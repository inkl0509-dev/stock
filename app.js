import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit, getDocsFromServer, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { fbApp, auth, api, configMissing } from "./firebase.js";
import { checkForUpdate } from "./pwa.js";
import { isAdminEmail } from "./admins.js";

/* ---------- Firebase ---------- */
// IndexedDB cache: all stock and activity is saved on the device, so the app opens and works
// offline. Changes made offline are queued and synced automatically when back online.
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------- constants & state ---------- */
// Lists admins can edit on the admin page (Firestore: settings/lists). These are the defaults.
const DEFAULT_LISTS = {
  units: ["pcs","bottles","cans","packs","boxes","packets","sets","pairs"],
  packings: ["Carton","Box","Packet","Case","Tray","Bag","Pack","Crate"],
  categories: ["Glassware","Cutlery","Cups & mugs","Plates & bowls","Serveware","Other"],
  places: [], suppliers: [], outlets: [],
  reasons: ["Dropped","Dishwasher","Chipped / cracked","Lost","Guest breakage"]
};
let lists = JSON.parse(JSON.stringify(DEFAULT_LISTS));
const TYPE_LABEL = { received:"Received", used:"Used", issued:"Issued", broken:"Broken", count:"Stock count" };
const QUICK_PICKS = [
  ["Water glass","Glassware"],["Wine glass","Glassware"],["Highball glass","Glassware"],["Juice glass","Glassware"],
  ["Espresso cup","Cups & mugs"],["Espresso saucer","Cups & mugs"],["Cappuccino cup","Cups & mugs"],["Tea cup","Cups & mugs"],
  ["Tea spoon","Cutlery"],["Table spoon","Cutlery"],["Dinner fork","Cutlery"],["Dinner knife","Cutlery"],
  ["Dinner plate","Plates & bowls"],["Quarter plate","Plates & bowls"],["Soup bowl","Plates & bowls"]
];
// Barcodes: item.codes = [{ code, per: "pcs"|"pkt"|"ctn"|"n", n (units, when per = "n"), brand }]
// Several barcodes per item are fine (e.g. different brands of the same glass).
// Older items may still have barcode / barcodePkt / barcodeCtn fields; those are read too.
const LEGACY_CODES = [["barcode","pcs"],["barcodePkt","pkt"],["barcodeCtn","ctn"]];
const PER_OPTS = [["pcs","Piece"],["pkt","Packet"],["ctn","Carton"],["n","Other qty"]];

let items = [], moves = [], loaded = false;
let unsubs = [];
const ui = { q:"", cat:"", sort:"attention" };   // cat "" = nothing chosen: show search + recent items only
const pending = {};   // quick +/- taps waiting to be saved
const chains = {};    // one write at a time per document
let cart = null;      // the open Stock in / Stock out list

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const int = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
const U = it => it?.unit || "pcs";
const unitWord = u => u === "pcs" ? "pieces" : u;
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
const withCurrent = (arr, v) => v && !arr.includes(v) ? [...arr, v] : arr;
const options = (arr, sel) => arr.map(v => `<option value="${esc(v)}" ${v===sel?"selected":""}>${esc(v)}</option>`).join("");
const datalist = (id, arr) => `<datalist id="${id}">${arr.map(v => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
const byName = (a,b) => a.name.localeCompare(b.name);

const shown = it => Math.max(0, (+it.qty||0) + (pending[it.id]?.delta||0));
function status(it){ const q = shown(it), m = +it.min||0; return q<=0 ? "out" : q<=m ? "low" : "ok"; }
const statusLabel = st => st === "ok" ? "In stock" : st === "low" ? "⚠ Low" : "✕ Out of stock";

/* ---------- packing: stock is stored in the item's unit (e.g. pieces) ---------- */
// pp = units in 1 small pack, pc = units in 1 big pack; pn / cn = what you call them (box, packet, carton, case…)
const rawSizes = it => ({ pp: int(it?.perPacket), pc: int(it?.perCarton),
  pn: String(it?.packName || "packet").trim().toLowerCase() || "packet", cn: String(it?.cartonName || "carton").trim().toLowerCase() || "carton" });
/* Every item is shown and entered in TWO units only: its main pack (carton, box…) and its single unit (can, spoon…).
   The main pack is the carton level if set, otherwise the packet level. */
function sizes(it){
  const r = rawSizes(it);
  return r.pc ? { ...r, pp: 0 } : r;
}
/* the main pack: { name, n } or null */
function mainPack(it){ const r = rawSizes(it); return r.pc ? { name: r.cn, n: r.pc, k: "ctn" } : r.pp ? { name: r.pn, n: r.pp, k: "pkt" } : null; }
const UNIT_KEYS = ["unit", "perCarton", "perPacket", "cartonName", "packName"];
const pl = (n, w) => n === 1 ? w : /(s|x|z|ch|sh)$/.test(w) ? w + "es" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s";
const PACK_NAMES = ["Packet", "Box", "Pack", "Tray", "Bag", "Roll", "Sleeve"];
const BIG_NAMES = ["Carton", "Case", "Box", "Crate", "Bundle", "Sack"];
function split(q, s){
  let rest = Math.max(0, q|0); const out = { ctn:0, pkt:0, pcs:0 };
  if (s.pc) { out.ctn = Math.floor(rest / s.pc); rest -= out.ctn * s.pc; }
  if (s.pp) { out.pkt = Math.floor(rest / s.pp); rest -= out.pkt * s.pp; }
  out.pcs = rest; return out;
}
const plural = (n, one, many) => `${n} ${n===1?one:many}`;
function packText(q, s, unit = "pcs", { always=false } = {}){
  if (!s.pc && !s.pp) return always ? `${q} ${unit}` : "";
  const b = split(q, s), parts = [];
  if (b.ctn) parts.push(`${b.ctn} ${pl(b.ctn, s.cn || "carton")}`);
  if (b.pkt) parts.push(`${b.pkt} ${pl(b.pkt, s.pn || "packet")}`);
  if (b.pcs || !parts.length) parts.push(`${b.pcs} ${unit}`);
  return parts.join(" + ");
}
function sizeText(s, unit = "pcs"){
  const bits = [];
  const pn = s.pn || "packet", cn = s.cn || "carton";
  if (s.pp) bits.push(`1 ${pn} = ${s.pp} ${unit}`);
  if (s.pc) bits.push(s.pp && s.pc % s.pp === 0 ? `1 ${cn} = ${s.pc/s.pp} ${pl(s.pc/s.pp, pn)} (${s.pc} ${unit})` : `1 ${cn} = ${s.pc} ${unit}`);
  return bits.join(" · ");
}
/* ---------- barcodes ---------- */
const normCode = c => String(c || "").trim().replace(/\s+/g, "").toLowerCase();
function codesOf(it){
  const out = Array.isArray(it?.codes) ? it.codes.filter(c => c && c.code).map(c => ({ ...c })) : [];
  for (const [f, per] of LEGACY_CODES) if (it?.[f] && !out.some(c => normCode(c.code) === normCode(it[f]))) out.push({ code: it[f], per });
  return out;
}
const stripLegacy = ({ barcode, barcodePkt, barcodeCtn, _codes, ...rest }) => rest;
function findByCode(code){
  const c = normCode(code); if (!c) return null;
  for (const it of items) for (const k of codesOf(it)) if (normCode(k.code) === c) return { it, c: k };
  return null;
}
/* how many units one scan of this barcode is */
function codeUnits(c, it){
  const s = rawSizes(it);
  if (c.per === "ctn") return s.pc || 1;
  if (c.per === "pkt") return s.pp || 1;
  if (c.per === "n") return int(c.n) || 1;
  return 1;
}
/* which quantity box (cartons / packets / pieces) a scan adds to */
function levelFor(c, it){
  const s = sizes(it);   // only the main pack has its own box; anything else counts as single units
  if (c?.per === "ctn" && s.pc) return ["ctn", 1];
  if (c?.per === "pkt" && s.pp) return ["pkt", 1];
  return ["pcs", c ? codeUnits(c, it) : 0];
}
function codeLabel(c, it){
  const u = U(it), n = codeUnits(c, it);
  const sz = rawSizes(it);
  const base = c.per === "ctn" ? sz.cn : c.per === "pkt" ? sz.pn : c.per === "n" ? `pack of ${n}` : (u === "pcs" ? "piece" : /[^s]s$/.test(u) && !/es$/.test(u) ? u.slice(0, -1) : u);
  return base + (c.per !== "pcs" && c.per !== "n" && n > 1 ? ` (${n} ${u})` : "");
}
async function addCodeToItem(it, c){
  const updated = { ...stripLegacy(it), codes: [...codesOf(it), c], updatedAt: Date.now() };
  Object.assign(it, updated);
  await putItem(updated);
}

/* ---------- feedback: beep + vibrate ---------- */
let actx;
function beep(ok = true){
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.value = ok ? 1250 : 320; g.gain.value = 0.07;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.08 : 0.28));
  } catch (_) {}
  try { navigator.vibrate?.(ok ? 40 : [90, 60, 90]); } catch (_) {}
}

/* ---------- auth ---------- */
onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  if (user) {
    $("#loginView").hidden = true; $("#appView").hidden = false;
    $("#who").textContent = user.displayName || user.email || "";
    startData();
    showAdminLink();
  } else {
    amAdmin = false;
    items = []; moves = []; loaded = false;
    $("#appView").hidden = true; $("#loginView").hidden = false;
    try { $("#lRemember").checked = localStorage.getItem("cs-remember") !== "0"; } catch (_) {}
    $("#lEmail").focus();
  }
});

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#lEmail").value.trim(), pass = $("#lPass").value, err = $("#lErr");
  if (configMissing) return showConfigHelp();
  if (!email || !pass) return err.textContent = "Enter your email and password.";
  err.textContent = ""; $("#lBtn").disabled = true;
  try {
    // Remember me ON → stay signed in after closing the browser; OFF → signed out when it closes
    await setPersistence(auth, $("#lRemember").checked ? browserLocalPersistence : browserSessionPersistence);
    try { localStorage.setItem("cs-remember", $("#lRemember").checked ? "1" : "0"); } catch (_) {}
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (ex) {
    if (/api-key|invalid-api-key|configuration-not-found|project-not-found/.test(ex.code || "")) return showConfigHelp(ex.code);
    err.textContent = ex.code === "auth/operation-not-allowed" ? "Email/Password sign-in is turned off. Turn it on in Firebase → Authentication → Sign-in method."
      : ex.code === "auth/unauthorized-domain" ? `This website (${location.hostname}) isn't allowed yet. Add it in Firebase → Authentication → Settings → Authorized domains.`
      : ex.code === "auth/user-disabled" ? "This account is disabled. Ask your admin."
      : ex.code === "auth/too-many-requests" ? "Too many attempts. Wait a minute and try again."
      : ex.code === "auth/network-request-failed" ? "No internet connection."
      : "Wrong email or password.";
  } finally { $("#lBtn").disabled = false; }
});
function showConfigHelp(code){
  $("#lErr").innerHTML = `<b>Firebase isn't connected yet.</b> Open <code>firebase-config.js</code> and replace the placeholder values
    with your app's config from Firebase console → Project settings → General → Your apps → Web app.
    Then upload the file to GitHub again.${code ? ` <small>(${esc(code)})</small>` : ""}`;
  $("#lErr").classList.add("setup");
}
if (configMissing) showConfigHelp();

$("#outBtn").addEventListener("click", () => {
  const role = amAdmin ? "Admin" : "Staff";
  openSheet(`<h3>Sign out?</h3><p>Signed in as <b>${esc(auth.currentUser?.email)}</b> <span class="pill ${role === "Admin" ? "admin" : "staff"}">${role}</span></p>
    <p class="hint">${role === "Admin" ? "You can manage users and lists on the Admin page." : "An admin can make you an admin on Admin → Users."} You'll need your email and password to sign back in.</p>
    <div class="actions"><button class="btn" type="button" data-close>Stay signed in</button><button class="btn primary" type="button" id="yesOut">Sign out</button></div>`,
    p => p.querySelector("#yesOut").addEventListener("click", () => { closeSheet(1, true); signOut(auth); }));
});
$("#lPassToggle").addEventListener("click", () => {
  const i = $("#lPass"), show = i.type === "password";
  i.type = show ? "text" : "password"; $("#lPassToggle").textContent = show ? "Hide" : "Show";
});

let amAdmin = false;
function setAdmin(v){ amAdmin = !!v; renderHome(); }
/* Admin = owner email (admins.js) or listed as admin on Admin → Users (settings/access) */
function showAdminLink(){
  const email = String(auth.currentUser?.email || "").toLowerCase();
  setAdmin(isAdminEmail(email));
  unsubs.push(onSnapshot(doc(db, "settings", "access"), snap => {
    setAdmin(isAdminEmail(email) || !!snap.data()?.admins?.includes(email));
  }, () => {}));
}
/* signed in, but not on the user list */
function showNoAccess(){
  $("#list").innerHTML = `<div class="empty"><h3>No access yet</h3>
    <p>${esc(auth.currentUser?.email)} isn't on the user list. Ask your admin to add you on Admin → Users, then tap Reload.</p>
    <button class="btn" type="button" id="naOut">Sign in with another account</button></div>`;
  $("#naOut").addEventListener("click", () => signOut(auth));
  setSync("No access", "bad");
}

/* add a new entry to an admin list (categories, units…) from a form */
async function addToList(key, value){
  if (!amAdmin) return false;
  try { await setDoc(doc(db, "settings", "lists"), { [key]: arrayUnion(value), updatedAt: Date.now() }, { merge: true }); return true; }
  catch (_) { return false; }
}
const NEW_OPT = `<option value="__new">＋ Add new…</option>`;

/* reload: fresh data from the server + check for a new app version */
$("#reloadBtn").addEventListener("click", async () => {
  const b = $("#reloadBtn");
  if (b.classList.contains("spin")) return;
  b.classList.add("spin"); b.disabled = true;
  Object.keys(pending).forEach(commitNudge);
  unsubs.forEach(u => u()); unsubs = [];
  startData();
  let online = true;
  try { await getDocsFromServer(collection(db, "items")); } catch (_) { online = false; }
  const updated = await checkForUpdate();
  b.classList.remove("spin"); b.disabled = false;
  if (!online) toast("You're offline. Showing data saved on this device.");
  else toast(updated ? "Stock refreshed · a new version is ready" : "Stock refreshed · app is up to date");
});

/* ---------- data ---------- */
function setSync(text, cls){ const s = $("#sync"); s.textContent = text; s.className = "sync " + (cls||""); }
window.addEventListener("online",  () => setSync("Back online · syncing", "ok"));
window.addEventListener("offline", () => setSync("Offline · changes will sync", "warn"));

function startData(){
  loaded = false; render();
  setSync("Loading your stock…");
  unsubs.push(onSnapshot(collection(db, "items"), { includeMetadataChanges: true }, snap => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded = true;
    setSync(snap.metadata.fromCache ? "Offline · changes will sync" : "Saved · syncs across devices",
            snap.metadata.fromCache ? "warn" : "ok");
    render();
  }, e => { loaded = true; if (e.code === "permission-denied") return showNoAccess(); setSync("Can't load stock: " + e.code, "bad"); render(); }));

  unsubs.push(onSnapshot(doc(db, "settings", "lists"), snap => {
    const d = snap.data() || {};
    lists = {};
    for (const k of Object.keys(DEFAULT_LISTS)) lists[k] = Array.isArray(d[k]) ? d[k] : DEFAULT_LISTS[k];
    render();
  }, () => {}));

  unsubs.push(onSnapshot(query(collection(db, "moves"), orderBy("at","desc"), limit(200)), snap => {
    moves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, () => {}));
}

