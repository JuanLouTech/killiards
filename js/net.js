// Networking: no backend, two transports.
//
// 1. PeerJS (WebRTC data channels, public cloud broker + Google STUN). Fast,
//    peer-to-peer, works on most networks. The room creator's peer id (a
//    short 5-letter code) is the room code.
// 2. Relay fallback over public MQTT-over-WSS brokers. If the WebRTC channel
//    doesn't open within a few seconds (mDNS blocked, no NAT hairpinning,
//    UDP-hostile networks...), the join transparently falls back to relaying
//    JSON messages through the broker. Turn-based gameplay doesn't care about
//    the extra latency, and it works on any network. Both transports can be
//    mixed in one lobby — everything routes through the host either way.
//
// If you ever want guaranteed p2p instead, add TURN credentials (e.g. free
// tier at metered.ca) to ICE_CONFIG below.

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const RTC_TIMEOUT = 6000;    // when to give up on WebRTC and try the relay
const JOIN_TIMEOUT = 16000;  // when to give up entirely

// A relay-backed connection mimicking the PeerJS DataConnection surface
// (peer / open / on / send / close), so the rest of the app can't tell the
// difference. Messages are deduped by a per-direction counter because we
// publish through every connected broker for redundancy.
class MqttConn {
  constructor(net, remoteId, pubTopic, initiator) {
    this.net = net;
    this.peer = remoteId;
    this.pubTopic = pubTopic;
    this.initiator = initiator; // initiator side sends the keepalive pings
    this.open = false;
    this.relay = true;
    this._h = {};
    this._n = 0;
    this._seen = 0;
    this._closed = false;
    this.lastSeen = Date.now();
    this._lastPing = 0;
    net.relayConns.push(this);
  }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
  _emit(ev, ...a) { (this._h[ev] || []).forEach(f => f(...a)); }
  _raw(obj) { obj.__n = ++this._n; this.net.relayPublish(this.pubTopic, JSON.stringify(obj)); }
  _ctrl(c) { this._raw({ __c: c }); }
  send(d) { this._raw({ d }); }
  _open() {
    if (this.open || this._closed) return;
    this.open = true;
    this._emit('open');
  }
  _close() {
    if (this._closed) return;
    this._closed = true;
    this.open = false;
    this.net.relayConns = this.net.relayConns.filter(c => c !== this);
    this._emit('close');
  }
  close() {
    if (!this._closed) this._ctrl('bye');
    this._close();
  }
  _recv(msg) {
    if (typeof msg.__n === 'number') {
      if (msg.__n <= this._seen) return; // duplicate via second broker
      this._seen = msg.__n;
    }
    this.lastSeen = Date.now();
    if (msg.__c === 'bye') { this._close(); return; }
    if (msg.__c === 'ping') { this._ctrl('pong'); return; }
    if (msg.__c === 'pong') return;
    if (msg.__c === 'helloAck') { this._open(); return; }
    if (msg.__c) return;
    if ('d' in msg) this._emit('data', msg.d);
  }
}

