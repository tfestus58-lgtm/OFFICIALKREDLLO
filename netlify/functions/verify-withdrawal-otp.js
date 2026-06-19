/**
 * verify-withdrawal-otp.js — Kreddlo Netlify Function
 *
 * Validates the 6-digit withdrawal OTP against the stored value in Firestore.
 * Single-use: clears the OTP fields on success so it can't be reused.
 *
 * POST body: { uid, code }
 * Auth: Firebase ID token in Authorization header
 *
 * Returns: { success: true } or { error: "..." }
 */

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const { verifyCaller }                  = require('./_verify-auth');

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed.' });

  /* ── Auth ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) return respond(401, { error: 'Unauthorized. Please log in again.' });

  let uid, code;
  try {
    ({ uid, code } = JSON.parse(event.body || '{}'));
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (!uid || uid !== callerUid) return respond(403, { error: 'Forbidden.' });
  if (!code) return respond(400, { error: 'Verification code is required.' });

  /* ── Get user ── */
  let db, userSnap;
  try {
    db       = getDb();
    userSnap = await db.collection('users').doc(uid).get();
  } catch (err) {
    console.error('[verify-withdrawal-otp] Firestore read error:', err.message);
    return respond(500, { error: 'Database error.' });
  }

  if (!userSnap.exists) return respond(404, { error: 'User not found.' });
  const user = userSnap.data();

  /* ── Check OTP fields exist ── */
  if (!user.withdrawalOtp || !user.withdrawalOtpExpiry) {
    return respond(400, { error: 'No verification code found. Please request a new one.' });
  }

  /* ── Check already used ── */
  if (user.withdrawalOtpUsed === true) {
    return respond(400, { error: 'This code has already been used. Please request a new one.' });
  }

  /* ── Check expiry ── */
  const expiry = user.withdrawalOtpExpiry.toDate
    ? user.withdrawalOtpExpiry.toDate()
    : new Date(user.withdrawalOtpExpiry);

  if (Date.now() > expiry.getTime()) {
    return respond(400, { error: 'This code has expired. Please request a new one.' });
  }

  /* ── Check code matches ── */
  if (String(user.withdrawalOtp).trim() !== String(code).trim()) {
    return respond(400, { error: 'Incorrect code. Please check your email and try again.' });
  }

  /* ── Mark used and clear fields ── */
  try {
    await db.collection('users').doc(uid).update({
      withdrawalOtpUsed:   true,
      withdrawalOtp:       FieldValue.delete(),
      withdrawalOtpExpiry: FieldValue.delete(),
    });
  } catch (err) {
    console.error('[verify-withdrawal-otp] Firestore update error:', err.message);
    return respond(500, { error: 'Failed to confirm OTP.' });
  }

  console.log(`[verify-withdrawal-otp] uid ${uid} OTP verified successfully.`);
  return respond(200, { success: true });
};
