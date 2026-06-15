/**
 * create-bank-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer FIAT (bank) withdrawal requests.
 * Mirrors create-payout.js (crypto) but settles to a bank account instead
 * of a crypto wallet.
 *
 * Flow:
 *  1. Validate & parse request body
 *  2. Verify Paystack and/or Stripe is enabled in config/platform
 *  3. Verify user exists, is a freelancer, KYC verified, sufficient balance
 *  4. Create a /payouts document (type: 'bank', status: 'pending')
 *  5. If Paystack is enabled and a matching bank code is found:
 *       - Create a Paystack transfer recipient
 *       - Initiate a Paystack transfer (automated)
 *     Otherwise:
 *       - Mark the payout as 'pending_review' for manual processing by the
 *         Kreddlo team (covers Stripe / international wires not yet
 *         automated, and any Paystack lookup failure)
 *  6. Deduct amount from user's availableBalance + increment totalWithdrawn
 *  7. Send a withdrawal confirmation notification
 *  8. Return payout ID + status to the client
 *
 * Environment variables required (set in Netlify dashboard):
 *   PAYSTACK_SECRET_KEY       — Paystack secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — e.g. https://kreddlo.com
 */

const { getSettings } = require('./get-settings');

/* ─────────────────────────────────────────────
   FIREBASE ADMIN (loaded lazily so cold starts
   don't fail if env var is missing in preview)
───────────────────────────────────────────── */
let _db = null;

function getDb() {
  if (_db) return _db;

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  _db = admin.firestore();
  return _db;
}

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

