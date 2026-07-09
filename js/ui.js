// Screen flow + lobby state. The host owns the lobby and broadcasts it.

const UI = {
  profile: { name: '', emoji: EMOJI_LIST[0], color: PLAYER_COLORS[0] },
  loadProfile() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('killiards-profile') || 'null'); } catch (e) { /* ignore */ }
    // random looks by default so two quick joiners never look identical
    this.profile = {
      name: (saved && saved.name) || '',
      emoji: saved && EMOJI_LIST.includes(saved.emoji)
        ? saved.emoji
        : EMOJI_LIST[Math.floor(Math.random() * EMOJI_LIST.length)],
      color: saved && PLAYER_COLORS.includes(saved.color)
        ? saved.color
        : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
    };
  },
  lobby: { players: [], tableId: TABLES[0].id },
  inMatch: false,

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s =>
      s.classList.toggle('active', s.id === 'screen-' + name));
    if (name === 'game') {
      Renderer.resize();
      Controls.resize();
      Game.startLoop();
    } else {
      Game.stopLoop();
    }
  },

  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), 2600);
  },

  fatal(msg) {
    const el = document.getElementById('fatal');
    el.querySelector('p').textContent = msg;
    el.classList.add('show');
  },

  // ---- home ----

  initHome() {
    this.loadProfile();
    document.getElementById('name-input').value = this.profile.name;

    const grid = document.getElementById('emoji-grid');
    EMOJI_LIST.forEach(e => {
      const b = document.createElement('button');
      b.textContent = e;
      b.className = 'emoji-btn' + (e === this.profile.emoji ? ' sel' : '');
      b.addEventListener('click', () => {
        this.profile.emoji = e;
        grid.querySelectorAll('.emoji-btn').forEach(x => x.classList.toggle('sel', x === b));
      });
      grid.appendChild(b);
    });

    const row = document.getElementById('color-row');
    PLAYER_COLORS.forEach(c => {
      const b = document.createElement('button');
      b.className = 'color-btn' + (c === this.profile.color ? ' sel' : '');
      b.style.background = c;
      b.addEventListener('click', () => {
        this.profile.color = c;
        row.querySelectorAll('.color-btn').forEach(x => x.classList.toggle('sel', x === b));
      });
      row.appendChild(b);
    });

    document.getElementById('copy-code').addEventListener('click', () => {
      navigator.clipboard.writeText(Net.myId).then(() => this.toast('Code copied!'));
    });
  },

  readProfile() {
    const name = document.getElementById('name-input').value.trim().slice(0, 12);
    try {
      localStorage.setItem('killiards-profile', JSON.stringify({
        name, emoji: this.profile.emoji, color: this.profile.color,
      }));
    } catch (e) { /* ignore */ }
    // no forced default: nameless players are shown by their emoji
    this.profile.name = name;
  },

  // ---- lobby ----

  hostCreateLobby() {
    this.readProfile();
    Net.isHost = true;
    this.lobby = {
      players: [{ id: Net.myId, ...this.profile, ready: false, isHost: true }],
      tableId: TABLES[0].id,
    };
    this.renderLobby();
    this.showScreen('lobby');
  },

  hostBroadcastLobby() {
    Net.broadcast({ t: 'lobby', d: this.lobby });
    this.renderLobby();
  },

  hostAddPlayer(id, prof) {
    if (this.lobby.players.some(p => p.id === id)) return;
    // peekers (invite links) are connected before they take a seat, so the
    // admission-time capacity check doesn't cover them — re-check here
    if (this.inMatch) return;
    if (this.lobby.players.length >= 6) { Net.toGuest(id, { t: 'busy' }); return; }
    this.lobby.players.push({ id, name: prof.name, emoji: prof.emoji, color: prof.color, ready: false, isHost: false });
    this.hostBroadcastLobby();
  },

  hostRemovePlayer(id) {
    this.lobby.players = this.lobby.players.filter(p => p.id !== id);
    if (this.inMatch) {
      Net.broadcast({ t: 'left', d: { id } });
      Game.playerLeft(id);
    } else {
      this.hostBroadcastLobby();
    }
  },

  // ---- bots (host only) ----

  MAX_BOTS: 3,

  hostAddBot() {
    if (!Net.isHost || this.inMatch) return;
    const bots = this.lobby.players.filter(p => p.isBot);
    if (bots.length >= this.MAX_BOTS || this.lobby.players.length >= 6) return;
    const used = new Set(this.lobby.players.map(p => p.emoji));
    const usedColors = new Set(this.lobby.players.map(p => p.color));
    const emoji = shuffle(EMOJI_LIST.filter(e => !used.has(e)))[0] || '🤖';
    const color = shuffle(PLAYER_COLORS.filter(c => !usedColors.has(c)))[0] ||
      PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
    let n = 1;
    while (this.lobby.players.some(p => p.id === 'B' + n)) n++;
    this.lobby.players.push({
      id: 'B' + n, name: '', emoji, color,
      ready: true, isHost: false, isBot: true,
    });
    this.hostBroadcastLobby();
  },

  hostRemoveBot(id) {
    if (!Net.isHost || this.inMatch) return;
    this.lobby.players = this.lobby.players.filter(p => p.id !== id);
    this.hostBroadcastLobby();
  },

  toggleReady() {
    if (Net.isHost) {
      const me = this.lobby.players.find(p => p.id === Net.myId);
      me.ready = !me.ready;
      this.hostBroadcastLobby();
    } else {
      Net.toHost({ t: 'ready' });
    }
  },

  renderLobby() {
    document.getElementById('lobby-code').textContent =
      Net.isHost ? Net.myId : (this.lobby.players.find(p => p.isHost) || {}).id || '?';

    const wrap = document.getElementById('lobby-players');
    wrap.innerHTML = '';
    this.lobby.players.forEach(p => {
      const me = p.id === Net.myId;
      const div = document.createElement('div');
      div.className = 'player-card' + (me ? ' me' : '') + (p.isBot ? ' bot' : '');
      div.innerHTML = `
        <span class="p-ball${p.isBot ? ' bot' : ''}" style="background:${p.color}">${p.emoji}</span>
        <span class="p-name">${esc(dispName(p))}${p.isHost ? ' <i>HOST</i>' : ''}${p.isBot ? ' <i class="bot-tag">BOT</i>' : ''}${me ? ' <em>(you)</em>' : ''}</span>
        <span class="p-ready ${p.ready ? 'on' : ''}">${p.ready ? 'READY' : 'WAITING'}</span>`;
      if (p.isBot && Net.isHost) {
        const rm = document.createElement('button');
        rm.className = 'mini bot-remove';
        rm.textContent = '✕';
        rm.title = 'Remove bot';
        rm.addEventListener('click', () => this.hostRemoveBot(p.id));
        div.appendChild(rm);
      }
      wrap.appendChild(div);
    });

    // add-bot button (host only, max 3 bots / 6 seats)
    const botBtn = document.getElementById('btn-add-bot');
    const botCount = this.lobby.players.filter(p => p.isBot).length;
    botBtn.style.display = Net.isHost ? '' : 'none';
    botBtn.disabled = botCount >= this.MAX_BOTS || this.lobby.players.length >= 6;

    // table selector
    const tsel = document.getElementById('table-select');
    if (!tsel.dataset.built) {
      tsel.dataset.built = '1';
      const addOpt = (id, name, thumbEl) => {
        const d = document.createElement('div');
        d.className = 'table-opt';
        d.dataset.id = id;
        const lab = document.createElement('span');
        lab.textContent = name;
        d.append(thumbEl, lab);
        d.addEventListener('click', () => {
          if (!Net.isHost) return;
          this.lobby.tableId = id;
          this.hostBroadcastLobby();
        });
        tsel.appendChild(d);
      };
      TABLES.forEach(t => {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        Renderer.drawThumb(c, t);
        addOpt(t.id, t.name, c);
      });
      const rand = document.createElement('div');
      rand.className = 'rand-thumb';
      rand.textContent = '🎲';
      addOpt('random', 'Random', rand);
    }
    tsel.querySelectorAll('.table-opt').forEach(d =>
      d.classList.toggle('sel', d.dataset.id === this.lobby.tableId));
    tsel.classList.toggle('locked', !Net.isHost);

    // buttons
    const me = this.lobby.players.find(p => p.id === Net.myId);
    const readyBtn = document.getElementById('btn-ready');
    readyBtn.textContent = me && me.ready ? 'Cancel ready' : 'Ready!';
    readyBtn.classList.toggle('on', !!(me && me.ready));

    const startBtn = document.getElementById('btn-start');
    const allReady = this.lobby.players.length > 0 && this.lobby.players.every(p => p.ready);
    startBtn.style.display = Net.isHost ? '' : 'none';
    startBtn.disabled = !allReady;
    startBtn.textContent = this.lobby.players.length === 1 ? 'Start (solo test)' : 'Start match';
    document.getElementById('lobby-hint').textContent = Net.isHost
      ? (allReady ? 'All set — start when you want!' : 'Share the invite link 🔗. Everyone must be ready.')
      : 'Waiting for the host to start…';
  },

  guestApplyLobby(d) {
    this.lobby = d;
    if (!this.inMatch) {
      this.renderLobby();
      this.showScreen('lobby');
    }
  },

  // ---- invite links (?room=CODE): preview the lobby before joining ----

  peeking: null,    // room code while previewing an invite
  peekFailed: false,

  // swap the home screen into its invite variant (runs before the relay is up)
  showInviteHome(code) {
    this.peeking = code;
    document.getElementById('screen-home').classList.add('invited');
    document.getElementById('invite-code').textContent = code;
    this.setInviteStatus('Connecting to the room…');
  },

  // relay is up: connect to the host and ask for the current roster
  startInvitePeek() {
    const code = this.peeking;
    if (!code) return;
    this.setInviteStatus('Connecting to the room…');
    Net.join(code,
      () => Net.toHost({ t: 'peek' }),
      (err) => this.setInviteStatus('⚠️ ' + err, true));
  },

  setInviteStatus(msg, failed) {
    this.peekFailed = !!failed;
    document.getElementById('invite-status').textContent = msg;
    document.getElementById('invite-retry').style.display = failed ? 'inline-block' : 'none';
    if (failed) document.getElementById('btn-join-invite').disabled = true;
  },

  // lobby snapshots arrive while peeking (the host broadcasts every change
  // to all connections, seated or not): render the roster preview
  applyPeekLobby(d) {
    this.lobby = d;
    const wrap = document.getElementById('invite-players');
    wrap.innerHTML = '';
    d.players.forEach(p => {
      const div = document.createElement('div');
      div.className = 'invite-player';
      div.innerHTML = `<span class="p-ball${p.isBot ? ' bot' : ''}" style="background:${p.color}">${p.emoji}</span>
        <span>${esc(dispName(p))}${p.isHost ? ' <i>HOST</i>' : ''}</span>`;
      wrap.appendChild(div);
    });
    const seats = d.players.length;
    const full = seats >= 6;
    this.setInviteStatus(full
      ? 'The room is full right now — waiting for a free seat…'
      : `${seats} player${seats === 1 ? '' : 's'} in the room — pick your look and jump in!`);
    document.getElementById('btn-join-invite').disabled = full;
  },

  inviteJoin() {
    if (!this.peeking || !Net.server || !Net.server.open) return;
    this.readProfile();
    this.peeking = null;
    document.getElementById('screen-home').classList.remove('invited');
    Net.toHost({ t: 'profile', d: this.profile });
  },

  // "create your own room instead": back to the normal home screen
  inviteEscape() {
    this.peeking = null;
    document.getElementById('screen-home').classList.remove('invited');
    if (Net.server) Net.server.close();
  },

  // ---- match start / roulette ----

  hostStartMatch() {
    const players = this.lobby.players;
    if (!players.length || !players.every(p => p.ready)) return;
    let tableId = this.lobby.tableId;
    if (tableId === 'random') {
      tableId = TABLES[Math.floor(Math.random() * TABLES.length)].id;
    }
    const table = getTable(tableId);
    const order = shuffle([...players]).map(p => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color, isBot: !!p.isBot }));
    const spawns = shuffle([...table.spawns]).slice(0, order.length);
    const d = { tableId, order, spawns };
    Net.matchLocked = true;
    Net.broadcast({ t: 'start', d });
    this.handleStart(d);
  },

  handleStart(d) {
    this.inMatch = true;
    this.showScreen('roulette');
    const grid = document.getElementById('roulette-grid');
    const result = document.getElementById('roulette-result');
    result.textContent = '';
    grid.innerHTML = '';
    d.order.forEach(p => {
      const el = document.createElement('div');
      el.className = 'roulette-card';
      el.innerHTML = `<span class="p-ball big${p.isBot ? ' bot' : ''}" style="background:${p.color}">${p.emoji}</span><span>${esc(dispName(p))}</span>`;
      grid.appendChild(el);
    });
    const cards = [...grid.children];
    const n = cards.length;

    // spin the highlight and land on order[0] (the RNG-chosen starter)
    let ticks = n <= 1 ? 6 : n * 3 + n; // ends on index 0 (multiple of n)
    let i = -1, delay = 80;
    const stepFn = () => {
      i++;
      cards.forEach((c, ci) => c.classList.toggle('hl', ci === i % n));
      SFX.tick();
      if (i < ticks) {
        delay = Math.min(430, delay * 1.16);
        setTimeout(stepFn, delay);
      } else {
        const starter = d.order[0];
        cards[0].classList.add('win');
        result.innerHTML = `<b style="color:${starter.color}">${esc(dispName(starter))}</b> starts!`;
        SFX.fanfare();
        setTimeout(() => {
          Game.startMatch(d);
          this.showScreen('game');
          Game.beginTurn();
        }, 1700);
      }
    };
    setTimeout(stepFn, 700);
  },

  // ---- best play banner (over the game canvas, before the ranking) ----

  showBestPlayBar(bp, shooter) {
    const bar = document.getElementById('bestplay-bar');
    document.getElementById('bestplay-title').innerHTML =
      `🎬 Best play: <b style="color:${shooter.color}">${esc(dispName(shooter))}</b> · ${bp.score} dmg`;
    bar.classList.add('show');
  },

  hideBestPlayBar() {
    document.getElementById('bestplay-bar').classList.remove('show');
  },

  // ---- ranking ----

  showRanking(ranked) {
    this.showScreen('ranking');
    const list = document.getElementById('ranking-list');
    list.innerHTML = '';
    const medals = ['🏆', '🥈', '🥉'];
    ranked.forEach((b, i) => {
      const div = document.createElement('div');
      div.className = 'rank-row' + (i === 0 ? ' winner' : '');
      div.innerHTML = `
        <span class="rank-pos">${medals[i] || (i + 1) + 'º'}</span>
        <span class="p-ball${b.isBot ? ' bot' : ''}" style="background:${b.color}">${b.emoji}</span>
        <span class="p-name">${esc(dispName(b))}${b.isBot ? ' <i class="bot-tag">BOT</i>' : ''}</span>
        <span class="rank-note">${b.dead ? 'Survived ' + b.deathTurn + ' turn' + (b.deathTurn === 1 ? '' : 's') : (i === 0 ? 'WINNER' : 'Survived')}</span>`;
      list.appendChild(div);
    });
    document.getElementById('btn-again').style.display = Net.isHost ? '' : 'none';
    document.getElementById('ranking-hint').textContent =
      Net.isHost ? '' : 'The host can bring everyone back to the lobby.';
  },

  backToLobby() {
    this.inMatch = false;
    Game.match = null;
    Net.matchLocked = false;
    if (Net.isHost) {
      this.lobby.players.forEach(p => { p.ready = !!p.isBot; }); // bots are always ready
      this.hostBroadcastLobby();
    } else {
      this.renderLobby();
    }
    this.showScreen('lobby');
  },
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
