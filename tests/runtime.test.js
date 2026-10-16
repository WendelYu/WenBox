const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync('app/src/main/assets/web/runtime.js', 'utf8');

function setup({ native, browser, execResult = true, fetchImpl = fetch, documentExtra = {} } = {}) {
    const events = [];
    const active = {
        isConnected: true, selectionStart: 1, selectionEnd: 3, selectionDirection: 'forward',
        focus: () => events.push('restore-focus'),
        setSelectionRange: (...args) => events.push(['restore-input', ...args])
    };
    const selection = {
        rangeCount: 1, getRangeAt: () => ({ cloneRange: () => 'range' }),
        removeAllRanges: () => events.push('clear-ranges'),
        addRange: value => events.push(['restore-range', value])
    };
    const field = {
        style: {}, setAttribute() {}, focus: () => events.push('focus'),
        select: () => events.push('select'), setSelectionRange() {},
        remove: () => events.push('remove')
    };
    const context = {
        window: { __TAURI__: native ? { clipboard: { writeText: native } } : undefined, getSelection: () => selection },
        navigator: { clipboard: browser ? { writeText: browser } : undefined },
        document: {
            activeElement: active, createElement: () => field,
            body: { appendChild() {} }, execCommand: () => { events.push(['copy', field.value]); return execResult; },
            ...documentExtra
        },
        fetch: fetchImpl, AbortController, Response, setTimeout, clearTimeout
    };
    vm.runInNewContext(source, context);
    return { ...context.window.WenBox, events, window: context.window, document: context.document };
}

test('Mac native clipboard succeeds without a browser clipboard API', async () => {
    let copied;
    const api = setup({ native: async value => { copied = value; } });
    await api.copyText('中文消息\n  indentation 🚀');
    assert.equal(copied, '中文消息\n  indentation 🚀');
    assert.deepEqual(api.events, []);
});

test('LAN HTTP fallback preserves Unicode, focus and selection', async () => {
    const api = setup();
    await api.copyText('第一行\n  第二行');
    assert.ok(api.events.some(e => Array.isArray(e) && e[0] === 'copy' && e[1] === '第一行\n  第二行'));
    assert.ok(api.events.includes('remove'));
    assert.ok(api.events.includes('restore-focus'));
    assert.ok(api.events.some(e => Array.isArray(e) && e[0] === 'restore-input' && e[1] === 1 && e[2] === 3));
});

test('WebKit clipboard rejection falls back to selection copy', async () => {
    const api = setup({ browser: async () => { throw new Error('NotAllowedError'); } });
    await api.copyText('fallback');
    assert.ok(api.events.some(e => Array.isArray(e) && e[0] === 'copy'));
});

test('copy failure rejects and still removes temporary selection', async () => {
    const api = setup({ execResult: false });
    await assert.rejects(api.copyText('fail'), /剪贴板不可用/);
    assert.ok(api.events.includes('remove'));
    assert.ok(api.events.includes('restore-focus'));
});

test('Electron clipboard adapter is used when there is no Tauri bridge', async () => {
    const api = setup();
    let copied;
    api.window.wenboxDesktop = { writeText: async value => { copied = value; } };
    await api.copyText('electron');
    assert.equal(copied, 'electron');
});

test('overlapping refreshes share one request and recover after rejection', async () => {
    const api = setup();
    let calls = 0, reject;
    const task = api.singleFlight(() => { calls++; return new Promise((_, r) => { reject = r; }); });
    const first = task(), second = task();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    reject(new Error('offline'));
    await assert.rejects(first, /offline/);
    const next = task();
    await Promise.resolve();
    assert.equal(calls, 2);
    reject(new Error('again'));
    await assert.rejects(next, /again/);
});

test('heartbeat-only changes skip rendering; file and room changes redraw', () => {
    const api = setup(), container = {};
    assert.equal(api.listChanged(container, [{ id: 'a', name: 'a.txt', lastSeen: 1 }], 'room-a'), true);
    assert.equal(api.listChanged(container, [{ id: 'a', name: 'a.txt', lastSeen: 2 }], 'room-a'), false);
    assert.equal(api.listChanged(container, [{ id: 'a', name: 'b.txt', lastSeen: 2 }], 'room-a'), true);
    assert.equal(api.listChanged(container, [{ id: 'a', name: 'b.txt', lastSeen: 2 }], 'room-b'), true);
});

