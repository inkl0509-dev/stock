import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Firebase ---------- */
const fbApp = initializeApp(firebaseConfig);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) // works offline, syncs when back online
});
const auth = getAuth(fbApp);

/* ---------- constants & state ---------- */
const CATS = ["Glassware","Cutlery","Cups & mugs","Plates & bowls","Serveware","Other"];
const UNITS = ["pcs","dozen","sets"];
const TYPE_LABEL = { received:"Received", issued:"Issued", broken:"Broken", count:"Stock count" };

let items = [], moves = [], loaded = false;
let unsubs = [];
const ui = { q:"", cat:"All", sort:"attention" };
const pending = {};   // quick +/- taps waiting to be saved
const chains = {};    // one write at a time per document

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,7);

const shown = it => Math.max(0, (+it.qty||0) + (pending[it.id]?.delta||0));
function status(it){ const q = shown(it), m = +it.min||0; return q<=0 ? "out" : q<=m ? "low" : "ok"; }

/* ---------- auth ---------- */
onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  if (user) {
    $("#loginView").hidden = true; $("#appView").hidden = false;
    startData();
  } else {
    items = []; moves = []; loaded = false;
    $("#appView").hidden = true; $("#loginView").hidden = false;
    $("#lEmail").focus();
  }
});

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#lEmail").value.trim(), pass = $("#lPass").value, err = $("#lErr");
  if (!email || !pass) return err.textContent = "Enter your email and password.";
  err.textContent = ""; $("#lBtn").disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (ex) {
    err.textContent = ex.code === "auth/too-many-requests"
      ? "Too many attempts. Wait a minute and try again."
      : ex.code === "auth/network-request-failed"
      ? "No internet connection."
      : "Wrong email or password.";
  } finally { $("#lBtn").disabled = false; }
});
$("#outBtn").addEventListener("click", () => signOut(auth));

/* ---------- data ---------- */
function setSync(text, cls){ const s = $("#sync"); s.textContent = text; s.className = "sync " + (cls||""); }

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
const putItem   = it => { const { id, ...body } = it; return chain("i/"+id, () => setDoc(doc(db,"items",id), body)).catch(writeErr); };
const removeItem = id => chain("i/"+id, () => deleteDoc(doc(db,"items",id))).catch(writeErr);
const addMove   = m  => { const { id, ...body } = m; return setDoc(doc(db,"moves",id), body).catch(writeErr); };

async function applyMove(itemId, type, n, note){
  const it = items.find(x => x.id === itemId); if (!it) return;
  const before = +it.qty||0;
  const after = type === "received" ? before + n : Math.max(0, before - n);
  it.qty = after; render();
  await putItem({ ...it, qty: after, updatedAt: Date.now() });
  await addMove({ id: uid("m"), itemId, name: it.name, unit: it.unit||"pcs", type, qty: n, before, after, note: note||"", at: Date.now() });
}

/* quick +/- : taps are combined into one saved change */
function nudge(id, d){
  const it = items.find(x => x.id === id); if (!it) return;
  const p = pending[id] || (pending[id] = { delta:0, t:null });
  if ((+it.qty||0) + p.delta + d < 0) return;
  p.delta += d; clearTimeout(p.t);
  p.t = setTimeout(() => commitNudge(id), 800);
  render();
}
async function commitNudge(id){
  const p = pending[id]; if (!p) return;
  clearTimeout(p.t); delete pending[id];
  if (!p.delta) return render();
  const it = items.find(x => x.id === id); if (!it) return;
  const before = +it.qty||0, after = Math.max(0, before + p.delta);
  it.qty = after; render();
  try {
    await putItem({ ...it, qty: after, updatedAt: Date.now() });
    await addMove({ id: uid("m"), itemId: id, name: it.name, unit: it.unit||"pcs", type: "count", qty: after - before, before, after, note: "Quick adjust", at: Date.now() });
  } catch (e) {}
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
    <div class="tile"><span class="lab">Pieces on hand</span><span class="val">${pieces.toLocaleString()}</span><span class="sub">all items</span></div>
    <div class="tile ${low+out?"warn":""}"><span class="lab">Low / out</span><span class="val">${low} / ${out}</span>${low+out?`<button class="link" type="button" id="copyReorder">Copy reorder list</button>`:`<span class="sub">All above minimum</span>`}</div>
    <div class="tile ${broken?"bad":""}"><span class="lab">Broken · 30 days</span><span class="val">${broken}</span><span class="sub">pieces written off</span></div>`;
}

function renderChips(){
  const counts = {}; items.forEach(i => counts[i.category] = (counts[i.category]||0) + 1);
  const cats = ["All", ...CATS.filter(c => counts[c])];
  if (!cats.includes(ui.cat)) ui.cat = "All";
  $("#chips").innerHTML = cats.map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${ui.cat===c}">${esc(c)}<span class="c">${c==="All"?items.length:counts[c]}</span></button>`).join("");
}

