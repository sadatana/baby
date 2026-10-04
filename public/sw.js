// オフラインでも使えるようにアプリ本体をキャッシュする
const CACHE = 'sukusuku-v6';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/pregnancy.js',
  'js/data.js',
  'js/store.js',
  'js/growth.js',
  'js/standards.js',
  'js/who-percentiles.js',
  'js/charts.js',
  'js/media.js',
  'js/api.js',
  'js/sync.js',
  'js/icons.js',
  'js/zip.js',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネットワーク優先・失敗時はキャッシュ（更新がすぐ反映されるように）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API（家族の記録・写真）はキャッシュしない
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// ---------- プッシュ通知（家族が記録を追加したとき） ----------
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    // 形式が違う通知は既定の文言で表示する
  }
  e.waitUntil(self.registration.showNotification(data.title || 'すくすくノート', {
    body: data.body || '家族が新しい記録を追加しました',
    icon: 'icons/icon.svg',
    badge: 'icons/icon.svg',
    tag: data.tag || 'sukusuku',
    renotify: true,
    data: { url: data.url || './#album' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    if (win) {
      await win.focus();
      return win.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