function chain(key, fn){ const p = (chains[key]||Promise.resolve()).catch(()=>{}).then(fn); chains[key] = p; return p; }
function writeErr(e){
  toast(e?.code === "permission-denied" ? "You don't have permission to change stock." : "Couldn't save. Try again.");
  throw e;
}
const putItem    = it => { const { id, ...body } = it; return chain("i/"+id, () => setDoc(doc(db,"items",id), body)).catch(writeErr); };
const removeItem = id => chain("i/"+id, () => deleteDoc(doc(db,"items",id))).catch(writeErr);
const addMove    = m  => { const { id, ...body } = m; return setDoc(doc(db,"moves",id), body).catch(writeErr); };

/* change stock and log it. received adds; used/issued/broken subtract; count adds n (may be negative) */
async function applyMove(itemId, type, n, note, { party = "", batch = "", extra = {} } = {}){
  const it = items.find(x => x.id === itemId); if (!it) return null;
  const before = +it.qty||0;
  const after = type === "received" ? before + n : type === "count" ? Math.max(0, before + n) : Math.max(0, before - n);
  if (after === before) return { before, after };
  it.qty = after; render();
  await putItem({ ...it, qty: after, updatedAt: Date.now() });
  await addMove({ id: uid("m"), itemId, name: it.name, unit: U(it), type, qty: type === "count" ? after - before : n,
    before, after, note: note||"", party: party||"", batch: batch||"", by: auth.currentUser?.email || "", at: Date.now(), ...extra });
  return { before, after };
}

/* quick +/- on a row: taps are combined into one saved change */
function nudge(id, d){
  const it = items.find(x => x.id === id); if (!it) return;
  const p = pending[id] || (pending[id] = { delta:0, t:null });
  if ((+it.qty||0) + p.delta + d < 0) return;
  p.delta += d; clearTimeout(p.t);
  p.t = setTimeout(() => commitNudge(id), 900);
  render();
}
async function commitNudge(id){
  const p = pending[id]; if (!p) return;
  clearTimeout(p.t); delete pending[id];
  if (!p.delta) return render();
  try { await applyMove(id, "count", p.delta, "Quick count fix"); } catch (e) {}
}

/* ---------- main screen ---------- */
function render(){ renderHome(); renderSummary(); renderChips(); renderList(); renderFeed(); quickRefresh?.(); }

function renderSummary(){
  const low = items.filter(it => status(it) === "low").length;
  const out = items.filter(it => status(it) === "out").length;
  const since = Date.now() - 30*864e5, today = new Date().toDateString();
  const sum = f => moves.filter(f).reduce((a,m) => a + (+m.qty||0), 0);
  const inToday = moves.filter(m => m.type === "received" && new Date(m.at).toDateString() === today).length;
  const outToday = moves.filter(m => ["used","issued"].includes(m.type) && new Date(m.at).toDateString() === today).length;
  const broken = moves.filter(m => m.type === "broken" && m.at >= since).reduce((a, m) => a + effQty(m), 0);
  $("#summary").innerHTML = `
    <div class="tile"><span class="lab">Items</span><span class="val">${items.length}</span><span class="sub">${items.reduce((a,it)=>a+shown(it),0).toLocaleString()} units on hand</span></div>
    <div class="tile ${low+out?"warn":""}"><span class="lab">Low / out of stock</span><span class="val"><span class="v-low">${low}</span> <span class="v-sep">/</span> <span class="v-out">${out}</span></span>${low+out?`<button class="link" type="button" id="copyReorder">Copy reorder list</button>`:`<span class="sub">All above minimum</span>`}</div>
    <div class="tile"><span class="lab">Today</span><span class="val">${inToday} <small class="in">in</small> ${outToday} <small class="outw">out</small></span><span class="sub">stock entries</span></div>
    <div class="tile ${broken?"bad":""}"><span class="lab">Broken · 30 days</span><span class="val">${broken}</span><span class="sub">units written off</span></div>`;
}

function renderChips(){
  const counts = {}; items.forEach(i => counts[i.category] = (counts[i.category]||0) + 1);
  const low = items.filter(it => status(it) !== "ok").length;
  const noCode = items.filter(it => !codesOf(it).length).length;
  const cats = [...(low ? ["Low stock"] : []), ...(noCode ? ["No barcode"] : []), ...lists.categories.filter(c => counts[c]), ...Object.keys(counts).filter(c => !lists.categories.includes(c)).sort(), "All"];
  if (ui.cat && !cats.includes(ui.cat)) ui.cat = "";
  $("#chips").innerHTML = cats.map(c => `<button type="button" class="chip ${c==="Low stock"?"warn":c==="No barcode"?"nocode":c==="All"?"allc":""}" data-cat="${esc(c)}" aria-pressed="${ui.cat===c}">${c==="All" ? "All items" : esc(c)}<span class="c">${c==="All"?items.length:c==="Low stock"?low:c==="No barcode"?noCode:counts[c]}</span></button>`).join("");
}

