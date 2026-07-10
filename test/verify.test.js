// Headless test of the turn audit (Game.verifyTurn): an honest recording
// verifies clean against a local re-simulation; a tampered one — forged hp,
// bent trajectory, understated shot power, invented power-ups — is flagged.
// game.js only touches Net/UI/DOM at call time, so a Net stub is enough here.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'js') + '/';
const src =
  'const Net = { logs: [], log(m) { this.logs.push(m); } };\n' +
  fs.readFileSync(path + 'tables.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'physics.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'game.js', 'utf8') +
  '\n;Object.assign(globalThis, { Sim, PHYS, getTable, Game, Net });';
eval(src);

let failures = 0;
function check(name, cond) {
  if (!cond) { failures++; console.log('FAIL:', name); }
  else console.log('ok:', name);
}
const lastLog = () => Net.logs[Net.logs.length - 1] || '';

// Identical starting state for the "shooter device" and the "receiver":
// exactly what runEndSequence leaves behind on every device (rounded ints).
function mkMatch() {
  const table = getTable('bastion');
  return {
    table,
    balls: table.spawns.slice(0, 3).map(([x, y], i) => ({
      id: 'p' + i, name: 'P' + i, emoji: '🎱', x, y, vx: 0, vy: 0,
      hp: 100, dead: false, lastBorder: null, rMul: null, mMul: null,
      storedPower: i === 0 ? 'blast' : null, fxNow: i === 1 ? 'tiny' : null, fxNext: null,
    })),
    barriers: (table.barriers || []).map(([x, y]) => ({ x, y, vx: 0, vy: 0, isBar: true })),
    // pre-existing power-ups always have born < the audited turn's tc: a
    // spawn rolled at the end of turn N ships inside turn N's own payload
    powerups: [{ id: 'u1', k: 'boost', x: 900, y: 600, born: 0 },
               { id: 'u2', k: 'poison', x: 1500, y: 820, born: 0 }],
    borderDmg: 4,
  };
}

// What the shooter's device does: run the live sim, build the turn payload
// (mirrors performShot + finishLiveTurn, minus networking and spawn roll).
function playTurn(m, input) {
  const effect = m.balls[0].storedPower || null;
  m.balls[0].storedPower = null;
  const speed = PHYS.MIN_SHOT + input.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
  const sim = new Sim(m.balls, m.table, 0,
    { dx: input.dx, dy: input.dy, speed, spin: input.spin },
    { barriers: m.barriers, powerups: m.powerups, effect, borderDmg: m.borderDmg });
  let n = 0;
  while (!sim.step() && n++ < 3600) { /* run */ }
  return {
    tc: 1, sh: 0, v: PHYS.SIM_V,
    in: { dx: input.dx, dy: input.dy, power: input.power, spin: input.spin || null },
    fx: effect,
    act: m.balls.map(b => b.fxNow || null),
    frames: sim.frames, events: sim.events,
    final: {
      p: m.balls.map(b => [Math.round(b.x), Math.round(b.y)]),
      hp: m.balls.map(b => Math.round(b.hp * 10) / 10),
      sp: m.balls.map(b => b.storedPower || null),
      eff: m.balls.map(b => b.fxNext || null),
      bar: m.barriers.map(b => [Math.round(b.x), Math.round(b.y)]),
      pu: m.powerups.slice(),
    },
  };
}

const input = { dx: 0.943, dy: 0.333, power: 0.87, spin: { x: 0.25, y: -0.35 } };
const honest = playTurn(mkMatch(), input);
// the wire: JSON round-trip must preserve every double exactly
const wire = (p) => JSON.parse(JSON.stringify(p));

Game.match = mkMatch(); // the receiver, one authoritative turn behind

check('turn is eventful enough to audit (events fired)', honest.events.length >= 3);

Game.verifyTurn(wire(honest));
check('honest payload verifies clean', lastLog().includes('physics verified ✓'));

{ // forged hp: shooter heals itself 30 in the final state
  const p = wire(honest);
  p.final.hp[0] = Math.min(PHYS.MAX_HP, p.final.hp[0] + 30);
  Game.verifyTurn(p);
  check('forged final hp is flagged', lastLog().includes('FAILED VERIFICATION') && lastLog().includes('hp'));
}

{ // bent trajectory: one recorded frame nudged a few units
  const p = wire(honest);
  p.frames[10][0] += 3;
  Game.verifyTurn(p);
  check('tampered recording is flagged', lastLog().includes('FAILED VERIFICATION') && lastLog().includes('frames'));
}

{ // understated inputs: claims a weaker shot than the recording shows
  const p = wire(honest);
  p.in.power *= 0.9;
  Game.verifyTurn(p);
  check('lying about shot inputs is flagged', lastLog().includes('FAILED VERIFICATION'));
}

{ // invented power-up: a pickup that was never on the table
  const p = wire(honest);
  p.final.pu.push({ id: 'ux', k: 'heal', x: 500, y: 500, born: 0 });
  Game.verifyTurn(p);
  check('invented power-up is flagged', lastLog().includes('FAILED VERIFICATION') && lastLog().includes('survivors'));
}

{ // …but a fresh spawn rolled this turn (born === tc) is legitimate
  const p = wire(honest);
  p.final.pu.push({ id: 'u1_555', k: 'heal', x: 500, y: 500, born: 1 });
  Game.verifyTurn(p);
  check('fresh power-up spawn is NOT flagged', lastLog().includes('physics verified ✓'));
}

{ // claiming a stored power the receiver knows the shooter never had
  const p = wire(honest);
  p.fx = 'boost';
  Game.verifyTurn(p);
  check('claiming an unowned effect is flagged', lastLog().includes('FAILED VERIFICATION') && lastLog().includes('effect'));
}

{ // a different sim version is skipped, not failed
  const p = wire(honest);
  p.v = 99;
  Game.verifyTurn(p);
  check('foreign sim version skips the audit', lastLog().includes('verify skipped'));
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
