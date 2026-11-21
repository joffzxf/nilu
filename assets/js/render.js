import {
  SLOPE_CAP,
  heightAt,
} from './life.js?v=2.2.0';

const AMBER = '227, 181, 102';
const PAPER = '238, 232, 220';
const RED = '200, 85, 61';

function rgba(rgb, alpha) {
  return `rgba(${rgb}, ${alpha})`;
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class LifeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.dust = Array.from({ length: 44 }, (_, i) => ({
      x: hash(i * 3.7),
      y: hash(i * 8.1 + 4),
      r: 0.4 + hash(i * 2.3) * 1.1,
      speed: 0.2 + hash(i * 5.9) * 0.9,
      phase: hash(i * 4.2) * Math.PI * 2,
    }));
    this.sparks = [];
    this.rings = [];
    this.streaks = [];
    this.lastNow = 0;
    this.deathAt = 0;
    this.deathReason = '';
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize, { passive: true });
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (event) => {
      this.reduced = event.matches;
    });
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  geometry() {
    const centerX = this.w * 0.5;
    const centerY = this.h * 0.5;
    const left = this.w < 620 ? 22 : Math.max(this.w * 0.07, 46);
    const halfW = centerX - left;
    const halfH = Math.min(this.h * 0.32, 280);
    return { left, centerX, centerY, halfW, halfH };
  }

  paintBackground(now) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, h);

    const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.6);
    g.addColorStop(0, rgba(AMBER, 0.055));
    g.addColorStop(0.4, rgba(AMBER, 0.014));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.24, w / 2, h / 2, Math.max(w, h) * 0.8);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.72, 'rgba(0,0,0,0.2)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.66)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    if (this.reduced) return;
    ctx.save();
    for (const d of this.dust) {
      const x = ((d.x - now * 0.0000045 * d.speed) % 1.08 + 1.08) % 1.08 * w - w * 0.04;
      const y = d.y * h;
      const alpha = 0.02 + 0.045 * (0.5 + 0.5 * Math.sin(now * 0.00055 + d.phase));
      ctx.fillStyle = rgba(PAPER, alpha);
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ageToX(age, nowAge, left, centerX) {
    if (nowAge <= 0) return centerX;
    const u = Math.pow(Math.max(0, Math.min(1, age / nowAge)), 0.58);
    return left + u * (centerX - left);
  }

  drawTicks(g, age) {
    const { ctx } = this;
    const marks = [1, 5, 15, 60, 300, 1800, 3600, 21600, 86400, 604800, 2592000, 31536000, 315360000, 788400000, 1576800000];
    ctx.save();
    ctx.lineWidth = 1;
    for (const mark of marks) {
      if (age < mark * 1.04) continue;
      const x = this.ageToX(age - mark, age, g.left, g.centerX);
      ctx.strokeStyle = rgba(PAPER, 0.035);
      ctx.beginPath();
      ctx.moveTo(x, g.centerY - g.halfH * 0.82);
      ctx.lineTo(x, g.centerY + g.halfH * 0.82);
      ctx.stroke();
    }
    // the present
    ctx.strokeStyle = rgba(AMBER, 0.1);
    ctx.beginPath();
    ctx.moveTo(g.centerX, g.centerY - g.halfH * 0.9);
    ctx.lineTo(g.centerX, g.centerY + g.halfH * 0.9);
    ctx.stroke();
    ctx.restore();
  }

  drawCurve(life, events, now) {
    const { ctx } = this;
    const g = this.geometry();
    const age = Math.max(0, life.age);
    const H = Math.max(0, life.height);
    const amp = g.halfH * Math.pow(Math.min(1, H / 0.02), 0.55);
    const baseY = g.centerY + amp;

    this.drawTicks(g, age);

    if (age <= 0 || H <= 0) {
      // 一条平线也是轨迹
      if (age > 0) {
        ctx.save();
        ctx.strokeStyle = rgba(PAPER, 0.1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(g.left, g.centerY);
        ctx.lineTo(g.centerX, g.centerY);
        ctx.stroke();
        ctx.restore();
      }
      this.drawSparks(now);
      this.drawDot(g, life, now, 1);
      return;
    }

    const ages = Array.from({ length: 170 }, (_, index) => {
      const u = index / 169;
      return age * Math.pow(u, 1 / 0.58);
    });
    const points = [];
    const hasEvents = Array.isArray(events) && events.length > 0;
    for (const a of ages) {
      const h = hasEvents ? heightAt(a, events) : life.slope * a;
      const x = this.ageToX(a, age, g.left, g.centerX);
      const y = g.centerY - ((h - H) / H) * amp;
      points.push({ x, y });
    }
    const endX = g.centerX;
    const endY = g.centerY;
    points.push({ x: endX, y: endY });

    ctx.save();
    const fill = ctx.createLinearGradient(0, g.centerY - amp, 0, baseY);
    fill.addColorStop(0, rgba(AMBER, 0.26));
    fill.addColorStop(0.55, rgba(AMBER, 0.11));
    fill.addColorStop(1, rgba(AMBER, 0.025));
    ctx.beginPath();
    ctx.moveTo(points[0].x, baseY);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = rgba(AMBER, 0.028);
    ctx.fill();

    // 面积的底边：很淡，但让它真的“被围起来”
    ctx.strokeStyle = rgba(AMBER, 0.09);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(points[0].x, baseY);
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.stroke();

    const stroke = ctx.createLinearGradient(g.left, 0, g.centerX, 0);
    stroke.addColorStop(0, rgba(AMBER, 0.06));
    stroke.addColorStop(0.45, rgba(AMBER, 0.38));
    stroke.addColorStop(1, 'rgba(246, 223, 177, 0.95)');
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(AMBER, 0.35);
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // 最近的一段更亮：让人看见“现在”还在长
    const recent = points.slice(Math.max(0, points.length - 26));
    if (recent.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(recent[0].x, recent[0].y);
      for (let i = 1; i < recent.length; i += 1) ctx.lineTo(recent[i].x, recent[i].y);
      ctx.strokeStyle = 'rgba(247, 226, 186, 0.9)';
      ctx.lineWidth = 2.1;
      ctx.lineCap = 'round';
      ctx.shadowColor = rgba(AMBER, 0.6);
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.restore();
    }

    // 一点未来的方向，不画完
    const angle = -Math.atan2((life.slope / SLOPE_CAP) * 0.34, 1);
    ctx.save();
    ctx.setLineDash([2, 9]);
    ctx.strokeStyle = rgba(AMBER, 0.14);
    ctx.beginPath();
    ctx.moveTo(g.centerX, g.centerY);
    ctx.lineTo(g.centerX + Math.cos(angle) * 84, g.centerY + Math.sin(angle) * 84);
    ctx.stroke();
    ctx.restore();

    this.drawSparks(now);
    this.drawDot(g, life, now, 1);
  }

  drawDot(g, life, now, alpha = 1) {
    const { ctx } = this;
    const pulse = this.reduced ? 0 : Math.sin(now * 0.0022) * 1.2;
    const death = this.deathAt ? Math.min(1, (now - this.deathAt) / 1700) : 0;
    const a = Math.max(0, alpha * (1 - death));
    if (a <= 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(g.centerX, g.centerY, 0, g.centerX, g.centerY, 44 + pulse);
    glow.addColorStop(0, `rgba(255, 246, 222, ${0.8 * a})`);
    glow.addColorStop(0.16, rgba(AMBER, 0.5 * a));
    glow.addColorStop(0.5, rgba(AMBER, 0.1 * a));
    glow.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(g.centerX, g.centerY, (46 + pulse) * (1 - death * 0.4), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = `rgba(255, 248, 232, ${a})`;
    ctx.shadowColor = rgba(AMBER, 0.9);
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(g.centerX, g.centerY, 3.6 * (1 - death), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSparks(now) {
    const { ctx } = this;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.reduced) {
      this.sparks = [];
      this.rings = [];
      this.streaks = [];
      return;
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.sparks = this.sparks.filter((s) => s.life > 0);
    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 24 * dt;
      s.vx *= 0.99;
      const alpha = Math.max(0, s.life / s.maxLife);
      ctx.fillStyle = rgba(s.color, alpha * 0.8);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    this.rings = this.rings.filter((r) => r.life > 0);
    for (const r of this.rings) {
      r.life -= dt;
      const t = 1 - r.life / r.maxLife;
      ctx.strokeStyle = rgba(AMBER, (1 - t) * 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + t * r.grow, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.streaks = this.streaks.filter((s) => s.life > 0);
    for (const s of this.streaks) {
      s.life -= dt;
      s.x += s.vx * dt;
      const alpha = Math.max(0, s.life / s.maxLife) * 0.18;
      ctx.strokeStyle = rgba(AMBER, alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + s.len, s.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  burst(type = 'effort') {
    if (this.reduced) return;
    const g = this.geometry();
    if (type === 'effort') {
      this.rings.push({ x: g.centerX, y: g.centerY, r0: 4, grow: 42, life: 0.75, maxLife: 0.75 });
      for (let i = 0; i < 12; i += 1) {
        const angle = -Math.PI / 2 + (hash(i * 4.1) - 0.5) * 2.2;
        const speed = 16 + hash(i * 7.3) * 54;
        this.sparks.push({
          x: g.centerX,
          y: g.centerY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.5 + hash(i * 2.2) * 0.5,
          maxLife: 1,
          size: 0.7 + hash(i * 9.1) * 1.1,
          color: i % 3 === 0 ? '246, 226, 190' : AMBER,
        });
      }
    } else if (type === 'wrong') {
      for (let i = 0; i < 7; i += 1) {
        this.sparks.push({
          x: g.centerX,
          y: g.centerY,
          vx: (hash(i * 9 + 3) - 0.5) * 44,
          vy: -10 - hash(i + 7) * 30,
          life: 0.35 + hash(i * 3.3) * 0.3,
          maxLife: 0.65,
          size: 0.8,
          color: RED,
        });
      }
    }
  }

  warp() {
    if (this.reduced) return;
    for (let i = 0; i < 22; i += 1) {
      this.streaks.push({
        x: this.w * (0.15 + hash(i * 5.3) * 0.8),
        y: this.h * (0.2 + hash(i * 8.7) * 0.6),
        vx: -600 - hash(i * 2.9) * 900,
        len: -30 - hash(i * 4.4) * 120,
        life: 0.4 + hash(i * 6.2) * 0.6,
        maxLife: 1,
      });
    }
  }

  die(reason = 'manual') {
    this.deathAt = performance.now();
    this.deathReason = reason;
  }

  isDeathComplete(now = performance.now()) {
    return Boolean(this.deathAt) && now - this.deathAt > 1700;
  }

  draw(life, events, now, options = {}) {
    this.paintBackground(now);
    if (!life) {
      const g = this.geometry();
      this.drawDot(g, { slope: 0, height: 0 }, now, 0.6);
      return;
    }
    if (life.status !== 'alive' && !this.deathAt) this.die(life.endReason || 'manual');
    this.drawCurve(life, events, now);
  }
}
