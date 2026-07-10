// Headless smoke test: load tables.js + physics.js and run turns.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'js') + '/';
const src = fs.readFileSync(path + 'tables.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'physics.js', 'utf8') +
  '\n;Object.assign(globalThis, { Sim, PHYS, getTable, TABLE_W, TABLE_H, pointInConvexPoly, closestOnSegment, TABLES, POWER_KINDS, POWER_KIND_IDS });';
eval(src);

function mkBalls(spawns, n) {
  return spawns.slice(0, n).map(([x, y], i) => ({
    id: 'p' + i, x, y, vx: 0, vy: 0, hp: 100, dead: false, lastBorder: null,
  }));
}

function runTurn(table, balls, shooter, shot) {
  const sim = new Sim(balls, table, shooter, shot);
  let steps = 0;
  while (!sim.step() && steps < 60 * 30) steps++;
  return sim;
}

let failures = 0;
function check(name, cond) {
  if (!cond) { failures++; console.log('FAIL:', name); }
  else console.log('ok:', name);
}

// Test 1: straight shot at a wall on classic table
{
  const t = getTable('classic');
  const balls = mkBalls([[800, 450], [1200, 450]], 2);
  const sim = runTurn(t, balls, 0, { dx: -1, dy: 0, speed: 1400, spin: { x: 0, y: 0 } });
  check('sim settles', sim.done);
  check('shooter moved', balls[0].x !== 800);
  check('frames recorded', sim.frames.length > 10);
  const wallEvents = sim.events.filter(e => e.type === 'wall');
  check('wall contact happened', wallEvents.length >= 1);
  check('shooter took fixed border dmg', balls[0].hp < 100 && balls[0].hp >= 100 - PHYS.BORDER_DMG * wallEvents.length);
  check('balls stay in bounds', balls.every(b => b.x >= PHYS.R - 1 && b.x <= TABLE_W - PHYS.R + 1 && b.y >= PHYS.R - 1 && b.y <= TABLE_H - PHYS.R + 1));
}

// Test 2: direct hit on another ball — victim damaged, shooter immune to ball dmg
{
  const t = getTable('classic');
  const balls = mkBalls([[400, 450], [800, 450]], 2);
  const sim = runTurn(t, balls, 0, { dx: 1, dy: 0, speed: 1400, spin: { x: 0, y: 0 } });
  const ballEvents = sim.events.filter(e => e.type === 'ball');
  check('ball contact happened', ballEvents.length >= 1);
  const victimDmg = ballEvents.flatMap(e => e.victims).filter(v => v.i === 1);
  const shooterBallDmg = ballEvents.flatMap(e => e.victims).filter(v => v.i === 0);
  check('victim damaged by contact', victimDmg.length >= 1 && balls[1].hp < 100);
  check('shooter immune to ball dmg', shooterBallDmg.length === 0);
  console.log('   victim hp after head-on:', balls[1].hp.toFixed(1));
}

// Test 3: obstacles push balls out (diamonds table, shot through a diamond)
{
  const t = getTable('diamonds');
  const balls = mkBalls([[430, 700], [1400, 150]], 2);
  const sim = runTurn(t, balls, 0, { dx: 0, dy: -1, speed: 1400, spin: { x: 0, y: 0 } });
  // ball shot upward into diamond at (430,280,r150): must never end inside it
  const inside = pointInConvexPoly(balls[0].x, balls[0].y, t.obstacles[0].pts);
  check('ball not inside obstacle', !inside);
  check('obstacle contact registered', sim.events.some(e => e.type === 'wall' && e.victims.some(v => v.i === 0)));
}

// Test 4: same-border repeated contact = single damage
{
  const t = getTable('classic');
  const balls = mkBalls([[800, 100], [1400, 800]], 2);
  // shallow angle shot along the top wall
  const sim = runTurn(t, balls, 0, { dx: 0.995, dy: -0.1, speed: 1200, spin: { x: 0, y: 0 } });
  const topHits = sim.events.filter(e => e.type === 'wall' && e.victims.some(v => v.i === 0));
  console.log('   new-contact wall damage events:', topHits.length, '(shallow slide along top wall)');
  check('no runaway same-border damage', balls[0].hp > 60);
}

// Test 5: dead ball takes no damage but transmits hits
{
  const t = getTable('classic');
  const balls = mkBalls([[400, 450], [800, 450], [1000, 450]], 3);
  balls[1].dead = true;
  const sim = runTurn(t, balls, 0, { dx: 1, dy: 0, speed: 1500, spin: { x: 0, y: 0 } });
  check('dead ball hp untouched', balls[1].hp === 100);
  check('dead ball moved when pushed', balls[1].x !== 800);
  console.log('   third ball hp (hit via dead ball):', balls[2].hp.toFixed(1));
}

// Test 6: spin changes outcome of first contact
{
  const t = getTable('classic');
  const mk = () => mkBalls([[800, 450], [300, 200]], 2);
  const b1 = mk(), b2 = mk();
  runTurn(t, b1, 0, { dx: 1, dy: 0, speed: 1200, spin: { x: 0, y: 0 } });
  runTurn(t, b2, 0, { dx: 1, dy: 0, speed: 1200, spin: { x: 0.9, y: 0 } });
  const dist = Math.hypot(b1[0].x - b2[0].x, b1[0].y - b2[0].y);
  console.log('   final position delta with side spin:', dist.toFixed(0), 'units');
  check('spin alters trajectory', dist > 30);
}

// Test 7: recording size sane + frames replayable
{
  const t = getTable('gate');
  const balls = mkBalls(t.spawns, 6);
  const sim = runTurn(t, balls, 0, { dx: 1, dy: 0.2, speed: 1500, spin: { x: 0, y: -0.5 } });
  const payload = JSON.stringify({ frames: sim.frames, events: sim.events });
  console.log('   6-player recording:', sim.frames.length, 'frames,', (payload.length / 1024).toFixed(1), 'KB');
  check('payload under 200KB', payload.length < 200 * 1024);
  check('every frame has 12 coords', sim.frames.every(f => f.length === 12));
  const last = sim.frames[sim.frames.length - 1];
  check('last frame matches final positions', balls.every((b, i) =>
    Math.abs(last[i * 2] - b.x) <= 1 && Math.abs(last[i * 2 + 1] - b.y) <= 1));
}

// Test 8: shot into octagon corner triangles
{
  const t = getTable('octagon');
  const balls = mkBalls([[800, 450]], 1);
  const sim = runTurn(t, balls, 0, { dx: -0.7, dy: -0.714, speed: 1500, spin: { x: 0, y: 0 } });
  const inAnyObs = t.obstacles.some(o => pointInConvexPoly(balls[0].x, balls[0].y, o.pts));
  check('corner triangle keeps ball out', !inAnyObs);
  check('settled', sim.done);
}


// Test 10: teleporter transports the ball, keeps it moving, and settles
{
  const t = getTable('wormholes');
  const balls = mkBalls([[450, 190], [1150, 720]], 2); // near portal 1a at (230,190)
  const sim = runTurn(t, balls, 0, { dx: -1, dy: 0, speed: 900, spin: { x: 0, y: 0 } });
  const tps = sim.events.filter(e => e.type === 'tp');
  check('teleport event fired', tps.length >= 1);
  check('teleported sim settles (no infinite loop)', sim.done);
  // ball rolled into a=(230,190) so it must have come out near b=(1370,710)
  check('ball exited at the paired portal side', balls[0].x > 800);
}

// Test 11: barriers are recorded, pushable, stay in bounds, and hurt on impact
{
  const t = getTable('bastion');
  const barriers = t.barriers.map(([x, y]) => ({ x, y, vx: 0, vy: 0 }));
  const balls = mkBalls([[200, 290], [900, 290]], 2); // barrier at (520,290) between them
  const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 1500, spin: { x: 0, y: 0 } }, { barriers });
  let steps = 0;
  while (!sim.step() && steps < 60 * 30) steps++;
  check('frames include barrier coords', sim.frames.every(f => f.length === (2 + barriers.length) * 2));
  check('barrier moved when rammed', barriers[0].x !== 520);
  check('barriers stay in bounds', barriers.every(b =>
    b.x >= PHYS.BAR_R - 1 && b.x <= TABLE_W - PHYS.BAR_R + 1 && b.y >= PHYS.BAR_R - 1 && b.y <= TABLE_H - PHYS.BAR_R + 1));
  const hitOther = sim.events.some(e => e.type === 'ball' && e.victims.some(v => v.i === 1));
  console.log('   barrier launched into victim, victim hp:', balls[1].hp.toFixed(1));
  check('launched barrier damages the victim', hitOther && balls[1].hp < 100);
}

