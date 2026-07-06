# Geofence anomaly queue — 80m display threshold + off-site checkout entries

**Date:** 2026-07-07
**Status:** Approved by Kartik (Option B)

## Problem

The admin "🚨 Geofence anomalies" queue shows spoof-detection flags (round GPS
accuracy, identical coordinates, impossible travel, accuracy mismatch) for
check-ins at *any* distance — including employees standing right at the store.
Kartik has to dismiss each one. He considers anything within 80m of the store
fine and only wants to review events farther than that.

## Facts established during design

- Live production geofence (Firestore `settings/store`): lat 25.908917,
  lng 93.72174, **radius 50m**. Kartik confirmed: do NOT change the radius.
- Check-in is **hard-blocked** beyond the radius (`doCheckIn`), so a recorded
  check-in can never be more than 50m away — and therefore never more than 80m.
- Check-out is **soft** (`doCheckOut`): always succeeds, logs distance and an
  `outsideFence` flag on the attendance record, but writes nothing to the
  anomaly queue today.
- The anomaly queue (`geofenceAnomalies` collection) is written only at
  check-in, doc ID `{employeeId}_{date}`.

## Decision

Option B — record everything, filter the display, and add off-site checkouts
to the queue so it shows exactly "check in/out more than 80m away":

1. **New constant** `ANOMALY_SHOW_MIN_DIST_M = 80` in `index.html` next to the
   other geofence constants. Single place to tune later.
2. **Display filter** in `loadGeofenceAnomalies()`: skip entries whose
   `distanceM` is ≤ 80. Entries with no recorded distance still show (safe
   default). Nothing is deleted — filtered entries stay in Firestore.
3. **Off-site checkout entries** in `doCheckOut()`: when checkout distance
   > 80m, write a `geofenceAnomalies` doc with tag `off-site-checkout` and
   doc ID `{employeeId}_{date}_out` (never collides with a check-in flag from
   the same day). Fire-and-forget, mirroring the existing check-in anomaly
   write — must never block or slow down checkout.
4. **Label** `off-site-checkout` → "Off-site checkout" added to
   `ANOMALY_TAG_LABELS` so the queue renders it readably.

## Explicitly unchanged

- 50m radius and all geofence settings
- Check-in hard block
- Spoof-detection scoring and recording (still runs and writes for all check-ins)
- Dismiss button (works as-is for new entries)
- Off-site chip on attendance records

## Consequence accepted by Kartik

Because check-ins can't exceed 50m, check-in spoof flags will no longer appear
in the queue (they are still recorded in Firestore for later review if ever
needed). The queue will show only off-site checkouts > 80m.

## Testing

On `dev` branch → staging (dev.clockit-wot.pages.dev, staging Firebase
`testclockit-8283d`): plant one fake queue entry at >80m (must show) and one at
30m (must be hidden); verify a real checkout writes the new entry only when
> 80m. Then PR `dev` → `main`.
