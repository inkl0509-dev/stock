// GET /api/me → { email, admin }  — tells the app whether to show the "Users" button.
import { adminAuth, currentUser, isOwnerEmail, send, handle } from "./_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const me = await currentUser(req);
  const admin = me.admin === true || isOwnerEmail(me.email);
  // Give ADMIN_EMAILS users the admin role on their account too
  if (admin && me.admin !== true) {
    const u = await adminAuth().getUser(me.uid);
    await adminAuth().setCustomUserClaims(me.uid, { ...(u.customClaims || {}), admin: true });
  }
  send(res, 200, { email: me.email, admin });
});
