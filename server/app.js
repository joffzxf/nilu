import {
  LIFE_ENGINE_VERSION,
  LIFETIME_DAYS,
  LIFETIME_SECONDS,
  applyEffort,
  createLife,
  effortLength,
  endLife,
  fastForward,
  makeSequence,
  settle,
} from '../assets/js/life.js';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomUint32() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] >>> 0;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, login: row.login, name: row.name || row.login, avatarUrl: row.avatarUrl || '' };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToLife(row) {
  return {
    bornAt: Number(row.birthAt),
    age: Number(row.age),
    day: Number(row.day),
    slope: Number(row.slope),
    height: Number(row.height),
    area: Number(row.area),
    efforts: Number(row.efforts),
    status: row.status,
    endReason: row.endReason || null,
    seed: Number(row.seed),
  };
}

function accountJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    birthAt: Number(row.birthAt),
    age: Number(row.age),
    day: Number(row.day),
    slope: Number(row.slope),
    height: Number(row.height),
    area: Number(row.area),
    efforts: Number(row.efforts),
    endReason: row.endReason || null,
    engineVersion: row.engineVersion,
  };
}

function summaryJson(row) {
  return {
    id: row.id,
    status: row.status,
    birthAt: Number(row.birthAt),
    endedAt: row.endedAt ? Number(row.endedAt) : null,
    endReason: row.endReason || null,
    day: Number(row.day),
    age: Number(row.age),
    area: Number(row.area),
    efforts: Number(row.efforts),
  };
}

function eventsJson(rows) {
  return rows.map((event) => ({
    type: event.type,
    at: Number(event.at),
    atMs: Number(event.atMs),
    slope: event.slope === null || event.slope === undefined ? null : Number(event.slope),
  }));
}

function isAllowedOrigin(origin, config) {
  if (!origin) return false;
  if (config.appOrigins.includes(origin)) return true;
  if (config.devAuth && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function safeReturnUrl(raw, config, fallbackOrigin) {
  const fallback = `${fallbackOrigin || config.appOrigins[0] || 'https://joffzxf.github.io'}/`;
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(config.devAuth && url.protocol === 'http:')) return fallback;
    if (!isAllowedOrigin(url.origin, config)) return fallback;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

async function readJson(request, maxBytes = 64 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) fail(413, 'body_too_large', '提交的内容太大了');
  let text = '';
  try {
    text = await request.text();
  } catch {
    fail(400, 'body_unreadable', '读不到请求内容');
  }
  if (text.length > maxBytes) fail(413, 'body_too_large', '提交的内容太大了');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    fail(400, 'bad_json', '请求内容不是合法的 JSON');
  }
}

function endedAtFor(row, life, now) {
  if (life.endReason === 'lifespan') return Number(row.birthAt) + LIFETIME_SECONDS * 1000;
  return now;
}

