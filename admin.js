import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { fbApp, auth, api } from "./firebase.js";
import "./pwa.js";

const db = getFirestore(fbApp);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let users = [], meUid = null, q = "";

onAuthStateChanged(auth, user => {
  if (!user) { location.replace("/"); return; }
  $("#whoAdmin").textContent = "Signed in as " + user.email;
  start();
});

async function start(){
  // Make sure the sign-in token carries the admin role (needed to save lists)
  try {
    const r = await api("/api/me");
    if (r.admin) { const t = await auth.currentUser.getIdTokenResult(); if (t.claims.admin !== true) await auth.currentUser.getIdToken(true); }
  } catch (_) {}
  load();
  watchLists();
}

/* ---------- tabs ---------- */
document.querySelector(".admin-tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-atab]"); if (!b) return;
  const tab = b.dataset.atab;
  document.querySelectorAll("[data-atab]").forEach(x => x.setAttribute("aria-selected", x === b));
  $("#usersPane").hidden = tab !== "users";
  $("#listsPane").hidden = tab !== "lists";
  $("#addUser").hidden = tab !== "users";
  $("#refreshUsers").hidden = tab !== "users";
  try { history.replaceState(null, "", tab === "lists" ? "#lists" : "#users"); } catch (_) {}
});
if (location.hash === "#lists") document.querySelector('[data-atab="lists"]').click();

/* ---------- lists & settings ---------- */
const LIST_DEFS = [
  { key: "units",      title: "Counted in",          help: "Units an item can be counted in.",                      ph: "e.g. pairs",          def: ["pcs","sets","pairs","dozen"] },
  { key: "categories", title: "Categories",          help: "Groups for the stock list filters.",                    ph: "e.g. Bar tools",      def: ["Glassware","Cutlery","Cups & mugs","Plates & bowls","Serveware","Other"] },
  { key: "places",     title: "Storage places",      help: "Where items are kept (shown as “Kept at”).",            ph: "e.g. Bar shelf B",    def: [] },
  { key: "suppliers",  title: "Suppliers",           help: "Picked when you record stock received.",                ph: "e.g. ABC Crockery",   def: [] },
  { key: "outlets",    title: "Outlets / issued to", help: "Picked when you issue stock out.",                      ph: "e.g. Banquet hall",   def: [] },
  { key: "reasons",    title: "Breakage reasons",    help: "Picked when you record breakage.",                      ph: "e.g. Dishwasher",     def: ["Dropped","Dishwasher","Chipped / cracked","Lost","Guest breakage"] }
];
let listData = null, saving = Promise.resolve();
const listsRef = () => doc(db, "settings", "lists");

function watchLists(){
  onSnapshot(listsRef(), snap => {
    const d = snap.data() || {};
    listData = {};
    for (const def of LIST_DEFS) listData[def.key] = Array.isArray(d[def.key]) ? d[def.key] : def.def;
    renderLists();
  }, e => {
    $("#listsBox").innerHTML = `<div class="notice"><b>Couldn't load lists.</b><span>${esc(e.code === "permission-denied" ? "Update your Firestore rules from firestore.rules, then reload." : e.message)}</span></div>`;
  });
}

function renderLists(){
  const open = document.activeElement?.dataset?.addfor; // keep focus in the input you were typing in
  $("#listsBox").innerHTML = LIST_DEFS.map(def => {
    const arr = listData[def.key];
    return `<section class="lcard">
      <div class="lhead"><h2>${esc(def.title)}</h2><span class="hint">${arr.length}</span></div>
      <p class="hint">${esc(def.help)}</p>
      <ul class="tags">${arr.length ? arr.map((v,i) => `<li><span>${esc(v)}</span>
        <button type="button" class="tagbtn" data-up="${def.key}" data-i="${i}" aria-label="Move ${esc(v)} up" ${i===0?"disabled":""}>↑</button>
        <button type="button" class="tagbtn" data-del="${def.key}" data-i="${i}" aria-label="Remove ${esc(v)}">✕</button></li>`).join("")
        : `<li class="none">Nothing yet</li>`}</ul>
      <form class="join" data-form="${def.key}" novalidate>
        <input data-addfor="${def.key}" maxlength="40" placeholder="${esc(def.ph)}" aria-label="Add to ${esc(def.title)}">
        <button class="btn" type="submit">Add</button>
      </form>
    </section>`;
  }).join("");
  if (open) { const i = $(`[data-addfor="${open}"]`); i && i.focus(); }
}

