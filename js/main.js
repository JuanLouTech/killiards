// Boot + network message wiring.

window.addEventListener('DOMContentLoaded', () => {
  UI.initHome();
  Renderer.init(document.getElementById('table-canvas'), document.getElementById('table-wrap'));
  Controls.init((shot) => Game.shoot(shot));

  // unlock audio on first interaction (mobile requirement)
  window.addEventListener('pointerdown', () => SFX.unlock(), { once: true });

  // a room is full when all 6 seats are taken, bots included
  Net.seatsFull = () => UI.lobby.players.length >= 6;

  // opened through an invite link (?room=CODE): show the invite variant of
  // the home screen right away, connect to the room once the relay is up
  const inviteRoom = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  if (inviteRoom) UI.showInviteHome(inviteRoom);

  // ---- peer bootstrap ----
  Net.start(
    (id) => {
      document.getElementById('my-code').textContent = id;
      if (UI.peeking) UI.startInvitePeek();
    },
    () => {
      UI.toast('Network error — check your connection');
      if (UI.peeking) UI.setInviteStatus('⚠️ No connection to the relay — check your internet', true);
    },
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
  // an invited player asks for the roster before taking a seat
  Net.on('peek', (_d, from) => {
    if (Net.isHost) Net.toGuest(from, { t: 'lobby', d: UI.lobby });
  });
  Net.on('_busy', () => {
    if (UI.peeking) { UI.setInviteStatus('⚠️ That room is full or already playing.', true); return; }
    UI.toast('That room is full or already playing');
  });
  Net.on('_left', (_d, from) => {
    if (Net.isHost) UI.hostRemovePlayer(from);
  });

  // ---- guest-side messages (peekers get roster updates but stay put) ----
  Net.on('lobby', (d) => UI.peeking ? UI.applyPeekLobby(d) : UI.guestApplyLobby(d));
  Net.on('start', (d) => {
    if (UI.peeking) {
      UI.setInviteStatus('A match just started — you can join when it ends.');
      document.getElementById('btn-join-invite').disabled = true;
      return;
    }
    UI.handleStart(d);
  });
  Net.on('left', (d) => Game.playerLeft(d.id));
  Net.on('lobbyBack', () => { if (!UI.peeking) UI.backToLobby(); });
  Net.on('_hostLost', () => {
    if (UI.peeking) {
      // a busy/full rejection also closes the channel: keep the specific message
      if (!UI.peekFailed) UI.setInviteStatus('⚠️ The host went offline.', true);
      return;
    }
    if (document.getElementById('screen-home').classList.contains('active')) return;
    UI.fatal('Connection to the host was lost.');
  });

  // ---- shared: a finished turn arrives (host relays guest recordings) ----
  Net.on('turn', (d, from) => {
    if (Net.isHost) Net.broadcast({ t: 'turn', d }, from);
    Game.onTurnResult(d);
  });

  // ---- a shot was fired somewhere: its device is now simulating ----
  Net.on('shot', (d, from) => {
    if (Net.isHost) Net.broadcast({ t: 'shot', d }, from);
    Game.onShotFired(d);
  });

  // ---- chat: anyone can talk at any time; the host relays ----
  Net.on('chat', (d, from) => {
    if (Net.isHost) Net.broadcast({ t: 'chat', d }, from);
    UI.addChat(d);
  });

  const chatModal = document.getElementById('chat-modal');
  const chatInput = document.getElementById('chat-input');
  let lastChat = 0;
  const sendChat = () => {
    const text = chatInput.value.trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (now - lastChat < 800) return; // rate limit
    lastChat = now;
    chatInput.value = '';
    const d = { id: Net.myId, text };
    Net.send({ t: 'chat', d });
    UI.addChat(d);
    UI.closeChat(); // back to the game right away
  };
  document.getElementById('chat-toggle').addEventListener('click', () => UI.openChat());
  document.getElementById('chat-close').addEventListener('click', () => UI.closeChat());
  document.getElementById('chat-send').addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  document.getElementById('chat-toast').addEventListener('click', () => UI.openChat());
  chatModal.addEventListener('pointerdown', (e) => {
    if (e.target === chatModal) UI.closeChat();
  });

  // ---- bots (host adds them in the lobby) ----
  document.getElementById('btn-add-bot').addEventListener('click', () => UI.hostAddBot());

  // ---- border damage (host lobby setting) ----
  document.querySelectorAll('#dmg-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!Net.isHost || UI.inMatch) return;
      UI.lobby.borderDmg = btn.dataset.lvl;
      UI.hostBroadcastLobby();
    });
  });

  // ---- tournament length (host lobby setting) ----
  document.querySelectorAll('#tourney-select button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!Net.isHost || UI.inMatch) return;
      UI.lobby.tourney = +btn.dataset.len;
      if (UI.lobby.tourney) UI.lobby.tableId = 'random'; // rerolled every match
      UI.hostBroadcastLobby();
    });
  });

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

  // ---- invite landing buttons ----
  document.getElementById('btn-join-invite').addEventListener('click', () => {
    goFullscreen();
    UI.inviteJoin();
  });
  document.getElementById('invite-retry').addEventListener('click', () => UI.startInvitePeek());
  document.getElementById('invite-escape').addEventListener('click', () => UI.inviteEscape());

  // ---- lobby / ranking buttons ----
  // full reload is the cleanest way to tear down the peer + lobby state;
  // the host side sees the connection close and removes us
  document.getElementById('btn-leave').addEventListener('click', () => window.location.reload());
  document.getElementById('lobby-copy').addEventListener('click', () => {
    const code = document.getElementById('lobby-code').textContent;
    navigator.clipboard.writeText(code).then(() => UI.toast('Code copied!'));
  });
  // invite link: native share sheet on touch devices (WhatsApp/Telegram/…),
  // clipboard + toast everywhere else
  document.getElementById('lobby-share').addEventListener('click', () => {
    const code = document.getElementById('lobby-code').textContent;
    const url = location.origin + location.pathname + '?room=' + code;
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: 'KILLIARDS', text: `Join my KILLIARDS room ${code}!`, url })
        .catch(() => { /* user dismissed the sheet */ });
    } else {
      navigator.clipboard.writeText(url).then(() => UI.toast('Invite link copied — send it to your friends!'));
    }
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
    // mid-tournament the same button chains straight into the next match
    if (UI.tourney && UI.tourney.no < UI.tourney.len) return UI.hostNextMatch();
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
