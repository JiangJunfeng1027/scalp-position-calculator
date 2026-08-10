const CACHE_NAME = "scalp-position-calculator-v14";
const ASSETS = [
  "./",
  "./index.html",
  "./cost.html",
  "./cost.css",
  "./cost-core.js",
  "./cost.js",
  "./manifest.webmanifest?v=5",
  "./favicon-v5.ico",
  "./favicon-32-v5.png",
  "./favicon-16-v5.png",
  "./favicon-v5.svg",
  "./apple-touch-icon-v5.png",
  "./safari-pinned-tab-v5.svg",
  "./icon-192-v5.png",
  "./icon-512-v5.png",
  "./maskable-192-v5.png",
  "./maskable-512-v5.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
