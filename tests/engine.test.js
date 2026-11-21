import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  createRun,
  difficultyFor,
  getResult,
  simulate,
  validateInputs,
  ENGINE_VERSION,
  DEFAULT_DURATION_TICKS,
} from '../assets/js/engine.js';

function perfectInputs({ seed, durationTicks = DEFAULT_DURATION_TICKS, reaction = 12, typing = 6 }) {
  const run = createRun({ seed, durationTicks });
  const inputs = [];
  let due = null;
  while (run.status === 'running') {
    if (!run.prompt) {
      due = null;
    } else if (due === null) {
      due = run.tick + reaction;
    }
    let batch = [];
    if (run.prompt && due !== null && run.tick >= due) {
      batch = [run.prompt.seq[run.prompt.index]];
      inputs.push({ t: run.tick, k: batch[0] });
      const willFinish = run.prompt.index + 1 >= run.prompt.seq.length;
      due = willFinish ? null : run.tick + typing;
    }
    advance(run, batch);
  }
  return { inputs, run };
}

test('相同 seed 与输入产生完全一致的结果', () => {
  const { inputs } = perfectInputs({ seed: 12345, durationTicks: 1200 });
  const a = simulate({ seed: 12345, durationTicks: 1200, inputs });
  const b = simulate({ seed: 12345, durationTicks: 1200, inputs });
  assert.deepEqual(getResult(a), getResult(b));
  assert.equal(a.status, 'ended');
});

test('不同 seed 产生不同指令序列', () => {
  const a = createRun({ seed: 1 });
  const b = createRun({ seed: 2 });
  for (let i = 0; i < 60; i += 1) {
    advance(a, []);
    advance(b, []);
  }
  assert.notDeepEqual(a.prompt?.seq, b.prompt?.seq);
});

test('完成指令会抬高斜率，失误不会抹去高度', () => {
  const run = createRun({ seed: 7 });
  while (!run.prompt) advance(run, []);
  const yBefore = run.y;
  const slopeBefore = run.slope;
  const seq = run.prompt.seq.slice();
  for (const key of seq) {
    advance(run, [key]);
  }
  assert.equal(run.successes, 1);
  assert.ok(run.slope > slopeBefore);
  assert.ok(run.y > yBefore);

  const heightAfterSuccess = run.y;
  while (!run.prompt) advance(run, []);
  advance(run, [(run.prompt.seq[0] + 1) % 4]);
  assert.equal(run.misses, 1);
  assert.equal(run.combo, 0);
  assert.ok(run.y >= heightAfterSuccess);
});

test('面积随时间单调不减，且没有抬升时为零', () => {
  const flat = createRun({ seed: 99, durationTicks: 600 });
  while (flat.status === 'running') advance(flat, []);
  assert.equal(flat.slope, 0);
  assert.equal(flat.area, 0);
  assert.equal(getResult(flat).score, 0);

  const run = createRun({ seed: 99, durationTicks: 900 });
  while (!run.prompt) advance(run, []);
  const seq = run.prompt.seq.slice();
  for (const key of seq) advance(run, [key]);
  let lastArea = run.area;
  while (run.status === 'running') {
    advance(run, []);
    assert.ok(run.area >= lastArea);
    lastArea = run.area;
  }
  assert.ok(getResult(run).score > 0);
});

test('超时会中断连击并进入喘息', () => {
  const run = createRun({ seed: 9 });
  while (!run.prompt) advance(run, []);
  const deadline = run.prompt.deadlineTick;
  while (run.tick <= deadline) advance(run, []);
  assert.equal(run.misses, 1);
  assert.equal(run.prompt, null);
  assert.ok(run.nextPromptTick > run.tick);
});

test('指令长度随时间变长，给键时间变短', () => {
  assert.equal(difficultyFor(0).len, 2);
  assert.equal(difficultyFor(30).len, 7);
  assert.ok(difficultyFor(40).perKeyMs < difficultyFor(0).perKeyMs);
  assert.ok(difficultyFor(20).windowMs >= 1100);
});

test('输入校验拒绝同 tick 多键、越界与乱序', () => {
  assert.equal(validateInputs([], 100).ok, true);
  assert.equal(validateInputs([{ t: 1, k: 0 }, { t: 1, k: 1 }], 100).ok, false);
  assert.equal(validateInputs([{ t: 2, k: 0 }, { t: 1, k: 1 }], 100).ok, false);
  assert.equal(validateInputs([{ t: 100, k: 0 }], 100).ok, false);
  assert.equal(validateInputs([{ t: 1, k: 4 }], 100).ok, false);
  assert.equal(validateInputs('nope', 100).ok, false);
});

test('回放忽略结算后输入，结果与真跑一致', () => {
  const { inputs, run } = perfectInputs({ seed: 4242, durationTicks: 900 });
  const replayed = simulate({ seed: 4242, durationTicks: 900, inputs });
  const a = getResult(run);
  const b = getResult(replayed);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.curve, b.curve);
  assert.equal(a.version, ENGINE_VERSION);
  assert.ok(a.score > 0);
});

test('完美操作的高分显著高于慢速操作', () => {
  const fast = perfectInputs({ seed: 2026, durationTicks: 1800, reaction: 8, typing: 4 }).run;
  const slow = perfectInputs({ seed: 2026, durationTicks: 1800, reaction: 40, typing: 26 }).run;
  assert.ok(getResult(fast).score > getResult(slow).score * 1.5);
  assert.ok(getResult(fast).successes > getResult(slow).successes);
});
