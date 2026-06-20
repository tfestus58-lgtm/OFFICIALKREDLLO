/**
 * Netlify Function: raise-dispute.js
 * Path: netlify/functions/raise-dispute.js
 *
 * Called when a buyer or freelancer raises a dispute on a project.
 * - Verifies the caller is the project's buyer (raisedByRole 'buyer', default)
 *   or the project's freelancer (raisedByRole 'freelancer')
 * - Guards against duplicate disputes
 * - Updates the project: status → disputed, escrowStatus → disputed
 * - Sends notifications to both parties
 *
 * POST body:
 *   (project) { projectId: string, raisedBy: string, raisedByRole: 'buyer'|'freelancer', description: string }
 *   (invoice) { type: 'invoice', invoiceId: string, raisedBy: string, description: string, clientEmail: string }
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
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
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

  const { type, projectId, invoiceId, raisedBy, raisedByRole, description, clientEmail } = payload;

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

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

  /* ══════════════════════════════════════════════════════════════
     INVOICE DISPUTE PATH
     type === 'invoice': look up the invoices collection, verify
     the caller via clientEmail (buyer side only for invoices).
  ══════════════════════════════════════════════════════════════ */
  if (type === 'invoice') {
    if (!invoiceId || typeof invoiceId !== 'string') {
      return respond(400, { error: 'invoiceId is required for invoice disputes.' });
    }
    if (!clientEmail || typeof clientEmail !== 'string') {
      return respond(400, { error: 'clientEmail is required for invoice disputes.' });
    }

    /* ── Fetch invoice ── */
    let invoiceSnap;
    try {
      invoiceSnap = await db.collection('invoices').doc(invoiceId).get();
    } catch (err) {
      console.error(`Firestore read failed for invoice ${invoiceId}:`, err.message);
      return respond(500, { error: 'Database read failed.' });
    }

    if (!invoiceSnap.exists) {
      return respond(404, { error: 'Invoice not found.' });
    }

    const invoice = invoiceSnap.data();

    /* ── Verify buyer via clientEmail ── */
    const storedClientEmail = (invoice.clientEmail || '').trim().toLowerCase();
    const suppliedEmail     = clientEmail.trim().toLowerCase();
    if (!storedClientEmail || storedClientEmail !== suppliedEmail) {
      return respond(403, { error: 'You are not authorised to raise a dispute on this invoice.' });
    }

    /* ── Guard: duplicate dispute ── */
    if (invoice.status === 'disputed') {
      return respond(409, { error: 'A dispute has already been raised on this invoice.' });
    }

    /* ── Guard: can only dispute invoices in escrow or delivered ── */
    if (!['escrow', 'delivered'].includes(invoice.status)) {
      return respond(400, { error: `Cannot raise a dispute on an invoice with status "${invoice.status}".` });
    }

    const sellerUid    = invoice.sellerUid || invoice.uid || null;
    const invoiceTitle = invoice.invoiceNumber || invoice.title || invoiceId;

    /* ── Mark invoice as disputed ── */
    try {
      await db.collection('invoices').doc(invoiceId).update({
        status:         'disputed',
        escrowStatus:   'disputed',
        disputeReason:  description.trim(),
        disputedBy:     raisedBy,
        disputedByRole: 'buyer',
        disputedAt:     FieldValue.serverTimestamp(),
        updatedAt:      FieldValue.serverTimestamp(),
      });
      console.log(`Dispute raised on invoice ${invoiceId} by ${raisedBy}.`);
    } catch (err) {
      console.error(`Firestore update failed for invoice ${invoiceId}:`, err.message);
      return respond(500, { error: 'Failed to update invoice status.' });
    }

    /* ── Fetch seller details for notification ── */
    let sellerEmail = null;
    let sellerName  = 'Freelancer';
    if (sellerUid) {
      try {
        const sellerSnap = await db.collection('users').doc(sellerUid).get();
        if (sellerSnap.exists) {
          sellerEmail = sellerSnap.data().email || null;
          sellerName  = sellerSnap.data().name || sellerSnap.data().displayName || 'Freelancer';
        }
      } catch (err) {
        console.warn('Could not fetch seller details for notification:', err.message);
      }
    }

    const buyerDisplayName = invoice.clientName || invoice.payerName || 'Client';

    /* ── Notify seller ── */
    if (sellerUid) {
      await callFunction('send-smart-notification', {
        userUid:    sellerUid,
        to:         sellerEmail || null,
        title:      'Dispute Raised',
        body:       `A dispute has been raised on invoice ${invoiceTitle}. Kreddlo support will review shortly.`,
        url:        `${platformUrl}/dashboard-invoices.html`,
        templateId: 'dispute-raised',
        emailMode:  sellerEmail ? 'always' : 'never',
        emailData: {
          name:          sellerName,
          projectTitle:  invoiceTitle,
          raisedByName:  buyerDisplayName,
          disputeId:     invoiceId,
        },
      });
    }

    return respond(200, {
      success: true,
      message: 'Dispute submitted. The Kreddlo team will be in touch.',
    });
  }

  /* ══════════════════════════════════════════════════════════════
     PROJECT DISPUTE PATH (original logic)
  ══════════════════════════════════════════════════════════════ */
  if (!projectId || typeof projectId !== 'string') {
    return respond(400, { error: 'projectId is required.' });
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

  /* ── Verify caller is the project buyer OR the project freelancer ──
     raisedByRole defaults to 'buyer' for backward compatibility with
     existing callers that only ever sent buyer-side disputes. */
  const role = raisedByRole === 'freelancer' ? 'freelancer' : 'buyer';
  const isAuthorised = role === 'freelancer'
    ? !!project.freelancerUid && project.freelancerUid === raisedBy
    : project.buyerUid === raisedBy;

  if (!isAuthorised) {
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

  const projectUrl  = `${platformUrl}/buyer-projects.html?projectId=${encodeURIComponent(projectId)}`;
  const raiserName  = role === 'freelancer' ? freelancerName : buyerName;

  /* ── Notify the buyer ── */
  await callFunction('send-smart-notification', {
    userUid:    buyerUid,
    title:      role === 'buyer' ? 'Dispute Submitted' : 'Dispute Raised',
    body:       role === 'buyer'
      ? `Your dispute for "${projectTitle}" has been received. The Kreddlo team will be in touch.`
      : `A dispute has been raised on "${projectTitle}". Kreddlo support will review shortly.`,
    url:        projectUrl,
    templateId: 'dispute-raised',
    emailMode:  buyerEmail ? 'always' : 'never',
    emailData: {
      name:         buyerName,
      projectTitle,
      raisedByName: raiserName,
      disputeId:    projectId,
    },
  });

  /* ── Notify the freelancer ── */
  if (freelancerUid) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid,
      title:      role === 'freelancer' ? 'Dispute Submitted' : 'Dispute Raised',
      body:       role === 'freelancer'
        ? `Your dispute for "${projectTitle}" has been received. The Kreddlo team will be in touch.`
        : `A dispute has been raised on "${projectTitle}". Kreddlo support will review shortly.`,
      url:        `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(projectId)}`,
      templateId: 'dispute-raised',
      emailMode:  freelancerEmail ? 'always' : 'never',
      emailData: {
        name:         freelancerName,
        projectTitle,
        raisedByName: raiserName,
        disputeId:    projectId,
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
