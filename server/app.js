import {
  ENGINE_VERSION,
  getResult,
  simulate,
  validateInputs,
} from '../assets/js/engine.js';

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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
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
  return {
    id: row.id,
    login: row.login,
    name: row.name || row.login,
    avatarUrl: row.avatarUrl || '',
  };
}

function parseCurve(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => Number.isFinite(Number(item)))
      .slice(0, 240)
      .map((item) => Math.round(Number(item) * 100) / 100);
  } catch {
    return [];
  }
}

function runJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    score: Number(row.score || 0),
    area: Number(row.area || 0),
    maxSlope: Number(row.maxSlope || 0),
    successes: Number(row.successes || 0),
    misses: Number(row.misses || 0),
    maxCombo: Number(row.maxCombo || 0),
    durationTicks: Number(row.durationTicks || 0),
    createdAt: Number(row.createdAt || 0),
    curve: parseCurve(row.curveJson),
  };
}

function bestJson(row) {
  const run = runJson(row);
  if (!run) return null;
  return {
    score: run.score,
    maxSlope: run.maxSlope,
    successes: run.successes,
    misses: run.misses,
    maxCombo: run.maxCombo,
    createdAt: run.createdAt,
    curve: run.curve,
  };
}

function startOfWeekShanghai(timestamp) {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(timestamp + offset);
  local.setUTCHours(0, 0, 0, 0);
  const day = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - day);
  return local.getTime() - offset;
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
    const createdAt = now();
    await store.createSession({
      tokenHash: await sha256(token),
      userId: user.id,
      createdAt,
      expiresAt: createdAt + config.sessionTtlMs,
      userAgent: request.headers.get('user-agent') || '',
    });
    return token;
  }

  async function challengeResponse(auth, body, request) {
    const current = now();
    const recent = await store.countChallengesSince(auth.user.id, current - 60 * 60 * 1000);
    if (recent >= 120) fail(429, 'rate_limited', '这一小时走得有点多，歇一会儿再来');
    await store.cleanup(current);
    await store.invalidateOpenChallenges(auth.user.id, current);

    const id = `c_${randomHex(16)}`;
    const seed = randomUint32();
    const durationTicks = config.durationTicks;
    const expiresAt = current + config.challengeTtlMs;
    await store.createChallenge({
      id,
      userId: auth.user.id,
      seed,
      durationTicks,
      engineVersion: ENGINE_VERSION,
      createdAt: current,
      expiresAt,
    });
    return json({
      id,
      seed,
      durationTicks,
      engineVersion: ENGINE_VERSION,
      expiresAt,
    });
  }

  async function submitRun(auth, request) {
    const body = await readJson(request, 256 * 1024);
    const challengeId = String(body.challengeId || '');
    if (!challengeId || challengeId.length > 80) fail(400, 'bad_challenge', '缺少有效的这一程');
    const current = now();
    const recent = await store.countRunsSince(auth.user.id, current - 60 * 60 * 1000);
    if (recent >= 40) fail(429, 'rate_limited', '这一小时走得有点多，歇一会儿再来');

    const challenge = await store.getChallenge(challengeId);
    if (!challenge) fail(404, 'challenge_not_found', '找不到这一程的凭证');
    if (challenge.userId !== auth.user.id) fail(403, 'challenge_forbidden', '这一程不属于当前账号');

    if (challenge.usedAt) {
      const existing = await store.getRunByChallenge(challengeId);
      if (existing) return json(await runResultPayload(existing, auth, true));
      fail(409, 'challenge_used', '这一程已经提交过了');
    }
    if (challenge.expiresAt <= current) fail(410, 'challenge_expired', '这一程的复核凭证已过期');
    if (challenge.engineVersion !== ENGINE_VERSION) {
      fail(409, 'engine_mismatch', '这一程由旧版本引擎生成，无法复核');
    }

    const minMs = (challenge.durationTicks / 60) * 1000 * config.minRunRatio;
    if (current - challenge.createdAt < minMs) {
      fail(409, 'too_fast', '这一程走得太快了，无法复核');
    }

    const validation = validateInputs(body.inputs, challenge.durationTicks);
    if (!validation.ok) fail(400, validation.error, '输入记录不合法');

    const simulated = simulate({
      seed: challenge.seed,
      durationTicks: challenge.durationTicks,
      inputs: body.inputs,
    });
    const result = getResult(simulated);

    const row = {
      id: `r_${randomHex(12)}`,
      challengeId,
      userId: auth.user.id,
      score: result.score,
      area: result.area,
      maxSlope: result.slope,
      successes: result.successes,
      misses: result.misses,
      maxCombo: result.maxCombo,
      durationTicks: challenge.durationTicks,
      engineVersion: ENGINE_VERSION,
      inputs: body.inputs,
      curve: result.curve,
      createdAt: current,
    };

    try {
      await store.insertRun(row);
    } catch (error) {
      const existing = await store.getRunByChallenge(challengeId);
      if (existing) return json(await runResultPayload(existing, auth, true));
      throw error;
    }
    await store.markChallengeUsed(challengeId, current);

    const inserted = await store.getRunByChallenge(challengeId);
    return json(await runResultPayload(inserted || row, auth, false));
  }

  async function runResultPayload(row, auth, duplicate) {
    const totalAccounts = await store.countUsers();
    const best = await store.getUserBest(auth.user.id);
    const rank = await store.getRank(auth.user.id, null);
    return {
      run: runJson(row),
      rank,
      personalBest: best ? Number(best.score) : Number(row.score || 0),
      totalAccounts,
      duplicate: Boolean(duplicate),
    };
  }

  async function leaderboard(request) {
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope') || 'all';
    if (!['all', 'week'].includes(scope)) fail(400, 'bad_scope', '榜单范围不对');
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit'), 10) || 50));
    const offset = Math.max(0, Math.min(10000, Number.parseInt(url.searchParams.get('offset'), 10) || 0));
    const current = now();
    const since = scope === 'week' ? startOfWeekShanghai(current) : null;
    const rows = await store.getLeaderboard({ since, limit, offset });
    const entries = rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: row.userId,
      login: row.login,
      name: row.name || row.login,
      avatarUrl: row.avatarUrl || '',
      score: Number(row.score || 0),
      maxSlope: Number(row.maxSlope || 0),
      successes: Number(row.successes || 0),
      misses: Number(row.misses || 0),
      maxCombo: Number(row.maxCombo || 0),
      createdAt: row.createdAt ? Number(row.createdAt) : null,
      curve: parseCurve(row.curveJson),
      hasRun: Boolean(row.runId),
    }));

    const auth = await authenticate(request);
    let me = null;
    if (auth) {
      const bestScore = await store.getBestScore(auth.user.id, since);
      const rank = await store.getRank(auth.user.id, since);
      me = {
        rank,
        score: bestScore === null ? 0 : bestScore,
        hasRun: bestScore !== null,
      };
    }

    return json({
      scope,
      total: await store.countUsers(),
      entries,
      me,
    });
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
    const state = randomHex(24);
    const current = now();
    await store.cleanup(current);
    await store.createLoginState({
      state,
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
    target.searchParams.set('state', state);
    target.searchParams.set('allow_signup', 'true');
    return redirect(target.toString());
  }

  async function githubCallback(request) {
    const url = new URL(request.url);
    const state = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const defaultReturn = `${config.appOrigins[0] || 'https://joffzxf.github.io'}/`;
    const stateRow = state ? await store.consumeLoginState(state, now()) : null;
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
        engineVersion: ENGINE_VERSION,
        githubOAuth: Boolean(config.githubClientId && config.githubClientSecret),
        devAuth: Boolean(config.devAuth),
        durationTicks: config.durationTicks,
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

    if (path === '/api/challenges' && method === 'POST') {
      const auth = await requireAuth(request);
      return challengeResponse(auth, {}, request);
    }

    if (path === '/api/runs' && method === 'POST') {
      const auth = await requireAuth(request);
      return submitRun(auth, request);
    }

    if (path === '/api/leaderboard' && method === 'GET') return leaderboard(request);

    if (path === '/api/me' && method === 'GET') {
      const auth = await requireAuth(request);
      const best = await store.getUserBest(auth.user.id);
      return json({
        user: auth.user,
        best: bestJson(best),
        rank: await store.getRank(auth.user.id, null),
        totalAccounts: await store.countUsers(),
      });
    }

    if (path === '/api/me/runs' && method === 'GET') {
      const auth = await requireAuth(request);
      const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit'), 10) || 30));
      const rows = await store.getUserRuns(auth.user.id, limit);
      return json({
        entries: rows.map((row) => ({
          ...runJson(row),
          userId: auth.user.id,
          login: auth.user.login,
          name: auth.user.name,
          avatarUrl: auth.user.avatarUrl,
        })),
      });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const auth = await authenticate(request);
      if (auth) await store.deleteSession(auth.tokenHash);
      return json({ ok: true });
    }

    const runMatch = /^\/api\/runs\/([A-Za-z0-9_]+)$/.exec(path);
    if (runMatch && method === 'GET') {
      const row = await store.getRunById(runMatch[1]);
      if (!row) fail(404, 'run_not_found', '找不到这条轨迹');
      return json({
        run: {
          ...runJson(row),
          userId: row.userId,
          login: row.login,
          name: row.name || row.login,
          avatarUrl: row.avatarUrl || '',
        },
      });
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
