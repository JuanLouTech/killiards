// Turn simulation. Runs only on the active player's device; every fixed step
// is recorded so other devices can replay the exact same motion.
//
// Besides player balls the sim can carry extra "bodies": pushable barriers
// (blue squares that behave like heavy balls) recorded in the same frames.
// Static table features handled here: teleporter pairs and power-up pickups.

const PHYS = {
  DT: 1 / 60,          // fixed physics step
  REC_EVERY: 2,        // record positions every N steps (30fps recording)
  R: 28,               // ball radius
  DRAG: 0.6,           // exponential drag for living balls
  DEAD_DRAG: 2.4,      // dead balls are heavier to push around
  WALL_E: 0.86,        // wall restitution
  BALL_E: 0.95,        // ball-ball restitution
  STOP: 8,             // speed below which a ball fully stops
  MIN_SHOT: 380,
  MAX_SHOT: 1500,
  BORDER_DMG: 8,       // fixed damage on every NEW border contact
  BALL_DMG_K: 0.022,   // damage per unit of speed change in ball contacts
  MAX_T: 20,           // safety cap on turn length (seconds)
  MAX_HP: 160,         // starting health

  // barriers (pushable squares, circle physics)
  BAR_R: 34,
  BAR_M: 1.9,          // heavier than balls: launched barriers hit hard
  BAR_DRAG: 1.0,

  // teleporters
  TELE_R: 46,          // trigger radius around each portal center

  // power-ups
  PU_R: 26,            // pickup trigger radius
  PU_LIFE: 4,          // turns a power-up stays on the table
  PU_CHANCE: 0.38,     // spawn roll at the end of each turn
  PU_MAX: 3,           // max simultaneous power-ups

  // effects
  BLAST_R: 230,
  BLAST_DMG: 26,
  BLAST_KICK: 520,
  BOOST_MULT: 1.45,
  HEAL_HP: 25,
  POISON_HP: 18,
  HEAVY_SPEED: 0.55,
  HEAVY_M: 2.2,
  TINY_R: 0.62,
  TINY_M: 0.3,   // very light: a tiny ball barely pushes anyone
};

// Power-up catalogue. Traps are picked up exactly like buffs — shoving an
// enemy ball into one is the whole point.
const POWER_KINDS = {
  blast:  { emoji: '💥', name: 'Blast shot',  trap: false, desc: 'your next shot explodes on first contact' },
  boost:  { emoji: '⚡', name: 'Power boost', trap: false, desc: 'your next shot is much stronger' },
  heal:   { emoji: '💚', name: 'Repair',      trap: false, desc: `+${PHYS.HEAL_HP} energy on your next turn` },
  poison: { emoji: '☠️', name: 'Poison',      trap: true,  desc: `-${PHYS.POISON_HP} energy on your next turn` },
  tiny:   { emoji: '🐜', name: 'Tiny ball',   trap: true,  desc: 'your ball is small and light next turn' },
  heavy:  { emoji: '🪨', name: 'Heavy ball',  trap: true,  desc: 'your next shot is slow and sluggish' },
};
const POWER_KIND_IDS = Object.keys(POWER_KINDS);

// Closest point on segment ab to point p.
function closestOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby || 1;
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return [ax + abx * t, ay + aby * t];
}

