// Tournament-mode E2E (hermetic, same BroadcastChannel MQTT shim as
// e2e.test.js). Two humans play a 3-match tournament; each match the turn
// holder self-destructs (hp 1 + wall shot) so every match ends in one turn.
// Verifies: lobby setting sync, random-table lock, per-match points (6/4),
// standings agreement across devices, next-match chaining without re-ready,
// final standings + confetti, and the return to the lobby.
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

let fail = 0;
const check = (name, cond) => { console.log((cond ? 'ok: ' : 'FAIL: ') + name); if (!cond) fail++; };

(async () => {
  await new Promise(r => server.listen(8127, r));
  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await context.addInitScript(FAKE_MQTT);
  await context.route('**/mqtt*', route => route.fulfill({ contentType: 'text/javascript', body: '/* shimmed */' }));
  const errors = [];
  const mkPage = async (tag) => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') errors.push(tag + ' console: ' + m.text().slice(0, 200)); });
    await page.goto('http://localhost:8127/');
    await page.waitForFunction(() => document.getElementById('my-code').textContent.length === 5);
    return page;
  };

  const host = await mkPage('Ana');
  const guest = await mkPage('Bob');
  const code = await host.evaluate(() => Net.myId);

  await host.fill('#name-input', 'Ana');
  await host.click('#btn-create');
  await host.evaluate(() => document.querySelector('#tourney-select [data-len="3"]').click());
  check('tournament forces a random table', await host.evaluate(() => UI.lobby.tableId === 'random'));

  await guest.fill('#name-input', 'Bob');
  await guest.fill('#join-input', code);
  await guest.click('#btn-join');
  await guest.waitForFunction(() => {
    const b = document.querySelector('#tourney-select .sel');
    return document.getElementById('screen-lobby').classList.contains('active') && b && b.dataset.len === '3';
  }, null, { timeout: 8000 });
  check('guest sees the tournament choice', true);
  check('guest cannot change it', await guest.evaluate(() => document.querySelector('#tourney-select .sel').disabled));

  for (const p of [guest, host]) await p.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 8000 });
  check('start button announces the tournament',
    await host.evaluate(() => document.getElementById('btn-start').textContent === 'Start tournament'));
  await host.click('#btn-start');

  const pages = { Ana: host, Bob: guest };
  const totals = { Ana: 0, Bob: 0 };
  for (let match = 1; match <= 3; match++) {
    for (const p of [host, guest]) {
      await p.waitForFunction((n) =>
        document.getElementById('screen-game').classList.contains('active') &&
        Game.match && Game.match.mode === 'idle' &&
        UI.tourney && UI.tourney.no === n,
      match, { timeout: 40000 });
    }
    check(`match ${match}: both playing, tourney state synced`, true);

    // the turn holder self-destructs: 1 hp + a hard shot into a wall
    let shooterTag = null;
    for (const [tag, p] of Object.entries(pages)) {
      if (await p.evaluate(() => Game.currentBall().id === Net.myId)) { shooterTag = tag; break; }
    }
    check(`match ${match}: a human holds the first turn`, !!shooterTag);
    await pages[shooterTag].evaluate(() => {
      Game.match.balls[Game.match.turnIdx].hp = 1;
      Game.shoot({ dx: 1, dy: 0, power: 1, spin: { x: 0, y: 0 } });
    });
    const winnerTag = shooterTag === 'Ana' ? 'Bob' : 'Ana';
    totals[winnerTag] += 6;
    totals[shooterTag] += 4;

    for (const p of [host, guest]) {
      await p.waitForFunction(() =>
        document.getElementById('screen-ranking').classList.contains('active'), null, { timeout: 40000 });
    }
    check(`match ${match}: ranking title counts matches`, await guest.evaluate((m) =>
      document.getElementById('ranking-title').textContent === `Match ${m} of 3 over`, match));
    check(`match ${match}: winner row shows +6`, await guest.evaluate(() =>
      document.querySelector('#ranking-list .rank-row .rank-pts').textContent === '+6'));

    // standings agree with the expected totals on every device (tie order in
    // the UI is insertion-based, so compare pts by name, plus leader-on-top)
    for (const [tag, p] of Object.entries(pages)) {
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll('#tourney-list .rank-row')].map(r => ({
          name: r.querySelector('.p-name').textContent.trim(),
          pts: parseInt(r.querySelector('.rank-pts').textContent),
        })));
      const ok = rows.length === 2 &&
        rows.every(r => totals[r.name] === r.pts) &&
        rows[0].pts === Math.max(...rows.map(r => r.pts));
      check(`match ${match}: standings correct on ${tag}`, ok);
    }

    if (match < 3) {
      check(`match ${match}: host chains the next match`, await host.evaluate(() =>
        document.getElementById('btn-again').textContent === 'Next match ▶'));
      check(`match ${match}: no confetti yet`, await host.evaluate(() =>
        !document.getElementById('confetti').classList.contains('show')));
      check(`match ${match}: guest told to wait for the host`, await guest.evaluate(() =>
        document.getElementById('ranking-hint').textContent.includes('host starts the next match')));
      await host.click('#btn-again');
    }
  }

  check('final standings header', await guest.evaluate(() =>
    document.getElementById('tourney-title').textContent.includes('Final standings')));
  check('confetti fires on every device',
    (await host.evaluate(() => document.getElementById('confetti').classList.contains('show'))) &&
    (await guest.evaluate(() => document.getElementById('confetti').classList.contains('show'))));
  check('champion earned the right total', Math.max(totals.Ana, totals.Bob) === 16);
  check('host button returns to the lobby', await host.evaluate(() =>
    document.getElementById('btn-again').textContent === 'Back to lobby'));

  await host.click('#btn-again');
  for (const p of [host, guest]) {
    await p.waitForFunction(() =>
      document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 8000 });
  }
  check('everyone back in the lobby, tournament cleared',
    await host.evaluate(() => UI.tourney === null) && await guest.evaluate(() => UI.tourney === null));

  if (errors.length) { console.log('page errors:', errors); fail++; }
  console.log(fail ? `\n${fail} FAILURES` : '\nTOURNEY E2E ALL PASS');
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
