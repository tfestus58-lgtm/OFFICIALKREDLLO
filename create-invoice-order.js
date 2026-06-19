/**
 * Netlify Function: create-invoice-order.js
 * Path: netlify/functions/create-invoice-order.js
 *
 * Creates a payment session for an existing invoice and returns a checkout URL.
 * Mirrors create-product-order.js's payment-creation pattern, but reads from
 * the `invoices` collection instead of `products`.
 *
 * Expected POST body (JSON):
 *   {
 *     invoiceId:     string  — Firestore invoices document ID
 *     paymentMethod: string  — 'crypto' | 'stripe' | 'flutterwave'
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
 *   FLW_SECRET_KEY           — required for flutterwave payments
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Payment API endpoints ── */
const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';
const STRIPE_CHECKOUT_URL          = 'https://api.stripe.com/v1/checkout/sessions';
const FLW_PAYMENT_URL              = 'https://api.flutterwave.com/v3/payments';

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
   PAYMENT CREATORS — same shape as create-product-order.js,
   redirect targets point back to invoice.html (no buyer login required)
══════════════════════════════════════════════════════════════ */

async function createCryptoCheckout({ invoiceId, amount, currency, description, clientEmail, platformUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  const payload = {
    price_amount:      amount,
    price_currency:    currency.toLowerCase(),
    order_id:          invoiceId,
    order_description: description.trim().substring(0, 500),
    is_fixed_rate:     false,
    success_url: `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=crypto`,
    cancel_url:  `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=cancelled`,
    ipn_callback_url: `${platformUrl}/.netlify/functions/nowpayments-webhook`,
  };

  if (clientEmail) payload.customer_email = clientEmail.trim().toLowerCase();

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

async function createStripeCheckout({ invoiceId, amount, currency, description, clientEmail, invoiceTitle, platformUrl }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const sessionParams = {
    'payment_method_types[]':                                    'card',
    'mode':                                                      'payment',
    'line_items[0][price_data][currency]':                       currency.toLowerCase(),
    'line_items[0][price_data][product_data][name]':             invoiceTitle,
    'line_items[0][price_data][product_data][description]':      description,
    'line_items[0][price_data][unit_amount]':                    Math.round(amount * 100),
    'line_items[0][quantity]':                                   1,
    'metadata[invoice_id]':                                      invoiceId,
    'metadata[platform]':                                        'kreddlo',
    'metadata[order_type]':                                      'invoice',
    'success_url': `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=stripe`,
    'cancel_url':  `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=cancelled`,
  };

  if (clientEmail) sessionParams['customer_email'] = clientEmail.trim().toLowerCase();

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

async function createFlutterwaveCheckout({ invoiceId, amount, currency, description, clientEmail, invoiceTitle, platformUrl }) {
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) throw new Error('FLW_SECRET_KEY is not set.');
  if (!clientEmail) throw new Error('clientEmail is required for Flutterwave payments.');

  const paymentRef = `kreddlo-inv-${invoiceId}-${Date.now()}`;

  const payload = {
    tx_ref:          paymentRef,
    amount:          amount,
    currency:        currency,
    redirect_url:    `${platformUrl}/invoice.html?invoiceId=${encodeURIComponent(invoiceId)}&payment=success&method=flutterwave`,
    payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
    customer: {
      email: clientEmail.trim().toLowerCase(),
    },
    customizations: {
      title:       invoiceTitle,
      description: description,
      logo:        `${platformUrl}/assets/kreddlo-logo.png`,
    },
    meta: { invoiceId, invoiceTitle, orderType: 'invoice', platform: 'kreddlo' },
  };

  const res = await fetch(FLW_PAYMENT_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${flwKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.status !== 'success' || !data?.data?.link) {
    throw new Error(data?.message || 'Flutterwave did not return a checkout URL.');
  }

  return { checkoutUrl: data.data.link, paymentRef };
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

  const { invoiceId, paymentMethod, payerName } = body;

  if (!invoiceId || typeof invoiceId !== 'string') {
    return respond(400, { error: 'invoiceId is required.' });
  }
  if (!['crypto', 'stripe', 'flutterwave'].includes(paymentMethod)) {
    return respond(400, { error: 'paymentMethod must be crypto, stripe, or flutterwave.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    return respond(500, { error: 'Platform URL is not configured.' });
  }

  try {
    const db = getDb();

    /* ── Fetch invoice ── */
    const invoiceRef  = db.collection('invoices').doc(invoiceId);
    const invoiceSnap = await invoiceRef.get();
    if (!invoiceSnap.exists) {
      return respond(404, { error: 'Invoice not found.' });
    }
    const invoice = invoiceSnap.data();

    if (invoice.status === 'paid') {
      return respond(400, { error: 'This invoice has already been paid.' });
    }
    if (invoice.status === 'void' || invoice.status === 'cancelled') {
      return respond(400, { error: 'This invoice is no longer payable.' });
    }

    /* ── Respect platform gateway availability ── */
    const settings = await getSettings(db);
    if (paymentMethod === 'stripe'   && settings.stripeEnabled   !== true) {
      return respond(400, { error: 'Card payments are not currently available.' });
    }
    if (paymentMethod === 'flutterwave' && settings.flutterwaveEnabled !== true) {
      return respond(400, { error: 'Flutterwave payments are not currently available.' });
    }
    if (paymentMethod === 'crypto'   && settings.cryptoEnabled   !== true) {
      return respond(400, { error: 'Crypto payments are not currently available.' });
    }

    const currency = (invoice.currency || 'USD').toUpperCase();
    const amount   = invoice.total;

    if (!amount || amount <= 0) {
      return respond(400, { error: 'This invoice does not have a valid total.' });
    }

    /* ── Create invoice-orders document (mirrors product-orders shape) ── */
    const orderRef = db.collection('invoice-orders').doc();
    const orderId   = orderRef.id;

    await orderRef.set({
      invoiceId,
      sellerUid:      invoice.uid,
      clientEmail:    (invoice.clientEmail || '').trim().toLowerCase(),
      clientName:     invoice.clientName || '',
      payerName:      (payerName || invoice.clientName || '').trim(),
      amount,
      currency,
      amountUsd:      null,
      platformFee:    null,
      sellerAmount:   null,
      paymentMethod,
      paymentStatus:  'pending',
      createdAt:      FieldValue.serverTimestamp(),
    });

    /* ── Initiate payment ── */
    const paymentArgs = {
      invoiceId,
      amount,
      currency,
      description:  `Invoice ${invoice.invoiceNumber || invoiceId} — ${invoice.clientName || 'Client'}`,
      invoiceTitle: `Invoice ${invoice.invoiceNumber || ''}`.trim(),
      clientEmail:  (invoice.clientEmail || '').trim().toLowerCase(),
      platformUrl,
    };

    let result;
    if (paymentMethod === 'crypto') {
      result = await createCryptoCheckout(paymentArgs);
    } else if (paymentMethod === 'stripe') {
      result = await createStripeCheckout(paymentArgs);
    } else {
      result = await createFlutterwaveCheckout(paymentArgs);
    }

    /* ── Store paymentRef on order + link order id back on the invoice ── */
    await orderRef.update({ paymentRef: result.paymentRef || null });
    await invoiceRef.update({
      lastOrderId:     orderId,
      lastPaymentTry:  FieldValue.serverTimestamp(),
      status:          invoice.status === 'draft' ? 'sent' : invoice.status,
    });

    console.log(`Invoice order created — orderId: ${orderId}, invoice: ${invoiceId}, method: ${paymentMethod}, currency: ${currency}, amount: ${amount}`);

    return respond(200, { checkoutUrl: result.checkoutUrl, orderId });

  } catch (err) {
    console.error('[create-invoice-order] Error:', err);
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
