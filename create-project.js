/**
 * Netlify Function: create-project.js
 * Path: netlify/functions/create-project.js
 *
 * Creates a new project document in the Firestore `projects` collection
 * when a buyer hires a freelancer through profile.html.
 *
 * This is the missing create path that payment functions
 * (create-stripe-payment, create-flutterwave-payment, create-crypto-payment)
 * assume already exists before they try to read the project doc.
 *
 * Flow:
 *  1. Verify caller identity (Firebase ID token)
 *  2. Validate request body
 *  3. Guard: buyer cannot hire themselves
 *  4. Guard: freelancer must exist and have kycStatus === 'verified'
 *  5. Write a new `projects` document with status 'pending_payment'
 *  6. Return { projectId } to the frontend
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *
 * Expected POST body (JSON):
 *   {
 *     freelancerUid:    string   — UID of the freelancer being hired
 *     title:            string   — project title
 *     description:      string   — scope of work
 *     budget:           number   — agreed budget in USD
 *     deadline:         string   — ISO date string e.g. "2026-08-01"
 *     buyerSignature:   string   — base64 PNG of buyer signature (no data: prefix)
 *     withProtection:   boolean  — whether buyer opted into project protection
 *   }
 *
 * Success response (200):
 *   { projectId: string }
 *
 * Error responses:
 *   400 — missing/invalid fields
 *   401 — not authenticated
 *   403 — freelancer not verified, or buyer trying to hire themselves
 *   404 — freelancer not found
 *   500 — internal error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { verifyCaller }                  = require('./_verify-auth');

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

/* ── Utility: build a Netlify function response ── */
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

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 1. Verify caller identity ── */
  const buyerUid = await verifyCaller(event);
  if (!buyerUid) {
    return respond(401, { error: 'Unauthorized. Please log in again.' });
  }

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const {
    freelancerUid,
    title,
    description,
    budget,
    deadline,
    buyerSignature = '',
    withProtection = false,
  } = body;

  if (!freelancerUid || typeof freelancerUid !== 'string' || !freelancerUid.trim()) {
    return respond(400, { error: 'freelancerUid is required.' });
  }
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return respond(400, { error: 'A project title of at least 3 characters is required.' });
  }
  if (!description || typeof description !== 'string' || description.trim().length < 20) {
    return respond(400, { error: 'A project description of at least 20 characters is required.' });
  }
  const budgetNum = Number(budget);
  if (!budgetNum || budgetNum <= 0) {
    return respond(400, { error: 'A valid budget greater than 0 is required.' });
  }
  if (!deadline || typeof deadline !== 'string' || !deadline.trim()) {
    return respond(400, { error: 'A project deadline is required.' });
  }
  // Validate deadline is in the future
  const deadlineDate = new Date(deadline + 'T00:00:00Z');
  if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
    return respond(400, { error: 'Deadline must be a valid future date.' });
  }

  /* ── 3. Guard: buyer cannot hire themselves ── */
  if (buyerUid === freelancerUid.trim()) {
    return respond(403, { error: 'You cannot hire yourself.' });
  }

  try {
    const db = getDb();

    /* ── 4a. Fetch buyer info ── */
    const buyerSnap = await db.collection('users').doc(buyerUid).get();
    if (!buyerSnap.exists) {
      return respond(404, { error: 'Buyer account not found.' });
    }
    const buyerData = buyerSnap.data();
    const buyerName  = buyerData.displayName || buyerData.name || 'Client';
    const buyerEmail = buyerData.email || '';

    /* ── 4b. Fetch freelancer and guard KYC ── */
    const freelancerSnap = await db.collection('users').doc(freelancerUid.trim()).get();
    if (!freelancerSnap.exists) {
      return respond(404, { error: 'Freelancer not found.' });
    }
    const freelancerData     = freelancerSnap.data();
    const freelancerName     = freelancerData.displayName || freelancerData.name || 'Freelancer';
    const freelancerUsername = freelancerData.username || '';

    if (freelancerData.kycStatus !== 'verified') {
      return respond(403, { error: 'This freelancer is not yet verified and cannot accept projects.' });
    }

    /* ── 5. Write the project document ── */
    // Payment functions read: totalAmount || budget || amount — we set all three for safety
    const now = FieldValue.serverTimestamp();

    const projectDoc = {
      // Parties
      buyerUid,
      buyerName,
      buyerEmail,
      freelancerUid:       freelancerUid.trim(),
      freelancerName,
      freelancerUsername,

      // Project details
      projectTitle:   title.trim(),
      title:          title.trim(),           // some functions read `title` directly
      description:    description.trim(),
      scope:          description.trim(),     // sign-contract reads `scope`

      // Financial — payment functions read totalAmount || budget || amount
      budget:         budgetNum,
      totalAmount:    budgetNum,
      amount:         budgetNum,
      currency:       'USD',
      withProtection: Boolean(withProtection),

      // Deadline
      deadline:       deadline.trim(),

      // Buyer has signed; freelancer has not yet
      buyerSigned:         true,
      buyerSignedAt:       now,
      buyerSignature:      buyerSignature || '',
      buyerIp:             (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || '',
      freelancerSigned:    false,
      freelancerSignedAt:  null,
      freelancerSignature: '',

      // Lifecycle — pending_payment means project exists but escrow not yet funded
      status:       'pending_payment',
      escrowStatus: 'pending',
      paymentStatus: 'unpaid',

      // Timestamps
      createdAt: now,
      updatedAt: now,
    };

    const projectRef = await db.collection('projects').add(projectDoc);
    const projectId  = projectRef.id;

    console.log(`Project ${projectId} created — buyer: ${buyerUid}, freelancer: ${freelancerUid}, budget: $${budgetNum}`);

    /* ── 6. Notify the freelancer ── */
    // Non-fatal — fire-and-forget
    try {
      const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
      if (platformUrl) {
        const notifyRes = await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
          },
          body: JSON.stringify({
            userUid:    freelancerUid.trim(),
            title:      'New Project Request',
            body:       `${buyerName} wants to hire you for "${title.trim()}". Awaiting your countersignature.`,
            url:        `${platformUrl}/dashboard-projects.html`,
            templateId: 'new-project-request',
            emailMode:  'never',
            emailData:  { projectTitle: title.trim(), buyerName },
          }),
        });
        if (!notifyRes.ok) {
          console.warn('[create-project] Notification returned', notifyRes.status);
        }
      }
    } catch (notifErr) {
      console.warn('[create-project] Could not notify freelancer:', notifErr.message);
    }

    return respond(200, { projectId });

  } catch (err) {
    console.error('[create-project] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};
