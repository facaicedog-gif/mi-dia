// Mi día · service worker: funciona sin conexión y muestra los avisos.
const CACHE = 'midia-v25';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero y sin usar la copia del navegador, para recibir siempre la versión nueva;
// si no hay conexión, lo guardado.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-store' })
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Aviso enviado desde el servidor (llega aunque la app esté cerrada).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tienes un pendiente', {
    body: d.body || '',
    tag: d.tag,
    silent: false,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: d.data || {}
  }));
});

// Tocar el aviso abre la app en ese pendiente.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.tag || '';
  const abrir = id && id !== 'prueba' && !id.startsWith('asg-');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) { if (abrir) c.postMessage({ open: id }); return c.focus(); }
      return self.clients.openWindow(abrir ? './#open=' + encodeURIComponent(id) : './');
    })
  );
});
