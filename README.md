# Crockery Stock

Stock app for glasses, cutlery, espresso cups and other crockery. Works on phone and desktop,
installs like an app, and keeps working offline.

- Plain HTML/CSS/JS — no build step
- **Firebase Firestore** stores the stock (cached on each device in **IndexedDB**, so it opens and works offline and syncs when back online)
- **Firebase Auth** for sign-in (with "Remember me")
- **Vercel** hosts the site, plus two small server functions in `/api` for the admin "Users" page

## Features

- Stock counted in pieces, with optional **packet** and **carton** sizes
  (e.g. 1 packet = 12 pcs, 1 carton = 6 packets). Enter and view stock as cartons + packets + pieces.
- **Stock in / Stock out screen** — works like a shopping list:
  scan or search items, enter cartons / packets / pieces for each, then save everything at once.
  Stock out has three types: **Use** (consumed), **Issue** (to an outlet/event), **Breakage** (with reason).
  Supplier / outlet / reason picked from the Admin lists. **Undo** after saving.
- **Barcode scanning**
  - **Phone camera:** tap *Scan*, keep scanning items one after another (beep + vibrate on each).
    Works in Chrome, Edge and Safari (iPhone) over HTTPS — Vercel gives you HTTPS automatically.
  - **Handheld USB / Bluetooth scanners** work too — just scan; no need to tap anything.
  - Each item can have 3 barcodes: **piece**, **packet** and **carton**. Scanning a carton barcode adds 1 whole carton.
  - **Unknown barcode?** Create a new item with it, or link it to an existing item — without losing your list.
  - Scan on the main screen (or type a barcode in search) to jump straight to that item.
- Quick − / + count fixes on each row
- Low-stock alerts, "Low stock" filter, reorder list in cartons/packets
- Activity log (can't be edited)
- **Install** button, **Update now** bar when a new version is deployed, **Reload** button
- **Admin page** (admins only):
  - **Users:** add, delete, disable, reset password, make admin/staff
  - **Lists & settings:** edit the dropdowns staff use — *Counted in* units (pcs, sets, pairs, dozen…),
    categories, storage places, suppliers, outlets (issued to) and breakage reasons

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js` | Stock page |
| `admin.html`, `admin.js` | Users page (admins only) |
| `style.css` | Styles (light + dark, mobile) |
| `firebase.js` | Shared Firebase setup |
| `firebase-config.js` | **Your** Firebase web keys go here |
| `pwa.js`, `sw.js`, `manifest.json`, icons | Install / offline / update |
| `api/users.js`, `api/me.js`, `api/_lib.js` | Server functions for user management (run on Vercel) |
| `firestore.rules` | Database security rules |
| `vercel.json`, `package.json` | Vercel settings |

---

## 1. Firebase setup

1. https://console.firebase.google.com → **Add project**.
2. **Build → Firestore Database → Create database** → production mode.
   Open **Rules**, paste `firestore.rules`, **Publish**.
3. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**.
4. **Authentication → Users → Add user** → create **your own** login (you'll be the first admin).
5. **Project settings ⚙️ → General → Your apps → Web `</>`** → register → copy the config values into `firebase-config.js`.
6. **Project settings ⚙️ → Service accounts → Generate new private key** → a `.json` file downloads.
   ⚠️ **Never put this file in GitHub.** You'll paste it into Vercel in step 3.

## 2. Upload to GitHub

```bash
git init
git add .
git commit -m "Crockery Stock app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/crockery-stock.git
git push -u origin main
```

## 3. Deploy on Vercel

1. https://vercel.com → **Add New → Project** → import the repo. Framework Preset: **Other**. Leave build settings empty.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | Open the downloaded service-account `.json` file, copy **everything**, paste it here |
   | `ADMIN_EMAILS` | Your email, e.g. `you@gmail.com` (comma-separate for more than one main admin) |

3. **Deploy**.
4. Firebase → **Authentication → Settings → Authorized domains → Add domain** → your `xxx.vercel.app` domain.

Sign in with your account → you'll see an **Admin** button → add your staff and set up your lists there.

> Changed environment variables later? Vercel → Deployments → ⋯ → **Redeploy** so they take effect.

## 4. Install on phones

- **Android / Chrome / Edge:** tap **Install** in the app header (or the browser menu → *Install app*).
- **iPhone / iPad:** open in Safari → **Share** → **Add to Home Screen**. (The Install button shows these steps.)

## 5. Releasing updates

1. Change the code.
2. **Open `sw.js` and change `VERSION`** (e.g. `"2026-11-01-1"` → `"2026-11-05-1"`). This is what tells phones there's a new version.
3. `git add . && git commit -m "..." && git push`

Vercel redeploys. Open apps show **"A new version of the app is ready · Update now"**
(right away when they reopen the app, or when someone taps **Reload**).

If you forget to change `VERSION`, installed apps keep showing the old version.

## Roles

- **Staff:** see and update stock.
- **Admin:** everything staff can do + the **Admin** page (users and lists).
- Emails in `ADMIN_EMAILS` are always admins and can't be removed or deleted from the Users page.

## Updating from an older version of this project

Paste the new `firestore.rules` into Firebase → Firestore → **Rules** → **Publish**
(it adds the `settings` rule the Admin → Lists page needs).

## Run locally (optional)

```bash
npx vercel dev        # runs the site AND the /api functions (needs the env variables)
# or, stock page only (no Users page):
python3 -m http.server 8000
```

## Data layout

- `items/{id}` — `name, category, unit, qty, min, perPacket, perCarton, place, createdAt, updatedAt`
  (`qty`, `min`, `perPacket`, `perCarton` are all in the item's unit, e.g. pieces)
- `moves/{id}` — `itemId, name, unit, type (received|issued|broken|count), qty, before, after, party (supplier / outlet / reason), note, at`
- `settings/lists` — `units, categories, places, suppliers, outlets, reasons` (admins only can change)
