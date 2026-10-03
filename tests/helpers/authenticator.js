// テスト用のソフトウェア認証器（パスキー）。本物と同じ形式のデータと署名を作る
import { b64url, fromB64url, sha256 } from '../../worker/util.js';

const enc = new TextEncoder();

export function encodeCbor(v) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  };
  const item = (x) => {
    if (typeof x === 'number') {
      if (x >= 0) head(0, x);
      else head(1, -1 - x);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      out.push(...x);
    } else if (typeof x === 'string') {
      const b = enc.encode(x);
      head(3, b.length);
      out.push(...b);
    } else if (Array.isArray(x)) {
      head(4, x.length);
      x.forEach(item);
    } else {
      const entries = x instanceof Map ? [...x] : Object.entries(x);
      head(5, entries.length);
      for (const [k, val] of entries) {
        item(k);
        item(val);
      }
    }
  };
  item(v);
  return new Uint8Array(out);
}

function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export class Authenticator {
  constructor() {
    this.credentials = []; // { id, keyPair, userHandle, counter }
  }

  async create(options, origin, { counterStart = 0 } = {}) {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(16));
    const cose = encodeCbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
    const rpIdHash = await sha256(options.rp.id);
    const authData = new Uint8Array([
      ...rpIdHash, 0x45, 0, 0, 0, counterStart, ...new Uint8Array(16), 0, id.length, ...id, ...cose,
    ]);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    const attestationObject = encodeCbor({ fmt: 'none', attStmt: {}, authData });
    const cred = { id: b64url(id), keyPair, userHandle: options.user.id, counter: counterStart, rpId: options.rp.id };
    this.credentials.push(cred);
    return {
      id: cred.id,
      rawId: cred.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) },
    };
  }

  async get(options, origin, { index = this.credentials.length - 1, counter } = {}) {
    const cred = this.credentials[index];
    cred.counter = counter ?? cred.counter + 1;
    const c = cred.counter;
    const authData = new Uint8Array([...(await sha256(options.rpId)), 0x05, (c >>> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const signed = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.keyPair.privateKey, signed));
    return {
      id: cred.id,
      rawId: cred.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(raw)),
        userHandle: cred.userHandle,
      },
    };
  }
}
