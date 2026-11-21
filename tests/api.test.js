import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSqliteDriver } from '../server/driver-sqlite.js';
import { createSqlStore } from '../server/store-sql.js';
import { createApp } from '../server/app.js';
import { BASE_GAIN } from '../assets/js/life.js';

const schema = await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');

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
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
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
  const createAccount = async (token) => {
    const response = await call('/api/account', { method: 'POST', token, body: {} });
    assert.equal(response.status, 200);
    return response.json;
  };
  const advance = (seconds) => { clock += seconds * 1000; };
  return { store, app, config, call, login, createAccount, advance };
}

test('健康检查、CORS 预检', async () => {
  const { call } = await setup();
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.lifetimeDays, 30000);
  assert.ok(health.json.features.includes('fastForward'));
  assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:3000');

  const preflight = await call('/api/health', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
});

test('未登录不能创建或读取这一生', async () => {
  const { call } = await setup();
  const created = await call('/api/account', { method: 'POST', body: {} });
  assert.equal(created.status, 401);
  const read = await call('/api/account');
  assert.equal(read.status, 401);
});

test('创建一生；同一时间只有一个还活着的一生', async () => {
  const { call, login, createAccount } = await setup();
  const session = await login('甲');
  const first = await createAccount(session.token);
  assert.equal(first.account.status, 'alive');
  assert.equal(first.account.age, 0);
  assert.equal(first.account.area, 0);
  const second = await createAccount(session.token);
  assert.equal(second.account.id, first.account.id);

  const read = await call('/api/account', { token: session.token });
  assert.equal(read.status, 200);
  assert.equal(read.json.account.id, first.account.id);
  assert.deepEqual(read.json.events.map((event) => event.type), ['birth']);
});

