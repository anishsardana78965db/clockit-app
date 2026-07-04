# Daily Attendance Notification — Design

**Date:** 2026-07-05
**Status:** Approved by Kartik (chat, 2026-07-05)

> **Update (same day):** the scheduler moved from Firebase Cloud Functions to a
> **Cloudflare Worker** (`worker/`) with cron triggers — both Firebase projects
> are on the Spark plan, which cannot run Cloud Functions, and Kartik chose not
> to upgrade to Blaze. The `functions/` folder was removed. Everything else in
> this design (data model, absent semantics, message format, app-side changes,
> FCM delivery) is unchanged; only the code that runs at 11:00 AM / 7:30 PM now
> lives on Cloudflare. The audit also found auto-clockout had been dead since
> 2026-05-01; Kartik confirmed he disabled it on purpose and doesn't want it,
> so the Worker runs ONLY the 11 AM report (auto-clockout code and the old
> scripts/auto-clockout.js were removed; the timezone-fix section below is
> historical).

## Requirement

Every day at **11:00 AM IST**, send a push notification to Kartik's and
Mukesh's phones listing every employee who has checked in (with check-in
time). Employees who have not checked in by 11:00 AM are **marked absent in
the database**; a later check-in overrides the absent mark and the day counts
normally.

## Decisions (from Q&A)

- **Absent semantics:** written to the attendance record at 11 AM, overridable by a later check-in. Salary/calendar logic keys off `checkIn` only, so an absent mark never affects pay math.
- **Recipients:** both are Android users and registered employees in the app. Recipients are chosen via a per-employee **"Daily report" toggle in the Admin Panel** (no hardcoded names).
- **Channel:** Firebase Cloud Messaging (FCM) web push — free, no new accounts. WhatsApp/SMS and email were considered and rejected (cost/setup burden, poor fit).
- **Format:** team is ≤10, so the full list fits in the notification body.

## Architecture

Three pieces, following existing patterns:

### 1. Cloud Function `dailyAttendanceReport` (functions/index.js)

`onSchedule("0 11 * * *", timeZone Asia/Kolkata)` — same pattern as
`autoClockOut`. Steps:

1. Compute today's IST date string.
2. Read all `employees`; for each, read `attendance/{empId}_{date}`.
3. Checked in → add "Name — 9:04 AM" line. Not checked in → write `{ absent: true, markedAbsentAt, employeeId, date }` (merge) and add to absent list.
4. Build message: title `ClockIt — Attendance 05 Jul`, body `✅ N checked in · ❌ M absent` + per-employee lines + `Absent: X, Y`.
5. Send via FCM to every employee doc with `dailyReport === true` and a saved `fcmToken`. Per-token failures are logged and don't block other recipients.

### 2. Service worker `firebase-messaging-sw.js` (new, repo root)

Minimal FCM compat service worker so notifications arrive when the app is
closed. Selects production vs staging Firebase config by hostname, same as
`index.html`.

### 3. App changes (index.html)

- **Push registration:** after login, if the employee's record has `dailyReport === true`, ask notification permission, get an FCM token (using a per-project VAPID key), and save it to the employee doc as `fcmToken`. Fire-and-forget; never blocks login. No permission prompt for non-recipients.
- **Admin Panel:** "🔔 Daily report" on/off button on each employee card, writing `dailyReport` to the employee doc.
- **Check-in:** `doCheckIn` additionally writes `absent: false` so a late check-in visibly clears the 11 AM absent mark in the data.
- **VAPID keys:** two constants (production + staging) pasted from the Firebase Console by Kartik — the only manual setup step. Registration no-ops with a console warning while a key is missing.

## Data model additions

- `employees/{id}`: `dailyReport: boolean`, `fcmToken: string`, `fcmTokenAt: number`
- `attendance/{empId}_{date}`: `absent: boolean`, `markedAbsentAt: number`

All additions pass existing Firestore rules; the Cloud Function uses the
Admin SDK which bypasses rules.

## Also included: autoClockOut timezone fix

Existing bug: `schedule: "30 14 * * *"` with `timeZone: "Asia/Kolkata"` fires
at **2:30 PM IST**, not the intended 7:30 PM (the cron is interpreted in the
given timezone, so the UTC conversion in the comment is wrong). Fixed to
`"30 19 * * *"`.

## Error handling

- Expired/invalid token: logged, other recipients still receive; fix is re-opening the app on that phone.
- Scheduler retries up to 3× on failure.
- Zero check-ins still sends ("everyone absent") — silence always means something is broken, never ambiguity.

## Testing (staging first, per project workflow)

1. Deploy functions to staging project `testclockit-8283d`; push `dev` so Cloudflare Pages staging serves the new frontend + service worker.
2. Enable the toggle for a test employee, log in on a phone, allow notifications, confirm token saved.
3. Force-run the scheduler job from Google Cloud Console → verify notification content, absent marks written, and that a later check-in clears the absent mark.
4. Then merge to `main` via PR and repeat setup on production.

## Out of scope

- iPhone support work (both recipients are Android; revisit if that changes).
- Tap-to-open detailed report screen (list fits in the notification; add if team grows past ~10).
- PNG app icon (not needed for Android push).
