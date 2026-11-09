// Service worker: makes the app installable and lets it open offline.
//
// How it stays up to date (no "Update" button needed):
//  - When online, the app's own files are ALWAYS loaded fresh from the website.
//    The saved copy is only used when there is no internet.
//  - A new version of this file takes over by itself and the open app reloads once.
//
// Changing VERSION is no longer required for updates, but it clears old saved copies.
const VERSION = "2026-11-09-6";
const CACHE = "crockery-stock-" + VERSION;
const SHELL = [
  "/", "/index.html", "/admin.html",
  "/style.css", "/app.js", "/admin.js", "/firebase.js", "/firebase-config.js", "/admins.js", "/pwa.js",
  "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // fetch every file fresh (not from the browser's HTTP cache), one by one, so one missing file can't block install
    await Promise.all(SHELL.map(async url => {
      try { const res = await fetch(url, { cache: "reload" }); if (res.ok) await c.put(url, res); } catch (_) {}
    }));
    await self.skipWaiting();   // take over straight away
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// old pages may still ask to skip waiting
self.addEventListener("message", e => { if (e.data?.type === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch the server API or Firebase data (Firestore keeps its own offline copy)
  if (url.pathname.startsWith("/api/")) return;
  if (url.hostname.endsWith("googleapis.com") && !url.hostname.startsWith("fonts.")) return;

  // Firebase SDK, barcode library and fonts never change at a given address → saved copy first
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

  // The app's own files: NETWORK FIRST (always the newest), saved copy only when offline
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      // the home page can be "/" or "/index.html": save and find it under one name
      const key = url.pathname === "/" ? "/index.html" : url.pathname;
      try {
        const res = await fetch(req, { cache: "no-store" });
        if (res.ok) c.put(key, res.clone());
        return res;
      } catch (err) {
        return (await c.match(key, { ignoreSearch: true }))
          || (req.mode === "navigate" ? await c.match("/index.html") : null)
          || Response.error();
      }
    })());
  }
});
