// Cloudflare Worker: 画面（静的ファイル）と API を配信する
//   env.DB: D1 / env.MEDIA: R2 / env.ASSETS: 静的ファイル（public/）
import {
  HttpError, json, uuid, randomToken, hashToken, b64url, randomBytes, recoveryCode, normalizeCode,
} from './util.js';
import { verifyRegistration, verifyAuthentication } from './webauthn.js';

const SESSION_COOKIE = '__Host-sid';
const SESSION_TTL = 60 * 24 * 3600 * 1000; // 60 日
const CHALLENGE_TTL = 5 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 3600 * 1000;
const DEVICE_LINK_TTL = 15 * 60 * 1000;
const RELOGIN_LINK_TTL = 24 * 3600 * 1000;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const SYNC_PAGE = 500;
const ROLES = ['admin', 'editor', 'viewer'];

// 記録の種類
const BABY_TYPES = new Set(['child', 'fetal', 'growth', 'milestone', 'media']);
const MOM_TYPES = { weight: 'weight', journal: 'journal', contraction: 'labor', kick: 'labor' }; // 種類 → 共有設定の項目
const SOCIAL_TYPES = new Set(['reaction', 'comment']);
const SELF_TYPES = new Set(['prefs', 'share']); // id = 本人のユーザー ID
const ALL_TYPES = new Set([...BABY_TYPES, ...Object.keys(MOM_TYPES), ...SOCIAL_TYPES, ...SELF_TYPES]);
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code || e.message }, e.status);
      console.error(e);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

// ---------- ルーティング ----------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
}

async function handleApi(request, env, url) {
  const ctx = {
    request,
    env,
    url,
    db: env.DB,
    now: Date.now(),
    origin: url.origin,
    rpId: url.hostname,
  };
  // 別サイトからの書き込みを防ぐ
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) {
    throw new HttpError(403, 'bad origin', 'bad_origin');
  }
  for (const r of routes) {
    if (r.method !== request.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler(ctx);
  }
  throw new HttpError(404, 'not found', 'not_found');
}

async function body(ctx) {
  try {
    const data = await ctx.request.json();
    if (!data || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'invalid json', 'invalid_json');
  }
}

function text(v, max, field) {
  const s = String(v ?? '').trim();
  if (!s || s.length > max) throw new HttpError(400, `invalid ${field}`, `invalid_${field}`);
  return s;
}

// ---------- セッション ----------

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionCookie(token, maxAgeMs) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