function matches(it, q){
  if (!q) return true;
  const hay = (it.name + " " + it.category + " " + (it.place||"") + " " + codesOf(it).map(c => c.code + " " + (c.brand||"")).join(" ")).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function sorted(){
  const q = ui.q.trim();
  const list = items.filter(it =>
    (!ui.cat || ui.cat === "All" || (ui.cat === "Low stock" ? status(it) !== "ok" : ui.cat === "No barcode" ? !codesOf(it).length : it.category === ui.cat)) && matches(it, q));
  const rank = { out:0, low:1, ok:2 };
  if (ui.sort === "attention") list.sort((a,b) => rank[status(a)] - rank[status(b)] || byName(a,b));
  else if (ui.sort === "name") list.sort(byName);
  else if (ui.sort === "most") list.sort((a,b) => shown(b) - shown(a));
  else list.sort((a,b) => shown(a) - shown(b));
  return list;
}

function renderList(){
  const el = $("#list");
  if (!loaded) { el.innerHTML = `<div class="empty"><h3>Opening the stockroom…</h3><p>Your items will appear here.</p></div>`; return; }
  if (!items.length) {
    el.innerHTML = `<div class="empty"><h3>Let's add your first item</h3><p>Tap one to start, scan a barcode, or add your own.</p>
      <div class="picks">${QUICK_PICKS.slice(0,8).map(([n,c]) => `<button type="button" class="chip" data-act="pick" data-name="${esc(n)}" data-cat="${esc(c)}">${esc(n)}</button>`).join("")}</div>
      <button class="btn primary" type="button" data-act="add">＋ Add an item</button></div>`;
    return;
  }
  $("#sort").hidden = !ui.cat;
  $("#qClear").hidden = !ui.q;
  /* nothing searched and no filter: don't list every item */
  if (!ui.q.trim() && !ui.cat) {
    const seen = new Set(), recent = [];
    for (const m of moves) { if (recent.length >= 6) break; const it = items.find(x => x.id === m.itemId); if (it && !seen.has(it.id)) { seen.add(it.id); recent.push(it); } }
    const attention = items.filter(it => status(it) !== "ok").length;
    el.innerHTML = `<div class="search-start">
        <p><b>Search or scan</b> to find an item.</p>
        <p class="hint">${items.length} items${attention ? ` · <button type="button" class="link" data-act="cat" data-cat="Low stock">${attention} need attention</button>` : ""} · <button type="button" class="link" data-act="cat" data-cat="All">show all</button></p>
      </div>
      ${recent.length ? `<div class="recent-h">Recently used</div>` + recent.map(rowHtml).join("") : ""}`;
    return;
  }
  const list = sorted();
  const setupBanner = ui.cat === "No barcode" && list.length ? `<div class="setup-banner">${BARCODE_ICON}<div><b>${plural(list.length, "item has", "items have")} no barcode.</b><span>Scan them one after another. Each scan is saved to the item shown.</span></div><button type="button" class="btn primary" data-act="setup">Start</button></div>` : "";
  const cat = realCat(), q = ui.q.trim();
  const addBar = `<div class="add-bar"><button type="button" class="btn add-here" data-act="addhere">＋ ${cat ? `New item in <b>${esc(cat)}</b>` : "New item"}</button></div>`;
  if (!list.length) {
    el.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>${q ? `No item called “${esc(q)}”${cat ? ` in ${esc(cat)}` : ""}.` : "Try another search or category."}</p>
      <div class="empty-actions">${q ? `<button class="btn primary" type="button" data-act="addhere">＋ Create “${esc(q)}”${cat ? ` in ${esc(cat)}` : ""}</button>` : ""}
      <button class="btn" type="button" data-act="clear">Clear search</button></div></div>`;
    return;
  }
  el.innerHTML = setupBanner + (ui.cat && ui.cat !== "Low stock" && ui.cat !== "No barcode" ? addBar : "") + list.map(rowHtml).join("");
}
/* the chosen category chip, if it's a real category (not All / Low stock / No barcode) */
function realCat(){ return ui.cat && !["All", "Low stock", "No barcode"].includes(ui.cat) ? ui.cat : ""; }
function rowHtml(it){
  {
    const st = status(it), q = shown(it), m = +it.min||0, s = sizes(it);
    const pct = Math.min(100, m ? (q/(m*2))*100 : (q?100:0));
    const pack = packText(q, s, U(it));
    return `<div class="row ${st} ${pending[it.id]?"pending":""}" data-row="${it.id}">
      <span class="stripe" aria-hidden="true"></span>
      <button type="button" class="main" data-act="open" data-id="${it.id}">
        <span class="name">${esc(it.name)}${codesOf(it).length ? ` <span class="bc-mark" title="Has barcode" aria-label="Has barcode">${BARCODE_ICON}</span>` : ""}</span>
        <span class="meta"><span class="pill ${st}">${statusLabel(st)}</span>${esc(it.category)} · min ${m}${it.place?` · ${esc(it.place)}`:""}</span>
        ${pack ? `<span class="pack">${esc(pack)}</span>` : ""}
        <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      </button>
      <div class="ctrl">
        <button type="button" class="step" data-act="dec" data-id="${it.id}" aria-label="Count one less ${esc(it.name)}">−</button>
        <span class="qty"><b>${q}</b><small>${esc(U(it))}</small></span>
        <button type="button" class="step" data-act="inc" data-id="${it.id}" aria-label="Count one more ${esc(it.name)}">+</button>
      </div></div>`;
  }
}

function fmtWhen(t){
  const d = new Date(t), now = new Date(), diff = (now - d) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return Math.floor(diff/60) + " min ago";
  const hm = d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  if (d.toDateString() === now.toDateString()) return "Today " + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + hm;
  return d.toLocaleDateString([], { day:"numeric", month:"short" }) + " " + hm;
}
/* ---------- corrections: a wrong entry is fixed by a new "Correction" entry (fixOf = original id) ---------- */
const CORRECTABLE = ["received", "used", "issued", "broken"];
const fixesFor = id => moves.filter(x => x.fixOf === id).sort((a, b) => a.at - b.at);
function effQty(m){ const f = fixesFor(m.id); return f.length ? int(f[f.length - 1].fixQty) : +m.qty || 0; }
const myEmail = () => String(auth.currentUser?.email || "").toLowerCase();
const canCorrect = m => CORRECTABLE.includes(m.type) && (amAdmin || String(m.by || "").toLowerCase() === myEmail());

function deltaText(m){
  if (CORRECTABLE.includes(m.type) && fixesFor(m.id).length) {
    const sign = m.type === "received" ? "+" : "−";
    return `<s>${sign}${+m.qty||0}</s> ${sign}${effQty(m)}`;
  }
  const n = +m.qty||0;
  if (m.type === "received") return "+" + n;
  if (["issued","broken","used"].includes(m.type)) return "−" + n;
  return (n>0?"+":n<0?"−":"") + Math.abs(n);
}
const partyWord = t => t === "received" ? "from" : t === "issued" ? "to" : t === "used" ? "at" : "·";
function moveLi(m, withName){
  const fixed = CORRECTABLE.includes(m.type) && fixesFor(m.id).length, can = canCorrect(m);
  const label = m.fixOf ? "Correction" : (TYPE_LABEL[m.type] || m.type);
  return `<li class="${can ? "can-fix" : ""} ${fixed ? "fixed" : ""} ${m.fixOf ? "is-fix" : ""}" ${can ? `data-mid="${m.id}" tabindex="0" role="button" aria-label="Correct this entry"` : ""}>
    <span class="delta ${m.fixOf ? "count" : m.type}">${deltaText(m)}</span><div>
    <div class="what">${withName ? esc(m.name) + " · " : ""}${label}${m.party ? ` ${partyWord(m.type)} ${esc(m.party)}` : ""}${fixed ? ` <span class="pill fixpill">corrected</span>` : ""}</div>
    <div class="when">${fmtWhen(m.at)}${m.fixOf ? "" : ` · now ${m.after} ${esc(m.unit||"pcs")}`}${m.by ? ` · ${esc(m.by.split("@")[0])}` : ""}</div>
    ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}</div>
    ${can ? `<span class="fix-ico" aria-hidden="true">✎</span>` : ""}</li>`;
}

/* tap an entry → correct the amount, or cancel the entry */
function correctEntry(id){
  const m = moves.find(x => x.id === id); if (!m || !canCorrect(m)) return;
  const it = items.find(x => x.id === m.itemId);
  if (!it) return toast("This item was deleted, so the entry can't be changed.");
  const cur = effQty(m), u = U(it), isIn = m.type === "received";
  openSheet(`<h3>Correct entry</h3>
    <div class="fix-orig">
      <b>${TYPE_LABEL[m.type]} ${cur} ${esc(u)}</b> · ${esc(it.name)}
      <span class="hint">${fmtWhen(m.at)}${m.by ? ` · by ${esc(m.by.split("@")[0])}` : ""}${m.party ? ` · ${partyWord(m.type)} ${esc(m.party)}` : ""}${cur !== +m.qty ? ` · first entered as ${+m.qty}` : ""}</span>
    </div>
    <fieldset class="qbox-wrap"><legend>Correct amount</legend><div class="qbox" id="fxQ"></div></fieldset>
    <div class="field"><label for="fxNote">Reason <span class="opt">optional</span></label><input id="fxNote" maxlength="80" placeholder="e.g. Typed 72 instead of 48"></div>
    <div class="err" id="fxErr" role="alert"></div>
    <div class="actions">
      <button type="button" class="btn danger" id="fxCancel">Cancel this entry</button>
      <button type="button" class="btn primary" id="fxSave" disabled>Save correction</button>
    </div>`, p => {
    const stockNow = () => shown(items.find(x => x.id === it.id) || it);
    const qb = qtyBox(p.querySelector("#fxQ"), () => sizes(it), cur, n => {
      const change = isIn ? n - cur : cur - n, after = stockNow() + change;
      p.querySelector("#fxSave").disabled = n === cur || after < 0;
      if (n === cur) return `Same as now: <b>${cur} ${esc(u)}</b>`;
      if (after < 0) return `<span class="bad">Stock would go below zero (only ${stockNow()} ${esc(u)} left)</span>`;
      return `${cur} → <b>${n} ${esc(u)}</b> · stock ${change > 0 ? "+" : "−"}${Math.abs(change)} → <b>${after} ${esc(u)}</b>`;
    }, () => u, { smallFirst: !isIn });
    const save = async newQ => {
      const change = isIn ? newQ - cur : cur - newQ, err = p.querySelector("#fxErr");
      if (stockNow() + change < 0) return err.textContent = `Stock would go below zero. Only ${stockNow()} ${u} left.`;
      const reason = p.querySelector("#fxNote").value.trim();
      closeSheet(1, true);
      await commitNudge(it.id);
      try {
        const note = `${newQ === 0 ? "Cancelled" : "Corrected"}: ${TYPE_LABEL[m.type].toLowerCase()} ${cur} → ${newQ} (${fmtWhen(m.at).toLowerCase()})${reason ? ` · ${reason}` : ""}`;
        const r = await applyMove(it.id, "count", change, note, { extra: { fixOf: m.id, fixQty: newQ } });
        if (r && r.after === r.before) await addMove({ id: uid("m"), itemId: it.id, name: it.name, unit: u, type: "count", qty: 0, before: r.before, after: r.after, note, party: "", by: myEmail(), at: Date.now(), fixOf: m.id, fixQty: newQ });
        toast(newQ === 0 ? `Entry cancelled · ${it.name}` : `Corrected to ${newQ} ${u} · ${it.name}`);
      } catch (_) {}
    };
    p.querySelector("#fxSave").addEventListener("click", () => save(qb.total()));
    p.querySelector("#fxCancel").addEventListener("click", e => {
      if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Tap again to cancel it"; return; }
      save(0);
    });
  });
}
document.addEventListener("click", e => {
  const li = e.target.closest("li[data-mid]"); if (!li) return;
  correctEntry(li.dataset.mid);
});
document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("li[data-mid]")) { e.preventDefault(); correctEntry(e.target.dataset.mid); }
});
function renderFeed(){
  const f = $("#feed");
  $("#actCount").textContent = moves.length ? `Last ${moves.length} changes` : "";
  if (!moves.length) { f.innerHTML = `<li style="display:block"><div class="empty" style="padding:20px 6px"><p>Every stock in, stock out and breakage shows up here.</p></div></li>`; return; }
  f.innerHTML = moves.map(m => moveLi(m, true)).join("");
}

/* ---------- sheets (two layers: a form can open on top of the stock list) ---------- */
const guards = {};
const sheetEls = layer => layer === 2 ? [$("#sheet2"), $("#panel2")] : [$("#sheet"), $("#panel")];
function openSheet(html, mount, { layer = 1, full = false, guard = null } = {}){
  const [sh, pn] = sheetEls(layer);
  pn.className = "panel" + (full ? " full" : "");
  pn.innerHTML = `<button type="button" class="btn ghost x" data-close aria-label="Close">✕</button>` + html;
  sh.hidden = false; guards[layer] = guard;
  document.body.classList.add("locked");
  mount && mount(pn);
  return pn;
}
function closeSheet(layer = 1, force = false){
  if (!force && guards[layer] && guards[layer]()) return;
  const [sh, pn] = sheetEls(layer);
  sh.hidden = true; pn.innerHTML = ""; guards[layer] = null;
  if (layer === 1) { closeSheet(2, true); cart = null; }
  if ($("#sheet").hidden && $("#sheet2").hidden && $("#scanner").hidden) document.body.classList.remove("locked");
}
document.addEventListener("click", e => {
  const c = e.target.closest("[data-close]"); if (!c) return;
  closeSheet(c.closest("#sheet2") ? 2 : 1);
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#scanner").hidden) closeScanner();
  else if (!$("#sheet2").hidden) closeSheet(2);
  else if (!$("#sheet").hidden) closeSheet(1);
});

/* Quantity entry in cartons / packets / pieces with − / + buttons and a live total */
function qtyBox(box, getSizes, startPcs, onChange, getUnit = () => "pcs", { smallFirst = false } = {}){
  let s = getSizes();
  const read = () => {
    const v = k => int(box.querySelector(`[data-u="${k}"]`)?.value);
    return v("ctn") * (s.pc||0) + v("pkt") * (s.pp||0) + v("pcs");
  };
  const draw = total => {
    s = getSizes();
    const b = (s.pc || s.pp) ? split(total, s) : { ctn:0, pkt:0, pcs: total };
    const rows = [], u = getUnit(), w = unitWord(u);
    if (s.pc) rows.push(["ctn", cap(pl(2, s.cn || "carton")), `${s.pc} ${u} each`, b.ctn]);
    if (s.pp) rows.push(["pkt", cap(pl(2, s.pn || "packet")), `${s.pp} ${u} each`, b.pkt]);
    rows.push(["pcs", rows.length && !smallFirst ? `Loose ${w}` : cap(w), "", b.pcs]);
    if (smallFirst) rows.reverse();
    box.innerHTML = rows.map(([k,lab,sub,val]) => `
      <div class="qrow">
        <label for="q-${k}-${box.id}"><b>${lab}</b>${sub?`<small>${sub}</small>`:""}</label>
        <div class="stepper">
          <button type="button" class="step" data-d="-1" data-k="${k}" aria-label="Less ${lab.toLowerCase()}">−</button>
          <input id="q-${k}-${box.id}" data-u="${k}" type="number" inputmode="numeric" min="0" step="1" value="${val||""}" placeholder="0">
          <button type="button" class="step" data-d="1" data-k="${k}" aria-label="More ${lab.toLowerCase()}">+</button>
        </div>
      </div>`).join("") + `<div class="qtotal" aria-live="polite"></div>`;
    update();
  };
  const update = () => { const t = read(); box.querySelector(".qtotal").innerHTML = onChange(t); };
  box.addEventListener("input", update);
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-d]"); if (!b) return;
    const i = box.querySelector(`[data-u="${b.dataset.k}"]`);
    i.value = Math.max(0, int(i.value) + Number(b.dataset.d)) || "";
    update();
  });
  draw(startPcs);
  return {
    total: read,
    redraw: () => draw(read()),
    refresh: update,
    add(k, n = 1){
      const i = box.querySelector(`[data-u="${k}"]`) || box.querySelector('[data-u="pcs"]');
      i.value = Math.max(0, int(i.value) + n) || ""; update();
      i.closest(".qrow")?.classList.remove("bump"); void i.offsetWidth; i.closest(".qrow")?.classList.add("bump");
    },
    focusFirst(){ box.querySelector("input")?.focus(); }
  };
}

/* ---------- item form ---------- */
/* ---------- units: 1 [Carton ▾] = [24] [cans ▾] ---------- */
function packOptions(sel){
  const names = [...(lists.packings?.length ? lists.packings : DEFAULT_LISTS.packings)];
  if (sel && !names.some(n => n.toLowerCase() === sel.toLowerCase())) names.push(cap(sel));
  return names.map(n => `<option value="${esc(n.toLowerCase())}" ${sel && n.toLowerCase() === sel.toLowerCase() ? "selected" : ""}>${esc(n)}</option>`).join("")
    + `<option value="__new">＋ Add new…</option>`;
}
function unitOptions(sel){ return options(withCurrent(lists.units.length ? lists.units : ["pcs"], sel), sel) + NEW_OPT; }
function sizeFields(it, { locked = false } = {}){
  const r = rawSizes(it), main = mainPack(it);
  return `<div class="units-card ${locked ? "locked" : ""}" id="fPackBox" data-slot="${main?.k || "ctn"}" data-keeppp="${r.pc ? r.pp : 0}" data-keeppn="${esc(r.pn)}">
    <div class="uc-title"><b>Units</b><span class="hint">main pack and single unit</span></div>
    <div class="uc-line">
      <span class="uc-cap">Main pack</span><span class="uc-cap"></span><span class="uc-cap">Contains</span><span class="uc-cap">Single unit</span>
      <select id="fOuter" aria-label="Main pack unit" ${locked ? "disabled" : ""}><option value="" ${main ? "" : "selected"}>No pack</option>${packOptions(main?.name || "")}</select>
      <span class="eq">=</span>
      <input id="fOuterN" class="pnum" type="number" inputmode="numeric" min="0" step="1" value="${main?.n || ""}" placeholder="0" aria-label="How many single units in 1 main pack" ${locked ? "disabled" : ""}>
      <select id="fUnit" data-list="units" data-word="unit" aria-label="Single unit" ${locked ? "disabled" : ""}>${unitOptions(U(it))}</select>
    </div>
    <div class="pk-new" id="fPkNew" hidden><input id="fPkNewVal" maxlength="20" placeholder="New pack name, e.g. Crate" aria-label="New pack name"><button type="button" class="btn sm primary" id="fPkNewAdd">Add</button><button type="button" class="btn sm" id="fPkNewCancel">Cancel</button></div>
    <p class="pack-sum" id="fSizeHint"></p>
    ${locked ? `<p class="hint">Only admins can change an item's units.</p>` : ""}
  </div>`;
}
function readSizes(p){
  const $p = sel => p.querySelector(sel), box = $p("#fPackBox");
  const main = $p("#fOuter").value, n = int($p("#fOuterN").value);
  if (!main || main === "__new" || !n) return { pp: 0, pc: 0, pn: "packet", cn: "carton", bad: !!main && main !== "__new" && !n, empty: true };
  if (box.dataset.slot === "pkt") return { pp: n, pc: 0, pn: main, cn: "carton" };
  // keep an older second pack size (used by packet barcodes) when the carton stays
  return { pc: n, cn: main, pp: int(box.dataset.keeppp), pn: box.dataset.keeppn || "packet" };
}
function wirePacking(p, getUnit, after = () => {}, { ownUnit = false } = {}){
  const $p = sel => p.querySelector(sel);
  let newFor = null;
  const prev = { fOuter: $p("#fOuter").value, fUnit: $p("#fUnit").value };
  const update = () => {
    const u = getUnit(), main = $p("#fOuter").value, n = int($p("#fOuterN").value), h = $p("#fSizeHint");
    $p("#fOuterN").disabled = !main || $p("#fPackBox").classList.contains("locked");
    h.classList.toggle("bad", !!main && !n);
    h.innerHTML = !main ? `No pack: counted in single <b>${esc(u)}</b> only.`
      : !n ? `Enter how many ${esc(u)} are in 1 ${esc(main)}.`
      : `1 ${esc(main)} = <b>${n} ${esc(u)}</b>`;
    after(readSizes(p));
  };
  const showNew = (el, ph) => { newFor = el; $p("#fPkNew").hidden = false; $p("#fPkNewVal").value = ""; $p("#fPkNewVal").placeholder = ph; $p("#fPkNewVal").focus(); };
  $p("#fOuter").addEventListener("change", e => {
    const el = e.target;
    if (el.value !== "__new") { prev.fOuter = el.value; if (el.value) $p("#fOuterN").focus(); return update(); }
    el.value = prev.fOuter; showNew(el, "New pack name, e.g. Crate");
  });
  if (ownUnit) $p("#fUnit").addEventListener("change", e => {
    const el = e.target;
    if (el.value !== "__new") { prev.fUnit = el.value; return update(); }
    el.value = prev.fUnit; showNew(el, "New single unit, e.g. cans");
  });
  const addNew = async () => {
    const v = $p("#fPkNewVal").value.trim().replace(/\s+/g, " "); if (!v || !newFor) return;
    const el = newFor, isUnit = el.id === "fUnit", val = isUnit ? v : v.toLowerCase();
    if (![...el.options].some(o => o.value.toLowerCase() === val.toLowerCase()))
      el.querySelector('option[value="__new"]').insertAdjacentHTML("beforebegin", `<option value="${esc(val)}">${esc(isUnit ? v : cap(v))}</option>`);
    el.value = [...el.options].find(o => o.value.toLowerCase() === val.toLowerCase()).value;
    prev[el.id] = el.value; $p("#fPkNew").hidden = true; newFor = null;
    el.dispatchEvent(new Event("change"));
    if (await addToList(isUnit ? "units" : "packings", isUnit ? v : cap(v))) toast(`Added “${v}” to the list`);
  };
  $p("#fPkNewAdd").addEventListener("click", addNew);
  $p("#fPkNewVal").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addNew(); } if (e.key === "Escape") { e.stopPropagation(); $p("#fPkNew").hidden = true; } });
  $p("#fPkNewCancel").addEventListener("click", () => { $p("#fPkNew").hidden = true; newFor = null; });
  $p("#fOuterN").addEventListener("input", update);
  update();
  return { update };
}

/* set the units from inside Stock in (admins), without leaving it */
function packSetup(it, onDone){
  openSheet(`<h3>Units for ${esc(it.name)}</h3>
    <p class="hint">Choose the main pack and how many single units are in it, e.g. 1 Carton = 24 cans.</p>
    <form id="fPackOnly" novalidate class="pack-only">
      ${sizeFields(it)}
      <div class="err" id="psErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, p => {
    const unitNow = () => { const v = p.querySelector("#fUnit").value; return v && v !== "__new" ? v : "pcs"; };
    const pk = wirePacking(p, unitNow, () => {}, { ownUnit: true });
    p.querySelector("#fUnit").addEventListener("change", pk.update);
    p.querySelector("#fPackOnly").addEventListener("submit", async e => {
      e.preventDefault();
      const s = readSizes(p);
      if (s.bad) return p.querySelector("#psErr").textContent = `Enter how many ${unitNow()} are in 1 ${p.querySelector("#fOuter").value}.`;
      const updated = { ...it, unit: unitNow(), perPacket: s.pp, perCarton: s.pc, packName: s.pn, cartonName: s.cn, updatedAt: Date.now() };
      Object.assign(it, updated);
      closeSheet(2, true);
      try { await putItem(updated); const m = mainPack(it); toast(m ? `Saved: 1 ${m.name} = ${m.n} ${U(it)}` : `Saved: counted in ${U(it)}`); } catch (_) {}
      onDone && onDone(it);
    });
  }, { layer: 2 });
}

function codeFields(it){
  const n = codesOf(it).length;
  return `<details class="packing" id="fCodesBox" ${n || it._codes ? "open" : ""}>
    <summary>Barcodes <span class="hint">(optional) · <span id="fCodesN">${n || "none"}</span></span></summary>
    <div id="fCodes" class="codes-edit"></div>
    <div class="codes-add">
      <button type="button" class="btn scan-btn" id="fCodeScan">${BARCODE_ICON}<span>Scan barcode</span></button>
      <button type="button" class="btn" id="fCodeType">Type barcode</button>
    </div>
    <p class="hint">Add one barcode for each brand or pack size. A packet or carton barcode adds a whole packet or carton.</p>
  </details>`;
}
/* the editable list of barcodes inside the item form */
function codesEditor(p, startCodes, getUnitNow, getSizes = () => ({ pn: "packet", cn: "carton" })){
  let list = startCodes.map(c => ({ ...c }));
  const box = p.querySelector("#fCodes");
  const draw = () => {
    p.querySelector("#fCodesN").textContent = list.length || "none";
    box.innerHTML = list.length ? list.map((c, i) => `
      <div class="code-row" data-i="${i}">
        <div class="code-top"><input class="code-val" data-k="code" value="${esc(c.code)}" aria-label="Barcode" spellcheck="false" autocomplete="off" inputmode="text">
          <button type="button" class="btn ghost sm" data-rm="${i}" aria-label="Remove barcode ${esc(c.code)}">✕</button></div>
        <div class="code-opts">
          <select data-k="per" aria-label="One scan is a">${PER_OPTS.map(([v, l]) => `<option value="${v}" ${c.per===v?"selected":""}>${v === "pkt" ? cap(getSizes().pn) : v === "ctn" ? cap(getSizes().cn) : l}</option>`).join("")}</select>
          <input data-k="n" type="number" min="2" step="1" inputmode="numeric" value="${c.n||""}" placeholder="qty" aria-label="Units per scan" ${c.per==="n"?"":"hidden"}>
          <input data-k="brand" value="${esc(c.brand||"")}" maxlength="40" placeholder="Brand (optional)" aria-label="Brand">
        </div>
      </div>`).join("") : `<p class="hint none-yet">No barcodes yet.</p>`;
  };
  box.addEventListener("input", e => {
    const row = e.target.closest(".code-row"), k = e.target.dataset.k; if (!row || !k) return;
    const c = list[+row.dataset.i];
    c[k] = k === "n" ? int(e.target.value) : e.target.value;
    if (k === "per") { row.querySelector('[data-k="n"]').hidden = c.per !== "n"; if (c.per === "n") row.querySelector('[data-k="n"]').focus(); }
  });
  box.addEventListener("change", e => box.dispatchEvent(new Event("input", { bubbles: true })) );
  box.addEventListener("click", e => { const r = e.target.closest("[data-rm]"); if (r) { list.splice(+r.dataset.rm, 1); draw(); } });
  const add = code => {
    const v = String(code).trim(); if (!v) return { ok: false, text: "Empty barcode" };
    if (list.some(c => normCode(c.code) === normCode(v))) return { ok: false, text: `${v} is already on this item` };
    list.push({ code: v, per: "pcs", brand: "" }); draw();
    p.querySelector("#fCodesBox").open = true;
    return { ok: true, text: `Added ${v}` };
  };
  p.querySelector("#fCodeScan").addEventListener("click", () =>
    openScanner(code => { const r = add(code); return { ...r, close: r.ok }; }, { title: "Scan a barcode for this item" }));
  p.querySelector("#fCodeType").addEventListener("click", () => {
    list.push({ code: "", per: "pcs", brand: "" }); draw();
    p.querySelector("#fCodesBox").open = true;
    box.querySelector(".code-row:last-child .code-val")?.focus();
  });
  draw();
  return { get: () => list.map(c => ({ code: String(c.code||"").trim(), per: c.per || "pcs", ...(c.per === "n" ? { n: int(c.n) } : {}), ...(c.brand?.trim() ? { brand: c.brand.trim() } : {}) })).filter(c => c.code) };
}

