const VERSION = "aw-v2-20260914-2";
const SHELL = [
  "/",
  "/app.js",
  "/styles.css",
  "/storage.js",
  "/session.js",
  "/view-helpers.js",
  "/firebase.js",
  "/firebase-config.json",
  "/manifest.webmanifest",
  "/assets/logo.png",
];
const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const SDK_FILES = [
  "firebase-app.js",
  "firebase-auth.js",
  "firebase-app-check.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(SHELL);
      await Promise.allSettled(SDK_FILES.map((file) => cache.add(SDK + file)));
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (
          (key.startsWith("aw-") || key.startsWith("alabama-")) &&
          key !== VERSION
        )
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const same = url.origin === self.location.origin;
  // Authenticated API responses and private business records never enter this cache.
  if (same && url.pathname.startsWith("/api/")) return;
  const shell = same && SHELL.includes(url.pathname);
  const sdk =
    url.href.startsWith(SDK) &&
    SDK_FILES.includes(url.pathname.split("/").pop());
  if (!shell && !sdk) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const saved = await cache.match(request, { ignoreSearch: true });
        if (saved) return saved;
        throw error;
      }
    })(),
  );
});