function saveList(key, arr, msg){
  listData[key] = arr; renderLists();
  saving = saving.then(() => setDoc(listsRef(), { [key]: arr, updatedAt: Date.now() }, { merge: true }))
    .then(() => toast(msg))
    .catch(e => toast(e.code === "permission-denied" ? "Only admins can change lists. Sign out and in again if you were just made admin." : "Couldn't save. Try again."));
}

$("#listsBox").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.closest("[data-form]"); if (!f) return;
  const key = f.dataset.form, input = f.querySelector("input"), v = input.value.trim().replace(/\s+/g, " ");
  if (!v) return;
  const arr = listData[key];
  if (arr.some(x => x.toLowerCase() === v.toLowerCase())) { toast(`“${v}” is already in the list`); return; }
  input.value = "";
  saveList(key, [...arr, v], `Added ${v}`);
});
$("#listsBox").addEventListener("click", e => {
  const del = e.target.closest("[data-del]"), up = e.target.closest("[data-up]");
  if (del) {
    const key = del.dataset.del, i = +del.dataset.i, arr = [...listData[key]], [v] = arr.splice(i, 1);
    saveList(key, arr, `Removed ${v}. Items already using it keep it.`);
  } else if (up) {
    const key = up.dataset.up, i = +up.dataset.i, arr = [...listData[key]];
    [arr[i-1], arr[i]] = [arr[i], arr[i-1]];
    saveList(key, arr, "Order saved");
  }
});

function notice(html){ const n = $("#notice"); n.hidden = !html; n.innerHTML = html || ""; }

async function load(){
  const btn = $("#refreshUsers"); btn.disabled = true;
  try {
    const r = await api("/api/users");
    users = r.users; meUid = r.me;
    notice(""); $("#addUser").disabled = false;
    render();
  } catch (e) {
    $("#addUser").disabled = true;
    $("#ulist").innerHTML = "";
    if (e.status === 403) notice(`<b>Admins only.</b><span>Your account can update stock but can't manage users. Ask an admin for access.</span>`);
    else if (e.status === 404) notice(`<b>User management isn't available here.</b><span>It runs on Vercel. Deploy the project to Vercel (the <code>/api</code> folder) to use this page.</span>`);
    else if (!navigator.onLine) notice(`<b>You're offline.</b><span>Connect to the internet to manage users.</span>`);
    else notice(`<b>Couldn't load users.</b><span>${esc(e.message)}</span>`);
  } finally { btn.disabled = false; }
}

const fmtDate = s => s ? new Date(s).toLocaleDateString([], { day:"numeric", month:"short", year:"numeric" }) : "never";
const initials = u => (u.name || u.email || "?").trim().split(/[\s@.]+/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join("");

function render(){
  const term = q.trim().toLowerCase();
  const list = users.filter(u => !term || (u.name + " " + u.email).toLowerCase().includes(term));
  if (!list.length) {
    $("#ulist").innerHTML = `<li style="display:block"><div class="empty"><h3>${users.length ? "No one matches" : "No users yet"}</h3></div></li>`;
    return;
  }
  $("#ulist").innerHTML = list.map(u => `
    <li class="${u.disabled ? "off" : ""}">
      <span class="avatar" aria-hidden="true">${esc(initials(u))}</span>
      <div style="min-width:0">
        <div class="uname">${esc(u.name || u.email)}${u.uid === meUid ? ` <span class="hint">(you)</span>` : ""}</div>
        <div class="umeta">
          <span class="pill ${u.admin ? "admin" : "staff"}">${u.admin ? "Admin" : "Staff"}</span>
          ${u.disabled ? `<span class="pill off">Disabled</span>` : ""}
          ${u.name ? `<span>${esc(u.email)}</span> ·` : ""}
          <span>Last sign-in ${fmtDate(u.lastSignIn)}</span>
        </div>
      </div>
      <div class="uact"><button class="btn sm" type="button" data-manage="${u.uid}">Manage</button></div>
    </li>`).join("");
}

/* ---------- sheets ---------- */
function openSheet(html, mount){
  $("#panel").innerHTML = `<button type="button" class="btn ghost x" data-close aria-label="Close">✕</button>` + html;
  $("#sheet").hidden = false; document.body.classList.add("locked");
  mount && mount($("#panel"));
}
function closeSheet(){ $("#sheet").hidden = true; $("#panel").innerHTML = ""; document.body.classList.remove("locked"); }
$("#sheet").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

let toastT;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3000); }