function itemForm(it, preset, { layer = 1, onSaved = null } = {}){
  const isNew = !it;
  it = it || { name: preset?.name || "", category: preset?.cat || (lists.categories.includes(ui.cat) ? ui.cat : (lists.categories[0] || "Other")),
               unit: lists.units[0] || "pcs", qty:0, min:0, place:"" };
  if (preset?.code) it = { ...it, _codes: true, codes: [{ code: preset.code, per: preset.per || "pcs" }] };
  openSheet(`<h3>${isNew ? "New item" : "Edit item"}</h3>
    <form id="fItem" novalidate>
      <div class="field"><label for="fName">Item name</label><input id="fName" maxlength="80" value="${esc(it.name)}" placeholder="e.g. Highball glass" autocomplete="off"></div>
      ${isNew && QUICK_PICKS.some(([n, c]) => !preset?.cat || c === preset.cat) ? `<div class="picks small" id="fPicks">${QUICK_PICKS.filter(([n, c]) => !preset?.cat || c === preset.cat).map(([n,c]) => `<button type="button" class="chip" data-name="${esc(n)}" data-cat="${esc(c)}">${esc(n)}</button>`).join("")}</div>` : ""}
      <div class="grid2">
        <div class="field"><label for="fCat">Category</label><select id="fCat" data-list="categories" data-word="category">${options(withCurrent(lists.categories, it.category), it.category)}${NEW_OPT}</select></div>
        <div class="field"><label for="fPlace">Kept at <span class="opt">optional</span></label><input id="fPlace" maxlength="60" value="${esc(it.place||"")}" placeholder="e.g. Bar shelf B" list="placesList" autocomplete="off">${datalist("placesList", lists.places)}</div>
      </div>
      ${sizeFields(it, { locked: !isNew && !amAdmin })}
      <div class="add-new-row" id="fNewRow" hidden>
        <input id="fNewVal" maxlength="40" autocomplete="off" aria-label="New entry">
        <button class="btn sm primary" type="button" id="fNewAdd">Add</button>
        <button class="btn sm" type="button" id="fNewCancel">Cancel</button>
      </div>
      <label class="remember fast-opt" for="fFast"><input type="checkbox" id="fFast" ${it.fast ? "checked" : ""}> <span><b>Fast-moving item</b> (e.g. water). Show it in Daily count and Quick use.</span></label>
      ${codeFields(it)}
      ${isNew ? `<fieldset class="qbox-wrap"><legend>How many do you have now?</legend><div class="qbox" id="fQty"></div></fieldset>`
              : `<p class="hint">Current stock: <b>${shown(it)} ${esc(U(it))}</b>. To change it, use Stock in / Stock out, or the − / + count fix.</p>`}
      <div class="field"><label for="fMin">Warn me when stock falls to <span class="opt" id="fMinU">${esc(U(it))}</span></label><input id="fMin" type="number" inputmode="numeric" min="0" step="1" value="${+it.min||""}" placeholder="e.g. 24"><p class="hint" id="fMinHint"></p></div>
      <div class="err" id="fErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? "Add item" : "Save changes"}</button></div>
    </form>`, p => {
    const getS = () => readSizes(p);
    const unitNow = () => { const v = p.querySelector("#fUnit").value; return v && v !== "__new" ? v : "pcs"; };
    /* "＋ Add new…" in Category / Counted in */
    let newFor = null;
    const prev = { fCat: p.querySelector("#fCat").value, fUnit: p.querySelector("#fUnit").value };
    ["#fCat","#fUnit"].forEach(sel => p.querySelector(sel).addEventListener("change", e => {
      const el = e.target;
      if (el.value !== "__new") { prev[el.id] = el.value; return; }
      el.value = prev[el.id];
      newFor = el;
      const row = p.querySelector("#fNewRow"), inp = p.querySelector("#fNewVal");
      row.hidden = false; inp.value = "";
      inp.placeholder = el.id === "fCat" ? "New category, e.g. Bar tools" : "New unit, e.g. pairs";
      inp.focus();
    }));
    const addNew = async () => {
      const inp = p.querySelector("#fNewVal"), v = inp.value.trim().replace(/\s+/g, " ");
      if (!v || !newFor) return;
      const el = newFor;
      const exists = [...el.options].find(o => o.value.toLowerCase() === v.toLowerCase() && o.value !== "__new");
      if (!exists) el.querySelector('option[value="__new"]').insertAdjacentHTML("beforebegin", `<option value="${esc(v)}">${esc(v)}</option>`);
      el.value = exists ? exists.value : v; prev[el.id] = el.value;
      p.querySelector("#fNewRow").hidden = true; newFor = null;
      el.dispatchEvent(new Event("change"));
      if (!exists) {
        const saved = await addToList(el.dataset.list, v);
        toast(saved ? `Added “${v}” to the ${el.dataset.word} list` : `Using “${v}” for this item. An admin can add it to the list.`);
      }
    };
    p.querySelector("#fNewAdd").addEventListener("click", addNew);
    p.querySelector("#fNewVal").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addNew(); } if (e.key === "Escape") { e.stopPropagation(); p.querySelector("#fNewCancel").click(); } });
    p.querySelector("#fNewCancel").addEventListener("click", () => { p.querySelector("#fNewRow").hidden = true; newFor = null; });
    const qb = isNew ? qtyBox(p.querySelector("#fQty"), getS, 0, t => `Total <b>${t} ${esc(unitNow())}</b>`, unitNow) : null;
    const minHint = () => {
      const m = int(p.querySelector("#fMin").value), s = getS();
      p.querySelector("#fMinU").textContent = unitNow();
      p.querySelector("#fMinHint").textContent = m && (s.pp || s.pc) ? `= ${packText(m, s, unitNow())}` : "Shows a Low alert at this level.";
    };
    const packing = wirePacking(p, unitNow, () => { qb?.redraw(); minHint(); });
    p.querySelector("#fUnit").addEventListener("change", packing.update);
    const lockedUnits = !isNew && !amAdmin;
    p.querySelector("#fMin").addEventListener("input", minHint);
    p.querySelector("#fPicks")?.addEventListener("click", e => {
      const c = e.target.closest("[data-name]"); if (!c) return;
      p.querySelector("#fName").value = c.dataset.name; p.querySelector("#fCat").value = c.dataset.cat; p.querySelector("#fCat").dispatchEvent(new Event("change"));
      p.querySelectorAll("#fPicks .chip").forEach(x => x.setAttribute("aria-pressed", x === c));
    });
    const ce = codesEditor(p, codesOf(it), unitNow, getS);
    if (!it.name) p.querySelector("#fName").focus();

    p.querySelector("#fItem").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#fErr");
      const name = p.querySelector("#fName").value.trim();
      const s = getS(), qty = qb ? qb.total() : (+it.qty||0), min = int(p.querySelector("#fMin").value);
      if (!name) { p.querySelector("#fName").focus(); return err.textContent = "Give the item a name."; }
      if (s.bad && !lockedUnits) return err.textContent = `Units: enter how many ${unitNow()} are in 1 ${p.querySelector("#fOuter").value}.`;
      if (items.some(x => x.name.toLowerCase() === name.toLowerCase() && (isNew || x.id !== it.id))) return err.textContent = `“${name}” is already in your list.`;
      const codes = ce.get();
      const filled = codes.map(c => normCode(c.code));
      if (new Set(filled).size !== filled.length) return err.textContent = "The same barcode is in the list twice.";
      for (const c of codes) {
        const owner = findByCode(c.code);
        if (owner && owner.it.id !== it.id) return err.textContent = `Barcode ${c.code} already belongs to ${owner.it.name}. Use Merge if they are the same product.`;
        if (c.per === "n" && int(c.n) < 2) return err.textContent = `Enter how many ${unitNow()} barcode ${c.code} counts as.`;
        if (c.per === "pkt" && !s.pp) return err.textContent = `Barcode ${c.code} is set as a packet. Enter the qty in 1 packet under Packing, or choose “Other qty”.`;
        if (c.per === "ctn" && !s.pc) return err.textContent = `Barcode ${c.code} is set as a carton. Enter what 1 carton holds under Packing, or choose “Other qty”.`;
      }
      const base = { name, category: p.querySelector("#fCat").value, unit: unitNow(), min, place: p.querySelector("#fPlace").value.trim(),
                     perPacket: s.pp, perCarton: s.pc, packName: s.pn, cartonName: s.cn, codes, fast: p.querySelector("#fFast").checked };
      if (lockedUnits) for (const k of UNIT_KEYS) { if (k in it) base[k] = it[k]; else delete base[k]; }   // staff can't change units
      closeSheet(layer, true);
      try {
        let saved;
        if (isNew) {
          const id = uid("i");
          saved = { id, ...stripLegacy(base), qty, createdAt: Date.now(), updatedAt: Date.now() };
          items.push(saved);
          await putItem(saved);
          if (qty > 0) await addMove({ id: uid("m"), itemId: id, name, unit: base.unit, type: "received", qty, before: 0, after: qty, note: "Opening stock", party: "", by: auth.currentUser?.email || "", at: Date.now() });
          toast(`Added ${name}`);
        } else {
          saved = { ...stripLegacy(it), ...base, updatedAt: Date.now() };
          await putItem(saved);
          toast("Saved");
        }
        onSaved && onSaved(saved);
      } catch (e) {}
    });
  }, { layer });
}

/* ---------- item details ---------- */
function itemDetail(id, { code = null } = {}){
  const it = items.find(x => x.id === id); if (!it) return;
  const st = status(it), hist = moves.filter(m => m.itemId === id).slice(0, 8), s = sizes(it), codes = codesOf(it);
  openSheet(`<h3>${esc(it.name)}</h3>
    <div class="big"><b class="num">${shown(it)}</b><span>${esc(U(it))}</span><span class="pill ${st}">${statusLabel(st)}</span></div>
    ${s.pp || s.pc ? `<p class="pack big-pack">${esc(packText(shown(it), s, U(it)))}</p>` : ""}
    <div class="inout">
      <button class="btn act in" type="button" data-quick="in"><span aria-hidden="true">↓</span>Stock in</button>
      <button class="btn act out" type="button" data-quick="out"><span aria-hidden="true">↑</span>Stock out</button>
    </div>
    <p class="hint">${esc(it.category)} · warn at ${+it.min||0} ${esc(U(it))}${it.place ? ` · kept at ${esc(it.place)}` : ""}${s.pp||s.pc ? `<br>${esc(sizeText(s, U(it)))}` : ""}</p>
    <div class="codes">${codes.map(c => `<span class="code">${BARCODE_ICON}${esc(c.code)} <small>${esc(codeLabel(c, it))}${c.brand ? ` · ${esc(c.brand)}` : ""}</small></span>`).join("")}
      <button type="button" class="btn sm scan-btn" id="addCodeBtn">${BARCODE_ICON}<span>${codes.length ? "Add another barcode" : "Add barcode"}</span></button></div>
    <h2 style="font-size:1rem">History</h2>
    ${hist.length ? `<ul class="mini-feed">${hist.map(m => moveLi(m,false)).join("")}</ul>` : `<p class="hint">No changes recorded yet.</p>`}
    <div class="actions"><button class="btn danger" type="button" id="delBtn">Delete</button><button class="btn" type="button" id="mergeBtn">Merge…</button><button class="btn" type="button" id="editBtn">Edit details</button></div>`,
  p => {
    p.querySelectorAll("[data-quick]").forEach(b => b.addEventListener("click", () => quickEntry(it, b.dataset.quick, { code })));
    p.querySelector("#editBtn").addEventListener("click", () => itemForm(it));
    p.querySelector("#delBtn").addEventListener("click", () => confirmDelete(it));
    p.querySelector("#mergeBtn").addEventListener("click", () => mergeSheet(it));
    p.querySelector("#addCodeBtn").addEventListener("click", () => {
      openScanner(code => {
        const owner = findByCode(code);
        if (owner && owner.it.id === it.id) return { ok: false, text: `${code} is already on ${it.name}` };
        if (owner) return { ok: false, text: `${code} belongs to ${owner.it.name}. Use Merge if they are the same product.` };
        const c = { code, per: scanLevel(it) };
        addCodeToItem(it, c).then(() => { toast(`Barcode added to ${it.name}`); itemDetail(it.id); }).catch(() => {});
        return { ok: true, text: `Saved: ${codeLabel(c, it)} barcode`, close: true };
      }, { title: `Add barcode · ${it.name}`, level: it });
    });
  });
}

