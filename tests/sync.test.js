import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectChanges, applyRemote, canPush, newAccount, serialize } from '../public/js/sync.js';
import { defaultState } from '../public/js/store.js';

const me = { user: { id: 'u1', displayName: 'ママ' }, groups: [{ id: 'g1', name: '家族', role: 'admin' }] };

test('first collect pushes every local record, then only changes', () => {
  const s = defaultState();
  s.fetalRecords.push({ id: 'f1', childId: s.children[0].id, date: '2026-09-01', efwG: 1500, updatedAt: 100 });
  s.weights.push({ id: 'w1', date: '2026-09-01', kg: 55 });
  const a = newAccount(me, me.groups[0]);
  collectChanges(s, a, 999);
  const keys = Object.keys(a.outbox).sort();
  assert.deepEqual(keys, ['child:' + s.children[0].id, 'fetal:f1', 'prefs:u1', 'weight:w1'].sort());
  assert.equal(a.outbox['fetal:f1'].updatedAt, 100);
  assert.equal(a.outbox['weight:w1'].updatedAt, 999);

  a.outbox = {};
  assert.equal(collectChanges(s, a), 0);
  s.fetalRecords[0].efwG = 1550;
  s.weights = [];
  collectChanges(s, a, 1000);
  assert.equal(a.outbox['fetal:f1'].data.efwG, 1550);
  assert.deepEqual(a.outbox['weight:w1'], { type: 'weight', id: 'w1', deleted: true, updatedAt: 1000 });
});

test('remote records are applied without echoing back', () => {
  const s = defaultState();
  s.children = [];
  const a = newAccount(me, me.groups[0]);
  const { changed } = applyRemote(s, a, [
    { type: 'child', id: 'c1', data: { id: 'c1', name: 'まめ' }, ownerId: 'u2', updatedBy: 'u2' },
    { type: 'weight', id: 'w9', data: { id: 'w9', date: '2026-09-01', kg: 60 }, ownerId: 'u2' },
    { type: 'prefs', id: 'u1', data: { profile: { heightCm: 160 }, checks: { a: true }, checkups: {} } },
    { type: 'prefs', id: 'u2', data: { profile: { heightCm: 999 } } },
  ]);
  assert.ok(changed);
  assert.equal(s.children[0].name, 'まめ');
  assert.equal(s.children[0].ownerId, 'u2');
  assert.equal(s.profile.heightCm, 160);
  assert.equal(collectChanges(s, a), 0, 'nothing to push after applying remote data');

  // 削除
  const r = applyRemote(s, a, [{ type: 'media', id: 'm1', deleted: true }, { type: 'child', id: 'c1', deleted: true }]);
  assert.equal(s.children.length, 0);
  assert.deepEqual(r.removedMedia, []);
  assert.equal(collectChanges(s, a), 0);
});

test('pending local edits win over incoming remote data', () => {
  const s = defaultState();
  const a = newAccount(me, me.groups[0]);
  s.growthRecords.push({ id: 'g1', date: '2026-10-01', weightKg: 4 });
  collectChanges(s, a);
  applyRemote(s, a, [{ type: 'growth', id: 'g1', data: { id: 'g1', date: '2026-10-01', weightKg: 3 }, ownerId: 'u2' }]);
  assert.equal(s.growthRecords[0].weightKg, 4);
});

test("others' mom records and viewer writes are not pushed", () => {
  const s = defaultState();
  const viewer = newAccount({ ...me, groups: [{ id: 'g1', name: '家族', role: 'viewer' }] }, { id: 'g1', name: '家族', role: 'viewer' });
  applyRemote(s, viewer, [{ type: 'weight', id: 'w1', data: { id: 'w1', kg: 55 }, ownerId: 'u2' }]);
  s.weights = [];
  s.fetalRecords.push({ id: 'f1', date: '2026-09-01' });
  s.reactions.push({ id: 'u1.f1.0', targetId: 'f1', emoji: '❤️' });
  collectChanges(s, viewer);
  const keys = Object.keys(viewer.outbox);
  assert.ok(keys.includes('reaction:u1.f1.0'));
  assert.ok(keys.includes(`prefs:u1`));
  assert.ok(!keys.some((k) => k.startsWith('fetal:') || k.startsWith('weight:') || k.startsWith('child:')));
  assert.equal(viewer.needsResync, true);
});

test('canPush rules', () => {
  const admin = { userId: 'u1', role: 'admin' };
  const editor = { userId: 'u1', role: 'editor' };
  assert.equal(canPush(editor, 'fetal', 'x', 'u2', false), true);
  assert.equal(canPush(editor, 'weight', 'x', 'u2', false), false);
  assert.equal(canPush(editor, 'weight', 'x', '', false), true);
  assert.equal(canPush(editor, 'comment', 'x', 'u2', true), false);
  assert.equal(canPush(admin, 'comment', 'x', 'u2', true), true);
  assert.equal(canPush(admin, 'share', 'u2', '', false), false);
  assert.equal(serialize(defaultState(), null).has('prefs:null'), false);
});
