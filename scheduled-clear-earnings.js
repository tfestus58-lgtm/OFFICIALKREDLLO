/**
 * Netlify Scheduled Function: scheduled-clear-earnings.js
 * Path: netlify/functions/scheduled-clear-earnings.js
 *
 * Runs hourly (schedule defined in netlify.toml).
 *
 * Item 9 — Earnings Holding Period (product sales + affiliate commissions).
 *
 * Finds `product-earnings` and `affiliate-earnings` records where
 * `cleared === false` and `clearsAt <= now`, then:
 *   1. Moves the held amount from the user's pendingBalance(s) into their
 *      availableBalance / balances.{CURRENCY} (product sales) or from
 *      affiliatePendingBalance into affiliateBalance (affiliate commissions).
 *   2. Flips the earning record's `cleared` flag to true.
 *
 * This is the only place uncleared funds ever become withdrawable — both
 * create-payout.js / create-bank-payout.js (freelancer payouts) and
 * affiliate-withdraw.js already gate on availableBalance / affiliateBalance,
 * so once this job has run, those existing functions enforce the holding
 * period automatically with no changes of their own required.
 *
 * If a holding period of 0 days is configured, deliver-product.js and the
 * payment webhooks mark earnings `cleared: true` immediately at creation —
 * this job will simply find nothing to do for those records.
 *
 * netlify.toml entry required:
 *   [functions."scheduled-clear-earnings"]
 *   schedule = "0 * * * *"
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT — full service account JSON as single-line string
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');

/* ── Firebase Admin — lazy singleton ── */
let _db = null;

function getDb() {
  if (_db) return _db;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  _db = getFirestore();
  return _db;
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  console.log('scheduled-clear-earnings: running at', new Date().toISOString());

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  const now = new Date();
  const results = {
    productEarningsCleared:   0,
    productEarningsFailed:    0,
    affiliateEarningsCleared: 0,
    affiliateEarningsFailed:  0,
  };

  /* ════════════════════════════════════════════════════════════
     1. CLEAR PRODUCT-SALE EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('product-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no product earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} product earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        const earning = docSnap.data();

        try {
          const currency = (earning.currency || 'USD').toUpperCase();
          const amount   = Number(earning.amount) || 0;

          await db.collection('users').doc(earning.sellerUid).update({
            [`balances.${currency}`]:         FieldValue.increment(amount),
            availableBalance:                 FieldValue.increment(amount),
            [`pendingBalances.${currency}`]:  FieldValue.increment(-amount),
            pendingBalance:                   FieldValue.increment(-amount),
          });

          await docSnap.ref.update({
            cleared:    true,
            clearedAt:  FieldValue.serverTimestamp(),
          });

          results.productEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear product earning ${docSnap.id}:`, err.message);
          results.productEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: product-earnings query failed (may need composite index on product-earnings.cleared + product-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  /* ════════════════════════════════════════════════════════════
     2. CLEAR AFFILIATE-COMMISSION EARNINGS
  ════════════════════════════════════════════════════════════ */
  try {
    const snap = await db.collection('affiliate-earnings')
      .where('cleared',  '==', false)
      .where('clearsAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('scheduled-clear-earnings: no affiliate earnings ready to clear.');
    } else {
      console.log(`scheduled-clear-earnings: found ${snap.size} affiliate earning(s) ready to clear.`);

      for (const docSnap of snap.docs) {
        const earning = docSnap.data();

        try {
          const amount = Number(earning.commissionAmount) || 0;

          await db.collection('users').doc(earning.affiliateUid).update({
            affiliateBalance:        FieldValue.increment(amount),
            affiliatePendingBalance: FieldValue.increment(-amount),
          });

          await docSnap.ref.update({
            cleared:    true,
            clearedAt:  FieldValue.serverTimestamp(),
          });

          results.affiliateEarningsCleared++;
        } catch (err) {
          console.error(`scheduled-clear-earnings: failed to clear affiliate earning ${docSnap.id}:`, err.message);
          results.affiliateEarningsFailed++;
        }
      }
    }
  } catch (err) {
    // Likely a missing composite index (cleared + clearsAt) — see FIRESTORE_INDEXES.md
    console.error('scheduled-clear-earnings: affiliate-earnings query failed (may need composite index on affiliate-earnings.cleared + affiliate-earnings.clearsAt — check logs for a Firebase auto-create link):', err.message);
  }

  console.log('scheduled-clear-earnings: complete —', JSON.stringify(results));

  return respond(200, results);
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
