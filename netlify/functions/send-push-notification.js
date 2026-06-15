/**
 * Netlify Function: send-push-notification.js
 * Path: netlify/functions/send-push-notification.js
 *
 * Sends an FCM push notification to a single user AND writes an in-app
 * notification document to Firestore so the bell dot stays in sync even
 * when push delivery fails (user has not granted permission, token expired, etc).
 *
 * POST body:
 *   {
 *     userUid: string   — the Firebase UID of the recipient
 *     title:   string   — notification title
 *     body:    string   — notification body text
 *     url?:    string   — optional deep-link URL (opened on notification tap)
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full Firebase service account JSON as a single-line string
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com (no trailing slash)
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

/* ── Extract project_id from service account for FCM endpoint ── */
function getProjectId() {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    return sa.project_id || '';
  } catch {
    return '';
  }
}

/* ── Generate a Google OAuth 2.0 access token from the service account ── */
async function getGoogleAccessToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  // Build the JWT manually (header.payload.signature)
  const header   = { alg: 'RS256', typ: 'JWT' };
  const b64url   = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Sign with the private key using Node's crypto
  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt       = `${unsigned}.${signature}`;

  // Exchange for an access token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google OAuth token exchange failed: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

/* ── Send the FCM push via HTTP v1 API ── */
async function sendFcmPush({ fcmToken, title, body, url }) {
  const projectId   = getProjectId();
  const accessToken = await getGoogleAccessToken();

  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: {
        url:     url || '',
        title:   title,
        body:    body,
        // click_action is used by older SDKs; url in data works for modern web push
        click_action: url || '',
      },
      webpush: {
        notification: {
          title,
          body,
          icon:  '/assets/kreddlo-192.png',
          badge: '/assets/favicon-32x32.png',
        },
        fcm_options: {
          link: url || '/',
        },
      },
    },
  };

  const res = await fetch(fcmEndpoint, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    // FCM error codes that mean the token is no longer valid
    const staleTokenCodes = ['registration-token-not-registered', 'invalid-registration-token'];
    const fcmError        = errBody?.error?.details?.[0]?.errorCode || '';
    if (staleTokenCodes.includes(fcmError)) {
      return { sent: false, staleToken: true };
    }
    throw new Error(`FCM push failed: ${JSON.stringify(errBody)}`);
  }

  return { sent: true, staleToken: false };
}

/* ── Write in-app notification to Firestore ── */
async function writeInAppNotification(db, userUid, { title, body, url }) {
  await db.collection('users').doc(userUid).collection('notifications').add({
    title,
    body,
    url:       url || null,
    read:      false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { userUid, title, body, url } = payload;

  if (!userUid || typeof userUid !== 'string') {
    return respond(400, { error: 'userUid is required.' });
  }
  if (!title || typeof title !== 'string') {
    return respond(400, { error: 'title is required.' });
  }
  if (!body || typeof body !== 'string') {
    return respond(400, { error: 'body is required.' });
  }

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const notifUrl    = url || `${platformUrl}/dashboard.html`;

  /* ── Init Firestore ── */
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    return respond(500, { error: 'Database not available.' });
  }

  /* ── Fetch user document ── */
  let userSnap;
  try {
    userSnap = await db.collection('users').doc(userUid).get();
  } catch (err) {
    console.error(`Firestore read failed for uid ${userUid}:`, err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.warn(`send-push-notification: user ${userUid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const { fcmToken } = userSnap.data();

  /* ── Always write the in-app notification regardless of push status ── */
  try {
    await writeInAppNotification(db, userUid, { title, body, url: notifUrl });
    console.log(`In-app notification written for uid ${userUid}.`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`Failed to write in-app notification for uid ${userUid}:`, err.message);
  }

  /* ── Send push if token exists ── */
  if (!fcmToken) {
    console.log(`uid ${userUid} has no fcmToken — in-app notification only.`);
    return respond(200, { success: true, push: false, reason: 'No FCM token on record.' });
  }

  try {
    const result = await sendFcmPush({
      fcmToken,
      title,
      body,
      url: notifUrl,
    });

    if (result.staleToken) {
      // Token expired — clear it from Firestore so we stop trying
      await db.collection('users').doc(userUid).update({ fcmToken: null });
      console.log(`Stale FCM token cleared for uid ${userUid}.`);
      return respond(200, { success: true, push: false, reason: 'Stale token cleared.' });
    }

    console.log(`Push notification sent to uid ${userUid}.`);
    return respond(200, { success: true, push: true });

  } catch (err) {
    // Push failure is non-fatal — in-app notification is already written
    console.error(`FCM push failed for uid ${userUid}:`, err.message);
    return respond(200, { success: true, push: false, reason: err.message });
  }
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
