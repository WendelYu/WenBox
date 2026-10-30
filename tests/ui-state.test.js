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

function memoryStorage(initial = {}) {
    const entries = new Map(Object.entries(initial));
    return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)) };
}
test('chat identity survives app restart, migrates a live session and preserves known aliases', () => {
    const local = memoryStorage();
    const first = context.WenBoxUI.createChatIdentity(local, memoryStorage({ wenbox_client_id: 'cid_live_session' }), () => 'cid_unexpected');
    assert.equal(first.id, 'cid_live_session');
    const restarted = context.WenBoxUI.createChatIdentity(local, memoryStorage(), () => 'cid_new');
    assert.equal(restarted.id, first.id);
    const anotherOldTab = context.WenBoxUI.createChatIdentity(local, memoryStorage({ wenbox_client_id: 'cid_other_session' }));
    assert.equal(anotherOldTab.id, first.id);
    assert.equal(anotherOldTab.owns('cid_other_session'), true);
    assert.equal(context.WenBoxUI.createChatIdentity(local, memoryStorage()).owns('cid_other_session'), true);
});
test('history ownership is explicit, persistent and reversible; a same-name sender is never auto-claimed', () => {
    const local = memoryStorage();
    const identity = context.WenBoxUI.createChatIdentity(local, memoryStorage(), () => 'cid_current');
    assert.equal(identity.owns('cid_different_device'), false);
    identity.claim('cid_old_app'); assert.equal(identity.owns('cid_old_app'), true);
    const reopened = context.WenBoxUI.createChatIdentity(local, memoryStorage());
    assert.equal(reopened.owns('cid_old_app'), true);
    reopened.unclaim('cid_old_app');
    assert.equal(context.WenBoxUI.createChatIdentity(local, memoryStorage()).owns('cid_old_app'), false);
    assert.equal(reopened.owns('cid_different_device'), false);
    assert.throws(() => reopened.claim('<untrusted>'), /无效/);
});
test('failed storage never reports a history claim as saved', () => {
    const storage = memoryStorage();
    const identity = context.WenBoxUI.createChatIdentity(storage, memoryStorage(), () => 'cid_current');
    storage.setItem = () => { throw Error('quota'); };
    assert.throws(() => identity.claim('cid_old'), /quota/);
    assert.equal(identity.owns('cid_old'), false);
});
test('message grouping keeps authors and sides separate and rejects backward timestamps', () => {
    const group = context.WenBoxUI.sameMessageGroup;
    const first = { sender: 'self:cid', mine: true, timestamp: 200000 };
    assert.equal(group(first, { ...first, timestamp: 201000 }), true);
    assert.equal(group(first, { ...first, mine: false, timestamp: 201000 }), false);
    assert.equal(group(first, { ...first, sender: 'cid_someone_else', timestamp: 201000 }), false);
    assert.equal(group(first, { ...first, timestamp: 190000 }), false);
    assert.equal(group(first, { ...first, timestamp: 400000 }), false);
});
