/**
 * Netlify Function: paystack-webhook.js
 * Path: netlify/functions/paystack-webhook.js
 *
 * Receives POST requests from Paystack when payment events occur.
 * Verifies the webhook signature, then on charge.success marks the
 * Firestore project as funded and notifies both parties.
 *
 * Flow:
 *  1. Accept POST only
 *  2. Get raw body as UTF-8 string
 *  3. Verify Paystack webhook signature (HMAC-SHA512, timing-safe)
 *  4. Parse the verified event
 *  5. Only act on charge.success — all others return 200 immediately
 *  6. Extract orderId and payment details from event data
 *  7. Init Firestore and fetch the project document
 *  8. Guard against double-processing
 *  9. Update the Firestore project document
 * 10. Fetch freelancer and buyer details
 * 11. Send push notification to the freelancer
 * 12. Send payment-received email to the freelancer
 *
 * Environment variables required:
 *   PAYSTACK_SECRET_KEY      — Paystack secret key (also used as webhook signing key)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com
 *
 * Paystack signs all webhook payloads using HMAC-SHA512 of the raw
 * request body with the secret key. The signature is sent in the
 * x-paystack-signature header as a hex digest.
 * Docs: https://paystack.com/docs/payments/webhooks/
 */

const crypto                           = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings } = require('./get-settings');

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

