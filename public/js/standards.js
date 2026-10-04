// 成長曲線の標準値データと補間（DOM非依存）
// ※標準値は「目安」です。アプリ内では診断的な表現（正常・異常）はしません。
import { WHO_PERCENTILES } from './who-percentiles.js';

// ---------- 胎児の推定体重（EFW） ----------
// 出典: 日本産科婦人科学会「胎児体重の妊娠週数ごとの基準値」（日本超音波医学会 2003 年の基準に基づく）
// [妊娠週数, -2.0SD, 平均, +2.0SD]（g）。照合の記録と新基準（JSUM2025）については docs/reference-values.md
export const FETAL_EFW_SOURCE = '日本産科婦人科学会「胎児体重の妊娠週数ごとの基準値」';
const FETAL_EFW_TABLE = [
  [18, 126, 187, 247],
  [20, 210, 313, 416],
  [22, 320, 469, 618],
  [24, 461, 660, 859],
  [26, 639, 892, 1145],
  [28, 853, 1163, 1473],
  [30, 1098, 1470, 1842],
  [32, 1368, 1805, 2242],
  [34, 1649, 2156, 2663],
  [36, 1927, 2507, 3087],
  [38, 2181, 2838, 3495],
  [40, 2388, 3125, 3862],
];

export const FETAL_EFW_RANGE = [FETAL_EFW_TABLE[0][0], FETAL_EFW_TABLE[FETAL_EFW_TABLE.length - 1][0]];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 表 rows（x 昇順）から x の位置の値を線形補間する。範囲外は null
function interpolate(rows, x, pick) {
  if (!rows.length || x < rows[0][0] || x > rows[rows.length - 1][0]) return null;
  for (let i = 0; i < rows.length - 1; i++) {
    const [x0] = rows[i];
    const [x1] = rows[i + 1];
    if (x >= x0 && x <= x1) return lerp(pick(rows[i]), pick(rows[i + 1]), (x - x0) / (x1 - x0));
  }
  return pick(rows[rows.length - 1]);
}

// 妊娠週数（小数可）における推定体重の平均と SD（g）
export function fetalEfwAt(week) {
  const mean = interpolate(FETAL_EFW_TABLE, week, (r) => r[2]);
  if (mean == null) return null;
  const sd = interpolate(FETAL_EFW_TABLE, week, (r) => (r[3] - r[1]) / 4);
  return { mean, sd, low: mean - 1.5 * sd, high: mean + 1.5 * sd };
}

// 推定体重が平均から何 SD 離れているか
export function fetalEfwSd(week, grams) {
  const ref = fetalEfwAt(week);
  if (!ref || !(grams > 0)) return null;
  return (grams - ref.mean) / ref.sd;
}

// ---------- 出生後の発育曲線（パーセンタイル） ----------
// 形式: INFANT_PERCENTILES[指標][性別] = [{ month, p: [3, 10, 25, 50, 75, 90, 97 パーセンタイル値] }, ...]
//   指標: weight (kg) / length (cm) / head (cm)、性別: male / female
// 現在は WHO Child Growth Standards（0〜36ヶ月）を使用。同じ形式の表に差し替えれば、
// 日本の「乳幼児身体発育調査」などの基準にも切り替えられる。
// ※WHO の身長は 24ヶ月未満が寝かせて測る「身長（仰臥位）」、24ヶ月以降が立って測る値（約0.7cm 低い）。
export const PERCENTILES = [3, 10, 25, 50, 75, 90, 97];
export const INFANT_SOURCE = 'WHO Child Growth Standards（世界保健機関の国際基準）';
export const INFANT_PERCENTILES = {
  weight: { male: WHO_PERCENTILES.weight.male, female: WHO_PERCENTILES.weight.female },
  length: { male: WHO_PERCENTILES.length.male, female: WHO_PERCENTILES.length.female },
  head: { male: WHO_PERCENTILES.head.male, female: WHO_PERCENTILES.head.female },
};

export function hasInfantStandard(indicator, sex) {
  return (INFANT_PERCENTILES[indicator]?.[sex]?.length ?? 0) > 1;
}

// 月齢（小数可）における各パーセンタイル値。データがない・範囲外なら null
export function infantPercentilesAt(indicator, sex, month) {
  const rows = (INFANT_PERCENTILES[indicator]?.[sex] ?? []).map((r) => [r.month, r.p]);
  if (rows.length < 2) return null;
  const out = PERCENTILES.map((_, i) => interpolate(rows, month, (r) => r[1][i]));
  return out[0] == null ? null : out;
}

// 計測値がどのパーセンタイルの帯にあるか（例: "25〜50"）。データがなければ null
export function percentileBand(indicator, sex, month, value) {
  const ps = infantPercentilesAt(indicator, sex, month);
  if (!ps || !(value > 0)) return null;
  if (value < ps[0]) return `${PERCENTILES[0]}未満`;
  for (let i = 0; i < ps.length - 1; i++) {
    if (value < ps[i + 1]) return `${PERCENTILES[i]}〜${PERCENTILES[i + 1]}`;
  }
  return `${PERCENTILES[PERCENTILES.length - 1]}以上`;
}

export function infantMonthRange(indicator, sex) {
  const rows = INFANT_PERCENTILES[indicator]?.[sex] ?? [];
  return rows.length ? [rows[0].month, rows[rows.length - 1].month] : null;
}
