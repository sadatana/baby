import {
  parseDate, formatDate, formatDateJa, today, addDays, diffDays,
  dueDateFromLmp, gestationalAge, checkupSchedule, nextCheckup,
  contractionStats, formatDuration, weightGainGuide,
} from './pregnancy.js';
import { weekInfo, HOSPITAL_BAG, PROCEDURES, FOOD_NOTES, WARNING_SIGNS } from './data.js';
import * as store from './store.js';

let state = store.load();
let currentTab = 'home';
let selectedWeek = null; // 成長タブで表示中の週

const view = document.getElementById('view');
const settingsDialog = document.getElementById('settings');
const settingsForm = document.getElementById('settings-form');

// ---------- ユーティリティ ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function persist() {
  if (!store.save(state)) toast('保存できませんでした（ストレージの空き容量を確認してください）');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function dueDate() {
  return parseDate(state.profile.dueDate);
}

function babyLabel() {
  return state.profile.babyName ? esc(state.profile.babyName) : '赤ちゃん';
}

const timeFmt = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortDateFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// ---------- ホーム ----------

function renderHome() {
  const due = dueDate();
  if (!due) {
    return `
      <section class="card welcome">
        <div class="big-emoji">🤰</div>
        <h2>ご妊娠おめでとうございます</h2>
        <p>出産予定日（または最終月経の開始日）を設定すると、妊娠週数や赤ちゃんの成長、健診スケジュールを確認できます。</p>
        <button class="btn primary" data-action="open-settings">予定日を設定する</button>
      </section>
      ${renderWarningCard()}`;
  }

  const t = today();
  const ga = gestationalAge(due, t);
  const info = weekInfo(ga.week);
  const next = nextCheckup(due, t);
  const pct = Math.round(ga.progress * 100);

  let headline;
  if (ga.notStarted) headline = '予定日の設定を確認してください';
  else if (ga.daysLeft > 0) headline = `${babyLabel()}に会えるまで あと <strong>${ga.daysLeft}</strong> 日`;
  else if (ga.daysLeft === 0) headline = '今日が出産予定日です 🎉';
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

    <section class="card baby-size" data-action="goto-week" data-week="${info.week}">
      <div class="size-emoji">${info.emoji}</div>
      <div>
        <p class="muted small">今週の${babyLabel()}は</p>
        <p class="size-name">${esc(info.size)}くらい</p>
        <p class="small">身長 ${info.length} ／ 体重 ${info.weight}</p>
      </div>
    </section>

    <section class="card">
      <h3>💡 今週のポイント</h3>
      <p>${esc(info.tip)}</p>
    </section>

    ${next ? `
    <section class="card">
      <h3>🏥 次の妊婦健診（目安）</h3>
      <p><strong>${formatDateJa(next.date)}</strong>（${next.week}週）</p>
      <p class="muted small">${diffDays(next.date, t) === 0 ? '今日です' : `あと${diffDays(next.date, t)}日`}・実際の日程は産院の指示に従ってください</p>
    </section>` : ''}

    ${renderWarningCard()}`;
}

function renderWarningCard() {
  return `
    <section class="card warning">
      <h3>⚠️ すぐに産院へ連絡するサイン</h3>
      <ul>${WARNING_SIGNS.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <p class="muted small">迷ったときは、ためらわずにかかりつけの産院へ電話してください。</p>
    </section>`;
}

// ---------- 成長（週ごとのガイド） ----------

function renderWeeks() {
  const due = dueDate();
  const current = due ? gestationalAge(due, today()).week : null;
  const w = selectedWeek ?? (current != null ? Math.max(4, Math.min(41, current)) : 4);
  const info = weekInfo(w);
  const chips = [];
  for (let i = 4; i <= 41; i++) {
    chips.push(`<button class="chip ${i === w ? 'active' : ''} ${i === current ? 'current' : ''}" data-action="select-week" data-week="${i}">${i}</button>`);
  }
  const range = due ? `${formatDateJa(addDays(due, (w - 40) * 7))} 〜` : '';

  return `
    <section class="card">
      <h2>週ごとの成長ガイド</h2>
      <div class="chips" id="week-chips">${chips.join('')}</div>
    </section>
    <section class="card week-detail">
      <div class="week-head">
        <button class="icon-btn" data-action="select-week" data-week="${Math.max(4, w - 1)}" aria-label="前の週">◀</button>
        <div>
          <p class="week-title">妊娠${w}週</p>
          ${range ? `<p class="muted small">${range}</p>` : ''}
        </div>
        <button class="icon-btn" data-action="select-week" data-week="${Math.min(41, w + 1)}" aria-label="次の週">▶</button>
      </div>
      <div class="baby-size inline">
        <div class="size-emoji">${info.emoji}</div>
        <div>
          <p class="size-name">${esc(info.size)}くらい</p>
          <p class="small">身長 ${info.length} ／ 体重 ${info.weight}</p>
        </div>
      </div>
      <h3>👶 赤ちゃんの様子</h3>
      <p>${esc(info.baby)}</p>
      <h3>🤰 ママの様子</h3>
      <p>${esc(info.mom)}</p>
      <h3>💡 ポイント</h3>
      <p>${esc(info.tip)}</p>
      <p class="muted small">※大きさ・体重は一般的な目安です。個人差があります。</p>
    </section>
    <section class="card">
      <h3>🍽️ 食べ物の注意点</h3>
      <ul class="food">
        ${FOOD_NOTES.map((f) => `<li class="food-${f.level}"><strong>${esc(f.title)}</strong><span>${esc(f.text)}</span></li>`).join('')}
      </ul>
    </section>`;
}

// ---------- ツール（陣痛タイマー・胎動カウンター） ----------

function activeContraction() {
  const last = state.contractions[state.contractions.length - 1];
  return last && last.end == null ? last : null;
}

function activeKick() {
  const last = state.kicks[state.kicks.length - 1];
  return last && last.end == null ? last : null;
}

function renderTools() {
  const active = activeContraction();
  const stats = contractionStats(state.contractions);
  const recent = state.contractions.slice(-10).map((c, i, arr) => {
    const prev = i > 0 ? arr[i - 1] : state.contractions[state.contractions.length - arr.length - 1];
    const interval = prev ? (c.start - prev.start) / 1000 : null;
    return { ...c, interval };
  }).reverse();

  const kick = activeKick();
  const kickHistory = state.kicks.filter((k) => k.end != null).slice(-5).reverse();

  return `
    <section class="card">
      <h2>⏱️ 陣痛タイマー</h2>
      <p class="muted small">痛みが始まったら「開始」、おさまったら「終了」をタップ。間隔（開始〜次の開始）と持続時間を記録します。</p>
      <button class="big-btn ${active ? 'stop' : ''}" data-action="toggle-contraction">
        ${active ? '陣痛おさまった（終了）' : '陣痛きた（開始）'}
      </button>
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
            <td>${timeFmt.format(c.start)}</td>
            <td>${c.end ? formatDuration((c.end - c.start) / 1000) : '計測中'}</td>
            <td>${formatDuration(c.interval)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn ghost small" data-action="clear-contractions">記録をリセット</button>` : ''}
    </section>

    <section class="card">
      <h2>👣 胎動カウンター</h2>
      <p class="muted small">赤ちゃんが動いたらタップ。10回動くまでの時間を測ります（目安として妊娠28週ごろから）。</p>
      ${kick ? `
        <button class="big-btn kick" data-action="kick">👣 動いた！ <strong>${kick.count}</strong> / 10</button>
        <p class="live">経過時間 <strong data-live-since="${kick.start}">0秒</strong></p>
        <button class="btn ghost small" data-action="finish-kick">カウントを終了</button>
      ` : '<button class="big-btn" data-action="start-kick">カウントを始める</button>'}
      ${kickHistory.length ? `
      <table class="log">
        <thead><tr><th>日時</th><th>回数</th><th>かかった時間</th></tr></thead>
        <tbody>
          ${kickHistory.map((k) => `<tr>
            <td>${shortDateFmt.format(k.start)}</td>
            <td>${k.count}回</td>
            <td>${formatDuration((k.end - k.start) / 1000)}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : ''}
      <p class="muted small">いつもより明らかに胎動が少ない・感じないときは、すぐに産院へ連絡してください。</p>
    </section>`;
}

// ---------- 記録（体重・日記） ----------

function renderWeightChart(due) {
  const pts = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) return '';
  const W = 320;
  const H = 160;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const xs = pts.map((p) => {
    const d = parseDate(p.date);
    return due ? gestationalAge(due, d).totalDays / 7 : diffDays(d, parseDate(pts[0].date)) / 7;
  });
  const ys = pts.map((p) => p.kg);
  const pre = state.profile.preWeightKg;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs, minX + 1);
  const minY = Math.floor(Math.min(...ys, pre ?? Infinity) - 1);
  const maxY = Math.ceil(Math.max(...ys) + 1);
  const sx = (x) => pad.l + ((x - minX) / (maxX - minX)) * (W - pad.l - pad.r);
  const sy = (y) => H - pad.b - ((y - minY) / (maxY - minY)) * (H - pad.t - pad.b);
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="体重の推移">
      <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" class="axis"/>
      <text x="4" y="${sy(maxY) + 4}" class="tick">${maxY}</text>
      <text x="4" y="${sy(minY)}" class="tick">${minY}</text>
      <text x="${pad.l}" y="${H - 6}" class="tick">${due ? `${Math.floor(minX)}週` : ''}</text>
      <text x="${W - pad.r}" y="${H - 6}" class="tick" text-anchor="end">${due ? `${Math.floor(maxX)}週` : ''}</text>
      ${pre ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${sy(pre)}" y2="${sy(pre)}" class="baseline"/>` : ''}
      <path d="${line}" class="line"/>
      ${xs.map((x, i) => `<circle cx="${sx(x).toFixed(1)}" cy="${sy(ys[i]).toFixed(1)}" r="3" class="dot"/>`).join('')}
    </svg>`;
}

const MOODS = ['😊', '😌', '😐', '😣', '😢'];

function renderRecords() {
  const due = dueDate();
  const { heightCm, preWeightKg } = state.profile;
  const guide = weightGainGuide(heightCm, preWeightKg);
  const weights = [...state.weights].sort((a, b) => b.date.localeCompare(a.date));
  const latest = weights[0];
  const gain = latest && preWeightKg ? Math.round((latest.kg - preWeightKg) * 10) / 10 : null;
  const todayStr = formatDate(today());
  const journal = [...state.journal].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  return `
    <section class="card">
      <h2>⚖️ 体重記録</h2>
      <form class="inline-form" data-form="weight">
        <input type="date" name="date" value="${todayStr}" required>
        <input type="number" name="kg" step="0.1" min="25" max="200" inputmode="decimal" placeholder="kg" required>
        <button class="btn primary">記録</button>
      </form>
      ${guide ? `
        <p class="small">妊娠前 BMI <strong>${guide.bmi}</strong>（${guide.category}）・
        増加の目安 <strong>${guide.range ? `${guide.range[0]}〜${guide.range[1]}kg` : '医師と相談（上限5kg程度が目安）'}</strong></p>
        ${gain != null ? `<p class="small">現在の増加: <strong>${gain > 0 ? '+' : ''}${gain}kg</strong></p>` : ''}
      ` : '<p class="muted small">設定で身長と妊娠前の体重を入力すると、体重増加の目安が表示されます。</p>'}
      ${renderWeightChart(due)}
      ${weights.length ? `
      <ul class="entries">
        ${weights.slice(0, 8).map((w) => `<li>
          <span>${esc(w.date)}${due ? `（${gestationalAge(due, parseDate(w.date)).week}週）` : ''}</span>
          <strong>${w.kg}kg</strong>
          <button class="icon-btn small" data-action="delete-weight" data-date="${esc(w.date)}" aria-label="削除">✕</button>
        </li>`).join('')}
      </ul>` : ''}
    </section>

    <section class="card">
      <h2>📔 マタニティ日記</h2>
      <form data-form="journal" class="journal-form">
        <div class="moods">
          ${MOODS.map((m, i) => `<label><input type="radio" name="mood" value="${m}" ${i === 0 ? 'checked' : ''}><span>${m}</span></label>`).join('')}
        </div>
        <textarea name="text" rows="3" maxlength="1000" placeholder="体調、健診で言われたこと、${babyLabel()}へのメッセージなど" required></textarea>
        <button class="btn primary">保存</button>
      </form>
      ${journal.length ? `
      <ul class="journal">
        ${journal.map((j) => `<li>
          <div class="journal-head">
            <span>${esc(j.mood)} ${esc(j.date)}${due ? `・${Math.max(0, gestationalAge(due, parseDate(j.date)).week)}週` : ''}</span>
            <button class="icon-btn small" data-action="delete-journal" data-id="${j.id}" aria-label="削除">✕</button>
          </div>
          <p>${esc(j.text).replace(/\n/g, '<br>')}</p>
        </li>`).join('')}
      </ul>` : ''}
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
      <details open>
        <summary><h2>🏥 妊婦健診スケジュール（目安）</h2></summary>
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
        <summary><h2>🧳 入院準備リスト <span class="count">${progressText(bagKeys)}</span></h2></summary>
        ${HOSPITAL_BAG.map((g) => `
          <h3>${esc(g.group)}</h3>
          <ul class="checklist">${g.items.map((i) => checkbox(`bag:${i}`, i)).join('')}</ul>
        `).join('')}
      </details>
    </section>

    <section class="card">
      <details>
        <summary><h2>📋 手続きリスト <span class="count">${progressText(procKeys)}</span></h2></summary>
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

const RENDERERS = { home: renderHome, weeks: renderWeeks, tools: renderTools, records: renderRecords, lists: renderLists };

function render({ keepScroll = true } = {}) {
  const y = window.scrollY;
  view.innerHTML = RENDERERS[currentTab]();
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const active = b.dataset.tab === currentTab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (keepScroll) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  updateLive();
  if (currentTab === 'weeks') {
    document.querySelector('#week-chips .chip.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function switchTab(tab) {
  if (!RENDERERS[tab]) return;
  currentTab = tab;
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

function openSettings() {
  const p = state.profile;
  settingsForm.dueDate.value = p.dueDate || '';
  settingsForm.lmp.value = '';
  settingsForm.babyName.value = p.babyName || '';
  settingsForm.heightCm.value = p.heightCm ?? '';
  settingsForm.preWeightKg.value = p.preWeightKg ?? '';
  settingsDialog.showModal();
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
  if (due) {
    const d = diffDays(parseDate(due), today());
    if (d > 300 || d < -60) {
      e.preventDefault();
      toast('出産予定日を確認してください');
      return;
    }
  }
  const num = (v) => (v === '' ? null : Number(v));
  state.profile = {
    dueDate: due,
    babyName: settingsForm.babyName.value.trim(),
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
  a.download = `maternity-backup-${formatDate(today())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !data.profile) throw new Error('invalid');
    if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
    state = store.mergeState(data);
    persist();
    settingsDialog.close();
    render();
    toast('復元しました');
  } catch {
    toast('バックアップファイルを読み込めませんでした');
  }
}

// ---------- イベント ----------

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const { action } = el.dataset;

  switch (action) {
    case 'open-settings':
      openSettings();
      break;
    case 'close-settings':
      settingsDialog.close();
      break;
    case 'export':
      exportData();
      break;
    case 'reset':
      if (confirm('すべてのデータを削除します。この操作は取り消せません。よろしいですか？')) {
        store.clear();
        state = store.defaultState();
        settingsDialog.close();
        render();
        toast('削除しました');
      }
      break;
    case 'goto-week':
      selectedWeek = Number(el.dataset.week);
      switchTab('weeks');
      break;
    case 'select-week':
      selectedWeek = Number(el.dataset.week);
      render();
      break;
    case 'toggle-contraction': {
      const active = activeContraction();
      if (active) active.end = Date.now();
      else state.contractions.push({ start: Date.now(), end: null });
      persist();
      render();
      break;
    }
    case 'clear-contractions':
      if (confirm('陣痛の記録をすべて削除しますか？')) {
        state.contractions = [];
        persist();
        render();
      }
      break;
    case 'start-kick':
      state.kicks.push({ start: Date.now(), end: null, count: 0 });
      persist();
      render();
      break;
    case 'kick': {
      const k = activeKick();
      if (!k) break;
      k.count += 1;
      if (navigator.vibrate) navigator.vibrate(30);
      if (k.count >= 10) {
        k.end = Date.now();
        toast(`10回に到達しました（${formatDuration((k.end - k.start) / 1000)}）`);
      }
      persist();
      render();
      break;
    }
    case 'finish-kick': {
      const k = activeKick();
      if (k) {
        if (k.count === 0) state.kicks.pop();
        else k.end = Date.now();
        persist();
        render();
      }
      break;
    }
    case 'delete-weight':
      state.weights = state.weights.filter((w) => w.date !== el.dataset.date);
      persist();
      render();
      break;
    case 'delete-journal':
      if (confirm('この日記を削除しますか？')) {
        state.journal = state.journal.filter((j) => String(j.id) !== el.dataset.id);
        persist();
        render();
      }
      break;
    default:
      break;
  }
});

document.addEventListener('change', (e) => {
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
  } else if (action === 'import' && el.files?.[0]) {
    importData(el.files[0]);
    el.value = '';
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'weight') {
    const date = form.date.value;
    const kg = Number(form.kg.value);
    if (!parseDate(date) || !(kg > 0)) return;
    state.weights = state.weights.filter((w) => w.date !== date);
    state.weights.push({ date, kg: Math.round(kg * 10) / 10 });
    persist();
    render();
    toast('体重を記録しました');
  } else if (form.dataset.form === 'journal') {
    const text = form.text.value.trim();
    if (!text) return;
    state.journal.push({ id: Date.now(), date: formatDate(today()), mood: form.mood.value, text });
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

const initial = location.hash.slice(1);
currentTab = RENDERERS[initial] ? initial : 'home';
render({ keepScroll: false });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
