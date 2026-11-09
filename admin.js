import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { onAuthStateChanged, getAuth, createUserWithEmailAndPassword, updateProfile, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc, collection, query, where, getDocs, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { fbApp, auth } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import { ADMIN_EMAILS, isAdminEmail } from "./admins.js";
import "./pwa.js";

const db = getFirestore(fbApp);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let q = "";

onAuthStateChanged(auth, user => {
  if (!user) { location.replace("/"); return; }
  $("#whoAdmin").textContent = "Signed in as " + user.email;
  start();
});

/* Who can use the app is kept in Firestore: settings/access = { admins: [emails], staff: [emails], people: { email: {name, addedAt, addedBy} } }
   The owner emails in admins.js are always admins. */
let isAdmin = false, access = null;
const accessRef = () => doc(db, "settings", "access");
const lc = e => String(e || "").trim().toLowerCase();
const me = () => lc(auth.currentUser?.email);

function start(){
  isAdmin = isAdminEmail(me());
  watchLists();
  watchItems();
  watchAccess();
}
function watchAccess(){
  onSnapshot(accessRef(), async snap => {
    access = snap.exists() ? { admins: [], staff: [], people: {}, ...snap.data() } : null;
    isAdmin = isAdminEmail(me()) || !!access?.admins?.includes(me());
    // first visit by the owner: start the list (owner only), so access control switches on
    let setupFailed = false;
    if (!access && isAdminEmail(me())) {
      try { await setDoc(accessRef(), { admins: [], staff: [], people: {}, createdAt: Date.now(), createdBy: me() }); return; }
      catch (_) { setupFailed = true; }   // keep going: show the page anyway
    }
    $("#addUser").disabled = !isAdmin || setupFailed;
    renderUsers();
    if (setupFailed) notice(`<b>One step left.</b><span>Firebase blocked saving the user list. Copy everything from <code>firestore.rules</code>, paste it in Firebase console → Firestore Database → <b>Rules</b>, tap <b>Publish</b>, then reload this page.</span>`);
    if (listData) renderLists();
  }, e => {
    $("#addUser").disabled = true;
    notice(e.code === "permission-denied"
      ? `<b>Admins only.</b><span>${esc(me())} can't manage users. Ask an admin to make you an admin.</span>`
      : `<b>Couldn't load users.</b><span>Check your internet connection and reload.</span>`);
    $("#ulist").innerHTML = "";
  });
}

/* ---------- tabs ---------- */
document.querySelector(".admin-tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-atab]"); if (!b) return;
  const tab = b.dataset.atab;
  document.querySelectorAll("[data-atab]").forEach(x => x.setAttribute("aria-selected", x === b));
  $("#usersPane").hidden = tab !== "users";
  $("#listsPane").hidden = tab !== "lists";
  $("#unitsPane").hidden = tab !== "units";
  if (tab === "units") renderUnits();
  $("#addUser").hidden = tab !== "users";
  $("#refreshUsers").hidden = tab !== "users";
  try { history.replaceState(null, "", "#" + tab); } catch (_) {}
});
if (["#lists", "#units"].includes(location.hash)) document.querySelector(`[data-atab="${location.hash.slice(1)}"]`).click();

