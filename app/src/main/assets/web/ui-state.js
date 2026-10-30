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
    function createChatIdentity(storage, session, generate = () => 'cid_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36)) {
        const key = 'wenbox_chat_identity';
        const valid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
        const read = (store, key) => { try { return store?.getItem(key); } catch (_) { return null; } };
        let saved;
        try { saved = JSON.parse(read(storage, key)); } catch (_) {}
        const previous = [read(storage, 'wenbox_client_id'), read(session, 'wenbox_client_id')].filter(valid);
        const id = valid(saved?.id) ? saved.id : previous[0] || generate();
        const aliases = new Set((Array.isArray(saved?.aliases) ? saved.aliases : []).filter(valid).filter(v => v !== id).slice(0, 64));
        for (const old of previous) if (old !== id && aliases.size < 64) aliases.add(old);
        const save = values => storage.setItem(key, JSON.stringify({ schema: 1, id, aliases: Array.from(values) }));
        let persistent = true;
        try { save(aliases); } catch (_) { persistent = false; }
        // Preserve continuity when opening an older client version in this same profile.
        for (const store of [storage, session]) { try { store?.setItem('wenbox_client_id', id); } catch (_) {} }
        return {
            id, persistent,
            owns(value) { return valid(value) && (value === id || aliases.has(value)); },
            restored(value) { return aliases.has(value); },
            claim(value) {
                if (!valid(value)) throw new Error('历史消息身份无效');
                if (value === id || aliases.has(value)) return;
                if (aliases.size >= 64) throw new Error('历史身份数量已达上限');
                const next = new Set(aliases); next.add(value); save(next); aliases.add(value);
            },
            unclaim(value) {
                if (!aliases.has(value)) return;
                const next = new Set(aliases); next.delete(value); save(next); aliases.delete(value);
            },
            canRestore(value) { return valid(value) && value !== id && !aliases.has(value); }
        };
    }
    function sameMessageGroup(previous, current) {
        if (!previous || previous.sender !== current.sender || previous.mine !== current.mine) return false;
        const gap = Number(current.timestamp) - Number(previous.timestamp);
        return Number.isFinite(gap) && gap >= 0 && gap < 120000;
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
    function selectLocalAddress(ips, selected) {
        const address = item => typeof item === 'string' ? item : item.ip;
        if (selected && (ips || []).some(item => address(item) === selected)) return selected;
        const preferred = (ips || []).find(item => item.is_preferred || item.isPreferred);
        return address(preferred || (ips || [])[0] || { ip: '127.0.0.1' });
    }
    root.WenBoxUI = { createChatIdentity, sameMessageGroup, createCooldown, avatar, createOutbox, isLinkLocal, selectDirectPeer, selectLocalAddress };
})(typeof window === 'undefined' ? globalThis : window);
