# ClockIt → Multi-Tenant SaaS: Design Spec

**Date:** 2026-07-14
**Status:** Approved by Kartik (brainstorming session)
**Scope:** Umbrella design for turning ClockIt into a self-serve multi-business attendance product. This spec sets the architecture and phase boundaries; **each phase gets its own detailed design + implementation plan** before any code is written.

## Goal

One person (starting with Kartik) can own multiple businesses; each business has its own locations, employees, and attendance data, fully isolated from other businesses. First deployment: Kartik's 3 businesses. Later: outside businesses sign up self-serve and pay for it. Employees use Android, iPhone, or web; location spoofing is detected where technically possible and surfaced to admins.

**Scale target:** small — ~10–50 employees total initially, growing to a few dozen customer businesses. Cost goal: ₹0/month infrastructure until there are paying customers.

## Decisions made (with reasons)

- **Approach: evolve the current stack in phases** (Cloudflare Pages + Firestore + Cloudflare Worker), not a rewrite on a SQL backend and not clone-per-business. Reasons: production app stays live throughout; free tier covers the target scale; a rewrite risks months of work and a data migration for negligible gain at 50 employees.
- **The "slow opening" problem is the app, not Cloudflare.** The 3,200-line single `index.html` loads the full Firebase SDK and downloads entire collections before rendering. Fixed by the Phase 2 frontend split + Phase 1 scoped queries — not by changing hosts.
- **Mobile apps via Capacitor wrap** of the same web code (one codebase → web + Android + iOS), not separate native apps.
- **Anti-spoofing signals flag, never auto-block.** Consistent with the existing 80m anomaly-queue philosophy: every suspicious check-in lands in the admin anomaly queue with a reason; a human decides.
- **Billing starts manual** (UPI/bank transfer, owner flips a status flag). Razorpay (~2%/txn) only when customer volume justifies it.
- **Auto-clockout stays removed** (explicit prior decision — do not re-add).

## Architecture

Four layers, all on current providers:

1. **Web app** — static, Cloudflare Pages (free). Split into small pages: sign-in, employee clock-in, admin dashboard, owner console. Same code powers the mobile shells.
2. **Database** — Firebase Firestore (Spark/free). Restructured multi-tenant (below). Flip to Blaze pay-as-you-go only when ~15–25 active businesses approach the 50k reads/day limit (est. ₹100–500/month at that point).
3. **Auth** — Firebase Auth (free). Owners/admins: email + password with email reset. Employees: unchanged UX (pick name + 6-digit PIN) — the PIN is verified by the Cloudflare Worker, which mints a Firebase custom token so the session is real and rules-enforceable. Server-side rate limiting on PIN attempts.
4. **Server jobs & API** — existing Cloudflare Worker (free tier, 100k req/day). Daily report cron loops all businesses using each business's own timezone and report time (replaces hardcoded IST). New trusted endpoints: employee PIN sign-in, Play Integrity / App Attest verification, nightly backup export.

### Data model

```
users/{uid}                    # real accounts (owners/admins; employees get one implicitly)
  memberships: { bizId: role } # role = owner | admin | employee

businesses/{bizId}             # name, timezone (IANA), reportTime, status (trial|active|readonly), ownerUid
  locations/{locId}            # name, geofence center + radius
  employees/{empId}            # name, PIN hash, salary, allowed locationIds, linked uid, active flag
  attendance/…                 # scoped per business, queried per month (no full-collection scans)
  devices/{deviceId}           # device binding, as today
  anomalies/…                  # anomaly queue incl. spoofing flags
  settings/…
```

### Security rules (the actual isolation)

- Read/write only for members of the business (role checked from membership).
- Employees may write only their own attendance; may read only their own records + what the clock-in screen needs.
- Salary fields readable only by owner/admin and the employee themself.
- Rules get **automated tests** (Firebase emulator) — tenant isolation is the one property never verified by eyeball alone.

### Backups (Spark has none built in)

Worker cron exports every business's data nightly as JSON to Cloudflare R2 (free ≤10 GB). A restore is rehearsed once, not just assumed.

## Phases (each = its own spec → plan → build cycle)

