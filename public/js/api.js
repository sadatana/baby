// サーバー（Cloudflare Workers）の API とパスキー（WebAuthn）の呼び出し

export class ApiError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error);
  return data;
}

let healthy;
// サーバーが使えるか（GitHub Pages などで静的ファイルだけを配信している場合は使えない）
export async function available() {
  healthy ??= request('GET', '/api/health').then((r) => !!r.ok).catch(() => false);
  return healthy;
}

export function passkeySupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

// ---------- base64url ⇔ ArrayBuffer ----------

function toB64url(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

function credentialToJSON(cred) {
  const r = cred.response;
  const response = { clientDataJSON: toB64url(r.clientDataJSON) };
  if (r.attestationObject) response.attestationObject = toB64url(r.attestationObject);
  if (r.authenticatorData) response.authenticatorData = toB64url(r.authenticatorData);
  if (r.signature) response.signature = toB64url(r.signature);
  if (r.userHandle) response.userHandle = toB64url(r.userHandle);
  return { id: cred.id, rawId: toB64url(cred.rawId), type: cred.type, response };
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'ブラウザ';
}

// パスキーを作成して登録する。intent: { type: 'new' | 'invite' | 'link', token? }
export async function registerPasskey(intent, { displayName, groupName } = {}) {
  const { challengeId, options } = await request('POST', '/api/auth/register/options', { intent, displayName });
  const publicKey = {
    ...options,
    challenge: fromB64url(options.challenge),
    user: { ...options.user, id: fromB64url(options.user.id) },
    excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: fromB64url(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return request('POST', '/api/auth/register/verify', {
    challengeId, credential: credentialToJSON(cred), deviceName: deviceName(), groupName,
  });
}

export async function loginPasskey() {
  const { challengeId, options } = await request('POST', '/api/auth/login/options', {});
  const cred = await navigator.credentials.get({ publicKey: { ...options, challenge: fromB64url(options.challenge) } });
  return request('POST', '/api/auth/login/verify', { challengeId, credential: credentialToJSON(cred) });
}

// ---------- アカウント・グループ ----------

export const me = () => request('GET', '/api/me');
export const updateMe = (displayName) => request('PATCH', '/api/me', { displayName });
export const logout = () => request('POST', '/api/auth/logout', {});
export const deleteMe = () => request('DELETE', '/api/me');
export const deviceLink = () => request('POST', '/api/me/device-link', {});
export const newRecoveryCode = () => request('POST', '/api/me/recovery-code', {});
export const recover = (code) => request('POST', '/api/auth/recover', { code });
export const inviteInfo = (token) => request('GET', `/api/invites/${encodeURIComponent(token)}`);
export const members = (gid) => request('GET', `/api/groups/${gid}/members`);
export const createInvite = (gid, role) => request('POST', `/api/groups/${gid}/invites`, { role });
export const renameGroup = (gid, name) => request('PATCH', `/api/groups/${gid}`, { name });
export const setRole = (gid, uid, role) => request('PATCH', `/api/groups/${gid}/members/${uid}`, { role });
export const removeMember = (gid, uid) => request('DELETE', `/api/groups/${gid}/members/${uid}`);
export const reloginLink = (gid, uid) => request('POST', `/api/groups/${gid}/members/${uid}/relogin-link`, {});

// ---------- 同期・写真 ----------

export const pullChanges = (gid, since) => request('GET', `/api/groups/${gid}/sync?since=${since}`);
export const pushChanges = (gid, changes) => request('POST', `/api/groups/${gid}/sync`, { changes });

export function uploadMedia(gid, id, size, blob) {
  return request('PUT', `/api/groups/${gid}/media/${encodeURIComponent(id)}/${size}`, blob, {
    headers: { 'content-type': blob.type || 'image/jpeg' },
  });
}

export async function fetchMedia(gid, id, size) {
  const res = await request('GET', `/api/groups/${gid}/media/${encodeURIComponent(id)}/${size}`, undefined, { raw: true });
  return res.blob();
}

// ---------- プッシュ通知 ----------

export const pushKey = () => request('GET', '/api/push/key');
export const pushSubscribe = (sub) => request('POST', '/api/push/subscribe', sub);
export const pushUnsubscribe = (endpoint) => request('DELETE', '/api/push/subscribe', { endpoint });
