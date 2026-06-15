/**
 * Netlify Function: approve-delivery.js
 * Path: netlify/functions/approve-delivery.js
 *
 * Called when a buyer approves a delivered project.
 * - Verifies the caller is the project's buyer
 * - Updates the project: status → completed, escrowStatus → releasing
 * - Credits the net amount to the freelancer's availableBalance
 * - Sends push notification to the freelancer
 * - Triggers emails to both parties via send-email
 *
 * POST body:
 *   { projectId: string, buyerUid: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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

/* ── Internal function caller (function-to-function via HTTP) ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — the core Firestore update already succeeded
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { projectId, buyerUid } = payload;

  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }
  if (!buyerUid || typeof buyerUid !== 'string') {
    return respond(400, { error: 'buyerUid is required.' });
  }

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Fetch project ── */
  let projectSnap;
  try {
    projectSnap = await db.collection('projects').doc(projectId).get();
  } catch (err) {
    console.error(`Firestore read failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!projectSnap.exists) {
    return respond(404, { error: 'Project not found.' });
  }

  const project = projectSnap.data();

  /* ── Verify caller is the project buyer ── */
  if (project.buyerUid !== buyerUid) {
    return respond(403, { error: 'You are not authorised to approve this delivery.' });
  }

  /* ── Guard against double-approval ── */
  if (project.status === 'completed') {
    return respond(409, { error: 'This delivery has already been approved.' });
  }

  /* ── Guard: project must be in a deliverable state ── */
  if (!['in_progress', 'delivered'].includes(project.status)) {
    return respond(400, { error: `Cannot approve a project with status "${project.status}".` });
  }

  const netAmount      = Number(project.netAmount || 0);
  const freelancerUid  = project.freelancerUid || null;
  const projectTitle   = project.projectTitle || 'Your project';

  if (!freelancerUid) {
    return respond(400, { error: 'Project has no freelancer assigned.' });
  }
  if (netAmount <= 0) {
    return respond(400, { error: 'Project net amount is zero or not set.' });
  }

  /* ── Update project: mark as completed ── */
  try {
    await db.collection('projects').doc(projectId).update({
      status:       'completed',
      escrowStatus: 'releasing',
      completedAt:  FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    });
    console.log(`Project ${projectId} marked completed.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── Credit the freelancer's availableBalance ── */
  try {
    await db.collection('users').doc(freelancerUid).update({
      availableBalance: FieldValue.increment(netAmount),
      totalEarned:      FieldValue.increment(netAmount),
      updatedAt:        FieldValue.serverTimestamp(),
    });
    console.log(`Credited $${netAmount} to freelancer ${freelancerUid}.`);
  } catch (err) {
    console.error(`Failed to credit freelancer ${freelancerUid}:`, err.message);
    // We still continue — the project is marked completed. Admin can manually credit.
  }

  /* ── Fetch user details for notifications and emails ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const [fSnap, bSnap] = await Promise.all([
      db.collection('users').doc(freelancerUid).get(),
      db.collection('users').doc(buyerUid).get(),
    ]);
    if (fSnap.exists) {
      freelancerEmail = fSnap.data().email || null;
      freelancerName  = fSnap.data().name  || 'Freelancer';
    }
    if (bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`;

  /* ── Notify the freelancer: payment received ── */
  await callFunction('send-smart-notification', {
    userUid:    freelancerUid,
    to:         freelancerEmail || null,
    title:      'Work Approved',
    body:       `"${projectTitle}" has been approved. Your payment is on its way.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  'always',
    data: {
      name:         freelancerName,
      projectTitle,
      amount:       `$${netAmount.toFixed(2)}`,
      buyerName,
    },
  });

  /* ── Notify the buyer: work delivered ── */
  if (buyerEmail) {
    await callFunction('send-smart-notification', {
      userUid:      null,
      to:           buyerEmail,
      title:        'Work Delivered',
      body:         `"${projectTitle}" has been marked as delivered. Please review and approve.`,
      url:          projectUrl,
      templateId:   'work-delivered',
      emailMode:    'delayed',
      delayMinutes: 15,
      data: {
        name:           buyerName,
        projectTitle,
        freelancerName,
      },
    });
  }

  return respond(200, {
    success: true,
    message: `Delivery approved. $${netAmount.toFixed(2)} credited to ${freelancerName}.`,
  });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