// Test 12: power-up pickup — shooter collects, and a PUSHED ball collects for ITS owner
{
  const t = getTable('classic');
  const balls = mkBalls([[400, 450], [700, 450]], 2);
  const powerups = [{ id: 'u1', k: 'boost', x: 1000, y: 450, born: 1 },
                    { id: 'u2', k: 'poison', x: 200, y: 200, born: 1 }];
  const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 1100, spin: { x: 0, y: 0 } }, { powerups });
  let steps = 0;
  while (!sim.step() && steps < 60 * 30) steps++;
  const pev = sim.events.filter(e => e.type === 'pu');
  check('pickup event fired', pev.length === 1);
  check('pushed ball keeps the power-up for its owner', pev[0].i === 1 && balls[1].storedPower === 'boost');
  check('picked power-up removed from the table', powerups.length === 1 && powerups[0].id === 'u2');
  check('shooter got nothing', !balls[0].storedPower);
}

// Test 13: effects — boost (stored) travels farther, heavy/tiny (active
// next-turn effects, set via fxNow) change mass, size and shot speed
{
  const t = getTable('classic');
  const run = (effect, fxNow) => {
    const balls = mkBalls([[300, 450], [1400, 800]], 2);
    if (fxNow) balls[0].fxNow = fxNow;
    // slow shot: nobody reaches the far wall, so distances compare cleanly
    const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 500, spin: { x: 0, y: 0 } }, { effect });
    let steps = 0;
    while (!sim.step() && steps < 60 * 30) steps++;
    return { balls, sim };
  };
  const plain = run(null), boost = run('boost'), heavy = run(null, 'heavy');
  check('boost travels farther than plain', boost.balls[0].x > plain.balls[0].x + 50);
  check('heavy travels shorter than plain', heavy.balls[0].x < plain.balls[0].x - 50);
  const tiny = run(null, 'tiny');
  check('tiny shrinks the affected ball', tiny.balls[0].rMul === PHYS.TINY_R);
  check('effect event recorded for replays', boost.sim.events.some(e => e.type === 'fx' && e.kind === 'boost'));

  // tiny is light: a head-on hit barely moves (and barely damages) the victim
  const headOn = (fxNow) => {
    // moderate speed: the victim never reaches a wall, so displacement compares cleanly
    const balls = mkBalls([[400, 450], [800, 450]], 2);
    if (fxNow) balls[0].fxNow = fxNow;
    const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 600, spin: { x: 0, y: 0 } }, {});
    let steps = 0;
    while (!sim.step() && steps < 60 * 30) steps++;
    return balls[1];
  };
  const vPlain = headOn(null), vTiny = headOn('tiny');
  console.log('   victim pushed:', (vPlain.x - 800).toFixed(0), 'units by plain,', (vTiny.x - 800).toFixed(0), 'by tiny');
  check('tiny ball pushes much less', (vTiny.x - 800) < (vPlain.x - 800) * 0.6);
  check('tiny ball damages much less', (100 - vTiny.hp) < (100 - vPlain.hp) * 0.6);
}

