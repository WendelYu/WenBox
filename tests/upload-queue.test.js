const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup({ sendNative } = {}) {
    const requests = [], completed = [], timers = [];
    class XHR {
        constructor() { this.handlers = {}; this.upload = { addEventListener() {} }; requests.push(this); }
        addEventListener(type, handler) { this.handlers[type] = handler; }
        open(method, url) { this.url = url; }
        setRequestHeader(key, value) { this.token = value; }
        send(body) { this.body = body; }
        abort() { this.aborted = true; this.handlers.abort(); }
        finish(status = 200, data = { success: true, fileId: 'uploaded-id' }) {
            this.status = status; this.responseText = JSON.stringify(data); this.handlers.load();
        }
    }
    const context = { FormData, AbortController, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
    vm.runInNewContext(readFileSync('app/src/main/assets/web/upload-queue.js', 'utf8'), context);
    const queue = context.WenBox.createUploadQueue({ createXHR: () => new XHR(), concurrency: 2, sendNative, onComplete: (...args) => completed.push(args) });
    const add = (name = '中文 | sample.txt', extra = {}) => {
        const file = new Blob(['hello']); file.name = name;
        return queue.enqueue(file, { url: '/api/upload', token: 'room-token', revision: 1, ...extra });
    };
    return { queue, add, requests, completed, timers };
}

test('queue limits concurrency and cancelling one file leaves the others running', () => {
    const { queue, add, requests } = setup();
    const ids = [add(), add(), add()];
    assert.equal(requests.length, 2);
    queue.cancel(ids[0]);
    assert.equal(requests[0].aborted, true);
    assert.equal(queue.getState(ids[0]), 'cancelled');
    assert.equal(requests.length, 3);
    assert.equal(queue.getState(ids[1]), 'uploading');
    assert.equal(queue.getState(ids[2]), 'uploading');
});

test('queued cancellation prevents sending that file when capacity opens', () => {
    const { queue, add, requests } = setup();
    add(); add(); const third = add(); queue.cancel(third);
    requests[0].finish();
    assert.equal(requests.length, 2);
    assert.equal(queue.getState(third), 'cancelled');
});

test('failed uploads can retry with their captured endpoint and credentials', async () => {
    const { queue, add, requests, completed } = setup();
    const id = add('report.txt', { url: 'http://192.168.1.8/api/upload' });
    requests[0].finish(503);
    assert.equal(queue.getState(id), 'failed'); assert.equal(completed.length, 0);
    queue.retry(id);
    assert.equal(requests[1].url, 'http://192.168.1.8/api/upload');
    assert.equal(requests[1].token, 'room-token');
    requests[1].finish();
    await Promise.resolve();
    assert.equal(queue.getState(id), 'done'); assert.equal(completed.length, 1);
});

test('room switch aborts active uploads and never starts pending files or publishes stale cards', () => {
    const { queue, add, requests, completed, timers } = setup();
    const ids = [add(), add(), add()]; queue.clear();
    requests[0].finish(); requests[1].finish(); timers.forEach(fn => fn());
    assert.equal(requests.length, 2); assert.equal(completed.length, 0);
    ids.forEach(id => assert.equal(queue.getState(id), undefined));
    const fresh = add(); assert.equal(queue.getState(fresh), 'uploading');
});

test('empty files succeed but a 200 response without a file id does not publish a broken card', async () => {
    const { queue, add, requests, completed } = setup();
    const empty = new Blob([]); empty.name = 'empty.txt';
    const id = queue.enqueue(empty, { url: '/api/upload' });
    assert.equal(requests[0].body.get('file').size, 0);
    requests[0].finish(200, { success: true });
    assert.equal(queue.getState(id), 'failed'); assert.equal(completed.length, 0);
    queue.retry(id); requests[1].finish(200, { success: true, fileId: 'empty-file', size: 0 });
    await Promise.resolve();
    assert.equal(queue.getState(id), 'done'); assert.equal(completed.length, 1);
});

test('native queue preserves captured credentials and cancels without publishing late completion', async () => {
    const pending = [];
    const { queue, add, requests, completed } = setup({ sendNative: (file, context, progress, signal) => new Promise(resolve => pending.push({ file, context, progress, signal, resolve })) });
    const id = add('截图.png', { url: 'http://169.254.1.2:9527/api/upload', token: 'private-token' });
    assert.equal(requests.length, 0);
    assert.equal(pending[0].context.token, 'private-token');
    queue.cancel(id); assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve({ success: true, fileId: 'late' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.length, 0);
    queue.retry(id);
    assert.equal(pending[1].context.url, 'http://169.254.1.2:9527/api/upload');
    pending[1].resolve({ success: true, fileId: 'retry' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.getState(id), 'done'); assert.equal(completed.length, 1);
});
