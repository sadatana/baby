import {
  parseDate, formatDate, formatDateJa, today, addDays, diffDays,
  dueDateFromLmp, gestationalAge, checkupSchedule, nextCheckup,
  contractionStats, formatDuration, weightGainGuide,
} from './pregnancy.js';
import { weekInfo, HOSPITAL_BAG, PROCEDURES, FOOD_NOTES, WARNING_SIGNS } from './data.js';
import {
  uuid, ageOf, formatAge, isBorn, periodOf, gestAtBirth, MILESTONE_TEMPLATES, milestoneTemplate, photoMonthOf, photoMonthLabel,
  buildTimeline, groupByPeriod, DAYS_PER_MONTH,
} from './growth.js';
import {
  fetalEfwAt, FETAL_EFW_RANGE, FETAL_EFW_SOURCE, hasInfantStandard, infantPercentilesAt,
  percentileBand, INFANT_SOURCE,
} from './standards.js';
import { lineChart, ticks } from './charts.js';
import * as store from './store.js';
import * as media from './media.js';
import * as api from './api.js';
import { createSyncEngine } from './sync.js';
import { createZip, safeName } from './zip.js';
import { icon, moodIcon, moodLevel, MOOD_LABELS, hydrateIcons } from './icons.js';

let state = store.load();
let currentTab = 'home';
let selectedWeek = null; // 週ごとのガイドで表示中の週
const ui = {
  growthView: 'records', // records | guide
  fetalMetric: 'efwG',
  infantMetric: 'weight',
  withFetal: false, // 出生後の体重グラフに妊娠中の推定体重も表示
  albumView: 'timeline', // timeline | photos | milestones
  timelineFilter: 'all',
  momView: 'records', // records | tools
  momOwner: null, // ママタブで表示する人（null: 自動 / 'me' / ユーザー ID）
  editing: null, // { type, id } 計測記録の編集中
  openComments: new Set(), // コメント欄を開いている記録
};

const view = document.getElementById('view');
const dialogs = {
  settings: document.getElementById('settings'),
  birth: document.getElementById('birth'),
  milestone: document.getElementById('milestone'),
  children: document.getElementById('children'),
  viewer: document.getElementById('viewer'),
};
const settingsForm = document.getElementById('settings-form');
const birthForm = document.getElementById('birth-form');
const milestoneForm = document.getElementById('milestone-form');
const viewerForm = document.getElementById('viewer-form');

// ---------- ユーティリティ ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function persist() {
  if (!store.save(state)) toast('保存できませんでした（ストレージの空き容量を確認してください）');
  syncEngine.schedule();
}

// ---------- 家族共有（同期） ----------

const syncEngine = createSyncEngine(api, {
  getState: () => state,
  saveState: () => store.save(state),
  onChange: () => {
    ensureChild();
    requestRender();
  },
  onStatus: updateSyncStatus,
  onSignedOut: (reason) => {
    toast(reason === 'removed' ? '家族グループから外れました。設定から確認してください' : 'ログインの有効期限が切れました。設定から再ログインしてください', 5000);
    updateRoleUi();
  },
  removeMediaFile: (id) => media.deleteFile(id).catch(() => {}),
  readMediaFile: (id) => media.getFile(id),
});
const account = () => syncEngine.account;
const canEdit = () => !account() || account().role !== 'viewer';
const isAdmin = () => account()?.role === 'admin';
// ママの記録・コメントなどが自分のものか（ログインしていなければすべて自分のもの）
const isMine = (r) => !account() || !r?.ownerId || r.ownerId === account().userId;
const memberName = (uid) => (uid && account()?.members?.[uid]?.displayName) || (uid === account()?.userId ? account()?.displayName : '') || '家族';
const ROLE_LABELS = { admin: '管理者', editor: '編集者', viewer: '閲覧者' };

if (account()) {
  media.setRemote((id, size) => api.fetchMedia(account().groupId, id, size));
}

function updateRoleUi() {
  document.body.dataset.role = account()?.role || '';
  updateSyncStatus(null);
}

function updateSyncStatus(st) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const a = account();
  el.hidden = !a;
  if (!a) return;
  const status = st || {};
  const error = a.error;
  el.innerHTML = icon(error === 'signed_out' || error === 'removed' ? 'alert' : status.syncing ? 'sync' : error ? 'cloudOff' : 'cloud', status.syncing ? 'spin' : '');
  el.classList.toggle('warn', !!error);
  el.title = error === 'offline' ? 'オフライン（つながったら同期します）'
    : error ? '同期できませんでした' : status.syncing ? '同期中…' : `同期済み${a.lastSyncAt ? `（${new Date(a.lastSyncAt).toLocaleTimeString('ja-JP')}）` : ''}`;
  const info = document.getElementById('sync-info');
  if (info) info.textContent = el.title;
}

// 入力中に画面を書き換えると入力が消えるため、家族の更新は入力が終わってから反映する
let pendingRender = false;
function isEditing() {
  const el = document.activeElement;
  const typing = el && view.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file'].includes(el.type)));
  return typing || Object.values(dialogs).some((d) => d.open && d !== dialogs.settings);
}
function requestRender() {
  if (isEditing()) pendingRender = true;
  else render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (pendingRender && !isEditing()) {
    pendingRender = false;
    render();
  }
}, 0));

let toastTimer;
function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const FALLBACK_CHILD = store.newChild();
function child() {
  return state.children.find((c) => c.id === state.activeChildId) || state.children[0] || FALLBACK_CHILD;
}

// 子どもの記録がまだない場合（家族グループに参加した直後など）に 1 人目を用意する
function ensureChild() {
  if (!state.children.some((c) => c.id === state.activeChildId)) state.activeChildId = state.children[0]?.id ?? null;
  if (!state.children.length && canEdit() && !syncPending) {
    const c = store.newChild();
    state.children.push(c);
    state.activeChildId = c.id;
    persist();
  }
}
let syncPending = false;

function dueDate() {
  return parseDate(child().dueDate);
}

function babyLabel() {
  return child().name ? esc(child().name) : '赤ちゃん';
}

const num = (v) => (v === '' || v == null ? null : Number(v));
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const todayStr = () => formatDate(today());
const mine = (list) => list.filter((r) => r.childId === child().id);
const byDateAsc = (a, b) => a.date.localeCompare(b.date);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? 0) - (a.createdAt ?? 0);

function periodLabel(dateStr) {
  return periodOf(child(), dateStr).label;
}

function segmented(name, current, options) {
  return `<div class="segmented" role="tablist">
    ${options.map(([value, label]) => `<button role="tab" aria-selected="${value === current}"
      class="${value === current ? 'active' : ''}" data-action="set-ui" data-key="${name}" data-value="${value}">${label}</button>`).join('')}
  </div>`;
}

function chips(name, current, options) {
  return `<div class="chips-row">
    ${options.map(([value, label]) => `<button class="pill ${value === current ? 'active' : ''}" aria-pressed="${value === current}"
      data-action="set-ui" data-key="${name}" data-value="${value}">${label}</button>`).join('')}
  </div>`;
}

function photoStrip(ids = []) {
  const list = ids.filter((id) => state.media.some((m) => m.id === id));
  if (!list.length) return '';
  return `<div class="photo-strip">${list.map((id) => photoThumb(id)).join('')}</div>`;
}

function photoThumb(id) {
  const m = state.media.find((x) => x.id === id);
  const video = isVideo(m);
  return `<button class="photo ${video ? 'video' : ''}" data-action="open-photo" data-id="${esc(id)}" aria-label="${video ? '動画' : '写真'}を開く">
    <img data-media-id="${esc(id)}" alt="" loading="lazy">
    ${video ? `<span class="play-mark">${icon('play')}${m.duration ? `<span>${Math.round(m.duration)}秒</span>` : ''}</span>` : ''}</button>`;
}

const timeFmt = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortDateFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const safeTime = (fmt, ms) => (Number.isFinite(Number(ms)) ? fmt.format(Number(ms)) : '--');

// ---------- 写真の取り込み ----------

let busy = false;
const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);
const isImageFile = (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name);
const isVideo = (m) => m?.kind === 'video';

// 写真・動画を取り込む（写真は縮小して保存、動画は 30 秒・50MB まで）
async function importPhotos(files, { takenAt = null } = {}) {
  const list = [...(files || [])].filter((f) => isImageFile(f) || isVideoFile(f));
  const ids = [];
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    toast(`保存しています… (${i + 1}/${list.length})`, 0);
    const id = uuid();
    const file = list[i];
    const video = isVideoFile(file);
    try {
      const meta = video ? await media.importVideo(file, id) : await media.importImage(file, id);
      const now = Date.now();
      state.media.push({
        id,
        childId: child().id,
        takenAt: takenAt || meta.takenAt || (video && file.lastModified ? formatDate(today(new Date(file.lastModified))) : todayStr()),
        caption: '',
        width: meta.width,
        height: meta.height,
        ...(video ? { kind: 'video', duration: meta.duration } : {}),
        createdAt: now,
        updatedAt: now,
      });
      ids.push(id);
      syncEngine.markLocalMedia(id);
    } catch (e) {
      errors.push(e?.code === 'too_long' ? '30秒を超える動画' : e?.code === 'too_large' ? '50MBを超える動画'
        : video ? 'この端末で再生できない動画' : '読み込めない写真（JPEG・PNG でお試しください）');
    }
  }
  if (list.length) {
    persist();
    media.requestPersistence();
    toast(errors.length
      ? `${ids.length}件保存しました。保存できなかったもの: ${[...new Set(errors)].join('、')}`
      : `${ids.length}件保存しました`, errors.length ? 5000 : 2400);
  }
  return ids;
}

async function deletePhoto(id) {
  store.remove(state, 'media', id);
  for (const type of ['fetalRecords', 'growthRecords', 'milestones']) {
    state[type].forEach((r) => {
      if (r.photoIds?.includes(id)) r.photoIds = r.photoIds.filter((p) => p !== id);
    });
  }
  persist();
  await media.deleteFile(id).catch(() => {});
}

// ---------- ホーム ----------

function renderHome() {
  if (isBorn(child())) return renderBabyHome();
  const due = dueDate();
  if (!due) {
    return `
      <section class="card welcome">
        <div class="welcome-mark">${icon('baby')}</div>
        <h2>ご妊娠おめでとうございます</h2>
        <p>出産予定日（または最終月経の開始日）を設定すると、妊娠週数や赤ちゃんの成長、健診スケジュールを確認できます。</p>
        <button class="btn primary" data-action="open-settings">予定日を設定する</button>
      </section>
      ${renderQuickActions()}
      ${renderWarningCard()}`;
  }

  const t = today();
  const ga = gestationalAge(due, t);
  const info = weekInfo(ga.week);
  const next = nextCheckup(due, t);
  const pct = Math.round(ga.progress * 100);
  const lastFetal = mine(state.fetalRecords).sort(byDateDesc)[0];

  let headline;
  if (ga.notStarted) headline = '予定日の設定を確認してください';
  else if (ga.daysLeft > 0) headline = `${babyLabel()}に会えるまで あと <strong>${ga.daysLeft}</strong> 日`;
  else if (ga.daysLeft === 0) headline = '今日が出産予定日です';
  else headline = `予定日から ${-ga.daysLeft} 日経過`;

  return `
    <section class="card hero">
      <p class="hero-sub">${ga.trimester.label}・妊娠${ga.month}ヶ月</p>
      <p class="hero-week">妊娠 <strong>${Math.max(0, ga.week)}</strong>週<strong>${ga.day}</strong>日</p>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>
      <p class="hero-count">${headline}</p>
      <p class="muted small">出産予定日: ${formatDateJa(due)}</p>
      ${ga.isFullTerm ? '<p class="badge">正期産の時期です</p>' : ''}
    </section>

    ${ga.week >= 34 ? `
    <section class="card born-card edit-only">
      <p>${babyLabel()}が生まれたら、誕生を登録しましょう。月齢の表示や発育曲線に切り替わります。</p>
      <button class="btn primary" data-action="open-birth">誕生を登録する</button>
    </section>` : ''}

    ${renderQuickActions()}

    <section class="card baby-size" data-action="goto-week" data-week="${info.week}">
      ${sizeVisual(info.week)}
      <div>
        <p class="muted small">今週の${babyLabel()}は</p>
        <p class="size-name">${esc(info.size)}くらい</p>
        <p class="small">身長 ${info.length} ／ 体重 ${info.weight}</p>
      </div>
    </section>

    ${lastFetal ? `
    <section class="card link-card" data-action="goto-tab" data-tab="growth">
      <h3>${icon('ruler')}前回の健診の記録</h3>
      <p>${esc(lastFetal.date)}（${esc(periodLabel(lastFetal.date))}）
        ${lastFetal.efwG ? `推定体重 <strong>${esc(lastFetal.efwG)}g</strong>` : ''}</p>
    </section>` : ''}

    <section class="card">
      <h3>${icon('lightbulb')}今週のポイント</h3>
      <p>${esc(info.tip)}</p>
    </section>

    ${next ? `
    <section class="card">
      <h3>${icon('hospital')}次の妊婦健診（目安）</h3>
      <p><strong>${formatDateJa(next.date)}</strong>（${next.week}週）</p>
      <p class="muted small">${diffDays(next.date, t) === 0 ? '今日です' : `あと${diffDays(next.date, t)}日`}・実際の日程は産院の指示に従ってください</p>
    </section>` : ''}

    ${renderWarningCard()}`;
}

