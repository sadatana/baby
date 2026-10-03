// 開発・テスト用: Cloudflare D1 と同じ使い方ができる SQLite（node:sqlite）のラッパー
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const plain = (row) => (row ? { ...row } : null);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params.map(norm));
  }

  stmt() {
    return this.db.prepare(this.sql);
  }

  async first(column) {
    const row = plain(this.stmt().get(...this.params));
    return column ? row?.[column] ?? null : row;
  }

  async all() {
    return { results: this.stmt().all(...this.params).map(plain), success: true };
  }

  async run() {
    if (/\bRETURNING\b/i.test(this.sql)) return this.all();
    const r = this.stmt().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export class D1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // migrations/ の SQL を順に適用する（適用済みは記録して飛ばす）
  migrate(dir) {
    this.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
    const done = new Set(this.db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      this.db.exec(readFileSync(join(dir, name), 'utf8'));
      this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    return this;
  }
}
