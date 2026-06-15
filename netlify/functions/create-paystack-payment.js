/**
 * Netlify Function: create-paystack-payment.js
 * Path: netlify/functions/create-paystack-payment.js
 *
 * Initialises a Paystack transaction for a Kreddlo project payment.
 * Redirects the buyer to the Paystack-hosted checkout page where they
 * can pay by card, bank transfer, USSD, QR code, mobile money, and
 * more — across Africa and internationally.
 *
 * Flow:
 *  1. Validate request body
 *  2. Init Firebase and load platform settings
 *  3. Guard: paystackEnabled must be true in settings
 *  4. Guard: PAYSTACK_SECRET_KEY must be set
 *  5. Build and POST the transaction to the Paystack Initialize API
 *  6. Return { checkoutUrl, paymentRef } to the frontend
 *
 * Environment variables required:
 *   PAYSTACK_SECRET_KEY      — Paystack secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com (no trailing slash)
 *
 * Expected POST body (JSON):
 *   {
 *     orderId:      string   — Firestore project document ID
 *     amount:       number   — payment amount in USD (e.g. 250)
 *     description:  string   — shown on the Paystack checkout page
 *     buyerEmail:   string   — required by Paystack to initialise a transaction
 *     projectTitle: string   — shown as the transaction description
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.paystack.com/...", paymentRef: "kreddlo-..." }
 *
 * Error responses:
 *   400 — Missing or invalid request fields
 *   403 — Paystack payments are not currently enabled
 *   500 — Paystack is not configured / unhandled error
 *   502 — Paystack API error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Paystack Initialize Transaction endpoint ── */
const PAYSTACK_INIT_URL = 'https://api.paystack.co/transaction/initialize';

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

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Parse and validate request body ── */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { orderId, amount, description, buyerEmail, projectTitle } = body;

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    return respond(400, { error: 'orderId is required.' });
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return respond(400, { error: 'amount must be a positive number in USD.' });
  }
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return respond(400, { error: 'description is required.' });
  }
  if (!projectTitle || typeof projectTitle !== 'string' || projectTitle.trim() === '') {
    return respond(400, { error: 'projectTitle is required.' });
  }
  if (!buyerEmail || typeof buyerEmail !== 'string' || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }

  /* ── 3. Pull environment variables ── */
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.error('PLATFORM_URL environment variable is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  try {

    /* ── 4. Init Firebase and load platform settings ── */
    const db       = getDb();
    const settings = await getSettings(db);

    /* ── 5. Guard: Paystack must be enabled in admin settings ── */
    if (!settings.paystackEnabled) {
      return respond(403, { error: 'Paystack payments are not currently enabled.' });
    }

    /* ── 6. Guard: PAYSTACK_SECRET_KEY must be present ── */
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackKey) {
      console.error('PAYSTACK_SECRET_KEY environment variable is not set.');
      return respond(500, { error: 'Paystack is not configured. Please contact support.' });
    }

    /* ── 7. Build a unique transaction reference ── */
    /*
     * Paystack requires a unique reference per transaction.
     * Format: kreddlo-<orderId>-<timestamp>
     * This guarantees uniqueness even if a buyer retries payment on the same order.
     */
    const paymentRef = `kreddlo-${orderId.trim()}-${Date.now()}`;

    /* ── 8. Build the Paystack transaction payload ── */
    /*
     * Paystack's Initialize Transaction API accepts JSON.
     * amount must be in the smallest currency unit (kobo for NGN, cents for USD/GBP/EUR).
     * currency: USD — Paystack supports multi-currency including USD, GBP, EUR, GHS,
     * ZAR, KES, and more, enabling payments from African and international clients.
     * channels enables every payment method Paystack supports across its markets:
     *   card          — Visa, Mastercard, Verve, Amex
     *   bank          — direct bank debit (Nigeria)
     *   ussd          — *737# and other USSD codes
     *   qr            — QR code payments
     *   mobile_money  — MTN, Airtel, Tigo, Vodafone (Ghana, Uganda, Rwanda, Côte d'Ivoire)
     *   bank_transfer — instant bank transfer (Pay with Transfer)
     */
    const transactionPayload = {
      email:        buyerEmail.trim().toLowerCase(),
      amount:       Math.round(amount * 100),  // Paystack uses the smallest currency unit
      currency:     'USD',
      reference:    paymentRef,
      callback_url: `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId.trim())}&method=paystack`,
      metadata: {
        orderId:      orderId.trim(),
        projectTitle: projectTitle.trim(),
        platform:     'kreddlo',
      },
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
    };

    /* ── 9. Call the Paystack API ── */
    let paystackRes;
    try {
      paystackRes = await fetch(PAYSTACK_INIT_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${paystackKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(transactionPayload),
      });
    } catch (networkErr) {
      console.error('Network error reaching Paystack:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 10. Handle the Paystack response ── */
    let paystackData;
    try {
      paystackData = await paystackRes.json();
    } catch {
      console.error('Paystack returned non-JSON response, status:', paystackRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!paystackRes.ok || !paystackData.status) {
      // Log full error server-side; return a human-readable message to the client
      console.error('Paystack API error:', {
        status:  paystackRes.status,
        payload: paystackData,
      });
      const detail = paystackData?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = paystackData?.data?.authorization_url;

    if (!checkoutUrl) {
      console.error('Paystack response missing authorization_url:', paystackData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(`Paystack transaction initialised — orderId: ${orderId}, amount: $${amount} USD, ref: ${paymentRef}`);

    /* ── 11. Return success ── */
    return respond(200, { checkoutUrl, paymentRef });

  } catch (err) {
    console.error('[create-paystack-payment] Unhandled error:', err);
    return respond(500, { error: 'Internal server error. Please try again.' });
  }
};

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
