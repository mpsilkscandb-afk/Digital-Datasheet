/*
 * MPS Design Registry & Inventory Datasheet - Local Development Server.
 * Combines static file serving for the frontend app shell with an in-memory
 * Google Apps Script mock (/api) and Drive photo viewer (/photo/<id>).
 *
 * Usage:
 *   node tools/dev-server.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || process.argv[2] || '8099', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip'
};

// Initialize GAS backend
const gas = createGas({ root: ROOT });
gas.setup();

// Admin token & initial seed data
const initialAdminPin = gas.adminPin;
const adminToken = gas.login('Admin', initialAdminPin);
const adminCall = gas.withToken(adminToken);

// Standard test PINs (configurable via env, default fallbacks for local dev)
const ADMIN_PIN = process.env.ADMIN_PIN || '123456';
const ENTRY_PIN = process.env.ENTRY_PIN || '1111';
const PURCHASE_PIN = process.env.PURCHASE_PIN || '3333';

// Update admin PIN to standard dev pin
const users = (adminCall('users.list').users || []);
const adminUser = users.find(u => u.name === 'Admin');
if (adminUser) {
  adminCall('users.save', { user_id: adminUser.user_id, name: 'Admin', role: 'admin', pin: ADMIN_PIN, active: 'Y' });
}

// Seed entry and purchase users
adminCall('users.save', { name: 'Ravi', role: 'entry', pin: ENTRY_PIN, active: 'Y' });
adminCall('users.save', { name: 'Purchase', role: 'purchase', pin: PURCHASE_PIN, active: 'Y' });

// Seed standard masters
const m = adminCall('masters.get');
const freeSizeSet = (m.sizeSets || []).find(s => s.name.includes('Free')) || (m.sizeSets || [])[0];
const standardSizeSet = (m.sizeSets || []).find(s => s.name.includes('S - XXL')) || (m.sizeSets || [])[0];

const s1 = adminCall('masters.save', { kind: 'supplier', item: { name: 'Sri Lakshmi Silks', city: 'Kanchipuram', agent: 'Nil', brand: 'MPS Silks', photo_required: true } });
const s2 = adminCall('masters.save', { kind: 'supplier', item: { name: 'Kanchi Weaves', city: 'Chennai', agent: 'Sundar', brand: 'MPS Silks', photo_required: false } });
const s3 = adminCall('masters.save', { kind: 'supplier', item: { name: 'Surat Fashion', city: 'Surat', agent: 'Nil', brand: 'Surat Trend', photo_required: false } });

adminCall('masters.save', { kind: 'brand', item: { name: 'MPS Silks' } });
adminCall('masters.save', { kind: 'brand', item: { name: 'Kanchi Royal' } });

if (freeSizeSet) {
  adminCall('masters.save', { kind: 'product', item: { name: 'Silk Saree', size_set: freeSizeSet.set_id } });
}
if (standardSizeSet) {
  adminCall('masters.save', { kind: 'product', item: { name: 'Shirt', size_set: standardSizeSet.set_id } });
}

// Ensure setting sheet_title is populated
adminCall('masters.save', { kind: 'settings', item: { sheet_title: 'MPS SILKS - KGF - Inventory Datasheet - (Readymade Product)', photo_mode: 'all', inactive_days: 90 } });

function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(json);
}

function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (req.method === 'GET') {
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const result = gas.get(query);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => {
      bodyStr += chunk;
      if (bodyStr.length > 50 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const result = gas.call(body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 200, { ok: false, code: 'SERVER_ERROR', error: 'Invalid JSON or server error: ' + err.message });
      }
    });
    return;
  }

  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}

function handlePhoto(req, res, photoId) {
  const file = gas.state.files && gas.state.files[photoId];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Photo not found');
  }

  const buf = Buffer.from(file.bytes, 'base64');
  res.writeHead(200, {
    'Content-Type': file.type || 'image/jpeg',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(buf);
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1:' + PORT);
  let pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(ROOT, '.' + pathname);
  // Security containment check
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*'
    };

    if (pathname === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const pathname = parsed.pathname || '';

  if (pathname === '/api') {
    return handleApi(req, res);
  }

  if (pathname.startsWith('/photo/')) {
    const photoId = pathname.replace('/photo/', '').trim();
    return handlePhoto(req, res, photoId);
  }

  return serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`MPS Silks dev server running at http://127.0.0.1:${PORT}`);
    console.log('App shell, /api mock backend and /photo/:id endpoint ready.');
    console.log('Dev accounts seeded: Admin (admin), Ravi (entry), Purchase (purchase).');
  });
}

module.exports = { server, gas };
