// netlify/functions/download-contract.js
//
// Streams a contract PDF directly to the browser without storing it anywhere.
// Fetches the contract doc from Firestore, passes all fields to
// generate-contract-pdf in preview mode, and pipes the bytes back as the
// HTTP response.
//
// GET /api/download-contract?contractId=xxx&uid=yyy
//
// Security: verifies that uid matches either freelancerUid or buyerUid on
//           the contract document.
//
// Returns:
//   application/pdf binary stream (Content-Disposition: attachment)

const admin = require('firebase-admin');

function getAdmin() {
  if (admin.apps.length) return admin;
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin;
}

exports.handler = async (event) => {
  const { contractId, uid } = event.queryStringParameters || {};

  if (!contractId || !uid) {
    return { statusCode: 400, body: 'contractId and uid are required' };
  }

  try {
    const db   = getAdmin().firestore();
    const snap = await db.collection('contracts').doc(contractId).get();

    if (!snap.exists) {
      return { statusCode: 404, body: 'Contract not found' };
    }

    const data = snap.data();

    // Auth check: only freelancer or buyer may download
    if (data.freelancerUid !== uid && data.buyerUid !== uid) {
      return { statusCode: 403, body: 'Access denied' };
    }

    // If a stored PDF already exists, redirect to it — fastest path
    if (data.contractPdfUrl) {
      return {
        statusCode: 302,
        headers: { Location: data.contractPdfUrl },
        body: '',
      };
    }

    // Generate on-demand via the PDF handler
    const handler    = require('./generate-contract-pdf');

    function toIso(ts) {
      if (!ts) return '';
      return ts.toDate ? ts.toDate().toISOString() : String(ts);
    }

    const fakeEvent = {
      httpMethod: 'POST',
      body: JSON.stringify({
        projectId:           contractId,
        projectTitle:        data.title            || 'Service Agreement',
        serviceDescription:  data.scope            || data.description || '',
        budget:              data.amount           || 0,
        deadline:            toIso(data.deadline),
        freelancerName:      data.freelancerName   || '',
        freelancerUsername:  data.freelancerUsername || '',
        freelancerSignature: data.freelancerSignature || '',
        freelancerSignedAt:  toIso(data.freelancerSignedAt),
        freelancerIp:        data.freelancerIp     || '',
        buyerName:           data.buyerName        || '',
        buyerEmail:          data.buyerEmail       || '',
        buyerSignature:      data.buyerSignature   || '',
        buyerSignedAt:       toIso(data.buyerSignedAt),
        buyerIp:             data.buyerIp          || '',
        agreementDate:       new Date().toLocaleDateString('en-US', {
                               month: 'long', day: 'numeric', year: 'numeric',
                             }),
        preview: true,
      }),
    };

    const result = await handler.handler(fakeEvent);

    if (result.statusCode !== 200) {
      return { statusCode: 500, body: 'PDF generation failed' };
    }

    // Pass through the binary PDF
    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="kreddlo-contract-${contractId}.pdf"`,
        'Cache-Control':       'private, no-store',
      },
      body:            result.body,          // already base64
      isBase64Encoded: result.isBase64Encoded,
    };

  } catch (err) {
    console.error('[download-contract]', err);
    return { statusCode: 500, body: err.message || 'Download failed' };
  }
};
