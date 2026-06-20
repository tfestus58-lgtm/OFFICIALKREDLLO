/**
 * Netlify Function: confirm-invoice-delivery.js
 * Path: netlify/functions/confirm-invoice-delivery.js
 *
 * Called when the buyer clicks their confirmation link (token-based, no auth required).
 * - Validates the confirmToken against the invoice doc
 * - Moves sellerAmount from escrowBalance → availableBalance on the seller's Firestore doc
 * - Updates invoice status → completed
 * - Notifies the freelancer that funds are released
 *
 * POST body:
 *   { invoiceId: string, confirmToken: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT
 *   PLATFORM_URL
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

let _db = null;
function getDb() {
  if (_db) return _db;
  let serviceAccount;
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
  _db = getFirestore();
  return _db;
}

async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) return;
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`${functionName} returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body.' }); }

  const { invoiceId, confirmToken } = body;
  if (!invoiceId || typeof invoiceId !== 'string') return respond(400, { error: 'invoiceId is required.' });
  if (!confirmToken || typeof confirmToken !== 'string') return respond(400, { error: 'confirmToken is required.' });

  let db;
  try { db = getDb(); }
  catch (err) { return respond(500, { error: 'Database not available.' }); }

  /* ── Fetch invoice ── */
  let invoiceSnap;
  try { invoiceSnap = await db.collection('invoices').doc(invoiceId).get(); }
  catch (err) { return respond(500, { error: 'Database read failed.' }); }

  if (!invoiceSnap.exists) return respond(404, { error: 'Invoice not found.' });
  const invoice = invoiceSnap.data();

  /* ── Token validation ── */
  if (!invoice.confirmToken || invoice.confirmToken !== confirmToken) {
    return respond(403, { error: 'Invalid or expired confirmation token.' });
  }

  /* ── Idempotency: already completed ── */
  if (invoice.status === 'completed') {
    return respond(200, { success: true, message: 'This delivery was already confirmed.' });
  }

  /* ── Invoice must be in delivered state ── */
  if (invoice.status !== 'delivered') {
    return respond(400, { error: `Invoice cannot be confirmed in status "${invoice.status}".` });
  }

  const sellerUid    = invoice.uid;
  const sellerAmount = Number(invoice.escrowSellerAmount || 0);
  const currency     = (invoice.currency || 'USD').toUpperCase();
  const invoiceNumber = invoice.invoiceNumber || invoiceId;

  if (!sellerUid) return respond(400, { error: 'Invoice has no seller.' });

  /* ── Mark invoice completed ── */
  try {
    await db.collection('invoices').doc(invoiceId).update({
      status:      'completed',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt:   FieldValue.serverTimestamp(),
    });
    console.log(`Invoice ${invoiceId} confirmed as completed.`);
  } catch (err) {
    return respond(500, { error: 'Failed to update invoice status.' });
  }

  /* ── Release escrow → availableBalance ── */
  if (sellerAmount > 0) {
    try {
      await db.collection('users').doc(sellerUid).update({
        escrowBalance:                   FieldValue.increment(-sellerAmount),
        availableBalance:                FieldValue.increment(sellerAmount),
        [`balances.${currency}`]:        FieldValue.increment(sellerAmount),
        totalEarned:                     FieldValue.increment(sellerAmount),
        updatedAt:                       FieldValue.serverTimestamp(),
      });
      console.log(`Released ${sellerAmount} ${currency} from escrow to availableBalance for seller ${sellerUid}.`);
    } catch (err) {
      console.error(`Failed to release escrow for seller ${sellerUid}:`, err.message);
      // Non-fatal — invoice is already marked completed; admin can reconcile.
    }

    /* ── Update escrow-holds record ── */
    try {
      const holdQuery = await db.collection('escrow-holds')
        .where('invoiceId', '==', invoiceId)
        .where('status', '==', 'held')
        .limit(1)
        .get();
      if (!holdQuery.empty) {
        await holdQuery.docs[0].ref.update({ status: 'released', releasedAt: FieldValue.serverTimestamp() });
      }
    } catch (_) {}
  }

  /* ── Fetch seller details for notification ── */
  let freelancerName  = 'Freelancer';
  let freelancerEmail = null;
  try {
    const fSnap = await db.collection('users').doc(sellerUid).get();
    if (fSnap.exists) {
      freelancerName  = fSnap.data().name || fSnap.data().displayName || 'Freelancer';
      freelancerEmail = fSnap.data().email || null;
    }
  } catch (_) {}

  const platformUrl   = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const amountFormatted = new Intl.NumberFormat('en', { style: 'currency', currency }).format(sellerAmount);

  /* ── Notify freelancer: funds released ── */
  await callFunction('send-smart-notification', {
    userUid:    sellerUid,
    title:      'Invoice Payment Released',
    body:       `Your client confirmed delivery for invoice ${invoiceNumber}. ${amountFormatted} is now available.`,
    url:        `${platformUrl}/dashboard-invoices.html`,
    templateId: 'invoice-escrow-released',
    emailMode:  freelancerEmail ? 'always' : 'never',
    emailData: {
      name:          freelancerName,
      invoiceNumber,
      amount:        amountFormatted,
      dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
    },
  });

  return respond(200, { success: true, message: 'Delivery confirmed. Funds have been released to the freelancer.' });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
