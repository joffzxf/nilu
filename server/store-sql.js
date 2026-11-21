/**
 * 所有 SQL 都在这里，SQLite 与 D1 只负责执行。
 * 返回字段统一 camelCase。
 */
export function createSqlStore(driver) {
  const ACCOUNT_COLUMNS = `
    id, user_id AS userId, status, birth_at AS birthAt, ended_at AS endedAt,
    end_reason AS endReason, last_settled_at AS lastSettledAt,
    age_seconds AS age, day, slope, height, area, efforts, seed,
    engine_version AS engineVersion, version, meta_json AS metaJson,
    created_at AS createdAt, updated_at AS updatedAt`;

  return {
    async init(schemaSql) {
      await driver.exec(schemaSql);
    },

    /* ---------- users ---------- */

    async upsertUser({ githubId, login, name, avatarUrl, now }) {
      await driver.run(
        `INSERT INTO users (id, github_id, login, name, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           login = excluded.login,
           name = excluded.name,
           avatar_url = excluded.avatar_url,
           updated_at = excluded.updated_at`,
        [`u_${crypto.randomUUID()}`, githubId, login, name || null, avatarUrl || null, now, now],
      );
      return this.getUserByGithubId(githubId);
    },

    async getUserByGithubId(githubId) {
      return driver.get(
        `SELECT id, github_id AS githubId, login, name, avatar_url AS avatarUrl, created_at AS createdAt
         FROM users WHERE github_id = ?`,
        [githubId],
      );
    },

    async getUserById(id) {
      return driver.get(
        `SELECT id, github_id AS githubId, login, name, avatar_url AS avatarUrl, created_at AS createdAt
         FROM users WHERE id = ?`,
        [id],
      );
    },

    async countUsers() {
      const row = await driver.get('SELECT COUNT(*) AS n FROM users');
      return Number(row?.n || 0);
    },

    /* ---------- sessions / oauth ---------- */

    async createSession({ tokenHash, userId, expiresAt, createdAt, userAgent }) {
      await driver.run(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        [tokenHash, userId, createdAt, expiresAt, userAgent || null],
      );
    },

    async getSession(tokenHash, now) {
      return driver.get(
        `SELECT s.user_id AS userId, s.expires_at AS expiresAt,
                u.login, u.name, u.avatar_url AS avatarUrl
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
        [tokenHash, now],
      );
    },

    async deleteSession(tokenHash) {
      await driver.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    },

    async createLoginState({ state, nonce, returnUrl, createdAt, expiresAt }) {
      await driver.run(
        `INSERT INTO login_states (state, nonce, return_url, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [state, nonce, returnUrl, createdAt, expiresAt],
      );
    },

    async consumeLoginState(state, now) {
      const row = await driver.get(
        `SELECT state, nonce, return_url AS returnUrl, expires_at AS expiresAt
         FROM login_states WHERE state = ? AND expires_at > ?`,
        [state, now],
      );
      if (row) await driver.run('DELETE FROM login_states WHERE state = ?', [state]);
      return row;
    },

    async createLoginCode({ codeHash, userId, createdAt, expiresAt }) {
      await driver.run(
        `INSERT INTO login_codes (code_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        [codeHash, userId, createdAt, expiresAt],
      );
    },

    async consumeLoginCode(codeHash, now) {
      const result = await driver.run(
        `UPDATE login_codes SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
        [now, codeHash, now],
      );
      if (!result.changes) return null;
      return driver.get('SELECT user_id AS userId FROM login_codes WHERE code_hash = ?', [codeHash]);
    },

    /* ---------- accounts ---------- */

    async getAliveAccount(userId) {
      return driver.get(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts
         WHERE user_id = ? AND status = 'alive' LIMIT 1`,
        [userId],
      );
    },

    async getAccountById(id) {
      return driver.get(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`,
        [id],
      );
    },

    async listAccounts(userId) {
      return driver.all(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );
    },

    async getLastEnded(userId) {
      return driver.get(
        `SELECT id, ended_at AS endedAt, end_reason AS endReason, area, day
         FROM accounts WHERE user_id = ? AND status = 'ended'
         ORDER BY ended_at DESC LIMIT 1`,
        [userId],
      );
    },

    async countAccountsSince(userId, since) {
      const row = await driver.get(
        'SELECT COUNT(*) AS n FROM accounts WHERE user_id = ? AND created_at >= ?',
        [userId, since],
      );
      return Number(row?.n || 0);
    },

    async createAccount(row) {
      await driver.run(
        `INSERT INTO accounts (
           id, user_id, status, birth_at, ended_at, end_reason, last_settled_at,
           age_seconds, day, slope, height, area, efforts, seed, engine_version,
           version, meta_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.userId, row.status, row.birthAt, row.endedAt || null, row.endReason || null,
          row.lastSettledAt, row.age, row.day, row.slope, row.height, row.area, row.efforts,
          row.seed, row.engineVersion, row.version, row.metaJson || '{}', row.createdAt, row.updatedAt,
        ],
      );
    },

    /** 乐观锁：拿旧 version 换新 version，冲突由 app 重试。 */
    async updateAccount(row) {
      const result = await driver.run(
        `UPDATE accounts SET
           status = ?, ended_at = ?, end_reason = ?, last_settled_at = ?,
           age_seconds = ?, day = ?, slope = ?, height = ?, area = ?, efforts = ?,
           version = ?, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'alive'`,
        [
          row.status, row.endedAt || null, row.endReason || null, row.lastSettledAt,
          row.age, row.day, row.slope, row.height, row.area, row.efforts,
          row.version + 1, row.updatedAt, row.id, row.version,
        ],
      );
      return result.changes > 0;
    },

    /* ---------- events ---------- */

    async addEvent({ accountId, type, atAge, atMs, slopeAfter, payload }) {
      await driver.run(
        `INSERT INTO account_events (account_id, type, at_age, at_ms, slope_after, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [accountId, type, atAge, atMs, slopeAfter ?? null, payload ? JSON.stringify(payload) : null],
      );
    },

    async getEvents(accountId, limit = 2000) {
      return driver.all(
        `SELECT type, at_age AS at, at_ms AS atMs, slope_after AS slope
         FROM account_events WHERE account_id = ?
         ORDER BY at_age ASC, id ASC LIMIT ?`,
        [accountId, limit],
      );
    },

    /* ---------- efforts ---------- */

    async abandonOpenEfforts(accountId, now) {
      await driver.run(
        `UPDATE efforts SET status = 'abandoned', completed_at = ?
         WHERE account_id = ? AND status = 'open'`,
        [now, accountId],
      );
    },

    async createEffort({ id, accountId, userId, sequence, createdAt }) {
      await driver.run(
        `INSERT INTO efforts (id, account_id, user_id, sequence_json, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
        [id, accountId, userId, JSON.stringify(sequence), createdAt],
      );
    },

    async getEffort(id) {
      return driver.get(
        `SELECT id, account_id AS accountId, user_id AS userId,
                sequence_json AS sequenceJson, status, keys_json AS keysJson,
                created_at AS createdAt, completed_at AS completedAt
         FROM efforts WHERE id = ?`,
        [id],
      );
    },

    async completeEffort({ id, accountId, status, keys, now }) {
      const result = await driver.run(
        `UPDATE efforts SET status = ?, keys_json = ?, completed_at = ?
         WHERE id = ? AND account_id = ? AND status = 'open'`,
        [status, JSON.stringify(keys), now, id, accountId],
      );
      return result.changes > 0;
    },

    async countEffortsSince(accountId, since) {
      const row = await driver.get(
        'SELECT COUNT(*) AS n FROM efforts WHERE account_id = ? AND created_at >= ?',
        [accountId, since],
      );
      return Number(row?.n || 0);
    },

    async cleanup(now) {
      await driver.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      await driver.run('DELETE FROM login_states WHERE expires_at <= ?', [now]);
      await driver.run('DELETE FROM login_codes WHERE expires_at <= ? OR used_at IS NOT NULL', [now]);
      await driver.run(
        `DELETE FROM efforts
         WHERE (completed_at IS NOT NULL AND completed_at <= ?)
            OR (status = 'open' AND created_at <= ?)`,
        [now - 30 * 24 * 60 * 60 * 1000, now - 30 * 24 * 60 * 60 * 1000],
      );
    },
  };
}