/* ---------- lists & settings ---------- */
// field = item field that uses this list (renaming updates those items too)
const LIST_DEFS = [
  { key: "units",      title: "Counted in (single units)", help: "The single unit you count: piece, bottle, can, pack…",                      ph: "e.g. pairs",          def: ["pcs","bottles","cans","packs","boxes","packets","sets","pairs","liters","kg"], field: "unit" },
  { key: "packings",   title: "Packing units",       help: "What items come in: carton, box, packet… (used in an item's Packing).", ph: "e.g. Sleeve", def: ["Carton","Box","Packet","Case","Tray","Bag","Pack","Crate"] },
  { key: "categories", title: "Categories",          help: "Groups for the stock list filters.",                    ph: "e.g. Bar tools",      def: ["Glassware","Cutlery","Cups & mugs","Plates & bowls","Serveware","Other"], field: "category" },
  { key: "places",     title: "Storage places",      help: "Where items are kept (shown as “Kept at”).",            ph: "e.g. Bar shelf B",    def: [], field: "place" },
  { key: "suppliers",  title: "Suppliers",           help: "Picked when you record stock received.",                ph: "e.g. ABC Crockery",   def: [] },
  { key: "outlets",    title: "Outlets / issued to", help: "Picked when you issue stock out.",                      ph: "e.g. Banquet hall",   def: [] },
  { key: "reasons",    title: "Breakage reasons",    help: "Picked when you record breakage.",                      ph: "e.g. Dishwasher",     def: ["Dropped","Dishwasher","Chipped / cracked","Lost","Guest breakage"] }
];
let listData = null, saving = Promise.resolve(), allItems = [], editing = null;
function watchItems(){
  onSnapshot(collection(db, "items"), snap => { allItems = snap.docs.map(d => ({ id: d.id, ...d.data() })); if (listData) renderLists(); if (!$("#unitsPane").hidden) renderUnits(); }, () => {});
}
const usage = (def, v) => def.field ? allItems.filter(it => (it[def.field] || (def.field === "unit" ? "pcs" : "")) === v).length : 0;
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
  $("#listsBox").innerHTML = (isAdmin ? "" : `<div class="notice"><b>View only.</b><span>Only admins can change these lists. Admin emails are set in <code>admins.js</code> and <code>firestore.rules</code>.</span></div>`) +
  LIST_DEFS.map(def => {
    const arr = listData[def.key];
    return `<section class="lcard">
      <div class="lhead"><h2>${esc(def.title)}</h2><span class="hint">${arr.length}</span></div>
      <p class="hint">${esc(def.help)}${def.field ? " Tap ✎ to rename." : ""}</p>
      <ul class="tags">${arr.length ? arr.map((v,i) => {
        const n = usage(def, v);
        if (editing && editing.key === def.key && editing.i === i) return `<li class="editing"><form class="tag-edit" data-rename="${def.key}" data-i="${i}" novalidate>
            <input value="${esc(v)}" maxlength="40" aria-label="New name for ${esc(v)}" data-renameinput>
            <button class="btn sm primary" type="submit">Save</button><button class="btn sm" type="button" data-cancel>Cancel</button></form>
            ${n ? `<small class="hint">${n} item${n>1?"s":""} will be updated too</small>` : ""}</li>`;
        return `<li><span>${esc(v)}${def.field ? ` <small class="use">${n}</small>` : ""}</span>
        <button type="button" class="tagbtn" data-edit="${def.key}" data-i="${i}" aria-label="Rename ${esc(v)}">✎</button>
        <button type="button" class="tagbtn" data-up="${def.key}" data-i="${i}" aria-label="Move ${esc(v)} up" ${i===0?"disabled":""}>↑</button>
        <button type="button" class="tagbtn" data-del="${def.key}" data-i="${i}" aria-label="Remove ${esc(v)}">✕</button></li>`;
      }).join("")
        : `<li class="none">Nothing yet</li>`}</ul>
      <form class="join" data-form="${def.key}" novalidate>
        <input data-addfor="${def.key}" maxlength="40" placeholder="${esc(def.ph)}" aria-label="Add to ${esc(def.title)}">
        <button class="btn" type="submit">Add</button>
      </form>
    </section>`;
  }).join("");
  if (open) { const i = $(`[data-addfor="${open}"]`); i && i.focus(); }
  const ri = $("[data-renameinput]"); if (ri && editing && !editing.focused) { editing.focused = true; ri.focus(); ri.select(); }
  if (!isAdmin) $("#listsBox").querySelectorAll("button, input").forEach(x => x.disabled = true);
}

/* rename an entry, and update the items that use it */
async function renameEntry(key, i, newName){
  const def = LIST_DEFS.find(d => d.key === key), arr = [...listData[key]], old = arr[i];
  const v = newName.trim().replace(/\s+/g, " ");
  editing = null;
  if (!v || v === old) return renderLists();
  if (arr.some((x, j) => j !== i && x.toLowerCase() === v.toLowerCase())) { renderLists(); return toast(`“${v}” is already in the list`); }
  arr[i] = v;
  saveList(key, arr, `Renamed to ${v}`);
  if (!def.field) return;
  try {
    const snap = await getDocs(query(collection(db, "items"), where(def.field, "==", old)));
    let n = 0;
    for (const d of snap.docs) { await updateDoc(d.ref, { [def.field]: v, updatedAt: Date.now() }); n++; }
    if (n) toast(`Renamed to ${v} · ${n} item${n>1?"s":""} updated`);
  } catch (e) { toast("List renamed, but some items couldn't be updated. Try again."); }
}

