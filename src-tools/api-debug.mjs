import { emptyRequest, row, parseCurl, prepareRequest } from './api-request.mjs';
import { DEFAULT_BASE_URL, joinUrl, materializeEndpointRequest, scanBrowserFiles } from './api-catalog.mjs';

const root = document.getElementById('tab-api');
if (root) {
    const $ = id => document.getElementById('api' + id);
    let state = emptyRequest(), response = null, sending = false;
    let catalog = null, selectedEndpointId = null, methodFilter = 'ALL', mockSeed = 1, scanning = false;
    let pathParamValues = Object.create(null);
    const history = [];
    const invoke = window.__TAURI__?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI_INVOKE__;
    const tauriDialogOpen = window.__TAURI__?.dialog?.open;
    const native = typeof invoke === 'function' || !!window.wenboxDesktop?.apiRequest;
    $('Transport').textContent = native ? '本机直连 · 免跨域' : '浏览器模式 · 需目标允许 CORS';

    const note = (message, error = false) => {
        const el = $('Notice');
        if (!el) return;
        el.textContent = message;
        el.dataset.error = String(error);
        el.hidden = !message;
    };

    const setStatus = (message, error = false) => {
        const el = $('CatalogStatus');
        if (!el) return;
        el.textContent = message;
        el.dataset.error = String(error);
        el.hidden = !message;
    };

    function syncBadges() {
        const qCount = state.query.filter(r => r.name || r.value).length;
        const hCount = state.headers.filter(r => r.name || r.value).length;
        const qb = $('QueryBadge'), hb = $('HeaderBadge'), bb = $('BodyBadge'), hc = $('HistoryCount');
        if (qb) { qb.textContent = String(qCount); qb.hidden = qCount === 0; }
        if (hb) { hb.textContent = String(hCount); hb.hidden = hCount === 0; }
        if (bb) { bb.textContent = state.bodyMode === 'none' ? '' : state.bodyMode.toUpperCase(); bb.hidden = state.bodyMode === 'none'; }
        if (hc) hc.textContent = String(history.length);
        if ($('Method')) $('Method').dataset.method = $('Method').value;
    }

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
            enabled.addEventListener('change', () => { entry.enabled = enabled.checked; syncBadges(); });
            const name = document.createElement('input'); name.value = entry.name; name.placeholder = '参数名'; name.setAttribute('aria-label', `${key} 参数名 ${index + 1}`);
            const value = document.createElement('input'); value.value = entry.value; value.placeholder = '值 / {{变量}}'; value.setAttribute('aria-label', `${key} 参数值 ${index + 1}`);
            for (const input of [name, value]) {
                input.spellcheck = false; input.autocomplete = 'off';
                input.addEventListener('input', () => { entry.name = name.value; entry.value = value.value; syncBadges(); });
            }
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn--ghost btn--sm'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${entry.name || '第 ' + (index + 1) + ' 项'}`);
            remove.addEventListener('click', () => { state[key].splice(index, 1); renderRows(key, id); syncBadges(); });
            line.append(enabled, name, value, remove); container.append(line);
        });
        if (!state[key].length) {
            const empty = document.createElement('p'); empty.className = 'api-hint';
            empty.textContent = '暂无参数，点击下方按钮添加，或从左侧接口自动读取。';
            container.append(empty);
        }
    }

    function render() {
        for (const [key, id] of Object.entries({ method: 'Method', url: 'Url', body: 'Body', bodyMode: 'BodyMode', bearer: 'Bearer', variables: 'Variables', timeout: 'Timeout' })) $(id).value = state[key];
        renderRows('query', 'QueryRows'); renderRows('headers', 'HeaderRows');
        $('Body').disabled = state.bodyMode === 'none';
        syncBadges();
    }

    // ---------- Project / JAR / OpenAPI Catalog & Smart Mocking ----------

    function currentEndpoint() {
        return catalog?.endpoints?.find(ep => ep.id === selectedEndpointId) || null;
    }

    function resolveEndpointUrlWithPathParams(endpoint) {
        const baseUrl = $('BaseUrl')?.value || catalog?.baseUrl || DEFAULT_BASE_URL;
        const resolved = (endpoint.path || '/').replace(/\{([A-Za-z0-9_.-]+)(?::[^}]*)?\}/g, (_, k) => {
            const val = pathParamValues[k];
            return encodeURIComponent(val !== undefined && val !== '' ? String(val) : k);
        });
        return joinUrl(baseUrl, resolved);
    }

    function updateSelectedBanner(endpoint, materialized) {
        const banner = $('SelectedEndpoint');
        if (!banner) return;
        if (!endpoint) {
            banner.hidden = true;
            banner.replaceChildren();
            return;
        }
        banner.hidden = false;
        banner.replaceChildren();

        const top = document.createElement('div');
        top.className = 'api-selected-top';
        const badge = document.createElement('span');
        badge.className = 'api-method-badge';
        badge.dataset.method = endpoint.method;
        badge.textContent = endpoint.method;
        const pathEl = document.createElement('code');
        pathEl.className = 'api-selected-path';
        pathEl.textContent = endpoint.path;
        const summaryEl = document.createElement('span');
        summaryEl.className = 'api-selected-summary';
        summaryEl.textContent = endpoint.summary && endpoint.summary !== endpoint.methodName
            ? `${endpoint.summary} · ${endpoint.controller}.${endpoint.methodName}`
            : `${endpoint.controller}.${endpoint.methodName}`;
        top.append(badge, pathEl, summaryEl);
        banner.append(top);

        if (materialized?.pathParams?.length) {
            const paramsBar = document.createElement('div');
            paramsBar.className = 'api-path-params';
            for (const p of materialized.pathParams) {
                const chip = document.createElement('label');
                chip.className = 'api-path-param-chip';
                const tag = document.createElement('span');
                tag.textContent = `{${p.name}}`;
                const input = document.createElement('input');
                input.type = 'text';
                input.spellcheck = false;
                input.autocomplete = 'off';
                input.value = String(pathParamValues[p.name] ?? p.value ?? '');
                input.setAttribute('aria-label', `路径参数 ${p.name}`);
                input.addEventListener('input', () => {
                    pathParamValues[p.name] = input.value;
                    state.url = $('Url').value = resolveEndpointUrlWithPathParams(endpoint);
                });
                chip.append(tag, input);
                paramsBar.append(chip);
            }
            banner.append(paramsBar);
        }
    }

    function applySelectedEndpoint(endpoint, { switchTab = true } = {}) {
        if (!endpoint || !catalog) return;
        read();
        selectedEndpointId = endpoint.id;
        const mat = materializeEndpointRequest(endpoint, catalog, {
            baseUrl: $('BaseUrl')?.value || catalog.baseUrl || DEFAULT_BASE_URL,
            mockMode: $('MockMode')?.value || 'smart',
            seed: mockSeed,
        });
        pathParamValues = Object.create(null);
        for (const p of mat.pathParams || []) pathParamValues[p.name] = p.value;

        state = {
            ...state,
            method: mat.method,
            url: mat.url,
            query: mat.query,
            headers: mat.headers,
            body: mat.body,
            bodyMode: mat.bodyMode,
        };
        render();
        updateSelectedBanner(endpoint, mat);
        renderCatalogList();

        if (switchTab) {
            if (mat.bodyMode !== 'none') selectTab('Body');
            else if (mat.query.length) selectTab('Query');
            else if (mat.headers.length) selectTab('Header');
        }

        const modeLabel = ($('MockMode')?.value === 'empty') ? '空默认值' : '智能模拟值';
        const prefix = `已填入 ${endpoint.method} ${endpoint.path}（${modeLabel}）。`;
        note(mat.warnings.length ? `${prefix} 提示：${mat.warnings.join(' ')}` : prefix, false);
    }

    function renderCatalogList() {
        const list = $('CatalogList'), empty = $('CatalogEmpty');
        if (!list || !empty) return;
        list.replaceChildren();
        const endpoints = catalog?.endpoints || [];
        const q = ($('CatalogSearch')?.value || '').trim().toLowerCase();
        const filtered = endpoints.filter(ep => {
            if (methodFilter !== 'ALL' && ep.method !== methodFilter) return false;
            if (!q) return true;
            return `${ep.method} ${ep.path} ${ep.summary} ${ep.controller} ${ep.group} ${ep.methodName}`.toLowerCase().includes(q);
        });
        if ($('CatalogCount')) $('CatalogCount').textContent = `${filtered.length}`;
        empty.hidden = filtered.length > 0;
        if (!filtered.length) {
            empty.textContent = endpoints.length ? '未找到匹配接口，请调整关键词或方法筛选。' : '未识别到 HTTP 接口，请确认包含 Controller 注解或 OpenAPI JSON。';
            return;
        }
        const groups = new Map();
        for (const ep of filtered) {
            const g = ep.group || ep.controller || '默认分组';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(ep);
        }
        for (const [groupName, items] of groups) {
            const details = document.createElement('details');
            details.className = 'api-catalog-group';
            details.open = true;
            const summary = document.createElement('summary');
            const label = document.createElement('span');
            label.textContent = groupName;
            const count = document.createElement('small');
            count.textContent = `${items.length}`;
            summary.append(label, count);
            details.append(summary);

            const itemsBox = document.createElement('div');
            itemsBox.className = 'api-catalog-items';
            for (const ep of items) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'api-endpoint-item';
                if (ep.id === selectedEndpointId) btn.classList.add('is-active');
                btn.dataset.endpointId = ep.id;

                const badge = document.createElement('span');
                badge.className = 'api-method-badge';
                badge.dataset.method = ep.method;
                badge.textContent = ep.method;

                const textWrap = document.createElement('span');
                textWrap.className = 'api-endpoint-text';
                const pEl = document.createElement('span');
                pEl.className = 'api-endpoint-path';
                pEl.textContent = ep.path;
                const sEl = document.createElement('span');
                sEl.className = 'api-endpoint-summary';
                sEl.textContent = ep.summary || ep.methodName;
                textWrap.append(pEl, sEl);

                btn.append(badge, textWrap);
                btn.addEventListener('click', () => applySelectedEndpoint(ep));
                itemsBox.append(btn);
            }
            details.append(itemsBox);
            list.append(details);
        }
    }

    function applyLoadedCatalog(result) {
        catalog = result;
        selectedEndpointId = null;
        mockSeed = 1;
        pathParamValues = Object.create(null);

        const baseInput = $('BaseUrl');
        if (baseInput) {
            if (result.baseUrl) baseInput.value = result.baseUrl;
            else if (!baseInput.value.trim()) baseInput.value = DEFAULT_BASE_URL;
        }
        const s = result.stats || {};
        const kindLabel = {
            'project-dir': '项目目录',
            'spring-fat-jar': 'Fat JAR',
            'jar': 'JAR 包',
            'openapi-json': 'OpenAPI',
            'java-file': 'Java 源码',
        }[result.sourceKind] || '项目';
        if ($('SourceTitle')) $('SourceTitle').textContent = result.sourceName || '项目接口';
        if ($('SourceMeta')) $('SourceMeta').textContent = `${kindLabel} · ${s.controllersFound || 0} 控制器 · ${s.endpointsFound || 0} 接口`;
        if ($('CatalogWelcome')) $('CatalogWelcome').hidden = true;
        if ($('CatalogLoaded')) $('CatalogLoaded').hidden = false;
        if ($('Rescan')) $('Rescan').hidden = !(typeof invoke === 'function' && result.sourcePath && result.sourcePath !== result.sourceName);
        if ($('Remock')) $('Remock').disabled = !(result.endpoints?.length);

        const warnSuffix = result.warnings?.length ? `（提示 ${result.warnings.length} 条）` : '';
        setStatus(`已索引 ${s.filesScanned || 0} 个文件 · ${s.typesIndexed || 0} 个类型${warnSuffix}`, false);

        renderCatalogList();
        if (result.endpoints?.length) {
            applySelectedEndpoint(result.endpoints[0]);
        } else {
            updateSelectedBanner(null, null);
            note(result.warnings?.length ? result.warnings.join(' ') : '未扫描到 HTTP 接口，请检查项目是否包含 Spring MVC / JAX-RS / OpenAPI 定义。', !result.warnings?.length);
        }
    }

    async function runScan(fn, label) {
        if (scanning) return;
        scanning = true;
        for (const id of ['PickDir', 'PickFile', 'PickDirMini', 'PickFileMini', 'Rescan']) {
            if ($(id)) $(id).disabled = true;
        }
        setStatus(`正在扫描${label}并解析接口与参数类型…`, false);
        try {
            const result = await fn();
            applyLoadedCatalog(result);
        } catch (err) {
            const msg = typeof err === 'string' ? err : (err?.message || String(err));
            setStatus(`扫描失败：${msg}`, true);
            note(`扫描失败：${msg}`, true);
        } finally {
            scanning = false;
            for (const id of ['PickDir', 'PickFile', 'PickDirMini', 'PickFileMini', 'Rescan']) {
                if ($(id)) $(id).disabled = false;
            }
        }
    }

    async function pickDirectory() {
        if (typeof invoke === 'function' && typeof tauriDialogOpen === 'function') {
            try {
                const picked = await tauriDialogOpen({ directory: true, multiple: false, title: '选择 Java / Spring Boot 项目目录' });
                if (typeof picked === 'string' && picked) await runScan(() => invoke('api_scan_source', { path: picked }), '项目目录');
                return;
            } catch (e) {
                note('打开目录选择器失败：' + (e?.message || String(e)), true);
                return;
            }
        }
        $('DirInput')?.click();
    }

    async function pickFile() {
        if (typeof invoke === 'function' && typeof tauriDialogOpen === 'function') {
            try {
                const picked = await tauriDialogOpen({
                    directory: false,
                    multiple: false,
                    title: '选择 JAR 包、Java Controller 或 OpenAPI JSON',
                    filters: [{ name: '项目接口文件', extensions: ['jar', 'war', 'java', 'json', 'yml', 'yaml'] }],
                });
                if (typeof picked === 'string' && picked) await runScan(() => invoke('api_scan_source', { path: picked }), '文件');
                return;
            } catch (e) {
                note('打开文件选择器失败：' + (e?.message || String(e)), true);
                return;
            }
        }
        $('FileInput')?.click();
    }

    $('PickDir')?.addEventListener('click', pickDirectory);
    $('PickDirMini')?.addEventListener('click', pickDirectory);
    $('PickFile')?.addEventListener('click', pickFile);
    $('PickFileMini')?.addEventListener('click', pickFile);

    $('Rescan')?.addEventListener('click', async () => {
        if (typeof invoke === 'function' && catalog?.sourcePath) {
            await runScan(() => invoke('api_scan_source', { path: catalog.sourcePath }), '当前项目');
        }
    });

    $('ClearCatalog')?.addEventListener('click', () => {
        catalog = null;
        selectedEndpointId = null;
        pathParamValues = Object.create(null);
        if ($('CatalogWelcome')) $('CatalogWelcome').hidden = false;
        if ($('CatalogLoaded')) $('CatalogLoaded').hidden = true;
        if ($('Rescan')) $('Rescan').hidden = true;
        if ($('Remock')) $('Remock').disabled = true;
        updateSelectedBanner(null, null);
        setStatus('', false);
        note('');
    });

    $('DirInput')?.addEventListener('change', async () => {
        const files = $('DirInput').files;
        if (!files?.length) return;
        await runScan(() => scanBrowserFiles(files), '项目目录');
        $('DirInput').value = '';
    });

    $('FileInput')?.addEventListener('change', async () => {
        const files = $('FileInput').files;
        if (!files?.length) return;
        await runScan(() => scanBrowserFiles(files), '所选文件');
        $('FileInput').value = '';
    });

    $('CatalogPanel')?.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        $('CatalogPanel').classList.add('is-drag-over');
    });
    $('CatalogPanel')?.addEventListener('dragleave', () => {
        $('CatalogPanel').classList.remove('is-drag-over');
    });
    $('CatalogPanel')?.addEventListener('drop', async event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        $('CatalogPanel').classList.remove('is-drag-over');
        await runScan(() => scanBrowserFiles(event.dataTransfer.files), '拖入文件');
    });

    $('CatalogSearch')?.addEventListener('input', renderCatalogList);
    root.addEventListener('click', event => {
        const filterBtn = event.target.closest('[data-api-method-filter]');
        if (filterBtn) {
            methodFilter = filterBtn.dataset.apiMethodFilter;
            for (const b of root.querySelectorAll('[data-api-method-filter]')) {
                const on = b === filterBtn;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-pressed', String(on));
            }
            renderCatalogList();
        }
    });

    $('MockMode')?.addEventListener('change', () => {
        const ep = currentEndpoint();
        if (ep) applySelectedEndpoint(ep, { switchTab: false });
    });
    $('BaseUrl')?.addEventListener('change', () => {
        const ep = currentEndpoint();
        if (ep) applySelectedEndpoint(ep, { switchTab: false });
    });
    $('Remock')?.addEventListener('click', () => {
        mockSeed++;
        const ep = currentEndpoint();
        if (ep) applySelectedEndpoint(ep, { switchTab: false });
    });

    // ---------- Request Editor, cURL Paste/Copy, Response & History ----------

    $('Url').addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text') || '';
        if (!/^curl(?:\.exe)?\s/i.test(text.trim())) return;
        event.preventDefault();
        try {
            const imported = parseCurl(text);
            read();
            state = { ...state, ...imported.request };
            selectedEndpointId = null;
            updateSelectedBanner(null, null);
            renderCatalogList();
            render();
            selectTab(imported.request.bodyMode === 'none' ? 'Query' : 'Body');
            note(`已导入 ${imported.label}${imported.warnings.length ? '：' + imported.warnings.join(' ') : '。'}`);
        } catch (e) {
            note(e.message, true);
        }
    });

    $('CopyCurl')?.addEventListener('click', async () => {
        try {
            const req = prepareRequest(read());
            const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
            const parts = ['curl', '-X', req.method, q(req.url)];
            for (const h of req.headers) parts.push('-H', q(`${h.name}: ${h.value}`));
            if (req.body !== null) parts.push('--data-raw', q(req.body));
            const cmd = parts.join(' ');
            if (window.WenBox?.copyText) await window.WenBox.copyText(cmd);
            else await navigator.clipboard.writeText(cmd);
            note('已复制当前请求的 cURL 命令');
        } catch (e) {
            note('生成 cURL 失败：' + e.message, true);
        }
    });

    root.addEventListener('click', event => { const tab = event.target.closest('[data-api-tab]'); if (tab) selectTab(tab.dataset.apiTab); });
    $('Method').addEventListener('change', syncBadges);
    $('AddQuery').addEventListener('click', () => { state.query.push(row()); renderRows('query', 'QueryRows'); syncBadges(); });
    $('AddHeader').addEventListener('click', () => { state.headers.push(row()); renderRows('headers', 'HeaderRows'); syncBadges(); });
    $('BodyMode').addEventListener('change', () => { state.bodyMode = $('BodyMode').value; $('Body').disabled = state.bodyMode === 'none'; syncBadges(); });
    $('Format').addEventListener('click', () => { try { $('Body').value = JSON.stringify(JSON.parse($('Body').value), null, 2); note('JSON 已格式化'); } catch (e) { note(e.message, true); } });
    $('New').addEventListener('click', () => {
        if (sending) return;
        state = emptyRequest(); response = null; selectedEndpointId = null; pathParamValues = Object.create(null);
        updateSelectedBanner(null, null); renderCatalogList();
        render(); renderResponse(); note('');
    });

    function renderResponse() {
        $('ResponseMeta').hidden = !response;
        $('ResponseEmpty').hidden = !!response;
        $('ResponseData').hidden = !response;
        $('CopyResponse').disabled = !response;
        if (!response) { $('ResponseEmpty').textContent = '发送请求后，在这里查看状态码、耗时与响应正文。'; return; }
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
    $('ClearHistory').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); history.length = 0; renderHistory(); });

    function renderHistory() {
        $('History').replaceChildren();
        for (const entry of history) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'api-history-item';
            const method = document.createElement('strong'); method.textContent = entry.state.method; method.dataset.method = entry.state.method;
            const label = document.createElement('span'); label.textContent = entry.state.url || '未命名请求';
            const status = document.createElement('small'); status.textContent = entry.status;
            button.append(method, label, status);
            button.addEventListener('click', () => {
                if (sending) return;
                state = structuredClone(entry.state);
                selectedEndpointId = null; updateSelectedBanner(null, null); renderCatalogList();
                render(); note('已恢复历史请求，可修改后重新发送。');
            });
            $('History').append(button);
        }
        $('HistoryEmpty').hidden = history.length > 0;
        syncBadges();
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
