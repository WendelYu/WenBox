import { row } from './api-model.mjs';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const MAX_NESTING_DEPTH = 8;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_NESTED_JARS = 128;

export function normalizeBaseUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '');
}

export function normalizePathSegment(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed === '/') return '';
    let s = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
    while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
}

export function combinePaths(prefix, suffix) {
    const p = normalizePathSegment(prefix);
    const s = normalizePathSegment(suffix);
    if (!p && !s) return '/';
    if (!p) return s;
    if (!s) return p;
    return `${p}${s}`;
}

export function joinUrl(baseUrl, endpointPath) {
    const p = String(endpointPath || '').trim() || '/';
    if (/^https?:\/\//i.test(p)) return p;
    const base = normalizeBaseUrl(baseUrl);
    const seg = p.startsWith('/') ? p : '/' + p;
    if (!base) return seg;
    if (base.endsWith(seg)) return base;
    return base + seg;
}

export function simpleTypeName(raw) {
    const noGen = String(raw || '').split('<')[0].trim();
    const parts = noGen.split(/[./$]/);
    return (parts[parts.length - 1] || noGen).replace(/(\[\])+$/, '');
}

export function resolveTypeDef(typeName, types = {}) {
    if (!typeName || !types) return null;
    if (Object.hasOwn(types, typeName)) return types[typeName];
    const simple = simpleTypeName(typeName);
    if (Object.hasOwn(types, simple)) return types[simple];
    for (const def of Object.values(types)) {
        if (def.fullName === typeName || def.name === simple) return def;
    }
    return null;
}

function isScalarType(typeName) {
    const clean = String(typeName || '').trim().replace(/^java\.(?:lang|util|math|time)\./g, '');
    if (clean.endsWith('[]')) return true;
    return /^(?:String|CharSequence|char|Character|boolean|Boolean|byte|Byte|short|Short|int|Integer|long|Long|float|Float|double|Double|BigDecimal|BigInteger|Number|UUID|Date|LocalDate|LocalDateTime|LocalTime|Instant|OffsetDateTime|ZonedDateTime|Object)$/.test(simpleTypeName(clean));
}

function isCollectionOrMap(typeName) {
    const base = simpleTypeName(typeName);
    return /^(?:List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|Page|Map|HashMap|LinkedHashMap|Optional)$/.test(base);
}

function isIgnoredInjectedType(typeName) {
    return /^(?:HttpServletRequest|HttpServletResponse|HttpSession|ServletRequest|ServletResponse|Model|ModelMap|RedirectAttributes|BindingResult|Errors|Principal|Authentication|WebRequest|NativeWebRequest|ServerWebExchange|ServerHttpRequest|ServerHttpResponse|Locale|TimeZone|InputStream|OutputStream|Reader|Writer|UriComponentsBuilder|Pageable|Sort)$/.test(simpleTypeName(typeName));
}

export function collectInheritedFields(typeDef, types, stack = new Set()) {
    if (!typeDef) return [];
    const key = typeDef.fullName || typeDef.name;
    if (stack.has(key) || stack.size >= MAX_NESTING_DEPTH) return [];
    const nextStack = new Set(stack);
    nextStack.add(key);
    let merged = [];
    if (typeDef.superClass) {
        const superDef = resolveTypeDef(typeDef.superClass, types);
        if (superDef) merged = collectInheritedFields(superDef, types, nextStack);
    }
    const byName = new Map();
    for (const f of merged) byName.set(f.name, f);
    for (const f of typeDef.fields || []) byName.set(f.name, f);
    return [...byName.values()];
}

function coerceExampleValue(raw, targetType) {
    if (raw === undefined || raw === null) return null;
    const base = simpleTypeName(targetType);
    const str = String(raw).trim();
    if (/^(?:boolean|Boolean)$/.test(base)) {
        if (str === 'true' || str === '1') return true;
        if (str === 'false' || str === '0') return false;
    }
    if (/^(?:byte|short|int|Integer|long|Long)$/.test(base)) {
        const n = Number(str);
        if (Number.isFinite(n)) return Math.trunc(n);
    }
    if (/^(?:float|Float|double|Double|BigDecimal|BigInteger|Number)$/.test(base)) {
        const n = Number(str);
        if (Number.isFinite(n)) return n;
    }
    return str;
}

function applyStringConstraints(val, constraints) {
    if (!constraints) return val;
    let s = String(val);
    if (constraints.email && !s.includes('@')) s = 'demo@example.com';
    if (constraints.minLen && s.length < constraints.minLen) {
        s = s.padEnd(constraints.minLen, 'a');
    }
    if (constraints.maxLen && s.length > constraints.maxLen) {
        s = s.slice(0, constraints.maxLen);
    }
    return s;
}

function applyNumericConstraints(val, constraints, isFloat) {
    let n = Number(val);
    if (!Number.isFinite(n)) n = 1;
    if (constraints?.min !== undefined && constraints.min !== null && n < constraints.min) {
        n = constraints.min;
    }
    if (constraints?.max !== undefined && constraints.max !== null && n > constraints.max) {
        n = constraints.max;
    }
    return isFloat ? Number(n.toFixed(2)) : Math.trunc(n);
}

function smartScalarMock(typeBase, fieldName, constraints, seed = 1) {
    const name = String(fieldName || '').toLowerCase();
    const sIdx = ((Math.max(1, seed) - 1) % 9) + 1;

    if (/^(?:boolean|Boolean)$/.test(typeBase)) {
        if (/(?:deleted|disabled|locked|hidden|ban)/.test(name)) return false;
        if (/(?:enabled|active|valid|ok|success|is|has)/.test(name)) return true;
        return seed % 2 === 1;
    }
    if (/^(?:byte|short|int|Integer|long|Long|float|Float|double|Double|BigDecimal|BigInteger|Number)$/.test(typeBase)) {
        const isFloat = /^(?:float|Float|double|Double|BigDecimal|Number)$/.test(typeBase);
        let n;
        if (/^(?:page|pagenum|pageindex|current)$/.test(name)) n = 1;
        else if (/^(?:pagesize|size|limit|rows)$/.test(name)) n = 20;
        else if (/id$/.test(name) || name === 'id') n = 1000 + sIdx;
        else if (/(?:price|amount|money|fee|rate|cost|totalamount)/.test(name)) n = Number((99.9 + (sIdx - 1) * 10).toFixed(2));
        else if (/(?:status|state|type|level|tier|sort|order)/.test(name)) n = sIdx;
        else if (/(?:count|num|qty|quantity|total|stock)/.test(name)) n = 10 + (sIdx - 1);
        else if (/age/.test(name)) n = 24;
        else n = isFloat ? 1.5 : sIdx;
        return applyNumericConstraints(n, constraints, isFloat);
    }

    // Date / Time / UUID
    if (typeBase === 'LocalDate') return '2026-11-28';
    if (typeBase === 'LocalTime') return '12:00:00';
    if (/^(?:LocalDateTime|Date|Instant|OffsetDateTime|ZonedDateTime)$/.test(typeBase)) {
        return typeBase === 'Instant' || typeBase === 'OffsetDateTime' ? '2026-11-28T12:00:00Z' : '2026-11-28 12:00:00';
    }
    if (typeBase === 'UUID') return `550e8400-e29b-41d4-a716-44665544000${sIdx}`;

    // String heuristics
    let val;
    if (constraints?.email || /(?:email|mail)/.test(name)) val = 'demo@example.com';
    else if (/(?:phone|mobile|tel)/.test(name)) val = `1380013800${sIdx}`;
    else if (/(?:url|uri|link|avatar|img|image|icon|cover)/.test(name)) val = 'https://example.com/demo';
    else if (/(?:username|account|login)/.test(name)) val = 'admin';
    else if (/(?:password|passwd|pwd)/.test(name)) val = 'Demo@123456';
    else if (/id$/.test(name) || name === 'id') val = `100${sIdx}`;
    else if (/(?:code|sn|no|sku)/.test(name)) val = `CODE_00${sIdx}`;
    else if (/(?:name|title|label|nick)/.test(name)) val = `示例名称${sIdx > 1 ? sIdx : ''}`;
    else if (/(?:desc|remark|note|content|msg|message|reason|summary|memo)/.test(name)) val = '示例说明文本';
    else if (/(?:token|secret|key)/.test(name)) val = 'demo-token-001';
    else if (/(?:date|day)/.test(name)) val = '2026-11-28';
    else if (/(?:time)/.test(name)) val = '2026-11-28 12:00:00';
    else val = sIdx > 1 ? `sample_${sIdx}` : 'sample';
    return applyStringConstraints(val, constraints);
}

function emptyScalarMock(typeBase) {
    if (/^(?:boolean|Boolean)$/.test(typeBase)) return false;
    if (/^(?:byte|short|int|Integer|long|Long|float|Float|double|Double|BigDecimal|BigInteger|Number)$/.test(typeBase)) return 0;
    return '';
}

function splitFirstGeneric(inner) {
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '<') depth++;
        else if (ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
    }
    return [inner.trim(), ''];
}

