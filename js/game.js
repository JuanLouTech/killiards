// Match conductor: turn sequencing, live simulation + recording on the active
// player's device, faithful replay everywhere else, damage animation, deaths,
// and the final survival ranking.

const Game = {
  match: null,
  running: false,
  lastFrame: 0,

  // d: {tableId, order:[{id,name,emoji,color}], spawns:[[x,y]...]}
  startMatch(d) {
    const table = getTable(d.tableId);
    const balls = d.order.map((p, i) => ({
      id: p.id, name: p.name, emoji: p.emoji, color: p.color,
      x: d.spawns[i][0], y: d.spawns[i][1], vx: 0, vy: 0,
      hp: PHYS.MAX_HP, hpShow: PHYS.MAX_HP, dead: false, deathTurn: null, lastBorder: null,
    }));
    this.match = {
      table, balls,
      turnIdx: 0, turnCount: 1,
      mode: 'idle',       // idle | live | replay | end | over
      sim: null, replay: null, endPhase: null,
      barsAlpha: 1,
    };
  },

  myBallIdx() {
    return this.match.balls.findIndex(b => b.id === Net.myId);
  },

  currentBall() {
    return this.match.balls[this.match.turnIdx];
  },

  beginTurn() {
    const m = this.match;
    m.mode = 'idle';
    const cur = this.currentBall();
    const mine = cur.id === Net.myId;
    if (mine) SFX.turnStart();
    Controls.setTurn({
      active: mine,
      color: cur.color,
      message: mine
        ? `<b style="color:${cur.color}">Your turn!</b>`
        : `Turn: <b style="color:${cur.color}">${esc(cur.name)}</b>`,
    });
  },

  // ---- shooting (local player's turn) ----

  shoot(input) {
    const m = this.match;
    if (!m || m.mode !== 'idle' || this.currentBall().id !== Net.myId) return;
    const speed = PHYS.MIN_SHOT + input.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
    const shot = { dx: input.dx, dy: input.dy, speed, spin: input.spin };
    m.sim = new Sim(m.balls, m.table, m.turnIdx, shot);
    m.sim.onEvent = (ev) => this.handleEvent(ev);
    m.mode = 'live';
    SFX.shoot(input.power);
    Controls.setTurn({ active: false, color: this.currentBall().color, message: '&nbsp;' });
  },

  finishLiveTurn() {
    const m = this.match;
    const payload = {
      tc: m.turnCount,
      sh: m.turnIdx,
      frames: m.sim.frames,
      events: m.sim.events,
      final: {
        p: m.balls.map(b => [Math.round(b.x), Math.round(b.y)]),
        hp: m.balls.map(b => Math.round(b.hp * 10) / 10),
      },
    };
    m.sim = null;
    Net.send({ t: 'turn', d: payload });
    this.runEndSequence(payload.final);
  },

  // ---- replaying someone else's turn ----

  onTurnResult(d) {
    const m = this.match;
    if (!m || m.mode === 'over') return;
    m.replay = { frames: d.frames, events: d.events, evIdx: 0, f: 0, final: d.final };
    m.mode = 'replay';
    SFX.shoot(0.7);
  },

  stepReplay(dt) {
    const m = this.match;
    const rp = m.replay;
    rp.f += dt * (60 / PHYS.REC_EVERY); // recording is at 30fps
    const last = rp.frames.length - 1;
    const f0 = Math.min(Math.floor(rp.f), last);
    const f1 = Math.min(f0 + 1, last);
    const k = Math.min(1, rp.f - f0);
    const A = rp.frames[f0], B = rp.frames[f1];
    m.balls.forEach((b, i) => {
      b.x = A[i * 2] + (B[i * 2] - A[i * 2]) * k;
      b.y = A[i * 2 + 1] + (B[i * 2 + 1] - A[i * 2 + 1]) * k;
    });
    while (rp.evIdx < rp.events.length && rp.events[rp.evIdx].f <= rp.f) {
      this.handleEvent(rp.events[rp.evIdx]);
      rp.evIdx++;
    }
    if (rp.f >= last) {
      const final = rp.final;
      m.replay = null;
      this.runEndSequence(final);
    }
  },

  // sounds / sparks / camera shake for a collision, live or replayed
  handleEvent(ev) {
    if (ev.type === 'wall') SFX.wall(ev.mag);
    else SFX.ball(ev.mag * 2);
    Renderer.spawnSparks(ev.x, ev.y, ev.type === 'wall' ? 8 : 12, '#41ff5a', 260);
    const myIdx = this.myBallIdx();
    const mine = ev.victims.find(v => v.i === myIdx);
    if (mine) Renderer.addShake(4 + mine.dmg * 0.9); // stronger when it's YOUR ball
    else if (ev.victims.length) Renderer.addShake(1.5);
  },

  // ---- end of turn: authoritative state, bar animation, deaths ----

  runEndSequence(final) {
    const m = this.match;
    m.balls.forEach((b, i) => {
      b.x = final.p[i][0];
      b.y = final.p[i][1];
      b.vx = 0; b.vy = 0;
      b.hp = final.hp[i];
    });
    const deaths = m.balls
      .map((b, i) => (!b.dead && b.hp <= 0 ? i : -1))
      .filter(i => i >= 0);
    m.endPhase = {
      t: 0,
      tweens: m.balls.map(b => ({ b, from: b.hpShow, to: Math.max(0, b.hp) })),
      deaths, deathsFired: false,
      total: 1.0 + (deaths.length ? 0.4 + deaths.length * 0.35 + 0.8 : 0.2),
    };
    m.mode = 'end';
  },

  stepEnd(dt) {
    const m = this.match;
    const ep = m.endPhase;
    ep.t += dt;
    const k = Math.min(1, ep.t / 0.9);
    const ease = 1 - Math.pow(1 - k, 3);
    for (const tw of ep.tweens) tw.b.hpShow = tw.from + (tw.to - tw.from) * ease;

    if (k >= 1 && !ep.deathsFired) {
      ep.deathsFired = true;
      ep.deaths.forEach((idx, n) => {
        setTimeout(() => {
          const b = m.balls[idx];
          if (b.dead) return;
          b.dead = true;
          b.deathTurn = m.turnCount;
          SFX.explode();
          Renderer.spawnExplosion(b.x, b.y, b.color);
        }, 400 + n * 350);
      });
    }
    if (ep.t >= ep.total) {
      m.endPhase = null;
      this.afterTurn();
    }
  },

  afterTurn() {
    const m = this.match;
    const alive = m.balls.filter(b => !b.dead);
    const soloMode = m.balls.length === 1;
    if ((!soloMode && alive.length <= 1) || alive.length === 0) {
      m.mode = 'over';
      Net.matchLocked = false;
      setTimeout(() => UI.showRanking(this.ranking()), 900);
      return;
    }
    // next living player in order
    let idx = m.turnIdx;
    do { idx = (idx + 1) % m.balls.length; } while (m.balls[idx].dead);
    m.turnIdx = idx;
    m.turnCount++;
    this.beginTurn();
  },

  ranking() {
    const m = this.match;
    return [...m.balls].sort((a, b) => {
      if (a.dead !== b.dead) return a.dead ? 1 : -1;      // survivor first
      if (a.dead && b.dead) return b.deathTurn - a.deathTurn; // died later = higher
      return 0;
    });
  },

  playerLeft(id) {
    const m = this.match;
    if (!m || m.mode === 'over') return;
    const idx = m.balls.findIndex(b => b.id === id);
    if (idx < 0) return;
    const wasCurrent = idx === m.turnIdx;
    const b = m.balls[idx];
    if (!b.dead) {
      b.dead = true;
      b.deathTurn = m.turnCount;
      b.hpShow = 0;
      Renderer.spawnExplosion(b.x, b.y, b.color);
    }
    UI.toast(`${b.name} left the match`);
    if (wasCurrent && m.mode === 'idle') this.afterTurn();
  },

  // ---- render loop ----

  startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  stopLoop() { this.running = false; },

  frame(dt) {
    const m = this.match;
    if (!m) return;

    if (m.mode === 'live' && m.sim) {
      if (m.sim.tick(dt)) this.finishLiveTurn();
    } else if (m.mode === 'replay' && m.replay) {
      this.stepReplay(dt);
    } else if (m.mode === 'end' && m.endPhase) {
      this.stepEnd(dt);
    }

    // bars visible when balls are at rest, hidden while they move
    const barsTarget = (m.mode === 'live' || m.mode === 'replay') ? 0 : 1;
    m.barsAlpha += (barsTarget - m.barsAlpha) * Math.min(1, dt * 8);

    // aim arrow while dragging
    let aim = null;
    if (m.mode === 'idle' && this.currentBall() && this.currentBall().id === Net.myId) {
      const a = Controls.getAim();
      if (a) {
        const b = this.currentBall();
        aim = { x: b.x, y: b.y, dx: a.dx, dy: a.dy, power: a.power, color: b.color };
      }
    }

    Renderer.draw({ table: m.table, balls: m.balls, barsAlpha: m.barsAlpha, aim });
  },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
