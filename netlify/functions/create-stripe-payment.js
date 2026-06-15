/**
 * Netlify Function: create-stripe-payment.js
 * Path: netlify/functions/create-stripe-payment.js
 *
 * Creates a Stripe Checkout Session for a Kreddlo project payment.
 * Redirects the buyer to the Stripe-hosted checkout page where they
 * can pay by card (Visa, Mastercard, Amex, UnionPay, JCB, iDEAL,
 * Bancontact, Giropay, EPS, Przelewy24, Sofort, BLIK, Boleto, and
 * others auto-enabled by Stripe based on buyer country and currency).
 *
 * Flow:
 *  1. Validate request body
 *  2. Init Firebase and load platform settings
 *  3. Guard: stripeEnabled must be true in settings
 *  4. Guard: STRIPE_SECRET_KEY must be set
 *  5. Build and POST the Checkout Session to Stripe
 *  6. Return { checkoutUrl, sessionId } to the frontend
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com (no trailing slash)
 *
 * Expected POST body (JSON):
 *   {
 *     orderId:      string   — Firestore project document ID
 *     amount:       number   — payment amount in USD (e.g. 250)
 *     description:  string   — shown on the Stripe checkout page
 *     buyerEmail:   string?  — optional, pre-fills email on checkout
 *     projectTitle: string   — shown as the line item name
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: "https://checkout.stripe.com/...", sessionId: "cs_..." }
 *
 * Error responses:
 *   403 — Stripe payments are not currently enabled
 *   500 — Stripe is not configured / unhandled error
 *   502 — Stripe API error
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Stripe Checkout Sessions endpoint ── */
const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';

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

/* ── Encode object as application/x-www-form-urlencoded ── */
function toFormEncoded(obj, prefix) {
  const parts = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;

    if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(toFormEncoded(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          parts.push(toFormEncoded(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }

  return parts.join('&');
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

    /* ── 5. Guard: Stripe must be enabled in admin settings ── */
    if (!settings.stripeEnabled) {
      return respond(403, { error: 'Stripe payments are not currently enabled.' });
    }

    /* ── 6. Guard: STRIPE_SECRET_KEY must be present ── */
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY environment variable is not set.');
      return respond(500, { error: 'Stripe is not configured. Please contact support.' });
    }

    /* ── 7. Build the Checkout Session payload ── */
    /*
     * Stripe's API uses application/x-www-form-urlencoded, not JSON.
     * payment_method_types[]: card enables all card types Stripe supports
     * globally. Additional methods (iDEAL, Bancontact, Giropay, EPS,
     * Przelewy24, Sofort, BLIK, Boleto, etc.) are automatically enabled
     * by Stripe based on the buyer's country and the session currency.
     */
    const sessionParams = {
      'payment_method_types[]': 'card',
      'mode':                   'payment',
      'line_items[0][price_data][currency]':                    'usd',
      'line_items[0][price_data][product_data][name]':          projectTitle.trim(),
      'line_items[0][price_data][product_data][description]':   description.trim(),
      'line_items[0][price_data][unit_amount]':                 Math.round(amount * 100), // Stripe uses cents
      'line_items[0][quantity]':                                1,
      'metadata[order_id]':                                     orderId.trim(),
      'metadata[platform]':                                     'kreddlo',
      'success_url': `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=stripe`,
      'cancel_url':  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
    };

    // Pre-fill the buyer's email on the Stripe checkout page if provided
    if (buyerEmail && typeof buyerEmail === 'string' && buyerEmail.includes('@')) {
      sessionParams['customer_email'] = buyerEmail.trim().toLowerCase();
    }

    /* ── 8. Call the Stripe API ── */
    let stripeRes;
    try {
      stripeRes = await fetch(STRIPE_CHECKOUT_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: toFormEncoded(sessionParams),
      });
    } catch (networkErr) {
      console.error('Network error reaching Stripe:', networkErr);
      return respond(502, { error: 'Could not reach the payment service. Please try again.' });
    }

    /* ── 9. Handle the Stripe response ── */
    let stripeData;
    try {
      stripeData = await stripeRes.json();
    } catch {
      console.error('Stripe returned non-JSON response, status:', stripeRes.status);
      return respond(502, { error: 'Unexpected response from payment service.' });
    }

    if (!stripeRes.ok) {
      // Log full error server-side; return a human-readable message to the client
      console.error('Stripe API error:', {
        status:  stripeRes.status,
        payload: stripeData,
      });
      const detail = stripeData?.error?.message || 'Unknown error from payment service.';
      return respond(502, { error: `Payment service error: ${detail}` });
    }

    const checkoutUrl = stripeData.url;
    const sessionId   = stripeData.id;

    if (!checkoutUrl) {
      console.error('Stripe response missing url field:', stripeData);
      return respond(502, { error: 'Payment service did not return a checkout URL.' });
    }

    console.log(`Stripe session created — orderId: ${orderId}, amount: $${amount} USD, sessionId: ${sessionId}`);

    /* ── 10. Return success ── */
    return respond(200, { checkoutUrl, sessionId });

  } catch (err) {
    console.error('[create-stripe-payment] Unhandled error:', err);
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
