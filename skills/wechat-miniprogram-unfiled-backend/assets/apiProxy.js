/**
 * apiProxy — WeChat cloud function that relays mini-program calls to a self-hosted backend.
 *
 * Why: wx.request is restricted to filed HTTPS domains; wx.cloud.callFunction rides WeChat's
 * private channel and is exempt. This function therefore reaches the backend by IP, so it works
 * before (and independently of) ICP filing.
 *
 * Zero dependencies: Node built-ins only. Nothing to npm install.
 *
 * Environment variables (set in the cloud console):
 *   BACKEND_BASE  http://<SERVER_IP>:<PORT>   — deliberately a raw IP, not a domain
 *   PROXY_KEY     shared secret; must match the backend's gate. Missing => refuses to serve.
 *
 * Deploy:
 *   tcb fn deploy apiProxy --force --dir cloudfunctions/apiProxy
 */
const http = require('http');
const https = require('https');

/* Optional: cloud-storage channel. Keep it lazy so the function still loads without the SDK. */
let cloudSdk = null;
try {
  cloudSdk = require('wx-server-sdk');
  cloudSdk.init({ env: cloudSdk.DYNAMIC_CURRENT_ENV });
} catch (e) { cloudSdk = null; }

const BACKEND = String(process.env.BACKEND_BASE || '').replace(/\/+$/, '');
const PROXY_KEY = String(process.env.PROXY_KEY || '').trim();

/** Forward one HTTP request. Resolves { status, ct, body:Buffer }. */
function forward(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(new Error('BAD_URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        ct: res.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('BACKEND_TIMEOUT')));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

const contentTypeOf = (fileId) => {
  const p = String(fileId).toLowerCase();
  if (p.indexOf('.png') >= 0) return 'image/png';
  if (p.indexOf('.webp') >= 0) return 'image/webp';
  if (p.indexOf('.bmp') >= 0) return 'image/bmp';
  if (p.indexOf('.pdf') >= 0) return 'application/pdf';
  return 'image/jpeg';
};

exports.main = async (event) => {
  const path = String((event && event.path) || '');
  const method = String((event && event.method) || 'GET').toUpperCase();

  /* Fail closed: a relay without a shared secret is an open proxy. */
  if (!BACKEND) return { ok: false, status: 0, error: 'BACKEND_BASE_MISSING' };
  if (!PROXY_KEY) return { ok: false, status: 0, error: 'PROXY_KEY_MISSING' };
  if (!path.startsWith('/api/') || path.indexOf('..') >= 0) {
    return { ok: false, status: 0, error: 'BAD_PATH' };
  }

  const headers = Object.assign({}, (event && event.headers) || {});
  headers['x-proxy-key'] = PROXY_KEY;
  headers.connection = 'close';

  try {
    let body = null;
    let target = BACKEND + path;

    if (typeof (event && event.fileID) === 'string' && event.fileID.indexOf('cloud://') === 0) {
      /* Channel A: cloud storage. Client uploaded via wx.cloud.uploadFile, we pull and stream it. */
      if (!cloudSdk) return { ok: false, status: 0, error: 'SDK_MISSING' };
      let fb = null;
      try {
        const dl = await cloudSdk.downloadFile({ fileID: event.fileID });
        fb = dl && dl.fileContent;
      } catch (e) { fb = null; }
      if (!fb || !fb.length) return { ok: false, status: 0, error: 'FILE_DOWNLOAD_FAIL' };
      body = Buffer.isBuffer(fb) ? fb : Buffer.from(fb);
      headers['content-type'] = contentTypeOf(event.fileID);
      headers['content-length'] = body.length;
      const purpose = String((event.data && event.data.purpose) || 'private');
      target += (path.indexOf('?') >= 0 ? '&' : '?') + 'purpose=' + encodeURIComponent(purpose);
    } else if (typeof (event && event.fileCdn) === 'string' && /^https?:\/\//.test(event.fileCdn)) {
      /* Channel B: temporary CDN URL produced by wx.cloud.CDN({type:'filePath'}). */
      const purpose = String((event.data && event.data.purpose) || 'private');
      const dl = await forward(event.fileCdn, 'GET', {}, null);
      if (dl.status < 200 || dl.status >= 300 || !dl.body || !dl.body.length) {
        return { ok: false, status: 0, error: 'CDN_DOWNLOAD_FAIL_' + dl.status };
      }
      body = dl.body;
      headers['content-type'] = String(dl.ct || '').split(';')[0].trim() || 'application/octet-stream';
      headers['content-length'] = body.length;
      target += (path.indexOf('?') >= 0 ? '&' : '?') + 'purpose=' + encodeURIComponent(purpose);
    } else if (event && event.data !== undefined && method !== 'GET' && method !== 'HEAD') {
      /* Channel C: plain JSON body (<= ~1MB per callFunction limit). */
      body = Buffer.from(
        typeof event.data === 'string' ? event.data : JSON.stringify(event.data),
        'utf8'
      );
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }
      headers['content-length'] = body.length;
    }

    const r = await forward(target, method, headers, body);
    const text = r.body.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON response */ }

    return { ok: true, status: r.status, ct: r.ct, json, size: r.body.length };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
};