async function currentUser(ctx, { required = true } = {}) {
  if (ctx.user !== undefined) return ctx.user;
  const token = readCookie(ctx.request, SESSION_COOKIE);
  let user = null;
  if (token) {
    user = await ctx.db.prepare(
      `SELECT u.id, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ).bind(await hashToken(token), ctx.now).first();
  }
  ctx.user = user ? { id: user.id, displayName: user.display_name } : null;
  if (!ctx.user && required) throw new HttpError(401, 'login required', 'unauthorized');
  return ctx.user;
}

async function createSession(ctx, userId) {
  const token = randomToken();
  await ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), userId, ctx.now, ctx.now + SESSION_TTL).run();
  return sessionCookie(token, SESSION_TTL);
}

async function mePayload(ctx, userId) {
  const user = await ctx.db.prepare('SELECT id, display_name FROM users WHERE id = ?').bind(userId).first();
  const { results } = await ctx.db.prepare(
    `SELECT g.id, g.name, m.role FROM memberships m JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = ? ORDER BY m.created_at`,
  ).bind(userId).all();
  const devices = await ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(userId).first();
  return {
    user: { id: user.id, displayName: user.display_name },
    groups: results.map((g) => ({ id: g.id, name: g.name, role: g.role })),
    devices: devices.n,
  };
}

async function membership(ctx, groupId, roles = ROLES) {
  const user = await currentUser(ctx);
  const m = await ctx.db.prepare('SELECT role FROM memberships WHERE group_id = ? AND user_id = ?')
    .bind(groupId, user.id).first();
  if (!m) throw new HttpError(404, 'group not found', 'not_found');
  if (!roles.includes(m.role)) throw new HttpError(403, 'forbidden', 'forbidden');
  return { user, role: m.role };
}

// ---------- パスキー登録・ログイン ----------

async function findLink(ctx, token) {
  const link = await ctx.db.prepare('SELECT * FROM links WHERE token_hash = ?').bind(await hashToken(token)).first();
  if (!link || link.used_at || link.expires_at < ctx.now) throw new HttpError(400, 'link expired', 'link_invalid');
  return link;
}

async function findInvite(ctx, token) {
  const inv = await ctx.db.prepare(
    `SELECT i.*, g.name AS group_name, u.display_name AS inviter FROM invites i
     JOIN groups g ON g.id = i.group_id LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?`,
  ).bind(await hashToken(String(token || ''))).first();
  if (!inv || inv.used_at || inv.expires_at < ctx.now) throw new HttpError(400, 'invite expired', 'invite_invalid');
  return inv;
}

async function saveChallenge(ctx, kind, data) {
  await ctx.db.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(ctx.now).run();
  const id = uuid();
  const challenge = b64url(randomBytes(32));
  await ctx.db.prepare('INSERT INTO challenges (id, challenge, kind, data, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, challenge, kind, JSON.stringify(data), ctx.now + CHALLENGE_TTL).run();
  return { id, challenge };
}

async function takeChallenge(ctx, id, kind) {
  const row = await ctx.db.prepare('DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING *')
    .bind(String(id || ''), kind).first();
  if (!row || row.expires_at < ctx.now) throw new HttpError(400, 'challenge expired', 'challenge_invalid');
  return { challenge: row.challenge, data: JSON.parse(row.data) };
}

const APP_NAME = 'マタニティ手帳';

route('GET', '/api/health', () => json({ ok: true }));

// intent: { type: 'new' } 新しく家族グループを作る / { type: 'invite', token } 招待で参加 / { type: 'link', token } 既存アカウントに端末を追加
route('POST', '/api/auth/register/options', async (ctx) => {
  const b = await body(ctx);
  const intent = b.intent || {};
  let userId;
  let name;
  let exclude = [];
  if (intent.type === 'new' || intent.type === 'invite') {
    if (intent.type === 'invite') await findInvite(ctx, intent.token);
    name = text(b.displayName, 20, 'name');
    userId = uuid();
  } else if (intent.type === 'link') {
    const link = await findLink(ctx, String(intent.token || ''));
    const user = await ctx.db.prepare('SELECT id, display_name FROM users WHERE id = ?').bind(link.user_id).first();
    userId = user.id;
    name = user.display_name;
    const { results } = await ctx.db.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(userId).all();
    exclude = results.map((r) => ({ type: 'public-key', id: r.id }));
  } else {
    throw new HttpError(400, 'invalid intent', 'invalid_intent');
  }
  const ch = await saveChallenge(ctx, 'register', { intent, userId, displayName: name });
  return json({
    challengeId: ch.id,
    options: {
      challenge: ch.challenge,
      rp: { name: APP_NAME, id: ctx.rpId },
      user: { id: b64url(new TextEncoder().encode(userId)), name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      attestation: 'none',
      excludeCredentials: exclude,
      timeout: CHALLENGE_TTL,
    },
  });
});

route('POST', '/api/auth/register/verify', async (ctx) => {
  const b = await body(ctx);
  const { challenge, data } = await takeChallenge(ctx, b.challengeId, 'register');
  const cred = await verifyRegistration(b.credential, { challenge, origin: ctx.origin, rpId: ctx.rpId });
  const exists = await ctx.db.prepare('SELECT id FROM passkeys WHERE id = ?').bind(cred.credentialId).first();
  if (exists) throw new HttpError(409, 'already registered', 'passkey_exists');

  const { intent, userId, displayName } = data;
  const deviceName = String(b.deviceName || '').slice(0, 40);
  const stmts = [];
  let recovery = null;
  if (intent.type === 'new') {
    const groupName = text(b.groupName || `${displayName}の家族`, 30, 'group_name');
    const groupId = uuid();
    recovery = recoveryCode();
    stmts.push(
      ctx.db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, displayName, ctx.now),
      ctx.db.prepare('INSERT INTO groups (id, name, seq, created_at) VALUES (?, ?, 0, ?)').bind(groupId, groupName, ctx.now),
      ctx.db.prepare('INSERT INTO memberships (group_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(groupId, userId, 'admin', ctx.now),
      ctx.db.prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)')
        .bind(userId, await hashToken(normalizeCode(recovery)), ctx.now),
    );
  } else if (intent.type === 'invite') {
    const inv = await findInvite(ctx, intent.token);
    // 1 回限り: 同時に使われても片方だけが成功するよう条件付きで更新する
    const used = await ctx.db.prepare(
      'UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL RETURNING group_id',
    ).bind(ctx.now, userId, inv.token_hash).first();
    if (!used) throw new HttpError(400, 'invite expired', 'invite_invalid');
    recovery = recoveryCode();
    stmts.push(
      ctx.db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(userId, displayName, ctx.now),
      ctx.db.prepare('INSERT INTO memberships (group_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(inv.group_id, userId, inv.role, ctx.now),
      ctx.db.prepare('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)')
        .bind(userId, await hashToken(normalizeCode(recovery)), ctx.now),
    );
  } else {
    const link = await findLink(ctx, String(intent.token || ''));
    if (link.user_id !== userId) throw new HttpError(400, 'link mismatch', 'link_invalid');
    const used = await ctx.db.prepare('UPDATE links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING user_id')
      .bind(ctx.now, link.token_hash).first();
    if (!used) throw new HttpError(400, 'link expired', 'link_invalid');
  }
  stmts.push(ctx.db.prepare(
    `INSERT INTO passkeys (id, user_id, alg, public_key, sign_count, device_name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(cred.credentialId, userId, cred.alg, JSON.stringify(cred.jwk), cred.signCount, deviceName, ctx.now, ctx.now));
  await ctx.db.batch(stmts);

  const cookie = await createSession(ctx, userId);
  return json({ ...(await mePayload(ctx, userId)), recoveryCode: recovery }, 200, { 'set-cookie': cookie });
});

route('POST', '/api/auth/login/options', async (ctx) => {
  const ch = await saveChallenge(ctx, 'login', {});
  return json({
    challengeId: ch.id,
    options: { challenge: ch.challenge, rpId: ctx.rpId, userVerification: 'preferred', allowCredentials: [], timeout: CHALLENGE_TTL },
  });
});

route('POST', '/api/auth/login/verify', async (ctx) => {
  const b = await body(ctx);
  const { challenge } = await takeChallenge(ctx, b.challengeId, 'login');
  const row = await ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(String(b.credential?.id || '')).first();
  if (!row) throw new HttpError(401, 'unknown passkey', 'unknown_passkey');
  const { signCount } = await verifyAuthentication(b.credential, {
    challenge,
    origin: ctx.origin,
    rpId: ctx.rpId,
    passkey: { alg: row.alg, jwk: JSON.parse(row.public_key), signCount: row.sign_count },
  });
  await ctx.db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').bind(signCount, ctx.now, row.id).run();
  const cookie = await createSession(ctx, row.user_id);
  return json(await mePayload(ctx, row.user_id), 200, { 'set-cookie': cookie });
});

// 復旧コード → パスキーを登録し直すためのリンク
route('POST', '/api/auth/recover', async (ctx) => {
  const b = await body(ctx);
  const code = normalizeCode(b.code);
  if (code.length !== 16) throw new HttpError(400, 'invalid code', 'invalid_code');
  const row = await ctx.db.prepare('SELECT user_id FROM recovery_codes WHERE code_hash = ?').bind(await hashToken(code)).first();
  if (!row) throw new HttpError(400, 'invalid code', 'invalid_code');
  const token = await createLink(ctx, row.user_id, 'recovery', row.user_id, DEVICE_LINK_TTL);
  return json({ token });
});

route('POST', '/api/auth/logout', async (ctx) => {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (token) await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
});

async function createLink(ctx, userId, kind, createdBy, ttl) {
  const token = randomToken();
  await ctx.db.prepare(
    'INSERT INTO links (token_hash, user_id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(await hashToken(token), userId, kind, createdBy, ctx.now, ctx.now + ttl).run();
  return token;
}

// ---------- 自分のアカウント ----------

route('GET', '/api/me', async (ctx) => {
  const user = await currentUser(ctx);
  return json(await mePayload(ctx, user.id));
});

route('PATCH', '/api/me', async (ctx) => {
  const user = await currentUser(ctx);
  const b = await body(ctx);
  await ctx.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(text(b.displayName, 20, 'name'), user.id).run();
  return json(await mePayload(ctx, user.id));
});

route('POST', '/api/me/device-link', async (ctx) => {
  const user = await currentUser(ctx);
  const token = await createLink(ctx, user.id, 'device', user.id, DEVICE_LINK_TTL);
  return json({ token, expiresAt: ctx.now + DEVICE_LINK_TTL });
});

route('POST', '/api/me/recovery-code', async (ctx) => {
  const user = await currentUser(ctx);
  const code = recoveryCode();
  await ctx.db.prepare(
    `INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at`,
  ).bind(user.id, await hashToken(normalizeCode(code)), ctx.now).run();
  return json({ recoveryCode: code });
});

// 退会: 自分だけのグループは削除し、他の家族がいるグループからは抜ける（ママ個人の記録は削除）
route('DELETE', '/api/me', async (ctx) => {
  const user = await currentUser(ctx);
  const { results } = await ctx.db.prepare('SELECT group_id, role FROM memberships WHERE user_id = ?').bind(user.id).all();
  for (const m of results) await checkCanLeave(ctx, m.group_id, user.id, m.role);
  for (const m of results) await leaveGroup(ctx, m.group_id, user.id);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM links WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
});

// ---------- 家族グループ・招待 ----------

route('GET', '/api/invites/:token', async (ctx) => {
  const inv = await findInvite(ctx, ctx.params.token);
  return json({ groupName: inv.group_name, role: inv.role, invitedBy: inv.inviter || '', expiresAt: inv.expires_at });
});

route('PATCH', '/api/groups/:gid', async (ctx) => {
  await membership(ctx, ctx.params.gid, ['admin']);
  const b = await body(ctx);
  await ctx.db.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(text(b.name, 30, 'group_name'), ctx.params.gid).run();
  return json({ ok: true });
});

route('GET', '/api/groups/:gid/members', async (ctx) => {
  await membership(ctx, ctx.params.gid);
  const { results } = await ctx.db.prepare(
    `SELECT m.user_id, u.display_name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ORDER BY m.created_at`,
  ).bind(ctx.params.gid).all();
  return json({ members: results.map((r) => ({ userId: r.user_id, displayName: r.display_name, role: r.role, joinedAt: r.created_at })) });
});

route('POST', '/api/groups/:gid/invites', async (ctx) => {
  const { user } = await membership(ctx, ctx.params.gid, ['admin']);
  const b = await body(ctx);
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'invalid role', 'invalid_role');
  const token = randomToken();
  await ctx.db.prepare(
    'INSERT INTO invites (token_hash, group_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(await hashToken(token), ctx.params.gid, b.role, user.id, ctx.now, ctx.now + INVITE_TTL).run();
  return json({ token, role: b.role, expiresAt: ctx.now + INVITE_TTL });
});

async function adminCount(ctx, groupId) {
  const r = await ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ? AND role = 'admin'").bind(groupId).first();
  return r.n;
}

async function memberCount(ctx, groupId) {
  const r = await ctx.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?').bind(groupId).first();
  return r.n;
}

async function checkCanLeave(ctx, groupId, userId, role) {
  if (role === 'admin' && (await adminCount(ctx, groupId)) === 1 && (await memberCount(ctx, groupId)) > 1) {
    throw new HttpError(409, 'last admin', 'last_admin');
  }
}

async function leaveGroup(ctx, groupId, userId) {
  if ((await memberCount(ctx, groupId)) <= 1) {
    await deleteGroup(ctx, groupId);
    return;
  }
  // 本人のママの記録・設定・リアクション・コメントは削除する（赤ちゃんの記録は家族のものとして残す）
  const personal = [...Object.keys(MOM_TYPES), ...SOCIAL_TYPES, ...SELF_TYPES];
  const { results } = await ctx.db.prepare(
    `SELECT type, id FROM records WHERE group_id = ? AND owner_id = ? AND deleted_at IS NULL
     AND type IN (${personal.map(() => '?').join(',')})`,
  ).bind(groupId, userId, ...personal).all();
  await tombstone(ctx, groupId, userId, results);
  await ctx.db.prepare('DELETE FROM memberships WHERE group_id = ? AND user_id = ?').bind(groupId, userId).run();
}

async function deleteGroup(ctx, groupId) {
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM records WHERE group_id = ?').bind(groupId),
    ctx.db.prepare('DELETE FROM invites WHERE group_id = ?').bind(groupId),
    ctx.db.prepare('DELETE FROM memberships WHERE group_id = ?').bind(groupId),
    ctx.db.prepare('DELETE FROM groups WHERE id = ?').bind(groupId),
  ]);
  let cursor;
  do {
    const list = await ctx.env.MEDIA.list({ prefix: `${groupId}/`, cursor });
    if (list.objects.length) await ctx.env.MEDIA.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

route('PATCH', '/api/groups/:gid/members/:uid', async (ctx) => {
  await membership(ctx, ctx.params.gid, ['admin']);
  const b = await body(ctx);
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'invalid role', 'invalid_role');
  const target = await ctx.db.prepare('SELECT role FROM memberships WHERE group_id = ? AND user_id = ?')
    .bind(ctx.params.gid, ctx.params.uid).first();
  if (!target) throw new HttpError(404, 'member not found', 'not_found');
  if (target.role === 'admin' && b.role !== 'admin' && (await adminCount(ctx, ctx.params.gid)) === 1) {
    throw new HttpError(409, 'last admin', 'last_admin');
  }
  await ctx.db.prepare('UPDATE memberships SET role = ? WHERE group_id = ? AND user_id = ?').bind(b.role, ctx.params.gid, ctx.params.uid).run();
  return json({ ok: true });
});

// メンバーの削除（管理者）・グループからの退出（本人）
route('DELETE', '/api/groups/:gid/members/:uid', async (ctx) => {
  const { user, role } = await membership(ctx, ctx.params.gid);
  const self = ctx.params.uid === user.id;
  if (!self && role !== 'admin') throw new HttpError(403, 'forbidden', 'forbidden');
  const target = await ctx.db.prepare('SELECT role FROM memberships WHERE group_id = ? AND user_id = ?')
    .bind(ctx.params.gid, ctx.params.uid).first();
  if (!target) throw new HttpError(404, 'member not found', 'not_found');
  await checkCanLeave(ctx, ctx.params.gid, ctx.params.uid, target.role);
  await leaveGroup(ctx, ctx.params.gid, ctx.params.uid);
  return json({ ok: true });
});

// 端末をすべてなくしたメンバー向けの再ログイン用リンク（管理者が発行）
route('POST', '/api/groups/:gid/members/:uid/relogin-link', async (ctx) => {
  const { user } = await membership(ctx, ctx.params.gid, ['admin']);
  const target = await ctx.db.prepare('SELECT 1 AS ok FROM memberships WHERE group_id = ? AND user_id = ?')
    .bind(ctx.params.gid, ctx.params.uid).first();
  if (!target) throw new HttpError(404, 'member not found', 'not_found');
  const token = await createLink(ctx, ctx.params.uid, 'relogin', user.id, RELOGIN_LINK_TTL);
  return json({ token, expiresAt: ctx.now + RELOGIN_LINK_TTL });
});

// ---------- 同期 ----------

async function allocSeq(ctx, groupId, n) {
  const row = await ctx.db.prepare('UPDATE groups SET seq = seq + ? WHERE id = ? RETURNING seq').bind(n, groupId).first();
  return row.seq - n + 1;
}

async function shareSettings(ctx, groupId) {
  const { results } = await ctx.db.prepare(
    "SELECT owner_id, data FROM records WHERE group_id = ? AND type = 'share' AND deleted_at IS NULL",
  ).bind(groupId).all();
  return new Map(results.map((r) => [r.owner_id, JSON.parse(r.data)]));
}

export function isVisible(row, userId, shares) {
  if (row.type === 'prefs') return row.owner_id === userId;
  const category = MOM_TYPES[row.type];
  if (!category || row.owner_id === userId) return true;
  return !row.private && !!shares.get(row.owner_id)?.[category];
}

route('GET', '/api/groups/:gid/sync', async (ctx) => {
  const { user } = await membership(ctx, ctx.params.gid);
  const since = Math.max(0, Number(ctx.url.searchParams.get('since')) || 0);
  const shares = await shareSettings(ctx, ctx.params.gid);
  const { results } = await ctx.db.prepare(
    'SELECT * FROM records WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  ).bind(ctx.params.gid, since, SYNC_PAGE).all();
  const records = results.map((r) => (r.deleted_at || !isVisible(r, user.id, shares)
    ? { type: r.type, id: r.id, deleted: true, seq: r.seq }
    : {
      type: r.type,
      id: r.id,
      data: JSON.parse(r.data),
      ownerId: r.owner_id,
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      seq: r.seq,
    }));
  const cursor = results.length ? results[results.length - 1].seq : since;
  return json({ records, cursor, more: results.length === SYNC_PAGE });
});

function canWrite(type, role, existing, userId, deleting) {
  if (BABY_TYPES.has(type)) return role !== 'viewer';
  if (MOM_TYPES[type]) return role !== 'viewer' && (!existing || existing.owner_id === userId);
  if (SOCIAL_TYPES.has(type)) {
    if (!existing || existing.owner_id === userId) return true;
    return type === 'comment' && deleting && role === 'admin';
  }
  return true; // prefs / share（id = 本人で確認済み）
}

async function tombstone(ctx, groupId, userId, rows) {
  if (!rows.length) return;
  const base = await allocSeq(ctx, groupId, rows.length);
  await ctx.db.batch(rows.map((r, i) => ctx.db.prepare(
    `UPDATE records SET data = '{}', deleted_at = ?, updated_at = ?, updated_by = ?, seq = ?
     WHERE group_id = ? AND type = ? AND id = ?`,
  ).bind(ctx.now, ctx.now, userId, base + i, groupId, r.type, r.id)));
}

route('POST', '/api/groups/:gid/sync', async (ctx) => {
  const { user, role } = await membership(ctx, ctx.params.gid);
  const gid = ctx.params.gid;
  const b = await body(ctx);
  const changes = Array.isArray(b.changes) ? b.changes.slice(0, 200) : [];
  const results = [];
  const writes = [];
  const mediaToDelete = [];
  let shareChanged = false;

  for (const c of changes) {
    const result = { type: c?.type, id: c?.id };
    results.push(result);
    if (!ALL_TYPES.has(c?.type) || !ID_RE.test(String(c?.id ?? ''))) {
      result.status = 'invalid';
      continue;
    }
    if (SELF_TYPES.has(c.type) && c.id !== user.id) {
      result.status = 'forbidden';
      continue;
    }
    const deleting = !!c.deleted;
    const data = deleting ? {} : c.data;
    const dataText = JSON.stringify(data ?? null);
    if (!deleting && (!data || typeof data !== 'object' || Array.isArray(data) || dataText.length > MAX_RECORD_BYTES)) {
      result.status = 'invalid';
      continue;
    }
    const existing = await ctx.db.prepare('SELECT owner_id, updated_at, deleted_at FROM records WHERE group_id = ? AND type = ? AND id = ?')
      .bind(gid, c.type, c.id).first();
    if (!canWrite(c.type, role, existing, user.id, deleting)) {
      result.status = 'forbidden';
      continue;
    }
    const updatedAt = Math.min(Number(c.updatedAt) || ctx.now, ctx.now);
    if (existing && existing.updated_at > updatedAt) {
      result.status = 'stale';
      continue;
    }
    if (deleting && (!existing || existing.deleted_at)) {
      result.status = 'ok';
      continue;
    }
    result.status = 'ok';
    writes.push({ c, deleting, dataText, updatedAt, owner: existing?.owner_id ?? user.id });
    if (c.type === 'media' && deleting) mediaToDelete.push(c.id);
    if (c.type === 'share') shareChanged = true;
  }

  if (writes.length) {
    const base = await allocSeq(ctx, gid, writes.length);
    await ctx.db.batch(writes.map((w, i) => ctx.db.prepare(
      `INSERT INTO records (group_id, type, id, owner_id, data, private, created_by, updated_by, created_at, updated_at, deleted_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, type, id) DO UPDATE SET data = excluded.data, private = excluded.private,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, seq = excluded.seq`,
    ).bind(
      gid, w.c.type, w.c.id, w.owner, w.dataText, w.c.type === 'journal' && w.c.data?.private ? 1 : 0,
      user.id, user.id, ctx.now, w.updatedAt, w.deleting ? ctx.now : null, base + i,
    )));
  }

  if (shareChanged) {
    // 共有設定が変わったら、家族の端末が表示・非表示を更新できるよう本人のママの記録を再送する
    const types = Object.keys(MOM_TYPES);
    const { results: rows } = await ctx.db.prepare(
      `SELECT type, id FROM records WHERE group_id = ? AND owner_id = ? AND deleted_at IS NULL
       AND type IN (${types.map(() => '?').join(',')})`,
    ).bind(gid, user.id, ...types).all();
    if (rows.length) {
      const base = await allocSeq(ctx, gid, rows.length);
      await ctx.db.batch(rows.map((r, i) => ctx.db.prepare('UPDATE records SET seq = ? WHERE group_id = ? AND type = ? AND id = ?')
        .bind(base + i, gid, r.type, r.id)));
    }
  }

  if (mediaToDelete.length) {
    await ctx.env.MEDIA.delete(mediaToDelete.flatMap((id) => [`${gid}/${id}/full`, `${gid}/${id}/thumb`]));
  }
  return json({ results });
});

// ---------- 写真 ----------

function mediaKey(ctx) {
  const { gid, id, size } = ctx.params;
  if (!ID_RE.test(id) || !['full', 'thumb'].includes(size)) throw new HttpError(400, 'invalid media', 'invalid_media');
  return `${gid}/${id}/${size}`;
}

route('PUT', '/api/groups/:gid/media/:id/:size', async (ctx) => {
  await membership(ctx, ctx.params.gid, ['admin', 'editor']);
  const key = mediaKey(ctx);
  const type = ctx.request.headers.get('content-type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new HttpError(415, 'unsupported media type', 'unsupported_media');
  const buf = await ctx.request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_MEDIA_BYTES) throw new HttpError(413, 'too large', 'too_large');
  await ctx.env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  return json({ ok: true, bytes: buf.byteLength });
});

route('GET', '/api/groups/:gid/media/:id/:size', async (ctx) => {
  await membership(ctx, ctx.params.gid);
  const obj = await ctx.env.MEDIA.get(mediaKey(ctx));
  if (!obj) throw new HttpError(404, 'not found', 'not_found');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
});