function saveList(key, arr, msg){
  listData[key] = arr; renderLists();
  saving = saving.then(() => setDoc(listsRef(), { [key]: arr, updatedAt: Date.now() }, { merge: true }))
    .then(() => toast(msg))
    .catch(e => toast(e.code === "permission-denied" ? "Only admins can change lists. Sign out and in again if you were just made admin." : "Couldn't save. Try again."));
}

$("#listsBox").addEventListener("submit", e => {
  e.preventDefault();
  const r = e.target.closest("[data-rename]");
  if (r) return renameEntry(r.dataset.rename, +r.dataset.i, r.querySelector("input").value);
  const f = e.target.closest("[data-form]"); if (!f) return;
  const key = f.dataset.form, input = f.querySelector("input"), v = input.value.trim().replace(/\s+/g, " ");
  if (!v) return;
  const arr = listData[key];
  if (arr.some(x => x.toLowerCase() === v.toLowerCase())) { toast(`“${v}” is already in the list`); return; }
  input.value = "";
  saveList(key, [...arr, v], `Added ${v}`);
});
$("#listsBox").addEventListener("keydown", e => { if (e.key === "Escape" && editing) { e.stopPropagation(); editing = null; renderLists(); } });
$("#listsBox").addEventListener("click", e => {
  const del = e.target.closest("[data-del]"), up = e.target.closest("[data-up]"), ed = e.target.closest("[data-edit]");
  if (e.target.closest("[data-cancel]")) { editing = null; return renderLists(); }
  if (ed) { editing = { key: ed.dataset.edit, i: +ed.dataset.i }; return renderLists(); }
  if (del) {
    const key = del.dataset.del, i = +del.dataset.i, arr = [...listData[key]], [v] = arr.splice(i, 1);
    const def = LIST_DEFS.find(d => d.key === key), n = usage(def, v);
    if (key === "categories" && n) return deleteCategoryInUse(v, arr, n);
    saveList(key, arr, n ? `Removed ${v}. The ${n} item${n>1?"s":""} using it keep it.` : `Removed ${v}`);
  } else if (up) {
    const key = up.dataset.up, i = +up.dataset.i, arr = [...listData[key]];
    [arr[i-1], arr[i]] = [arr[i], arr[i-1]];
    saveList(key, arr, "Order saved");
  }
});

function notice(html){ const n = $("#notice"); n.hidden = !html; n.innerHTML = html || ""; }

const fmtDate = t => t ? new Date(t).toLocaleDateString([], { day:"numeric", month:"short", year:"numeric" }) : "";
const initials = u => (u.name || u.email || "?").trim().split(/[\s@.]+/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join("");
function userList(){
  const out = new Map();
  ADMIN_EMAILS.map(lc).forEach(e => out.set(e, { email: e, role: "owner" }));
  (access?.admins || []).forEach(e => { if (!out.has(e)) out.set(e, { email: e, role: "admin" }); });
  (access?.staff || []).forEach(e => { if (!out.has(e)) out.set(e, { email: e, role: "staff" }); });
  for (const u of out.values()) Object.assign(u, access?.people?.[u.email] || {});
  return [...out.values()].sort((a, b) => (a.role === "owner" ? -1 : 0) - (b.role === "owner" ? -1 : 0) || a.email.localeCompare(b.email));
}
const roleName = r => r === "owner" ? "Owner" : r === "admin" ? "Admin" : "Staff";

function renderUsers(){
  if (!isAdmin) {
    notice(`<b>Admins only.</b><span>${esc(me())} is a staff account. Ask an admin to make you an admin.</span>`);
    $("#ulist").innerHTML = ""; return;
  }
  notice("");
  const term = q.trim().toLowerCase();
  const list = userList().filter(u => !term || ((u.name || "") + " " + u.email).toLowerCase().includes(term));
  $("#ulist").innerHTML = list.length ? list.map(u => `
    <li>
      <span class="avatar" aria-hidden="true">${esc(initials(u))}</span>
      <div style="min-width:0">
        <div class="uname">${esc(u.name || u.email)}${u.email === me() ? ` <span class="hint">(you)</span>` : ""}</div>
        <div class="umeta">
          <span class="pill ${u.role === "staff" ? "staff" : "admin"}">${roleName(u.role)}</span>
          ${u.name ? `<span>${esc(u.email)}</span>` : ""}
          ${u.addedAt ? `<span>· added ${fmtDate(u.addedAt)}</span>` : ""}
        </div>
      </div>
      <div class="uact">${u.role === "owner" ? "" : `<button class="btn sm" type="button" data-manage="${esc(u.email)}">Manage</button>`}</div>
    </li>`).join("") : `<li style="display:block"><div class="empty"><h3>No one matches</h3></div></li>`;
}

/* save the access list (whole document, so emails with dots are safe) */
async function saveAccess(change, okMsg){
  const cur = access || { admins: [], staff: [], people: {} };
  const next = change({ admins: [...(cur.admins||[])], staff: [...(cur.staff||[])], people: { ...(cur.people||{}) } });
  next.admins = [...new Set(next.admins.map(lc))]; next.staff = [...new Set(next.staff.map(lc))].filter(e => !next.admins.includes(e));
  try { await setDoc(accessRef(), { ...next, updatedAt: Date.now(), updatedBy: me() }); okMsg && toast(okMsg); return true; }
  catch (e) { toast(e.code === "permission-denied" ? "Only admins can change users. Publish the new firestore.rules in Firebase if you haven't yet." : "Couldn't save. Check your connection."); return false; }
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
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500); }

