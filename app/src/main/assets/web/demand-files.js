/* Metadata-only publication. File bytes stay with their owner until requested. */
(function (root) {
    'use strict';
    function create(options) {
        const files = new Map(), uploads = new Map();
        let session = null, timer = null, polling = false, repoll = false, generation = 0;
        const key = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
        const uuid = () => {
            const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
            const h = Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
            return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
        };
        async function request(ctx, path, init = {}) {
            const response = await options.fetch(ctx.base + path, { ...init, headers: { 'X-Room-Token': ctx.token || '', 'X-Share-Key': ctx.key, ...init.headers } });
            if (!response.ok) {
                if (response.status === 404) throw new Error('房主版本不支持按需分享，请更新房主客户端');
                let message = '';
                try {
                    const body = await response.json();
                    if (typeof body?.message === 'string') message = body.message.trim();
                } catch (_) { /* Non-JSON responses still retain the HTTP status. */ }
                throw new Error(`分享请求失败 (${response.status})${message ? '：' + message : ''}`);
            }
            return response.json();
        }
        async function rawUpload(file, ctx, job, controller) {
            const context = { url: ctx.base + '/api/offers/transfer/' + job.requestId + '/' + job.secret, token: ctx.token };
            if (file.nativeP2p && options.p2pRelayUpload) {
                return options.p2pRelayUpload(file.shareId, context.url, ctx.token, controller.signal);
            }
            if (file.forTransfer) file = file.forTransfer();
            if (options.nativeUpload) return options.nativeUpload(file, context, () => {}, controller.signal);
            if (file.virtualEncrypted) {
                const parts = [];
                for (let offset=0; offset<file.size; offset+=1024*1024) {
                    if (controller.signal.aborted) throw new DOMException('已取消','AbortError');
                    parts.push(await file.slice(offset,offset+1024*1024).arrayBuffer());
                }
                file = new Blob(parts, {type:'application/octet-stream'});
            }
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', context.url);
                xhr.setRequestHeader('X-Room-Token', ctx.token || '');
                xhr.timeout = 10 * 60 * 1000;
                const abort = () => xhr.abort();
                controller.signal.addEventListener('abort', abort, { once: true });
                xhr.onloadend = () => controller.signal.removeEventListener('abort', abort);
                xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('文件传输中断'));
                xhr.onerror = xhr.ontimeout = () => reject(new Error('文件传输失败'));
                xhr.onabort = () => reject(new Error('文件分享已取消'));
                xhr.send(file);
            });
        }
        async function poll() {
            if (!session || !files.size) return;
            if (polling) { repoll = true; return; }
            polling = true;
            const ctx = session, current = generation;
            const latest = options.context();
            if (latest.roomId === ctx.roomId && latest.base === ctx.base) ctx.token = latest.token;
            try {
                const result = await request(ctx, '/api/offers/requests');
                if (current !== generation) return;
                for (const job of result.jobs || []) {
                    const entry = files.get(job.clientId);
                    if (!entry || uploads.has(job.requestId)) continue;
                    const controller = new AbortController(); uploads.set(job.requestId, controller);
                    rawUpload(entry.file, ctx, job, controller).catch(error => { if (!controller.signal.aborted) options.error?.(error); }).finally(() => uploads.delete(job.requestId));
                }
            } catch (_) { /* Network recovery is automatic; no repeated toast. */ }
            finally {
                polling = false;
                if (repoll) {
                    repoll = false;
                    poll();
                }
            }
        }
        async function reset() {
            const old = session;
            generation++; session = null; files.clear();
            clearInterval(timer); timer = null;
            for (const controller of uploads.values()) controller.abort();
            uploads.clear();
            try { await options.revokeP2p?.(null); } catch (_) {}
            if (!old) return;
            try {
                const headers = { 'X-Room-Token': old.token || '', 'X-Share-Key': old.key };
                const response = await options.fetch(old.base + '/api/offers/detach', { method: 'POST', headers }, 1800, 0);
                if (response.status === 404) await request(old, '/api/offers/revoke', { method: 'POST' });
            } catch (_) { /* The host also expires disconnected senders. */ }
        }
        return {
            async publish(list, scope) {
                const ctx = options.context();
                if (session && (session.roomId !== ctx.roomId || session.base !== ctx.base)) await reset();
                if (!session) session = { ...ctx, key: key() };
                session.token = ctx.token;
                const current = generation, active = session;
                const entries = Array.from(list, file => ({
                    file: file?.nativeP2p ? file : (options.prepare ? options.prepare(file, ctx) : file),
                    original: file,
                    clientId: uuid()
                }));
                if (!entries.length) return [];
                if (entries.length > 32) throw new Error('每次最多分享 32 个文件');
                const buildMetadata = (includeDirect) => entries.map(e => {
                    const item = {
                        clientId: e.clientId,
                        name: e.file.name,
                        size: e.file.size,
                        mimeType: e.file.mimeType || e.original.type || 'application/octet-stream'
                    };
                    if (e.file.virtualEncrypted || e.file.encrypted) {
                        item.plainSize = e.file.plainSize ?? e.original.size;
                        item.encrypted = true;
                    }
                    if (includeDirect && Array.isArray(e.file.directUrls) && e.file.directUrls.length && e.file.directSecret) {
                        item.directUrls = e.file.directUrls;
                        item.directSecret = e.file.directSecret;
                    }
                    return item;
                });
                const hasDirect = entries.some(e => Array.isArray(e.file.directUrls) && e.file.directUrls.length && e.file.directSecret);
                let response;
                try {
                    response = await request(active, '/api/offers', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ownerKey: active.key, senderName: options.sender(), scope, files: buildMetadata(true) })
                    });
                } catch (err) {
                    // Older hosts with deny_unknown_fields reject directUrls/directSecret; retry cleanly without P2P metadata while preserving encryption metadata.
                    if (hasDirect && /\(400\)/.test(String(err?.message || ''))) {
                        response = await request(active, '/api/offers', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ownerKey: active.key, senderName: options.sender(), scope, files: buildMetadata(false) })
                        });
                    } else {
                        throw err;
                    }
                }
                if (current !== generation) { await request(active, '/api/offers/revoke', { method: 'POST' }); return []; }
                for (const offer of response.files || []) {
                    const entry = entries.find(e => e.clientId === offer.clientId);
                    if (entry) files.set(offer.clientId, { ...entry, id: offer.id });
                }
                if (!timer) timer = setInterval(poll, 400);
                poll();
                return response.files || [];
            },
            owns(id) { return Array.from(files.values()).some(e => e.id === id); },
            async remove(id) {
                if (!session) return;
                await request(session, '/api/offers/revoke', { method: 'POST', headers: { 'X-Share-File': id } });
                for (const [key, entry] of files) {
                    if (entry.id === id) {
                        if (entry.file?.nativeP2p && entry.file.shareId) {
                            try { await options.revokeP2p?.(entry.file.shareId); } catch (_) {}
                        }
                        files.delete(key);
                    }
                }
            },
            nudge() { poll(); },
            reset
        };
    }
    root.WenBoxDemandFiles = { create };
    if (typeof module !== 'undefined') module.exports = { create };
})(typeof window === 'undefined' ? globalThis : window);
