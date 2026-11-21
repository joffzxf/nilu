/** 环境变量 -> 运行配置。Node 与 Worker 共用。 */
export function configFromEnv(env = {}) {
  const parseList = (value) => String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const parsedOrigins = parseList(env.APP_ORIGIN || 'https://joffzxf.github.io');
  const appOrigins = parsedOrigins.length ? parsedOrigins : ['https://joffzxf.github.io'];
  const durationTicks = clampInt(env.DURATION_TICKS, 3600, 600, 60 * 60 * 2);
  const minRunRatio = clampFloat(env.MIN_RUN_RATIO, 0.8, 0, 1);
  return {
    appOrigins,
    githubClientId: String(env.GITHUB_CLIENT_ID || ''),
    githubClientSecret: String(env.GITHUB_CLIENT_SECRET || ''),
    githubCallbackUrl: String(env.GITHUB_CALLBACK_URL || ''),
    apiOrigin: String(env.API_ORIGIN || '').replace(/\/+$/, ''),
    devAuth: env.DEV_AUTH === '1' || env.DEV_AUTH === 'true',
    durationTicks,
    minRunRatio,
    sessionTtlMs: clampInt(env.SESSION_TTL_MS, 90 * 24 * 60 * 60 * 1000, 60_000, 365 * 24 * 60 * 60 * 1000),
    challengeTtlMs: clampInt(env.CHALLENGE_TTL_MS, 15 * 60 * 1000, 60_000, 60 * 60 * 1000),
    now: () => Date.now(),
  };
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clampFloat(value, fallback, min, max) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
