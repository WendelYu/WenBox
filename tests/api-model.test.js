const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src-tools/api-model.mjs');

test('user VTO snippet produces fields and names the unresolved nested type', async () => {
    const { javaToJson } = await model;
    const result = javaToJson('String name;\nString code;\nprivate List<ShelfTierVto> tierList;');
    assert.equal(JSON.stringify(result.value), '{"name":"","code":"","tierList":[]}');
    assert.match(result.warnings[0], /ShelfTierVto/);
});
test('Java syntax parser handles nested classes, comments, renames, defaults and method exclusion', async () => {
    const { javaToJson } = await model;
    const result = javaToJson(`class RequestVto {
        // String ignored;
        @JsonProperty("display_name") private String name = "柜体";
        private List<ShelfTierVto> tierList;
        static int cache; transient String local; @JsonIgnore String secret;
        int a = 3, b; void update() { int localMethod = 1; }
        class ShelfTierVto { int level; boolean active = true; }
    }`);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { display_name: '柜体', tierList: [{ level: 0, active: true }], a: 3, b: 0 });
    assert.deepEqual(result.warnings, []);
});
test('cyclic Java types stop expansion; invalid or oversized source is rejected', async () => {
    const { javaToJson } = await model;
    const result = javaToJson('class Node { String name; Node parent; List<Node> children; }');
    assert.equal(result.value.parent, null); assert.deepEqual(result.value.children, []);
    assert.match(result.warnings[0], /循环/);
    assert.throws(() => javaToJson('private name;'), /无法解析/);
    assert.throws(() => javaToJson('a'.repeat(65537)), /64 KiB/);
});
test('JSON, query and cURL imports preserve encoded values and repeated query keys', async () => {
    const { importText } = await model;
    assert.deepEqual(importText('{"name":"测试"}').value, { name: '测试' });
    assert.deepEqual(importText('a=1&a=2&name=%E6%B5%8B%E8%AF%95').rows.map(r => [r.name, r.value]), [['a','1'],['a','2'],['name','测试']]);
    const { request } = importText(`curl -XPOST 'https://example.com/items?q=one&q=two' \\
      -H 'Content-Type: application/json' -H 'Authorization: Bearer token' --data-raw '{"name":"张三","code":"A:B"}'`);
    assert.equal(request.method, 'POST'); assert.equal(request.url, 'https://example.com/items');
    assert.equal(request.query.length, 2); assert.equal(request.bodyMode, 'json');
    assert.equal(JSON.parse(request.body).code, 'A:B');
    assert.equal(request.headers[1].value, 'Bearer token');
});
test('cURL imports reject executable syntax, files and unsupported options', async () => {
    const { importText } = await model;
    for (const value of [
        'curl https://example.com; rm -rf /', 'curl https://example.com | cat',
        'curl https://example.com -d @secret.txt', 'curl https://example.com -H "X: $(whoami)"',
        'curl https://example.com --insecure', 'curl https://example.com --form file=@private',
        'curl https://example.com https://other.example.com'
    ]) assert.throws(() => importText(value));
});
test('prepare resolves variables without encoding errors and never silently discards GET bodies', async () => {
    const { emptyRequest, row, prepareRequest } = await model;
    const state = { ...emptyRequest(), url: '{{base}}/items?fixed=1', variables: 'base=https://example.com\ntoken=abc', query: [row('q', '中文 &+'), row('q','two'), row('off','x',false)], bearer: '{{token}}' };
    const request = prepareRequest(state), url = new URL(request.url);
    assert.deepEqual(url.searchParams.getAll('q'), ['中文 &+', 'two']); assert.equal(url.searchParams.get('fixed'), '1');
    assert.equal(request.headers[0].value, 'Bearer abc');
    assert.throws(() => prepareRequest({ ...state, variables: '' }), /未填写/);
    assert.throws(() => prepareRequest({ ...state, bodyMode: 'json', body: '{"a":1}' }), /GET\/HEAD/);
    assert.throws(() => prepareRequest({ ...state, method: 'POST', bodyMode: 'json', body: '{bad}' }), /JSON/);
    assert.throws(() => prepareRequest({ ...state, headers: [row('Authorization','Basic x')] }), /重复/);
    assert.throws(() => prepareRequest({ ...state, headers: [row('X','x\r\ny')] }), /换行/);
});
test('Java annotation opt-outs and duplicate serialized names are handled explicitly', async () => {
    const { javaToJson } = await model;
    assert.deepEqual(JSON.parse(JSON.stringify(javaToJson('@JsonIgnore(false) String visible; @JsonIgnore(value=true) String hidden;').value)), { visible: '' });
    assert.throws(() => javaToJson('@JsonProperty("name") String a; @JsonProperty("name") String b;'), /字段 name 重复/);
});