function makePassword(){
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  return Array.from(a, n => chars[n % chars.length]).join("");
}
async function copy(text){
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch (_) { toast("Select the text and copy it"); }
}
function passwordField(id, label){
  return `<div class="field"><label for="${id}">${label}</label>
    <div class="join"><input id="${id}" type="text" autocomplete="new-password" minlength="6" spellcheck="false">
    <button type="button" class="btn" data-gen="${id}">Generate</button><button type="button" class="btn" data-copy="${id}">Copy</button></div>
    <p class="hint">At least 6 characters. Share it with the person so they can sign in.</p></div>`;
}
function wirePassword(p){
  p.querySelectorAll("[data-gen]").forEach(b => b.addEventListener("click", () => { p.querySelector("#" + b.dataset.gen).value = makePassword(); }));
  p.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy(p.querySelector("#" + b.dataset.copy).value)));
}
function busy(btn, text){ btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = text; return () => { btn.disabled = false; btn.textContent = btn.dataset.t; }; }

/* add user */
$("#addUser").addEventListener("click", () => {
  openSheet(`<h3>Add user</h3>
    <form id="fAdd" novalidate>
      <div class="field"><label for="aName">Name <span class="opt">optional</span></label><input id="aName" maxlength="60" placeholder="e.g. Ahmed (store keeper)"></div>
      <div class="field"><label for="aEmail">Email</label><input id="aEmail" type="email" inputmode="email" autocomplete="off" placeholder="name@example.com"></div>
      ${passwordField("aPass","Password")}
      <fieldset class="qbox-wrap"><legend>Access</legend>
        <div class="radio-cards">
          <label><input type="radio" name="role" value="staff" checked><span><b>Staff</b><small>Updates stock</small></span></label>
          <label><input type="radio" name="role" value="admin"><span><b>Admin</b><small>Stock + manage users</small></span></label>
        </div>
      </fieldset>
      <div class="err" id="aErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="aBtn">Add user</button></div>
    </form>`, p => {
    wirePassword(p);
    p.querySelector("#aPass").value = makePassword();
    p.querySelector("#aName").focus();
    p.querySelector("#fAdd").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#aErr");
      const body = {
        name: p.querySelector("#aName").value.trim(),
        email: p.querySelector("#aEmail").value.trim(),
        password: p.querySelector("#aPass").value,
        role: p.querySelector("input[name=role]:checked").value
      };
      if (!body.email.includes("@")) return err.textContent = "Enter a valid email.";
      if (body.password.length < 6) return err.textContent = "Password must be at least 6 characters.";
      const done = busy(p.querySelector("#aBtn"), "Adding…");
      try {
        const r = await api("/api/users", { method: "POST", body });
        users.push(r.user); users.sort((a,b) => a.email.localeCompare(b.email)); render();
        showCredentials(body.email, body.password, "User added");
      } catch (ex) { err.textContent = ex.message; done(); }
    });
  });
});

function showCredentials(email, pass, title){
  const text = `Crockery Stock login\n${location.origin}\nEmail: ${email}\nPassword: ${pass}`;
  openSheet(`<h3>${esc(title)}</h3>
    <p>Send these sign-in details to the person:</p>
    <div class="field"><label for="cred">Sign-in details</label><textarea id="cred" rows="4" readonly>${esc(text)}</textarea></div>
    <div class="actions"><button class="btn" type="button" id="cCopy">Copy details</button><button class="btn primary" type="button" data-close>Done</button></div>`,
  p => p.querySelector("#cCopy").addEventListener("click", () => copy(text)));
}