function renderBabyHome() {
  const c = child();
  const birth = parseDate(c.birthDate);
  const t = today();
  const age = ageOf(birth, t);
  const latest = mine(state.growthRecords).sort(byDateDesc)[0];
  const doneTemplates = new Set(mine(state.milestones).map((m) => m.templateId));
  const nextTemplates = MILESTONE_TEMPLATES.filter((m) => m.phase === 'baby' && !doneTemplates.has(m.id)).slice(0, 3);
  const events = [
    { label: 'お食い初め（生後100日）', date: addDays(birth, 99) },
    { label: 'ハーフバースデー', date: new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + 6, birth.getUTCDate())) },
    { label: '1歳の誕生日', date: new Date(Date.UTC(birth.getUTCFullYear() + 1, birth.getUTCMonth(), birth.getUTCDate())) },
  ].filter((e) => diffDays(e.date, t) >= 0);

  return `
    <section class="card hero">
      <p class="hero-sub">${babyLabel()}</p>
      <p class="hero-age">${age ? esc(formatAge(age)) : '誕生日を確認してください'}</p>
      ${age ? `<p class="hero-count">生まれて <strong>${age.totalDays + 1}</strong> 日目</p>` : ''}
      <p class="muted small">誕生日: ${formatDateJa(birth)}</p>
    </section>

    ${renderQuickActions()}

    ${latest ? `
    <section class="card link-card" data-action="goto-tab" data-tab="growth">
      <h3>${icon('ruler')}最新の計測</h3>
      <p>${esc(latest.date)}（${esc(periodLabel(latest.date))}）</p>
      <p>${growthValues(latest)}</p>
    </section>` : ''}

    ${events.length ? `
    <section class="card">
      <h3>${icon('calendar')}これからの行事</h3>
      <ul class="plain">
        ${events.map((e) => `<li>${esc(e.label)}: <strong>${formatDateJa(e.date)}</strong>
          <span class="muted small">${diffDays(e.date, t) === 0 ? '今日！' : `あと${diffDays(e.date, t)}日`}</span></li>`).join('')}
      </ul>
    </section>` : ''}

    ${nextTemplates.length ? `
    <section class="card">
      <h3>${icon('star')}これからの「初めて」</h3>
      <ul class="plain">
        ${nextTemplates.map((m) => `<li><span class="li-icon">${icon(m.icon)}</span>${esc(m.title)} <span class="muted small">${esc(m.hint)}</span>
          <button class="btn ghost tiny edit-only" data-action="new-milestone" data-template="${m.id}">記録</button></li>`).join('')}
      </ul>
      <p class="muted small">時期は一般的な目安です。発達には個人差があります。</p>
    </section>` : ''}`;
}

function renderQuickActions() {
  return `
    <section class="quick edit-only">
      <label class="quick-btn">${icon('camera')}<span>写真・動画</span>
        <input type="file" accept="image/*,video/*" multiple data-action="add-photos" hidden>
      </label>
      <button class="quick-btn" data-action="goto-tab" data-tab="growth">${icon('ruler')}<span>${isBorn(child()) ? '身長・体重' : '健診の記録'}</span></button>
      <button class="quick-btn" data-action="new-milestone">${icon('star')}<span>できごと</span></button>
    </section>`;
}

// 赤ちゃんの大きさを円の大きさで表す（4週〜41週）
function sizeVisual(week) {
  const t = Math.max(0, Math.min(1, (week - 4) / 37));
  const d = Math.round(14 + 58 * Math.sqrt(t));
  return `<div class="size-visual" aria-hidden="true"><span style="width:${d}px;height:${d}px"></span></div>`;
}

function renderWarningCard() {
  return `
    <section class="card warning">
      <h3>${icon('alert')}すぐに産院へ連絡するサイン</h3>
      <ul>${WARNING_SIGNS.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <p class="muted small">迷ったときは、ためらわずにかかりつけの産院へ電話してください。</p>
    </section>`;
}

// ---------- 成長 ----------

function renderGrowth() {
  const head = segmented('growthView', ui.growthView, [['records', '成長の記録'], ['guide', '週ごとのガイド']]);
  if (ui.growthView === 'guide') return head + renderWeeks();
  // 出生後でも、妊娠中の記録を編集するときは健診の記録フォームを表示する
  const fetalForm = !isBorn(child()) || ui.editing?.type === 'fetalRecords';
  return head + (fetalForm ? renderFetal() : renderInfant());
}

function field(name, label, value, attrs = '') {
  return `<label>${label}<input type="number" name="${name}" value="${value ?? ''}" inputmode="decimal" ${attrs}></label>`;
}

const FETAL_METRICS = [
  ['efwG', '推定体重', 'g'],
  ['bpdMm', '頭の横幅 BPD', 'mm'],
  ['flMm', '太ももの骨 FL', 'mm'],
  ['acMm', 'おなかの周り AC', 'mm'],
  ['crlMm', '頭からおしりまで CRL', 'mm'],
  ['fhrBpm', '心拍数', '回/分'],
];

function fetalValues(r) {
  return FETAL_METRICS.filter(([k]) => r[k] != null)
    .map(([k, label, unit]) => `<span class="val">${label.split(' ')[0]} <strong>${esc(r[k])}</strong>${unit}</span>`).join('');
}

function editingRecord(type) {
  if (ui.editing?.type !== type) return null;
  return state[type].find((r) => r.id === ui.editing.id) || null;
}

function renderFetal() {
  const due = dueDate();
  const rec = editingRecord('fetalRecords') || {};
  const records = mine(state.fetalRecords).sort(byDateDesc);
  return `
    <section class="card edit-only">
      <h2>${icon(rec.id ? 'edit' : 'ruler')}${rec.id ? '健診の記録を編集' : '健診の記録'}</h2>
      <p class="muted small">エコーで測った値を、わかる項目だけ入力してください。</p>
      <form data-form="fetal" class="record-form">
        <input type="hidden" name="id" value="${esc(rec.id || '')}">
        <label>健診日<input type="date" name="date" value="${esc(rec.date || todayStr())}" required></label>
        <div class="grid2">
          ${field('efwG', '推定体重 EFW (g)', rec.efwG, 'min="1" max="6000" step="1"')}
          ${field('bpdMm', '頭の横幅 BPD (mm)', rec.bpdMm, 'min="1" max="120" step="0.1"')}
          ${field('flMm', '太ももの骨 FL (mm)', rec.flMm, 'min="1" max="100" step="0.1"')}
          ${field('acMm', 'おなかの周り AC (mm)', rec.acMm, 'min="1" max="450" step="0.1"')}
          ${field('crlMm', '頭殿長 CRL (mm)', rec.crlMm, 'min="1" max="120" step="0.1"')}
          ${field('fhrBpm', '心拍数 (回/分)', rec.fhrBpm, 'min="30" max="250" step="1"')}
        </div>
        <label>メモ（任意）<textarea name="note" rows="2" maxlength="1000" placeholder="先生に言われたことなど">${esc(rec.note || '')}</textarea></label>
        <label>エコー写真（任意）<input type="file" name="photos" accept="image/*" multiple></label>
        ${rec.id ? photoStrip(rec.photoIds) : ''}
        <div class="actions">
          ${rec.id ? '<button type="button" class="btn ghost" data-action="cancel-edit">やめる</button>' : ''}
          <button class="btn primary">${rec.id ? '更新' : '記録する'}</button>
        </div>
      </form>
      ${due ? '' : '<p class="alert small">出産予定日を設定すると、記録した日の妊娠週数とグラフが表示されます。</p>'}
    </section>

    ${due ? renderFetalChart(due, records) : ''}

    ${records.length ? `
    <section class="card">
      <h2>記録の一覧</h2>
      <ul class="records">${records.map((r) => recordItem('fetalRecords', r, fetalValues(r))).join('')}</ul>
    </section>` : ''}`;
}

function recordItem(type, r, valuesHtml) {
  return `<li>
    <div class="record-head">
      <span>${esc(r.date)} <span class="muted">${esc(periodLabel(r.date))}</span></span>
      <span class="edit-only">
        <button class="icon-btn small" data-action="edit-record" data-type="${type}" data-id="${esc(r.id)}" aria-label="編集">${icon('edit')}</button>
        <button class="icon-btn small" data-action="delete-record" data-type="${type}" data-id="${esc(r.id)}" aria-label="削除">${icon('trash')}</button>
      </span>
    </div>
    <div class="vals">${valuesHtml}</div>
    ${r.note ? `<p class="note">${esc(r.note).replace(/\n/g, '<br>')}</p>` : ''}
    ${photoStrip(r.photoIds)}
  </li>`;
}

function renderFetalChart(due, records) {
  const metric = FETAL_METRICS.find(([k]) => k === ui.fetalMetric) || FETAL_METRICS[0];
  const [key, label, unit] = metric;
  const pts = records.filter((r) => r[key] != null)
    .map((r) => [gestationalAge(due, parseDate(r.date)).totalDays / 7, r[key], `${r.date}（${periodLabel(r.date)}）${r[key]}${unit}`])
    .sort((a, b) => a[0] - b[0]);
  const available = FETAL_METRICS.filter(([k]) => records.some((r) => r[k] != null));
  const metricChips = available.length > 1
    ? chips('fetalMetric', key, available.map(([k, l]) => [k, l.split(' ')[0]])) : '';
  if (!pts.length) {
    return available.length ? `<section class="card"><h2>${icon('growth')}グラフ</h2>${metricChips}</section>` : '';
  }

  const isEfw = key === 'efwG';
  const xs = pts.map((p) => p[0]);
  let x0 = Math.floor(Math.min(...xs)) - 1;
  let x1 = Math.ceil(Math.max(...xs)) + 1;
  if (isEfw) {
    x0 = Math.max(4, Math.min(x0, FETAL_EFW_RANGE[0]));
    x1 = Math.max(x1, Math.min(FETAL_EFW_RANGE[1], x0 + 8));
  }
  const band = { lower: [], upper: [], cls: 'band' };
  const mean = { pts: [], cls: 'ref' };
  if (isEfw) {
    for (let w = Math.max(x0, FETAL_EFW_RANGE[0]); w <= Math.min(x1, FETAL_EFW_RANGE[1]); w += 0.5) {
      const ref = fetalEfwAt(w);
      band.lower.push([w, ref.low]);
      band.upper.push([w, ref.high]);
      mean.pts.push([w, ref.mean]);
    }
  }
  const ys = [...pts.map((p) => p[1]), ...band.upper.map((p) => p[1])];
  const yMax = Math.max(...ys) * 1.08;
  const yMin = isEfw ? 0 : Math.max(0, Math.min(...pts.map((p) => p[1])) * 0.85);
  const step = (x1 - x0) > 16 ? 4 : 2;

  return `
    <section class="card">
      <h2>${icon('growth')}${esc(label.split(' ')[0])}の変化</h2>
      ${metricChips}
      ${lineChart({
        label: `${label}の推移`,
        xRange: [x0, x1],
        yRange: [yMin, yMax],
        xTicks: ticks(x0, x1).filter((v) => v % step === 0),
        xTick: (v) => `${v}週`,
        yTick: (v) => v.toLocaleString('ja-JP'),
        bands: [band],
        refLines: [mean],
        series: [{ pts }],
      })}
      <p class="legend small">
        <span class="lg lg-line"></span>記録
        ${isEfw ? `<span class="lg lg-band"></span>平均±1.5SD の範囲 <span class="lg lg-ref"></span>平均` : ''}
      </p>
      <p class="muted small">${isEfw ? `標準値: ${esc(FETAL_EFW_SOURCE)}。` : ''}グラフは一般的な目安です。気になることは健診で医師に相談してください。</p>
    </section>`;
}

const INFANT_METRICS = [
  ['weight', '体重', 'kg'],
  ['length', '身長', 'cm'],
  ['head', '頭囲', 'cm'],
];

function growthValues(r) {
  return [
    ['heightCm', '身長', 'cm'], ['weightKg', '体重', 'kg'], ['headCm', '頭囲', 'cm'], ['chestCm', '胸囲', 'cm'],
  ].filter(([k]) => r[k] != null).map(([k, l, u]) => `<span class="val">${l} <strong>${esc(r[k])}</strong>${u}</span>`).join('');
}

function birthValues(c) {
  const b = c.birth || {};
  return [
    [b.weightG, '体重', 'g'], [b.lengthCm, '身長', 'cm'], [b.headCm, '頭囲', 'cm'], [b.chestCm, '胸囲', 'cm'],
  ].filter(([v]) => v != null).map(([v, l, u]) => `<span class="val">${l} <strong>${esc(v)}</strong>${u}</span>`).join('');
}

function renderInfant() {
  const c = child();
  const rec = editingRecord('growthRecords') || {};
  const records = mine(state.growthRecords).sort(byDateDesc);
  const gest = gestAtBirth(c);
  const fetal = mine(state.fetalRecords).sort(byDateDesc);
  return `
    <section class="card">
      <div class="record-head">
        <h2>${icon('baby')}生まれたとき</h2>
        <button class="btn ghost tiny edit-only" data-action="open-birth">編集</button>
      </div>
      <p>${formatDateJa(parseDate(c.birthDate))}${gest ? `（在胎${gest.week}週${gest.day}日）` : ''}
        ${c.sex ? `・${c.sex === 'male' ? '男の子' : '女の子'}` : ''}</p>
      <div class="vals">${birthValues(c) || '<span class="muted small">生まれたときの大きさは未入力です</span>'}</div>
    </section>

    <section class="card edit-only">
      <h2>${icon(rec.id ? 'edit' : 'ruler')}${rec.id ? '計測を編集' : '身長・体重の記録'}</h2>
      <form data-form="growth" class="record-form">
        <input type="hidden" name="id" value="${esc(rec.id || '')}">
        <label>測った日<input type="date" name="date" value="${esc(rec.date || todayStr())}" required></label>
        <div class="grid2">
          ${field('weightKg', '体重 (kg)', rec.weightKg, 'min="0.3" max="40" step="0.001" placeholder="例: 5.42"')}
          ${field('heightCm', '身長 (cm)', rec.heightCm, 'min="20" max="130" step="0.1"')}
          ${field('headCm', '頭囲 (cm)', rec.headCm, 'min="15" max="60" step="0.1"')}
          ${field('chestCm', '胸囲 (cm)', rec.chestCm, 'min="15" max="80" step="0.1"')}
        </div>
        <label>メモ（任意）<textarea name="note" rows="2" maxlength="1000" placeholder="1ヶ月健診など">${esc(rec.note || '')}</textarea></label>
        <label>写真（任意）<input type="file" name="photos" accept="image/*" multiple></label>
        ${rec.id ? photoStrip(rec.photoIds) : ''}
        <div class="actions">
          ${rec.id ? '<button type="button" class="btn ghost" data-action="cancel-edit">やめる</button>' : ''}
          <button class="btn primary">${rec.id ? '更新' : '記録する'}</button>
        </div>
      </form>
    </section>

    ${renderInfantChart(c, records, fetal)}

    ${records.length ? `
    <section class="card">
      <h2>記録の一覧</h2>
      <ul class="records">${records.map((r) => recordItem('growthRecords', r, growthValues(r))).join('')}</ul>
    </section>` : ''}

    ${fetal.length ? `
    <section class="card">
      <details>
        <summary><h2>${icon('mom')}妊娠中の記録 <span class="count">${fetal.length}件</span></h2></summary>
        <ul class="records">${fetal.map((r) => recordItem('fetalRecords', r, fetalValues(r))).join('')}</ul>
      </details>
    </section>` : ''}`;
}

