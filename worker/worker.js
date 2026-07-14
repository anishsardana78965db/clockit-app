// ClockIt scheduled jobs — Cloudflare Worker (free plan, cron triggers).
// Replaces the never-deployed Firebase Functions (both Firebase projects are
// on the Spark plan, which cannot run Cloud Functions).
//
// Auth: a Firebase service-account JSON stored as the SERVICE_ACCOUNT secret.
// Its project_id decides which Firestore/FCM project this worker talks to,
// so the same code serves staging and production via wrangler environments.
//
// Job (cron is UTC; IST has no DST so this never shifts):
//   "30 5 * * *" = 11:00 AM IST — daily attendance report + absent marks
// (Auto clock-out deliberately removed 2026-07-05 — Kartik doesn't want it.)

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istTodayStr() {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function fmtIst(ms) {
  return new Date(Number(ms)).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ── Google OAuth from the service account (RS256 JWT via WebCrypto) ──

function b64url(input) {
  const s = typeof input === "string" ? input : String.fromCharCode(...new Uint8Array(input));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)
  );
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("token exchange failed: " + JSON.stringify(j));
  return j.access_token;
}

// ── Firestore REST helpers (only the value types this app uses) ──

const fsBase = (pid) =>
  `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

function dec(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
  }
  return out;
}

function enc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] =
      typeof v === "boolean" ? { booleanValue: v }
      : typeof v === "number" ? { integerValue: String(Math.trunc(v)) }
      : { stringValue: String(v) };
  }
  return { fields };
}

async function fsGetDoc(pid, tok, path) {
  const r = await fetch(`${fsBase(pid)}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return dec((await r.json()).fields);
}

async function fsMerge(pid, tok, path, obj) {
  const mask = Object.keys(obj).map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const r = await fetch(`${fsBase(pid)}/${path}?${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(enc(obj)),
  });
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`);
}

// ponytail: one query, limit 100; fine for a single-store team. Paginate if
// the business somehow grows past 100 employees.
async function listEmployees(pid, tok) {
  const r = await fetch(`${fsBase(pid)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "employees" }], limit: 100 } }),
  });
  if (!r.ok) throw new Error(`employees query: ${r.status}`);
  return (await r.json())
    .filter((row) => row.document)
    .map((row) => ({ id: row.document.name.split("/").pop(), ...dec(row.document.fields) }));
}

async function sendPush(pid, tok, deviceToken, title, body) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        webpush: {
          // Urgency: Android defers normal-priority pushes while dozing —
          // this is what made 11 AM reports arrive at 2-4 PM.
          // TTL: undeliverable within 2h → drop, don't deliver stale.
          headers: { Urgency: "high", TTL: "7200" },
          fcm_options: { link: "/" },
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`FCM ${r.status}: ${await r.text()}`);
}

// ── Jobs ──

async function dailyReport(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const pid = sa.project_id;
  const tok = await getAccessToken(sa);
  const today = istTodayStr();

  const employees = await listEmployees(pid, tok);
  const checkedIn = [];
  const absent = [];

  for (const emp of employees) {
    const att = await fsGetDoc(pid, tok, `attendance/${emp.id}_${today}`);
    if (att && att.checkIn) {
      checkedIn.push({ name: emp.name || emp.id, checkIn: att.checkIn });
    } else {
      absent.push(emp.name || emp.id);
      // Overridable: doCheckIn writes absent:false on a late check-in.
      await fsMerge(pid, tok, `attendance/${emp.id}_${today}`, {
        absent: true,
        markedAbsentAt: Date.now(),
        employeeId: emp.id,
        date: today,
      });
    }
  }

  checkedIn.sort((a, b) => a.checkIn - b.checkIn);
  const lines = checkedIn.map((r) => `${r.name} — ${fmtIst(r.checkIn)}`);
  if (absent.length) lines.push(`Absent: ${absent.join(", ")}`);

  const dayLabel = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
  });
  // Generation time in the title makes any future delivery delay self-evident.
  const title = `ClockIt — Attendance ${dayLabel} · ${fmtIst(Date.now())}`;
  const body = `✅ ${checkedIn.length} checked in · ❌ ${absent.length} absent\n${lines.join("\n")}`;

  const recipients = employees.filter((e) => e.dailyReport === true && e.fcmToken);
  const results = [];
  for (const r of recipients) {
    try {
      await sendPush(pid, tok, r.fcmToken, title, body);
      results.push(`sent:${r.name}`);
    } catch (e) {
      // log-and-continue; recipient re-opens the app to refresh a dead token
      results.push(`FAILED:${r.name}:${e.message}`);
    }
  }
  return `[dailyReport] ${today} in=${checkedIn.length} absent=${absent.length} → ${results.join(" | ") || "no recipients configured"}`;
}

// ── Entry points ──

export default {
  async scheduled(event, env, ctx) {
    console.log(await dailyReport(env));
  },

  // Manual trigger for testing: /run/daily?key=…
  // (key must match the TRIGGER_KEY secret)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/run/daily") return new Response(await dailyReport(env));
    return new Response("not found", { status: 404 });
  },
};
