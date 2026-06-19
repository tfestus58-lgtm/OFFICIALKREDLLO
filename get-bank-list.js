/**
 * get-bank-list.js — Kreddlo Netlify Function
 *
 * Returns the list of banks for a given fiat currency, sourced from
 * Flutterwave's GET /v3/banks/:country endpoint. Used by the affiliate
 * bank withdrawal form (dashboard-affiliate.html) to populate the
 * searchable "Bank" dropdown — same pattern as the freelancer bank
 * payout flow in create-bank-payout.js.
 *
 * For Stripe-supported international currencies (USD, EUR, GBP, etc.)
 * no bank list is returned — instead a `stripeFields` descriptor tells
 * the frontend which input fields to render (routing+account, IBAN, etc.)
 *
 * Query params:
 *   currency  — fiat currency code (NGN, GHS, KES, USD, EUR, GBP …) — required
 *
 * Environment variables required:
 *   FLW_SECRET_KEY — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 */

const { verifyCaller } = require('./_verify-auth');

const FLW_BASE = 'https://api.flutterwave.com/v3';

/**
 * Map a currency code to the Flutterwave country code used when
 * looking up banks via GET /v3/banks/:country.
 * Kept identical to the map in create-bank-payout.js so both flows
 * agree on which countries are supported.
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
 * Stripe-supported international currencies.
 * For these we return stripeFields instead of a bank list —
 * Stripe does not expose a public bank directory like Flutterwave.
 *
 * Each entry describes:
 *   type   — input pattern the frontend should render
 *   fields — ordered list of field IDs the frontend must collect
 *   label  — human-readable description shown to the user
 */
const STRIPE_FIELD_MAP = {
  USD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Routing number + Account number' },
  CAD: { type: 'routing_account', fields: ['routingNumber', 'accountNumber'], label: 'Institution & transit number + Account number' },
  AUD: { type: 'bsb_account',     fields: ['bsbNumber',     'accountNumber'], label: 'BSB number + Account number' },
  NZD: { type: 'bsb_account',     fields: ['bsbNumber',     'accountNumber'], label: 'Bank branch number + Account number' },
  GBP: { type: 'sort_account',    fields: ['sortCode',      'accountNumber'], label: 'Sort code + Account number' },
  EUR: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  CHF: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  DKK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  NOK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
  SEK: { type: 'iban',            fields: ['iban'],                           label: 'IBAN' },
};

const STRIPE_CURRENCIES = Object.keys(STRIPE_FIELD_MAP);

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed.' }) };
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  const currency = ((event.queryStringParameters && event.queryStringParameters.currency) || 'NGN')
    .toUpperCase()
    .trim();

  /* ── Stripe international currencies — return field descriptor, no bank list ── */
  if (STRIPE_CURRENCIES.includes(currency)) {
    const stripeFields = STRIPE_FIELD_MAP[currency];
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        banks:        [],
        currency,
        stripeFields,
      }),
    };
  }

  /* ── Flutterwave-supported currencies — fetch bank list from FLW ── */
  const countryCode = CURRENCY_TO_COUNTRY[currency];
  if (!countryCode) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `Bank transfers are not yet supported for ${currency}.` }),
    };
  }

  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('[get-bank-list] FLW_SECRET_KEY not set.');
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({ error: 'Bank lookup is temporarily unavailable.' }),
    };
  }

  try {
    const res = await fetch(`${FLW_BASE}/banks/${countryCode}`, {
      headers: { Authorization: `Bearer ${flwKey}` },
    });

    if (!res.ok) {
      throw new Error(`Flutterwave bank list returned status ${res.status}`);
    }

    const data = await res.json();
    if (data.status !== 'success' || !Array.isArray(data.data)) {
      throw new Error('Unexpected response from Flutterwave bank list.');
    }

    const banks = data.data
      .map((b) => ({ code: b.code, name: b.name }))
      .filter((b) => b.code && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ banks, currency, country: countryCode }),
    };
  } catch (err) {
    console.error('[get-bank-list] Failed to fetch bank list:', err.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not load bank list. Please try again.' }),
    };
  }
};
