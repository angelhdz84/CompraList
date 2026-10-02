// Service worker de CompraLIST Pro.
//
// IMPORTANTE: bump CACHE_VERSION en cada despliegue. Si no, los usuarios se
// quedan pegados a una version antigua porque la cache es cache-first.
// Los datos del usuario NO viven aqui (están en localStorage), asi que la cache
// solo contiene el shell estatico de la app.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `compralist-${CACHE_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './css/driver.css',
  './js/app.js',
  './js/driver.js.iife.js',
  './js/popper.min.js',
  './js/tippy-bundle.umd.min.js',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll falla entero si un recurso falla; se granulariza para no bloquear la instalación.
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('[sw] no se pudo cachear', url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('compralist-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Solo mismo origen: Google Fonts y demas externos van directo a la red.
  if (url.origin !== self.location.origin) return;

  // Navegacion: red primero, cache como red de seguridad (permite ir offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto de recursos: cache primero, y se refresca en segundo plano.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
