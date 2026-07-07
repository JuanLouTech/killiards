// Match conductor: turn sequencing, live simulation + recording on the active
// player's device, faithful replay everywhere else, damage animation, deaths,
// power-up lifecycle, bot turns (host-simulated), best-play tracking and the
// final survival ranking.

const Game = {
  match: null,
  running: false,
  lastFrame: 0,
  bestPlay: null,
  TURN_SECONDS: 60,

  // separated so tests can stub it; rAF already pauses when the tab is hidden
  hasFocus() { return typeof document !== 'undefined' && document.hasFocus(); },

  // d: {tableId, order:[{id,name,emoji,color,isBot}], spawns:[[x,y]...]}
  startMatch(d) {
    const table = getTable(d.tableId);
    const balls = d.order.map((p, i) => ({
      id: p.id, name: p.name, emoji: p.emoji, color: p.color, isBot: !!p.isBot,
      x: d.spawns[i][0], y: d.spawns[i][1], vx: 0, vy: 0,
      hp: PHYS.MAX_HP, hpShow: PHYS.MAX_HP, dead: false, deathTurn: null,
      lastBorder: null, storedPower: null, rMul: null, mMul: null,
    }));
    this.match = {
      table, balls,
      barriers: (table.barriers || []).map(([x, y]) => ({ x, y, vx: 0, vy: 0, isBar: true })),
      powerups: [],
      turnIdx: 0, turnCount: 1,
      mode: 'idle',       // idle | live | replay | end | bestplay | over
      sim: null, replay: null, endPhase: null, turnQueue: [],
      activeFx: null,     // stored power consumed by the current shot
      hpAtTurn: balls.map(b => b.hp),
      deadAtTurn: balls.map(b => b.dead),
      barsAlpha: 1,
    };
    this.bestPlay = null;
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
    m.turnTimer = this.TURN_SECONDS;
    m.hpAtTurn = m.balls.map(b => b.hp);
    m.deadAtTurn = m.balls.map(b => b.dead);
    const cur = this.currentBall();
    const mine = cur.id === Net.myId;
    if (mine) SFX.turnStart();
    const icon = cur.storedPower ? ` ${POWER_KINDS[cur.storedPower].emoji}` : '';
    Controls.setTurn({
      active: mine,
      color: cur.color,
      message: mine
        ? `<b style="color:${cur.color}">Your turn!</b>${icon}`
        : `Turn: <b style="color:${cur.color}">${esc(dispName(cur))}</b>${icon}`,
    });
    // a recording for this turn may already be waiting (it arrived while we
    // were still replaying the previous one): play it now
    if (m.turnQueue.length) {
      this.startReplay(m.turnQueue.shift());
      return;
    }
    // bot turns are simulated by the host, exactly like a local shot
    if (cur.isBot && Net.isHost) {
      const tc = m.turnCount;
      setTimeout(() => { if (this.match === m) this.botShoot(tc); }, 900 + Math.random() * 1200);
    }
  },

  // ---- shooting (local player's turn, or a bot's turn on the host) ----

  shoot(input) {
    const m = this.match;
    if (!m || m.mode !== 'idle' || this.currentBall().id !== Net.myId) return;
    this.performShot(input);
  },

  botShoot(tc) {
    const m = this.match;
    if (!m || m.mode !== 'idle' || m.turnCount !== tc) return;
    if (!this.currentBall().isBot || !Net.isHost) return;
    this.performShot(this.botPlan());
  },

  botPlan() {
    const m = this.match;
    const me = this.currentBall();
    const foes = m.balls.filter(b => !b.dead && b !== me);
    const distTo = (p) => Math.hypot(p.x - me.x, p.y - me.y);
    let tx = TABLE_W / 2, ty = TABLE_H / 2;
    const buffs = m.powerups.filter(u => !POWER_KINDS[u.k].trap);
    if (buffs.length && (!foes.length || Math.random() < 0.3)) {
      const u = buffs.reduce((a, c) => (distTo(c) < distTo(a) ? c : a));
      tx = u.x; ty = u.y;
    } else if (foes.length) {
      // favour close and weak targets
      const t = foes.reduce((a, c) => (distTo(c) + c.hp * 4 < distTo(a) + a.hp * 4 ? c : a));
      tx = t.x; ty = t.y;
    }
    const a = Math.atan2(ty - me.y, tx - me.x) + (Math.random() * 2 - 1) * 0.09;
    const power = Math.max(0.55, Math.min(1, Math.hypot(tx - me.x, ty - me.y) / 1000 + 0.35));
    return { dx: Math.cos(a), dy: Math.sin(a), power, spin: { x: 0, y: 0 } };
  },

  performShot(input) {
    const m = this.match;
    const shooter = this.currentBall();
    const effect = shooter.storedPower || null;
    shooter.storedPower = null;
    m.activeFx = effect;
    const speed = PHYS.MIN_SHOT + input.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
    const shot = { dx: input.dx, dy: input.dy, speed, spin: input.spin };
    m.sim = new Sim(m.balls, m.table, m.turnIdx, shot, {
      barriers: m.barriers,
      powerups: m.powerups,
      effect,
      onEvent: (ev) => this.handleEvent(ev),
    });
    m.mode = 'live';
    SFX.shoot(input.power);
    Controls.setTurn({ active: false, color: shooter.color, message: '&nbsp;' });
  },

  finishLiveTurn() {
    const m = this.match;
    const spawn = this.rollPowerSpawn();
    const payload = {
      tc: m.turnCount,
      sh: m.turnIdx,
      fx: m.activeFx,
      frames: m.sim.frames,
      events: m.sim.events,
      final: {
        p: m.balls.map(b => [Math.round(b.x), Math.round(b.y)]),
        hp: m.balls.map(b => Math.round(b.hp * 10) / 10),
        sp: m.balls.map(b => b.storedPower || null),
        bar: m.barriers.map(b => [Math.round(b.x), Math.round(b.y)]),
        pu: m.powerups.concat(spawn ? [spawn] : []),
      },
    };
    m.sim = null;
    this.scoreBestPlay(payload);
    Net.send({ t: 'turn', d: payload });
    this.runEndSequence(payload.final);
  },

  // A power-up may appear for the NEXT turn. The device that just simulated
  // rolls it and ships it in the authoritative payload, so every device sees
  // the exact same spawn with no extra messages or races.
  rollPowerSpawn() {
    const m = this.match;
    if (m.powerups.length >= PHYS.PU_MAX || Math.random() > PHYS.PU_CHANCE) return null;
    const kind = POWER_KIND_IDS[Math.floor(Math.random() * POWER_KIND_IDS.length)];
    for (let tries = 0; tries < 40; tries++) {
      const x = 110 + Math.random() * (TABLE_W - 220);
      const y = 110 + Math.random() * (TABLE_H - 220);
      if (m.balls.some(b => Math.hypot(b.x - x, b.y - y) < 160)) continue;
      if (m.powerups.some(u => Math.hypot(u.x - x, u.y - y) < 140)) continue;
      if (m.barriers.some(b => Math.hypot(b.x - x, b.y - y) < 130)) continue;
      if ((m.table.teles || []).some(t =>
        Math.hypot(t.a[0] - x, t.a[1] - y) < 150 || Math.hypot(t.b[0] - x, t.b[1] - y) < 150)) continue;
      const nearObstacle = m.table.obstacles.some(o => {
        if (pointInConvexPoly(x, y, o.pts)) return true;
        for (let e = 0; e < o.pts.length; e++) {
          const [ax, ay] = o.pts[e];
          const [bx, by] = o.pts[(e + 1) % o.pts.length];
          const [cx, cy] = closestOnSegment(x, y, ax, ay, bx, by);
          if (Math.hypot(x - cx, y - cy) < 90) return true;
        }
        return false;
      });
      if (nearObstacle) continue;
      return {
        id: 'u' + m.turnCount + '_' + Math.floor(Math.random() * 1e6),
        k: kind, x: Math.round(x), y: Math.round(y), born: m.turnCount,
      };
    }
    return null;
  },

  // ---- replaying someone else's turn ----

  onTurnResult(d) {
    const m = this.match;
    if (!m || m.mode === 'over') return;
    // a recording can arrive while this device is still replaying the
    // previous turn (bot turns: the host plays on without waiting for our
    // replay to finish) — queue it instead of clobbering the replay
    if (m.mode !== 'idle') {
      m.turnQueue.push(d);
      return;
    }
    this.startReplay(d);
  },

  startReplay(d) {
    const m = this.match;
    this.scoreBestPlay(d);
    // effect visuals during the replay (positions come from the frames)
    if (d.fx === 'tiny') m.balls[d.sh].rMul = PHYS.TINY_R;
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
    m.barriers.forEach((br, i) => {
      const o = (m.balls.length + i) * 2;
      if (A.length > o + 1) {
        br.x = A[o] + (B[o] - A[o]) * k;
        br.y = A[o + 1] + (B[o + 1] - A[o + 1]) * k;
      }
    });
    while (rp.evIdx < rp.events.length && rp.events[rp.evIdx].f <= rp.f) {
      this.handleEvent(rp.events[rp.evIdx]);
      rp.evIdx++;
    }
    if (rp.f >= last) {
      const wasBestPlay = rp.bestplay;
      const final = rp.final;
      m.replay = null;
      if (wasBestPlay) this.endBestPlay();
      else this.runEndSequence(final);
    }
  },

  // FX for a simulation event, live or replayed. Sounds, sparks, camera
  // shake, plus the visual side of pickups/teleports/explosions.
  handleEvent(ev) {
    const m = this.match;
    const myIdx = this.myBallIdx();
    if (ev.type === 'wall') {
      SFX.wall(ev.mag);
      Renderer.spawnSparks(ev.x, ev.y, 8, '#41ff5a', 260);
    } else if (ev.type === 'ball') {
      SFX.ball(ev.mag * 2);
      Renderer.spawnSparks(ev.x, ev.y, 12, '#41ff5a', 260);
    } else if (ev.type === 'pu') {
      const kind = POWER_KINDS[ev.k];
      SFX.powerup();
      Renderer.spawnSparks(ev.x, ev.y, 18, kind.trap ? '#c86bff' : '#ffd84d', 320);
      m.powerups = m.powerups.filter(u => u.id !== ev.id); // no-op on the live device
      const b = m.balls[ev.i];
      if (b) b.storedPower = ev.k;
      if (ev.i === myIdx) {
        UI.toast(`${kind.trap ? 'Uh-oh… you caught' : 'You got'} ${kind.emoji} ${kind.name}: ${kind.desc}`);
      }
    } else if (ev.type === 'tp') {
      SFX.teleport();
      Renderer.spawnSparks(ev.x, ev.y, 14, '#3ec6ff', 300);
      Renderer.spawnSparks(ev.x2, ev.y2, 14, '#ff6bd6', 300);
    } else if (ev.type === 'boom') {
      SFX.explode();
      Renderer.spawnExplosion(ev.x, ev.y, '#ff9d3b');
    } else if (ev.type === 'fx') {
      const b = m.balls[ev.i];
      if (ev.kind === 'poison') {
        SFX.trap();
        if (b) Renderer.spawnSparks(b.x, b.y, 20, '#a1ff4d', 240);
        if (ev.i === myIdx) UI.toast('☠️ Poison bites: -' + PHYS.POISON_HP + ' energy');
      } else if (ev.kind === 'heal') {
        SFX.powerup();
        if (b) Renderer.spawnSparks(b.x, b.y, 20, '#41ff5a', 240);
      } else if (ev.kind === 'tiny' || ev.kind === 'heavy') {
        SFX.trap();
        if (ev.i === myIdx) UI.toast(POWER_KINDS[ev.kind].emoji + ' ' + POWER_KINDS[ev.kind].name + ' strikes this turn!');
      }
      return; // no shake for effect banners
    }
    const mine = (ev.victims || []).find(v => v.i === myIdx);
    if (mine) Renderer.addShake(4 + mine.dmg * 0.9); // stronger when it's YOUR ball
    else if (ev.victims && ev.victims.length) Renderer.addShake(1.5);
  },

  // Status line under the turn banner: shot clock on your turn, SIMULATING…
  // for everyone watching a recorded/live turn play out.
  updateTurnSub() {
    const m = this.match;
    let text = '', cls = '';
    const cur = m ? this.currentBall() : null;
    if (m && m.mode === 'idle' && cur && cur.id === Net.myId) {
      const s = Math.ceil(Math.max(0, m.turnTimer));
      text = `⏱ ${s}s`;
      if (s <= 10) cls = 'urgent';
    } else if (m && (m.mode === 'replay' || (m.mode === 'live' && cur && cur.id !== Net.myId))) {
      text = 'SIMULATING…';
      cls = 'simulating';
    }
    if (text !== this._subText || cls !== this._subCls) {
      this._subText = text;
      this._subCls = cls;
      const el = document.getElementById('turn-sub');
      if (el) { el.textContent = text; el.className = cls; }
    }
  },

  // ---- emotes ----

  showEmote(d) {
    const m = this.match;
    if (!m) return;
    const b = m.balls.find(x => x.id === d.id);
    if (b) Renderer.spawnEmote(b.x, b.y - PHYS.R - 14, d.e);
    SFX.pop();
  },

  // ---- end of turn: authoritative state, bar animation, deaths ----

  runEndSequence(final) {
    const m = this.match;
    m.balls.forEach((b, i) => {
      b.x = final.p[i][0];
      b.y = final.p[i][1];
      b.vx = 0; b.vy = 0;
      b.hp = final.hp[i];
      b.rMul = null; b.mMul = null;
      if (final.sp) b.storedPower = final.sp[i];
    });
    if (final.bar) {
      m.barriers.forEach((br, i) => {
        if (final.bar[i]) { br.x = final.bar[i][0]; br.y = final.bar[i][1]; br.vx = 0; br.vy = 0; }
      });
    }
    if (final.pu) m.powerups = final.pu;
    m.activeFx = null;
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
      setTimeout(() => this.maybeBestPlay(), 900);
      return;
    }
    // power-ups fade out after a few turns on the table
    m.turnCount++;
    m.powerups = m.powerups.filter(u => m.turnCount - u.born <= PHYS.PU_LIFE);
    // next living player in order
    let idx = m.turnIdx;
    do { idx = (idx + 1) % m.balls.length; } while (m.balls[idx].dead);
    m.turnIdx = idx;
    this.beginTurn();
  },

  // ---- best play of the match ----

  // Every device scores every turn payload the same way, so they all agree
  // on the best play without any extra networking.
  scoreBestPlay(payload) {
    const m = this.match;
    let score = 0;
    for (const ev of payload.events) {
      for (const v of (ev.victims || [])) if (v.i !== payload.sh) score += v.dmg;
    }
    m.balls.forEach((b, i) => {
      if (i !== payload.sh && !m.deadAtTurn[i] && m.hpAtTurn[i] > 0 && payload.final.hp[i] <= 0) {
        score += 45; // kill bonus
      }
    });
    if (!this.bestPlay || score > this.bestPlay.score) {
      this.bestPlay = {
        score: Math.round(score),
        frames: payload.frames, events: payload.events,
        sh: payload.sh, fx: payload.fx, tc: payload.tc,
        deadMask: m.balls.map(b => b.dead),
      };
    }
  },

  maybeBestPlay() {
    const m = this.match;
    const bp = this.bestPlay;
    if (!m || !bp || bp.score < 20 || m.balls.length < 2) {
      UI.showRanking(this.ranking());
      return;
    }
    this._savedEnd = m.balls.map(b => ({ dead: b.dead, x: b.x, y: b.y }));
    m.balls.forEach((b, i) => {
      b.dead = bp.deadMask[i];
      b.rMul = (bp.fx === 'tiny' && i === bp.sh) ? PHYS.TINY_R : null;
    });
    m.replay = { frames: bp.frames, events: bp.events, evIdx: 0, f: 0, final: null, bestplay: true };
    m.mode = 'bestplay';
    UI.showBestPlayBar(bp, m.balls[bp.sh]);
    SFX.fanfare();
  },

  endBestPlay() {
    const m = this.match;
    if (!m) return;
    m.replay = null;
    m.mode = 'over';
    if (this._savedEnd) {
      m.balls.forEach((b, i) => {
        b.dead = this._savedEnd[i].dead;
        b.x = this._savedEnd[i].x;
        b.y = this._savedEnd[i].y;
        b.rMul = null;
      });
      this._savedEnd = null;
    }
    UI.hideBestPlayBar();
    UI.showRanking(this.ranking());
  },

  skipBestPlay() {
    const m = this.match;
    if (m && m.mode === 'bestplay') this.endBestPlay();
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
    UI.toast(`${dispName(b)} left the match`);
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
    } else if ((m.mode === 'replay' || m.mode === 'bestplay') && m.replay) {
      this.stepReplay(dt);
    } else if (m.mode === 'end' && m.endPhase) {
      this.stepEnd(dt);
    } else if (m.mode === 'idle') {
      // 60s shot clock: only ticks on the active player's device while the
      // app is focused (rAF already pauses it in the background)
      const cur = this.currentBall();
      if (cur && cur.id === Net.myId && this.hasFocus()) {
        m.turnTimer -= dt;
        if (m.turnTimer <= 0) {
          UI.toast('⏱ Time is up — auto shot!');
          this.performShot(this.botPlan());
        }
      }
    }
    this.updateTurnSub();

    // bars visible when balls are at rest, hidden while they move
    const barsTarget = (m.mode === 'live' || m.mode === 'replay' || m.mode === 'bestplay') ? 0 : 1;
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

    Renderer.draw({
      table: m.table, balls: m.balls, barsAlpha: m.barsAlpha, aim,
      barriers: m.barriers, powerups: m.powerups,
    });
  },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Nameless players (bots, or people who skipped the name field) are shown by
// their emoji in turn banners, rankings and toasts.
function dispName(p) {
  return p.name || p.emoji;
}
