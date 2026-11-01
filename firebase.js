// Shared Firebase setup for the stock page and the admin page.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const fbApp = initializeApp(firebaseConfig);
export const auth = getAuth(fbApp);

// Calls the server API (Vercel functions in /api) as the signed-in user.
export async function api(path, { method = "GET", body } = {}){
  const user = auth.currentUser;
  if (!user) throw Object.assign(new Error("Not signed in"), { status: 401 });
  const token = await user.getIdToken();
  const res = await fetch(path, {
    method,
    headers: { "Authorization": "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
  return data;
}
