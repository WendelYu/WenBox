(function (root) {
    function createCooldown(now = () => Date.now()) {
        const deadlines = new Map();
        return {
            start(host, seconds) {
                const duration = Math.min(3600, Math.max(0, Number(seconds) || 0));
                deadlines.set(host, Math.max(deadlines.get(host) || 0, now() + duration * 1000));
            },
            remaining(host) {
                const seconds = Math.max(0, Math.ceil(((deadlines.get(host) || 0) - now()) / 1000));
                if (!seconds) deadlines.delete(host);
                return seconds;
            }
        };
    }
    function avatar(name) {
        const characters = Array.from(String(name).trim() || '成员');
        const hash = characters.reduce((value, character) => (Math.imul(value, 31) + character.codePointAt(0)) | 0, 0);
        return { initial: characters[0].toUpperCase(), tone: (hash >>> 0) % 8 };
    }
    function createOutbox() {
        const entries = new Map();
        let serial = 0;
        return {
            add(content, clientId, revision) {
                const item = { id: `draft-${++serial}`, content, clientId, revision, status: 'sending' };
                entries.set(item.id, item); return item;
            },
            get: id => entries.get(id),
            reconcile(message, revision) {
                const entry = [...entries.values()].find(item => item.revision === revision && item.content === message.content && item.clientId === message.clientId);
                if (entry) entries.delete(entry.id);
                return entry;
            },
            clear() { entries.clear(); }
        };
    }
    function isLinkLocal(ip) {
        if (typeof ip !== 'string' || !/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
        const parts = ip.split('.').map(Number);
        return parts[2] >= 1 && parts[2] <= 254 && parts[3] <= 255;
    }
    // Only a single directly connected, opt-in startup room can be joined automatically.
    // A stable room-ID ordering makes both ends choose the same host, even on simultaneous startup.
    function selectDirectPeer(local, rooms, ips) {
        if (!local?.isActive || !local.autoConnect || !local.canAutoConnect || local.needPassword || !local.roomId) return null;
        const ownIps = new Set((ips || []).map(item => typeof item === 'string' ? item : item.ip));
        if (![...ownIps].some(isLinkLocal)) return null;
        const peers = new Map();
        for (const room of rooms || []) {
            if (!room.roomId || room.roomId === local.roomId || !room.autoConnect || room.needPassword
                || !isLinkLocal(room.ip) || ownIps.has(room.ip)
                || !Number.isInteger(room.port) || room.port < 1 || room.port > 65535) continue;
            peers.set(room.roomId, room);
        }
        if (peers.size !== 1) return null;
        const peer = [...peers.values()][0];
        // An already used host keeps its room when the other end restarts or reconnects.
        return peer.canAutoConnect === false || local.roomId > peer.roomId ? peer : null;
    }
    root.WenBoxUI = { createCooldown, avatar, createOutbox, isLinkLocal, selectDirectPeer };
})(typeof window === 'undefined' ? globalThis : window);
