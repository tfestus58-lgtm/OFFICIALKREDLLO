/**
 * Netlify Function: stripe-webhook.js
 * Path: netlify/functions/stripe-webhook.js
 *
 * Receives POST requests from Stripe when payment events occur.
 * Verifies the webhook signature, then on checkout.session.completed
 * marks the Firestore project as funded and notifies the freelancer.
 *
 * Flow:
 *  1. Verify Stripe webhook signature (HMAC-SHA256, timing-safe)
 *  2. Parse the event
 *  3. Only act on checkout.session.completed — all others return 200 immediately
 *  4. Extract order_id from event metadata
 *  5. Update Firestore project document
 *  6. Fetch freelancer details
 *  7. Send push notification to freelancer
 *  8. Send payment-received email to freelancer
 *
 * Environment variables required:
 *   STRIPE_WEBHOOK_SECRET    — from Stripe Dashboard > Webhooks > signing secret
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com
 *
 * Stripe sends the raw request body as-is for signature verification.
 * Netlify provides the raw body in event.body. isBase64Encoded must be
 * handled so we always work with a UTF-8 string for HMAC computation.
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
    // Non-fatal — Firestore is already updated
    console.error(`Failed to call ${functionName}:`, err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   STRIPE SIGNATURE VERIFICATION
   Stripe signs webhooks using HMAC-SHA256.
   Header format: t=<timestamp>,v1=<hex_signature>[,v0=<deprecated>]
   Signed payload: <timestamp> + "." + <rawBody>
   Docs: https://stripe.com/docs/webhooks/signatures
══════════════════════════════════════════════════════════════ */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return { valid: false, reason: 'Missing signature header or secret.' };

  // Parse the header into its components
  const parts     = sigHeader.split(',');
  let timestamp   = null;
  const v1Sigs    = [];

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't')  timestamp = value;
    if (key === 'v1') v1Sigs.push(value);
  }

  if (!timestamp) {
    return { valid: false, reason: 'Missing timestamp in Stripe-Signature header.' };
  }
  if (v1Sigs.length === 0) {
    return { valid: false, reason: 'No v1 signature found in Stripe-Signature header.' };
  }

  // Guard against replay attacks: reject if timestamp is older than 5 minutes
  const tolerance = 300; // seconds
  const eventAge  = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(eventAge) > tolerance) {
    return { valid: false, reason: `Webhook timestamp is too old (${eventAge}s). Possible replay attack.` };
  }

  // Construct the signed payload string as Stripe defines it
  const signedPayload = `${timestamp}.${rawBody}`;

  // Compute the expected HMAC-SHA256
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // Check against all v1 signatures (Stripe may send multiple during key rotation)
  for (const receivedSig of v1Sigs) {
    try {
      const receivedBuf = Buffer.from(receivedSig, 'hex');
      const expectedBuf = Buffer.from(expectedSig, 'hex');

      if (
        receivedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(receivedBuf, expectedBuf)
      ) {
        return { valid: true };
      }
    } catch {
      // Buffer mismatch (different lengths) — continue checking other sigs
    }
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
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  /* ── 3. Verify Stripe webhook signature ── */
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
  const { valid, reason } = verifyStripeSignature(rawBody, sigHeader, webhookSecret);

  if (!valid) {
    console.warn(`Stripe webhook signature verification failed: ${reason}`);
    return respond(401, { error: 'Invalid webhook signature.' });
  }

  /* ── 4. Parse the verified event ── */
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON in webhook body.' });
  }

  const eventType = stripeEvent.type || '';
  console.log(`Stripe webhook received — type: ${eventType}, id: ${stripeEvent.id}`);

  /* ── 5. Only act on checkout.session.completed ── */
  if (eventType !== 'checkout.session.completed') {
    // Acknowledge all other event types immediately — no action needed
    console.log(`Stripe event type "${eventType}" is not handled. Acknowledged.`);
    return respond(200, { received: true });
  }

  /* ── 6. Extract data from the completed session ── */
  const session = stripeEvent.data?.object || {};

  const orderId            = session.metadata?.order_id || null;
  const sessionId          = session.id                 || null;
  const paymentStatus      = session.payment_status     || null;
  const customerEmail      = session.customer_email     || null;
  // Stripe sends amount_total in the smallest currency unit (e.g. cents for USD)
  const confirmedAmountRaw = session.amount_total       || 0;
  const confirmedCurrency  = (session.currency || 'usd').toUpperCase();
  const confirmedAmount    = confirmedAmountRaw / 100;
  // Keep amountUsd for backward-compat references below (project path uses it)
  const amountUsd          = confirmedCurrency === 'USD' ? confirmedAmount : null;

  if (!orderId) {
    console.error('checkout.session.completed event missing metadata.order_id. Cannot update Firestore.', session);
    // Still return 200 so Stripe stops retrying — we cannot recover without an order ID
    return respond(200, { received: true, warning: 'Missing order_id in metadata.' });
  }

  console.log(`Processing completed checkout — orderId: ${orderId}, sessionId: ${sessionId}, amount: ${confirmedAmount} ${confirmedCurrency}`);

  /* ── 7. Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    // Return 500 so Stripe retries this webhook later
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 7b. Route: Pro upgrade ── */
  const paymentPurpose = session.metadata?.payment_purpose || null;
  if (paymentPurpose === 'pro_upgrade') {
    const upgradeUid       = session.metadata?.uid           || null;
    const upgradePeriod    = session.metadata?.billingPeriod || 'monthly';
    const upgradeSubId     = session.metadata?.subscriptionId || orderId;
    await handleProUpgrade({ db, uid: upgradeUid, billingPeriod: upgradePeriod, subscriptionId: upgradeSubId, gateway: 'stripe', amount: confirmedAmount, customerEmail });
    return respond(200, { received: true });
  }

  /* ── 8. Route: try projects first, then product-orders ── */
  const projectRef  = db.collection('projects').doc(orderId);
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

    // Fetch platform settings to calculate fees
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[stripe-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    const productPlatformFee  = +(confirmedAmount * (productOrderSettings.platformFeePercent / 100)).toFixed(2);
    const productSellerAmount = +(confirmedAmount - productPlatformFee).toFixed(2);

    // Mark order paid and write confirmed amount + fees
    try {
      await orderRef.update({
        paymentStatus:      'paid',
        paymentMethod:      'stripe',
        stripeSessionId:    sessionId,
        amount:             confirmedAmount,
        currency:           confirmedCurrency,
        amountUsd:          confirmedCurrency === 'USD' ? confirmedAmount : null,
        platformFee:        productPlatformFee,
        sellerAmount:       productSellerAmount,
        paymentConfirmedAt: FieldValue.serverTimestamp(),
        updatedAt:          FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);
    } catch (err) {
      console.error(`Firestore update failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Failed to update product order status.' });
    }

    // Trigger delivery
    await callFunction('deliver-product', { orderId, sellerAmount: productSellerAmount });

    // Fire Facebook pixel if product has a pixelId configured
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      const fbPixelId = productSnap.exists && productSnap.data().integrations && productSnap.data().integrations.facebookPixelId;
      if (fbPixelId) {
        await callFunction('pixel-event', {
          pixelId:   fbPixelId,
          eventName: 'Purchase',
          value:     confirmedAmount,
          currency:  confirmedCurrency,
          email:     order.buyerEmail || customerEmail || '',
          orderId,
        });
      }
    } catch (err) {
      console.warn(`Could not fire pixel for product-order ${orderId}:`, err.message);
    }

    console.log(`Stripe product order ${orderId} handled successfully.`);
    return respond(200, { received: true });
  }

  /* ── 8b. Project path (existing logic) ── */
  const project = projectSnap.data();

  // Guard against double-processing the same payment
  if (project.escrowStatus === 'funded') {
    console.log(`Project ${orderId} is already funded. Skipping duplicate webhook.`);
    return respond(200, { received: true });
  }

  /* Fetch platform fee settings */
  let settings;
  try {
    settings = await getSettings(db);
  } catch (err) {
    console.warn('[stripe-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  const baseAmount       = Number(confirmedAmount || 0);
  const platformFeeAmt   = baseAmount * (settings.platformFeePercent / 100);
  const protectionFeeAmt = baseAmount * (settings.projectProtectionPercent / 100);
  const netAmount        = baseAmount - platformFeeAmt - protectionFeeAmt;

  /* ── 9. Update the Firestore project document ── */
  try {
    await projectRef.update({
      escrowStatus:       'funded',
      status:             'in_progress',
      paymentMethod:      'stripe',
      stripeSessionId:    sessionId,
      paymentStatus:      paymentStatus,
      currency:           confirmedCurrency,
      platformFee:        platformFeeAmt,
      protectionFee:      protectionFeeAmt,
      netAmount:          netAmount,
      paymentConfirmedAt: FieldValue.serverTimestamp(),
      updatedAt:          FieldValue.serverTimestamp(),
    });
    console.log(`Project ${orderId} updated — escrowStatus: funded, status: in_progress.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── 10. Fetch freelancer and buyer details ── */
  const freelancerUid  = project.freelancerUid  || null;
  const buyerUid       = project.buyerUid       || null;
  const projectTitle   = project.projectTitle   || 'Your project';

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
    // Non-fatal — Firestore is already updated
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
        amount:       confirmedAmount ? new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount) : 'the agreed amount',
        dashboardUrl: projectUrl,
      },
    });
  } else {
    console.warn(`No freelancer uid or email found for project ${orderId}. Notification not sent.`);
  }

  console.log(`Stripe checkout.session.completed handled successfully for project ${orderId}.`);
  return respond(200, { received: true });
};

