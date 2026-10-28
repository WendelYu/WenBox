(() => {
    'use strict';
    const view = document.getElementById('view-kvm');
    if (!view) return;
    const node = id => document.getElementById(id);
    const text = (id, value) => { node(id).textContent = value; };
    const errorBox = node('kvmError');
    const invoke = window.__TAURI__?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI_INVOKE__;
    const desktop = typeof invoke === 'function';
    let snapshot = null, busy = false, timer = null, speedDirty = false, scrollDirty = false;
    const visible = () => !view.hidden && !document.hidden;
    function controls() {
        const m = snapshot?.managed, peer = m?.peer, pending = m?.pending;
        for (const button of view.querySelectorAll('[data-kvm]')) {
            const a = button.dataset.kvm;
            button.disabled = busy || !desktop || (a !== 'refresh' && !m)
                || (a === 'start' && (m?.enabled || !snapshot?.installed)) || (a === 'stop' && !m?.enabled)
                || (['pair', 'pairing', 'role'].includes(a) && !!peer)
                || (['pair', 'pairing', 'settings'].includes(a) && !snapshot?.installed)
                || (a === 'role' && !!pending)
                || (a === 'confirm' && (!pending || pending.localConfirmed))
                || (a === 'reject' && !pending)
                || (a === 'forget' && !peer)
                || (a === 'layout' && (!peer || m?.local?.role !== 'source'))
                || (a === 'scroll-speed' && (!m?.enabled || !peer || m.local.role !== 'target' || snapshot?.scrollSpeed == null))
                || (a === 'speed' && (!m?.enabled || !peer || m.local.role !== 'source' || snapshot?.pointerSpeed == null))
                || (a === 'diagnostics' && !snapshot);
            if (['settings', 'input-settings', 'reveal-app'].includes(a)) button.hidden = snapshot?.platform !== 'macOS';
        }
        for (const button of node('kvmCandidates').querySelectorAll('button')) button.disabled = busy || !!peer || button.dataset.pairing !== 'true';
        node('kvmRoleSelect').disabled = busy || !desktop || !!peer || !!pending;
        node('kvmSide').disabled = busy || !desktop || !peer || m?.local?.role !== 'source';
        for (const button of view.querySelectorAll('[data-kvm-side]')) {
            button.disabled = busy || !m?.enabled || !peer || m.local.role !== 'source';
            button.setAttribute('aria-pressed', String(button.dataset.kvmSide === m?.side));
        }
        for (const b of view.querySelectorAll('[data-kvm-speed]')) b.disabled = busy;
        node('kvmPointerSpeed').disabled = busy;
        node('kvmScrollSpeed').disabled = busy;
        view.setAttribute('aria-busy', String(busy));
    }
    function render(state) {
        snapshot = state;
        const m = state.managed;
        node('kvmPermissions').hidden = state.platform !== 'macOS';
        const permissionLabel = value => value === true ? '已授权' : value === false ? '需要授权或重新授权' : '待检测';
        text('kvmAccessibilityStatus', permissionLabel(state.permissions?.accessibility));
        text('kvmInputStatus', permissionLabel(state.permissions?.inputMonitoring));
        const enabled = !!m?.enabled;
        node('kvmDetails').hidden = !enabled;
        node('kvmEscape').hidden = !enabled || !m?.peer;
        node('kvmIntro').hidden = enabled && !!m?.peer;
        node('kvmPairingCard').hidden = !enabled || !!m?.peer;
        node('kvmStatusBadge').dataset.state = !enabled ? 'off' : state.inputConnected === true ? 'connected' : 'waiting';
        text('kvmStatusBadge', !enabled ? '未开启' : state.inputConnected === true ? '已连接' : m?.pending ? '等待确认' : state.backendRunning ? (state.inputConnected == null && state.role === 'target' ? '接收端就绪' : '等待连接') : '准备连接');
        text('kvmMessage', !enabled ? '需要时开启，让键鼠在两台电脑之间流转。' : state.inputConnected === true ? `已连接 ${m.peer?.name || '对端'}，可以跨屏操作` : state.message);
        view.querySelector('[data-kvm="start"]').hidden = enabled;
        view.querySelector('[data-kvm="stop"]').hidden = !enabled;
        view.querySelector('[data-kvm="diagnostics"]').hidden = !enabled;
        text('kvmPlatform', state.platform);
        text('kvmRole', { source: '使用本机键鼠', target: '接收对端输入' }[state.role] || '尚未配置');
        text('kvmTls', state.tlsConfigured ? '设备证书与加密连接' : '尚未确认');
        text('kvmSystem', state.platform === 'Windows' ? (state.systemInput && state.serviceReady ? '本机输入服务已就绪' : (state.serviceError || '输入服务尚未就绪')) : '由 Windows 对端输入服务提供');
        if (!m) { text('kvmMessage', '请更新桌面客户端，以使用设备配对和屏幕布局。'); controls(); return; }
        if (document.activeElement !== node('kvmRoleSelect')) node('kvmRoleSelect').value = m.local.role;
        text('kvmPairingHint', m.local.pairing ? '配对窗口已打开，请在另一台电脑也打开此窗口。' : '两端需要选择不同角色；首次配对需分别确认。');
        node('kvmPending').hidden = !m.pending;
        if (m.pending) {
            text('kvmPendingName', `正在配对：${m.pending.name}`);
            const code = String(m.pending.code);
            text('kvmPairCode', `${code.slice(0, 4)} ${code.slice(4)}`);
            text('kvmPairExpiry', `${m.pending.localConfirmed ? '本机已确认，等待对端' : '等待本机确认'} · 约 ${m.pending.expiresIn} 秒后过期`);
        }
        node('kvmScrollSettings').hidden = !m.enabled || !m.peer || m.local.role !== 'target' || state.scrollSpeed == null;
        node('kvmScrollHint').hidden = !m.enabled || !m.peer || m.local.role !== 'source';
        if (!scrollDirty && state.scrollSpeed != null) { node('kvmScrollSpeed').value = state.scrollSpeed; text('kvmScrollValue', (state.scrollSpeed/100).toFixed(2)+'×'); }
        node('kvmPointerSettings').hidden = !m.enabled || !m.peer || m.local.role !== 'source' || state.pointerSpeed == null;
        if (!speedDirty && state.pointerSpeed != null) { node('kvmPointerSpeed').value = state.pointerSpeed; text('kvmPointerValue', (state.pointerSpeed / 100).toFixed(2) + '×'); }
        node('kvmLayoutCard').hidden = !m.enabled || !m.peer;
        if (m.peer) {
            text('kvmPeerLabel', `${m.peer.name} · ${m.peer.ip}`);
            text('kvmOwnScreen', m.local.name);
            text('kvmPeerScreen', m.peer.name);
            node('kvmPeerScreen').dataset.side = m.side;
            if (document.activeElement !== node('kvmSide')) node('kvmSide').value = m.side;
        }
        const list = node('kvmEvents'); list.replaceChildren();
        for (const event of (state.events || []).slice().reverse()) {
            const item = document.createElement('li'); item.textContent = `${new Date(event.time * 1000).toLocaleTimeString()} · ${event.message}`; list.append(item);
        }
        node('kvmEventsSection').hidden = !m.enabled || !list.childElementCount;
        controls();
    }
    function schedule() { clearTimeout(timer); if (desktop && visible()) timer = setTimeout(() => refresh(false), snapshot?.managed?.pending ? 1800 : 3500); }
    async function refresh(clearError = true) {
        if (busy || !visible()) return;
        busy = true; controls(); if (clearError) errorBox.hidden = true;
        try { render(await invoke('kvm_status', {})); }
        catch (error) { snapshot = null; errorBox.textContent = String(error?.message || error); errorBox.hidden = false; }
        finally { busy = false; controls(); schedule(); }
    }
    function candidates(items) {
        const list = node('kvmCandidates'); list.replaceChildren();
        const eligible = items.filter(c => c.info.enabled && c.info.role !== snapshot?.managed?.local?.role);
        const seen = new Set();
        for (const candidate of eligible) {
            if (seen.has(candidate.info.id)) continue;
            seen.add(candidate.info.id);
            const item = document.createElement('li');
            const label = document.createElement('span'); label.textContent = `${candidate.info.name} · ${candidate.ip} · ${candidate.info.platform}`;
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn--secondary btn--sm'; button.textContent = candidate.info.pairing ? '配对' : '请在对端允许配对';
            button.dataset.pairing = String(candidate.info.pairing);
            button.disabled = !candidate.info.pairing || !!snapshot?.managed?.peer;
            button.addEventListener('click', () => { node('kvmPeerIp').value = candidate.ip; act('pair'); });
            item.append(label, button); list.append(item);
        }
        if (!seen.size) text('kvmPairingHint', '暂无已开启流转的可用电脑。请在对端开启流转，选择不同角色并允许配对。');
    }
    async function act(action) {
        if (!desktop || busy) return;
        clearTimeout(timer); if (action === 'refresh') return refresh();
        busy = true; controls(); errorBox.hidden = true;
        try {
            if (action === 'diagnostics') {
                const managed = snapshot?.managed;
                const safe = managed ? { ...managed, pending: managed.pending ? { localConfirmed: managed.pending.localConfirmed, remoteConfirmed: managed.pending.remoteConfirmed, expiresIn: managed.pending.expiresIn } : null } : null;
                await window.WenBox.copyText(JSON.stringify({ appVersion: document.querySelector('meta[name="wenbox-version"]')?.content, ...snapshot, managed: safe }, null, 2)); text('kvmMessage', '诊断信息已复制');
            } else if (action === 'discover') { candidates(await invoke('kvm_discover', {})); }
            else {
                const m = snapshot?.managed;
                const commands = { 'scroll-speed': ['kvm_scroll_speed', { percent: Number(node('kvmScrollSpeed').value) }], speed: ['kvm_pointer_speed', { percent: Number(node('kvmPointerSpeed').value) }], start: ['kvm_start', {}], stop: ['kvm_stop', {}], settings: ['kvm_open_settings', { pane: 'accessibility' }], 'input-settings': ['kvm_open_settings', { pane: 'input-monitoring' }], 'reveal-app': ['kvm_open_settings', { pane: 'reveal-app' }], pairing: ['kvm_pairing_window', {}], pair: ['kvm_pair', { ip: node('kvmPeerIp').value.trim() }], confirm: ['kvm_confirm', { session: m?.pending?.session, accept: true }], reject: ['kvm_confirm', { session: m?.pending?.session, accept: false }], forget: ['kvm_forget', {}], layout: ['kvm_layout', { side: node('kvmSide').value }], role: ['kvm_role', { role: node('kvmRoleSelect').value }] };
                const entry = commands[action]; if (!entry) return;
                await invoke(entry[0], entry[1]);
                if (action === 'speed') speedDirty = false;
                if (action === 'scroll-speed') scrollDirty = false;
                if (action !== 'settings') render(await invoke('kvm_status', {}));
            }
        } catch (error) { errorBox.textContent = String(error?.message || error); errorBox.hidden = false; }
        finally { busy = false; controls(); schedule(); }
    }
    node('kvmScrollSpeed').addEventListener('input', () => { scrollDirty = true; text('kvmScrollValue', (Number(node('kvmScrollSpeed').value)/100).toFixed(2)+'×'); });
    node('kvmPointerSpeed').addEventListener('input', () => { speedDirty = true; text('kvmPointerValue', (Number(node('kvmPointerSpeed').value) / 100).toFixed(2) + '×'); });
    view.addEventListener('click', event => { const preset = event.target.closest('[data-kvm-speed]'); if (preset && !preset.disabled) { node('kvmPointerSpeed').value = preset.dataset.kvmSpeed; speedDirty = true; text('kvmPointerValue', (Number(preset.dataset.kvmSpeed) / 100).toFixed(2) + '×'); act('speed'); return; } const direction = event.target.closest('[data-kvm-side]'); if (direction && !direction.disabled) { node('kvmSide').value = direction.dataset.kvmSide; act('layout'); return; } const button = event.target.closest('button[data-kvm]'); if (button && !button.disabled) act(button.dataset.kvm); });
    function onView() {
        clearTimeout(timer); if (!visible()) return;
        if (!desktop) {
            text('kvmMessage', '键鼠流转仅支持 Windows 和 macOS 桌面客户端；请在电脑上的 WenBox 中使用。'); text('kvmPlatform', '浏览器或移动端');
            for (const id of ['kvmRole', 'kvmTls', 'kvmSystem']) text(id, '不可用');
            node('kvmPairingCard').hidden = true; controls(); return;
        }
        refresh();
    }
    document.addEventListener('wenbox:viewchange', onView); document.addEventListener('visibilitychange', onView); controls();
})();
