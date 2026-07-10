// AI Ready layer: window.KilliardsAI — a stable, human-invisible API that
// lets an AI agent visiting the page play exactly like a human: join a room,
// read the state, preview a few candidate shots, fire through the very same
// code path as a touch drag, and talk in chat. The API cannot express an
// illegal move, and agent turns are audited by every other device exactly
// like human turns (game.js). /llms.txt mirrors describe() for discovery.
//
// Fair play, baked in rather than promised:
//   - agents are visible: their profile ships isAgent and the UI tags them AI
//   - previewShot is capped per turn (a human imagines a few shots, not 500)
//   - the 60s shot clock applies to agents like anyone else
//   - sendChat has the same rate limit as the human chat box
//
// This file only observes the game by wrapping a few UI/Game entry points;
// the game itself stays agent-agnostic and works without it.

(() => {
  const VERSION = 1;
  const PREVIEW_CAP = 5;
  const EVENT_CAP = 200;

  const events = [];
  let dropped = 0;
  let previews = 0;
  let lastChatAt = 0;
  let lastLobbySig = '';
  let reportedLeft = new Set();

  const push = (type, data) => {
    if (events.length >= EVENT_CAP) { events.shift(); dropped++; }
    events.push({ type, ...data });
  };

  const ballView = (b) => ({
    id: b.id, name: dispName(b), you: b.id === Net.myId,
    x: Math.round(b.x), y: Math.round(b.y), hp: Math.round(b.hp * 10) / 10,
    dead: !!b.dead, stored: b.storedPower || null,
    fxNow: b.fxNow || null, fxNext: b.fxNext || null,
    isBot: !!b.isBot, isAgent: !!b.isAgent,
  });

  // ---- observe: wrappers never break the game (errors are swallowed) ----
  const wrap = (obj, key, after) => {
    const orig = obj[key].bind(obj);
    obj[key] = (...args) => {
      const r = orig(...args);
      try { after(...args); } catch (e) { /* observer only */ }
      return r;
    };
  };

  wrap(UI, 'addChat', (d) => {
    const p = UI.chatPlayer(d.id);
    if (!p) return;
    push('chat', { from: d.id, name: dispName(p), text: String(d.text).slice(0, 120), mine: d.id === Net.myId });
  });

  wrap(UI, 'renderLobby', () => {
    const players = UI.lobby.players.map(p => ({
      id: p.id, name: dispName(p), ready: !!p.ready,
      isHost: !!p.isHost, isBot: !!p.isBot, isAgent: !!p.isAgent,
    }));
    const sig = JSON.stringify(players);
    if (sig === lastLobbySig) return; // renderLobby runs on every broadcast
    lastLobbySig = sig;
    push('lobby', { players });
  });

  wrap(Game, 'startMatch', (d) => {
    previews = 0;
    reportedLeft = new Set();
    push('matchStart', {
      tableId: d.tableId,
      order: d.order.map(p => ({ id: p.id, name: p.name || p.emoji, isBot: !!p.isBot, isAgent: !!p.isAgent })),
    });
  });

  wrap(Game, 'beginTurn', () => {
    const m = Game.match;
    if (!m) return;
    previews = 0;
    const cur = Game.currentBall();
    push('turn', {
      turn: m.turnCount, current: cur.id, currentName: dispName(cur),
      yourTurn: cur.id === Net.myId && !cur.dead,
      balls: m.balls.map(ballView),
      powerups: m.powerups.map(u => ({ kind: u.k, x: u.x, y: u.y })),
    });
  });

  wrap(Game, 'playerLeft', (id) => {
    const m = Game.match;
    // departures during a running sim are deferred and re-enter here later —
    // report each player once, when the game actually applies it
    if (!m || m.mode === 'live' || m.mode === 'livewatch') return;
    if (reportedLeft.has(id)) return;
    reportedLeft.add(id);
    push('playerLeft', { id });
  });

  wrap(UI, 'showRanking', (ranked) => {
    push('matchOver', {
      ranking: ranked.map((b, i) => ({ pos: i + 1, id: b.id, name: dispName(b), you: b.id === Net.myId, dead: b.dead })),
      tourney: UI.tourney
        ? { match: UI.tourney.no, of: UI.tourney.len, scores: { ...UI.tourney.scores } }
        : null,
    });
  });

  // ---- act ----

  const turnGuard = () => {
    const m = Game.match;
    if (!m) return 'no match running';
    if (m.mode !== 'idle') return 'a turn is playing out — wait for your turn event';
    const cur = Game.currentBall();
    if (!cur || cur.id !== Net.myId) return `not your turn (${cur ? dispName(cur) : '?'} plays)`;
    return null;
  };

  // accepts {angle} in radians (0 = right, PI/2 = down) or {dx, dy}
  const normalizeShot = (input) => {
    let dx = input.dx, dy = input.dy;
    if (typeof input.angle === 'number') { dx = Math.cos(input.angle); dy = Math.sin(input.angle); }
    const n = Math.sqrt(dx * dx + dy * dy);
    if (!n || !Number.isFinite(n)) return null;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0));
    return {
      dx: dx / n, dy: dy / n,
      power: clamp(input.power != null ? input.power : 0.7, Controls.MIN_POWER, 1),
      spin: { x: clamp(input.spin && input.spin.x, -1, 1), y: clamp(input.spin && input.spin.y, -1, 1) },
    };
  };

  window.KilliardsAI = {
    version: VERSION,
    previewCap: PREVIEW_CAP,

    // Join a room as a declared agent. Resolves once the host channel is open.
    join(code, opts = {}) {
      return new Promise((resolve, reject) => {
        if (!Net.myId) return reject(new Error('relay not ready yet — retry in a second'));
        if (Net.server && Net.server.open) return reject(new Error('already connected to a room'));
        UI.profile.name = String(opts.name || 'AI').trim().slice(0, 12);
        UI.profile.emoji = '🤖';
        if (PLAYER_COLORS.includes(opts.color)) UI.profile.color = opts.color;
        Net.join(String(code || '').toUpperCase(),
          () => {
            Net.toHost({ t: 'profile', d: { ...UI.profile, isAgent: true } });
            resolve({ joined: true, id: Net.myId });
          },
          (err) => reject(new Error(err)));
      });
    },

    // Host a room instead. Returns the code to share with humans.
    createRoom(opts = {}) {
      if (!Net.myId) return { ok: false, error: 'relay not ready yet' };
      if (UI.inMatch) return { ok: false, error: 'already in a match' };
      document.getElementById('name-input').value = String(opts.name || 'AI').trim().slice(0, 12);
      UI.profile.emoji = '🤖';
      UI.profile.isAgent = true; // spread into the host's own lobby card
      UI.hostCreateLobby();
      return { ok: true, code: Net.myId };
    },

    ready() {
      const me = UI.lobby.players.find(p => p.id === Net.myId);
      if (!me) return { ok: false, error: 'not seated in a lobby' };
      if (!me.ready) UI.toggleReady();
      return { ok: true }; // guests: confirmed when the host echoes the lobby
    },

    // Everything an agent can see — same information a human reads off the
    // screen. Coordinates live in a fixed 1600x900 space, origin top-left.
    getState() {
      const scr = document.querySelector('.screen.active');
      const st = {
        api: VERSION,
        screen: scr ? scr.id.replace('screen-', '') : null,
        myId: Net.myId || null,
        previewsLeft: PREVIEW_CAP - previews,
        players: UI.lobby.players.map(p => ({
          id: p.id, name: dispName(p), ready: !!p.ready,
          isHost: !!p.isHost, isBot: !!p.isBot, isAgent: !!p.isAgent,
        })),
        chat: UI.chat.slice(-10).map(c => ({ name: c.name, text: c.text })),
      };
      const m = Game.match;
      if (m) {
        const cur = Game.currentBall();
        const yourTurn = m.mode === 'idle' && cur && cur.id === Net.myId;
        st.match = {
          mode: m.mode, turn: m.turnCount, tableId: m.table.id,
          current: cur ? cur.id : null, yourTurn,
          shotClock: yourTurn ? Math.ceil(Math.max(0, m.turnTimer)) : null,
          balls: m.balls.map(ballView),
          powerups: m.powerups.map(u => ({ kind: u.k, trap: POWER_KINDS[u.k].trap, x: u.x, y: u.y })),
          barriers: m.barriers.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), r: PHYS.BAR_R })),
          obstacles: m.table.obstacles.map(o => o.pts),
          teleporters: (m.table.teles || []).map(t => ({ a: t.a, b: t.b, r: PHYS.TELE_R })),
          borderDmg: m.borderDmg,
          tourney: UI.tourney ? { match: UI.tourney.no, of: UI.tourney.len, scores: { ...UI.tourney.scores } } : null,
        };
      }
      return st;
    },

    // Dry-run a candidate shot through the real physics on cloned state.
    // Capped per turn: pick your best idea and commit, like a human would.
    previewShot(input = {}) {
      const err = turnGuard();
      if (err) return { ok: false, error: err };
      if (previews >= PREVIEW_CAP) return { ok: false, error: `preview cap reached (${PREVIEW_CAP} per turn)` };
      const shot = normalizeShot(input);
      if (!shot) return { ok: false, error: 'bad shot: pass {angle} or {dx, dy}' };
      previews++;
      const m = Game.match;
      const balls = m.balls.map(b => ({ ...b }));
      const barriers = m.barriers.map(b => ({ ...b }));
      const powerups = m.powerups.map(u => ({ ...u }));
      const meIdx = balls.findIndex(b => b.id === Net.myId);
      const effect = balls[meIdx].storedPower || null;
      balls[meIdx].storedPower = null;
      const speed = PHYS.MIN_SHOT + shot.power * (PHYS.MAX_SHOT - PHYS.MIN_SHOT);
      const sim = new Sim(balls, m.table, meIdx,
        { dx: shot.dx, dy: shot.dy, speed, spin: shot.spin },
        { barriers, powerups, effect, borderDmg: m.borderDmg });
      let guard = 0;
      while (!sim.step() && guard++ < 60 * (PHYS.MAX_T + 1)) { /* run */ }
      return {
        ok: true,
        previewsLeft: PREVIEW_CAP - previews,
        finals: balls.map(ballView),
        damage: m.balls.map((b, i) => ({
          id: b.id, name: dispName(b), delta: Math.round((balls[i].hp - b.hp) * 10) / 10,
        })),
        events: sim.events.map(e => ({ type: e.type, mag: e.mag, victims: e.victims })),
      };
    },

    // Fire. Same validation, same code path, same audit as a human drag.
    shoot(input = {}) {
      const err = turnGuard();
      if (err) return { ok: false, error: err };
      const shot = normalizeShot(input);
      if (!shot) return { ok: false, error: 'bad shot: pass {angle} or {dx, dy}' };
      Game.shoot(shot);
      return { ok: true, previewsUsed: previews };
    },

    sendChat(text) {
      text = String(text == null ? '' : text).trim().slice(0, 120);
      if (!text) return { ok: false, error: 'empty message' };
      const now = Date.now();
      if (now - lastChatAt < 800) return { ok: false, error: 'rate limited — one message per 800ms' };
      lastChatAt = now;
      const d = { id: Net.myId, text };
      Net.send({ t: 'chat', d });
      UI.addChat(d);
      return { ok: true };
    },

    // Drain the event queue (poll after each of your actions or on a timer).
    // Types: lobby, matchStart, turn, chat, playerLeft, matchOver, overflow.
    pollEvents() {
      const out = events.splice(0);
      if (dropped) { out.unshift({ type: 'overflow', dropped }); dropped = 0; }
      return out;
    },

    // Self-describing spec, so a generic agent landing here can onboard.
    describe() {
      return {
        game: 'KILLIARDS — turn-based multiplayer billiard combat. Each ball is a player with energy (hp). On your turn, fire your ball; collisions damage whoever is hit (never the shooter), border contacts damage the ball that touches them. Last ball alive wins.',
        coordinates: 'fixed 1600x900 logical table, origin top-left, +x right, +y down',
        rules: {
          maxHp: PHYS.MAX_HP,
          shotClockSeconds: Game.TURN_SECONDS,
          shooterImmuneToBallDamage: true,
          borderDamagePerNewContact: 'match setting, see getState().match.borderDmg',
          powerUps: Object.fromEntries(Object.entries(POWER_KINDS).map(([k, v]) => [k, `${v.emoji} ${v.name}: ${v.desc}${v.trap ? ' (trap)' : ''}`])),
          spin: 'spin.x = side english (kicks toward the side of the dot on first contact), spin.y = follow/draw',
        },
        fairPlay: {
          declared: 'joining through this API tags you as an AI to all players',
          previewCap: `${PREVIEW_CAP} previewShot calls per turn`,
          shotClock: `auto-shot fires after ${Game.TURN_SECONDS}s like for any player`,
          audited: 'every device re-runs your turns through the same deterministic physics and flags divergence',
        },
        api: {
          join: 'join(code, {name?, color?}) -> Promise — join a room as a declared agent',
          createRoom: 'createRoom({name?}) -> {code} — host a room instead',
          ready: 'ready() — mark yourself ready in the lobby',
          getState: 'getState() — screen, lobby, full match state, shot clock, previews left',
          previewShot: 'previewShot({angle|dx,dy, power 0..1, spin:{x,y}}) — dry-run on cloned physics, capped per turn',
          shoot: 'shoot({angle|dx,dy, power, spin}) — fire for real (your turn only)',
          sendChat: 'sendChat(text) — talk to the other players (rate limited)',
          pollEvents: 'pollEvents() — drain queued events: lobby, matchStart, turn, chat, playerLeft, matchOver',
        },
      };
    },
  };
})();
