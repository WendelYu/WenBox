import { emptyRequest, row, importText, prepareRequest } from './api-model.mjs';

const root = document.getElementById('tab-api');
if (root) {
    const $ = id => document.getElementById('api' + id);
    let state = emptyRequest(), parsed = null, parseTimer, response = null, sending = false;
    const history = [];
    const invoke = window.__TAURI__?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI_INVOKE__;
    const native = typeof invoke === 'function' || !!window.wenboxDesktop?.apiRequest;
    $('Transport').textContent = native ? '本机直连 · HTTP / HTTPS' : '浏览器模式 · 目标接口需允许 CORS';
    const note = (message, error = false) => { $('Notice').textContent = message; $('Notice').dataset.error = String(error); $('Notice').hidden = !message; };

    function read() {
        for (const [key, id] of Object.entries({ method: 'Method', url: 'Url', body: 'Body', bodyMode: 'BodyMode', bearer: 'Bearer', variables: 'Variables', timeout: 'Timeout' })) state[key] = $(id).value;
        return state;
    }
    function selectTab(tab) {
        for (const button of root.querySelectorAll('[data-api-tab]')) {
            const active = button.dataset.apiTab === tab;
            button.setAttribute('aria-selected', String(active)); button.classList.toggle('active', active);
            $(button.dataset.apiTab + 'Panel').hidden = !active;
        }
    }
    function renderRows(key, id) {
        const container = $(id); container.replaceChildren();
        state[key].forEach((entry, index) => {
            const line = document.createElement('div'); line.className = 'api-param-row';
            const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled; enabled.setAttribute('aria-label', `启用第 ${index + 1} 项`);
            enabled.addEventListener('change', () => { entry.enabled = enabled.checked; });
            const name = document.createElement('input'); name.value = entry.name; name.placeholder = '参数名'; name.setAttribute('aria-label', `${key} 参数名 ${index + 1}`);
            const value = document.createElement('input'); value.value = entry.value; value.placeholder = '值 / {{变量}}'; value.setAttribute('aria-label', `${key} 参数值 ${index + 1}`);
            for (const input of [name, value]) { input.spellcheck = false; input.autocomplete = 'off'; input.addEventListener('input', () => { entry.name = name.value; entry.value = value.value; }); }
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn--ghost btn--sm'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${entry.name || '第 ' + (index + 1) + ' 项'}`);
            remove.addEventListener('click', () => { state[key].splice(index, 1); renderRows(key, id); });
            line.append(enabled, name, value, remove); container.append(line);
        });
        if (!state[key].length) { const empty = document.createElement('p'); empty.className = 'api-hint'; empty.textContent = '暂无参数，点击下方添加，或粘贴导入。'; container.append(empty); }
    }
    function render() {
        for (const [key, id] of Object.entries({ method: 'Method', url: 'Url', body: 'Body', bodyMode: 'BodyMode', bearer: 'Bearer', variables: 'Variables', timeout: 'Timeout' })) $(id).value = state[key];
        renderRows('query', 'QueryRows'); renderRows('headers', 'HeaderRows');
        $('Body').disabled = state.bodyMode === 'none';
    }
    function preview() {
        try {
            parsed = importText($('Import').value);
            $('Preview').textContent = parsed.kind === 'body' ? JSON.stringify(parsed.value, null, 2) : JSON.stringify(parsed.request || parsed.rows, null, 2);
            $('ImportStatus').textContent = `已识别：${parsed.label}${parsed.warnings.length ? ' · ' + parsed.warnings.join(' ') : ''}`;
            $('Apply').disabled = false; $('ImportStatus').dataset.error = 'false';
        } catch (error) {
            parsed = null; $('Apply').disabled = true; $('Preview').textContent = '';
            $('ImportStatus').textContent = $('Import').value.trim() ? error.message : '支持字段片段、完整 Java class、JSON、URL、键值参数和常用 cURL。';
            $('ImportStatus').dataset.error = String(!!$('Import').value.trim());
        }
    }
    function applyImport(input, target = 'Body') {
        read();
        if (input.kind === 'request') { state = { ...state, ...input.request }; selectTab(input.request.bodyMode === 'none' ? 'Query' : 'Body'); }
        else if (input.kind === 'query') { state.query = input.rows; selectTab('Query'); }
        else if (target === 'Query') {
            if (Array.isArray(input.value) || !input.value || typeof input.value !== 'object') throw Error('Query 导入需要 JSON 对象');
            state.query = Object.entries(input.value).map(([k, v]) => row(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v === null ? '' : String(v)));
            selectTab('Query');
        } else {
            state.body = JSON.stringify(input.value, null, 2); state.bodyMode = 'json';
            if (['GET', 'HEAD'].includes(state.method)) state.method = 'POST';
            selectTab('Body');
        }
        render(); note(`已填入 ${input.label}${input.warnings.length ? '。' + input.warnings.join(' ') : '，可以修改后发送。'}`);
    }
    $('Import').addEventListener('input', () => { clearTimeout(parseTimer); parseTimer = setTimeout(preview, 250); });
    $('Apply').addEventListener('click', () => { preview(); if (parsed) { try { applyImport(parsed, $('ImportTarget').value); } catch (e) { note(e.message, true); } } });
    $('Sample').addEventListener('click', () => { $('Import').value = 'String name;\nString code;\nprivate List<ShelfTierVto> tierList;'; preview(); });
    $('Body').addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text') || '';
        const box = $('Body');
        if (box.value && !(box.selectionStart === 0 && box.selectionEnd === box.value.length)) return;
        if (!/;/.test(text) || /^[\[{]/.test(text.trim())) return;
        try { const input = importText(text); if (input.kind !== 'body') return; event.preventDefault(); applyImport(input); }
        catch (_) { /* Normal paste preserves unsupported input for editing. */ }
    });
    $('Url').addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text') || '';
        if (!/^curl(?:\.exe)?\s/i.test(text.trim())) return;
        event.preventDefault(); try { applyImport(importText(text)); } catch (e) { note(e.message, true); }
    });
    root.addEventListener('click', event => { const tab = event.target.closest('[data-api-tab]'); if (tab) selectTab(tab.dataset.apiTab); });
    $('AddQuery').addEventListener('click', () => { state.query.push(row()); renderRows('query', 'QueryRows'); });
    $('AddHeader').addEventListener('click', () => { state.headers.push(row()); renderRows('headers', 'HeaderRows'); });
    $('BodyMode').addEventListener('change', () => { state.bodyMode = $('BodyMode').value; $('Body').disabled = state.bodyMode === 'none'; });
    $('Format').addEventListener('click', () => { try { $('Body').value = JSON.stringify(JSON.parse($('Body').value), null, 2); note('JSON 已格式化'); } catch (e) { note(e.message, true); } });
    $('New').addEventListener('click', () => { if (sending) return; state = emptyRequest(); response = null; render(); renderResponse(); note(''); });
    function renderResponse() {
        $('ResponseMeta').hidden = !response;
        $('ResponseEmpty').hidden = !!response;
        $('ResponseData').hidden = !response;
        $('CopyResponse').disabled = !response;
        if (!response) { $('ResponseEmpty').textContent = '发送请求后在这里查看响应。'; return; }
        $('Status').textContent = `${response.status} ${response.statusText}`;
        $('Status').dataset.error = String(response.status >= 400);
        $('Timing').textContent = `${response.elapsedMs} ms · ${(response.size / 1024).toFixed(2)} KiB${response.truncated ? ' · 已截断至 4 MiB' : ''}`;
        let body = response.body;
        if ($('Pretty').checked) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {} }
        $('ResponseBody').textContent = body || '（空响应体）';
        $('ResponseHeaders').textContent = response.headers.map(h => `${h.name}: ${h.value}`).join('\n') || '（无可见响应头）';
    }
    $('Pretty').addEventListener('change', renderResponse);
    $('CopyResponse').addEventListener('click', async () => { try { await window.WenBox.copyText(response.body); note('响应已复制'); } catch (e) { note('复制失败：' + e.message, true); } });
    $('ClearHistory').addEventListener('click', () => { history.length = 0; renderHistory(); });
    function renderHistory() {
        $('History').replaceChildren();
        for (const entry of history) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'api-history-item';
            const method = document.createElement('strong'); method.textContent = entry.state.method;
            const label = document.createElement('span'); label.textContent = entry.state.url || '未命名请求';
            const status = document.createElement('small'); status.textContent = entry.status;
            button.append(method, label, status);
            button.addEventListener('click', () => { if (sending) return; state = structuredClone(entry.state); render(); note('已恢复请求，可修改后重新发送'); });
            $('History').append(button);
        }
        $('HistoryEmpty').hidden = history.length > 0;
    }
    async function browserRequest(request) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), request.timeoutMs), start = performance.now();
        try {
            const result = await fetch(request.url, { method: request.method, headers: request.headers.map(h => [h.name, h.value]), body: request.body, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
            const reader = result.body?.getReader(), parts = []; let size = 0, truncated = false;
            if (reader) while (true) {
                const chunk = await reader.read(); if (chunk.done) break;
                const keep = chunk.value.subarray(0, 4 * 1024 * 1024 - size); parts.push(keep); size += keep.length;
                if (keep.length !== chunk.value.length) { truncated = true; await reader.cancel(); break; }
            }
            const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
            return { status: result.status, statusText: result.statusText, headers: [...result.headers].map(([name, value]) => ({ name, value })), body: new TextDecoder().decode(bytes), size, truncated, elapsedMs: Math.round(performance.now() - start) };
        } catch (e) { throw Error(e.name === 'AbortError' ? '请求超时' : '浏览器请求失败：请检查网络、CORS 或重定向；桌面客户端可直接请求。'); }
        finally { clearTimeout(timer); }
    }
    async function send() {
        if (sending) return;
        let request; try { request = prepareRequest(read()); } catch (e) { note(e.message, true); return; }
        const snapshot = structuredClone(state);
        sending = true; $('Send').disabled = true; $('Send').textContent = '请求中…'; $('New').disabled = true; note('');
        response = null; renderResponse(); $('ResponseEmpty').textContent = `正在等待响应，最长 ${state.timeout} 秒…`;
        let status;
        try {
            response = invoke ? await invoke('api_debug_request', { request }) : window.wenboxDesktop?.apiRequest ? await window.wenboxDesktop.apiRequest(request) : await browserRequest(request);
            status = `${response.status}`; renderResponse();
        } catch (e) { status = '失败'; note(e.message || String(e), true); $('ResponseEmpty').textContent = '本次请求未获得完整响应，请查看错误信息。'; }
        finally {
            history.unshift({ state: snapshot, status }); if (history.length > 20) history.pop(); renderHistory();
            sending = false; $('Send').disabled = false; $('Send').textContent = '发送请求'; $('New').disabled = false;
        }
    }
    $('Send').addEventListener('click', send);
    root.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); } });
    render(); renderHistory(); selectTab('Body');
}
