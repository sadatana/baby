// 線のアイコン（24×24、stroke=currentColor）。絵文字の代わりに使う
const P = {
  logo: '<path d="M12 21V11"/><path d="M12 11C12 7 9 4.5 4.5 4.5 4.5 9 7 11 12 11z"/><path d="M12 13c0-3.5 2.6-6 7.5-6 0 4-2.6 6-7.5 6z"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  growth: '<path d="M3 20h18"/><path d="M5 16l4.5-5 3.5 3 6-7"/><path d="M15 7h4v4"/>',
  album: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.75"/><path d="m21 16-5-5-9 9"/>',
  mom: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21"/>',
  checklist: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5"/><path d="m3.5 12 1.5 1.5L7.5 11"/><path d="m3.5 18 1.5 1.5L7.5 17"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  cloud: '<path d="M17.5 19H7a5 5 0 1 1 1.1-9.9A6 6 0 0 1 19.5 11a4 4 0 0 1-2 8z"/>',
  cloudOff: '<path d="M17.5 19H7a5 5 0 0 1-1.6-9.7"/><path d="M9.3 7.4A6 6 0 0 1 19.5 11a4 4 0 0 1 1.3 6.6"/><path d="m3 3 18 18"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  ruler: '<path d="M3 16.5 16.5 3 21 7.5 7.5 21z"/><path d="m7 12.5 1.5 1.5"/><path d="m10 9.5 2 2"/><path d="m13 6.5 1.5 1.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.2.9-4.5 4.4 1 6.1L12 17.1 6.6 20l1-6.1L3.1 9.5l6.2-.9z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.3A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 9.2 4.1C19.5 15.4 12 20 12 20z"/>',
  sparkle: '<path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m6 6 2.5 2.5"/><path d="m15.5 15.5 2.5 2.5"/><path d="m18 6-2.5 2.5"/><path d="M8.5 15.5 6 18"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5v.01"/><path d="M15 9.5v.01"/>',
  thumbsUp: '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  hospital: '<path d="M4 21V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v16"/><path d="M12 8v6"/><path d="M9 11h6"/><path d="M2 21h20"/>',
  bag: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  document: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M10 2h4"/>',
  scale: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8.5 10a5 5 0 0 1 7 0"/><path d="m12 10 1.5-2"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20"/>',
  lightbulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  food: '<path d="M7 3v8a2 2 0 0 0 4 0V3"/><path d="M9 11v10"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 4 3 4v9"/>',
  footprints: '<path d="M8 3c1.7 0 2.5 2 2.5 4S9.7 11 8 11 5.5 9 5.5 7 6.3 3 8 3z"/><path d="M6 14h4v2.5a2 2 0 0 1-4 0z"/><path d="M16 7c1.7 0 2.5 2 2.5 4s-.8 4-2.5 4-2.5-2-2.5-4 .8-4 2.5-4z"/><path d="M14 18h4v.5a2 2 0 0 1-4 0z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1A5 5 0 0 1 7.5 14h3a5 5 0 0 1 5 5v1"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18.5 14a5 5 0 0 1 3 4.6V20"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  baby: '<circle cx="12" cy="12" r="9"/><path d="M9 10v.01"/><path d="M15 10v.01"/><path d="M9.5 14.5a3.5 3.5 0 0 0 5 0"/><path d="M12 3c-1 1.5-1 3 0 3.5"/>',
  gift: '<rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8"/><path d="M12 8v13"/><path d="M12 8C10 4 6.5 4.5 7 7s5 1 5 1 4.5 1.5 5-1-5-3-5 1z"/>',
};

// 気分（5段階）の顔: 0 とても良い 〜 4 つらい
const MOOD_MOUTHS = [
  '<path d="M8 13.5a4.5 4.5 0 0 0 8 0z"/>',
  '<path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>',
  '<path d="M9 15h6"/>',
  '<path d="M8.5 16a4.5 4.5 0 0 1 7 0"/>',
  '<path d="M8.5 16.5a4.5 4.5 0 0 1 7 0"/><path d="M8 8l2 1.5"/><path d="m16 8-2 1.5"/>',
];

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}

export function moodIcon(level, cls = '') {
  const m = MOOD_MOUTHS[level] ?? MOOD_MOUTHS[2];
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M9 9.5v.01"/><path d="M15 9.5v.01"/>${m}</svg>`;
}

export const MOOD_LABELS = ['とても良い', '良い', 'ふつう', 'いまいち', 'つらい'];
// 以前の記録（絵文字で保存した気分）を 5 段階に読み替える
const LEGACY_MOODS = ['\u{1F60A}', '\u{1F60C}', '\u{1F610}', '\u{1F623}', '\u{1F622}'];
export function moodLevel(mood) {
  if (typeof mood === 'number') return Math.max(0, Math.min(4, mood));
  const i = LEGACY_MOODS.indexOf(mood);
  return i >= 0 ? i : 2;
}

// HTML 内の <span data-icon="名前"> にアイコンを入れる
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
  });
}
