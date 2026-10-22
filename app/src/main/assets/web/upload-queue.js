// Classic-script factory also works in Electron's file:// renderer and older Android WebViews.
(function (root) {
    function createUploadQueue({ container, history, count, onComplete, createXHR = () => new XMLHttpRequest(), now = () => Date.now(), concurrency = 3 }) {
        const items = new Map();
        let serial = 0, active = 0, generation = 0;
        const bytes = value => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
        function render(item) {
            if (!item.row) return;
            const pending = ['queued', 'uploading'].includes(item.state);
            item.row.dataset.state = item.state;
            const status = item.row.querySelector('.upload-status');
            const progress = item.row.querySelector('progress');
            progress.value = item.state === 'done' ? 1 : item.total ? item.loaded / item.total : 0;
            const phase = item.row.querySelector('.upload-phase');
            if (phase) phase.textContent = ({ queued: '排队中', uploading: item.loaded >= item.total && item.total > 0 ? '确认中' : `${Math.round(progress.value * 100)}%`, done: '已送达', cancelled: '已取消', failed: '未送达' })[item.state];
            const elapsed = Math.max((now() - item.started) / 1000, .001);
            const speed = item.loaded / elapsed;
            const remaining = speed ? Math.ceil((item.total - item.loaded) / speed) : 0;
            status.textContent = ({ queued: '等待发送', done: '已发送', cancelled: '已取消', failed: item.error })[item.state]
                || (item.total > 0 && item.loaded >= item.total ? '上传完成，等待对方确认接收…' : `${bytes(item.loaded)} / ${bytes(item.total)} · ${bytes(speed)}/s · 剩余 ${remaining} 秒`);
            const button = item.row.querySelector('button');
            button.hidden = item.state === 'done';
            button.textContent = pending ? '取消' : '重试';
            button.dataset.action = pending ? 'cancel-upload' : 'retry-upload';
        }
        function settle(item, state, error) {
            if (item.state !== 'uploading') return;
            item.state = state; item.error = error; item.xhr = null;
            active--; render(item);
            if (state === 'done') {
                // Publish the card to the captured room only after the upload succeeds.
                Promise.resolve().then(() => onComplete?.(item.result, item.file, item.context)).catch(() => {
                    if (item.generation === generation && item.row) item.row.querySelector('.upload-status').textContent = '文件已送达，消息发送失败';
                });
                item.timer = setTimeout(() => {
                    if (item.generation !== generation) return;
                    if (history && item.row) history.prepend(item.row);
                    // Retain a bounded history rather than accumulating File objects indefinitely.
                    const completed = [...items.values()].filter(i => i.state === 'done');
                    if (completed.length > 50) {
                        const oldest = completed[0]; oldest.row?.remove(); items.delete(oldest.id);
                    }
                    if (count) count.textContent = String([...items.values()].filter(i => i.state === 'done').length);
                    item.file = null;
                }, 3000);
            }
            pump();
        }
        function start(item) {
            item.state = 'uploading'; item.started = now(); active++;
            try {
                const xhr = item.xhr = createXHR();
                xhr.upload.addEventListener('progress', event => {
                    if (item.state !== 'uploading' || !event.lengthComputable) return;
                    item.total = event.total; item.loaded = event.loaded; render(item);
                });
                xhr.addEventListener('load', () => {
                    if (xhr.status < 200 || xhr.status >= 300) return settle(item, 'failed', `发送失败（HTTP ${xhr.status}），请重试`);
                    try {
                        item.result = JSON.parse(xhr.responseText);
                        if (item.result.success === false || !(item.result.fileId || item.result.id)) throw new Error();
                        item.loaded = item.total;
                        settle(item, 'done');
                    } catch (_) { settle(item, 'failed', '服务端未确认文件，请重试'); }
                });
                xhr.addEventListener('error', () => settle(item, 'failed', '连接中断，请确认双方在线后重试'));
                xhr.addEventListener('abort', () => settle(item, 'cancelled'));
                xhr.addEventListener('timeout', () => settle(item, 'failed', '传输超时，请重试'));
                xhr.open('POST', item.context.url);
                if (item.context.token) xhr.setRequestHeader('X-Room-Token', item.context.token);
                const form = new FormData(); form.append('file', item.file, item.file.name);
                xhr.send(form); render(item);
            } catch (error) { settle(item, 'failed', String(error.message || error)); }
        }
        function pump() {
            for (const item of items.values()) {
                if (active >= concurrency) break;
                if (item.state === 'queued') start(item);
            }
        }
        function enqueue(file, context) {
            const item = { id: String(++serial), file, context: { ...context }, generation, state: 'queued', loaded: 0, total: file.size, started: now() };
            if (container) {
                item.row = document.createElement('div'); item.row.className = 'upload-row';
                item.row.innerHTML = '<div class="upload-title"><span class="truncate"></span><span class="upload-phase"></span><button type="button" class="btn btn--ghost btn--sm"></button></div><progress max="1" value="0" aria-label="文件发送进度"></progress><span class="upload-status text-2"></span>';
                item.row.querySelector('.truncate').textContent = file.name;
                item.row.querySelector('.truncate').title = file.name;
                item.row.querySelector('button').dataset.uploadId = item.id;
                container.appendChild(item.row);
            }
            items.set(item.id, item); render(item); pump(); return item.id;
        }
        function cancel(id) {
            const item = items.get(id); if (!item) return;
            if (item.state === 'queued') { item.state = 'cancelled'; render(item); }
            else if (item.state === 'uploading') { item.xhr?.abort(); settle(item, 'cancelled'); }
        }
        function retry(id) {
            const item = items.get(id);
            if (!item || !['failed', 'cancelled'].includes(item.state)) return;
            item.state = 'queued'; item.loaded = 0; item.total = item.file.size;
            render(item); pump();
        }
        function clear() {
            generation++;
            // Mark pending items before aborting, so abort cannot start another queued upload.
            for (const item of items.values()) {
                clearTimeout(item.timer);
                const xhr = item.xhr; item.state = 'cancelled'; xhr?.abort(); item.row?.remove();
            }
            items.clear(); active = 0; if (count) count.textContent = '0';
        }
        return { enqueue, cancel, retry, clear, getState: id => items.get(id)?.state };
    }
    root.WenBox = root.WenBox || {}; root.WenBox.createUploadQueue = createUploadQueue;
})(typeof window === 'undefined' ? globalThis : window);