// Test 14: blast explodes on first contact and area-damages others (not the shooter)
{
  const t = getTable('classic');
  const balls = mkBalls([[400, 450], [800, 450], [900, 500]], 3);
  const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 1200, spin: { x: 0, y: 0 } }, { effect: 'blast' });
  let steps = 0;
  while (!sim.step() && steps < 60 * 30) steps++;
  const boom = sim.events.find(e => e.type === 'boom');
  check('blast detonated', !!boom);
  check('blast damaged bystanders', boom.victims.some(v => v.i === 2));
  check('blast spared the shooter', !boom.victims.some(v => v.i === 0));
}

// Test 15: power-up spawn roll produces valid positions on every table
{
  // minimal Game-less reimplementation guard: just check the constants exist
  check('power kinds defined', POWER_KIND_IDS.length === 6 && POWER_KIND_IDS.every(k => POWER_KINDS[k].emoji));
  check('trap/buff split', POWER_KIND_IDS.filter(k => POWER_KINDS[k].trap).length === 3);
}

// Test 10: side english kicks toward the side the hit point is on.
// Ball aimed east (+x) with the dot set RIGHT must, after a head-on wall
// bounce, drift to the RIGHT of its aim (screen-down, +y) — and mirrored.
{
  const t = getTable('classic');
  for (const [sx, want] of [[1, +1], [-1, -1]]) {
    const balls = mkBalls([[800, 450]], 1);
    runTurn(t, balls, 0, { dx: 1, dy: 0, speed: 1200, spin: { x: sx, y: 0 } });
    const drift = (balls[0].y - 450) * want;
    check(`spin.x=${sx} deflects to the ${sx > 0 ? 'right' : 'left'} of aim`, drift > 30);
  }
}