function makePassword(){
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  return Array.from(a, n => chars[n % chars.length]).join("");
}
async function copy(text){
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch (_) { toast("Select the text and copy it"); }
}
function busy(btn, text){ btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = text; return () => { btn.disabled = false; btn.textContent = btn.dataset.t; }; }

/* Create a login without signing the admin out: use a second, separate Firebase connection */
let adderAuth = null;
async function createLogin(email, password, name){
  adderAuth = adderAuth || getAuth(initializeApp(firebaseConfig, "user-adder"));
  const cred = await createUserWithEmailAndPassword(adderAuth, email, password);
  if (name) { try { await updateProfile(cred.user, { displayName: name }); } catch (_) {} }
  try { await signOut(adderAuth); } catch (_) {}
}

/* add user */
$("#addUser").addEventListener("click", () => {
  openSheet(`<h3>Add user</h3>
    <form id="fAdd" novalidate>
      <div class="field"><label for="aName">Name <span class="opt">optional</span></label><input id="aName" maxlength="60" placeholder="e.g. Ahmed (store keeper)"></div>
      <div class="field"><label for="aEmail">Email</label><input id="aEmail" type="email" inputmode="email" autocomplete="off" placeholder="name@example.com"></div>
      <div class="field"><label for="aPass">Password</label>
        <div class="join"><input id="aPass" type="text" autocomplete="new-password" spellcheck="false"><button type="button" class="btn" id="aGen">New</button></div>
        <p class="hint">At least 6 characters. You'll get the sign-in details to send them.</p></div>
      <label class="remember" for="aHas"><input type="checkbox" id="aHas"> They already have a login (keep their password)</label>
      <fieldset class="qbox-wrap"><legend>Access</legend>
        <div class="radio-cards">
          <label><input type="radio" name="role" value="staff" checked><span><b>Staff</b><small>Stock in / out, items</small></span></label>
          <label><input type="radio" name="role" value="admin"><span><b>Admin</b><small>Also users, units & categories</small></span></label>
        </div>
      </fieldset>
      <div class="err" id="aErr" role="alert"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="aBtn">Add user</button></div>
    </form>`, p => {
    p.querySelector("#aPass").value = makePassword();
    p.querySelector("#aGen").addEventListener("click", () => p.querySelector("#aPass").value = makePassword());
    p.querySelector("#aHas").addEventListener("change", e => p.querySelector("#aPass").closest(".field").hidden = e.target.checked);
    p.querySelector("#aName").focus();
    p.querySelector("#fAdd").addEventListener("submit", async e => {
      e.preventDefault();
      const err = p.querySelector("#aErr"); err.textContent = "";
      const name = p.querySelector("#aName").value.trim(), email = lc(p.querySelector("#aEmail").value);
      const pass = p.querySelector("#aPass").value, has = p.querySelector("#aHas").checked;
      const role = p.querySelector("input[name=role]:checked").value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err.textContent = "Enter a valid email.";
      if (userList().some(u => u.email === email)) return err.textContent = `${email} is already on the list. Use Manage to change their access.`;
      if (!has && pass.length < 6) return err.textContent = "Password must be at least 6 characters.";
      const done = busy(p.querySelector("#aBtn"), "Adding…");
      let existed = has;
      if (!has) {
        try { await createLogin(email, pass, name); }
        catch (ex) {
          if (ex.code === "auth/email-already-in-use") existed = true;
          else {
            done();
            return err.innerHTML = ex.code === "auth/admin-restricted-operation" || ex.code === "auth/operation-not-allowed"
              ? `Firebase is blocking new logins. In Firebase → Authentication → <b>Settings → User actions</b>, turn <b>on</b> “Enable create (sign-up)”, then try again. (Only people on this list can use the app, so this is safe.)`
              : ex.code === "auth/invalid-email" ? "That email address isn't valid."
              : ex.code === "auth/weak-password" ? "Password is too weak. Use at least 6 characters."
              : ex.code === "auth/network-request-failed" ? "No internet connection." : `Couldn't create the login (${esc(ex.code || ex.message)}).`;
          }
        }
      }
      const ok = await saveAccess(a => {
        a.admins = a.admins.filter(x => x !== email); a.staff = a.staff.filter(x => x !== email);
        (role === "admin" ? a.admins : a.staff).push(email);
        a.people[email] = { name, addedAt: Date.now(), addedBy: me() };
        return a;
      });
      if (!ok) { done(); return err.textContent = "The login was made, but the access list couldn't be saved. Try Add user again."; }
      if (existed) { closeSheet(); toast(`${email} added. They sign in with their existing password.`); }
      else showCredentials(email, pass, "User added");
    });
  });
});

