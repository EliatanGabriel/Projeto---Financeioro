// NoAzul PWA service worker — cache-first para assets estáticos, network-first para HTML.
// Dados financeiros (sql.js/localStorage) NÃO passam por aqui.
// v2: invalida cache v1 que envenenou sql-wasm-browser.wasm com HTML (index.html).
const CACHE = 'noazul-v2';
const CORE = ['/', '/index.html', '/manifest.json', '/favicon.svg', '/icons.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // Supabase/workers = rede sempre
  if (url.pathname.endsWith('.wasm')) return; // sql.js: sempre da rede, nunca do cache (evita HTML envenenado)
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('/index.html', copy));
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
