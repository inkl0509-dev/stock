// Service worker: lets the app install, open offline, and update.
// ⚠️ Change VERSION every time you deploy changes → users see "New version available".
const VERSION = "2026-11-02-6";
const CACHE = "crockery-stock-" + VERSION;
const SHELL = [
  "/", "/index.html", "/admin.html",
  "/style.css", "/app.js", "/admin.js", "/firebase.js", "/firebase-config.js", "/admins.js", "/pwa.js",
  "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  // Download the new version, then wait until the user taps "Update"
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => { if (e.data?.type === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache the server API or Firebase data (Firestore keeps its own offline copy in IndexedDB)
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.endsWith("googleapis.com") && !url.hostname.startsWith("fonts.")) return;

  // Firebase SDK, barcode scanner library and fonts never change at a given URL → cache first
  if (url.hostname === "www.gstatic.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com" || url.hostname === "unpkg.com") {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Firebase config + admin list: always fetch fresh (so pasting new keys works right away); offline → saved copy
  if (url.origin === location.origin && (url.pathname === "/firebase-config.js" || url.pathname === "/admins.js")) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: "no-store" });
        if (res.ok) c.put(url.pathname, res.clone());
        return res;
      } catch (err) {
        return (await c.match(url.pathname)) || Response.error();
      }
    })());
    return;
  }

  // Our own files: use the cached version for this release, fall back to network
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("/index.html") : null);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match("/index.html")) || Response.error();
      }
    })());
  }
});
