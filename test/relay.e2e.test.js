// Relay-fallback E2E: simulates a network where WebRTC can NEVER connect
// (the exact failure reported on real home networks: candidates exchange but
// ICE never completes). PeerJS is replaced by a stub whose connections never
// open, so joining must fall back to the REAL public MQTT relay brokers.
// Requires internet access. Run with: node test/relay.e2e.test.js
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

// A Peer whose broker registration works but whose connections never open —
// models "signaling ok, ICE stuck at checking".
const DEAD_RTC_PEER = `
window.Peer = class {
  constructor(id) { this.id = id; this._h = {}; setTimeout(() => this._emit('open', id), 30); }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
  _emit(ev, ...a) { (this._h[ev] || []).forEach(f => f(...a)); }
  connect() { return { open: false, on() {}, close() {}, send() {} }; }
  destroy() {}
};
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (name, cond) => { console.log((cond ? 'ok: ' : 'FAIL: ') + name); if (!cond) fail++; };

(async () => {
  await new Promise(r => server.listen(8140, r));
  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
  await context.addInitScript(DEAD_RTC_PEER);
  await context.route('**/peerjs*', route => route.fulfill({ contentType: 'text/javascript', body: '/* dead rtc */' }));
  const errors = [];
  const mkPage = async (tag) => {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(tag + ': ' + String(e).slice(0, 200)));
    await page.goto('http://localhost:8140/');
    return page;
  };

  const host = await mkPage('host');
  const guest = await mkPage('guest');

  for (const p of [host, guest])
    await p.waitForFunction(() => document.getElementById('my-code').textContent.length === 5);
  const code = await host.evaluate(() => document.getElementById('my-code').textContent);
  console.log('room:', code);

  // wait for at least one relay broker connection on both pages
  for (const [tag, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(() => Net.relayReady(), null, { timeout: 30000 });
    check(`${tag} relay broker connected`, true);
  }

  await host.fill('#name-input', 'Hosty');
  await host.click('#btn-create');
  await guest.fill('#name-input', 'Guesty');
  await guest.fill('#join-input', code);
  await guest.click('#btn-join');

  // rtc gives up after 6s, then the relay handshake takes ~1-3s
  await guest.waitForFunction(() => document.getElementById('screen-lobby').classList.contains('active'), null, { timeout: 30000 });
  check('guest joined via relay', true);
  check('guest server is relay conn', await guest.evaluate(() => Net.server && Net.server.relay === true));
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players .player-card').length === 2, null, { timeout: 15000 });
  check('host sees both players', true);

  await guest.click('#btn-ready');
  await host.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 10000 });
  await host.click('#btn-start');
  for (const p of [host, guest])
    await p.waitForFunction(() => document.getElementById('screen-game').classList.contains('active'), null, { timeout: 30000 });
  check('match starts over relay', true);

  const starters = await Promise.all([host, guest].map(p => p.evaluate(() => Game.currentBall().id)));
  check('both agree on starter', starters[0] === starters[1]);

  const shooter = (await host.evaluate(() => Game.currentBall().id === Net.myId)) ? host : guest;
  const tcBefore = await host.evaluate(() => Game.match.turnCount);
  await shooter.evaluate(() => Game.shoot({ dx: 0.8, dy: -0.6, power: 1, spin: { x: 0, y: 0 } }));
  for (const p of [host, guest])
    await p.waitForFunction((tc) => Game.match.turnCount === tc + 1 || Game.match.mode === 'over', tcBefore, { timeout: 60000 });
  const [sh, sg] = await Promise.all([host, guest].map(p =>
    p.evaluate(() => Game.match.balls.map(b => [Math.round(b.x), Math.round(b.y), b.hp]))));
  console.log('host :', JSON.stringify(sh));
  console.log('guest:', JSON.stringify(sg));
  check('turn recording converges over relay', JSON.stringify(sh) === JSON.stringify(sg));

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 6));

  await browser.close();
  server.close();
  console.log(fail ? `\n${fail} FAILURES` : '\nRELAY E2E ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('crash:', e); process.exit(2); });