function pointInConvexPoly(px, py, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

class Sim {
  // balls: the live match ball objects (mutated in place so the local device
  // can render the simulation directly). shot: {dx, dy, speed, spin:{x,y}}
  // opts: { barriers, powerups, effect, onEvent } — barriers/powerups are the
  // live match arrays, mutated in place like the balls.
  constructor(balls, table, shooterIdx, shot, opts = {}) {
    this.balls = balls;
    this.barriers = opts.barriers || [];
    this.barriers.forEach(b => { b.isBar = true; b.vx = b.vx || 0; b.vy = b.vy || 0; });
    this.bodies = balls.concat(this.barriers);
    this.pu = opts.powerups || null;
    this.table = table;
    this.teles = table.teles || [];
    this.shooterIdx = shooterIdx;
    this.spin = shot.spin && (shot.spin.x || shot.spin.y) ? { ...shot.spin } : null;
    this.spinApplied = false;
    this.frames = [];
    this.events = [];
    this.steps = 0;
    this.acc = 0;
    this.done = false;
    this.onEvent = opts.onEvent || null;

    for (const b of this.bodies) {
      b.vx = 0;
      b.vy = 0;
      b.lastBorder = null; // per-turn "new contact" tracking
      // teleporter re-entry lock: a body resting on a portal must leave it
      // before it can teleport again
      b.teleLock = null;
      this.teles.forEach((t, ti) => {
        if (Math.hypot(b.x - t.a[0], b.y - t.a[1]) < PHYS.TELE_R ||
            Math.hypot(b.x - t.b[0], b.y - t.b[1]) < PHYS.TELE_R) b.teleLock = ti;
      });
    }
    for (const b of balls) { b.rMul = null; b.mMul = null; }

    // stored power-up consumed by this shot (buff or trap, applied the same way)
    this.effect = opts.effect || null;
    this.blastArmed = false;
    const s = balls[shooterIdx];
    let speedMul = 1;
    if (this.effect === 'blast') this.blastArmed = true;
    else if (this.effect === 'boost') speedMul = PHYS.BOOST_MULT;
    else if (this.effect === 'heavy') { speedMul = PHYS.HEAVY_SPEED; s.mMul = PHYS.HEAVY_M; }
    else if (this.effect === 'tiny') { s.rMul = PHYS.TINY_R; s.mMul = PHYS.TINY_M; }
    else if (this.effect === 'heal') s.hp = Math.min(PHYS.MAX_HP, s.hp + PHYS.HEAL_HP);
    else if (this.effect === 'poison') s.hp = Math.max(1, s.hp - PHYS.POISON_HP);
    if (this.effect) {
      this.emit({ f: 0, type: 'fx', kind: this.effect, i: shooterIdx,
        x: Math.round(s.x), y: Math.round(s.y), mag: 0, victims: [] });
    }

    s.vx = shot.dx * shot.speed * speedMul;
    s.vy = shot.dy * shot.speed * speedMul;
    this.recordFrame();
  }

  bodyR(b) {
    return b.isBar ? PHYS.BAR_R : PHYS.R * (b.rMul || 1);
  }

  bodyM(b) {
    return b.isBar ? PHYS.BAR_M : (b.mMul || 1);
  }

  recordFrame() {
    const f = [];
    for (const b of this.bodies) f.push(Math.round(b.x), Math.round(b.y));
    this.frames.push(f);
  }

  recFrame() {
    return this.steps / PHYS.REC_EVERY;
  }

  emit(ev) {
    this.events.push(ev);
    if (this.onEvent) this.onEvent(ev);
  }

  damage(idx, amount, kind, ev) {
    if (idx >= this.balls.length) return; // barriers have no hp
    const b = this.balls[idx];
    if (b.dead) return;
    if (kind === 'ball' && idx === this.shooterIdx) return; // shooter immune to ball hits
    b.hp = Math.max(0, b.hp - amount);
    ev.victims.push({ i: idx, dmg: Math.round(amount * 10) / 10 });
  }

  // Applies spin ("english") once, on the shooter's first contact of the turn.
  applySpin(nx, ny) {
    if (!this.spin || this.spinApplied) return;
    this.spinApplied = true;
    const b = this.balls[this.shooterIdx];
    const speed = Math.hypot(b.vx, b.vy);
    if (speed < 20) return;
    const fx = b.vx / speed, fy = b.vy / speed;
    const tx = -ny, ty = nx;
    // spin.x = side english: dot on the RIGHT kicks the ball to the right of
    // its aim (the raw tangent points the other way, hence the negation)
    // spin.y = follow/draw (dot above center pushes through, below pulls back)
    b.vx += tx * (-this.spin.x) * speed * 0.45 + fx * (-this.spin.y) * speed * 0.4;
    b.vy += ty * (-this.spin.x) * speed * 0.45 + fy * (-this.spin.y) * speed * 0.4;
  }

  // Blast power-up: the shooter's first contact of any kind detonates.
  maybeBlast(cx, cy) {
    if (!this.blastArmed) return;
    this.blastArmed = false;
    const ev = { f: this.recFrame(), type: 'boom', x: Math.round(cx), y: Math.round(cy), mag: 900, victims: [] };
    this.bodies.forEach((b, i) => {
      const d = Math.hypot(b.x - cx, b.y - cy);
      if (d > PHYS.BLAST_R) return;
      const k = 1 - d / PHYS.BLAST_R;
      if (d > 0.5) {
        const kick = PHYS.BLAST_KICK * k / this.bodyM(b);
        b.vx += (b.x - cx) / d * kick;
        b.vy += (b.y - cy) / d * kick;
      }
      if (i < this.balls.length && i !== this.shooterIdx) {
        this.damage(i, PHYS.BLAST_DMG * k, 'boom', ev);
      }
    });
    this.emit(ev);
  }

  borderContact(idx, borderId, x, y, mag) {
    const b = this.bodies[idx];
    if (b.lastBorder === borderId) return; // same border: no new damage
    b.lastBorder = borderId;
    const ev = { f: this.recFrame(), type: 'wall', x: Math.round(x), y: Math.round(y), mag: Math.round(mag), victims: [] };
    this.damage(idx, PHYS.BORDER_DMG, 'wall', ev);
    this.emit(ev);
  }

  collideWalls(idx) {
    const b = this.bodies[idx];
    const R = this.bodyR(b), E = PHYS.WALL_E;
    let hit = null;
    if (b.x < R) { b.x = R; if (b.vx < 0) { hit = ['W_L', Math.abs(b.vx), 1, 0]; b.vx = -b.vx * E; } }
    else if (b.x > TABLE_W - R) { b.x = TABLE_W - R; if (b.vx > 0) { hit = ['W_R', Math.abs(b.vx), -1, 0]; b.vx = -b.vx * E; } }
    if (b.y < R) { b.y = R; if (b.vy < 0) { hit = ['W_T', Math.abs(b.vy), 0, 1]; b.vy = -b.vy * E; } }
    else if (b.y > TABLE_H - R) { b.y = TABLE_H - R; if (b.vy > 0) { hit = ['W_B', Math.abs(b.vy), 0, -1]; b.vy = -b.vy * E; } }
    if (hit) {
      const [id, mag, nx, ny] = hit;
      if (idx === this.shooterIdx) { this.applySpin(nx, ny); this.maybeBlast(b.x, b.y); }
      if (mag > 12) this.borderContact(idx, id, b.x, b.y, mag);
    }
  }

  collideObstacles(idx) {
    const b = this.bodies[idx];
    const R = this.bodyR(b);
    this.table.obstacles.forEach((obs, oi) => {
      const pts = obs.pts;
      let best = null;
      for (let e = 0; e < pts.length; e++) {
        const [ax, ay] = pts[e];
        const [bx, by] = pts[(e + 1) % pts.length];
        const [cx, cy] = closestOnSegment(b.x, b.y, ax, ay, bx, by);
        const d = Math.hypot(b.x - cx, b.y - cy);
        if (!best || d < best.d) best = { d, cx, cy, e };
      }
      const inside = pointInConvexPoly(b.x, b.y, pts);
      if (!inside && best.d >= R) return;

      let nx, ny;
      if (inside || best.d < 0.001) {
        // Center on/inside the polygon: push out along the nearest edge normal.
        const [ax, ay] = pts[best.e];
        const [bx2, by2] = pts[(best.e + 1) % pts.length];
        const ex = bx2 - ax, ey = by2 - ay;
        const el = Math.hypot(ex, ey) || 1;
        nx = ey / el; ny = -ex / el;
        if (pointInConvexPoly(b.x + nx * 5, b.y + ny * 5, pts)) { nx = -nx; ny = -ny; }
        b.x = best.cx + nx * R;
        b.y = best.cy + ny * R;
      } else {
        nx = (b.x - best.cx) / best.d;
        ny = (b.y - best.cy) / best.d;
        b.x = best.cx + nx * R;
        b.y = best.cy + ny * R;
      }
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= (1 + PHYS.WALL_E) * vn * nx;
        b.vy -= (1 + PHYS.WALL_E) * vn * ny;
        if (idx === this.shooterIdx) { this.applySpin(nx, ny); this.maybeBlast(best.cx, best.cy); }
        if (Math.abs(vn) > 12) {
          this.borderContact(idx, `o${oi}e${best.e}`, best.cx, best.cy, Math.abs(vn));
        }
      }
    });
  }

  collideBodies() {
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) {
        const a = this.bodies[i], b = this.bodies[j];
        const RR = this.bodyR(a) + this.bodyR(b);
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= RR || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        // separate overlap equally
        const push = (RR - d) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn >= 0) continue;
        // impulse along the normal, mass-aware (barriers and heavy/tiny balls)
        const ma = this.bodyM(a), mb = this.bodyM(b);
        const jn = -(1 + PHYS.BALL_E) * rvn / (1 / ma + 1 / mb);
        a.vx -= jn / ma * nx; a.vy -= jn / ma * ny;
        b.vx += jn / mb * nx; b.vy += jn / mb * ny;

        if (i === this.shooterIdx) { this.applySpin(-nx, -ny); this.maybeBlast((a.x + b.x) / 2, (a.y + b.y) / 2); }
        else if (j === this.shooterIdx) { this.applySpin(nx, ny); this.maybeBlast((a.x + b.x) / 2, (a.y + b.y) / 2); }

        if (jn > 15) {
          const ev = {
            f: this.recFrame(), type: 'ball',
            x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2),
            mag: Math.round(jn), victims: [],
          };
          // damage proportional to the speed change caused by the contact
          this.damage(i, jn / ma * PHYS.BALL_DMG_K, 'ball', ev);
          this.damage(j, jn / mb * PHYS.BALL_DMG_K, 'ball', ev);
          this.emit(ev);
        }
      }
    }
  }

  checkTeleports() {
    if (!this.teles.length) return;
    for (const b of this.bodies) {
      this.teles.forEach((t, ti) => {
        const da = Math.hypot(b.x - t.a[0], b.y - t.a[1]);
        const db = Math.hypot(b.x - t.b[0], b.y - t.b[1]);
        if (b.teleLock === ti) {
          if (da > PHYS.TELE_R + 20 && db > PHYS.TELE_R + 20) b.teleLock = null;
          return;
        }
        if (b.teleLock !== null) return;
        let from = null, to = null;
        if (da < PHYS.TELE_R) { from = t.a; to = t.b; }
        else if (db < PHYS.TELE_R) { from = t.b; to = t.a; }
        if (!from) return;
        b.x = to[0] + (b.x - from[0]);
        b.y = to[1] + (b.y - from[1]);
        b.teleLock = ti;
        this.emit({ f: this.recFrame(), type: 'tp', x: from[0], y: from[1],
          x2: to[0], y2: to[1], mag: 300, victims: [] });
      });
    }
  }

  checkPickups() {
    if (!this.pu || !this.pu.length) return;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (b.dead) continue;
      for (let p = this.pu.length - 1; p >= 0; p--) {
        const u = this.pu[p];
        if (Math.hypot(b.x - u.x, b.y - u.y) < PHYS.PU_R + this.bodyR(b)) {
          this.pu.splice(p, 1);
          b.storedPower = u.k; // whoever's ball touches it keeps it — traps included
          this.emit({ f: this.recFrame(), type: 'pu', x: u.x, y: u.y,
            id: u.id, k: u.k, i, mag: 0, victims: [] });
        }
      }
    }
  }

  step() {
    const dt = PHYS.DT;
    for (const b of this.bodies) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    for (let i = 0; i < this.bodies.length; i++) {
      this.collideWalls(i);
      this.collideObstacles(i);
    }
    this.collideBodies();
    this.checkTeleports();
    this.checkPickups();

    let anyMoving = false;
    for (const b of this.bodies) {
      const drag = b.isBar ? PHYS.BAR_DRAG : (b.dead ? PHYS.DEAD_DRAG : PHYS.DRAG);
      const mult = Math.exp(-drag * dt);
      b.vx *= mult; b.vy *= mult;
      if (Math.hypot(b.vx, b.vy) < PHYS.STOP) { b.vx = 0; b.vy = 0; }
      else anyMoving = true;
    }

    this.steps++;
    if (this.steps % PHYS.REC_EVERY === 0) this.recordFrame();

    const t = this.steps * dt;
    if ((!anyMoving && t > 0.25) || t > PHYS.MAX_T) {
      if (this.steps % PHYS.REC_EVERY !== 0) this.recordFrame();
      this.done = true;
    }
    return this.done;
  }

  // Advance by real elapsed time; returns true when the turn has settled.
  tick(dtReal) {
    this.acc += Math.min(dtReal, 0.1);
    while (this.acc >= PHYS.DT && !this.done) {
      this.acc -= PHYS.DT;
      this.step();
    }
    return this.done;
  }
}
