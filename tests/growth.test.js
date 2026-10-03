import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../js/pregnancy.js';
import {
  ageOf, formatAge, periodOf, gestAtBirth, buildTimeline, groupByPeriod, exifDate, MILESTONE_TEMPLATES,
} from '../js/growth.js';
import {
  fetalEfwAt, fetalEfwSd, infantPercentilesAt, percentileBand, INFANT_PERCENTILES,
} from '../js/standards.js';
import { ticks, niceStep, lineChart } from '../js/charts.js';
import { mergeState, upsert, remove } from '../js/store.js';

const d = parseDate;

test('ageOf counts calendar months and days', () => {
  assert.deepEqual(
    (({ years, months, days, totalDays }) => ({ years, months, days, totalDays }))(ageOf(d('2026-01-15'), d('2026-03-10'))),
    { years: 0, months: 1, days: 23, totalDays: 54 },
  );
  assert.equal(ageOf(d('2026-01-15'), d('2026-01-14')), null);
  const a = ageOf(d('2026-01-31'), d('2026-03-01'));
  assert.equal(a.months, 1);
  assert.equal(a.days, 1);
  const y = ageOf(d('2025-05-20'), d('2026-07-20'));
  assert.equal(y.years, 1);
  assert.equal(y.months, 2);
  assert.equal(y.days, 0);
});

test('formatAge', () => {
  assert.equal(formatAge(ageOf(d('2026-01-15'), d('2026-01-15'))), '生後0日');
  assert.equal(formatAge(ageOf(d('2026-01-15'), d('2026-01-25'))), '生後10日');
  assert.equal(formatAge(ageOf(d('2026-01-15'), d('2026-03-15'))), '生後2ヶ月');
  assert.equal(formatAge(ageOf(d('2026-01-15'), d('2026-03-20'))), '生後2ヶ月5日');
  assert.equal(formatAge(ageOf(d('2025-01-15'), d('2026-04-01'))), '1歳2ヶ月');
});

test('periodOf switches from gestational week to age after birth', () => {
  const child = { dueDate: '2026-10-08', birthDate: '2026-10-01' };
  assert.equal(periodOf(child, '2026-03-01').label, '妊娠8週');
  assert.equal(periodOf(child, '2026-10-05').label, '生後0ヶ月');
  assert.equal(periodOf(child, '2026-12-05').label, '生後2ヶ月');
  assert.equal(periodOf(child, '2027-11-05').label, '1歳1ヶ月');
  assert.equal(periodOf({}, '2026-03-01').label, '2026年03月');
  assert.deepEqual(gestAtBirth(child), { week: 39, day: 0 });
});

test('timeline groups records, unattached photos and journal', () => {
  const s = mergeState({ profile: { dueDate: '2026-10-08' } });
  const id = s.children[0].id;
  s.children[0].birthDate = '2026-10-01';
  s.fetalRecords.push({ id: 'f1', childId: id, date: '2026-06-01', efwG: 900, photoIds: ['p1'] });
  s.growthRecords.push({ id: 'g1', childId: id, date: '2026-11-02', weightKg: 4.2, photoIds: [] });
  s.milestones.push({ id: 'm1', childId: id, date: '2026-05-01', title: '初めての胎動', templateId: 'first-kick' });
  s.media.push({ id: 'p1', childId: id, takenAt: '2026-06-01' }, { id: 'p2', childId: id, takenAt: '2026-11-02' },
    { id: 'p3', childId: 'other', takenAt: '2026-11-02' });
  s.journal.push({ id: 1, date: '2026-07-01', mood: '😊', text: 'hi' });
  const items = buildTimeline(s, id);
  assert.deepEqual(items.map((i) => i.kind), ['growth', 'photos', 'birth', 'journal', 'fetal', 'milestone']);
  assert.equal(items.find((i) => i.kind === 'photos').media.length, 1); // p1 は記録に添付、p3 は別の子
  assert.equal(buildTimeline(s, id, { includeJournal: false }).length, 5);
  const groups = groupByPeriod(s.children[0], items);
  assert.deepEqual(groups.map((g) => g.label), ['生後1ヶ月', '生後0ヶ月', '妊娠25週', '妊娠21週', '妊娠17週']);
});

