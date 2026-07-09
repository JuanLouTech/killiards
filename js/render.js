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
  floaters: [],        // rising emote emojis
  shakeMag: 0,
  lastT: 0,
  TELE_COLORS: ['#3ec6ff', '#ff6bd6', '#ffb14d'],

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

  spawnEmote(x, y, emoji) {
    this.floaters.push({ x, y, emoji, life: 0, ttl: 1.7 });
  },

  // Floating damage/heal number over a ball: red "-12" rising and fading,
  // green "+25" for heals (negative dmg). Bigger hits draw bigger.
  spawnDamage(x, y, dmg) {
    const mag = Math.abs(dmg);
    if (mag < 0.5) return;
    this.floaters.push({
      x: x + (Math.random() * 2 - 1) * 12, y,
      text: (dmg > 0 ? '-' : '+') + Math.round(mag),
      color: dmg > 0 ? '#ff5a5a' : '#41ff5a',
      size: Math.min(60, 27 + mag * 1.1),
      life: 0, ttl: 1.1,
    });
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

    // static-ish table features under everything that moves
    if (scene.table.teles) this.drawTeleporters(ctx, scene.table.teles, now);
    if (scene.powerups && scene.powerups.length) this.drawPowerups(ctx, scene.powerups, now);

    // aim arrow (under the balls)
    if (scene.aim && scene.aim.power > 0.02) {
      this.drawArrow(ctx, scene.aim);
    }

    // barriers & balls
    if (scene.barriers) {
      for (const br of scene.barriers) this.drawBarrier(ctx, br);
    }
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

    // floating emotes & damage numbers (drawn above everything)
    this.floaters = this.floaters.filter(f => {
      f.life += dt;
      if (f.life >= f.ttl) return false;
      const k = f.life / f.ttl;
      f.y -= 55 * dt;
      const pop = Math.min(1, f.life / 0.18);          // quick scale-in
      const a = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;      // fade at the end
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (f.text) {
        ctx.font = `900 ${Math.round(f.size * (0.6 + pop * 0.4))}px sans-serif`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      } else {
        ctx.font = `${Math.round(52 * (0.5 + pop * 0.5))}px sans-serif`;
        ctx.fillText(f.emoji, f.x, f.y);
      }
      return true;
    });
    ctx.globalAlpha = 1;
  },

  drawTeleporters(ctx, teles, now) {
    teles.forEach((t, ti) => {
      const color = this.TELE_COLORS[ti % this.TELE_COLORS.length];
      for (const [x, y] of [t.a, t.b]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(now * 1.4 + ti);
        ctx.shadowColor = color;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.setLineDash([16, 12]);
        ctx.beginPath();
        ctx.arc(0, 0, PHYS.TELE_R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.rotate(-now * 2.6);
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, PHYS.TELE_R * 0.55, 0.6, Math.PI * 2 - 0.6);
        ctx.stroke();
        ctx.restore();
      }
    });
  },

  drawPowerups(ctx, powerups, now) {
    for (const u of powerups) {
      const kind = POWER_KINDS[u.k];
      const color = kind.trap ? '#c86bff' : '#ffd84d';
      const pulse = 1 + Math.sin(now * 4 + u.x) * 0.08;
      const R = PHYS.PU_R * pulse;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(u.x, u.y, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.font = `${Math.round(R * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kind.emoji, u.x, u.y + 1);
      ctx.restore();
    }
  },

  drawBarrier(ctx, br) {
    const s = PHYS.BAR_R * 1.72; // square drawn slightly inside its circle body
    ctx.save();
    ctx.shadowColor = '#3ec6ff';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = '#3ec6ff';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    const p = new Path2D();
    if (p.roundRect) p.roundRect(br.x - s / 2, br.y - s / 2, s, s, 9);
    else p.rect(br.x - s / 2, br.y - s / 2, s, s);
    ctx.stroke(p);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(62, 198, 255, 0.12)';
    ctx.fill(p);
    ctx.strokeStyle = 'rgba(234, 250, 255, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke(p);
    ctx.restore();
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
    const R = PHYS.R * (b.rMul || 1);
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
      ctx.shadowColor = b.isBot ? '#ffd84d' : b.color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // bots wear a yellow glowing ring instead of the white one
      ctx.strokeStyle = b.isBot ? '#ffd84d' : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = b.isBot ? 3.5 : 2.5;
      ctx.stroke();
      ctx.font = `${R * 1.25}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.emoji, b.x, b.y + 2);
      // stored power-up badge
      if (b.storedPower && POWER_KINDS[b.storedPower]) {
        const bx = b.x + R * 0.85, by = b.y - R * 0.85;
        ctx.fillStyle = 'rgba(4,5,10,0.85)';
        ctx.beginPath();
        ctx.arc(bx, by, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = POWER_KINDS[b.storedPower].trap ? '#c86bff' : '#ffd84d';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = '17px sans-serif';
        ctx.fillText(POWER_KINDS[b.storedPower].emoji, bx, by + 1);
      }
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
    // name (nameless balls show only the bar — the emoji is on the ball)
    if (b.name) {
      ctx.font = 'bold 19px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(b.name, b.x + 1.5, y - 3 + 1.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.name, b.x, y - 3);
    }
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
    (table.teles || []).forEach((t, ti) => {
      ctx.strokeStyle = this.TELE_COLORS[ti % this.TELE_COLORS.length];
      ctx.lineWidth = 4 / s;
      for (const [x, y] of [t.a, t.b]) {
        ctx.beginPath();
        ctx.arc(x, y, PHYS.TELE_R, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    for (const [x, y] of (table.barriers || [])) {
      const bs = PHYS.BAR_R * 1.72;
      ctx.strokeStyle = '#3ec6ff';
      ctx.lineWidth = 4 / s;
      ctx.strokeRect(x - bs / 2, y - bs / 2, bs, bs);
    }
  },
};
