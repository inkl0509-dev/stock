import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit, getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { fbApp, auth, api } from "./firebase.js";
import { checkForUpdate } from "./pwa.js";

/* ---------- Firebase ---------- */
// IndexedDB cache: all stock and activity is saved on the device, so the app opens and works
// offline. Changes made offline are queued and synced automatically when back online.
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------- constants & state ---------- */
// Lists admins can edit on the admin page (Firestore: settings/lists). These are the defaults.
const DEFAULT_LISTS = {
  units: ["pcs","sets","pairs","dozen"],
  categories: ["Glassware","Cutlery","Cups & mugs","Plates & bowls","Serveware","Other"],
  places: [], suppliers: [], outlets: [],
  reasons: ["Dropped","Dishwasher","Chipped / cracked","Lost","Guest breakage"]
};
let lists = JSON.parse(JSON.stringify(DEFAULT_LISTS));
const U = it => it?.unit || "pcs";
const unitWord = u => u === "pcs" ? "pieces" : u;
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
const withCurrent = (arr, v) => v && !arr.includes(v) ? [...arr, v] : arr;
const options = (arr, sel) => arr.map(v => `<option value="${esc(v)}" ${v===sel?"selected":""}>${esc(v)}</option>`).join("");
const datalist = (id, arr) => `<datalist id="${id}">${arr.map(v => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
const TYPE_LABEL = { received:"Received", used:"Used", issued:"Issued", broken:"Broken", count:"Stock count" };
const QUICK_PICKS = [
  ["Water glass","Glassware"],["Wine glass","Glassware"],["Highball glass","Glassware"],["Juice glass","Glassware"],
  ["Espresso cup","Cups & mugs"],["Espresso saucer","Cups & mugs"],["Cappuccino cup","Cups & mugs"],["Tea cup","Cups & mugs"],
  ["Tea spoon","Cutlery"],["Table spoon","Cutlery"],["Dinner fork","Cutlery"],["Dinner knife","Cutlery"],
  ["Dinner plate","Plates & bowls"],["Quarter plate","Plates & bowls"],["Soup bowl","Plates & bowls"]
];

let items = [], moves = [], loaded = false;
let unsubs = [];
const ui = { q:"", cat:"All", sort:"attention" };
const pending = {};   // quick +/- taps waiting to be saved
const chains = {};    // one write at a time per document

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const int = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

const shown = it => Math.max(0, (+it.qty||0) + (pending[it.id]?.delta||0));
function status(it){ const q = shown(it), m = +it.min||0; return q<=0 ? "out" : q<=m ? "low" : "ok"; }

/* ---------- packing: everything is stored in pieces ---------- */
// item.perPacket  = pieces in 1 packet (optional)
// item.perCarton  = pieces in 1 carton (optional)
const sizes = it => ({ pp: int(it?.perPacket), pc: int(it?.perCarton) });
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
  if (b.ctn) parts.push(plural(b.ctn,"carton","cartons"));
  if (b.pkt) parts.push(plural(b.pkt,"packet","packets"));
  if (b.pcs || !parts.length) parts.push(`${b.pcs} ${unit}`);
  return parts.join(" + ");
}
function sizeText(s, unit = "pcs"){
  const bits = [];
  if (s.pp) bits.push(`1 packet = ${s.pp} ${unit}`);
  if (s.pc) bits.push(s.pp && s.pc % s.pp === 0 ? `1 carton = ${s.pc/s.pp} packets (${s.pc} ${unit})` : `1 carton = ${s.pc} ${unit}`);
  return bits.join(" · ");
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
    $("#adminLink").hidden = true;
    items = []; moves = []; loaded = false;
    $("#appView").hidden = true; $("#loginView").hidden = false;
    try { $("#lRemember").checked = localStorage.getItem("cs-remember") !== "0"; } catch (_) {}
    $("#lEmail").focus();
  }
});

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#lEmail").value.trim(), pass = $("#lPass").value, err = $("#lErr");
  if (!email || !pass) return err.textContent = "Enter your email and password.";
  err.textContent = ""; $("#lBtn").disabled = true;
  try {
    // Remember me ON  → stay signed in after closing the browser or restarting the phone
    // Remember me OFF → signed out when the tab/browser is closed
    await setPersistence(auth, $("#lRemember").checked ? browserLocalPersistence : browserSessionPersistence);
    try { localStorage.setItem("cs-remember", $("#lRemember").checked ? "1" : "0"); } catch (_) {}
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (ex) {
    err.textContent = ex.code === "auth/too-many-requests" ? "Too many attempts. Wait a minute and try again."
      : ex.code === "auth/network-request-failed" ? "No internet connection."
      : "Wrong email or password.";
  } finally { $("#lBtn").disabled = false; }
});
$("#outBtn").addEventListener("click", () => {
  openSheet(`<h3>Sign out?</h3><p class="hint">Signed in as ${esc(auth.currentUser?.email)}. You'll need your email and password to get back in.</p>
    <div class="actions"><button class="btn" type="button" data-close>Stay signed in</button><button class="btn primary" type="button" id="yesOut">Sign out</button></div>`,
    p => p.querySelector("#yesOut").addEventListener("click", () => { closeSheet(); signOut(auth); }));
});
$("#lPassToggle").addEventListener("click", () => {
  const i = $("#lPass"), show = i.type === "password";
  i.type = show ? "text" : "password"; $("#lPassToggle").textContent = show ? "Hide" : "Show";
});

async function showAdminLink(){
  // Cached so the button appears instantly (and offline); confirmed with the server.
  try { $("#adminLink").hidden = localStorage.getItem("cs-admin:" + auth.currentUser.uid) !== "1"; } catch (_) {}
  try {
    const r = await api("/api/me");
    $("#adminLink").hidden = !r.admin;
    // pick up the admin role in the sign-in token (needed to edit lists)
    if (r.admin) { const t = await auth.currentUser.getIdTokenResult(); if (t.claims.admin !== true) await auth.currentUser.getIdToken(true); }
    try { localStorage.setItem("cs-admin:" + auth.currentUser.uid, r.admin ? "1" : "0"); } catch (_) {}
  } catch (e) { if (e.status === 403 || e.status === 401) $("#adminLink").hidden = true; }
}

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
  }, e => { setSync("Can't load stock: " + e.code, "bad"); loaded = true; render(); }));

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

/* change stock, log it, offer undo */
async function applyMove(itemId, type, n, note, { undoable = true, party = "" } = {}){
  const it = items.find(x => x.id === itemId); if (!it) return;
  const before = +it.qty||0;
  const after = type === "received" ? before + n : type === "count" ? Math.max(0, before + n) : Math.max(0, before - n);
  if (after === before) return { before, after };
  it.qty = after; render();
  await putItem({ ...it, qty: after, updatedAt: Date.now() });
  await addMove({ id: uid("m"), itemId, name: it.name, unit: U(it), type, qty: type === "count" ? after - before : n, before, after, note: note||"", party: party||"", at: Date.now() });
  if (undoable) {
    const label = type === "count" ? `${it.name}: now ${after} ${U(it)}` : `${TYPE_LABEL[type]} ${n} ${U(it)} · ${it.name}`;
    toast(label, { action: "Undo", onAction: () => applyMove(itemId, "count", before - after, "Undo", { undoable:false }).then(() => toast("Undone")) });
  }
  return { before, after };
}

/* quick +/- : taps are combined into one saved change */
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
  try { await applyMove(id, "count", p.delta, "Quick adjust", { undoable:false }); } catch (e) {}
}

/* ---------- rendering ---------- */
function render(){ renderSummary(); renderChips(); renderList(); renderFeed(); }

function renderSummary(){
  const pieces = items.reduce((a,it) => a + shown(it), 0);
  const low = items.filter(it => status(it) === "low").length;
  const out = items.filter(it => status(it) === "out").length;
  const since = Date.now() - 30*864e5;
  const broken = moves.filter(m => m.type === "broken" && m.at >= since).reduce((a,m) => a + (+m.qty||0), 0);
  $("#summary").innerHTML = `
    <div class="tile"><span class="lab">Items</span><span class="val">${items.length}</span><span class="sub">${new Set(items.map(i=>i.category)).size} categories</span></div>
    <div class="tile"><span class="lab">Units on hand</span><span class="val">${pieces.toLocaleString()}</span><span class="sub">all items</span></div>
    <div class="tile ${low+out?"warn":""}"><span class="lab">Low / out</span><span class="val">${low} / ${out}</span>${low+out?`<button class="link" type="button" id="copyReorder">Copy reorder list</button>`:`<span class="sub">All above minimum</span>`}</div>
    <div class="tile ${broken?"bad":""}"><span class="lab">Broken · 30 days</span><span class="val">${broken}</span><span class="sub">pieces written off</span></div>`;
}

function renderChips(){
  const counts = {}; items.forEach(i => counts[i.category] = (counts[i.category]||0) + 1);
  const low = items.filter(it => status(it) !== "ok").length;
  const cats = ["All", ...(low ? ["Low stock"] : []), ...lists.categories.filter(c => counts[c]), ...Object.keys(counts).filter(c => !lists.categories.includes(c)).sort()];
  if (!cats.includes(ui.cat)) ui.cat = "All";
  $("#chips").innerHTML = cats.map(c => `<button type="button" class="chip ${c==="Low stock"?"warn":""}" data-cat="${esc(c)}" aria-pressed="${ui.cat===c}">${esc(c)}<span class="c">${c==="All"?items.length:c==="Low stock"?low:counts[c]}</span></button>`).join("");
}

function sorted(){
  const q = ui.q.trim().toLowerCase();
  const list = items.filter(it =>
    (ui.cat === "All" || (ui.cat === "Low stock" ? status(it) !== "ok" : it.category === ui.cat)) &&
    (!q || (it.name + " " + it.category + " " + (it.place||"")).toLowerCase().includes(q)));
  const rank = { out:0, low:1, ok:2 };
  const byName = (a,b) => a.name.localeCompare(b.name);
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
    el.innerHTML = `<div class="empty"><h3>Let's add your first item</h3><p>Tap one to start, or add your own.</p>
      <div class="picks">${QUICK_PICKS.slice(0,8).map(([n,c]) => `<button type="button" class="chip" data-act="pick" data-name="${esc(n)}" data-cat="${esc(c)}">${esc(n)}</button>`).join("")}</div>
      <button class="btn primary" type="button" data-act="add">＋ Add an item</button></div>`;
    return;
  }
  const list = sorted();
  if (!list.length) { el.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>Try another search or category.</p><button class="btn" type="button" data-act="clear">Clear search</button></div>`; return; }
  el.innerHTML = list.map(it => {
    const st = status(it), q = shown(it), m = +it.min||0, s = sizes(it);
    const pct = Math.min(100, m ? (q/(m*2))*100 : (q?100:0));
    const pack = packText(q, s, U(it));
    return `<div class="row ${st} ${pending[it.id]?"pending":""}">
      <span class="stripe" aria-hidden="true"></span>
      <button type="button" class="main" data-act="open" data-id="${it.id}">
        <span class="name">${esc(it.name)}</span>
        <span class="meta"><span class="pill ${st}">${st==="ok"?"In stock":st==="low"?"Low":"Out"}</span>${esc(it.category)} · min ${m}${it.place?` · ${esc(it.place)}`:""}</span>
        ${pack ? `<span class="pack">${esc(pack)}</span>` : ""}
        <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      </button>
      <div class="ctrl">
        <button type="button" class="step" data-act="dec" data-id="${it.id}" aria-label="Remove one ${esc(it.name)}">−</button>
        <span class="qty"><b>${q}</b><small>${esc(U(it))}</small></span>
        <button type="button" class="step" data-act="inc" data-id="${it.id}" aria-label="Add one ${esc(it.name)}">+</button>
      </div></div>`;
  }).join("");
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
function deltaText(m){
  const n = +m.qty||0;
  if (m.type === "received") return "+" + n;
  if (m.type === "issued" || m.type === "broken" || m.type === "used") return "−" + n;
  return (n>0?"+":n<0?"−":"") + Math.abs(n);
}
function moveLi(m, withName){
  return `<li><span class="delta ${m.type}">${deltaText(m)}</span><div>
    <div class="what">${withName ? esc(m.name) + " · " : ""}${TYPE_LABEL[m.type] || m.type}${m.party ? ` ${m.type==="received"?"from":m.type==="issued"?"to":"·"} ${esc(m.party)}` : ""}</div>
    <div class="when">${fmtWhen(m.at)} · now ${m.after} ${esc(m.unit||"pcs")}</div>
    ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}</div></li>`;
}
function renderFeed(){
  const f = $("#feed");
  $("#actCount").textContent = moves.length ? `Last ${moves.length} changes` : "";
  if (!moves.length) { f.innerHTML = `<li style="display:block"><div class="empty" style="padding:20px 6px"><p>Every delivery, issue and breakage you record shows up here.</p></div></li>`; return; }
  f.innerHTML = moves.map(m => moveLi(m, true)).join("");
}