/* ── Pro Upgrade handler (shared logic) ── */
async function handleProUpgrade({ db, uid, billingPeriod, subscriptionId, gateway, amount, customerEmail }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid in metadata — cannot activate Pro.');
    return;
  }

  const now         = new Date();
  const daysToAdd   = billingPeriod === 'annual' ? 365 : 30;
  const endDate     = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

  try {
    // Activate Pro on the user document
    await db.collection('users').doc(uid).update({
      plan:             'pro',
      premiumStatus:    'active',
      premiumStartDate: now,
      premiumEndDate:   endDate,
      updatedAt:        require('firebase-admin/firestore').FieldValue.serverTimestamp(),
    });

    // Mark the subscription doc as active
    if (subscriptionId) {
      await db.collection('subscriptions').doc(subscriptionId).update({
        status:    'active',
        activatedAt: now,
        premiumEndDate: endDate,
      }).catch(() => {}); // non-fatal if sub doc doesn't exist
    }

    console.log(`[pro_upgrade] uid: ${uid} activated Pro via ${gateway} — expires ${endDate.toISOString()}`);

    // Send welcome email
    const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
    if (platformUrl) {
      const userSnap = await db.collection('users').doc(uid).get().catch(() => null);
      const userData = userSnap?.exists ? userSnap.data() : {};
      const toEmail  = customerEmail || userData.email || null;
      const name     = userData.displayName || userData.name || 'Freelancer';

      if (toEmail) {
        await fetch(`${platformUrl}/.netlify/functions/send-email`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            to:   toEmail,
            type: 'premium-activated',
            data: {
              name,
              plan:          'Pro',
              billingPeriod: billingPeriod === 'annual' ? 'Annual' : 'Monthly',
              endDate:       endDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
              dashboardUrl:  `${platformUrl}/dashboard.html`,
            },
          }),
        }).catch(e => console.warn('[pro_upgrade] send-email failed:', e.message));
      }
    }
  } catch (err) {
    console.error('[pro_upgrade] Firestore update failed:', err.message);
  }
}

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
