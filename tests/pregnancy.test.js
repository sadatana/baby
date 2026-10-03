import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, formatDate, dueDateFromLmp, lmpFromDueDate, gestationalAge,
  trimesterOf, monthOf, checkupSchedule, nextCheckup, contractionStats,
  formatDuration, weightGainGuide,
} from '../js/pregnancy.js';
import { WEEKS, weekInfo } from '../js/data.js';
import { mergeState, defaultState } from '../js/store.js';

test('parseDate rejects invalid dates', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026/01/01'), null);
  assert.equal(parseDate(''), null);
  assert.equal(formatDate(parseDate('2026-01-05')), '2026-01-05');
});

test('due date is LMP + 280 days (Naegele)', () => {
  assert.equal(formatDate(dueDateFromLmp(parseDate('2026-01-01'))), '2026-10-08');
  assert.equal(formatDate(lmpFromDueDate(parseDate('2026-10-08'))), '2026-01-01');
  // うるう年をまたぐ
  assert.equal(formatDate(dueDateFromLmp(parseDate('2027-06-01'))), '2028-03-07');
});

test('gestational age in weeks and days', () => {
  const due = parseDate('2026-10-08');
  const ga = gestationalAge(due, parseDate('2026-03-01'));
  assert.equal(ga.totalDays, 59);
  assert.equal(ga.week, 8);
  assert.equal(ga.day, 3);
  assert.equal(ga.daysLeft, 221);
  assert.equal(ga.trimester.index, 1);

  const onDue = gestationalAge(due, due);
  assert.equal(onDue.week, 40);
  assert.equal(onDue.day, 0);
  assert.equal(onDue.daysLeft, 0);
  assert.equal(onDue.progress, 1);
  assert.equal(onDue.isFullTerm, true);

  const before = gestationalAge(due, parseDate('2025-12-25'));
  assert.equal(before.notStarted, true);
  assert.equal(before.progress, 0);
});

test('trimester and month boundaries', () => {
  assert.equal(trimesterOf(15).index, 1);
  assert.equal(trimesterOf(16).index, 2);
  assert.equal(trimesterOf(27).index, 2);
  assert.equal(trimesterOf(28).index, 3);
  assert.equal(monthOf(0), 1);
  assert.equal(monthOf(3), 1);
  assert.equal(monthOf(4), 2);
  assert.equal(monthOf(36), 10);
  assert.equal(monthOf(41), 10);
});

test('checkup schedule follows standard intervals', () => {
  const due = parseDate('2026-10-08');
  const weeks = checkupSchedule(due).map((c) => c.week);
  assert.deepEqual(weeks, [8, 12, 16, 20, 24, 26, 28, 30, 32, 34, 36, 37, 38, 39, 40]);
  const next = nextCheckup(due, parseDate('2026-03-01')); // 8週3日
  assert.equal(next.week, 12);
  assert.equal(nextCheckup(due, parseDate('2026-12-01')), null);
});

test('contraction stats', () => {
  const min = 60 * 1000;
  const list = [
    { start: 0, end: 45 * 1000 },
    { start: 10 * min, end: 10 * min + 60 * 1000 },
    { start: 18 * min, end: null },
  ];
  const s = contractionStats(list);
  assert.equal(s.count, 3);
  assert.equal(s.avgDurationSec, 52.5);
  assert.equal(s.avgIntervalSec, 9 * 60);
  assert.equal(contractionStats([]).avgIntervalSec, null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(5), '5秒');
  assert.equal(formatDuration(65), '1分05秒');
  assert.equal(formatDuration(null), '--');
});

test('weight gain guide by pre-pregnancy BMI', () => {
  assert.deepEqual(weightGainGuide(160, 45).range, [12, 15]);
  assert.deepEqual(weightGainGuide(160, 55).range, [10, 13]);
  assert.deepEqual(weightGainGuide(160, 70).range, [7, 10]);
  assert.equal(weightGainGuide(160, 80).range, null);
  assert.equal(weightGainGuide(null, 50), null);
});

test('weekly content exists for weeks 4-41', () => {
  for (let w = 4; w <= 41; w++) {
    const info = WEEKS[w];
    assert.ok(info, `week ${w}`);
    for (const k of ['size', 'emoji', 'length', 'weight', 'baby', 'mom', 'tip']) {
      assert.ok(info[k], `week ${w} ${k}`);
    }
  }
  assert.equal(weekInfo(2).week, 4);
  assert.equal(weekInfo(45).week, 41);
});

test('mergeState fills missing fields', () => {
  const s = mergeState({ profile: { dueDate: '2026-10-08', heightCm: 160 }, weights: 'bad' });
  assert.equal(s.children[0].dueDate, '2026-10-08');
  assert.equal(s.profile.heightCm, 160);
  assert.deepEqual(s.weights, []);
  const empty = mergeState(null);
  const def = defaultState();
  assert.equal(empty.children.length, 1);
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(def).sort());
});
