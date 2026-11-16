const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { apiRequest } = require('../api-debug-client');

test('desktop debug sends a real PATCH, preserves error response and does not follow redirects', async t => {
    const received = [];
    const server = http.createServer(async (req, res) => {
        const parts = []; for await (const p of req) parts.push(p);
        received.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: Buffer.concat(parts).toString() });
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/never' }); return res.end(); }
        res.writeHead(422, { 'Content-Type': 'application/json', 'X-Fixture': 'ok' }); res.end('{"message":"参数错误"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const input = { url: base + '/items?q=one&q=two', method: 'PATCH', headers: [{ name:'Authorization',value:'Bearer test' }], body:'{"name":"柜体"}', timeoutMs:2000 };
    const result = await apiRequest(input);
    assert.equal(result.status,422); assert.equal(JSON.parse(result.body).message,'参数错误');
    assert.deepEqual(received[0],{ method:'PATCH', path:'/items?q=one&q=two', auth:'Bearer test', body:input.body });
    assert.equal((await apiRequest({...input,url:base+'/redirect'})).status,302);
    assert.equal(received.length,2);
});
test('desktop debug validates protocol, timeout, body and request framing', async () => {
    const valid = { url:'http://127.0.0.1:1', method:'GET', headers:[], body:null, timeoutMs:1000 };
    for (const extra of [{url:'file:///private.txt'},{timeoutMs:0},{method:'CONNECT'},{body:'x'},{headers:[{name:'Content-Length',value:'100'}]},{headers:[{name:'X-Test',value:'x\r\ny'}]}]) await assert.rejects(apiRequest({...valid,...extra}));
});
test('desktop debug caps response memory and enforces the whole-request timeout', async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/stall') return;
        res.end(Buffer.alloc(4 * 1024 * 1024 + (req.url === '/large' ? 1 : 0), 120));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const input = { url: `http://127.0.0.1:${server.address().port}`, method: 'GET', headers: [], body: null, timeoutMs: 1000 };
    const large = await apiRequest({ ...input, url: input.url + '/large' });
    assert.equal(large.size, 4 * 1024 * 1024); assert.equal(large.truncated, true);
    const exact = await apiRequest({ ...input, url: input.url + '/exact' });
    assert.equal(exact.size, 4 * 1024 * 1024); assert.equal(exact.truncated, false);
    await assert.rejects(apiRequest({ ...input, url: input.url + '/stall' }), /超时/);
});
