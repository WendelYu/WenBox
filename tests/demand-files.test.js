const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../app/src/main/assets/web/demand-files.js');

function fixture(fetch, extra = {}) {
    return create({
        context: () => ({ base: 'http://127.0.0.1:9527', token: 'token', roomId: 'room' }),
        sender: () => 'sender', fetch, ...extra
    });
}

test('plain files remain compatible with hosts that reject encryption metadata', async () => {
    let published = false;
    const service = fixture(async (url, init) => {
        if (url.endsWith('/api/offers')) {
            const body = JSON.parse(init.body);
            const allowed = ['clientId', 'name', 'size', 'mimeType'];
            if (body.files.some(file => Object.keys(file).some(key => !allowed.includes(key)))) {
                return new Response(JSON.stringify({ message: '分享信息格式无效' }), { status: 400 });
            }
            published = true;
            return Response.json({ files: body.files.map(file => ({ ...file, id: 'legacy-offer' })) });
        }
        return Response.json({ jobs: [] });
    });
    try {
        await service.publish([new File(['hello'], '测试.txt')], 'room');
        assert.equal(published, true);
        assert.equal(service.owns('legacy-offer'), true);
    } finally { await service.reset(); }
});

test('encrypted shares retain wire and plain sizes without a plaintext fallback on rejection', async () => {
    const bodies = [];
    const service = fixture(async (url, init) => {
        if (!url.endsWith('/api/offers')) return Response.json({ jobs: [] });
        bodies.push(JSON.parse(init.body));
        return Response.json({ message: '分享信息格式无效' }, { status: 400 });
    }, { prepare: file => ({ name: file.name, size: file.size + 61, virtualEncrypted: true }) });
    try {
        await assert.rejects(service.publish([new File(['hello'], '测试.txt')], 'room'), /分享请求失败 \(400\)：分享信息格式无效/);
        assert.equal(bodies.length, 1, 'never retry with unencrypted file metadata');
        assert.equal(bodies[0].files[0].encrypted, true);
        assert.equal(bodies[0].files[0].plainSize, 5);
        assert.equal(bodies[0].files[0].size, 66);
    } finally { await service.reset(); }
});

test('failed shares show the host reason and safely handle non-JSON errors', async () => {
    for (const [status, body, expected] of [
        [400, JSON.stringify({ message: '房间分享文件过多，请先移除不需要的分享' }), '分享请求失败 (400)：房间分享文件过多，请先移除不需要的分享'],
        [401, JSON.stringify({ message: '请重新加入房间' }), '分享请求失败 (401)：请重新加入房间'],
        [400, '<html>Bad Request</html>', '分享请求失败 (400)'],
        [400, 'null', '分享请求失败 (400)'],
        [400, JSON.stringify({ message: {} }), '分享请求失败 (400)'],
        [404, '{}', '房主版本不支持按需分享，请更新房主客户端']
    ]) {
        const service = fixture(async () => new Response(body, { status }));
        try {
            await assert.rejects(service.publish([new File(['hello'], 'test.txt')], 'room'), { message: expected });
        } finally { await service.reset(); }
    }
});

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