function showCredentials(email, pass, title){
  const where = window.Capacitor?.isNativePlatform?.() ? "Use the Crockery Stock app" : location.origin;
  const text = `Crockery Stock login\n${where}\nEmail: ${email}\nPassword: ${pass}`;
  openSheet(`<h3>${esc(title)}</h3>
    <p>Send these sign-in details to the person:</p>
    <div class="field"><label for="cred">Sign-in details</label><textarea id="cred" rows="4" readonly>${esc(text)}</textarea></div>
    <div class="actions"><button class="btn" type="button" id="cCopy">Copy details</button><button class="btn primary" type="button" data-close>Done</button></div>`,
  p => p.querySelector("#cCopy").addEventListener("click", () => copy(text)));
}

/* manage user */
$("#ulist").addEventListener("click", e => {
  const b = e.target.closest("[data-manage]"); if (!b) return;
  const u = userList().find(x => x.email === b.dataset.manage); if (!u) return;
  const self = u.email === me();
  openSheet(`<h3>${esc(u.name || u.email)}</h3>
    <p class="hint">${esc(u.email)}${u.addedAt ? ` · added ${fmtDate(u.addedAt)}` : ""}</p>
    <form id="fName" novalidate class="field">
      <label for="mName">Name</label>
      <div class="join"><input id="mName" maxlength="60" value="${esc(u.name || "")}"><button class="btn" type="submit">Save</button></div>
    </form>
    <fieldset class="qbox-wrap"><legend>Access</legend>
      <div class="radio-cards">
        <label><input type="radio" name="mrole" value="staff" ${u.role === "staff" ? "checked" : ""} ${self ? "disabled" : ""}><span><b>Staff</b><small>Stock in / out, items</small></span></label>
        <label><input type="radio" name="mrole" value="admin" ${u.role === "admin" ? "checked" : ""} ${self ? "disabled" : ""}><span><b>Admin</b><small>Also users, units & categories</small></span></label>
      </div>
      ${self ? `<p class="hint">You can't remove your own admin access.</p>` : ""}
    </fieldset>
    <div class="field"><label>Password</label>
      <button class="btn" type="button" id="mReset">Email a password reset link</button>
      <p class="hint">They get an email from Firebase with a link to choose a new password.</p></div>
    ${self ? "" : `<div class="actions"><button class="btn danger" type="button" id="mRemove">Remove access</button></div>`}`,
  p => {
    p.querySelector("#fName").addEventListener("submit", async ev => {
      ev.preventDefault();
      const name = p.querySelector("#mName").value.trim();
      await saveAccess(a => { a.people[u.email] = { ...(a.people[u.email] || {}), name }; return a; }, "Name saved");
    });
    p.querySelectorAll("input[name=mrole]").forEach(r => r.addEventListener("change", () =>
      saveAccess(a => {
        a.admins = a.admins.filter(x => x !== u.email); a.staff = a.staff.filter(x => x !== u.email);
        (r.value === "admin" ? a.admins : a.staff).push(u.email); return a;
      }, r.value === "admin" ? `${u.email} is now an admin` : `${u.email} is now staff`)));
    p.querySelector("#mReset").addEventListener("click", async ev => {
      const done = busy(ev.target, "Sending…");
      try { await sendPasswordResetEmail(auth, u.email); done(); toast(`Reset link sent to ${u.email}`); }
      catch (ex) { done(); toast(ex.code === "auth/user-not-found" ? "This email has no login yet. Remove and add them again with a password." : "Couldn't send the email. Try again."); }
    });
    p.querySelector("#mRemove")?.addEventListener("click", () => {
      openSheet(`<h3>Remove ${esc(u.name || u.email)}?</h3>
        <p>They won't be able to use the app any more. Stock changes they made stay in the activity log.</p>
        <p class="hint">You can add them back any time.</p>
        <div class="actions"><button class="btn" type="button" data-close>Keep</button><button class="btn danger solid" type="button" id="yesRm">Remove access</button></div>`,
      q2 => q2.querySelector("#yesRm").addEventListener("click", async () => {
        const ok = await saveAccess(a => { a.admins = a.admins.filter(x => x !== u.email); a.staff = a.staff.filter(x => x !== u.email); delete a.people[u.email]; return a; }, `${u.email} removed`);
        if (ok) closeSheet();
      }));
    });
  });
});

$("#refreshUsers").addEventListener("click", () => { renderUsers(); toast("Up to date"); });
$("#uq").addEventListener("input", e => { q = e.target.value; renderUsers(); });


/* ---------- Item units: main pack + how many + single unit, for every item ---------- */
const iuState = {};   // itemId -> edited values not yet saved
const cap1 = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
function mainOf(it){
  const pc = +it.perCarton || 0, pp = +it.perPacket || 0;
  return pc ? { k: "ctn", name: String(it.cartonName || "carton").toLowerCase(), n: pc }
       : pp ? { k: "pkt", name: String(it.packName || "packet").toLowerCase(), n: pp } : { k: "ctn", name: "", n: 0 };
}
function renderUnits(){
  const box = $("#iuList"); if (!box) return;
  if (!isAdmin) { box.innerHTML = `<div class="notice"><b>Admins only.</b><span>Only admins can change item units.</span></div>`; return; }
  if (document.activeElement && box.contains(document.activeElement)) return;   // don't redraw while typing
  const q = ($("#iuQ")?.value || "").trim().toLowerCase();
  const packs = listData?.packings?.length ? listData.packings : ["Carton","Box","Packet","Case","Tray","Bag","Pack","Crate"];
  const units = listData?.units?.length ? listData.units : ["pcs"];
  const list = allItems.filter(it => !q || (it.name + " " + (it.category || "")).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) { box.innerHTML = `<div class="empty"><h3>${allItems.length ? "No items match" : "No items yet"}</h3></div>`; return; }
  box.innerHTML = list.map(it => {
    const m = mainOf(it), st = iuState[it.id] || { name: m.name, n: m.n, unit: it.unit || "pcs" };
    const pk = [...packs.map(x => x.toLowerCase())]; if (st.name && !pk.includes(st.name)) pk.push(st.name);
    const un = [...units]; if (!un.includes(st.unit)) un.push(st.unit);
    const dirty = !!iuState[it.id];
    return `<div class="iu-row ${dirty ? "dirty" : ""}" data-id="${it.id}">
      <div class="iu-name"><b>${esc(it.name)}</b><small>${esc(it.category || "")} · ${+it.qty || 0} ${esc(it.unit || "pcs")} in stock</small></div>
      <div class="iu-edit">
        <span class="one">1</span>
        <select data-f="name" aria-label="Main pack for ${esc(it.name)}"><option value="" ${st.name ? "" : "selected"}>No pack</option>${pk.map(x => `<option value="${esc(x)}" ${x === st.name ? "selected" : ""}>${esc(cap1(x))}</option>`).join("")}</select>
        <span class="eq">=</span>
        <input data-f="n" type="number" inputmode="decimal" min="0" step="any" value="${st.n || ""}" placeholder="0" aria-label="How many in 1 pack" ${st.name ? "" : "disabled"}>
        <select data-f="unit" aria-label="Single unit for ${esc(it.name)}">${un.map(x => `<option value="${esc(x)}" ${x === st.unit ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <button type="button" class="btn sm primary" data-save ${dirty ? "" : "disabled"}>Save</button>
      </div>
    </div>`;
  }).join("");
}
$("#iuQ")?.addEventListener("input", () => { document.activeElement.blur?.(); renderUnits(); $("#iuQ").focus(); });
$("#iuList").addEventListener("input", e => {
  const row = e.target.closest(".iu-row"), f = e.target.dataset.f; if (!row || !f) return;
  const it = allItems.find(x => x.id === row.dataset.id), m = mainOf(it);
  const st = iuState[it.id] || (iuState[it.id] = { name: m.name, n: m.n, unit: it.unit || "pcs" });
  // whole numbers, except measured units (liters, kg…) which may have decimals, e.g. 1 Can = 0.5 liters
  st[f] = f === "n" ? Math.max(0, /^(l|lt|ltr|ltrs|liters?|litres?|ml|kg|kgs|g|grams?|gallons?)$/i.test(st.unit || it.unit || "") ? Math.round((+e.target.value || 0) * 1000) / 1000 : Math.floor(+e.target.value || 0)) : e.target.value;
  if (f === "name") { const n = row.querySelector('[data-f="n"]'); n.disabled = !st.name; if (st.name) n.focus(); }
  row.classList.add("dirty"); row.querySelector("[data-save]").disabled = false;
});
$("#iuList").addEventListener("change", e => $("#iuList").dispatchEvent(new Event("input", { bubbles: true })) );
$("#iuList").addEventListener("click", async e => {
  const b = e.target.closest("[data-save]"); if (!b) return;
  const row = b.closest(".iu-row"), it = allItems.find(x => x.id === row.dataset.id), st = iuState[it.id]; if (!st) return;
  if (st.name && !st.n) { toast(`Enter how many ${st.unit} are in 1 ${st.name}.`); row.querySelector('[data-f="n"]').focus(); return; }
  const m = mainOf(it), upd = { unit: st.unit, updatedAt: Date.now() };
  if (!st.name) Object.assign(upd, { perCarton: 0, perPacket: 0 });
  else if (m.k === "pkt" && m.n) Object.assign(upd, { packName: st.name, perPacket: st.n });
  else Object.assign(upd, { cartonName: st.name, perCarton: st.n });
  b.disabled = true; b.textContent = "Saving…";
  try {
    await updateDoc(doc(db, "items", it.id), upd);
    delete iuState[it.id];
    toast(st.name ? `${it.name}: 1 ${st.name} = ${st.n} ${st.unit}` : `${it.name}: counted in ${st.unit}`);
    document.activeElement?.blur?.(); renderUnits();
  } catch (ex) { b.disabled = false; b.textContent = "Save"; toast(ex.code === "permission-denied" ? "Only admins can change units. Publish the new firestore.rules in Firebase." : "Couldn't save. Try again."); }
});


/* deleting a category that items use: choose where those items go, so the category is really gone */
function deleteCategoryInUse(cat, rest, n){
  const others = [...new Set([...rest, ...allItems.map(i => i.category).filter(c => c && c !== cat)])];
  if (!others.length) others.push("Other");
  openSheet(`<h3>Delete “${esc(cat)}”?</h3>
    <p>${n} item${n > 1 ? "s use" : " uses"} this category. Move ${n > 1 ? "them" : "it"} to:</p>
    <div class="field"><label for="dcTo">New category</label>
      <select id="dcTo">${others.map(c => `<option ${c === "Other" ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    <div class="err" id="dcErr" role="alert"></div>
    <div class="actions"><button class="btn" type="button" data-close>Keep it</button><button class="btn danger solid" type="button" id="dcGo">Delete and move</button></div>`,
  p => p.querySelector("#dcGo").addEventListener("click", async () => {
    const to = p.querySelector("#dcTo").value, b = p.querySelector("#dcGo");
    b.disabled = true; b.textContent = "Moving…";
    try {
      const snap = await getDocs(query(collection(db, "items"), where("category", "==", cat)));
      for (const d of snap.docs) await updateDoc(d.ref, { category: to, updatedAt: Date.now() });
      const next = rest.includes(to) ? rest : [...rest, to];
      closeSheet();
      saveList("categories", next, `Deleted ${cat} · ${snap.docs.length} item${snap.docs.length === 1 ? "" : "s"} moved to ${to}`);
    } catch (_) { b.disabled = false; b.textContent = "Delete and move"; p.querySelector("#dcErr").textContent = "Couldn't move the items. Try again."; }
  }));
}
