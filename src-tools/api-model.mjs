import { parse as parseJava } from 'java-parser';
import { emptyRequest, methods, parseCurl, prepareRequest, row, urlParts } from './api-request.mjs';
export { emptyRequest, methods, parseCurl, prepareRequest, row, urlParts };

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
