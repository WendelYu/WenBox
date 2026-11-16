import { parse as parseJava } from 'java-parser';
import shellQuote from 'shell-quote';

export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const row = (name = '', value = '', enabled = true) => ({ name, value, enabled });
export const emptyRequest = () => ({ method: 'GET', url: '', query: [], headers: [], body: '', bodyMode: 'none', bearer: '', variables: '', timeout: 30 });

function nodes(node, name, skip = []) {
    if (!node?.children) return [];
    if (node.name === name) return [node];
    if (skip.includes(node.name)) return [];
    return Object.values(node.children).flatMap(values => values.flatMap(child => nodes(child, name, skip)));
}
function tokens(node) {
    if (!node) return [];
    if (node.image !== undefined) return [node];
    return Object.values(node.children || {}).flatMap(v => v.flatMap(tokens)).sort((a, b) => a.startOffset - b.startOffset);
}
const spelling = node => tokens(node).map(t => t.image).join('');

export function javaToJson(source) {
    if (source.length > 65536) throw Error('字段定义最多 64 KiB，请仅粘贴本次请求涉及的类型');
    let cst, wrapped = false;
    try { cst = parseJava(source); if (!nodes(cst, 'normalClassDeclaration').length) throw Error('field snippet'); }
    catch (_) {
        try { cst = parseJava(`class WenBoxRequest {\n${source}\n}`); wrapped = true; }
        catch (_) { throw Error('无法解析 Java 字段，请保留字段类型、名称和分号；可粘贴字段片段或完整 class'); }
    }
    const classes = nodes(cst, 'normalClassDeclaration');
    if (!classes.length) throw Error('未找到 class 字段；请粘贴 VTO/DTO 字段或完整 class 定义');
    const definitions = new Map(), warnings = new Set();
    function collect(node) {
        if (node?.name === 'normalClassDeclaration') {
            const name = spelling(node.children.typeIdentifier?.[0]);
            if (definitions.has(name)) throw Error(`类型 ${name} 重复，请只保留一份定义`);
            definitions.set(name, node);
        }
        for (const values of Object.values(node?.children || {})) for (const child of values) collect(child);
    }
    collect(cst);
    if (definitions.size > 64) throw Error('一次最多解析 64 个类型');
    const root = spelling(classes[0].children.typeIdentifier[0]);
    let fieldCount = 0;
    function defaultFor(type, stack) {
        type = type.replace(/\s+/g, '').replace(/java\.(?:lang|util|math|time)\./g, '');
        if (type.endsWith('[]')) {
            const item = defaultFor(type.slice(0, -2), stack);
            return item === null ? [] : [item];
        }
        const list = /^(?:List|Set|Collection|Iterable|ArrayList|LinkedList)<(.+)>$/.exec(type);
        if (list) { const item = defaultFor(list[1], stack); return item === null ? [] : [item]; }
        if (/^(?:Map|HashMap|LinkedHashMap)(?:<.*>)?$/.test(type)) return {};
        const optional = /^Optional<(.+)>$/.exec(type);
        if (optional) return defaultFor(optional[1], stack);
        if (/^(?:String|CharSequence|char|Character|UUID|Date|LocalDate|LocalDateTime|Instant|OffsetDateTime)$/.test(type)) return '';
        if (/^(?:boolean|Boolean)$/.test(type)) return false;
        if (/^(?:byte|short|int|long|float|double|Byte|Short|Integer|Long|Float|Double|BigDecimal|BigInteger|Number)$/.test(type)) return 0;
        if (definitions.has(type)) return build(type, stack);
        warnings.add(`未提供 ${type} 的定义，引用留为 null，集合留空；可把关联 class 一起粘贴。`);
        return null;
    }
    function build(name, stack = []) {
        if (stack.includes(name) || stack.length >= 8) { warnings.add(`${name} 存在循环引用或嵌套超过 8 层，已留为 null。`); return null; }
        const definition = definitions.get(name), result = Object.create(null);
        if (definition.children.superclass) warnings.add(`${name} 的继承字段未展开，请将所需父类字段一并粘贴。`);
        const fields = nodes(definition.children.classBody[0], 'fieldDeclaration', ['normalClassDeclaration', 'recordDeclaration', 'methodDeclaration', 'constructorDeclaration']);
        for (const field of fields) {
            const modifiers = (field.children.fieldModifier || []).map(spelling).join(' ');
            if (/\b(?:static|transient)\b/.test(modifiers) || /@(?:[\w.]+\.)?JsonIgnore(?:\((?:(?:value=)?true)?\)|(?=\s|$))/.test(modifiers)) continue;
            const rename = /@(?:[\w.]+\.)?(?:JsonProperty|SerializedName)\((?:value=)?("(?:[^"\\]|\\.)*")\)/.exec(modifiers);
            const type = spelling(field.children.unannType?.[0]);
            for (const variable of nodes(field, 'variableDeclarator')) {
                if (++fieldCount > 500) throw Error('展开后的字段超过 500 个，请缩小粘贴范围');
                const id = variable.children.variableDeclaratorId[0];
                const key = rename ? JSON.parse(rename[1]) : id.children.Identifier[0].image;
                let value = defaultFor(type + (id.children.dims ? spelling(id.children.dims[0]) : ''), [...stack, name]);
                const initializer = spelling(variable.children.variableInitializer?.[0]);
                if (initializer && /^(?:"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)$/.test(initializer)) {
                    try { value = JSON.parse(initializer); } catch (_) { /* Keep typed default. */ }
                }
                if (Object.hasOwn(result, key)) throw Error(`字段 ${key} 重复，请检查字段名称或序列化注解`);
                result[key] = value;
            }
        }
        return result;
    }
    const value = build(root);
    if (!Object.keys(value).length) throw Error('未找到可生成参数的实例字段（static / transient / @JsonIgnore 会被忽略）');
    return { value, warnings: [...warnings], label: wrapped ? 'Java 字段' : root };
}

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

export function importText(raw) {
    const text = raw.trim();
    if (!text) throw Error('请先粘贴字段、JSON、URL 或 cURL');
    if (text.length > 65536) throw Error('导入内容最多 64 KiB');
    if (/^curl(?:\.exe)?\s/i.test(text)) return parseCurl(text);
    if (/^https?:\/\/\S+$/i.test(text)) return { kind: 'request', request: { ...emptyRequest(), ...urlParts(text) }, label: 'URL', warnings: [] };
    if (/^[\[{]/.test(text)) {
        let value; try { value = JSON.parse(text); } catch (e) { throw Error('JSON 格式错误：' + e.message); }
        return { kind: 'body', value, label: 'JSON', warnings: [] };
    }
    if (/^[\w.%+\-[\]]+=/.test(text)) return { kind: 'query', rows: [...new URLSearchParams(text.replace(/\r?\n/g, '&'))].map(([k, v]) => row(k, v)), label: '键值参数', warnings: [] };
    return { kind: 'body', ...javaToJson(text) };
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