/** Format a number as USD string */
function usd(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Mask an account number for display in emails/logs */
function maskAccount(num) {
  if (!num) return '';
  const s = String(num);
  if (s.length <= 4) return s;
  return '••••' + s.slice(-4);
}

const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Look up a Paystack bank_code matching the freeform bank name the
 * freelancer typed in. Returns null if no confident match is found.
 */
async function findPaystackBankCode(paystackKey, bankName) {
  if (!bankName) return null;

  const res = await fetch(`${PAYSTACK_BASE}/bank?currency=NGN`, {
    headers: { Authorization: `Bearer ${paystackKey}` },
  });

  if (!res.ok) {
    throw new Error(`Paystack bank lookup returned status ${res.status}`);
  }

  const data = await res.json();
  if (!data.status || !Array.isArray(data.data)) return null;

  const needle = bankName.trim().toLowerCase();

  // Exact match first, then "contains" match as a fallback
  let match = data.data.find(b => (b.name || '').toLowerCase() === needle);
  if (!match) {
    match = data.data.find(b =>
      (b.name || '').toLowerCase().includes(needle) ||
      needle.includes((b.name || '').toLowerCase())
    );
  }

  return match ? match.code : null;
}

/**
 * Create a Paystack transfer recipient (NUBAN) and return the recipient_code.
 */
async function createPaystackRecipient(paystackKey, { accountName, accountNumber, bankCode }) {
  const res = await fetch(`${PAYSTACK_BASE}/transferrecipient`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paystackKey}`,
    },
    body: JSON.stringify({
      type: 'nuban',
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.status) {
    throw new Error(data.message || `Paystack recipient creation failed (status ${res.status})`);
  }

  return data.data.recipient_code;
}

/**
 * Initiate a Paystack transfer to a recipient. Amount is in the smallest
 * currency unit (kobo for NGN), so multiply naira amount by 100.
 */
async function initiatePaystackTransfer(paystackKey, { amountNaira, recipientCode, reason, reference }) {
  const res = await fetch(`${PAYSTACK_BASE}/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paystackKey}`,
    },
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(amountNaira * 100),
      recipient: recipientCode,
      reason: reason || 'Kreddlo withdrawal',
      reference,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.status) {
    throw new Error(data.message || `Paystack transfer failed (status ${res.status})`);
  }

  return {
    transferCode: data.data.transfer_code || null,
    paystackStatus: data.data.status || 'pending',
  };
}

/* ─────────────────────────────────────────────
   MAIN HANDLER
───────────────────────────────────────────── */
exports.handler = async function (event) {
  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  /* ── Only allow POST ── */
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const {
    uid,
    amount,          // USD amount the freelancer entered
    accountName,
    accountNumber,
    bankName,
    swift,           // SWIFT / IBAN — required for international transfers
    country,
    saveDetails,     // boolean — save bank details for future withdrawals
    fees,            // { platformFee }
  } = payload;

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID.' }) };
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Minimum withdrawal amount is $10.00.' }) };
  }
  if (!accountName || !accountName.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Account holder name is required.' }) };
  }
  if (!accountNumber || !accountNumber.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bank account number is required.' }) };
  }
  if (!bankName || !bankName.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bank name is required.' }) };
  }
  if (!country || !country.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Country is required.' }) };
  }

  const amtUsd = Number(amount);

  try {
    const db       = getDb();
    const settings = await getSettings(db);

    /* ── Fiat payouts must be enabled by an admin ── */
    if (!settings.paystackEnabled && !settings.stripeEnabled) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Bank withdrawals are not currently enabled.' }) };
    }

    /* ────────────────────────────────────────
       STEP 1 — Verify user + sufficient balance
    ──────────────────────────────────────── */
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    }

    const userData = userSnap.data();

    if (userData.role !== 'freelancer') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only freelancers can withdraw funds.' }) };
    }

    if (userData.kycStatus !== 'verified') {
      return { statusCode: 403, body: JSON.stringify({ error: 'KYC verification required before withdrawing.' }) };
    }

    const availableBalance = Number(userData.availableBalance || 0);

    if (availableBalance < amtUsd) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Insufficient balance. Available: ${usd(availableBalance)}, Requested: ${usd(amtUsd)}.`,
        }),
      };
    }

    /* ────────────────────────────────────────
       STEP 2 — Create payout document (status: pending)
    ──────────────────────────────────────── */
    const platformFee = Number(fees?.platformFee || 0);

    const bankDetails = {
      accountName:   accountName.trim(),
      accountNumber: accountNumber.trim(),
      bankName:      bankName.trim(),
      swift:         (swift || '').trim(),
      country:       country.trim(),
    };

    const payoutData = {
      userUid:    uid,
      userName:   userData.name  || '',
      userEmail:  userData.email || '',
      amount:     amtUsd,
      type:       'bank',
      method:     null,           // set below: 'paystack' or 'manual'
      bankDetails,
      fees: {
        platformFee,
      },
      status:     'pending',
      createdAt:  new Date(),
      updatedAt:  new Date(),
    };

    const payoutRef = await db.collection('payouts').add(payoutData);
    const payoutId  = payoutRef.id;

    /* ────────────────────────────────────────
       STEP 3 — Attempt automated Paystack transfer
       (NGN NUBAN accounts only). Anything else
       (Stripe, international wires, lookup
       failures) is queued for manual processing.
    ──────────────────────────────────────── */
    let method        = 'manual';
    let payoutStatus  = 'pending_review';
    let transferCode  = null;
    let resultMessage = `Bank transfer request of ${usd(amtUsd)} received. Our team will process this within 1-3 business days.`;

    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    if (settings.paystackEnabled && paystackKey) {
      try {
        const bankCode = await findPaystackBankCode(paystackKey, bankDetails.bankName);

        if (bankCode) {
          const recipientCode = await createPaystackRecipient(paystackKey, {
            accountName:   bankDetails.accountName,
            accountNumber: bankDetails.accountNumber,
            bankCode,
          });

          const transferResult = await initiatePaystackTransfer(paystackKey, {
            amountNaira:   amtUsd, // platform fee already deducted client-side, amtUsd is final payout amount
            recipientCode,
            reason:        `Kreddlo withdrawal ${payoutId}`,
            reference:     `kreddlo-${uid}-${payoutId}`,
          });

          method        = 'paystack';
          payoutStatus  = 'sent';
          transferCode  = transferResult.transferCode;
          resultMessage = `Withdrawal of ${usd(amtUsd)} sent to your bank account.`;
        }
      } catch (paystackErr) {
        console.error('[create-bank-payout] Paystack transfer failed, falling back to manual review:', paystackErr.message);
        // Falls through to manual review — payout is still recorded and balance deducted.
      }
    }

    await payoutRef.update({
      method,
      status:       payoutStatus,
      transferCode: transferCode || null,
      updatedAt:    new Date(),
    });

    /* ────────────────────────────────────────
       STEP 4 — Deduct from user availableBalance
                and increment totalWithdrawn
    ──────────────────────────────────────── */
    const newBalance     = Math.max(0, availableBalance - amtUsd);
    const totalWithdrawn = Number(userData.totalWithdrawn || 0) + amtUsd;

    const userUpdate = {
      availableBalance: newBalance,
      totalWithdrawn,
      updatedAt: new Date(),
    };

    if (saveDetails) {
      userUpdate.bankDetails = bankDetails;
    }

    await userRef.update(userUpdate);

    /* ────────────────────────────────────────
       STEP 5 — Send withdrawal confirmation notification
    ──────────────────────────────────────── */
    try {
      const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Bank Withdrawal Initiated',
          body:       method === 'paystack'
            ? `Your withdrawal of ${usd(amtUsd)} has been sent to your bank account.`
            : `Your withdrawal of ${usd(amtUsd)} has been received and is being processed by our team.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'bank-withdrawal-initiated',
          emailMode:  'always',
          data: {
            name:          userData.name || 'Freelancer',
            amount:        usd(amtUsd),
            bankName:      bankDetails.bankName,
            accountNumber: maskAccount(bankDetails.accountNumber),
            payoutId,
            newBalance:    usd(newBalance),
            date:          new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
          },
        }),
      }).catch(err => {
        console.error('[create-bank-payout] send-smart-notification failed:', err.message);
      });
    } catch (notifyErr) {
      console.error('[create-bank-payout] Notification block error:', notifyErr.message);
    }

    /* ────────────────────────────────────────
       STEP 6 — Return success response
    ──────────────────────────────────────── */
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success:    true,
        payoutId,
        status:     payoutStatus,
        method,
        newBalance,
        message:    resultMessage,
      }),
    };

  } catch (err) {
    console.error('[create-bank-payout] Unhandled error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
