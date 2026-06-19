/**
 * resolve-bank-account.js — Kreddlo Netlify Function
 *
 * Resolves a bank account holder name from a bank code + account number,
 * via Flutterwave's POST /v3/accounts/resolve endpoint. Used by the
 * affiliate bank withdrawal form (dashboard-affiliate.html) to auto-fill
 * the read-only "Account Name" field after the user enters their account
 * number — eliminates manual entry errors, same pattern intended for the
 * freelancer bank payout flow.
 *
 * Query params:
 *   bankCode       — Flutterwave bank code — required
 *   accountNumber  — bank account number — required
 *
 * Environment variables required:
 *   FLW_SECRET_KEY — Flutterwave secret key (FLWSECK_TEST-... or FLWSECK-...)
 */

const { verifyCaller } = require('./_verify-auth');

const FLW_BASE = 'https://api.flutterwave.com/v3';

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

  const params        = event.queryStringParameters || {};
  const bankCode      = (params.bankCode || '').trim();
  const accountNumber = (params.accountNumber || '').trim();

  if (!bankCode) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bank is required.' }) };
  }
  if (!accountNumber) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Account number is required.' }) };
  }

  const flwKey = process.env.FLW_SECRET_KEY;
  if (!flwKey) {
    console.error('[resolve-bank-account] FLW_SECRET_KEY not set.');
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({ error: 'Account lookup is temporarily unavailable.' }),
    };
  }

  try {
    const res = await fetch(`${FLW_BASE}/accounts/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${flwKey}`,
      },
      body: JSON.stringify({
        account_bank:   bankCode,
        account_number: accountNumber,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status !== 'success' || !data.data || !data.data.account_name) {
      return {
        statusCode: 422,
        headers: CORS,
        body: JSON.stringify({ error: data.message || 'Could not verify this account. Check the bank and account number.' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountName: data.data.account_name }),
    };
  } catch (err) {
    console.error('[resolve-bank-account] Lookup failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not verify this account. Please try again.' }),
    };
  }
};
