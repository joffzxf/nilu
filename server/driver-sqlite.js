import { DatabaseSync } from 'node:sqlite';

/** Node 本地 / 自托管用的 SQLite 驱动。 */
export function createSqliteDriver(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes || 0), lastInsertRowid: info.lastInsertRowid };
    },
    async exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}
