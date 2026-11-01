// Shared helpers for the /api functions. Files starting with "_" are not public routes on Vercel.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export function adminAuth(){
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw Object.assign(new Error("Server not set up: add FIREBASE_SERVICE_ACCOUNT in Vercel → Settings → Environment Variables."), { status: 500 });
    let sa;
    try { sa = JSON.parse(raw); } catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service account file."), { status: 500 }); }
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(sa) });
  }
  return getAuth();
}

// Emails listed in ADMIN_EMAILS (comma separated) are always admins — use it for the first admin.
export const ownerEmails = () => (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
export const isOwnerEmail = email => !!email && ownerEmails().includes(email.toLowerCase());

export function send(res, status, data){ res.status(status).setHeader("Cache-Control", "no-store").json(data); }

export async function currentUser(req){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw Object.assign(new Error("Sign in first."), { status: 401 });
  try { return await adminAuth().verifyIdToken(token, true); }
  catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error("Your session has expired. Sign in again."), { status: 401 });
  }
}

export async function requireAdmin(req){
  const me = await currentUser(req);
  if (me.admin === true || isOwnerEmail(me.email)) return me;
  throw Object.assign(new Error("Only admins can manage users."), { status: 403 });
}

export function handle(fn){
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const map = {
        "auth/email-already-exists": [409, "A user with this email already exists."],
        "auth/invalid-email": [400, "That email address isn't valid."],
        "auth/invalid-password": [400, "Password must be at least 6 characters."],
        "auth/user-not-found": [404, "That user no longer exists."]
      };
      const known = map[e.code || e.errorInfo?.code];
      if (known) return send(res, known[0], { error: known[1] });
      console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server." });
    }
  };
}
