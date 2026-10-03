// ローカル開発サーバー: Worker（worker/index.js）を Node で動かす
//   npm run dev → http://localhost:8787
//   D1 の代わりに SQLite（.dev/db.sqlite）、R2 の代わりに .dev/media/ を使う
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { D1 } from './d1.js';
import { R2 } from './r2.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 8787;
const memory = process.argv.includes('--memory');
if (!memory) mkdirSync(join(root, '.dev'), { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    let file = normalize(join(root, 'public', decodeURIComponent(pathname)));
    if (!file.startsWith(join(root, 'public'))) return new Response('forbidden', { status: 403 });
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

const env = {
  DB: new D1(memory ? ':memory:' : join(root, '.dev', 'db.sqlite')).migrate(join(root, 'migrations')),
  MEDIA: new R2(memory ? null : join(root, '.dev', 'media')),
  ASSETS,
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`http://localhost:${port}`));
