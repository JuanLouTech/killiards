// Shot controls: slingshot drag pad + spin (hit point) widget.
// Only active during the local player's turn.

const Controls = {
  padCanvas: null,
  padCtx: null,
  spinCanvas: null,
  spinCtx: null,
  hintEl: null,
  bannerEl: null,

  active: false,
  color: '#3b82f6',
  aiming: false,
  pull: { x: 0, y: 0 },   // pointer offset from pad center, clamped
  spin: { x: 0, y: 0 },   // hit point offset, each axis in [-1, 1]
  onShoot: null,
  everDragged: false,

  init(onShoot) {
    this.onShoot = onShoot;
    this.padCanvas = document.getElementById('pad-canvas');
    this.padCtx = this.padCanvas.getContext('2d');
    this.spinCanvas = document.getElementById('spin-canvas');
    this.spinCtx = this.spinCanvas.getContext('2d');
    this.hintEl = document.getElementById('pad-hint');
    this.bannerEl = document.getElementById('turn-banner');

    this.bigCanvas = document.getElementById('spin-big');
    this.bigCtx = this.bigCanvas.getContext('2d');

    window.addEventListener('resize', () => this.resize());
    this.bindPad();
    this.bindSpin();
    this.resize();
  },

  resize() {
    const fit = (canvas) => {
      const r = canvas.parentElement.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
    };
    fit(this.padCanvas);
    const sr = this.spinCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.spinCanvas.width = Math.round((sr.width || 76) * dpr);
    this.spinCanvas.height = Math.round((sr.height || 76) * dpr);
    this.drawPad();
    this.drawSpin();
  },

  padMaxR() {
    return Math.min(this.padCanvas.width, this.padCanvas.height) / 2 - 14 * (window.devicePixelRatio || 1);
  },

  bindPad() {
    const el = this.padCanvas;
    const toLocal = (e) => {
      const r = el.getBoundingClientRect();
      const dpr = el.width / r.width;
      return {
        x: (e.clientX - r.left - r.width / 2) * dpr,
        y: (e.clientY - r.top - r.height / 2) * dpr,
      };
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      el.setPointerCapture(e.pointerId);
      this.aiming = true;
      this.everDragged = true;
      this.hintEl.classList.add('hidden');
      this.updatePull(toLocal(e));
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.aiming) return;
      this.updatePull(toLocal(e));
    });
    const release = (e) => {
      if (!this.aiming) return;
      this.aiming = false;
      const power = this.power();
      const mag = Math.hypot(this.pull.x, this.pull.y);
      if (power > 0.08 && mag > 1 && this.onShoot) {
        // slingshot: shoot opposite to the pull direction
        const dx = -this.pull.x / mag;
        const dy = -this.pull.y / mag;
        this.onShoot({ dx, dy, power, spin: { ...this.spin } });
      }
      this.pull = { x: 0, y: 0 };
      this.drawPad();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  },

  updatePull(p) {
    const maxR = this.padMaxR();
    const m = Math.hypot(p.x, p.y);
    const f = m > maxR ? maxR / m : 1;
    this.pull = { x: p.x * f, y: p.y * f };
    this.drawPad();
  },

  power() {
    return Math.min(1, Math.hypot(this.pull.x, this.pull.y) / this.padMaxR());
  },

  // Current aim in table-space direction (y axis matches screen). Null if idle.
  getAim() {
    if (!this.aiming) return null;
    const mag = Math.hypot(this.pull.x, this.pull.y);
    if (mag < 1) return null;
    return { dx: -this.pull.x / mag, dy: -this.pull.y / mag, power: this.power() };
  },

  // Small widget is a live indicator + button; precise editing happens in a
  // large modal (much easier on touch screens).
  bindSpin() {
    this.spinCanvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.openSpinModal();
    });

    const modal = document.getElementById('spin-modal');
    const el = this.bigCanvas;
    let dragging = false;
    const setFrom = (e) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const maxR = r.width / 2 - 16;
      let sx = (e.clientX - cx) / maxR;
      let sy = (e.clientY - cy) / maxR;
      const m = Math.hypot(sx, sy);
      if (m > 1) { sx /= m; sy /= m; }
      this.spin = { x: sx, y: sy };
      this.drawSpinBig();
    };
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      setFrom(e);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) setFrom(e); });
    const end = () => { dragging = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    document.getElementById('spin-big-done').addEventListener('click', () => this.closeSpinModal());
    document.getElementById('spin-big-reset').addEventListener('click', () => {
      this.spin = { x: 0, y: 0 };
      this.drawSpinBig();
    });
    modal.addEventListener('pointerdown', (e) => {
      if (e.target === modal) this.closeSpinModal();
    });
  },

  openSpinModal() {
    document.getElementById('spin-modal').classList.add('show');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = Math.min(280, window.innerWidth - 100, window.innerHeight - 260);
    this.bigCanvas.style.width = css + 'px';
    this.bigCanvas.style.height = css + 'px';
    this.bigCanvas.width = Math.round(css * dpr);
    this.bigCanvas.height = Math.round(css * dpr);
    this.drawSpinBig();
  },

  closeSpinModal() {
    document.getElementById('spin-modal').classList.remove('show');
    this.drawSpin();
  },

  drawSpinBig() {
    const ctx = this.bigCtx;
    const W = this.bigCanvas.width, H = this.bigCanvas.height;
    if (!W) return;
    const cx = W / 2, cy = H / 2;
    const R = W / 2 - 10;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.clearRect(0, 0, W, H);
    // ball
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
    // crosshair + guide rings
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    [0.35, 0.7].forEach(f => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    // labels
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = `bold ${11 * dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FOLLOW', cx, cy - R * 0.86);
    ctx.fillText('DRAW', cx, cy + R * 0.86);
    // hit point
    const maxR = R - 16 * dpr;
    const px = cx + this.spin.x * maxR, py = cy + this.spin.y * maxR;
    ctx.fillStyle = '#0a0a0f';
    ctx.beginPath();
    ctx.arc(px, py, 12 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  },

  setTurn({ active, color, message }) {
    this.active = active;
    if (color) this.color = color;
    this.spin = { x: 0, y: 0 };
    this.pull = { x: 0, y: 0 };
    this.aiming = false;
    if (!active) this.closeSpinModal();
    this.bannerEl.innerHTML = message;
    if (active) {
      this.hintEl.textContent = 'Drag & release to shoot';
      this.hintEl.classList.remove('hidden');
    } else {
      this.hintEl.classList.add('hidden');
    }
    document.getElementById('controls').classList.toggle('my-turn', active);
    this.drawPad();
    this.drawSpin();
  },

  drawPad() {
    const ctx = this.padCtx;
    const W = this.padCanvas.width, H = this.padCanvas.height;
    if (!W) return;
    const cx = W / 2, cy = H / 2;
    const maxR = this.padMaxR();
    ctx.clearRect(0, 0, W, H);
    if (maxR <= 0) return;

    // concentric guide rings
    ctx.strokeStyle = this.active ? 'rgba(120,140,255,0.35)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.5;
    [0.33, 0.66, 1].forEach(f => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    // center dot = your ball
    ctx.fillStyle = this.active ? this.color : 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.arc(cx, cy, 9 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();

    if (this.aiming) {
      const px = cx + this.pull.x, py = cy + this.pull.y;
      // line from pull point to center + beyond (shot direction)
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(cx - this.pull.x * 0.35, cy - this.pull.y * 0.35);
      ctx.stroke();
      // grabbed circle
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, 22 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      ctx.stroke();
    }
  },

  drawSpin() {
    const ctx = this.spinCtx;
    const W = this.spinCanvas.width, H = this.spinCanvas.height;
    if (!W) return;
    const cx = W / 2, cy = H / 2;
    const R = W / 2 - 8;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this.active ? this.color : '#33333d';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // crosshair
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    // hit point
    const maxR = R - 6;
    ctx.fillStyle = '#0a0a0f';
    ctx.beginPath();
    ctx.arc(cx + this.spin.x * maxR, cy + this.spin.y * maxR, 7 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
  },
};
