/**
 * affiliate-withdraw.js — Kreddlo Netlify Function
 *
 * Handles affiliate balance withdrawal requests.
 *
 * Flow:
 *  1. Authenticate caller via Firebase ID token
 *  2. Validate amount against available affiliateBalance
 *  3. Verify user has affiliateEnabled: true
 *  4. Read platform settings for affiliateWithdrawFeePercent
 *  5. Deduct fee, compute net amount
 *  6. Write record to affiliate-payouts collection with status: pending
 *  7. Atomically deduct gross amount from user's affiliateBalance in Firestore
 *  8. Increment affiliateTotalPaid
 *  9. Trigger NOWPayments payout (same flow as create-payout.js)
 * 10. Return { payoutId, grossAmount, feeAmount, netAmount }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON
 *   NOWPAYMENTS_API_KEY       — NOWPayments API key
 */

const https = require('https');

/* ─── Firebase Admin ────────────────────────────────────────────────────────── */
let _db   = null;
let _auth = null;

function getAdmin() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  if (!_db)   _db   = admin.firestore();
  if (!_auth) _auth = admin.auth();
  return { db: _db, auth: _auth, FieldValue: admin.firestore.FieldValue };
}

/* ─── Settings ───────────────────────────────────────────────────────────────── */
const DEFAULTS = {
  affiliateWithdrawFeePercent: 2.0,
  minAffiliateWithdrawalUsd:   5,
  platformCurrency:            'USD',
};

async function getSettings(db) {
  try {
    const snap = await db.collection('config').doc('platform').get();
    return snap.exists ? { ...DEFAULTS, ...snap.data() } : { ...DEFAULTS };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

/* ─── NOWPayments payout ─────────────────────────────────────────────────────── */
function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const opts = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendNowPaymentsPayout(walletAddress, amount, currency, payoutId) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    console.warn('[affiliate-withdraw] NOWPAYMENTS_API_KEY not set — skipping payout call in dev mode');
    return { id: 'dev-mock-' + payoutId };
  }

  // Convert currency to NOWPayments coin ticker (same logic as create-payout.js)
  const coinMap = {
    BTC: 'btc', ETH: 'eth', USDT: 'usdttrc20', USDC: 'usdcerc20',
    BNB: 'bnb', SOL: 'sol', TRX: 'trx', XRP: 'xrp', LTC: 'ltc',
  };
  const coin = coinMap[currency] || 'usdttrc20';

  const res = await httpsPost(
    'api.nowpayments.io',
    '/v1/payout',
    {
      ipn_callback_url: process.env.URL + '/.netlify/functions/nowpayments-webhook',
      withdrawals: [{
        address:  walletAddress,
        currency: coin,
        amount:   amount,
        ipn_callback_url: process.env.URL + '/.netlify/functions/nowpayments-webhook',
        extra_id: payoutId,
      }],
    },
    { 'x-api-key': apiKey }
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error('NOWPayments payout failed: ' + JSON.stringify(res.body));
  }
  return res.body;
}

