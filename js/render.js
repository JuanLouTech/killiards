// Canvas renderer. The table lives in logical 1600x900 space and is scaled
// (letterboxed) to fit the available area, keeping the aspect ratio so every
// device sees exactly the same play field.

const Renderer = {
  canvas: null,
  ctx: null,
  wrap: null,
  scale: 1,
  MARGIN: 70, // logical units around the table so labels/glow aren't clipped
  borderLayer: null,   // static glowing borders, pre-rendered per resize
  tableId: null,
  particles: [],
  shakeMag: 0,
  lastT: 0,

  init(canvas, wrap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = wrap;
    window.addEventListener('resize', () => this.resize());
    // catches layout changes that don't fire window resize (controls column
    // appearing, hand-side swap, orientation flips…)
    if (window.ResizeObserver) {
      new ResizeObserver(() => this.resize()).observe(wrap);
    }
    this.resize();
  },

  resize() {
    if (!this.wrap) return;
    // content-box size: clientWidth/Height include padding, so subtract it —
    // otherwise the canvas overflows under neighbouring UI
    const cs = getComputedStyle(this.wrap);
    const availW = this.wrap.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const availH = this.wrap.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (availW < 2 || availH < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const LW = TABLE_W + this.MARGIN * 2, LH = TABLE_H + this.MARGIN * 2;
    const s = Math.min(availW / LW, availH / LH);
    const cssW = LW * s, cssH = LH * s;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.scale = (cssW * dpr) / LW;
    this.tableId = null; // force border layer rebuild
  },

  buildBorderLayer(table) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    ctx.scale(this.scale, this.scale);
    ctx.translate(this.MARGIN, this.MARGIN);

    const drawGlowPath = (path, color) => {
      // outer glow pass + bright core pass = laser look
      ctx.save();
      ctx.shadowColor = color;
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 26;
      ctx.strokeStyle = color;
      ctx.lineWidth = 7;
      ctx.stroke(path);
      ctx.shadowBlur = 10;
      ctx.strokeStyle = '#eaffea';
      ctx.lineWidth = 2.5;
      ctx.stroke(path);
      ctx.restore();
    };

    const color = '#41ff5a';
    const border = new Path2D();
    border.rect(4, 4, TABLE_W - 8, TABLE_H - 8);
    drawGlowPath(border, color);

    for (const obs of table.obstacles) {
      const p = new Path2D();
      obs.pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      p.closePath();
      ctx.save();
      ctx.scale(1, 1);
      ctx.fillStyle = 'rgba(65,255,90,0.06)';
      ctx.fill(p);
      ctx.restore();
      drawGlowPath(p, color);
    }
    this.borderLayer = c;
  },

  addShake(mag) {
    this.shakeMag = Math.min(30, this.shakeMag + mag);
  },

  spawnSparks(x, y, n, color, speed = 300) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        ttl: 0.3 + Math.random() * 0.4, life: 0, color,
        size: 3 + Math.random() * 4,
      });
    }
  },

  spawnExplosion(x, y, color) {
    this.spawnSparks(x, y, 50, color, 550);
    this.spawnSparks(x, y, 25, '#ffffff', 350);
    this.addShake(14);
  },

  // scene: { table, balls, barsAlpha, aim, myIdx }
  // balls: [{x, y, color, emoji, dead, name, hpShow}]
  draw(scene) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, this.lastT ? now - this.lastT : 0.016);
    this.lastT = now;

    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    if (this.tableId !== scene.table.id || !this.borderLayer) {
      this.buildBorderLayer(scene.table);
      this.tableId = scene.table.id;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, W, H);

    // camera shake
    let ox = 0, oy = 0;
    if (this.shakeMag > 0.3) {
      ox = (Math.random() * 2 - 1) * this.shakeMag * this.scale * 0.5;
      oy = (Math.random() * 2 - 1) * this.shakeMag * this.scale * 0.5;
      this.shakeMag *= Math.pow(0.02, dt); // fast decay
    } else this.shakeMag = 0;

    ctx.setTransform(1, 0, 0, 1, ox, oy);
    ctx.drawImage(this.borderLayer, 0, 0);

    const m = this.MARGIN * this.scale;
    ctx.setTransform(this.scale, 0, 0, this.scale, ox + m, oy + m);

    // aim arrow (under the balls)
    if (scene.aim && scene.aim.power > 0.02) {
      this.drawArrow(ctx, scene.aim);
    }

    // balls
    for (const b of scene.balls) {
      this.drawBall(ctx, b);
    }

    // labels & energy bars
    if (scene.barsAlpha > 0.01) {
      ctx.globalAlpha = scene.barsAlpha;
      for (const b of scene.balls) {
        if (!b.dead) this.drawLabel(ctx, b);
      }
      ctx.globalAlpha = 1;
    }

    // particles
    this.particles = this.particles.filter(p => {
      p.life += dt;
      if (p.life >= p.ttl) return false;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.98; p.vy *= 0.98;
      const a = 1 - p.life / p.ttl;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    ctx.globalAlpha = 1;
  },

  drawArrow(ctx, aim) {
    const len = 60 + aim.power * 300;
    const tipX = aim.x + aim.dx * len;
    const tipY = aim.y + aim.dy * len;
    ctx.save();
    ctx.shadowColor = aim.color;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = aim.color;
    ctx.fillStyle = aim.color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(aim.x + aim.dx * (PHYS.R + 6), aim.y + aim.dy * (PHYS.R + 6));
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // arrowhead
    const a = Math.atan2(aim.dy, aim.dx);
    ctx.beginPath();
    ctx.moveTo(tipX + Math.cos(a) * 18, tipY + Math.sin(a) * 18);
    ctx.lineTo(tipX + Math.cos(a + 2.5) * 14, tipY + Math.sin(a + 2.5) * 14);
    ctx.lineTo(tipX + Math.cos(a - 2.5) * 14, tipY + Math.sin(a - 2.5) * 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  drawBall(ctx, b) {
    const R = PHYS.R;
    ctx.save();
    if (b.dead) {
      // dead ball: thick grey circumference, no name/bar
      ctx.fillStyle = '#101014';
      ctx.beginPath();
      ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6b6b74';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.font = `${R * 1.1}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.emoji, b.x, b.y + 2);
    } else {
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.font = `${R * 1.25}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.emoji, b.x, b.y + 2);
    }
    ctx.restore();
  },

  drawLabel(ctx, b) {
    const w = 124, h = 15, r = 7;
    const x = b.x - w / 2;
    const y = b.y - PHYS.R - 32;
    const round = (rx, ry, rw, rh, rr) => {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, rr);
      else ctx.rect(rx, ry, rw, rh);
    };
    ctx.save();
    // name
    ctx.font = 'bold 19px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(b.name, b.x + 1.5, y - 3 + 1.5);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.name, b.x, y - 3);
    // bar
    const pct = Math.max(0, Math.min(1, b.hpShow / PHYS.MAX_HP));
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    round(x - 2, y - 2, w + 4, h + 4, r + 2);
    ctx.fill();
    ctx.fillStyle = '#26262e';
    round(x, y, w, h, r);
    ctx.fill();
    if (pct > 0) {
      round(x, y, w, h, r);
      ctx.clip();
      ctx.fillStyle = `hsl(${pct * 115}, 90%, 48%)`;
      ctx.fillRect(x, y, w * pct, h);
    }
    ctx.restore();
  },

  // small helper used by the lobby to draw table thumbnails
  drawThumb(canvas, table) {
    const ctx = canvas.getContext('2d');
    const s = canvas.width / TABLE_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.strokeStyle = '#41ff5a';
    ctx.lineWidth = 3 / s;
    ctx.strokeRect(6, 6, TABLE_W - 12, TABLE_H - 12);
    for (const obs of table.obstacles) {
      ctx.beginPath();
      obs.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(65,255,90,0.15)';
      ctx.fill();
      ctx.stroke();
    }
  },
};
