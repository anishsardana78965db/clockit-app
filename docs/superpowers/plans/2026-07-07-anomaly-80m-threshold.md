# Anomaly Queue 80m Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin "🚨 Geofence anomalies" queue only shows events more than 80m from the store; off-site checkouts >80m now appear in it; everything is still recorded.

**Architecture:** Single static file, `index.html`, inline ES-module script talking straight to Firestore. Three touch points: a new constant, a display filter in `loadGeofenceAnomalies()`, and a fire-and-forget queue write in `doCheckOut()`. No build step — pushing to `dev` auto-deploys staging at dev.clockit-wot.pages.dev.

**Tech Stack:** Vanilla JS + Firebase Firestore (web SDK). No test framework exists; verification is against the staging database (`testclockit-8283d`), which the app uses automatically on any hostname other than `clockit-wot.pages.dev` (including localhost).

**Spec:** `docs/superpowers/specs/2026-07-07-anomaly-80m-threshold-design.md`

## Global Constraints

- Do NOT change the geofence radius (`radiusM` = 50 in Firestore `settings/store`) or any geofence settings.
- Do NOT touch the check-in hard block or the spoof-detection scoring/recording.
- The new checkout write must be fire-and-forget: it can never block, slow, or fail the employee's checkout.
- Work on `dev` branch only; production merges go through a PR to `main`.

---

### Task 1: Threshold constant, display filter, off-site checkout entries

**Files:**
- Modify: `index.html:1950` (constants), `index.html:2125` (doCheckOut), `index.html:2143` (doCheckOut write), `index.html:2907` (ANOMALY_TAG_LABELS), `index.html:2926-2928` (loadGeofenceAnomalies filter)
- Test: none (no framework — staging verification in steps 5–7)

**Interfaces:**
- Consumes: existing `haversineDistance`, `setDoc`/`doc`/`db`, `currentEmp`, `todayStr()`, `loadGeofenceAnomalies()` — all already defined in `index.html`.
- Produces: `ANOMALY_SHOW_MIN_DIST_M` (number, 80) used by both the filter and the checkout write; new `geofenceAnomalies` docs with ID `{employeeId}_{date}_out` and tag `off-site-checkout`.

- [ ] **Step 1: Add the constant** — after line 1950 (`let STORE_RADIUS_M = DEFAULT_STORE_RADIUS_M;`):

```js
// Anomaly queue display threshold — events at or under this distance are
// recorded but hidden from the admin review list.
const ANOMALY_SHOW_MIN_DIST_M = 80;
```

- [ ] **Step 2: Filter the admin list** — in `loadGeofenceAnomalies()`, extend the existing filter chain:

```js
    const rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => (r.createdAt ?? 0) >= cutoff)
      .filter(r => r.distanceM == null || r.distanceM > ANOMALY_SHOW_MIN_DIST_M);
```

(`distanceM == null` still shows — a queue entry with no recorded distance is itself suspicious; safe default.)

- [ ] **Step 3: Label the new tag** — in `ANOMALY_TAG_LABELS`:

```js
  'accuracy-distance-mismatch': 'Accuracy/distance mismatch',
  'off-site-checkout': 'Off-site checkout'
```

- [ ] **Step 4: Write off-site checkouts to the queue** — in `doCheckOut()`:

4a. Capture accuracy alongside the existing coords (line ~2120–2125), so the queue's "±Xm" detail renders:

```js
  let lat = null, lng = null, distanceM = null, accuracyM = null, outsideFence = false, gpsUnavailable = false;
  try {
    const pos = await getLocation();
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
    accuracyM = pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null;
    distanceM = Math.round(haversineDistance(lat, lng, STORE_LAT, STORE_LNG));
    outsideFence = distanceM > STORE_RADIUS_M;
```

4b. After `todayRecord = { ...todayRecord, ...update };` (line ~2144), add the fire-and-forget write, mirroring the check-in anomaly pattern:

```js
  // Off-site checkout beyond the display threshold goes to the admin anomaly
  // queue. Fire-and-forget — must never block or slow down checkout.
  if (distanceM != null && distanceM > ANOMALY_SHOW_MIN_DIST_M) {
    (async () => {
      try {
        await setDoc(doc(db, 'geofenceAnomalies', `${currentEmp.id}_${today}_out`), {
          employeeId: currentEmp.id,
          employeeName: currentEmp.name || '',
          date: today,
          tags: ['off-site-checkout'],
          lat, lng,
          accuracyM,
          distanceM,
          createdAt: now
        });
      } catch(e) {
        console.warn('[ClockIt] off-site checkout anomaly write failed:', e);
      }
    })();
  }
```

- [ ] **Step 5: Plant staging test docs** — two fake queue entries in the STAGING Firestore (`testclockit-8283d`, API key `AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ`, world-writable rules), one at 150m (must show) and one at 30m (must be hidden). `createdAt` must be current epoch millis (list drops entries older than 30 days):

```bash
NOW=$(date +%s)000
curl -s -X PATCH "https://firestore.googleapis.com/v1/projects/testclockit-8283d/databases/(default)/documents/geofenceAnomalies/TEST_far?key=AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ" \
  -H 'Content-Type: application/json' -d "{\"fields\":{\"employeeId\":{\"stringValue\":\"TEST\"},\"employeeName\":{\"stringValue\":\"Filter Test FAR\"},\"date\":{\"stringValue\":\"2026-07-07\"},\"tags\":{\"arrayValue\":{\"values\":[{\"stringValue\":\"off-site-checkout\"}]}},\"distanceM\":{\"integerValue\":\"150\"},\"createdAt\":{\"integerValue\":\"$NOW\"}}}"
curl -s -X PATCH "https://firestore.googleapis.com/v1/projects/testclockit-8283d/databases/(default)/documents/geofenceAnomalies/TEST_near?key=AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ" \
  -H 'Content-Type: application/json' -d "{\"fields\":{\"employeeId\":{\"stringValue\":\"TEST\"},\"employeeName\":{\"stringValue\":\"Filter Test NEAR\"},\"date\":{\"stringValue\":\"2026-07-07\"},\"tags\":{\"arrayValue\":{\"values\":[{\"stringValue\":\"round-accuracy\"}]}},\"distanceM\":{\"integerValue\":\"30\"},\"createdAt\":{\"integerValue\":\"$NOW\"}}}"
```

Expected: each curl returns the created document JSON.

- [ ] **Step 6: Verify the filter locally** — serve `index.html` on localhost (uses staging DB automatically), open the admin panel's anomalies section, confirm "Filter Test FAR · 150m" is listed and "Filter Test NEAR" is NOT. Checkout-path verification: stub geolocation in the browser console to a point >80m from the store and run a check-in/checkout as a test employee, then confirm a `{id}_{date}_out` doc appears in staging `geofenceAnomalies` (readable via the same REST URL). If UI login isn't possible, hand checkout verification to Kartik on staging.

- [ ] **Step 7: Clean up test docs**

```bash
curl -s -X DELETE "https://firestore.googleapis.com/v1/projects/testclockit-8283d/databases/(default)/documents/geofenceAnomalies/TEST_far?key=AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ"
curl -s -X DELETE "https://firestore.googleapis.com/v1/projects/testclockit-8283d/databases/(default)/documents/geofenceAnomalies/TEST_near?key=AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ"
```

- [ ] **Step 8: Commit and push `dev`, then open PR `dev` → `main`**

```bash
git add index.html
git commit -m "Show anomalies only beyond 80m; add off-site checkout entries"
git push origin dev
```

PR via GitHub web (no gh CLI on this machine): https://github.com/anishsardana78965db/clockit-app/compare/main...dev
