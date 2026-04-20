# Firestore Rules — Deployment Guide

You've shipped Phase 2, which moves admin and employee PINs out of plaintext
Firestore fields and into PBKDF2 hashes. This guide walks you through pasting
the new rules into the Firebase Console.

## Why rules matter here

ClockIt has no Firebase Auth — anyone on the internet with your config values
could theoretically write to your Firestore project. The rules in
`firestore.rules` are defense-in-depth: they don't authenticate users, but
they shape-check writes so a random client can't wipe `pinHash` fields or
create malformed attendance records.

If you later add Firebase Auth (email/password admin account, for example),
you can tighten these rules by requiring `request.auth != null` on writes.

## Step-by-step

1. Go to <https://console.firebase.google.com/> and pick your ClockIt project.
2. In the left sidebar, click **Build → Firestore Database**.
3. Across the top of the Firestore page there are tabs: **Data · Rules ·
   Indexes · Usage**. Click **Rules**.
4. You'll see the current rules in an editor. Select all and replace with the
   contents of `firestore.rules` (sitting next to this guide).
5. Click **Publish** in the top right. The Console will show "Rules published
   successfully" when it takes effect (usually within a few seconds).

## Before you publish — sanity checklist

Run through these so you don't lock yourself out:

- [ ] You've already run the one-time PIN migration at least once (so
      `config/admin` exists in Firestore). The rules allow writes to
      `config/*` only when `pinHash` and `pinSalt` are present, which matches
      how `writeAdminPin` writes.
- [ ] You have at least one test employee in the system.
- [ ] You know your admin PIN — if the rules happen to reject a fix-up
      write, you'll need to log in to retry.

## What the rules allow/block

**Allowed (reads):** Everything. The app needs to list employees, read
attendance, read the admin config to verify the hash, and read holidays.

**Allowed (writes):**
- Attendance records with a valid `employeeId` and `YYYY-MM-DD` date.
- Employee documents with either `pinHash` (new flow) or `pin` (legacy, for
  backward compatibility during rollout).
- Holidays where the document ID matches `YYYY-MM-DD`.
- Store settings and devices (unrestricted — these are shape-safe by the app).
- `config/admin` and any other config doc, only if `pinHash` + `pinSalt` are
  present on the write.

**Blocked:**
- Writes to any path not listed above (`match /{document=**}` catch-all).
- Employee updates that remove hashed PIN fields without providing
  replacements.
- Attendance records missing `employeeId` or with malformed dates.

## Testing the rules

The Console has a **Rules Playground** (top right of the Rules tab). You can
simulate a read/write against a path and see if the rules allow it. A few
useful sanity tests:

1. **Read employees** → `get /employees/any_id` — should be `Allow`.
2. **Write a bad attendance record** → `create /attendance/test_doc` with
   body `{ "foo": 1 }` — should be `Deny`.
3. **Read admin config** → `get /config/admin` — should be `Allow` (needed
   by the login flow).

## If something breaks

If the app starts failing after you publish, open DevTools → Console on the
app and look for `FirebaseError: Missing or insufficient permissions`. The
error message will tell you which path and operation was blocked. Either fix
the rule or revert to the previous version via the **Rule history** link in
the Console.