function renderInfantChart(c, records, fetal) {
  const birth = parseDate(c.birthDate);
  const [key, label, unit] = INFANT_METRICS.find(([k]) => k === ui.infantMetric) || INFANT_METRICS[0];
  const field2 = { weight: 'weightKg', length: 'heightCm', head: 'headCm' }[key];
  const birthVal = { weight: c.birth?.weightG != null ? c.birth.weightG / 1000 : null, length: c.birth?.lengthCm, head: c.birth?.headCm }[key];
  const pts = records.filter((r) => r[field2] != null)
    .map((r) => [diffDays(parseDate(r.date), birth) / DAYS_PER_MONTH, r[field2], `${r.date}（${periodLabel(r.date)}）${r[field2]}${unit}`]);
  if (birthVal != null) pts.push([0, birthVal, `生まれたとき ${birthVal}${unit}`]);
  pts.sort((a, b) => a[0] - b[0]);
  const fetalPts = key === 'weight' && ui.withFetal
    ? fetal.filter((r) => r.efwG != null).map((r) => [diffDays(parseDate(r.date), birth) / DAYS_PER_MONTH, r.efwG / 1000,
      `${r.date}（${periodLabel(r.date)}）推定 ${r.efwG}g`]).sort((a, b) => a[0] - b[0])
    : [];

  const metricChips = chips('infantMetric', key, INFANT_METRICS.map(([k, l]) => [k, l]));
  const fetalToggle = key === 'weight' && fetal.some((r) => r.efwG != null)
    ? `<label class="toggle"><input type="checkbox" data-action="toggle-fetal" ${ui.withFetal ? 'checked' : ''}> 妊娠中の推定体重も表示</label>` : '';
  if (!pts.length && !fetalPts.length) {
    return `<section class="card"><h2>${icon('growth')}発育曲線</h2>${metricChips}<p class="muted">記録するとグラフが表示されます。</p></section>`;
  }

  const allX = [...pts, ...fetalPts].map((p) => p[0]);
  const x0 = Math.min(0, Math.floor(Math.min(...allX)));
  const x1 = Math.max(6, Math.ceil(Math.max(...allX) + 1));
  const sex = c.sex;
  const hasStd = sex && hasInfantStandard(key, sex);
  const band = { lower: [], upper: [], cls: 'band' };
  const median = { pts: [], cls: 'ref' };
  if (hasStd) {
    for (let m = Math.max(0, x0); m <= x1; m += 0.25) {
      const ps = infantPercentilesAt(key, sex, m);
      if (!ps) continue;
      band.lower.push([m, ps[0]]);
      band.upper.push([m, ps[6]]);
      median.pts.push([m, ps[3]]);
    }
  }
  const ys = [...pts, ...fetalPts].map((p) => p[1]).concat(band.upper.map((p) => p[1]), band.lower.map((p) => p[1]));
  const yMax = Math.max(...ys) * 1.06;
  const yMin = key === 'weight' ? 0 : Math.max(0, Math.min(...ys) * 0.9);
  const span = x1 - x0;
  const step = span > 24 ? 6 : span > 12 ? 3 : span > 6 ? 2 : 1;
  const latest = pts[pts.length - 1];
  const bandText = hasStd && latest ? percentileBand(key, sex, latest[0], latest[1]) : null;

  return `
    <section class="card">
      <h2>${icon('growth')}発育曲線</h2>
      ${metricChips}
      ${fetalToggle}
      ${lineChart({
        label: `${label}の推移`,
        xRange: [x0, x1],
        yRange: [yMin, yMax],
        xTicks: ticks(x0, x1).filter((v) => v % step === 0),
        xTick: (v) => (v === 0 ? '誕生' : v < 0 ? `${v}ヶ月` : v % 12 === 0 ? `${v / 12}歳` : `${v}ヶ月`),
        bands: [band],
        refLines: [median],
        series: [
          ...(fetalPts.length ? [{ pts: fetalPts, cls: 'line fetal', dotCls: 'dot fetal' }] : []),
          { pts },
        ],
      })}
      <p class="legend small">
        <span class="lg lg-line"></span>記録
        ${fetalPts.length ? '<span class="lg lg-fetal"></span>妊娠中（推定体重）' : ''}
        ${hasStd ? '<span class="lg lg-band"></span>3〜97パーセンタイル <span class="lg lg-ref"></span>中央値' : ''}
      </p>
      ${bandText ? `<p class="small">最新の記録は ${esc(bandText)} パーセンタイルの間です。</p>` : ''}
      ${!sex ? '<p class="muted small">性別を登録すると、男女別の発育曲線（標準の範囲）を重ねて表示できます。</p>'
        : !hasStd ? '<p class="muted small">この期間の標準値はありません。記録した値だけを表示しています。</p>'
          : `<p class="muted small">標準値: ${esc(INFANT_SOURCE)}（0〜3歳）。日本の母子健康手帳の発育曲線とは少し異なります。</p>`}
      <p class="muted small">発育曲線は一般的な目安です。気になることは健診で医師・保健師に相談してください。</p>
    </section>`;
}

// 週ごとのガイド（既存）
function renderWeeks() {
  const due = dueDate();
  const current = due ? gestationalAge(due, today()).week : null;
  const w = selectedWeek ?? (current != null ? Math.max(4, Math.min(41, current)) : 4);
  const info = weekInfo(w);
  const weekChips = [];
  for (let i = 4; i <= 41; i++) {
    weekChips.push(`<button class="chip ${i === w ? 'active' : ''} ${i === current ? 'current' : ''}" data-action="select-week" data-week="${i}">${i}</button>`);
  }
  const range = due ? `${formatDateJa(addDays(due, (w - 40) * 7))} 〜` : '';

  return `
    <section class="card">
      <h2>週ごとの成長ガイド</h2>
      <div class="chips" id="week-chips">${weekChips.join('')}</div>
    </section>
    <section class="card week-detail">
      <div class="week-head">
        <button class="icon-btn" data-action="select-week" data-week="${Math.max(4, w - 1)}" aria-label="前の週">${icon('chevronLeft')}</button>
        <div>
          <p class="week-title">妊娠${w}週</p>
          ${range ? `<p class="muted small">${range}</p>` : ''}
        </div>
        <button class="icon-btn" data-action="select-week" data-week="${Math.min(41, w + 1)}" aria-label="次の週">${icon('chevronRight')}</button>
      </div>
      <div class="baby-size inline">
        ${sizeVisual(info.week)}
        <div>
          <p class="size-name">${esc(info.size)}くらい</p>
          <p class="small">身長 ${info.length} ／ 体重 ${info.weight}</p>
        </div>
      </div>
      <h3>${icon('baby')}赤ちゃんの様子</h3>
      <p>${esc(info.baby)}</p>
      <h3>${icon('mom')}ママの様子</h3>
      <p>${esc(info.mom)}</p>
      <h3>${icon('lightbulb')}ポイント</h3>
      <p>${esc(info.tip)}</p>
      <p class="muted small">※大きさ・体重は一般的な目安です。個人差があります。</p>
    </section>
    <section class="card">
      <h3>${icon('food')}食べ物の注意点</h3>
      <ul class="food">
        ${FOOD_NOTES.map((f) => `<li class="food-${f.level}"><strong>${esc(f.title)}</strong><span>${esc(f.text)}</span></li>`).join('')}
      </ul>
    </section>`;
}

// ---------- アルバム ----------

function renderAlbum() {
  const head = segmented('albumView', ui.albumView, [['timeline', 'タイムライン'], ['photos', '写真'], ['monthly', '月齢フォト'], ['milestones', 'できごと']]);
  const add = `
    <div class="album-actions edit-only">
      <label class="btn primary file-btn">${icon('camera')}写真・動画
        <input type="file" accept="image/*,video/*" multiple data-action="add-photos" hidden>
      </label>
      <button class="btn ghost" data-action="new-milestone">${icon('star')}できごと</button>
    </div>`;
  const body = { timeline: renderTimeline, photos: renderPhotos, monthly: renderMonthly, milestones: renderMilestones }[ui.albumView]();
  return head + add + body;
}

const TIMELINE_FILTERS = {
  all: () => true,
  measure: (i) => i.kind === 'fetal' || i.kind === 'growth' || i.kind === 'birth',
  photo: (i) => i.kind === 'photos' || (i.record?.photoIds?.length ?? 0) > 0,
  milestone: (i) => i.kind === 'milestone' || i.kind === 'birth',
  journal: (i) => i.kind === 'journal',
};

function renderTimeline() {
  const items = buildTimeline(state, child().id).filter(TIMELINE_FILTERS[ui.timelineFilter] || TIMELINE_FILTERS.all);
  const groups = groupByPeriod(child(), items);
  const filterChips = chips('timelineFilter', ui.timelineFilter,
    [['all', 'すべて'], ['measure', '計測'], ['photo', '写真'], ['milestone', 'できごと'], ['journal', '日記']]);
  if (!groups.length) {
    return `<section class="card">${filterChips}
      <p class="muted">まだ記録がありません。健診の記録や写真、できごとを追加すると、ここに時系列で表示されます。</p></section>`;
  }
  return `
    ${filterChips}
    ${groups.map((g) => `
      <section class="tl-group">
        <h3 class="tl-head">${esc(g.label)}</h3>
        <ul class="timeline">${g.items.map(timelineItem).join('')}</ul>
      </section>`).join('')}`;
}

// ---------- 新着（前回アルバムを見たとき以降に家族が追加したもの） ----------

const SEEN_KEY = 'sukusuku:album-seen';
let albumSeenAt = (() => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || Date.now();
  } catch {
    return Date.now();
  }
})();

function markAlbumSeen() {
  albumSeenAt = Date.now();
  try {
    localStorage.setItem(SEEN_KEY, String(albumSeenAt));
  } catch {
    // 保存できなくても表示に影響しない
  }
}

// 家族（自分以外）が前回の確認以降に追加した記録か
function isNew(r) {
  const a = account();
  if (!a || !r) return false;
  const by = r.createdBy || r.ownerId;
  return !!by && by !== a.userId && (Number(r.createdAt) || 0) > albumSeenAt;
}

function itemIsNew(item) {
  if (item.kind === 'photos') return item.media.some(isNew);
  const target = item.kind === 'birth' ? `birth:${item.record.id}` : String(item.record?.id);
  return isNew(item.record) || state.comments.some((c) => c.targetId === target && isNew(c));
}

function hasNewInAlbum() {
  if (!account()) return false;
  const id = child().id;
  return ['fetalRecords', 'growthRecords', 'milestones', 'media'].some((k) => state[k].some((r) => r.childId === id && isNew(r)))
    || state.comments.some(isNew) || state.journal.some(isNew);
}

function timelineItem(item) {
  const fresh = itemIsNew(item);
  const date = `<span class="tl-date">${esc(item.date)}${fresh ? '<span class="new-badge">新着</span>' : ''}</span>`;
  switch (item.kind) {
    case 'fetal':
      return `<li class="tl tl-measure${fresh ? ' is-new' : ''}">${date}${byline(item.record)}<p class="tl-title">${icon('ruler')}健診の記録</p>
        <div class="vals">${fetalValues(item.record)}</div>
        ${item.record.note ? `<p class="note">${esc(item.record.note)}</p>` : ''}${photoStrip(item.record.photoIds)}
        ${socialBar('fetal', item.record.id)}</li>`;
    case 'growth':
      return `<li class="tl tl-measure${fresh ? ' is-new' : ''}">${date}${byline(item.record)}<p class="tl-title">${icon('ruler')}計測</p>
        <div class="vals">${growthValues(item.record)}</div>
        ${item.record.note ? `<p class="note">${esc(item.record.note)}</p>` : ''}${photoStrip(item.record.photoIds)}
        ${socialBar('growth', item.record.id)}</li>`;
    case 'birth':
      return `<li class="tl tl-birth${fresh ? ' is-new' : ''}">${date}<p class="tl-title">${icon('gift')}${babyLabel()}誕生</p>
        <div class="vals">${birthValues(item.record)}</div>${socialBar('birth', `birth:${item.record.id}`)}</li>`;
    case 'milestone': {
      const t = milestoneTemplate(item.record.templateId);
      return `<li class="tl tl-milestone${fresh ? ' is-new' : ''}">${date}
        <p class="tl-title">${icon(t ? t.icon : 'star')}${esc(item.record.title)}
          <button class="icon-btn small" data-action="edit-milestone" data-id="${esc(item.record.id)}" aria-label="開く">${icon('chevronRight')}</button></p>
        ${item.record.note ? `<p class="note">${esc(item.record.note).replace(/\n/g, '<br>')}</p>` : ''}${photoStrip(item.record.photoIds)}
        ${socialBar('milestone', item.record.id)}</li>`;
    }
    case 'photos':
      return `<li class="tl tl-photo${fresh ? ' is-new' : ''}">${date}<p class="tl-title">${icon('camera')}${item.media.some(isVideo) ? '写真・動画' : '写真'} ${item.media.length}件</p>
        <div class="photo-strip">${item.media.map((m) => photoThumb(m.id)).join('')}</div></li>`;
    case 'journal':
      return `<li class="tl tl-journal${fresh ? ' is-new' : ''}">${date}${isMine(item.record) ? '' : byline(item.record, true)}<p class="tl-title">${moodIcon(moodLevel(item.record.mood))}日記${item.record.private ? icon('lock', 'inline') : ''}</p>
        <p class="note">${esc(item.record.text).replace(/\n/g, '<br>')}</p>${socialBar('journal', String(item.record.id))}</li>`;
    default:
      return '';
  }
}

