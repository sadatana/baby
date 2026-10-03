// 赤ちゃんの成長記録に関する計算ロジック（DOM非依存）
import { parseDate, diffDays, gestationalAge } from './pregnancy.js';

export const DAYS_PER_MONTH = 30.4375;

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// 誕生日から on までの月齢（暦の上での「◯ヶ月◯日」）
export function ageOf(birth, on) {
  const totalDays = diffDays(on, birth);
  if (totalDays < 0) return null;
  let months = (on.getUTCFullYear() - birth.getUTCFullYear()) * 12 + (on.getUTCMonth() - birth.getUTCMonth());
  let days = on.getUTCDate() - birth.getUTCDate();
  if (days < 0) {
    months -= 1;
    // 前月の日数で繰り下げる（1/31 生まれ → 3/1 は 1ヶ月1日）
    const pm = on.getUTCMonth() === 0 ? 11 : on.getUTCMonth() - 1;
    const py = on.getUTCMonth() === 0 ? on.getUTCFullYear() - 1 : on.getUTCFullYear();
    days += Math.max(daysInMonth(py, pm), birth.getUTCDate());
    days = Math.min(days, totalDays);
  }
  return {
    totalDays,
    years: Math.floor(months / 12),
    months: months % 12,
    totalMonths: months,
    days,
    monthsFloat: totalDays / DAYS_PER_MONTH,
  };
}

export function formatAge(age) {
  if (!age) return '';
  if (age.totalMonths === 0) return `生後${age.days}日`;
  if (age.years === 0) return `生後${age.months}ヶ月${age.days ? `${age.days}日` : ''}`;
  return `${age.years}歳${age.months ? `${age.months}ヶ月` : ''}`;
}

export function isBorn(child) {
  return !!parseDate(child?.birthDate);
}

// ある日付が「妊娠◯週」「生後◯ヶ月」のどこにあたるかの見出し
export function periodOf(child, dateStr) {
  const d = parseDate(dateStr);
  const birth = parseDate(child?.birthDate);
  if (d && birth && diffDays(d, birth) >= 0) {
    const age = ageOf(birth, d);
    const label = age.totalMonths === 0 ? '生後0ヶ月'
      : age.years === 0 ? `生後${age.months}ヶ月` : `${age.years}歳${age.months}ヶ月`;
    return { key: `b${String(age.totalMonths).padStart(3, '0')}`, label };
  }
  const due = parseDate(child?.dueDate);
  if (d && due) {
    const ga = gestationalAge(due, d);
    if (ga.week >= 0) return { key: `p${String(ga.week).padStart(2, '0')}`, label: `妊娠${ga.week}週` };
  }
  return { key: `d${dateStr.slice(0, 7)}`, label: dateStr.slice(0, 7).replace('-', '年') + '月' };
}

// 生まれたときの在胎週数
export function gestAtBirth(child) {
  const due = parseDate(child?.dueDate);
  const birth = parseDate(child?.birthDate);
  if (!due || !birth) return null;
  const ga = gestationalAge(due, birth);
  return { week: ga.week, day: ga.day };
}

// 初めてのできごとのテンプレート（目安の時期は一般的なもの。個人差があります）
export const MILESTONE_TEMPLATES = [
  { id: 'heartbeat', phase: 'pregnancy', emoji: '💓', title: '心拍が確認できた', hint: '妊娠6〜8週ごろ' },
  { id: 'boshi-techo', phase: 'pregnancy', emoji: '📕', title: '母子健康手帳をもらった', hint: '妊娠8〜11週ごろ' },
  { id: 'sex', phase: 'pregnancy', emoji: '🎀', title: '性別がわかった', hint: '妊娠16〜24週ごろ' },
  { id: 'first-kick', phase: 'pregnancy', emoji: '🦶', title: '初めての胎動', hint: '妊娠16〜22週ごろ' },
  { id: 'omiyamairi', phase: 'baby', emoji: '⛩️', title: 'お宮参り', hint: '生後1ヶ月ごろ' },
  { id: 'smile', phase: 'baby', emoji: '😊', title: '初めてあやすと笑った', hint: '生後2〜3ヶ月ごろ' },
  { id: 'okuizome', phase: 'baby', emoji: '🍚', title: 'お食い初め', hint: '生後100日ごろ' },
  { id: 'neck', phase: 'baby', emoji: '👶', title: '首がすわった', hint: '生後3〜4ヶ月ごろ' },
  { id: 'roll', phase: 'baby', emoji: '🔄', title: '寝返り', hint: '生後5〜6ヶ月ごろ' },
  { id: 'weaning', phase: 'baby', emoji: '🥄', title: '離乳食スタート', hint: '生後5〜6ヶ月ごろ' },
  { id: 'tooth', phase: 'baby', emoji: '🦷', title: '初めての歯', hint: '生後6〜9ヶ月ごろ' },
  { id: 'sit', phase: 'baby', emoji: '🧸', title: 'ひとりでおすわり', hint: '生後7ヶ月ごろ' },
  { id: 'crawl', phase: 'baby', emoji: '🐛', title: 'はいはい', hint: '生後8〜9ヶ月ごろ' },
  { id: 'pull-up', phase: 'baby', emoji: '🧍', title: 'つかまり立ち', hint: '生後9〜10ヶ月ごろ' },
  { id: 'first-birthday', phase: 'baby', emoji: '🎂', title: '1歳の誕生日', hint: '1歳' },
  { id: 'word', phase: 'baby', emoji: '💬', title: '初めての言葉', hint: '1歳ごろ' },
  { id: 'walk', phase: 'baby', emoji: '👣', title: 'ひとりで歩いた', hint: '1歳〜1歳3ヶ月ごろ' },
];

