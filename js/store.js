// localStorage を使ったデータ保存（データは端末内にのみ保存されます）
// 写真のファイル本体は容量が大きいため IndexedDB（media.js）に保存し、ここには情報だけを持つ。

const KEY = 'maternity-app:v1';
export const SCHEMA_VERSION = 2;

const newId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function newChild(fields = {}) {
  const now = Date.now();
  return {
    id: newId(),
    name: '',
    dueDate: '',
    birthDate: '',
    sex: '', // 'male' | 'female' | ''
    birth: { lengthCm: null, weightG: null, headCm: null, chestCm: null },
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

export function defaultState() {
  const child = newChild();
  return {
    version: SCHEMA_VERSION,
    profile: { heightCm: null, preWeightKg: null }, // ママの情報
    // 赤ちゃん（複数の子どもに対応できる形で保存する）
    children: [child],
    activeChildId: child.id,
    // 赤ちゃんの記録。すべて { id, childId, date, ..., createdAt, updatedAt }
    fetalRecords: [], // { efwG, bpdMm, flMm, acMm, crlMm, fhrBpm, note, photoIds }
    growthRecords: [], // { heightCm, weightKg, headCm, chestCm, note, photoIds }
    milestones: [], // { templateId, title, note, photoIds }
    media: [], // { id, childId, takenAt: 'YYYY-MM-DD', caption, width, height, createdAt, updatedAt }
    deleted: [], // 削除の記録 { type, id, at }（将来の同期で使う）
    // ママの記録
    weights: [], // { date: 'YYYY-MM-DD', kg: number }
    journal: [], // { id, date: 'YYYY-MM-DD', mood, text }
    checks: {}, // チェックリストの完了状態 { key: true }
    checkups: {}, // 健診の受診済み { week: true }
    contractions: [], // { start: epochMs, end: epochMs|null }
    kicks: [], // { start: epochMs, end: epochMs|null, count }
  };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function mergeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  // v1: 予定日・ニックネームは profile にあった → 子ども 1 人目へ移す
  let children = arr(raw.children).filter((c) => c && c.id)
    .map((c) => ({ ...newChild(), ...c, birth: { ...newChild().birth, ...obj(c.birth) } }));
  if (!children.length) {
    const p = obj(raw.profile);
    children = [newChild({ name: p.babyName || '', dueDate: p.dueDate || '' })];
  }
  const activeChildId = children.some((c) => c.id === raw.activeChildId) ? raw.activeChildId : children[0].id;
  const rawProfile = obj(raw.profile);

  return {
    ...base,
    version: SCHEMA_VERSION,
    profile: { heightCm: rawProfile.heightCm ?? null, preWeightKg: rawProfile.preWeightKg ?? null },
    children,
    activeChildId,
    fetalRecords: arr(raw.fetalRecords),
    growthRecords: arr(raw.growthRecords),
    milestones: arr(raw.milestones),
    media: arr(raw.media),
    deleted: arr(raw.deleted),
    weights: arr(raw.weights),
    journal: arr(raw.journal),
    checks: obj(raw.checks),
    checkups: obj(raw.checkups),
    contractions: arr(raw.contractions),
    kicks: arr(raw.kicks),
  };
}

export function load() {
  try {
    return mergeState(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return defaultState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 何もしない
  }
}

// 記録の追加・更新（同じ id があれば置き換える）
export function upsert(list, record) {
  const now = Date.now();
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) {
    list[i] = { ...list[i], ...record, updatedAt: now };
    return list[i];
  }
  const created = { id: newId(), createdAt: now, updatedAt: now, ...record };
  list.push(created);
  return created;
}

// 記録の削除（削除したことを deleted に残す）
export function remove(state, type, id) {
  const before = state[type].length;
  state[type] = state[type].filter((r) => r.id !== id);
  if (state[type].length !== before) state.deleted.push({ type, id, at: Date.now() });
}
