/**
 * Netlify Function: nowpayments-webhook.js
 * Path: netlify/functions/nowpayments-webhook.js
 *
 * Receives IPN (Instant Payment Notification) POST requests from NOWPayments
 * whenever a payment status changes. Verifies the HMAC-SHA512 signature,
 * then — on a confirmed or finished payment — updates the Firestore project
 * document and emails the freelancer.
 *
 * Environment variables required:
 *   NOWPAYMENTS_IPN_SECRET      — IPN secret from your NOWPayments dashboard
 *   FIREBASE_SERVICE_ACCOUNT    — full Firebase service account JSON as a
 *                                 single-line string (for server-side Firestore)
 *   PLATFORM_URL                — your live domain, e.g. https://kreddlo.com
 *
 * NOWPayments sends these statuses (in rough order):
 *   waiting → confirming → confirmed → finished
 *   partially_paid → failed → refunded → expired
 *
 * We act on "confirmed" and "finished" only — both mean the funds are secured.
 */

const crypto  = require('crypto');
const https   = require('https');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings } = require('./get-settings');

/* ── Initialise Firebase Admin SDK once (survives warm Lambda invocations) ── */
function getDb() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ── Statuses that mean "money is in hand" ── */
const FUNDED_STATUSES = new Set(['confirmed', 'finished']);

/* ── Statuses worth logging but requiring no Firestore write ── */
const PENDING_STATUSES = new Set(['waiting', 'confirming', 'partially_paid']);

/* ── Terminal failure statuses ── */
const FAILED_STATUSES = new Set(['failed', 'refunded', 'expired']);


exports.handler = async (event) => {

  /* ── 1. Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  const rawBody = event.body || '';

  /* ── 2. Verify IPN signature ── */
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.error('NOWPAYMENTS_IPN_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const receivedSig = (event.headers['x-nowpayments-sig'] || '').toLowerCase();
  if (!receivedSig) {
    console.warn('Webhook received with no x-nowpayments-sig header — rejected.');
    return respond(401, { error: 'Missing signature.' });
  }

  const isValid = verifySignature(rawBody, ipnSecret, receivedSig);
  if (!isValid) {
    console.warn('Webhook signature mismatch — possible spoofed request. Rejected.');
    return respond(401, { error: 'Invalid signature.' });
  }

  /* ── 3. Parse the verified payload ── */
  let payment;
  try {
    payment = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    payment_id,
    payment_status,
    order_id,          // this is the Firestore project document ID we passed at invoice creation
    pay_amount,        // amount sent by buyer in crypto
    pay_currency,      // crypto coin used
    actually_paid,     // actual amount received (may differ slightly from pay_amount)
    outcome_amount,    // USD value received after conversion
    outcome_currency,
    fee,               // object: { currency, depositFee, withdrawalFee, serviceFee }
    updated_at,
  } = payment;

  console.log(`IPN received — paymentId: ${payment_id}, status: ${payment_status}, orderId: ${order_id}`);

  /* ── 4. Route by status ── */

  if (PENDING_STATUSES.has(payment_status)) {
    // Confirming on-chain — nothing to write yet, just acknowledge
    console.log(`Payment ${payment_id} is pending (${payment_status}). No action taken.`);
    return respond(200, { received: true });
  }

  if (FAILED_STATUSES.has(payment_status)) {
    // Optionally mark the project payment as failed so the buyer can retry
    await handleFailedPayment({ order_id, payment_id, payment_status });
    return respond(200, { received: true });
  }

  if (FUNDED_STATUSES.has(payment_status)) {
    await handleFundedPayment({
      order_id,
      payment_id,
      payment_status,
      pay_amount,
      pay_currency,
      actually_paid,
      outcome_amount,
      outcome_currency,
      fee,
      updated_at,
    });
    return respond(200, { received: true });
  }

  // Unknown status — acknowledge so NOWPayments stops retrying, log for review
  console.warn(`Unhandled payment status "${payment_status}" for order ${order_id}.`);
  return respond(200, { received: true });
};


/* ══════════════════════════════════════════════════════════════
   SIGNATURE VERIFICATION
   NOWPayments signs webhooks with HMAC-SHA512 of the request body
   after sorting the body's top-level keys alphabetically.
   Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt#callbacks
══════════════════════════════════════════════════════════════ */
function verifySignature(rawBody, secret, receivedSig) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  // Sort keys alphabetically and re-serialise (NOWPayments requirement)
  const sorted = sortObjectKeys(parsed);
  const sortedJson = JSON.stringify(sorted);

  const expectedSig = crypto
    .createHmac('sha512', secret)
    .update(sortedJson)
    .digest('hex')
    .toLowerCase();

  // Timing-safe comparison prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(receivedSig, 'utf8'),
    );
  } catch {
    // Buffers of different length — definitely not equal
    return false;
  }
}