test('milestone templates have unique ids', () => {
  const ids = MILESTONE_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

function jpegWithExif(dateStr, littleEndian = true) {
  // SOI + APP1(Exif) + IFD0(ExifIFD pointer) + ExifIFD(DateTimeOriginal)
  const tiff = new DataView(new ArrayBuffer(8 + 18 + 18 + 20));
  const le = littleEndian;
  tiff.setUint16(0, le ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, le);
  tiff.setUint32(4, 8, le);
  tiff.setUint16(8, 1, le); // IFD0: 1 entry
  tiff.setUint16(10, 0x8769, le);
  tiff.setUint16(12, 4, le);
  tiff.setUint32(14, 1, le);
  tiff.setUint32(18, 26, le);
  tiff.setUint16(26, 1, le); // Exif IFD
  tiff.setUint16(28, 0x9003, le);
  tiff.setUint16(30, 2, le);
  tiff.setUint32(32, 20, le);
  tiff.setUint32(36, 44, le);
  [...dateStr].forEach((c, i) => tiff.setUint8(44 + i, c.charCodeAt(0)));
  const app1Len = 2 + 6 + tiff.byteLength;
  const out = new Uint8Array(4 + app1Len + 2);
  out.set([0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  out.set(new Uint8Array(tiff.buffer), 12);
  out.set([0xff, 0xda], out.length - 2);
  return out.buffer;
}

test('exifDate reads DateTimeOriginal (both byte orders)', () => {
  assert.equal(exifDate(jpegWithExif('2026:05:04 10:20:30')), '2026-05-04');
  assert.equal(exifDate(jpegWithExif('2026:05:04 10:20:30', false)), '2026-05-04');
  assert.equal(exifDate(jpegWithExif('0000:00:00 00:00:00')), null);
  assert.equal(exifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), null);
  assert.equal(exifDate(new ArrayBuffer(1)), null);
});

test('fetal EFW standard interpolation', () => {
  const at18 = fetalEfwAt(18);
  assert.equal(at18.mean, 187);
  assert.equal(Math.round(at18.sd * 10) / 10, 30.3);
  const at21 = fetalEfwAt(21);
  assert.equal(at21.mean, (313 + 469) / 2);
  assert.ok(at21.low < at21.mean && at21.mean < at21.high);
  assert.equal(fetalEfwAt(17), null);
  assert.equal(fetalEfwAt(41), null);
  assert.equal(fetalEfwSd(40, 3125), 0);
});

test('infant percentiles use WHO standards (0-36 months)', () => {
  const birth = infantPercentilesAt('weight', 'male', 0);
  assert.equal(birth[3], 3.35); // WHO 男児 出生時 体重中央値 3.3kg
  assert.equal(infantPercentilesAt('length', 'female', 12)[3], 74); // WHO 女児 12ヶ月 身長中央値 74.0cm
  assert.equal(infantPercentilesAt('head', 'male', 36)[3], 49.46);
  assert.equal(infantPercentilesAt('weight', 'male', 37), null);
  for (const key of ['weight', 'length', 'head']) {
    for (const sex of ['male', 'female']) {
      assert.equal(INFANT_PERCENTILES[key][sex].length, 37);
      for (const row of INFANT_PERCENTILES[key][sex]) {
        assert.ok(row.p.every((v, i) => i === 0 || v > row.p[i - 1]), `${key} ${sex} ${row.month}`);
      }
    }
  }
  assert.equal(percentileBand('weight', 'female', 0, 3.23), '50〜75');
});

test('infant percentiles interpolate a registered table', () => {
  const saved = INFANT_PERCENTILES.weight.male;
  INFANT_PERCENTILES.weight.male = [
    { month: 0, p: [2, 2.5, 2.8, 3, 3.2, 3.5, 4] },
    { month: 2, p: [4, 4.5, 4.8, 5, 5.2, 5.5, 6] },
  ];
  try {
    assert.deepEqual(infantPercentilesAt('weight', 'male', 1), [3, 3.5, 3.8, 4, 4.2, 4.5, 5]);
    assert.equal(percentileBand('weight', 'male', 1, 4.1), '50〜75');
    assert.equal(percentileBand('weight', 'male', 1, 2), '3未満');
    assert.equal(percentileBand('weight', 'male', 1, 9), '97以上');
    assert.equal(infantPercentilesAt('weight', 'male', 3), null);
  } finally {
    INFANT_PERCENTILES.weight.male = saved;
  }
});

test('chart ticks and svg output', () => {
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(3000, 5), 1000);
  assert.deepEqual(ticks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  const svg = lineChart({
    label: 'a<b', xRange: [0, 10], yRange: [0, 100],
    series: [{ pts: [[1, 10, 'x&y'], [5, 50]] }],
    bands: [{ lower: [[0, 0], [10, 10]], upper: [[0, 20], [10, 30]] }],
  });
  assert.match(svg, /aria-label="a&lt;b"/);
  assert.match(svg, /<title>x&amp;y<\/title>/);
  assert.equal((svg.match(/class="dot"/g) || []).length, 2);
});

test('store migrates v1 profile into first child and tracks deletes', () => {
  const s = mergeState({ profile: { dueDate: '2026-10-08', babyName: 'まめ', heightCm: 158, preWeightKg: 50 } });
  assert.equal(s.version, 2);
  assert.equal(s.children[0].name, 'まめ');
  assert.equal(s.activeChildId, s.children[0].id);
  assert.deepEqual(s.profile, { heightCm: 158, preWeightKg: 50 });
  const again = mergeState(JSON.parse(JSON.stringify(s)));
  assert.equal(again.children[0].id, s.children[0].id);

  const r = upsert(s.growthRecords, { childId: s.children[0].id, date: '2026-11-01', weightKg: 4 });
  assert.ok(r.id && r.createdAt);
  upsert(s.growthRecords, { id: r.id, weightKg: 4.1 });
  assert.equal(s.growthRecords.length, 1);
  assert.equal(s.growthRecords[0].weightKg, 4.1);
  remove(s, 'growthRecords', r.id);
  assert.equal(s.growthRecords.length, 0);
  assert.equal(s.deleted[0].id, r.id);
});
