const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startDesktopServer } = require('../desktop-server');

async function withServers(run) {
    const received = [];
    const backend = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': "script-src 'unsafe-inline'" });
        res.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : Buffer.from('backend'));
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const app = await startDesktopServer({ backendPort: backend.address().port });
    try { await run(app, received, backend); }
    finally { await app.close(); await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }); }
}
function request(origin, pathname, { headers = {}, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(origin);
        const req = http.request({ hostname: url.hostname, port: url.port, path: pathname, method, headers }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject); req.end(body);
    });
}
test('desktop serves offline assets with CSP, blocks traversal, rebinding and cross-site proxy access', () => withServers(async (app, received) => {
    const page = await request(app.origin, '/');
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /ui-state.js/);
    assert.match(page.headers['content-security-policy'], /script-src 'self';/);
    for (const asset of ['/ui-state.js', '/theme.js', '/workspace.css']) assert.equal((await request(app.origin, asset)).status, 200);
    for (const path of ['/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/%5c..%5cpackage.json']) assert.equal((await request(app.origin, path)).status, 403);
    assert.equal((await request(app.origin, '/api/files', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(app.origin, '/api/files', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(app.origin, '/api/files', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal(received.length, 0);
}));
test('desktop proxy preserves binary body, authorization and original renderer origin', () => withServers(async (app, received) => {
    const bytes = Buffer.from([0, 255, 31, 0, 128, 42]);
    const response = await request(app.origin, '/api/upload?name=a%20b', { method: 'POST', body: bytes, headers: { Origin: app.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Room-Token': 'room-token', 'Content-Length': bytes.length } });
    assert.equal(response.status, 200); assert.deepEqual(response.body, bytes);
    assert.equal(received[0].headers.origin, app.origin);
    assert.equal(received[0].headers['x-room-token'], 'room-token');
    assert.equal(received[0].url, '/api/upload?name=a%20b');
    assert.match(response.headers['content-security-policy'], /script-src 'self';/);
}));
test('desktop remains usable for tools when local transfer service is offline', () => withServers(async (app, _received, backend) => {
    await new Promise(resolve => backend.close(resolve));
    const response = await request(app.origin, '/api/status');
    assert.equal(response.status, 503);
    assert.match(response.body.toString(), /本机传输服务未运行/);
    assert.equal((await request(app.origin, '/')).status, 200);
}));
