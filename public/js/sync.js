// 家族共有の同期
//   - 端末内のデータ（state）と「最後に同期した内容」（snapshot）を比べて変更を見つけ、送信待ち（outbox）に積む
//   - サーバーからの差分（seq 順）を state に反映する
// 前半は DOM 非依存の純粋なロジック、後半はブラウザで動く同期エンジン

export const COLLECTIONS = {
  children: 'child',
  fetalRecords: 'fetal',
  growthRecords: 'growth',
  milestones: 'milestone',
  media: 'media',
  weights: 'weight',
  journal: 'journal',
  contractions: 'contraction',
  kicks: 'kick',
  reactions: 'reaction',
  comments: 'comment',
  shares: 'share',
};
const TYPE_TO_COLLECTION = Object.fromEntries(Object.entries(COLLECTIONS).map(([k, v]) => [v, k]));
export const MOM_TYPES = new Set(['weight', 'journal', 'contraction', 'kick']);
const SOCIAL_TYPES = new Set(['reaction', 'comment']);
const BABY_TYPES = new Set(['child', 'fetal', 'growth', 'milestone', 'media']);
const META = ['ownerId', 'createdBy', 'updatedBy'];

// 文字列の短いハッシュ（FNV-1a）
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function stripMeta(obj) {
  const out = { ...obj };
  for (const k of META) delete out[k];
  return out;
}

// state を { key: { type, id, obj } } に展開する
export function serialize(state, userId) {
  const out = new Map();
  for (const [coll, type] of Object.entries(COLLECTIONS)) {
    for (const obj of state[coll] || []) {
      if (obj?.id == null) continue;
      const id = String(obj.id);
      out.set(`${type}:${id}`, { type, id, obj });
    }
  }
  if (userId) {
    out.set(`prefs:${userId}`, {
      type: 'prefs',
      id: userId,
      obj: { profile: state.profile, checks: state.checks, checkups: state.checkups },
    });
  }
  return out;
}

const snapEntry = (obj) => `${hash(JSON.stringify(stripMeta(obj)))}|${obj.ownerId || ''}`;
const snapOwner = (entry) => entry?.split('|')[1] || '';

// この端末から送ってよい変更か（サーバーでも同じ確認をする）
export function canPush(account, type, id, owner, deleting) {
  const me = account.userId;
  if (type === 'prefs' || type === 'share') return id === me;
  const mine = !owner || owner === me;
  if (SOCIAL_TYPES.has(type)) return mine || (type === 'comment' && deleting && account.role === 'admin');
  if (account.role === 'viewer') return false;
  if (MOM_TYPES.has(type)) return mine;
  return BABY_TYPES.has(type);
}

// 前回の同期からの変更を outbox に積む。送れない変更があれば needsResync を立てる
export function collectChanges(state, account, now = Date.now()) {
  const current = serialize(state, account.userId);
  const snapshot = account.snapshot;
  let blocked = false;
  const push = (key, change) => {
    account.outbox[key] = change;
  };
  for (const [key, { type, id, obj }] of current) {
    const entry = snapEntry(obj);
    if (snapshot[key] === entry) continue;
    if (snapshot[key] && snapshot[key].split('|')[0] === entry.split('|')[0]) {
      snapshot[key] = entry; // 中身は同じ（記録者の情報だけが変わった）
      continue;
    }
    if (!canPush(account, type, id, obj.ownerId || snapOwner(snapshot[key]), false)) {
      blocked = true;
      continue;
    }
    snapshot[key] = entry;
    push(key, { type, id, data: stripMeta(obj), updatedAt: Number(obj.updatedAt) || now });
  }
  for (const key of Object.keys(snapshot)) {
    if (current.has(key)) continue;
    const [type, ...rest] = key.split(':');
    const id = rest.join(':');
    if (!canPush(account, type, id, snapOwner(snapshot[key]), true)) {
      blocked = true;
      delete snapshot[key];
      continue;
    }
    delete snapshot[key];
    push(key, { type, id, deleted: true, updatedAt: now });
  }
  if (blocked) account.needsResync = true;
  return Object.keys(account.outbox).length;
}

// サーバーから届いた記録を state に反映する。送信待ちの変更がある記録はそちらを優先する
export function applyRemote(state, account, records) {
  const removedMedia = [];
  let changed = false;
  for (const r of records) {
    const key = `${r.type}:${r.id}`;
    if (account.outbox[key]) continue;
    if (r.type === 'prefs') {
      if (r.id !== account.userId || r.deleted) continue;
      state.profile = { ...state.profile, ...(r.data.profile || {}) };
      state.checks = r.data.checks || {};
      state.checkups = r.data.checkups || {};
      account.snapshot[key] = snapEntry({ profile: state.profile, checks: state.checks, checkups: state.checkups });
      changed = true;
      continue;
    }
    const coll = TYPE_TO_COLLECTION[r.type];
    if (!coll) continue;
    const list = state[coll];
    const idx = list.findIndex((x) => String(x.id) === r.id);
    if (r.deleted) {
      if (idx >= 0) {
        list.splice(idx, 1);
        changed = true;
        if (r.type === 'media') removedMedia.push(r.id);
      }
      delete account.snapshot[key];
      continue;
    }
    const obj = { ...r.data, ownerId: r.ownerId, createdBy: r.createdBy, updatedBy: r.updatedBy };
    if (idx >= 0) list[idx] = obj;
    else list.push(obj);
    account.snapshot[key] = snapEntry(obj);
    changed = true;
  }
  return { changed, removedMedia };
}

