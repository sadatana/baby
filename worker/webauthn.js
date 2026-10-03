// パスキー（WebAuthn）の検証。attestation は "none" を前提に、署名と各種値の検証を行う
import { fromB64url, sha256, equalBytes, b64url, HttpError } from './util.js';

const dec = new TextDecoder();

// ---------- CBOR（WebAuthn で使う範囲のみ） ----------

export function decodeCbor(bytes, start = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;

  const readLength = (info) => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(pos++);
    if (info === 25) { const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      const hi = view.getUint32(pos);
      const lo = view.getUint32(pos + 4);
      pos += 8;
      if (hi > 0x1fffff) throw new Error('cbor: integer too large');
      return hi * 2 ** 32 + lo;
    }
    throw new Error('cbor: indefinite length is not supported');
  };

  const item = (depth) => {
    if (depth > 16) throw new Error('cbor: too deep');
    if (pos >= bytes.length) throw new Error('cbor: unexpected end');
    const head = view.getUint8(pos++);
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0: return readLength(info);
      case 1: return -1 - readLength(info);
      case 2: {
        const len = readLength(info);
        if (pos + len > bytes.length) throw new Error('cbor: bytes overflow');
        const v = bytes.slice(pos, pos + len);
        pos += len;
        return v;
      }
      case 3: {
        const len = readLength(info);
        if (pos + len > bytes.length) throw new Error('cbor: text overflow');
        const v = dec.decode(bytes.subarray(pos, pos + len));
        pos += len;
        return v;
      }
      case 4: {
        const len = readLength(info);
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const len = readLength(info);
        const map = new Map();
        for (let i = 0; i < len; i++) {
          const k = item(depth + 1);
          map.set(k, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor: unsupported simple value');
      default:
        throw new Error('cbor: unsupported major type');
    }
  };

  const value = item(0);
  return { value, end: pos };
}

// ---------- authenticatorData ----------

export function parseAuthData(bytes) {
  if (bytes.length < 37) throw new HttpError(400, 'authenticatorData too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32];
  const out = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    signCount: view.getUint32(33),
  };
  if (flags & 0x40) {
    const idLen = view.getUint16(53);
    out.credentialId = bytes.slice(55, 55 + idLen);
    const { value } = decodeCbor(bytes, 55 + idLen);
    out.publicKey = value;
  }
  return out;
}

// COSE 公開鍵 → JWK（ES256 / RS256）
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new HttpError(400, 'invalid public key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (kty === 3 && alg === -257) {
    return { alg: -257, jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)), alg: 'RS256' } };
  }
  throw new HttpError(400, 'unsupported key type');
}

// ECDSA 署名（DER）→ WebCrypto 用の raw (r||s)
export function derToRaw(der) {
  if (der[0] !== 0x30) throw new HttpError(400, 'invalid signature');
  let pos = 2;
  if (der[1] & 0x80) pos = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[pos] !== 0x02) throw new HttpError(400, 'invalid signature');
    const len = der[pos + 1];
    let v = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new HttpError(400, 'invalid signature');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

function checkClientData(clientDataBytes, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(dec.decode(clientDataBytes));
  } catch {
    throw new HttpError(400, 'invalid clientDataJSON');
  }
  if (data.type !== type) throw new HttpError(400, 'unexpected ceremony type');
  if (data.challenge !== challenge) throw new HttpError(400, 'challenge mismatch');
  if (data.origin !== origin) throw new HttpError(400, 'origin mismatch');
  return data;
}

async function checkRpId(authData, rpId) {
  if (!equalBytes(authData.rpIdHash, await sha256(rpId))) throw new HttpError(400, 'rpId mismatch');
  if (!authData.userPresent) throw new HttpError(400, 'user not present');
}

// 登録（navigator.credentials.create の結果）の検証
export async function verifyRegistration(credential, { challenge, origin, rpId }) {
  const clientData = fromB64url(credential?.response?.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.create', challenge, origin });
  let att;
  try {
    att = decodeCbor(fromB64url(credential.response.attestationObject)).value;
  } catch {
    throw new HttpError(400, 'invalid attestationObject');
  }
  if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array)) throw new HttpError(400, 'invalid attestationObject');
  const authData = parseAuthData(att.get('authData'));
  await checkRpId(authData, rpId);
  if (!authData.credentialId || !authData.publicKey) throw new HttpError(400, 'no credential data');
  const credentialId = b64url(authData.credentialId);
  if (credential.id && credential.id !== credentialId) throw new HttpError(400, 'credential id mismatch');
  const { alg, jwk } = coseToJwk(authData.publicKey);
  // 鍵として読み込めることを確認しておく
  await importKey(alg, jwk);
  return { credentialId, alg, jwk, signCount: authData.signCount };
}

function importKey(alg, jwk) {
  if (alg === -7) return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (alg === -257) return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  throw new HttpError(400, 'unsupported algorithm');
}

// ログイン（navigator.credentials.get の結果）の検証
export async function verifyAuthentication(credential, { challenge, origin, rpId, passkey }) {
  const clientData = fromB64url(credential?.response?.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  const authBytes = fromB64url(credential.response.authenticatorData);
  const authData = parseAuthData(authBytes);
  await checkRpId(authData, rpId);
  const signed = new Uint8Array(authBytes.length + 32);
  signed.set(authBytes);
  signed.set(await sha256(clientData), authBytes.length);
  let sig = fromB64url(credential.response.signature);
  const key = await importKey(passkey.alg, passkey.jwk);
  let ok;
  if (passkey.alg === -7) {
    sig = derToRaw(sig);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed);
  } else {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
  }
  if (!ok) throw new HttpError(401, 'invalid signature');
  // 署名回数が戻っている場合は複製された認証器の可能性がある（0 のままの認証器は許可）
  if ((authData.signCount !== 0 || passkey.signCount !== 0) && authData.signCount <= passkey.signCount) {
    throw new HttpError(401, 'signature counter did not increase');
  }
  return { signCount: authData.signCount };
}
