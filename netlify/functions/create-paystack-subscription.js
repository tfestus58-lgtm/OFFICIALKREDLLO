/**
 * Netlify Function: create-paystack-subscription.js
 * Path: netlify/functions/create-paystack-subscription.js
 *
 * Initialises a Paystack transaction for a Kreddlo Pro plan subscription.
 * Called exclusively by create-subscription.js — never directly by the frontend.
 *
 * Key differences from create-paystack-payment.js:
 *  - Amount comes from the validated subscriptions/{subscriptionId} Firestore doc
 *    (written by create-subscription.js before calling us), not from a projects doc.
 *  - No KYC freelancer guard — this is a user paying for their own plan.
 *  - callback_url points to pricing.html, not buyer-payments.html.
 *  - metadata.custom_fields carries payment_purpose: 'pro_upgrade' so
 *    paystack-webhook.js can route the event correctly.
 *
 * Flow:
 *  1. Validate request body
 *  2. Guard: PAYSTACK_SECRET_KEY must be set
 *  3. Guard: paystackEnabled must be true in platform settings
 *  4. Verify subscriptions doc and read authoritative price
 *  5. Build and POST the transaction to the Paystack Initialize API
 *  6. Return { checkoutUrl, paymentRef } to create-subscription.js
 *
 * Environment variables required:
 *   PAYSTACK_SECRET_KEY      — Paystack secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com (no trailing slash)
 *
 * Expected POST body (JSON) — sent by create-subscription.js:
 *   {
 *     subscriptionId: string   — Firestore subscriptions doc ID (sub_<uid>_<ts>)
 *     uid:            string   — Firebase Auth UID of the subscribing user
 *     amount:         number   — price in USD (e.g. 9.99 or 99.00)
 *     description:    string   — shown on the Paystack checkout page
 *     buyerEmail:     string   — required by Paystack to initialise a transaction
 *     metadata:       object   — forwarded to paystack-webhook.js via custom_fields
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.paystack.com/...", paymentRef: "kredsub-..." }
 *
 * Error responses:
 *   400 — Missing / invalid fields
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

  const {
    subscriptionId,
    uid,
    amount: clientAmount,
    description,
    buyerEmail,
    metadata: clientMetadata,
  } = body;

  if (!subscriptionId || typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
    return respond(400, { error: 'subscriptionId is required.' });
  }
  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    return respond(400, { error: 'uid is required.' });
  }
  if (!clientAmount || isNaN(Number(clientAmount)) || Number(clientAmount) <= 0) {
    return respond(400, { error: 'amount must be a positive number.' });
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return respond(400, { error: 'description is required.' });
  }
  if (!buyerEmail || typeof buyerEmail !== 'string' || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }

  /* ── 3. Pull environment variables ── */
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.error('[create-paystack-subscription] PLATFORM_URL is not set.');
    return respond(500, { error: 'Platform URL is not configured. Please contact support.' });
  }

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) {
    console.error('[create-paystack-subscription] PAYSTACK_SECRET_KEY is not set.');
    return respond(500, { error: 'Paystack is not configured. Please contact support.' });
  }

  try {

    /* ── 4. Init Firebase and check platform settings ── */
    const db       = getDb();
    const settings = await getSettings(db);

    if (!settings.paystackEnabled) {
      return respond(403, { error: 'Paystack payments are not currently enabled.' });
    }

    /* ── 5. Verify subscriptions doc and read authoritative price ── */
    /*
     * create-subscription.js writes subscriptions/{subscriptionId} before
     * calling us. We read the price back from there so the amount is always
     * server-authoritative — the clientAmount is a fallback only.
     */
    const subSnap = await db.collection('subscriptions').doc(subscriptionId.trim()).get();
    if (!subSnap.exists) {
      return respond(404, { error: 'Subscription record not found.' });
    }
    const subDoc = subSnap.data();

    const amount = Number(subDoc.price || clientAmount);
    if (!amount || amount <= 0) {
      return respond(400, { error: 'Subscription has no valid price set.' });
    }

    /*
     * Paystack supports multi-currency: USD, GBP, EUR, NGN, GHS, ZAR, KES, etc.
     * We default to USD for Pro plan subscriptions since prices are defined in USD.
     * If the platform is configured with a different currency, we use that.
     */
    const currency = (settings.platformCurrency || 'USD').toUpperCase();

    /* ── 6. Build a unique transaction reference ── */
    /*
     * Paystack requires a unique reference per transaction.
     * Prefix with 'kredsub-' to distinguish subscription payments
     * from project payments ('kreddlo-') in Paystack dashboard and webhooks.
     */
    const paymentRef = `kredsub-${subscriptionId.trim()}-${Date.now()}`;

    /* ── 7. Build the Paystack transaction payload ── */
    /*
     * custom_fields is used to pass metadata through Paystack's webhook.
     * paystack-webhook.js reads custom_fields[*].variable_name to route events.
     * We include payment_purpose so the webhook knows to upgrade the user's plan.
     */
    const customFields = [
      { display_name: 'Payment Purpose', variable_name: 'payment_purpose', value: 'pro_upgrade'          },
      { display_name: 'Subscription ID', variable_name: 'subscriptionId',  value: subscriptionId.trim()  },
      { display_name: 'User ID',         variable_name: 'uid',             value: uid.trim()             },
    ];

    // Merge any additional metadata from create-subscription.js
    if (clientMetadata && typeof clientMetadata === 'object') {
      for (const [k, v] of Object.entries(clientMetadata)) {
        // Skip keys already added above to avoid duplicates
        if (['payment_purpose', 'subscriptionId', 'uid'].includes(k)) continue;
        customFields.push({
          display_name: k,
          variable_name: k,
          value: String(v),
        });
      }
    }

    const transactionPayload = {
      email:        buyerEmail.trim().toLowerCase(),
      amount:       Math.round(amount * 100),   // Paystack uses smallest currency unit
      currency,
      reference:    paymentRef,
      callback_url: `${platformUrl}/pricing.html?sub=success&subscriptionId=${encodeURIComponent(subscriptionId.trim())}&method=paystack`,
      metadata: {
        subscriptionId: subscriptionId.trim(),
        uid:            uid.trim(),
        platform:       'kreddlo',
        custom_fields:  customFields,
      },
      /*
       * Enable every Paystack payment channel:
       *   card          — Visa, Mastercard, Verve, Amex
       *   bank          — direct bank debit (Nigeria)
       *   ussd          — *737# and other USSD codes
       *   qr            — QR code payments
       *   mobile_money  — MTN, Airtel, Tigo, Vodafone (Ghana, Uganda, Rwanda, Côte d'Ivoire)
       *   bank_transfer — Pay with Transfer (instant bank transfer)
       */
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
    };

    /* ── 8. Call the Paystack API ── */
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
      console.error('[create-paystack-subscription] Network error reaching Paystack:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 9. Handle the Paystack response ── */
    let paystackData;
    try {
      paystackData = await paystackRes.json();
    } catch {
      console.error('[create-paystack-subscription] Paystack returned non-JSON, status:', paystackRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!paystackRes.ok || !paystackData.status) {
      console.error('[create-paystack-subscription] Paystack API error:', {
        status:  paystackRes.status,
        payload: paystackData,
      });
      const detail = paystackData?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = paystackData?.data?.authorization_url;

    if (!checkoutUrl) {
      console.error('[create-paystack-subscription] Paystack response missing authorization_url:', paystackData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(
      `[create-paystack-subscription] Transaction initialised — subscriptionId: ${subscriptionId}, ` +
      `uid: ${uid}, amount: ${amount} ${currency}, ref: ${paymentRef}`
    );

    /* ── 10. Return success ── */
    return respond(200, { checkoutUrl, paymentRef });

  } catch (err) {
    console.error('[create-paystack-subscription] Unhandled error:', err);
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