// 家族共有中: 誰が記録したか
function byline(r, owner = false) {
  if (!account()) return '';
  const uid = owner ? r.ownerId : (r.updatedBy || r.createdBy);
  return uid ? `<span class="byline">${esc(memberName(uid))}</span>` : '';
}

// ---------- リアクション・コメント ----------

// リアクション（id の末尾の番号で種類を区別する）
const REACTIONS = [['heart', '大好き'], ['thumbsUp', 'いいね'], ['sparkle', 'すごい'], ['smile', 'かわいい']];
const reactionIndex = (r) => Number(String(r.id).split('.').pop());

function socialBar(targetType, targetId) {
  if (!account() || targetId == null) return '';
  const me = account().userId;
  const reactions = state.reactions.filter((r) => r.targetId === targetId);
  const comments = state.comments.filter((c) => c.targetId === targetId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const open = ui.openComments.has(targetId);
  return `<div class="social">
    <div class="social-row">
      ${REACTIONS.map(([name, label], i) => {
        const who = reactions.filter((r) => reactionIndex(r) === i);
        const mine = who.some((r) => r.id === `${me}.${targetId}.${i}`);
        return `<button class="react ${mine ? 'mine' : ''}" aria-pressed="${mine}" data-action="react" data-type="${targetType}"
          data-target="${esc(targetId)}" data-i="${i}" aria-label="${label}" title="${esc([label, ...who.map((r) => memberName(r.ownerId || me))].join('：'))}">${icon(name)}${who.length ? `<span>${who.length}</span>` : ''}</button>`;
      }).join('')}
      <button class="react comment-toggle" data-action="toggle-comments" data-target="${esc(targetId)}" aria-expanded="${open}" aria-label="コメント">${icon('comment')}${comments.length ? `<span>${comments.length}</span>` : ''}</button>
    </div>
    ${open ? `<div class="comments">
      ${comments.map((c) => `<p class="comment"><strong>${esc(memberName(c.ownerId || me))}</strong> ${esc(c.text)}
        ${isMine(c) || isAdmin() ? `<button class="icon-btn small" data-action="delete-comment" data-id="${esc(c.id)}" aria-label="コメントを削除">${icon('close')}</button>` : ''}</p>`).join('')}
      <form data-form="comment" class="comment-form">
        <input type="hidden" name="targetType" value="${targetType}">
        <input type="hidden" name="targetId" value="${esc(targetId)}">
        <input name="text" maxlength="300" placeholder="コメントを書く" required autocomplete="off">
        <button class="btn primary tiny">送信</button>
      </form>
    </div>` : ''}
  </div>`;
}

function toggleReaction(targetType, targetId, i) {
  const id = `${account().userId}.${targetId}.${i}`;
  const idx = state.reactions.findIndex((r) => r.id === id);
  if (idx >= 0) state.reactions.splice(idx, 1);
  else state.reactions.push({ id, targetType, targetId, emoji: REACTIONS[i][0], createdAt: Date.now() });
  persist();
}

function rerenderSocial() {
  render();
  if (dialogs.viewer.open) renderViewerSocial();
}

function albumPhotos() {
  return mine(state.media).sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.createdAt - a.createdAt);
}

function renderPhotos() {
  const photos = albumPhotos();
  if (!photos.length) {
    return '<section class="card"><p class="muted">写真はまだありません。エコー写真やおなかの写真、生まれてからの写真を追加しましょう。</p></section>';
  }
  const groups = groupByPeriod(child(), photos.map((m) => ({ date: m.takenAt, media: m })));
  return groups.map((g) => `
    <section class="tl-group">
      <h3 class="tl-head">${esc(g.label)} <span class="muted small">${g.items.length}枚</span></h3>
      <div class="photo-grid">${g.items.map((i) => photoThumb(i.media.id)).join('')}</div>
    </section>`).join('');
}

// 月齢フォト: 月ごとに 1 枚ずつ並べて成長を見比べる
function renderMonthly() {
  const c = child();
  const chosen = new Map();
  for (const m of mine(state.media)) {
    if (!m.monthly) continue;
    const pm = photoMonthOf(c, m.takenAt);
    if (pm) chosen.set(pm.key, m);
  }
  const t = today();
  const tile = (pm) => {
    const m = chosen.get(pm.key);
    return `<figure class="month-tile ${m ? '' : 'empty'}">
      ${m ? photoThumb(m.id) : '<div class="photo placeholder"></div>'}
      <figcaption>${esc(photoMonthLabel(pm))}</figcaption>
    </figure>`;
  };
  const birth = parseDate(c.birthDate);
  const due = dueDate();
  let html = '';
  if (due || birth) {
    const lastP = birth ? photoMonthOf(c, formatDate(addDays(birth, -1)))
      : photoMonthOf(c, formatDate(t));
    if (lastP?.phase === 'pregnancy') {
      const months = [];
      for (let i = 2; i <= lastP.month; i++) months.push({ phase: 'pregnancy', month: i, key: `p${i}` });
      html += `<section class="card"><h2>${icon('mom')}おなかの写真</h2><div class="month-grid">${months.map(tile).join('')}</div></section>`;
    }
  }
  if (birth) {
    const now = ageOf(birth, t)?.totalMonths ?? 0;
    const months = [];
    for (let i = 0; i <= Math.min(now, 47); i++) months.push({ phase: 'baby', month: i, key: `b${i}` });
    html += `<section class="card"><h2>${icon('baby')}生まれてから</h2><div class="month-grid">${months.map(tile).join('')}</div></section>`;
  }
  if (!html) {
    return '<section class="card"><p class="muted">出産予定日か誕生日を設定すると、月ごとの写真を並べて見られます。</p></section>';
  }
  return `<p class="muted small hint">写真を開いて「月齢フォトにする」を押すと、その月の 1 枚として表示されます。毎月同じ場所・同じ構図で撮ると、成長がよく分かります。</p>${html}`;
}

function renderMilestones() {
  const records = mine(state.milestones);
  const byTemplate = new Map(records.filter((r) => r.templateId).map((r) => [r.templateId, r]));
  const custom = records.filter((r) => !r.templateId).sort(byDateDesc);
  const section = (phase, title) => `
    <section class="card">
      <h2>${title}</h2>
      <ul class="milestones">
        ${MILESTONE_TEMPLATES.filter((t) => t.phase === phase).map((t) => {
          const r = byTemplate.get(t.id);
          return `<li class="${r ? 'done' : ''}">
            <span class="ms-mark">${icon(r ? 'checkCircle' : t.icon)}</span>
            <span class="ms-body"><strong>${esc(t.title)}</strong>
              <small class="muted">${r ? `${esc(r.date)}（${esc(periodLabel(r.date))}）` : esc(t.hint)}</small></span>
            ${r ? `<button class="btn ghost tiny" data-action="edit-milestone" data-id="${esc(r.id)}">見る</button>`
              : `<button class="btn ghost tiny edit-only" data-action="new-milestone" data-template="${t.id}">記録</button>`}
          </li>`;
        }).join('')}
      </ul>
    </section>`;
  const born = isBorn(child());
  return `
    ${born ? section('baby', '生まれてから') : section('pregnancy', '妊娠中')}
    ${custom.length ? `
    <section class="card">
      <h2>そのほかの「初めて」</h2>
      <ul class="milestones">${custom.map((r) => `<li class="done">
        <span class="ms-mark">${icon('checkCircle')}</span>
        <span class="ms-body"><strong>${esc(r.title)}</strong><small class="muted">${esc(r.date)}（${esc(periodLabel(r.date))}）</small></span>
        <button class="btn ghost tiny" data-action="edit-milestone" data-id="${esc(r.id)}">見る</button></li>`).join('')}
      </ul>
    </section>` : ''}
    ${born ? section('pregnancy', '妊娠中') : section('baby', '生まれてから（これから）')}
    <p class="muted small center">時期は一般的な目安です。発達には個人差があります。</p>`;
}

// ---------- ママ（体重・日記・陣痛・胎動） ----------

// 記録した人（'me' または家族のユーザー ID）
const ownerKey = (r) => (isMine(r) ? 'me' : r.ownerId);
const MOM_COLLECTIONS = ['weights', 'journal', 'contractions', 'kicks'];

function momOwners() {
  const others = new Set();
  for (const coll of MOM_COLLECTIONS) state[coll].forEach((r) => { if (!isMine(r)) others.add(r.ownerId); });
  return [...others];
}

function currentMomOwner() {
  const others = momOwners();
  if (ui.momOwner && (ui.momOwner === 'me' ? canEdit() : others.includes(ui.momOwner))) return ui.momOwner;
  const hasOwn = MOM_COLLECTIONS.some((c) => state[c].some(isMine));
  return (!canEdit() || !hasOwn) && others.length ? others[0] : 'me';
}

const momList = (coll, owner = currentMomOwner()) => state[coll].filter((r) => ownerKey(r) === owner);

function renderMom() {
  const owner = currentMomOwner();
  const others = momOwners();
  const head = segmented('momView', ui.momView, [['records', '体重・日記'], ['tools', '陣痛・胎動']]);
  const ownerChips = others.length
    ? chips('momOwner', owner, [...(canEdit() ? [['me', '自分']] : []), ...others.map((uid) => [uid, memberName(uid)])]) : '';
  if (!canEdit() && !others.length) {
    return `${head}<section class="card"><p class="muted">ママの記録は、共有されたときにここに表示されます。</p></section>`;
  }
  const readOnly = owner !== 'me';
  return head + ownerChips
    + (readOnly ? `<p class="muted small">${esc(memberName(owner))}さんが共有している記録です。</p>` : renderShareCard())
    + (ui.momView === 'tools' ? renderTools(readOnly) : renderRecords(readOnly));
}

function renderShareCard() {
  if (!account() || !canEdit()) return '';
  const share = state.shares.find((x) => x.id === account().userId) || {};
  const item = (key, label) => `<label class="toggle"><input type="checkbox" data-action="share-toggle" data-key="${key}" ${share[key] ? 'checked' : ''}> ${label}</label>`;
  return `
    <section class="card share-card">
      <details>
        <summary><h2>${icon('users')}家族への共有 <span class="count">${['weight', 'journal', 'labor'].filter((k) => share[k]).length}/3</span></h2></summary>
        <p class="muted small">オンにした記録だけ、家族グループのメンバーが見られます。</p>
        ${item('weight', '体重')}
        ${item('journal', '日記（「自分だけ」にした日記は共有されません）')}
        ${item('labor', '陣痛・胎動の記録')}
      </details>
    </section>`;
}

function activeContraction() {
  const own = momList('contractions', 'me');
  const last = own[own.length - 1];
  return last && last.end == null ? last : null;
}

function activeKick() {
  const own = momList('kicks', 'me');
  const last = own[own.length - 1];
  return last && last.end == null ? last : null;
}

