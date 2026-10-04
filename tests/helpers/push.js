// プッシュ通知のテスト用: ブラウザ（受け取る側）と同じ手順で復号・署名確認をする
import assert from 'node:assert/strict';
import { b64url, fromB64url } from '../../worker/util.js';

const enc = new TextEncoder();

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// ブラウザ側の購読（鍵の組と auth）
export async function fakeBrowserSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, keys: { p256dh: b64url(pub), auth: b64url(auth) }, pair };
}

// RFC 8291 の復号（ブラウザが行う処理）
export async function decrypt(body, sub) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  assert.equal(rs, 4096);
  const uaPublic = fromB64url(sub.keys.p256dh);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.pair.privateKey, 256));
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(fromB64url(sub.keys.auth), shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, 'last record delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

export async function verifyVapid(header, publicKey, endpoint) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[4], publicKey);
  const key = await crypto.subtle.importKey('raw', fromB64url(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(m[3]), enc.encode(`${m[1]}.${m[2]}`));
  assert.ok(ok, 'VAPID signature');
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp * 1000 > Date.now());
  return claims;
}
