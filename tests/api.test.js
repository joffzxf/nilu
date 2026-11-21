import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSqliteDriver } from '../server/driver-sqlite.js';
import { createSqlStore } from '../server/store-sql.js';
import { createApp } from '../server/app.js';
import { advance, createRun, getResult } from '../assets/js/engine.js';

const schema = await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');

function perfectInputs(seed, durationTicks, reaction = 6, typing = 3) {
  const run = createRun({ seed, durationTicks });
  const inputs = [];
  let due = null;
  while (run.status === 'running') {
    if (!run.prompt) due = null;
    else if (due === null) due = run.tick + reaction;
    let batch = [];
    if (run.prompt && due !== null && run.tick >= due) {
      const key = run.prompt.seq[run.prompt.index];
      batch = [key];
      inputs.push({ t: run.tick, k: key });
      due = run.prompt.index + 1 >= run.prompt.seq.length ? null : run.tick + typing;
    }
    advance(run, batch);
  }
  return { inputs, result: getResult(run) };
}

async function setup(overrides = {}) {
  const driver = createSqliteDriver(':memory:');
  const store = createSqlStore(driver);
  await store.init(schema);
  let clock = 1_800_000_000_000;
  const config = {
    appOrigins: ['http://localhost:3000'],
    githubClientId: '',
    githubClientSecret: '',
    githubCallbackUrl: '',
    apiOrigin: 'http://api.local',
    devAuth: true,
    durationTicks: 600,
    minRunRatio: 0,
    sessionTtlMs: 1000 * 60 * 60,
    challengeTtlMs: 1000 * 60 * 10,
    now: () => clock,
    ...overrides,
  };
  const app = createApp({ store, config });
  const call = async (path, { method = 'GET', token, body, origin = 'http://localhost:3000' } = {}) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.fetch(new Request(`http://api.local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, headers: response.headers };
  };
  const login = async (name) => {
    const response = await call('/api/dev/login', { method: 'POST', body: { login: name } });
    assert.equal(response.status, 200);
    return response.json;
  };
  const challenge = async (token) => {
    const response = await call('/api/challenges', { method: 'POST', token, body: {} });
    assert.equal(response.status, 200);
    return response.json;
  };
  const advanceClock = (ms) => { clock += ms; };
  return { driver, store, app, config, call, login, challenge, advanceClock };
}

test('健康检查与 CORS 预检', async () => {
  const { call } = await setup();
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:3000');

  const preflight = await call('/api/health', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
});

test('未登录不能领凭证，无效令牌被拒绝', async () => {
  const { call } = await setup();
  const anonymous = await call('/api/challenges', { method: 'POST', body: {} });
  assert.equal(anonymous.status, 401);
  const badToken = await call('/api/challenges', { method: 'POST', token: 'a'.repeat(64), body: {} });
  assert.equal(badToken.status, 401);
});

test('本地测试登录 -> 领凭证 -> 回放复核 -> 上榜', async () => {
  const { call, login, challenge } = await setup();
  const session = await login('测试甲');
  assert.equal(session.user.login, 'dev-测试甲');

  const ch = await challenge(session.token);
  assert.equal(ch.durationTicks, 600);
  assert.equal(ch.engineVersion, '1.0.0');

  const { inputs, result } = perfectInputs(ch.seed, ch.durationTicks);
  assert.ok(result.successes > 0);
  const submit = await call('/api/runs', {
    method: 'POST',
    token: session.token,
    body: { challengeId: ch.id, inputs },
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.json.run.score, result.score);
  assert.equal(submit.json.duplicate, false);
  assert.equal(submit.json.rank, 1);
  assert.equal(submit.json.run.successes, result.successes);
  assert.ok(Array.isArray(submit.json.run.curve));

  const replayed = await call('/api/runs', {
    method: 'POST',
    token: session.token,
    body: { challengeId: ch.id, inputs },
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.json.duplicate, true);
  assert.equal(replayed.json.run.id, submit.json.run.id);
  assert.equal(replayed.json.run.score, submit.json.run.score);

  const board = await call('/api/leaderboard?scope=all');
  assert.equal(board.status, 200);
  assert.equal(board.json.total, 1);
  assert.equal(board.json.entries.length, 1);
  assert.equal(board.json.entries[0].login, 'dev-测试甲');
  assert.equal(board.json.entries[0].score, result.score);
});

test('所有账户都在榜上，包括还没走的人；排序按最好成绩', async () => {
  const { call, login, challenge } = await setup();
  const a = await login('甲');
  const b = await login('乙');
  await login('丙');

  const chA = await challenge(a.token);
  const fast = perfectInputs(chA.seed, chA.durationTicks, 4, 2);
  await call('/api/runs', { method: 'POST', token: a.token, body: { challengeId: chA.id, inputs: fast.inputs } });

  const chB = await challenge(b.token);
  const slow = perfectInputs(chB.seed, chB.durationTicks, 24, 14);
  const slowResult = await call('/api/runs', {
    method: 'POST', token: b.token, body: { challengeId: chB.id, inputs: slow.inputs },
  });
  assert.equal(slowResult.status, 200);

  const board = await call('/api/leaderboard?scope=all');
  assert.equal(board.status, 200);
  assert.equal(board.json.total, 3);
  assert.equal(board.json.entries.length, 3);
  assert.equal(board.json.entries[0].login, 'dev-甲');
  assert.ok(board.json.entries[0].score > board.json.entries[1].score);
  assert.equal(board.json.entries[2].login, 'dev-丙');
  assert.equal(board.json.entries[2].score, 0);
  assert.equal(board.json.entries[2].hasRun, false);
});

test('复核按服务器回放为准，非法输入被拒绝', async () => {
  const { call, login, challenge } = await setup();
  const session = await login('回放');
  const ch = await challenge(session.token);

  const duplicatedTick = await call('/api/runs', {
    method: 'POST',
    token: session.token,
    body: { challengeId: ch.id, inputs: [{ t: 1, k: 0 }, { t: 1, k: 1 }] },
  });
  assert.equal(duplicatedTick.status, 400);

  const outOfRange = await call('/api/runs', {
    method: 'POST',
    token: session.token,
    body: { challengeId: ch.id, inputs: [{ t: 9999, k: 0 }] },
  });
  assert.equal(outOfRange.status, 400);

  const wrongKey = await call('/api/runs', {
    method: 'POST',
    token: session.token,
    body: { challengeId: ch.id, inputs: [{ t: 50, k: 3 }, { t: 60, k: 3 }] },
  });
  assert.equal(wrongKey.status, 200);
  assert.ok(wrongKey.json.run.score >= 0);
});

test('凭证过期后不能提交', async () => {
  const { call, login, challenge, advanceClock, config } = await setup();
  const session = await login('过期');
  const ch = await challenge(session.token);
  advanceClock(config.challengeTtlMs + 1);
  const submit = await call('/api/runs', {
    method: 'POST', token: session.token, body: { challengeId: ch.id, inputs: [] },
  });
  assert.equal(submit.status, 410);
  assert.equal(submit.json.error, 'challenge_expired');
});

test('别人的凭证不能提交', async () => {
  const { call, login, challenge } = await setup();
  const a = await login('甲');
  const b = await login('乙');
  const ch = await challenge(a.token);
  const submit = await call('/api/runs', {
    method: 'POST', token: b.token, body: { challengeId: ch.id, inputs: [] },
  });
  assert.equal(submit.status, 403);
});

test('本周榜、我的记录与轨迹详情', async () => {
  const { call, login, challenge } = await setup();
  const session = await login('周榜');
  const ch = await challenge(session.token);
  const { inputs, result } = perfectInputs(ch.seed, ch.durationTicks);
  const submit = await call('/api/runs', {
    method: 'POST', token: session.token, body: { challengeId: ch.id, inputs },
  });
  assert.equal(submit.status, 200);

  const week = await call('/api/leaderboard?scope=week', { token: session.token });
  assert.equal(week.status, 200);
  assert.equal(week.json.entries[0].score, result.score);
  assert.equal(week.json.me.rank, 1);

  const mine = await call('/api/me/runs', { token: session.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.entries.length, 1);
  assert.equal(mine.json.entries[0].score, result.score);

  const detail = await call(`/api/runs/${submit.json.run.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.login, 'dev-周榜');
  assert.equal(detail.json.run.score, result.score);
});

test('未配置 GitHub OAuth 时开始登录返回 503', async () => {
  const { call } = await setup();
  const response = await call('/api/auth/github/start?nonce=abcdefgh&return=http%3A%2F%2Flocalhost%3A3000%2F');
  assert.equal(response.status, 503);
  assert.equal(response.json.error, 'oauth_not_configured');
});

test('开放重定向被拦截：return 只能回到允许的来源', async () => {
  const { call, store, config } = await setup({
    githubClientId: 'client-id',
    githubClientSecret: 'client-secret',
  });
  const response = await call('/api/auth/github/start?nonce=abcdefgh&return=https%3A%2F%2Fevil.example%2Fsteal');
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.ok(location.startsWith('https://github.com/login/oauth/authorize'));
  const state = new URL(location).searchParams.get('state');
  const saved = await store.consumeLoginState(state, config.now());
  assert.equal(saved.returnUrl, `${config.appOrigins[0]}/`);
});