1. **Phase 1 — Multi-tenant foundation.** Data restructure, Firebase Auth + Worker PIN sign-in, security rules + rules tests, scoped per-month queries, per-business report cron, nightly R2 backups, migration of Titan's live data. Everything else stacks on this.
2. **Phase 2 — Frontend split.** Break `index.html` into small fast pages; fixes load time.
3. **Phase 3 — Mobile apps.** Capacitor shells for Android + iOS with native GPS + integrity signals (below). Store submissions.
4. **Phase 4 — Self-serve + charging.** Signup (email verify → create business → draw geofence → add employees → share link), 30-day trial, manual payment activation, read-only-on-unpaid, signup-abuse caps.

## Anti-spoofing (honest capability statement)

| Platform | Signals | Strength |
|---|---|---|
| Android app | `isFromMockProvider` per GPS fix; Play Integrity verdict verified server-side by Worker at clock-in | Strong — catches mock-location apps and rooted devices |
| iOS app | App Attest (genuine app), basic jailbreak checks | Decent — iOS has no mock-location flag; spoofing requires jailbreak/tethered tools, which is itself the barrier |
| Web | None device-level; check-ins carry a visible "web check-in" lower-trust tag | Fallback only |
| All | Server-issued timestamps (device clock irrelevant); impossible-travel speed check; GPS-accuracy gate; existing 80m anomaly queue | Baseline |

Failures of Play Integrity (sideloaded APK, no-Google-Play phones) degrade to web-trust level — flagged, never blocked.

## Edge cases and their answers

**People & accounts**
- Same person in two businesses: one account, two memberships (roles can differ per business).
- Employee across multiple locations: `allowed locationIds` list; nearest matching geofence wins.
- Employee leaves: deactivate (soft), history retained.
- Duplicate names: internal IDs; picker disambiguates visually.
- Lockouts: employee PIN → admin resets; admin/owner password → email reset. No permanent lockout path.
- Ownership transfer: supported in owner console.

**Location & clock-in**
- Overlapping geofences: nearest recorded; ambiguity logged, not blocked.
- Poor GPS: retry prompt; persistent failure → allowed + flagged. Drift must never mark honest people absent.
- No internet: clear error + retry. True offline queuing is **out of scope** (it would trust device time — the thing being defended against).
- Double-tap: idempotent; duplicates within seconds collapse.
- Forgot checkout: accepted behavior, admin manual entry (no auto-clockout — prior decision).
- Timezones: IANA per business; DST-safe.
- Overnight shifts: **known limitation** (day-based model); revisit only on customer demand.

**Devices & spoofing**
- Shared shop tablet: multiple employees per device allowed and recorded, as today.
- No Play Services / sideloaded: web-trust level, flagged not blocked.
- Developer options / mock flag false positives: anomaly queue, human decides.
- Clock tampering: neutralized by server timestamps.

**Data & money**
- Tenant isolation: rules + automated rules tests.
- Business deleted: soft-delete, 30-day recovery.
- Trial expiry / unpaid: read-only; data always visible and exportable — never held hostage.
- Migration failure: old flat collections stay untouched until the new structure is verified; rollback = repoint.
- Quota spikes: per-month queries and pagination; no full-collection scans anywhere.

**Notifications**
- Daily report per business timezone; business with no registered admin device is skipped gracefully.

## Migration of existing production data (inside Phase 1)

One-time script copies flat collections (`employees`, `attendance`, `devices`, `holidays`, `config`, `settings`, `geofenceAnomalies`) into `businesses/titan-world/…`, preserving PINs, history, and device bindings. Full rehearsal on staging with a copy of prod data; production cutover on a quiet evening; originals retained until verified.

## Testing & rollout

- Existing discipline unchanged: work on `dev` → staging URL (staging Firestore `testclockit-8283d`) → PR to `main`.
- New: Firestore rules tests (emulator), migration rehearsal, physical-device test (1 Android + 1 iPhone) before store submission.
- Dogfooding: Kartik's 3 businesses run every phase before any outside customer onboards.

## Costs

- **Infrastructure: ₹0/month** at target scale (all free tiers). Blaze flip (~₹100–500/mo) only at ~15–25 active businesses — by then revenue exists. Blaze requires a card on file; deferred deliberately.
- **Fixed:** domain ~₹800–1,500/yr; Google Play ~₹2,200 one-time; Apple Developer ~₹8,300/yr (required for iOS, the largest recurring cost); Razorpay ~2%/txn when adopted.

## Out of scope (explicit)

- Auto-clockout (removed by prior decision).
- Offline clock-in queuing.
- Overnight/cross-midnight shifts.
- Payment gateway integration (Phase 4 starts manual).
- Separate native Android/iOS codebases.
