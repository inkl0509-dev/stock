// Admin-only user management.
//   GET    /api/users                         → list users
//   POST   /api/users  {email,password,name,role}            → add user
//   PATCH  /api/users  {uid, role?, password?, disabled?, name?} → change user
//   DELETE /api/users?uid=...                 → delete user
import { adminAuth, requireAdmin, isOwnerEmail, send, handle } from "./_lib.js";

const view = u => ({
  uid: u.uid,
  email: u.email || "",
  name: u.displayName || "",
  admin: u.customClaims?.admin === true || isOwnerEmail(u.email),
  owner: isOwnerEmail(u.email),
  disabled: !!u.disabled,
  created: u.metadata.creationTime || null,
  lastSignIn: u.metadata.lastSignInTime || null
});

export default handle(async (req, res) => {
  const me = await requireAdmin(req);
  const auth = adminAuth();

  if (req.method === "GET") {
    const users = [];
    let page;
    do {
      page = await auth.listUsers(1000, page?.pageToken);
      users.push(...page.users.map(view));
    } while (page.pageToken && users.length < 5000);
    users.sort((a, b) => a.email.localeCompare(b.email));
    return send(res, 200, { users, me: me.uid });
  }

  if (req.method === "POST") {
    const { email, password, name, role } = req.body || {};
    if (!email || !String(email).includes("@")) return send(res, 400, { error: "Enter a valid email." });
    if (!password || String(password).length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
    const u = await auth.createUser({ email: String(email).trim(), password: String(password), displayName: String(name || "").trim() || undefined });
    if (role === "admin") await auth.setCustomUserClaims(u.uid, { admin: true });
    return send(res, 201, { user: view(await auth.getUser(u.uid)) });
  }

  if (req.method === "PATCH") {
    const { uid, role, password, disabled, name } = req.body || {};
    if (!uid) return send(res, 400, { error: "Missing user." });
    const target = await auth.getUser(uid);
    const self = uid === me.uid;

    if (self && (role === "staff" || disabled === true)) return send(res, 400, { error: "You can't remove your own admin access or disable yourself." });
    if (isOwnerEmail(target.email) && (role === "staff" || disabled === true)) return send(res, 400, { error: "This user is a main admin (set in ADMIN_EMAILS) and can't be changed here." });

    const update = {};
    if (password !== undefined) {
      if (String(password).length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
      update.password = String(password);
    }
    if (disabled !== undefined) update.disabled = !!disabled;
    if (name !== undefined) update.displayName = String(name).trim() || null;
    if (Object.keys(update).length) await auth.updateUser(uid, update);

    if (role === "admin" || role === "staff") {
      await auth.setCustomUserClaims(uid, { ...(target.customClaims || {}), admin: role === "admin" });
    }
    // Sign them out everywhere after a password change or disable
    if (update.password || update.disabled) await auth.revokeRefreshTokens(uid);

    return send(res, 200, { user: view(await auth.getUser(uid)) });
  }

  if (req.method === "DELETE") {
    const uid = req.query?.uid;
    if (!uid) return send(res, 400, { error: "Missing user." });
    if (uid === me.uid) return send(res, 400, { error: "You can't delete your own account." });
    const target = await auth.getUser(uid);
    if (isOwnerEmail(target.email)) return send(res, 400, { error: "This user is a main admin (set in ADMIN_EMAILS) and can't be deleted here." });
    await auth.deleteUser(uid);
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: "Method not allowed" });
});
