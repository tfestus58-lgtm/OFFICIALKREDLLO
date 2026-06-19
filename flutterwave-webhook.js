/**
 * Netlify Function: flutterwave-webhook.js
 * Path: netlify/functions/flutterwave-webhook.js
 *
 * Receives POST requests from Flutterwave when payment events occur.
 * Verifies the webhook signature, then on charge.completed (successful)
 * marks the Firestore project/product-order/invoice-order as funded/paid
 * and notifies both parties.
 *
 * Flow:
 *  1. Accept POST only
 *  2. Get raw body as UTF-8 string
 *  3. Verify Flutterwave webhook signature (SHA-256 HMAC, timing-safe)
 *  4. Parse the verified event
 *  5. Only act on charge.completed with status=successful — all others return 200
 *  6. Verify the transaction with Flutterwave's verify endpoint (double-check)
 *  7. Route: pro_upgrade → project → product-order → invoice-order
 *  8. Update Firestore, credit affiliates, trigger delivery, notify parties
 *
 * Environment variables required:
 *   FLW_SECRET_KEY           — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   FLW_WEBHOOK_HASH         — Flutterwave webhook secret hash (set in FLW dashboard)
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as one-line string
 *   PLATFORM_URL             — live domain, e.g. https://kreddlo.com
 *
 * Flutterwave signs all webhook payloads by sending the webhook hash in the
 * verif-hash header. We compare it against FLW_WEBHOOK_HASH.
 * For extra security we also re-verify the transaction via the Flutterwave
 * GET /v3/transactions/:id/verify endpoint before writing to Firestore.
 * Docs: https://developer.flutterwave.com/docs/integration-guides/webhooks/
 */

const crypto                           = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const { getSettings }                  = require('./get-settings');

/* ── Flutterwave verify endpoint ── */
const FLW_VERIFY_URL = (txId) => `https://api.flutterwave.com/v3/transactions/${txId}/verify`;

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
   FLUTTERWAVE WEBHOOK SIGNATURE VERIFICATION
   Flutterwave sends the webhook secret hash you configured in the
   dashboard in the "verif-hash" header on every webhook call.
   We compare it (timing-safe) against FLW_WEBHOOK_HASH.
   Docs: https://developer.flutterwave.com/docs/integration-guides/webhooks/
══════════════════════════════════════════════════════════════ */
function verifyFlutterwaveSignature(sigHeader, webhookHash) {
  if (!sigHeader || !webhookHash) {
    return { valid: false, reason: 'Missing verif-hash header or FLW_WEBHOOK_HASH env var.' };
  }

  try {
    const receivedBuf = Buffer.from(sigHeader, 'utf8');
    const expectedBuf = Buffer.from(webhookHash, 'utf8');

    if (
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      return { valid: true };
    }
  } catch {
    return { valid: false, reason: 'timingSafeEqual comparison failed.' };
  }

  return { valid: false, reason: 'Signature mismatch.' };
}

