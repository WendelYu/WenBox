// Shared adapters for desktop WebViews and plain HTTP LAN browsers.
(function () {
    async function copyText(value) {
        const text = String(value ?? '');
        const nativeClipboard = window.__TAURI__?.clipboard || window.wenboxDesktop;
        if (nativeClipboard?.writeText) {
            try {
                await nativeClipboard.writeText(text);
                return;
            } catch (_) { /* Try the browser adapter if the native bridge is unavailable. */ }
        }
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (_) { /* WebKit permissions and insecure origins need the selection fallback. */ }
        }

        const active = document.activeElement;
        const selection = window.getSelection();
        const ranges = [];
        for (let i = 0; selection && i < selection.rangeCount; i++) {
            ranges.push(selection.getRangeAt(i).cloneRange());
        }
        const inputSelection = active && typeof active.selectionStart === 'number'
            ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        const field = document.createElement('textarea');
        field.value = text;
        field.readOnly = true;
        field.setAttribute('aria-label', '复制内容');
        // Keep it selectable in Safari; display:none and visibility:hidden cannot be copied.
        field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
        document.body.appendChild(field);
        try {
            field.focus({ preventScroll: true });
            field.select();
            field.setSelectionRange(0, text.length);
            if (!document.execCommand('copy')) throw new Error('剪贴板不可用');
        } finally {
            field.remove();
            if (active?.isConnected) active.focus({ preventScroll: true });
            if (inputSelection) active.setSelectionRange(...inputSelection);
            if (selection) {
                selection.removeAllRanges();
                ranges.forEach(range => selection.addRange(range));
            }
        }
    }

    // Share an existing request instead of queuing duplicate timer / manual refresh calls.
    function singleFlight(task) {
        let pending = null;
        return function (...args) {
            if (pending) return pending;
            pending = Promise.resolve().then(() => task.apply(this, args))
                .finally(() => { pending = null; });
            return pending;
        };
    }

    // 服务端线程池满时返回 503：做 2 次指数退避重试，避免前端把瞬时过载显示成失败。
    async function fetchWithTimeout(url, options = {}, timeout = 4000, retries = 2, backoffMs = 400) {
        let attempt = 0;
        for (;;) {
            const response = await fetchOnce(url, options, timeout);
            if (response.status !== 503 || attempt >= retries) return response;
            await new Promise(resolve => setTimeout(resolve, backoffMs * Math.pow(2, attempt)));
            attempt++;
        }
    }

    function nativeInvoke(command, args) {
        const invoke = window.__TAURI__?.invoke?.bind(window.__TAURI__) || window.__TAURI_INVOKE__;
        return invoke(command, args);
    }
    function needsNativeTransport() {
        return !!(window.__TAURI__?.invoke || window.__TAURI_INVOKE__)
            && (window.location?.protocol === 'tauri:' || window.location?.hostname === 'tauri.localhost');
    }
    function nativeApiUrl(url) { return needsNativeTransport() && /^http:\/\//i.test(String(url)) && new URL(url).pathname.startsWith('/api/'); }
    async function nativeResponse(url, options = {}, image = false) {
        const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
        const result = await nativeInvoke('native_request', { url: String(url), method: options.method || 'GET', headers,
            body: options.body == null ? null : String(options.body), image });
        const bytes = Uint8Array.from(atob(result.body), c => c.charCodeAt(0));
        return new Response([204, 205, 304].includes(result.status) ? null : bytes, { status: result.status, headers: result.headers });
    }
    let activeImages = 0;
    const imageWaiters = [];
    async function resolveRequestUrl(url) {
        if (!nativeApiUrl(url)) return url;
        if (activeImages >= 3) await new Promise(resolve => imageWaiters.push(resolve));
        else activeImages++;
        try {
        const response = await nativeResponse(url, {}, true);
        if (!response.ok) throw new Error(`图片加载失败（HTTP ${response.status}）`);
        const type = (response.headers.get('content-type') || '').split(';')[0];
        if (!type.startsWith('image/')) throw new Error('文件不是可预览的图片');
        const bytes = new Uint8Array(await response.arrayBuffer());
        return 'data:' + type + ';base64,' + encodeBytes(bytes);
        } finally {
            const next = imageWaiters.shift();
            if (next) next(); else activeImages--;
        }
    }
    function encodeBytes(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
    }
    async function nativeUpload(file, context, onProgress, signal) {
        let id, timer;
        const check = () => { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); };
        const cancel = () => { if (id) nativeInvoke('native_upload_cancel', { id }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            check();
            id = await nativeInvoke('native_upload_begin', { url: context.url, name: file.name, size: file.size, token: context.token || null });
            check(); onProgress(0, file.size, 'preparing');
            for (let offset = 0; offset < file.size; offset += 512 * 1024) {
                check();
                const bytes = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
                check();
                await nativeInvoke('native_upload_chunk', { id, offset, bytes: encodeBytes(bytes) });
            }
            check();
            onProgress(0, file.size, 'uploading');
            timer = setInterval(() => nativeInvoke('native_upload_progress', { id }).then(loaded => { if (!signal.aborted) onProgress(loaded, file.size); }).catch(() => {}), 250);
            const result = await nativeInvoke('native_upload_finish', { id });
            check(); onProgress(file.size, file.size); return result;
        } finally {
            clearInterval(timer); signal.removeEventListener('abort', cancel); cancel();
        }
    }
    async function fetchOnce(url, options = {}, timeout = 4000) {
        if (nativeApiUrl(url)) {
            const signal = options.signal;
            if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
            let timer, abort;
            try {
                return await Promise.race([nativeResponse(url, options), new Promise((_, reject) => {
                    abort = () => reject(new DOMException('已取消', 'AbortError'));
                    signal?.addEventListener('abort', abort, { once: true });
                    timer = setTimeout(() => reject(new Error('请求超时')), timeout);
                })]);
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        }
        if (options.signal) return fetch(url, options);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            // Consume inside the timeout, including stalled response bodies.
            const body = await response.blob();
            return new Response([204, 205, 304].includes(response.status) ? null : body, {
                status: response.status, statusText: response.statusText, headers: response.headers
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 单一调度器：所有轮询共用一个定时器注册表。
     * - document.hidden 时整体暂停，后台标签页不再空转请求；
     * - 页面重新可见时立即补跑一次，保证数据不过期；
     * - 房间切换时递增 revision，过期响应可以直接丢弃。
     */
    function createScheduler(options = {}) {
        // 允许注入定时器实现，便于在 Node 测试环境中用假定时器驱动调度逻辑
        const setTimer = options.setTimeout || setTimeout;
        const clearTimer = options.clearTimeout || clearTimeout;
        const now = options.now || (() => Date.now());
        const tasks = new Map();
        let timer = null;
        let revision = 0;
        let running = false;

        function schedule(delay) {
            if (timer !== null || running || tasks.size === 0 || (typeof document !== 'undefined' && document.hidden)) return;
            const interval = Math.min(...[...tasks.values()].map(t => t.interval));
            timer = setTimer(async () => {
                timer = null;
                if (typeof document !== 'undefined' && document.hidden) return;
                running = true;
                const current = revision;
                try {
                    // A slow file request must not hold up heartbeats or chat polling.
                    await Promise.allSettled([...tasks.values()].filter(task => task.due()).map(async task => {
                        if (current === revision) await task.run();
                    }));
                } finally { running = false; schedule(); }
            }, delay ?? interval);
        }

        return {
            add(name, interval, run) {
                tasks.set(name, {
                    interval,
                    run,
                    next: now() + interval,
                    due() {
                        if (now() < this.next) return false;
                        this.next = now() + this.interval;
                        return true;
                    }
                });
                schedule();
            },
            remove(name) {
                tasks.delete(name);
            },
            /** 房间切换时调用：丢弃所有在途响应 */
            bump() {
                revision++;
                for (const task of tasks.values()) task.next = now();
            },
            get revision() {
                return revision;
            },
            runNow() {
                for (const task of tasks.values()) task.next = 0;
                if (timer !== null) clearTimer(timer);
                timer = null;
                schedule(0);
            },
            pause() {
                if (timer !== null) clearTimer(timer);
                timer = null;
            },
            dispose() {
                tasks.clear();
                if (timer !== null) clearTimer(timer);
                timer = null;
            }
        };
    }

    const renderKeys = new WeakMap();
    function listChanged(container, entries, context = '') {
        if (!container) return false;
        // Volatile heartbeat timestamps do not affect the rendered list.
        const key = context + JSON.stringify(entries, (name, value) =>
            name === 'lastSeen' || name === 'last_seen' ? undefined : value);
        if (renderKeys.get(container) === key) return false;
        renderKeys.set(container, key);
        return true;
    }

    // 页面重新可见时立刻补跑，避免用户切回来看到过期数据
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (!window.WenBox?.scheduler) return;
            if (document.hidden) window.WenBox.scheduler.pause();
            else window.WenBox.scheduler.runNow();
        });
    }

    window.WenBox = {
        copyText,
        resolveRequestUrl,
        needsNativeTransport,
        nativeUpload,
        singleFlight,
        fetchWithTimeout,
        fetchOnce,
        listChanged,
        createScheduler,
        scheduler: createScheduler()
    };
})();
