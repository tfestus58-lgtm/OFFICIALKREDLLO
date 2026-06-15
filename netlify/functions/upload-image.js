/**
 * Netlify Function: upload-image.js
 * Generic image uploader to Cloudinary.
 * Used for product covers, profile photos, etc.
 *
 * POST body (JSON):
 *   {
 *     image:  string,   // base64, no data: prefix
 *     folder: string,   // e.g. "products", "profiles"
 *     publicId: string, // e.g. uid + "-cover"
 *   }
 *
 * Response:
 *   200 { url: string }
 *   400/500 { error: string }
 *
 * Env vars required:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 */

const https  = require('https');
const crypto = require('crypto');

async function uploadToCloudinary(base64Data, folder, publicId) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigStr    = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha256').update(sigStr).digest('hex');

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const dataUri  = `data:image/jpeg;base64,${base64Data}`;

  const fields = {
    file:      dataUri,
    api_key:   apiKey,
    timestamp,
    public_id: publicId,
    folder,
    signature,
  };

  let body = '';
  for (const [key, val] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  const bodyBuf = Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path:     `/v1_1/${cloudName}/image/upload`,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) resolve(parsed.secure_url);
          else reject(new Error('Cloudinary error: ' + (parsed.error?.message || data)));
        } catch (e) {
          reject(new Error('Cloudinary response error: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { image, folder, publicId } = payload;

  if (!image || typeof image !== 'string' || image.length < 100) {
    return { statusCode: 400, body: JSON.stringify({ error: 'image is required' }) };
  }
  if (!folder || !publicId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'folder and publicId are required' }) };
  }

  try {
    const url = await uploadToCloudinary(image, folder, publicId);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    };
  } catch (err) {
    console.error('upload-image error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
