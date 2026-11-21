const AMBER = '227, 181, 102';
const PAPER = '238, 232, 220';
const RED = '200, 85, 61';

const NICE_Y = [12, 16, 24, 32, 48, 64, 88, 120, 160, 210, 270, 340, 420, 520];

function niceCeiling(value) {
  for (const step of NICE_Y) if (value <= step) return step;
  return Math.ceil(value / 100) * 100;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function rgba(rgb, alpha) {
  return `rgba(${rgb}, ${alpha})`;
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.runKey = '';
    this.lastTick = -1;
    this.trail = [];
    this.marks = [];
    this.sparks = [];
    this.rings = [];
    this.peak = 0;
    this.yMax = 16;
    this.frozen = false;
    this.lastNow = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.dust = Array.from({ length: 56 }, (_, i) => ({
      x: hash(i * 3.1),
      y: hash(i * 7.7 + 2),
      r: 0.4 + hash(i * 1.3) * 1.1,
      speed: 0.2 + hash(i * 9.2) * 0.8,
      phase: hash(i * 5.5) * Math.PI * 2,
    }));

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

  resetForRun(run) {
    this.runKey = `${run.seed}:${run.durationTicks}`;
    this.lastTick = -1;
    this.trail = [];
    this.marks = [];
    this.sparks = [];
    this.rings = [];
    this.peak = 0;
    this.yMax = 16;
    this.frozen = false;
  }

  playGeometry() {
    const mobile = this.w < 760;
    const short = this.h < 690;
    const left = mobile ? 30 : this.w < 1100 ? 52 : 68;
    const right = mobile ? 20 : 54;
    const top = short ? 90 : mobile ? 152 : 124;
    const bottom = mobile ? 274 : short ? 196 : 224;
    const w = Math.max(80, this.w - left - right);
    const h = Math.max(80, this.h - top - bottom);
    return { left, right, top, bottom, w, h, base: top + h, mobile };
  }

  attractGeometry() {
    const mobile = this.w < 760;
    const top = mobile ? 96 : Math.max(120, this.h * 0.16);
    const bottom = mobile ? this.h * 0.43 : Math.max(96, this.h * 0.14);
    const left = mobile ? 24 : this.w * 0.04;
    const right = mobile ? 20 : this.w * 0.04;
    return {
      left,
      right,
      top,
      bottom,
      w: Math.max(100, this.w - left - right),
      h: Math.max(100, this.h - top - bottom),
      base: this.h - bottom,
      mobile,
    };
  }

  paintBackground(now) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(w * 0.7, h * 0.28, 0, w * 0.7, h * 0.28, Math.max(w, h) * 0.72);
    glow.addColorStop(0, rgba(AMBER, 0.065));
    glow.addColorStop(0.45, rgba(AMBER, 0.018));
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.72, 'rgba(0,0,0,0.18)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    if (this.reduced) return;
    ctx.save();
    for (const d of this.dust) {
      const x = ((d.x + now * 0.000004 * d.speed) % 1.08) * w - w * 0.04;
      const y = d.y * h;
      const alpha = 0.025 + 0.045 * (0.5 + 0.5 * Math.sin(now * 0.0006 + d.phase));
      ctx.fillStyle = rgba(PAPER, alpha);
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawGrid(g, run, options = {}) {
    const { ctx } = this;
    const yMax = options.yMax ?? this.yMax;
    const attract = options.attract === true;
    ctx.save();
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i += 1) {
      const x = g.left + (g.w * i) / 4;
      ctx.strokeStyle = attract ? rgba(PAPER, 0.045) : rgba(PAPER, 0.055);
      ctx.setLineDash(i === 0 || i === 4 ? [] : [1, 8]);
      ctx.beginPath();
      ctx.moveTo(x, g.top);
      ctx.lineTo(x, g.base);
      ctx.stroke();
    }

    if (!attract) {
      for (let i = 0; i <= 2; i += 1) {
        const y = g.base - (g.h * i) / 2;
        ctx.strokeStyle = rgba(PAPER, i === 0 ? 0.035 : 0.04);
        ctx.setLineDash(i === 0 ? [] : [1, 9]);
        ctx.beginPath();
        ctx.moveTo(g.left, y);
        ctx.lineTo(g.left + g.w, y);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.font = '9px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = rgba(PAPER, 0.27);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const totalSeconds = run ? run.durationTicks / 60 : 60;
      for (let i = 0; i <= 4; i += 1) {
        const x = g.left + (g.w * i) / 4;
        const seconds = Math.round((totalSeconds * i) / 4);
        ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
        ctx.fillText(`${seconds}s`, x, g.base + 15);
      }

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(PAPER, 0.23);
      for (let i = 0; i <= 2; i += 1) {
        const y = g.base - (g.h * i) / 2;
        const value = Math.round((yMax * i) / 2);
        ctx.fillText(String(value), g.left - 12, y);
      }

      ctx.strokeStyle = rgba(PAPER, 0.14);
      ctx.beginPath();
      ctx.moveTo(g.left, g.base);
      ctx.lineTo(g.left + g.w, g.base);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.strokeStyle = rgba(PAPER, 0.1);
      ctx.beginPath();
      ctx.moveTo(g.left, g.base);
      ctx.lineTo(g.left + g.w, g.base);
      ctx.stroke();
    }

    ctx.restore();
  }

  mapPoint(g, x, y, yMax = this.yMax) {
    const total = 100;
    return {
      x: g.left + (Math.min(total, Math.max(0, x)) / total) * g.w,
      y: g.base - (Math.max(0, y) / yMax) * g.h,
    };
  }

  pushTrail(run) {
    if (run.tick === this.lastTick) return;
    this.lastTick = run.tick;
    const last = this.trail[this.trail.length - 1];
    if (!last || last[0] !== run.x || last[1] !== run.y) this.trail.push([run.x, run.y]);
    if (this.trail.length > 4200) this.trail.splice(0, 600);
  }

  drawRun(run, now, options = {}) {
    const ending = options.ending === true;
    this.paintBackground(now);
    const g = this.playGeometry();
    if (this.runKey !== `${run.seed}:${run.durationTicks}`) this.resetForRun(run);
    this.pushTrail(run);
    this.peak = Math.max(this.peak, run.y);
    const target = niceCeiling(Math.max(12, this.peak * 1.14));
    if (ending) this.frozen = true;
    const smooth = this.reduced ? 1 : 0.075;
    this.yMax += (target - this.yMax) * smooth;
    if (Math.abs(this.yMax - target) < 0.02) this.yMax = target;

    this.drawGrid(g, run);

    const { ctx } = this;
    const points = this.trail.map(([x, y]) => this.mapPoint(g, x, y));
    if (points.length === 0) points.push(this.mapPoint(g, 0, 0));
    const head = this.mapPoint(g, run.x, run.y);

    if (points.length > 1) {
      ctx.save();
      const fill = ctx.createLinearGradient(0, g.top, 0, g.base);
      fill.addColorStop(0, rgba(AMBER, ending ? 0.22 : 0.13));
      fill.addColorStop(0.55, rgba(AMBER, ending ? 0.09 : 0.05));
      fill.addColorStop(1, rgba(AMBER, 0));
      ctx.beginPath();
      ctx.moveTo(points[0].x, g.base);
      for (const p of points) ctx.lineTo(p.x, p.y);
      ctx.lineTo(points[points.length - 1].x, g.base);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      const stroke = ctx.createLinearGradient(g.left, 0, g.left + g.w, 0);
      stroke.addColorStop(0, rgba(AMBER, 0.2));
      stroke.addColorStop(0.55, rgba(AMBER, 0.72));
      stroke.addColorStop(1, 'rgba(246, 223, 177, 0.98)');
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineTo(head.x, head.y);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = rgba(AMBER, 0.42);
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.restore();
    }

    this.drawMarks(g, now);
    this.drawSparks(now);
    this.drawDot(g, run, head, now);

    if (ending) {
      ctx.save();
      ctx.strokeStyle = rgba(AMBER, 0.24);
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(head.x, head.y);
      ctx.lineTo(head.x, g.base);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawMarks(g, now) {
    const { ctx } = this;
    ctx.save();
    for (const mark of this.marks) {
      const p = this.mapPoint(g, mark.x, mark.y);
      const age = (now - mark.t) / 1000;
      if (mark.type === 'success') {
        ctx.fillStyle = rgba(AMBER, Math.max(0, 0.5 - age * 0.18));
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = rgba(RED, Math.max(0, 0.42 - age * 0.1));
        ctx.beginPath();
        ctx.moveTo(p.x, g.base + 1);
        ctx.lineTo(p.x, g.base + 5);
        ctx.stroke();
      }
    }
    if (this.marks.length > 220) this.marks.splice(0, this.marks.length - 220);
    ctx.restore();
  }

  drawDot(g, run, head, now) {
    const { ctx } = this;
    const pulse = this.reduced ? 0 : Math.sin(now * 0.0055) * 1.1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 34 + pulse);
    glow.addColorStop(0, 'rgba(255, 246, 222, 0.9)');
    glow.addColorStop(0.18, rgba(AMBER, 0.55));
    glow.addColorStop(0.55, rgba(AMBER, 0.12));
    glow.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 36 + pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const slopeAngle = Math.atan2(-run.slope * (g.h / this.yMax), g.w / 100);
    ctx.save();
    ctx.strokeStyle = rgba(AMBER, 0.38);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(head.x + Math.cos(slopeAngle) * 26, head.y + Math.sin(slopeAngle) * 26);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#fff7e6';
    ctx.shadowColor = rgba(AMBER, 0.9);
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 3.4, 0, Math.PI * 2);
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
      return;
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.sparks = this.sparks.filter((s) => s.life > 0);
    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 34 * dt;
      s.vx *= 0.992;
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
      ctx.strokeStyle = rgba(AMBER, (1 - t) * 0.42);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + t * r.grow, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  burst(type, run) {
    if (this.reduced) return;
    const g = this.playGeometry();
    const p = this.mapPoint(g, run.x, run.y);
    if (type === 'success') {
      this.rings.push({ x: p.x, y: p.y, r0: 3, grow: 30, life: 0.55, maxLife: 0.55 });
      const count = 10;
      for (let i = 0; i < count; i += 1) {
        const angle = -Math.PI / 2 + (hash(run.tick * 7 + i) - 0.5) * 2.4;
        const speed = 18 + hash(run.tick * 3 + i) * 62;
        this.sparks.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.5 + hash(i + run.tick) * 0.45,
          maxLife: 0.95,
          size: 0.7 + hash(i * 2 + run.tick) * 1.1,
          color: i % 3 === 0 ? '246, 226, 190' : AMBER,
        });
      }
      this.marks.push({ type: 'success', x: run.x, y: run.y, t: performance.now() });
    } else if (type === 'miss') {
      for (let i = 0; i < 5; i += 1) {
        this.sparks.push({
          x: p.x,
          y: p.y,
          vx: (hash(i * 9 + run.tick) - 0.5) * 34,
          vy: -8 - hash(i + run.tick) * 22,
          life: 0.35 + hash(i * 3) * 0.25,
          maxLife: 0.6,
          size: 0.8,
          color: RED,
        });
      }
      this.marks.push({ type: 'miss', x: run.x, y: run.y, t: performance.now() });
    }
  }

  drawAttract(now) {
    this.paintBackground(now);
    const g = this.attractGeometry();
    this.drawGrid(g, null, { attract: true, yMax: 1 });
    const { ctx } = this;
    const yAt = (t) => {
      const a = 0.66 * smoothstep(0.02, 0.48, t);
      const b = 0.34 * smoothstep(0.54, 0.9, t);
      const wobble = 0.012 * Math.sin(t * 18) * smoothstep(0.15, 0.85, t);
      return a + b + wobble;
    };
    const points = [];
    for (let i = 0; i <= 140; i += 1) {
      const t = i / 140;
      points.push({ x: g.left + t * g.w, y: g.base - yAt(t) * g.h * 0.9 });
    }

    const fill = ctx.createLinearGradient(0, g.top, 0, g.base);
    fill.addColorStop(0, rgba(AMBER, 0.075));
    fill.addColorStop(1, rgba(AMBER, 0));
    ctx.beginPath();
    ctx.moveTo(points[0].x, g.base);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, g.base);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = rgba(AMBER, 0.23);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    let headT = this.reduced ? 0.74 : (now % 18000) / 18000;
    if (headT > 0.985) headT = 0.985;
    const visible = points.filter((p) => p.x <= g.left + headT * g.w + 0.5);
    if (visible.length > 1) {
      ctx.save();
      const stroke = ctx.createLinearGradient(g.left, 0, g.left + g.w, 0);
      stroke.addColorStop(0, rgba(AMBER, 0.12));
      stroke.addColorStop(0.7, rgba(AMBER, 0.62));
      stroke.addColorStop(1, rgba('246, 223, 177', 0.9));
      ctx.beginPath();
      ctx.moveTo(visible[0].x, visible[0].y);
      for (const p of visible) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.shadowColor = rgba(AMBER, 0.35);
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.restore();
    }

    const head = points[Math.min(points.length - 1, Math.floor(headT * points.length))];
    const fade = smoothstep(0.0, 0.04, headT) * (1 - smoothstep(0.94, 0.985, headT));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 40);
    glow.addColorStop(0, rgba('255, 246, 222', 0.75 * fade));
    glow.addColorStop(0.3, rgba(AMBER, 0.3 * fade));
    glow.addColorStop(1, rgba(AMBER, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 248, 232, ${0.9 * fade})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  burstAt(type, x, y) {
    if (this.reduced) return;
    if (type === 'success') {
      this.rings.push({ x, y, r0: 3, grow: 30, life: 0.55, maxLife: 0.55 });
    }
  }
}

/** 榜单详情里的静态轨迹图。 */
export function renderCurvePreview(canvas, curve, options = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, rect.width);
  const h = Math.max(120, rect.height || 230);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#090b0e';
  ctx.fillRect(0, 0, w, h);

  const left = 14;
  const right = 14;
  const top = 18;
  const bottom = 26;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const base = top + plotH;

  ctx.strokeStyle = rgba(PAPER, 0.07);
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const x = left + (plotW * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, base);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(PAPER, 0.14);
  ctx.beginPath();
  ctx.moveTo(left, base);
  ctx.lineTo(left + plotW, base);
  ctx.stroke();

  const values = Array.isArray(curve) && curve.length > 1 ? curve : [0, 0];
  const peak = Math.max(1, ...values);
  const points = values.map((value, i) => ({
    x: left + (plotW * i) / (values.length - 1),
    y: base - (Math.max(0, value) / (peak * 1.12)) * plotH,
  }));

  const fill = ctx.createLinearGradient(0, top, 0, base);
  fill.addColorStop(0, rgba(AMBER, 0.2));
  fill.addColorStop(1, rgba(AMBER, 0));
  ctx.beginPath();
  ctx.moveTo(points[0].x, base);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, base);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = 'rgba(240, 211, 160, 0.92)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = rgba(AMBER, 0.35);
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const last = points[points.length - 1];
  ctx.fillStyle = '#fff7e6';
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = rgba(PAPER, 0.28);
  ctx.font = '9px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('0s', left, base + 9);
  ctx.textAlign = 'right';
  const durationSeconds = Math.round((options.durationTicks || 3600) / 60);
  ctx.fillText(`${durationSeconds}s`, left + plotW, base + 9);
}

/** 榜单行里 12 个点的迷你轨迹。 */
export function sparklineSvg(curve, width = 92, height = 25) {
  const values = Array.isArray(curve) && curve.length > 1 ? curve : [0, 0];
  const peak = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(values.length / 12));
  const sample = [];
  for (let i = 0; i < values.length; i += step) sample.push(values[i]);
  if (sample[sample.length - 1] !== values[values.length - 1]) sample.push(values[values.length - 1]);
  const points = sample.map((value, i) => {
    const x = (i / Math.max(1, sample.length - 1)) * width;
    const y = height - 2 - (Math.max(0, value) / (peak * 1.08)) * (height - 5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${points.join(' ')} ${width},${height}`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${area}" fill="rgba(227,181,102,0.06)"/><polyline points="${points.join(' ')}" fill="none" stroke="rgba(227,181,102,0.65)" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
