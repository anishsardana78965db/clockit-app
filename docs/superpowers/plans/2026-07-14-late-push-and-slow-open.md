# Plan: Late 11 AM report notification + slow app opening

**Date:** 2026-07-14
**Status:** Proposed (diagnosis done, fixes not yet applied)
**Scope:** Two production annoyances, independent of the SaaS phases. Both are small.

## Problem 1 — 11 AM report arrives at 2–4 PM

### Diagnosis

Not Cloudflare, not GitHub (GitHub only hosts code; it sends nothing).
`worker/worker.js` `sendPush()` sends FCM web-push with **no urgency header**.
Web push defaults to *normal* priority; Android defers normal-priority pushes
while the phone dozes and delivers them when the device wakes — hours later.
The cron almost certainly fires on time at 05:30 UTC; the phone sits on the message.

### Fix (worker.js, ~3 lines)

Add to the FCM message:

```js
webpush: {
  headers: { Urgency: "high", TTL: "7200" },   // deliver now; drop if undeliverable for 2h
  fcm_options: { link: "/" },
},
```

- `Urgency: high` — asks Android to deliver immediately.
- `TTL: 7200` — a report that can't be delivered within 2 hours is dropped, not
  delivered stale at 4 PM (opening the app shows the same info anyway).

### Verification

1. One-time: check Cloudflare dashboard → Worker → cron invocation history to
   confirm the cron itself fires ~05:30 UTC (rules out the other theory).
2. Add the generation time to the notification body ("Report for 14 Jul · 11:00 AM")
   so any future delay is self-evident from the notification itself.
3. Deploy to staging worker first, trigger via `/run/daily` test endpoint,
   confirm prompt delivery; then deploy production and observe next morning.

### Device-side note (no code)

On phones that still get late pushes after the fix: Android Settings → Apps →
Chrome → Battery → set to "Unrestricted", and keep the ClockIt PWA installed.
Aggressive OEM battery savers (Xiaomi/Oppo/Vivo) can still defer pushes; that
part is physics, not our bug.

## Problem 2 — slow app opening

### Diagnosis

Not Cloudflare (static file delivery is fast). The page:
1. loads the Firebase SDK from Google's CDN,
2. then runs **sequential** Firestore reads (holidays → employees → devices …)
   before rendering anything useful. Each round-trip waits for the previous one.

Deep fix is already planned (Phase 1 scoped queries + Phase 2 page split).
These quick wins are worth shipping now:

### Fixes (index.html only)

1. **Parallelize boot reads** — `Promise.all` the independent `getDocs` calls
   instead of awaiting them one by one. Biggest single win, zero risk.
2. **Cache-first render** — keep the last employee list (names only — no PINs,
   no salaries) in `localStorage`; render the name picker instantly on load,
   refresh from Firestore in the background and reconcile. App feels instant
   on every open after the first.
3. **Preconnect hints** — `<link rel="preconnect">` for
   `firestore.googleapis.com`, `www.gstatic.com`, `identitytoolkit.googleapis.com`
   so TLS handshakes overlap with page parse.

### Verification

Measure before/after: open staging URL with DevTools Network tab (mobile
throttling), note time to interactive name picker. Target: cached opens render
the picker < 1s; cold opens improve by the sum of the formerly-serial reads.

## Rollout

Both fixes: `dev` branch → staging URL + staging worker → verify → PR to `main`.
Worker deploy: `wrangler deploy` (staging) / `wrangler deploy --env production`.

## Out of scope

- Frontend split (Phase 2 of the SaaS spec).
- Auto-clockout (permanently out — prior decision).
