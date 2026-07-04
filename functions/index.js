const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// Build today's date string in IST (YYYY-MM-DD)
function istTodayStr() {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // IST = UTC+5:30
  const pad = (n) => String(n).padStart(2, "0");
  return `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth() + 1)}-${pad(istNow.getUTCDate())}`;
}

/**
 * autoClockOut — runs every day at 7:30 PM IST.
 * Finds all employees who checked in today but have no checkOut,
 * and writes a checkOut timestamp of 7:30 PM for them.
 */
exports.autoClockOut = onSchedule(
  {
    // Cron is interpreted in timeZone, so this is 19:30 IST directly.
    // (Was "30 14 * * *", which fired at 2:30 PM IST — clocking people
    // out five hours early.)
    schedule: "30 19 * * *",
    timeZone: "Asia/Kolkata",
    retryCount: 3,
  },
  async (event) => {
    const db = getFirestore();
    const today = istTodayStr();

    // 7:30 PM IST as a JS timestamp
    const clockOutTs = new Date(
      `${today}T19:30:00+05:30`
    ).getTime();

    console.log(`[autoClockOut] Running for date: ${today}, clockOut ts: ${clockOutTs}`);

    // Fetch all employees
    const empSnap = await db.collection("employees").get();
    if (empSnap.empty) {
      console.log("[autoClockOut] No employees found.");
      return;
    }

    let count = 0;
    const batch = db.batch();

    for (const empDoc of empSnap.docs) {
      const empId = empDoc.id;
      const attRef = db.collection("attendance").doc(`${empId}_${today}`);
      const attSnap = await attRef.get();

      if (!attSnap.exists) continue; // didn't check in today
      const data = attSnap.data();
      if (!data.checkIn || data.checkOut) continue; // already clocked out or no check-in

      batch.update(attRef, {
        checkOut: clockOutTs,
        autoClockOut: true,
      });
      count++;
      console.log(`[autoClockOut] Clocking out employee: ${empId}`);
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[autoClockOut] Done. Clocked out ${count} employee(s).`);
    } else {
      console.log("[autoClockOut] No employees needed auto clock-out.");
    }
  }
);

/**
 * dailyAttendanceReport — runs every day at 11:00 AM IST.
 * Marks employees with no check-in as absent (overridable — a later
 * check-in clears it), then pushes a summary to every employee whose
 * record has dailyReport: true and a saved fcmToken.
 */
exports.dailyAttendanceReport = onSchedule(
  {
    schedule: "0 11 * * *", // 11:00 AM IST (cron interpreted in timeZone)
    timeZone: "Asia/Kolkata",
    retryCount: 3,
  },
  async (event) => {
    const db = getFirestore();
    const today = istTodayStr();
    const fmtIst = (ts) =>
      new Date(ts).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

    const empSnap = await db.collection("employees").get();
    if (empSnap.empty) {
      console.log("[dailyReport] No employees found.");
      return;
    }

    const checkedIn = [];
    const absent = [];
    const recipients = [];
    const absentBatch = db.batch();

    for (const empDoc of empSnap.docs) {
      const emp = empDoc.data();
      const name = emp.name || empDoc.id;
      if (emp.dailyReport === true && emp.fcmToken) {
        recipients.push({ name, token: emp.fcmToken });
      }

      const attSnap = await db
        .collection("attendance")
        .doc(`${empDoc.id}_${today}`)
        .get();

      if (attSnap.exists && attSnap.data().checkIn) {
        checkedIn.push({ name, checkIn: attSnap.data().checkIn });
      } else {
        absent.push(name);
        absentBatch.set(
          attSnap.ref,
          {
            absent: true,
            markedAbsentAt: Date.now(),
            employeeId: empDoc.id,
            date: today,
          },
          { merge: true }
        );
      }
    }

    if (absent.length > 0) await absentBatch.commit();
    console.log(
      `[dailyReport] ${today}: ${checkedIn.length} in, ${absent.length} absent, ${recipients.length} recipient(s).`
    );

    if (recipients.length === 0) {
      console.log("[dailyReport] No recipients with dailyReport + fcmToken. Skipping send.");
      return;
    }

    checkedIn.sort((a, b) => a.checkIn - b.checkIn);
    const lines = checkedIn.map((r) => `${r.name} — ${fmtIst(r.checkIn)}`);
    if (absent.length > 0) lines.push(`Absent: ${absent.join(", ")}`);

    const dayLabel = new Date().toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
    });
    const title = `ClockIt — Attendance ${dayLabel}`;
    const body = `✅ ${checkedIn.length} checked in · ❌ ${absent.length} absent\n${lines.join("\n")}`;

    const messaging = getMessaging();
    for (const r of recipients) {
      try {
        await messaging.send({
          token: r.token,
          notification: { title, body },
          webpush: { fcmOptions: { link: "/" } },
        });
        console.log(`[dailyReport] Sent to ${r.name}.`);
      } catch (e) {
        // ponytail: log-and-continue; recipient re-opens the app to refresh a dead token
        console.error(`[dailyReport] Send failed for ${r.name}: ${e.message}`);
      }
    }
  }
);
