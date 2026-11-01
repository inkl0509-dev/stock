// Install button + "new version available" bar. Used by every page.
let reg = null, deferredPrompt = null;
const $ = s => document.querySelector(s);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- updates ---------- */
function showUpdate(worker){
  const bar = $("#updateBar"); if (!bar) return;
  bar.hidden = false;
  $("#updateBtn").onclick = () => { $("#updateBtn").disabled = true; $("#updateBtn").textContent = "Updating…"; worker.postMessage({ type: "SKIP_WAITING" }); };
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      reg = await navigator.serviceWorker.register("/sw.js");
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
      // look for a new version when the app comes back to the screen, and every 30 minutes
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    } catch (e) { console.warn("Service worker not registered", e); }
  });
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (refreshing) return; refreshing = true; location.reload(); });
}

/** Ask the server for a newer version. Resolves true if one is ready to install. */
export async function checkForUpdate(){
  if (!reg) return false;
  try { await reg.update(); } catch (_) {}
  await new Promise(r => setTimeout(r, 800));
  if (reg.waiting && navigator.serviceWorker.controller) { showUpdate(reg.waiting); return true; }
  return false;
}

/* ---------- install ---------- */
function setInstallVisible(v){ document.querySelectorAll("[data-install]").forEach(b => b.hidden = !v); }

window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; setInstallVisible(true); });
window.addEventListener("appinstalled", () => { deferredPrompt = null; setInstallVisible(false); });

document.addEventListener("click", async e => {
  if (e.target.closest("[data-install]")) {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null; setInstallVisible(false);
    } else if ($("#iosHelp")) {
      $("#iosHelp").hidden = false;
    }
  }
  if (e.target.closest("[data-ios-close]")) $("#iosHelp").hidden = true;
});

// iPhone/iPad have no install prompt: show the button with "Share → Add to Home Screen" instructions
if (isIOS() && !isStandalone()) document.addEventListener("DOMContentLoaded", () => setInstallVisible(true));