/* ══════════════════════════════════════════════════════════════
   FLUTTERWAVE TRANSACTION VERIFICATION
   After the webhook passes the hash check, we re-verify the
   transaction via GET /v3/transactions/:id/verify to confirm
   the amount, currency and status are genuine.
   This prevents replay attacks where a fraudster sends a webhook
   body from a cheap transaction to unlock an expensive order.
══════════════════════════════════════════════════════════════ */
async function verifyFlutterwaveTransaction(txId, flwKey) {
  const res = await fetch(FLW_VERIFY_URL(txId), {
    method:  'GET',
    headers: {
      'Authorization': `Bearer ${flwKey}`,
      'Content-Type':  'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || `Flutterwave verify returned status ${res.status}`);
  }

  return data.data; // verified transaction object
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

  /* ── 3. Verify Flutterwave webhook signature ── */
  const webhookHash = process.env.FLW_WEBHOOK_HASH;
  if (!webhookHash) {
    console.error('FLW_WEBHOOK_HASH environment variable is not set.');
    return respond(500, { error: 'Webhook not configured.' });
  }

  const sigHeader = (
    event.headers['verif-hash'] ||
    event.headers['Verif-Hash'] ||
    ''
  );

  const { valid, reason } = verifyFlutterwaveSignature(sigHeader, webhookHash);

  if (!valid) {
    console.warn(`Flutterwave webhook signature verification failed: ${reason}`);
    return respond(401, { error: 'Invalid webhook signature.' });
  }

  /* ── 4. Parse the verified event ── */
  let flwEvent;
  try {
    flwEvent = JSON.parse(rawBody);
  } catch {
    return respond(400, { error: 'Invalid JSON in webhook body.' });
  }

  const eventType = flwEvent.event || '';
  console.log(`Flutterwave webhook received — event: ${eventType}`);

  /* ── 5. Only act on charge.completed — acknowledge everything else ── */
  if (eventType !== 'charge.completed') {
    console.log(`Flutterwave event "${eventType}" is not handled. Acknowledged.`);
    return respond(200, { received: true });
  }

  /* ── 6. Extract data from the charge.completed event ── */
  const eventData = flwEvent.data || {};

  /*
   * Flutterwave sends the tx_ref we generated in create-flutterwave-payment.js
   * Format: kreddlo-<orderId>-<timestamp>
   * We extract orderId from it.
   */
  const txRef    = eventData?.tx_ref    || null;
  const flwTxId  = eventData?.id        || null;
  const status   = eventData?.status    || null;

  /* Only process successful charges */
  if (status !== 'successful') {
    console.log(`Flutterwave charge.completed with status="${status}" — not successful. Acknowledged.`);
    return respond(200, { received: true });
  }

  if (!txRef) {
    console.error('charge.completed event missing tx_ref. Cannot update Firestore.', eventData);
    return respond(200, { received: true, warning: 'Missing tx_ref in event data.' });
  }

  if (!flwTxId) {
    console.error('charge.completed event missing transaction id. Cannot verify.', eventData);
    return respond(200, { received: true, warning: 'Missing transaction id in event data.' });
  }

  /*
   * Extract orderId from tx_ref.
   * tx_ref format: kreddlo-<orderId>-<timestamp>
   * Split on '-' and take everything between the first and last segments.
   */
  const txRefParts = txRef.split('-');
  // txRefParts[0] = 'kreddlo', txRefParts[last] = timestamp, middle = orderId
  const orderId = txRefParts.length >= 3
    ? txRefParts.slice(1, -1).join('-')
    : null;

  if (!orderId) {
    console.error(`Could not extract orderId from tx_ref="${txRef}". Cannot update Firestore.`);
    return respond(200, { received: true, warning: 'Could not parse orderId from tx_ref.' });
  }

  /* ── 7. Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── 8. Re-verify the transaction with Flutterwave ── */
  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('FLW_SECRET_KEY environment variable is not set.');
    return respond(500, { error: 'Flutterwave not configured.' });
  }

  let verifiedTx;
  try {
    verifiedTx = await verifyFlutterwaveTransaction(flwTxId, flwKey);
  } catch (err) {
    console.error(`Flutterwave transaction verification failed for tx ${flwTxId}:`, err.message);
    // Return 500 so Flutterwave retries the webhook
    return respond(500, { error: 'Could not verify transaction with Flutterwave.' });
  }

  /* Confirm the verified transaction is also successful */
  if (verifiedTx.status !== 'successful') {
    console.warn(`Verified transaction ${flwTxId} status is "${verifiedTx.status}", not successful. Ignoring.`);
    return respond(200, { received: true, warning: 'Transaction not confirmed as successful by verify endpoint.' });
  }

  /*
   * Flutterwave returns amount in the base currency unit (no smallest-unit conversion).
   * e.g. 250.00 NGN is exactly 250.00 — unlike Paystack which returns 25000 (kobo).
   */
  const confirmedAmount   = Number(verifiedTx.amount)   || 0;
  const confirmedCurrency = (verifiedTx.currency || 'NGN').toUpperCase();
  const customerEmail     = verifiedTx.customer?.email  || null;
  const reference         = verifiedTx.flw_ref          || txRef;

  console.log(
    `Processing charge.completed — orderId: ${orderId}, txId: ${flwTxId}, amount: ${confirmedAmount} ${confirmedCurrency}`
  );

  /* ── 9. Route: Pro upgrade ── */
  const paymentPurpose = verifiedTx.meta?.payment_purpose || eventData?.meta?.payment_purpose || null;
  if (paymentPurpose === 'pro_upgrade') {
    const upgradeUid    = verifiedTx.meta?.uid            || null;
    const upgradePeriod = verifiedTx.meta?.billingPeriod  || 'monthly';
    const upgradeSubId  = verifiedTx.meta?.subscriptionId || orderId;
    await handleProUpgrade({
      db,
      uid:            upgradeUid,
      billingPeriod:  upgradePeriod,
      subscriptionId: upgradeSubId,
      gateway:        'flutterwave',
      amount:         confirmedAmount,
      customerEmail,
    });
    return respond(200, { received: true });
  }

  /* ── 10. Route: try projects first, then product-orders, then invoice-orders ── */
  const projectRef  = db.collection('projects').doc(orderId);
  let   projectSnap;

  try {
    projectSnap = await projectRef.get();
  } catch (err) {
    console.error(`Firestore read failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  /* ── 10a. Product-order path ── */
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
      /* ── 10b. Invoice-order path ── */
      const invOrderRef  = db.collection('invoice-orders').doc(orderId);
      let   invOrderSnap;
      try {
        invOrderSnap = await invOrderRef.get();
      } catch (err) {
        console.error(`Firestore read failed for invoice-order ${orderId}:`, err.message);
        return respond(500, { error: 'Database read failed.' });
      }

      if (!invOrderSnap.exists) {
        console.error(`Order "${orderId}" not found in projects, product-orders, or invoice-orders.`);
        return respond(200, { received: true, warning: `Order ${orderId} not found.` });
      }

      await handleInvoiceOrderPaid({
        db,
        orderId,
        invOrderRef,
        invOrderSnap,
        confirmedAmount,
        confirmedCurrency,
        sessionId:      null,
        paymentMethod:  'flutterwave',
        flwRef:         reference,
      });
      return respond(200, { received: true });
    }

    const order = orderSnap.data();

    /* Idempotency guard */
    if (order.paymentStatus === 'paid') {
      console.log(`Product order ${orderId} already paid. Skipping duplicate webhook.`);
      return respond(200, { received: true });
    }

    /* Fetch platform settings to calculate fees */
    let productOrderSettings;
    try {
      productOrderSettings = await getSettings(db);
    } catch (err) {
      console.warn('[flutterwave-webhook] Could not fetch settings for product order, using defaults:', err.message);
      productOrderSettings = { platformFeePercent: 2.5 };
    }

    const productPlatformFee  = +(confirmedAmount * (productOrderSettings.platformFeePercent / 100)).toFixed(2);
    const productSellerAmount = +(confirmedAmount - productPlatformFee).toFixed(2);

    /* Mark order paid and write confirmed amount + fees */
    try {
      await orderRef.update({
        paymentStatus:          'paid',
        paymentMethod:          'flutterwave',
        flutterwaveReference:   reference,
        flutterwaveTxId:        flwTxId,
        amount:                 confirmedAmount,
        currency:               confirmedCurrency,
        amountUsd:              confirmedCurrency === 'USD' ? confirmedAmount : null,
        platformFee:            productPlatformFee,
        sellerAmount:           productSellerAmount,
        paymentConfirmedAt:     FieldValue.serverTimestamp(),
        updatedAt:              FieldValue.serverTimestamp(),
      });
      console.log(`Product order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${productSellerAmount}`);
    } catch (err) {
      console.error(`Firestore update failed for product-order ${orderId}:`, err.message);
      return respond(500, { error: 'Failed to update product order status.' });
    }

    /* Credit affiliate commission if this order was referred */
    const { finalSellerAmount } = await creditAffiliateCommission({
      db,
      order,
      orderId,
      sellerAmount:      productSellerAmount,
      confirmedAmount,
      confirmedCurrency,
      gateway:           'flutterwave',
    });

    /* Trigger delivery with the final seller amount (after any affiliate deduction) */
    await callFunction('deliver-product', { orderId, sellerAmount: finalSellerAmount });

    /* Fire Facebook pixel if product has a pixelId configured */
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

    console.log(`Flutterwave product order ${orderId} handled successfully.`);
    return respond(200, { received: true });
  }

  /* ── 10c. Project path ── */
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
    console.warn('[flutterwave-webhook] Could not fetch settings, using defaults:', err.message);
    settings = { platformFeePercent: 2.5, projectProtectionPercent: 1.0 };
  }

  const baseAmount       = Number(confirmedAmount || 0);
  const platformFeeAmt   = baseAmount * (settings.platformFeePercent / 100);
  const protectionFeeAmt = baseAmount * (settings.projectProtectionPercent / 100);
  const netAmount        = baseAmount - platformFeeAmt - protectionFeeAmt;

  /* ── 11. Update the Firestore project document ── */
  try {
    await projectRef.update({
      escrowStatus:           'funded',
      status:                 'in_progress',
      paymentMethod:          'flutterwave',
      flutterwaveReference:   reference,
      flutterwaveTxId:        flwTxId,
      paymentStatus:          'success',
      currency:               confirmedCurrency,
      platformFee:            platformFeeAmt,
      protectionFee:          protectionFeeAmt,
      netAmount:              netAmount,
      paymentConfirmedAt:     FieldValue.serverTimestamp(),
      updatedAt:              FieldValue.serverTimestamp(),
    });
    console.log(`Project ${orderId} updated — escrowStatus: funded, status: in_progress.`);
  } catch (err) {
    console.error(`Firestore update failed for project ${orderId}:`, err.message);
    return respond(500, { error: 'Failed to update project status.' });
  }

  /* ── 12. Fetch freelancer and buyer details ── */
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

  /* ── 13. Notify the freelancer: payment received (push + email always) ── */
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
        amount:       confirmedAmount
          ? new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount)
          : 'the agreed amount',
        dashboardUrl: projectUrl,
      },
    });
  } else {
    console.warn(`No freelancer uid or email found for project ${orderId}. Notification not sent.`);
  }

  console.log(`Flutterwave charge.completed handled successfully for project ${orderId}.`);
  return respond(200, { received: true });
};

/* ══════════════════════════════════════════════════════════════
   AFFILIATE COMMISSION CREDITING
   Called from the product-order path after the order is marked paid.
   Mirrors the same logic in stripe-webhook.js.
   Always non-fatal — never blocks order delivery.
══════════════════════════════════════════════════════════════ */
async function creditAffiliateCommission({ db, order, orderId, sellerAmount, confirmedAmount, confirmedCurrency, gateway }) {
  const affiliateRef = order.affiliateRef || null;

  if (!affiliateRef) {
    return { finalSellerAmount: sellerAmount };
  }

  try {
    const affiliateUserSnap = await db.collection('users').doc(affiliateRef).get();
    if (!affiliateUserSnap.exists) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" not found — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    const affiliateUser = affiliateUserSnap.data();
    if (affiliateUser.affiliateEnabled !== true) {
      console.warn(`[affiliate] Referring user "${affiliateRef}" has not opted in — skipping commission for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (affiliateRef === order.sellerUid) {
      console.warn(`[affiliate] Self-referral detected for order ${orderId}. Skipping.`);
      return { finalSellerAmount: sellerAmount };
    }

    let commissionPercent = 0;
    try {
      const productSnap = await db.collection('products').doc(order.productId).get();
      if (productSnap.exists) {
        const productData = productSnap.data();
        if (productData.affiliateEnabled !== true) {
          console.log(`[affiliate] Product "${order.productId}" does not have affiliateEnabled — skipping for order ${orderId}.`);
          return { finalSellerAmount: sellerAmount };
        }
        commissionPercent = Number(productData.affiliateCommissionPercent) || 0;
      } else {
        console.warn(`[affiliate] Product "${order.productId}" not found — skipping for order ${orderId}.`);
        return { finalSellerAmount: sellerAmount };
      }
    } catch (err) {
      console.warn(`[affiliate] Could not read product doc: ${err.message} — skipping for order ${orderId}.`);
      return { finalSellerAmount: sellerAmount };
    }

    if (commissionPercent <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    const commissionAmount  = +(sellerAmount * (commissionPercent / 100)).toFixed(2);
    const finalSellerAmount = +(sellerAmount - commissionAmount).toFixed(2);

    if (commissionAmount <= 0) {
      return { finalSellerAmount: sellerAmount };
    }

    await db.collection('users').doc(affiliateRef).update({
      affiliateBalance:     FieldValue.increment(commissionAmount),
      affiliateTotalEarned: FieldValue.increment(commissionAmount),
      updatedAt:            FieldValue.serverTimestamp(),
    });

    await db.collection('affiliate-earnings').add({
      affiliateUid:       affiliateRef,
      sellerUid:          order.sellerUid  || null,
      buyerUid:           order.buyerUid   || null,
      orderId,
      productId:          order.productId  || null,
      commissionPercent,
      commissionAmount,
      currency:           confirmedCurrency,
      confirmedAmount,
      gateway,
      status:             'pending',
      createdAt:          FieldValue.serverTimestamp(),
    });

    await db.collection('product-orders').doc(orderId).update({
      affiliateCommissionPaid:    true,
      affiliateCommissionAmount:  commissionAmount,
      affiliateCommissionPercent: commissionPercent,
      sellerAmount:               finalSellerAmount,
    });

    console.log(`[affiliate] Commission credited — order: ${orderId}, affiliate: ${affiliateRef}, amount: ${commissionAmount} ${confirmedCurrency} (${commissionPercent}%), finalSellerAmount: ${finalSellerAmount}`);

    return { finalSellerAmount };

  } catch (err) {
    console.error(`[affiliate] Commission crediting failed for order ${orderId}:`, err.message);
    return { finalSellerAmount: sellerAmount };
  }
}

/* ══════════════════════════════════════════════════════════════
   PRO UPGRADE HANDLER
   Activates a Pro subscription when payment_purpose === 'pro_upgrade'.
══════════════════════════════════════════════════════════════ */
async function handleProUpgrade({ db, uid, billingPeriod, subscriptionId, gateway, amount, customerEmail }) {
  if (!uid) {
    console.error('[pro_upgrade] Missing uid in metadata — cannot activate Pro.');
    return;
  }

  const now       = new Date();
  const daysToAdd = billingPeriod === 'annual' ? 365 : 30;
  const endDate   = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

  try {
    await db.collection('users').doc(uid).update({
      plan:             'pro',
      premiumStatus:    'active',
      planStatus:       'active',
      premiumStartDate: now,
      premiumEndDate:   endDate,
      updatedAt:        FieldValue.serverTimestamp(),
    });

    if (subscriptionId) {
      await db.collection('subscriptions').doc(subscriptionId).update({
        status:         'active',
        activatedAt:    now,
        premiumEndDate: endDate,
      }).catch(() => {});
    }

    console.log(`[pro_upgrade] uid: ${uid} activated Pro via ${gateway} — expires ${endDate.toISOString()}`);

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

/* ══════════════════════════════════════════════════════════════
   INVOICE-ORDER PAID HANDLER
   Called when a Flutterwave payment for an invoice-order completes.
   1. Idempotency guard
   2. Calculate platform fee and seller amount
   3. Mark invoice-order as paid
   4. Mark the parent invoice doc as paid
   5. Notify the freelancer (push + email)
══════════════════════════════════════════════════════════════ */
async function handleInvoiceOrderPaid({ db, orderId, invOrderRef, invOrderSnap, confirmedAmount, confirmedCurrency, sessionId, paymentMethod, flwRef }) {
  const invOrder = invOrderSnap.data();

  if (invOrder.paymentStatus === 'paid') {
    console.log(`Invoice order ${orderId} already paid. Skipping duplicate webhook.`);
    return;
  }

  let invSettings;
  try {
    invSettings = await getSettings(db);
  } catch (err) {
    console.warn('[invoice-webhook] Could not fetch settings, using defaults:', err.message);
    invSettings = { platformFeePercent: 2.5 };
  }

  const platformFee  = +(confirmedAmount * (invSettings.platformFeePercent / 100)).toFixed(2);
  const sellerAmount = +(confirmedAmount - platformFee).toFixed(2);

  const orderUpdate = {
    paymentStatus:          'paid',
    paymentMethod,
    amount:                 confirmedAmount,
    currency:               confirmedCurrency,
    amountUsd:              confirmedCurrency === 'USD' ? confirmedAmount : null,
    platformFee,
    sellerAmount,
    paymentConfirmedAt:     FieldValue.serverTimestamp(),
    updatedAt:              FieldValue.serverTimestamp(),
  };
  if (sessionId) orderUpdate.stripeSessionId        = sessionId;
  if (flwRef)    orderUpdate.flutterwaveReference   = flwRef;

  try {
    await invOrderRef.update(orderUpdate);
    console.log(`Invoice order ${orderId} marked as paid. Amount: ${confirmedAmount} ${confirmedCurrency}, sellerAmount: ${sellerAmount}`);
  } catch (err) {
    console.error(`Firestore update failed for invoice-order ${orderId}:`, err.message);
    return;
  }

  const invoiceId = invOrder.invoiceId || null;
  const sellerUid = invOrder.sellerUid || null;

  if (invoiceId) {
    try {
      await db.collection('invoices').doc(invoiceId).update({
        status:    'paid',
        paidAt:    FieldValue.serverTimestamp(),
        paidOrder: orderId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`Invoice ${invoiceId} marked as paid.`);
    } catch (err) {
      console.error(`Could not mark invoice ${invoiceId} as paid:`, err.message);
    }
  }

  if (!sellerUid) {
    console.warn(`No sellerUid on invoice-order ${orderId} — skipping notification.`);
    return;
  }

  let freelancerEmail = null;
  let freelancerName  = 'Freelancer';
  try {
    const userSnap = await db.collection('users').doc(sellerUid).get();
    if (userSnap.exists) {
      freelancerEmail = userSnap.data().email || null;
      freelancerName  = userSnap.data().name || userSnap.data().displayName || 'Freelancer';
    }
  } catch (err) {
    console.warn('[invoice-webhook] Could not fetch freelancer details:', err.message);
  }

  const platformUrl   = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const invoiceAmount = new Intl.NumberFormat('en', { style: 'currency', currency: confirmedCurrency }).format(confirmedAmount);
  const clientName    = invOrder.clientName || invOrder.payerName || 'A client';

  let invoiceNumber = '';
  if (invoiceId) {
    try {
      const invSnap = await db.collection('invoices').doc(invoiceId).get();
      if (invSnap.exists) invoiceNumber = invSnap.data().invoiceNumber || '';
    } catch (_) {}
  }

  await callFunction('send-smart-notification', {
    userUid:    sellerUid,
    to:         freelancerEmail || null,
    title:      'Invoice Paid',
    body:       `${clientName} has paid your invoice for ${invoiceAmount}.`,
    url:        `${platformUrl}/dashboard-invoices.html`,
    templateId: 'invoice-paid',
    emailMode:  'always',
    data: {
      name:          freelancerName,
      clientName,
      amount:        invoiceAmount,
      invoiceNumber,
      dashboardUrl:  `${platformUrl}/dashboard-invoices.html`,
    },
  });

  console.log(`Invoice order ${orderId} handled successfully — freelancer ${sellerUid} notified.`);
}

/* ── Utility: build a Netlify function response ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
