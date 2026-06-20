/**
 * create-bank-payout.js — Kreddlo Netlify Function
 *
 * Handles freelancer FIAT (bank) withdrawal requests.
 * Supports multi-currency balances (NGN, USD, GBP, EUR, GHS, KES, ZAR, etc.)
 *
 * Flow:
 *  1. Validate & parse request body (includes withdrawalCurrency)
 *  2. Verify Flutterwave and/or Stripe is enabled in config/platform
 *  3. Verify user exists, is a freelancer, KYC verified, sufficient balance
 *     in the requested currency (reads from user.balances map)
 *  4. Create a /payouts document (type: 'bank', status: 'pending')
 *  5. If Flutterwave is enabled and currency is FLW-supported:
 *       - Look up bank code via FLW /v3/banks/:country
 *       - Initiate a Flutterwave transfer (bank details sent directly — no recipient step)
 *     If Stripe is enabled and currency is Stripe-supported (USD, EUR, GBP, etc.):
 *       - Create a Stripe bank account token with the supplied bank details
 *       - Initiate a Stripe payout/transfer to the external bank account
 *     If neither gateway supports the currency:
 *       - Mark as 'pending_manual' — requires manual wire processing
 *     On any gateway API failure:
 *       - Mark as 'pending_review' for manual processing
 *  6. Deduct amount from user's balances.{currency} + increment totalWithdrawn
 *  7. Send a withdrawal confirmation notification
 *  8. Return payout ID + status to the client
 *
 * Environment variables required (set in Netlify dashboard):
 *   FLW_SECRET_KEY            — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 *   STRIPE_SECRET_KEY         — Stripe secret key (sk_live_... or sk_test_...)
 *   FIREBASE_SERVICE_ACCOUNT  — Full Firebase service account JSON as one-line string
 *   PLATFORM_URL              — e.g. https://kreddlo.com
 */

const { getSettings }  = require('./get-settings');
const { verifyCaller } = require('./_verify-auth');

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

const FLW_BASE = 'https://api.flutterwave.com/v3';

/**
 * Currencies Flutterwave can natively transfer to bank accounts.
 * Covers Nigeria, Ghana, Kenya, Uganda, Tanzania, Rwanda, South Africa,
 * Côte d'Ivoire, Senegal, and more.
 * Everything else is routed as pending_manual.
 *
 * Docs: https://developer.flutterwave.com/docs/collecting-payments/transfers
 */
const FLW_TRANSFER_CURRENCIES = [
  'NGN', 'GHS', 'KES', 'UGX', 'TZS', 'RWF',
  'ZAR', 'XOF', 'XAF', 'MWK', 'ZMW',
];

/**
 * Currencies Stripe can natively payout to external bank accounts.
 * Covers major international currencies.
 * Docs: https://stripe.com/docs/payouts
 */
const STRIPE_TRANSFER_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF',
  'DKK', 'NOK', 'SEK', 'NZD', 'SGD', 'HKD',
];

/**
 * Maps a Stripe-supported currency to its bank account country code
 * and the fields required for Stripe bank account tokenization.
 */
const STRIPE_CURRENCY_CONFIG = {
  USD: { country: 'US', currency: 'usd', type: 'routing_account' },
  EUR: { country: 'DE', currency: 'eur', type: 'iban' },        // Generic EU
  GBP: { country: 'GB', currency: 'gbp', type: 'sort_account' },
  CAD: { country: 'CA', currency: 'cad', type: 'routing_account' },
  AUD: { country: 'AU', currency: 'aud', type: 'routing_account' },
  CHF: { country: 'CH', currency: 'chf', type: 'iban' },
  DKK: { country: 'DK', currency: 'dkk', type: 'iban' },
  NOK: { country: 'NO', currency: 'nok', type: 'iban' },
  SEK: { country: 'SE', currency: 'sek', type: 'iban' },
  NZD: { country: 'NZ', currency: 'nzd', type: 'routing_account' },
  SGD: { country: 'SG', currency: 'sgd', type: 'routing_account' },
  HKD: { country: 'HK', currency: 'hkd', type: 'routing_account' },
};

/**
 * Map a currency code to the Flutterwave country code used
 * when looking up banks via GET /v3/banks/:country
 */
