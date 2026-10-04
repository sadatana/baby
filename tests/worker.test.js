// Worker（API）のテスト: SQLite（D1 の代わり）とメモリ上のストレージ（R2 の代わり）で動かす
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { D1 } from '../dev/d1.js';
import { R2 } from '../dev/r2.js';
import { Authenticator } from './helpers/authenticator.js';
import { decodeCbor, derToRaw } from '../worker/webauthn.js';

const ORIGIN = 'http://localhost:8787';
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
let env;

beforeEach(() => {
  env = {
    DB: new D1().migrate(MIGRATIONS),
    MEDIA: new R2(),
    ASSETS: { fetch: () => new Response('asset') },
  };
});

// ログイン状態（Cookie）を持つクライアント
class Client {
  constructor() {
    this.cookie = '';
    this.auth = new Authenticator();
  }

  async call(method, path, body, { headers = {}, raw = false } = {}) {
    const init = { method, headers: { origin: ORIGIN, cookie: this.cookie, ...headers } };
    if (body !== undefined) {
      if (body instanceof Uint8Array) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (raw) return res;
    return { status: res.status, body: await res.json() };
  }

  async register(intent, { displayName = 'ママ', groupName } = {}) {
    const opt = await this.call('POST', '/api/auth/register/options', { intent, displayName });
    assert.equal(opt.status, 200, JSON.stringify(opt.body));
    const credential = await this.auth.create(opt.body.options, ORIGIN);
    return this.call('POST', '/api/auth/register/verify', { challengeId: opt.body.challengeId, credential, groupName });
  }

  async login(opts) {
    const opt = await this.call('POST', '/api/auth/login/options', {});
    const credential = await this.auth.get(opt.body.options, ORIGIN, opts);
    return this.call('POST', '/api/auth/login/verify', { challengeId: opt.body.challengeId, credential });
  }

  sync(gid, changes) {
    return this.call('POST', `/api/groups/${gid}/sync`, { changes });
  }

  async pull(gid, since = 0) {
    const r = await this.call('GET', `/api/groups/${gid}/sync?since=${since}`);
    assert.equal(r.status, 200);
    return r.body;
  }
}

async function family() {
  const mom = new Client();
  const r = await mom.register({ type: 'new' }, { displayName: 'ママ', groupName: 'まめの家族' });
  assert.equal(r.status, 200);
  const gid = r.body.groups[0].id;
  const join = async (role, name) => {
    const inv = await mom.call('POST', `/api/groups/${gid}/invites`, { role });
    const c = new Client();
    const res = await c.register({ type: 'invite', token: inv.body.token }, { displayName: name });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    c.id = res.body.user.id;
    return c;
  };
  mom.id = r.body.user.id;
  return { mom, gid, join, recoveryCode: r.body.recoveryCode };
}

const change = (type, id, data, updatedAt = Date.now()) => ({ type, id, data, updatedAt });

test('webauthn helpers: CBOR and DER', () => {
  assert.deepEqual(decodeCbor(new Uint8Array([0xa1, 0x01, 0x02])).value, new Map([[1, 2]]));
  assert.equal(decodeCbor(new Uint8Array([0x38, 0x18])).value, -25);
  assert.throws(() => decodeCbor(new Uint8Array([0x5f])));
  const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x80, 0x02, 0x02, 0x01, 0x02]);
  const raw = derToRaw(der);
  assert.equal(raw[31], 0x80);
  assert.equal(raw[62], 0x01);
  assert.equal(raw[63], 0x02);
});

