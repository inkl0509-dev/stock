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
const TYPE_LABEL = { received:"Received", used:"Used", issued:"Issued", broken:"Broken", count:"Stock count" };
const QUICK_PICKS = [
  ["Water glass","Glassware"],["Wine glass","Glassware"],["Highball glass","Glassware"],["Juice glass","Glassware"],
  ["Espresso cup","Cups & mugs"],["Espresso saucer","Cups & mugs"],["Cappuccino cup","Cups & mugs"],["Tea cup","Cups & mugs"],
  ["Tea spoon","Cutlery"],["Table spoon","Cutlery"],["Dinner fork","Cutlery"],["Dinner knife","Cutlery"],
  ["Dinner plate","Plates & bowls"],["Quarter plate","Plates & bowls"],["Soup bowl","Plates & bowls"]
];
const CODE_FIELDS = [["barcode","pcs","Piece / single"],["barcodePkt","pkt","Packet"],["barcodeCtn","ctn","Carton"]];

let items = [], moves = [], loaded = false;
let unsubs = [];
const ui = { q:"", cat:"All", sort:"attention" };
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
const statusLabel = st => st === "ok" ? "In stock" : st === "low" ? "Low" : "Out";

/* ---------- packing: stock is stored in the item's unit (e.g. pieces) ---------- */
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
const levelName = (per, it) => per === "ctn" ? "carton" : per === "pkt" ? "packet" : (U(it) === "pcs" ? "piece" : U(it));

/* ---------- barcodes ---------- */
const normCode = c => String(c || "").trim().replace(/\s+/g, "").toLowerCase();
function findByCode(code){
  const c = normCode(code); if (!c) return null;
  for (const it of items) for (const [field, per] of CODE_FIELDS) if (it[field] && normCode(it[field]) === c) return { it, per };
  return null;
}
const codesOf = it => CODE_FIELDS.filter(([f]) => it[f]).map(([f, per, label]) => ({ code: it[f], per, label }));

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
    // Remember me ON → stay signed in after closing the browser; OFF → signed out when it closes
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
    p => p.querySelector("#yesOut").addEventListener("click", () => { closeSheet(1, true); signOut(auth); }));
});
$("#lPassToggle").addEventListener("click", () => {
  const i = $("#lPass"), show = i.type === "password";
  i.type = show ? "text" : "password"; $("#lPassToggle").textContent = show ? "Hide" : "Show";
});

