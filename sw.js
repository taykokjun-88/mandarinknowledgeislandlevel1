/* Lightweight Service Worker for Mandarin 1 Knowledge Isles
   - Cache-first for static libraries & hand-painted sprites (lib/, assets/)
   - Network-first for HTML, config.js, and data/content.js so updates roll out immediately
   - Never caches POST requests, cross-origin API calls, or Whisper models (cached by transformers.js) */
const CACHE = "m1-isles-static-v1";
const STATIC_RE = /\/(assets\/|lib\/(three\/|hanzi-data\/|mediapipe\/|transformers\/|pinyin-pro\.js|hanzi-writer\.min\.js))/;

self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("m1-isles-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Cache-first for static assets and local libraries (excluding large Whisper ONNX models)
  if (STATIC_RE.test(url.pathname) && !url.pathname.includes("/lib/models/")) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(req).then(hit => {
          if (hit) return hit;
          return fetch(req).then(res => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Network-first for HTML, config.js, data/content.js, manifest
  if (req.mode === "navigate" || /\.(html|js|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
