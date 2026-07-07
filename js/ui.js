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
    this.profile.name = name || 'Player ' + Math.floor(10 + Math.random() * 90);
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
      div.className = 'player-card' + (me ? ' me' : '');
      div.innerHTML = `
        <span class="p-ball" style="background:${p.color}">${p.emoji}</span>
        <span class="p-name">${esc(p.name)}${p.isHost ? ' <i>HOST</i>' : ''}${me ? ' <em>(you)</em>' : ''}</span>
        <span class="p-ready ${p.ready ? 'on' : ''}">${p.ready ? 'READY' : 'WAITING'}</span>`;
      wrap.appendChild(div);
    });

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
      ? (allReady ? 'All set — start when you want!' : 'Share the code. Everyone must be ready.')
      : 'Waiting for the host to start…';
  },

  guestApplyLobby(d) {
    this.lobby = d;
    if (!this.inMatch) {
      this.renderLobby();
      this.showScreen('lobby');
    }
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
    const order = shuffle([...players]).map(p => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color }));
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
      el.innerHTML = `<span class="p-ball big" style="background:${p.color}">${p.emoji}</span><span>${esc(p.name)}</span>`;
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
        result.innerHTML = `<b style="color:${starter.color}">${esc(starter.name)}</b> starts!`;
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
        <span class="p-ball" style="background:${b.color}">${b.emoji}</span>
        <span class="p-name">${esc(b.name)}</span>
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
      this.lobby.players.forEach(p => { p.ready = false; });
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
