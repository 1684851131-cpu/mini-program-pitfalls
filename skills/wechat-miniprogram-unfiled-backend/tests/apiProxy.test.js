/* Functional test: the published apiProxy actually relays, rejects and fails closed. */
const http = require('http');

const results = [];
const assert = (cond, msg) => {
  results.push([cond, msg]);
  console.log((cond ? '  ok - ' : '  FAIL - ') + msg);
};

(async () => {
  /* a tiny backend that echoes method/path/body/headers */
  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        path: req.url,
        method: req.method,
        proxyKey: req.headers['x-proxy-key'] || '',
        token: req.headers['x-token'] || '',
        body: body || null,
      }));
    });
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const port = backend.address().port;

  /* env must be set before require: the module reads it at load time */
  process.env.BACKEND_BASE = 'http://127.0.0.1:' + port;
  process.env.PROXY_KEY = 'test-secret';
  const fn = require('../assets/apiProxy.js');

  console.log('\n[1] GET relay');
  const r1 = await fn.main({ path: '/api/health', method: 'GET' });
  assert(r1.ok === true, 'relay reports ok');
  assert(r1.status === 200, 'upstream status passed through');
  assert(r1.json && r1.json.path === '/api/health', 'path reached the backend');
  assert(r1.json.proxyKey === 'test-secret', 'x-proxy-key injected');
  assert(r1.size > 0, 'size reported');

  console.log('\n[2] identity headers pass through');
  const r2 = await fn.main({ path: '/api/orders', method: 'GET', headers: { 'x-token': 'abc123' } });
  assert(r2.json.token === 'abc123', 'x-token forwarded untouched');

  console.log('\n[3] POST body');
  const r3 = await fn.main({ path: '/api/orders', method: 'POST', data: { a: 1 } });
  assert(r3.json.method === 'POST', 'method preserved');
  assert(r3.json.body === '{"a":1}', 'JSON body serialized');
  assert(r3.json.proxyKey === 'test-secret', 'key still injected');

  console.log('\n[4] path guards');
  const bad1 = await fn.main({ path: '/api/../etc/passwd', method: 'GET' });
  assert(bad1.error === 'BAD_PATH', 'traversal rejected');
  const bad2 = await fn.main({ path: '/admin', method: 'GET' });
  assert(bad2.error === 'BAD_PATH', 'non-/api/ path rejected');
  const bad3 = await fn.main({ path: 'api/health', method: 'GET' });
  assert(bad3.error === 'BAD_PATH', 'missing leading slash rejected');

  console.log('\n[5] fail-closed on missing config');
  delete require.cache[require.resolve('../assets/apiProxy.js')];
  delete process.env.PROXY_KEY;
  const fn2 = require('../assets/apiProxy.js');
  const closed = await fn2.main({ path: '/api/health', method: 'GET' });
  assert(closed.ok === false && closed.error === 'PROXY_KEY_MISSING', 'refuses to serve without PROXY_KEY');

  console.log('\n[6] timeout path exists');
  const slow = http.createServer(() => { /* never responds */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  process.env.BACKEND_BASE = 'http://127.0.0.1:' + slow.address().port;
  process.env.PROXY_KEY = 'test-secret';
  delete require.cache[require.resolve('../assets/apiProxy.js')];
  const fn3 = require('../assets/apiProxy.js');
  const t0 = Date.now();
  const timedOut = await fn3.main({ path: '/api/health', method: 'GET' });
  const elapsed = Date.now() - t0;
  assert(timedOut.ok === false, 'hung upstream reported as failure');
  assert(elapsed >= 19000 && elapsed <= 25000, 'upstream timeout ~20s (took ' + Math.round(elapsed / 1000) + 's)');

  backend.close();
  slow.close();

  const failed = results.filter(([c]) => !c);
  console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL PASS'));
  process.exit(failed.length ? 1 : 0);
})();