/* ---------- quick entry: one product, stock in or out, any counting method ---------- */
function countMethods(it){
  const s = sizes(it), u = U(it), out = [];
  out.push({ id: "pcs", label: u === "pcs" ? "Pieces" : cap(u), n: 1 });
  if (s.pp) out.push({ id: "pkt", label: cap(pl(2, s.pn)), n: s.pp });
  if (s.pc) out.push({ id: "ctn", label: cap(pl(2, s.cn)), n: s.pc });
  return out;
}
function quickEntry(it, mode = "in", { code = null } = {}){
  const methods = countMethods(it), u = U(it);
  // start with the way the scanned barcode counts (e.g. carton), else a sensible default
  let method = (code && methods.find(m => m.id === (code.per === "n" ? "n" + int(code.n) : code.per))) ||
               (mode === "in" ? [...methods].filter(m => m.id !== "dz").pop() : methods[0]);
  let outType = "used";
  openSheet(`
    <h3>${esc(it.name)}</h3>
    <p class="hint qe-have"></p>
    <div class="seg two mode" role="radiogroup" aria-label="Stock in or out">
      <input type="radio" name="qMode" id="qm-in" value="in" ${mode==="in"?"checked":""}><label for="qm-in" class="in">↓ Stock in</label>
      <input type="radio" name="qMode" id="qm-out" value="out" ${mode==="out"?"checked":""}><label for="qm-out" class="out">↑ Stock out</label>
    </div>
    <div class="seg three" id="qOut" role="radiogroup" aria-label="Type of stock out">
      ${Object.entries(OUT_TYPES).map(([k, t], i) => `<input type="radio" name="qOutT" id="qo-${k}" value="${k}" ${i===0?"checked":""}><label for="qo-${k}" class="${k}">${t.label}</label>`).join("")}
    </div>
    <form id="fQuick" novalidate class="qe">
      <label class="qe-lab" for="qNum">How many?</label>
      <div class="qe-num">
        <button type="button" class="step big" data-q="-1" aria-label="One less">−</button>
        <input id="qNum" type="number" inputmode="numeric" min="0" step="1" value="1" aria-label="How many">
        <button type="button" class="step big" data-q="1" aria-label="One more">+</button>
      </div>
      <div class="qe-lab qe-lab-row"><span>Counted in</span>${amAdmin ? `<button type="button" class="link" id="qPack">${mainPack(it) ? "Change units" : "Comes in cartons or boxes? Set units"}</button>` : ""}</div>
      <div class="qe-methods" role="radiogroup" aria-label="Counted in">
        ${methods.map(m => `<input type="radio" name="qMeth" id="qx-${m.id}" value="${m.id}" ${m.id===method.id?"checked":""}><label for="qx-${m.id}"><b>${esc(m.label)}</b>${m.n > 1 ? `<small>${m.n} ${esc(u)}${m.brand ? ` · ${esc(m.brand)}` : ""}</small>` : ""}</label>`).join("")}
      </div>
      <div class="qe-total" aria-live="polite"></div>
      <div class="field" id="qPartyBox"></div>
      <div class="field"><label for="qNote">Note <span class="opt">optional</span></label><input id="qNote" maxlength="120"></div>
      <div class="err" id="qErr" role="alert"></div>
      <div class="actions">
        <button type="button" class="btn" id="qMore" title="Add more products to this entry">＋ More items</button>
        <button class="btn primary big-save" type="submit" id="qSave">Save</button>
      </div>
    </form>`, p => {
    const num = p.querySelector("#qNum");
    const isOut = () => p.querySelector("input[name=qMode]:checked").value === "out";
    const type = () => isOut() ? outType : "received";
    const total = () => int(num.value) * method.n;
    const drawParty = () => {
      const [label, key, ph] = isOut() ? OUT_TYPES[outType].party : ["Supplier", "suppliers", "e.g. ABC Crockery Traders"];
      const arr = lists[key] || [], box = p.querySelector("#qPartyBox"), keep = box.querySelector("input")?.value || "";
      box.innerHTML = `<label for="qParty">${label} <span class="opt">optional</span></label>
        <input id="qParty" maxlength="60" list="qPartyList" autocomplete="off" placeholder="${esc(ph)}" value="${esc(keep)}">${datalist("qPartyList", arr)}
        ${arr.length ? `<div class="picks small">${arr.map(v => `<button type="button" class="chip" data-party="${esc(v)}" aria-pressed="${v===keep}">${esc(v)}</button>`).join("")}</div>` : ""}`;
    };
    const update = () => {
      const cur = shown(items.find(x => x.id === it.id) || it), t = total(), out = isOut();
      p.classList.toggle("is-out", out);
      p.querySelector("#qOut").hidden = !out;
      p.querySelector(".qe-have").textContent = `${cur} ${u} in stock${packText(cur, sizes(it), u) ? " · " + packText(cur, sizes(it), u) : ""}`;
      const after = out ? cur - t : cur + t, k = int(num.value);
      p.querySelector(".qe-total").innerHTML = !k ? `<span class="muted">Enter how many</span>`
        : after < 0 ? `<span class="bad">Only ${cur} ${esc(u)} in stock</span>`
        : `${method.n > 1 ? `${k} ${esc(method.label.toLowerCase())} = ` : ""}<b>${out ? "−" : "+"}${t} ${esc(u)}</b> → stock becomes <b>${after} ${esc(u)}</b>`;
      const save = p.querySelector("#qSave");
      save.textContent = out ? `Save ${OUT_TYPES[outType].label.toLowerCase()}` : "Save stock in";
      save.disabled = !k || after < 0;
    };
    p.querySelectorAll("input[name=qMode]").forEach(r => r.addEventListener("change", () => { drawParty(); update(); }));
    p.querySelectorAll("input[name=qOutT]").forEach(r => r.addEventListener("change", () => { outType = r.value; drawParty(); update(); }));
    p.querySelectorAll("input[name=qMeth]").forEach(r => r.addEventListener("change", () => { method = methods.find(m => m.id === r.value); update(); num.focus(); num.select(); }));
    num.addEventListener("input", update);
    p.querySelector("#qPack")?.addEventListener("click", () => {
      const keep = { n: int(num.value), mode: isOut() ? "out" : "in" };
      packSetup(it, fresh => {
        // re-open with the new pack choices; start on the big pack for stock in
        const z = sizes(fresh), per = keep.mode === "in" ? (z.pc ? "ctn" : z.pp ? "pkt" : "pcs") : "pcs";
        quickEntry(fresh, keep.mode, { code: { per } });
      });
    });
    p.querySelectorAll("[data-q]").forEach(b => b.addEventListener("click", () => { num.value = Math.max(0, int(num.value) + +b.dataset.q); update(); }));
    p.addEventListener("click", e => {
      const c = e.target.closest("[data-party]"); if (!c) return;
      p.querySelector("#qParty").value = c.dataset.party;
      p.querySelectorAll("[data-party]").forEach(x => x.setAttribute("aria-pressed", x === c));
    });
    /* add more products: carry this one over into the multi-item list */
    p.querySelector("#qMore").addEventListener("click", () => {
      const t = total(), out = isOut(), ot = outType, k = int(num.value), m = method;
      openCart(out ? "out" : "in", { itemId: it.id });
      if (cart) {
        if (out) { const r = cart.p.querySelector(`#co-${ot}`); if (r) { r.checked = true; r.dispatchEvent(new Event("change")); } }
        const line = cart.lines.find(l => l.id === it.id);
        if (line && k) { if (m.id === "ctn" || m.id === "pkt") line.qb.add(m.id, k); else line.qb.add("pcs", t); }
        cart.p.querySelector("#cFind")?.focus();
      }
    });
    p.querySelector("#fQuick").addEventListener("submit", async e => {
      e.preventDefault();
      const t = total(), tp = type(), cur = shown(items.find(x => x.id === it.id) || it);
      if (!t) return p.querySelector("#qErr").textContent = "Enter how many.";
      if (tp !== "received" && t > cur) return p.querySelector("#qErr").textContent = `Only ${cur} ${u} in stock.`;
      const party = p.querySelector("#qParty")?.value.trim() || "", note = p.querySelector("#qNote").value.trim();
      closeSheet(1, true);
      await commitNudge(it.id);
      try {
        const r = await applyMove(it.id, tp, t, note, { party });
        const label = tp === "received" ? "Stock in" : OUT_TYPES[tp].label;
        if (r && r.after !== r.before) toast(`${label}: ${t} ${u} · ${it.name}`, { action: "Undo", onAction: async () => {
          await applyMove(it.id, "count", r.before - r.after, "Undo"); toast("Undone");
        }});
      } catch (_) {}
    });
    drawParty(); update();
    setTimeout(() => { num.focus(); num.select(); }, 60);
  });
}

/* ---------- merge two items (e.g. the same product from another brand) ---------- */
function mergeSheet(src){
  const others = items.filter(x => x.id !== src.id);
  if (!others.length) return toast("There's no other item to merge with.");
  const sc = codesOf(src);
  openSheet(`<h3>Merge “${esc(src.name)}”</h3>
    <p class="hint">Use this when the same product was added twice, for example a second brand with its own barcode.</p>
    <div class="field"><label for="mgTo">Merge into</label>
      <select id="mgTo"><option value="">Choose the item to keep…</option>${itemOptions("").replace(`<option value="${src.id}"`, `<option disabled value="${src.id}"`)}</select></div>
    <div id="mgPrev" class="merge-prev" hidden></div>
    <div class="err" id="mgErr" role="alert"></div>
    <div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="mgGo" disabled>Merge</button></div>`,
  p => {
    const sel = p.querySelector("#mgTo"), prev = p.querySelector("#mgPrev"), go = p.querySelector("#mgGo"), err = p.querySelector("#mgErr");
    sel.addEventListener("change", () => {
      const tgt = items.find(x => x.id === sel.value); err.textContent = "";
      if (!tgt) { prev.hidden = true; go.disabled = true; return; }
      if (U(tgt) !== U(src)) { prev.hidden = true; go.disabled = true; return err.textContent = `${src.name} is counted in ${U(src)} but ${tgt.name} in ${U(tgt)}. Change one of them first (Edit details).`; }
      prev.hidden = false; go.disabled = false;
      prev.innerHTML = `<ul>
        <li><b>${esc(tgt.name)}</b> stock: ${shown(tgt)} → <b>${shown(tgt) + shown(src)} ${esc(U(tgt))}</b></li>
        <li>${sc.length ? `${plural(sc.length, "barcode", "barcodes")} move to ${esc(tgt.name)} (brand “${esc(src.name)}” unless set)` : "No barcodes to move"}</li>
        <li>History stays in the activity log</li>
        <li><b>${esc(src.name)}</b> is removed</li></ul>`;
      go.textContent = `Merge into ${tgt.name}`;
    });
    go.addEventListener("click", async () => {
      const tgt = items.find(x => x.id === sel.value); if (!tgt) return;
      go.disabled = true; go.textContent = "Merging…";
      try { await mergeItems(src, tgt); closeSheet(1, true); toast(`Merged into ${tgt.name}`); itemDetail(tgt.id); }
      catch (_) { go.disabled = false; go.textContent = "Merge"; err.textContent = "Couldn't merge. Check your connection and try again."; }
    });
  });
}
async function mergeItems(src, tgt){
  await commitNudge(src.id); await commitNudge(tgt.id);
  const sS = rawSizes(src), tS = rawSizes(tgt);
  const have = codesOf(tgt).map(c => normCode(c.code));
  // keep each moved barcode counting the same number of units it did before
  const moved = codesOf(src).filter(c => !have.includes(normCode(c.code))).map(c => {
    const units = codeUnits(c, src);
    let per = c.per;
    if ((per === "pkt" && sS.pp !== tS.pp) || (per === "ctn" && sS.pc !== tS.pc)) per = "n";
    const out = { code: c.code, per: per === "n" && units === 1 ? "pcs" : per, brand: c.brand || src.name };
    if (out.per === "n") out.n = units;
    return out;
  });
  const updated = { ...stripLegacy(tgt), codes: [...codesOf(tgt), ...moved], updatedAt: Date.now() };
  Object.assign(tgt, updated);
  await putItem(updated);
  const n = +src.qty || 0, by = auth.currentUser?.email || "", at = Date.now();
  if (n) await applyMove(tgt.id, "count", n, `Merged from ${src.name}`);
  if (n) await addMove({ id: uid("m"), itemId: src.id, name: src.name, unit: U(src), type: "count", qty: -n, before: n, after: 0, note: `Merged into ${tgt.name}`, party: "", by, at });
  await removeItem(src.id);
}

function confirmDelete(it){
  openSheet(`<h3>Delete ${esc(it.name)}?</h3>
    <p>This removes the item from your stock list. Its past activity stays in the log.</p>
    <div class="actions"><button class="btn" type="button" data-close>Keep it</button><button class="btn danger solid" type="button" id="yesDel">Delete item</button></div>`,
  p => p.querySelector("#yesDel").addEventListener("click", async () => {
    closeSheet(1, true);
    try { await removeItem(it.id); toast(`Deleted ${it.name}`); } catch (e) {}
  }));
}

/* ---------- unknown barcode: create a new item or link to an existing one ---------- */
function unknownCode(code, { layer = 1, onResolved = null } = {}){
  openSheet(`<h3>New barcode</h3>
    <p>No item has barcode <b class="num">${esc(code)}</b> yet.</p>
    <div class="choice">
      <button class="btn primary" type="button" id="ucNew">＋ Create a new item with this barcode</button>
    </div>
    <div class="or"><span>or link it to an item you already have</span></div>
    <div class="field"><label for="ucItem">Item</label>
      <select id="ucItem"><option value="">Choose an item…</option>${itemOptions("")}</select></div>
    <div class="field"><label>This barcode is on a</label>
      <div class="seg three" role="radiogroup" aria-label="Barcode is on a">
        ${PER_OPTS.slice(0,3).map(([per, label], i) => `<input type="radio" name="ucPer" id="uc-${per}" value="${per}" ${i===0?"checked":""}><label for="uc-${per}">${label}</label>`).join("")}
      </div></div>
    <div class="field"><label for="ucBrand">Brand <span class="opt">optional</span></label><input id="ucBrand" maxlength="40" placeholder="e.g. Ocean, Luminarc"></div>
    <div class="err" id="ucErr" role="alert"></div>
    <div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn" type="button" id="ucLink">Link barcode</button></div>`,
  p => {
    p.querySelector("#ucNew").addEventListener("click", () => {
      const per = p.querySelector("input[name=ucPer]:checked").value;
      closeSheet(layer, true);
      itemForm(null, { code, per }, { layer, onSaved: it => onResolved && onResolved(it, codesOf(it).find(c => normCode(c.code) === normCode(code))) });
    });
    p.querySelector("#ucLink").addEventListener("click", async () => {
      const id = p.querySelector("#ucItem").value, per = p.querySelector("input[name=ucPer]:checked").value;
      const err = p.querySelector("#ucErr");
      if (!id) return err.textContent = "Choose the item this barcode belongs to.";
      const it = items.find(x => x.id === id), s = sizes(it);
      if (per === "pkt" && !s.pp) return err.textContent = `${it.name} has no packet size yet. Choose Piece, or set the packet size in Edit details first.`;
      if (per === "ctn" && !s.pc) return err.textContent = `${it.name} has no carton size yet. Choose Piece, or set the carton size in Edit details first.`;
      const brand = p.querySelector("#ucBrand").value.trim();
      const c = { code, per, ...(brand ? { brand } : {}) };
      closeSheet(layer, true);
      try {
        await addCodeToItem(it, c);
        toast(`Barcode linked to ${it.name}`);
        onResolved && onResolved(it, c);
      } catch (_) {}
    });
  }, { layer });
}

