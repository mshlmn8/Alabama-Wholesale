/* Alabama Wholesale — Service Worker
 *
 * Goal: the app loads reliably even when the device has no internet.
 *
 * Strategy:
 *   - HTML / navigation requests: network-first, fall back to the cached
 *     HTML. Keeps users on the latest deploy when online, still works
 *     when offline.
 *   - Images (/images/*) and Google Fonts: cache-first with background
 *     revalidate. Cuts cold-start time and works fully offline.
 *   - Firebase / Google APIs: bypass. The Firebase SDK has its own
 *     offline queue (IndexedDB persistent cache).
 *   - Everything else: stale-while-revalidate.
 *
 * The cache key includes a version. Bump CACHE_VERSION on each deploy
 * so users pick up the new build; the activate handler purges old caches.
 */

const CACHE_VERSION = 'aw-2026-05-19-1';
const CACHE_NAME = 'aw-cache-' + CACHE_VERSION;

// Files cached up front so the app boots offline even on first cold start
// after install.
const CORE_ASSETS = [
  '/',
  '/alabama-wholesale-v9.html'
];

// Hostnames whose responses should NEVER be cached or intercepted.
// The Firebase SDK has its own IndexedDB cache + write queue; getting in
// the middle of that breaks sync.
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebaseapp.com',
  'firebaseio.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com'
];

// ---- Install: pre-cache the shell ----
self.addEventListener('install', event => {
  // Activate immediately on the next page load instead of waiting for all
  // tabs to close.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).catch(err => {
      console.warn('[sw] pre-cache failed', err);
    })
  );
});

// ---- Activate: nuke older versions ----
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- Fetch: route by request type ----
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Bypass Firebase / Google APIs — those have their own offline story.
  if (BYPASS_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;
  // Don't try to cache extension or chrome-internal URLs.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  const isOwnOrigin = url.origin === self.location.origin;
  const isImage = isOwnOrigin && url.pathname.startsWith('/images/');
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  if (isNavigation || (isOwnOrigin && url.pathname.endsWith('.html'))) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (isImage || isFont) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (isOwnOrigin) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

// ---- Strategies ----

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Last resort — serve the cached app shell so navigation still works.
    const shell = await caches.match('/alabama-wholesale-v9.html');
    if (shell) return shell;
    return new Response('Offline and no cached copy yet.', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Refresh in the background — but don't block the response.
    fetch(req).then(r => { if (r && r.ok) caches.open(CACHE_NAME).then(c => c.put(req, r.clone())); }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(r => {
    if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
    return r;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// Let the page tell us to skip the waiting phase (used by the update toast).
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