/* manage user */
$("#ulist").addEventListener("click", e => {
  const b = e.target.closest("[data-manage]"); if (!b) return;
  const u = users.find(x => x.uid === b.dataset.manage); if (!u) return;
  const self = u.uid === meUid, locked = self || u.owner;
  openSheet(`<h3>${esc(u.name || u.email)}</h3>
    <p class="hint">${esc(u.email)} · added ${fmtDate(u.created)} · last sign-in ${fmtDate(u.lastSignIn)}</p>
    ${u.owner ? `<p class="hint">Main admin (set in ADMIN_EMAILS on Vercel). Access can't be removed here.</p>` : ""}
    <form id="fName" novalidate class="field">
      <label for="mName">Name</label>
      <div class="join"><input id="mName" maxlength="60" value="${esc(u.name)}"><button class="btn" type="submit">Save</button></div>
    </form>
    <fieldset class="qbox-wrap"><legend>Access</legend>
      <div class="radio-cards">
        <label><input type="radio" name="mrole" value="staff" ${!u.admin ? "checked" : ""} ${locked ? "disabled" : ""}><span><b>Staff</b><small>Updates stock</small></span></label>
        <label><input type="radio" name="mrole" value="admin" ${u.admin ? "checked" : ""} ${locked ? "disabled" : ""}><span><b>Admin</b><small>Stock + manage users</small></span></label>
      </div>
    </fieldset>
    <form id="fPass" novalidate>
      ${passwordField("mPass","Set a new password")}
      <div class="actions"><button class="btn" type="submit" id="pBtn">Reset password</button></div>
    </form>
    <div class="err" id="mErr" role="alert"></div>
    ${locked ? "" : `<div class="actions">
      <button class="btn" type="button" id="mDisable">${u.disabled ? "Enable sign-in" : "Disable sign-in"}</button>
      <button class="btn danger" type="button" id="mDelete">Delete user</button></div>`}`,
  p => {
    wirePassword(p);
    const err = p.querySelector("#mErr");
    const patch = async (body, okMsg) => {
      err.textContent = "";
      try {
        const r = await api("/api/users", { method: "PATCH", body: { uid: u.uid, ...body } });
        Object.assign(u, r.user); render(); toast(okMsg); return true;
      } catch (ex) { err.textContent = ex.message; return false; }
    };
    p.querySelector("#fName").addEventListener("submit", async e => { e.preventDefault(); await patch({ name: p.querySelector("#mName").value }, "Name saved"); });
    p.querySelectorAll("input[name=mrole]").forEach(r => r.addEventListener("change", async () => {
      const ok = await patch({ role: r.value }, r.value === "admin" ? "Now an admin" : "Now staff");
      if (!ok) p.querySelector(`input[name=mrole][value=${u.admin ? "admin" : "staff"}]`).checked = true;
    }));
    p.querySelector("#fPass").addEventListener("submit", async e => {
      e.preventDefault();
      const pass = p.querySelector("#mPass").value;
      if (pass.length < 6) return err.textContent = "Password must be at least 6 characters.";
      const done = busy(p.querySelector("#pBtn"), "Saving…");
      if (await patch({ password: pass }, "Password changed")) showCredentials(u.email, pass, "Password changed");
      else done();
    });
    p.querySelector("#mDisable")?.addEventListener("click", async () => {
      if (await patch({ disabled: !u.disabled }, u.disabled ? "Sign-in disabled" : "Sign-in enabled")) closeSheet();
    });
    p.querySelector("#mDelete")?.addEventListener("click", () => confirmDelete(u));
  });
});

function confirmDelete(u){
  openSheet(`<h3>Delete ${esc(u.name || u.email)}?</h3>
    <p>They won't be able to sign in any more. Stock changes they made stay in the activity log.</p>
    <p class="hint">To block someone only for a while, use “Disable sign-in” instead.</p>
    <div class="err" id="dErr" role="alert"></div>
    <div class="actions"><button class="btn" type="button" data-close>Keep user</button><button class="btn danger solid" type="button" id="yesDel">Delete user</button></div>`,
  p => p.querySelector("#yesDel").addEventListener("click", async () => {
    const done = busy(p.querySelector("#yesDel"), "Deleting…");
    try {
      await api("/api/users?uid=" + encodeURIComponent(u.uid), { method: "DELETE" });
      users = users.filter(x => x.uid !== u.uid); render(); closeSheet(); toast("User deleted");
    } catch (ex) { p.querySelector("#dErr").textContent = ex.message; done(); }
  }));
}

$("#refreshUsers").addEventListener("click", load);
$("#uq").addEventListener("input", e => { q = e.target.value; render(); });