export function milestoneTemplate(id) {
  return MILESTONE_TEMPLATES.find((t) => t.id === id) || null;
}

const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.sort ?? 0) - (a.sort ?? 0);

// 計測・写真・できごと・日記を時系列（新しい順）にまとめる
// 記録に添付された写真はその記録の中で表示し、単独の写真は同じ日ごとにまとめる
export function buildTimeline(state, childId, { includeJournal = true } = {}) {
  const child = state.children.find((c) => c.id === childId);
  if (!child) return [];
  const mine = (arr) => arr.filter((r) => r.childId === childId);
  const items = [];
  const linked = new Set();

  for (const r of mine(state.fetalRecords)) {
    items.push({ kind: 'fetal', date: r.date, record: r, sort: 2 });
    (r.photoIds || []).forEach((id) => linked.add(id));
  }
  for (const r of mine(state.growthRecords)) {
    items.push({ kind: 'growth', date: r.date, record: r, sort: 2 });
    (r.photoIds || []).forEach((id) => linked.add(id));
  }
  for (const r of mine(state.milestones)) {
    items.push({ kind: 'milestone', date: r.date, record: r, sort: 3 });
    (r.photoIds || []).forEach((id) => linked.add(id));
  }
  if (isBorn(child)) items.push({ kind: 'birth', date: child.birthDate, record: child, sort: 4 });

  const photosByDate = new Map();
  for (const m of mine(state.media)) {
    if (linked.has(m.id)) continue;
    if (!photosByDate.has(m.takenAt)) photosByDate.set(m.takenAt, []);
    photosByDate.get(m.takenAt).push(m);
  }
  for (const [date, media] of photosByDate) items.push({ kind: 'photos', date, media, sort: 1 });

  if (includeJournal) {
    for (const j of state.journal) items.push({ kind: 'journal', date: j.date, record: j, sort: 0 });
  }

  items.sort(byDateDesc);
  return items;
}

// タイムラインを「妊娠◯週」「生後◯ヶ月」ごとのグループに分ける
export function groupByPeriod(child, items) {
  const groups = [];
  for (const item of items) {
    const p = periodOf(child, item.date);
    const last = groups[groups.length - 1];
    if (last && last.key === p.key) last.items.push(item);
    else groups.push({ ...p, items: [item] });
  }
  return groups;
}

// ---------- 写真の撮影日（EXIF） ----------

// JPEG の EXIF から撮影日時を読み取り "YYYY-MM-DD" を返す。読めなければ null
export function exifDate(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if ((marker & 0xff00) !== 0xff00) return null;
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        return readTiffDate(v, off + 10);
      }
      if (marker === 0xffda) return null; // 画像データ開始。これ以降に EXIF はない
      off += 2 + len;
    }
  } catch {
    // 壊れたファイルなどは無視
  }
  return null;
}

function readTiffDate(v, tiff) {
  const le = v.getUint16(tiff) === 0x4949; // "II" = リトルエンディアン
  const u16 = (o) => v.getUint16(tiff + o, le);
  const u32 = (o) => v.getUint32(tiff + o, le);
  const ascii = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = v.getUint8(tiff + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readIfd = (ifdOff) => {
    const tags = {};
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      const tag = u16(e);
      const count = u32(e + 4);
      if (tag === 0x8769) tags.exif = u32(e + 8);
      else if ((tag === 0x9003 || tag === 0x0132) && u16(e + 2) === 2) tags[tag] = ascii(u32(e + 8), count);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0.exif ? readIfd(ifd0.exif) : {};
  const raw = exif[0x9003] || ifd0[0x0132];
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(raw || '');
  if (!m || m[1] === '0000') return null;
  const s = `${m[1]}-${m[2]}-${m[3]}`;
  return parseDate(s) ? s : null;
}