/* ---------- bottom sheets ---------- */
let lastFocus = null;
function openSheet(html, mount){
  lastFocus = document.activeElement;
  $("#panel").innerHTML = `<button type="button" class="btn ghost x" data-close aria-label="Close">✕</button>` + html;
  $("#sheet").hidden = false;
  document.body.classList.add("locked");
  mount && mount($("#panel"));
}
function closeSheet(){ $("#sheet").hidden = true; $("#panel").innerHTML = ""; document.body.classList.remove("locked"); lastFocus?.focus?.(); }
$("#sheet").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

/* Quantity entry in cartons / packets / pieces, with +/- buttons and a live total */
function qtyBox(box, getSizes, startPcs, onChange, getUnit = () => "pcs", { smallFirst = false } = {}){
  let s = getSizes();
  const read = () => {
    const v = k => int(box.querySelector(`[data-u="${k}"]`)?.value);
    return v("ctn") * (s.pc||0) + v("pkt") * (s.pp||0) + v("pcs");
  };
  const draw = total => {
    s = getSizes();
    const b = (s.pc || s.pp) ? split(total, s) : { ctn:0, pkt:0, pcs: total };
    const rows = [];
    const u = getUnit(), w = unitWord(u);
    if (s.pc) rows.push(["ctn","Cartons",`${s.pc} ${u} each`,b.ctn]);
    if (s.pp) rows.push(["pkt","Packets",`${s.pp} ${u} each`,b.pkt]);
    rows.push(["pcs", rows.length && !smallFirst ? `Loose ${w}` : cap(w), "", b.pcs]);
    if (smallFirst) rows.reverse();   // when using stock, single pieces come first
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
  return { total: read, redraw: () => draw(read()) };
}

function sizeFields(it){
  const s = sizes(it);
  const cartonInPackets = s.pp && s.pc && s.pc % s.pp === 0;
  return `<details class="packing" ${s.pp || s.pc ? "open" : ""}>
    <summary>Packing <span class="hint">(optional) · cartons & packets</span></summary>
    <div class="grid2">
      <div class="field"><label for="fPP">Qty in 1 packet</label><input id="fPP" type="number" inputmode="numeric" min="0" step="1" value="${s.pp||""}" placeholder="e.g. 12"></div>
      <div class="field"><label for="fPC">1 carton holds</label>
        <div class="join"><input id="fPC" type="number" inputmode="numeric" min="0" step="1" value="${s.pc ? (cartonInPackets ? s.pc/s.pp : s.pc) : ""}" placeholder="e.g. 6">
        <select id="fPCU" aria-label="Carton holds">
          <option value="pkt" ${cartonInPackets || (!s.pc && s.pp) ? "selected" : ""}>packets</option>
          <option value="pcs" ${s.pc && !cartonInPackets ? "selected" : ""}>single units</option>
        </select></div>
      </div>
    </div>
    <p class="hint" id="fSizeHint"></p>
  </details>`;
}
function readSizes(p){
  const pp = int(p.querySelector("#fPP").value);
  const n = int(p.querySelector("#fPC").value);
  const unit = p.querySelector("#fPCU").value;
  const pc = n ? (unit === "pkt" ? (pp ? n * pp : 0) : n) : 0;
  return { pp, pc, bad: n && unit === "pkt" && !pp };
}

function itemForm(it, preset){
  const isNew = !it;
  it = it || { name: preset?.name || "", category: preset?.cat || (lists.categories.includes(ui.cat) ? ui.cat : (lists.categories[0] || "Other")), unit: lists.units[0] || "pcs", qty:0, min:0, place:"" };
  openSheet(`<h3>${isNew ? "Add item" : "Edit item"}</h3>
    <form id="fItem" novalidate>
      <div class="field"><label for="fName">Item name</label><input id="fName" maxlength="80" value="${esc(it.name)}" placeholder="e.g. Highball glass" autocomplete="off"></div>
      ${isNew ? `<div class="picks small" id="fPicks">${QUICK_PICKS.map(([n,c]) => `<button type="button" class="chip" data-name="${esc(n)}" data-cat="${esc(c)}">${esc(n)}</button>`).join("")}</div>` : ""}
      <div class="grid2">
        <div class="field"><label for="fCat">Category</label><select id="fCat">${options(withCurrent(lists.categories, it.category), it.category)}</select></div>
        <div class="field"><label for="fUnit">Counted in</label><select id="fUnit">${options(withCurrent(lists.units.length ? lists.units : ["pcs"], U(it)), U(it))}</select></div>
      </div>
      <div class="field"><label for="fPlace">Kept at <span class="opt">optional</span></label><input id="fPlace" maxlength="60" value="${esc(it.place||"")}" placeholder="e.g. Bar shelf B" list="placesList" autocomplete="off">${datalist("placesList", lists.places)}</div>
      ${sizeFields(it)}
      <fieldset class="qbox-wrap"><legend>${isNew ? "How many do you have now?" : "Current stock"}</legend><div class="qbox" id="fQty"></div></fieldset>
      <div class="field"><label for="fMin">Warn me when stock falls to <span class="opt" id="fMinU">${esc(U(it))}</span></label><input id="fMin" type="number" inputmode="numeric" min="0" step="1" value="${+it.min||""}" placeholder="e.g. 24"><p class="hint" id="fMinHint"></p></div>
      <div class="err" id="fErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? "Add item" : "Save changes"}</button></div>
    </form>`, p => {
    const getS = () => readSizes(p);
    const unitNow = () => p.querySelector("#fUnit").value || "pcs";
    const qb = qtyBox(p.querySelector("#fQty"), getS, +it.qty||0, t => `Total <b>${t} ${esc(unitNow())}</b>`, unitNow);
    const minHint = () => {
      const m = int(p.querySelector("#fMin").value), s = getS();
      p.querySelector("#fMinU").textContent = unitNow();
      p.querySelector("#fMinHint").textContent = m && (s.pp || s.pc) ? `= ${packText(m, s, unitNow())}` : "Shows a Low alert at this level.";
    };
    const sizeChanged = () => {
      const s = getS();
      p.querySelector("#fSizeHint").textContent = s.bad ? "Enter pieces in 1 packet first, or choose “pieces”." : (sizeText(s, unitNow()) || `Leave empty if you only count single ${unitWord(unitNow())}.`);
      qb.redraw(); minHint();
    };
    ["#fPP","#fPC"].forEach(sel => p.querySelector(sel).addEventListener("input", sizeChanged));
    ["#fPCU","#fUnit"].forEach(sel => p.querySelector(sel).addEventListener("change", sizeChanged));
    p.querySelector("#fMin").addEventListener("input", minHint);
    sizeChanged();
    p.querySelector("#fPicks")?.addEventListener("click", e => {
      const c = e.target.closest("[data-name]"); if (!c) return;
      p.querySelector("#fName").value = c.dataset.name; p.querySelector("#fCat").value = c.dataset.cat;
      p.querySelectorAll("#fPicks .chip").forEach(x => x.setAttribute("aria-pressed", x === c));
    });
    if (!it.name) p.querySelector("#fName").focus();

    p.querySelector("#fItem").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#fErr");
      const name = p.querySelector("#fName").value.trim();
      const s = getS(), qty = qb.total(), min = int(p.querySelector("#fMin").value);
      if (!name) { p.querySelector("#fName").focus(); return err.textContent = "Give the item a name."; }
      if (s.bad) return err.textContent = "Enter how many pieces are in 1 packet, or set the carton in pieces.";
      if (items.some(x => x.name.toLowerCase() === name.toLowerCase() && (isNew || x.id !== it.id))) return err.textContent = `“${name}” is already in your list.`;
      const base = { name, category: p.querySelector("#fCat").value, unit: unitNow(), min, place: p.querySelector("#fPlace").value.trim(), perPacket: s.pp, perCarton: s.pc };
      closeSheet();
      try {
        if (isNew) {
          const id = uid("i");
          await putItem({ id, ...base, qty, createdAt: Date.now(), updatedAt: Date.now() });
          if (qty > 0) await addMove({ id: uid("m"), itemId: id, name, unit: base.unit, type: "received", qty, before: 0, after: qty, note: "Opening stock", at: Date.now() });
          toast(`Added ${name}`);
        } else {
          const before = +it.qty||0;
          await putItem({ ...it, ...base, qty, updatedAt: Date.now() });
          if (qty !== before) await addMove({ id: uid("m"), itemId: it.id, name, unit: base.unit, type: "count", qty: qty - before, before, after: qty, note: "Count corrected", at: Date.now() });
          toast("Saved");
        }
      } catch (e) {}
    });
  });
}

