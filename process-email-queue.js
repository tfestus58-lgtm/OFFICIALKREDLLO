/**
 * Netlify Scheduled Function: process-email-queue.js
 * Path: netlify/functions/process-email-queue.js
 * Schedule: every 5 minutes (cron: 5-minute interval)
 *
 * Processes delayed emails from the email-queue Firestore collection.
 *
 * Logic per queued document:
 *   1. Check if sendAfter timestamp has passed. (Firestore query handles this.)
 *   2. Fetch the corresponding in-app notification document.
 *   3. If the user has already READ the notification — skip the email.
 *      Mark queue doc as sent with skippedReason = 'read-by-user'.
 *   4. If not read — send the email via send-email function.
 *      Mark queue doc sent=true, update notification emailSent=true.
 *
 * Firestore email-queue document schema:
 *   {
 *     userUid:    string
 *     notifDocId: string | null
 *     templateId: string
 *     emailData:  object
 *     sendAfter:  number (Unix ms timestamp)
 *     sent:       boolean
 *     createdAt:  Timestamp
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb() {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

/* ── Call a sibling Netlify function ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    return res;
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async () => {

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = Date.now();

  /* ── Query: unsent docs whose sendAfter has passed ── */
  let snapshot;
  try {
    snapshot = await db
      .collection('email-queue')
      .where('sent', '==', false)
      .where('sendAfter', '<=', now)
      .limit(20)
      .get();
  } catch (err) {
    console.error('Firestore email-queue query failed:', err.message);
    return respond(500, { error: 'Queue query failed.' });
  }

  if (snapshot.empty) {
    console.log('process-email-queue: no pending items.');
    return respond(200, { processed: 0 });
  }

  console.log(`process-email-queue: processing ${snapshot.size} item(s).`);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const queueDoc of snapshot.docs) {
    const queueData = queueDoc.data();
    const { userUid, notifDocId, templateId, emailData } = queueData;

    const queueRef = db.collection('email-queue').doc(queueDoc.id);

    /* ── Check if notification was already read ── */
    let notificationRead = false;

    if (notifDocId && userUid) {
      try {
        const notifSnap = await db
          .collection('users').doc(userUid)
          .collection('notifications').doc(notifDocId)
          .get();

        if (notifSnap.exists && notifSnap.data().read === true) {
          notificationRead = true;
        }
      } catch (err) {
        // If we can't read the notification doc, err on the side of sending
        console.warn(`Could not read notification doc ${notifDocId} for uid ${userUid}:`, err.message);
      }
    }

    /* ── Skip if already read ── */
    if (notificationRead) {
      try {
        await queueRef.update({
          sent:          true,
          skippedReason: 'read-by-user',
          processedAt:   new Date().toISOString(),
        });
        console.log(`Skipped email for uid ${userUid} (notification already read), queueDocId ${queueDoc.id}.`);
        skipped++;
      } catch (err) {
        console.error(`Failed to mark queue doc ${queueDoc.id} as skipped:`, err.message);
        errors++;
      }
      continue;
    }

    /* ── Send the email ── */
    try {
      const res = await callFunction('send-email', {
        templateId,
        data: emailData || {},
      });

      if (res && res.ok) {
        // Mark queue doc as sent
        await queueRef.update({
          sent:        true,
          sentAt:      new Date().toISOString(),
          processedAt: new Date().toISOString(),
        });

        // Update the notification document too
        if (notifDocId && userUid) {
          try {
            await db
              .collection('users').doc(userUid)
              .collection('notifications').doc(notifDocId)
              .update({ emailSent: true, emailSentAt: new Date().toISOString() });
          } catch (err) {
            // Non-fatal
            console.warn(`Could not update emailSent on notification ${notifDocId}:`, err.message);
          }
        }

        console.log(`Email sent for uid ${userUid}, template ${templateId}, queueDocId ${queueDoc.id}.`);
        processed++;
      } else {
        const status = res ? res.status : 'no response';
        console.error(`send-email returned ${status} for uid ${userUid}, queueDocId ${queueDoc.id}.`);
        errors++;
      }
    } catch (err) {
      console.error(`Error sending email for queueDocId ${queueDoc.id}:`, err.message);
      errors++;
    }
  }

  console.log(`process-email-queue done. processed=${processed} skipped=${skipped} errors=${errors}`);
  return respond(200, { processed, skipped, errors });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
