const TOKEN_KEY = 'nilu.token';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'network_error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export class ApiClient {
  constructor(base = '') {
    this.base = String(base || '').replace(/\/+$/, '');
    this.token = readToken();
    this.online = false;
    this.health = null;
  }

  setToken(token) {
    this.token = token || '';
    try {
      if (this.token) localStorage.setItem(TOKEN_KEY, this.token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }

  url(path) {
    const base = this.base || window.location.origin;
    return new URL(`${base}${path}`, window.location.origin).toString();
  }

  async request(path, options = {}) {
    const { method = 'GET', body, timeout = 12000, auth = true } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (error) {
      throw new ApiError(error.name === 'AbortError' ? '请求超时' : '网络连接失败', 0, 'network_error');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code = data && data.error ? data.error : `http_${response.status}`;
      const message = data && data.message ? data.message : `服务返回 ${response.status}`;
      if (response.status === 401 && auth) this.setToken('');
      throw new ApiError(message, response.status, code);
    }
    if (data === null) throw new ApiError('服务返回了无法解析的内容', response.status, 'bad_json');
    return data;
  }

  async probe() {
    try {
      const health = await this.request('/api/health', { auth: false, timeout: 2500 });
      if (!health || health.ok !== true) return null;
      this.health = health;
      this.online = true;
      return health;
    } catch {
      this.online = false;
      this.health = null;
      return null;
    }
  }

  loginUrl(nonce, returnUrl) {
    const params = new URLSearchParams({ nonce, return: returnUrl });
    return `${this.url('/api/auth/github/start')}?${params.toString()}`;
  }

  exchange(code) {
    return this.request('/api/auth/exchange', { method: 'POST', body: { code }, auth: false });
  }

  devLogin(login = '本地行人') {
    return this.request('/api/dev/login', { method: 'POST', body: { login }, auth: false });
  }

  me() {
    return this.request('/api/me');
  }

  logout() {
    return this.request('/api/auth/logout', { method: 'POST', body: {} });
  }

  getAccount() {
    return this.request('/api/account');
  }

  createAccount() {
    return this.request('/api/account', { method: 'POST', body: {} });
  }

  startEffort() {
    return this.request('/api/account/efforts', { method: 'POST', body: {} });
  }

  completeEffort(effortId, keys) {
    return this.request(`/api/account/efforts/${encodeURIComponent(effortId)}/complete`, {
      method: 'POST',
      body: { keys },
    });
  }

  fastForward(targetDay) {
    return this.request('/api/account/fast-forward', {
      method: 'POST',
      body: { targetDay },
    });
  }

  endAccount() {
    return this.request('/api/account/end', { method: 'POST', body: { confirm: true } });
  }

  listAccounts() {
    return this.request('/api/accounts');
  }
}

export function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomSeed() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] >>> 0;
}
