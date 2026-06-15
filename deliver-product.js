/**
 * Netlify Function: deliver-product.js
 * Path: netlify/functions/deliver-product.js
 *
 * Handles product delivery after a successful payment.
 * Can be called directly via POST or internally by payment webhooks.
 * Idempotent — returns 200 immediately if delivery already completed.
 *
 * Expected POST body (JSON):
 *   { orderId: string }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

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

/* ── Internal function-to-function HTTP caller ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return null;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[deliver-product] callFunction(${functionName}) failed — status: ${res.status}, body: ${errText}`);
    }

    return res;
  } catch (err) {
    console.error(`[deliver-product] callFunction(${functionName}) network error:`, err.message);
    return null;
  }
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

  const { orderId } = body;

  if (!orderId || typeof orderId !== 'string') {
    return respond(400, { error: 'orderId is required.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

  try {
    const db = getDb();

    /* ── Fetch order ── */
    const orderRef  = db.collection('product-orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return respond(404, { error: 'Order not found.' });
    }

    const order = orderSnap.data();

    /* ── Idempotency guard — prevent double delivery ── */
    if (order.deliveryStatus === 'delivered') {
      console.log(`[deliver-product] Order ${orderId} already delivered — skipping.`);
      return respond(200, { success: true, message: 'Already delivered.' });
    }

    /* ── Fetch product ── */
    const productSnap = await db.collection('products').doc(order.productId).get();
    if (!productSnap.exists) {
      return respond(404, { error: 'Product not found.' });
    }
    const product = productSnap.data();

    /* ── Fetch seller user document for seller name ── */
    const sellerSnap = await db.collection('users').doc(order.sellerUid).get();
    const seller     = sellerSnap.exists ? sellerSnap.data() : {};
    const sellerName = seller.displayName || seller.name || 'the seller';

    /* ── Delivery logic by type ── */
    if (product.deliveryType === 'instant-auto') {
      /* Send product-delivery email to buyer immediately */
      await callFunction('send-email', {
        to:         order.buyerEmail,
        toName:     order.buyerName,
        templateId: 'product-delivery',
        data: {
          name:            order.buyerName,
          productTitle:    product.title,
          deliveryType:    product.deliveryType,
          deliveryContent: product.deliveryContent,
          sellerName,
        },
      });

    } else if (product.deliveryType === 'manual-link') {
      /* Notify seller to deliver manually */
      await callFunction('send-smart-notification', {
        userUid:      order.sellerUid,
        title:        'New sale — delivery required',
        body:         `You have a new sale on "${product.title}". The buyer is waiting for delivery.`,
        url:          `${platformUrl}/dashboard.html`,
        templateId:   'product-sale',
        emailMode:    'always',
        emailData: {
          name:         sellerName,
          buyerName:    order.buyerName,
          buyerEmail:   order.buyerEmail,
          productTitle: product.title,
          amount:       order.sellerAmount,
        },
      });

      /* Create a seller task so it appears in their dashboard task list */
      await db.collection('seller-tasks').add({
        sellerUid:    order.sellerUid,
        orderId,
        productId:    order.productId,
        productTitle: product.title,
        buyerEmail:   order.buyerEmail,
        buyerName:    order.buyerName,
        type:         'manual-delivery',
        status:       'pending',
        createdAt:    FieldValue.serverTimestamp(),
      });
    }

    /* ── Mark order as delivered ── */
    await orderRef.update({
      deliveryStatus: 'delivered',
      deliveredAt:    FieldValue.serverTimestamp(),
    });

    /* ── Increment product salesCount ── */
    await db.collection('products').doc(order.productId).update({
      salesCount: FieldValue.increment(1),
    });

    /* ── Credit seller balance ── */
    await db.collection('users').doc(order.sellerUid).update({
      totalSales:       FieldValue.increment(1),
      availableBalance: FieldValue.increment(order.sellerAmount),
      totalEarned:      FieldValue.increment(order.sellerAmount),
    });

    /* ── Schedule review-request email (48 hours = 2880 minutes) ── */
    await callFunction('send-smart-notification', {
      userUid:      order.sellerUid, // placeholder — email goes to buyer via emailData.to
      title:        'Review request scheduled',
      body:         `A review request will be sent to ${order.buyerEmail} in 48 hours.`,
      templateId:   'review-request',
      emailMode:    'delayed',
      delayMinutes: 2880,
      emailTo:      order.buyerEmail,
      emailToName:  order.buyerName,
      emailData: {
        name:         order.buyerName,
        productTitle: product.title,
        reviewUrl:    `${platformUrl}/review.html?orderId=${encodeURIComponent(orderId)}`,
        sellerName,
      },
    });

    /* ── Send seller a product-sale notification ── */
    await callFunction('send-smart-notification', {
      userUid:    order.sellerUid,
      title:      'You made a sale!',
      body:       `${order.buyerName} purchased "${product.title}" for $${order.sellerAmount} USD.`,
      url:        `${platformUrl}/dashboard.html`,
      templateId: 'product-sale',
      emailMode:  'always',
      emailData: {
        name:         sellerName,
        buyerName:    order.buyerName,
        buyerEmail:   order.buyerEmail,
        productTitle: product.title,
        amount:       order.sellerAmount,
      },
    });

    console.log(`[deliver-product] Delivered — orderId: ${orderId}, type: ${product.deliveryType}`);

    return respond(200, { success: true, orderId, deliveryType: product.deliveryType });

  } catch (err) {
    console.error('[deliver-product] Error:', err);
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