/* ---------- STOCK IN / STOCK OUT list ---------- */
const OUT_TYPES = {
  used:   { label: "Use",      help: "Used up in service, e.g. kitchen or café.",  party: ["Used at", "outlets", "e.g. Kitchen"] },
  issued: { label: "Issue",    help: "Sent to another outlet or an event.",        party: ["Issued to", "outlets", "e.g. Banquet hall"] },
  broken: { label: "Breakage", help: "Broken, chipped or lost. Written off.",       party: ["Reason", "reasons", "e.g. Dropped"] }
};
function itemOptions(sel){
  const groups = {};
  items.forEach(i => (groups[i.category] ||= []).push(i));
  const order = [...lists.categories.filter(c => groups[c]), ...Object.keys(groups).filter(c => !lists.categories.includes(c)).sort()];
  return order.map(c => `<optgroup label="${esc(c)}">${groups[c].sort(byName)
    .map(i => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${esc(i.name)} (${shown(i)} ${esc(U(i))})</option>`).join("")}</optgroup>`).join("");
}

let lineSeq = 0;
function openCart(mode = "in", { itemId = null, per = null, scan = false } = {}){
  if (!items.length && !scan) { toast("Add an item first."); return itemForm(); }
  closeSheet(2, true);
  cart = { mode, outType: "used", lines: [] };
  const pn = openSheet(`
    <div class="cart-head">
      <h3 id="cartTitle"></h3>
      <div class="seg two mode" role="radiogroup" aria-label="Stock in or out">
        <input type="radio" name="cMode" id="cm-in" value="in" ${mode==="in"?"checked":""}><label for="cm-in" class="in">↓ Stock in</label>
        <input type="radio" name="cMode" id="cm-out" value="out" ${mode==="out"?"checked":""}><label for="cm-out" class="out">↑ Stock out</label>
      </div>
      <div class="seg three" id="outTypes" role="radiogroup" aria-label="Type of stock out">
        ${Object.entries(OUT_TYPES).map(([k, t], i) => `<input type="radio" name="cOut" id="co-${k}" value="${k}" ${i===0?"checked":""}><label for="co-${k}" class="${k}">${t.label}</label>`).join("")}
      </div>
      <p class="hint" id="cartHelp"></p>
      <div class="finder">
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="cFind" type="search" placeholder="Search item or type barcode" autocomplete="off" aria-label="Search item or barcode" enterkeyhint="go">
        </div>
        <button type="button" class="btn primary scan-big" id="cScan">${BARCODE_ICON}<span>Scan</span></button>
      </div>
      <ul class="results" id="cResults" hidden></ul>
    </div>
    <div class="cart-body">
      <div id="cLines" class="lines"></div>
      <div class="cart-extra" id="cExtra" hidden>
        <div class="field" id="cPartyBox"></div>
        <div class="field"><label for="cNote">Note <span class="opt">optional</span></label><input id="cNote" maxlength="120"></div>
      </div>
    </div>
    <div class="cart-foot">
      <div class="err" id="cErr" role="alert"></div>
      <div class="discard" id="cDiscard" hidden><span>Discard this list?</span><button type="button" class="btn sm" id="cKeep">Keep editing</button><button type="button" class="btn sm danger solid" id="cDrop">Discard</button></div>
      <div class="foot-row"><span id="cSum" class="cart-sum"></span><button class="btn primary big-save" type="button" id="cSave" disabled>Save</button></div>
    </div>`, null, { full: true, guard: () => {
      if (!cart || !cart.lines.some(l => l.qb.total() > 0)) return false;
      $("#cDiscard").hidden = false; return true;
    }});
  cart.p = pn;

  const kind = () => cart.mode === "in" ? "received" : cart.outType;
  const partyCfg = () => cart.mode === "in" ? ["Supplier", "suppliers", "e.g. ABC Crockery Traders"] : OUT_TYPES[cart.outType].party;

  const drawParty = () => {
    const [label, key, ph] = partyCfg(), arr = lists[key] || [], box = pn.querySelector("#cPartyBox");
    const keep = box.querySelector("input")?.value || "";
    box.innerHTML = `<label for="cParty">${label} <span class="opt">optional</span></label>
      <input id="cParty" maxlength="60" list="cPartyList" autocomplete="off" placeholder="${esc(ph)}" value="${esc(keep)}">${datalist("cPartyList", arr)}
      ${arr.length ? `<div class="picks small">${arr.map(v => `<button type="button" class="chip" data-party="${esc(v)}" aria-pressed="${v===keep}">${esc(v)}</button>`).join("")}</div>` : ""}`;
  };
  const drawMode = () => {
    pn.classList.toggle("is-out", cart.mode === "out");
    pn.querySelector("#cartTitle").textContent = cart.mode === "in" ? "Stock in" : "Stock out";
    pn.querySelector("#outTypes").hidden = cart.mode !== "out";
    pn.querySelector("#cartHelp").textContent = cart.mode === "in" ? "New stock arrived. Scan or search each item, then enter how many cartons, boxes or pieces came." : OUT_TYPES[cart.outType].help;
    drawParty();
    cart.lines.forEach(l => l.qb.refresh());
    updateFoot();
  };
  const updateFoot = () => {
    const active = cart.lines.filter(l => l.qb.total() > 0);
    pn.querySelector("#cExtra").hidden = !cart.lines.length;
    pn.querySelector("#cSum").innerHTML = cart.lines.length
      ? `<b>${active.length}</b> of ${plural(cart.lines.length, "item", "items")} ready`
      : "No items yet";
    const save = pn.querySelector("#cSave");
    save.disabled = !active.length;
    save.textContent = cart.mode === "in" ? `Save stock in${active.length ? ` (${active.length})` : ""}` : `Save ${OUT_TYPES[cart.outType].label.toLowerCase()}${active.length ? ` (${active.length})` : ""}`;
    pn.querySelector("#cLines").querySelector(".cart-empty")?.remove();
    if (!cart.lines.length) pn.querySelector("#cLines").innerHTML = `<div class="cart-empty">${BARCODE_ICON}<p><b>Scan a barcode</b> or search above to add items.</p><p class="hint">With a handheld scanner, just scan. Items are added automatically.</p></div>`;
  };

  /* add an item to the list, or add to its line if it's already there */
  const addLine = (it, perLevel = null, n = 0, { fromScan = false } = {}) => {
    let line = cart.lines.find(l => l.id === it.id);
    if (!line) {
      pn.querySelector(".cart-empty")?.remove();
      const k = ++lineSeq, el = document.createElement("div");
      el.className = "cline"; el.dataset.id = it.id;
      el.innerHTML = `<div class="cl-head">
          <div class="cl-name"><b>${esc(it.name)}</b><span class="hint cl-have"></span></div>
          <button type="button" class="btn ghost rm" aria-label="Remove ${esc(it.name)} from list">✕</button>
        </div>
        <div class="qbox compact" id="cq-${k}"></div>
        <button type="button" class="link pack-link"></button>`;
      pn.querySelector("#cLines").prepend(el);
      line = { id: it.id, el };
      const live = () => items.find(x => x.id === it.id) || it, u = U(it);
      const packLink = () => { const mp = mainPack(live()), lk = el.querySelector(".pack-link"); lk.hidden = !amAdmin; lk.textContent = mp ? `1 ${mp.name} = ${mp.n} ${U(live())} · change` : "Comes in cartons or boxes? Set units"; };
      line.qb = qtyBox(el.querySelector(".qbox"), () => sizes(live()), 0, t => {
        const s = sizes(live());
        const cur = shown(live()), out = cart && cart.mode === "out";
        el.querySelector(".cl-have").textContent = `${cur} ${u} in stock${s.pp||s.pc ? ` · ${packText(cur, s, u)}` : ""}`;
        if (!t) return `<span class="muted">Enter how many</span>`;
        const after = out ? cur - t : cur + t;
        return after < 0 ? `<span class="bad">Only ${cur} ${esc(u)} in stock</span>`
                         : `${out ? "−" : "+"}<b>${t} ${esc(u)}</b> → stock <b>${after}</b>`;
      }, () => u, { smallFirst: cart.mode === "out" });
      packLink();
      el.querySelector(".pack-link").addEventListener("click", () => packSetup(live(), () => { line.qb.redraw(); packLink(); updateFoot(); el.querySelector(".cl-have").textContent = ""; line.qb.refresh(); }));
      el.querySelector(".rm").addEventListener("click", () => {
        el.remove(); cart.lines = cart.lines.filter(l => l !== line); updateFoot();
      });
      el.addEventListener("input", updateFoot);
      el.addEventListener("click", e => { if (e.target.closest("[data-d]")) updateFoot(); });
      cart.lines.push(line);
    } else if (!fromScan) {
      pn.querySelector("#cLines").prepend(line.el);
    }
    if (n) line.qb.add(perLevel || "pcs", n);
    line.el.classList.remove("flash"); void line.el.offsetWidth; line.el.classList.add("flash");
    if (!fromScan) { line.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); if (!n) line.qb.focusFirst(); }
    updateFoot();
    return line;
  };
  cart.addLine = addLine;

  /* search / type a barcode */
  const find = pn.querySelector("#cFind"), results = pn.querySelector("#cResults");
  const showResults = () => {
    const q = find.value.trim();
    if (!q) { results.hidden = true; results.innerHTML = ""; return; }
    const hit = findByCode(q);
    const list = (hit ? [hit.it] : items.filter(it => matches(it, q)).sort(byName)).slice(0, 8);
    results.hidden = false;
    results.innerHTML = list.length ? list.map((it, i) => `<li><button type="button" class="res ${i===0?"first":""}" data-pick="${it.id}">
        <span><b>${esc(it.name)}</b><small>${esc(it.category)}</small></span><span class="num">${shown(it)} ${esc(U(it))}</span></button></li>`).join("")
      : `<li class="none">No item matches “${esc(q)}”. <button type="button" class="link" data-newcode>${/^\w{4,}$/.test(q) ? "Use as a new barcode" : "Create a new item"}</button></li>`;
  };
  find.addEventListener("input", showResults);
  find.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = find.value.trim(); if (!q) return;
    const hit = findByCode(q);
    if (hit) { const line = addLine(hit.it, ...levelFor(hit.c, hit.it), { fromScan: true }); showLine(line); beep(true); find.value = ""; showResults(); return; }
    const first = results.querySelector("[data-pick]");
    if (first) first.click();
    else if (/^\w{4,}$/.test(q)) { beep(false); handleUnknown(q); }
  });
  results.addEventListener("click", e => {
    const b = e.target.closest("[data-pick]");
    if (b) { const it = items.find(x => x.id === b.dataset.pick); find.value = ""; showResults(); addLine(it); return; }
    if (e.target.closest("[data-newcode]")) {
      const q = find.value.trim(); find.value = ""; showResults();
      if (/^\w{4,}$/.test(q)) handleUnknown(q); else itemForm(null, { name: q }, { layer: 2, onSaved: it => addLine(it) });
    }
  });
  const handleUnknown = code => unknownCode(code, { layer: 2, onResolved: (it, c) => addLine(it, ...levelFor(c, it)) });

  /* camera scanning: after a scan, close the scanner and go straight to that product.
     With "Keep scanning" on, the scanner stays open for the next item. */
  pn.querySelector("#cScan").addEventListener("click", () => {
    const unknown = [];
    let goTo = null;
    openScanner(code => {
      const hit = findByCode(code);
      if (!hit) {
        if (!keepScanning()) { goTo = { unknown: code }; return { ok: false, text: `New barcode ${code}`, close: true }; }
        if (!unknown.includes(code)) unknown.push(code);
        return { ok: false, text: `Not found: ${code}. You can set it up after tapping Done.` };
      }
      const line = addLine(hit.it, ...levelFor(hit.c, hit.it), { fromScan: true });
      if (!keepScanning()) { goTo = { line }; return { ok: true, text: hit.it.name, close: true }; }
      return { ok: true, text: `+1 ${codeLabel(hit.c, hit.it)} · ${hit.it.name}${hit.c.brand ? ` (${hit.c.brand})` : ""} · ${line.qb.total()} ${U(hit.it)} in list` };
    }, { title: cart.mode === "in" ? "Scan item coming in" : "Scan item going out", multi: true, keepToggle: true,
         onClose: () => {
           if (goTo?.line) showLine(goTo.line);
           else if (goTo?.unknown) handleUnknown(goTo.unknown);
           else if (unknown.length) handleUnknown(unknown[0]);
         } });
  });
  /* bring a product line into view and highlight it */
  const showLine = line => {
    pn.querySelector("#cLines").prepend(line.el);
    pn.querySelector(".cart-body").scrollTo({ top: 0, behavior: "smooth" });
    line.el.classList.remove("flash", "picked"); void line.el.offsetWidth; line.el.classList.add("picked");
  };
  cart.showLine = showLine;

  pn.querySelectorAll("input[name=cMode]").forEach(r => r.addEventListener("change", () => { cart.mode = r.value; drawMode(); }));
  pn.querySelectorAll("input[name=cOut]").forEach(r => r.addEventListener("change", () => { cart.outType = r.value; drawMode(); }));
  pn.addEventListener("click", e => {
    const c = e.target.closest("[data-party]"); if (!c) return;
    pn.querySelector("#cParty").value = c.dataset.party;
    pn.querySelectorAll("[data-party]").forEach(x => x.setAttribute("aria-pressed", x === c));
  });
  pn.querySelector("#cKeep").addEventListener("click", () => pn.querySelector("#cDiscard").hidden = true);
  pn.querySelector("#cDrop").addEventListener("click", () => closeSheet(1, true));

  /* save everything */
  pn.querySelector("#cSave").addEventListener("click", async () => {
    const err = pn.querySelector("#cErr"); err.textContent = "";
    const active = cart.lines.filter(l => l.qb.total() > 0);
    if (!active.length) return err.textContent = "Enter a quantity for at least one item.";
    const type = kind();
    if (type !== "received") {
      const over = active.map(l => [items.find(x => x.id === l.id), l.qb.total()]).find(([it, n]) => n > shown(it));
      if (over) return err.textContent = `Only ${shown(over[0])} ${U(over[0])} of ${over[0].name} in stock.`;
    }
    const party = pn.querySelector("#cParty")?.value.trim() || "", note = pn.querySelector("#cNote").value.trim();
    const batch = uid("b"), done = [], label = type === "received" ? "Stock in" : OUT_TYPES[type].label;
    const totals = active.map(l => [l.id, l.qb.total()]);
    closeSheet(1, true);
    try {
      for (const [id, n] of totals) {
        await commitNudge(id);
        const r = await applyMove(id, type, n, note, { party, batch });
        if (r && r.after !== r.before) done.push({ id, ...r });
      }
    } catch (_) {}
    if (!done.length) return;
    const first = items.find(x => x.id === done[0].id);
    const msg = done.length === 1 ? `${label}: ${totals[0][1]} ${U(first)} · ${first.name}` : `${label}: ${done.length} items saved`;
    toast(msg, { action: "Undo", onAction: async () => {
      for (const r of [...done].reverse()) await applyMove(r.id, "count", r.before - r.after, "Undo");
      toast("Undone");
    }});
  });

  drawMode();
  if (itemId) { const it = items.find(x => x.id === itemId); if (it) addLine(it, per, per ? 1 : 0); }
  if (scan) pn.querySelector("#cScan").click();
  else if (!itemId) setTimeout(() => find.focus(), 50);
}

/* ---------- camera scanner (html5-qrcode, loaded on first use) ---------- */
const QR_URL = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
const BARCODE_ICON = `<svg class="bc" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>`;
let qr = null, scanCb = null, scanMulti = false, scanOnClose = null, scanSkip = null, lastCode = "", lastAt = 0, torchOn = false;
function loadScript(src){
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
}
async function loadQr(){ if (!window.Html5Qrcode) await loadScript(QR_URL); return window.Html5Qrcode; }
function qrFormats(){
  const F = window.Html5QrcodeSupportedFormats;   // fewer formats = faster, more reliable reading
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE];
}
function scanMsg(text, cls = ""){ const m = $("#scanMsg"); m.textContent = text; m.className = "scan-msg " + cls; }
function setScanTitle(t){ $("#scanTitle").textContent = t; }

/* Piece / Packet / Carton choice shown in the scanner when adding a barcode to an item */
function showLevelChoice(it){
  const box = $("#scanLevel");
  if (!it) { box.hidden = true; box.innerHTML = ""; return; }
  const s = sizes(it), opts = [["pcs", U(it) === "pcs" ? "Piece" : cap(U(it))]];
  if (s.pp) opts.push(["pkt", `${cap(s.pn)} (${s.pp})`]);
  if (s.pc) opts.push(["ctn", `${cap(s.cn)} (${s.pc})`]);
  box.hidden = opts.length < 2;
  box.className = `seg ${opts.length === 3 ? "three" : "two"} scan-level`;
  box.innerHTML = opts.map(([v, l], i) => `<input type="radio" name="scanLv" id="sl-${v}" value="${v}" ${i===0?"checked":""}><label for="sl-${v}">${l}</label>`).join("");
}
const scanLevel = () => document.querySelector('input[name="scanLv"]:checked')?.value || "pcs";

function keepScanning(){ try { return localStorage.getItem("cs-keepscan") === "1"; } catch (_) { return false; } }
$("#scanKeep").addEventListener("change", e => {
  try { localStorage.setItem("cs-keepscan", e.target.checked ? "1" : "0"); } catch (_) {}
  $("#scanClose").textContent = e.target.checked ? "Done" : "Close";
  scanMsg(e.target.checked ? "Keep scanning is on: scan one item after another, then tap Done." : "Each scan takes you straight to the product.");
});
async function openScanner(onCode, { title = "Scan barcode", multi = false, onClose = null, level = null, skip = null, keepToggle = false } = {}){
  scanCb = onCode; scanMulti = multi; scanOnClose = onClose; scanSkip = skip;
  setScanTitle(title);
  $("#scanKeepBox").hidden = !keepToggle;
  $("#scanKeep").checked = keepScanning();
  $("#scanClose").textContent = multi && (!keepToggle || keepScanning()) ? "Done" : "Close";
  $("#scanSkip").hidden = !skip;
  $("#scanCount").textContent = ""; $("#scanCount").dataset.n = "0";
  $("#scanCode").value = "";
  $("#scanTorch").hidden = true; $("#scanZoomBox").hidden = true; torchOn = false; $("#scanTorch").setAttribute("aria-pressed", "false");
  showLevelChoice(level);
  scanMsg("Starting camera…");
  $("#scanner").hidden = false; document.body.classList.add("locked");
  try {
    const Q = await loadQr();
    qr = new Q("scanRegion", { verbose: false, formatsToSupport: qrFormats(),
      useBarCodeDetectorIfSupported: true, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    await qr.start({ facingMode: "environment" }, {
      fps: 15,
      disableFlip: true,
      aspectRatio: 1.333,
      // wide, short box: barcodes are long. The whole width is read.
      qrbox: (w, h) => ({ width: Math.max(200, Math.floor(w * 0.92)), height: Math.max(90, Math.floor(h * 0.55)) }),
      // sharper picture + continuous focus = much easier reading of small barcodes
      videoConstraints: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: "continuous" }] }
    }, onDecoded, () => {});
    if ($("#scanner").hidden) return stopCamera();
    setupCameraTools();
    scanMsg(multi && (!keepToggle || keepScanning()) ? "Hold the barcode 10–20 cm away, inside the box. Keep scanning, then tap Done." : "Hold the barcode 10–20 cm away, inside the box.");
  } catch (e) {
    const m = String(e?.name || e?.message || e);
    scanMsg(/NotAllowed|Permission|denied/i.test(m) ? "Camera access is blocked. Allow the camera for this site in your browser settings, or use Photo / type the barcode."
      : /NotFound|Overconstrained|no camera/i.test(m) ? "No camera found. Use Photo, type the barcode, or use a handheld scanner."
      : !window.Html5Qrcode ? "The camera scanner needs internet the first time. Type the barcode below."
      : "Couldn't start the live camera. Use Photo or type the barcode.", "warn");
    await stopCamera();
  }
}
/* torch + zoom, where the phone supports them */
function setupCameraTools(){
  let caps = {};
  try { caps = qr?.getRunningTrackCapabilities?.() || {}; } catch (_) {}
  $("#scanTorch").hidden = !caps.torch;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const z = $("#scanZoom");
    z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, 8); z.step = caps.zoom.step || 0.1;
    // a little zoom helps phones focus on small barcodes
    const start = Math.min(+z.max, Math.max(+z.min, 1.6));
    z.value = start; applyZoom(start);
    $("#scanZoomBox").hidden = false;
  }
}
function applyZoom(v){ try { qr?.applyVideoConstraints({ advanced: [{ zoom: +v }] }); } catch (_) {} }
$("#scanZoom").addEventListener("input", e => applyZoom(e.target.value));
$("#scanTorch").addEventListener("click", async () => {
  torchOn = !torchOn;
  try { await qr?.applyVideoConstraints({ advanced: [{ torch: torchOn }] }); $("#scanTorch").setAttribute("aria-pressed", String(torchOn)); }
  catch (_) { torchOn = false; toast("This camera has no torch."); }
});
/* read a barcode from a photo: often easier on iPhone or with small / shiny barcodes */
$("#scanPhotoBtn").addEventListener("click", () => $("#scanPhoto").click());
$("#scanPhoto").addEventListener("change", async e => {
  const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
  scanMsg("Reading photo…");
  try {
    const Q = await loadQr();
    const fq = new Q("scanFileRegion", { verbose: false, formatsToSupport: qrFormats(), useBarCodeDetectorIfSupported: true, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    const code = await fq.scanFile(f, false);
    try { fq.clear(); } catch (_) {}
    lastCode = ""; deliverCode(String(code).trim());
  } catch (_) {
    beep(false);
    scanMsg("No barcode found in that photo. Fill the picture with the barcode, keep it sharp, and try again.", "warn");
  }
});
$("#scanSkip").addEventListener("click", () => { scanSkip && scanSkip(); });

function onDecoded(text){
  const code = String(text).trim(), now = Date.now();
  if (code === lastCode && now - lastAt < 1800) return;      // same barcode still in view
  lastCode = code; lastAt = now;
  deliverCode(code);
}
function deliverCode(code){
  if (!scanCb || !code) return;
  const r = scanCb(code) || {};
  beep(r.ok !== false);
  scanMsg(r.text || code, r.ok === false ? "warn" : "ok");
  if (r.ok !== false) { const c = $("#scanCount"); c.dataset.n = +c.dataset.n + 1; c.textContent = `${c.dataset.n} scanned`; }
  $("#scanner").classList.remove("hit", "miss"); void $("#scanner").offsetWidth;
  $("#scanner").classList.add(r.ok === false ? "miss" : "hit");
  if (!scanMulti || r.close) closeScanner();
}
async function stopCamera(){
  const q = qr; qr = null;
  if (!q) return;
  try { if (torchOn) await q.applyVideoConstraints({ advanced: [{ torch: false }] }); } catch (_) {}
  try { await q.stop(); } catch (_) {}
  try { q.clear(); } catch (_) {}
}
async function closeScanner(){
  $("#scanner").hidden = true;
  const cb = scanOnClose; scanCb = null; scanOnClose = null; scanSkip = null; lastCode = "";
  await stopCamera();
  if ($("#sheet").hidden && $("#sheet2").hidden) document.body.classList.remove("locked");
  cb && cb();
}
$("#scanClose").addEventListener("click", closeScanner);
$("#scanScrim").addEventListener("click", closeScanner);
$("#scanManual").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#scanCode").value.trim(); if (!v) return;
  $("#scanCode").value = "";
  lastCode = ""; deliverCode(v);
});

/* ---------- barcode setup: give existing items a barcode, one after another ---------- */
function barcodeSetup(){
  const queue = items.filter(it => !codesOf(it).length).sort(byName);
  if (!queue.length) return toast("Every item already has a barcode.");
  let i = 0, saved = 0;
  const title = () => `${queue[i].name}  ·  ${i + 1} of ${queue.length}`;
  const next = msg => {
    i++;
    if (i >= queue.length) { scanMsg(msg ? msg + " · All done." : "All done.", "ok"); setTimeout(closeScanner, 900); return; }
    setScanTitle(title()); showLevelChoice(queue[i]);
    scanMsg(`${msg ? msg + " · " : ""}Now scan: ${queue[i].name}`, msg ? "ok" : "");
  };
  openScanner(code => {
    const it = queue[i]; if (!it) return { ok: false, text: "All done" };
    const owner = findByCode(code);
    if (owner) return { ok: false, text: `${code} is already on ${owner.it.name}. Scan a different barcode, or tap Skip.` };
    const c = { code, per: scanLevel() };
    addCodeToItem(it, c).catch(() => {});
    saved++;
    setTimeout(() => next(`Saved for ${it.name}`), 0);
    return { ok: true, text: `Saved for ${it.name}` };
  }, { title: title(), multi: true, level: queue[0], skip: () => next(`Skipped ${queue[i].name}`),
       onClose: () => { if (saved) toast(`${plural(saved, "barcode", "barcodes")} saved`); render(); } });
  scanMsg(`Scan the barcode on: ${queue[0].name}`);
}

/* scan from the main screen: open the item, or set up an unknown barcode */
function scanToFind(){
  openScanner(code => {
    const hit = findByCode(code);
    if (hit) { itemDetail(hit.it.id, { code: hit.c }); return { ok: true, text: hit.it.name, close: true }; }
    setTimeout(() => unknownCode(code, { onResolved: it => itemDetail(it.id) }), 0);
    return { ok: false, text: "New barcode", close: true };
  }, { title: "Scan to find an item" });
}

/* handheld USB / Bluetooth scanners type the code very fast and press Enter */
let kbBuf = "", kbLast = 0;
document.addEventListener("keydown", e => {
  const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $("#appView").hidden) return;
  const now = Date.now();
  if (now - kbLast > 60) kbBuf = "";
  kbLast = now;
  if (e.key === "Enter") {
    const code = kbBuf; kbBuf = "";
    if (code.length < 4) return;
    e.preventDefault();
    const hit = findByCode(code);
    if (!$("#scanner").hidden) { deliverCode(code); return; }
    if (cart && cart.addLine && $("#sheet2").hidden) {
      if (hit) { const line = cart.addLine(hit.it, ...levelFor(hit.c, hit.it), { fromScan: true }); cart.showLine?.(line); beep(true); }
      else { beep(false); unknownCode(code, { layer: 2, onResolved: (it, c) => cart?.addLine(it, ...levelFor(c, it)) }); }
      return;
    }
    if (!$("#sheet").hidden) return;
    if (hit) { beep(true); itemDetail(hit.it.id, { code: hit.c }); }
    else { beep(false); unknownCode(code, { onResolved: it => itemDetail(it.id) }); }
  } else if (e.key.length === 1) kbBuf += e.key;
});

/* ---------- toast ---------- */
let toastT;
function toast(msg, opt = {}){
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${opt.action ? `<button type="button">${esc(opt.action)}</button>` : ""}`;
  t.hidden = false; clearTimeout(toastT);
  if (opt.action) t.querySelector("button").onclick = () => { t.hidden = true; opt.onAction(); };
  toastT = setTimeout(() => t.hidden = true, opt.action ? 7000 : 2600);
}