export function createApp({ store, config, fetchImpl = globalThis.fetch }) {
  if (!store) throw new Error('createApp: store is required');
  if (!config) throw new Error('createApp: config is required');

  const now = () => Number(config.now ? config.now() : Date.now());

  async function authenticate(request) {
    const header = request.headers.get('authorization') || '';
    const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header.trim());
    if (!match) return null;
    const tokenHash = await sha256(match[1]);
    const session = await store.getSession(tokenHash, now());
    if (!session) return null;
    return {
      tokenHash,
      user: {
        id: session.userId,
        login: session.login,
        name: session.name || session.login,
        avatarUrl: session.avatarUrl || '',
      },
    };
  }

  async function requireAuth(request) {
    const auth = await authenticate(request);
    if (!auth) fail(401, 'unauthorized', '请先登录');
    return auth;
  }

  async function createSessionFor(user, request) {
    const token = randomHex(32);
    const current = now();
    await store.createSession({
      tokenHash: await sha256(token),
      userId: user.id,
      createdAt: current,
      expiresAt: current + config.sessionTtlMs,
      userAgent: request.headers.get('user-agent') || '',
    });
    return token;
  }

  /**
   * 把离线期间的时间补上。
   * 乐观锁冲突就重读重算；多标签页也不会把时间算两遍。
   */
  async function settleAccount(userId, at = now()) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await store.getAliveAccount(userId);
      if (!row) return null;
      const life = rowToLife(row);
      const delta = Math.max(0, (at - Number(row.lastSettledAt)) / 1000);
      const wasAlive = life.status === 'alive';
      settle(life, delta);

      let endedAt = null;
      if (life.status === 'ended') endedAt = endedAtFor(row, life, at);
      const updated = {
        ...row,
        status: life.status,
        endedAt,
        endReason: life.endReason,
        lastSettledAt: at,
        age: life.age,
        day: life.day,
        slope: life.slope,
        height: life.height,
        area: life.area,
        efforts: life.efforts,
        updatedAt: at,
      };
      const ok = await store.updateAccount(updated);
      if (!ok) continue;

      if (wasAlive && life.status === 'ended') {
        await store.addEvent({
          accountId: row.id,
          type: 'end',
          atAge: life.age,
          atMs: at,
          slopeAfter: life.slope,
          payload: { reason: life.endReason },
        });
      }
      return store.getAccountById(row.id);
    }
    fail(409, 'account_busy', '这一生正在被另一个页面写入，请稍后再试');
  }

  async function accountPayload(userId, at = now()) {
    const row = await settleAccount(userId, at);
    if (!row) {
      const lastEnded = await store.getLastEnded(userId);
      return {
        account: null,
        events: [],
        serverNow: at,
        lastEnded: lastEnded ? {
          endedAt: Number(lastEnded.endedAt),
          endReason: lastEnded.endReason,
          area: Number(lastEnded.area),
          day: Number(lastEnded.day),
        } : null,
      };
    }
    return rowPayload(row, at);
  }

  async function rowPayload(row, at = now(), extra = {}) {
    if (!row) return { account: null, events: [], serverNow: at, ...extra };
    return {
      account: accountJson(row),
      events: eventsJson(await store.getEvents(row.id)),
      serverNow: at,
      ...extra,
    };
  }

  async function createAccount(auth, at = now()) {
    const existing = await settleAccount(auth.user.id, at);
    if (existing) return { account: existing };
    const recent = await store.countAccountsSince(auth.user.id, at - 60 * 60 * 1000);
    if (recent >= 10) fail(429, 'rate_limited', '这一小时开始得有点多，先让这一生走一会儿');

    const id = `a_${randomHex(12)}`;
    const seed = randomUint32();
    const row = {
      id,
      userId: auth.user.id,
      status: 'alive',
      birthAt: at,
      endedAt: null,
      endReason: null,
      lastSettledAt: at,
      age: 0,
      day: 0,
      slope: 0,
      height: 0,
      area: 0,
      efforts: 0,
      seed,
      engineVersion: LIFE_ENGINE_VERSION,
      version: 0,
      metaJson: '{}',
      createdAt: at,
      updatedAt: at,
    };
    try {
      await store.createAccount(row);
    } catch {
      const alive = await store.getAliveAccount(auth.user.id);
      if (alive) return { account: alive };
      throw new HttpError(409, 'account_conflict', '这一生刚刚被创建，请重试');
    }
    await store.addEvent({
      accountId: id,
      type: 'birth',
      atAge: 0,
      atMs: at,
      slopeAfter: 0,
      payload: null,
    });
    return { account: await store.getAccountById(id) };
  }

  async function startEffort(auth, at = now()) {
    const row = await settleAccount(auth.user.id, at);
    if (!row) fail(409, 'no_alive_account', '这一生已经结束了');
    if (row.status !== 'alive') fail(409, 'account_ended', '这一生已经结束了');
    const recent = await store.countEffortsSince(row.id, at - 60 * 60 * 1000);
    if (recent >= 240) fail(429, 'rate_limited', '这一小时努力得有点多，先歇一会儿');

    await store.abandonOpenEfforts(row.id, at);
    const length = effortLength(Number(row.efforts));
    const sequence = makeSequence(Number(row.seed), Number(row.efforts), length);
    const effortId = `e_${randomHex(12)}`;
    await store.createEffort({
      id: effortId,
      accountId: row.id,
      userId: auth.user.id,
      sequence,
      createdAt: at,
    });
    return {
      effortId,
      sequence,
      account: accountJson(row),
      events: eventsJson(await store.getEvents(row.id)),
      serverNow: at,
    };
  }

  async function completeEffort(auth, effortId, keys, at = now()) {
    const effort = await store.getEffort(effortId);
    if (!effort || effort.userId !== auth.user.id) fail(404, 'effort_not_found', '找不到这次努力');
    if (effort.status !== 'open') fail(409, 'effort_used', '这次努力已经结束了');

    if (!Array.isArray(keys) || keys.some((key) => !Number.isInteger(key) || key < 0 || key > 3)) {
      fail(400, 'bad_keys', '输入不合法');
    }

    const sequence = parseJsonArray(effort.sequenceJson);
    const correct = keys.length === sequence.length && sequence.every((key, index) => key === keys[index]);

    if (!correct) {
      await store.completeEffort({
        id: effortId,
        accountId: effort.accountId,
        status: 'failed',
        keys,
        now: at,
      });
      const row = await settleAccount(auth.user.id, at);
      return {
        ok: false,
        reason: 'wrong',
        account: row ? accountJson(row) : null,
        events: row ? eventsJson(await store.getEvents(row.id)) : [],
        serverNow: at,
      };
    }

    const claimed = await store.completeEffort({
      id: effortId,
      accountId: effort.accountId,
      status: 'done',
      keys,
      now: at,
    });
    if (!claimed) fail(409, 'effort_used', '这次努力已经结束了');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await settleAccount(auth.user.id, at);
      if (!row) fail(409, 'account_ended', '这一生已经结束了');
      if (row.status !== 'alive') {
        return {
          ok: false,
          reason: 'ended',
          account: accountJson(row),
          events: eventsJson(await store.getEvents(row.id)),
          serverNow: at,
        };
      }
      const life = rowToLife(row);
      const gain = applyEffort(life);
      const updated = {
        ...row,
        slope: life.slope,
        efforts: life.efforts,
        updatedAt: at,
      };
      const ok = await store.updateAccount(updated);
      if (!ok) continue;

      await store.addEvent({
        accountId: row.id,
        type: 'effort',
        atAge: life.age,
        atMs: at,
        slopeAfter: life.slope,
        payload: { effortId, length: sequence.length },
      });
      return {
        ok: true,
        gain,
        account: accountJson(await store.getAccountById(row.id)),
        events: eventsJson(await store.getEvents(row.id)),
        serverNow: at,
      };
    }
    fail(409, 'account_busy', '这一生正在被另一个页面写入，请稍后再试');
  }

  async function fastForwardAccount(auth, targetDay, at = now()) {
    const target = Number(targetDay);
    if (!Number.isInteger(target) || target < 0 || target > LIFETIME_DAYS) {
      fail(400, 'bad_target', '只能快进到 0 到 30000 天');
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await settleAccount(auth.user.id, at);
      if (!row) fail(409, 'no_alive_account', '这一生已经结束了');
      if (row.status !== 'alive') return rowPayload(row, at, { ended: true });
      if (target < Number(row.day) - 1e-9) fail(400, 'backwards', '只能向前');

      const life = rowToLife(row);
      const result = fastForward(life, target);
      if (!result.ok) fail(400, 'bad_target', '只能向前');

      const endedAt = life.status === 'ended' ? endedAtFor(row, life, at) : null;
      const updated = {
        ...row,
        status: life.status,
        endedAt,
        endReason: life.endReason,
        lastSettledAt: at,
        age: life.age,
        day: life.day,
        slope: life.slope,
        height: life.height,
        area: life.area,
        efforts: life.efforts,
        updatedAt: at,
      };
      if (await store.updateAccount(updated)) {
        await store.addEvent({
          accountId: row.id,
          type: 'fast_forward',
          atAge: life.age,
          atMs: at,
          slopeAfter: life.slope,
          payload: { targetDay: target, ended: life.status === 'ended' },
        });
        if (life.status === 'ended') {
          await store.addEvent({
            accountId: row.id,
            type: 'end',
            atAge: life.age,
            atMs: at,
            slopeAfter: life.slope,
            payload: { reason: life.endReason },
          });
        }
        return rowPayload(await store.getAccountById(row.id), at, { ended: life.status === 'ended' });
      }
    }
    fail(409, 'account_busy', '这一生正在被另一个页面写入，请稍后再试');
  }

  async function endAccount(auth, at = now()) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await settleAccount(auth.user.id, at);
      if (!row) fail(409, 'no_alive_account', '这一生已经结束了');
      if (row.status !== 'alive') return rowPayload(row, at, { ended: true });
      const life = rowToLife(row);
      endLife(life, 'manual');
      const updated = {
        ...row,
        status: 'ended',
        endedAt: at,
        endReason: 'manual',
        lastSettledAt: at,
        updatedAt: at,
      };
      if (await store.updateAccount(updated)) {
        await store.addEvent({
          accountId: row.id,
          type: 'end',
          atAge: life.age,
          atMs: at,
          slopeAfter: life.slope,
          payload: { reason: 'manual' },
        });
        return rowPayload(await store.getAccountById(row.id), at, { ended: true });
      }
    }
    fail(409, 'account_busy', '这一生正在被另一个页面写入，请稍后再试');
  }

  async function githubStart(request) {
    if (!config.githubClientId || !config.githubClientSecret) {
      fail(503, 'oauth_not_configured', 'GitHub 登录尚未配置');
    }
    const url = new URL(request.url);
    const nonce = String(url.searchParams.get('nonce') || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) fail(400, 'bad_nonce', '登录会话不合法');
    const fallbackOrigin = config.apiOrigin ? config.appOrigins[0] : new URL(request.url).origin;
    const returnUrl = safeReturnUrl(url.searchParams.get('return'), config, fallbackOrigin);
    const stateValue = randomHex(24);
    const current = now();
    await store.cleanup(current);
    await store.createLoginState({
      state: stateValue,
      nonce,
      returnUrl,
      createdAt: current,
      expiresAt: current + 10 * 60 * 1000,
    });

    const origin = config.apiOrigin || new URL(request.url).origin;
    const redirectUri = config.githubCallbackUrl || `${origin}/api/auth/github/callback`;
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', config.githubClientId);
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('scope', 'read:user');
    target.searchParams.set('state', stateValue);
    target.searchParams.set('allow_signup', 'true');
    return redirect(target.toString());
  }

  async function githubCallback(request) {
    const url = new URL(request.url);
    const stateValue = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const defaultReturn = `${config.appOrigins[0] || 'https://joffzxf.github.io'}/`;
    const stateRow = stateValue ? await store.consumeLoginState(stateValue, now()) : null;
    const returnUrl = stateRow?.returnUrl || defaultReturn;
    const nonce = stateRow?.nonce || '';
    const failRedirect = (reason) => {
      const target = new URL(returnUrl);
      target.hash = `login_error=${encodeURIComponent(reason)}`;
      return redirect(target.toString());
    };

    if (!stateRow) return failRedirect('登录会话已过期');
    if (!code) return failRedirect('GitHub 没有返回授权码');
    if (!config.githubClientId || !config.githubClientSecret) return failRedirect('GitHub 登录尚未配置');

    try {
      const origin = config.apiOrigin || new URL(request.url).origin;
      const redirectUri = config.githubCallbackUrl || `${origin}/api/auth/github/callback`;
      const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'nilu-game',
        },
        body: new URLSearchParams({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      const tokenData = await tokenResponse.json().catch(() => null);
      if (!tokenData?.access_token) return failRedirect(`GitHub 授权失败：${tokenData?.error || '未知原因'}`);

      const userResponse = await fetchImpl('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nilu-game',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!userResponse.ok) return failRedirect(`GitHub 用户信息读取失败（${userResponse.status}）`);
      const profile = await userResponse.json();
      if (!profile || !Number.isInteger(profile.id) || !profile.login) return failRedirect('GitHub 返回了不完整的用户信息');

      const user = await store.upsertUser({
        githubId: profile.id,
        login: String(profile.login),
        name: profile.name ? String(profile.name) : '',
        avatarUrl: profile.avatar_url ? String(profile.avatar_url) : '',
        now: now(),
      });

      const loginCode = randomHex(24);
      await store.createLoginCode({
        codeHash: await sha256(loginCode),
        userId: user.id,
        createdAt: now(),
        expiresAt: now() + 2 * 60 * 1000,
      });
      const target = new URL(returnUrl);
      target.hash = `login=${loginCode}&nonce=${encodeURIComponent(nonce)}`;
      return redirect(target.toString());
    } catch (error) {
      console.error('github oauth callback failed', error);
      return failRedirect('登录过程中出了点问题');
    }
  }

  async function exchangeLoginCode(request) {
    const body = await readJson(request);
    const code = String(body.code || '');
    if (!/^[a-f0-9]{48}$/i.test(code)) fail(401, 'login_code_invalid', '登录码无效');
    const consumed = await store.consumeLoginCode(await sha256(code), now());
    if (!consumed) fail(401, 'login_code_invalid', '登录码已过期或已使用');
    const user = await store.getUserById(consumed.userId);
    if (!user) fail(401, 'login_code_invalid', '账号不存在');
    const token = await createSessionFor(user, request);
    return json({ token, user: publicUser(user) });
  }

  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204 });

    if (path === '/api/health' && method === 'GET') {
      return json({
        ok: true,
        service: 'nilu',
        engineVersion: LIFE_ENGINE_VERSION,
        schemaVersion: 2,
        lifetimeDays: LIFETIME_DAYS,
        daySeconds: 86400,
        githubOAuth: Boolean(config.githubClientId && config.githubClientSecret),
        devAuth: Boolean(config.devAuth),
        features: ['account', 'effort', 'fastForward', 'end', 'multiAccount', 'events'],
        now: now(),
      });
    }

    if (path === '/api/dev/login' && method === 'POST') {
      if (!config.devAuth) fail(404, 'not_found', '没有这个接口');
      const body = await readJson(request);
      const raw = String(body.login || '本地行人').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || '本地行人';
      const display = String(body.name || `本地测试 · ${raw}`).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30) || `本地测试 · ${raw}`;
      const githubId = -((fnv1a(raw) % 2000000000) + 1);
      const user = await store.upsertUser({
        githubId,
        login: `dev-${raw}`,
        name: display,
        avatarUrl: '',
        now: now(),
      });
      const token = await createSessionFor(user, request);
      return json({ token, user: publicUser(user), dev: true });
    }

    if (path === '/api/auth/github/start' && method === 'GET') return githubStart(request);
    if (path === '/api/auth/github/callback' && method === 'GET') return githubCallback(request);
    if (path === '/api/auth/exchange' && method === 'POST') return exchangeLoginCode(request);

    if (path === '/api/account' && method === 'GET') {
      const auth = await requireAuth(request);
      return json(await accountPayload(auth.user.id));
    }

    if (path === '/api/account' && method === 'POST') {
      const auth = await requireAuth(request);
      const created = await createAccount(auth, now());
      return json(await accountPayload(auth.user.id));
    }

    if (path === '/api/accounts' && method === 'GET') {
      const auth = await requireAuth(request);
      const rows = await store.listAccounts(auth.user.id);
      return json({
        accounts: rows.map(summaryJson),
        serverNow: now(),
      });
    }

    if (path === '/api/account/efforts' && method === 'POST') {
      const auth = await requireAuth(request);
      return json(await startEffort(auth, now()));
    }

    const effortMatch = /^\/api\/account\/efforts\/([A-Za-z0-9_]+)\/complete$/.exec(path);
    if (effortMatch && method === 'POST') {
      const auth = await requireAuth(request);
      const body = await readJson(request);
      return json(await completeEffort(auth, effortMatch[1], body.keys, now()));
    }

    if (path === '/api/account/fast-forward' && method === 'POST') {
      const auth = await requireAuth(request);
      const body = await readJson(request);
      return json(await fastForwardAccount(auth, body.targetDay, now()));
    }

    if (path === '/api/account/end' && method === 'POST') {
      const auth = await requireAuth(request);
      const body = await readJson(request);
      if (body.confirm !== true) fail(400, 'confirm_required', '需要确认');
      return json(await endAccount(auth, now()));
    }

    if (path === '/api/account/events' && method === 'GET') {
      const auth = await requireAuth(request);
      const row = await settleAccount(auth.user.id, now());
      if (!row) fail(404, 'no_alive_account', '这一生已经结束了');
      return json({ events: eventsJson(await store.getEvents(row.id)) });
    }

    if (path === '/api/me' && method === 'GET') {
      const auth = await requireAuth(request);
      const alive = await store.getAliveAccount(auth.user.id);
      const accounts = await store.listAccounts(auth.user.id);
      return json({
        user: auth.user,
        alive: alive ? summaryJson(alive) : null,
        accounts: accounts.map(summaryJson),
        serverNow: now(),
      });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const auth = await authenticate(request);
      if (auth) await store.deleteSession(auth.tokenHash);
      return json({ ok: true });
    }

    fail(404, 'not_found', '没有这个接口');
  }

  return {
    async fetch(request) {
      let response;
      try {
        response = await handle(request);
      } catch (error) {
        if (error instanceof HttpError) {
          response = json({ error: error.code, message: error.message }, error.status);
        } else {
          console.error('nilu api error', error);
          response = json({ error: 'internal_error', message: '服务器开了个小差，请稍后再试' }, 500);
        }
      }

      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
      headers.set('Vary', 'Origin');
      const origin = request.headers.get('origin');
      if (origin && isAllowedOrigin(origin, config)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Max-Age', '600');
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