export function generateMockValue(typeExpr, fieldMeta = {}, types = {}, options = {}) {
    const warnings = options.warnings || new Set();
    const stack = options.stack || [];
    const mockMode = options.mockMode === 'empty' ? 'empty' : 'smart';
    const seed = Number.isInteger(options.seed) && options.seed > 0 ? options.seed : 1;
    const rawType = String(typeExpr || 'String')
        .replace(/\s+/g, '')
        .replace(/java\.(?:lang|util|math|time)\./g, '');

    if (rawType.endsWith('[]')) {
        const elem = generateMockValue(rawType.slice(0, -2), fieldMeta, types, { ...options, warnings, stack });
        if (mockMode === 'empty') {
            return elem === null ? [] : (typeof elem === 'object' ? [elem] : []);
        }
        return elem === null ? [] : [elem];
    }

    const collMatch = /^(?:List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|Page)<(.+)>$/.exec(rawType);
    if (collMatch) {
        const elem = generateMockValue(collMatch[1], fieldMeta, types, { ...options, warnings, stack });
        if (mockMode === 'empty') {
            return elem === null ? [] : (typeof elem === 'object' ? [elem] : []);
        }
        return elem === null ? [] : [elem];
    }

    const optMatch = /^Optional<(.+)>$/.exec(rawType);
    if (optMatch) {
        return generateMockValue(optMatch[1], fieldMeta, types, { ...options, warnings, stack });
    }

    const mapMatch = /^(?:Map|HashMap|LinkedHashMap)(?:<(.+)>)?$/.exec(rawType);
    if (mapMatch) {
        if (mockMode === 'empty' || !mapMatch[1]) return {};
        const [, valType] = splitFirstGeneric(mapMatch[1]);
        if (!valType || valType === 'Object') return { key: 'sample' };
        return { key: generateMockValue(valType, { name: 'key' }, types, { ...options, warnings, stack }) };
    }

    const base = simpleTypeName(rawType);
    if (/^(?:String|CharSequence|char|Character|UUID|Date|LocalDate|LocalDateTime|LocalTime|Instant|OffsetDateTime|ZonedDateTime|boolean|Boolean|byte|Byte|short|Short|int|Integer|long|Long|float|Float|double|Double|BigDecimal|BigInteger|Number)$/.test(base)) {
        if (mockMode === 'smart') {
            const explicit = fieldMeta?.defaultValue ?? fieldMeta?.example;
            if (explicit !== undefined && explicit !== null && explicit !== '') {
                return coerceExampleValue(explicit, base);
            }
            return smartScalarMock(base, fieldMeta?.javaName || fieldMeta?.name || '', fieldMeta?.constraints, seed);
        }
        return emptyScalarMock(base);
    }
    if (base === 'Object') return mockMode === 'smart' ? 'sample' : null;

    const typeDef = resolveTypeDef(rawType, types);
    if (!typeDef) {
        warnings.add(`未找到类型 ${rawType} 的定义，已保留为 null/空。`);
        return null;
    }

    if (typeDef.kind === 'enum') {
        const vals = typeDef.enumValues || [];
        if (!vals.length) return '';
        return mockMode === 'smart' ? vals[(seed - 1) % vals.length] : vals[0];
    }

    const typeKey = typeDef.fullName || typeDef.name;
    if (stack.includes(typeKey) || stack.length >= MAX_NESTING_DEPTH) {
        warnings.add(`${typeDef.name} 存在循环引用或嵌套超过 ${MAX_NESTING_DEPTH} 层，已截断。`);
        return null;
    }

    const fields = collectInheritedFields(typeDef, types);
    if (!fields.length) return {};

    const nextStack = [...stack, typeKey];
    const obj = {};
    for (const f of fields) {
        obj[f.name] = generateMockValue(f.type, f, types, { ...options, warnings, stack: nextStack });
    }
    return obj;
}

function toScalarString(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
}

export function materializeEndpointRequest(endpoint, catalog, options = {}) {
    const types = catalog?.types || {};
    const mockMode = options.mockMode === 'empty' ? 'empty' : 'smart';
    const seed = Number.isInteger(options.seed) && options.seed > 0 ? options.seed : 1;
    const warnings = new Set(endpoint?.warnings || []);
    const baseUrl = normalizeBaseUrl(options.baseUrl) || normalizeBaseUrl(catalog?.baseUrl) || DEFAULT_BASE_URL;

    let resolvedPath = endpoint?.path || '/';
    const pathParams = [];
    const query = [];
    const headers = [];
    let body = '';
    let bodyMode = 'none';

    for (const param of endpoint?.params || []) {
        if (param.inferredName && param.location !== 'body' && param.location !== 'queryObject') {
            warnings.add(`字节码参数 ${param.name} 未保留原始名称，请确认实际字段名。`);
        }
        if (param.location === 'path') {
            const val = mockMode === 'empty' && param.defaultValue
                ? param.defaultValue
                : generateMockValue(param.type, param, types, { mockMode, seed, warnings });
            const strVal = toScalarString(val) || (mockMode === 'smart' ? '1' : '0');
            pathParams.push({ ...param, value: strVal });
            const pattern = new RegExp(`\\{${param.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::[^}]*)?\\}`, 'g');
            resolvedPath = resolvedPath.replace(pattern, encodeURIComponent(strVal));
        } else if (param.location === 'query') {
            const val = generateMockValue(param.type, param, types, { mockMode, seed, warnings });
            query.push(row(param.name, Array.isArray(val) ? val.join(',') : toScalarString(val), true));
        } else if (param.location === 'queryObject') {
            const val = generateMockValue(param.type, param, types, { mockMode, seed, warnings });
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                for (const [k, v] of Object.entries(val)) {
                    query.push(row(k, Array.isArray(v) ? v.join(',') : toScalarString(v), true));
                }
            }
        } else if (param.location === 'header') {
            const val = generateMockValue(param.type, param, types, { mockMode, seed, warnings });
            headers.push(row(param.name, toScalarString(val), true));
        } else if (param.location === 'body') {
            const val = generateMockValue(param.type, param, types, { mockMode, seed, warnings });
            body = JSON.stringify(val ?? {}, null, 2);
            bodyMode = 'json';
        }
    }

    // Ensure any leftover `{id}` path placeholder still gets a clean sample if unannotated
    resolvedPath = resolvedPath.replace(/\{([A-Za-z0-9_.-]+)(?::[^}]*)?\}/g, (_, pName) => {
        const existing = pathParams.find(p => p.name === pName);
        if (existing) return encodeURIComponent(existing.value);
        const val = mockMode === 'smart' ? String(smartScalarMock('String', pName, null, seed)) : '1';
        pathParams.push({ name: pName, location: 'path', type: 'String', value: val, required: true });
        return encodeURIComponent(val);
    });

    if (endpoint?.contentType && bodyMode === 'json' && endpoint.contentType !== 'application/json') {
        headers.push(row('Content-Type', endpoint.contentType, true));
    }

    return {
        method: endpoint?.method || 'GET',
        url: joinUrl(baseUrl, resolvedPath),
        path: resolvedPath,
        query,
        headers,
        body,
        bodyMode,
        pathParams,
        warnings: [...warnings],
    };
}

// ---------- Browser / Fallback Multi-File Scanner (OpenAPI + Java + JAR) ----------

