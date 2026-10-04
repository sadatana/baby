// Web Push（プッシュ通知）の送信
//   - 通知の中身の暗号化: RFC 8291（aes128gcm）
//   - 送信元の証明: VAPID（RFC 8292、ES256 の JWT）
// 依存ライブラリなし（WebCrypto のみ）
import { b64url, fromB64url } from './util.js';

const enc = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// ---------- VAPID の鍵 ----------

// 新しい鍵を作る。{ publicKey: 非圧縮公開鍵（65 バイト）の base64url, privateKey: JWK }
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64url(raw), privateKey: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y } };
}

export async function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ---------- 通知の中身の暗号化（RFC 8291） ----------

export async function encryptPayload(payload, subscription, { salt = crypto.getRandomValues(new Uint8Array(16)), serverKeys } = {}) {
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  const pair = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 最後のレコードの区切り
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

// 1 件送る。戻り値: 'ok' | 'gone'（購読が無効になっている）| 'error'
export async function sendPush(subscription, payload, keys, subject, fetcher = fetch) {
  try {
    const body = await encryptPayload(JSON.stringify(payload), subscription);
    const res = await fetcher(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

// 購読先として受け付ける URL（主要ブラウザのプッシュサービスのみ。任意の URL へ送らないようにする）
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome・Android・Edge（一部）
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, // Safari・iPhone
  /\.notify\.windows\.com$/, // Edge（Windows）
];
export function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && endpoint.length <= 1000 && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
