const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();

/**
 * autoClockOut — runs every day at 7:30 PM IST (14:00 UTC).
 * Finds all employees who checked in today but have no checkOut,
 * and writes a checkOut timestamp of 7:30 PM for them.
 */
exports.autoClockOut = onSchedule(
  {
    schedule: "30 14 * * *", // 14:30 UTC = 7:30 PM IST (UTC+5:30)
    timeZone: "Asia/Kolkata",
    retryCount: 3,
  },
  async (event) => {
    const db = getFirestore();

    // Build today's date string in IST (YYYY-MM-DD)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
    const istNow = new Date(now.getTime() + istOffset);
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth() + 1)}-${pad(istNow.getUTCDate())}`;

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
