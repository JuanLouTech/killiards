// Boot + network message wiring.

window.addEventListener('DOMContentLoaded', () => {
  UI.initHome();
  Renderer.init(document.getElementById('table-canvas'), document.getElementById('table-wrap'));
  Controls.init((shot) => Game.shoot(shot));

  // unlock audio on first interaction (mobile requirement)
  window.addEventListener('pointerdown', () => SFX.unlock(), { once: true });

  // a room is full when all 6 seats are taken, bots included
  Net.seatsFull = () => UI.lobby.players.length >= 6;

  // ---- peer bootstrap ----
  Net.start(
    (id) => { document.getElementById('my-code').textContent = id; },
    () => UI.toast('Network error — check your connection'),
  );

  // ---- host-side messages ----
  Net.on('profile', (d, from) => {
    if (!Net.isHost) return;
    UI.hostAddPlayer(from, d);
  });
  Net.on('ready', (_d, from) => {
    if (!Net.isHost) return;
    const p = UI.lobby.players.find(x => x.id === from);
    if (p) { p.ready = !p.ready; UI.hostBroadcastLobby(); }
  });
  Net.on('_joined', () => {
    // someone joined our code before we clicked "Create room": open the lobby
    if (Net.isHost && !UI.inMatch && !UI.lobby.players.some(p => p.id === Net.myId)) {
      UI.hostCreateLobby();
    }
  });
  Net.on('_busy', () => UI.toast('That room is full or already playing'));
  Net.on('_left', (_d, from) => {
    if (Net.isHost) UI.hostRemovePlayer(from);
  });

  // ---- guest-side messages ----
  Net.on('lobby', (d) => UI.guestApplyLobby(d));
  Net.on('start', (d) => UI.handleStart(d));
  Net.on('left', (d) => Game.playerLeft(d.id));
  Net.on('lobbyBack', () => UI.backToLobby());
  Net.on('_hostLost', () => {
    if (document.getElementById('screen-home').classList.contains('active')) return;
    UI.fatal('Connection to the host was lost.');
  });

  // ---- shared: a finished turn arrives (host relays guest recordings) ----
  Net.on('turn', (d, from) => {
    if (Net.isHost) Net.broadcast({ t: 'turn', d }, from);
    Game.onTurnResult(d);
  });

  // ---- emotes: everyone can react at any time during a match ----
  Net.on('emote', (d, from) => {
    if (Net.isHost) Net.broadcast({ t: 'emote', d }, from);
    Game.showEmote(d);
  });

  const EMOTES = ['😂', '😮', '🔥', '👏', '😱', '🤏'];
  const emoteBar = document.getElementById('emote-bar');
  let lastEmote = 0;
  EMOTES.forEach(e => {
    const b = document.createElement('button');
    b.className = 'emote-btn';
    b.textContent = e;
    b.addEventListener('click', () => {
      if (!Game.match || Game.match.mode === 'over') return;
      const now = Date.now();
      if (now - lastEmote < 700) return; // rate limit
      lastEmote = now;
      const d = { id: Net.myId, e };
      Net.send({ t: 'emote', d });
      Game.showEmote(d);
    });
    emoteBar.appendChild(b);
  });

  // ---- bots (host adds them in the lobby) ----
  document.getElementById('btn-add-bot').addEventListener('click', () => UI.hostAddBot());

  // ---- best play replay is skippable ----
  document.getElementById('bestplay-skip').addEventListener('click', () => Game.skipBestPlay());

  // Fullscreen on touch devices, requested inside user gestures (the only
  // way browsers allow it). iPhones only honor this as an installed PWA.
  const goFullscreen = () => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    if (document.fullscreenElement) return;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const p = req.call(el, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* not supported — fine */ }
    }
  };

  // ---- home screen buttons ----
  document.getElementById('btn-create').addEventListener('click', () => {
    if (!Net.myId) return UI.toast('Still connecting… try again in a second');
    goFullscreen();
    UI.hostCreateLobby();
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('join-input').value.trim().toUpperCase();
    if (code.length < 4) return UI.toast('Enter a room code first');
    if (!Net.myId) return UI.toast('Still connecting… try again in a second');
    goFullscreen();
    UI.readProfile();
    const btn = document.getElementById('btn-join');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    Net.join(code,
      () => {
        btn.disabled = false; btn.textContent = 'Join room';
        Net.toHost({ t: 'profile', d: UI.profile });
      },
      (err) => {
        btn.disabled = false; btn.textContent = 'Join room';
        UI.toast(err + ' · tap the logo 3× for the connection log');
      });
  });

  // ---- lobby / ranking buttons ----
  // full reload is the cleanest way to tear down the peer + lobby state;
  // the host side sees the connection close and removes us
  document.getElementById('btn-leave').addEventListener('click', () => window.location.reload());
  document.getElementById('lobby-copy').addEventListener('click', () => {
    const code = document.getElementById('lobby-code').textContent;
    navigator.clipboard.writeText(code).then(() => UI.toast('Code copied!'));
  });
  document.getElementById('btn-ready').addEventListener('click', () => { goFullscreen(); UI.toggleReady(); });
  document.getElementById('btn-start').addEventListener('click', () => { goFullscreen(); UI.hostStartMatch(); });

  // ---- help modal ----
  const helpModal = document.getElementById('help-modal');
  document.getElementById('help-toggle').addEventListener('click', () => helpModal.classList.add('show'));
  document.getElementById('help-close').addEventListener('click', () => helpModal.classList.remove('show'));
  helpModal.addEventListener('pointerdown', (e) => {
    if (e.target === helpModal) helpModal.classList.remove('show');
  });
  document.getElementById('btn-again').addEventListener('click', () => {
    Net.broadcast({ t: 'lobbyBack' });
    UI.backToLobby();
  });
  document.getElementById('btn-exit').addEventListener('click', () => window.location.reload());
  document.querySelector('#fatal button').addEventListener('click', () => window.location.reload());

  // ---- left/right-handed controls (landscape only) ----
  const gameScreen = document.getElementById('screen-game');
  if (localStorage.getItem('killiards-hand') === 'L') gameScreen.classList.add('lefty');
  document.getElementById('hand-toggle').addEventListener('click', () => {
    const lefty = gameScreen.classList.toggle('lefty');
    localStorage.setItem('killiards-hand', lefty ? 'L' : 'R');
    Renderer.resize();
    Controls.resize();
  });

  // ---- connection log panel (tap the logo 3× or open with ?debug) ----
  const netlog = document.getElementById('netlog');
  const showLog = () => {
    netlog.classList.add('show');
    const el = document.getElementById('netlog-text');
    el.textContent = Net.logs.join('\n') || '(empty)';
    el.scrollTop = el.scrollHeight;
  };
  let taps = 0, tapT = 0;
  document.querySelector('.logo').addEventListener('pointerdown', () => {
    const now = Date.now();
    taps = now - tapT < 600 ? taps + 1 : 1;
    tapT = now;
    if (taps >= 3) { taps = 0; showLog(); }
  });
  document.getElementById('netlog-close').addEventListener('click', () => netlog.classList.remove('show'));
  document.getElementById('netlog-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(Net.logs.join('\n')).then(() => UI.toast('Log copied!'));
  });
  if (new URLSearchParams(location.search).has('debug')) showLog();
});