test('static files are served from ASSETS', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/index.html`), env);
  assert.equal(await res.text(), 'asset');
});

test('create a family group with a passkey, then log in again', async () => {
  const { mom, gid, recoveryCode } = await family();
  assert.match(recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const me = await mom.call('GET', '/api/me');
  assert.equal(me.body.user.displayName, 'ママ');
  assert.deepEqual(me.body.groups, [{ id: gid, name: 'まめの家族', role: 'admin' }]);

  await mom.call('POST', '/api/auth/logout', {});
  assert.equal((await mom.call('GET', '/api/me')).status, 401);
  const login = await mom.login();
  assert.equal(login.status, 200);
  assert.equal(login.body.groups[0].id, gid);
});

test('login rejects bad signatures, replayed challenges and counter rollback', async () => {
  const { mom } = await family();
  // 署名の改ざん
  const opt = await mom.call('POST', '/api/auth/login/options', {});
  const cred = await mom.auth.get(opt.body.options, ORIGIN);
  const tampered = { ...cred, response: { ...cred.response, clientDataJSON: cred.response.clientDataJSON } };
  const sig = cred.response.signature;
  tampered.response.signature = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  const bad = await mom.call('POST', '/api/auth/login/verify', { challengeId: opt.body.challengeId, credential: tampered });
  assert.ok(bad.status === 401 || bad.status === 400);
  // 同じチャレンジは 2 回使えない
  const again = await mom.call('POST', '/api/auth/login/verify', { challengeId: opt.body.challengeId, credential: cred });
  assert.equal(again.status, 400);
  // 署名回数が戻った
  assert.equal((await mom.login({ counter: 5 })).status, 200);
  assert.equal((await mom.login({ counter: 3 })).status, 401);
  // 別のオリジン
  const opt2 = await mom.call('POST', '/api/auth/login/options', {});
  const evil = await mom.auth.get(opt2.body.options, 'https://evil.example');
  assert.equal((await mom.call('POST', '/api/auth/login/verify', { challengeId: opt2.body.challengeId, credential: evil })).status, 400);
});

test('requests from another origin are rejected', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/login/options`, {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(res.status, 403);
});

test('invites: role, single use, info', async () => {
  const { mom, gid, join } = await family();
  const inv = await mom.call('POST', `/api/groups/${gid}/invites`, { role: 'viewer' });
  const info = await new Client().call('GET', `/api/invites/${inv.body.token}`);
  assert.deepEqual([info.body.groupName, info.body.role, info.body.invitedBy], ['まめの家族', 'viewer', 'ママ']);

  const grandma = new Client();
  assert.equal((await grandma.register({ type: 'invite', token: inv.body.token }, { displayName: 'ばあば' })).status, 200);
  const again = new Client();
  const reuse = await again.call('POST', '/api/auth/register/options', { intent: { type: 'invite', token: inv.body.token }, displayName: 'x' });
  assert.equal(reuse.status, 400);

  const papa = await join('editor', 'パパ');
  const members = await papa.call('GET', `/api/groups/${gid}/members`);
  assert.deepEqual(members.body.members.map((m) => [m.displayName, m.role]), [['ママ', 'admin'], ['ばあば', 'viewer'], ['パパ', 'editor']]);
  // 管理者以外は招待できない
  assert.equal((await papa.call('POST', `/api/groups/${gid}/invites`, { role: 'viewer' })).status, 403);
  // グループ外の人は見られない
  assert.equal((await new Client().call('GET', `/api/groups/${gid}/members`)).status, 401);
  const outsider = await family();
  assert.equal((await outsider.mom.call('GET', `/api/groups/${gid}/members`)).status, 404);
});

test('sync: roles, ownership, last-write-wins and tombstones', async () => {
  const { mom, gid, join } = await family();
  const papa = await join('editor', 'パパ');
  const grandma = await join('viewer', 'ばあば');

  const t = Date.now() - 10000;
  let r = await mom.sync(gid, [
    change('child', 'c1', { id: 'c1', name: 'まめ', dueDate: '2026-11-20' }, t),
    change('fetal', 'f1', { id: 'f1', childId: 'c1', date: '2026-09-01', efwG: 1500 }, t),
  ]);
  assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'ok']);

  // 閲覧者は赤ちゃんの記録を書けない・リアクションは書ける
  r = await grandma.sync(gid, [
    change('fetal', 'f2', { id: 'f2', efwG: 1 }),
    change('reaction', `${grandma.id}.f1.0`, { targetType: 'fetal', targetId: 'f1', emoji: '❤️' }),
  ]);
  assert.deepEqual(r.body.results.map((x) => x.status), ['forbidden', 'ok']);
  // 他人のリアクションは消せない
  r = await papa.sync(gid, [{ type: 'reaction', id: `${grandma.id}.f1.0`, deleted: true, updatedAt: Date.now() }]);
  assert.equal(r.body.results[0].status, 'forbidden');

  // 古い更新は反映されない（後から保存した方を優先）
  r = await papa.sync(gid, [change('fetal', 'f1', { id: 'f1', efwG: 1400 }, t - 1)]);
  assert.equal(r.body.results[0].status, 'stale');
  r = await papa.sync(gid, [change('fetal', 'f1', { id: 'f1', childId: 'c1', date: '2026-09-01', efwG: 1550 }, t + 1)]);
  assert.equal(r.body.results[0].status, 'ok');

  const pulled = await grandma.pull(gid);
  const f1 = pulled.records.find((x) => x.id === 'f1');
  assert.equal(f1.data.efwG, 1550);
  assert.equal(f1.ownerId, mom.id);
  assert.equal(f1.updatedBy, papa.id);

  // 差分だけ取得できる
  const cursor = pulled.cursor;
  assert.deepEqual((await grandma.pull(gid, cursor)).records, []);
  await mom.sync(gid, [{ type: 'fetal', id: 'f1', deleted: true, updatedAt: Date.now() }]);
  const diff = await grandma.pull(gid, cursor);
  assert.deepEqual(diff.records.map((x) => [x.id, x.deleted]), [['f1', true]]);

  // 不正な種類・ID・他人の設定
  r = await mom.sync(gid, [change('evil', 'x', {}), change('child', 'bad id!', {}), change('prefs', papa.id, {})]);
  assert.deepEqual(r.body.results.map((x) => x.status), ['invalid', 'invalid', 'forbidden']);
});

