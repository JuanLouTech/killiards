// Bot shot planning. Pure function of the match state — no DOM, no
// networking — so it also runs headless in Node (test/bots.test.js).
//
// The whole game is deterministic, so the same Sim class that plays a turn
// can silently "audition" candidate shots on a cloned copy of the table; the
// bot simply picks the best-scoring outcome. Only the host plans bot turns,
// and the chosen shot goes through the normal record-and-broadcast path, so
// nothing changes for the network protocol.
//
// Difficulty is three dials: how many candidates the bot auditions, how much
// execution error is added AFTER it has decided (a bad player can pick the
// right shot and still miss it), and how much the scoring cares about
// self-preservation, power-ups and final position.

const BOT_LEVELS = {
  easy: { sims: 7,  aimNoise: 0.12,  powerNoise: 0.2,  selfW: 0.35, killBonus: 30, pickups: false, trapAvoid: 0,  random: 3,  position: 0,   spin: false },
  mid:  { sims: 20, aimNoise: 0.045, powerNoise: 0.08, selfW: 1.0,  killBonus: 60, pickups: true,  trapAvoid: 14, random: 6,  position: 0.5, spin: false },
  hard: { sims: 46, aimNoise: 0.008, powerNoise: 0.02, selfW: 1.35, killBonus: 90, pickups: true,  trapAvoid: 26, random: 18, position: 1,   spin: true },
};
const BOT_LEVEL_IDS = Object.keys(BOT_LEVELS);

const BotAI = {
  // state: {balls, table, barriers, powerups, turnIdx} — the live match
  // arrays; they are cloned before any simulation, never mutated.
  // Returns {dx, dy, power, spin} exactly like the touch controls do.
  plan(state, level) {
    const cfg = BOT_LEVELS[level] || BOT_LEVELS.mid;
    let best = null;
    for (const c of this.candidates(state, cfg).slice(0, cfg.sims)) {
      const score = this.audition(state, c, cfg) + Math.random() * 2; // tie-break jitter
      if (!best || score > best.score) best = { c, score };
    }
    const c = best.c;
    const a = Math.atan2(c.dy, c.dx) + (Math.random() * 2 - 1) * cfg.aimNoise;
    const power = Math.min(1, Math.max(0.15, c.power * (1 + (Math.random() * 2 - 1) * cfg.powerNoise)));
    return { dx: Math.cos(a), dy: Math.sin(a), power, spin: c.spin };
  },

  // Candidate shots in priority order (the sims budget cuts the tail):
  // direct hits on every living foe, buff pickups, then random exploratory
  // shots that discover banks, doubles and escapes.
  candidates(state, cfg) {
    const { balls, powerups, turnIdx } = state;
    const me = balls[turnIdx];
    const list = [];
    const aimAt = (x, y, power) => {
      const d = Math.hypot(x - me.x, y - me.y) || 1;
      list.push({ dx: (x - me.x) / d, dy: (y - me.y) / d, power, spin: { x: 0, y: 0 } });
    };
    const foes = balls.filter(b => !b.dead && b !== me).sort((a, b) => a.hp - b.hp);
    for (const f of foes) {
      const d = Math.hypot(f.x - me.x, f.y - me.y);
      aimAt(f.x, f.y, Math.min(1, Math.max(0.5, d / 950 + 0.4)));
      aimAt(f.x, f.y, 1);
      aimAt(f.x, f.y, 0.62);
    }
    if (cfg.pickups) {
      for (const u of powerups.filter(u => !POWER_KINDS[u.k].trap)) {
        const d = Math.hypot(u.x - me.x, u.y - me.y);
        aimAt(u.x, u.y, Math.min(0.9, Math.max(0.35, d / 1100 + 0.25)));
      }
    }
    for (let i = 0; i < cfg.random; i++) {
      const a = Math.random() * Math.PI * 2;
      const spin = cfg.spin && Math.random() < 0.5
        ? { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 }
        : { x: 0, y: 0 };
      list.push({ dx: Math.cos(a), dy: Math.sin(a), power: 0.45 + Math.random() * 0.55, spin });
    }
    return list;
  },

  // Run one candidate to completion on cloned state and score the outcome.
  audition(state, c, cfg) {
    const balls = state.balls.map(b => ({ ...b }));
    const barriers = state.barriers.map(b => ({ ...b }));
    const powerups = state.powerups.map(u => ({ ...u }));
    const me = balls[state.turnIdx];
    const effect = me.storedPower || null; // performShot will consume it too
    me.storedPower = null;
    const speed = PHYS.MIN_SHOT + c.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
    const sim = new Sim(balls, state.table, state.turnIdx,
      { dx: c.dx, dy: c.dy, speed, spin: c.spin }, { barriers, powerups, effect });
    let guard = 0;
    while (!sim.step() && guard++ < 60 * (PHYS.MAX_T + 1)) { /* run silently */ }
    return this.score(state, balls, powerups, cfg);
  },

  score(state, after, afterPu, cfg) {
    const before = state.balls;
    const idx = state.turnIdx;
    const me = after[idx];
    let s = 0;
    after.forEach((b, i) => {
      if (i === idx || before[i].dead) return;
      s += before[i].hp - b.hp;                   // damage dealt (foe heals count against)
      if (b.hp <= 0) s += cfg.killBonus;          // kill secured
      if (b.storedPower && !before[i].storedPower) s -= 10; // fed a foe a buff
      if (b.fxNext && !before[i].fxNext) s += 6;  // handicapped a foe's next turn
    });
    s -= (before[idx].hp - me.hp) * cfg.selfW;    // self harm (self heals reward)
    if (me.hp <= 0) s -= 500;                     // never suicide
    if (me.storedPower) s += 22;                  // banked a blast/boost
    if (me.fxNext) s -= cfg.trapAvoid;            // our ball is handicapped next turn
    if (cfg.position) {
      // resting against a border or next to a trap is asking to be punished
      const wall = Math.min(me.x, me.y, TABLE_W - me.x, TABLE_H - me.y);
      if (wall < 110) s -= (110 - wall) * 0.06 * cfg.position;
      for (const u of afterPu) {
        if (POWER_KINDS[u.k].trap && Math.hypot(u.x - me.x, u.y - me.y) < 170) {
          s -= 8 * cfg.position;
        }
      }
    }
    return s;
  },
};
