/**
 * get-settings.js
 * Shared helper — NOT a Netlify function handler.
 * Usage: const { getSettings } = require('./get-settings');
 *        const settings = await getSettings(db);
 */

const DEFAULTS = {
  platformFeePercent:        2.5,
  projectProtectionPercent:  1.0,
  withdrawalFeePercent:      1.5,
  earlyPayoutFeePercent:     2.0,
  holdingPeriodDays:         7,
  minWithdrawalUsd:          10,
  boostPrice24h:             5,
  boostPrice3d:              12,
  boostPrice7d:              25,
  referralCreditAmount:      2,
  stripeEnabled:             false,
  paystackEnabled:           false,
  twitterUrl:                '',
  linkedinUrl:               '',
  instagramUrl:              '',
};

/**
 * Fetches platform settings from Firestore config/platform.
 * Always returns a complete settings object — falls back to defaults
 * if the document is missing or the read fails.
 *
 * @param {FirebaseFirestore.Firestore} db  Initialized Firestore instance
 * @returns {Promise<typeof DEFAULTS>}
 */
async function getSettings(db) {
  try {
    const snap = await db.collection('config').doc('platform').get();

    if (!snap.exists) {
      return { ...DEFAULTS };
    }

    // Merge: Firestore values win; any missing field falls back to its default
    return { ...DEFAULTS, ...snap.data() };
  } catch (err) {
    console.error('[get-settings] Firestore read failed, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

module.exports = { getSettings };
