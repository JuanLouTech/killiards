// Full-app E2E with a BroadcastChannel-backed MQTT shim (hermetic: no real
// brokers). Exercises the whole relay transport except the wire itself.
// 3 players: exercises lobby sync, host relay of guest turns, roulette
// agreement, replay convergence and turn rotation.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(data);
  });
});

const FAKE_MQTT = `
window.mqtt = {
  connect() {
    const client = {
      connected: false, _h: {}, _subs: [],
      on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; },
      _emit(ev, ...a) { (this._h[ev] || []).forEach(f => f(...a)); },
      subscribe(t) { this._subs.push(t); },
      publish(topic, payload) { this._bc.postMessage({ topic, payload }); },
      end() {},
    };
    const match = (f, t) => {
      const fs = f.split('/'), ts = t.split('/');
      return fs.length === ts.length && fs.every((s, i) => s === '+' || s === ts[i]);
    };
    client._bc = new BroadcastChannel('fake-mqtt');
    client._bc.onmessage = (e) => {
      const { topic, payload } = e.data;
      if (client._subs.some(f => match(f, topic))) {
        client._emit('message', topic, { toString: () => payload });
      }
    };
    setTimeout(() => { client.connected = true; client._emit('connect'); }, 20);
    return client;
  },
};
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (name, cond) => { console.log((cond ? 'ok: ' : 'FAIL: ') + name); if (!cond) fail++; };

(async () => {
  await new Promise(r => server.listen(8125, r));
  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await context.addInitScript(FAKE_MQTT);
  // keep the test hermetic: no real relay brokers
  await context.route('**/mqtt*', route => route.fulfill({ contentType: 'text/javascript', body: '/* shimmed */' }));
  const errors = [];
  const mkPage = async (tag, path = '/') => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text().slice(0, 200)); });
    await page.goto('http://localhost:8125' + path);
    return page;
  };

  const host = await mkPage('host');
  const g2 = await mkPage('g2');
  for (const p of [host, g2])
    await p.waitForFunction(() => document.getElementById('my-code').textContent.length === 5);
  const code = await host.evaluate(() => document.getElementById('my-code').textContent);

  await host.fill('#name-input', 'Hosty');
  await host.click('#btn-create');
  check('share button in lobby', await host.evaluate(() => document.getElementById('lobby-share').offsetParent !== null));

  // g1 arrives through a direct invite link: sees the lobby preview (room
  // code + live roster) before taking a seat
  const g1 = await mkPage('g1', '/?room=' + code);
  const pages = { host, g1, g2 };
  await g1.waitForFunction(() => document.getElementById('screen-home').classList.contains('invited'));
  check('invite view shows the room code', await g1.evaluate((c) => document.getElementById('invite-code').textContent === c, code));
  check('invite view hides the normal controls', await g1.evaluate(() => document.getElementById('btn-create').offsetParent === null));
  await g1.waitForFunction(() => document.querySelectorAll('#invite-players .invite-player').length === 1, null, { timeout: 8000 });
  check('invite roster previews the host', await g1.evaluate(() => document.querySelector('#invite-players .invite-player').textContent.includes('Hosty')));
  await g1.fill('#name-input', 'Uno');
  await g1.waitForFunction(() => !document.getElementById('btn-join-invite').disabled);
  await g1.click('#btn-join-invite');
  await g1.waitForFunction(() => document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 8000 });
  check('invited player reaches the lobby', true);

  // g2 joins the classic way, typing the code
  await g2.fill('#name-input', 'Dos');
  await g2.fill('#join-input', code);
  await g2.click('#btn-join');
  await g2.waitForFunction(() => document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 8000 });
  check('guests reach lobby', true);
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players .player-card').length === 3, null, { timeout: 8000 });
  check('host sees 3 players', true);
  check('g2 sees 3 players', await g2.evaluate(() => document.querySelectorAll('#lobby-players .player-card').length === 3));

  // host adds a bot: everyone sees 4 cards, the bot one marked and ready
  await host.click('#btn-add-bot');
  await g2.waitForFunction(() => document.querySelectorAll('#lobby-players .player-card').length === 4, null, { timeout: 8000 });
  check('bot visible on guests', true);
  check('bot card is marked and ready', await g2.evaluate(() => {
    const card = document.querySelector('#lobby-players .player-card.bot');
    return !!card && card.querySelector('.p-ready').classList.contains('on');
  }));
  check('guests cannot add bots', await g2.evaluate(() => document.getElementById('btn-add-bot').style.display === 'none'));

  // host taps the difficulty chip: mid → hard, synced to every guest
  check('bot spawns at MID level', await host.evaluate(() => document.querySelector('.bot-level').textContent === 'MID'));
  await host.click('.bot-level');
  await g2.waitForFunction(() => {
    const chip = document.querySelector('.bot-level');
    return chip && chip.textContent === 'HARD';
  }, null, { timeout: 8000 });
  check('bot level change reaches guests', true);
  check('guests cannot change the level', await g2.evaluate(() => document.querySelector('.bot-level').disabled));

  // host picks table, everyone sees it
  await host.evaluate(() => document.querySelectorAll('#table-select .table-opt')[1].click());
  await sleep(500);
  check('g1 sees table choice', await g1.evaluate(() => document.querySelector('#table-select .table-opt.sel').dataset.id === 'diamonds'));

  for (const p of [g1, g2, host]) await p.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 8000 });
  await host.click('#btn-start');

  for (const p of Object.values(pages))
    await p.waitForFunction(() => document.getElementById('screen-game').classList.contains('active'), null, { timeout: 25000 });
  check('all reach game screen', true);

  const starters = await Promise.all(Object.values(pages).map(p => p.evaluate(() => Game.currentBall().id)));
  check('all agree on starter', new Set(starters).size === 1);
  check('bot ball carries its difficulty into the match',
    await host.evaluate(() => Game.match.balls.find(b => b.isBot).botLevel === 'hard'));

  const state = (p) => p.evaluate(() => ({
    mode: Game.match.mode,
    tc: Game.match.turnCount,
    balls: Game.match.balls.map(b => [Math.round(b.x), Math.round(b.y), b.hp, b.dead, b.storedPower]),
    pu: Game.match.powerups.map(u => [u.id, u.k, u.x, u.y]),
  }));

  // Wait until every page is idle past tcBefore with identical state. Bot
  // turns run on the host's own clock, so lock-step waits don't work; poll.
  const settle = async (tcBefore) => {
    for (let i = 0; i < 240; i++) {
      const snaps = await Promise.all(Object.values(pages).map(state));
      const same = snaps.every(s => JSON.stringify(s) === JSON.stringify(snaps[0]));
      const done = snaps.every(s => (s.mode === 'idle' && s.tc > tcBefore) || s.mode === 'over');
      if (same && done) return snaps[0];
      await sleep(250);
    }
    return null;
  };

  // play 4 turns (with 4 players that includes the bot's turn, host-simulated);
  // whoever's turn it is shoots; assert convergence each time.
  // The bot's whole turn can play out inside a settle() poll window (guests'
  // replays lag behind the host), so count its shots at the source too.
  await host.evaluate(() => {
    window.__botShots = 0;
    const orig = Game.botShoot.bind(Game);
    Game.botShoot = (tc) => { window.__botShots++; orig(tc); };
  });
  let botPlayed = false;
  for (let turn = 0; turn < 4; turn++) {
    let shooterTag = null;
    for (const [tag, p] of Object.entries(pages)) {
      if (await p.evaluate(() => Game.currentBall().id === Net.myId)) { shooterTag = tag; break; }
    }
    const tcBefore = await host.evaluate(() => Game.match.turnCount);
    if (!shooterTag) {
      // nobody local owns the turn: must be the bot — the host plays it alone
      botPlayed = true;
    } else {
      const angle = 0.5 + turn * 1.9;
      await pages[shooterTag].evaluate((a) => Game.shoot({ dx: Math.cos(a), dy: Math.sin(a), power: 0.95, spin: { x: 0.2, y: -0.2 } }), angle);
    }
    const settled = await settle(tcBefore);
    check(`turn ${turn + 1} by ${shooterTag || 'BOT'}: states converge`, !!settled);
    if (!settled) {
      console.log(JSON.stringify(await Promise.all(Object.values(pages).map(state))));
      break;
    }
    const turns = await Promise.all(Object.values(pages).map(p => p.evaluate(() => Game.currentBall().id)));
    check(`turn ${turn + 1}: everyone agrees whose turn is next`, new Set(turns).size === 1);
  }
  botPlayed = botPlayed || await host.evaluate(() => window.__botShots > 0);
  check('the bot got a turn and auto-played it', botPlayed);
  console.log('hp after 4 turns:', JSON.stringify((await state(host)).balls));

  // emotes: g2 reacts, everyone (host relays) sees the floater
  await g2.click('#emote-bar .emote-btn');
  await host.waitForFunction(() => Renderer.floaters.length > 0, null, { timeout: 5000 });
  check('emote relayed to host', true);
  check('emote relayed to other guest', await g1.evaluate(() => Renderer.floaters.length > 0));

  // damage bars visible again once idle (a bot may still be playing: wait)
  await host.waitForFunction(() => Game.match.mode === 'idle' && Game.match.barsAlpha > 0.8, null, { timeout: 30000 });
  check('bars visible after turn', true);

  // shot clock: on the shooter's page (focus stubbed — headless pages report
  // no focus) the timer shows, runs out, and fires the turn by itself; other
  // pages show SIMULATING… while the recording plays
  {
    // if a bot holds the turn, let it finish first
    for (let i = 0; i < 3; i++) {
      const isBot = await host.evaluate(() => Game.match.mode !== 'over' && Game.currentBall().isBot);
      if (!isBot) break;
      await settle(await host.evaluate(() => Game.match.turnCount));
    }
    let clockTag = null;
    for (const [tag, p] of Object.entries(pages)) {
      if (await p.evaluate(() => Game.match.mode === 'idle' && Game.currentBall().id === Net.myId)) { clockTag = tag; break; }
    }
    check('shot clock: a human holds the turn', !!clockTag);
    const shooter = pages[clockTag];
    const watcher = clockTag === 'host' ? g2 : host;
    await shooter.evaluate(() => { Game.hasFocus = () => true; });
    await shooter.waitForFunction(() => document.getElementById('turn-sub').textContent.startsWith('⏱'), null, { timeout: 5000 });
    check('shot clock visible on the active player', true);
    const tcBefore = await host.evaluate(() => Game.match.turnCount);
    await shooter.evaluate(() => { Game.match.turnTimer = 0.8; });
    // the watcher's own table is still idle (no recording yet) but it must
    // already know a shot is being simulated on the shooter's device
    await watcher.waitForFunction(() =>
      Game.match.mode === 'idle' && document.getElementById('turn-sub').textContent.includes('SIMULATING'),
    null, { timeout: 20000 });
    check('watchers see SIMULATING… while waiting for the recording', true);
    check('shot clock auto-fires the turn', !!(await settle(tcBefore)));
  }

  // simulate g1 disconnect mid-match (shim can't detect page close, so close
  // the connection explicitly — real PeerJS fires 'close' on ICE drop too)
  await g1.evaluate(() => Net.server.close());
  await g1.close();
  await sleep(1500);
  const deadOnHost = await host.evaluate(() => Game.match.balls.filter(b => b.dead).length);
  const deadOnG2 = await g2.evaluate(() => Game.match.balls.filter(b => b.dead).length);
  check('disconnect kills ball everywhere', deadOnHost === 1 && deadOnG2 === 1);
  // 4 players (incl. the bot), one disconnected -> 3 still alive
  const aliveHost = await host.evaluate(() => Game.match.balls.filter(b => !b.dead).length);
  check('three players remain alive', aliveHost === 3);
  const curH = await host.evaluate(() => Game.currentBall().dead);
  check('current turn holder is alive', curH === false);

  // ranking screen renders (nameless bot shown by its emoji)
  await host.evaluate(() => UI.showRanking(Game.ranking()));
  check('ranking rows render', await host.evaluate(() => document.querySelectorAll('#ranking-list .rank-row').length === 4));
  check('winner row not a dead player', await host.evaluate(() =>
    document.querySelector('#ranking-list .rank-row.winner .rank-note').textContent === 'WINNER'));
  check('bot row shows its emoji as name', await host.evaluate(() => {
    const bot = Game.match.balls.find(b => b.isBot);
    return [...document.querySelectorAll('#ranking-list .rank-row .p-name')]
      .some(el => el.textContent.includes(bot.emoji));
  }));

  await host.screenshot({ path: __dirname + '/shot-host.png' });
  await g2.screenshot({ path: __dirname + '/shot-guest.png' });

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 8));

  await browser.close();
  server.close();
  console.log(fail ? `\n${fail} FAILURES` : '\nE2E ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E crash:', e); process.exit(2); });
