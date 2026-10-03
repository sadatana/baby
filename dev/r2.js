// 開発・テスト用: Cloudflare R2 と同じ使い方ができるストレージ（メモリ上、または指定フォルダ）
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class R2 {
  constructor(dir = null) {
    this.dir = dir;
    this.mem = new Map();
  }

  path(key) {
    return join(this.dir, encodeURIComponent(key));
  }

  async put(key, value, options = {}) {
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
    const meta = { contentType: options.httpMetadata?.contentType || 'application/octet-stream' };
    if (this.dir) {
      mkdirSync(dirname(this.path(key)), { recursive: true });
      writeFileSync(this.path(key), bytes);
      writeFileSync(`${this.path(key)}.meta`, JSON.stringify(meta));
    } else {
      this.mem.set(key, { bytes, meta });
    }
  }

  async get(key) {
    let entry = this.mem.get(key);
    if (this.dir && existsSync(this.path(key))) {
      entry = { bytes: readFileSync(this.path(key)), meta: JSON.parse(readFileSync(`${this.path(key)}.meta`, 'utf8')) };
    }
    if (!entry) return null;
    return { body: new Blob([entry.bytes]).stream(), size: entry.bytes.length, httpMetadata: entry.meta };
  }

  async delete(keys) {
    for (const key of [].concat(keys)) {
      this.mem.delete(key);
      if (this.dir) {
        rmSync(this.path(key), { force: true });
        rmSync(`${this.path(key)}.meta`, { force: true });
      }
    }
  }

  async list({ prefix = '' } = {}) {
    const keys = this.dir && existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => !f.endsWith('.meta')).map(decodeURIComponent)
      : [...this.mem.keys()];
    return { objects: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
}
