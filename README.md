# Crockery Stock

Stock app for glasses, cutlery, espresso cups and other crockery. Works on phone and desktop.
Plain HTML/CSS/JS — no build step. Data is stored in Firebase Firestore; sign-in uses Firebase Auth.

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout |
| `style.css` | Styles (light + dark mode, mobile) |
| `app.js` | App logic + Firebase |
| `firebase-config.js` | **Your** Firebase keys go here |
| `firestore.rules` | Database security rules |
| `manifest.json`, `icon.svg` | "Add to Home Screen" icon |

---

## 1. Set up Firebase

1. Go to https://console.firebase.google.com → **Add project** → give it a name (e.g. `crockery-stock`).
2. **Build → Firestore Database → Create database** → choose a location near you → start in **production mode**.
3. Open the **Rules** tab, paste everything from `firestore.rules`, click **Publish**.
4. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
5. **Authentication → Users → Add user** — create a login (email + password) for yourself and each staff member.
   (There is no sign-up page in the app, so only people you add can get in.)
6. **Project settings (⚙️) → General → Your apps → Web (`</>`)** → register app → copy the `firebaseConfig` object
   and paste its values into `firebase-config.js`.

## 2. Upload to GitHub

Create an empty repository on https://github.com/new (e.g. `crockery-stock`), then in this folder:

```bash
git init
git add .
git commit -m "Crockery Stock app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/crockery-stock.git
git push -u origin main
```

No terminal? On the new repo page click **uploading an existing file** and drag all files in.

## 3. Deploy on Vercel

1. Go to https://vercel.com → sign in with GitHub → **Add New → Project**.
2. Import the `crockery-stock` repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
4. Click **Deploy**. You'll get a link like `https://crockery-stock.vercel.app`.
5. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** →
   add `crockery-stock.vercel.app` (your Vercel domain).

Every `git push` to `main` redeploys automatically.

## 4. Use it on your phone

Open the Vercel link → browser menu → **Add to Home Screen**. It opens like an app and keeps working
offline; changes sync when you're back online.

## Run locally (optional)

ES modules need a local server (opening the file directly won't work):

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open http://localhost:8000 (`localhost` is already an authorized domain in Firebase).

## Data layout

- `items/{id}` — `name, category, qty, min, unit, place, createdAt, updatedAt`
- `moves/{id}` — `itemId, name, unit, type (received|issued|broken|count), qty, before, after, note, at`