test("mom's records follow share settings; private journal stays private", async () => {
  const { mom, gid, join } = await family();
  const papa = await join('editor', 'パパ');
  await mom.sync(gid, [
    change('weight', 'w1', { id: 'w1', date: '2026-09-01', kg: 55 }),
    change('journal', 'j1', { id: 'j1', text: '共有してもいい日記' }),
    change('journal', 'j2', { id: 'j2', text: '自分だけ', private: true }),
    change('prefs', mom.id, { profile: { heightCm: 158 } }),
  ]);
  const ids = (p) => p.records.filter((x) => !x.deleted).map((x) => x.id).sort();
  assert.deepEqual(ids(await papa.pull(gid)), []);
  assert.deepEqual(ids(await mom.pull(gid)), ['j1', 'j2', 'w1', mom.id].sort());

  const before = (await papa.pull(gid)).cursor;
  await mom.sync(gid, [change('share', mom.id, { weight: true, journal: true, labor: false })]);
  const after = await papa.pull(gid, before);
  assert.deepEqual(ids(after), ['j1', 'share', 'w1'].map((x) => (x === 'share' ? mom.id : x)).sort());

  // 共有をやめると、家族側には削除として届く
  await mom.sync(gid, [change('share', mom.id, { weight: false, journal: true, labor: false })]);
  const off = await papa.pull(gid, after.cursor);
  assert.ok(off.records.some((x) => x.id === 'w1' && x.deleted));

  // パパはママの記録を編集できない
  const r = await papa.sync(gid, [change('weight', 'w1', { kg: 99 })]);
  assert.equal(r.body.results[0].status, 'forbidden');
});

test('photos: editors upload, every member can view, deletion removes the file', async () => {
  const { mom, gid, join } = await family();
  const grandma = await join('viewer', 'ばあば');
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const put = await mom.call('PUT', `/api/groups/${gid}/media/m1/full`, jpeg, { headers: { 'content-type': 'image/jpeg' } });
  assert.equal(put.status, 200);
  assert.equal((await grandma.call('PUT', `/api/groups/${gid}/media/m2/full`, jpeg, { headers: { 'content-type': 'image/jpeg' } })).status, 403);
  assert.equal((await mom.call('PUT', `/api/groups/${gid}/media/m3/full`, jpeg, { headers: { 'content-type': 'text/html' } })).status, 415);
  // 動画は本体（full）だけ受け付け、50MB まで
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  assert.equal((await mom.call('PUT', `/api/groups/${gid}/media/v1/full`, mp4, { headers: { 'content-type': 'video/mp4' } })).status, 200);
  assert.equal((await mom.call('PUT', `/api/groups/${gid}/media/v1/thumb`, mp4, { headers: { 'content-type': 'video/mp4' } })).status, 415);
  const big = new Uint8Array(9 * 1024 * 1024);
  assert.equal((await mom.call('PUT', `/api/groups/${gid}/media/m4/full`, big, { headers: { 'content-type': 'image/jpeg' } })).status, 413);
  assert.equal((await mom.call('PUT', `/api/groups/${gid}/media/v2/full`, big, { headers: { 'content-type': 'video/mp4' } })).status, 200);

  const res = await grandma.call('GET', `/api/groups/${gid}/media/m1/full`, undefined, { raw: true });
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);
  assert.equal((await new Client().call('GET', `/api/groups/${gid}/media/m1/full`, undefined, { raw: true })).status, 401);

  await mom.sync(gid, [change('media', 'm1', { id: 'm1' })]);
  await mom.sync(gid, [{ type: 'media', id: 'm1', deleted: true, updatedAt: Date.now() }]);
  assert.equal((await mom.call('GET', `/api/groups/${gid}/media/m1/full`, undefined, { raw: true })).status, 404);
});

