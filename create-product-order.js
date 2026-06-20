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
const { getAuth }                      = require('firebase-admin/auth');
const { getSettings }                  = require('./get-settings');

/* ── Payment API endpoints ── */
const NOWPAYMENTS_INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice';
const STRIPE_CHECKOUT_URL          = 'https://api.stripe.com/v1/checkout/sessions';
const FLW_PAYMENT_URL              = 'https://api.flutterwave.com/v3/payments';
const FRANKFURTER_URL              = 'https://api.frankfurter.app/latest';

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

/* ── Exchange rate cache (Firestore-backed, 1-hour TTL) ── */
const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns the USD conversion rate for `currency`.
 * 1. Checks Firestore config/exchangeRates for a cached rate younger than 1 hour.
 * 2. If stale or missing, fetches fresh rates from Frankfurter, writes them to
 *    Firestore, then returns the needed rate.
 * 3. If Frankfurter is unreachable, returns the stale cached rate if one exists,
 *    otherwise returns null (caller should skip the cap check rather than block).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} currency  e.g. "NGN", "GBP"
 * @returns {Promise<number|null>}  rate to multiply by to get USD, or null on total failure
 */
async function getUsdRate(db, currency) {
  if (currency === 'USD') return 1;

  const cacheRef = db.collection('config').doc('exchangeRates');

  // ── 1. Try cache ──
  try {
    const snap = await cacheRef.get();
    if (snap.exists) {
      const cached = snap.data();
      const ageMs  = Date.now() - (cached.updatedAt || 0);
      if (ageMs < RATE_CACHE_TTL_MS && cached.rates?.[currency]) {
        return cached.rates[currency]; // fresh hit — no network call needed
      }
    }
  } catch (cacheReadErr) {
    console.warn('[create-product-order] Cache read failed:', cacheReadErr.message);
  }

  // ── 2. Fetch fresh rates from Frankfurter ──
  try {
    // Fetch all major rates in one call so we can cache them all at once
    const res = await fetch(`${FRANKFURTER_URL}?from=USD`);
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const data = await res.json();

    // data.rates has currency → USD-denominated price (i.e. 1 USD = X currency)
    // We need the inverse: 1 X = ? USD
    const rates = {};
    for (const [cur, usdPerCur] of Object.entries(data.rates || {})) {
      rates[cur] = 1 / usdPerCur; // convert to "1 unit of cur = ? USD"
    }

    // Persist to Firestore so future calls skip the network
    try {
      await cacheRef.set({ rates, updatedAt: Date.now() });
    } catch (writeErr) {
      console.warn('[create-product-order] Cache write failed (non-fatal):', writeErr.message);
    }

    return rates[currency] ?? null;
  } catch (fetchErr) {
    console.warn('[create-product-order] Frankfurter fetch failed:', fetchErr.message);

    // ── 3. Stale fallback — better than blocking the order ──
    try {
      const snap = await cacheRef.get();
      if (snap.exists && snap.data()?.rates?.[currency]) {
        console.warn('[create-product-order] Using stale cached rate for', currency);
        return snap.data().rates[currency];
      }
    } catch (_) { /* ignore */ }

    return null; // total failure — caller will skip cap check
  }
}

/* ── Price cap check (uses cached rates) ── */
async function checkPriceCap(amount, currency, maxProductPriceUsd, db) {
  if (currency === 'USD') {
    return amount <= maxProductPriceUsd;
  }
  const rate = await getUsdRate(db, currency);
  if (rate === null) return true; // skip cap check if no rate available — don't block orders
  const usdEquivalent = amount * rate;
  return usdEquivalent <= maxProductPriceUsd;
}

/* ══════════════════════════════════════════════════════════════
   PAYMENT CREATORS
══════════════════════════════════════════════════════════════ */

