const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const catalogMod = import('../src-tools/api-catalog.mjs');

function makeFile(name, content, relativePath = name) {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    return {
        name,
        webkitRelativePath: relativePath,
        async text() { return buf.toString('utf8'); },
        async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    };
}

function buildZip(entries) {
    const parts = [], centrals = [];
    let offset = 0;
    for (const { name, data, deflate } of entries) {
        const raw = Buffer.from(data);
        const payload = deflate ? zlib.deflateRawSync(raw) : raw;
        const method = deflate ? 8 : 0;
        const nBuf = Buffer.from(name, 'utf8');

        const lfh = Buffer.alloc(30 + nBuf.length);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt32LE(payload.length, 18);
        lfh.writeUInt32LE(raw.length, 22);
        lfh.writeUInt16LE(nBuf.length, 26);
        nBuf.copy(lfh, 30);

        const cd = Buffer.alloc(46 + nBuf.length);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(payload.length, 20);
        cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(nBuf.length, 28);
        cd.writeUInt32LE(offset, 42);
        nBuf.copy(cd, 46);

        parts.push(lfh, payload);
        centrals.push(cd);
        offset += lfh.length + payload.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cdBuf, eocd]);
}

function buildTestClass({ thisName, superName = 'java/lang/Object', access = 0x0021, fields = [], methods = [], classAnns = [] }) {
    const cp = [];
    const addUtf8 = s => {
        const b = Buffer.from(s, 'utf8');
        const e = Buffer.alloc(3 + b.length);
        e[0] = 1; e.writeUInt16BE(b.length, 1); b.copy(e, 3);
        cp.push(e); return cp.length;
    };
    const addClass = s => {
        const ni = addUtf8(s);
        const e = Buffer.alloc(3);
        e[0] = 7; e.writeUInt16BE(ni, 1);
        cp.push(e); return cp.length;
    };
    const u2 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
    const u4 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; };

    const thisIdx = addClass(thisName);
    const superIdx = addClass(superName);
    const attrRva = addUtf8('RuntimeVisibleAnnotations');
    const attrRvpa = addUtf8('RuntimeVisibleParameterAnnotations');
    const attrSig = addUtf8('Signature');
    const attrMp = addUtf8('MethodParameters');

    const encodeAnnVal = v => {
        if (Array.isArray(v)) {
            return Buffer.concat([Buffer.from('['), u2(v.length), ...v.map(encodeAnnVal)]);
        }
        if (v && v.enumDesc) {
            return Buffer.concat([Buffer.from('e'), u2(addUtf8(v.enumDesc)), u2(addUtf8(v.enumConst))]);
        }
        return Buffer.concat([Buffer.from('s'), u2(addUtf8(String(v)))]);
    };
    const encodeAnns = list => Buffer.concat([
        u2(list.length),
        ...list.map(a => {
            const entries = Object.entries(a.args || {});
            return Buffer.concat([
                u2(addUtf8(a.desc)),
                u2(entries.length),
                ...entries.flatMap(([k, v]) => [u2(addUtf8(k)), encodeAnnVal(v)]),
            ]);
        }),
    ]);

    const fBufs = [u2(fields.length)];
    for (const f of fields) {
        const fAttrs = [];
        if (f.sig) fAttrs.push(Buffer.concat([u2(attrSig), u4(2), u2(addUtf8(f.sig))]));
        fBufs.push(Buffer.concat([u2(f.flags ?? 0x0002), u2(addUtf8(f.name)), u2(addUtf8(f.desc)), u2(fAttrs.length), ...fAttrs]));
    }

    const mBufs = [u2(methods.length)];
    for (const m of methods) {
        const mAttrs = [];
        if (m.anns?.length) {
            const rva = encodeAnns(m.anns);
            mAttrs.push(Buffer.concat([u2(attrRva), u4(rva.length), rva]));
        }
        if (m.paramAnns?.length) {
            const rvpa = Buffer.concat([Buffer.from([m.paramAnns.length]), ...m.paramAnns.map(encodeAnns)]);
            mAttrs.push(Buffer.concat([u2(attrRvpa), u4(rvpa.length), rvpa]));
        }
        if (m.paramNames?.length) {
            const mp = Buffer.concat([
                Buffer.from([m.paramNames.length]),
                ...m.paramNames.map(n => Buffer.concat([u2(n ? addUtf8(n) : 0), u2(0)])),
            ]);
            mAttrs.push(Buffer.concat([u2(attrMp), u4(mp.length), mp]));
        }
        mBufs.push(Buffer.concat([u2(0x0001), u2(addUtf8(m.name)), u2(addUtf8(m.desc)), u2(mAttrs.length), ...mAttrs]));
    }

    const cAttrs = [];
    if (classAnns.length) {
        const rva = encodeAnns(classAnns);
        cAttrs.push(Buffer.concat([u2(attrRva), u4(rva.length), rva]));
    }

    return Buffer.concat([
        Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]),
        u2(cp.length + 1),
        ...cp,
        u2(access),
        u2(thisIdx),
        u2(superIdx),
        u2(0),
        ...fBufs,
        ...mBufs,
        u2(cAttrs.length),
        ...cAttrs,
    ]);
}

