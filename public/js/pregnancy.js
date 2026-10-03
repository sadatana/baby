// 妊娠週数・予定日・健診スケジュールなどの計算ロジック（DOM非依存）

export const PREGNANCY_DAYS = 280; // 最終月経開始日から出産予定日までの日数（40週0日）
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" をタイムゾーンの影響を受けない UTC 日付として扱う
export function parseDate(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

export function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateJa(date) {
  const w = ['日', '月', '火', '水', '木', '金', '土'][date.getUTCDay()];
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日(${w})`;
}

// ローカル時刻の「今日」を UTC 日付として返す
export function today(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function diffDays(a, b) {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

export function dueDateFromLmp(lmp) {
  return addDays(lmp, PREGNANCY_DAYS);
}

export function lmpFromDueDate(due) {
  return addDays(due, -PREGNANCY_DAYS);
}

// 日本の区分: 初期 〜15週6日 / 中期 16週〜27週6日 / 後期 28週〜
export function trimesterOf(week) {
  if (week < 16) return { index: 1, label: '妊娠初期' };
  if (week < 28) return { index: 2, label: '妊娠中期' };
  return { index: 3, label: '妊娠後期' };
}

// 妊娠月数（0〜3週が1ヶ月目、36〜39週が10ヶ月目）
export function monthOf(week) {
  return Math.min(10, Math.floor(week / 4) + 1);
}

export function gestationalAge(due, on) {
  const lmp = lmpFromDueDate(due);
  const totalDays = diffDays(on, lmp);
  const week = Math.floor(totalDays / 7);
  const day = ((totalDays % 7) + 7) % 7;
  const daysLeft = diffDays(due, on);
  return {
    totalDays,
    week,
    day,
    daysLeft,
    progress: Math.max(0, Math.min(1, totalDays / PREGNANCY_DAYS)),
    trimester: trimesterOf(week),
    month: monthOf(week),
    isFullTerm: week >= 37 && week < 42,
    isPostTerm: week >= 42,
    notStarted: totalDays < 0,
  };
}

export function dateForWeek(due, week, day = 0) {
  return addDays(lmpFromDueDate(due), week * 7 + day);
}

// 厚生労働省が示す標準的な妊婦健診の間隔
//   〜23週: 4週間に1回 / 24〜35週: 2週間に1回 / 36週〜: 1週間に1回
export function checkupWeeks() {
  const weeks = [8, 12, 16, 20];
  for (let w = 24; w <= 34; w += 2) weeks.push(w);
  for (let w = 36; w <= 40; w += 1) weeks.push(w);
  return weeks;
}

export function checkupSchedule(due) {
  return checkupWeeks().map((week, i) => ({
    number: i + 1,
    week,
    date: dateForWeek(due, week),
  }));
}

export function nextCheckup(due, on) {
  return checkupSchedule(due).find((c) => diffDays(c.date, on) >= 0) || null;
}

// 陣痛の記録から平均間隔・平均持続時間を算出する
// contractions: [{ start: epochMs, end: epochMs|null }]（開始時刻の昇順）
export function contractionStats(contractions, lastN = 6) {
  const done = contractions.filter((c) => c.end != null);
  const recent = done.slice(-lastN);
  const durations = recent.map((c) => (c.end - c.start) / 1000);
  const intervals = [];
  const starts = contractions.slice(-lastN - 1).map((c) => c.start);
  for (let i = 1; i < starts.length; i++) intervals.push((starts[i] - starts[i - 1]) / 1000);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  return {
    count: contractions.length,
    avgDurationSec: avg(durations),
    avgIntervalSec: avg(intervals),
  };
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${String(r).padStart(2, '0')}秒` : `${r}秒`;
}

// 妊娠前 BMI に基づく体重増加の目安（日本産科婦人科学会 2021年）
export function weightGainGuide(heightCm, preWeightKg) {
  if (!heightCm || !preWeightKg) return null;
  const h = heightCm / 100;
  const bmi = preWeightKg / (h * h);
  let range;
  let category;
  if (bmi < 18.5) {
    category = '低体重';
    range = [12, 15];
  } else if (bmi < 25) {
    category = '普通体重';
    range = [10, 13];
  } else if (bmi < 30) {
    category = '肥満(1度)';
    range = [7, 10];
  } else {
    category = '肥満(2度以上)';
    range = null; // 個別対応（上限5kgまでが目安）
  }
  return { bmi: Math.round(bmi * 10) / 10, category, range };
}
