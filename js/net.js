// Networking: no backend. All traffic relays through public MQTT-over-WSS
// brokers (EMQX / HiveMQ, used redundantly). WebRTC was dropped on purpose:
// it fails on many home networks (mDNS + no NAT hairpinning, and public TURN
// is dead), while a WebSocket relay works everywhere and a turn-based game
// doesn't care about the extra ~100ms.
//
// Star topology: the room code is the host's locally generated 5-letter id.
// Guests publish to kb1/<code>/h/<guestId>, the host answers on
// kb1/<code>/g/<guestId>. Messages are published through every connected
// broker for redundancy and deduped with a per-direction counter.

const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const MAX_PLAYERS = 6;
const HELLO_RETRY = 1500;   // ms between join hello attempts
const JOIN_TIMEOUT = 9000;  // give up joining after this
const PING_EVERY = 5000;    // guest → host keepalive
const CONN_TIMEOUT = 16000; // silence longer than this = connection lost

// A relay-backed connection with a DataConnection-like surface
// (peer / open / on / send / close).
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
  conns: [],          // host: connections to all guests
  server: null,       // guest: connection to the host
  isHost: true,
  myId: '',
  handlers: {},
  matchLocked: false, // host: reject joins while a match is running

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
    this.myId = this.shortId();
    this.log(`device id: ${this.myId}`);
    if (typeof mqtt === 'undefined') {
      this.log('relay lib not loaded');
      if (onError) onError(new Error('relay lib missing'));
      return;
    }
    let ready = false;
    this.relaySubscribe(`kb1/${this.myId}/h/+`); // our inbox in case we host
    this.initRelay(() => {
      if (!ready) {
        ready = true;
        onReady(this.myId);
      }
    });
    setTimeout(() => {
      if (!ready && onError) onError(new Error('relay unreachable'));
    }, 12000);
  },

  initRelay(onUp) {
    if (this.relayInit) return;
    this.relayInit = true;
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
          if (onUp) onUp();
        });
        c.on('message', (topic, buf) => this.onRelayMessage(topic, buf));
        c.on('error', () => { /* broker down — the other one covers us */ });
        this.relayClients.push(c);
      } catch (e) { /* ignore */ }
    });
    // keepalive + liveness (MQTT has no presence)
    setInterval(() => {
      const now = Date.now();
      for (const conn of [...this.relayConns]) {
        if (!conn.open) continue;
        if (now - conn.lastSeen > CONN_TIMEOUT) {
          this.log(`connection to ${conn.peer} timed out`);
          conn._close();
        } else if (conn.initiator && now - conn._lastPing > PING_EVERY) {
          conn._lastPing = now;
          conn._ctrl('ping');
        }
      }
    }, 2500);
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
    this.relayClients.forEach(c => { if (c.connected) c.publish(topic, payload); });
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
          this.log(`incoming connection from ${otherId}`);
          conn = new MqttConn(this, otherId, `kb1/${this.myId}/g/${otherId}`, false);
          this.relayInbound[otherId] = conn;
          conn._seen = msg.__n || 0;
          this.acceptConnection(conn);
          conn._open();
          conn.on('close', () => {
            if (this.relayInbound[otherId] === conn) delete this.relayInbound[otherId];
          });
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
    // Admit on 'open' OR on first data (belt and braces against ordering).
    let admitted = false, rejected = false;
    const admit = () => {
      if (admitted || rejected) return;
      const amGuestElsewhere = this.server && this.server.open;
      const seatsFull = this.seatsFull ? this.seatsFull() : false; // bots take seats too
      if (this.matchLocked || amGuestElsewhere || seatsFull || this.conns.length >= MAX_PLAYERS - 1) {
        rejected = true;
        this.log(`rejected ${conn.peer} (busy/full)`);
        conn.send({ t: 'busy' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      admitted = true;
      this.log(`${conn.peer} admitted`);
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
      const wasMember = this.conns.includes(conn);
      this.conns = this.conns.filter(c => c !== conn);
      if (admitted && wasMember) this.dispatch({ t: '_left' }, conn.peer);
    });
  },

  // ---- guest side ----

  join(code, onOpen, onFail) {
    code = code.toUpperCase();
    let settled = false;
    let conn = null;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      this.log(`join failed: ${msg}`);
      try { if (conn) conn.close(); } catch (e) { /* ignore */ }
      onFail(msg);
    };

    if (!this.relayReady()) {
      fail('No connection to the relay — check your internet');
      return;
    }

    this.log(`connecting to room ${code}…`);
    conn = this.relayOutbound[code];
    if (!conn || conn._closed) {
      conn = new MqttConn(this, code, `kb1/${code}/h/${this.myId}`, true);
      this.relayOutbound[code] = conn;
      conn.on('close', () => {
        if (this.relayOutbound[code] === conn) delete this.relayOutbound[code];
      });
    }
    this.relaySubscribe(`kb1/${code}/g/${this.myId}`);
    this.server = conn;
    this.isHost = false;

    conn.on('open', () => {
      if (settled) return;
      settled = true;
      this.log('joined — channel open');
      onOpen();
    });
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
      if (this.server === conn && settled) this.dispatch({ t: '_hostLost' }, code);
    });

    // hello with retries (either broker may deliver; host acks are deduped)
    const hello = () => {
      if (settled || conn._closed || conn.open) return;
      conn._ctrl('hello');
      setTimeout(hello, HELLO_RETRY);
    };
    hello();
    setTimeout(() => fail('Room not found — check the code and that the host is online'), JOIN_TIMEOUT);
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
