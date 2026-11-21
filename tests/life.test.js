import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_GAIN,
  DAY_SECONDS,
  LIFETIME_SECONDS,
  applyEffort,
  createLife,
  effortLength,
  fastForward,
  formatArea,
  heightAt,
  makeSequence,
  settle,
} from '../assets/js/life.js';

test('新生：时间、斜率、面积都是零', () => {
  const life = createLife({ bornAt: 1000, seed: 7 });
  assert.equal(life.age, 0);
  assert.equal(life.day, 0);
  assert.equal(life.slope, 0);
  assert.equal(life.area, 0);
  assert.equal(life.status, 'alive');
});

test('没有努力时，时间再久面积也是零', () => {
  const life = createLife({ bornAt: 0 });
  settle(life, 3600);
  assert.equal(life.height, 0);
  assert.equal(life.area, 0);
  assert.equal(life.age, 3600);
  assert.equal(life.day, 3600 / DAY_SECONDS);
});

test('一次努力后，面积按梯形积分增长', () => {
  const life = createLife({ bornAt: 0 });
  const gain = applyEffort(life);
  assert.ok(Math.abs(gain - BASE_GAIN) < 1e-12);
  assert.ok(Math.abs(life.slope - BASE_GAIN) < 1e-12);
  settle(life, 3600);
  assert.ok(Math.abs(life.height - BASE_GAIN * 3600) < 1e-8);
  assert.ok(Math.abs(life.area - 0.5 * BASE_GAIN * 3600 * 3600) < 1e-4);
});

test('斜率在两次努力之间保持，面积分段累计', () => {
  const life = createLife({ bornAt: 0 });
  applyEffort(life);
  settle(life, 100);
  const h1 = life.height;
  const a1 = life.area;
  applyEffort(life);
  settle(life, 100);
  assert.ok(life.height > h1);
  assert.ok(life.area > a1);
  assert.ok(Math.abs(life.height - heightAt(life.age, [
    { at: 0, slope: BASE_GAIN },
    { at: 100, slope: life.slope },
  ])) < 1e-6);
});

test('快进只能向前，到三万天结束', () => {
  const life = createLife({ bornAt: 0 });
  applyEffort(life);
  settle(life, 60);
  const backwards = fastForward(life, 0);
  assert.equal(backwards.ok, false);
  assert.equal(backwards.reason, 'backwards');

  const forward = fastForward(life, 10);
  assert.equal(forward.ok, true);
  assert.equal(life.day, 10);
  assert.ok(life.area > 0);

  const ending = fastForward(life, 30000);
  assert.equal(ending.ok, true);
  assert.equal(ending.ended, true);
  assert.equal(life.status, 'ended');
  assert.equal(life.endReason, 'lifespan');
  assert.equal(life.day, 30000);
});

test('自然时间超过寿命也会结束', () => {
  const life = createLife({ bornAt: 0 });
  applyEffort(life);
  settle(life, LIFETIME_SECONDS + 100);
  assert.equal(life.status, 'ended');
  assert.equal(life.age, LIFETIME_SECONDS);
  assert.equal(life.day, 30000);
});

test('努力指令从 10 键开始，每次成功加一键，且可复现', () => {
  assert.equal(effortLength(0), 10);
  assert.equal(effortLength(1), 11);
  assert.equal(effortLength(20), 30);
  assert.equal(effortLength(500), 510);
  const a = makeSequence(123, 4, effortLength(4));
  const b = makeSequence(123, 4, effortLength(4));
  assert.deepEqual(a, b);
  assert.equal(a.length, 14);
  assert.ok(a.every((key) => key >= 0 && key <= 3));
});

test('面积显示会从小数切换成整数/科学计数', () => {
  assert.equal(formatArea(0), '0');
  assert.match(formatArea(12.34), /12/);
  assert.match(formatArea(123456), /123,456/);
  assert.match(formatArea(1e9), /1,000,000,000/);
  assert.match(formatArea(1e16), /e/);
});