async function createCryptoCheckout({ orderId, amount, productCurrency, description, buyerEmail, platformUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  const payload = {
    price_amount:      amount,
    price_currency:    productCurrency.toLowerCase(),
    order_id:          orderId,
    order_description: description.trim().substring(0, 500),
    is_fixed_rate:     false,
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

async function createStripeCheckout({ orderId, amount, productCurrency, description, buyerEmail, productTitle, platformUrl }) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set.');

  const sessionParams = {
    'automatic_payment_methods[enabled]':                        'true',
    'mode':                                                      'payment',
    'line_items[0][price_data][currency]':                       productCurrency.toLowerCase(),
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

async function createFlutterwaveCheckout({ orderId, amount, productCurrency, description, buyerEmail, productTitle, platformUrl }) {
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) throw new Error('FLW_SECRET_KEY is not set.');
  if (!buyerEmail) throw new Error('buyerEmail is required for Flutterwave payments.');

  const paymentRef = `kreddlo-${orderId}-${Date.now()}`;

  const payload = {
    tx_ref:          paymentRef,
    amount:          amount,                // Flutterwave accepts the decimal amount directly
    currency:        productCurrency,
    redirect_url:    `${platformUrl}/buyer-payments.html?payment=success&orderId=${encodeURIComponent(orderId)}&method=flutterwave`,
    payment_options: 'card,banktransfer,ussd,mobilemoney,account,barter,nqr',
    customer: {
      email: buyerEmail.trim().toLowerCase(),
    },
    customizations: {
      title:       productTitle,
      description: description,
      logo:        `${platformUrl}/assets/kreddlo-logo.png`,
    },
    meta: { orderId, productTitle, platform: 'kreddlo' },
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

  const { productId, buyerEmail, buyerName, paymentMethod, affiliateRef } = body;

  if (!productId || typeof productId !== 'string') {
    return respond(400, { error: 'productId is required.' });
  }
  if (!buyerEmail || !buyerEmail.includes('@')) {
    return respond(400, { error: 'buyerEmail is required and must be a valid email address.' });
  }
  if (!buyerName || typeof buyerName !== 'string') {
    return respond(400, { error: 'buyerName is required.' });
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

    /* ── Fetch product ── */
    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists || productSnap.data().active === false) {
      return respond(404, { error: 'Product not found or is no longer available.' });
    }
    const product = productSnap.data();

    /* ── Determine currency and amount based on payment method ── */
    const productCurrency = (product.currency || 'USD').toUpperCase();

    let amount;
    if (paymentMethod === 'crypto') {
      amount = product.cryptoPrice || product.cardPrice || product.price;
    } else {
      amount = product.cardPrice || product.price;
    }

    if (!amount || amount <= 0) {
      return respond(400, { error: 'This product does not have a price set for the selected payment method.' });
    }

    /* ── Enforce price cap on backend ── */
    const settings = await getSettings(db);
    const withinCap = await checkPriceCap(amount, productCurrency, settings.maxProductPriceUsd || 1800, db);
    if (!withinCap) {
      return respond(400, { error: 'Product price exceeds the platform maximum.' });
    }

    /* ── Sanitise and validate affiliateRef (optional) ── */
    const sanitisedRef = (typeof affiliateRef === 'string' && affiliateRef.trim().length > 0)
      ? affiliateRef.trim()
      : null;

    /* ── Create product-orders document ── */
    const orderRef = db.collection('product-orders').doc();
    const orderId  = orderRef.id;

    await orderRef.set({
      productId,
      sellerUid:      product.uid,
      buyerEmail:     buyerEmail.trim().toLowerCase(),
      buyerName:      buyerName.trim(),
      amount,
      currency:       productCurrency,
      amountUsd:      null,    // filled in by webhook after confirmed exchange rate
      platformFee:    null,    // calculated by webhook from confirmed amount
      sellerAmount:   null,    // calculated by webhook from confirmed amount
      paymentMethod,
      paymentStatus:  'pending',
      deliveryStatus: 'pending',
      reviewLeft:     false,
      affiliateRef:   sanitisedRef,   // null if no referral; webhook uses this to credit affiliate
      createdAt:      FieldValue.serverTimestamp(),
    });

    /* ── Initiate payment ── */
    const paymentArgs = {
      orderId,
      amount,
      productCurrency,
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
      result = await createFlutterwaveCheckout(paymentArgs);
    }

    /* ── Store paymentRef on order ── */
    await orderRef.update({ paymentRef: result.paymentRef || null });

    /* ── Link order to a buyer account (create one if needed) ── */
    try {
      const auth            = getAuth();
      const normalizedEmail = buyerEmail.trim().toLowerCase();

      let buyerUid;
      try {
        // Try to find an existing Firebase Auth user with this email
        const existingUser = await auth.getUserByEmail(normalizedEmail);
        buyerUid = existingUser.uid;
      } catch (lookupErr) {
        if (lookupErr.code === 'auth/user-not-found') {
          // No account yet — create a passwordless account for the guest
          const newUser = await auth.createUser({
            email:         normalizedEmail,
            displayName:   buyerName.trim(),
            emailVerified: false,
          });
          buyerUid = newUser.uid;

          // Write a minimal user profile so buyer-purchases.html can find them
          await db.collection('users').doc(buyerUid).set({
            uid:        buyerUid,
            email:      normalizedEmail,
            name:       buyerName.trim(),
            role:       'buyer',
            createdAt:  FieldValue.serverTimestamp(),
            createdVia: 'guest-purchase',
          });

          // Queue a "set your password" welcome email via email-queue
          try {
            const resetLink = await auth.generatePasswordResetLink(normalizedEmail);
            await db.collection('email-queue').add({
              userUid:    buyerUid,
              templateId: 'guest-purchase-welcome',
              emailData: {
                name:      buyerName.trim(),
                email:     normalizedEmail,
                resetLink,
              },
              sendAfter:  Date.now(),   // send immediately on next queue run
              sent:       false,
              createdAt:  FieldValue.serverTimestamp(),
            });
          } catch (emailErr) {
            // Non-fatal — order still succeeds even if welcome email fails
            console.warn('[create-product-order] Failed to queue guest welcome email:', emailErr.message);
          }
        } else {
          // Re-throw unexpected auth errors
          throw lookupErr;
        }
      }

      // Stamp buyerUid onto the order
      await orderRef.update({ buyerUid });

    } catch (accountErr) {
      // Non-fatal — don't block the checkout if account linking fails
      console.warn('[create-product-order] Guest account linking failed:', accountErr.message);
    }

    console.log(`Product order created — orderId: ${orderId}, product: ${productId}, method: ${paymentMethod}, currency: ${productCurrency}, amount: ${amount}`);

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