function renderTools(readOnly) {
  const contractions = momList('contractions').sort((a, b) => a.start - b.start);
  const kicks = momList('kicks').sort((a, b) => a.start - b.start);
  const lastC = contractions[contractions.length - 1];
  const active = lastC && lastC.end == null ? lastC : null;
  const stats = contractionStats(contractions);
  const recent = contractions.slice(-10).map((c, i, arr) => {
    const prev = i > 0 ? arr[i - 1] : contractions[contractions.length - arr.length - 1];
    const interval = prev ? (c.start - prev.start) / 1000 : null;
    return { ...c, interval };
  }).reverse();

  const lastK = kicks[kicks.length - 1];
  const kick = lastK && lastK.end == null ? lastK : null;
  const kickHistory = kicks.filter((k) => k.end != null).slice(-5).reverse();

  return `
    <section class="card">
      <h2>${icon('timer')}陣痛タイマー</h2>
      ${readOnly ? (active ? '<p class="alert">いま陣痛を計測中です</p>' : '') : `
      <p class="muted small">痛みが始まったら「開始」、おさまったら「終了」をタップ。間隔（開始〜次の開始）と持続時間を記録します。</p>
      <button class="big-btn ${active ? 'stop' : ''}" data-action="toggle-contraction">
        ${active ? '陣痛おさまった（終了）' : '陣痛きた（開始）'}
      </button>`}
      ${active ? `<p class="live">持続時間 <strong data-live-since="${active.start}">0秒</strong></p>` : ''}
      <div class="stats">
        <div><span>平均間隔</span><strong>${formatDuration(stats.avgIntervalSec)}</strong></div>
        <div><span>平均持続</span><strong>${formatDuration(stats.avgDurationSec)}</strong></div>
        <div><span>記録数</span><strong>${stats.count}回</strong></div>
      </div>
      ${stats.avgIntervalSec != null && stats.avgIntervalSec <= 600 && stats.count >= 4
        ? '<p class="alert">間隔が10分以内になっています。産院から指示された連絡のタイミングを確認し、必要なら電話しましょう。</p>' : ''}
      ${recent.length ? `
      <table class="log">
        <thead><tr><th>開始</th><th>持続</th><th>間隔</th></tr></thead>
        <tbody>
          ${recent.map((c) => `<tr>
            <td>${safeTime(timeFmt, c.start)}</td>
            <td>${c.end ? formatDuration((c.end - c.start) / 1000) : '計測中'}</td>
            <td>${formatDuration(c.interval)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${readOnly ? '' : '<button class="btn ghost small" data-action="clear-contractions">記録をリセット</button>'}` : ''}
    </section>

    <section class="card">
      <h2>${icon('footprints')}胎動カウンター</h2>
      ${readOnly ? (kick ? `<p>カウント中: <strong>${esc(kick.count)}</strong> / 10</p>` : '') : `
      <p class="muted small">赤ちゃんが動いたらタップ。10回動くまでの時間を測ります（目安として妊娠28週ごろから）。</p>
      ${kick ? `
        <button class="big-btn kick" data-action="kick">動いた <strong>${esc(kick.count)}</strong> / 10</button>
        <p class="live">経過時間 <strong data-live-since="${kick.start}">0秒</strong></p>
        <button class="btn ghost small" data-action="finish-kick">カウントを終了</button>
      ` : '<button class="big-btn" data-action="start-kick">カウントを始める</button>'}`}
      ${kickHistory.length ? `
      <table class="log">
        <thead><tr><th>日時</th><th>回数</th><th>かかった時間</th></tr></thead>
        <tbody>
          ${kickHistory.map((k) => `<tr>
            <td>${safeTime(shortDateFmt, k.start)}</td>
            <td>${esc(k.count)}回</td>
            <td>${formatDuration((k.end - k.start) / 1000)}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : ''}
      <p class="muted small">いつもより明らかに胎動が少ない・感じないときは、すぐに産院へ連絡してください。</p>
    </section>`;
}

function renderWeightChart(due, weights, pre) {
  const pts = [...weights].sort(byDateAsc);
  if (pts.length < 2) return '';
  const xs = pts.map((p) => {
    const d = parseDate(p.date);
    return due ? gestationalAge(due, d).totalDays / 7 : diffDays(d, parseDate(pts[0].date)) / 7;
  });
  const ys = pts.map((p) => p.kg);
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.max(Math.ceil(Math.max(...xs)), minX + 1);
  const minY = Math.floor(Math.min(...ys, pre ?? Infinity) - 1);
  const maxY = Math.ceil(Math.max(...ys) + 1);
  return lineChart({
    label: '体重の推移',
    xRange: [minX, maxX],
    yRange: [minY, maxY],
    xTick: (v) => (due ? `${v}週` : `${v}`),
    refLines: pre ? [{ pts: [[minX, pre], [maxX, pre]], cls: 'baseline' }] : [],
    series: [{ pts: xs.map((x, i) => [x, ys[i], `${pts[i].date} ${ys[i]}kg`]) }],
  });
}


function renderRecords(readOnly) {
  const due = dueDate();
  const { heightCm, preWeightKg } = readOnly ? {} : state.profile;
  const guide = weightGainGuide(heightCm, preWeightKg);
  const weights = momList('weights').sort(byDateDesc);
  const latest = weights[0];
  const gain = latest && preWeightKg ? Math.round((latest.kg - preWeightKg) * 10) / 10 : null;
  const journal = momList('journal').sort((a, b) => b.date.localeCompare(a.date)
    || (b.createdAt ?? Number(b.id) ?? 0) - (a.createdAt ?? Number(a.id) ?? 0));

  return `
    <section class="card">
      <h2>${icon('scale')}体重記録</h2>
      ${readOnly ? '' : `
      <form class="inline-form" data-form="weight">
        <input type="date" name="date" value="${todayStr()}" required>
        <input type="number" name="kg" step="0.1" min="25" max="200" inputmode="decimal" placeholder="kg" required>
        <button class="btn primary">記録</button>
      </form>
      ${guide ? `
        <p class="small">妊娠前 BMI <strong>${guide.bmi}</strong>（${guide.category}）・
        増加の目安 <strong>${guide.range ? `${guide.range[0]}〜${guide.range[1]}kg` : '医師と相談（上限5kg程度が目安）'}</strong></p>
        ${gain != null ? `<p class="small">現在の増加: <strong>${gain > 0 ? '+' : ''}${gain}kg</strong></p>` : ''}
      ` : '<p class="muted small">設定で身長と妊娠前の体重を入力すると、体重増加の目安が表示されます。</p>'}`}
      ${renderWeightChart(due, weights, readOnly ? null : preWeightKg)}
      ${weights.length ? `
      <ul class="entries">
        ${weights.slice(0, 8).map((w) => `<li>
          <span>${esc(w.date)}${due ? `（${gestationalAge(due, parseDate(w.date)).week}週）` : ''}</span>
          <strong>${esc(w.kg)}kg</strong>
          ${readOnly ? '' : `<button class="icon-btn small" data-action="delete-weight" data-id="${esc(w.id)}" aria-label="削除">${icon('trash')}</button>`}
        </li>`).join('')}
      </ul>` : (readOnly ? '<p class="muted small">共有された体重の記録はありません。</p>' : '')}
    </section>

    <section class="card">
      <h2>${icon('book')}日記</h2>
      ${readOnly ? '' : `
      <form data-form="journal" class="journal-form">
        <div class="moods">
          ${MOOD_LABELS.map((label, i) => `<label title="${label}"><input type="radio" name="mood" value="${i}" ${i === 1 ? 'checked' : ''} aria-label="${label}"><span>${moodIcon(i)}</span></label>`).join('')}
        </div>
        <textarea name="text" rows="3" maxlength="1000" placeholder="体調、健診で言われたこと、${babyLabel()}へのメッセージなど" required></textarea>
        ${account() ? '<label class="toggle"><input type="checkbox" name="private"> 自分だけ（家族には見せない）</label>' : ''}
        <button class="btn primary">保存</button>
      </form>`}
      ${journal.length ? `
      <ul class="journal">
        ${journal.map((j) => `<li>
          <div class="journal-head">
            <span class="journal-meta">${moodIcon(moodLevel(j.mood), 'mood')}${esc(j.date)}・${esc(periodLabel(j.date))}${j.private ? icon('lock', 'inline') : ''}</span>
            ${readOnly ? '' : `<button class="icon-btn small" data-action="delete-journal" data-id="${esc(j.id)}" aria-label="削除">${icon('trash')}</button>`}
          </div>
          <p>${esc(j.text).replace(/\n/g, '<br>')}</p>
          ${socialBar('journal', String(j.id))}
        </li>`).join('')}
      </ul>` : (readOnly ? '<p class="muted small">共有された日記はありません。</p>' : '')}
    </section>`;
}

// ---------- 準備（健診・入院準備・手続き） ----------

function checkbox(key, label, extra = '') {
  const checked = !!state.checks[key];
  return `<li class="${checked ? 'done' : ''}"><label>
    <input type="checkbox" data-action="check" data-key="${esc(key)}" ${checked ? 'checked' : ''}>
    <span>${esc(label)}${extra}</span></label></li>`;
}

function progressText(keys) {
  const done = keys.filter((k) => state.checks[k]).length;
  return `${done}/${keys.length}`;
}

function renderLists() {
  const due = dueDate();
  const t = today();

  const schedule = due ? checkupSchedule(due) : [];
  const bagKeys = HOSPITAL_BAG.flatMap((g) => g.items.map((i) => `bag:${i}`));
  const procKeys = PROCEDURES.flatMap((g) => g.items.map((i) => `proc:${i.title}`));

  return `
    <section class="card">
      <details ${isBorn(child()) ? '' : 'open'}>
        <summary><h2>${icon('hospital')}妊婦健診スケジュール（目安）</h2></summary>
        ${due ? `
        <p class="muted small">〜23週: 4週に1回 / 24〜35週: 2週に1回 / 36週〜: 毎週。実際の日程は産院の指示に従ってください。</p>
        <ul class="checklist">
          ${schedule.map((c) => {
            const past = diffDays(c.date, t) < 0;
            const done = !!state.checkups[c.week];
            return `<li class="${done ? 'done' : ''} ${past && !done ? 'past' : ''}"><label>
              <input type="checkbox" data-action="checkup" data-week="${c.week}" ${done ? 'checked' : ''}>
              <span>第${c.number}回・${c.week}週 <span class="muted">${formatDateJa(c.date)}ごろ</span></span>
            </label></li>`;
          }).join('')}
        </ul>` : '<p class="muted">出産予定日を設定すると表示されます。</p>'}
      </details>
    </section>

    <section class="card">
      <details>
        <summary><h2>${icon('bag')}入院準備リスト <span class="count">${progressText(bagKeys)}</span></h2></summary>
        ${HOSPITAL_BAG.map((g) => `
          <h3>${esc(g.group)}</h3>
          <ul class="checklist">${g.items.map((i) => checkbox(`bag:${i}`, i)).join('')}</ul>
        `).join('')}
      </details>
    </section>

    <section class="card">
      <details ${isBorn(child()) ? 'open' : ''}>
        <summary><h2>${icon('document')}手続きリスト <span class="count">${progressText(procKeys)}</span></h2></summary>
        <p class="muted small">制度の内容・期限は自治体や勤務先によって異なります。最新情報は各窓口で確認してください。</p>
        ${PROCEDURES.map((g) => `
          <h3>${esc(g.when)}</h3>
          <ul class="checklist">${g.items.map((i) => checkbox(
            `proc:${i.title}`, i.title,
            `<small class="muted">${esc(i.where)}｜${esc(i.note)}</small>`,
          )).join('')}</ul>
        `).join('')}
      </details>
    </section>`;
}

// ---------- 描画・ナビゲーション ----------

const RENDERERS = { home: renderHome, growth: renderGrowth, album: renderAlbum, mom: renderMom, lists: renderLists };
// 以前のタブ名（ブックマーク等）からの移行
const LEGACY_TABS = { weeks: ['growth', { growthView: 'guide' }], tools: ['mom', { momView: 'tools' }], records: ['mom', { momView: 'records' }] };

function render({ keepScroll = true } = {}) {
  const y = window.scrollY;
  updateChildSwitch();
  view.innerHTML = RENDERERS[currentTab]();
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const active = b.dataset.tab === currentTab;
    b.classList.toggle('active', active);
    if (b.dataset.tab === 'album') b.classList.toggle('has-new', !active && hasNewInAlbum());
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (keepScroll) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  updateLive();
  media.hydrateImages(view);
  if (currentTab === 'growth' && ui.growthView === 'guide') {
    document.querySelector('#week-chips .chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function switchTab(tab) {
  if (LEGACY_TABS[tab]) {
    Object.assign(ui, LEGACY_TABS[tab][1]);
    [tab] = LEGACY_TABS[tab];
  }
  if (!RENDERERS[tab]) return;
  if (currentTab === 'album' && tab !== 'album') markAlbumSeen();
  currentTab = tab;
  ui.editing = null;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  render({ keepScroll: false });
}

function updateLive() {
  const now = Date.now();
  document.querySelectorAll('[data-live-since]').forEach((el) => {
    el.textContent = formatDuration((now - Number(el.dataset.liveSince)) / 1000);
  });
}
setInterval(updateLive, 1000);

// ---------- 設定 ----------

async function openSettings() {
  const c = child();
  settingsForm.dueDate.value = c.dueDate || '';
  settingsForm.lmp.value = '';
  settingsForm.babyName.value = c.name || '';
  settingsForm.heightCm.value = state.profile.heightCm ?? '';
  settingsForm.preWeightKg.value = state.profile.preWeightKg ?? '';
  dialogs.settings.showModal();
  document.getElementById('import-label').hidden = !!account();
  familyMembers = null;
  renderFamilySection();
  const est = await media.storageEstimate();
  document.getElementById('storage-usage').textContent = est?.usage != null
    ? `（使用量: 約${Math.round(est.usage / 1024 / 1024)}MB・写真${mine(state.media).length}枚）` : '';
}

settingsForm.lmp.addEventListener('change', () => {
  const lmp = parseDate(settingsForm.lmp.value);
  if (lmp) settingsForm.dueDate.value = formatDate(dueDateFromLmp(lmp));
});

settingsForm.addEventListener('submit', (e) => {
  const due = settingsForm.dueDate.value;
  if (due && !parseDate(due)) {
    e.preventDefault();
    toast('日付の形式が正しくありません');
    return;
  }
  if (due && !isBorn(child())) {
    const d = diffDays(parseDate(due), today());
    if (d > 300 || d < -60) {
      e.preventDefault();
      toast('出産予定日を確認してください');
      return;
    }
  }
  Object.assign(child(), { dueDate: due, name: settingsForm.babyName.value.trim(), updatedAt: Date.now() });
  state.profile = {
    heightCm: num(settingsForm.heightCm.value),
    preWeightKg: num(settingsForm.preWeightKg.value),
  };
  selectedWeek = null;
  persist();
  render();
  toast('保存しました');
});

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sukusuku-backup-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// すべてのデータを ZIP で保存（記録の JSON と、写真・動画の元のファイル）
async function exportZip() {
  if (busy) return;
  busy = true;
  try {
    const files = [
      { name: 'data.json', data: JSON.stringify(state, null, 2) },
      {
        name: 'README.txt',
        data: [
          'すくすくノート バックアップ',
          `作成日: ${formatDateJa(today())}`,
          '',
          'data.json  … 記録のデータ（設定の「バックアップから復元」で読み込めます）',
          'photos/    … 写真・動画（子どもごと、撮影日順）',
        ].join('\r\n'),
      },
    ];
    const folders = new Map(state.children.map((c, i) => [c.id, safeName(childName(c, i))]));
    const list = [...state.media].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    let missing = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      toast(`写真・動画を集めています… (${i + 1}/${list.length})`, 0);
      const blob = await media.getBlob(m.id, 'full');
      if (!blob) {
        missing += 1;
        continue;
      }
      const ext = isVideo(m) ? ({ 'video/quicktime': 'mov', 'video/webm': 'webm' }[blob.type] || 'mp4') : 'jpg';
      const caption = m.caption ? `_${safeName(m.caption).slice(0, 20)}` : '';
      files.push({
        name: `photos/${folders.get(m.childId) || 'other'}/${m.takenAt}_${String(m.id).slice(0, 8)}${caption}.${ext}`,
        data: blob,
        date: new Date(m.createdAt || Date.now()),
      });
    }
    toast('ZIP ファイルを作成しています…', 0);
    const zip = await createZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = `sukusuku-${todayStr()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60 * 1000);
    toast(missing ? `保存しました（${missing}件の写真・動画は取得できませんでした）` : `保存しました（写真・動画 ${list.length} 件）`, 4000);
  } catch (e) {
    toast(e?.message === 'too_large' ? 'データが大きすぎて 1 つの ZIP にできません（約 4GB まで）' : 'ZIP を作成できませんでした', 5000);
  } finally {
    busy = false;
  }
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !(data.profile || data.children)) throw new Error('invalid');
    if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
    state = store.mergeState(data);
    persist();
    dialogs.settings.close();
    render();
    toast('復元しました');
  } catch {
    toast('バックアップファイルを読み込めませんでした');
  }
}

// ---------- 子ども（きょうだい） ----------

function childStatus(c) {
  const birth = parseDate(c.birthDate);
  if (birth) return formatAge(ageOf(birth, today())) || '誕生予定';
  const due = parseDate(c.dueDate);
  if (!due) return '予定日未設定';
  const ga = gestationalAge(due, today());
  return ga.notStarted ? '予定日未確認' : `妊娠${ga.week}週${ga.day}日`;
}

