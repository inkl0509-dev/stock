# Crockery Stock

Stock app for glasses, cutlery, espresso cups and other crockery. Works on phone and desktop,
installs like an app, and keeps working offline.

- Plain HTML/CSS/JS — no build step
- **Firebase Firestore** stores the stock (cached on each device in **IndexedDB**, so it opens and works offline and syncs when back online)
- **Firebase Auth** for sign-in (with "Remember me")
- **Vercel** hosts the site (no server code or environment variables needed)

## Features

- **Home screen with big buttons:** Stock in · Stock out · Scan · Daily count · Quick use · Items · Low stock ·
  Activity · New item · Admin. Search sits at the top; Items and Activity open as their own pages with a Back button
  (the phone's back button works too).
- **Daily count** (for water and other fast items): count what's left, enter it in cartons / packets / pieces, and the
  app records the difference as *used*. No need to log every bottle. Mark items as **Fast-moving** in Edit item,
  or with *Edit list* on the Daily count screen.
- **Quick use:** big tap buttons for fast items (−1, or −1 packet). Taps are grouped and saved automatically
  after a few seconds, with *Undo last*.

- **Two units per item:** a **main pack** (carton, box…) and a **single unit** (can, spoon, bottle…):
  *1 Carton = 24 cans*, *1 Box = 12 spoons*. Stock in/out, counts and lists show only these two.
  Staff choose them when creating an item; only **admins** can change them later (in the item, from Stock in,
  or on **Admin → Item units**, which lists every item). Firestore rules enforce this.
- **Liquids and weights:** set the single unit to *liters* (or ml, kg, g) and the main pack to *Can*:
  *1 Can = 1 liter* (or 5 L, 0.5 L). Stock, minimum level and stock out then take decimals (e.g. use 0.75 L);
  stock shows as *9 cans + 0.25 liters*. Counted items (glasses, spoons) stay whole numbers.
- **Correct a wrong entry:** tap an entry in Activity or an item's History → *Correct amount* or *Cancel this entry*.
  Stock is adjusted by the difference; the original shows as corrected and a *Correction* line records who, when and why.
  Staff can correct their own entries, admins any.
- **Stock in / Stock out screen** — works like a shopping list:
  scan or search items, enter cartons / packets / pieces for each, then save everything at once.
  Stock out has three types: **Use** (consumed), **Issue** (to an outlet/event), **Breakage** (with reason).
  Supplier / outlet / reason picked from the Admin lists. **Undo** after saving.
- **Barcode scanning** with the phone camera
- **Product details from the camera:** scan the barcode of a new product and the app looks it up in the free
  online product lists (Open Food Facts / Open Products Facts) and fills in the **name, brand, size and photo**.
  Works well for drinks and packaged goods; most crockery isn't listed, so then you type the name.
  In **New item** you can also tap **Scan to fill details**.
- **Product photos:** in New item / Edit item tap **Take photo**. The photo is made small and shown in the list.
- **Make your own barcodes:** open an item → **🏷 Make a barcode** (or **Make barcode** in the item form). The app
  makes a unique code (EAN-13 starting with 29, the range meant for in-house use) and saves it to the item.
  Then **Share** the label (WhatsApp, email…), **Download** it, or **Print** several labels on one page.
  - **Phone camera:** tap *Scan*, keep scanning items one after another (beep + vibrate on each).
    Works in Chrome, Edge and Safari (iPhone) over HTTPS — Vercel gives you HTTPS automatically.
  - **Handheld USB / Bluetooth scanners** work too — just scan; no need to tap anything.
  - Each item can have **any number of barcodes** — e.g. one per brand. Each barcode counts as a piece, packet,
    carton, or a custom qty ("Other qty", e.g. a box of 24), and can have a brand name.
  - **Scanner tools:** high-resolution camera with continuous focus, wide scan box, **Light** (torch) and **Zoom**
    where the phone supports them, and **Photo** — take a picture of the barcode if live scanning struggles.
  - **Barcode setup:** tap the **No barcode** filter → **Start**, and scan your existing items one after another.
    Or open an item → **Add barcode**.
- **Merge items:** open an item → **Merge…** → choose the item to keep. Stock is added together, barcodes move over
  (still counting the right qty even if pack sizes differ), history stays, and the duplicate is removed.
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
| `admins.js` | The **owner** email (always admin) |
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

## 2b. Users and admins

**You (the owner)** are the email in `admins.js` and in `firestore.rules` (`isOwner`). The owner is always an admin.

Everyone else is managed **inside the app**: sign in as the owner → **Admin** button → **Users** → **Add user**.
Type their email and a password (or tick *They already have a login*), choose **Staff** or **Admin**, tap **Add user**,
and send them the sign-in details it shows.

- **Staff:** stock in / out, add and edit items.
- **Admin:** also Users and *Units & categories*.
- Only people on this list can use the app. Remove someone with **Manage → Remove access**.

One Firebase setting is needed for **Add user** to create logins:
Firebase → Authentication → **Settings → User actions** → **Enable create (sign-up)** = **on**.
(This is safe: a login that isn't on your user list can't see or change anything.)

## 3. Deploy on Vercel

1. https://vercel.com → **Add New → Project** → import the repo. Framework Preset: **Other**. Leave build settings empty. **Deploy**.
2. Firebase → **Authentication → Settings → Authorized domains → Add domain** → your `xxx.vercel.app` domain.

No environment variables are needed.

## 4. Install on phones

- **Android / Chrome / Edge:** tap **Install** in the app header (or the browser menu → *Install app*).
- **iPhone / iPad:** open in Safari → **Share** → **Add to Home Screen**. (The Install button shows these steps.)

## 5. Releasing updates

1. Upload **all** changed files to GitHub (simplest: all files from the zip) → Commit. Vercel redeploys.
2. That's it. When online, the app always loads the newest files; phones switch over by themselves
   (the open app reloads once). The saved offline copy is only used when there's no internet.

**App not loading on a phone?** Tap the red **Repair app** bar, or open `https://YOUR-SITE.vercel.app/?repair` once.
It clears the saved copy on that phone and loads the latest version. Logins and stock are not affected.

## Roles

- **Staff:** see and update stock.
- **Admin:** everything staff can do + the **Admin** page (users and lists).
- The owner email (admins.js + firestore.rules) is always an admin and can't be removed.

## Updating from an older version of this project

Paste the new `firestore.rules` into Firebase → Firestore → **Rules** → **Publish**
(it adds the `settings` rule the Admin → Lists page needs).

## Run locally (optional)

```bash
python3 -m http.server 8000
```

## Data layout

- `items/{id}` — `name, category, unit, qty, min, perPacket, perCarton, packName, cartonName, place, fast, codes[{code, per, n, brand}], createdAt, updatedAt`
  (`qty`, `min`, `perPacket`, `perCarton` are all in the item's unit, e.g. pieces)
- `moves/{id}` — `itemId, name, unit, type (received|used|issued|broken|count), qty, before, after, party, note, by, at, fixOf/fixQty (corrections)`
- `settings/lists` — `units, packings, categories, places, suppliers, outlets, reasons` (admins only can change)
- `settings/access` — `admins[], staff[], people{email: {name, addedAt}}` (who can use the app)