function itemDetail(id){
  const it = items.find(x => x.id === id); if (!it) return;
  const st = status(it), hist = moves.filter(m => m.itemId === id).slice(0, 8), s = sizes(it);
  openSheet(`<h3>${esc(it.name)}</h3>
    <div class="big"><b class="num">${shown(it)}</b><span>${esc(U(it))}</span><span class="pill ${st}">${st==="ok"?"In stock":st==="low"?"Low":"Out"}</span></div>
    ${s.pp || s.pc ? `<p class="pack big-pack">${esc(packText(shown(it), s, U(it)))}</p>` : ""}
    <p class="hint">${esc(it.category)} · warn at ${+it.min||0} ${esc(U(it))}${it.place ? ` · kept at ${esc(it.place)}` : ""}${s.pp||s.pc ? `<br>${esc(sizeText(s, U(it)))}` : ""}</p>
    <div class="moves4">
      <button class="btn move received" type="button" data-batch="received"><span aria-hidden="true">↓</span>New arrival</button>
      <button class="btn move used" type="button" data-batch="used"><span aria-hidden="true">−</span>Use</button>
      <button class="btn move issued" type="button" data-move="issued"><span aria-hidden="true">↑</span>Issue</button>
      <button class="btn move broken" type="button" data-move="broken"><span aria-hidden="true">✕</span>Breakage</button>
    </div>
    <h2 style="font-size:1rem">History</h2>
    ${hist.length ? `<ul class="mini-feed">${hist.map(m => moveLi(m,false)).join("")}</ul>` : `<p class="hint">No changes recorded yet.</p>`}
    <div class="actions"><button class="btn danger" type="button" id="delBtn">Delete</button><button class="btn" type="button" id="editBtn">Edit details</button></div>`,
  p => {
    p.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", () => moveForm(id, b.dataset.move)));
    p.querySelectorAll("[data-batch]").forEach(b => b.addEventListener("click", () => batchForm(b.dataset.batch, id)));
    p.querySelector("#editBtn").addEventListener("click", () => itemForm(it));
    p.querySelector("#delBtn").addEventListener("click", () => confirmDelete(it));
  });
}