async function showAdminLink(){
  try { $("#adminLink").hidden = localStorage.getItem("cs-admin:" + auth.currentUser.uid) !== "1"; } catch (_) {}
  try {
    const r = await api("/api/me");
    $("#adminLink").hidden = !r.admin;
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

/* change stock and log it. received adds; used/issued/broken subtract; count adds n (may be negative) */
async function applyMove(itemId, type, n, note, { party = "", batch = "" } = {}){
  const it = items.find(x => x.id === itemId); if (!it) return null;
  const before = +it.qty||0;
  const after = type === "received" ? before + n : type === "count" ? Math.max(0, before + n) : Math.max(0, before - n);
  if (after === before) return { before, after };
  it.qty = after; render();
  await putItem({ ...it, qty: after, updatedAt: Date.now() });
  await addMove({ id: uid("m"), itemId, name: it.name, unit: U(it), type, qty: type === "count" ? after - before : n,
    before, after, note: note||"", party: party||"", batch: batch||"", by: auth.currentUser?.email || "", at: Date.now() });
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
function render(){ renderSummary(); renderChips(); renderList(); renderFeed(); }

function renderSummary(){
  const low = items.filter(it => status(it) === "low").length;
  const out = items.filter(it => status(it) === "out").length;
  const since = Date.now() - 30*864e5, today = new Date().toDateString();
  const sum = f => moves.filter(f).reduce((a,m) => a + (+m.qty||0), 0);
  const inToday = moves.filter(m => m.type === "received" && new Date(m.at).toDateString() === today).length;
  const outToday = moves.filter(m => ["used","issued"].includes(m.type) && new Date(m.at).toDateString() === today).length;
  const broken = sum(m => m.type === "broken" && m.at >= since);
  $("#summary").innerHTML = `
    <div class="tile"><span class="lab">Items</span><span class="val">${items.length}</span><span class="sub">${items.reduce((a,it)=>a+shown(it),0).toLocaleString()} units on hand</span></div>
    <div class="tile ${low+out?"warn":""}"><span class="lab">Low / out</span><span class="val">${low} / ${out}</span>${low+out?`<button class="link" type="button" id="copyReorder">Copy reorder list</button>`:`<span class="sub">All above minimum</span>`}</div>
    <div class="tile"><span class="lab">Today</span><span class="val">${inToday} <small class="in">in</small> ${outToday} <small class="outw">out</small></span><span class="sub">stock entries</span></div>
    <div class="tile ${broken?"bad":""}"><span class="lab">Broken · 30 days</span><span class="val">${broken}</span><span class="sub">units written off</span></div>`;
}

function renderChips(){
  const counts = {}; items.forEach(i => counts[i.category] = (counts[i.category]||0) + 1);
  const low = items.filter(it => status(it) !== "ok").length;
  const cats = ["All", ...(low ? ["Low stock"] : []), ...lists.categories.filter(c => counts[c]), ...Object.keys(counts).filter(c => !lists.categories.includes(c)).sort()];
  if (!cats.includes(ui.cat)) ui.cat = "All";
  $("#chips").innerHTML = cats.map(c => `<button type="button" class="chip ${c==="Low stock"?"warn":""}" data-cat="${esc(c)}" aria-pressed="${ui.cat===c}">${esc(c)}<span class="c">${c==="All"?items.length:c==="Low stock"?low:counts[c]}</span></button>`).join("");
}

function matches(it, q){
  if (!q) return true;
  const hay = (it.name + " " + it.category + " " + (it.place||"") + " " + CODE_FIELDS.map(([f]) => it[f]||"").join(" ")).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function sorted(){
  const q = ui.q.trim();
  const list = items.filter(it =>
    (ui.cat === "All" || (ui.cat === "Low stock" ? status(it) !== "ok" : it.category === ui.cat)) && matches(it, q));
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
  const list = sorted();
  if (!list.length) { el.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>Try another search or category.</p><button class="btn" type="button" data-act="clear">Clear search</button></div>`; return; }
  el.innerHTML = list.map(it => {
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
  if (["issued","broken","used"].includes(m.type)) return "−" + n;
  return (n>0?"+":n<0?"−":"") + Math.abs(n);
}
const partyWord = t => t === "received" ? "from" : t === "issued" ? "to" : t === "used" ? "at" : "·";
function moveLi(m, withName){
  return `<li><span class="delta ${m.type}">${deltaText(m)}</span><div>
    <div class="what">${withName ? esc(m.name) + " · " : ""}${TYPE_LABEL[m.type] || m.type}${m.party ? ` ${partyWord(m.type)} ${esc(m.party)}` : ""}</div>
    <div class="when">${fmtWhen(m.at)} · now ${m.after} ${esc(m.unit||"pcs")}${m.by ? ` · ${esc(m.by.split("@")[0])}` : ""}</div>
    ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}</div></li>`;
}
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
    if (s.pc) rows.push(["ctn","Cartons",`${s.pc} ${u} each`,b.ctn]);
    if (s.pp) rows.push(["pkt","Packets",`${s.pp} ${u} each`,b.pkt]);
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
function codeFields(it){
  const any = CODE_FIELDS.some(([f]) => it[f]);
  return `<details class="packing" ${any || it._focusCodes ? "open" : ""}>
    <summary>Barcodes <span class="hint">(optional) · scan to fill</span></summary>
    ${CODE_FIELDS.map(([f, per, label]) => `
      <div class="field"><label for="fc-${f}">${label} barcode</label>
        <div class="join"><input id="fc-${f}" data-codefield="${f}" value="${esc(it[f]||"")}" inputmode="text" autocomplete="off" spellcheck="false" placeholder="Scan or type">
        <button type="button" class="btn scan-btn" data-scanfill="${f}" aria-label="Scan ${label.toLowerCase()} barcode">${BARCODE_ICON}<span>Scan</span></button></div>
      </div>`).join("")}
    <p class="hint">Scanning a packet or carton barcode adds a whole packet or carton.</p>
  </details>`;
}

function itemForm(it, preset, { layer = 1, onSaved = null } = {}){
  const isNew = !it;
  it = it || { name: preset?.name || "", category: preset?.cat || (lists.categories.includes(ui.cat) ? ui.cat : (lists.categories[0] || "Other")),
               unit: lists.units[0] || "pcs", qty:0, min:0, place:"" };
  if (preset?.code) { it = { ...it, [CODE_FIELDS.find(c => c[1] === (preset.per || "pcs"))[0]]: preset.code, _focusCodes: true }; }
  openSheet(`<h3>${isNew ? "New item" : "Edit item"}</h3>
    <form id="fItem" novalidate>
      <div class="field"><label for="fName">Item name</label><input id="fName" maxlength="80" value="${esc(it.name)}" placeholder="e.g. Highball glass" autocomplete="off"></div>
      ${isNew ? `<div class="picks small" id="fPicks">${QUICK_PICKS.map(([n,c]) => `<button type="button" class="chip" data-name="${esc(n)}" data-cat="${esc(c)}">${esc(n)}</button>`).join("")}</div>` : ""}
      <div class="grid2">
        <div class="field"><label for="fCat">Category</label><select id="fCat">${options(withCurrent(lists.categories, it.category), it.category)}</select></div>
        <div class="field"><label for="fUnit">Counted in</label><select id="fUnit">${options(withCurrent(lists.units.length ? lists.units : ["pcs"], U(it)), U(it))}</select></div>
      </div>
      <div class="field"><label for="fPlace">Kept at <span class="opt">optional</span></label><input id="fPlace" maxlength="60" value="${esc(it.place||"")}" placeholder="e.g. Bar shelf B" list="placesList" autocomplete="off">${datalist("placesList", lists.places)}</div>
      ${sizeFields(it)}
      ${codeFields(it)}
      ${isNew ? `<fieldset class="qbox-wrap"><legend>How many do you have now?</legend><div class="qbox" id="fQty"></div></fieldset>`
              : `<p class="hint">Current stock: <b>${shown(it)} ${esc(U(it))}</b>. To change it, use Stock in / Stock out, or the − / + count fix.</p>`}
      <div class="field"><label for="fMin">Warn me when stock falls to <span class="opt" id="fMinU">${esc(U(it))}</span></label><input id="fMin" type="number" inputmode="numeric" min="0" step="1" value="${+it.min||""}" placeholder="e.g. 24"><p class="hint" id="fMinHint"></p></div>
      <div class="err" id="fErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? "Add item" : "Save changes"}</button></div>
    </form>`, p => {
    const getS = () => readSizes(p);
    const unitNow = () => p.querySelector("#fUnit").value || "pcs";
    const qb = isNew ? qtyBox(p.querySelector("#fQty"), getS, 0, t => `Total <b>${t} ${esc(unitNow())}</b>`, unitNow) : null;
    const minHint = () => {
      const m = int(p.querySelector("#fMin").value), s = getS();
      p.querySelector("#fMinU").textContent = unitNow();
      p.querySelector("#fMinHint").textContent = m && (s.pp || s.pc) ? `= ${packText(m, s, unitNow())}` : "Shows a Low alert at this level.";
    };
    const sizeChanged = () => {
      const s = getS();
      p.querySelector("#fSizeHint").textContent = s.bad ? "Enter the qty in 1 packet first, or choose “single units”." : (sizeText(s, unitNow()) || `Leave empty if you only count single ${unitWord(unitNow())}.`);
      qb?.redraw(); minHint();
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
    p.querySelectorAll("[data-scanfill]").forEach(b => b.addEventListener("click", () => {
      const input = p.querySelector(`#fc-${b.dataset.scanfill}`);
      openScanner(code => { input.value = code; return { ok: true, text: "Barcode added", close: true }; }, { title: "Scan barcode for this item" });
    }));
    if (!it.name) p.querySelector("#fName").focus();

    p.querySelector("#fItem").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#fErr");
      const name = p.querySelector("#fName").value.trim();
      const s = getS(), qty = qb ? qb.total() : (+it.qty||0), min = int(p.querySelector("#fMin").value);
      if (!name) { p.querySelector("#fName").focus(); return err.textContent = "Give the item a name."; }
      if (s.bad) return err.textContent = "Enter the qty in 1 packet, or set the carton in single units.";
      if (items.some(x => x.name.toLowerCase() === name.toLowerCase() && (isNew || x.id !== it.id))) return err.textContent = `“${name}” is already in your list.`;
      const codes = {};
      for (const [f] of CODE_FIELDS) codes[f] = p.querySelector(`#fc-${f}`).value.trim();
      const filled = Object.values(codes).filter(Boolean).map(normCode);
      if (new Set(filled).size !== filled.length) return err.textContent = "Each barcode can only be used once.";
      for (const c of filled) {
        const owner = findByCode(c);
        if (owner && owner.it.id !== it.id) return err.textContent = `Barcode ${c} already belongs to ${owner.it.name}.`;
      }
      const base = { name, category: p.querySelector("#fCat").value, unit: unitNow(), min, place: p.querySelector("#fPlace").value.trim(),
                     perPacket: s.pp, perCarton: s.pc, ...codes };
      closeSheet(layer, true);
      try {
        let saved;
        if (isNew) {
          const id = uid("i");
          saved = { id, ...base, qty, createdAt: Date.now(), updatedAt: Date.now() };
          items.push(saved);
          await putItem(saved);
          if (qty > 0) await addMove({ id: uid("m"), itemId: id, name, unit: base.unit, type: "received", qty, before: 0, after: qty, note: "Opening stock", party: "", by: auth.currentUser?.email || "", at: Date.now() });
          toast(`Added ${name}`);
        } else {
          const { _focusCodes, ...clean } = it;
          saved = { ...clean, ...base, updatedAt: Date.now() };
          await putItem(saved);
          toast("Saved");
        }
        onSaved && onSaved(saved);
      } catch (e) {}
    });
  }, { layer });
}

