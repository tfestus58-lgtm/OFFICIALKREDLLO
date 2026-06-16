/**
 * Netlify Function: raise-dispute.js
 * Path: netlify/functions/raise-dispute.js
 *
 * Called when a buyer raises a dispute on a project.
 * - Verifies the caller is the project's buyer
 * - Guards against duplicate disputes
 * - Updates the project: status → disputed, escrowStatus → disputed
 * - Sends notifications to both parties
 *
 * POST body:
 *   { projectId: string, raisedBy: string, raisedByRole: 'buyer', description: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { verifyCaller }                 = require('./_verify-auth');

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

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { projectId, raisedBy, raisedByRole, description } = payload;

  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
  }
  if (!raisedBy || typeof raisedBy !== 'string') {
    return respond(400, { error: 'raisedBy is required.' });
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return respond(400, { error: 'description is required.' });
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
  if (project.buyerUid !== raisedBy) {
    return respond(403, { error: 'You are not authorised to raise a dispute on this project.' });
  }

  /* ── Guard against duplicate disputes ── */
  if (project.status === 'disputed') {
    return respond(409, { error: 'A dispute has already been raised on this project.' });
  }

  /* ── Guard: can only dispute active/delivered projects ── */
  if (!['in_progress', 'delivered', 'active'].includes(project.status)) {
    return respond(400, { error: `Cannot raise a dispute on a project with status "${project.status}".` });
  }

  const projectTitle  = project.projectTitle || 'Your project';
  const freelancerUid = project.freelancerUid || null;
  const buyerUid      = project.buyerUid;

  /* ── Update project: mark as disputed ── */
  try {
    await db.collection('projects').doc(projectId).update({
      status:        'disputed',
      escrowStatus:  'disputed',
      disputeReason: description.trim(),
      disputedBy:    raisedBy,
      disputedByRole: raisedByRole || 'buyer',
      disputedAt:    FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`Dispute raised on project ${projectId} by ${raisedBy}.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${projectId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── Fetch user details for notifications ── */
  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerEmail      = null;
  let buyerName       = 'Client';

  try {
    const fetches = [db.collection('users').doc(buyerUid).get()];
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());

    const [bSnap, fSnap] = await Promise.all(fetches);
    if (bSnap.exists) {
      buyerEmail = bSnap.data().email || null;
      buyerName  = bSnap.data().name  || 'Client';
    }
    if (fSnap && fSnap.exists) {
      freelancerEmail = fSnap.data().email || null;
      freelancerName  = fSnap.data().name  || 'Freelancer';
    }
  } catch (err) {
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;

  /* ── Notify the buyer: dispute received ── */
  await callFunction('send-smart-notification', {
    userUid:    buyerUid,
    title:      'Dispute Submitted',
    body:       `Your dispute for "${projectTitle}" has been received. The Kreddlo team will be in touch.`,
    url:        projectUrl,
    templateId: 'dispute-raised',
    emailMode:  buyerEmail ? 'always' : 'never',
    emailData: {
      name:         buyerName,
      projectTitle,
      description:  description.trim(),
    },
  });

  /* ── Notify the freelancer: dispute raised ── */
  if (freelancerUid) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid,
      title:      'Dispute Raised',
      body:       `A dispute has been raised on "${projectTitle}". Kreddlo support will review shortly.`,
      url:        `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`,
      templateId: 'dispute-raised-freelancer',
      emailMode:  freelancerEmail ? 'always' : 'never',
      emailData: {
        name:         freelancerName,
        projectTitle,
        buyerName,
      },
    });
  }

  return respond(200, {
    success: true,
    message: 'Dispute submitted. The Kreddlo team will be in touch.',
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
