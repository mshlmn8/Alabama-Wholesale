const VERSION = "aw-v2-20260915-9";
const SHELL = [
  "/",
  "/app.js",
  "/gemini-chat.js",
  "/product-photos.js",
  "/gemini-chat.css",
  "/styles.css",
  "/storage.js",
  "/device-storage.js",
  "/storage-recovery.js",
  "/session.js",
  "/draft-sync.js",
  "/order-downloads.js",
  "/view-helpers.js",
  "/firebase.js",
  "/firebase-config.json",
  "/manifest.webmanifest",
  "/assets/logo.png",
  "/assets/app-icon-v2.svg",
  "/assets/fonts/manrope-latin.woff2",
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
      try {
        const cache = await caches.open(VERSION);
        await Promise.allSettled(
          [...SHELL, ...SDK_FILES.map((file) => SDK + file)].map((url) =>
            cache.add(url),
          ),
        );
      } catch {
        // Storage can be unavailable even when the app works over the network.
      }
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old = (await caches.keys()).filter(
          (key) =>
            (key.startsWith("aw-") || key.startsWith("alabama-")) &&
            key !== VERSION,
        );
        await Promise.allSettled(old.map((key) => caches.delete(key)));
      } catch {
        // A cache cleanup error must not keep a broken older worker in control.
      }
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
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        try {
          const cache = await caches.open(VERSION);
          const saved = await cache.match(request, { ignoreSearch: true });
          if (saved) return saved;
        } catch {
          // Preserve the network failure when no offline cache can be read.
        }
        throw error;
      }
      if (response.ok) event.waitUntil(remember(request, response.clone()));
      return response;
    })(),
  );
});

async function remember(request, response) {
  try {
    const cache = await caches.open(VERSION);
    await cache.put(request, response);
  } catch {
    // The fresh network response remains usable when a device cannot cache it.
  }
}
