const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../app/src/main/assets/web/demand-files.js');
test('publishes metadata without reading File bytes; reset revokes the owner and clears retained files', async () => {
    const calls = [];
    const service = create({ context: () => ({ base: 'http://127.0.0.1:9527', token: 'token', roomId: 'room' }), sender: () => 'sender', fetch: async (url, init) => {
        calls.push({ url, init });
        const body = init.body && JSON.parse(init.body);
        return { ok: true, json: async () => body ? ({ files: body.files.map(f => ({ ...f, id: 'offer-id' })) }) : ({ jobs: [] }) };
    }, nativeUpload: () => { throw Error('must not upload before a download request'); } });
    try {
        const file = { name: '文件.txt', size: 123, type: 'text/plain', slice() { throw Error('must not read'); } };
        await service.publish([file], 'room');
        assert.equal(service.owns('offer-id'), true);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.scope, 'room'); assert.equal(body.files[0].size, 123);
        assert.equal(calls.some(c => c.url.includes('/transfer/')), false);
        await service.remove('offer-id'); assert.equal(service.owns('offer-id'), false);
        assert.equal(calls.at(-1).init.headers['X-Share-File'], 'offer-id');
    } finally { await service.reset(); }
});
