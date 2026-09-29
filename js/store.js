// localStorage を使ったデータ保存（データは端末内にのみ保存されます）

const KEY = 'maternity-app:v1';

export function defaultState() {
  return {
    profile: { dueDate: '', babyName: '', heightCm: null, preWeightKg: null },
    weights: [], // { date: 'YYYY-MM-DD', kg: number }
    journal: [], // { id, date: 'YYYY-MM-DD', mood, text }
    checks: {}, // チェックリストの完了状態 { key: true }
    checkups: {}, // 健診の受診済み { week: true }
    contractions: [], // { start: epochMs, end: epochMs|null }
    kicks: [], // { start: epochMs, end: epochMs|null, count }
  };
}

export function mergeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    profile: { ...base.profile, ...(raw.profile || {}) },
    weights: Array.isArray(raw.weights) ? raw.weights : [],
    journal: Array.isArray(raw.journal) ? raw.journal : [],
    checks: raw.checks && typeof raw.checks === 'object' ? raw.checks : {},
    checkups: raw.checkups && typeof raw.checkups === 'object' ? raw.checkups : {},
    contractions: Array.isArray(raw.contractions) ? raw.contractions : [],
    kicks: Array.isArray(raw.kicks) ? raw.kicks : [],
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
