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
  const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
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
  const mkPage = async (tag) => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text().slice(0, 200)); });
    await page.goto('http://localhost:8125/');
    return page;
  };

  const host = await mkPage('host');
  const g1 = await mkPage('g1');
  const g2 = await mkPage('g2');
  const pages = { host, g1, g2 };

  for (const p of Object.values(pages))
    await p.waitForFunction(() => document.getElementById('my-code').textContent.length === 5);
  const code = await host.evaluate(() => document.getElementById('my-code').textContent);

  await host.fill('#name-input', 'Hosty');
  await host.click('#btn-create');

  for (const [name, p] of [['Uno', g1], ['Dos', g2]]) {
    await p.fill('#name-input', name);
    await p.fill('#join-input', code);
    await p.click('#btn-join');
    await p.waitForFunction(() => document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 8000 });
  }
  check('guests reach lobby', true);
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players .player-card').length === 3, null, { timeout: 8000 });
  check('host sees 3 players', true);
  check('g2 sees 3 players', await g2.evaluate(() => document.querySelectorAll('#lobby-players .player-card').length === 3));

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

  const state = (p) => p.evaluate(() => Game.match.balls.map(b => [Math.round(b.x), Math.round(b.y), b.hp, b.dead]));

  // play 3 turns, whoever's turn it is shoots; assert convergence each time
  for (let turn = 0; turn < 3; turn++) {
    let shooterTag = null;
    for (const [tag, p] of Object.entries(pages)) {
      if (await p.evaluate(() => Game.currentBall().id === Net.myId)) { shooterTag = tag; break; }
    }
    check(`turn ${turn + 1}: someone has the turn locally`, !!shooterTag);
    const shooter = pages[shooterTag];
    const tcBefore = await host.evaluate(() => Game.match.turnCount);
    const angle = 0.5 + turn * 1.9;
    await shooter.evaluate((a) => Game.shoot({ dx: Math.cos(a), dy: Math.sin(a), power: 0.95, spin: { x: 0.2, y: -0.2 } }), angle);
    // a turn is only fully finished when turnCount advances (post end-sequence)
    for (const p of Object.values(pages))
      await p.waitForFunction((tc) => Game.match.turnCount === tc + 1 || Game.match.mode === 'over', tcBefore, { timeout: 60000 });
    const [sh, s1, s2] = await Promise.all([state(host), state(g1), state(g2)]);
    const same = JSON.stringify(sh) === JSON.stringify(s1) && JSON.stringify(s1) === JSON.stringify(s2);
    check(`turn ${turn + 1} by ${shooterTag}: states converge`, same);
    if (!same) { console.log(JSON.stringify(sh), JSON.stringify(s1), JSON.stringify(s2)); break; }
    const turns = await Promise.all(Object.values(pages).map(p => p.evaluate(() => Game.currentBall().id)));
    check(`turn ${turn + 1}: everyone agrees whose turn is next`, new Set(turns).size === 1);
  }
  console.log('hp after 3 turns:', JSON.stringify(await state(host)));

  // damage bars visible again after settling (barsAlpha back up)
  await sleep(1200);
  check('bars visible after turn', await host.evaluate(() => Game.match.barsAlpha > 0.8));

  // simulate g1 disconnect mid-match (shim can't detect page close, so close
  // the connection explicitly — real PeerJS fires 'close' on ICE drop too)
  await g1.evaluate(() => Net.server.close());
  await g1.close();
  await sleep(1500);
  const deadOnHost = await host.evaluate(() => Game.match.balls.filter(b => b.dead).length);
  const deadOnG2 = await g2.evaluate(() => Game.match.balls.filter(b => b.dead).length);
  check('disconnect kills ball everywhere', deadOnHost === 1 && deadOnG2 === 1);
  // with 3 players and one dead, match should now be over (1 alive... no: 2 alive)
  const aliveHost = await host.evaluate(() => Game.match.balls.filter(b => !b.dead).length);
  check('two players remain alive', aliveHost === 2);
  const curH = await host.evaluate(() => Game.currentBall().dead);
  check('current turn holder is alive', curH === false);

  // ranking screen renders
  await host.evaluate(() => UI.showRanking(Game.ranking()));
  check('ranking rows render', await host.evaluate(() => document.querySelectorAll('#ranking-list .rank-row').length === 3));
  check('winner row not a dead player', await host.evaluate(() =>
    document.querySelector('#ranking-list .rank-row.winner .rank-note').textContent === 'WINNER'));

  await host.screenshot({ path: __dirname + '/shot-host.png' });
  await g2.screenshot({ path: __dirname + '/shot-guest.png' });

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 8));

  await browser.close();
  server.close();
  console.log(fail ? `\n${fail} FAILURES` : '\nE2E ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E crash:', e); process.exit(2); });