function unwrapPlaceholder(raw) {
    const trimmed = String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
    const m = /^\$\{([^}]+)\}$/.exec(trimmed);
    if (m) {
        const idx = m[1].indexOf(':');
        return idx >= 0 ? m[1].slice(idx + 1).trim().replace(/^["']|["']$/g, '') : '';
    }
    return trimmed;
}

function parseSpringConfig(text, isProps, cfg) {
    if (isProps) {
        for (const line of text.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#') || t.startsWith('!')) continue;
            const sep = t.indexOf('=') >= 0 ? t.indexOf('=') : t.indexOf(':');
            if (sep < 1) continue;
            const key = t.slice(0, sep).trim();
            const val = unwrapPlaceholder(t.slice(sep + 1));
            if (!val) continue;
            if (key === 'server.port' && /^\d+$/.test(val)) cfg.port = val;
            if (key === 'server.servlet.context-path' || key === 'server.context-path') cfg.contextPath = val;
        }
        return;
    }
    const stack = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const noComment = rawLine.replace(/\s+#.*$/, '');
        const trimmed = noComment.trim();
        if (!trimmed || trimmed === '---' || trimmed.startsWith('-')) continue;
        const indent = noComment.search(/\S|$/);
        const colon = trimmed.indexOf(':');
        if (colon < 1) continue;
        const key = trimmed.slice(0, colon).trim().replace(/^["']|["']$/g, '');
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const val = unwrapPlaceholder(trimmed.slice(colon + 1));
        if (!val) { stack.push({ indent, key }); continue; }
        const fullKey = [...stack.map(s => s.key), key].join('.');
        if (fullKey === 'server.port' && /^\d+$/.test(val)) cfg.port = val;
        if (fullKey === 'server.servlet.context-path' || fullKey === 'server.context-path') cfg.contextPath = val;
    }
}

function stripJavaCommentsWithDocs(src) {
    let out = '';
    for (let i = 0; i < src.length;) {
        const c = src[i];
        if (c === '"') {
            if (src.startsWith('"""', i)) {
                out += '"""'; i += 3;
                while (i < src.length && !src.startsWith('"""', i)) { out += src[i++]; }
                if (src.startsWith('"""', i)) { out += '"""'; i += 3; }
                continue;
            }
            out += c; i++;
            while (i < src.length) {
                const sc = src[i]; out += sc; i++;
                if (sc === '\\' && i < src.length) { out += src[i++]; }
                else if (sc === '"') break;
            }
        } else if (c === "'") {
            out += c; i++;
            while (i < src.length) {
                const sc = src[i]; out += sc; i++;
                if (sc === '\\' && i < src.length) { out += src[i++]; }
                else if (sc === "'") break;
            }
        } else if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '/' && src[i + 1] === '*') {
            const isDoc = src[i + 2] === '*' && src[i + 3] !== '/';
            const start = i + 2;
            const end = src.indexOf('*/', start);
            const rawComment = end >= 0 ? src.slice(start, end) : src.slice(start);
            i = end >= 0 ? end + 2 : src.length;
            if (isDoc) {
                const lines = rawComment.split(/\r?\n/).map(l => l.trim().replace(/^\*+\s?/, '').trim()).filter(l => l && !l.startsWith('@'));
                const doc = lines.join(' ').trim().slice(0, 120);
                if (doc) out += `\n__WENBOX_DOC__(${JSON.stringify(doc)})\n`;
            } else out += ' ';
        } else { out += c; i++; }
    }
    return out;
}

function findMatchingDelim(str, openIdx, open, close) {
    let depth = 0;
    for (let i = openIdx; i < str.length; i++) {
        const c = str[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < str.length) {
                if (str[i] === '\\') i += 2;
                else if (str[i] === c) break;
                else i++;
            }
            continue;
        }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function splitTopLevel(str, delim = ',') {
    const out = [];
    let start = 0, p = 0, b = 0, k = 0, a = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < str.length) {
                if (str[i] === '\\') i += 2;
                else if (str[i] === c) break;
                else i++;
            }
            continue;
        }
        if (c === '(') p++; else if (c === ')') p = Math.max(0, p - 1);
        else if (c === '{') b++; else if (c === '}') b = Math.max(0, b - 1);
        else if (c === '[') k++; else if (c === ']') k = Math.max(0, k - 1);
        else if (c === '<') a++; else if (c === '>') a = Math.max(0, a - 1);
        else if (c === delim && p === 0 && b === 0 && k === 0 && a === 0) {
            const item = str.slice(start, i).trim();
            if (item || delim === ',') out.push(item);
            start = i + 1;
        }
    }
    const tail = str.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

function splitFirstEq(str) {
    let inS = false, inD = false, depth = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '\\') { i++; continue; }
        if (c === '"' && !inS) inD = !inD;
        else if (c === "'" && !inD) inS = !inS;
        else if (!inS && !inD && (c === '(' || c === '{' || c === '[')) depth++;
        else if (!inS && !inD && (c === ')' || c === '}' || c === ']')) depth = Math.max(0, depth - 1);
        else if (!inS && !inD && depth === 0 && c === '=') return [str.slice(0, i), str.slice(i + 1)];
    }
    return null;
}

function parseAnnArgs(raw) {
    const map = {};
    const trimmed = String(raw || '').trim();
    if (!trimmed) return map;
    const parts = splitTopLevel(trimmed, ',');
    if (parts.length === 1 && !splitFirstEq(parts[0])) {
        map.value = parts[0].trim();
        return map;
    }
    for (const part of parts) {
        const eq = splitFirstEq(part);
        if (eq) map[eq[0].trim()] = eq[1].trim();
        else if (!map.value && part.trim()) map.value = part.trim();
    }
    return map;
}

function extractAnnsAndDoc(src) {
    let i = 0, doc = null;
    const anns = [];
    while (i < src.length) {
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src.startsWith('__WENBOX_DOC__(', i)) {
            const close = findMatchingDelim(src, i + '__WENBOX_DOC__'.length, '(', ')');
            if (close > 0) {
                try { doc = JSON.parse(src.slice(i + '__WENBOX_DOC__('.length, close)); } catch {}
                i = close + 1; continue;
            }
        }
        if (src[i] === '@') {
            i++;
            const start = i;
            while (i < src.length && /[\w.$]/.test(src[i])) i++;
            const simple = src.slice(start, i).split('.').pop();
            while (i < src.length && /\s/.test(src[i])) i++;
            let args = {};
            if (src[i] === '(') {
                const close = findMatchingDelim(src, i, '(', ')');
                if (close > 0) { args = parseAnnArgs(src.slice(i + 1, close)); i = close + 1; }
            }
            anns.push({ name: simple, args });
            continue;
        }
        break;
    }
    return { anns, doc, rest: src.slice(i).trim() };
}

function extractAnnStrs(raw) {
    if (!raw) return [];
    let t = raw.trim();
    if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1);
    return splitTopLevel(t, ',').map(item => {
        const s = item.trim();
        if (s.startsWith('"') && s.endsWith('"')) {
            try { return JSON.parse(s); } catch { return s.slice(1, -1); }
        }
        return s;
    }).filter(Boolean);
}

function annStr(ann, keys) {
    for (const k of keys) {
        const list = extractAnnStrs(ann.args[k]);
        if (list.length) return list[0];
    }
    return null;
}

function annNum(ann, keys) {
    for (const k of keys) {
        if (ann.args[k] !== undefined) {
            const n = Number(String(ann.args[k]).replace(/["'LlFfDd]/g, ''));
            if (Number.isFinite(n)) return n;
        }
    }
    return null;
}

function splitMembers(body) {
    const out = [];
    let segStart = 0, p = 0, a = 0, b = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < body.length) {
                if (body[i] === '\\') i += 2;
                else if (body[i] === c) break;
                else i++;
            }
            continue;
        }
        if (c === '@' && b === 0 && p === 0 && a === 0) {
            i++;
            while (i < body.length && /[\w.]/.test(body[i])) i++;
            while (i < body.length && /\s/.test(body[i])) i++;
            if (body[i] === '(') {
                const close = findMatchingDelim(body, i, '(', ')');
                if (close > 0) i = close;
            } else i--;
            continue;
        }
        if (c === '(') p++; else if (c === ')') p = Math.max(0, p - 1);
        else if (c === '<') a++; else if (c === '>') a = Math.max(0, a - 1);
        else if (c === '{') b++;
        else if (c === '}') {
            b = Math.max(0, b - 1);
            if (b === 0 && p === 0 && a === 0) {
                const chunk = body.slice(segStart, i + 1).trim();
                if (chunk && !chunk.startsWith('package ') && !chunk.startsWith('import ')) out.push(chunk);
                segStart = i + 1;
            }
        } else if (c === ';' && b === 0 && p === 0 && a === 0) {
            const chunk = body.slice(segStart, i + 1).trim();
            if (chunk && !chunk.startsWith('package ') && !chunk.startsWith('import ')) out.push(chunk);
            segStart = i + 1;
        }
    }
    return out;
}

function findDeclOpenBrace(text) {
    let p = 0, a = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < text.length) {
                if (text[i] === '\\') i += 2;
                else if (text[i] === c) break;
                else i++;
            }
            continue;
        }
        if (c === '(') p++; else if (c === ')') p = Math.max(0, p - 1);
        else if (c === '<') a++; else if (c === '>') a = Math.max(0, a - 1);
        else if (c === '{' && p === 0 && a === 0) return i;
    }
    return -1;
}