test('scanBrowserFiles extracts Spring Boot project directory, inheritance, and smart mock parameters', async () => {
    const { scanBrowserFiles, materializeEndpointRequest } = await catalogMod;
    const files = [
        makeFile('application.yml', 'server:\n  port: 9095\n  servlet:\n    context-path: /api\n', 'demo/src/main/resources/application.yml'),
        makeFile('BaseReq.java', 'package com.demo;\npublic class BaseReq { private String traceId; }\n', 'demo/src/main/java/com/demo/BaseReq.java'),
        makeFile('PayStatus.java', 'package com.demo;\npublic enum PayStatus { UNPAID, PAID }\n', 'demo/src/main/java/com/demo/PayStatus.java'),
        makeFile('OrderItem.java', 'package com.demo;\npublic record OrderItem(String skuCode, int qty) {}\n', 'demo/src/main/java/com/demo/OrderItem.java'),
        makeFile('CreateOrderReq.java', `package com.demo;
import java.util.List;
public class CreateOrderReq extends BaseReq {
  @Schema(example = "ORD-888")
  private String orderCode;
  @Email
  private String contactEmail;
  private PayStatus status;
  private List<OrderItem> items;
  private MissingType missingRef;
}`, 'demo/src/main/java/com/demo/CreateOrderReq.java'),
        makeFile('OrderController.java', `package com.demo;
@RestController
@Tag(name = "订单接口")
@RequestMapping("/orders")
public class OrderController {
  /** 创建订单 */
  @PostMapping("/{tenantId}")
  public String create(
    @PathVariable("tenantId") Long tenantId,
    @RequestParam(defaultValue = "20") Integer pageSize,
    @RequestHeader("X-Token") String token,
    @RequestBody CreateOrderReq req
  ) { return "ok"; }

  @GetMapping("/search")
  public String search(OrderFilter filter) { return "ok"; }
}
class OrderFilter { String keyword; int pageNum; }`, 'demo/src/main/java/com/demo/OrderController.java'),
    ];

    const catalog = await scanBrowserFiles(files);
    assert.equal(catalog.baseUrl, 'http://127.0.0.1:9095/api');
    assert.equal(catalog.endpoints.length, 2);

    const postEp = catalog.endpoints.find(e => e.method === 'POST');
    assert.equal(postEp.path, '/orders/{tenantId}');
    assert.equal(postEp.summary, '创建订单');

    const smart1 = materializeEndpointRequest(postEp, catalog, { mockMode: 'smart', seed: 1 });
    assert.equal(smart1.url, 'http://127.0.0.1:9095/api/orders/1001');
    assert.deepEqual(smart1.query.map(r => [r.name, r.value]), [['pageSize', '20']]);
    assert.deepEqual(smart1.headers.map(r => [r.name, r.value]), [['X-Token', 'demo-token-001']]);
    const body1 = JSON.parse(smart1.body);
    assert.ok('traceId' in body1);
    assert.equal(body1.orderCode, 'ORD-888');
    assert.equal(body1.contactEmail, 'demo@example.com');
    assert.equal(body1.status, 'UNPAID');
    assert.equal(body1.items.length, 1);
    assert.equal(body1.items[0].qty, 10);
    assert.ok(smart1.warnings.some(w => w.includes('MissingType')));

    const smart2 = materializeEndpointRequest(postEp, catalog, { mockMode: 'smart', seed: 2 });
    assert.equal(JSON.parse(smart2.body).status, 'PAID');

    const empty = materializeEndpointRequest(postEp, catalog, { mockMode: 'empty', seed: 1 });
    const emptyBody = JSON.parse(empty.body);
    assert.equal(emptyBody.orderCode, '');
    assert.equal(emptyBody.items[0].qty, 0);

    const getEp = catalog.endpoints.find(e => e.method === 'GET');
    const getMat = materializeEndpointRequest(getEp, catalog, { mockMode: 'smart', seed: 1 });
    assert.deepEqual(getMat.query.map(r => r.name), ['keyword', 'pageNum']);
});

