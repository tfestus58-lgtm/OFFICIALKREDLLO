/**
 * Netlify Function: send-smart-notification.js
 * Path: netlify/functions/send-smart-notification.js
 *
 * Unified notification dispatcher. Handles:
 *   1. Writing an in-app notification to Firestore (always)
 *   2. Sending an FCM push notification (if user has a token)
 *   3. Sending a transactional email via send-email (emailMode controls timing)
 *
 * POST body:
 *   {
 *     userUid:      string        — Firebase UID of the recipient
 *     title:        string        — notification title
 *     body:         string        — notification body text
 *     url?:         string        — optional deep-link URL
 *     templateId:   string        — email template ID (matches send-email.js)
 *     emailData:    object        — data object passed to the email template
 *     emailMode:    'always' | 'delayed' | 'never'
 *     delayMinutes: number        — delay in minutes for 'delayed' mode (default 15)
 *   }
 *
 * Environment variables required:
 *   FIREBASE_SERVICE_ACCOUNT  — full service account JSON (single-line string)
 *   FIREBASE_SERVER_KEY       — FCM server key (for Authorization header)
 *   PLATFORM_URL              — live domain e.g. https://kreddlo.com
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue }     = require('firebase-admin/firestore');
const crypto                           = require('crypto');

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

/* ── Extract project_id for FCM HTTP v1 endpoint ── */
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

  const header   = { alg: 'RS256', typ: 'JWT' };
  const b64url   = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt       = `${unsigned}.${signature}`;

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

/* ── Send FCM push via HTTP v1 API ── */
async function sendFcmPush({ fcmToken, title, body, url }) {
  const projectId   = getProjectId();
  const accessToken = await getGoogleAccessToken();
  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: {
        url:          url || '',
        title,
        body,
        click_action: url || '',
      },
      webpush: {
        notification: {
          title,
          body,
          icon:  '/assets/kreddlo-192.png',
          badge: '/assets/favicon-32x32.png',
        },
        fcm_options: { link: url || '/' },
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
    const fcmError = errBody?.error?.details?.[0]?.errorCode || '';
    const stale    = ['registration-token-not-registered', 'invalid-registration-token'];
    if (stale.includes(fcmError)) return { sent: false, staleToken: true };
    throw new Error(`FCM push failed: ${JSON.stringify(errBody)}`);
  }

  return { sent: true, staleToken: false };
}

/* ── Call a sibling Netlify function by name ── */
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  if (!platformUrl) {
    console.warn(`callFunction: PLATFORM_URL not set, cannot call ${name}.`);
    return null;
  }
  const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  return res;
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const {
    userUid,
    title,
    body,
    url,
    templateId,
    emailData    = {},
    emailMode    = 'never',
    delayMinutes = 15,
  } = payload;

  if (!userUid)    return respond(400, { error: 'userUid is required.' });
  if (!title)      return respond(400, { error: 'title is required.' });
  if (!body)       return respond(400, { error: 'body is required.' });
  if (!templateId) return respond(400, { error: 'templateId is required.' });

  const platformUrl = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
  const notifUrl    = url || `${platformUrl}/dashboard.html`;

  /* ── Step 1: Fetch user from Firestore ── */
  let db, userSnap;
  try {
    db       = getDb();
    userSnap = await db.collection('users').doc(userUid).get();
  } catch (err) {
    console.error('Firestore read failed:', err.message);
    return respond(500, { error: 'Database read failed.' });
  }

  if (!userSnap.exists) {
    console.warn(`send-smart-notification: user ${userUid} not found.`);
    return respond(404, { error: 'User not found.' });
  }

  const { fcmToken } = userSnap.data();

  /* ── Step 2: Write in-app notification document ── */
  let notifDocId;
  try {
    const notifRef = await db
      .collection('users')
      .doc(userUid)
      .collection('notifications')
      .add({
        title,
        body,
        url:        notifUrl,
        templateId,
        read:       false,
        emailSent:  false,
        emailMode,
        createdAt:  FieldValue.serverTimestamp(),
      });
    notifDocId = notifRef.id;
    console.log(`In-app notification written for uid ${userUid}, docId ${notifDocId}.`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`Failed to write in-app notification for uid ${userUid}:`, err.message);
  }

  /* ── Step 3: Send FCM push if token exists ── */
  if (fcmToken) {
    try {
      const result = await sendFcmPush({ fcmToken, title, body, url: notifUrl });
      if (result.staleToken) {
        await db.collection('users').doc(userUid).update({ fcmToken: null });
        console.log(`Stale FCM token cleared for uid ${userUid}.`);
      } else {
        console.log(`FCM push sent to uid ${userUid}.`);
      }
    } catch (err) {
      // Non-fatal — in-app notification already written
      console.error(`FCM push failed for uid ${userUid}:`, err.message);
    }
  } else {
    console.log(`uid ${userUid} has no fcmToken — in-app only.`);
  }

  /* ── Step 4: Handle email based on emailMode ── */
  if (emailMode === 'never') {
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'always') {
    try {
      await callFunction('send-email', { templateId, data: emailData });
      // Mark emailSent on the notification document
      if (notifDocId) {
        await db
          .collection('users').doc(userUid)
          .collection('notifications').doc(notifDocId)
          .update({ emailSent: true, emailSentAt: new Date().toISOString() });
      }
      console.log(`Email sent immediately for uid ${userUid}, template ${templateId}.`);
    } catch (err) {
      console.error(`Email send failed for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  if (emailMode === 'delayed') {
    try {
      await db.collection('email-queue').add({
        userUid,
        notifDocId:  notifDocId || null,
        templateId,
        emailData,
        sendAfter:   Date.now() + delayMinutes * 60 * 1000,
        sent:        false,
        createdAt:   FieldValue.serverTimestamp(),
      });
      console.log(`Email queued for uid ${userUid} in ${delayMinutes} min, template ${templateId}.`);
    } catch (err) {
      console.error(`Failed to queue email for uid ${userUid}:`, err.message);
    }
    return respond(200, { received: true, notifDocId });
  }

  // Fallback for unknown emailMode
  return respond(200, { received: true, notifDocId });
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
