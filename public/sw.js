/* Offline for a bar with bad wifi.

   The shell is network-first so a deploy actually reaches you, falling back to
   cache when there is no signal. Deck files are cache-first because they are
   large, they change rarely, and a deck you have opened once should still be
   there in the basement.

   Bump CACHE when the shell changes shape enough that a stale copy would be
   wrong; old caches are dropped on activate either way.
*/
const CACHE = 'lastcall-v1';
const SHELL = ['./', './index.html', './cards.js', './manifest.webmanifest',
               './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  // addAll fails the whole install if one entry 404s, so misses are tolerated
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // fonts and anything else stay on the network

  const isDeck = url.pathname.includes('/decks/');
  e.respondWith(isDeck ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req) || await caches.match('./index.html');
    if (hit) return hit;
    throw err;
  }
}
