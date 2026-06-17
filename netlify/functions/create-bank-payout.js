/**
 * create-bank-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer FIAT (bank) withdrawal requests.
 * Supports multi-currency balances (NGN, USD, GBP, EUR, GHS, KES, ZAR, etc.)
 *
 * Flow:
 *  1. Validate & parse request body (now includes withdrawalCurrency)
 *  2. Verify Paystack and/or Stripe is enabled in config/platform
 *  3. Verify user exists, is a freelancer, KYC verified, sufficient balance
 *     in the requested currency (reads from user.balances map)
 *  4. Create a /payouts document (type: 'bank', status: 'pending')
 *  5. If Paystack is enabled and currency is Paystack-supported:
 *       - Create a Paystack transfer recipient
 *       - Initiate a Paystack transfer (automated)
 *     If international currency (USD, EUR, GBP, etc.):
 *       - Mark as 'pending_manual' — requires manual Stripe Connect / wire
 *     On any Paystack lookup failure:
 *       - Mark as 'pending_review' for manual processing
 *  6. Deduct amount from user's balances.{currency} + increment totalWithdrawn
 *  7. Send a withdrawal confirmation notification
 *  8. Return payout ID + status to the client
 *
 * Environment variables required (set in Netlify dashboard):
 *   PAYSTACK_SECRET_KEY       — Paystack secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — e.g. https://kreddlo.com
 */

const { getSettings }    = require('./get-settings');
const { verifyCaller }   = require('./_verify-auth');

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

/**
 * Format a number in a given currency using Intl.NumberFormat.
 * Falls back to USD formatting if currency is invalid.
 */