export function newAccount(me, group) {
  return {
    userId: me.user.id,
    displayName: me.user.displayName,
    groups: me.groups,
    groupId: group.id,
    groupName: group.name,
    role: group.role,
    cursor: 0,
    snapshot: {},
    outbox: {},
    pendingUploads: {},
    members: {},
    needsResync: false,
    lastSyncAt: null,
    error: null,
  };
}

// ---------- ブラウザ用の同期エンジン ----------

const ACCOUNT_KEY = 'maternity-app:account';

export function loadAccount() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY));
    return a && a.userId && a.groupId ? a : null;
  } catch {
    return null;
  }
}

export function saveAccount(account) {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // 容量不足など。次回の同期でやり直す
  }
}

/**
 * hooks:
 *   getState() / saveState()   端末内のデータ
 *   onChange({ remote })       画面の更新
 *   onStatus(status)           同期状態の表示
 *   onSignedOut()              ログインが切れた
 *   removeMediaFile(id)        削除された写真のファイルを消す
 *   readMediaFile(id)          アップロードする写真 { full, thumb }
 */
export function createSyncEngine(api, hooks) {
  let account = loadAccount();
  let running = null;
  let again = false;
  let timer = null;

  const status = (extra = {}) => hooks.onStatus?.({
    signedIn: !!account,
    pending: account ? Object.keys(account.outbox).length + Object.keys(account.pendingUploads).length : 0,
    lastSyncAt: account?.lastSyncAt ?? null,
    error: account?.error ?? null,
    ...extra,
  });

  async function uploadMedia(id) {
    const file = await hooks.readMediaFile(id);
    if (file?.full) await api.uploadMedia(account.groupId, id, 'full', file.full);
    if (file?.thumb) await api.uploadMedia(account.groupId, id, 'thumb', file.thumb);
    delete account.pendingUploads[id];
  }

  async function push() {
    collectChanges(hooks.getState(), account);
    saveAccount(account);
    const entries = Object.entries(account.outbox);
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      // 写真の情報を送る前にファイルをアップロードする
      for (const [, c] of batch) {
        if (c.type === 'media' && !c.deleted && account.pendingUploads[c.id]) await uploadMedia(c.id);
      }
      const res = await api.pushChanges(account.groupId, batch.map(([, c]) => c));
      res.results.forEach((r, j) => {
        const [key, sent] = batch[j];
        if (account.outbox[key] === sent) delete account.outbox[key];
        if (r.status !== 'ok') account.needsResync = true;
      });
      saveAccount(account);
    }
    // 写真の情報より先にファイルだけ残っている場合（前回の途中で中断など）
    for (const id of Object.keys(account.pendingUploads)) {
      if (!hooks.getState().media.some((m) => m.id === id)) delete account.pendingUploads[id];
      else await uploadMedia(id);
    }
  }

  async function pull() {
    if (account.needsResync) {
      account.cursor = 0;
      account.needsResync = false;
    }
    let anyChange = false;
    for (;;) {
      const res = await api.pullChanges(account.groupId, account.cursor);
      const { changed, removedMedia } = applyRemote(hooks.getState(), account, res.records);
      anyChange ||= changed;
      removedMedia.forEach((id) => hooks.removeMediaFile?.(id));
      account.cursor = res.cursor;
      if (!res.more) break;
    }
    if (anyChange) hooks.saveState();
    saveAccount(account);
    return anyChange;
  }

  async function runOnce() {
    status({ syncing: true });
    try {
      await push();
      const changed = await pull();
      account.lastSyncAt = Date.now();
      account.error = null;
      saveAccount(account);
      if (changed) hooks.onChange?.({ remote: true });
    } catch (e) {
      if (e?.status === 401 || e?.status === 404) {
        // ログインが切れた・グループから外された
        account.error = e.status === 401 ? 'signed_out' : 'removed';
        saveAccount(account);
        hooks.onSignedOut?.(account.error);
      } else {
        account.error = navigator.onLine === false ? 'offline' : 'failed';
        saveAccount(account);
      }
    }
    status();
  }

  async function run() {
    if (!account || account.error === 'signed_out' || account.error === 'removed') return;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await runOnce();
      } while (again);
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  return {
    get account() {
      return account;
    },
    // ログイン・グループ作成・参加の後に呼ぶ。uploadLocal: 端末内の記録をグループへ送る
    async start(me, groupId, { uploadLocal = false } = {}) {
      const group = me.groups.find((g) => g.id === groupId) || me.groups[0];
      account = newAccount(me, group);
      if (uploadLocal) {
        for (const m of hooks.getState().media) account.pendingUploads[m.id] = true;
      }
      saveAccount(account);
      await run();
    },
    updateMe(me) {
      if (!account) return;
      const group = me.groups.find((g) => g.id === account.groupId);
      if (!group) return;
      Object.assign(account, { displayName: me.user.displayName, groups: me.groups, groupName: group.name, role: group.role });
      saveAccount(account);
    },
    setMembers(members) {
      if (!account) return;
      account.members = Object.fromEntries(members.map((m) => [m.userId, { displayName: m.displayName, role: m.role }]));
      saveAccount(account);
    },
    markLocalMedia(id) {
      if (!account) return;
      account.pendingUploads[id] = true;
      saveAccount(account);
    },
    // 端末内の変更を少し待ってから送る
    schedule(delay = 1500) {
      if (!account) return;
      clearTimeout(timer);
      timer = setTimeout(run, delay);
      status({ pending: Object.keys(account.outbox).length + 1 });
    },
    run,
    signOut() {
      clearTimeout(timer);
      account = null;
      saveAccount(null);
      status();
    },
    status,
  };
}