test('stalled LAN requests abort and release refresh locks', async () => {
    const api = setup({ fetchImpl: (_, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    await assert.rejects(api.fetchWithTimeout('/api/status', {}, 10), /aborted/);
});

test('response bodies and HTTP error codes survive deadline adapter', async () => {
    const api = setup({ fetchImpl: async () => new Response('{"message":"invalid token"}', { status: 403 }) });
    const response = await api.fetchWithTimeout('/api/messages');
    assert.equal(response.status, 403);
    assert.equal(response.ok, false);
    assert.deepEqual(await response.json(), { message: 'invalid token' });
});

test('empty success responses remain valid', async () => {
    const api = setup({ fetchImpl: async () => new Response(null, { status: 204 }) });
    const response = await api.fetchWithTimeout('/api/room/heartbeat');
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
});

test('Electron preload works with sandbox-only modules and exposes one text IPC method', async () => {
    let exposed, args;
    const ipcRenderer = { invoke: async (...value) => { args = value; } };
    vm.runInNewContext(readFileSync('preload.js', 'utf8'), {
        require: name => {
            assert.equal(name, 'electron');
            return { ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => {
                assert.equal(key, 'wenboxDesktop'); exposed = value;
            } } };
        }
    });
    assert.deepEqual(Object.keys(exposed), ['writeText']);
    await exposed.writeText('中文消息');
    assert.deepEqual(args, ['wenbox:copy-text', '中文消息']);
});


test('503 responses are retried with exponential backoff', async () => {
    let calls = 0;
    const api = setup({ fetchImpl: async () => {
        calls++;
        return calls < 3 ? new Response('busy', { status: 503 }) : new Response('{"ok":true}', { status: 200 });
    } });
    const response = await api.fetchWithTimeout('/api/status', {}, 4000, 2, 0);
    assert.equal(response.status, 200, '第三次尝试应成功');
    assert.equal(calls, 3, '应重试 2 次');
    assert.deepEqual(await response.json(), { ok: true });
});

test('503 is returned after the retry budget is exhausted', async () => {
    let calls = 0;
    const api = setup({ fetchImpl: async () => { calls++; return new Response('busy', { status: 503 }); } });
    const response = await api.fetchWithTimeout('/api/status', {}, 4000, 1, 0);
    assert.equal(response.status, 503);
    assert.equal(calls, 2, 'retries=1 时最多请求 2 次');
});

test('non-503 errors are not retried', async () => {
    let calls = 0;
    const api = setup({ fetchImpl: async () => { calls++; return new Response('nope', { status: 401 }); } });
    const response = await api.fetchWithTimeout('/api/files');
    assert.equal(response.status, 401);
    assert.equal(calls, 1);
});

function fakeClock() {
    let current = 0;
    const timers = [];
    return {
        now: () => current,
        timers,
        // 假定时器：立刻返回，由测试推进时钟后手动触发
        setTimeout: fn => { timers.push(fn); return timers.length; },
        clearTimeout: () => {},
        advance(ms) { current += ms; }
    };
}

test('scheduler runs registered tasks repeatedly and stops on dispose', async () => {
    const api = setup();
    const clock = fakeClock();
    const scheduler = api.createScheduler(clock);
    let runs = 0;
    scheduler.add('messages', 10, () => { runs++; });
    assert.equal(clock.timers.length, 1, '注册任务后应启动一个定时器');

    clock.advance(10);
    await clock.timers[0]();
    assert.equal(runs, 1);

    clock.advance(10);
    await clock.timers[clock.timers.length - 1]();
    assert.equal(runs, 2, '定时器应持续调度');
    scheduler.dispose();
});

test('scheduler skips tasks whose interval has not elapsed', async () => {
    const api = setup();
    const clock = fakeClock();
    const scheduler = api.createScheduler(clock);
    let runs = 0;
    scheduler.add('messages', 100, () => { runs++; });
    await clock.timers[0](); // 时钟未推进，任务尚未到期
    assert.equal(runs, 0, '未到期不应执行');
    clock.advance(100);
    await clock.timers[clock.timers.length - 1]();
    assert.equal(runs, 1);
    scheduler.dispose();
});

test('scheduler pauses polling while the tab is hidden', async () => {
    const api = setup();
    let hidden = false;
    api.document.hidden = false;
    Object.defineProperty(api.document, 'hidden', { get: () => hidden, configurable: true });
    const clock = fakeClock();
    const scheduler = api.createScheduler(clock);
    let runs = 0;
    scheduler.add('messages', 10, () => { runs++; });

    clock.advance(10);
    await clock.timers[0]();
    assert.equal(runs, 1);

    hidden = true;
    const before = clock.timers.length;
    clock.advance(10);
    await clock.timers[before - 1]();
    assert.equal(runs, 1, '后台标签页不应继续轮询');
    assert.ok(clock.timers.length > before, '隐藏时仍应保持定时器以便恢复');

    hidden = false;
    clock.advance(10);
    await clock.timers[clock.timers.length - 1]();
    assert.equal(runs, 2, '回到前台后应恢复轮询');
    scheduler.dispose();
});

test('scheduler bump discards in-flight polling state', () => {
    const api = setup();
    const clock = fakeClock();
    const scheduler = api.createScheduler(clock);
    const before = scheduler.revision;
    scheduler.bump();
    assert.equal(scheduler.revision, before + 1, '房间切换应递增 revision');
    scheduler.dispose();
    assert.equal(scheduler.revision, before + 1);
});