test('add a device with a link, recover with the recovery code', async () => {
  const { mom, recoveryCode } = await family();
  const link = await mom.call('POST', '/api/me/device-link', {});
  const tablet = new Client();
  const r = await tablet.register({ type: 'link', token: link.body.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, mom.id);
  assert.equal(r.body.devices, 2);
  // リンクは 1 回限り
  const reuse = await new Client().call('POST', '/api/auth/register/options', { intent: { type: 'link', token: link.body.token } });
  assert.equal(reuse.status, 400);

  // 端末をすべてなくした → 復旧コード
  const lost = new Client();
  assert.equal((await lost.call('POST', '/api/auth/recover', { code: 'AAAA-BBBB-CCCC-DDDD' })).status, 400);
  const rec = await lost.call('POST', '/api/auth/recover', { code: recoveryCode.toLowerCase().replace(/-/g, ' ') });
  assert.equal(rec.status, 200);
  const r2 = await lost.register({ type: 'link', token: rec.body.token });
  assert.equal(r2.body.user.id, mom.id);
});

test('admin manages members: roles, relogin link, removal, last admin protection', async () => {
  const { mom, gid, join } = await family();
  const papa = await join('editor', 'パパ');
  const grandma = await join('viewer', 'ばあば');

  assert.equal((await mom.call('PATCH', `/api/groups/${gid}/members/${mom.id}`, { role: 'editor' })).status, 409);
  assert.equal((await mom.call('DELETE', `/api/groups/${gid}/members/${mom.id}`)).status, 409);
  assert.equal((await papa.call('PATCH', `/api/groups/${gid}/members/${grandma.id}`, { role: 'editor' })).status, 403);
  assert.equal((await mom.call('PATCH', `/api/groups/${gid}/members/${papa.id}`, { role: 'admin' })).status, 200);

  const relogin = await papa.call('POST', `/api/groups/${gid}/members/${grandma.id}/relogin-link`, {});
  assert.equal(relogin.status, 200);
  const newPhone = new Client();
  assert.equal((await newPhone.register({ type: 'link', token: relogin.body.token })).body.user.id, grandma.id);

  // ばあばのリアクションは削除時に消える
  await grandma.sync(gid, [change('reaction', `${grandma.id}.x.0`, { targetId: 'x', emoji: '❤️' })]);
  assert.equal((await mom.call('DELETE', `/api/groups/${gid}/members/${grandma.id}`)).status, 200);
  const p = await mom.pull(gid);
  assert.ok(p.records.find((x) => x.id === `${grandma.id}.x.0`).deleted);
  assert.equal((await grandma.call('GET', `/api/groups/${gid}/members`)).status, 404);
});

test('deleting the account removes a group that has no other members', async () => {
  const { mom, gid } = await family();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  await mom.call('PUT', `/api/groups/${gid}/media/m1/thumb`, jpeg, { headers: { 'content-type': 'image/jpeg' } });
  await mom.sync(gid, [change('child', 'c1', { id: 'c1' })]);
  assert.equal((await mom.call('DELETE', '/api/me')).status, 200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 0);
  assert.equal((await env.MEDIA.list({ prefix: `${gid}/` })).objects.length, 0);
  assert.equal((await mom.login()).status, 401);
});

test('the last admin cannot delete the account while others remain', async () => {
  const { mom, join } = await family();
  await join('viewer', 'ばあば');
  assert.equal((await mom.call('DELETE', '/api/me')).status, 409);
});
