// Synthesized sound effects via WebAudio — no assets needed.

const SFX = (() => {
  let ctx = null;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ type = 'sine', freq = 440, to = null, dur = 0.15, vol = 0.2, delay = 0 }) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.3, vol = 0.25, freq = 800, delay = 0 }) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
  }

  return {
    unlock() { ac(); },
    shoot(power) {
      noise({ dur: 0.18, vol: 0.12 + power * 0.15, freq: 2500 });
      tone({ type: 'triangle', freq: 220 + power * 300, to: 60, dur: 0.2, vol: 0.15 });
    },
    wall(mag) {
      const m = Math.min(1, mag / 900);
      tone({ type: 'square', freq: 160 + m * 220, to: 70, dur: 0.09, vol: 0.08 + m * 0.12 });
      noise({ dur: 0.06, vol: 0.05 + m * 0.08, freq: 4000 });
    },
    ball(mag) {
      const m = Math.min(1, mag / 800);
      tone({ type: 'sine', freq: 140, to: 60, dur: 0.12, vol: 0.15 + m * 0.2 });
      noise({ dur: 0.04, vol: 0.08 + m * 0.1, freq: 6000 });
    },
    explode() {
      noise({ dur: 0.7, vol: 0.4, freq: 900 });
      tone({ type: 'sawtooth', freq: 120, to: 25, dur: 0.6, vol: 0.25 });
    },
    tick() {
      tone({ type: 'square', freq: 900, dur: 0.04, vol: 0.06 });
    },
    turnStart() {
      tone({ type: 'sine', freq: 520, dur: 0.09, vol: 0.1 });
      tone({ type: 'sine', freq: 780, dur: 0.12, vol: 0.1, delay: 0.09 });
    },
    fanfare() {
      [440, 554, 659, 880].forEach((f, i) =>
        tone({ type: 'triangle', freq: f, dur: 0.25, vol: 0.14, delay: i * 0.12 }));
    },
  };
})();