function extractMappings(anns, isClassLevel) {
    const out = [];
    for (const ann of anns) {
        let methods = null;
        if (ann.name === 'RequestMapping') {
            methods = extractAnnStrs(ann.args.method).map(s => s.split('.').pop().toUpperCase()).filter(m => /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(m));
            if (!methods.length && !isClassLevel) methods = ['GET'];
        } else if (/^(?:Get|Post|Put|Delete|Patch)Mapping$/.test(ann.name) || /^(?:GET|POST|PUT|DELETE|PATCH)$/.test(ann.name)) {
            methods = [ann.name.replace(/Mapping$/, '').toUpperCase()];
        } else if (ann.name === 'Path') {
            methods = [];
        }
        if (!methods) continue;
        let paths = extractAnnStrs(ann.args.path || ann.args.value);
        if (!paths.length) paths = [''];
        const consumes = extractAnnStrs(ann.args.consumes)[0] || null;
        out.push({ methods, paths, consumes });
    }
    const jaxMethods = out.filter(o => o.methods.length).flatMap(o => o.methods);
    if (anns.some(a => a.name === 'Path') && jaxMethods.length) {
        const jaxPaths = out.filter(o => !o.methods.length || o.paths[0]).flatMap(o => o.paths);
        return [{ methods: jaxMethods, paths: jaxPaths.length ? jaxPaths : [''], consumes: null }];
    }
    return out;
}

function normalizeJavaType(raw) {
    return String(raw || '').replace(/java\.(?:lang|util|math|time)\./g, '').trim().replace(/\.\.\.$/, '[]');
}

function parseParamList(paramsText) {
    return splitTopLevel(paramsText, ',').map(item => {
        const { anns, rest } = extractAnnsAndDoc(item);
        const clean = rest.replace(/^(?:(?:public|private|protected|final)\s+)+/, '').trim();
        if (!clean) return null;
        let splitAt = -1;
        for (let i = clean.length - 1; i >= 0; i--) {
            if (/\s|>|\]/.test(clean[i])) { splitAt = i + 1; break; }
        }
        if (splitAt <= 0) return null;
        const rawVar = clean.slice(splitAt).trim();
        const varName = rawVar.replace(/\[\]$/, '');
        const rawType = clean.slice(0, splitAt).trim() + (rawVar.endsWith('[]') ? '[]' : '');
        const meta = {
            name: varName, type: normalizeJavaType(rawType), locationHint: null, explicitName: null,
            defaultValue: null, required: false, example: null, description: null, jsonName: null, constraints: null,
        };
        const c = {};
        for (const ann of anns) {
            if (ann.name === 'RequestBody') { meta.locationHint = 'body'; meta.required = ann.args.required !== 'false'; }
            else if (ann.name === 'PathVariable' || ann.name === 'PathParam') { meta.locationHint = 'path'; meta.explicitName = annStr(ann, ['value', 'name']); meta.required = ann.args.required !== 'false'; }
            else if (ann.name === 'RequestParam' || ann.name === 'QueryParam') { meta.locationHint = 'query'; meta.explicitName = annStr(ann, ['value', 'name']); meta.defaultValue = annStr(ann, ['defaultValue']); meta.required = ann.args.required ? ann.args.required === 'true' : meta.defaultValue === null; }
            else if (ann.name === 'RequestHeader' || ann.name === 'HeaderParam') { meta.locationHint = 'header'; meta.explicitName = annStr(ann, ['value', 'name']); meta.defaultValue = annStr(ann, ['defaultValue']); meta.required = ann.args.required ? ann.args.required === 'true' : meta.defaultValue === null; }
            else if (ann.name === 'ModelAttribute') meta.locationHint = 'queryObject';
            else if (/^(?:Schema|ApiModelProperty|Parameter|ApiParam)$/.test(ann.name)) {
                meta.explicitName ||= annStr(ann, ['name']);
                meta.example ||= annStr(ann, ['example']);
                meta.description ||= annStr(ann, ['description', 'value']);
                if (ann.args.required === 'true') meta.required = true;
            } else if (ann.name === 'JsonProperty' || ann.name === 'SerializedName') meta.jsonName = annStr(ann, ['value']);
            else if (/^(?:NotNull|NotBlank|NotEmpty)$/.test(ann.name)) meta.required = true;
            else if (ann.name === 'Min') c.min = annNum(ann, ['value']);
            else if (ann.name === 'Max') c.max = annNum(ann, ['value']);
            else if (ann.name === 'Size' || ann.name === 'Length') { c.minLen = annNum(ann, ['min']); c.maxLen = annNum(ann, ['max']); }
            else if (ann.name === 'Email') c.email = true;
        }
        if (Object.keys(c).length) meta.constraints = c;
        return meta;
    }).filter(Boolean);
}

