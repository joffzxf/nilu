/** Cloudflare D1 驱动：与 SQLite 驱动保持同一组方法。 */
export function createD1Driver(d1) {
  return {
    async all(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).all();
      return result.results || [];
    },
    async get(sql, params = []) {
      const row = await d1.prepare(sql).bind(...params).first();
      return row === undefined ? null : row;
    },
    async run(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).run();
      return {
        changes: Number(result.meta?.changes || 0),
        lastInsertRowid: result.meta?.last_row_id,
      };
    },
    async exec(sql) {
      await d1.exec(sql);
    },
  };
}
