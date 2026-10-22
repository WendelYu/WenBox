const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = {};
vm.runInNewContext(fs.readFileSync('app/src/main/assets/web/ui-state.js', 'utf8'), context);
const { isLinkLocal, selectDirectPeer } = context.WenBoxUI;
const a = { roomId: 'aaa', isActive: true, autoConnect: true, canAutoConnect: true, needPassword: false };
const b = { ...a, roomId: 'bbb' };
const aRoom = { ...a, ip: '169.254.18.3', port: 9527 };
const bRoom = { ...b, ip: '169.254.207.8', port: 9527 };

test('both startup orders elect exactly one host across different third octets', () => {
    for (const rooms of [[aRoom, bRoom], [bRoom, aRoom]]) {
        assert.equal(selectDirectPeer(a, rooms, [aRoom.ip]), null);
        assert.equal(selectDirectPeer(b, rooms, [{ ip: bRoom.ip }]), aRoom);
    }
});
test('office LAN, own IPs, missing USB addresses and legacy rooms cannot auto-join', () => {
    assert.equal(selectDirectPeer(b, [{ ...aRoom, ip: '192.168.1.8' }], [bRoom.ip]), null);
    assert.equal(selectDirectPeer(b, [aRoom], ['192.168.1.8']), null);
    assert.equal(selectDirectPeer(b, [aRoom], [aRoom.ip]), null);
    assert.equal(selectDirectPeer(b, [{ ...aRoom, autoConnect: undefined }], [bRoom.ip]), null);
    for (const port of [0, -1, 65536, '9527', NaN]) {
        assert.equal(selectDirectPeer(b, [{ ...aRoom, port }], [bRoom.ip]), null);
    }
});
test('manual, password, occupied or closed local rooms keep their current session', () => {
    for (const patch of [{ autoConnect: false }, { canAutoConnect: false }, { needPassword: true }, { isActive: false }]) {
        assert.equal(selectDirectPeer({ ...b, ...patch }, [aRoom], [bRoom.ip]), null);
    }
    assert.equal(selectDirectPeer(b, [{ ...aRoom, needPassword: true }], [bRoom.ip]), null);
});
test('multiple default peers require manual choice; duplicate packets do not', () => {
    assert.equal(selectDirectPeer(b, [aRoom, { ...aRoom, roomId: 'ccc', ip: '169.254.9.9' }], [bRoom.ip]), null);
    assert.equal(selectDirectPeer(b, [aRoom, aRoom], [bRoom.ip]), aRoom);
});
test('restarted end rejoins a host with existing conversation regardless of new ID ordering', () => {
    const usedHost = { ...bRoom, canAutoConnect: false };
    assert.equal(selectDirectPeer(a, [usedHost], [aRoom.ip]), usedHost);
    assert.equal(selectDirectPeer({ ...b, canAutoConnect: false }, [aRoom], [bRoom.ip]), null);
});
test('link-local detection rejects malformed and reserved auto-configuration ranges', () => {
    for (const ip of ['169.254.1.0', '169.254.254.255', '169.254.18.3']) assert.equal(isLinkLocal(ip), true);
    for (const ip of ['', null, '169.254.256.1', '169.254.18.999', '169.254.0.1', '169.254.255.1', '169.254.18.1.evil', '127.0.0.1']) {
        assert.equal(isLinkLocal(ip), false);
    }
});