/* ---------- item details ---------- */
function itemDetail(id){
  const it = items.find(x => x.id === id); if (!it) return;
  const st = status(it), hist = moves.filter(m => m.itemId === id).slice(0, 8), s = sizes(it), codes = codesOf(it);
  openSheet(`<h3>${esc(it.name)}</h3>
    <div class="big"><b class="num">${shown(it)}</b><span>${esc(U(it))}</span><span class="pill ${st}">${statusLabel(st)}</span></div>
    ${s.pp || s.pc ? `<p class="pack big-pack">${esc(packText(shown(it), s, U(it)))}</p>` : ""}
    <p class="hint">${esc(it.category)} · warn at ${+it.min||0} ${esc(U(it))}${it.place ? ` · kept at ${esc(it.place)}` : ""}${s.pp||s.pc ? `<br>${esc(sizeText(s, U(it)))}` : ""}</p>
    ${codes.length ? `<p class="codes">${codes.map(c => `<span class="code">${BARCODE_ICON}${esc(c.code)} <small>${esc(c.label.split(" ")[0].toLowerCase())}</small></span>`).join("")}</p>` : ""}
    <div class="inout">
      <button class="btn act in" type="button" data-cart="in"><span aria-hidden="true">↓</span>Stock in</button>
      <button class="btn act out" type="button" data-cart="out"><span aria-hidden="true">↑</span>Stock out</button>
    </div>
    <h2 style="font-size:1rem">History</h2>
    ${hist.length ? `<ul class="mini-feed">${hist.map(m => moveLi(m,false)).join("")}</ul>` : `<p class="hint">No changes recorded yet.</p>`}
    <div class="actions"><button class="btn danger" type="button" id="delBtn">Delete</button><button class="btn" type="button" id="editBtn">Edit details${codes.length ? "" : " / add barcode"}</button></div>`,
  p => {
    p.querySelectorAll("[data-cart]").forEach(b => b.addEventListener("click", () => openCart(b.dataset.cart, { itemId: id })));
    p.querySelector("#editBtn").addEventListener("click", () => itemForm(it));
    p.querySelector("#delBtn").addEventListener("click", () => confirmDelete(it));
  });
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
        ${CODE_FIELDS.map(([f, per, label], i) => `<input type="radio" name="ucPer" id="uc-${per}" value="${per}" ${i===0?"checked":""}><label for="uc-${per}">${label.split(" ")[0]}</label>`).join("")}
      </div></div>
    <div class="err" id="ucErr" role="alert"></div>
    <div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn" type="button" id="ucLink">Link barcode</button></div>`,
  p => {
    p.querySelector("#ucNew").addEventListener("click", () => {
      const per = p.querySelector("input[name=ucPer]:checked").value;
      closeSheet(layer, true);
      itemForm(null, { code, per }, { layer, onSaved: it => onResolved && onResolved(it, per) });
    });
    p.querySelector("#ucLink").addEventListener("click", async () => {
      const id = p.querySelector("#ucItem").value, per = p.querySelector("input[name=ucPer]:checked").value;
      const err = p.querySelector("#ucErr");
      if (!id) return err.textContent = "Choose the item this barcode belongs to.";
      const it = items.find(x => x.id === id), field = CODE_FIELDS.find(c => c[1] === per)[0];
      if (it[field] && normCode(it[field]) !== normCode(code)) {
        if (!p.dataset.confirmReplace) { p.dataset.confirmReplace = "1"; return err.textContent = `${it.name} already has ${it[field]} as its ${levelName(per, it)} barcode. Tap “Link barcode” again to replace it.`; }
      }
      closeSheet(layer, true);
      try {
        const updated = { ...it, [field]: code, updatedAt: Date.now() };
        Object.assign(it, updated);
        await putItem(updated);
        toast(`Barcode linked to ${it.name}`);
        onResolved && onResolved(it, per);
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
    pn.querySelector("#cartHelp").textContent = cart.mode === "in" ? "New stock arrived. Scan or search each item, then enter cartons, packets or pieces." : OUT_TYPES[cart.outType].help;
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
        <div class="qbox compact" id="cq-${k}"></div>`;
      pn.querySelector("#cLines").prepend(el);
      line = { id: it.id, el };
      const s = sizes(it), u = U(it);
      line.qb = qtyBox(el.querySelector(".qbox"), () => s, 0, t => {
        const cur = shown(items.find(x => x.id === it.id) || it), out = cart && cart.mode === "out";
        el.querySelector(".cl-have").textContent = `${cur} ${u} in stock${s.pp||s.pc ? ` · ${packText(cur, s, u)}` : ""}`;
        if (!t) return `<span class="muted">Enter how many</span>`;
        const after = out ? cur - t : cur + t;
        return after < 0 ? `<span class="bad">Only ${cur} ${esc(u)} in stock</span>`
                         : `${out ? "−" : "+"}<b>${t} ${esc(u)}</b> → stock <b>${after}</b>`;
      }, () => u, { smallFirst: cart.mode === "out" });
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
    if (hit) { addLine(hit.it, hit.per, 1, { fromScan: true }); beep(true); find.value = ""; showResults(); return; }
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
  const handleUnknown = code => unknownCode(code, { layer: 2, onResolved: (it, p) => addLine(it, p, 1) });

  /* camera scanning: keeps scanning until Done */
  pn.querySelector("#cScan").addEventListener("click", () => {
    const unknown = [];
    openScanner(code => {
      const hit = findByCode(code);
      if (!hit) { if (!unknown.includes(code)) unknown.push(code); return { ok: false, text: `Not found: ${code}. You can set it up after closing the scanner.` }; }
      const line = addLine(hit.it, hit.per, 1, { fromScan: true });
      return { ok: true, text: `+1 ${levelName(hit.per, hit.it)} · ${hit.it.name} (${line.qb.total()} ${U(hit.it)} in list)` };
    }, { title: cart.mode === "in" ? "Scan items coming in" : "Scan items going out", multi: true, onClose: () => { if (unknown.length) handleUnknown(unknown[0]); } });
  });

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
let qr = null, scanCb = null, scanMulti = false, scanOnClose = null, lastCode = "", lastAt = 0;
function loadScript(src){
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
}
function scanMsg(text, cls = ""){ const m = $("#scanMsg"); m.textContent = text; m.className = "scan-msg " + cls; }
async function openScanner(onCode, { title = "Scan barcode", multi = false, onClose = null } = {}){
  scanCb = onCode; scanMulti = multi; scanOnClose = onClose;
  $("#scanTitle").textContent = title;
  $("#scanClose").textContent = multi ? "Done" : "Close";
  $("#scanCount").textContent = ""; $("#scanCount").dataset.n = "0";
  $("#scanCode").value = "";
  scanMsg("Starting camera…");
  $("#scanner").hidden = false; document.body.classList.add("locked");
  try {
    if (!window.Html5Qrcode) await loadScript(QR_URL);
    const F = window.Html5QrcodeSupportedFormats;
    qr = new window.Html5Qrcode("scanRegion", { verbose: false, useBarCodeDetectorIfSupported: true,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX] });
    await qr.start({ facingMode: "environment" }, {
      fps: 12,
      qrbox: (w, h) => ({ width: Math.max(160, Math.floor(Math.min(w * 0.86, 360))), height: Math.max(90, Math.floor(Math.min(h * 0.42, 190))) })
    }, onDecoded, () => {});
    if ($("#scanner").hidden) return stopCamera();
    scanMsg(multi ? "Point at a barcode. Keep scanning, then tap Done." : "Point the camera at a barcode.");
  } catch (e) {
    const m = String(e?.name || e?.message || e);
    scanMsg(/NotAllowed|Permission|denied/i.test(m) ? "Camera access is blocked. Allow the camera for this site in your browser settings, or type the barcode below."
      : /NotFound|Overconstrained|no camera/i.test(m) ? "No camera found. Type the barcode below, or use a handheld scanner."
      : !window.Html5Qrcode ? "The camera scanner needs internet the first time. Type the barcode below."
      : "Couldn't start the camera. Type the barcode below.", "warn");
    await stopCamera();
    $("#scanCode").focus();
  }
}
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
  try { await q.stop(); } catch (_) {}
  try { q.clear(); } catch (_) {}
}
async function closeScanner(){
  $("#scanner").hidden = true;
  const cb = scanOnClose; scanCb = null; scanOnClose = null; lastCode = "";
  await stopCamera();
  if ($("#sheet").hidden && $("#sheet2").hidden) document.body.classList.remove("locked");
  cb && cb();
}
$("#scanClose").addEventListener("click", closeScanner);
$("#scanManual").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#scanCode").value.trim(); if (!v) return;
  $("#scanCode").value = "";
  deliverCode(v);
});

/* scan from the main screen: open the item, or set up an unknown barcode */
function scanToFind(){
  openScanner(code => {
    const hit = findByCode(code);
    if (hit) { setTimeout(() => itemDetail(hit.it.id), 0); return { ok: true, text: hit.it.name, close: true }; }
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
      if (hit) { cart.addLine(hit.it, hit.per, 1, { fromScan: true }); beep(true); }
      else { beep(false); unknownCode(code, { layer: 2, onResolved: (it, p) => cart?.addLine(it, p, 1) }); }
      return;
    }
    if (!$("#sheet").hidden) return;
    if (hit) { beep(true); itemDetail(hit.it.id); }
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
  else if (act === "clear") { ui.q = ""; ui.cat = "All"; $("#q").value = ""; render(); }
});
$("#addBtn").addEventListener("click", () => itemForm());
$("#actionbar").addEventListener("click", e => {
  const b = e.target.closest("[data-cart],[data-scanfind]"); if (!b) return;
  if (b.dataset.scanfind !== undefined) scanToFind(); else openCart(b.dataset.cart);
});
$("#mainScan").addEventListener("click", scanToFind);
$("#q").addEventListener("input", e => { ui.q = e.target.value; renderList(); });
$("#q").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const hit = findByCode(e.target.value);
  if (hit) { e.preventDefault(); beep(true); e.target.value = ""; ui.q = ""; renderList(); itemDetail(hit.it.id); }
});
$("#sort").addEventListener("change", e => { ui.sort = e.target.value; renderList(); });
$("#chips").addEventListener("click", e => { const c = e.target.closest("[data-cat]"); if (c) { ui.cat = c.dataset.cat; renderChips(); renderList(); } });
document.querySelector(".tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  $("#layout").dataset.tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
});
$("#summary").addEventListener("click", async e => {
  if (e.target.id !== "copyReorder") return;
  const lines = items.filter(it => status(it) !== "ok").sort(byName).map(it => {
    const s = sizes(it), need = Math.max(1, (+it.min||0) * 2 - shown(it));
    const order = s.pc ? plural(Math.ceil(need / s.pc), "carton", "cartons") : s.pp ? plural(Math.ceil(need / s.pp), "packet", "packets") : `${need} ${U(it)}`;
    return `${it.name}: have ${shown(it)} ${U(it)} — order ${order}`;
  });
  const text = "Reorder list\n" + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast("Reorder list copied"); }
  catch (err) { openSheet(`<h3>Reorder list</h3><div class="field"><label for="rl">Select and copy</label><textarea id="rl" rows="8" readonly>${esc(text)}</textarea></div>`, p => p.querySelector("#rl").select()); }
});
setInterval(() => { if (moves.length) renderFeed(); }, 60000);