// Test 11: heal/poison apply the instant a ball touches them
{
  const t = getTable('classic');
  {
    const balls = mkBalls([[400, 450]], 1);
    balls[0].hp = 50;
    const pu = [{ id: 'u1', k: 'heal', x: 700, y: 450, born: 0 }];
    const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 600, spin: { x: 0, y: 0 } }, { powerups: pu });
    let n = 0; while (!sim.step() && n++ < 3600) { /* run */ }
    check('heal applies instantly, nothing stored', Math.abs(balls[0].hp - (50 + PHYS.HEAL_HP)) < 0.01 && !balls[0].storedPower);
    check('heal emits a negative-damage victim (green floater)', sim.events.some(e => e.type === 'pu' && e.victims.some(v => v.dmg < 0)));
    check('heal removed from the table', pu.length === 0);
  }
  {
    const balls = mkBalls([[400, 450]], 1);
    balls[0].hp = 10;
    const pu = [{ id: 'u2', k: 'poison', x: 700, y: 450, born: 0 }];
    const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 600, spin: { x: 0, y: 0 } }, { powerups: pu });
    let n = 0; while (!sim.step() && n++ < 3600) { /* run */ }
    check('poison bites instantly but cannot kill by itself', balls[0].hp === 1 && !balls[0].storedPower);
    check('poison emits a positive-damage victim', sim.events.some(e => e.type === 'pu' && e.victims.some(v => v.dmg > 0)));
  }
}

// Test 12: tiny/heavy schedule for the NEXT turn and are active during it
{
  const t = getTable('classic');
  const balls = mkBalls([[400, 450], [1200, 750]], 2);
  const pu = [{ id: 'u3', k: 'tiny', x: 700, y: 450, born: 0 }];
  const sim = new Sim(balls, t, 0, { dx: 1, dy: 0, speed: 600, spin: { x: 0, y: 0 } }, { powerups: pu });
  let n = 0; while (!sim.step() && n++ < 3600) { /* run */ }
  check('tiny schedules for next turn, nothing stored', balls[0].fxNext === 'tiny' && !balls[0].storedPower);
  check('tiny NOT active during the pickup turn', balls[0].rMul === null);
  // the hand-off every device performs at end of turn (runEndSequence)
  balls.forEach(b => { b.fxNow = b.fxNext || null; b.fxNext = null; });
  new Sim(balls, t, 1, { dx: -1, dy: 0, speed: 600, spin: { x: 0, y: 0 } }, {});
  check('tiny active next turn even when another player shoots',
    balls[0].rMul === PHYS.TINY_R && balls[0].mMul === PHYS.TINY_M);
  balls[1].fxNow = 'heavy';
  new Sim(balls, t, 1, { dx: -1, dy: 0, speed: 1000, spin: { x: 0, y: 0 } }, {});
  check('heavy ball is massive and its own shot is slowed',
    balls[1].mMul === PHYS.HEAVY_M && Math.abs(balls[1].vx + 1000 * PHYS.HEAVY_SPEED) < 0.01);
}