/* ---------- New arrival / Use: several items in one go ---------- */
const BATCH = {
  received: { title: "New arrival", help: "Record a delivery. Add each item that arrived, in cartons, packets or pieces.",
              party: ["Supplier", "suppliers", "e.g. ABC Crockery Traders"], save: "Save arrival", verb: "Received" },
  used:     { title: "Use / consume", help: "Record what was used up. Enter pieces, or whole packets and cartons.",
              party: ["Used at", "outlets", "e.g. Kitchen, Rooftop café"], save: "Save", verb: "Used" }
};
function itemOptions(sel){
  const groups = {};
  items.forEach(i => (groups[i.category] ||= []).push(i));
  const order = [...lists.categories.filter(c => groups[c]), ...Object.keys(groups).filter(c => !lists.categories.includes(c)).sort()];
  return order.map(c => `<optgroup label="${esc(c)}">${groups[c].sort((a,b) => a.name.localeCompare(b.name))
    .map(i => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${esc(i.name)} (${shown(i)} ${esc(U(i))})</option>`).join("")}</optgroup>`).join("");
}
let lineSeq = 0;
function batchForm(kind, presetId){
  if (!items.length) { toast("Add an item first."); return itemForm(); }
  const cfg = BATCH[kind], partyList = lists[cfg.party[1]] || [];
  openSheet(`<h3>${cfg.title}</h3>
    <p class="hint">${cfg.help}</p>
    <form id="fBatch" novalidate>
      <div id="lines" class="lines"></div>
      <button type="button" class="btn add-line" id="addLine">＋ Add another item</button>
      <div class="field"><label for="bParty">${cfg.party[0]} <span class="opt">optional</span></label>
        <input id="bParty" maxlength="60" list="bPartyList" autocomplete="off" placeholder="${esc(cfg.party[2])}">${datalist("bPartyList", partyList)}
        ${partyList.length ? `<div class="picks small">${partyList.map(v => `<button type="button" class="chip" data-party="${esc(v)}">${esc(v)}</button>`).join("")}</div>` : ""}
      </div>
      <div class="field"><label for="bNote">Note <span class="opt">optional</span></label><input id="bNote" maxlength="120" placeholder="${kind === "received" ? "e.g. Invoice #1234" : "e.g. Friday dinner service"}"></div>
      <div class="err" id="bErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="bSave">${cfg.save}</button></div>
    </form>`, p => {
    const lines = [];
    const syncRemove = () => lines.forEach(l => l.el.querySelector(".rm").hidden = lines.length === 1);
    const addLine = itemId => {
      const n = ++lineSeq, el = document.createElement("div");
      el.className = "line";
      el.innerHTML = `<div class="line-head">
          <select id="li-${n}" aria-label="Item"><option value="">Choose an item…</option>${itemOptions(itemId)}</select>
          <button type="button" class="btn ghost rm" aria-label="Remove this item">✕</button>
        </div>
        <p class="hint line-have"></p>
        <div class="qbox" id="lq-${n}"></div>`;
      p.querySelector("#lines").append(el);
      const line = { el, itemId: itemId || "", qb: null };
      lines.push(line);
      const mount = () => {
        const it = items.find(x => x.id === line.itemId);
        const old = el.querySelector(".qbox"), box = old.cloneNode(false);   // fresh box, no old listeners
        old.replaceWith(box);
        const have = el.querySelector(".line-have");
        if (!it) { line.qb = null; have.textContent = ""; return; }
        const s = sizes(it), u = U(it), cur = shown(it);
        have.textContent = `${cur} ${u} in stock${s.pp || s.pc ? ` · ${packText(cur, s, u)}` : ""}`;
        line.qb = qtyBox(box, () => s, 0, t => {
          if (!t) return "Enter an amount";
          const after = kind === "received" ? cur + t : cur - t;
          return after < 0 ? `<span class="bad">Only ${cur} ${esc(u)} in stock</span>`
                           : `<b>${t} ${esc(u)}</b> · stock becomes <b>${after} ${esc(u)}</b>`;
        }, () => u, { smallFirst: kind === "used" });
        box.querySelector("input")?.focus();
      };
      el.querySelector("select").addEventListener("change", e => { line.itemId = e.target.value; mount(); });
      el.querySelector(".rm").addEventListener("click", () => { el.remove(); lines.splice(lines.indexOf(line), 1); syncRemove(); });
      mount(); syncRemove();
      if (!itemId) el.querySelector("select").focus();
    };
    addLine(presetId);
    p.querySelector("#addLine").addEventListener("click", () => addLine());
    p.addEventListener("click", e => {
      const c = e.target.closest("[data-party]"); if (!c) return;
      p.querySelector("#bParty").value = c.dataset.party;
      p.querySelectorAll("[data-party]").forEach(x => x.setAttribute("aria-pressed", x === c));
    });

    p.querySelector("#fBatch").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#bErr");
      const chosen = lines.filter(l => l.itemId);
      if (!chosen.length) return err.textContent = "Choose an item.";
      if (chosen.some(l => !l.qb || l.qb.total() < 1)) return err.textContent = "Enter an amount for every item, or remove the empty one.";
      const totals = {};
      chosen.forEach(l => totals[l.itemId] = (totals[l.itemId] || 0) + l.qb.total());
      if (kind === "used") {
        const over = Object.entries(totals).map(([id, n]) => [items.find(x => x.id === id), n]).find(([it, n]) => n > shown(it));
        if (over) return err.textContent = `Only ${shown(over[0])} ${U(over[0])} of ${over[0].name} in stock.`;
      }
      const party = p.querySelector("#bParty").value.trim(), note = p.querySelector("#bNote").value.trim();
      closeSheet();
      const done = [];
      try {
        for (const [id, n] of Object.entries(totals)) {
          await commitNudge(id);
          const r = await applyMove(id, kind, n, note, { party, undoable: false });
          if (r && r.after !== r.before) done.push({ id, ...r });
        }
      } catch (_) {}
      if (!done.length) return;
      const first = items.find(x => x.id === done[0].id);
      const msg = done.length === 1 ? `${cfg.verb} ${totals[done[0].id]} ${U(first)} · ${first.name}` : `${cfg.verb} ${done.length} items`;
      toast(msg, { action: "Undo", onAction: async () => {
        for (const r of done.reverse()) await applyMove(r.id, "count", r.before - r.after, "Undo", { undoable: false });
        toast("Undone");
      }});
    });
  });
}

const MOVE_HELP = {
  received: "New stock that arrived, e.g. supplier delivery.",
  issued: "Stock sent out, e.g. to a banquet or another outlet.",
  broken: "Chipped, cracked or lost pieces to write off."
};
function moveForm(id, type){
  const it = items.find(x => x.id === id); if (!it) return;
  const s = sizes(it), have = shown(it);
  openSheet(`<h3>${esc(it.name)}</h3>
    <p class="hint">${have} ${esc(U(it))} on hand${s.pp||s.pc ? ` · ${esc(packText(have, s, U(it)))}` : ""}</p>
    <form id="fMove" novalidate>
      <div class="seg" role="radiogroup" aria-label="Type of change">
        ${["received","issued","broken"].map(t => `<input type="radio" name="mt" id="mt-${t}" value="${t}" ${t===type?"checked":""}><label for="mt-${t}" class="${t}">${TYPE_LABEL[t]}</label>`).join("")}
      </div>
      <p class="hint" id="mHelp">${MOVE_HELP[type]}</p>
      <fieldset class="qbox-wrap"><legend>How many?</legend><div class="qbox" id="mQty"></div></fieldset>
      <div class="field" id="mPartyBox"></div>
      <div class="field"><label for="mNote">Note <span class="opt">optional</span></label><input id="mNote" maxlength="120" placeholder="e.g. Supplier delivery, banquet hall, dishwasher"></div>
      <div class="err" id="mErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="mSave">Save</button></div>
    </form>`, p => {
    const t = () => p.querySelector("input[name=mt]:checked").value;
    const qb = qtyBox(p.querySelector("#mQty"), () => s, 0, n => {
      if (!n) return `Enter an amount`;
      const after = t() === "received" ? have + n : have - n;
      const u = esc(U(it));
      return after < 0 ? `<span class="bad">Only ${have} ${u} in stock</span>` : `<b>${n} ${u}</b> · stock becomes <b>${after} ${u}</b>`;
    }, () => U(it));
    const drawParty = () => {
      const tt = t(), box = p.querySelector("#mPartyBox");
      const cfg = tt === "received" ? ["Supplier", lists.suppliers, "e.g. ABC Crockery Traders"]
                : tt === "issued"   ? ["Issued to", lists.outlets, "e.g. Banquet hall, Rooftop café"]
                :                     ["Reason", lists.reasons, "e.g. Dropped"];
      box.innerHTML = `<label for="mParty">${cfg[0]} <span class="opt">optional</span></label>
        <input id="mParty" maxlength="60" list="mPartyList" autocomplete="off" placeholder="${esc(cfg[2])}">${datalist("mPartyList", cfg[1])}
        ${cfg[1].length ? `<div class="picks small">${cfg[1].map(v => `<button type="button" class="chip" data-party="${esc(v)}">${esc(v)}</button>`).join("")}</div>` : ""}`;
    };
    drawParty();
    p.querySelector("#mPartyBox").addEventListener("click", e => {
      const c = e.target.closest("[data-party]"); if (!c) return;
      p.querySelector("#mParty").value = c.dataset.party;
      p.querySelectorAll("[data-party]").forEach(x => x.setAttribute("aria-pressed", x === c));
    });
    p.querySelector("#mQty input").focus();
    p.querySelector(".seg").addEventListener("change", () => {
      p.querySelector("#mHelp").textContent = MOVE_HELP[t()]; drawParty();
      p.querySelector("#mQty").dispatchEvent(new Event("input"));
    });
    p.querySelector("#fMove").addEventListener("submit", async e => {
      e.preventDefault();
      const n = qb.total(), err = p.querySelector("#mErr"), type = t();
      if (n < 1) return err.textContent = "Enter at least 1 piece, packet or carton.";
      if (type !== "received" && n > have) return err.textContent = `Only ${have} ${U(it)} in stock.`;
      const note = p.querySelector("#mNote").value.trim(), party = p.querySelector("#mParty").value.trim();
      closeSheet();
      await commitNudge(id);
      try { await applyMove(id, type, n, note, { party }); } catch (e) {}
    });
  });
}

function confirmDelete(it){
  openSheet(`<h3>Delete ${esc(it.name)}?</h3>
    <p>This removes the item from your stock list. Its past activity stays in the log.</p>
    <div class="actions"><button class="btn" type="button" data-close>Keep it</button><button class="btn danger solid" type="button" id="yesDel">Delete item</button></div>`,
  p => p.querySelector("#yesDel").addEventListener("click", async () => {
    closeSheet();
    try { await removeItem(it.id); toast(`Deleted ${it.name}`); } catch (e) {}
  }));
}

let toastT;
function toast(msg, opt = {}){
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${opt.action ? `<button type="button">${esc(opt.action)}</button>` : ""}`;
  t.hidden = false; clearTimeout(toastT);
  if (opt.action) t.querySelector("button").onclick = () => { t.hidden = true; opt.onAction(); };
  toastT = setTimeout(() => t.hidden = true, opt.action ? 6000 : 2600);
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
  else if (act === "clear") { ui.q = ""; ui.cat = "All"; $("#q").value = ""; render(); }
});
$("#addBtn").addEventListener("click", () => itemForm());
$("#actionbar").addEventListener("click", e => { const b = e.target.closest("[data-batch]"); if (b) batchForm(b.dataset.batch); });
$("#q").addEventListener("input", e => { ui.q = e.target.value; renderList(); });
$("#sort").addEventListener("change", e => { ui.sort = e.target.value; renderList(); });
$("#chips").addEventListener("click", e => { const c = e.target.closest("[data-cat]"); if (c) { ui.cat = c.dataset.cat; renderChips(); renderList(); } });
document.querySelector(".tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  $("#layout").dataset.tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
});
$("#summary").addEventListener("click", async e => {
  if (e.target.id !== "copyReorder") return;
  const lines = items.filter(it => status(it) !== "ok").sort((a,b) => a.name.localeCompare(b.name)).map(it => {
    const s = sizes(it), need = Math.max(1, (+it.min||0) * 2 - shown(it));
    const order = s.pc ? plural(Math.ceil(need / s.pc), "carton", "cartons") : s.pp ? plural(Math.ceil(need / s.pp), "packet", "packets") : `${need} ${U(it)}`;
    return `${it.name}: have ${shown(it)} ${U(it)} — order ${order}`;
  });
  const text = "Reorder list\n" + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast("Reorder list copied"); }
  catch (err) { openSheet(`<h3>Reorder list</h3><div class="field"><label for="rl">Select and copy</label><textarea id="rl" rows="8" readonly>${esc(text)}</textarea></div>`, p => p.querySelector("#rl").select()); }
});
setInterval(() => { if (moves.length) renderFeed(); }, 60000);
