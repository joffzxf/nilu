/**
 * 所有 SQL 都放这里，SQLite 与 D1 只负责执行。
 * 返回字段统一用 camelCase，app.js 不再关心数据库列名。
 */
export function createSqlStore(driver) {
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

    /* ---------- sessions ---------- */

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

    /* ---------- oauth ---------- */

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
      return driver.get(
        'SELECT user_id AS userId FROM login_codes WHERE code_hash = ?',
        [codeHash],
      );
    },

    /* ---------- challenges ---------- */

    async invalidateOpenChallenges(userId, now) {
      await driver.run(
        'UPDATE challenges SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
        [now, userId],
      );
    },

    async createChallenge({ id, userId, seed, durationTicks, engineVersion, createdAt, expiresAt }) {
      await driver.run(
        `INSERT INTO challenges (id, user_id, seed, duration_ticks, engine_version, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, seed, durationTicks, engineVersion, createdAt, expiresAt],
      );
    },

    async getChallenge(id) {
      return driver.get(
        `SELECT id, user_id AS userId, seed, duration_ticks AS durationTicks,
                engine_version AS engineVersion, created_at AS createdAt,
                expires_at AS expiresAt, used_at AS usedAt
         FROM challenges WHERE id = ?`,
        [id],
      );
    },

    async markChallengeUsed(id, now) {
      const result = await driver.run(
        'UPDATE challenges SET used_at = ? WHERE id = ? AND used_at IS NULL',
        [now, id],
      );
      return result.changes > 0;
    },

    async countChallengesSince(userId, since) {
      const row = await driver.get(
        'SELECT COUNT(*) AS n FROM challenges WHERE user_id = ? AND created_at >= ?',
        [userId, since],
      );
      return Number(row?.n || 0);
    },

    /* ---------- runs ---------- */

    async insertRun(run) {
      await driver.run(
        `INSERT INTO runs (
           id, challenge_id, user_id, score, area, max_slope, successes, misses,
           max_combo, duration_ticks, engine_version, inputs_json, curve_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id, run.challengeId, run.userId, run.score, run.area, run.maxSlope,
          run.successes, run.misses, run.maxCombo, run.durationTicks, run.engineVersion,
          JSON.stringify(run.inputs), JSON.stringify(run.curve), run.createdAt,
        ],
      );
    },

    async getRunByChallenge(challengeId) {
      return driver.get(
        `SELECT id, challenge_id AS challengeId, user_id AS userId, score, area,
                max_slope AS maxSlope, successes, misses, max_combo AS maxCombo,
                duration_ticks AS durationTicks, engine_version AS engineVersion,
                curve_json AS curveJson, created_at AS createdAt
         FROM runs WHERE challenge_id = ?`,
        [challengeId],
      );
    },

    async getRunById(id) {
      return driver.get(
        `SELECT r.id, r.user_id AS userId, r.score, r.area, r.max_slope AS maxSlope,
                r.successes, r.misses, r.max_combo AS maxCombo, r.duration_ticks AS durationTicks,
                r.curve_json AS curveJson, r.created_at AS createdAt, u.login, u.name,
                u.avatar_url AS avatarUrl
         FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
        [id],
      );
    },

    async getUserBest(userId) {
      return driver.get(
        `SELECT id, score, area, max_slope AS maxSlope, successes, misses,
                max_combo AS maxCombo, duration_ticks AS durationTicks,
                curve_json AS curveJson, created_at AS createdAt
         FROM runs WHERE user_id = ?
         ORDER BY score DESC, created_at ASC LIMIT 1`,
        [userId],
      );
    },

    async getUserRuns(userId, limit) {
      return driver.all(
        `SELECT id, score, area, max_slope AS maxSlope, successes, misses,
                max_combo AS maxCombo, duration_ticks AS durationTicks,
                curve_json AS curveJson, created_at AS createdAt
         FROM runs WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [userId, limit],
      );
    },

    async countRunsSince(userId, since) {
      const row = await driver.get(
        'SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at >= ?',
        [userId, since],
      );
      return Number(row?.n || 0);
    },

    /* ---------- leaderboard ---------- */

    async getLeaderboard({ since, limit, offset }) {
      const sinceSql = since ? 'AND created_at >= ?' : '';
      const params = since ? [since, limit, offset] : [limit, offset];
      return driver.all(
        `SELECT u.id AS userId, u.login, u.name, u.avatar_url AS avatarUrl,
                r.id AS runId, COALESCE(r.score, 0) AS score,
                r.max_slope AS maxSlope, r.successes, r.misses,
                r.max_combo AS maxCombo, r.curve_json AS curveJson,
                r.created_at AS createdAt
         FROM users u
         LEFT JOIN runs r ON r.id = (
           SELECT id FROM runs
           WHERE user_id = u.id ${sinceSql}
           ORDER BY score DESC, created_at ASC
           LIMIT 1
         )
         ORDER BY CASE WHEN r.id IS NULL THEN 1 ELSE 0 END,
                  r.score DESC, r.created_at ASC, u.login ASC
         LIMIT ? OFFSET ?`,
        params,
      );
    },

    async getBestScore(userId, since) {
      const sinceSql = since ? 'AND created_at >= ?' : '';
      const params = since ? [userId, since] : [userId];
      const row = await driver.get(
        `SELECT MAX(score) AS score FROM runs WHERE user_id = ? ${sinceSql}`,
        params,
      );
      return row?.score === null || row?.score === undefined ? null : Number(row.score);
    },

    async getRank(userId, since) {
      if (since) {
        const row = await driver.get(
          `WITH best AS (
             SELECT u.id AS id,
                    COALESCE((SELECT MAX(score) FROM runs WHERE user_id = u.id AND created_at >= ?), -1) AS score
             FROM users u
           )
           SELECT COUNT(*) + 1 AS rank FROM best
           WHERE score > (SELECT score FROM best WHERE id = ?)`,
          [since, userId],
        );
        return Number(row?.rank || 1);
      }
      const row = await driver.get(
        `WITH best AS (
           SELECT u.id AS id,
                  COALESCE((SELECT MAX(score) FROM runs WHERE user_id = u.id), -1) AS score
           FROM users u
         )
         SELECT COUNT(*) + 1 AS rank FROM best
         WHERE score > (SELECT score FROM best WHERE id = ?)`,
        [userId],
      );
      return Number(row?.rank || 1);
    },

    async cleanup(now) {
      await driver.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      await driver.run('DELETE FROM login_states WHERE expires_at <= ?', [now]);
      await driver.run('DELETE FROM login_codes WHERE expires_at <= ? OR used_at IS NOT NULL', [now]);
    },
  };
}
