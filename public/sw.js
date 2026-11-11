// NoAzul PWA service worker — cache-first para assets estáticos, network-first para HTML.
// Dados financeiros (sql.js/localStorage) NÃO passam por aqui.
// v5: lembrete de contas com clique para focar o app; precacheia o WASM com validação de content-type e faz cache-first em assets estáticos
// (permite abrir o app offline mesmo depois de recarregar a página).
const CACHE = 'noazul-v5';
const CORE = ['/', '/index.html', '/manifest.json', '/favicon.svg', '/icons.svg', '/termos.html', '/privacidade.html'];
const WASM = '/sql-wasm-browser.wasm';

async function putSafe(request, res) {
  if (!res || !res.ok) return;
  if (String(request.url).endsWith('.wasm') && !(res.headers.get('content-type') || '').includes('wasm')) return;
  const copy = res.clone();
  const cache = await caches.open(CACHE);
  await cache.put(request, copy);
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    try {
      const res = await fetch(WASM, { cache: 'reload' });
      await putSafe(new Request(WASM), res);
    } catch { /* sem rede no install: o fetch normal tenta depois */ }
    await self.skipWaiting();
  })());
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
  if (url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).then((res) => {
      putSafe(new Request('/index.html'), res.clone());
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  const staticAsset = url.pathname.startsWith('/assets/') || /\.(?:wasm|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|css|js)$/i.test(url.pathname);
  if (staticAsset) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      putSafe(request, res.clone());
      return res;
    })));
    return;
  }
  e.respondWith(fetch(request).then((res) => {
    putSafe(request, res.clone());
    return res;
  }).catch(() => caches.match(request)));
});


self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) { if ('focus' in c) { c.navigate('/'); return c.focus(); } }
    return self.clients.openWindow('/');
  })());
});