/* ---------- events ---------- */
$("#list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const { act, id } = b.dataset;
  if (act === "inc") nudge(id, 1);
  else if (act === "dec") nudge(id, -1);
  else if (act === "open") itemDetail(id);
  else if (act === "add") itemForm();
  else if (act === "pick") itemForm(null, { name: b.dataset.name, cat: b.dataset.cat });
  else if (act === "addhere") itemForm(null, { name: ui.q.trim() ? cap(ui.q.trim()) : "", cat: realCat() || undefined });
  else if (act === "setup") barcodeSetup();
  else if (act === "clear") { ui.q = ""; ui.cat = ""; $("#q").value = ""; render(); $("#q").focus(); }
  else if (act === "cat") { ui.cat = b.dataset.cat; renderChips(); renderList(); }
});
$("#actionbar").addEventListener("click", e => {
  const b = e.target.closest("[data-cart],[data-scanfind]"); if (!b) return;
  if (b.dataset.scanfind !== undefined) scanToFind(); else openCart(b.dataset.cart);
});
$("#mainScan").addEventListener("click", scanToFind);
$("#q").addEventListener("input", e => { ui.q = e.target.value; if (currentView() !== "items") go("items"); else renderList(); });
$("#qClear").addEventListener("click", () => { ui.q = ""; $("#q").value = ""; renderList(); $("#q").focus(); });
$("#q").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const hit = findByCode(e.target.value);
  if (hit) { e.preventDefault(); beep(true); e.target.value = ""; ui.q = ""; renderList(); itemDetail(hit.it.id, { code: hit.c }); }
});
$("#sort").addEventListener("change", e => { ui.sort = e.target.value; renderList(); });
$("#chips").addEventListener("click", e => {
  const c = e.target.closest("[data-cat]"); if (!c) return;
  ui.cat = ui.cat === c.dataset.cat ? "" : c.dataset.cat;   // tap again to clear
  renderChips(); renderList();
});

$("#summary").addEventListener("click", async e => {
  if (e.target.id !== "copyReorder") return;
  const lines = items.filter(it => status(it) !== "ok").sort(byName).map(it => {
    const s = sizes(it), need = Math.max(1, (+it.min||0) * 2 - shown(it));
    const order = s.pc ? `${Math.ceil(need / s.pc)} ${pl(Math.ceil(need / s.pc), s.cn)}` : s.pp ? `${Math.ceil(need / s.pp)} ${pl(Math.ceil(need / s.pp), s.pn)}` : `${need} ${U(it)}`;
    return `${it.name}: have ${shown(it)} ${U(it)} — order ${order}`;
  });
  const text = "Reorder list\n" + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast("Reorder list copied"); }
  catch (err) { openSheet(`<h3>Reorder list</h3><div class="field"><label for="rl">Select and copy</label><textarea id="rl" rows="8" readonly>${esc(text)}</textarea></div>`, p => p.querySelector("#rl").select()); }
});
setInterval(() => { if (moves.length) renderFeed(); }, 60000);


/* ================= pages: Home · Items · Activity ================= */
const VIEWS = { "": "Crockery Stock", items: "Items", activity: "Activity" };
let fromHome = false;
function currentView(){ const h = location.hash.slice(1); return Object.hasOwn(VIEWS, h) ? h : ""; }
function applyView(){
  const v = currentView();
  $("#appView").dataset.view = v || "home";
  $("#viewTitle").textContent = VIEWS[v];
  document.title = v ? `${VIEWS[v]} · Crockery Stock` : "Crockery Stock";
  if (v !== "items") { ui.cat = ""; if (!$("#q").matches(":focus")) { ui.q = ""; $("#q").value = ""; } }
  render();
  window.scrollTo({ top: 0 });
}
function go(view, { cat } = {}){
  if (cat !== undefined) ui.cat = cat;
  if (currentView() === view) return applyView();
  fromHome = currentView() === "";
  location.hash = view;
}
window.addEventListener("hashchange", applyView);
$("#backBtn").addEventListener("click", () => { if (fromHome) { fromHome = false; history.back(); } else location.hash = ""; });

