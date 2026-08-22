const CACHE_PREFIX = "action-memory-root-";
const CACHE_NAME = `${CACHE_PREFIX}v16`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=14",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./src/app.js?v=16",
  "./src/calculator.js?v=9",
  "./src/core.js?v=9",
  "./src/db.js?v=9",
  "./src/google-backend.js?v=16",
  "./backend/apps-script/Code.gs?v=16"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (key === "action-memory-v2" || key.startsWith(CACHE_PREFIX)) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok && new URL(event.request.url).origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") return caches.match(new URL("./index.html", self.registration.scope).href);
      throw new Error("離線且無可用快取");
    })
  );
});
