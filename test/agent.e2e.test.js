// AI-layer E2E: one page plays ONLY through window.KilliardsAI (the "AI
// Ready" facade) against a human-driven host page. Covers: join + visible AI
// badge, lobby events, ready flow, turn events, the 5-preview cap, shooting
// through the normal (audited) pipeline, chat both ways, and matchOver.
// Hermetic BroadcastChannel MQTT shim, same harness as e2e.test.js.
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
  await new Promise(r => server.listen(8126, r));
  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await context.addInitScript(FAKE_MQTT);
  await context.route('**/mqtt*', route => route.fulfill({ contentType: 'text/javascript', body: '/* shimmed */' }));
  const errors = [];
  const mkPage = async (tag) => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text().slice(0, 200)); });
    await page.goto('http://localhost:8126/');
    return page;
  };

  const host = await mkPage('host');
  const agent = await mkPage('agent');
  for (const p of [host, agent])
    await p.waitForFunction(() => document.getElementById('my-code').textContent.length === 5);
  const code = await host.evaluate(() => document.getElementById('my-code').textContent);

  await host.fill('#name-input', 'Jarl');
  await host.click('#btn-create');

  // ---- the agent joins through the facade only ----
  check('facade is discoverable', await agent.evaluate(() =>
    !!window.KilliardsAI && KilliardsAI.version === 1 && !!KilliardsAI.describe().api.shoot));
  const joined = await agent.evaluate((c) => KilliardsAI.join(c, { name: 'Bottington' }), code);
  check('agent joins via the API', joined.joined === true);

  await host.waitForFunction(() => document.querySelectorAll('#lobby-players .player-card').length === 2, null, { timeout: 8000 });
  check('host sees the agent with a visible AI badge', await host.evaluate(() =>
    [...document.querySelectorAll('#lobby-players .bot-tag')].some(t => t.textContent === 'AI')));

  await agent.waitForFunction(() => document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 8000 });
  const lobbyEvents = await agent.evaluate(() => KilliardsAI.pollEvents());
  check('agent got lobby events with its own flag', lobbyEvents.some(e =>
    e.type === 'lobby' && e.players.some(p => p.name === 'Bottington' && p.isAgent)));

  await agent.evaluate(() => KilliardsAI.ready());
  await host.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 8000 });
  check('agent ready() reaches the host', true);
  await host.click('#btn-start');

  for (const p of [host, agent])
    await p.waitForFunction(() => document.getElementById('screen-game').classList.contains('active'), null, { timeout: 25000 });
  check('match starts for both', true);
  check('agent ball carries the AI tag into the turn pills', await host.evaluate(() =>
    document.getElementById('player-list').textContent.includes('🤖')));

  const settle = async (tcBefore) => {
    for (let i = 0; i < 240; i++) {
      const snaps = await Promise.all([host, agent].map(p => p.evaluate(() =>
        ({ mode: Game.match.mode, tc: Game.match.turnCount }))));
      if (snaps.every(s => (s.mode === 'idle' && s.tc > tcBefore) || s.mode === 'over')) return true;
      await sleep(250);
    }
    return false;
  };

  // ---- play turns: the agent acts only through the facade ----
  let capChecked = false, agentShots = 0, hostShots = 0, over = false;
  for (let round = 0; round < 6 && !over; round++) {
    const st = await agent.evaluate(() => KilliardsAI.getState());
    if (!st.match || st.match.mode === 'over') { over = true; break; }
    const tcBefore = st.match.turn;
    if (st.match.yourTurn) {
      if (!capChecked) {
        capChecked = true;
        const cap = await agent.evaluate(() => {
          const me = KilliardsAI.getState().match.balls.find(b => b.you);
          const foe = KilliardsAI.getState().match.balls.find(b => !b.you);
          const shot = { dx: foe.x - me.x, dy: foe.y - me.y, power: 0.55 };
          const runs = [];
          for (let i = 0; i < 6; i++) runs.push(KilliardsAI.previewShot(shot));
          return runs;
        });
        check('previews return physics results', cap[0].ok && Array.isArray(cap[0].finals) && Array.isArray(cap[0].events));
        check('previewsLeft counts down', cap[0].previewsLeft === 4 && cap[4].previewsLeft === 0);
        check('6th preview is rejected by the cap', cap[5].ok === false && /cap/.test(cap[5].error));
        check('shot clock is exposed on your turn', typeof (await agent.evaluate(() => KilliardsAI.getState().match.shotClock)) === 'number');
      }
      const res = await agent.evaluate(() => {
        const m = KilliardsAI.getState().match;
        const me = m.balls.find(b => b.you);
        const foe = m.balls.find(b => !b.you && !b.dead);
        return KilliardsAI.shoot({ dx: foe.x - me.x, dy: foe.y - me.y, power: 0.55, spin: { x: 0, y: 0 } });
      });
      check(`agent shot ${agentShots + 1} accepted`, res.ok === true);
      agentShots++;
    } else {
      await host.evaluate(() => {
        const m = Game.match;
        const me = m.balls[Game.myBallIdx()];
        const foe = m.balls.find(b => b.id !== Net.myId && !b.dead);
        const n = Math.hypot(foe.x - me.x, foe.y - me.y) || 1;
        Game.shoot({ dx: (foe.x - me.x) / n, dy: (foe.y - me.y) / n, power: 0.5, spin: { x: 0, y: 0 } });
      });
      hostShots++;
    }
    check(`round ${round + 1} settles everywhere`, await settle(tcBefore));
    // preview counter resets each turn
    if (capChecked) {
      const left = await agent.evaluate(() => KilliardsAI.getState().previewsLeft);
      check(`round ${round + 1}: preview budget refreshed`, left === 5);
      capChecked = 'done';
    }
    if (agentShots >= 1 && hostShots >= 1 && round >= 1) break;
  }
  check('both sides took real turns', agentShots >= 1 && hostShots >= 1);

  const turnEvents = await agent.evaluate(() => KilliardsAI.pollEvents());
  check('agent received turn events (incl. yourTurn)', turnEvents.some(e => e.type === 'turn' && e.yourTurn === true));

  // ---- chat both ways ----
  const chatRes = await agent.evaluate(() => KilliardsAI.sendChat('gg so far, human 🤖'));
  check('agent chat accepted', chatRes.ok === true);
  await host.waitForFunction(() => UI.chat.some(c => c.text.includes('gg so far')), null, { timeout: 8000 });
  check('agent chat reaches the host', true);
  await host.evaluate(() => {
    const d = { id: Net.myId, text: 'hello robot' };
    Net.send({ t: 'chat', d });
    UI.addChat(d);
  });
  await agent.waitForFunction(() =>
    KilliardsAI.getState().chat.some(c => c.text === 'hello robot'), null, { timeout: 8000 });
  const chatEv = await agent.evaluate(() => KilliardsAI.pollEvents());
  check('host chat arrives as an event with sender info', chatEv.some(e =>
    e.type === 'chat' && e.text === 'hello robot' && e.name === 'Jarl' && !e.mine));

  // ---- audits: the agent's turns verified clean on the host ----
  const hostLogs = await host.evaluate(() => Net.logs.join('\n'));
  check('host audited the agent turns clean', /physics verified ✓/.test(hostLogs) && !hostLogs.includes('FAILED VERIFICATION'));

  // ---- end the match: host self-destructs on its turn (test shortcut) ----
  for (let i = 0; i < 3; i++) {
    const hostTurn = await host.evaluate(() =>
      Game.match.mode === 'idle' && Game.currentBall().id === Net.myId);
    if (hostTurn) break;
    const st = await agent.evaluate(() => KilliardsAI.getState());
    if (st.match && st.match.yourTurn) {
      await agent.evaluate(() => KilliardsAI.shoot({ angle: Math.PI / 4, power: 0.3 }));
      await settle(st.match.turn);
    } else {
      await sleep(500);
    }
  }
  await host.evaluate(() => {
    Game.match.balls[Game.myBallIdx()].hp = 1;
    Game.shoot({ dx: -1, dy: 0, power: 1, spin: { x: 0, y: 0 } });
  });
  for (const p of [host, agent])
    await p.waitForFunction(() => document.getElementById('screen-ranking').classList.contains('active'), null, { timeout: 40000 });
  const overEv = await agent.evaluate(() => KilliardsAI.pollEvents());
  const mo = overEv.find(e => e.type === 'matchOver');
  check('agent gets the matchOver event and won', !!mo && mo.ranking[0].name === 'Bottington' && mo.ranking[0].you);
  check('AI badge shows in the ranking', await host.evaluate(() =>
    [...document.querySelectorAll('#ranking-list .bot-tag')].some(t => t.textContent === 'AI')));

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));

  await browser.close();
  server.close();
  console.log(fail ? `\n${fail} FAILURES` : '\nAGENT E2E ALL PASS');
  process.exit(fail ? 1 : 0);
})();
