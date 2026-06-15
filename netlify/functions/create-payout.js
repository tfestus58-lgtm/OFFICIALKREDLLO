/**
 * create-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer withdrawal requests.
 *
 * Flow:
 *  1. Validate & parse request body
 *  2. Verify user exists + has sufficient availableBalance in Firestore
 *  3. Call NOWPayments Mass Payout API to send chosen coin to wallet
 *  4. Write payout document to Firestore /payouts collection
 *  5. Deduct amount from user's availableBalance + increment totalWithdrawn
 *  6. Call /send-email function to send withdrawal confirmation email
 *  7. Return payout ID and NOWPayments batch ID to the client
 *
 * Environment variables required (set in Netlify dashboard):
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 *   NOWPAYMENTS_IPN_SECRET    — IPN secret (used for payout HMAC if needed)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 */

const https = require('https');

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

/** Simple HTTPS POST returning parsed JSON */
function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Truncate wallet address for display in emails */
function shortWallet(addr) {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-6);
}

/** Format a number as USD string */
function usd(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ─────────────────────────────────────────────
   NOWPAYMENTS MASS PAYOUT
   Docs: https://documenter.getpostman.com/view/7907941/2s93JqTRWN
───────────────────────────────────────────── */
async function initiateNowPaymentsPayout({
  walletAddress,
  currency,     // e.g. "USDT", "BTC", "ETH"
  coinId,       // e.g. "trc20", "btc", "eth" — maps to NOWPayments currency code
  amountCoin,   // exact coin amount to send (after all fees)
  uid,          // used as unique_external_id
  payoutDocId,  // Firestore doc ID — used as extra_id for reconciliation
}) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) throw new Error('NOWPAYMENTS_API_KEY is not set.');

  /*
   * NOWPayments accepts the currency as the coin ticker symbol in lowercase.
   * The coinId from the frontend (e.g. "trc20", "btc", "eth") maps cleanly
   * to what NOWPayments expects. We normalise to lowercase just in case.
   */
  const nowCurrency = (coinId || currency || 'usdttrc20').toLowerCase();

  const payload = {
    withdrawals: [
      {
        address:             walletAddress,
        currency:            nowCurrency,
        amount:              amountCoin,
        unique_external_id:  `kreddlo-${uid}-${Date.now()}`,
        extra_id:            payoutDocId || '',
      },
    ],
  };

  const result = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    payload,
    { 'x-api-key': apiKey },
  );

  if (result.status !== 200 && result.status !== 201) {
    const errMsg =
      (typeof result.body === 'object' && (result.body.message || result.body.error))
        || `NOWPayments returned status ${result.status}`;
    throw new Error(`NOWPayments error: ${errMsg}`);
  }

  /*
   * Response shape:
   * {
   *   id: "batch_id",
   *   withdrawals: [{ id, status, amount, currency, address, ... }]
   * }
   */
  const batchId      = result.body.id || null;
  const withdrawal   = Array.isArray(result.body.withdrawals) ? result.body.withdrawals[0] : null;
  const withdrawalId = withdrawal?.id || null;
  const nowStatus    = withdrawal?.status || 'WAITING';

  return { batchId, withdrawalId, nowStatus };
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
    amount,         // USD amount the freelancer entered
    amountCoin,     // coin amount after fees (sent to wallet)
    amountUsdt,     // equivalent USDT amount (for records)
    currency,       // coin symbol  — e.g. "USDT", "BTC", "ETH"
    coinId,         // NOWPayments currency id — e.g. "trc20", "btc"
    network,        // network label — e.g. "TRC-20", "Bitcoin"
    walletAddress,
    exchangeRate,   // USD per 1 coin unit
    usdtRate,       // USD per 1 USDT
    fees,           // { nowpaymentsFee, platformFee }
  } = payload;

  /* ── Basic input validation ── */
  if (!uid || typeof uid !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID.' }) };
  }
  if (!amount || isNaN(Number(amount)) || Number(amount) < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Minimum withdrawal amount is $10.00.' }) };
  }
  if (!walletAddress || walletAddress.trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid wallet address.' }) };
  }
  if (!currency || !coinId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing coin selection.' }) };
  }
  if (!amountCoin || Number(amountCoin) <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Coin amount must be greater than zero.' }) };
  }

  const amtUsd  = Number(amount);
  const coinAmt = Number(amountCoin);

  try {
    const db = getDb();

    /* ────────────────────────────────────────
       STEP 1 — Verify user + sufficient balance
    ──────────────────────────────────────── */
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    }

    const userData = userSnap.data();

    /* Role check */
    if (userData.role !== 'freelancer') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only freelancers can withdraw funds.' }) };
    }

    /* KYC check */
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
       We create it first so we have a doc ID to pass
       to NOWPayments as extra_id for reconciliation.
    ──────────────────────────────────────── */
    const payoutData = {
      userUid:       uid,
      userName:      userData.name        || '',
      userEmail:     userData.email       || '',
      amount:        amtUsd,
      amountCoin:    coinAmt,
      amountUsdt:    Number(amountUsdt    || 0),
      currency:      currency.toUpperCase(),
      coinId:        coinId,
      network:       network              || '',
      walletAddress: walletAddress.trim(),
      exchangeRate:  Number(exchangeRate  || 0),
      usdtRate:      Number(usdtRate      || 0),
      fees: {
        nowpaymentsFee: Number(fees?.nowpaymentsFee || 0),
        platformFee:    Number(fees?.platformFee    || 0),
      },
      status:        'pending',
      batchId:       null,
      withdrawalId:  null,
      nowStatus:     null,
      createdAt:     new Date(),
      updatedAt:     new Date(),
    };

    const payoutRef = await db.collection('payouts').add(payoutData);
    const payoutId  = payoutRef.id;

    /* ────────────────────────────────────────
       STEP 3 — Call NOWPayments Mass Payout API
    ──────────────────────────────────────── */
    let batchId, withdrawalId, nowStatus;

    try {
      ({ batchId, withdrawalId, nowStatus } = await initiateNowPaymentsPayout({
        walletAddress: walletAddress.trim(),
        currency,
        coinId,
        amountCoin:    coinAmt,
        uid,
        payoutDocId:   payoutId,
      }));
    } catch (nowErr) {
      /*
       * NOWPayments call failed — update payout doc to 'failed'
       * and return the error so the UI can surface it.
       */
      await payoutRef.update({
        status:    'failed',
        errorMsg:  nowErr.message,
        updatedAt: new Date(),
      });

      return {
        statusCode: 502,
        body: JSON.stringify({ error: nowErr.message }),
      };
    }

    /* ────────────────────────────────────────
       STEP 4 — Update payout doc to 'sent'
    ──────────────────────────────────────── */
    await payoutRef.update({
      status:       'sent',
      batchId:      batchId      || null,
      withdrawalId: withdrawalId || null,
      nowStatus:    nowStatus    || null,
      updatedAt:    new Date(),
    });

    /* ────────────────────────────────────────
       STEP 5 — Deduct from user availableBalance
                and increment totalWithdrawn
    ──────────────────────────────────────── */
    const newBalance       = Math.max(0, availableBalance - amtUsd);
    const totalWithdrawn   = Number(userData.totalWithdrawn || 0) + amtUsd;

    await userRef.update({
      availableBalance: newBalance,
      totalWithdrawn,
      updatedAt: new Date(),
    });

    /* ────────────────────────────────────────
       STEP 6 — Send withdrawal confirmation email
    ──────────────────────────────────────── */
    try {
      const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Withdrawal Initiated',
          body:       `Your withdrawal of ${usd(amtUsd)} has been processed and is on its way.`,
          url:        `${platformUrl}/dashboard-withdraw.html`,
          templateId: 'withdrawal-initiated',
          emailMode:  'always',
          data: {
            name:          userData.name || 'Freelancer',
            amount:        usd(amtUsd),
            coinAmount:    coinAmt.toFixed(coinAmt < 0.01 ? 8 : 4),
            currency:      currency.toUpperCase(),
            network:       network || '',
            walletAddress: shortWallet(walletAddress.trim()),
            payoutId,
            newBalance:    usd(newBalance),
            date:          new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
          },
        }),
      }).catch(err => {
        console.error('[create-payout] send-smart-notification failed:', err.message);
      });
    } catch (emailErr) {
      console.error('[create-payout] Notification block error:', emailErr.message);
    }

    /* ────────────────────────────────────────
       STEP 7 — Return success response
    ──────────────────────────────────────── */
    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success:      true,
        payoutId,
        batchId:      batchId      || null,
        withdrawalId: withdrawalId || null,
        nowStatus:    nowStatus    || null,
        newBalance,
        message:      `Withdrawal of ${usd(amtUsd)} initiated successfully.`,
      }),
    };

  } catch (err) {
    console.error('[create-payout] Unhandled error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