/* ================= home: big buttons ================= */
const ICONS = {
  in:   '<path d="M12 3v11m0 0-4-4m4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  out:  '<path d="M12 15V4m0 0-4 4m4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  scan: '<path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8"/>',
  count:'<path d="M9 4h6v3H9zM7 5H5v16h14V5h-2"/><path d="m9 14 2 2 4-4"/>',
  quick:'<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  items:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  low:  '<path d="M12 3 2 20h20zM12 10v4M12 17v.5"/>',
  act:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  add:  '<path d="M12 5v14M5 12h14"/>',
  admin:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11h6M20 8v6"/>'
};
const ic = k => `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const sameDay = (t, d = new Date()) => new Date(t).toDateString() === d.toDateString();
const isDailyCount = m => /^Daily count/.test(m.note || "");
function renderHome(){
  const el = $("#tiles"); if (!el) return;
  const fast = items.filter(i => i.fast);
  const counted = fast.filter(it => moves.some(m => m.itemId === it.id && isDailyCount(m) && sameDay(m.at))).length;
  const low = items.filter(it => status(it) !== "ok").length;
  const today = moves.filter(m => sameDay(m.at)).length;
  const t = (cls, icon, label, sub, attr, badge = 0) =>
    `<button type="button" class="htile ${cls}" ${attr}>${ic(icon)}<b>${label}</b><small>${sub}</small>${badge ? `<span class="badge">${badge}</span>` : ""}</button>`;
  el.innerHTML =
    t("t-in", "in", "Stock in", "Delivery arrived", 'data-cart="in"') +
    t("t-out", "out", "Stock out", "Use · issue · breakage", 'data-cart="out"') +
    t("t-scan", "scan", "Scan", "Find by barcode", "data-scanfind") +
    t("t-count", "count", "Daily count", fast.length ? `${counted} of ${fast.length} counted today` : "Count what's left", 'data-go="count"', fast.length - counted) +
    t("t-quick", "quick", "Quick use", fast.length ? "Tap when one is taken" : "For water & fast items", 'data-go="quick"') +
    t("", "items", "Items", `${items.length} items`, 'data-view="items"') +
    t(low ? "t-warn" : "", "low", "Low stock", low ? `${low} need attention` : "All above minimum", 'data-view="items" data-cat="Low stock"', low) +
    t("", "act", "Activity", `${today} change${today === 1 ? "" : "s"} today`, 'data-view="activity"') +
    t("", "add", "New item", "Add a product", 'data-go="new"') +
    (amAdmin ? `<a class="htile" href="/admin.html" id="adminLink">${ic("admin")}<b>Admin</b><small>Users, units, categories</small></a>` : "");
}
$("#tiles").addEventListener("click", e => {
  const b = e.target.closest(".htile"); if (!b || b.tagName === "A") return;
  if (b.dataset.cart) return openCart(b.dataset.cart);
  if (b.hasAttribute("data-scanfind")) return scanToFind();
  if (b.dataset.view) return go(b.dataset.view, { cat: b.dataset.cat || "" });
  if (b.dataset.go === "count") return dailyCount();
  if (b.dataset.go === "quick") return quickUse();
  if (b.dataset.go === "new") return itemForm();
});

/* ================= fast items: choose which ones ================= */
async function setFast(it, on){
  const updated = { ...it, fast: !!on, updatedAt: Date.now() };
  Object.assign(it, updated);
  try { await putItem(updated); } catch (_) {}
}
function chooseFast(onDone){
  openSheet(`<h3>Fast-moving items</h3>
    <p class="hint">Tick the items you use all day (water, juice, napkins…). They appear in Daily count and Quick use.</p>
    <div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="fsQ" type="search" placeholder="Search items" aria-label="Search items" autocomplete="off"></div>
    <ul class="pick-list" id="fsList"></ul>
    <div class="actions"><button class="btn primary" type="button" id="fsDone">Done</button></div>`,
  p => {
    const draw = () => {
      const q = p.querySelector("#fsQ").value.trim();
      const list = items.filter(it => matches(it, q)).sort((a, b) => (b.fast ? 1 : 0) - (a.fast ? 1 : 0) || byName(a, b));
      p.querySelector("#fsList").innerHTML = list.length ? list.map(it => `<li><label><input type="checkbox" data-fast="${it.id}" ${it.fast ? "checked" : ""}>
        <span><b>${esc(it.name)}</b><small>${esc(it.category)} · ${shown(it)} ${esc(U(it))}</small></span></label></li>`).join("") : `<li class="none">No items match.</li>`;
    };
    p.querySelector("#fsQ").addEventListener("input", draw);
    p.querySelector("#fsList").addEventListener("change", e => { const it = items.find(x => x.id === e.target.dataset.fast); if (it) setFast(it, e.target.checked); });
    p.querySelector("#fsDone").addEventListener("click", () => { closeSheet(2, true); onDone && onDone(); });
    draw();
  }, { layer: 2 });
}

/* ================= DAILY COUNT ================= */
function dailyCount(){
  const fast = () => items.filter(i => i.fast).sort(byName);
  if (!fast().length) return chooseFast(() => items.some(i => i.fast) && dailyCount());
  const lines = new Map();
  const pn = openSheet(`
    <div class="cart-head">
      <h3>Daily count</h3>
      <p class="hint">Count what's left of each item and enter it. The difference is saved as <b>used</b>, so nobody has to record every bottle.</p>
      <div class="finder">
        <button type="button" class="btn" id="dcEdit">Edit list</button>
        <button type="button" class="btn primary scan-big" id="dcScan">${BARCODE_ICON}<span>Scan</span></button>
      </div>
    </div>
    <div class="cart-body">
      <div id="dcLines" class="lines"></div>
      <div class="cart-extra">
        <div class="field" id="dcPartyBox"></div>
        <div class="field"><label for="dcNote">Note <span class="opt">optional</span></label><input id="dcNote" maxlength="120" placeholder="e.g. Closing count, bar"></div>
      </div>
    </div>
    <div class="cart-foot">
      <div class="err" id="dcErr" role="alert"></div>
      <div class="discard" id="cDiscard" hidden><span>Discard this count?</span><button type="button" class="btn sm" id="cKeep">Keep counting</button><button type="button" class="btn sm danger solid" id="cDrop">Discard</button></div>
      <div class="foot-row"><span id="dcSum" class="cart-sum"></span><button class="btn primary big-save" type="button" id="dcSave" disabled>Save count</button></div>
    </div>`, null, { full: true, guard: () => {
      if (![...lines.values()].some(l => l.touched)) return false;
      $("#cDiscard").hidden = false; return true;
    }});
  pn.classList.add("dc");
  const arr = lists.outlets || [];
  pn.querySelector("#dcPartyBox").innerHTML = `<label for="dcParty">Counted at <span class="opt">optional</span></label>
    <input id="dcParty" maxlength="60" list="dcPartyList" autocomplete="off" placeholder="e.g. Bar, Kitchen">${datalist("dcPartyList", arr)}
    ${arr.length ? `<div class="picks small">${arr.map(v => `<button type="button" class="chip" data-party="${esc(v)}">${esc(v)}</button>`).join("")}</div>` : ""}`;

  const lastCount = it => moves.find(m => m.itemId === it.id && isDailyCount(m));
  const foot = () => {
    const done = [...lines.values()].filter(l => l.touched);
    const used = done.reduce((a, l) => { const d = shown(l.it) - l.qb.total(); return a + (d > 0 ? d : 0); }, 0);
    pn.querySelector("#dcSum").innerHTML = `<b>${done.length}</b> of ${lines.size} counted${used ? ` · ${used} used` : ""}`;
    pn.querySelector("#dcSave").disabled = !done.length;
    pn.querySelector("#dcSave").textContent = done.length ? `Save count (${done.length})` : "Save count";
  };
  const addLine = it => {
    if (lines.has(it.id)) { const l = lines.get(it.id); l.el.scrollIntoView({ block: "center", behavior: "smooth" }); l.qb.focusFirst(); return l; }
    const el = document.createElement("div"); el.className = "cline dcline";
    const last = lastCount(it);
    el.innerHTML = `<div class="cl-head">
        <div class="cl-name"><b>${esc(it.name)}</b><span class="hint">App says ${shown(it)} ${esc(U(it))}${last ? ` · last count ${fmtWhen(last.at).toLowerCase()}` : " · not counted yet"}</span></div>
        <button type="button" class="btn sm none-left">None left</button>
      </div>
      <div class="qbox compact" id="dc-${it.id}"></div>`;
    pn.querySelector("#dcLines").append(el);
    const line = { it, el, touched: false };
    line.qb = qtyBox(el.querySelector(".qbox"), () => sizes(it), 0, n => {
      if (!line.touched) return `<span class="muted">How many are left?</span>`;
      const d = shown(it) - n;
      el.classList.toggle("done", true);
      return d > 0 ? `Left <b>${n}</b> · used <b>${d} ${esc(U(it))}</b> since the app's number`
        : d < 0 ? `Left <b>${n}</b> · <b>${-d} more</b> than the app has. It will be corrected.`
        : `Left <b>${n}</b> · matches the app ✓`;
    }, () => U(it));
    const touch = () => { line.touched = true; line.qb.refresh(); foot(); };
    el.querySelector(".qbox").addEventListener("input", touch);
    el.querySelector(".qbox").addEventListener("click", e => { if (e.target.closest("[data-d]")) touch(); });
    el.querySelector(".none-left").addEventListener("click", () => { el.querySelectorAll(".qbox input").forEach(i => i.value = ""); touch(); });
    lines.set(it.id, line);
    return line;
  };
  const drawAll = () => { fast().forEach(addLine); foot(); };
  drawAll();

  pn.querySelector("#dcEdit").addEventListener("click", () => chooseFast(() => { fast().forEach(addLine); foot(); }));
  pn.querySelector("#dcScan").addEventListener("click", () => openScanner(code => {
    const hit = findByCode(code);
    if (!hit) return { ok: false, text: `${code} isn't on any item.` };
    if (!hit.it.fast) setFast(hit.it, true);
    const l = addLine(hit.it); foot();
    setTimeout(() => { l.el.scrollIntoView({ block: "center", behavior: "smooth" }); l.el.classList.remove("picked"); void l.el.offsetWidth; l.el.classList.add("picked"); l.qb.focusFirst(); }, 50);
    return { ok: true, text: hit.it.name, close: true };
  }, { title: "Scan the item you're counting" }));
  pn.addEventListener("click", e => {
    const c = e.target.closest("[data-party]"); if (!c) return;
    pn.querySelector("#dcParty").value = c.dataset.party;
    pn.querySelectorAll("[data-party]").forEach(x => x.setAttribute("aria-pressed", x === c));
  });
  pn.querySelector("#cKeep").addEventListener("click", () => pn.querySelector("#cDiscard").hidden = true);
  pn.querySelector("#cDrop").addEventListener("click", () => closeSheet(1, true));

  pn.querySelector("#dcSave").addEventListener("click", async () => {
    const todo = [...lines.values()].filter(l => l.touched).map(l => ({ it: l.it, left: l.qb.total() }));
    if (!todo.length) return;
    const party = pn.querySelector("#dcParty").value.trim(), extra = pn.querySelector("#dcNote").value.trim();
    const note = "Daily count" + (extra ? ` · ${extra}` : "");
    closeSheet(1, true);
    const done = []; let used = 0;
    try {
      for (const { it, left } of todo) {
        await commitNudge(it.id);
        const cur = +items.find(x => x.id === it.id)?.qty || 0, d = cur - left;
        if (d > 0) { const r = await applyMove(it.id, "used", d, note, { party }); used += d; r && done.push({ id: it.id, ...r }); }
        else if (d < 0) { const r = await applyMove(it.id, "count", -d, note + " · more than expected", { party }); r && done.push({ id: it.id, ...r }); }
        else await addMove({ id: uid("m"), itemId: it.id, name: it.name, unit: U(it), type: "count", qty: 0, before: cur, after: cur, note: note + " · no change", party, by: auth.currentUser?.email || "", at: Date.now() });
      }
    } catch (_) {}
    toast(`Daily count saved: ${plural(todo.length, "item", "items")}${used ? `, ${used} used` : ""}`, done.length ? { action: "Undo", onAction: async () => {
      for (const r of [...done].reverse()) await applyMove(r.id, "count", r.before - r.after, "Undo daily count");
      toast("Undone");
    }} : {});
  });
}

/* ================= QUICK USE: tap each time one is taken ================= */
let quickRefresh = null;
const qPending = {};      // itemId -> { n, t }
let qLast = [];           // last saved batch, for Undo
function quickUse(){
  if (!items.some(i => i.fast)) return chooseFast(() => items.some(i => i.fast) && quickUse());
  let party = "";
  const pn = openSheet(`
    <div class="cart-head">
      <h3>Quick use</h3>
      <p class="hint">Tap an item each time one is taken. Taps are saved automatically after a few seconds.</p>
      <div class="field" id="quPartyBox"></div>
    </div>
    <div class="cart-body"><div class="quick-grid" id="quGrid"></div></div>
    <div class="cart-foot"><div class="foot-row">
      <button type="button" class="btn" id="quEdit">Edit list</button>
      <button type="button" class="btn" id="quUndo" disabled>Undo last</button>
      <button type="button" class="btn primary" id="quDone">Done</button>
    </div></div>`, null, { full: true, guard: () => { quickFlushAll(); quickRefresh = null; return false; } });
  const arr = lists.outlets || [];
  pn.querySelector("#quPartyBox").innerHTML = arr.length ? `<div class="picks small" role="group" aria-label="Used at">${arr.map(v => `<button type="button" class="chip" data-qparty="${esc(v)}">${esc(v)}</button>`).join("")}</div>` : "";
  pn.querySelector("#quPartyBox").addEventListener("click", e => {
    const c = e.target.closest("[data-qparty]"); if (!c) return;
    party = party === c.dataset.qparty ? "" : c.dataset.qparty;
    pn.querySelectorAll("[data-qparty]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.qparty === party)));
  });
  const draw = () => {
    const g = pn.querySelector("#quGrid"); if (!g) return;
    g.innerHTML = items.filter(i => i.fast).sort(byName).map(it => {
      const pend = qPending[it.id]?.n || 0, left = shown(it) - pend, s = sizes(it);
      return `<div class="qtile ${left <= 0 ? "empty" : status(it) !== "ok" ? "low" : ""}" data-id="${it.id}">
        <button type="button" class="qtap" data-take="1" aria-label="Take one ${esc(it.name)}">
          <b>${esc(it.name)}</b><span class="qleft">${left} ${esc(U(it))} left</span><span class="qminus">−1</span>
        </button>
        <div class="qrow2">
          ${s.pp ? `<button type="button" class="btn sm" data-take="${s.pp}">−1 ${esc(s.pn)} (${s.pp})</button>` : `<button type="button" class="btn sm" data-take="5">−5</button>`}
          ${pend ? `<span class="qpend">−${pend} saving…</span>` : ""}
        </div>
      </div>`;
    }).join("");
  };
  quickRefresh = () => { if (pn.isConnected && !$("#sheet").hidden) draw(); else quickRefresh = null; };
  pn.querySelector("#quGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-take]"); if (!b) return;
    const id = b.closest(".qtile").dataset.id, it = items.find(x => x.id === id), k = +b.dataset.take;
    const p = qPending[id] || (qPending[id] = { n: 0, t: null, party });
    if (shown(it) - p.n - k < 0) { beep(false); toast(`Only ${shown(it) - p.n} ${U(it)} of ${it.name} left`); return; }
    p.n += k; p.party = party; clearTimeout(p.t);
    p.t = setTimeout(() => quickFlush(id), 2500);
    try { navigator.vibrate?.(20); } catch (_) {}
    draw();
    const tile = pn.querySelector(`.qtile[data-id="${id}"]`); tile?.classList.add("tapped"); setTimeout(() => tile?.classList.remove("tapped"), 180);
  });
  pn.querySelector("#quEdit").addEventListener("click", () => { quickFlushAll(); chooseFast(draw); });
  pn.querySelector("#quDone").addEventListener("click", () => { quickFlushAll(); quickRefresh = null; closeSheet(1, true); });
  pn.querySelector("#quUndo").addEventListener("click", async () => {
    const batch = qLast; qLast = []; pn.querySelector("#quUndo").disabled = true;
    for (const r of [...batch].reverse()) await applyMove(r.id, "count", r.before - r.after, "Undo quick use");
    toast("Undone"); draw();
  });
  draw();
}
async function quickFlush(id){
  const p = qPending[id]; if (!p || !p.n) return;
  clearTimeout(p.t); delete qPending[id];
  await commitNudge(id);
  try {
    const r = await applyMove(id, "used", p.n, "Quick use", { party: p.party || "" });
    if (r) { qLast = [{ id, ...r }]; const u = $("#quUndo"); if (u) u.disabled = false; }
  } catch (_) {}
  quickRefresh?.();
}
function quickFlushAll(){ Object.keys(qPending).forEach(quickFlush); }
document.addEventListener("visibilitychange", () => { if (document.hidden) quickFlushAll(); });
window.addEventListener("pagehide", quickFlushAll);

applyView();   // show the right page on start (Home, #items or #activity)
