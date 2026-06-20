/**
 * Netlify Function: create-crypto-payment.js
 * Path: netlify/functions/create-crypto-payment.js
 *
 * Receives a POST request from the Kreddlo frontend, creates a
 * NOWPayments hosted invoice, and returns the invoice URL so the
 * frontend can redirect the buyer to complete payment in any crypto.
 *
 * Environment variables required (set in Netlify dashboard):
 *   NOWPAYMENTS_API_KEY   — your NOWPayments API key
 *   PLATFORM_URL          — your live domain, e.g. https://kreddlo.com
 *                           (no trailing slash)
 *
 * Expected request body (JSON):
 *   {
 *     orderId:     string   — Firestore project document ID
 *     amount:      number   — payment amount in USD (e.g. 250)
 *     description: string   — shown on the NOWPayments checkout page
 *     buyerEmail:  string?  — optional, pre-fills email on checkout
 *   }
 *
 * Success response (200):
 *   { invoiceUrl: "https://nowpayments.io/payment/..." }
 *
 * Error response (4xx / 5xx):
 *   { error: "human-readable message" }
 */

const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;
function getDb() {
  if (_db) return _db;
  let serviceAccount;
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (!getApps().length) { initializeApp({ credential: cert(serviceAccount) }); }
  _db = getFirestore();
  return _db;
}

exports.handler = async (event) => {

  /* ── 1. Only allow POST ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Parse and validate the request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId, amount: _clientAmount, description, buyerEmail } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    return respond(400, { error: 'orderId is required.' });
  }
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return respond(400, { error: 'description is required.' });
  }

  /* ── 3. Pull environment variables ── */
  const apiKey      = process.env.NOWPAYMENTS_API_KEY;
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, ''); // strip trailing slash

  if (!apiKey) {
    console.error('NOWPAYMENTS_API_KEY environment variable is not set.');
    return respond(500, { error: 'Payment service is not configured. Please contact support.' });
  }
  if (!platformUrl) {
    console.error('PLATFORM_URL environment variable is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  /* ── FIX #2: Read authoritative amount from Firestore — ignore client-supplied value ── */
  let amount;
  try {
    const db          = getDb();
    const projectSnap = await db.collection('projects').doc(orderId.trim()).get();
    if (!projectSnap.exists) {
      return respond(404, { error: 'Project not found.' });
    }
    const projectDoc = projectSnap.data();
    amount = Number(projectDoc.totalAmount || projectDoc.budget || projectDoc.amount || 0);
    if (!amount || amount <= 0) {
      return respond(400, { error: 'Project has no valid payment amount set.' });
    }

    /* ── KYC guard: verify the freelancer is verified before accepting payment ── */
    const freelancerUid = projectDoc.freelancerUid || projectDoc.sellerUid || null;
    if (freelancerUid) {
      const db2 = getDb(); // same singleton
      const freelancerSnap = await db2.collection('users').doc(freelancerUid).get();
      if (freelancerSnap.exists && freelancerSnap.data().kycStatus !== 'verified') {
        return respond(403, { error: 'This freelancer is not yet verified. Payment cannot be accepted at this time.' });
      }
    }
  } catch (dbErr) {
    console.error('[create-crypto-payment] Firestore read failed:', dbErr.message);
    return respond(500, { error: 'Could not verify project amount. Please try again.' });
  }

  /* ── 4. Build the NOWPayments invoice payload ── */
  const invoicePayload = {
    // Amount in USD — NOWPayments converts to chosen crypto at checkout
    price_amount:   amount,
    price_currency: 'usd',

    // No pay_currency set → buyer chooses any supported crypto on the
    // NOWPayments page. Set to e.g. 'btc' to lock to one coin.
    // pay_currency: undefined,

    // Order metadata — stored by NOWPayments and echoed in webhooks
    order_id:          orderId,
    order_description: description.trim().substring(0, 500), // NOWPayments max

    // Floating rate — amount in crypto adjusts to live price at payment time.
    // Set to true to lock the crypto amount at invoice creation instead.
    is_fixed_rate: false,

    // After the buyer pays, NOWPayments redirects here
    success_url: `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}`,

    // If the buyer cancels or the invoice expires
    cancel_url: `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,

    // NOWPayments will POST payment status updates to this Netlify function
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  // Optionally pre-fill the buyer's email on the NOWPayments checkout page
  if (buyerEmail && typeof buyerEmail === 'string' && buyerEmail.includes('@')) {
    invoicePayload.customer_email = buyerEmail.trim().toLowerCase();
  }

  /* ── 5. Call the NOWPayments API ── */
  let nowResponse;
  try {
    nowResponse = await fetch(NOWPAYMENTS_INVOICE_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
      },
      body: JSON.stringify(invoicePayload),
    });
  } catch (networkError) {
    console.error('Network error reaching NOWPayments:', networkError);
    return respond(502, { error: 'Could not reach the payment service. Please try again.' });
  }

  /* ── 6. Handle the NOWPayments response ── */
  let nowData;
  try {
    nowData = await nowResponse.json();
  } catch {
    console.error('NOWPayments returned non-JSON response, status:', nowResponse.status);
    return respond(502, { error: 'Unexpected response from payment service.' });
  }

  if (!nowResponse.ok) {
    // NOWPayments error — log the full details server-side, return safe message to client
    console.error('NOWPayments API error:', {
      status:  nowResponse.status,
      payload: nowData,
    });

    // Surface a specific message when possible (e.g. "Minimum payment amount is $1")
    const detail = nowData?.message || nowData?.error || 'Unknown error from payment service.';
    return respond(502, { error: `Payment service error: ${detail}` });
  }

  // invoice_url is the hosted checkout page URL
  const invoiceUrl = nowData.invoice_url;

  if (!invoiceUrl) {
    console.error('NOWPayments response missing invoice_url:', nowData);
    return respond(502, { error: 'Payment service did not return a checkout URL.' });
  }

  /* ── 7. Return the invoice URL to the frontend ── */
  console.log(`Invoice created — orderId: ${orderId}, amount: $${amount} USD, invoiceId: ${nowData.id}`);

  return respond(200, {
    checkoutUrl: invoiceUrl, // frontend pages (buyer-dashboard, buyer-projects) expect checkoutUrl
    invoiceUrl,              // kept for backward-compatibility with any other callers
    invoiceId: nowData.id,   // useful if the frontend wants to store it in Firestore
  });
};


/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*', // tighten to your domain in production
    },
    body: JSON.stringify(body),
  };
}
