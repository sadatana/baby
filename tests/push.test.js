// プッシュ通知のテスト: 受け取る側（ブラウザ）と同じ手順で復号し、内容と署名を確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, generateVapidKeys, vapidAuthorization, validEndpoint } from '../worker/push.js';
import { fromB64url } from '../worker/util.js';
import { fakeBrowserSubscription, decrypt, verifyVapid } from './helpers/push.js';

test('payload encryption can be decrypted by the browser side (RFC 8291)', async () => {
  const sub = await fakeBrowserSubscription();
  const body = await encryptPayload('{"title":"すくすくノート"}', sub.keys);
  assert.equal(await decrypt(body, sub), '{"title":"すくすくノート"}');
});

test('VAPID JWT is signed with the server key', async () => {
  const keys = await generateVapidKeys();
  assert.equal(fromB64url(keys.publicKey).length, 65);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  const claims = await verifyVapid(await vapidAuthorization(endpoint, keys, 'mailto:a@example.com'), keys.publicKey, endpoint);
  assert.equal(claims.sub, 'mailto:a@example.com');
});

test('only https push endpoints are accepted', () => {
  assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(validEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(validEndpoint('https://evil.example.com/x'), false);
  assert.equal(validEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  assert.equal(validEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(validEndpoint('https://localhost/x'), false);
  assert.equal(validEndpoint('not a url'), false);
});