function parseJavaFileIntoAcc(src, relPath, acc) {
    const cleaned = stripJavaCommentsWithDocs(src);
    const pkgMatch = /^\s*package\s+([^;]+);/m.exec(cleaned);
    const pkg = pkgMatch ? pkgMatch[1].trim() : '';

    function visitType(anns, doc, text, currentPkg) {
        const openBrace = findDeclOpenBrace(text);
        if (openBrace < 0) return;
        const header = text.slice(0, openBrace).trim();
        const closeBrace = text.lastIndexOf('}');
        if (closeBrace <= openBrace) return;
        const body = text.slice(openBrace + 1, closeBrace);
        const kindMatch = /\b(enum|record|interface|class)\s+([A-Za-z0-9_$]+)/.exec(header);
        if (!kindMatch) return;
        const kind = kindMatch[1], typeName = kindMatch[2];
        const fullName = currentPkg ? `${currentPkg}.${typeName}` : typeName;
        const afterName = header.slice(kindMatch.index + kindMatch[0].length).trim();
        const extMatch = /\bextends\s+([A-Za-z0-9_.$]+)/.exec(afterName);
        const superClass = extMatch && !['Object', 'implements'].includes(simpleTypeName(extMatch[1])) ? simpleTypeName(extMatch[1]) : null;

        if (kind === 'enum') {
            const enumHead = body.split(';')[0];
            const enumValues = splitTopLevel(enumHead, ',').map(item => extractAnnsAndDoc(item).rest.split(/[^\w$]/)[0]).filter(Boolean);
            acc.types[fullName] = { name: typeName, fullName, kind: 'enum', superClass: null, enumValues, fields: [] };
        }

        const isController = anns.some(a => /^(?:RestController|Controller|FeignClient|Path)$/.test(a.name));
        const classMappings = extractMappings(anns, true);
        const group = anns.find(a => a.name === 'Tag' || a.name === 'Api') ? (annStr(anns.find(a => a.name === 'Tag' || a.name === 'Api'), ['name', 'tags', 'value', 'description']) || typeName) : (doc || typeName);

        const fields = [];
        if (kind === 'record') {
            const parenIdx = afterName.indexOf('(');
            const parenEnd = parenIdx >= 0 ? findMatchingDelim(afterName, parenIdx, '(', ')') : -1;
            if (parenEnd > parenIdx) {
                for (const p of parseParamList(afterName.slice(parenIdx + 1, parenEnd))) {
                    fields.push({ name: p.jsonName || p.name, javaName: p.name, type: p.type, required: p.required, example: p.example, description: p.description, constraints: p.constraints });
                }
            }
        }

        let foundEps = 0;
        for (const member of splitMembers(body)) {
            const { anns: mAnns, doc: mDoc, rest: mRest } = extractAnnsAndDoc(member);
            if (!mRest) continue;
            const nestedBrace = findDeclOpenBrace(mRest);
            if (nestedBrace >= 0 && /\b(?:class|record|enum|interface)\b/.test(mRest.slice(0, nestedBrace))) {
                visitType(mAnns, mDoc, mRest, fullName);
                continue;
            }
            const sig = nestedBrace >= 0 ? mRest.slice(0, nestedBrace).trim() : (mRest.endsWith(';') ? mRest.slice(0, -1).trim() : '');
            if (!sig) continue;
            if (sig.includes('(') && (nestedBrace >= 0 || kind === 'interface') && (isController || classMappings.length)) {
                const mMaps = extractMappings(mAnns, false);
                if (!mMaps.length) continue;
                const opP = sig.indexOf('('), clP = sig.lastIndexOf(')');
                const mName = sig.slice(0, opP).trim().split(/[^\w$]+/).filter(Boolean).pop() || 'endpoint';
                const rawParams = parseParamList(sig.slice(opP + 1, clP));
                const opAnn = mAnns.find(a => a.name === 'Operation' || a.name === 'ApiOperation');
                const summary = (opAnn && annStr(opAnn, ['summary', 'value', 'notes', 'description'])) || mDoc || mName;
                const prefixes = classMappings.flatMap(m => m.paths);
                if (!prefixes.length) prefixes.push('');
                const clsMethods = classMappings.flatMap(m => m.methods);
                for (const mm of mMaps) {
                    const httpMethods = mm.methods.length ? mm.methods : (clsMethods.length ? clsMethods : ['GET']);
                    for (const prefix of prefixes) for (const suffix of mm.paths) {
                        const fullPath = combinePaths(prefix, suffix);
                        for (const httpMethod of httpMethods) {
                            const params = rawParams.filter(p => !isIgnoredInjectedType(p.type)).map(p => {
                                const name = p.explicitName || p.name;
                                let location = p.locationHint;
                                if (location === 'query' && !isScalarType(p.type) && !isCollectionOrMap(p.type) && !p.explicitName) location = 'queryObject';
                                if (!location) {
                                    if (fullPath.includes(`{${name}}`) || fullPath.includes(`{${name}:`)) location = 'path';
                                    else if (!isScalarType(p.type) && !isCollectionOrMap(p.type)) location = 'queryObject';
                                    else location = 'query';
                                }
                                return { name, location, type: p.type, required: p.required, defaultValue: p.defaultValue, example: p.example, description: p.description, inferredName: false };
                            });
                            acc.endpoints.push({
                                id: `${typeName}::${mName}::${httpMethod}::${fullPath}`,
                                group, controller: typeName, methodName: mName, summary, method: httpMethod, path: fullPath,
                                contentType: mm.consumes || (params.some(p => p.location === 'body') ? 'application/json' : null),
                                params, sourceFile: relPath, warnings: [],
                            });
                            foundEps++;
                        }
                    }
                }
            } else if (!sig.includes('(') && mRest.endsWith(';') && kind !== 'interface') {
                if (/\b(?:static|transient)\b/.test(` ${sig} `)) continue;
                if (mAnns.some(a => a.name === 'JsonIgnore' && a.args.value !== 'false')) continue;
                const clean = sig.replace(/^(?:(?:public|private|protected|final)\s+)+/, '').trim();
                const parts = splitTopLevel(clean, ',');
                const firstLeft = (splitFirstEq(parts[0])?.[0] || parts[0]).trim();
                let typeEnd = -1;
                for (let idx = firstLeft.length - 1; idx >= 0; idx--) {
                    if (/\s|>|\]/.test(firstLeft[idx])) { typeEnd = idx + 1; break; }
                }
                if (typeEnd <= 0) continue;
                const rawType = firstLeft.slice(0, typeEnd).trim();
                const renameAnn = mAnns.find(a => a.name === 'JsonProperty' || a.name === 'SerializedName');
                const rename = renameAnn ? annStr(renameAnn, ['value']) : null;
                const schemaAnn = mAnns.find(a => a.name === 'Schema' || a.name === 'ApiModelProperty');
                const annExample = schemaAnn ? annStr(schemaAnn, ['example']) : null;
                const description = (schemaAnn && annStr(schemaAnn, ['description', 'value'])) || mDoc || null;
                const required = (schemaAnn?.args.required === 'true') || mAnns.some(a => /^(?:NotNull|NotBlank|NotEmpty)$/.test(a.name));
                const c = {};
                for (const a of mAnns) {
                    if (a.name === 'Min') c.min = annNum(a, ['value']);
                    else if (a.name === 'Max') c.max = annNum(a, ['value']);
                    else if (a.name === 'Size' || a.name === 'Length') { c.minLen = annNum(a, ['min']); c.maxLen = annNum(a, ['max']); }
                    else if (a.name === 'Email') c.email = true;
                }
                parts.forEach((part, idx) => {
                    const eq = splitFirstEq(part);
                    const lhs = (eq ? eq[0] : part).trim();
                    const init = eq ? eq[1].trim() : null;
                    const rawVar = idx === 0 ? lhs.slice(typeEnd).trim() : lhs;
                    const jName = rawVar.replace(/\[\]$/, '').trim();
                    if (!/^[\w$]+$/.test(jName)) return;
                    let example = annExample;
                    if (example === null && init) {
                        if (init.startsWith('"') && init.endsWith('"')) { try { example = JSON.parse(init); } catch {} }
                        else if (init === 'true' || init === 'false' || /^-?\d+(?:\.\d+)?$/.test(init)) example = init;
                    }
                    fields.push({
                        name: idx === 0 && rename ? rename : jName,
                        javaName: jName,
                        type: normalizeJavaType(rawType + (rawVar.endsWith('[]') ? '[]' : '')),
                        required, example, description, constraints: Object.keys(c).length ? c : null,
                    });
                });
            }
        }
        if (foundEps > 0 || isController) acc.controllers.add(fullName);
        if (kind !== 'enum' && (!isController || fields.length)) {
            acc.types[fullName] = { name: typeName, fullName, kind, superClass, enumValues: [], fields };
        }
    }

    for (const member of splitMembers(cleaned)) {
        const { anns, doc, rest } = extractAnnsAndDoc(member);
        const ob = findDeclOpenBrace(rest);
        if (ob >= 0 && /\b(?:class|record|enum|interface)\b/.test(rest.slice(0, ob))) {
            visitType(anns, doc, rest, pkg);
        }
    }
}

export function scanOpenApiString(sourceName, sourcePath, text) {
    const doc = JSON.parse(text);
    if (!doc.openapi && !doc.swagger) throw Error('不是有效的 OpenAPI / Swagger JSON 文件');
    let baseUrl = null;
    if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
        const u = String(doc.servers[0].url).trim();
        if (/^https?:\/\//i.test(u)) baseUrl = u.replace(/\/+$/, '');
    } else if (doc.host) {
        const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || 'http';
        baseUrl = `${scheme}://${doc.host}${normalizePathSegment(doc.basePath || '')}`;
    }
    const types = {};
    const indexSchema = (name, schema) => {
        if (!schema || typeof schema !== 'object') return;
        if (Array.isArray(schema.enum)) {
            types[name] = { name, fullName: name, kind: 'enum', superClass: null, enumValues: schema.enum.map(String), fields: [] };
            return;
        }
        let superClass = null;
        const propObjs = [];
        if (schema.properties) propObjs.push(schema.properties);
        if (Array.isArray(schema.allOf)) {
            for (const sub of schema.allOf) {
                if (sub.$ref && !superClass) superClass = sub.$ref.split('/').pop();
                if (sub.properties) propObjs.push(sub.properties);
            }
        }
        const reqSet = new Set(schema.required || []);
        const fields = [];
        for (const props of propObjs) {
            for (const [k, ps] of Object.entries(props)) {
                const c = {};
                if (ps.minimum !== undefined) c.min = ps.minimum;
                if (ps.maximum !== undefined) c.max = ps.maximum;
                if (ps.minLength !== undefined) c.minLen = ps.minLength;
                if (ps.maxLength !== undefined) c.maxLen = ps.maxLength;
                if (ps.format === 'email') c.email = true;
                fields.push({
                    name: k, javaName: k, type: schemaToType(ps, `${name}_${k}`), required: reqSet.has(k),
                    example: ps.example !== undefined ? String(ps.example) : (ps.default !== undefined ? String(ps.default) : null),
                    description: ps.description || null, constraints: Object.keys(c).length ? c : null,
                });
            }
        }
        types[name] = { name, fullName: name, kind: 'class', superClass, enumValues: [], fields };
    };
    const schemaToType = (schema, hint) => {
        if (!schema) return 'Object';
        if (schema.$ref) return schema.$ref.split('/').pop();
        if (Array.isArray(schema.enum)) { indexSchema(hint, schema); return hint; }
        switch (schema.type) {
            case 'string': return schema.format === 'date' ? 'LocalDate' : schema.format === 'date-time' ? 'LocalDateTime' : schema.format === 'uuid' ? 'UUID' : 'String';
            case 'integer': return schema.format === 'int64' ? 'Long' : 'Integer';
            case 'number': return (schema.format === 'float' || schema.format === 'double') ? 'Double' : 'BigDecimal';
            case 'boolean': return 'Boolean';
            case 'array': return `List<${schemaToType(schema.items, `${hint}Item`)}>`;
            case 'object':
            default:
                if (schema.properties || schema.allOf) { if (!types[hint]) indexSchema(hint, schema); return hint; }
                return 'Map<String, Object>';
        }
    };
    const schemas = doc.components?.schemas || doc.definitions || {};
    for (const [n, s] of Object.entries(schemas)) indexSchema(n, s);

    const endpoints = [], groups = new Set();
    for (const [rawPath, item] of Object.entries(doc.paths || {})) {
        const sharedParams = Array.isArray(item?.parameters) ? item.parameters : [];
        for (const m of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
            const op = item?.[m];
            if (!op) continue;
            const method = m.toUpperCase();
            const group = (Array.isArray(op.tags) && op.tags[0]) || 'OpenAPI';
            groups.add(group);
            const operationId = op.operationId || rawPath;
            const params = [];
            let contentType = null;
            for (const p of [...sharedParams, ...(op.parameters || [])]) {
                const loc = p.in === 'path' ? 'path' : p.in === 'header' ? 'header' : p.in === 'body' ? 'body' : 'query';
                if (loc === 'body') contentType = 'application/json';
                const sch = p.schema || p;
                params.push({
                    name: p.name, location: loc, type: schemaToType(sch, `${operationId}_${p.name}`),
                    required: p.required ?? (loc === 'path'),
                    defaultValue: sch.default !== undefined ? String(sch.default) : null,
                    example: (p.example ?? sch.example) !== undefined ? String(p.example ?? sch.example) : null,
                    description: p.description || null, inferredName: false,
                });
            }
            const rbContent = op.requestBody?.content;
            if (rbContent) {
                const ct = rbContent['application/json'] ? 'application/json' : Object.keys(rbContent)[0];
                const media = ct && rbContent[ct];
                if (media?.schema) {
                    contentType = ct;
                    params.push({
                        name: 'body', location: 'body', type: schemaToType(media.schema, `${operationId}Body`),
                        required: op.requestBody.required ?? true, defaultValue: null,
                        example: (media.example ?? media.schema.example) !== undefined ? String(media.example ?? media.schema.example) : null,
                        description: op.requestBody.description || null, inferredName: false,
                    });
                }
            }
            endpoints.push({
                id: `${group}::${operationId}::${method}::${rawPath}`,
                group, controller: group, methodName: operationId, summary: op.summary || op.description || operationId,
                method, path: normalizePathSegment(rawPath) || '/', contentType, params, sourceFile: sourceName, warnings: [],
            });
        }
    }
    return {
        sourceName, sourceKind: 'openapi-json', sourcePath, baseUrl, endpoints, types,
        stats: { filesScanned: 1, controllersFound: groups.size, endpointsFound: endpoints.length, typesIndexed: Object.keys(types).length },
        warnings: [],
    };
}

