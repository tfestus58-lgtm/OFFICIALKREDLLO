/**
 * Netlify Function: create-product-order.js
 * Path: netlify/functions/create-product-order.js
 *
 * Creates a product order and initiates the appropriate payment flow.
 *
 * Expected POST body (JSON):
 *   {
 *     productId:     string  — Firestore products document ID
 *     buyerEmail:    string  — buyer's email address
 *     buyerName:     string  — buyer's display name
 *     paymentMethod: string  — 'crypto' | 'stripe' | 'paystack'
 *   }
 *
 * Success response (200):
 *   { checkoutUrl: string, orderId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com (no trailing slash)
 *   NOWPAYMENTS_API_KEY      — required for crypto payments
 *   STRIPE_SECRET_KEY        — required for stripe payments
 *   PAYSTACK_SECRET_KEY      — required for paystack payments
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Payment API endpoints ── */
const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';
const STRIPE_CHECKOUT_URL          = 'https://api.stripe.com/v1/checkout/sessions';
const PAYSTACK_INIT_URL            = 'https://api.paystack.co/transaction/initialize';

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

/* ── Stripe form-encode helper ── */
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
   PAYMENT CREATORS
══════════════════════════════════════════════════════════════ */

async function createCryptoCheckout({ orderId, amount, description, buyerEmail, platformUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  const payload = {
    price_amount:     amount,
    price_currency:   'usd',
    order_id:         orderId,
    order_description: description.trim().substring(0, 500),
    is_fixed_rate:    false,
    success_url: `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=crypto`,
    cancel_url:  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  if (buyerEmail) payload.customer_email = buyerEmail.trim().toLowerCase();

  const res = await fetch(NOWPAYMENTS_INVOICE_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body:    JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || !data.invoice_url) {
    throw new Error(data?.message || 'NOWPayments did not return an invoice URL.');
  }

  return { checkoutUrl: data.invoice_url, paymentRef: data.id };
}

async function createStripeCheckout({ orderId, amount, description, buyerEmail, productTitle, platformUrl }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const sessionParams = {
    'payment_method_types[]':                                    'card',
    'mode':                                                      'payment',
    'line_items[0][price_data][currency]':                       'usd',
    'line_items[0][price_data][product_data][name]':             productTitle,
    'line_items[0][price_data][product_data][description]':      description,
    'line_items[0][price_data][unit_amount]':                    Math.round(amount * 100),
    'line_items[0][quantity]':                                   1,
    'metadata[order_id]':                                        orderId,
    'metadata[platform]':                                        'kreddlo',
    'success_url': `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=stripe`,
    'cancel_url':  `${platformUrl}/buyer-payments.html?payment=cancelled&orderId=${encodeURIComponent(orderId)}`,
  };

  if (buyerEmail) sessionParams['customer_email'] = buyerEmail.trim().toLowerCase();

  const res = await fetch(STRIPE_CHECKOUT_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    toFormEncoded(sessionParams),
  });

  const data = await res.json();
  if (!res.ok || !data.url) {
    throw new Error(data?.error?.message || 'Stripe did not return a checkout URL.');
  }

  return { checkoutUrl: data.url, paymentRef: data.id };
}

async function createPaystackCheckout({ orderId, amount, description, buyerEmail, productTitle, platformUrl }) {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) throw new Error('PAYSTACK_SECRET_KEY is not set.');
  if (!buyerEmail) throw new Error('buyerEmail is required for Paystack payments.');

  const paymentRef = `kreddlo-${orderId}-${Date.now()}`;

  const payload = {
    email:        buyerEmail.trim().toLowerCase(),
    amount:       Math.round(amount * 100),
    currency:     'USD',
    reference:    paymentRef,
    callback_url: `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=paystack`,
    metadata: { orderId, productTitle, platform: 'kreddlo' },
    channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
  };

  const res = await fetch(PAYSTACK_INIT_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${paystackKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || !data.status || !data?.data?.authorization_url) {
    throw new Error(data?.message || 'Paystack did not return a checkout URL.');
  }

  return { checkoutUrl: data.data.authorization_url, paymentRef };
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON in request body.' });
  }

  const { productId, buyerEmail, buyerName, paymentMethod } = body;

  if (!productId || typeof productId !== 'string') {
    return respond(400, { error: 'productId is required.' });
  }
  if (!buyerEmail || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }
  if (!buyerName || typeof buyerName !== 'string') {
    return respond(400, { error: 'buyerName is required.' });
  }
  if (!['crypto', 'stripe', 'paystack'].includes(paymentMethod)) {
    return respond(400, { error: 'paymentMethod must be crypto, stripe, or paystack.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    return respond(500, { error: 'Platform URL is not configured.' });
  }

  try {
    const db = getDb();

    /* ── Fetch product ── */
    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists || productSnap.data().active === false) {
      return respond(404, { error: 'Product not found or is no longer available.' });
    }
    const product = productSnap.data();

    /* ── Platform fee calculation ── */
    const settings        = await getSettings(db);
    const platformFee     = +(product.price * (settings.platformFeePercent / 100)).toFixed(2);
    const sellerAmount    = +(product.price - platformFee).toFixed(2);

    /* ── Create product-orders document ── */
    const orderRef  = db.collection('product-orders').doc();
    const orderId   = orderRef.id;

    await orderRef.set({
      productId,
      sellerUid:       product.uid,
      buyerEmail:      buyerEmail.trim().toLowerCase(),
      buyerName:       buyerName.trim(),
      amountUsd:       product.price,
      platformFee,
      sellerAmount,
      paymentMethod,
      paymentStatus:   'pending',
      deliveryStatus:  'pending',
      reviewLeft:      false,
      createdAt:       FieldValue.serverTimestamp(),
    });

    /* ── Initiate payment ── */
    const paymentArgs = {
      orderId,
      amount:       product.price,
      description:  product.title || 'Kreddlo Product',
      productTitle: product.title || 'Kreddlo Product',
      buyerEmail:   buyerEmail.trim().toLowerCase(),
      platformUrl,
    };

    let result;
    if (paymentMethod === 'crypto') {
      result = await createCryptoCheckout(paymentArgs);
    } else if (paymentMethod === 'stripe') {
      result = await createStripeCheckout(paymentArgs);
    } else {
      result = await createPaystackCheckout(paymentArgs);
    }

    /* ── Store paymentRef on order ── */
    await orderRef.update({ paymentRef: result.paymentRef || null });

    console.log(`Product order created — orderId: ${orderId}, product: ${productId}, method: ${paymentMethod}`);

    return respond(200, { checkoutUrl: result.checkoutUrl, orderId });

  } catch (err) {
    console.error('[create-product-order] Error:', err);
    return respond(500, { error: err.message || 'Internal server error.' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