const Net = {
  peer: null,
  conns: [],          // host: connections to all guests (mixed transports)
  server: null,       // guest: connection to the host
  isHost: true,
  myId: '',
  handlers: {},
  matchLocked: false, // host: reject joins while a match is running
  joinFail: null,     // pending join failure callback (for fast peer-unavailable)
  joinRelayNow: null, // pending fast-fallback trigger

  relayClients: [],
  relayTopics: new Set(),
  relayConns: [],
  relayInbound: {},   // host side: guestId -> MqttConn
  relayOutbound: {},  // guest side: hostId -> MqttConn

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
    if (conn.relay) return;
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
      this.initRelay();
      this.relaySubscribe(`kb1/${pid}/h/+`); // our inbox in case we host
      onReady(pid);
    });
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
        // code not on the p2p broker — maybe the host is reachable via relay
        if (this.joinRelayNow) this.joinRelayNow();
        return;
      }
      if (err.type === 'network' || err.type === 'disconnected') return; // reconnect handles it
      if (onError) onError(err);
    });
    this.peer.on('connection', (conn) => this.acceptConnection(conn));
  },

  // ---- relay transport ----

  initRelay() {
    if (this.relayInit) return;
    this.relayInit = true;
    if (typeof mqtt === 'undefined') { this.log('relay lib not loaded'); return; }
    RELAY_BROKERS.forEach(url => {
      try {
        const c = mqtt.connect(url, {
          connectTimeout: 8000,
          keepalive: 30,
          clean: true,
          reconnectPeriod: 4000,
          clientId: 'kb_' + this.myId + '_' + Math.random().toString(16).slice(2, 8),
        });
        c.on('connect', () => {
          this.log(`relay up: ${url.split('/')[2]}`);
          this.relayTopics.forEach(t => c.subscribe(t));
        });
        c.on('message', (topic, buf) => this.onRelayMessage(topic, buf));
        c.on('error', () => { /* broker down — the other one covers us */ });
        this.relayClients.push(c);
      } catch (e) { /* ignore */ }
    });
    // keepalive + liveness for relay conns (MQTT has no presence)
    setInterval(() => {
      const now = Date.now();
      for (const conn of this.relayConns) {
        if (!conn.open) continue;
        if (now - conn.lastSeen > 30000) {
          this.log(`relay conn ${conn.peer} timed out`);
          conn._close();
        } else if (conn.initiator && now - conn._lastPing > 9000) {
          conn._lastPing = now;
          conn._ctrl('ping');
        }
      }
    }, 5000);
  },

  relayReady() {
    return this.relayClients.some(c => c.connected);
  },

  relaySubscribe(topic) {
    if (this.relayTopics.has(topic)) return;
    this.relayTopics.add(topic);
    this.relayClients.forEach(c => { if (c.connected) c.subscribe(topic); });
  },

  relayPublish(topic, payload) {
    let sent = false;
    this.relayClients.forEach(c => { if (c.connected) { c.publish(topic, payload); sent = true; } });
    return sent;
  },

  onRelayMessage(topic, buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    const parts = topic.split('/'); // kb1 / hostId / h|g / otherId
    if (parts.length !== 4) return;
    const [, hostId, dir, otherId] = parts;

    if (dir === 'h' && hostId === this.myId) {
      // we are the host side; message from guest `otherId`
      let conn = this.relayInbound[otherId];
      if (msg.__c === 'hello') {
        // a hello with a lower counter than we've seen = the guest restarted;
        // drop the stale session and start fresh
        if (conn && (msg.__n || 0) < conn._seen) {
          conn._close();
          delete this.relayInbound[otherId];
          conn = null;
        }
        if (!conn) {
          this.log(`incoming relay connection from ${otherId}`);
          conn = new MqttConn(this, otherId, `kb1/${this.myId}/g/${otherId}`, false);
          this.relayInbound[otherId] = conn;
          conn._seen = msg.__n || 0;
          this.acceptConnection(conn);
          conn._open();
          conn.on('close', () => { delete this.relayInbound[otherId]; });
        } else {
          conn._seen = Math.max(conn._seen, msg.__n || 0);
        }
        conn._ctrl('helloAck'); // idempotent — guest dedupes
        return;
      }
      if (conn) conn._recv(msg);
    } else if (dir === 'g' && otherId === this.myId) {
      // we are the guest side; message from host `hostId`
      const conn = this.relayOutbound[hostId];
      if (conn) conn._recv(msg);
    }
  },

  // ---- host side ----

  acceptConnection(conn) {
    this.log(`incoming connection request from ${conn.peer}${conn.relay ? ' (relay)' : ''}`);
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
      this.log(`${conn.peer} admitted — channel open${conn.relay ? ' (relay)' : ''}`);
      this.isHost = true;
      // if the same guest reached us via WebRTC after being admitted via
      // relay (or vice versa), keep only the first connection
      const dup = this.conns.find(c => c.peer === conn.peer);
      if (dup) { rejected = true; conn.close(); return; }
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
      const wasMember = this.conns.includes(conn);
      this.conns = this.conns.filter(c => c !== conn);
      if (admitted && wasMember) this.dispatch({ t: '_left' }, conn.peer);
    });
  },

  // ---- guest side ----

  join(code, onOpen, onFail) {
    code = code.toUpperCase();
    let settled = false;
    let rtcConn = null;
    let relayConn = null;

    const wire = (conn) => {
      conn.on('data', (msg) => {
        if (this.server !== conn) return;
        if (msg.t === 'busy') {
          this.dispatch({ t: '_busy' }, code);
          conn.close();
          return;
        }
        this.dispatch(msg, code);
      });
      conn.on('close', () => {
        if (this.server === conn) this.dispatch({ t: '_hostLost' }, code);
      });
    };

    const succeed = (conn) => {
      if (settled) return;
      settled = true;
      this.joinFail = null;
      this.joinRelayNow = null;
      this.server = conn;
      this.isHost = false;
      this.log(`joined — channel open${conn.relay ? ' (relay)' : ''}`);
      if (conn !== rtcConn && rtcConn) { try { rtcConn.close(); } catch (e) { /* ignore */ } }
      if (conn !== relayConn && relayConn) { try { relayConn.close(); } catch (e) { /* ignore */ } }
      onOpen();
    };

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      this.joinFail = null;
      this.joinRelayNow = null;
      this.log(`join failed: ${msg}`);
      try { if (rtcConn) rtcConn.close(); } catch (e) { /* ignore */ }
      try { if (relayConn) relayConn.close(); } catch (e) { /* ignore */ }
      onFail(msg);
    };
    this.joinFail = fail;

    const tryRelay = () => {
      if (settled || relayConn) return;
      if (!this.relayReady()) {
        this.log('relay not available (brokers unreachable)');
        return;
      }
      this.log('trying relay transport…');
      relayConn = this.relayOutbound[code];
      if (!relayConn || relayConn._closed) {
        relayConn = new MqttConn(this, code, `kb1/${code}/h/${this.myId}`, true);
        this.relayOutbound[code] = relayConn;
        relayConn.on('close', () => { if (this.relayOutbound[code] === relayConn) delete this.relayOutbound[code]; });
      }
      this.relaySubscribe(`kb1/${code}/g/${this.myId}`);
      wire(relayConn);
      relayConn.on('open', () => succeed(relayConn));
      // hello with retries (either broker may deliver; host acks are deduped)
      const hello = () => {
        if (settled || relayConn._closed || relayConn.open) return;
        relayConn._ctrl('hello');
        setTimeout(hello, 1800);
      };
      hello();
    };
    this.joinRelayNow = tryRelay;

    this.log(`connecting to room ${code}…`);
    rtcConn = this.peer.connect(code, { reliable: true });
    if (rtcConn) {
      this.watchConn(rtcConn, `join→${code}`);
      this.server = rtcConn; // provisional; replaced if the relay wins
      this.isHost = false;
      wire(rtcConn);
      rtcConn.on('open', () => succeed(rtcConn));
      rtcConn.on('error', () => { if (!settled) tryRelay(); });
    }

    setTimeout(() => { if (!settled) { this.log('WebRTC did not connect in time'); tryRelay(); } }, RTC_TIMEOUT);
    setTimeout(() => fail('Could not connect — check the code and that the host is online'), JOIN_TIMEOUT);
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