// Test 15: border damage setting — none deals nothing, low deals half
{
  const t = getTable('classic');
  const shot = { dx: -1, dy: 0, speed: 1400, spin: { x: 0, y: 0 } };
  const run = (borderDmg) => {
    const balls = mkBalls([[800, 450]], 1);
    const sim = new Sim(balls, t, 0, shot, { borderDmg });
    let steps = 0;
    while (!sim.step() && steps < 60 * 30) steps++;
    return { hp: balls[0].hp, walls: sim.events.filter(e => e.type === 'wall').length };
  };
  const none = run(0), low = run(PHYS.BORDER_DMG / 2), high = run(PHYS.BORDER_DMG);
  check('none: wall contacts cost nothing (events still fire)', none.hp === 100 && none.walls >= 1);
  check('low: half damage per contact', Math.abs((100 - low.hp) - low.walls * PHYS.BORDER_DMG / 2) < 0.01);
  check('high: full damage per contact', Math.abs((100 - high.hp) - high.walls * PHYS.BORDER_DMG) < 0.01);
  check('default is full damage (constant unchanged)', run(undefined).hp === high.hp);
}

// Test 9: every spawn on every table is clear of obstacles and walls
{
  for (const t of TABLES) {
    let bad = null;
    for (const [x, y] of t.spawns) {
      if (x < PHYS.R + 20 || x > TABLE_W - PHYS.R - 20 || y < PHYS.R + 20 || y > TABLE_H - PHYS.R - 20) { bad = `${t.id} spawn ${x},${y} too close to wall`; break; }
      for (const obs of t.obstacles) {
        if (pointInConvexPoly(x, y, obs.pts)) { bad = `${t.id} spawn ${x},${y} inside obstacle`; break; }
        for (let e = 0; e < obs.pts.length; e++) {
          const [ax, ay] = obs.pts[e];
          const [bx, by] = obs.pts[(e + 1) % obs.pts.length];
          const [cx, cy] = closestOnSegment(x, y, ax, ay, bx, by);
          if (Math.hypot(x - cx, y - cy) < PHYS.R + 20) { bad = `${t.id} spawn ${x},${y} too close to obstacle`; break; }
        }
        if (bad) break;
      }
      for (const tp of (t.teles || [])) {
        for (const [px, py] of [tp.a, tp.b]) {
          if (Math.hypot(x - px, y - py) < PHYS.TELE_R + PHYS.R + 15) { bad = `${t.id} spawn ${x},${y} on a teleporter`; break; }
        }
        if (bad) break;
      }
      for (const [bx, by] of (t.barriers || [])) {
        if (Math.hypot(x - bx, y - by) < PHYS.BAR_R + PHYS.R + 15) { bad = `${t.id} spawn ${x},${y} on a barrier`; break; }
      }
      if (bad) break;
    }
    check(`table ${t.id}: spawns are clear`, !bad);
    if (bad) console.log('   ', bad);
  }
}

// Test 16: determinism guard — the sim must stay bit-identical across JS
// engines, so physics.js may only use IEEE-exact Math functions. Math.exp
// and Math.hypot have engine-dependent precision (see PHYS.SIM_V).
{
  const psrc = fs.readFileSync(path + 'physics.js', 'utf8');
  const banned = psrc.match(/Math\.(?!sqrt\b|round\b|abs\b|min\b|max\b|floor\b|ceil\b|sign\b|trunc\b)\w+\(/g);
  check('physics.js uses only IEEE-exact Math ops', !banned);
  if (banned) console.log('   banned calls:', [...new Set(banned)].join(' '));
}

// Test 17: identical inputs → bit-identical re-simulation (the basis of the
// turn audit in Game.verifyTurn) on a busy table: barriers, a power-up
// pickup, spin, an active tiny effect and a blast, all in one turn.
{
  const t = getTable('bastion');
  const run = () => {
    const balls = mkBalls(t.spawns, 4);
    balls[1].fxNow = 'tiny';
    const barriers = t.barriers.map(([x, y]) => ({ x, y, vx: 0, vy: 0 }));
    const powerups = [{ id: 'u1', k: 'boost', x: 900, y: 600, born: 1 }];
    const sim = new Sim(balls, t, 0,
      { dx: 0.71, dy: 0.7, speed: 1387.3, spin: { x: 0.33, y: -0.41 } },
      { barriers, powerups, effect: 'blast', borderDmg: 4 });
    let n = 0;
    while (!sim.step() && n++ < 3600) { /* run */ }
    return JSON.stringify({
      f: sim.frames, e: sim.events,
      p: balls.map(b => [b.x, b.y, b.hp]),
      bar: barriers.map(b => [b.x, b.y]), pu: powerups,
    });
  };
  check('re-simulation is bit-identical', run() === run());
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
