const CACHE_PREFIX = "aw-warehouse-shell-";
const CACHE_NAME = CACHE_PREFIX + "v1";
const SHELL = [
  "/warehouse/",
  "/warehouse/index.html",
  "/warehouse/app.js",
  "/warehouse/helpers.js",
  "/warehouse/screens.js",
  "/warehouse/styles.css",
  "/warehouse/manifest.webmanifest",
  "/warehouse/icon.svg",
  "/firebase.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (request.mode === "navigate" && url.pathname.startsWith("/warehouse/")) {
    event.respondWith(
      fetch(request)
        .then((response) =>
          response.ok ? response : caches.match("/warehouse/index.html"),
        )
        .catch(() => caches.match("/warehouse/index.html")),
    );
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const saved = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, saved)),
          );
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
