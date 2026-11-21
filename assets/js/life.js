/**
 * 逆旅 · 一生引擎
 *
 * 时间单位：现实秒。
 * 斜率单位：高度 / 秒。
 * 面积单位：高度 · 秒。
 *
 * 服务器用这份代码结算，浏览器用同一份代码做实时插值。
 * 前端永远只负责“显示到现在”，不负责“这一生值多少”。
 */

export const LIFE_ENGINE_VERSION = '2.1.0';
export const DAY_SECONDS = 86400;
export const LIFETIME_DAYS = 30000;
export const LIFETIME_SECONDS = DAY_SECONDS * LIFETIME_DAYS;
export const SLOPE_CAP = 0.0012;
export const BASE_GAIN = 0.00003;
export const ARROW_GLYPHS = ['←', '↑', '→', '↓'];
export const KEY_TO_INDEX = {
  ArrowLeft: 0,
  ArrowUp: 1,
  ArrowRight: 2,
  ArrowDown: 3,
};

export function createLife(options = {}) {
  const bornAt = Number.isFinite(options.bornAt) ? options.bornAt : Date.now();
  return {
    bornAt,
    age: 0,
    day: 0,
    slope: 0,
    height: 0,
    area: 0,
    efforts: 0,
    status: 'alive',
    endReason: null,
    seed: Number.isInteger(options.seed) ? options.seed >>> 0 : 1,
  };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 按当前斜率走过 deltaSeconds。
 * 面积用梯形积分：height 是线性变化的。
 */
export function settle(life, deltaSeconds) {
  if (!life || life.status !== 'alive') return life;
  let delta = Number(deltaSeconds);
  if (!Number.isFinite(delta) || delta <= 0) return life;

  const remaining = LIFETIME_SECONDS - life.age;
  if (delta >= remaining) {
    delta = Math.max(0, remaining);
    const h0 = life.height;
    const h1 = h0 + life.slope * delta;
    life.area += (h0 + h1) * 0.5 * delta;
    life.height = h1;
    life.age = LIFETIME_SECONDS;
    life.day = LIFETIME_DAYS;
    life.status = 'ended';
    life.endReason = 'lifespan';
    return life;
  }

  const h0 = life.height;
  const h1 = h0 + life.slope * delta;
  life.area += (h0 + h1) * 0.5 * delta;
  life.height = h1;
  life.age += delta;
  life.day = life.age / DAY_SECONDS;
  return life;
}

/** 一次努力：斜率上升一点，越接近上限，涨得越少。 */
export function applyEffort(life) {
  if (!life || life.status !== 'alive') return 0;
  const room = Math.max(0, 1 - life.slope / SLOPE_CAP);
  const gain = BASE_GAIN * room;
  life.slope = Math.min(SLOPE_CAP, life.slope + gain);
  life.efforts += 1;
  return gain;
}

/** 快进到某一天，只能向前。返回是否因此走到寿命终点。 */
export function fastForward(life, targetDay) {
  if (!life || life.status !== 'alive') {
    return { ok: false, reason: 'ended' };
  }
  const target = Number(targetDay);
  if (!Number.isFinite(target)) return { ok: false, reason: 'bad_target' };
  const targetSeconds = target * DAY_SECONDS;
  if (targetSeconds + 1e-6 < life.age) return { ok: false, reason: 'backwards' };
  if (targetSeconds > LIFETIME_SECONDS + 1e-6) return { ok: false, reason: 'beyond_lifetime' };
  settle(life, Math.max(0, targetSeconds - life.age));
  return { ok: true, ended: life.status === 'ended' };
}

export function endLife(life, reason = 'manual') {
  if (!life || life.status !== 'alive') return false;
  life.status = 'ended';
  life.endReason = reason;
  return true;
}

export function effortLength(efforts) {
  return 10 + Math.max(0, Math.floor(Number(efforts) || 0));
}

function nextRandom(state) {
  let a = (state.value + 0x6d2b79f5) >>> 0;
  state.value = a;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** 与服务器无关的纯函数：给 seed 和 effort 序号，生成同一组箭头。 */
export function makeSequence(seed, effortIndex, length) {
  const state = { value: (seed ^ Math.imul(effortIndex + 1, 0x9e3779b1)) >>> 0 };
  const seq = [];
  let last = -1;
  let streak = 0;
  for (let i = 0; i < length; i += 1) {
    let key = Math.floor(nextRandom(state) * 4);
    if (key === last && streak >= 2) key = (key + 1 + Math.floor(nextRandom(state) * 3)) % 4;
    if (key === last) streak += 1;
    else {
      last = key;
      streak = 1;
    }
    seq.push(key);
  }
  return seq;
}

/** 从出生到 age 的高度曲线，用于画那条线。 */
export function heightAt(age, events = []) {
  let height = 0;
  let time = 0;
  let slope = 0;
  for (const event of events) {
    if (!event || !Number.isFinite(event.at)) continue;
    if (event.at >= age) break;
    const end = Math.min(age, event.at);
    height += slope * (end - time);
    time = end;
    if (Number.isFinite(event.slope)) slope = event.slope;
  }
  if (age > time) height += slope * (age - time);
  return height;
}

/** 以对数年龄采样：越靠近“现在”，点越密。 */
export function sampleAges(age, count = 160, tau = 3600) {
  if (!Number.isFinite(age) || age <= 0) return [0];
  if (age < tau) {
    return Array.from({ length: count }, (_, i) => (age * i) / (count - 1));
  }
  const denom = Math.log1p(age / tau);
  return Array.from({ length: count }, (_, i) => tau * (Math.exp((denom * i) / (count - 1)) - 1));
}

export function snapshot(life) {
  return {
    bornAt: life.bornAt,
    age: life.age,
    day: life.day,
    slope: life.slope,
    height: life.height,
    area: life.area,
    efforts: life.efforts,
    status: life.status,
    endReason: life.endReason,
  };
}

const plainNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const plainInteger = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

/** 右上角只露一个数字；它自己会长大。 */
export function formatArea(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1) return n.toFixed(n < 0.01 ? 6 : 4);
  if (n < 1000) return plainNumber.format(n);
  if (n < 1e16) return plainInteger.format(n);
  return n.toExponential(2).replace('e+', 'e');
}

export function formatDay(value) {
  const day = Math.max(0, Math.min(LIFETIME_DAYS, Math.round(Number(value) || 0)));
  return new Intl.NumberFormat('zh-CN').format(day);
}

export function projectFastForward(life, targetDay) {
  const copy = {
    ...life,
    status: life.status,
  };
  const result = fastForward(copy, targetDay);
  return { ok: result.ok, reason: result.reason, ended: result.ended, life: copy };
}