function formatCurrency(amount, currency) {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(Number(amount || 0));
  } catch {
    return '$' + Number(amount || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
}

/** Mask an account number for display in emails/logs */
function maskAccount(num) {
  if (!num) return '';
  const s = String(num);
  if (s.length <= 4) return s;
  return '••••' + s.slice(-4);
}

/**
 * Currencies Paystack can natively transfer to bank accounts.
 * Everything else is routed as pending_manual.
 */
const PAYSTACK_TRANSFER_CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES'];

const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Look up a Paystack bank_code matching the freeform bank name the
 * freelancer typed in. Uses currency to filter bank list.
 * Returns null if no confident match is found.
 */
async function findPaystackBankCode(paystackKey, bankName, currency) {
  if (!bankName) return null;

  const curr = (currency || 'NGN').toUpperCase();
  const res = await fetch(`${PAYSTACK_BASE}/bank?currency=${curr}`, {
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
 * Create a Paystack transfer recipient and return the recipient_code.
 * Uses the provided currency (NUBAN for NGN, equivalent for GHS/ZAR/KES).
 */
async function createPaystackRecipient(paystackKey, { accountName, accountNumber, bankCode, currency }) {
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
      currency: (currency || 'NGN').toUpperCase(),
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
 * currency unit (kobo for NGN, pesewas for GHS, etc.), so multiply by 100.
 */
async function initiatePaystackTransfer(paystackKey, { amountLocal, recipientCode, reason, reference }) {
  const res = await fetch(`${PAYSTACK_BASE}/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paystackKey}`,
    },
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(amountLocal * 100),
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

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const {
    uid: _bodyUid,  // ignored — we use the verified caller uid
    amount,               // amount in the withdrawal currency
    withdrawalCurrency,   // currency to withdraw (NGN, USD, GBP, etc.)
    accountName,
    accountNumber,
    bankName,
    swift,                // SWIFT / IBAN — required for international transfers
    country,
    saveDetails,          // boolean — save bank details for future withdrawals
    fees,                 // { platformFee }
  } = payload;

  // Always use the token-verified uid, not the client-supplied one
  const uid = callerUid;

  /* ── Normalise currency ── */
  const currency = (withdrawalCurrency || 'USD').toUpperCase().trim();

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID.' }) };
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid withdrawal amount.' }) };
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

  const amountLocal = Number(amount);

  try {
    const db       = getDb();
    const settings = await getSettings(db);
    const FieldValue = require('firebase-admin').firestore.FieldValue;

    /* ── Fiat payouts must be enabled by an admin ── */
    if (!settings.paystackEnabled && !settings.stripeEnabled) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Bank withdrawals are not currently enabled.' }) };
    }

    /* ────────────────────────────────────────
       STEP 1 — Pre-flight: verify user exists, role, KYC
       (outside transaction — read-only, fail fast)
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

    /* ── Quick pre-flight balance check (non-transactional — re-checked inside tx below) ── */
    const preflightBalances = userData.balances || {};
    if (!Object.keys(preflightBalances).length && userData.availableBalance) {
      preflightBalances['USD'] = Number(userData.availableBalance || 0);
    }
    if (Number(preflightBalances[currency] || 0) < amountLocal) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Insufficient ${currency} balance. Available: ${formatCurrency(Number(preflightBalances[currency] || 0), currency)}, Requested: ${formatCurrency(amountLocal, currency)}.`,
        }),
      };
    }

    /* ────────────────────────────────────────
       STEP 1b — Server-side fee validation
       Load expected platform fee rate from Firestore config,
       apply Pro rate if applicable, reject if client fee is manipulated.
    ──────────────────────────────────────── */
    let expectedFeePct = 1.5; // safe default
    {
      try {
        const cfgSnap = await db.collection('config').doc('platform').get();
        if (cfgSnap.exists) {
          const cfgData = cfgSnap.data();
          if (typeof cfgData.withdrawalFeePercent === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercent;
          }
          // Pro users get a reduced fee rate
          const isPro = userData.plan === 'pro' && userData.premiumStatus === 'active';
          if (isPro && typeof cfgData.withdrawalFeePercentPro === 'number') {
            expectedFeePct = cfgData.withdrawalFeePercentPro;
          }
        }
      } catch (cfgErr) {
        console.warn('[create-bank-payout] Could not load fee config, using default:', cfgErr.message);
      }

      const expectedPlatformFee = amountLocal * (expectedFeePct / 100);
      const clientPlatformFee   = Number(fees?.platformFee || 0);

      if (clientPlatformFee < expectedPlatformFee * 0.95) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid fee calculation. Please refresh and try again.' }),
        };
      }
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
      amount:     amountLocal,
      currency,
      type:       'bank',
      method:     null,       // set below: 'paystack', 'pending_manual', or 'manual'
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
       STEP 3 — Route to Paystack or mark for manual processing

       Paystack supports automated transfers for: NGN, GHS, ZAR, KES.
       All international currencies (USD, EUR, GBP, etc.) are flagged
       as pending_manual for Stripe Connect / wire processing.
    ──────────────────────────────────────── */
    let method        = 'manual';
    let payoutStatus  = 'pending_review';
    let transferCode  = null;
    let resultMessage = `Bank transfer request of ${formatCurrency(amountLocal, currency)} received. Our team will process this within 1-3 business days.`;

    const isPaystackCurrency = PAYSTACK_TRANSFER_CURRENCIES.includes(currency);
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    if (!isPaystackCurrency) {
      /* ── International currency — queue for manual Stripe/wire processing ── */
      method       = 'pending_manual';
      payoutStatus = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} received. International bank transfers are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] ${currency} withdrawal for ${uid} — queued as pending_manual (international bank transfer).`);

    } else if (settings.paystackEnabled && paystackKey) {
      /* ── Attempt automated Paystack transfer for supported currencies ── */
      try {
        const bankCode = await findPaystackBankCode(paystackKey, bankDetails.bankName, currency);

        if (bankCode) {
          const recipientCode = await createPaystackRecipient(paystackKey, {
            accountName:   bankDetails.accountName,
            accountNumber: bankDetails.accountNumber,
            bankCode,
            currency,
          });

          const transferResult = await initiatePaystackTransfer(paystackKey, {
            amountLocal,
            recipientCode,
            reason:    `Kreddlo withdrawal ${payoutId}`,
            reference: `kreddlo-${uid}-${payoutId}`,
          });

          method        = 'paystack';
          payoutStatus  = 'sent';
          transferCode  = transferResult.transferCode;
          resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} sent to your bank account.`;
        }
      } catch (paystackErr) {
        console.error('[create-bank-payout] Paystack transfer failed, falling back to manual review:', paystackErr.message);
        // Falls through — payout is still recorded, balance still deducted, team handles manually.
      }
    }

    await payoutRef.update({
      method,
      status:       payoutStatus,
      transferCode: transferCode || null,
      // For international currencies, add a note for the team
      ...(method === 'pending_manual' ? {
        note: 'International bank transfer — requires manual processing via Stripe Connect or wire.',
      } : {}),
      updatedAt: new Date(),
    });

    /* ────────────────────────────────────────
       FIX #1 — Atomic balance reservation via Firestore transaction
       Re-reads balance inside transaction to prevent race conditions.
    ──────────────────────────────────────── */
    let newCurrencyBalance;
    try {
      await db.runTransaction(async (tx) => {
        const freshSnap    = await tx.get(userRef);
        const freshData    = freshSnap.data();
        const freshBalances = freshData.balances || {};
        if (!Object.keys(freshBalances).length && freshData.availableBalance) {
          freshBalances['USD'] = Number(freshData.availableBalance || 0);
        }
        const currencyBalance = Number(freshBalances[currency] || 0);

        if (currencyBalance < amountLocal) {
          const err = new Error(
            `Insufficient ${currency} balance. Available: ${formatCurrency(currencyBalance, currency)}, Requested: ${formatCurrency(amountLocal, currency)}.`
          );
          err.statusCode = 400;
          throw err;
        }

        newCurrencyBalance = Math.max(0, currencyBalance - amountLocal);

        const txUpdate = {
          [`balances.${currency}`]: FieldValue.increment(-amountLocal),
          totalWithdrawn:           FieldValue.increment(amountLocal),
          updatedAt:                new Date(),
        };
        if (currency === 'USD') {
          txUpdate.availableBalance = Math.max(0, Number(freshData.availableBalance || 0) - amountLocal);
        }
        if (saveDetails) {
          txUpdate.bankDetails = bankDetails;
        }
        tx.update(userRef, txUpdate);
      });
    } catch (txErr) {
      await payoutRef.update({ status: 'failed', errorMsg: txErr.message, updatedAt: new Date() });
      const sc = txErr.statusCode || 500;
      return { statusCode: sc, body: JSON.stringify({ error: txErr.message }) };
    }

    /* ────────────────────────────────────────
       STEP 5 — Send withdrawal confirmation notification
    ──────────────────────────────────────── */
    try {
      const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
      const formattedAmount = formatCurrency(amountLocal, currency);

      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Bank Withdrawal Initiated',
          body:       method === 'paystack'
            ? `Your withdrawal of ${formattedAmount} has been sent to your bank account.`
            : `Your withdrawal of ${formattedAmount} has been received and is being processed by our team.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'bank-withdrawal-initiated',
          emailMode:  'always',
          data: {
            name:          userData.name || 'Freelancer',
            amount:        formattedAmount,
            currency,
            bankName:      bankDetails.bankName,
            accountNumber: maskAccount(bankDetails.accountNumber),
            payoutId,
            newBalance:    formatCurrency(newCurrencyBalance, currency),
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
        success:            true,
        payoutId,
        status:             payoutStatus,
        method,
        currency,
        newCurrencyBalance,
        message:            resultMessage,
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
