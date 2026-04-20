const admin = require('firebase-admin');

// Parse service account from GitHub secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'attendance-2d879',
});

const db = admin.firestore();

async function autoClockOut() {
  // Build today's date in IST (YYYY-MM-DD)
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // UTC+5:30
  const istNow = new Date(now.getTime() + istOffset);
  const today = `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth() + 1)}-${pad(istNow.getUTCDate())}`;

  // 7:30 PM IST as a timestamp
  const clockOutTs = new Date(`${today}T19:30:00+05:30`).getTime();

  console.log(`[auto-clockout] Date: ${today} | Clock-out timestamp: ${clockOutTs}`);

  // Fetch all employees
  const empSnap = await db.collection('employees').get();
  if (empSnap.empty) {
    console.log('[auto-clockout] No employees found.');
    process.exit(0);
  }

  let count = 0;
  const batch = db.batch();

  for (const empDoc of empSnap.docs) {
    const empId = empDoc.id;
    const attRef = db.collection('attendance').doc(`${empId}_${today}`);
    const attSnap = await attRef.get();

    if (!attSnap.exists) continue;           // didn't check in today
    const data = attSnap.data();
    if (!data.checkIn || data.checkOut) continue; // no check-in, or already clocked out

    batch.update(attRef, {
      checkOut: clockOutTs,
      autoClockOut: true,
    });
    count++;
    console.log(`[auto-clockout] Queued clock-out for employee: ${empId} (${empDoc.data().name || 'unknown'})`);
  }

  if (count > 0) {
    await batch.commit();
    console.log(`[auto-clockout] ✓ Clocked out ${count} employee(s).`);
  } else {
    console.log('[auto-clockout] No employees needed auto clock-out today.');
  }

  process.exit(0);
}

autoClockOut().catch((err) => {
  console.error('[auto-clockout] ✗ Error:', err);
  process.exit(1);
});
