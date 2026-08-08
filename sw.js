const CACHE_NAME = "scalp-position-calculator-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./cost.html",
  "./cost.css",
  "./cost-core.js",
  "./cost.js",
  "./manifest.webmanifest?v=4",
  "./favicon-v4.ico",
  "./favicon-32-v4.png",
  "./favicon-16-v4.png",
  "./favicon-v4.svg",
  "./apple-touch-icon-v4.png",
  "./safari-pinned-tab-v4.svg",
  "./icon-192-v4.png",
  "./icon-512-v4.png",
  "./maskable-192-v4.png",
  "./maskable-512-v4.png",
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