test('离线的时间会补上；一次努力抬高斜率，面积继续增长', async () => {
  const { call, login, createAccount, advance } = await setup();
  const session = await login('乙');
  const created = await createAccount(session.token);
  const start = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  assert.equal(start.status, 200);
  assert.ok(Array.isArray(start.json.sequence));
  assert.equal(start.json.sequence.length, 10);

  const complete = await call(`/api/account/efforts/${start.json.effortId}/complete`, {
    method: 'POST',
    token: session.token,
    body: { keys: start.json.sequence },
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.json.ok, true);
  assert.ok(complete.json.account.slope > 0);
  assert.ok(Math.abs(complete.json.account.slope - BASE_GAIN) < 1e-12);

  advance(3600);
  const read = await call('/api/account', { token: session.token });
  assert.equal(read.status, 200);
  assert.equal(read.json.account.age, 3600);
  const expected = 0.5 * BASE_GAIN * 3600 * 3600;
  assert.ok(Math.abs(read.json.account.area - expected) < 0.01);
  assert.ok(read.json.events.some((event) => event.type === 'effort'));
  assert.equal(created.account.id, read.json.account.id);
});

test('努力没有时间限制；输错了重新点，斜率不变', async () => {
  const { call, login, createAccount, advance } = await setup();
  const session = await login('丙');
  await createAccount(session.token);

  const start = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  advance(86400);
  const complete = await call(`/api/account/efforts/${start.json.effortId}/complete`, {
    method: 'POST',
    token: session.token,
    body: { keys: start.json.sequence },
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.json.ok, true);
  assert.ok(complete.json.account.age >= 86400);

  const wrongStart = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  const wrongKeys = [(wrongStart.json.sequence[0] + 1) % 4];
  const wrong = await call(`/api/account/efforts/${wrongStart.json.effortId}/complete`, {
    method: 'POST',
    token: session.token,
    body: { keys: wrongKeys },
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.json.ok, false);
  assert.equal(wrong.json.reason, 'wrong');
  assert.ok(Math.abs(wrong.json.account.slope - complete.json.account.slope) < 1e-12);

  const again = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  assert.equal(again.status, 200);
});

test('快进只能向前；到三万天这一生注销，不能再用', async () => {
  const { call, login, createAccount } = await setup();
  const session = await login('丁');
  await createAccount(session.token);
  const start = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  await call(`/api/account/efforts/${start.json.effortId}/complete`, {
    method: 'POST', token: session.token, body: { keys: start.json.sequence },
  });

  const forward = await call('/api/account/fast-forward', {
    method: 'POST', token: session.token, body: { targetDay: 10 },
  });
  assert.equal(forward.status, 200);
  assert.equal(forward.json.account.day, 10);
  assert.ok(forward.json.account.area > 0);

  const backwards = await call('/api/account/fast-forward', {
    method: 'POST', token: session.token, body: { targetDay: 5 },
  });
  assert.equal(backwards.status, 400);
  assert.equal(backwards.json.error, 'backwards');

  const ending = await call('/api/account/fast-forward', {
    method: 'POST', token: session.token, body: { targetDay: 30000 },
  });
  assert.equal(ending.status, 200);
  assert.equal(ending.json.account.status, 'ended');
  assert.equal(ending.json.account.endReason, 'lifespan');

  const after = await call('/api/account', { token: session.token });
  assert.equal(after.status, 200);
  assert.equal(after.json.account, null);
  assert.equal(after.json.lastEnded.endReason, 'lifespan');

  const effortAfter = await call('/api/account/efforts', { method: 'POST', token: session.token, body: {} });
  assert.equal(effortAfter.status, 409);

  const reborn = await call('/api/account', { method: 'POST', token: session.token, body: {} });
  assert.equal(reborn.status, 200);
  assert.notEqual(reborn.json.account.id, ending.json.account.id);

  const accounts = await call('/api/accounts', { token: session.token });
  assert.equal(accounts.json.accounts.length, 2);
  assert.equal(accounts.json.accounts.filter((account) => account.status === 'alive').length, 1);
});

test('结束需要确认；结束后可以开始下一生', async () => {
  const { call, login, createAccount } = await setup();
  const session = await login('戊');
  const first = await createAccount(session.token);

  const noConfirm = await call('/api/account/end', { method: 'POST', token: session.token, body: {} });
  assert.equal(noConfirm.status, 400);

  const ended = await call('/api/account/end', {
    method: 'POST', token: session.token, body: { confirm: true },
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.json.account.status, 'ended');
  assert.equal(ended.json.account.endReason, 'manual');

  const after = await call('/api/account', { token: session.token });
  assert.equal(after.json.account, null);
  const again = await call('/api/account/end', {
    method: 'POST', token: session.token, body: { confirm: true },
  });
  assert.equal(again.status, 409);

  const next = await call('/api/account', { method: 'POST', token: session.token, body: {} });
  assert.equal(next.status, 200);
  assert.equal(next.json.account.status, 'alive');
  assert.notEqual(next.json.account.id, first.account.id);
});

test('别人的努力不能提交', async () => {
  const { call, login, createAccount } = await setup();
  const a = await login('甲');
  const b = await login('乙');
  await createAccount(a.token);
  const start = await call('/api/account/efforts', { method: 'POST', token: a.token, body: {} });
  const stolen = await call(`/api/account/efforts/${start.json.effortId}/complete`, {
    method: 'POST', token: b.token, body: { keys: start.json.sequence },
  });
  assert.equal(stolen.status, 404);
});

test('未配置 GitHub OAuth 时开始登录返回 503', async () => {
  const { call } = await setup();
  const response = await call('/api/auth/github/start?nonce=abcdefgh&return=http%3A%2F%2Flocalhost%3A3000%2F');
  assert.equal(response.status, 503);
  assert.equal(response.json.error, 'oauth_not_configured');
});

test('OAuth 的 return URL 不能跳出白名单', async () => {
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

test('我的账户列表返回这一生与过去的一生', async () => {
  const { call, login, createAccount } = await setup();
  const session = await login('己');
  await createAccount(session.token);
  const me = await call('/api/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.login, 'dev-己');
  assert.equal(me.json.alive.status, 'alive');
  assert.equal(me.json.accounts.length, 1);
});
