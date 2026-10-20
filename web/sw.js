// Service worker for the web version: the app itself works offline, and files already read
// stay readable offline. __VERSION__ is replaced by build-web.sh, so each deploy gets a new cache.
const APP = 'app-__VERSION__';
const GITHUB = 'github';
const SHELL = [
  '/', '/reader.js', '/reader.css', '/token.html', '/site.webmanifest', '/icon.svg',
  '/vendor/marked.min.js', '/vendor/purify.min.js', '/vendor/highlight.min.js',
  '/vendor/solidity.min.js', '/vendor/yul.min.js',
];
const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== GITHUB).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, falling back to the cache when offline.
async function networkFirst(req, cacheName, key = req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(cacheName)).put(key, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(key);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Every page (/owner/repo...) is the same index.html, except the token guide.
  if (req.mode === 'navigate' && url.pathname !== '/token.html') e.respondWith(networkFirst(req, APP, '/'));
  else if (url.origin === location.origin) e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  else if (GITHUB_HOSTS.has(url.hostname)) e.respondWith(networkFirst(req, GITHUB));
});
