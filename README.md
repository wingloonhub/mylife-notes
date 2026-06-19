# MyLife Notes

A personal, mobile-friendly notes app with 8 notebooks: Recipes, Personal Records,
Memberships, Party Planner, Trip Planner, Shopping List, Quick Note, Events.

It's a **static site** — no build step. It runs in two modes:

- **Local mode (default):** data is saved in the browser on the device you use. Great
  for trying it out immediately. Password reset happens on-device.
- **Synced mode (Firebase):** real login, password-reset emails, and your notes sync
  across your phone and laptop.

---

## Deploy (GitHub → Vercel)

1. Create a new GitHub repo and upload every file in this folder (keep the structure,
   including the `icons/` folder).
2. In Vercel: **Add New… → Project → Import** that repo.
3. Framework preset: **Other**. Build command: *(leave empty)*. Output dir: `.` (root).
4. Deploy. Open the Vercel URL on your phone.

That's it for local mode — you can sign up and start adding notes.

---

## Add to your phone's home screen (with icon)

**iPhone (Safari):** open the site → Share → **Add to Home Screen**.
**Android (Chrome):** open the site → menu (⋮) → **Install app / Add to Home screen**.

The MyLife icon and standalone full-screen mode are already configured.

---

## Turn on Firebase sync (optional, recommended)

1. Go to <https://console.firebase.google.com> → **Add project**.
2. Add a **Web app** (the `</>` icon) and copy the `firebaseConfig` values.
3. In **Build → Authentication → Sign-in method**, enable **Email/Password**.
4. In **Build → Firestore Database**, create a database (Production mode is fine).
5. In Firestore **Rules**, paste this so each user only sees their own data:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

6. Open `firebase-config.js`, paste your values, and set `ENABLED: true`. Commit/push.
7. Add your Vercel domain under Authentication → **Settings → Authorized domains**.

Password reset emails now work via Firebase.

> Note: notes created in **local mode** live only on that device — they don't move to
> Firebase automatically. Once you're ready to use Firebase, start fresh there.

---

## Event reminders

Open **⚙ Settings** (top-right of the home screen) to choose how long before each event
to be reminded (e.g. 1 hour — changeable any time) and to **turn on reminders**.

- **While the app is open or backgrounded**, it fires a phone notification at your lead
  time. Android Chrome works best; iPhone needs the app on the home screen (iOS 16.4+).
- **When the app is fully closed**, a webpage can't wake itself — that needs an always-on
  sender. The reliable route is **Telegram** below: a scheduled job reads upcoming events
  and messages you at the lead time. Put your Telegram chat ID in Settings.

## Events → Telegram reminders when the app is closed (Phase 2)

A static site can't send a message on a timer by itself — a small scheduler reads upcoming
events from Firestore and pushes them. Because the lead time is "1 hour before", the
scheduler must run often (every ~15 min), so use a **Claude Code scheduled task** (like your
news-digest checker) rather than Vercel's free daily cron. Ask Claude to set this up — it
will read your events + the lead time/Telegram chat ID from Settings and send the reminder.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell + PWA tags |
| `app.js` | Whole app (auth, storage, all notebooks) |
| `styles.css` | Mobile-first styling |
| `firebase-config.js` | Your Firebase keys (off by default) |
| `manifest.webmanifest`, `sw.js` | PWA install + offline shell |
| `icons/` | App icons |
