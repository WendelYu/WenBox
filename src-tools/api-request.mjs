import shellQuote from 'shell-quote';

export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const row = (name = '', value = '', enabled = true) => ({ name, value, enabled });
export const emptyRequest = () => ({ method: 'GET', url: '', query: [], headers: [], body: '', bodyMode: 'none', bearer: '', variables: '', timeout: 30 });

export function urlParts(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw Error('请输入无账号、密码及片段的完整 HTTP/HTTPS 地址');
    const query = [...url.searchParams].map(([name, value]) => row(name, value));
    url.search = '';
    return { url: url.href, query };
}

export function parseCurl(text) {
    if (/[`]|\$\(|\$\{|\$[A-Za-z_]/.test(text)) throw Error('cURL 中含 shell 变量或命令替换，请先换成字面值');
    const args = shellQuote.parse(text.replace(/\\\r?\n/g, ''));
    if (args.some(a => typeof a !== 'string')) throw Error('仅可导入单条 cURL，不支持管道、重定向或通配符');
    if (!/^curl(?:\.exe)?$/i.test(args.shift() || '')) throw Error('请粘贴以 curl 开头的请求');
    const request = emptyRequest(), data = [];
    let address = '', explicitMethod = false, asQuery = false;
    const value = () => { if (!args.length) throw Error('cURL 参数缺少值'); return args.shift(); };
    while (args.length) {
        let flag = args.shift();
        const eq = flag.startsWith('--') ? flag.indexOf('=') : -1;
        if (eq > 0) { args.unshift(flag.slice(eq + 1)); flag = flag.slice(0, eq); }
        if (/^-[XHdub][^-].+/.test(flag)) { args.unshift(flag.slice(2)); flag = flag.slice(0, 2); }
        if (['-X', '--request'].includes(flag)) { request.method = value().toUpperCase(); explicitMethod = true; }
        else if (['-H', '--header'].includes(flag)) {
            const header = value(), at = header.indexOf(':');
            if (at < 1) throw Error('cURL 请求头需要 Name: Value 格式');
            request.headers.push(row(header.slice(0, at).trim(), header.slice(at + 1).trim()));
        } else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(flag)) {
            const body = value();
            if (body.startsWith('@') && flag !== '--data-raw') throw Error('不读取 cURL 的 @文件，请直接粘贴请求体');
            data.push(body);
            if (flag === '--json') request.headers.push(row('Content-Type', 'application/json'));
        } else if (flag === '--url') { if (address) throw Error('一次只能导入一个 URL'); address = value(); }
        else if (['-G', '--get'].includes(flag)) asQuery = true;
        else if (['-I', '--head'].includes(flag)) { request.method = 'HEAD'; explicitMethod = true; }
        else if (['-u', '--user'].includes(flag)) {
            const auth = value();
            request.headers.push(row('Authorization', 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(auth)))));
        } else if (['-b', '--cookie'].includes(flag)) {
            const cookie = value(); if (!cookie.includes('=')) throw Error('Cookie 文件不支持导入，请粘贴 Cookie 字面值');
            request.headers.push(row('Cookie', cookie));
        } else if (['-s', '--silent', '-S', '--show-error', '-v', '--verbose', '--compressed'].includes(flag)) { /* Output-only flags. */ }
        else if (flag.startsWith('-')) throw Error(`暂不支持 cURL 选项 ${flag}，请移除或手动填写对应参数`);
        else { if (address) throw Error('一次只能导入一个 URL'); address = flag; }
    }
    if (!address) throw Error('cURL 缺少 URL');
    Object.assign(request, urlParts(address));
    request.body = data.join('&');
    if (asQuery) { request.query.push(...[...new URLSearchParams(request.body)].map(([k, v]) => row(k, v))); request.body = ''; }
    else if (data.length) {
        if (!explicitMethod) request.method = 'POST';
        const type = request.headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        request.bodyMode = type.includes('json') ? 'json' : type.includes('application/x-www-form-urlencoded') || !type ? 'form' : 'text';
    }
    if (!methods.includes(request.method)) throw Error('该 HTTP 方法暂不支持');
    const managed = ['host', 'content-length', 'connection', 'accept-encoding'];
    const removed = request.headers.filter(h => managed.includes(h.name.toLowerCase()));
    request.headers = request.headers.filter(h => !managed.includes(h.name.toLowerCase()));
    return { kind: 'request', request, label: 'cURL 请求', warnings: removed.map(h => `${h.name} 由调试客户端重新生成。`) };
}

export function prepareRequest(state) {
    const variables = Object.create(null);
    for (const line of state.variables.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))) {
        const at = line.indexOf('='); if (at < 1) throw Error('变量格式为每行 name=value');
        variables[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    const interpolate = value => String(value).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name) => {
        if (!Object.hasOwn(variables, name)) throw Error(`变量 ${name} 未填写`);
        return variables[name];
    });
    const parts = urlParts(interpolate(state.url));
    const url = new URL(parts.url);
    for (const r of [...parts.query, ...state.query]) if (r.enabled && r.name) url.searchParams.append(interpolate(r.name), interpolate(r.value));
    const headers = state.headers.filter(r => r.enabled && r.name).map(r => ({ name: interpolate(r.name).trim(), value: interpolate(r.value) }));
    if (state.bearer.trim()) {
        if (headers.some(h => h.name.toLowerCase() === 'authorization')) throw Error('Bearer 与 Authorization 请求头重复，请保留一种');
        headers.push({ name: 'Authorization', value: 'Bearer ' + interpolate(state.bearer.trim()) });
    }
    const timeoutMs = Number(state.timeout) * 1000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Error('超时范围为 1–120 秒');
    let body = state.bodyMode === 'none' ? null : interpolate(state.body);
    if (['GET', 'HEAD'].includes(state.method)) {
        if (body) throw Error('GET/HEAD 不发送请求体，请切换方法或使用 Query 参数');
        body = null;
    }
    if (body !== null) {
        if (state.bodyMode === 'json') { try { JSON.parse(body); } catch (e) { throw Error('请求体 JSON 无效：' + e.message); } }
        if (!headers.some(h => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8' }[state.bodyMode] });
        if (new TextEncoder().encode(body).length > 1024 * 1024) throw Error('请求体不能超过 1 MiB');
    }
    if (!methods.includes(state.method)) throw Error('不支持的 HTTP 方法');
    for (const h of headers) if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(h.name) || /[\r\n\0]/.test(h.value)) throw Error('请求头名称无效或包含换行');
    return { method: state.method, url: url.href, headers, body, timeoutMs };
}
