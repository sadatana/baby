import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, createZip, safeName } from '../public/js/zip.js';

test('crc32 matches known values', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('createZip produces a valid archive with UTF-8 names', async () => {
  const img = new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])], { type: 'image/jpeg' });
  const zip = await createZip([
    { name: 'data.json', data: '{"a":1}' },
    { name: '写真/まめ/2026-10-01_abc.jpg', data: img },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2);

  // 標準のツール（Python の zipfile）で中身を検証する
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const file = join(dir, 'out.zip');
  writeFileSync(file, bytes);
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({n: len(z.read(n)) for n in z.namelist()}, ensure_ascii=False))
`, file]).toString();
  assert.deepEqual(JSON.parse(out), { 'data.json': 7, '写真/まめ/2026-10-01_abc.jpg': 7 });
  assert.ok(readFileSync(file).length > 0);
});

test('safeName strips path characters', () => {
  assert.equal(safeName('a/b:c'), 'a_b_c');
  assert.equal(safeName(''), 'untitled');
});