// ---------- Browser ZIP + JVM .class Bytecode Reader ----------

async function inflateRawBytes(bytes) {
    if (typeof DecompressionStream !== 'function') throw Error('当前运行环境不支持 deflate 解压，请使用 WenBox 桌面客户端扫描 JAR。');
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const outPromise = new Response(ds.readable).arrayBuffer();
    const [, ab] = await Promise.all([writePromise, outPromise]);
    return new Uint8Array(ab);
}

function parseZipEntriesJS(u8) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const minPos = Math.max(0, u8.length - 65557);
    let eocd = -1;
    for (let pos = u8.length - 22; pos >= minPos; pos--) {
        if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === u8.length) {
            eocd = pos; break;
        }
    }
    if (eocd < 0) throw Error('未找到 JAR/ZIP 目录结构');
    const total = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (total > MAX_ZIP_ENTRIES) throw Error('压缩包条目过多');
    const dec = new TextDecoder();
    const entries = [];
    let pos = cdOffset;
    for (let i = 0; i < total; i++) {
        if (view.getUint32(pos, true) !== 0x02014b50) throw Error('ZIP 目录条目损坏');
        const method = view.getUint16(pos + 10, true);
        const compSize = view.getUint32(pos + 20, true);
        const uncompSize = view.getUint32(pos + 24, true);
        const nLen = view.getUint16(pos + 28, true);
        const eLen = view.getUint16(pos + 30, true);
        const cLen = view.getUint16(pos + 32, true);
        const lfhOffset = view.getUint32(pos + 42, true);
        const name = dec.decode(u8.subarray(pos + 46, pos + 46 + nLen));
        entries.push({ name, method, compSize, uncompSize, lfhOffset });
        pos += 46 + nLen + eLen + cLen;
    }
    return entries;
}

async function readZipEntryJS(u8, entry) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const lfh = entry.lfhOffset;
    if (view.getUint32(lfh, true) !== 0x04034b50) throw Error(`ZIP 文件头损坏：${entry.name}`);
    const nLen = view.getUint16(lfh + 26, true);
    const eLen = view.getUint16(lfh + 28, true);
    const start = lfh + 30 + nLen + eLen;
    const payload = u8.subarray(start, start + entry.compSize);
    if (entry.method === 0) return payload;
    if (entry.method === 8) return inflateRawBytes(payload);
    throw Error(`不支持的压缩方法 ${entry.method}`);
}