test('scanBrowserFiles parses Fat JAR bytecode and BOOT-INF/lib DTOs with DecompressionStream', async () => {
    const { scanBrowserFiles, materializeEndpointRequest } = await catalogMod;
    const dtoClass = buildTestClass({
        thisName: 'com/demo/dto/CreateReq',
        fields: [
            { name: 'phone', desc: 'Ljava/lang/String;' },
            { name: 'tags', desc: 'Ljava/util/List;', sig: 'Ljava/util/List<Ljava/lang/String;>;' },
        ],
    });
    const ctrlClass = buildTestClass({
        thisName: 'com/demo/DemoController',
        classAnns: [
            { desc: 'Lorg/springframework/web/bind/annotation/RestController;' },
            { desc: 'Lorg/springframework/web/bind/annotation/RequestMapping;', args: { value: '/jar-api' } },
        ],
        methods: [{
            name: 'submit',
            desc: '(Ljava/lang/Long;Lcom/demo/dto/CreateReq;)Ljava/lang/String;',
            anns: [
                {
                    desc: 'Lorg/springframework/web/bind/annotation/RequestMapping;',
                    args: {
                        value: ['/{id}'],
                        method: [{ enumDesc: 'Lorg/springframework/web/bind/annotation/RequestMethod;', enumConst: 'POST' }],
                    },
                },
            ],
            paramAnns: [
                [{ desc: 'Lorg/springframework/web/bind/annotation/PathVariable;' }],
                [{ desc: 'Lorg/springframework/web/bind/annotation/RequestBody;' }],
            ],
            paramNames: ['id', 'req'],
        }],
    });
    const nestedJar = buildZip([{ name: 'com/demo/dto/CreateReq.class', data: dtoClass, deflate: true }]);
    const fatJar = buildZip([
        { name: 'BOOT-INF/classes/application.properties', data: Buffer.from('server.port=7777\n'), deflate: false },
        { name: 'BOOT-INF/classes/com/demo/DemoController.class', data: ctrlClass, deflate: true },
        { name: 'BOOT-INF/lib/demo-dto.jar', data: nestedJar, deflate: false },
    ]);

    const catalog = await scanBrowserFiles([makeFile('demo.jar', fatJar)]);
    assert.equal(catalog.sourceKind, 'spring-fat-jar');
    assert.equal(catalog.baseUrl, 'http://127.0.0.1:7777');
    assert.equal(catalog.endpoints.length, 1);
    const mat = materializeEndpointRequest(catalog.endpoints[0], catalog, { mockMode: 'smart' });
    assert.equal(mat.url, 'http://127.0.0.1:7777/jar-api/1001');
    const body = JSON.parse(mat.body);
    assert.match(body.phone, /^1380013800/);
    assert.equal(body.tags.length, 1);
});

test('scanBrowserFiles parses OpenAPI 3.0 JSON and handles cyclic schemas', async () => {
    const { scanBrowserFiles, materializeEndpointRequest } = await catalogMod;
    const spec = JSON.stringify({
        openapi: '3.0.1',
        servers: [{ url: 'http://127.0.0.1:8088/v2' }],
        paths: {
            '/nodes/{nodeId}': {
                post: {
                    tags: ['Nodes'],
                    operationId: 'saveNode',
                    summary: '保存节点',
                    parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'integer' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeDto' } } } },
                },
            },
        },
        components: {
            schemas: {
                NodeDto: {
                    type: 'object',
                    properties: {
                        email: { type: 'string', format: 'email' },
                        parent: { $ref: '#/components/schemas/NodeDto' },
                    },
                },
            },
        },
    });
    const catalog = await scanBrowserFiles([makeFile('openapi.json', spec)]);
    assert.equal(catalog.endpoints.length, 1);
    const mat = materializeEndpointRequest(catalog.endpoints[0], catalog, { mockMode: 'smart' });
    assert.equal(mat.url, 'http://127.0.0.1:8088/v2/nodes/1001');
    const body = JSON.parse(mat.body);
    assert.equal(body.email, 'demo@example.com');
    assert.equal(body.parent, null);
    assert.ok(mat.warnings.some(w => w.includes('循环')));
});