/* ── Internal function caller (function-to-function via HTTPS) ── */
async function callFunction(functionName, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`PLATFORM_URL not set — cannot call ${functionName}.`);
    return;
  }

  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${functionName}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`${functionName} returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    // Non-fatal — Firestore is already updated at this point
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   PAYSTACK SIGNATURE VERIFICATION
   Paystack signs webhooks using HMAC-SHA512.
   The signature is the hex digest of the raw request body,
   signed with the Paystack secret key.
   Header: x-paystack-signature
   Docs: https://paystack.com/docs/payments/webhooks/#verify-events
══════════════════════════════════════════════════════════════ */
function verifyPaystackSignature(rawBody, sigHeader, secretKey) {
  if (!sigHeader || !secretKey) {
    return { valid: false, reason: 'Missing signature header or secret key.' };
  }

  /* Compute HMAC-SHA512 of the raw body using the secret key */
  const expectedSig = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody, 'utf8')
    .digest('hex');

  /* Timing-safe comparison to prevent timing attacks */
  try {
    const receivedBuf = Buffer.from(sigHeader.toLowerCase(), 'hex');
    const expectedBuf = Buffer.from(expectedSig.toLowerCase(), 'hex');

    if (
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      return { valid: true };
    }
  } catch {
    // Buffer construction failed (e.g. non-hex signature value)
    return { valid: false, reason: 'Signature is not valid hex.' };
  }

  return { valid: false, reason: 'Signature mismatch.' };
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── 2. Get raw body as UTF-8 string ── */
  /*
   * Netlify may base64-encode the body for binary payloads.
   * Paystack sends JSON so this is defensive but necessary for correctness.
   * We must use the exact raw bytes that Paystack signed.
   */
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  /* ── 3. Verify Paystack webhook signature ── */
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error('PAYSTACK_SECRET_KEY environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const sigHeader = (
    event.headers['x-paystack-signature'] ||
    event.headers['X-Paystack-Signature'] ||
    ''
  );

  const { valid, reason } = verifyPaystackSignature(rawBody, sigHeader, secretKey);

  if (!valid) {
    console.warn(`Paystack webhook signature verification failed: ${reason}`);
    return respond(401, { error: 'Invalid webhook signature.' });
  }

  /* ── 4. Parse the verified event ── */
  let paystackEvent;
  try {
    paystackEvent = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON in webhook body.' });
  }

  const eventType = paystackEvent.event || '';
  console.log(`Paystack webhook received — event: ${eventType}`);

  /* ── 5. Only act on charge.success — acknowledge everything else ── */
  if (eventType !== 'charge.success') {
    console.log(`Paystack event "${eventType}" is not handled. Acknowledged.`);
    return respond(200, { received: true });
  }

  /* ── 6. Extract data from the charge.success event ── */
  const data = paystackEvent.data || {};

  /*
   * orderId is stored in data.metadata.orderId when the transaction was
   * initialised by create-paystack-payment.js.
   */
  const orderId       = data?.metadata?.orderId || null;
  const reference     = data?.reference         || null;
  const status        = data?.status            || null;
  const customerEmail = data?.customer?.email   || null;

  /*
   * Paystack sends amount in the smallest currency unit (kobo for NGN,
   * cents for USD). Divide by 100 to get the decimal USD amount.
   */
  const amountUsd = typeof data?.amount === 'number'
    ? data.amount / 100
    : null;

  if (!orderId) {
    console.error(
      'charge.success event missing metadata.orderId. Cannot update Firestore.',
      data
    );
    // Return 200 so Paystack stops retrying — we cannot recover without an order ID
    return respond(200, { received: true, warning: 'Missing orderId in metadata.' });
  }

  console.log(
    `Processing charge.success — orderId: ${orderId}, ref: ${reference}, amount: $${amountUsd}`
  );

  /* ── 7. Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    // Return 500 so Paystack retries this webhook later
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 8. Route: try projects first, then product-orders ── */
  const projectRef = db.collection('projects').doc(orderId);
  let   projectSnap;

  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  /* ── 8a. Product-order path ── */
  if (!projectSnap.exists) {
    const orderRef  = db.collection('product-orders').doc(orderId);
    let   orderSnap;
    try {
      orderSnap = await orderRef.get();
    } catch (err) {
      console.error(`Firestore read failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Database read failed.' });
    }

    if (!orderSnap.exists) {
      console.error(`Order "${orderId}" not found in projects or product-orders.`);
      return respond(200, { received: true, warning: `Order ${orderId} not found.` });
    }

    const order = orderSnap.data();

    // Idempotency guard
    if (order.paymentStatus === 'paid') {
      console.log(`Product order ${orderId} already paid. Skipping duplicate webhook.`);
      return respond(200, { received: true });
    }

    // Mark order paid
    try {
      await orderRef.update({
        paymentStatus:      'paid',
        paymentMethod:      'paystack',
        paystackReference:  reference,
        paymentConfirmedAt: FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${orderId} marked as paid.`);
    } catch (err) {
      console.error(`Firestore update failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Failed to update product order status.' });
    }

    // Trigger delivery
    await callFunction('deliver-product', { orderId });

    // Fire Facebook pixel if product has a pixelId configured
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists && productSnap.data().facebookPixelId) {
        await callFunction('pixel-event', {
          pixelId:   productSnap.data().facebookPixelId,
          eventName: 'Purchase',
          value:     order.amountUsd || amountUsd || 0,
          currency:  'USD',
          email:     order.buyerEmail || customerEmail || '',
          orderId,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${orderId}:`, err.message);
    }

    console.log(`Paystack product order ${orderId} handled successfully.`);
    return respond(200, { received: true });
  }

  /* ── 8b. Project path (existing logic) ── */
  const project = projectSnap.data();

  /* Guard against double-processing the same payment */
  if (project.escrowStatus === 'funded') {
    console.log(`Project ${orderId} is already funded. Skipping duplicate webhook.`);
    return respond(200, { received: true });
  }

  /* Fetch platform fee settings */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[paystack-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  const baseAmount       = Number(amountUsd || 0);
  const platformFeeAmt   = baseAmount * (settings.platformFeePercent / 100);
  const protectionFeeAmt = baseAmount * (settings.projectProtectionPercent / 100);
  const netAmount        = baseAmount - platformFeeAmt - protectionFeeAmt;

  /* ── 9. Update the Firestore project document ── */
  try {
    await projectRef.update({
      escrowStatus:        'funded',
      status:              'in_progress',
      paymentMethod:       'paystack',
      paystackReference:   reference,
      paymentStatus:       'success',
      platformFee:         platformFeeAmt,
      protectionFee:       protectionFeeAmt,
      netAmount:           netAmount,
      paymentConfirmedAt:  FieldValue.serverTimestamp(),
      updatedAt:           FieldValue.serverTimestamp(),
    });
    console.log(`Project ${orderId} updated — escrowStatus: funded, status: in_progress.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── 10. Fetch freelancer and buyer details ── */
  const freelancerUid = project.freelancerUid || null;
  const buyerUid      = project.buyerUid      || null;
  const projectTitle  = project.projectTitle  || 'Your project';

  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  let buyerName       = 'Client';

  try {
    const fetches = [];
    if (freelancerUid) fetches.push(db.collection('users').doc(freelancerUid).get());
    if (buyerUid)      fetches.push(db.collection('users').doc(buyerUid).get());

    const snaps = await Promise.all(fetches);

    if (freelancerUid && snaps[0]?.exists) {
      freelancerEmail = snaps[0].data().email || null;
      freelancerName  = snaps[0].data().name  || 'Freelancer';
    }
    if (buyerUid) {
      const bSnap = freelancerUid ? snaps[1] : snaps[0];
      if (bSnap?.exists) {
        buyerName = bSnap.data().name || 'Client';
      }
    }
  } catch (err) {
    // Non-fatal — Firestore project is already updated
    console.warn('Could not fetch user details for notifications:', err.message);
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(orderId)}`;

  /* ── 11 + 12. Notify the freelancer: payment received (push + email always) ── */
  if (freelancerUid || freelancerEmail) {
    await callFunction('send-smart-notification', {
      userUid:    freelancerUid  || null,
      to:         freelancerEmail || null,
      title:      'Payment Received',
      body:       `Payment has been placed in escrow for "${projectTitle}". You can begin work.`,
      url:        projectUrl,
      templateId: 'payment-received',
      emailMode:  'always',
      data: {
        name:         freelancerName,
        buyerName,
        projectTitle,
        amount:       amountUsd ? `$${amountUsd.toFixed(2)}` : 'the agreed amount',
        dashboardUrl: projectUrl,
      },
    });
  } else {
    console.warn(`No freelancer uid or email found for project ${orderId}. Notification not sent.`);
  }

  console.log(`Paystack charge.success handled successfully for project ${orderId}.`);
  return respond(200, { received: true });
};

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
