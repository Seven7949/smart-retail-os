/** expo-sqlite-compatible adapter over sql.js (real SQLite compiled to WASM) for tests. */
import initSqlJs from 'sql.js';
import type { SqlDb } from '../data/repo';

export async function memoryDb(): Promise<SqlDb> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  return {
    async execAsync(sql) { db.exec(sql.replace(/PRAGMA journal_mode = WAL;/, '')); },
    async runAsync(sql, ...params) { db.run(sql, params); },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
    async withTransactionAsync(fn) {
      db.run('BEGIN');
      try { await fn(); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; }
    },
  };
}
