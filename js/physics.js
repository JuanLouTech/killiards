// Turn simulation. Runs only on the active player's device; every fixed step
// is recorded so other devices can replay the exact same motion.

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
};

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
  constructor(balls, table, shooterIdx, shot) {
    this.balls = balls;
    this.table = table;
    this.shooterIdx = shooterIdx;
    this.spin = shot.spin && (shot.spin.x || shot.spin.y) ? { ...shot.spin } : null;
    this.spinApplied = false;
    this.frames = [];
    this.events = [];
    this.steps = 0;
    this.acc = 0;
    this.done = false;
    this.onEvent = null;

    for (const b of balls) {
      b.vx = 0;
      b.vy = 0;
      b.lastBorder = null; // per-turn "new contact" tracking
    }
    const s = balls[shooterIdx];
    s.vx = shot.dx * shot.speed;
    s.vy = shot.dy * shot.speed;
    this.recordFrame();
  }

  recordFrame() {
    const f = [];
    for (const b of this.balls) f.push(Math.round(b.x), Math.round(b.y));
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
    // spin.x = side english (deflects along the contact tangent)
    // spin.y = follow/draw (dot above center pushes through, below pulls back)
    b.vx += tx * this.spin.x * speed * 0.45 + fx * (-this.spin.y) * speed * 0.4;
    b.vy += ty * this.spin.x * speed * 0.45 + fy * (-this.spin.y) * speed * 0.4;
  }

  borderContact(idx, borderId, x, y, mag) {
    const b = this.balls[idx];
    if (b.lastBorder === borderId) return; // same border: no new damage
    b.lastBorder = borderId;
    const ev = { f: this.recFrame(), type: 'wall', x: Math.round(x), y: Math.round(y), mag: Math.round(mag), victims: [] };
    this.damage(idx, PHYS.BORDER_DMG, 'wall', ev);
    this.emit(ev);
  }

  collideWalls(idx) {
    const b = this.balls[idx];
    const R = PHYS.R, E = PHYS.WALL_E;
    let hit = null;
    if (b.x < R) { b.x = R; if (b.vx < 0) { hit = ['W_L', Math.abs(b.vx), 1, 0]; b.vx = -b.vx * E; } }
    else if (b.x > TABLE_W - R) { b.x = TABLE_W - R; if (b.vx > 0) { hit = ['W_R', Math.abs(b.vx), -1, 0]; b.vx = -b.vx * E; } }
    if (b.y < R) { b.y = R; if (b.vy < 0) { hit = ['W_T', Math.abs(b.vy), 0, 1]; b.vy = -b.vy * E; } }
    else if (b.y > TABLE_H - R) { b.y = TABLE_H - R; if (b.vy > 0) { hit = ['W_B', Math.abs(b.vy), 0, -1]; b.vy = -b.vy * E; } }
    if (hit) {
      const [id, mag, nx, ny] = hit;
      if (idx === this.shooterIdx) this.applySpin(nx, ny);
      if (mag > 12) this.borderContact(idx, id, b.x, b.y, mag);
    }
  }

  collideObstacles(idx) {
    const b = this.balls[idx];
    const R = PHYS.R;
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
        if (idx === this.shooterIdx) this.applySpin(nx, ny);
        if (Math.abs(vn) > 12) {
          this.borderContact(idx, `o${oi}e${best.e}`, best.cx, best.cy, Math.abs(vn));
        }
      }
    });
  }

  collideBalls() {
    const R2 = PHYS.R * 2;
    for (let i = 0; i < this.balls.length; i++) {
      for (let j = i + 1; j < this.balls.length; j++) {
        const a = this.balls[i], b = this.balls[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= R2 || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        // separate overlap equally
        const push = (R2 - d) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn >= 0) continue;
        // equal-mass impulse along the normal
        const jn = -(1 + PHYS.BALL_E) * rvn / 2;
        a.vx -= jn * nx; a.vy -= jn * ny;
        b.vx += jn * nx; b.vy += jn * ny;

        if (i === this.shooterIdx) this.applySpin(-nx, -ny);
        else if (j === this.shooterIdx) this.applySpin(nx, ny);

        if (jn > 15) {
          const ev = {
            f: this.recFrame(), type: 'ball',
            x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2),
            mag: Math.round(jn), victims: [],
          };
          // damage proportional to the speed change caused by the contact
          this.damage(i, jn * PHYS.BALL_DMG_K, 'ball', ev);
          this.damage(j, jn * PHYS.BALL_DMG_K, 'ball', ev);
          this.emit(ev);
        }
      }
    }
  }

  step() {
    const dt = PHYS.DT;
    for (const b of this.balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    for (let i = 0; i < this.balls.length; i++) {
      this.collideWalls(i);
      this.collideObstacles(i);
    }
    this.collideBalls();

    let anyMoving = false;
    for (const b of this.balls) {
      const drag = b.dead ? PHYS.DEAD_DRAG : PHYS.DRAG;
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
