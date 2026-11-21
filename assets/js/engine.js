/**
 * 逆旅 · 确定性游戏引擎
 *
 * 这个文件同时被浏览器与服务器加载。
 * 它不读时间、不读随机数、不碰 DOM：给定 seed + 输入序列，结果永远一致。
 * 服务器据此回放玩家输入，重新计算面积。
 */

export const ENGINE_VERSION = '1.0.0';
export const TICK_MS = 1000 / 60;
export const DEFAULT_DURATION_TICKS = 3600; // 60s
export const X_TOTAL = 100;
export const SLOPE_CAP = 2.6;
export const BASE_GAIN = 0.085;
export const SAMPLE_EVERY = 30; // 0.5s 一个采样点
export const MAX_INPUTS = 4096;
export const MAX_PROMPT_LEN = 7;

export const ARROWS = Object.freeze(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
export const ARROW_GLYPHS = Object.freeze(['←', '↑', '→', '↓']);
export const KEY_TO_INDEX = Object.freeze({
  ArrowLeft: 0,
  ArrowUp: 1,
  ArrowRight: 2,
  ArrowDown: 3,
});

const DEFAULTS = Object.freeze({
  durationTicks: DEFAULT_DURATION_TICKS,
  xTotal: X_TOTAL,
  slopeCap: SLOPE_CAP,
  baseGain: BASE_GAIN,
  successGap: 8,
  missGap: 42,
  maxPromptLen: MAX_PROMPT_LEN,
});

/** mulberry32：小、快、可复现。 */
function nextRandom(run) {
  let a = (run.rngState + 0x6d2b79f5) >>> 0;
  run.rngState = a;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** 第 level 次成功之后，下一组指令有多长、给多少时间。 */
export function difficultyFor(level, maxPromptLen = MAX_PROMPT_LEN, missStreak = 0) {
  const mercy = Math.min(3, Math.floor(missStreak / 2));
  const baseLen = Math.min(maxPromptLen, 2 + Math.floor(level / 6));
  const len = Math.max(2, baseLen - mercy);
  const perKeyMs = Math.max(130, 300 - level * 4);
  const rawWindow = Math.max(1100, len * perKeyMs + 520 - level * 6);
  const mercyWindow = 1 + Math.min(0.4, missStreak * 0.07);
  const openingGrace = level === 0 ? 500 : 0;
  const windowMs = rawWindow * mercyWindow + openingGrace;
  return { len, perKeyMs, windowMs, windowTicks: Math.round(windowMs / TICK_MS) };
}

function makePrompt(run) {
  const { len, windowTicks } = difficultyFor(run.level, MAX_PROMPT_LEN, run.missStreak);
  const seq = [];
  let last = -1;
  let streak = 0;
  for (let i = 0; i < len; i += 1) {
    let k = Math.floor(nextRandom(run) * 4);
    if (k === last && streak >= 2) {
      k = (k + 1 + Math.floor(nextRandom(run) * 3)) % 4;
    }
    if (k === last) streak += 1;
    else {
      last = k;
      streak = 1;
    }
    seq.push(k);
  }
  const key = seq.join('');
  if (seq.length > 2 && key === run.lastPromptKey) {
    seq[0] = (seq[0] + 1) % 4;
  }
  run.lastPromptKey = seq.join('');
  run.prompt = {
    seq,
    index: 0,
    deadlineTick: run.tick + windowTicks,
    len,
    windowTicks,
  };
  run.events.push({ type: 'prompt', tick: run.tick, len });
}

function succeed(run, tick) {
  const prompt = run.prompt;
  run.combo += 1;
  run.maxCombo = Math.max(run.maxCombo, run.combo);
  run.successes += 1;
  run.level += 1;
  run.missStreak = 0;
  const comboBonus = 1 + Math.min(run.combo, 10) * 0.012;
  const room = Math.max(0, 1 - run.slope / run.slopeCap);
  const gain = run.baseGain * room * comboBonus;
  run.slope = Math.min(run.slopeCap, run.slope + gain);
  run.prompt = null;
  run.nextPromptTick = tick + run.successGap;
  run.events.push({ type: 'success', tick, gain, slope: run.slope, combo: run.combo, len: prompt.len });
}

function fail(run, tick, reason) {
  run.misses += 1;
  run.combo = 0;
  run.missStreak += 1;
  run.prompt = null;
  run.nextPromptTick = tick + run.missGap;
  run.events.push({ type: 'miss', tick, reason });
}

export function createRun(options = {}) {
  const seed = Number.isInteger(options.seed) ? options.seed >>> 0 : 1;
  const durationTicks = Number.isInteger(options.durationTicks)
    ? Math.max(600, Math.min(60 * 60 * 10, options.durationTicks))
    : DEFAULTS.durationTicks;
  const run = {
    version: ENGINE_VERSION,
    seed,
    rngState: seed >>> 0,
    tick: 0,
    durationTicks,
    xTotal: DEFAULTS.xTotal,
    slopeCap: DEFAULTS.slopeCap,
    baseGain: DEFAULTS.baseGain,
    successGap: DEFAULTS.successGap,
    missGap: DEFAULTS.missGap,
    x: 0,
    y: 0,
    slope: 0,
    area: 0,
    level: 0,
    combo: 0,
    maxCombo: 0,
    missStreak: 0,
    successes: 0,
    misses: 0,
    prompt: null,
    nextPromptTick: 45,
    lastPromptKey: '',
    status: 'running',
    events: [],
    samples: [0],
    marks: [],
  };
  return run;
}

/**
 * 推进一个 tick。
 * inputs 是「这个 tick 里落下的按键」，通常只有一个。
 */
export function advance(run, inputs = []) {
  if (run.status !== 'running') return run;
  const tick = run.tick;

  for (const key of inputs) {
    if (!run.prompt) break;
    const expected = run.prompt.seq[run.prompt.index];
    if (key === expected) {
      run.prompt.index += 1;
      if (run.prompt.index >= run.prompt.seq.length) succeed(run, tick);
    } else {
      fail(run, tick, 'wrong');
      break;
    }
  }

  if (run.prompt && tick >= run.prompt.deadlineTick) {
    fail(run, tick, 'timeout');
  }

  if (!run.prompt && tick >= run.nextPromptTick) {
    makePrompt(run);
  }

  const dx = run.xTotal / run.durationTicks;
  run.y += run.slope * dx;
  run.area += run.y * dx;
  run.x += dx;
  run.tick = tick + 1;

  if (run.tick % SAMPLE_EVERY === 0 || run.tick === run.durationTicks) {
    run.samples.push(Math.round(run.y * 100) / 100);
  }

  if (run.tick >= run.durationTicks) {
    run.status = 'ended';
    run.prompt = null;
    run.events.push({ type: 'end', tick: run.tick });
  }

  return run;
}

/** 把模拟结果压成可存储、可展示的摘要。 */
export function getResult(run) {
  return {
    version: run.version,
    seed: run.seed,
    score: Math.max(0, Math.round(run.area)),
    area: Math.round(run.area * 100) / 100,
    height: Math.round(run.y * 100) / 100,
    slope: Math.round(run.slope * 10000) / 10000,
    maxSlope: Math.round(run.slope * 10000) / 10000,
    successes: run.successes,
    misses: run.misses,
    maxCombo: run.maxCombo,
    durationTicks: run.durationTicks,
    curve: run.samples.slice(),
  };
}

/** 服务器 / 测试用：从 seed 与输入日志完整重放。 */
export function simulate({ seed, durationTicks, inputs = [] }) {
  const run = createRun({ seed, durationTicks });
  let i = 0;
  while (run.status === 'running') {
    const batch = [];
    while (i < inputs.length && inputs[i].t < run.tick) i += 1;
    while (i < inputs.length && inputs[i].t === run.tick) {
      batch.push(inputs[i].k);
      i += 1;
    }
    advance(run, batch);
  }
  return run;
}

/**
 * 输入日志必须严格递增：一个 tick 只允许一个按键，
 * 否则同一毫秒连打七个箭头就能作弊。
 */
export function validateInputs(inputs, durationTicks) {
  if (!Array.isArray(inputs)) return { ok: false, error: 'inputs_not_array' };
  if (inputs.length > MAX_INPUTS) return { ok: false, error: 'too_many_inputs' };
  let last = -1;
  for (const item of inputs) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'bad_input' };
    if (!Number.isInteger(item.t) || !Number.isInteger(item.k)) {
      return { ok: false, error: 'bad_input' };
    }
    if (item.t <= last) return { ok: false, error: 'input_ticks_not_increasing' };
    if (item.t < 0 || item.t >= durationTicks) return { ok: false, error: 'input_tick_out_of_range' };
    if (item.k < 0 || item.k > 3) return { ok: false, error: 'bad_key' };
    last = item.t;
  }
  return { ok: true };
}

/** 同一 seed 下，玩家在某个时刻应该看到什么（客户端调试用）。 */
export function replayEvents({ seed, durationTicks, inputs }) {
  return simulate({ seed, durationTicks, inputs }).events;
}
