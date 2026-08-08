const CACHE_NAME = "scalp-position-calculator-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./cost.html",
  "./cost.css",
  "./cost-core.js",
  "./cost.js",
  "./manifest.webmanifest?v=3",
  "./favicon-v3.ico",
  "./favicon-32-v3.png",
  "./favicon-16-v3.png",
  "./favicon-v3.svg",
  "./apple-touch-icon-v3.png",
  "./safari-pinned-tab-v3.svg",
  "./icon-192-v3.png",
  "./icon-512-v3.png",
  "./maskable-192-v3.png",
  "./maskable-512-v3.png",
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