function parseJvmSigAt(sig, ref) {
    if (ref.i >= sig.length) return 'Object';
    const c = sig[ref.i];
    if ('BCDFIJSVZ'.includes(c)) {
        ref.i++;
        return { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }[c];
    }
    if (c === '[') { ref.i++; return parseJvmSigAt(sig, ref) + '[]'; }
    if (c === '+' || c === '-') { ref.i++; return parseJvmSigAt(sig, ref); }
    if (c === '*') { ref.i++; return 'Object'; }
    if (c === 'T') {
        ref.i++;
        const end = sig.indexOf(';', ref.i);
        const name = end >= 0 ? sig.slice(ref.i, end) : 'Object';
        ref.i = end >= 0 ? end + 1 : sig.length;
        return name || 'Object';
    }
    if (c === 'L') {
        ref.i++;
        let lastSimple = 'Object', lastArgs = [];
        while (ref.i < sig.length) {
            const start = ref.i;
            while (ref.i < sig.length && !';<.'.includes(sig[ref.i])) ref.i++;
            const rawCls = sig.slice(start, ref.i).replace(/\//g, '.');
            lastSimple = simpleTypeName(rawCls);
            lastArgs = [];
            if (sig[ref.i] === '<') {
                ref.i++;
                while (ref.i < sig.length && sig[ref.i] !== '>') lastArgs.push(parseJvmSigAt(sig, ref));
                if (sig[ref.i] === '>') ref.i++;
            }
            if (sig[ref.i] === '.') { ref.i++; continue; }
            if (sig[ref.i] === ';') ref.i++;
            break;
        }
        return lastArgs.length ? `${lastSimple}<${lastArgs.join(', ')}>` : lastSimple;
    }
    ref.i++;
    return 'Object';
}

const jvmDescToType = desc => parseJvmSigAt(desc, { i: 0 });
function jvmMethodParams(sig) {
    const ref = { i: 0 };
    if (sig[0] === '<') {
        let depth = 0;
        while (ref.i < sig.length) {
            if (sig[ref.i] === '<') depth++;
            else if (sig[ref.i] === '>') { depth--; if (depth === 0) { ref.i++; break; } }
            ref.i++;
        }
    }
    while (ref.i < sig.length && sig[ref.i] !== '(') ref.i++;
    if (ref.i >= sig.length) return [];
    ref.i++;
    const out = [];
    while (ref.i < sig.length && sig[ref.i] !== ')') out.push(parseJvmSigAt(sig, ref));
    return out;
}

function parseClassBytesJS(u8, relPath, acc, typesOnly) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 0;
    const u1 = () => u8[pos++];
    const u2 = () => { const v = dv.getUint16(pos, false); pos += 2; return v; };
    const u4 = () => { const v = dv.getUint32(pos, false); pos += 4; return v; };
    if (u4() !== 0xcafebabe) return;
    u2(); u2();
    const cpCount = u2();
    const cp = new Array(cpCount).fill(null);
    const dec = new TextDecoder();
    for (let i = 1; i < cpCount; i++) {
        const tag = u1();
        if (tag === 1) { const len = u2(); cp[i] = { t: 1, v: dec.decode(u8.subarray(pos, pos + len)) }; pos += len; }
        else if (tag === 3) { cp[i] = { t: 3, v: dv.getInt32(pos, false) }; pos += 4; }
        else if (tag === 4) { cp[i] = { t: 4, v: dv.getFloat32(pos, false) }; pos += 4; }
        else if (tag === 5) { cp[i] = { t: 5, v: Number(dv.getBigInt64(pos, false)) }; pos += 8; i++; }
        else if (tag === 6) { cp[i] = { t: 6, v: dv.getFloat64(pos, false) }; pos += 8; i++; }
        else if (tag === 7 || tag === 8) { cp[i] = { t: tag, v: u2() }; }
        else if ([9, 10, 11, 12, 17, 18].includes(tag)) pos += 4;
        else if (tag === 15) pos += 3;
        else if ([16, 19, 20].includes(tag)) pos += 2;
        else return;
    }
    const utf8 = idx => (cp[idx]?.t === 1 ? cp[idx].v : '');
    const clsName = idx => (cp[idx]?.t === 7 ? utf8(cp[idx].v).replace(/\//g, '.') : '');
    const readAnnSlice = (bytes, isParam) => {
        const adv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let ap = 0;
        const au1 = () => bytes[ap++];
        const au2 = () => { const v = adv.getUint16(ap, false); ap += 2; return v; };
        const readVal = () => {
            const tag = String.fromCharCode(au1());
            if (tag === 's') return utf8(au2());
            if (tag === 'Z') return Boolean(cp[au2()]?.v);
            if ('BCSIJFD'.includes(tag)) return String(cp[au2()]?.v ?? 0);
            if (tag === 'e') { au2(); return utf8(au2()); }
            if (tag === 'c') return jvmDescToType(utf8(au2()));
            if (tag === '@') return readAnn();
            if (tag === '[') { const n = au2(); const arr = []; for (let k = 0; k < n; k++) arr.push(readVal()); return arr; }
            return null;
        };
        const readAnn = () => {
            const name = simpleTypeName(jvmDescToType(utf8(au2())));
            const pairs = au2();
            const args = {};
            for (let k = 0; k < pairs; k++) { const key = utf8(au2()); args[key] = readVal(); }
            return { name, args };
        };
        if (isParam) {
            const pc = au1(), out = [];
            for (let i = 0; i < pc; i++) { const ac = au2(), a = []; for (let j = 0; j < ac; j++) a.push(readAnn()); out.push(a); }
            return out;
        }
        const ac = au2(), out = [];
        for (let j = 0; j < ac; j++) out.push(readAnn());
        return out;
    };

    const accFlags = u2(), thisIdx = u2(), superIdx = u2();
    const fullName = clsName(thisIdx) || relPath.replace(/\.class$/, '').replace(/\//g, '.');
    const simple = fullName.split(/[.$]/).pop();
    const superFull = superIdx ? clsName(superIdx) : null;
    const superClass = superFull && !/^(?:java\.lang\.(?:Object|Enum|Record))$/.test(superFull) ? simpleTypeName(superFull) : null;
    const ifaceCount = u2(); pos += ifaceCount * 2; // interfaces
    const isEnum = (accFlags & 0x4000) !== 0;
    const enumValues = [], fields = [];
    const fCount = u2();
    for (let i = 0; i < fCount; i++) {
        const ff = u2(), fName = utf8(u2()), fDesc = utf8(u2()), fAttrs = u2();
        let fSig = null, fAnns = [];
        for (let a = 0; a < fAttrs; a++) {
            const aName = utf8(u2()), aLen = u4(), slice = u8.subarray(pos, pos + aLen); pos += aLen;
            if (aName === 'Signature') fSig = utf8((slice[0] << 8) | slice[1]);
            else if (aName === 'RuntimeVisibleAnnotations') fAnns = readAnnSlice(slice, false);
        }
        if (isEnum && (ff & 0x4000)) { enumValues.push(fName); continue; }
        if (ff & (0x0008 | 0x0080 | 0x1000) || fName.startsWith('$')) continue;
        if (fAnns.some(a => a.name === 'JsonIgnore' && a.args.value !== false)) continue;
        const jProp = fAnns.find(a => a.name === 'JsonProperty' || a.name === 'SerializedName');
        const sch = fAnns.find(a => a.name === 'Schema' || a.name === 'ApiModelProperty');
        const c = {};
        for (const a of fAnns) {
            if (a.name === 'Min' && a.args.value !== undefined) c.min = Number(a.args.value);
            if (a.name === 'Max' && a.args.value !== undefined) c.max = Number(a.args.value);
            if ((a.name === 'Size' || a.name === 'Length')) { if (a.args.min !== undefined) c.minLen = Number(a.args.min); if (a.args.max !== undefined) c.maxLen = Number(a.args.max); }
            if (a.name === 'Email') c.email = true;
        }
        fields.push({
            name: (typeof jProp?.args.value === 'string' && jProp.args.value) || fName,
            javaName: fName, type: jvmDescToType(fSig || fDesc),
            required: sch?.args.required === true || fAnns.some(a => /^(?:NotNull|NotBlank|NotEmpty)$/.test(a.name)),
            example: typeof sch?.args.example === 'string' ? sch.args.example : null,
            description: typeof (sch?.args.description || sch?.args.value) === 'string' ? (sch.args.description || sch.args.value) : null,
            constraints: Object.keys(c).length ? c : null,
        });
    }

    const methods = [], mCount = u2();
    for (let i = 0; i < mCount; i++) {
        const mf = u2(), mName = utf8(u2()), mDesc = utf8(u2()), mAttrs = u2();
        let mSig = null, mAnns = [], pAnns = [], pNames = [];
        for (let a = 0; a < mAttrs; a++) {
            const aName = utf8(u2()), aLen = u4(), slice = u8.subarray(pos, pos + aLen); pos += aLen;
            if (aName === 'Signature') mSig = utf8((slice[0] << 8) | slice[1]);
            else if (aName === 'RuntimeVisibleAnnotations') mAnns = readAnnSlice(slice, false);
            else if (aName === 'RuntimeVisibleParameterAnnotations') pAnns = readAnnSlice(slice, true);
            else if (aName === 'MethodParameters') {
                const mc = slice[0];
                for (let p = 0; p < mc; p++) {
                    const ni = (slice[1 + p * 4] << 8) | slice[2 + p * 4];
                    pNames.push(ni ? utf8(ni) : null);
                }
            }
        }
        if (!(mf & (0x1000 | 0x0040)) && !mName.startsWith('<') && !typesOnly) {
            methods.push({ mName, mDesc, mSig, mAnns, pAnns, pNames });
        }
    }

    let cAnns = [];
    const cAttrs = u2();
    for (let a = 0; a < cAttrs; a++) {
        const aName = utf8(u2()), aLen = u4(), slice = u8.subarray(pos, pos + aLen); pos += aLen;
        if (aName === 'RuntimeVisibleAnnotations') cAnns = readAnnSlice(slice, false);
    }

    const asList = v => Array.isArray(v) ? v.map(String) : (v !== undefined && v !== null ? [String(v)] : []);
    const classMap = cAnns.filter(a => /^(?:RequestMapping|Path)$/.test(a.name)).map(a => ({
        methods: asList(a.args.method).map(s => s.toUpperCase()).filter(Boolean),
        paths: asList(a.args.path ?? a.args.value).length ? asList(a.args.path ?? a.args.value) : [''],
    }));
    const isController = cAnns.some(a => /^(?:RestController|Controller|FeignClient|Path)$/.test(a.name));
    const tagAnn = cAnns.find(a => a.name === 'Tag' || a.name === 'Api');
    const group = asList(tagAnn?.args.name ?? tagAnn?.args.tags ?? tagAnn?.args.value)[0] || simple;

    if (!typesOnly && (isController || classMap.length)) {
        const prefixes = classMap.flatMap(m => m.paths); if (!prefixes.length) prefixes.push('');
        const clsMethods = classMap.flatMap(m => m.methods);
        for (const m of methods) {
            const mMaps = m.mAnns.map(a => {
                if (a.name === 'RequestMapping') return { methods: asList(a.args.method).map(s => s.toUpperCase()), paths: asList(a.args.path ?? a.args.value) };
                if (/^(?:Get|Post|Put|Delete|Patch)Mapping$/.test(a.name) || /^(?:GET|POST|PUT|DELETE|PATCH)$/.test(a.name)) {
                    return { methods: [a.name.replace(/Mapping$/, '').toUpperCase()], paths: asList(a.args.path ?? a.args.value) };
                }
                return null;
            }).filter(Boolean);
            if (!mMaps.length) continue;
            const descParams = jvmMethodParams(m.mDesc);
            let sigParams = jvmMethodParams(m.mSig || m.mDesc);
            if (sigParams.length !== descParams.length) sigParams = descParams;
            const opAnn = m.mAnns.find(a => a.name === 'Operation' || a.name === 'ApiOperation');
            const summary = asList(opAnn?.args.summary ?? opAnn?.args.value)[0] || m.mName;
            for (const mm of mMaps) {
                const paths = mm.paths.length ? mm.paths : [''];
                const httpMethods = mm.methods.length ? mm.methods : (clsMethods.length ? clsMethods : ['GET']);
                for (const prefix of prefixes) for (const suffix of paths) {
                    const fullPath = combinePaths(prefix, suffix);
                    for (const httpMethod of httpMethods) {
                        const warnings = [];
                        const params = sigParams.map((t, idx) => {
                            if (isIgnoredInjectedType(t)) return null;
                            const pa = m.pAnns[idx] || [];
                            const rb = pa.find(a => a.name === 'RequestBody');
                            const pv = pa.find(a => a.name === 'PathVariable' || a.name === 'PathParam');
                            const rp = pa.find(a => a.name === 'RequestParam' || a.name === 'QueryParam');
                            const rh = pa.find(a => a.name === 'RequestHeader' || a.name === 'HeaderParam');
                            const ma = pa.find(a => a.name === 'ModelAttribute');
                            const sc = pa.find(a => a.name === 'Schema' || a.name === 'Parameter' || a.name === 'ApiParam');
                            const explicit = asList(pv?.args.value ?? pv?.args.name ?? rp?.args.value ?? rp?.args.name ?? rh?.args.value ?? rh?.args.name ?? sc?.args.name)[0] || null;
                            const byteName = m.pNames[idx] || null;
                            const inferredName = !explicit && !byteName;
                            const name = explicit || byteName || `arg${idx}`;
                            const defVal = asList(rp?.args.defaultValue ?? rh?.args.defaultValue)[0] || null;
                            let location = rb ? 'body' : pv ? 'path' : rh ? 'header' : ma ? 'queryObject' : rp ? 'query' : null;
                            if (location === 'query' && !isScalarType(t) && !isCollectionOrMap(t) && inferredName) location = 'queryObject';
                            if (!location) location = fullPath.includes(`{${name}}`) ? 'path' : (!isScalarType(t) && !isCollectionOrMap(t)) ? 'queryObject' : 'query';
                            if (inferredName && location !== 'body' && location !== 'queryObject') warnings.push(`字节码未保留参数名，已使用 ${name} 占位。`);
                            return {
                                name, location, type: t, required: Boolean(rb || pv || sc?.args.required === true),
                                defaultValue: defVal, example: asList(sc?.args.example)[0] || null, description: asList(sc?.args.description)[0] || null, inferredName,
                            };
                        }).filter(Boolean);
                        acc.endpoints.push({
                            id: `${simple}::${m.mName}::${httpMethod}::${fullPath}`,
                            group, controller: simple, methodName: m.mName, summary, method: httpMethod, path: fullPath,
                            contentType: params.some(p => p.location === 'body') ? 'application/json' : null,
                            params, sourceFile: relPath, warnings,
                        });
                    }
                }
            }
        }
        acc.controllers.add(fullName);
    }
    if (isEnum || (!isController && (fields.length || superClass))) {
        acc.types[fullName] = { name: simple, fullName, kind: isEnum ? 'enum' : 'class', superClass, enumValues, fields };
    }
}

function shouldSkipFrameworkJar(name) {
    const base = name.split('/').pop().toLowerCase();
    return /^(?:spring-|tomcat-|jackson-|netty-|hibernate-|slf4j-|logback-|log4j-|guava-|junit-|kotlin-|reactor-|micrometer-|mysql-|postgresql-|swagger-|springdoc-|springfox-|jakarta\.|javax\.|aspectj|bytebuddy|byte-buddy|asm-|cglib-|snakeyaml-|commons-|httpclient|httpcore|okhttp|okio|fastjson|hutool-|mybatis|druid-|hikaricp-|lettuce-|jedis-|protobuf-|grpc-)/.test(base);
}

function shouldSkipClassPath(name) {
    const clean = name.replace(/^BOOT-INF\/classes\//, '');
    return /^(?:java|javax|jakarta|sun|com\/sun|org\/springframework|org\/apache|com\/fasterxml|io\/netty|org\/hibernate|org\/slf4j|ch\/qos\/logback|reactor|io\/micrometer|io\/swagger|org\/springdoc|kotlin)\//.test(clean) || /(?:module-info|package-info)\.class$/.test(clean);
}

export async function scanBrowserFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) throw Error('请先选择项目目录、JAR 或 OpenAPI JSON 文件');
    const firstRel = files[0].webkitRelativePath || files[0].name;
    const rootName = firstRel.includes('/') ? firstRel.split('/')[0] : (files.length === 1 ? files[0].name : 'Selected Project');

    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.json')) {
        return scanOpenApiString(files[0].name, files[0].name, await files[0].text());
    }
    if (files.length === 1 && /\.(?:jar|war)$/i.test(files[0].name)) {
        const buf = new Uint8Array(await files[0].arrayBuffer());
        const entries = parseZipEntriesJS(buf);
        const isFat = entries.some(e => e.name.startsWith('BOOT-INF/classes/') || e.name.startsWith('BOOT-INF/lib/'));
        const acc = { endpoints: [], types: {}, controllers: new Set(), cfg: { port: null, contextPath: null }, filesScanned: 0, warnings: [] };
        const nestedJars = [];
        const dec = new TextDecoder();
        for (const e of entries) {
            const lower = e.name.toLowerCase();
            if (/^(?:boot-inf\/classes\/)?application\.(?:yml|yaml)$/.test(lower)) {
                acc.filesScanned++; parseSpringConfig(dec.decode(await readZipEntryJS(buf, e)), false, acc.cfg);
            } else if (/^(?:boot-inf\/classes\/)?application\.properties$/.test(lower)) {
                acc.filesScanned++; parseSpringConfig(dec.decode(await readZipEntryJS(buf, e)), true, acc.cfg);
            } else if (lower.startsWith('boot-inf/lib/') && lower.endsWith('.jar')) {
                nestedJars.push(e);
            } else if (lower.endsWith('.class')) {
                if (isFat && !e.name.startsWith('BOOT-INF/classes/')) continue;
                if (shouldSkipClassPath(e.name)) continue;
                acc.filesScanned++;
                parseClassBytesJS(await readZipEntryJS(buf, e), e.name.replace(/^BOOT-INF\/classes\//, ''), acc, false);
            }
        }
        for (const nj of nestedJars.filter(j => !shouldSkipFrameworkJar(j.name)).slice(0, MAX_NESTED_JARS)) {
            try {
                const njBuf = await readZipEntryJS(buf, nj);
                for (const ie of parseZipEntriesJS(njBuf)) {
                    if (ie.name.endsWith('.class') && !shouldSkipClassPath(ie.name)) {
                        parseClassBytesJS(await readZipEntryJS(njBuf, ie), ie.name, acc, true);
                    }
                }
            } catch {}
        }
        const ctx = normalizePathSegment(acc.cfg.contextPath || '');
        const baseUrl = (acc.cfg.port || ctx) ? `http://127.0.0.1:${acc.cfg.port || '8080'}${ctx}` : null;
        acc.endpoints.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
        return {
            sourceName: files[0].name, sourceKind: isFat ? 'spring-fat-jar' : 'jar', sourcePath: files[0].name, baseUrl,
            endpoints: acc.endpoints, types: acc.types,
            stats: { filesScanned: acc.filesScanned, controllersFound: acc.controllers.size, endpointsFound: acc.endpoints.length, typesIndexed: Object.keys(acc.types).length },
            warnings: acc.warnings,
        };
    }

    const acc = { endpoints: [], types: {}, controllers: new Set(), cfg: { port: null, contextPath: null }, filesScanned: 0, warnings: [] };
    const openapiFallback = [];
    for (const f of files) {
        const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
        if (/(?:^|\/)(?:\.git|target|build|node_modules|\.idea|\.gradle|dist|out|src\/test)\//.test(rel) || /Tests?\.java$/.test(rel)) continue;
        const lower = f.name.toLowerCase();
        if (/^(?:application|bootstrap)\.(?:yml|yaml|properties)$/.test(lower)) {
            acc.filesScanned++;
            parseSpringConfig(await f.text(), lower.endsWith('.properties'), acc.cfg);
        } else if (lower.endsWith('.java')) {
            acc.filesScanned++;
            parseJavaFileIntoAcc(await f.text(), rel, acc);
        } else if (/^(?:openapi|swagger|api-docs)\.json$/.test(lower)) {
            openapiFallback.push(f);
        }
    }
    if (!acc.endpoints.length && openapiFallback.length) {
        return scanOpenApiString(rootName, rootName, await openapiFallback[0].text());
    }
    const ctx = normalizePathSegment(acc.cfg.contextPath || '');
    const baseUrl = (acc.cfg.port || ctx) ? `http://127.0.0.1:${acc.cfg.port || '8080'}${ctx}` : null;
    acc.endpoints.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return {
        sourceName: rootName, sourceKind: files.length === 1 ? 'java-file' : 'project-dir', sourcePath: rootName, baseUrl,
        endpoints: acc.endpoints, types: acc.types,
        stats: { filesScanned: acc.filesScanned, controllersFound: acc.controllers.size, endpointsFound: acc.endpoints.length, typesIndexed: Object.keys(acc.types).length },
        warnings: acc.warnings,
    };
}
