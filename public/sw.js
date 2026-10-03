// オフラインでも使えるようにアプリ本体をキャッシュする
const CACHE = 'maternity-app-v4';
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
