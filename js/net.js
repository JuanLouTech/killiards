// Networking: PeerJS star topology, no backend. The room creator's peer id
// (a short 5-letter code) is the room code; guests connect directly to it
// through the public PeerJS cloud broker. STUN for discovery + a free TURN
// relay as fallback for NATs where a direct path can't be established.

// STUN only by default. If you need TURN (players behind hostile NATs), get
// free credentials from e.g. metered.ca or Cloudflare Calls and add them here:
//   { urls: 'turn:...', username: '...', credential: '...' }
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const Net = {
  peer: null,
  conns: [],          // host: connections to all guests
  server: null,       // guest: connection to the host
  isHost: true,
  myId: '',
  handlers: {},
  matchLocked: false, // host: reject joins while a match is running
  joinFail: null,     // pending join failure callback (for fast peer-unavailable)

  logs: [],

  // Connection diagnostics — shown in the in-game log panel (tap the logo
  // 3 times or add ?debug to the URL).
  log(msg) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    console.log('[net]', msg);
    const el = document.getElementById('netlog-text');
    if (el && el.offsetParent !== null) {
      el.textContent = this.logs.join('\n');
      el.scrollTop = el.scrollHeight;
    }
  },

  // Watch a DataConnection's underlying RTCPeerConnection and log ICE progress.
  watchConn(conn, tag) {
    let tries = 0;
    const dumpStats = (pc, label) => {
      pc.getStats().then(stats => {
        const cands = [];
        stats.forEach(s => {
          if (s.type === 'local-candidate') cands.push('L:' + s.candidateType + (s.protocol ? '/' + s.protocol : ''));
          if (s.type === 'remote-candidate') cands.push('R:' + s.candidateType);
        });
        this.log(`${tag}: ${label} → ${cands.join(' ') || 'NO candidates'}`);
      }).catch(() => {});
    };
    const iv = setInterval(() => {
      const pc = conn.peerConnection;
      if (!pc) { if (++tries > 200) clearInterval(iv); return; }
      clearInterval(iv);
      this.log(`${tag}: negotiating (signaling ok), gathering=${pc.iceGatheringState}`);
      pc.addEventListener('icegatheringstatechange', () =>
        this.log(`${tag}: gathering ${pc.iceGatheringState}`));
      pc.addEventListener('icecandidate', (e) => {
        if (e.candidate) {
          const c = e.candidate;
          this.log(`${tag}: local candidate ${c.type || ''} ${c.protocol || ''} ${(c.address || '').includes('.local') ? '(mdns)' : ''}`);
        } else {
          this.log(`${tag}: local gathering finished`);
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        this.log(`${tag}: ICE ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          dumpStats(pc, 'candidates seen');
        }
      });
      setTimeout(() => {
        if (!['connected', 'completed'].includes(pc.iceConnectionState)) {
          dumpStats(pc, `still ${pc.iceConnectionState} after 6s`);
        }
      }, 6000);
    }, 50);
  },

  on(type, fn) { this.handlers[type] = fn; },

  dispatch(msg, fromId) {
    const h = this.handlers[msg.t];
    if (h) h(msg.d, fromId);
  },

  shortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = 'K';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  },

  start(onReady, onError) {
    const id = this.shortId();
    this.peer = new Peer(id, { config: ICE_CONFIG, debug: 1 });
    this.peer.on('open', (pid) => {
      this.myId = pid;
      this.log(`peer registered on broker as ${pid}`);
      onReady(pid);
    });
    // if the socket to the broker drops (sleep, background tab, network blip),
    // reconnect so this room code stays joinable
    this.peer.on('disconnected', () => {
      this.log('lost broker socket — reconnecting');
      if (this.peer && !this.peer.destroyed) {
        setTimeout(() => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } }, 800);
      }
    });
    this.peer.on('error', (err) => {
      this.log(`peer error: ${err.type || err.message || err}`);
      if (err.type === 'unavailable-id') { this.start(onReady, onError); return; }
      if (err.type === 'peer-unavailable') {
        // the code we tried to join doesn't exist on the broker
        if (this.joinFail) { const f = this.joinFail; this.joinFail = null; f('Room not found — check the code'); }
        return;
      }
      if (err.type === 'network' || err.type === 'disconnected') return; // reconnect handles it
      if (onError) onError(err);
    });
    this.peer.on('connection', (conn) => this.acceptConnection(conn));
  },

  acceptConnection(conn) {
    this.log(`incoming connection request from ${conn.peer}`);
    this.watchConn(conn, `host←${conn.peer}`);
    // Admit on 'open' OR on first data (data arriving proves the channel is
    // open even if the open callback hasn't run yet — avoids a race where the
    // guest's profile is processed before the conn joins the broadcast list).
    let admitted = false, rejected = false;
    const admit = () => {
      if (admitted || rejected) return;
      const amGuestElsewhere = this.server && this.server.open;
      if (this.matchLocked || amGuestElsewhere || this.conns.length >= 7) {
        rejected = true;
        this.log(`rejected ${conn.peer} (busy)`);
        conn.send({ t: 'busy' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      admitted = true;
      this.log(`${conn.peer} admitted — channel open`);
      this.isHost = true;
      this.conns.push(conn);
      this.dispatch({ t: '_joined' }, conn.peer);
    };
    conn.on('open', admit);
    conn.on('data', (msg) => {
      admit();
      if (!rejected) this.dispatch(msg, conn.peer);
    });
    conn.on('close', () => {
      this.log(`${conn.peer} connection closed`);
      this.conns = this.conns.filter(c => c !== conn);
      if (admitted) this.dispatch({ t: '_left' }, conn.peer);
    });
  },

  join(code, onOpen, onFail) {
    let settled = false;
    let conn = null;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      this.joinFail = null;
      this.log(`join failed: ${msg}`);
      try { if (conn) conn.close(); } catch (e) { /* ignore */ }
      onFail(msg);
    };
    this.joinFail = fail;
    this.log(`connecting to room ${code.toUpperCase()}…`);
    conn = this.peer.connect(code.toUpperCase(), { reliable: true });
    if (!conn) { fail('Not connected yet — try again in a second'); return; }
    this.watchConn(conn, `join→${code.toUpperCase()}`);
    this.server = conn;
    this.isHost = false;
    conn.on('open', () => {
      if (settled) return;
      settled = true;
      this.joinFail = null;
      this.log('joined — channel open');
      onOpen();
    });
    conn.on('data', (msg) => {
      if (msg.t === 'busy') {
        this.dispatch({ t: '_busy' }, code);
        conn.close();
        return;
      }
      this.dispatch(msg, code);
    });
    conn.on('close', () => this.dispatch({ t: '_hostLost' }, code));
    conn.on('error', () => fail('Could not connect to that room'));
    setTimeout(() => fail('Could not connect — check the code and that the host is online'), 12000);
  },

  // host → everyone (optionally excluding one guest, e.g. the original sender)
  broadcast(msg, exceptId) {
    for (const c of this.conns) {
      if (c.peer !== exceptId && c.open) c.send(msg);
    }
  },

  // guest → host
  toHost(msg) {
    if (this.server && this.server.open) this.server.send(msg);
  },

  // Send a game message: hosts broadcast, guests send to the host who relays.
  send(msg) {
    if (this.isHost) this.broadcast(msg);
    else this.toHost(msg);
  },
};
