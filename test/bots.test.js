// Headless bot-AI evaluation: loads the real physics + planner (no browser)
// and pits difficulty levels against each other in full simulated matches.
// Run with plain `node test/bots.test.js`.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'js') + '/';
const src = fs.readFileSync(path + 'tables.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'physics.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'botai.js', 'utf8') +
  '\n;Object.assign(globalThis, { Sim, PHYS, getTable, TABLE_W, TABLE_H, POWER_KINDS, BotAI, BOT_LEVELS });';
eval(src);

let failures = 0;
function check(name, cond) {
  if (!cond) { failures++; console.log('FAIL:', name); }
  else console.log('ok:', name);
}

function mkMatch(tableId, n) {
  const table = getTable(tableId);
  return {
    table,
    balls: table.spawns.slice(0, n).map(([x, y], i) => ({
      id: 'p' + i, x, y, vx: 0, vy: 0, hp: PHYS.MAX_HP, dead: false,
      lastBorder: null, storedPower: null, rMul: null, mMul: null,
    })),
    barriers: (table.barriers || []).map(([x, y]) => ({ x, y, vx: 0, vy: 0, isBar: true })),
    powerups: [],
  };
}

// Play a whole bots-only match the same way Game does (plan → Sim to rest →
// deaths → next living seat). Returns the winning seat index, -1 on a draw.
function playMatch(levels, tableId) {
  const m = mkMatch(tableId, levels.length);
  let turnIdx = 0;
  for (let turn = 0; turn < 300; turn++) {
    const me = m.balls[turnIdx];
    const plan = BotAI.plan({ ...m, turnIdx }, levels[turnIdx]);
    const effect = me.storedPower || null;
    me.storedPower = null;
    const speed = PHYS.MIN_SHOT + plan.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
    const sim = new Sim(m.balls, m.table, turnIdx,
      { dx: plan.dx, dy: plan.dy, speed, spin: plan.spin },
      { barriers: m.barriers, powerups: m.powerups, effect });
    while (!sim.step()) { /* run to rest */ }
    m.balls.forEach(b => { if (!b.dead && b.hp <= 0) b.dead = true; });
    const alive = m.balls.filter(b => !b.dead);
    if (alive.length === 0) return -1;
    if (alive.length === 1) return m.balls.indexOf(alive[0]);
    do { turnIdx = (turnIdx + 1) % m.balls.length; } while (m.balls[turnIdx].dead);
  }
  const alive = m.balls.filter(b => !b.dead);
  return m.balls.indexOf(alive.reduce((a, b) => (b.hp > a.hp ? b : a)));
}

// Test 1: every level returns a well-formed, in-range shot
{
  const m = mkMatch('classic', 3);
  for (const lvl of Object.keys(BOT_LEVELS)) {
    const p = BotAI.plan({ ...m, turnIdx: 0 }, lvl);
    const len = Math.hypot(p.dx, p.dy);
    check(`${lvl}: unit direction + power in range`,
      Math.abs(len - 1) < 1e-6 && p.power >= 0.15 && p.power <= 1 && p.spin && 'x' in p.spin);
  }
  check('unknown level falls back to mid', !!BotAI.plan({ ...m, turnIdx: 0 }, undefined));
  // planning must not touch the real match state
  const before = JSON.stringify(m.balls);
  BotAI.plan({ ...m, turnIdx: 0 }, 'hard');
  check('planning leaves the live state untouched', JSON.stringify(m.balls) === before);
}

// Test 2: hard planning is fast enough to run inline on the host
{
  const m = mkMatch('classic', 4);
  const t0 = process.hrtime.bigint();
  BotAI.plan({ ...m, turnIdx: 0 }, 'hard');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`   hard plan took ${ms.toFixed(1)}ms`);
  check('hard plan under 400ms', ms < 400);
}

// Test 3: hard clearly beats easy across many matches (both seat orders)
{
  const N = 30;
  let hardWins = 0;
  for (let i = 0; i < N; i++) {
    const hardSeat = i % 2;
    const levels = hardSeat === 0 ? ['hard', 'easy'] : ['easy', 'hard'];
    if (playMatch(levels, i % 3 ? 'classic' : 'diamonds') === hardSeat) hardWins++;
  }
  console.log(`   hard vs easy: ${hardWins}/${N} wins`);
  check('hard wins at least 65% vs easy', hardWins / N >= 0.65);
}

// Test 4 (informational + sanity): mid should not lose badly to easy
{
  const N = 20;
  let midWins = 0;
  for (let i = 0; i < N; i++) {
    const midSeat = i % 2;
    const levels = midSeat === 0 ? ['mid', 'easy'] : ['easy', 'mid'];
    if (playMatch(levels, 'classic') === midSeat) midWins++;
  }
  console.log(`   mid vs easy: ${midWins}/${N} wins`);
  check('mid wins at least half vs easy', midWins / N >= 0.5);
}

console.log(failures ? `\n${failures} FAILURES` : '\nBOT AI ALL PASS');
process.exit(failures ? 1 : 0);