const CURRENCY_TO_COUNTRY = {
  NGN: 'NG',
  GHS: 'GH',
  KES: 'KE',
  UGX: 'UG',
  TZS: 'TZ',
  RWF: 'RW',
  ZAR: 'ZA',
  XOF: 'CI',   // Côte d'Ivoire uses XOF
  XAF: 'CM',   // Cameroon uses XAF
  MWK: 'MW',
  ZMW: 'ZM',
};

/**
 * Look up a Flutterwave bank code matching the freeform bank name
 * the freelancer typed in. Uses the currency→country mapping above.
 * Returns null if no confident match is found.
 *
 * Docs: GET /v3/banks/:country
 */
async function findFlutterwaveBankCode(flwKey, bankName, currency) {
  if (!bankName) return null;

  const countryCode = CURRENCY_TO_COUNTRY[(currency || 'NGN').toUpperCase()];
  if (!countryCode) return null;

  const res = await fetch(`${FLW_BASE}/banks/${countryCode}`, {
    headers: { Authorization: `Bearer ${flwKey}` },
  });

  if (!res.ok) {
    throw new Error(`Flutterwave bank lookup returned status ${res.status}`);
  }

  const data = await res.json();
  if (data.status !== 'success' || !Array.isArray(data.data)) return null;

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
 * Initiate a Flutterwave bank transfer.
 * Unlike Paystack, Flutterwave does NOT require a separate recipient creation
 * step — bank details are sent directly in the transfer request.
 * Amount is in the base currency unit (no kobo/smallest-unit conversion needed).
 *
 * Docs: POST /v3/transfers
 */
async function initiateFlutterwaveTransfer(flwKey, {
  amountLocal,
  currency,
  accountNumber,
  accountName,
  bankCode,
  bankName,
  narration,
  reference,
}) {
  const res = await fetch(`${FLW_BASE}/transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${flwKey}`,
    },
    body: JSON.stringify({
      account_bank:    bankCode,
      account_number:  accountNumber,
      amount:          amountLocal,   // Flutterwave accepts full decimal, not smallest unit
      narration:       narration || 'Kreddlo withdrawal',
      currency:        (currency || 'NGN').toUpperCase(),
      reference,
      beneficiary_name: accountName,
      meta: [
        { metaname: 'bankName', metavalue: bankName },
        { metaname: 'platform', metavalue: 'kreddlo' },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || `Flutterwave transfer failed (status ${res.status})`);
  }

  return {
    transferId:   data.data.id           || null,
    flwRef:       data.data.reference    || reference,
    flwStatus:    data.data.status       || 'NEW',
  };
}

/**
 * Initiate a Stripe bank transfer to an external bank account.
 *
 * Flow:
 *  1. Create a Stripe bank account token from the supplied bank details
 *     (routing + account for USD/CAD/AUD/NZD/SGD/HKD,
 *      sort code + account for GBP,
 *      IBAN for EUR/CHF/DKK/NOK/SEK)
 *  2. The token contains the validated bank_name from Stripe
 *  3. Create a Stripe Payout to the external account using the token
 *
 * Note: Stripe Payouts require the platform to have a Stripe Connect
 * account or a positive Stripe balance in the payout currency.
 *
 * Docs:
 *   POST /v1/tokens     — https://stripe.com/docs/api/tokens/create_bank_account
 *   POST /v1/payouts    — https://stripe.com/docs/api/payouts/create
 */
async function initiateStripeTransfer(stripeKey, {
  amountLocal,
  currency,
  accountNumber,
  accountName,
  routingNumber,   // USD/CAD/AUD/NZD/SGD/HKD: ABA/BSB/transit routing number
  sortCode,        // GBP: sort code (6 digits, no dashes)
  iban,            // EUR/CHF/DKK/NOK/SEK: full IBAN
  bankName,
  reference,
}) {
  const cfg = STRIPE_CURRENCY_CONFIG[currency.toUpperCase()];
  if (!cfg) {
    throw new Error(`No Stripe config for currency: ${currency}`);
  }

  const STRIPE_API = 'https://api.stripe.com/v1';
  const authHeader = 'Basic ' + Buffer.from(stripeKey + ':').toString('base64');

  /* ── Step 1: Create bank account token ── */
  const tokenParams = new URLSearchParams();
  tokenParams.append('bank_account[country]',       cfg.country);
  tokenParams.append('bank_account[currency]',       cfg.currency);
  tokenParams.append('bank_account[account_holder_name]', accountName);
  tokenParams.append('bank_account[account_holder_type]', 'individual');

  if (cfg.type === 'iban') {
    // EUR, CHF, DKK, NOK, SEK — IBAN-based
    tokenParams.append('bank_account[account_number]', iban || accountNumber);
  } else if (cfg.type === 'sort_account') {
    // GBP — sort code + account number
    const cleanSort = (sortCode || '').replace(/[-\s]/g, '');
    tokenParams.append('bank_account[routing_number]', cleanSort);
    tokenParams.append('bank_account[account_number]', accountNumber);
  } else {
    // USD/CAD/AUD/NZD/SGD/HKD — routing number + account number
    if (routingNumber) {
      tokenParams.append('bank_account[routing_number]', routingNumber);
    }
    tokenParams.append('bank_account[account_number]', accountNumber);
  }

  const tokenRes = await fetch(`${STRIPE_API}/tokens`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: tokenParams.toString(),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok || tokenData.error) {
    const errMsg = tokenData.error?.message || `Stripe token creation failed (status ${tokenRes.status})`;
    throw new Error(errMsg);
  }

  const stripeToken  = tokenData.id;
  const stripeBankName = tokenData.bank_account?.bank_name || bankName;

  /* ── Step 2: Create Stripe Payout ── */
  // Stripe amounts are in the smallest currency unit (cents for USD/EUR/GBP, etc.)
  // Most Stripe-supported currencies use 2 decimal places (100 cents = 1 unit)
  // Exceptions: JPY, KRW, etc. (0 decimal). All currencies in our list use 2.
  const amountInSmallestUnit = Math.round(amountLocal * 100);

  const payoutParams = new URLSearchParams();
  payoutParams.append('amount',      amountInSmallestUnit);
  payoutParams.append('currency',    cfg.currency);
  payoutParams.append('method',      'standard');
  payoutParams.append('description', `Kreddlo withdrawal ${reference}`);
  payoutParams.append('statement_descriptor', 'KREDDLO');
  payoutParams.append('destination', stripeToken);
  payoutParams.append('metadata[reference]',  reference);
  payoutParams.append('metadata[platform]',   'kreddlo');
  payoutParams.append('metadata[recipient]',  accountName);

  const payoutRes = await fetch(`${STRIPE_API}/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: payoutParams.toString(),
  });

  const payoutData = await payoutRes.json().catch(() => ({}));

  if (!payoutRes.ok || payoutData.error) {
    const errMsg = payoutData.error?.message || `Stripe payout failed (status ${payoutRes.status})`;
    throw new Error(errMsg);
  }

  return {
    transferId:    payoutData.id                   || null,
    stripeRef:     payoutData.balance_transaction  || reference,
    stripeStatus:  payoutData.status               || 'pending',
    stripeBankName,
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
    uid: _bodyUid,      // ignored — we use the verified caller uid
    amount,             // amount in the withdrawal currency
    withdrawalCurrency, // currency to withdraw (NGN, USD, GBP, etc.)
    accountName,
    accountNumber,
    bankName,
    bankCode,           // client-supplied Flutterwave bank code (bypasses fuzzy lookup)
    routingNumber,      // Stripe USD/CAD/AUD: ABA routing number
    sortCode,           // Stripe GBP: sort code (6 digits)
    iban,               // Stripe EUR/CHF/DKK/NOK/SEK: full IBAN
    saveDetails,        // boolean — save bank details for future withdrawals
    fees,               // { platformFee }
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
  if (!accountNumber && !iban) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bank account number or IBAN is required.' }) };
  }
  const isStripeCurrency = STRIPE_TRANSFER_CURRENCIES.includes(currency);
  if (!bankName || !bankName.trim()) {
    // For Stripe IBAN currencies, bank name is resolved from token — not required from client
    const ibanCurrency = isStripeCurrency && STRIPE_CURRENCY_CONFIG[currency]?.type === 'iban';
    if (!ibanCurrency) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Bank name is required.' }) };
    }
  }

  const amountLocal = Number(amount);

  try {
    const db         = getDb();
    const settings   = await getSettings(db);
    const FieldValue = require('firebase-admin').firestore.FieldValue;

    /* ── Fiat payouts must be enabled by an admin ── */
    if (!settings.flutterwaveEnabled && !settings.stripeEnabled) {
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
      accountNumber: (accountNumber || '').trim(),
      bankName:      (bankName || '').trim(),
      // Country is no longer collected from the user (Bug 5 simplification).
      // Derived from the withdrawal currency for routing/record-keeping until
      // the dynamic Flutterwave bank picker (Bug 6) supplies it directly.
      country:       CURRENCY_TO_COUNTRY[currency] || STRIPE_CURRENCY_CONFIG[currency]?.country || '',
      // Stripe-specific fields (populated for international currencies)
      ...(routingNumber ? { routingNumber: routingNumber.trim() } : {}),
      ...(sortCode      ? { sortCode: sortCode.replace(/[-\s]/g, '') } : {}),
      ...(iban          ? { iban: iban.trim().toUpperCase() } : {}),
      ...(bankCode      ? { bankCode: bankCode.trim() } : {}),
    };

    const payoutData = {
      userUid:   uid,
      userName:  userData.name  || '',
      userEmail: userData.email || '',
      amount:    amountLocal,
      currency,
      type:      'bank',
      method:    null,   // set below: 'flutterwave', 'pending_manual', or 'manual'
      bankDetails,
      fees: {
        platformFee,
      },
      status:    'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const payoutRef = await db.collection('payouts').add(payoutData);
    const payoutId  = payoutRef.id;

    /* ────────────────────────────────────────
       STEP 3 — Route to Flutterwave or mark for manual processing

       Flutterwave supports automated transfers for NGN, GHS, KES, UGX,
       TZS, RWF, ZAR, XOF, XAF, MWK, ZMW.
       All other currencies (USD, EUR, GBP, etc.) are flagged as
       pending_manual for wire/SWIFT processing by the team.
    ──────────────────────────────────────── */
    let method        = 'manual';
    let payoutStatus  = 'pending_review';
    let transferId    = null;
    let flwRef        = null;
    let stripeRef     = null;
    let resultMessage = `Bank transfer request of ${formatCurrency(amountLocal, currency)} received. Our team will process this within 1-3 business days.`;

    const isFlwCurrency    = FLW_TRANSFER_CURRENCIES.includes(currency);
    const flwKey           = process.env.FLW_SECRET_KEY;
    const stripeKey        = process.env.STRIPE_SECRET_KEY;

    if (isFlwCurrency && settings.flutterwaveEnabled && flwKey) {
      /* ── Attempt automated Flutterwave transfer for supported currencies ── */
      try {
        /*
         * Bug A3 fix: use client-supplied bankCode directly if provided,
         * only fall back to fuzzy name lookup if bankCode is absent.
         */
        let resolvedBankCode = bankDetails.bankCode || null;
        if (!resolvedBankCode) {
          resolvedBankCode = await findFlutterwaveBankCode(flwKey, bankDetails.bankName, currency);
        }

        if (resolvedBankCode) {
          const transferResult = await initiateFlutterwaveTransfer(flwKey, {
            amountLocal,
            currency,
            accountNumber: bankDetails.accountNumber,
            accountName:   bankDetails.accountName,
            bankCode:      resolvedBankCode,
            bankName:      bankDetails.bankName,
            narration:     `Kreddlo withdrawal ${payoutId}`,
            reference:     `kreddlo-${uid}-${payoutId}`,
          });

          method        = 'flutterwave';
          payoutStatus  = 'sent';
          transferId    = transferResult.transferId;
          flwRef        = transferResult.flwRef;
          resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} sent to your bank account.`;

          // Store resolved bankCode in bankDetails for audit trail
          bankDetails.bankCode = resolvedBankCode;

          console.log(`[create-bank-payout] Flutterwave transfer initiated — payoutId: ${payoutId}, transferId: ${transferId}, flwRef: ${flwRef}`);
        } else {
          /*
           * Bank code lookup returned null — bank name didn't match any
           * bank in the FLW list. Fall through to pending_review.
           */
          console.warn(`[create-bank-payout] Could not match bank "${bankDetails.bankName}" for ${currency} — falling back to pending_review.`);
        }
      } catch (flwErr) {
        console.error('[create-bank-payout] Flutterwave transfer failed, falling back to manual review:', flwErr.message);
        // Falls through — payout is still recorded, balance still deducted, team handles manually.
      }

    } else if (STRIPE_TRANSFER_CURRENCIES.includes(currency) && settings.stripeEnabled && stripeKey) {
      /* ── Attempt automated Stripe payout for international currencies ── */
      try {
        const stripeResult = await initiateStripeTransfer(stripeKey, {
          amountLocal,
          currency,
          accountNumber: bankDetails.accountNumber,
          accountName:   bankDetails.accountName,
          routingNumber: bankDetails.routingNumber || routingNumber || null,
          sortCode:      bankDetails.sortCode      || sortCode      || null,
          iban:          bankDetails.iban          || iban          || null,
          bankName:      bankDetails.bankName,
          reference:     `kreddlo-${uid}-${payoutId}`,
        });

        method        = 'stripe';
        payoutStatus  = 'sent';
        transferId    = stripeResult.transferId;
        stripeRef     = stripeResult.stripeRef;
        resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} sent to your bank account via Stripe.`;

        // Back-fill resolved bank name from Stripe token if we didn't have it
        if (stripeResult.stripeBankName && !bankDetails.bankName) {
          bankDetails.bankName = stripeResult.stripeBankName;
        }

        console.log(`[create-bank-payout] Stripe payout initiated — payoutId: ${payoutId}, stripeId: ${transferId}, stripeRef: ${stripeRef}`);
      } catch (stripeErr) {
        console.error('[create-bank-payout] Stripe payout failed, falling back to pending_manual:', stripeErr.message);
        // Fall through to pending_manual — team processes manually via wire.
        method        = 'pending_manual';
        payoutStatus  = 'pending_manual';
        resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} received. International bank transfers are processed within 2-5 business days.`;
      }

    } else if (!isFlwCurrency && !STRIPE_TRANSFER_CURRENCIES.includes(currency)) {
      /* ── Truly unsupported currency — queue for manual wire processing ── */
      method        = 'pending_manual';
      payoutStatus  = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} received. International bank transfers are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] ${currency} withdrawal for ${uid} — queued as pending_manual (unsupported currency).`);

    } else {
      /* ── Gateway not enabled or key missing — fallback to pending_manual ── */
      method        = 'pending_manual';
      payoutStatus  = 'pending_manual';
      resultMessage = `Withdrawal of ${formatCurrency(amountLocal, currency)} received. International bank transfers are processed manually within 2-5 business days.`;

      console.log(`[create-bank-payout] ${currency} withdrawal for ${uid} — gateway not configured, queued as pending_manual.`);
    }

    await payoutRef.update({
      method,
      status:      payoutStatus,
      transferId:  transferId || null,
      flwRef:      flwRef     || null,
      stripeRef:   stripeRef  || null,
      bankDetails,            // update with any resolved fields (bankCode, stripeBankName)
      // Add a processing note for manual review cases
      ...(method === 'pending_manual' ? {
        note: STRIPE_TRANSFER_CURRENCIES.includes(currency)
          ? 'International bank transfer — Stripe gateway not configured; requires manual wire/SWIFT processing.'
          : 'International bank transfer — requires manual processing via wire/SWIFT.',
      } : {}),
      updatedAt: new Date(),
    });

    /* ────────────────────────────────────────
       STEP 4 — Atomic balance deduction via Firestore transaction
       Re-reads balance inside transaction to prevent race conditions.
    ──────────────────────────────────────── */
    let newCurrencyBalance;
    try {
      await db.runTransaction(async (tx) => {
        const freshSnap     = await tx.get(userRef);
        const freshData     = freshSnap.data();
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
      const platformUrl     = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
      const formattedAmount = formatCurrency(amountLocal, currency);

      await fetch(`${platformUrl}/.netlify/functions/send-smart-notification`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
        },
        body:    JSON.stringify({
          userUid:    userData.uid || null,
          to:         userData.email || null,
          title:      'Bank Withdrawal Initiated',
          body:       (method === 'flutterwave' || method === 'stripe')
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
