/**
 * Otuburu service worker — minimal install-grade.
 *
 * Goals:
 *   1. Enable PWA installability (Chrome/Android requires a registered SW
 *      that handles `fetch` at least nominally before showing the install
 *      banner; iOS Safari ignores this but doesn't object).
 *   2. Cache the app shell so the page loads instantly on repeat visits
 *      even on a flaky mobile connection.
 *
 * Non-goals (for now):
 *   - Caching API responses or WebSocket data — those are real-time and
 *     stale data is worse than no data. Network-only for /api/* and /ws/*.
 *   - Background sync, push notifications — separate feature, not now.
 *
 * Cache strategy:
 *   - Navigation requests (HTML): network-first, fall back to cached
 *     index for offline shell.
 *   - Static assets (/_next/static/*, /icons/*, /favicon.svg):
 *     cache-first with revalidation.
 *   - Everything else: network-only.
 */

// Bump this whenever a build-time change matters (env-var injection,
// new chunks landing, anything where existing clients need to drop their
// cached shell). The next page open detects the new SW version, evicts
// the old SHELL_CACHE, and re-fetches index.html — which then pulls in
// the new chunk hashes via the new <script> tags.
const CACHE_VERSION = 'v2';
const SHELL_CACHE   = `otuburu-shell-${CACHE_VERSION}`;
const STATIC_CACHE  = `otuburu-static-${CACHE_VERSION}`;

// Files to pre-cache on install — the bare minimum for the shell.
const SHELL_FILES = [
  '/',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API, WebSocket upgrades, or auth flows — they must hit
  // the network so we get live data and fresh tokens.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/auth/')
  ) {
    return; // default network behaviour
  }

  // HTML navigations: network-first, shell fallback for offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then(c => c.put('/', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('/').then(r => r || Response.error()))
    );
    return;
  }

  // Static assets: cache-first with background revalidation.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.match(req).then(cached => {
        const fetchPromise = fetch(req)
          .then(resp => {
            if (resp.ok) {
              const copy = resp.clone();
              caches.open(STATIC_CACHE).then(c => c.put(req, copy)).catch(() => {});
            }
            return resp;
          })
          .catch(() => cached || Response.error());
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else: default browser handling (network).
});