const childName = (c, i) => c.name || (state.children.length > 1 ? `${i + 1}人目` : '赤ちゃん');

function updateChildSwitch() {
  const el = document.getElementById('child-switch');
  const multi = state.children.length > 1;
  el.hidden = !multi;
  document.querySelector('.app-name').hidden = multi;
  if (multi) {
    const i = Math.max(0, state.children.findIndex((c) => c.id === child().id));
    el.innerHTML = `<span>${esc(childName(child(), i))}</span>${icon('chevronDown')}`;
  }
}

function renderChildrenDialog() {
  const body = document.getElementById('children-body');
  body.innerHTML = `
    <h2>${icon('baby')}子どもを切り替え</h2>
    <ul class="child-list">
      ${state.children.map((c, i) => `<li class="${c.id === child().id ? 'active' : ''}">
        <button type="button" class="child-pick" data-action="select-child" data-id="${esc(c.id)}">
          <span class="ms-mark">${icon(c.id === child().id ? 'checkCircle' : 'circle')}</span>
          <span class="ms-body"><strong>${esc(childName(c, i))}</strong><small class="muted">${esc(childStatus(c))}</small></span>
        </button>
        ${state.children.length > 1 ? `<button type="button" class="icon-btn small edit-only" data-action="delete-child" data-id="${esc(c.id)}" aria-label="${esc(childName(c, i))}を削除">${icon('trash')}</button>` : ''}
      </li>`).join('')}
    </ul>
    <form data-form="add-child" class="record-form edit-only">
      <h3>${icon('plus')}きょうだいを追加</h3>
      <label>ニックネーム・名前<input name="name" maxlength="20" required placeholder="例: ふたばちゃん"></label>
      <fieldset class="seg-field">
        <legend>状態</legend>
        <label><input type="radio" name="stage" value="pregnancy" checked><span>妊娠中</span></label>
        <label><input type="radio" name="stage" value="born"><span>生まれている</span></label>
      </fieldset>
      <label><span data-stage-label>出産予定日</span><input type="date" name="date" required></label>
      <div class="actions">
        <button type="button" class="btn ghost" data-action="close-dialog">閉じる</button>
        <button class="btn primary">追加</button>
      </div>
    </form>
    <div class="actions" ${canEdit() ? 'hidden' : ''}><button type="button" class="btn ghost" data-action="close-dialog">閉じる</button></div>`;
  body.querySelectorAll('input[name="stage"]').forEach((r) => r.addEventListener('change', () => {
    body.querySelector('[data-stage-label]').textContent = r.value === 'born' && r.checked ? '生年月日' : '出産予定日';
  }));
}

function openChildren() {
  renderChildrenDialog();
  if (!dialogs.children.open) dialogs.children.showModal();
}

function selectChild(id) {
  if (!state.children.some((c) => c.id === id)) return;
  state.activeChildId = id;
  ui.editing = null;
  selectedWeek = null;
  store.save(state); // どの子を表示しているかは端末ごとの設定（同期しない）
  render({ keepScroll: false });
}

function addChild(form) {
  const name = form.name.value.trim();
  const date = form.date.value;
  const born = form.stage.value === 'born';
  if (!name || !parseDate(date)) return;
  const diff = diffDays(parseDate(date), today());
  if (born ? diff > 0 : diff > 300 || diff < -60) {
    toast(born ? '生年月日を確認してください' : '出産予定日を確認してください');
    return;
  }
  const c = store.newChild({ name, ...(born ? { birthDate: date } : { dueDate: date }) });
  state.children.push(c);
  state.activeChildId = c.id;
  persist();
  dialogs.children.close();
  dialogs.settings.close();
  render({ keepScroll: false });
  toast(`${name}を追加しました`);
}

function deleteChild(id) {
  const c = state.children.find((x) => x.id === id);
  if (!c || state.children.length < 2) return;
  const counts = ['fetalRecords', 'growthRecords', 'milestones', 'media'].reduce((n, k) => n + state[k].filter((r) => r.childId === id).length, 0);
  if (!confirm(`${c.name || 'この子'}を削除しますか？記録・写真 ${counts} 件もすべて削除され、元に戻せません。`)) return;
  for (const k of ['fetalRecords', 'growthRecords', 'milestones']) state[k] = state[k].filter((r) => r.childId !== id);
  const mediaIds = state.media.filter((m) => m.childId === id).map((m) => m.id);
  state.media = state.media.filter((m) => m.childId !== id);
  mediaIds.forEach((m) => media.deleteFile(m).catch(() => {}));
  state.children = state.children.filter((x) => x.id !== id);
  if (state.activeChildId === id) state.activeChildId = state.children[0].id;
  persist();
  renderChildrenDialog();
  render();
}

// ---------- 誕生の登録 ----------

function updateBirthGest() {
  const due = dueDate();
  const b = parseDate(birthForm.birthDate.value);
  const el = document.getElementById('birth-gest');
  if (due && b) {
    const ga = gestationalAge(due, b);
    el.textContent = `在胎 ${ga.week}週${ga.day}日（出産予定日 ${formatDateJa(due)}）`;
  } else {
    el.textContent = due ? '' : '出産予定日を設定しておくと、在胎週数も記録されます。';
  }
}

function openBirth() {
  const c = child();
  birthForm.birthDate.value = c.birthDate || todayStr();
  birthForm.querySelector(`input[name="sex"][value="${c.sex || ''}"]`).checked = true;
  birthForm.weightG.value = c.birth?.weightG ?? '';
  birthForm.lengthCm.value = c.birth?.lengthCm ?? '';
  birthForm.headCm.value = c.birth?.headCm ?? '';
  birthForm.chestCm.value = c.birth?.chestCm ?? '';
  document.getElementById('clear-birth').hidden = !isBorn(c);
  updateBirthGest();
  dialogs.birth.showModal();
}

birthForm.birthDate.addEventListener('change', updateBirthGest);

birthForm.addEventListener('submit', (e) => {
  const date = birthForm.birthDate.value;
  const d = parseDate(date);
  if (!d || diffDays(d, today()) > 0) {
    e.preventDefault();
    toast('生年月日を確認してください');
    return;
  }
  const c = child();
  const first = !isBorn(c);
  Object.assign(c, {
    birthDate: date,
    sex: birthForm.sex.value,
    birth: {
      weightG: num(birthForm.weightG.value),
      lengthCm: num(birthForm.lengthCm.value),
      headCm: num(birthForm.headCm.value),
      chestCm: num(birthForm.chestCm.value),
    },
    updatedAt: Date.now(),
  });
  persist();
  dialogs.settings.close();
  if (first) {
    ui.growthView = 'records';
    switchTab('home');
    toast('ご出産おめでとうございます', 3500);
  } else {
    render();
    toast('保存しました');
  }
});

// ---------- できごと ----------

function openMilestone({ id = null, templateId = null } = {}) {
  const r = id ? state.milestones.find((m) => m.id === id) : null;
  const t = milestoneTemplate(r?.templateId ?? templateId);
  milestoneForm.reset();
  milestoneForm.id.value = r?.id || '';
  milestoneForm.templateId.value = r?.templateId || t?.id || '';
  milestoneForm.date.value = r?.date || todayStr();
  milestoneForm.title.value = r?.title || t?.title || '';
  milestoneForm.note.value = r?.note || '';
  document.getElementById('milestone-title').textContent = r ? 'できごと' : 'できごとを記録';
  document.getElementById('delete-milestone').hidden = !r;
  milestoneForm.querySelectorAll('input, textarea').forEach((i) => { i.disabled = !canEdit(); });
  const old = milestoneForm.querySelector('.photo-strip');
  old?.remove();
  if (r?.photoIds?.length) {
    milestoneForm.photos.closest('label').insertAdjacentHTML('afterend', photoStrip(r.photoIds));
    media.hydrateImages(milestoneForm);
  }
  dialogs.milestone.showModal();
}

milestoneForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const date = milestoneForm.date.value;
  const title = milestoneForm.title.value.trim();
  if (!parseDate(date) || !title) return;
  busy = true;
  try {
    const photoIds = await importPhotos(milestoneForm.photos.files, { takenAt: date });
    const existing = state.milestones.find((m) => m.id === milestoneForm.id.value);
    store.upsert(state.milestones, {
      ...(existing ? { id: existing.id } : { childId: child().id }),
      date,
      title,
      templateId: milestoneForm.templateId.value || null,
      note: milestoneForm.note.value.trim(),
      photoIds: [...(existing?.photoIds || []), ...photoIds],
    });
    persist();
    dialogs.milestone.close();
    render();
    if (!photoIds.length) toast('できごとを記録しました');
  } finally {
    busy = false;
  }
});

// ---------- 写真ビューア ----------

let viewerIds = [];
let viewerIndex = 0;

function openViewer(id) {
  const scope = dialogs.milestone.open ? [...dialogs.milestone.querySelectorAll('[data-action="open-photo"]')].map((b) => b.dataset.id)
    : [...view.querySelectorAll('[data-action="open-photo"]')].map((b) => b.dataset.id);
  viewerIds = [...new Set(scope.length ? scope : [id])];
  viewerIndex = Math.max(0, viewerIds.indexOf(id));
  showViewerPhoto();
  if (!dialogs.viewer.open) dialogs.viewer.showModal();
}

async function showViewerPhoto() {
  const m = state.media.find((x) => x.id === viewerIds[viewerIndex]);
  if (!m) {
    dialogs.viewer.close();
    return;
  }
  const img = document.getElementById('viewer-img');
  const vid = document.getElementById('viewer-video');
  img.removeAttribute('src');
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  img.hidden = isVideo(m);
  vid.hidden = !isVideo(m);
  document.getElementById('viewer-meta').textContent = `${m.takenAt}・${periodLabel(m.takenAt)}（${viewerIndex + 1}/${viewerIds.length}）`;
  viewerForm.takenAt.value = m.takenAt;
  viewerForm.caption.value = m.caption || '';
  img.alt = m.caption || '写真';
  viewerForm.takenAt.readOnly = !canEdit();
  viewerForm.caption.readOnly = !canEdit();
  renderViewerSocial();
  const pm = photoMonthOf(child(), m.takenAt);
  const monthlyBtn = dialogs.viewer.querySelector('[data-action="viewer-monthly"]');
  monthlyBtn.hidden = !pm || isVideo(m);
  monthlyBtn.classList.toggle('on', !!m.monthly);
  monthlyBtn.innerHTML = `${icon(m.monthly ? 'checkCircle' : 'star')}${m.monthly ? `${esc(photoMonthLabel(pm))}の月齢フォト` : '月齢フォトにする'}`;
  dialogs.viewer.querySelector('[data-action="viewer-prev"]').disabled = viewerIndex === 0;
  dialogs.viewer.querySelector('[data-action="viewer-next"]').disabled = viewerIndex >= viewerIds.length - 1;
  if (isVideo(m)) {
    const poster = await media.fileUrl(m.id, 'thumb').catch(() => null);
    if (poster) vid.poster = poster;
  }
  const url = await media.fileUrl(m.id, 'full').catch(() => null);
  if (url && viewerIds[viewerIndex] === m.id) (isVideo(m) ? vid : img).src = url;
}

function renderViewerSocial() {
  const el = document.getElementById('viewer-social');
  const id = viewerIds[viewerIndex];
  el.innerHTML = id ? socialBar('media', id) : '';
  const m = state.media.find((x) => x.id === id);
  const by = m && account() ? memberName(m.createdBy || m.ownerId) : '';
  el.insertAdjacentHTML('afterbegin', by && m.ownerId ? `<p class="byline">${esc(by)}さんが追加</p>` : '');
}

viewerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const m = state.media.find((x) => x.id === viewerIds[viewerIndex]);
  if (!m || !parseDate(viewerForm.takenAt.value)) return;
  store.upsert(state.media, { id: m.id, takenAt: viewerForm.takenAt.value, caption: viewerForm.caption.value.trim() });
  persist();
  showViewerPhoto();
  render();
  toast('保存しました');
});

async function downloadViewerPhoto() {
  const m = state.media.find((x) => x.id === viewerIds[viewerIndex]);
  const url = m && await media.fileUrl(m.id, 'full').catch(() => null);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  const blob = (await media.getFile(m.id).catch(() => null))?.full;
  const ext = isVideo(m) ? ({ 'video/quicktime': 'mov', 'video/webm': 'webm' }[blob?.type] || 'mp4') : 'jpg';
  a.download = `sukusuku-${m.takenAt}-${m.id.slice(0, 6)}.${ext}`;
  a.click();
}

// スワイプで前後の写真へ
let touchX = null;
dialogs.viewer.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
dialogs.viewer.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 50) return;
  const next = viewerIndex + (dx < 0 ? 1 : -1);
  if (next >= 0 && next < viewerIds.length) {
    viewerIndex = next;
    showViewerPhoto();
  }
});

// ---------- 計測記録の保存 ----------

async function saveRecord(form, type, fields) {
  const date = form.date.value;
  if (!parseDate(date)) return;
  const values = Object.fromEntries(fields.map(([k, d]) => [k, round(num(form[k].value), d)]));
  if (Object.values(values).every((v) => v == null || !(v > 0))) {
    toast('少なくとも1つの項目を入力してください');
    return;
  }
  for (const k of Object.keys(values)) if (!(values[k] > 0)) values[k] = null;
  busy = true;
  form.querySelector('button.primary').disabled = true;
  try {
    const photoIds = await importPhotos(form.photos.files, { takenAt: date });
    const existing = state[type].find((r) => r.id === form.id.value);
    store.upsert(state[type], {
      ...(existing ? { id: existing.id } : { childId: child().id }),
      date,
      ...values,
      note: form.note.value.trim(),
      photoIds: [...(existing?.photoIds || []), ...photoIds],
    });
    ui.editing = null;
    persist();
    render();
    if (!photoIds.length) toast(existing ? '更新しました' : '記録しました');
  } finally {
    busy = false;
  }
}

// ---------- 家族グループ（アカウント） ----------

const accountDialog = document.getElementById('account');
const accountBody = document.getElementById('account-body');
let familyMembers = null; // 設定画面で表示するメンバー一覧
let lastLink = null; // 直前に作った招待・端末追加のリンク { label, url }

