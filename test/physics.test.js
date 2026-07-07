// Headless smoke test: load tables.js + physics.js and run turns.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'js') + '/';
const src = fs.readFileSync(path + 'tables.js', 'utf8') + '\n' +
  fs.readFileSync(path + 'physics.js', 'utf8') +
  '\n;Object.assign(globalThis, { Sim, PHYS, getTable, TABLE_W, TABLE_H, pointInConvexPoly, closestOnSegment, TABLES });';
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
      if (bad) break;
    }
    check(`table ${t.id}: spawns are clear`, !bad);
    if (bad) console.log('   ', bad);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