function sorted(){
  const q = ui.q.trim().toLowerCase();
  const list = items.filter(it => (ui.cat === "All" || it.category === ui.cat) &&
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
    el.innerHTML = `<div class="empty"><h3>No items yet</h3><p>Add what you keep in stock: water glasses, dinner forks, espresso cups.</p><button class="btn primary" type="button" data-act="add">＋ Add first item</button></div>`;
    return;
  }
  const list = sorted();
  if (!list.length) { el.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>Try another search or category.</p></div>`; return; }
  el.innerHTML = list.map(it => {
    const st = status(it), q = shown(it), m = +it.min||0;
    const pct = Math.min(100, m ? (q/(m*2))*100 : (q?100:0));
    return `<div class="row ${st} ${pending[it.id]?"pending":""}">
      <span class="stripe" aria-hidden="true"></span>
      <button type="button" class="main" data-act="open" data-id="${it.id}">
        <span class="name">${esc(it.name)}</span>
        <span class="meta"><span class="pill ${st}">${st==="ok"?"In stock":st==="low"?"Low":"Out"}</span>${esc(it.category)} · min ${m}${it.place?` · ${esc(it.place)}`:""}</span>
        <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      </button>
      <div class="ctrl">
        <button type="button" class="step" data-act="dec" data-id="${it.id}" aria-label="Remove one ${esc(it.name)}">−</button>
        <span class="qty"><b>${q}</b><small>${esc(it.unit||"pcs")}</small></span>
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
  if (m.type === "issued" || m.type === "broken") return "−" + n;
  return (n>0?"+":n<0?"−":"") + Math.abs(n);
}
function moveLi(m, withName){
  return `<li><span class="delta ${m.type}">${deltaText(m)}</span><div>
    <div class="what">${withName ? esc(m.name) + " · " : ""}${TYPE_LABEL[m.type] || m.type}</div>
    <div class="when">${fmtWhen(m.at)} · now ${m.after} ${esc(m.unit||"")}</div>
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
  mount && mount($("#panel"));
  const f = $("#panel").querySelector("input,select,textarea,.btn:not(.x)"); f && f.focus();
}
function closeSheet(){ $("#sheet").hidden = true; $("#panel").innerHTML = ""; lastFocus?.focus?.(); }
$("#sheet").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

function itemForm(it){
  const isNew = !it;
  it = it || { name:"", category: ui.cat !== "All" ? ui.cat : "Glassware", qty:0, min:0, unit:"pcs", place:"" };
  openSheet(`<h3>${isNew ? "Add item" : "Edit item"}</h3>
    <form id="fItem" novalidate>
      <div class="field"><label for="fName">Item name</label><input id="fName" maxlength="80" value="${esc(it.name)}" placeholder="e.g. Highball glass"></div>
      <div class="grid2">
        <div class="field"><label for="fCat">Category</label><select id="fCat">${CATS.map(c => `<option ${c===it.category?"selected":""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label for="fUnit">Counted in</label><select id="fUnit">${UNITS.map(u => `<option ${u===it.unit?"selected":""}>${u}</option>`).join("")}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="fQty">${isNew ? "Opening stock" : "Current count"}</label><input id="fQty" type="number" inputmode="numeric" min="0" step="1" value="${+it.qty||0}"></div>
        <div class="field"><label for="fMin">Minimum level</label><input id="fMin" type="number" inputmode="numeric" min="0" step="1" value="${+it.min||0}"></div>
      </div>
      <div class="field"><label for="fPlace">Kept at (optional)</label><input id="fPlace" maxlength="60" value="${esc(it.place||"")}" placeholder="e.g. Bar shelf B"></div>
      <p class="hint">You'll see a Low alert when the count drops to the minimum level.</p>
      <div class="err" id="fErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? "Add item" : "Save changes"}</button></div>
    </form>`, p => {
    p.querySelector("#fItem").addEventListener("submit", async e => {
      e.preventDefault();
      const name = p.querySelector("#fName").value.trim();
      const qty = Number(p.querySelector("#fQty").value), min = Number(p.querySelector("#fMin").value);
      const err = p.querySelector("#fErr");
      if (!name) return err.textContent = "Give the item a name.";
      if (!Number.isInteger(qty) || qty < 0) return err.textContent = "Count must be a whole number, 0 or more.";
      if (!Number.isInteger(min) || min < 0) return err.textContent = "Minimum must be a whole number, 0 or more.";
      if (items.some(x => x.name.toLowerCase() === name.toLowerCase() && (isNew || x.id !== it.id))) return err.textContent = "An item with this name already exists.";
      const base = { name, category: p.querySelector("#fCat").value, unit: p.querySelector("#fUnit").value, min, place: p.querySelector("#fPlace").value.trim() };
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
  const st = status(it), hist = moves.filter(m => m.itemId === id).slice(0, 8);
  openSheet(`<h3>${esc(it.name)}</h3>
    <div class="big"><b class="num">${shown(it)}</b><span>${esc(it.unit||"pcs")}</span><span class="pill ${st}">${st==="ok"?"In stock":st==="low"?"Low":"Out"}</span></div>
    <p class="hint">${esc(it.category)} · minimum ${+it.min||0}${it.place ? ` · kept at ${esc(it.place)}` : ""}</p>
    <div class="moves3">
      <button class="btn" type="button" data-move="received">Receive</button>
      <button class="btn" type="button" data-move="issued">Issue</button>
      <button class="btn danger" type="button" data-move="broken">Breakage</button>
    </div>
    <h2 style="font-size:1rem">History</h2>
    ${hist.length ? `<ul class="mini-feed">${hist.map(m => moveLi(m,false)).join("")}</ul>` : `<p class="hint">No changes recorded yet.</p>`}
    <div class="actions"><button class="btn danger" type="button" id="delBtn">Delete</button><button class="btn" type="button" id="editBtn">Edit details</button></div>`,
  p => {
    p.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", () => moveForm(id, b.dataset.move)));
    p.querySelector("#editBtn").addEventListener("click", () => itemForm(it));
    p.querySelector("#delBtn").addEventListener("click", () => confirmDelete(it));
  });
}

function moveForm(id, type){
  const it = items.find(x => x.id === id); if (!it) return;
  openSheet(`<h3>Record stock change</h3>
    <p class="hint">${esc(it.name)} · ${shown(it)} ${esc(it.unit||"pcs")} on hand</p>
    <form id="fMove" novalidate>
      <div class="seg" role="radiogroup" aria-label="Type of change">
        ${["received","issued","broken"].map(t => `<input type="radio" name="mt" id="mt-${t}" value="${t}" ${t===type?"checked":""}><label for="mt-${t}">${TYPE_LABEL[t]}</label>`).join("")}
      </div>
      <div class="field"><label for="mQty">Quantity (${esc(it.unit||"pcs")})</label><input id="mQty" type="number" inputmode="numeric" min="1" step="1" placeholder="0"></div>
      <div class="field"><label for="mNote">Note (optional)</label><input id="mNote" maxlength="120" placeholder="e.g. Supplier delivery, banquet hall, dishwasher"></div>
      <div class="err" id="mErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save change</button></div>
    </form>`, p => {
    p.querySelector("#mQty").focus();
    p.querySelector("#fMove").addEventListener("submit", async e => {
      e.preventDefault();
      const t = p.querySelector("input[name=mt]:checked").value;
      const n = Number(p.querySelector("#mQty").value), err = p.querySelector("#mErr");
      if (!Number.isInteger(n) || n < 1) return err.textContent = "Enter a whole number, 1 or more.";
      if (t !== "received" && n > shown(it)) return err.textContent = `Only ${shown(it)} ${it.unit||"pcs"} in stock.`;
      const note = p.querySelector("#mNote").value.trim();
      closeSheet();
      await commitNudge(id);
      try { await applyMove(id, t, n, note); toast(`${TYPE_LABEL[t]} ${n} ${it.name}`); } catch (e) {}
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
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }

/* ---------- events ---------- */
$("#list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const { act, id } = b.dataset;
  if (act === "inc") nudge(id, 1);
  else if (act === "dec") nudge(id, -1);
  else if (act === "open") itemDetail(id);
  else if (act === "add") itemForm();
});
$("#addBtn").addEventListener("click", () => itemForm());
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
  const lines = items.filter(it => status(it) !== "ok").sort((a,b) => a.name.localeCompare(b.name))
    .map(it => `${it.name}: ${shown(it)} ${it.unit||"pcs"} (min ${+it.min||0}) — order ${Math.max(1, (+it.min||0)*2 - shown(it))}`);
  const text = "Reorder list\n" + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast("Reorder list copied"); }
  catch (err) { openSheet(`<h3>Reorder list</h3><div class="field"><label for="rl">Select and copy</label><textarea id="rl" rows="8" readonly>${esc(text)}</textarea></div>`, p => p.querySelector("#rl").select()); }
});
setInterval(() => { if (moves.length) renderFeed(); }, 60000);