const linkUrl = (kind, token) => `${location.origin}${location.pathname}#${kind}=${encodeURIComponent(token)}`;
const hasLocalRecords = () => ['fetalRecords', 'growthRecords', 'milestones', 'media', 'weights', 'journal']
  .some((k) => state[k].length) || state.children.some((c) => c.dueDate || c.birthDate);

function errorMessage(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return 'パスキーの操作がキャンセルされました';
  if (e?.name === 'InvalidStateError') return 'この端末のパスキーはすでに登録されています';
  const messages = {
    network: '通信できませんでした。電波の良いところでお試しください',
    invite_invalid: '招待リンクの有効期限が切れているか、すでに使われています。招待した人に新しいリンクをお願いしてください',
    link_invalid: 'リンクの有効期限が切れているか、すでに使われています',
    invalid_code: '復旧コードが正しくありません',
    unknown_passkey: 'このパスキーは登録されていません',
    last_admin: 'ほかに管理者がいないため、この操作はできません。先に別のメンバーを管理者にしてください',
    forbidden: 'この操作の権限がありません',
    invalid_name: '名前を入力してください（20文字まで）',
  };
  return messages[e?.code] || 'うまくいきませんでした。時間をおいてもう一度お試しください';
}

async function renderFamilySection() {
  const el = document.getElementById('family-section');
  if (!el) return;
  const a = account();
  if (!a) {
    const ok = await api.available();
    el.innerHTML = ok && api.passkeySupported() ? `
      <h3>${icon('users')}家族と共有</h3>
      <p class="small">パスキー（指紋・顔認証）でログインすると、パートナーや両親と記録・写真を共有できます。</p>
      <div class="actions wrap">
        <button type="button" class="btn primary" data-action="account-create">家族グループを作る</button>
        <button type="button" class="btn ghost" data-action="account-login">ログイン</button>
      </div>
      <details class="small">
        <summary>パスキーをなくした場合</summary>
        <p class="muted small">グループを作ったときの復旧コードを入力してください。管理者から「再ログイン用リンク」をもらった場合は、そのリンクを開いてください。</p>
        <div class="inline-form two">
          <input name="recoveryCode" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters">
          <button type="button" class="btn ghost" data-action="account-recover">復旧</button>
        </div>
      </details>`
      : `<h3>${icon('users')}家族と共有</h3><p class="muted small">${ok ? 'このブラウザはパスキーに対応していないため、家族共有を使えません。' : '家族共有は、サーバー（Cloudflare）に公開したアプリで使えます。'}</p>`;
    return;
  }
  const admin = a.role === 'admin';
  const members = familyMembers;
  el.innerHTML = `
    <h3>${icon('users')}家族グループ</h3>
    ${a.error === 'signed_out' ? '<p class="alert small">ログインの有効期限が切れました。<button type="button" class="btn primary tiny" data-action="account-login">再ログイン</button></p>' : ''}
    ${a.error === 'removed' ? '<p class="alert small">この家族グループのメンバーではなくなりました。<button type="button" class="btn ghost tiny" data-action="account-logout">ログアウト</button></p>' : ''}
    <p><strong>${esc(a.groupName)}</strong> <span class="badge">${ROLE_LABELS[a.role]}</span></p>
    ${a.groups.length > 1 ? `<label class="small">表示するグループ
      <select data-action="switch-group">${a.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === a.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
    <p class="small">あなたの名前: ${esc(a.displayName)} <button type="button" class="btn ghost tiny" data-action="account-rename">変更</button></p>
    <p class="small muted"><span id="sync-info"></span> <button type="button" class="btn ghost tiny" data-action="sync-now">今すぐ同期</button></p>
    <h4>メンバー</h4>
    ${members ? `<ul class="members">${members.map((m) => `<li>
      <span class="m-name">${esc(m.displayName)}${m.userId === a.userId ? '（あなた）' : ''}</span>
      ${admin && m.userId !== a.userId ? `
        <select data-action="member-role" data-uid="${esc(m.userId)}" aria-label="${esc(m.displayName)}の権限">
          ${Object.entries(ROLE_LABELS).map(([r, l]) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button type="button" class="btn ghost tiny" data-action="member-relogin" data-uid="${esc(m.userId)}" title="端末をなくしたメンバー向け">再ログイン用リンク</button>
        <button type="button" class="icon-btn small" data-action="member-remove" data-uid="${esc(m.userId)}" aria-label="${esc(m.displayName)}を外す">${icon('close')}</button>`
        : `<span class="muted small">${ROLE_LABELS[m.role]}</span>`}
    </li>`).join('')}</ul>` : '<p class="muted small">読み込み中…</p>'}
    <p class="muted small">管理者: すべての操作と家族の管理 ／ 編集者（パートナーなど）: 記録の追加・編集 ／ 閲覧者（両親・祖父母など）: 見る・リアクション・コメント</p>
    ${admin ? `
    <div class="inline-form two">
      <select name="inviteRole" aria-label="招待する人の権限">
        <option value="viewer">閲覧者として</option>
        <option value="editor">編集者として</option>
        <option value="admin">管理者として</option>
      </select>
      <button type="button" class="btn primary" data-action="invite">招待リンクを作る</button>
    </div>` : ''}
    ${lastLink ? `<div class="link-box">
      <p class="small"><strong>${esc(lastLink.label)}</strong></p>
      <input readonly value="${esc(lastLink.url)}" aria-label="リンク">
      <div class="actions wrap">
        <button type="button" class="btn ghost tiny" data-action="copy-link">コピー</button>
        ${navigator.share ? '<button type="button" class="btn ghost tiny" data-action="share-link">LINE などで送る</button>' : ''}
      </div>
    </div>` : ''}
    <details class="small">
      <summary>ログインと端末</summary>
      <div class="actions wrap">
        <button type="button" class="btn ghost tiny" data-action="device-link">別の端末でもログインする</button>
        <button type="button" class="btn ghost tiny" data-action="recovery-code">復旧コードを作り直す</button>
        <button type="button" class="btn ghost tiny" data-action="account-logout">ログアウト</button>
        ${admin ? '' : '<button type="button" class="btn danger tiny" data-action="group-leave">グループから抜ける</button>'}
        <button type="button" class="btn danger tiny" data-action="account-delete">退会（アカウント削除）</button>
      </div>
    </details>`;
  updateSyncStatus(null);
  if (!members) loadMembers();
}

async function loadMembers() {
  const a = account();
  if (!a) return;
  try {
    const res = await api.members(a.groupId);
    familyMembers = res.members;
    syncEngine.setMembers(res.members);
    const mine = res.members.find((m) => m.userId === a.userId);
    if (mine && mine.role !== a.role) {
      a.role = mine.role;
      updateRoleUi();
      render();
    }
  } catch {
    familyMembers = [];
  }
  if (dialogs.settings.open) renderFamilySection();
}

function openAccount(html) {
  accountBody.innerHTML = html;
  if (!accountDialog.open) accountDialog.showModal();
}

function accountForm(kind, info = {}) {
  const titles = {
    create: '家族グループを作る',
    invite: '家族グループに参加',
    link: 'この端末でログイン',
  };
  const intro = {
    create: '<p class="small">この端末の記録をそのまま家族グループに移します。ログインにはパスワードの代わりに<strong>パスキー</strong>（指紋・顔認証）を使います。</p>',
    invite: `<p class="small">${esc(info.invitedBy || '家族')}さんから「<strong>${esc(info.groupName)}</strong>」に<strong>${ROLE_LABELS[info.role]}</strong>として招待されています。</p>`,
    link: '<p class="small">この端末にパスキーを作成して、ログインできるようにします。</p>',
  };
  return `
    <h2>${titles[kind]}</h2>
    ${intro[kind]}
    <form data-form="account" data-kind="${kind}">
      ${kind === 'link' ? '' : `<label>あなたの名前（家族に表示されます）
        <input name="displayName" maxlength="20" required value="${kind === 'create' ? 'ママ' : ''}" placeholder="例: ばあば"></label>`}
      ${kind === 'create' ? `<label>グループの名前
        <input name="groupName" maxlength="30" required value="${esc(`${child().name || '赤ちゃん'}の家族`)}"></label>` : ''}
      ${kind !== 'create' && hasLocalRecords() ? '<p class="alert small">この端末にある記録は、家族グループの記録に置き換わります。必要なら先に設定から「バックアップを保存」してください。</p>' : ''}
      <p class="muted small" id="account-error" role="alert"></p>
      <div class="actions">
        <button type="button" class="btn ghost" data-action="close-dialog">やめる</button>
        <button class="btn primary">パスキーを作成</button>
      </div>
    </form>`;
}

function showRecoveryCode(code) {
  openAccount(`
    <h2>${icon('key')}復旧コード</h2>
    <p class="small">パスキーの入った端末をすべてなくしたときに使います。<strong>スクリーンショットやメモで大切に保管</strong>してください（あとから表示することはできません）。</p>
    <p class="recovery-code">${esc(code)}</p>
    <div class="actions">
      <button type="button" class="btn ghost" data-action="copy-text" data-text="${esc(code)}">コピー</button>
      <button type="button" class="btn primary" data-action="close-dialog">保存しました</button>
    </div>`);
}

// ログイン・参加の後: この端末のデータを家族グループのデータに置き換えて同期を始める
async function beginSync(me, { uploadLocal }) {
  media.setRemote((id, size) => api.fetchMedia(syncEngine.account.groupId, id, size));
  if (!uploadLocal) {
    const prefs = { profile: state.profile, checks: state.checks, checkups: state.checkups };
    state = { ...store.defaultState(), ...prefs, children: [], activeChildId: null };
    store.save(state);
    await media.clearFiles().catch(() => {});
  }
  familyMembers = null;
  syncPending = true;
  updateRoleUi();
  render();
  toast('家族グループと同期しています…', 0);
  await syncEngine.start(me, me.groups[0]?.id, { uploadLocal });
  syncPending = false;
  ensureChild();
  updateRoleUi();
  render();
  loadMembers();
  if (dialogs.settings.open) renderFamilySection();
  toast(syncEngine.account?.error ? '同期できませんでした。あとで自動的にやり直します' : '同期しました');
}

async function submitAccount(form) {
  const kind = form.dataset.kind;
  const errEl = form.querySelector('#account-error');
  const btn = form.querySelector('button.primary');
  btn.disabled = true;
  errEl.textContent = '';
  try {
    let me;
    if (kind === 'create') {
      me = await api.registerPasskey({ type: 'new' }, { displayName: form.displayName.value.trim(), groupName: form.groupName.value.trim() });
    } else if (kind === 'invite') {
      me = await api.registerPasskey({ type: 'invite', token: pendingToken }, { displayName: form.displayName.value.trim() });
    } else {
      me = await api.registerPasskey({ type: 'link', token: pendingToken });
    }
    pendingToken = null;
    await beginSync(me, { uploadLocal: kind === 'create' });
    if (me.recoveryCode) showRecoveryCode(me.recoveryCode);
    else accountDialog.close();
  } catch (e) {
    errEl.textContent = errorMessage(e);
    btn.disabled = false;
  }
}

let pendingToken = null;

// #invite=… / #link=… で開かれたとき
async function handleLanding(hash) {
  const m = /^#(invite|link)=(.+)$/.exec(hash);
  if (!m) return false;
  const [, kind, raw] = m;
  pendingToken = decodeURIComponent(raw);
  if (!(await api.available()) || !api.passkeySupported()) {
    toast('このブラウザでは家族共有を使えません', 4000);
    return true;
  }
  if (account() && !account().error) {
    toast('すでにログインしています。別のグループに参加するには、いったんログアウトしてください', 5000);
    return true;
  }
  if (kind === 'invite') {
    try {
      openAccount(accountForm('invite', await api.inviteInfo(pendingToken)));
    } catch (e) {
      openAccount(`<h2>招待リンク</h2><p>${esc(errorMessage(e))}</p>
        <div class="actions"><button type="button" class="btn primary" data-action="close-dialog">閉じる</button></div>`);
    }
  } else {
    openAccount(accountForm('link'));
  }
  return true;
}

async function shareOrCopy(url, share) {
  if (share && navigator.share) {
    try {
      await navigator.share({ title: 'すくすくノート', text: '家族グループへの招待です', url });
      return;
    } catch {
      // キャンセル
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('コピーしました');
  } catch {
    toast('コピーできませんでした。長押しして選択してください');
  }
}

const FAMILY_ACTIONS = {
  'account-create': () => openAccount(accountForm('create')),
  'account-login': async () => {
    try {
      const me = await api.loginPasskey();
      if (!me.groups.length) {
        toast('参加している家族グループがありません', 4000);
        await api.logout().catch(() => {});
        return;
      }
      if (hasLocalRecords() && !account()
        && !confirm('この端末にある記録は、家族グループの記録に置き換わります。よろしいですか？（必要なら先に「バックアップを保存」してください）')) {
        await api.logout().catch(() => {});
        return;
      }
      if (account() && account().userId === me.user.id) {
        // 有効期限切れからの再ログイン
        account().error = null;
        syncEngine.updateMe(me);
        await syncEngine.run();
        updateRoleUi();
        renderFamilySection();
        toast('ログインしました');
        return;
      }
      dialogs.settings.close();
      await beginSync(me, { uploadLocal: false });
    } catch (e) {
      toast(errorMessage(e), 4000);
    }
  },
  'account-recover': async () => {
    const code = document.querySelector('#family-section [name="recoveryCode"]').value;
    try {
      const { token } = await api.recover(code);
      pendingToken = token;
      dialogs.settings.close();
      openAccount(accountForm('link'));
    } catch (e) {
      toast(errorMessage(e), 4000);
    }
  },
  'account-logout': async () => {
    if (!confirm('ログアウトしますか？この端末の記録は残りますが、家族との同期は止まります。')) return;
    await api.logout().catch(() => {});
    syncEngine.signOut();
    media.setRemote(null);
    familyMembers = null;
    lastLink = null;
    updateRoleUi();
    renderFamilySection();
    render();
  },
  'account-delete': async () => {
    if (!confirm('アカウントを削除します。ほかに家族がいないグループは、記録と写真がすべて削除されます。よろしいですか？')) return;
    try {
      await api.deleteMe();
      syncEngine.signOut();
      media.setRemote(null);
      familyMembers = null;
      updateRoleUi();
      renderFamilySection();
      render();
      toast('退会しました');
    } catch (e) {
      toast(errorMessage(e), 5000);
    }
  },
  'account-rename': async () => {
    const name = prompt('あなたの名前（家族に表示されます）', account().displayName);
    if (!name?.trim()) return;
    try {
      syncEngine.updateMe(await api.updateMe(name.trim()));
      familyMembers = null;
      renderFamilySection();
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  'sync-now': async () => {
    await syncEngine.run();
    toast(account()?.error ? '同期できませんでした' : '同期しました');
  },
  invite: async () => {
    const role = document.querySelector('#family-section [name="inviteRole"]').value;
    try {
      const { token } = await api.createInvite(account().groupId, role);
      lastLink = { label: `招待リンク（${ROLE_LABELS[role]}・7日間有効・1人だけ使えます）`, url: linkUrl('invite', token) };
      renderFamilySection();
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  'device-link': async () => {
    try {
      const { token } = await api.deviceLink();
      lastLink = { label: '別の端末でこのリンクを開いてください（15分間有効）', url: linkUrl('link', token) };
      renderFamilySection();
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  'member-relogin': async (el) => {
    try {
      const { token } = await api.reloginLink(account().groupId, el.dataset.uid);
      lastLink = { label: `${memberName(el.dataset.uid)}さん用の再ログイン用リンク（24時間有効）`, url: linkUrl('link', token) };
      renderFamilySection();
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  'member-remove': async (el) => {
    if (!confirm(`${memberName(el.dataset.uid)}さんをグループから外しますか？`)) return;
    try {
      await api.removeMember(account().groupId, el.dataset.uid);
      familyMembers = null;
      renderFamilySection();
    } catch (e) {
      toast(errorMessage(e), 5000);
    }
  },
  'group-leave': async () => {
    if (!confirm('このグループから抜けますか？あなたのママの記録・コメントは削除されます。')) return;
    try {
      await api.removeMember(account().groupId, account().userId);
      syncEngine.signOut();
      await api.logout().catch(() => {});
      updateRoleUi();
      renderFamilySection();
      render();
    } catch (e) {
      toast(errorMessage(e), 5000);
    }
  },
  'recovery-code': async () => {
    if (!confirm('新しい復旧コードを作ります。前のコードは使えなくなります。')) return;
    try {
      const { recoveryCode } = await api.newRecoveryCode();
      showRecoveryCode(recoveryCode);
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  'copy-link': () => shareOrCopy(lastLink.url, false),
  'share-link': () => shareOrCopy(lastLink.url, true),
  'copy-text': async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.text);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした');
    }
  },
};

// ---------- イベント ----------

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

const ACTIONS = {
  'open-settings': () => openSettings(),
  'close-dialog': (el) => el.closest('dialog')?.close(),
  export: () => exportData(),
  'export-zip': () => exportZip(),
  reset: async () => {
    if (account()) {
      if (!confirm('この端末から記録と写真を消して、ログアウトします。家族グループの記録は消えません。よろしいですか？')) return;
      await api.logout().catch(() => {});
      syncEngine.signOut();
      media.setRemote(null);
      updateRoleUi();
    } else if (!confirm('すべてのデータ（写真を含む）を削除します。この操作は取り消せません。よろしいですか？')) return;
    store.clear();
    await media.clearFiles().catch(() => {});
    state = store.defaultState();
    dialogs.settings.close();
    render();
    toast('削除しました');
  },
  'open-birth': () => openBirth(),
  'open-children': () => openChildren(),
  'select-child': (el) => {
    selectChild(el.dataset.id);
    dialogs.children.close();
  },
  'delete-child': (el) => deleteChild(el.dataset.id),
  'clear-birth': () => {
    if (!confirm('誕生の登録を取り消しますか？（記録や写真は消えません）')) return;
    Object.assign(child(), { birthDate: '', updatedAt: Date.now() });
    persist();
    dialogs.birth.close();
    render();
  },
  'goto-tab': (el) => switchTab(el.dataset.tab),
  'goto-week': (el) => {
    selectedWeek = Number(el.dataset.week);
    ui.growthView = 'guide';
    switchTab('growth');
  },
  'select-week': (el) => {
    selectedWeek = Number(el.dataset.week);
    render();
  },
  'set-ui': (el) => {
    ui[el.dataset.key] = el.dataset.value;
    ui.editing = null;
    render();
  },
  'edit-record': (el) => {
    ui.editing = { type: el.dataset.type, id: el.dataset.id };
    if (currentTab !== 'growth') {
      ui.growthView = 'records';
      currentTab = 'growth';
      history.replaceState(null, '', '#growth');
    }
    render({ keepScroll: false });
  },
  'cancel-edit': () => {
    ui.editing = null;
    render();
  },
  'delete-record': (el) => {
    if (!confirm('この記録を削除しますか？（添付した写真はアルバムに残ります）')) return;
    store.remove(state, el.dataset.type, el.dataset.id);
    if (ui.editing?.id === el.dataset.id) ui.editing = null;
    persist();
    render();
  },
  'new-milestone': (el) => openMilestone({ templateId: el.dataset.template || null }),
  'edit-milestone': (el) => openMilestone({ id: el.dataset.id }),
  'delete-milestone': () => {
    const id = milestoneForm.id.value;
    if (!id || !confirm('このできごとを削除しますか？（写真はアルバムに残ります）')) return;
    store.remove(state, 'milestones', id);
    persist();
    dialogs.milestone.close();
    render();
  },
  'open-photo': (el) => openViewer(el.dataset.id),
  react: (el) => {
    toggleReaction(el.dataset.type, el.dataset.target, Number(el.dataset.i));
    rerenderSocial();
  },
  'toggle-comments': (el) => {
    const id = el.dataset.target;
    if (ui.openComments.has(id)) ui.openComments.delete(id);
    else ui.openComments.add(id);
    rerenderSocial();
  },
  'delete-comment': (el) => {
    if (!confirm('このコメントを削除しますか？')) return;
    state.comments = state.comments.filter((c) => c.id !== el.dataset.id);
    persist();
    rerenderSocial();
  },
  ...FAMILY_ACTIONS,
  'viewer-prev': () => {
    if (viewerIndex > 0) {
      viewerIndex -= 1;
      showViewerPhoto();
    }
  },
  'viewer-next': () => {
    if (viewerIndex < viewerIds.length - 1) {
      viewerIndex += 1;
      showViewerPhoto();
    }
  },
  'viewer-download': () => downloadViewerPhoto(),
  'viewer-monthly': () => {
    const m = state.media.find((x) => x.id === viewerIds[viewerIndex]);
    const pm = m && photoMonthOf(child(), m.takenAt);
    if (!pm) return;
    if (m.monthly) {
      store.upsert(state.media, { id: m.id, monthly: false });
    } else {
      // 同じ月の月齢フォトは 1 枚だけ
      for (const other of mine(state.media)) {
        if (other.monthly && other.id !== m.id && photoMonthOf(child(), other.takenAt)?.key === pm.key) {
          store.upsert(state.media, { id: other.id, monthly: false });
        }
      }
      store.upsert(state.media, { id: m.id, monthly: true });
    }
    persist();
    showViewerPhoto();
    render();
  },
  'viewer-delete': async () => {
    if (!confirm('この写真を削除しますか？この操作は取り消せません。')) return;
    const id = viewerIds[viewerIndex];
    await deletePhoto(id);
    viewerIds = viewerIds.filter((x) => x !== id);
    viewerIndex = Math.min(viewerIndex, viewerIds.length - 1);
    if (viewerIds.length) showViewerPhoto();
    else dialogs.viewer.close();
    render();
    if (dialogs.milestone.open) dialogs.milestone.querySelector(`.photo[data-id="${CSS.escape(id)}"]`)?.remove();
  },
  'toggle-contraction': () => {
    const active = activeContraction();
    if (active) active.end = Date.now();
    else state.contractions.push({ id: uuid(), start: Date.now(), end: null });
    persist();
    render();
  },
  'clear-contractions': () => {
    if (!confirm('陣痛の記録をすべて削除しますか？')) return;
    state.contractions = state.contractions.filter((c) => !isMine(c));
    persist();
    render();
  },
  'start-kick': () => {
    state.kicks.push({ id: uuid(), start: Date.now(), end: null, count: 0 });
    persist();
    render();
  },
  kick: () => {
    const k = activeKick();
    if (!k) return;
    k.count += 1;
    if (navigator.vibrate) navigator.vibrate(30);
    if (k.count >= 10) {
      k.end = Date.now();
      toast(`10回に到達しました（${formatDuration((k.end - k.start) / 1000)}）`);
    }
    persist();
    render();
  },
  'finish-kick': () => {
    const k = activeKick();
    if (!k) return;
    if (k.count === 0) state.kicks = state.kicks.filter((x) => x !== k);
    else k.end = Date.now();
    persist();
    render();
  },
  'delete-weight': (el) => {
    state.weights = state.weights.filter((w) => String(w.id) !== el.dataset.id);
    persist();
    render();
  },
  'delete-journal': (el) => {
    if (!confirm('この日記を削除しますか？')) return;
    state.journal = state.journal.filter((j) => String(j.id) !== el.dataset.id);
    persist();
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  ACTIONS[el.dataset.action]?.(el);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const { action } = el.dataset || {};
  if (action === 'check') {
    if (el.checked) state.checks[el.dataset.key] = true;
    else delete state.checks[el.dataset.key];
    persist();
    render();
  } else if (action === 'checkup') {
    if (el.checked) state.checkups[el.dataset.week] = true;
    else delete state.checkups[el.dataset.week];
    persist();
    render();
  } else if (action === 'share-toggle' && account()) {
    const me = account().userId;
    const cur = state.shares.find((x) => x.id === me) || { weight: false, journal: false, labor: false };
    store.upsert(state.shares, { ...cur, id: me, [el.dataset.key]: el.checked });
    persist();
    render();
    toast(el.checked ? '家族に共有しました' : '共有をやめました');
  } else if (action === 'member-role') {
    try {
      await api.setRole(account().groupId, el.dataset.uid, el.value);
      toast('権限を変更しました');
    } catch (e) {
      toast(errorMessage(e), 5000);
    }
    familyMembers = null;
    renderFamilySection();
  } else if (action === 'switch-group') {
    if (!confirm('表示するグループを切り替えます。この端末の記録は選んだグループの記録に置き換わります。')) {
      el.value = account().groupId;
      return;
    }
    const me = { user: { id: account().userId, displayName: account().displayName }, groups: account().groups };
    const groups = [me.groups.find((g) => g.id === el.value), ...me.groups.filter((g) => g.id !== el.value)];
    dialogs.settings.close();
    await beginSync({ ...me, groups }, { uploadLocal: false });
  } else if (action === 'toggle-fetal') {
    ui.withFetal = el.checked;
    render();
  } else if (action === 'import' && el.files?.[0]) {
    importData(el.files[0]);
    el.value = '';
  } else if (action === 'add-photos' && el.files?.length && !busy) {
    busy = true;
    try {
      const ids = await importPhotos(el.files);
      if (ids.length && currentTab === 'home') {
        ui.albumView = 'photos';
        switchTab('album');
      } else {
        render();
      }
    } finally {
      busy = false;
      el.value = '';
    }
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (busy) return;
  const kind = form.dataset.form;
  if (kind === 'account') {
    submitAccount(form);
    return;
  }
  if (kind === 'add-child') {
    addChild(form);
    return;
  }
  if (kind === 'comment') {
    const text = form.text.value.trim();
    if (!text || !account()) return;
    state.comments.push({ id: uuid(), targetType: form.targetType.value, targetId: form.targetId.value, text, createdAt: Date.now() });
    persist();
    rerenderSocial();
    return;
  }
  if (kind === 'fetal') {
    saveRecord(form, 'fetalRecords', [['efwG', 0], ['bpdMm', 1], ['flMm', 1], ['acMm', 1], ['crlMm', 1], ['fhrBpm', 0]]);
  } else if (kind === 'growth') {
    saveRecord(form, 'growthRecords', [['weightKg', 3], ['heightCm', 1], ['headCm', 1], ['chestCm', 1]]);
  } else if (kind === 'weight') {
    const date = form.date.value;
    const kg = Number(form.kg.value);
    if (!parseDate(date) || !(kg > 0)) return;
    state.weights = state.weights.filter((w) => !(w.date === date && isMine(w)));
    state.weights.push({ id: uuid(), date, kg: Math.round(kg * 10) / 10 });
    persist();
    render();
    toast('体重を記録しました');
  } else if (kind === 'journal') {
    const text = form.text.value.trim();
    if (!text) return;
    state.journal.push({
      id: uuid(), date: todayStr(), mood: Number(form.mood.value), text, createdAt: Date.now(),
      ...(form.private?.checked ? { private: true } : {}),
    });
    persist();
    render();
    toast('日記を保存しました');
  }
});

// 別タブでの変更を反映
window.addEventListener('storage', () => {
  state = store.load();
  render();
});

// ---------- 起動 ----------

accountDialog.addEventListener('close', () => {
  if (pendingRender && !isEditing()) {
    pendingRender = false;
    render();
  }
});
dialogs.milestone.addEventListener('close', () => accountDialog.dispatchEvent(new Event('close')));
dialogs.viewer.addEventListener('close', () => {
  document.getElementById('viewer-video').pause();
  accountDialog.dispatchEvent(new Event('close'));
});

hydrateIcons();
ensureChild();
updateRoleUi();

const landingHash = location.hash; // 招待・端末追加のリンク（タブの切り替えで書き換わる前に読む）
const initialTab = location.hash.slice(1);
switchTab(RENDERERS[initialTab] || LEGACY_TABS[initialTab] ? initialTab : 'home');

// 家族共有: 起動時・画面に戻ったとき・オンラインになったとき・1分ごとに同期
handleLanding(landingHash);
if (account()) {
  syncEngine.run();
  loadMembers();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncEngine.run();
  else if (currentTab === 'album') markAlbumSeen();
});
window.addEventListener('online', () => syncEngine.run());
setInterval(() => {
  if (document.visibilityState === 'visible') syncEngine.run();
}, 60 * 1000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
