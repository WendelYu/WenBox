const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = {};
vm.runInNewContext(fs.readFileSync('app/src/main/assets/web/ui-state.js', 'utf8'), context);
const { createCooldown, avatar, createOutbox } = context.WenBoxUI;

test('PIN cooldown survives dialog reopen, isolates hosts and cannot be shortened', () => {
    let now = 1000;
    const cooldown = createCooldown(() => now);
    cooldown.start('host-a', 3); now += 1001;
    assert.equal(cooldown.remaining('host-a'), 2);
    cooldown.start('host-a', 0);
    assert.equal(cooldown.remaining('host-a'), 2);
    assert.equal(cooldown.remaining('host-b'), 0);
    now += 2000; assert.equal(cooldown.remaining('host-a'), 0);
    cooldown.start('host-a', Infinity); assert.equal(cooldown.remaining('host-a'), 3600);
});
test('avatar handles Unicode, empty names, and stable eight-tone hashing', () => {
    for (const name of ['王工', '🛠维修', '', ' a ', '现场测试']) {
        const result = avatar(name);
        assert.equal(result.initial, avatar(name).initial);
        assert.ok(result.tone >= 0 && result.tone < 8);
    }
    assert.equal(avatar(' a ').initial, 'A');
    assert.equal(avatar('🛠维修').initial, '🛠');
});
test('outbox reconciles one repeated message at a time and isolates rooms and senders', () => {
    const outbox = createOutbox();
    const first = outbox.add('hello', 'alice', 1), second = outbox.add('hello', 'alice', 1);
    assert.equal(outbox.reconcile({ content: 'hello', clientId: 'bob' }, 1), undefined);
    assert.equal(outbox.reconcile({ content: 'hello', clientId: 'alice' }, 2), undefined);
    assert.equal(outbox.reconcile({ content: 'hello', clientId: 'alice' }, 1), first);
    assert.equal(outbox.get(first.id), undefined);
    assert.equal(outbox.get(second.id), second);
    outbox.clear(); assert.equal(outbox.get(second.id), undefined);
});