/* ─── Handler ────────────────────────────────────────────────────────────────── */
exports.handler = async function(event) {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // 1. Auth
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const idToken    = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!idToken) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const { db, auth, FieldValue } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }

    const uid = decoded.uid;

    // 2. Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const requestedAmount = parseFloat(body.amount) || 0;

    // 3. Fetch settings
    const settings = await getSettings(db);
    const feePct   = Number(settings.affiliateWithdrawFeePercent) || 2;
    const minWd    = Number(settings.minAffiliateWithdrawalUsd)   || 5;
    const cur      = settings.platformCurrency || 'USD';

    if (requestedAmount < minWd) {
      return {
        statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'Minimum withdrawal is ' + cur + ' ' + minWd.toFixed(2) }),
      };
    }

    // 4. Fetch user doc
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'User not found' }) };
    }

    const userData = userSnap.data();

    // 5. Gate: affiliateEnabled
    if (userData.affiliateEnabled !== true) {
      return {
        statusCode: 403, headers: CORS,
        body: JSON.stringify({ error: 'Affiliate program not enabled for this account' }),
      };
    }

    // 5b. Gate: payoutsFrozen
    if (userData.payoutsFrozen === true) {
      return {
        statusCode: 403, headers: CORS,
        body: JSON.stringify({ error: 'Withdrawals temporarily paused by platform. Please contact support for assistance.' }),
      };
    }

    // 6. Check balance
    const available = Number(userData.affiliateBalance) || 0;
    if (requestedAmount > available) {
      return {
        statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'Insufficient affiliate balance. Available: ' + cur + ' ' + available.toFixed(2) }),
      };
    }

    // 7. Check wallet / bank details based on method
    const method = body.method || 'crypto';

    let walletAddress = null;
    let bankPayload   = null;

    if (method === 'bank') {
      const bankCode      = body.bankCode      || null;
      const accountNumber = body.accountNumber || null;
      const accountName   = body.accountName   || null;
      if (!bankCode || !accountNumber || !accountName) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'Bank details incomplete. Please provide bank, account number, and account name.' }),
        };
      }
      bankPayload = { bankCode, accountNumber, accountName, bankName: body.bankName || '' };
    } else {
      walletAddress = userData.walletAddress || null;
      if (!walletAddress) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'No withdrawal wallet set. Add one in Settings.' }),
        };
      }
    }

    // 8. Calculate amounts
    const grossAmount = parseFloat(requestedAmount.toFixed(2));
    const feeAmount   = parseFloat((grossAmount * feePct / 100).toFixed(2));
    const netAmount   = parseFloat((grossAmount - feeAmount).toFixed(2));

    // Determine paymentMethod bucket for this withdrawal
    const earningsBucket = (method === 'bank') ? 'fiat' : 'crypto';

    // 9. Create payout record in Firestore first (pending)
    const payoutRef = await db.collection('affiliate-payouts').add({
      uid,
      grossAmount,
      feeAmount,
      netAmount,
      feePct,
      currency:      cur,
      method,
      paymentMethod: earningsBucket,
      walletAddress: walletAddress || null,
      bankCode:      bankPayload ? bankPayload.bankCode      : null,
      bankName:      bankPayload ? bankPayload.bankName      : null,
      accountNumber: bankPayload ? bankPayload.accountNumber : null,
      accountName:   bankPayload ? bankPayload.accountName   : null,
      status:        'pending',
      createdAt:     new Date(),
    });
    const payoutId = payoutRef.id;

    // 10. Atomically deduct from affiliateBalance + increment affiliateTotalPaid
    await userRef.update({
      affiliateBalance:    FieldValue.increment(-grossAmount),
      affiliateTotalPaid:  FieldValue.increment(grossAmount),
    });

    // 11. Mark pending earnings in the matching bucket as paid (best-effort, non-fatal)
    // Only crypto earnings are marked when withdrawing via crypto; only fiat earnings
    // when withdrawing via bank — so funds never get mixed across buckets.
    try {
      const pendingQ    = db.collection('affiliate-earnings')
        .where('affiliateUid',  '==', uid)
        .where('status',        '==', 'pending')
        .where('paymentMethod', '==', earningsBucket)
        .limit(200);
      const pendingSnap = await pendingQ.get();
      const batch       = db.batch();
      pendingSnap.forEach(function(d) {
        batch.update(d.ref, { status: 'paid', paidAt: new Date(), payoutId });
      });
      await batch.commit();
    } catch (batchErr) {
      console.warn('[affiliate-withdraw] Could not mark earnings as paid:', batchErr.message);
    }

    // 12. Trigger payout via appropriate provider
    let nowPaymentsId = null;
    let flutterwaveId = null;
    try {
      if (method === 'bank' && bankPayload) {
        // Flutterwave bank transfer
        const fwKey = process.env.FLW_SECRET_KEY;
        if (fwKey) {
          const fwRes = await httpsPost(
            'api.flutterwave.com',
            '/v3/transfers',
            {
              account_bank:    bankPayload.bankCode,
              account_number:  bankPayload.accountNumber,
              amount:          netAmount,
              currency:        cur,
              narration:       'Kreddlo affiliate payout ' + payoutId,
              reference:       'aff-' + payoutId,
              debit_currency:  cur,
            },
            { 'Authorization': 'Bearer ' + fwKey }
          );
          if (fwRes.status !== 200 && fwRes.status !== 201) {
            throw new Error('Flutterwave transfer failed: ' + JSON.stringify(fwRes.body));
          }
          flutterwaveId = (fwRes.body.data && fwRes.body.data.id) ? String(fwRes.body.data.id) : null;
          await payoutRef.update({ flutterwaveId, status: 'processing' });
        } else {
          console.warn('[affiliate-withdraw] FLW_SECRET_KEY not set — skipping bank payout in dev mode');
          await payoutRef.update({ status: 'processing', devMode: true });
        }
      } else {
        // NOWPayments crypto payout
        const npRes   = await sendNowPaymentsPayout(walletAddress, netAmount, cur, payoutId);
        nowPaymentsId = npRes.id || null;
        await payoutRef.update({ nowPaymentsId, status: 'processing' });
      }
    } catch (npErr) {
      console.error('[affiliate-withdraw] Payout call failed:', npErr.message);
      await payoutRef.update({ npError: npErr.message });
    }

    return {
      statusCode: 200,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok:           true,
        payoutId,
        grossAmount,
        feeAmount,
        netAmount,
        method,
        nowPaymentsId,
        flutterwaveId,
      }),
    };

  } catch (err) {
    console.error('[affiliate-withdraw] Unhandled error:', err);
    return {
      statusCode: 500,
      headers:    CORS,
      body:       JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
