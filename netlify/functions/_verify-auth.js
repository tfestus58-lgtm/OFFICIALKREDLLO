/**
 * _verify-auth.js — Shared caller-identity verification helper
 *
 * Exports `verifyCaller(event)` which:
 *   1. Reads the Authorization header (handles both casings)
 *   2. Extracts the Bearer token
 *   3. Verifies it with Firebase Admin auth
 *   4. Returns the decoded token's uid
 *
 * Usage in any function:
 *   const { verifyCaller } = require('./_verify-auth');
 *   const callerUid = await verifyCaller(event);
 *   if (!callerUid) return respond(401, { error: 'Unauthorized.' });
 *
 * Keep webhooks (stripe, paystack, nowpayments) untouched —
 * they use signature verification, not user tokens.
 */

const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

function ensureAdminInitialised() {
  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
}

/**
 * Verifies the Firebase ID token in the Authorization header.
 *
 * @param {object} event - Netlify function event object
 * @returns {string|null} Verified uid, or null if token is missing/invalid
 */
async function verifyCaller(event) {
  // Handle both 'Authorization' and 'authorization' header casings
  const authHeader =
    event.headers['authorization'] || event.headers['Authorization'] || '';

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  try {
    ensureAdminInitialised();
    const decoded = await getAuth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    console.warn('[_verify-auth] Token verification failed:', err.message);
    return null;
  }
}

module.exports = { verifyCaller };