/**
 * Recursively sorts object keys alphabetically.
 * NOWPayments sorts the entire nested payload before signing.
 */
function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}


/* ══════════════════════════════════════════════════════════════
   HANDLE FUNDED PAYMENT
   - Updates the project document in Firestore
   - Emails the freelancer
══════════════════════════════════════════════════════════════ */
async function handleFundedPayment(data) {
  const {
    order_id, payment_id, payment_status,
    pay_amount, pay_currency,
    actually_paid, outcome_amount, outcome_currency,
    fee, updated_at,
  } = data;

  if (!order_id) {
    console.error('Funded payment arrived with no order_id — cannot update Firestore.');
    return;
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Failed to initialise Firebase Admin:', err.message);
    return;
  }

  const projectRef = db.collection('projects').doc(order_id);

  /* ── Try projects collection first ── */
  let projectSnap;
  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${order_id}:`, err.message);
    return;
  }

  /* ── If not a project, try product-orders ── */
  if (!projectSnap.exists) {
    const orderRef  = db.collection('product-orders').doc(order_id);
    let   orderSnap;
    try {
      orderSnap = await orderRef.get();
    } catch (err) {
      console.error(`Firestore read failed for product-order ${order_id}:`, err.message);
      return;
    }

    if (!orderSnap.exists) {
      console.error(`Order "${order_id}" not found in projects or product-orders.`);
      return; // caller returns 200 — nothing retrying can fix
    }

    const order = orderSnap.data();

    // Idempotency guard
    if (order.paymentStatus === 'paid') {
      console.log(`Product order ${order_id} already paid. Skipping duplicate webhook.`);
      return;
    }

    // Mark order paid
    try {
      await orderRef.update({
        paymentStatus:      'paid',
        paymentMethod:      'crypto',
        paymentConfirmedAt: FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${order_id} marked as paid.`);
    } catch (err) {
      console.error(`Firestore update failed for product-order ${order_id}:`, err.message);
      return;
    }

    // Trigger delivery
    await callFunction('deliver-product', { orderId: order_id });

    // Fire Facebook pixel if product has a pixelId configured
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists && productSnap.data().facebookPixelId) {
        await callFunction('pixel-event', {
          pixelId:   productSnap.data().facebookPixelId,
          eventName: 'Purchase',
          value:     order.amountUsd || 0,
          currency:  'USD',
          email:     order.buyerEmail || '',
          orderId:   order_id,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${order_id}:`, err.message);
    }

    return; // done with product order path
  }

  const project = projectSnap.data();

  // Guard against double-processing the same payment
  if (project.escrowStatus === 'funded') {
    console.log(`Project ${order_id} already marked as funded. Skipping duplicate webhook.`);
    return;
  }

  /* Fetch platform fee settings and compute net amount */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[nowpayments-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  const baseAmount        = Number(outcome_amount || pay_amount || 0);
  const platformFeeAmt    = baseAmount * (settings.platformFeePercent / 100);
  const protectionFeeAmt  = baseAmount * (settings.projectProtectionPercent / 100);
  const netAmount         = baseAmount - platformFeeAmt - protectionFeeAmt;

  /* Update the project document */
  const updatePayload = {
    escrowStatus:    'funded',
    status:          'in_progress',
    paymentMethod:   'crypto',
    paymentId:       payment_id,
    paymentStatus:   payment_status,
    payCurrency:     pay_currency      || null,
    payAmount:       pay_amount        || null,
    actuallyPaid:    actually_paid     || null,
    outcomeAmount:   outcome_amount    || null,
    outcomeCurrency: outcome_currency  || null,
    paymentFee:      fee               || null,
    platformFee:     platformFeeAmt,
    protectionFee:   protectionFeeAmt,
    netAmount:       netAmount,
    paymentConfirmedAt: updated_at
      ? new Date(updated_at)
      : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    await projectRef.update(updatePayload);
    console.log(`Project ${order_id} updated — escrowStatus: funded, status: in_progress.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${order_id}:`, err.message);
    return;
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const projectUrl  = `${platformUrl}/dashboard-projects.html?projectId=${encodeURIComponent(order_id)}`;

  /* Fetch freelancer and buyer details for the notification */
  let freelancerEmail = null;
  let freelancerName  = 'there';
  let buyerName       = 'A client';

  try {
    if (project.freelancerUid) {
      const freelancerSnap = await db.collection('users').doc(project.freelancerUid).get();
      if (freelancerSnap.exists) {
        freelancerEmail = freelancerSnap.data().email || null;
        freelancerName  = freelancerSnap.data().name  || 'there';
      }
    }
    if (project.buyerUid) {
      const buyerSnap = await db.collection('users').doc(project.buyerUid).get();
      if (buyerSnap.exists) {
        buyerName = buyerSnap.data().name || 'A client';
      }
    }
  } catch (err) {
    console.warn('Could not fetch user details for notification:', err.message);
  }

  /* Notify the freelancer: payment received (push + email always) */
  await callFunction('send-smart-notification', {
    userUid:    project.freelancerUid || null,
    to:         freelancerEmail,
    title:      'Escrow Funded',
    body:       `Payment has been placed in escrow for "${project.projectTitle || 'Your project'}". You can begin work.`,
    url:        projectUrl,
    templateId: 'payment-received',
    emailMode:  'always',
    data: {
      name:         freelancerName,
      buyerName,
      projectTitle: project.projectTitle || 'Your project',
      amount:       project.netAmount || outcome_amount || pay_amount
                      ? `$${Number(project.netAmount || outcome_amount || pay_amount).toFixed(2)}`
                      : 'the agreed amount',
      dashboardUrl: projectUrl,
    },
  });
}


/* ══════════════════════════════════════════════════════════════
   HANDLE FAILED / EXPIRED / REFUNDED PAYMENT
   Marks the project payment status so the buyer can retry.
══════════════════════════════════════════════════════════════ */
async function handleFailedPayment({ order_id, payment_id, payment_status }) {
  if (!order_id) return;

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed (failed payment handler):', err.message);
    return;
  }

  try {
    await db.collection('projects').doc(order_id).update({
      paymentStatus: payment_status,
      paymentId:     payment_id || null,
      updatedAt:     FieldValue.serverTimestamp(),
    });
    console.log(`Project ${order_id} payment marked as ${payment_status}.`);
  } catch (err) {
    console.error(`Firestore update failed for failed payment on project ${order_id}:`, err.message);
  }
}


/* ══════════════════════════════════════════════════════════════
   INTERNAL FUNCTION CALLER
   Calls sibling Netlify functions via HTTP fetch.
   Non-fatal: errors are logged and execution continues.
══════════════════════════════════════════════════════════════ */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return;
  }
  try {
    await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn(`callFunction(${name}) failed:`, err.message);
  }
}


/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
