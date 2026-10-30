(function () {
    // ---------------- 全局通知 Toast ----------------
    const { copyText, singleFlight, fetchWithTimeout, listChanged, scheduler, resolveRequestUrl } = window.WenBox;
    const fetch = fetchWithTimeout;
    let uploadQueue = null, demandFiles = null;
    const cooldown = window.WenBoxUI.createCooldown();
    const outbox = window.WenBoxUI.createOutbox();
    let discoveryStartedAt = Date.now();
    let chatHasSynced = false;
    let directAutoConnectEnabled = true;
    let directRetryAt = 0;
    let discoveryOpen = false;
    document.getElementById('btnBrowseRooms').addEventListener('click', () => selectView('view-rooms'));
    const directConnectionStatus = document.getElementById('directConnectionStatus');
    const toast = document.getElementById('toast');
    let toastTimer;
    function setText(element, value) {
        if (element && element.textContent !== String(value)) element.textContent = value;
    }
    // ---------------- 主题切换 (Phase 4) ----------------
    function initThemeToggle() {
        const button = document.getElementById('btnThemeToggle');
        if (!button || !window.WenBoxTheme) return;
        const iconUse = button.querySelector('use');

        function render(preference, resolved) {
            const isLight = resolved === 'light';
            if (iconUse) iconUse.setAttribute('href', isLight ? '#i-moon' : '#i-sun');
            button.setAttribute('aria-label', isLight ? '切换到深色主题' : '切换到浅色主题');
            button.title = `主题: ${preference === 'system' ? '跟随系统' : (preference === 'light' ? '浅色' : '深色')}`;
        }

        render(window.WenBoxTheme.preference, window.WenBoxTheme.resolved);
        window.WenBoxTheme.subscribe(render);
        button.addEventListener('click', () => {
            // 三态循环：跟随系统 -> 深色 -> 浅色 -> 跟随系统
            const order = ['system', 'dark', 'light'];
            const next = order[(order.indexOf(window.WenBoxTheme.preference) + 1) % order.length];
            window.WenBoxTheme.set(next);
        });
    }

    function showToast(msg) {
        if (!toast) return;
        const message = String(msg);
        const error = /失败|错误|无法|异常|未就绪|404|断开/.test(message);
        toast.replaceChildren();
        const content = document.createElement('span');
        content.className = 'toast-message'; content.textContent = message;
        toast.appendChild(content);
        if (error) {
            const copy = document.createElement('button'); copy.type = 'button';
            copy.className = 'btn btn--secondary btn--sm'; copy.textContent = '复制错误详情';
            copy.addEventListener('click', async () => {
                try { await copyText(message); copy.textContent = '已复制'; }
                catch (_) { copy.textContent = '请选择文字复制'; }
            });
            const close = document.createElement('button'); close.type = 'button';
            close.className = 'btn btn--ghost btn--sm'; close.textContent = '关闭';
            close.addEventListener('click', () => toast.classList.remove('show'));
            toast.append(copy, close);
        }
        toast.classList.add('show');
        clearTimeout(toastTimer);
        if (!error) toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    async function copyWithFeedback(text, message = '已复制到剪贴板') {
        try {
            await copyText(text);
            showToast(message);
            return true;
        } catch (_) {
            showToast('复制未成功，请选中内容后手动复制');
            return false;
        }
    }

    function markCopied(btn, text) {
        if (!btn) return;
        if (!btn.dataset.copyOriginal) btn.dataset.copyOriginal = btn.innerHTML;
        clearTimeout(btn._copyTimer);
        btn.classList.add('copied');
        btn.setAttribute('aria-label', '已复制');
        btn.innerHTML = text;
        btn._copyTimer = setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = btn.dataset.copyOriginal;
            btn.setAttribute('aria-label', btn.title || '复制');
        }, 1500);
    }

    // Primary navigation and independent tool/file segments share delegated controls.
    let currentActiveTab = 'view-rooms';
    function animateArrival(element, drawer = false) {
        if (!element?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        element.getAnimations().forEach(animation => animation.cancel());
        element.animate([{ transform: drawer ? 'translateX(28px)' : 'translateY(10px) scale(.985)' }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    }
    function selectView(id) {
        if (id === currentActiveTab && !document.getElementById(id)?.hidden) return;
        currentActiveTab = id;
        discoveryOpen = id === 'view-rooms';
        document.body.dataset.discoveryOpen = String(discoveryOpen);
        if (discoveryOpen) { discoveryStartedAt = Date.now(); pollDiscoveredRooms(); }
        document.body.dataset.activeView = id;
        setText(document.getElementById('workspaceTitle'), id === 'view-rooms' ? '房间' : id === 'view-kvm' ? '键鼠流转' : id === 'view-tools' ? '随手工具' : '快传工作台');
        setText(document.getElementById('workspaceSubtitle'), id === 'view-rooms' ? '发现、加入和管理局域网房间' : id === 'view-kvm' ? '键鼠跟随光标，在两台电脑间切换' : id === 'view-tools' ? '常用的小工具，离线也顺手' : '文件与消息，在设备间轻松流转');
        document.querySelectorAll('.primary-view').forEach(view => { view.hidden = view.id !== id; });
        document.querySelectorAll('[data-view]').forEach(button => {
            const selected = button.dataset.view === id;
            button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
        });
        animateArrival(document.getElementById(id));
        document.dispatchEvent(new CustomEvent('wenbox:viewchange', { detail: id }));
        scheduler.runNow();
    }
    function selectSegment(button, attribute, selector) {
        const id = button.dataset[attribute];
        document.querySelectorAll(`[data-${selector}]`).forEach(other => {
            const selected = other === button;
            other.classList.toggle('active', selected); other.setAttribute('aria-pressed', String(selected));
            const pane = document.getElementById(other.dataset[attribute]);
            if (pane) { pane.hidden = !selected; if (selected) animateArrival(pane); }
        });
    }
    function toggleFiles(open) {
        document.body.classList.toggle('files-open', open);
        document.getElementById('btnToggleFiles')?.setAttribute('aria-expanded', String(open));
        if (open) document.getElementById('btnCloseFiles')?.focus();
    }
    // Safari does not focus buttons on mouse click; capture the actual opener.
    let recentModalTrigger = null;
    document.addEventListener('click', event => {
        const target = event.target.closest('button, summary, a[href]');
        if (target) recentModalTrigger = { target, time: performance.now() };
    }, true);
    const modalFocus = new WeakMap();
    const modalClosing = new WeakMap();
    function openModal(modal) {
        if (typeof modal === 'string') modal = document.getElementById(modal);
        if (!modal) return;
        modalClosing.get(modal)?.cancel();
        modalClosing.delete(modal);
        if (modal.open) return;
        const details = document.getElementById('connectionDetails');
        const source = recentModalTrigger && performance.now() - recentModalTrigger.time < 1000 ? recentModalTrigger.target : document.activeElement;
        const trigger = details?.contains(source) ? details.querySelector('summary') : source;
        details?.removeAttribute('open');
        modalFocus.set(modal, trigger);
        modal.showModal();
        animateArrival(modal, modal.classList.contains("members-drawer"));
        (modal.querySelector('input:not([type="checkbox"]), textarea') || modal.querySelector('button'))?.focus();
    }
    function closeModal(modal) {
        if (typeof modal === 'string') modal = document.getElementById(modal);
        if (!modal?.open || modalClosing.has(modal)) return;
        if (!modal.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { modal.close(); return; }
        const style = getComputedStyle(modal);
        const animation = modal.animate([
            { opacity: style.opacity, transform: style.transform },
            { opacity: 0, transform: 'translateY(6px) scale(.99)' }
        ], { duration: 130, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
        modalClosing.set(modal, animation);
        animation.finished.then(() => {
            if (modalClosing.get(modal) !== animation) return;
            modalClosing.delete(modal); modal.close(); animation.cancel();
        }).catch(() => {});
    }
    document.querySelectorAll('dialog.modal').forEach(modal => {
        modal.addEventListener('cancel', event => {
            event.preventDefault();
            if (modal.id === 'appConfirmModal') window.closeAppConfirm(false);
            else if (modal.id === 'appAlertModal') window.closeAppAlert();
            else if (modal.id === 'joinRoomPinModal') window.closeJoinPinModal();
            else closeModal(modal);
        });
        modal.addEventListener('close', () => {
            const trigger = modalFocus.get(modal); modalFocus.delete(modal);
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        });
    });
    document.addEventListener('click', event => {
        const details = document.getElementById('connectionDetails');
        if (details?.open && !details.contains(event.target)) details.open = false;
    });
    document.addEventListener('keydown', event => {
        const details = document.getElementById('connectionDetails');
        if (event.key === 'Escape' && details?.open && !document.querySelector('dialog[open]')) {
            details.open = false; details.querySelector('summary')?.focus();
        }
    });
    document.addEventListener('click', event => {
        const button = event.target.closest('button[data-action], button[data-view], button[data-tool], button[data-file-page], button[data-room-page]');
        if (!button) return;
        if (button.dataset.view) return selectView(button.dataset.view);
        if (button.dataset.tool) return selectSegment(button, 'tool', 'tool');
        if (button.dataset.filePage) return selectSegment(button, 'filePage', 'file-page');
        if (button.dataset.roomPage) {
            document.body.dataset.roomPage = button.dataset.roomPage;
            document.querySelectorAll('[data-room-page]').forEach(other => {
                if (other === document.body) return;
                other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button));
            });
            return;
        }
        const value = button.dataset.value;
        const actions = {
            openCreateRoomModal: () => window.openCreateRoomModal(),
            closeCreateRoomModal: () => window.closeCreateRoomModal(),
            closeJoinPinModal: () => window.closeJoinPinModal(),
            closeManualJoinModal: () => window.closeManualJoinModal(),
            closeHostQrModal: () => window.closeHostQrModal(),
            closeAppConfirm: () => window.closeAppConfirm(false),
            closeAppAlert: () => window.closeAppAlert(),
            closeOnlineMembersModal: () => window.closeOnlineMembersModal(),
            closeEditNicknameModal: () => window.closeEditNicknameModal(),
            'join-room': () => window.onDiscoveredRoomClicked(value),
            'fill-profile': () => window.fillRoomProfile(Number(value)),
            'delete-profile': () => window.deleteRoomProfile(Number(value)),
            'copy-ip': () => window.copyMemberIp(value),
            'download-file': () => window.downloadRemoteFile(value, button.dataset.name),
            'remove-file': () => window.removeLocalSharedFile(value),
            'copy-code': () => window.copyChatCode(button),
            'refresh-files': () => loadFiles(),
            'retry-message': () => retryMessage(button.dataset.value),
            'restore-message-author': () => restoreMessageAuthor(value),
            'unrestore-message-author': () => restoreMessageAuthor(value, true),
            'cancel-upload': () => uploadQueue?.cancel(button.dataset.uploadId),
            'retry-upload': () => uploadQueue?.retry(button.dataset.uploadId)
        };
        actions[button.dataset.action]?.();
    });
    document.getElementById('btnToggleFiles')?.addEventListener('click', () => toggleFiles(!document.body.classList.contains('files-open')));
    document.getElementById('btnCloseFiles')?.addEventListener('click', () => { toggleFiles(false); document.getElementById('btnToggleFiles')?.focus(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.body.classList.contains('files-open')) toggleFiles(false);
    });
    document.getElementById('hostAddressSelect')?.addEventListener('change', event => window.switchActiveServerIp(event.target.value));

    // ---------------- 房间制架构与状态管理 (默认客户端发现模式) ----------------
    let roomState = {
        mode: 'client', // 'client' | 'host' | 'joined'
        token: localStorage.getItem('wenbox_room_token') || '',
        // 服务端返回的成员 id。成员 id 与房间令牌已解耦 (BUG 文档 S2)，
        // 判断"哪条消息/哪个成员是我"必须用 memberId，绝不能用 token。
        memberId: localStorage.getItem('wenbox_member_id') || '',
        roomInfo: null, // 当前房间详情
        discoveredRooms: []
    };

    let roomRevision = 0;
    let currentTargetBaseUrl = ''; // 默认为本端，joined 模式时为房主地址，如 "http://192.168.1.120:9527"
    let currentTargetDeviceName = '本端直连';
    let joinedPin = '', joinedResumeAt = 0;
    function updateRemoteConnection(state, message = '') {
        const previous = document.body.dataset.remoteConnection;
        document.body.dataset.remoteConnection = state;
        const notice = document.getElementById('roomConnectionNotice');
        notice.hidden = state === 'ready';
        notice.textContent = message;
        if (previous && previous !== 'ready' && state === 'ready') {
            document.querySelectorAll('.chat-img-thumb-wrapper[data-state="error"]').forEach(item => item.retryImage?.());
            if (roomState.mode === 'joined') loadFiles();
        }
    }
    const resumeJoinedSession = singleFlight(async () => {
        if (roomState.mode !== 'joined' || Date.now() < joinedResumeAt) return;
        joinedResumeAt = Date.now() + 15000;
        const revision = roomRevision;
        const response = await fetch(currentTargetBaseUrl + '/api/room/join', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeRoomId: roomState.roomInfo?.roomId, pin: joinedPin, name: getClientSenderName(), platform: detectClientPlatform() })
        });
        const result = await response.json();
        if (revision !== roomRevision || !result.success || result.room?.roomId !== roomState.roomInfo?.roomId) return;
        roomState.token = result.token || ''; roomState.memberId = result.memberId || '';
        uploadQueue?.updateToken(revision, roomState.token);
        localStorage.setItem('wenbox_room_token', roomState.token);
        localStorage.setItem('wenbox_member_id', roomState.memberId);
    });

    // UI 容器与元素绑定
    const discoveredRoomsContainer = document.getElementById('discoveredRoomsContainer');
    const discoveredRoomsCount = document.getElementById('discoveredRoomsCount');
    const noRoomsDiscoveredPrompt = document.getElementById('noRoomsDiscoveredPrompt');

    // Host 模式 UI 元素
    const btnShowHostQrCode = document.getElementById('btnShowHostQrCode');
    const btnCopyRoomDirectLink = document.getElementById('btnCopyRoomDirectLink');
    const btnCloseRoom = document.getElementById('btnCloseRoom');

    // Joined 模式 UI 元素
    const btnLeaveRoom = document.getElementById('btnLeaveRoom');

    // 模态弹窗元素
    const createRoomModal = document.getElementById('createRoomModal');
    const btnOpenCreateRoomModal = document.getElementById('btnOpenCreateRoomModal');
    const modalInputCreateRoomNickname = document.getElementById('modalInputCreateRoomNickname');
    const modalInputRoomName = document.getElementById('modalInputRoomName');
    const modalInputRoomPin = document.getElementById('modalInputRoomPin');
    const modalBtnConfirmCreateRoom = document.getElementById('modalBtnConfirmCreateRoom');

    const joinRoomPinModal = document.getElementById('joinRoomPinModal');
    const joinPinModalTitle = document.getElementById('joinPinModalTitle');
    const joinPinModalDesc = document.getElementById('joinPinModalDesc');
    const modalInputJoinPin = document.getElementById('modalInputJoinPin');
    const modalBtnConfirmJoinPin = document.getElementById('modalBtnConfirmJoinPin');
    let pendingJoinRoomData = null; // 待加入的房间数据暂存

    const manualJoinModal = document.getElementById('manualJoinModal');
    const btnOpenManualJoinModal = document.getElementById('btnOpenManualJoinModal');
    const modalInputManualUrl = document.getElementById('modalInputManualUrl');
    const modalInputManualPin = document.getElementById('modalInputManualPin');
    const modalBtnConfirmManualJoin = document.getElementById('modalBtnConfirmManualJoin');

    const hostQrModal = document.getElementById('hostQrModal');
    const hostQrCanvas = document.getElementById('hostQrCanvas');
    const qrDirectUrlText = document.getElementById('qrDirectUrlText');

    const btnRefreshDiscoveredRooms = document.getElementById('btnRefreshDiscoveredRooms');
    const phoneNameBadge = document.getElementById('phoneName');

    // ---------------- 纯前端离线二维码生成器 (零外部依赖，已与标准 QR 实现逐位交叉验证) ----------------
    // Byte 模式, 版本 1-14, ECC M/L 自适应, 8 掩码按规范惩罚规则择优
    function wbQrEncode(text) {
        const RS_BLOCK = {
            L: [[1,26,19],[1,44,34],[1,70,55],[1,100,80],[1,134,108],[2,86,68],[2,98,78],[2,121,97],[2,146,116],[2,86,68,2,87,69],[4,101,81],[2,116,92,2,117,93],[4,133,107],[3,145,115,1,146,116]],
            M: [[1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],[4,43,27],[4,49,31],[2,60,38,2,61,39],[3,58,36,2,59,37],[4,69,43,1,70,44],[1,80,50,4,81,51],[6,58,36,2,59,37],[8,59,37,1,60,38],[4,64,40,5,65,41]]
        };
        // 对齐图形中心表 (按版本索引: v1 无对齐图形)
        const ALIGN = [null, null, [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62], [6,26,46,66]];
        const ECC_BITS = { L: 1, M: 0 }; // 格式信息中的 ECC 指示位 (L=01, M=00)
        const bytes = new TextEncoder().encode(text);

        // GF(256) 乘法域
        const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
        (function () {
            let x = 1;
            for (let i = 0; i < 255; i++) {
                EXP[i] = x; LOG[x] = i;
                x <<= 1;
                if (x & 0x100) x ^= 0x11d;
            }
            for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
        })();
        const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

        function rsGenPoly(n) {
            let poly = [1]; // 低次在前
            for (let i = 0; i < n; i++) {
                const next = new Array(poly.length + 1).fill(0);
                for (let j = 0; j < poly.length; j++) {
                    next[j] ^= gmul(poly[j], EXP[i]);
                    next[j + 1] ^= poly[j];
                }
                poly = next;
            }
            return poly;
        }

        function rsEncode(data, ecLen) {
            const gen = rsGenPoly(ecLen);
            const rem = new Array(ecLen).fill(0);
            for (const d of data) {
                const factor = d ^ rem[0];
                rem.shift();
                rem.push(0);
                if (factor !== 0) {
                    for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[ecLen - 1 - i], factor);
                }
            }
            return rem;
        }

        const bitLen = (v) => { let n = 0; while (v) { n++; v >>= 1; } return n; };
        const bch15_5 = (data) => {
            let d = data << 10;
            while (bitLen(d) - 11 >= 0) d ^= 0x537 << (bitLen(d) - 11);
            return ((data << 10) | d) & 0x7FFF;
        };
        const bch18_6 = (data) => {
            let d = data << 12;
            while (bitLen(d) - 13 >= 0) d ^= 0x1F25 << (bitLen(d) - 13);
            return ((data << 12) | d) & 0x3FFFF;
        };

        function selectVersion(level) {
            for (let v = 1; v <= 14; v++) {
                const spec = RS_BLOCK[level][v - 1];
                let dataCodewords = 0;
                for (let i = 0; i < spec.length; i += 3) dataCodewords += spec[i] * spec[i + 2];
                const countBits = v <= 9 ? 8 : 16;
                if (4 + countBits + bytes.length * 8 <= dataCodewords * 8 - 4) {
                    return { version: v, dataCodewords, spec };
                }
            }
            return null;
        }

        function buildCodewords(dataCodewords, spec) {
            const bits = [];
            const pushBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
            pushBits(4, 4); // byte mode
            pushBits(bytes.length, chosen.version <= 9 ? 8 : 16);
            for (const b of bytes) pushBits(b, 8);
            const capacityBits = dataCodewords * 8;
            pushBits(0, Math.min(4, capacityBits - bits.length));
            while (bits.length % 8 !== 0) bits.push(0);
            const data = [];
            for (let i = 0; i < bits.length; i += 8) {
                let b = 0;
                for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
                data.push(b);
            }
            const pads = [0xEC, 0x11];
            let pi = 0;
            while (data.length < dataCodewords) data.push(pads[pi++ % 2]);

            const blocks = [];
            let offset = 0;
            for (let i = 0; i < spec.length; i += 3) {
                const count = spec[i], total = spec[i + 1], dataLen = spec[i + 2];
                for (let b = 0; b < count; b++) {
                    const chunk = data.slice(offset, offset + dataLen);
                    offset += dataLen;
                    blocks.push({ data: chunk, ec: rsEncode(chunk, total - dataLen) });
                }
            }
            const maxData = Math.max(...blocks.map(b => b.data.length));
            const maxEc = Math.max(...blocks.map(b => b.ec.length));
            const out = [];
            for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
            for (let i = 0; i < maxEc; i++) for (const b of blocks) if (i < b.ec.length) out.push(b.ec[i]);
            return out;
        }

        function getMaskFn(mask) {
            switch (mask) {
                case 0: return (r, c) => (r + c) % 2 === 0;
                case 1: return (r) => r % 2 === 0;
                case 2: return (_r, c) => c % 3 === 0;
                case 3: return (r, c) => (r + c) % 3 === 0;
                case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
                case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
                case 6: return (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
                case 7: return (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0;
            }
        }

        function penalty(m) {
            const size = m.length;
            let score = 0;
            const linePenalty = (line) => {
                let s = 0, run = 1;
                for (let i = 1; i <= line.length; i++) {
                    if (i < line.length && line[i] === line[i - 1]) { run++; continue; }
                    if (run >= 5) s += 3 + (run - 5);
                    run = 1;
                }
                const toStr = line.map(v => v ? '1' : '0').join('');
                let idx = 0;
                while ((idx = toStr.indexOf('10111010000', idx)) !== -1) { s += 40; idx++; }
                idx = 0;
                while ((idx = toStr.indexOf('00001011101', idx)) !== -1) { s += 40; idx++; }
                return s;
            };
            for (let r = 0; r < size; r++) score += linePenalty(m[r]);
            for (let c = 0; c < size; c++) {
                const col = new Array(size);
                for (let r = 0; r < size; r++) col[r] = m[r][c];
                score += linePenalty(col);
            }
            for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
                const v = m[r][c];
                if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) score += 3;
            }
            let dark = 0;
            for (const row of m) for (const cell of row) if (cell) dark++;
            score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
            return score;
        }

        function makeMatrix(version, codewords, mask, levelKey) {
            const size = 17 + 4 * version;
            const m = Array.from({ length: size }, () => new Array(size).fill(null));
            const setFinder = (r, c) => {
                for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
                    const rr = r + dr, cc = c + dc;
                    if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
                    const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
                    const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
                    m[rr][cc] = inFinder && ring !== 2;
                }
            };
            setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0);

            // 对齐图形 (必须在 timing 之前绘制: 与 timing 重叠的对齐图形需完整绘制)
            const centers = ALIGN[version];
            if (centers) {
                for (const cr of centers) for (const cc of centers) {
                    if (m[cr][cc] !== null) continue; // 仅跳过与定位图形重叠的 (左上)
                    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
                        m[cr + dr][cc + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                    }
                }
            }

            for (let i = 8; i < size - 8; i++) {
                if (m[6][i] === null) m[6][i] = i % 2 === 0;
                if (m[i][6] === null) m[i][6] = i % 2 === 0;
            }

            // 预留格式信息区 (不覆盖 row6/col6 上的 timing 模块)
            for (let i = 0; i <= 8; i++) {
                if (i !== 6) m[i][8] = null;
                if (i !== 6) m[8][i] = null;
            }
            for (let i = 0; i < 8; i++) {
                m[8][size - 1 - i] = null;
                m[size - 1 - i][8] = null;
            }

            // 数据放置前先写入格式信息 / 暗模块 / 版本信息
            const fmtBits0 = bch15_5((ECC_BITS[levelKey] << 3) | mask) ^ 0x5412;
            for (let i = 0; i < 15; i++) {
                const mod = ((fmtBits0 >> i) & 1) === 1;
                if (i < 6) m[i][8] = mod;
                else if (i < 8) m[i + 1][8] = mod;
                else m[size - 15 + i][8] = mod;
            }
            for (let i = 0; i < 15; i++) {
                const mod = ((fmtBits0 >> i) & 1) === 1;
                if (i < 8) m[8][size - 1 - i] = mod;
                else if (i < 9) m[8][15 - i] = mod;
                else m[8][14 - i] = mod;
            }
            m[size - 8][8] = true; // 固定暗模块
            if (version >= 7) {
                const verBits0 = bch18_6(version);
                for (let i = 0; i < 18; i++) {
                    const mod = ((verBits0 >> i) & 1) === 1;
                    m[Math.floor(i / 3)][i % 3 + size - 8 - 3] = mod;
                    m[i % 3 + size - 8 - 3][Math.floor(i / 3)] = mod;
                }
            }

            // 数据 zigzag 放置 + 掩码
            const maskFn = getMaskFn(mask);
            let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
            for (let col0 = size - 1; col0 > 0; col0 -= 2) {
                let col = col0;
                if (col <= 6) col--;
                for (;;) {
                    for (let c = 0; c < 2; c++) {
                        if (m[row][col - c] === null) {
                            let dark = false;
                            if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
                            if (maskFn(row, col - c)) dark = !dark;
                            m[row][col - c] = dark;
                            bitIndex--;
                            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
                        }
                    }
                    row += inc;
                    if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
                }
            }
            return m;
        }

        // 选版本与 ECC 等级 (M 优先, 放不下回退 L)
        const preferred = 'M';
        const order = preferred === 'M' ? ['M', 'L'] : ['L', 'M'];
        let chosen = null;
        for (const level of order) {
            const sel = selectVersion(level);
            if (sel) { chosen = { ...sel, level }; break; }
        }
        if (!chosen) throw new Error('内容过长，无法生成二维码');
        const codewords = buildCodewords(chosen.dataCodewords, chosen.spec);

        let best = null, bestScore = Infinity;
        for (let mask = 0; mask < 8; mask++) {
            const m = makeMatrix(chosen.version, codewords, mask, chosen.level);
            const s = penalty(m);
            if (s < bestScore) { bestScore = s; best = m; }
        }
        return { matrix: best, size: best.length };
    }

    function renderQrCodeToCanvas(canvas, text) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        let enc = null;
        try { enc = wbQrEncode(text); } catch (e) { enc = null; }

        if (enc) {
            const quiet = 2; // 模块静区
            const total = enc.size + quiet * 2;
            const scale = Math.max(1, Math.floor(size / total));
            const offset = Math.floor((size - scale * total) / 2);
            ctx.fillStyle = '#0F172A';
            for (let r = 0; r < enc.size; r++) {
                for (let c = 0; c < enc.size; c++) {
                    if (enc.matrix[r][c]) {
                        ctx.fillRect(offset + (c + quiet) * scale, offset + (r + quiet) * scale, scale, scale);
                    }
                }
            }
            return;
        }

        // 兜底：绘制直链文本提示
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(8, 8, size - 16, size - 16);
        ctx.fillStyle = '#60A5FA';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(' 局域网直链二维码', size / 2, size / 2 - 20);
        ctx.font = '11px monospace';
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(text.length > 28 ? text.substring(0, 28) + '...' : text, size / 2, size / 2 + 10);
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('在手机浏览器打开该网址即可', size / 2, size / 2 + 30);
    }

    // ---------------- 模态框打开与关闭控制 ----------------
    window.closeCreateRoomModal = function () {
        if (createRoomModal) closeModal(createRoomModal);
    };
    window.closeJoinPinModal = function () {
        if (joinRoomPinModal) closeModal(joinRoomPinModal);
        pendingJoinRoomData = null;
    };
    window.closeManualJoinModal = function () {
        if (manualJoinModal) closeModal(manualJoinModal);
    };
    window.closeHostQrModal = function () {
        if (hostQrModal) closeModal(hostQrModal);
    };

    // ---------------- 常用密码房配置 (保存 / 一键填入 / 删除) ----------------
    function getRoomProfiles() {
        try {
            const list = JSON.parse(localStorage.getItem('wenbox_room_profiles') || '[]');
            return Array.isArray(list) ? list : [];
        } catch (_) {
            return [];
        }
    }

    function persistRoomProfiles(list) {
        try {
            localStorage.setItem('wenbox_room_profiles', JSON.stringify(list.slice(0, 10)));
        } catch (_) {}
    }

    function renderRoomProfiles() {
        const container = document.getElementById('roomProfilesContainer');
        if (!container) return;
        const profiles = getRoomProfiles();
        if (!profiles.length) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = `<p class="text-2">常用房间（密码仅在本机保存）</p>` + profiles.map((profile, i) => `
            <div class="row row--between profile-row"><button type="button" class="btn btn--ghost truncate" data-action="fill-profile" data-value="${i}">${escapeHtml(profile.name)}</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="delete-profile" data-value="${i}" aria-label="删除常用房间">删除</button></div>`).join('');
    }

    window.fillRoomProfile = function (i) {
        const p = getRoomProfiles()[i];
        if (!p) return;
        if (modalInputRoomName) modalInputRoomName.value = p.name || '';
        if (modalInputRoomPin) modalInputRoomPin.value = p.pin || '';
        document.getElementById('requireRoomPin').checked = !!p.pin;
        updatePinField();
    };

    window.deleteRoomProfile = function (i) {
        const list = getRoomProfiles();
        list.splice(i, 1);
        persistRoomProfiles(list);
        renderRoomProfiles();
    };

    function saveRoomProfile(name, pin) {
        if (!name) return;
        const list = getRoomProfiles().filter(p => p.name !== name);
        list.unshift({ name, pin });
        persistRoomProfiles(list);
        showToast(`已保存常用密码房「${name}」`);
    }

    window.openCreateRoomModal = function () {
        directAutoConnectEnabled = false;
        if (modalInputCreateRoomNickname) {
            modalInputCreateRoomNickname.value = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        }
        if (modalInputRoomName) {
            const randomNum = Math.floor(1000 + Math.random() * 9000);
            modalInputRoomName.value = `WenBox-${randomNum}`;
        }
        if (modalInputRoomPin) { modalInputRoomPin.value = ''; modalInputRoomPin.type = 'password'; }
        document.getElementById('btnRevealRoomPin').textContent = '显示密码';
        document.getElementById('btnRevealRoomPin').setAttribute('aria-pressed', 'false');
        document.getElementById('requireRoomPin').checked = false;
        updatePinField();
        const chkSave = document.getElementById('chkSaveProfile');
        if (chkSave) chkSave.checked = false;
        const saveRow = document.getElementById('saveProfileRow');
        if (saveRow) saveRow.hidden = true;
        renderRoomProfiles();
        updateCreateRoomPreview();
        document.getElementById("createRoomError").hidden = true;
        if (createRoomModal) openModal(createRoomModal);
        if (modalInputCreateRoomNickname) {
            setTimeout(() => { modalInputCreateRoomNickname.focus(); modalInputCreateRoomNickname.select(); }, 120);
        }
    };

    function updateCreateRoomPreview() {
        setText(document.getElementById('createRoomPreview'), modalInputRoomName.value.trim() || '新的协作房间');
        setText(document.getElementById('createRoomPrivacy'), document.getElementById('requireRoomPin').checked ? '密码房间 · 凭密码加入' : '公开房间 · 同一网络可发现');
    }
    modalInputRoomName.addEventListener('input', updateCreateRoomPreview);
    function updatePinField() {
        updateCreateRoomPreview();
        const enabled = document.getElementById('requireRoomPin').checked;
        document.getElementById('createPinField').hidden = !enabled;
        if (!enabled) { modalInputRoomPin.value = ''; document.getElementById('chkSaveProfile').checked = false; }
        document.getElementById('saveProfileRow').hidden = !enabled;
    }
    document.getElementById('requireRoomPin').addEventListener('change', updatePinField);
    document.getElementById('btnRevealRoomPin').addEventListener('click', event => {
        const visible = modalInputRoomPin.type === 'password';
        modalInputRoomPin.type = visible ? 'text' : 'password';
        event.currentTarget.textContent = visible ? '隐藏密码' : '显示密码';
        event.currentTarget.setAttribute('aria-pressed', String(visible));
    });
    function updatePinSlots() {
        const input = modalInputJoinPin;
        const full = document.getElementById('btnPinInputMode').getAttribute('aria-pressed') === 'true';
        input.parentElement.classList.toggle('pin-entry--full', full || input.value.length > 6 || /[^0-9]/.test(input.value));
        document.querySelectorAll('#joinPinSlots span').forEach((slot, index) => { slot.textContent = input.value[index] ? '•' : ''; });
    }
    modalInputJoinPin.addEventListener('input', () => { updatePinSlots(); modalInputJoinPin.removeAttribute('aria-invalid'); document.getElementById('joinPinError').hidden = true; });
    document.getElementById('btnPinInputMode').addEventListener('click', event => {
        const full = event.currentTarget.getAttribute('aria-pressed') !== 'true';
        event.currentTarget.setAttribute('aria-pressed', String(full));
        event.currentTarget.textContent = full ? '使用 PIN 分格输入' : '使用完整密码输入';
        modalInputJoinPin.inputMode = full ? 'text' : 'numeric'; updatePinSlots(); modalInputJoinPin.focus();
    });
    function joinHostKey(value) {
        try { return new URL(value).origin; } catch (_) { return value; }
    }
    function manualHostUrl(value) {
        try { const url = new URL(value.includes('://') ? value : 'http://' + value); if (!['http:', 'https:'].includes(url.protocol)) return ''; if (!url.port) url.port = '9527'; return url.origin; } catch (_) { return ''; }
    }
    function updateJoinCooldown() {
        for (const [button, host] of [[modalBtnConfirmJoinPin, pendingJoinRoomData?.hostUrl], [modalBtnConfirmManualJoin, manualHostUrl(modalInputManualUrl.value)]]) {
            const seconds = cooldown.remaining(joinHostKey(host || ''));
            button.setAttribute('aria-busy', String(isJoiningRoom));
            button.disabled = isJoiningRoom || seconds > 0;
            button.textContent = seconds ? `${seconds} 秒后重试` : isJoiningRoom ? '正在加入…' : '加入房间';
        }
    }
    modalInputManualUrl.addEventListener('input', updateJoinCooldown);

    if (btnOpenCreateRoomModal) {
        btnOpenCreateRoomModal.addEventListener('click', () => {
            window.openCreateRoomModal();
        });
    }

    if (btnOpenManualJoinModal) {
        btnOpenManualJoinModal.addEventListener('click', () => {
            if (modalInputManualUrl) modalInputManualUrl.value = '';
            if (modalInputManualPin) modalInputManualPin.value = '';
            if (manualJoinModal) openModal(manualJoinModal);
            document.getElementById('manualJoinError').hidden = true; updateJoinCooldown();
        });
    }

    if (btnShowHostQrCode) {
        btnShowHostQrCode.addEventListener('click', () => {
            showHostQrModal();
        });
    }

    function showHostQrModal() {
        if (!hostQrModal || !roomState.roomInfo) return;
        const info = roomState.roomInfo;
        const hostBase = getReachableHostAddress(info.hostPort);
        let directUrl = `${hostBase}/?room=${encodeURIComponent(info.roomId || '')}`;
        if (info.pin) {
            directUrl += `&pin=${encodeURIComponent(info.pin)}`;
        }
        if (qrDirectUrlText) qrDirectUrlText.textContent = directUrl;
        renderQrCodeToCanvas(hostQrCanvas, directUrl);
        openModal(hostQrModal);
    }

    // ---------------- 模块一：局域网快传与日期归类直存 ----------------
    const fileListContainer = document.getElementById('fileListContainer');
    const emptyState = document.getElementById('emptyState');
    const fileCount = document.getElementById('fileCount');
    const btnRefresh = document.getElementById('btnRefresh');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    // 日期归档直存按钮与状态
    const btnSelectReimburseDir = document.getElementById('btnSelectReimburseDir');
    const reimburseStatus = document.getElementById('reimburseStatus');
    const previewFolderName = document.getElementById('previewFolderName');
    const customFolderSuffix = document.getElementById('customFolderSuffix');

    function archiveFolderName() {
        const name = customFolderSuffix.value.trim();
        return document.getElementById('archiveUseDate').checked ? `${getTodayDateStr()}${name ? '_' + name : ''}` : name;
    }
    document.getElementById('archiveUseDate').addEventListener('change', updatePreviewFolderName);
    function updatePreviewFolderName() {
        if (!previewFolderName) return;
        previewFolderName.textContent = archiveFolderName();
    }

    if (customFolderSuffix) {
        customFolderSuffix.addEventListener('input', updatePreviewFolderName);
    }
    document.querySelectorAll('[data-archive-topic]').forEach(button => button.addEventListener('click', () => {
        customFolderSuffix.value = button.dataset.archiveTopic; updatePreviewFolderName();
    }));
    updatePreviewFolderName();

    function getTodayDateStr() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    let currentFiles = [];

    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    function iconMarkup(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`; }
    function getFileIcon(name, mimeType) { return iconMarkup(getFileIconByExtension(name)); }

    // 视图切换容器
    const localSharedFileListContainer = document.getElementById('localSharedFileListContainer');
    const localEmptyState = document.getElementById('localEmptyState');
    const btnSelectShareFile = document.getElementById('btnSelectShareFile');
    const btnClearShareFiles = document.getElementById('btnClearShareFiles');
    const btnRefreshLocalFiles = document.getElementById('btnRefreshLocalFiles');
    const receivedFileListContainer = document.getElementById('receivedFileListContainer');
    const receivedEmptyState = document.getElementById('receivedEmptyState');
    const btnOpenDownloadFolder = document.getElementById('btnOpenDownloadFolder');
    const btnRefreshReceivedFiles = document.getElementById('btnRefreshReceivedFiles');
    const btnRefreshRemoteFiles = document.getElementById('btnRefreshRemoteFiles');
    const multiIpSelectorContainer = document.getElementById('multiIpSelectorContainer');

    function isTauriDesktop() {
        return !!getTauriInvoke() || window.location.hostname === 'tauri.localhost' || window.location.protocol === 'tauri:';
    }

    function getApiOrigin() {
        if (isTauriDesktop()) {
            return 'http://127.0.0.1:9527';
        }
        return '';
    }

    function getTauriInvoke() {
        if (typeof window !== 'undefined' && window.__TAURI__ && typeof window.__TAURI__.invoke === 'function') {
            return window.__TAURI__.invoke.bind(window.__TAURI__);
        }
        if (typeof window !== 'undefined' && typeof window.__TAURI_INVOKE__ === 'function') {
            return window.__TAURI_INVOKE__;
        }
        return null;
    }

    function getTauriDialog() {
        if (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.dialog) {
            return window.__TAURI__.dialog;
        }
        return null;
    }

    function detectClientPlatform() {
        const ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return 'Android';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
        if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Linux/i.test(ua)) return 'Linux';
        if (/Mobile/i.test(ua)) return 'Mobile';
        return 'Web';
    }

    let initialIp = isTauriDesktop() ? '127.0.0.1' : '';

    let userSelectedIp = null;
    try {
        userSelectedIp = localStorage.getItem('wenbox_selected_ip') || null;
    } catch (_) {}

    let selfDeviceInfo = {
        device: '本机',
        ip: userSelectedIp || initialIp,
        port: 9527,
        platform: detectClientPlatform()
    };
    let selfLanIps = [];
    let latestRoomMembers = [];

    function getReachableHostAddress(port) {
        let ip = userSelectedIp || selfDeviceInfo.ip;
        if (!ip || ip === '127.0.0.1' || ip === 'localhost' || ip === 'tauri.localhost') {
            if (Array.isArray(selfLanIps) && selfLanIps.length > 0) {
                const found = selfLanIps.find(item => {
                    const s = typeof item === 'string' ? item : (item && item.ip);
                    return s && s !== '127.0.0.1' && s !== 'localhost';
                });
                if (found) {
                    ip = typeof found === 'string' ? found : found.ip;
                }
            }
        }
        if ((!ip || ip === '127.0.0.1' || ip === 'tauri.localhost') && window.location.hostname && !isTauriDesktop() && window.location.hostname !== 'localhost') {
            ip = window.location.hostname;
        }
        if (!ip) ip = '127.0.0.1';
        const p = port || (roomState.roomInfo && roomState.roomInfo.hostPort) || selfDeviceInfo.port || 9527;
        return `http://${ip}:${p}`;
    }

    function renderMultiIpPills(ips, activeIp) {
        if (!multiIpSelectorContainer) return;
        multiIpSelectorContainer.hidden = !ips || ips.length === 0;
        const select = document.getElementById('hostAddressSelect');
        if (!select || !listChanged(select, ips, activeIp)) return;
        select.replaceChildren(...(ips || []).map(item => {
            const option = document.createElement('option');
            option.value = typeof item === 'string' ? item : item.ip;
            option.textContent = option.value + (item.name ? ` (${item.name})` : '');
            option.selected = option.value === activeIp; return option;
        }));
    }

    window.switchActiveServerIp = function (ip) {
        userSelectedIp = ip;
        try {
            localStorage.setItem('wenbox_selected_ip', ip);
        } catch (_) {}
        selfDeviceInfo.ip = ip;
        if (roomState.roomInfo) {
            roomState.roomInfo.hostIp = ip;
        }
        const invoke = getTauriInvoke();
        if (invoke) {
            invoke('set_room_host_ip_cmd', { ip }).then(() => {
                pollRoomMembers();
                pollChatMessages();
            }).catch(() => {});
        } else {
            fetch(getApiOrigin() + '/api/room/set_ip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            }).then(() => {
                pollRoomMembers();
                pollChatMessages();
            }).catch(() => {});
        }
        updateHostBannerDisplay();
        renderMultiIpPills(selfLanIps, ip);
        if (roomState.mode) {
            updateChatStatusBar(roomState.mode, roomState.roomInfo);
        }
        if (hostQrModal && hostQrModal.open) {
            showHostQrModal();
        }
        showToast(`访问地址已切换为： ${ip}`);
    };

    function updateHostBannerDisplay() {
        if (roomState.mode === 'host') updateChatStatusBar('host', roomState.roomInfo);
    }

    const checkSelfServerStatus = singleFlight(checkSelfServerStatusTask);
    async function checkSelfServerStatusTask() {
        const fetch = fetchWithTimeout;
        const invoke = getTauriInvoke();
        if (invoke) {
            try {
                // 与本地后台实时同步房间模式 (只有本机 Tauri UI 亲自建房 rStatus.isTauriHost 时才响应为 host)
                const rStatus = await invoke('get_room_status_cmd');
                if (rStatus && rStatus.isActive && rStatus.isTauriHost) {
                    if (roomState.mode === 'client') {
                        setRoomMode('host', rStatus);
                    }
                } else if (rStatus && !rStatus.isActive && roomState.mode === 'host') {
                    setRoomMode('client');
                }

                const ips = await invoke('get_all_lan_ips_cmd');
                selfLanIps = ips || [];


                const hasSelected = userSelectedIp && selfLanIps.some(item => {
                    const s = typeof item === 'string' ? item : (item && item.ip);
                    return s === userSelectedIp;
                });

                if (hasSelected) {
                    selfDeviceInfo.ip = userSelectedIp;
                } else {
                    userSelectedIp = null;
                    localStorage.removeItem('wenbox_selected_ip');
                    selfDeviceInfo.ip = window.WenBoxUI.selectLocalAddress(selfLanIps);
                }

                if (selfDeviceInfo.ip) {
                    invoke('set_room_host_ip_cmd', { ip: selfDeviceInfo.ip }).catch(() => {});
                }

                renderMultiIpPills(selfLanIps, selfDeviceInfo.ip);
                if (roomState.mode === 'host') {
                    updateHostBannerDisplay();
                    updateChatStatusBar('host', roomState.roomInfo);
                }
                return;
            } catch (e) {
                console.error('Tauri get IPs error:', e);
            }
        }

        // 浏览器环境或 HTTP 回退
        try {
            const res = await fetch(getApiOrigin() + '/api/status?t=' + Date.now());
            if (res.ok) {
                const data = await res.json();
                if (roomState.mode === 'host') {
                    selfLanIps = data.all_ips || [data.ip];

                    const hasSelected = userSelectedIp && selfLanIps.some(item => {
                        const s = typeof item === 'string' ? item : (item && item.ip);
                        return s === userSelectedIp;
                    });

                    if (hasSelected) {
                        selfDeviceInfo.ip = userSelectedIp;
                    } else {
                        selfDeviceInfo.ip = data.ip;
                    }
                    selfDeviceInfo.device = data.device || selfDeviceInfo.device;
                    selfDeviceInfo.port = data.port || selfDeviceInfo.port;
                    selfDeviceInfo.platform = data.platform || selfDeviceInfo.platform;

                    renderMultiIpPills(selfLanIps, selfDeviceInfo.ip);
                    updateHostBannerDisplay();
                    updateChatStatusBar('host', roomState.roomInfo);
                } else {
                    if (multiIpSelectorContainer) multiIpSelectorContainer.hidden = true;
                }
            }
        } catch (e) {
            // ignore
        }
    }

    // 复制入房直链
    if (btnCopyRoomDirectLink) {
        btnCopyRoomDirectLink.addEventListener('click', async () => {
            if (!roomState.roomInfo) return;
            const info = roomState.roomInfo;
            const hostBase = getReachableHostAddress(info.hostPort);
            let directUrl = `${hostBase}/?room=${encodeURIComponent(info.roomId || '')}`;
            if (info.pin) {
                directUrl += `&pin=${encodeURIComponent(info.pin)}`;
            }
            try {
                await copyText(directUrl);
                showToast(`已复制入房直链: ${directUrl}`);
            } catch (e) {
                if (typeof window.showAlertDialog === 'function') {
                    window.showAlertDialog('入房直链', `直链地址已生成：\n${directUrl}`);
                } else {
                    showToast(`入房直链: ${directUrl}`);
                }
            }
        });
    }

    // ---------------- 离开房间主动通知 ----------------
    function notifyLeaveRoom() {
        if (roomState.mode === 'joined' && currentTargetBaseUrl && roomState.token) {
            const url = `${currentTargetBaseUrl}/api/room/leave`;
            const payload = JSON.stringify({ token: roomState.token });
            try {
                if (navigator.sendBeacon && !window.WenBox.needsNativeTransport()) {
                    const blob = new Blob([payload], { type: 'application/json' });
                    navigator.sendBeacon(url, blob);
                } else {
                    fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Room-Token': roomState.token },
                        body: payload,
                        keepalive: true
                    }).catch(() => {});
                }
            } catch (_) {}
        }
    }
    window.addEventListener('beforeunload', notifyLeaveRoom);
    window.addEventListener('pagehide', notifyLeaveRoom);

    // ---------------- 房间系统核心：模式渲染与切换 ----------------
    function setRoomMode(mode, data) {
        if (roomState.mode === 'joined' && mode !== 'joined') notifyLeaveRoom();
        updateRemoteConnection('ready');
        if (mode !== 'joined') joinedPin = '';
        const changed = roomState.mode !== mode || roomState.roomInfo?.roomId !== data?.roomId;
        if (changed) { resetChatRoomHistory(); uploadQueue?.clear(); demandFiles?.reset(); outbox.clear(); }
        if (mode === 'client') discoveryStartedAt = Date.now();
        discoveryOpen = currentActiveTab === 'view-rooms';
        document.body.dataset.discoveryOpen = String(discoveryOpen);
        document.getElementById('btnBrowseRooms').textContent = '附近房间';
        roomRevision++; scheduler.bump();
        latestRoomMembers = [];
        roomState.mode = mode;
        if (changed && (mode === 'host' || mode === 'joined')) selectView('view-room');
        else if (changed && mode === 'client' && currentActiveTab === 'view-room') selectView('view-rooms');
        if (!directAutoConnectEnabled) directConnectionStatus.hidden = true;
        roomState.roomInfo = mode === 'client' ? null : data;
        currentTargetBaseUrl = mode === 'joined' ? (data.hostUrl || window.location.origin).replace(/\/+$/, '') : '';
        currentTargetDeviceName = mode === 'joined' ? data.hostDevice || '房主' : '本机房间';
        document.body.dataset.roomMode = mode;
        document.body.dataset.roomPage = 'chat'; toggleFiles(false);
        document.querySelectorAll('[data-room-page]').forEach(button => {
            if (button === document.body) return;
            const selected = button.dataset.roomPage === 'chat';
            button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
        });
        const defaultPage = document.querySelector(`[data-file-page="${mode === 'host' ? 'panel-shared' : 'panel-remote'}"]`);
        if (defaultPage) selectSegment(defaultPage, 'filePage', 'file-page');
        if (mode === 'host') { updateHostBannerDisplay(); loadLocalSharedFiles(); loadReceivedFiles(); pollRoomMembers(); }
        else if (mode === 'joined') { loadFiles(); pollJoinedMembers(); }
        else { currentFiles = []; pollDiscoveredRooms(); }
        updateChatStatusBar(mode, data); updateMyNicknameDisplay();
        if (mode !== 'client') pollChatMessages();
    }
    function updateChatStatusBar(mode, data) {
        setText(document.getElementById('roomRoleBadge'), ({ host: '房主', joined: '成员', client: '未加入房间' })[mode]);
        setText(document.getElementById('roomName'), data?.roomName?.replace(/^WenBox[·・]/, '') || data?.roomId || '发现附近的设备');
        setText(document.getElementById('roomLock'), data?.needPassword || data?.pin ? '密码房' : '公开房间');
        setText(document.getElementById('chatOnlineMemberBadge'), `${latestRoomMembers.length || 1} 人在线 · 查看成员`);
        setText(document.getElementById('chatRoomIpBadge'), mode === 'host' ? getReachableHostAddress(data?.hostPort) : currentTargetBaseUrl);
        setText(phoneNameBadge, '本地直传');
        document.getElementById('btnCopyChatRoomUrl').onclick = () => {
            const url = mode === 'host' ? getReachableHostAddress(data?.hostPort) : currentTargetBaseUrl;
            copyWithFeedback(url, '房间地址已复制');
        };
    }

    // ---------------- 通用 Promise 模态确认弹窗 (替代 window.confirm) ----------------
    window._appConfirmResolver = null;
    window.showConfirmDialog = function (title, message, okText = '确定', okColor = '#EF4444') {
        return new Promise((resolve) => {
            const modal = document.getElementById('appConfirmModal');
            const titleEl = document.getElementById('appConfirmTitle');
            const msgEl = document.getElementById('appConfirmMessage');
            const okBtn = document.getElementById('appConfirmOkBtn');
            if (!modal || !titleEl || !msgEl || !okBtn) {
                resolve(false);
                return;
            }
            titleEl.textContent = title;
            msgEl.textContent = message;
            okBtn.textContent = okText;
            okBtn.style.background = okColor;
            openModal(modal);
            window._appConfirmResolver = resolve;
        });
    };

    window.closeAppConfirm = function (result) {
        const modal = document.getElementById('appConfirmModal');
        if (modal) closeModal(modal);
        if (window._appConfirmResolver) {
            window._appConfirmResolver(!!result);
            window._appConfirmResolver = null;
        }
    };

    document.getElementById('appConfirmOkBtn')?.addEventListener('click', () => {
        window.closeAppConfirm(true);
    });

    // ---------------- 通用 Promise 模态提示弹窗 (替代 window.alert) ----------------
    window._appAlertResolver = null;
    window.showAlertDialog = function (title, message, okText = '我知道了') {
        return new Promise((resolve) => {
            const modal = document.getElementById('appAlertModal');
            const titleEl = document.getElementById('appAlertTitle');
            const msgEl = document.getElementById('appAlertMessage');
            const okBtn = document.getElementById('appAlertOkBtn');
            if (!modal || !titleEl || !msgEl || !okBtn) {
                showToast(`${title}: ${message}`);
                resolve();
                return;
            }
            titleEl.textContent = title;
            msgEl.textContent = message;
            okBtn.textContent = okText;
            openModal(modal);
            window._appAlertResolver = resolve;
        });
    };

    window.closeAppAlert = function () {
        const modal = document.getElementById('appAlertModal');
        if (modal) closeModal(modal);
        if (window._appAlertResolver) {
            window._appAlertResolver();
            window._appAlertResolver = null;
        }
    };

    document.getElementById('appAlertOkBtn')?.addEventListener('click', () => {
        window.closeAppAlert();
    });

    // ---------------- 创建房间 (成为服务端) ----------------
    if (modalBtnConfirmCreateRoom) {
        modalBtnConfirmCreateRoom.addEventListener('click', async () => {
            const rNick = (modalInputCreateRoomNickname && modalInputCreateRoomNickname.value.trim()) || localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
            localStorage.setItem('wenbox_nickname', rNick);
            updateMyNicknameDisplay(rNick);

            const rName = (modalInputRoomName && modalInputRoomName.value.trim()) || `WenBox-${Math.floor(1000 + Math.random() * 9000)}`;
            const rPin = document.getElementById('requireRoomPin').checked ? modalInputRoomPin.value.trim() : '';
            if (document.getElementById('requireRoomPin').checked && !rPin) { const error = document.getElementById('createRoomError'); error.textContent = '请输入入房密码，或关闭密码开关。'; error.hidden = false; modalInputRoomPin.focus(); return; }
            const myPlatform = detectClientPlatform();

            document.getElementById('createRoomError').hidden = true;
            modalBtnConfirmCreateRoom.setAttribute('aria-busy', 'true');
            modalBtnConfirmCreateRoom.disabled = true;
            modalBtnConfirmCreateRoom.textContent = '正在创建…';

            try {
                const invoke = getTauriInvoke();
                if (invoke) {
                    const cfg = await invoke('create_room_cmd', {
                        roomName: rName,
                        pin: rPin,
                        hostIp: selfDeviceInfo.ip || null,
                        creatorName: rNick,
                        creatorPlatform: myPlatform
                    });
                    window.closeCreateRoomModal();
                    setRoomMode('host', cfg);
                    showToast(`房间「${rName}」已创建！本机已变身服务端`);
                    const chkSaveInvoke = document.getElementById('chkSaveProfile');
                    if (chkSaveInvoke && chkSaveInvoke.checked && rPin) saveRoomProfile(rName, rPin);
                } else {
                    const resp = await fetch(getApiOrigin() + '/api/room/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            roomName: rName,
                            pin: rPin,
                            hostIp: selfDeviceInfo.ip || undefined,
                            creatorName: rNick,
                            creatorPlatform: myPlatform
                        })
                    });
                    if (!resp.ok) {
                        const errData = await resp.json().catch(() => ({}));
                        throw new Error(errData.message || `HTTP ${resp.status}`);
                    }
                    const cfg = await resp.json();
                    if (cfg && cfg.hostToken) {
                        sessionStorage.setItem('wenbox_host_token', cfg.hostToken);
                        roomState.token = cfg.hostToken;
                    }
                    window.closeCreateRoomModal();
                    setRoomMode('host', cfg);
                    showToast(`房间「${rName}」已创建！`);
                    const chkSaveFetch = document.getElementById('chkSaveProfile');
                    if (chkSaveFetch && chkSaveFetch.checked && rPin) saveRoomProfile(rName, rPin);
                }
            } catch (err) {
                const error = document.getElementById('createRoomError');
                error.textContent = `创建失败：${err.message || err}`; error.hidden = false;
            } finally {
                modalBtnConfirmCreateRoom.removeAttribute('aria-busy');
                modalBtnConfirmCreateRoom.disabled = false;
                modalBtnConfirmCreateRoom.textContent = '创建房间';
            }
        });
    }

    // ---------------- 解散房间 (切回客户端模式) ----------------
    if (btnCloseRoom) {
        btnCloseRoom.addEventListener('click', async () => {
            const ok = await window.showConfirmDialog(
                '解散房间',
                '确定要解散当前房间吗？解散后本机将恢复为客户端发现模式。',
                '确定解散',
                '#EF4444'
            );
            if (!ok) return;
            directAutoConnectEnabled = false;
            try {
                const invoke = getTauriInvoke();
                if (invoke) {
                    await invoke('close_room_cmd');
                } else {
                    const savedToken = sessionStorage.getItem('wenbox_host_token') || '';
                    const res = await fetch(getApiOrigin() + '/api/room/close', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Host-Token': savedToken
                        },
                        body: JSON.stringify({ hostToken: savedToken })
                    });
                    sessionStorage.removeItem('wenbox_host_token');
                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData.message || `HTTP ${res.status}`);
                    }
                }
                showToast('房间已解散，已切换回客户端发现大厅');
                setRoomMode('client');
            } catch (e) {
                showToast(`解散房间失败: ${e.message || e}`);
            }
        });
    }

    // ---------------- 退出已加入的房间 ----------------
    if (btnLeaveRoom) {
        btnLeaveRoom.addEventListener('click', async () => {
            const ok = await window.showConfirmDialog(
                '退出房间',
                '确定要退出当前房间吗？退出后可重新在客户端大厅选择房间加入。',
                '确定退出',
                '#F59E0B'
            );
            if (!ok) return;
            directAutoConnectEnabled = false;
            notifyLeaveRoom();
            roomState.token = '';
            localStorage.removeItem('wenbox_room_token');
            showToast('已退出房间');
            setRoomMode('client');
        });
    }

    // ---------------- 发现房间轮询与卡片渲染 ----------------
    let isPollingRooms = false;
    async function pollDiscoveredRooms() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (isPollingRooms) return;
        if (roomState.mode !== 'client' && !discoveryOpen) return;
        isPollingRooms = true;
        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                // 只有当本机 Tauri UI 是房主时才同步切为 host 模式
                try {
                    const rStatus = await invoke('get_room_status_cmd');
                    if (roomState.mode === 'client' && rStatus && rStatus.isActive && rStatus.isTauriHost) {
                        setRoomMode('host', rStatus);
                        return;
                    }
                } catch (_) {}

                try {
                    await invoke('send_room_probe_cmd');
                } catch (_) {}
            }
            let rooms = [];
            if (invoke) {
                rooms = await invoke('get_discovered_rooms_cmd');
            } else {
                const res = await fetch(getApiOrigin() + '/api/discovered_rooms?t=' + Date.now());
                if (res.ok) {
                    const data = await res.json();
                    rooms = data.rooms || [];
                }
            }
            if (revision !== roomRevision) return;
            renderDiscoveredRooms(rooms || []);
        } catch (e) {
            // ignore
        } finally {
            isPollingRooms = false;
        }
    }

    function renderDiscoveredRooms(rooms) {
        rooms = (rooms || []).slice().sort((a, b) => String(a.id || a.roomId).localeCompare(String(b.id || b.roomId)));
        document.getElementById('roomDiscoverySkeleton').hidden = rooms.length > 0 || Date.now() - discoveryStartedAt >= 3000;
        roomState.discoveredRooms = rooms;
        if (!listChanged(discoveredRoomsContainer, rooms, currentTargetBaseUrl + roomState.mode)) return;
        roomState.discoveredRooms = rooms;
        if (discoveredRoomsCount) discoveredRoomsCount.textContent = rooms.length;
        if (!discoveredRoomsContainer) return;

        if (rooms.length === 0) {
            discoveredRoomsContainer.innerHTML = '';
            if (noRoomsDiscoveredPrompt) noRoomsDiscoveredPrompt.hidden = Date.now() - discoveryStartedAt < 3000;
            return;
        }

        if (noRoomsDiscoveredPrompt) noRoomsDiscoveredPrompt.hidden = true;
        discoveredRoomsContainer.innerHTML = rooms.map(room => `
            <div class="list-row"><span class="room-device-icon">${iconMarkup(/Android|iOS/.test(room.hostPlatform) ? 'smartphone' : 'monitor')}</span><div class="member-details"><strong>${escapeHtml(room.roomName || room.roomId)}</strong><span class="text-2">${escapeHtml(room.hostDevice || '房主')} · ${escapeHtml(room.ip)}:${Number(room.port)}</span><span class="badge">${room.needPassword ? '需要密码' : '公开房间'}</span></div><button class="btn btn--primary btn--sm" type="button" data-action="join-room" data-value="${escapeHtml(JSON.stringify([room.roomId, room.ip, room.port]))}">加入房间</button></div>`).join('');
    }

    window.openJoinRoomDialog = function (data) {
        if (!data) return;
        directAutoConnectEnabled = false;
        const effectiveHostUrl = (data.hostUrl && String(data.hostUrl).trim()) ? String(data.hostUrl).trim().replace(/\/+$/, '') : (isTauriDesktop() ? 'http://127.0.0.1:9527' : window.location.origin);
        pendingJoinRoomData = {
            hostUrl: effectiveHostUrl,
            roomName: data.roomName || data.roomId || '房间',
            roomId: data.roomId || '',
            hostDevice: data.hostDevice || '主机',
            needPassword: !!data.needPassword
        };

        const titleEl = document.getElementById('joinPinModalTitle');
        const descEl = document.getElementById('joinPinModalDesc');
        const nickInput = document.getElementById('modalInputJoinNickname');
        const pinContainer = document.getElementById('joinPinContainer');
        const pinInput = document.getElementById('modalInputJoinPin');

        if (titleEl) titleEl.textContent = '加入房间';
        setText(document.getElementById('joinRoomPreview'), pendingJoinRoomData.roomName);
        setText(document.getElementById('joinRoomDevice'), `${pendingJoinRoomData.hostDevice} · ${pendingJoinRoomData.needPassword ? '密码房间' : '公开房间'}`);
        if (descEl) {
            descEl.textContent = pendingJoinRoomData.needPassword ? '确认你的昵称，再输入房主提供的密码。' : '确认你的昵称，加入后即可开始协作。';
        }
        if (nickInput) {
            nickInput.value = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        }
        if (pinContainer) {
            pinContainer.hidden = !pendingJoinRoomData.needPassword;
        }
        if (pinInput) { pinInput.value = data.pin || ''; pinInput.removeAttribute('aria-invalid'); }
        updatePinSlots(); document.getElementById('joinPinError').hidden = true; updateJoinCooldown();

        if (joinRoomPinModal) openModal(joinRoomPinModal);
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 150);
    };

    window.onDiscoveredRoomClicked = function (key) {
        const r = roomState.discoveredRooms.find(x => JSON.stringify([x.roomId, x.ip, x.port]) === key);
        if (!r) return;
        window.openJoinRoomDialog({
            hostUrl: `http://${r.ip}:${r.port}`,
            roomName: r.roomName,
            roomId: r.roomId,
            hostDevice: r.hostDevice,
            needPassword: r.needPassword
        });
    };

    if (modalBtnConfirmJoinPin) {
        modalBtnConfirmJoinPin.addEventListener('click', () => {
            if (!pendingJoinRoomData) return;
            const nickInput = document.getElementById('modalInputJoinNickname');
            const pinInput = document.getElementById('modalInputJoinPin');
            const nick = (nickInput && nickInput.value.trim()) || whoami_device_name_client();
            localStorage.setItem('wenbox_nickname', nick);
            const pin = (pendingJoinRoomData.needPassword && pinInput) ? pinInput.value.trim() : '';
            executeJoinRoom(pendingJoinRoomData.hostUrl, pin, pendingJoinRoomData.roomName, pendingJoinRoomData.hostDevice, pendingJoinRoomData.roomId, nick);
        });
    }

    const modalNickInput = document.getElementById('modalInputJoinNickname');
    if (modalNickInput) {
        modalNickInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                if (modalBtnConfirmJoinPin) modalBtnConfirmJoinPin.click();
            }
        });
    }
    if (modalInputJoinPin) {
        modalInputJoinPin.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                if (modalBtnConfirmJoinPin) modalBtnConfirmJoinPin.click();
            }
        });
    }

    if (modalBtnConfirmManualJoin) {
        modalBtnConfirmManualJoin.addEventListener('click', () => {
            let rawUrl = modalInputManualUrl ? modalInputManualUrl.value.trim() : '';
            if (!rawUrl) {
                showToast('请输入主机 IP 或网址');
                return;
            }
            rawUrl = manualHostUrl(rawUrl);
            if (!rawUrl) { showToast('请输入有效的 HTTP 主机地址'); return; }
            const pin = modalInputManualPin ? modalInputManualPin.value.trim() : '';
            const nick = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
            executeJoinRoom(rawUrl, pin, '手动连接房间', '远程主机', '', nick);
        });
    }

    for (const [dialogId, button] of [['createRoomModal', modalBtnConfirmCreateRoom], ['manualJoinModal', modalBtnConfirmManualJoin]]) {
        document.getElementById(dialogId).addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing && event.target.matches('input:not([type="checkbox"])')) {
                event.preventDefault(); button.click();
            }
        });
    }
    let isJoiningRoom = false;
    async function executeJoinRoom(hostUrl, pin, roomName, hostDevice, roomId, nickname, automatic = false) {
        if (isJoiningRoom || cooldown.remaining(joinHostKey(hostUrl))) return;
        if (!automatic) directAutoConnectEnabled = false;
        const revision = roomRevision;
        isJoiningRoom = true; updateJoinCooldown();
        const fetch = fetchWithTimeout;
        try {
            showToast('正在连接房间…');
            let joinRes = null;
            const myNick = nickname || localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
            const effectiveHostUrl = (hostUrl && String(hostUrl).trim()) ? String(hostUrl).trim().replace(/\/+$/, '') : (isTauriDesktop() ? 'http://127.0.0.1:9527' : window.location.origin);

            const invoke = getTauriInvoke();
            if (invoke) {
                joinRes = await invoke('join_remote_room_cmd', {
                    hostUrl: effectiveHostUrl,
                    pin: pin,
                    myName: myNick,
                    expectedRoomId: automatic ? roomId : null
                });
            } else {
                const resp = await fetch(`${effectiveHostUrl}/api/room/join`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pin: pin,
                        name: myNick,
                        platform: detectClientPlatform()
                    })
                });
                if (!resp.ok) {
                    const errData = await resp.json().catch(() => ({}));
                    if (resp.status === 429) cooldown.start(joinHostKey(effectiveHostUrl), errData.retryAfter || Number(resp.headers.get('Retry-After')) || 60);
                    throw new Error(errData.message || `HTTP ${resp.status}`);
                }
                joinRes = await resp.json();
            }

            if (automatic) {
                const current = await invoke('get_room_status_cmd');
                if (revision !== roomRevision || !directAutoConnectEnabled || !current.canAutoConnect
                    || document.querySelector('dialog[open]') || document.getElementById('webChatMessageInput')?.value.trim()) return;
            }
            if (joinRes && joinRes.success) {
                roomState.token = joinRes.token || '';
                roomState.memberId = joinRes.memberId || '';
                localStorage.setItem('wenbox_room_token', roomState.token);
                localStorage.setItem('wenbox_member_id', roomState.memberId);
                window.closeJoinPinModal();
                window.closeManualJoinModal();
                joinedPin = pin; joinedResumeAt = 0;
                setRoomMode('joined', {
                    hostUrl: effectiveHostUrl,
                    roomName: joinRes.room ? joinRes.room.roomName : (roomName || '已加入房间'),
                    roomId: joinRes.room ? joinRes.room.roomId : roomId,
                    hostDevice: joinRes.room ? joinRes.room.hostDevice : hostDevice,
                    needPassword: !!joinRes.room?.needPassword
                });
                if (automatic) setText(directConnectionStatus, '网线直连 · 已自动连接');
                showToast(` 成功加入房间！已与「${hostDevice || '房主'}」建立直连`);
                updateMyNicknameDisplay(myNick);
            } else {
                if (joinRes?.retryAfter > 0) cooldown.start(joinHostKey(effectiveHostUrl), joinRes.retryAfter);
                throw new Error(joinRes?.message || '入房密码不正确');
            }
        } catch (e) {
            if (automatic) {
                setText(directConnectionStatus, '网线直连 · 正在重试');
                directConnectionStatus.title = '请确认对端已打开WenBox，并允许本地网络和防火墙访问';
                return;
            }
            const error = document.getElementById(manualJoinModal.open ? 'manualJoinError' : 'joinPinError');
            error.hidden = false; error.textContent = String(e.message || e);
            modalInputJoinPin.setAttribute('aria-invalid', 'true');
        } finally {
            isJoiningRoom = false; updateJoinCooldown();
        }
    }

    const autoConnectDirect = singleFlight(async () => {
        const invoke = getTauriInvoke();
        if (!invoke || !directAutoConnectEnabled || roomState.mode === 'joined' || isJoiningRoom || Date.now() < directRetryAt) return;
        // User interaction always takes priority over background pairing.
        if (document.querySelector('dialog[open]') || document.getElementById('webChatMessageInput')?.value.trim()) return;
        const revision = roomRevision;
        try {
            const [local, ips, rooms] = await Promise.all([
                invoke('get_room_status_cmd'), invoke('get_all_lan_ips_cmd'), invoke('get_discovered_rooms_cmd')
            ]);
            if (revision !== roomRevision || !directAutoConnectEnabled || roomState.mode === 'joined') return;
            const hasLink = ips.some(item => window.WenBoxUI.isLinkLocal(typeof item === 'string' ? item : item.ip));
            directConnectionStatus.hidden = !hasLink;
            if (!hasLink) return;
            const ownIps = new Set(ips.map(item => typeof item === 'string' ? item : item.ip));
            const connected = latestRoomMembers.some(member => window.WenBoxUI.isLinkLocal(member.ip) && !ownIps.has(member.ip));
            setText(directConnectionStatus, connected ? '网线直连 · 已连接' :
                (local.canAutoConnect ? '网线直连 · 正在发现对端' : '网线直连 · 房间已就绪'));
            directConnectionStatus.title = '首次使用时，请允许WenBox的本地网络和防火墙访问';
            const peer = window.WenBoxUI.selectDirectPeer(local, rooms, ips);
            if (!peer) return;
            directRetryAt = Date.now() + 5000;
            await executeJoinRoom(`http://${peer.ip}:${peer.port}`, '', peer.roomName, peer.hostDevice, peer.roomId,
                localStorage.getItem('wenbox_nickname') || whoami_device_name_client(), true);
        } catch (_) { /* Native service may still be starting; the next tick retries. */ }
    });

    function whoami_device_name_client() {
        const storedNick = localStorage.getItem('wenbox_nickname');
        if (storedNick && storedNick.trim()) return storedNick.trim();
        const plat = detectClientPlatform();
        let prefix = '访客';
        if (plat === 'macOS') prefix = 'Mac电脑';
        else if (plat === 'Windows') prefix = 'Win电脑';
        else if (plat === 'Android') prefix = 'Android手机';
        else if (plat === 'iOS') prefix = 'iPhone';
        else if (plat === 'Linux') prefix = 'Linux设备';
        const nickname = `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
        localStorage.setItem('wenbox_nickname', nickname);
        return nickname;
    }

    function updateMyNicknameDisplay(nick) {
        const myNick = nick || localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        const bannerEl = document.getElementById('bannerMyNicknameDisplay');
        const chatEl = document.getElementById('chatMyNicknameDisplay');
        if (bannerEl) bannerEl.textContent = myNick;
        if (chatEl) chatEl.textContent = myNick;
    }

    window.openEditNicknameModal = function () {
        const modal = document.getElementById('editNicknameModal');
        const input = document.getElementById('modalInputEditNickname');
        const currentNick = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        if (input) { input.value = currentNick; input.dispatchEvent(new Event("input")); }
        if (modal) openModal(modal);
        if (input) setTimeout(() => { input.focus(); input.select(); }, 120);
    };

    window.closeEditNicknameModal = function () {
        const modal = document.getElementById('editNicknameModal');
        if (modal) closeModal(modal);
    };

    const btnChangeNicknameBanner = document.getElementById('btnChangeNicknameBanner');
    if (btnChangeNicknameBanner) {
        btnChangeNicknameBanner.addEventListener('click', window.openEditNicknameModal);
    }
    const btnChangeNicknameChat = document.getElementById('btnChangeNicknameChat');
    if (btnChangeNicknameChat) {
        btnChangeNicknameChat.addEventListener('click', window.openEditNicknameModal);
    }

    const nicknameInput = document.getElementById('modalInputEditNickname');
    nicknameInput?.addEventListener('input', () => {
        const name = nicknameInput.value.trim();
        setText(document.getElementById('nicknamePreview'), name || '我的设备');
        setText(document.getElementById('nicknameAvatar'), Array.from(name || 'W')[0].toUpperCase());
        setText(document.getElementById('nicknameCount'), `${nicknameInput.value.length} / 20`);
        document.getElementById('btnSaveNicknameModal').disabled = !name;
    });
    nicknameInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); document.getElementById('btnSaveNicknameModal').click(); }
    });
    const btnSaveNicknameModal = document.getElementById('btnSaveNicknameModal');
    if (btnSaveNicknameModal) {
        btnSaveNicknameModal.addEventListener('click', async () => {
            const input = document.getElementById('modalInputEditNickname');
            const newNick = (input && input.value.trim()) || '';
            if (!newNick) {
                showToast('请输入有效的昵称');
                return;
            }
            localStorage.setItem('wenbox_nickname', newNick);
            updateMyNicknameDisplay(newNick);
            window.closeEditNicknameModal();
            showToast(`昵称已更新为「${newNick}」`);

            // 如果当前在已加入的房间中，立即向房主发送心跳同步新昵称
            if (roomState.mode === 'joined' && currentTargetBaseUrl) {
                try {
                    await fetch(currentTargetBaseUrl + '/api/room/heartbeat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Room-Token': roomState.token || ''
                        },
                        body: JSON.stringify({
                            name: getClientSenderName(),
                            platform: detectClientPlatform(),
                            token: roomState.token || '',
                            roomId: roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : ''
                        })
                    });
                } catch (_) {}
            }
        });
    }

    // 房主轮询房间成员
    const pollRoomMembers = singleFlight(pollRoomMembersTask);
    async function pollRoomMembersTask() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (roomState.mode !== 'host') return;
        try {
            let members = [];
            const invoke = getTauriInvoke();
            if (invoke) {
                members = await invoke('get_room_members_cmd');
            } else {
                const savedHostToken = sessionStorage.getItem('wenbox_host_token') || roomState.token || '';
                const myNick = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
                const myPlatform = detectClientPlatform();

                // 浏览器作为房主时，检查房间活跃状态与房主凭据，防止服务端房间已被其他人解散或重建
                try {
                    const stRes = await fetch(getApiOrigin() + '/api/room/status?t=' + Date.now(), {
                        headers: savedHostToken ? { 'X-Host-Token': savedHostToken } : {}
                    });
                    if (revision !== roomRevision) return;
                    if (stRes.ok) {
                        const st = await stRes.json();
                        if (revision !== roomRevision) return;
                        const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
                        if (!st.isActive || !st.isHost || (st.roomId && currentRoomId && st.roomId !== currentRoomId)) {
                            sessionStorage.removeItem('wenbox_host_token');
                            roomState.token = null;
                    roomState.memberId = '';
                    localStorage.removeItem('wenbox_member_id');
                            showToast('房间已解散或服务端已创建新房间，已自动返回发现大厅');
                            setRoomMode('client');
                            return;
                        }
                    } else if (stRes.status === 401 || stRes.status === 403 || stRes.status === 404) {
                        sessionStorage.removeItem('wenbox_host_token');
                        roomState.token = null;
                    roomState.memberId = '';
                    localStorage.removeItem('wenbox_member_id');
                        showToast('房间已解散，已自动返回发现大厅');
                        setRoomMode('client');
                        return;
                    }
                } catch (_) {}

                // 发送心跳以维持在线及房主身份
                try {
                    await fetch(getApiOrigin() + '/api/room/heartbeat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Host-Token': savedHostToken
                        },
                        body: JSON.stringify({
                            token: savedHostToken,
                            roomId: roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '',
                            nickname: myNick,
                            platform: myPlatform
                        })
                    });
                } catch (_) {}

                const res = await fetch(getApiOrigin() + '/api/room/members?t=' + Date.now(), {
                    headers: savedHostToken ? { 'X-Host-Token': savedHostToken } : {}
                });
                if (revision !== roomRevision) return;
                if (res.ok) {
                    const data = await res.json();
                    members = data.members || [];
                } else if (res.status === 401 || res.status === 403 || res.status === 404) {
                    sessionStorage.removeItem('wenbox_host_token');
                    roomState.token = null;
                    roomState.memberId = '';
                    localStorage.removeItem('wenbox_member_id');
                    showToast('房间已解散，已自动返回发现大厅');
                    setRoomMode('client');
                    return;
                }
            }
            members.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            if (revision !== roomRevision) return;
            latestRoomMembers = members;
            const onlineBadge = document.getElementById('chatOnlineMemberBadge');
            setText(onlineBadge, ` ${members.length || 1} 人在线 · 查看成员`);

        } catch (e) {
            // ignore
        }
    }

    // 访客端轮询房间成员、心跳与在线人数
    const pollJoinedMembers = singleFlight(pollJoinedMembersTask);
    async function pollJoinedMembersTask() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (roomState.mode !== 'joined') return;
        const baseUrl = (currentTargetBaseUrl || (isTauriDesktop() ? 'http://127.0.0.1:9527' : window.location.origin)).replace(/\/+$/, '');
        if (!baseUrl) return;
        try {
            // 1. 发送心跳保证在线登记，并反向同步主机最新房间名
            try {
                const hbRes = await fetch(baseUrl + '/api/room/heartbeat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Room-Token': roomState.token || ''
                    },
                    body: JSON.stringify({
                        name: getClientSenderName(),
                        platform: detectClientPlatform(),
                        token: roomState.token || '',
                        roomId: roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : ''
                    }),
                    signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined
                });
                if (hbRes.ok) {
                    const hbData = await hbRes.json();
                    if (revision !== roomRevision) return;
                    if (hbData && hbData.room) {
                        const r = hbData.room;
                        const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
                        if (!r.isActive || (r.roomId && currentRoomId && r.roomId !== currentRoomId)) {
                            updateRemoteConnection('ended', '原房间已结束，记录保留。可手动退出后加入新房间。');
                            return;
                        }
                        if (roomState.roomInfo && roomState.roomInfo.roomName !== r.roomName) {
                            roomState.roomInfo.roomName = r.roomName;
                            roomState.roomInfo.roomId = r.roomId;
                            updateChatGatingUi('joined', roomState.roomInfo);
                            updateChatStatusBar('joined', roomState.roomInfo);
                        }
                    }
                }
            } catch (_) {}

            // 2. 拉取最新在线成员列表
            const api = baseUrl + '/api/room/members?t=' + Date.now();
            const res = await fetch(api, {
                headers: { 'X-Room-Token': roomState.token || '' },
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined
            });
            if (res.ok) {
                const data = await res.json();
                const members = data.members || [];
                if (revision !== roomRevision) return;
                latestRoomMembers = members;
                const onlineBadge = document.getElementById('chatOnlineMemberBadge');
                setText(onlineBadge, ` ${members.length} 人在线 · 查看成员`);
            }
        } catch (_) {}
    }

    window.openOnlineMembersModal = async function() {
        const modal = document.getElementById('onlineMembersModal');
        const listEl = document.getElementById('onlineMembersModalList');
        if (!modal || !listEl) return;

        // 如果成员数据尚未加载，立即尝试获取一次
        if (!latestRoomMembers || latestRoomMembers.length === 0) {
            if (roomState.mode === 'joined') {
                await pollJoinedMembers();
            } else if (roomState.mode === 'host') {
                await pollRoomMembers();
            }
        }

        let members = latestRoomMembers;
        if (!members || members.length === 0) {
            listEl.innerHTML = `<div class="members-empty">暂无在线成员信息</div>`;
            openModal(modal);
            return;
        }

        setText(document.getElementById('memberCount'), `${members.length} 台在线`);
        listEl.innerHTML = members.map(member => {
            const isMe = roomState.memberId && member.id === roomState.memberId;
            const name = member.name || '未命名设备';
            return `<div class="member-card"><span class="member-avatar">${escapeHtml(Array.from(name)[0].toUpperCase())}</span><div class="member-details"><strong>${escapeHtml(name)}${isMe ? '<small>你</small>' : ''}</strong><span class="text-2">${escapeHtml(member.platform || '设备')} <span class="member-online">在线</span></span><span class="mono text-3">${escapeHtml(member.ip || '地址未知')}</span></div><button type="button" class="btn btn--ghost btn--icon" title="复制 IP 地址" aria-label="复制 ${escapeHtml(name)} 的 IP 地址" data-action="copy-ip" data-value="${escapeHtml(member.ip || '')}" ${member.ip ? '' : 'disabled'}><svg class="icon"><use href="#i-copy"></use></svg></button></div>`;
        }).join('');

        openModal(modal);
    };

    window.closeOnlineMembersModal = function() {
        const modal = document.getElementById('onlineMembersModal');
        if (modal) closeModal(modal);
    };

    window.copyMemberIp = (ip) => copyWithFeedback(ip, 'IP 地址已复制');

    document.getElementById('btnShowChatMembersModal')?.addEventListener('click', () => {
        window.openOnlineMembersModal();
    });
    document.getElementById('chatOnlineMemberBadge')?.addEventListener('click', () => {
        window.openOnlineMembersModal();
    });

    if (btnRefreshDiscoveredRooms) {
        btnRefreshDiscoveredRooms.addEventListener('click', async () => {
            await pollDiscoveredRooms();
            showToast('房间列表已刷新');
        });
    }

    let isLoadingFiles = false;
    async function loadFiles() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (isLoadingFiles) return;
        isLoadingFiles = true;
        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                const files = await invoke('fetch_node_files', { baseUrl: currentTargetBaseUrl, token: roomState.token || null });
                if (revision !== roomRevision) return;
                currentFiles = files;
                renderFiles();
                return;
            }

            const tokenParam = roomState.token ? `&token=${encodeURIComponent(roomState.token)}` : '';
            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/files?t=' + Date.now() + tokenParam;
            const headers = {};
            if (roomState.token) {
                headers['X-Room-Token'] = roomState.token;
            }
            const res = await fetch(api, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (revision !== roomRevision) return;
            currentFiles = data.files || [];
            renderFiles();
        } catch (err) {
            if (revision !== roomRevision) return;
            console.error('loadFiles error:', err);
            if (fileListContainer && currentFiles.length === 0) {
                listChanged(fileListContainer, null, 'error');
                fileListContainer.innerHTML = `
                    <div class="file-load-error">
                        <div> 无法拉取该设备的文件列表 (${escapeHtml(String(err.message || err))})</div>
                        <div class="file-load-hint">请检查对方设备是否在线且已开启 WenBox 服务</div>
                        <button data-action="refresh-files" class="file-retry-button">点击重试</button>
                    </div>
                `;
            }
        } finally {
            isLoadingFiles = false;
        }
    }
    window.loadFiles = loadFiles;

    // 远程文件下载
    window.downloadRemoteFile = async function(fileId, fileName, context = captureAttachmentContext()) {
        const token = context.roomId === roomState.roomInfo?.roomId ? getEffectiveRoomToken() : context.token;
        const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
        const downloadBase = context.base;
        const tauriDialog = getTauriDialog();
        const invoke = getTauriInvoke();
        if (tauriDialog && invoke) {
            try {
                const savePath = await tauriDialog.save({
                    defaultPath: fileName,
                    title: `保存文件 ${fileName}`
                });
                if (!savePath) return;

                const dir = savePath.substring(0, Math.max(savePath.lastIndexOf('\\'), savePath.lastIndexOf('/')));
                const name = savePath.substring(Math.max(savePath.lastIndexOf('\\'), savePath.lastIndexOf('/')) + 1);

                const downloadUrl = downloadBase + `/api/download/${encodeURIComponent(fileId)}${tokenQuery}`;
                await invoke('save_remote_file_to_directory', {
                    downloadUrl: downloadUrl,
                    dirPath: dir,
                    folderName: '',
                    fileName: name,
                    token: token || null
                });
                showToast(`已成功保存到: ${savePath}`);
                return;
            } catch (e) {
                showToast(`保存失败：${e.message || e}`);
                return;
            }
        }

        const dlUrl = downloadBase + `/api/download/${encodeURIComponent(fileId)}${tokenQuery}`;
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    function renderFiles() {
        currentFiles = (currentFiles || []).slice().sort((a, b) => String(a.id || a.roomId).localeCompare(String(b.id || b.roomId)));
        if (!listChanged(fileListContainer, currentFiles, currentTargetBaseUrl + roomState.mode)) return;
        if (!fileCount || !fileListContainer || !emptyState) return;
        fileCount.textContent = `${currentFiles.length} 个文件`;
        if (currentFiles.length === 0) {
            fileListContainer.innerHTML = '';
            emptyState.hidden = false;
            return;
        }

        emptyState.hidden = true;
        fileListContainer.innerHTML = currentFiles.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} · ${file.onDemand ? escapeHtml(file.ownerName || '成员') + (file.online ? ' · 按需下载' : ' · 发送方离线') : '对方分享'}</div>
                        </div>
                    </div>
                    <div class="file-row-actions"><button ${file.onDemand && !file.online ? 'disabled' : ''} data-action="download-file" data-value="${escapeHtml(file.id)}" data-name="${escapeHtml(file.name)}" class="btn btn--secondary btn--sm">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        下载
                    </button>${file.onDemand && demandFiles?.owns(file.id) ? `<button data-action="remove-file" data-value="${escapeHtml(file.id)}" class="btn-danger-outline file-remove-button">移除</button>` : ''}</div>
                </div>
            `;
        }).join('');
    }

    // ---------------- 本机对外分享与已接收文件管理 ----------------
    const loadLocalSharedFiles = singleFlight(loadLocalSharedFilesTask);
    async function loadLocalSharedFilesTask() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (!localSharedFileListContainer) return;
        try {
            const res = await fetch(getApiOrigin() + '/api/files?t=' + Date.now(), { headers: authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const files = (await res.json()).files || [];
            if (revision !== roomRevision) return;
            renderLocalSharedFiles(files);
        } catch (e) {
            console.error('loadLocalSharedFiles error:', e);
        }
    }

    function formatDisplayPath(rawPath) {
        if (!rawPath) return '';
        const clientPlat = detectClientPlatform();
        const isWin = clientPlat === 'Windows';

        // Check if rawPath is a Windows path with drive letter (e.g. C:\Users\...)
        const winDriveMatch = rawPath.match(/^[A-Za-z]:[\\/](?:Users[\\/][^\\/]+[\\/])?Downloads[\\/](.*)$/i);
        const winWenBoxMatch = rawPath.match(/^[A-Za-z]:[\\/].*?[\\/]WenBox[\\/](.*)$/i);

        if (!isWin) {
            // macOS, Android, iOS, Linux: use forward slashes and native-friendly naming
            if (winDriveMatch) {
                const sub = winDriveMatch[1].replace(/\\/g, ' / ');
                return `下载 / ${sub}`;
            }
            if (winWenBoxMatch) {
                const sub = winWenBoxMatch[1].replace(/\\/g, ' / ');
                return `下载 / WenBox / ${sub}`;
            }
            if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
                return rawPath.replace(/^[A-Za-z]:[\\/]/, '').replace(/\\/g, ' / ');
            }
            return rawPath.replace(/\\/g, '/').replace(/^Download\//i, '下载 / ').replace(/\//g, ' / ');
        } else {
            // Windows client
            if (/^Download[\\/]/i.test(rawPath)) {
                return rawPath.replace(/\//g, '\\').replace(/^Download\\/i, 'Downloads\\');
            }
            return rawPath;
        }
    }

    function renderLocalSharedFiles(files) {
        files = (files || []).slice().sort((a, b) => String(a.id || a.roomId).localeCompare(String(b.id || b.roomId)));
        if (btnClearShareFiles) btnClearShareFiles.hidden = files.length === 0;
        if (!listChanged(localSharedFileListContainer, files, currentTargetBaseUrl + roomState.mode)) return;
        if (!localSharedFileListContainer || !localEmptyState) return;
        if (!files || files.length === 0) {
            localSharedFileListContainer.innerHTML = '';
            localEmptyState.hidden = false;
            return;
        }

        localEmptyState.hidden = true;
        localSharedFileListContainer.innerHTML = files.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);
            const dlUrl = `${getApiOrigin()}/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${escapeHtml(file.path || file.name)}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} · ${file.onDemand ? escapeHtml(file.ownerName || '成员') + (file.online ? ' · 按需下载' : ' · 发送方离线') : '已分享'}</div>
                        </div>
                    </div>
                    <div class="file-row-actions">
                        <button data-action="download-file" data-value="${escapeHtml(file.id)}" data-name="${escapeHtml(file.name)}" class="btn btn--secondary btn--sm" title="保存文件副本">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                            </svg>
                            下载
                        </button>
                        <button ${file.onDemand && !demandFiles?.owns(file.id) ? 'hidden' : ''} data-action="remove-file" data-value="${escapeHtml(file.id)}" class="btn-danger-outline file-remove-button" >
                            移除
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    window.removeLocalSharedFile = async function (fileId) {
        try {
            const invoke = getTauriInvoke();
            if (fileId.startsWith('offer-')) { await demandFiles.remove(fileId); } else if (invoke) {
                await invoke('remove_share_file', { id: fileId });
            } else {
                await fetch(getApiOrigin() + `/api/files/remove?id=${encodeURIComponent(fileId)}`, { method: 'POST', headers: authHeaders() });
            }
            showToast('已移除该分享文件');
            if (roomState.mode === 'host') loadLocalSharedFiles(); else loadFiles();
        } catch (e) {
            showToast(`移除失败: ${e.message || e}`);
        }
    };

    const loadReceivedFiles = singleFlight(loadReceivedFilesTask);
    async function loadReceivedFilesTask() {
        const fetch = fetchWithTimeout;
        const revision = roomRevision;
        if (!receivedFileListContainer) return;
        try {
            let files = [];
            const invoke = getTauriInvoke();
            if (invoke) {
                files = await invoke('get_received_files');
            } else {
                const res = await fetch(getApiOrigin() + '/api/received_files?t=' + Date.now(), { headers: authHeaders() });
                if (res.ok) {
                    const data = await res.json();
                    files = data.files || [];
                }
            }
            if (revision !== roomRevision) return;
            renderReceivedFiles(files);
        } catch (e) {
            console.error('loadReceivedFiles error:', e);
        }
    }

    function renderReceivedFiles(files) {
        if (!listChanged(receivedFileListContainer, files, currentTargetBaseUrl + roomState.mode)) return;
        if (!receivedFileListContainer || !receivedEmptyState) return;
        if (!files || files.length === 0) {
            receivedFileListContainer.innerHTML = '';
            receivedEmptyState.hidden = false;
            return;
        }

        receivedEmptyState.hidden = true;
        receivedFileListContainer.innerHTML = files.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);
            const dlUrl = `${getApiOrigin()}/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${escapeHtml(formatDisplayPath(file.path || 'Downloads/WenBox'))}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} · 已保存到下载目录</div>
                        </div>
                    </div>
                    <a href="${dlUrl}" class="btn btn--secondary btn--sm" download="${escapeHtml(file.name)}">
                        下载
                    </a>
                </div>
            `;
        }).join('');
    }

    if (btnSelectShareFile) {
        btnSelectShareFile.addEventListener('click', async () => {
            if (fileInput) fileInput.click();
        });
    }

    if (btnClearShareFiles) {
        btnClearShareFiles.addEventListener('click', async () => {
            const ok = await window.showConfirmDialog(
                '清空分享',
                '确定要清空本机所有对外分享的文件吗？',
                '确认清空',
                '#EF4444'
            );
            if (!ok) return;
            try {
                await demandFiles.reset();
                const invoke = getTauriInvoke();
                if (invoke) {
                    await invoke('clear_share_files');
                } else {
                    await fetch(getApiOrigin() + '/api/files/clear', { method: 'POST', headers: authHeaders() });
                }
                showToast('已清空本机所有对外分享文件');
                loadLocalSharedFiles();
            } catch (e) {
                showToast(`清空失败: ${e.message || e}`);
            }
        });
    }

    if (btnRefreshLocalFiles) {
        btnRefreshLocalFiles.addEventListener('click', () => {
            loadLocalSharedFiles();
            showToast('已刷新本机分享文件');
        });
    }

    if (btnOpenDownloadFolder) {
        btnOpenDownloadFolder.addEventListener('click', async () => {
            const invoke = getTauriInvoke();
            if (invoke) {
                try {
                    const p = await invoke('open_download_folder');
                    showToast(`已打开保存目录: ${p}`);
                } catch (e) {
                    showToast(`打开目录失败: ${e.message || e}`);
                }
            } else {
                showToast('文件已保存在系统“下载/WenBox”文件夹，请在电脑文件管理器中打开');
            }
        });
    }

    if (btnRefreshReceivedFiles) {
        btnRefreshReceivedFiles.addEventListener('click', () => {
            loadReceivedFiles();
            showToast('已刷新已接收文件');
        });
    }

    if (btnRefreshRemoteFiles) {
        btnRefreshRemoteFiles.addEventListener('click', () => {
            loadFiles();
            showToast('已刷新对方文件列表');
        });
    }

    function escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }


    // 辅助：将 Blob 转为 Base64 字符串
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = reader.result.split(',')[1];
                resolve(base64String);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    let archiveCandidates = [];
    let archiveRevision = -1;
    const archiveSelection = new Set();
    const archiveChoices = document.getElementById('archiveFileChoices');
    function updateArchiveCount() { document.getElementById('archiveSelectionCount').textContent = `已选 ${archiveSelection.size} 个`; }
    async function refreshArchiveFiles() {
        const context = captureAttachmentContext();
        const revision = roomRevision;
        archiveChoices.textContent = '正在读取文件…';
        archiveCandidates = []; btnSelectReimburseDir.disabled = true;
        if (archiveRevision !== revision) archiveSelection.clear();
        archiveRevision = revision;
        try {
            const lists = await Promise.all(['/api/files', '/api/received_files'].map(async path => {
                const response = await fetchWithTimeout(context.base + path, { headers: authHeaders() });
                if (!response.ok) throw new Error(`读取文件失败：HTTP ${response.status}`);
                return (await response.json()).files || [];
            }));
            if (revision !== roomRevision) { archiveChoices.textContent = '房间已切换，请刷新'; return; }
            archiveCandidates = [...new Map(lists.flat().map(file => [file.id, { ...file, context }])).values()];
            const ids = new Set(archiveCandidates.map(f => f.id));
            for (const id of archiveSelection) if (!ids.has(id)) archiveSelection.delete(id);
            archiveChoices.replaceChildren();
            for (const file of archiveCandidates) {
                const label = document.createElement('label'); label.className = 'archive-file-choice';
                const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = archiveSelection.has(file.id);
                checkbox.addEventListener('change', () => { checkbox.checked ? archiveSelection.add(file.id) : archiveSelection.delete(file.id); updateArchiveCount(); });
                const name = document.createElement('span'); name.textContent = file.name; name.title = file.name;
                const size = document.createElement('small'); size.textContent = formatBytes(file.size);
                label.append(checkbox, name, size); archiveChoices.append(label);
            }
            if (!archiveCandidates.length) archiveChoices.textContent = '当前房间还没有文件';
            updateArchiveCount();
        } catch (error) { archiveChoices.textContent = '读取失败，请刷新重试'; showToast(error.message || String(error)); }
        finally { btnSelectReimburseDir.disabled = false; }
    }
    document.getElementById('roomArchive').addEventListener('toggle', event => { if (event.target.open) refreshArchiveFiles(); });
    document.getElementById('refreshArchiveFiles').addEventListener('click', refreshArchiveFiles);
    document.getElementById('selectAllArchive').addEventListener('click', () => {
        const select = archiveSelection.size !== archiveCandidates.length;
        archiveSelection.clear(); if (select) archiveCandidates.forEach(f => archiveSelection.add(f.id));
        archiveChoices.querySelectorAll('input').forEach(input => { input.checked = select; }); updateArchiveCount();
    });
    btnSelectReimburseDir.addEventListener('click', async () => {
        if (archiveRevision !== roomRevision) { await refreshArchiveFiles(); showToast('房间已切换，请重新选择文件'); return; }
        const files = archiveCandidates.filter(f => archiveSelection.has(f.id));
        const folder = archiveFolderName();
        if (!files.length) { showToast('请先勾选需要归档的文件'); return; }
        if (!folder || /[<>:"/\\|?*\x00-\x1f]/.test(folder) || /[. ]$/.test(folder) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)) {
            showToast('文件夹名称无效，请使用普通分类名称'); return;
        }
        btnSelectReimburseDir.disabled = true;
        const failures = []; let saved = 0;
        try {
            const invoke = getTauriInvoke();
            const dialog = getTauriDialog();
            let directory, handle;
            if (invoke && dialog) {
                directory = await dialog.open({ directory: true, multiple: false, title: '选择分类文件夹的上级目录' });
                if (!directory) return;
            } else if (window.showDirectoryPicker) {
                const root = await window.showDirectoryPicker({ mode: 'readwrite' });
                handle = await root.getDirectoryHandle(folder, { create: true });
            } else { showToast('当前浏览器无法选择归档目录，请使用 WenBox 桌面客户端'); return; }
            reimburseStatus.hidden = false;
            for (const file of files) {
                reimburseStatus.textContent = `正在归档 ${saved + failures.length + 1}/${files.length}：${file.name}`;
                try {
                    const url = resolveChatUrl('/api/download/' + encodeURIComponent(file.id), file.context);
                    if (directory) {
                        await invoke('save_remote_file_to_directory', { downloadUrl: url, dirPath: directory, folderName: folder, fileName: file.name, token: new URL(url).searchParams.get('token') });
                    } else {
                        const response = await fetchWithTimeout(url);
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const safe = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
                        let name = safe, index = 0;
                        while (true) { try { await handle.getFileHandle(name); name = `${++index}_${safe}`; } catch (e) { if (e.name === 'NotFoundError') break; throw e; } }
                        const target = await handle.getFileHandle(name, { create: true });
                        const writer = await target.createWritable();
                        try { await writer.write(await response.blob()); await writer.close(); } catch (e) { await writer.abort(); throw e; }
                    }
                    saved++; archiveSelection.delete(file.id);
                } catch (error) { failures.push(`${file.name}：${error.message || error}`); }
            }
            reimburseStatus.textContent = `已归档 ${saved}/${files.length} 个文件到 ${directory ? directory + '/' : ''}${folder}`;
            if (failures.length) showToast('归档失败（失败项保留勾选，可重试）：\n' + failures.join('\n'));
            else showToast(`已归档 ${saved} 个文件`);
            updateArchiveCount();
            archiveChoices.querySelectorAll('input').forEach((input, index) => { input.checked = archiveSelection.has(archiveCandidates[index]?.id); });
        } catch (error) { if (error.name !== 'AbortError') showToast(`归档失败：${error.message || error}`); }
        finally { btnSelectReimburseDir.disabled = false; }
    });

    async function uploadFiles(fileList, image = false, scope = 'chat') {
        if (roomState.mode === 'client') { showToast('请先创建或加入房间'); return; }
        const revision = roomRevision;
        try {
            const offers = await demandFiles.publish(fileList, scope);
            if (revision !== roomRevision) return;
            if (scope === 'chat') for (const file of offers) {
                const name = file.name.replace(/[|\[\]]/g, '_');
                if (!await sendChatMessageDirect(`[file:${name}|${formatBytes(file.size)} · 按需下载，发送方需在线|/api/download/${encodeURIComponent(file.id)}]`)) throw new Error('文件信息已发布，但消息发送失败');
            }
            showToast(`已分享 ${offers.length} 个文件，点击下载时才传输；请保持 WenBox 开启`);
            if (roomState.mode === 'host') loadLocalSharedFiles(); else loadFiles();
        } catch (error) { showToast(error.message || String(error)); }
        finally { if (fileInput) fileInput.value = ''; }
    }
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', event => uploadFiles(event.target.files, false, 'room'));
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            if (roomState.mode === 'host') {
                loadLocalSharedFiles();
                loadReceivedFiles();
                pollRoomMembers();
            } else if (roomState.mode === 'joined') {
                loadFiles();
            } else {
                pollDiscoveredRooms();
            }
            checkSelfServerStatus();
            showToast('已刷新数据');
        });
    }

    // 初始数据加载与定时轮询
    checkSelfServerStatus();

    // 检查 URL 是否带参扫码秒进 (如 ?room=xxx&pin=yyy)
    async function checkUrlAutoJoin() {
        const urlParams = new URLSearchParams(window.location.search);
        const qRoom = urlParams.get('room');
        const qPin = urlParams.get('pin') || '';
        if (qRoom) {
            // 通过直链进入的必定是访客身份，绝不能当作房主
            sessionStorage.removeItem('wenbox_host_token');
            setRoomMode('client');

            let needPassword = !!qPin;
            let hostDevice = '主机';
            let roomName = qRoom;
            try {
                const res = await fetch(getApiOrigin() + '/api/room/status?t=' + Date.now());
                if (res.ok) {
                    const st = await res.json();
                    if (st && st.isActive) {
                        needPassword = !!st.needPassword;
                        if (st.hostDevice) hostDevice = st.hostDevice;
                        if (st.roomName) roomName = st.roomName;
                    }
                }
            } catch (_) {}

            window.openJoinRoomDialog({
                hostUrl: window.location.origin,
                roomName: roomName,
                roomId: qRoom,
                hostDevice: hostDevice,
                needPassword: needPassword,
                pin: qPin
            });
            return true;
        }
        return false;
    }

    // 初始检查当前房间状态 (如果是 Tauri 主机已开房，恢复 host 模式；如果是外部浏览器，严禁被当成房主)
    async function initRoomState() {
        if (await checkUrlAutoJoin()) return;

        const invoke = getTauriInvoke();
        if (invoke) {
            try {
                const st = await invoke('get_room_status_cmd');
                if (st && st.isActive && st.isTauriHost) {
                    setRoomMode('host', st);
                    return;
                }
            } catch (e) {
                // ignore
            }
        } else {
            const savedHostToken = sessionStorage.getItem('wenbox_host_token');
            try {
                const res = await fetch(getApiOrigin() + '/api/room/status?t=' + Date.now(), {
                    headers: savedHostToken ? { 'X-Host-Token': savedHostToken } : {}
                });
                if (res.ok) {
                    const st = await res.json();
                    if (st && st.isActive) {
                        // 严格校验：只有服务端确认 X-Host-Token 属于当前活跃房间 (st.isHost === true)，才允许恢复为 host
                        if (savedHostToken && st.isHost === true) {
                            roomState.token = savedHostToken;
                            setRoomMode('host', st);
                            return;
                        }
                        // 否则当前浏览器为局域网外部访客！严禁赋予 host 权限，立即清除无效的 hostToken，停留在客户端发现大厅供自由选择加入
                        sessionStorage.removeItem('wenbox_host_token');
                        setRoomMode('client');
                        return;
                    } else {
                        // 房间未激活，清除无效的 hostToken
                        sessionStorage.removeItem('wenbox_host_token');
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        // 默认进入客户端发现大厅
        setRoomMode('client');
    }

    // Initialization runs after all module bindings and the upload queue are ready.

    scheduler.add('members', 2500, async () => {
        if (roomState.mode === 'host') await pollRoomMembers();
        else if (roomState.mode === 'joined') await pollJoinedMembers();
        if (currentActiveTab === 'view-rooms') await pollDiscoveredRooms();
    });
    scheduler.add('files', 2500, async () => {
        if (currentActiveTab !== 'view-room') return;
        if (roomState.mode === 'host') await Promise.all([loadLocalSharedFiles(), loadReceivedFiles()]);
        else if (roomState.mode === 'joined') await loadFiles();
    });
    scheduler.add('server', 6000, checkSelfServerStatus);
    scheduler.add('direct', 2500, autoConnectDirect);
    scheduler.add('interface', 1000, () => {
        updateJoinCooldown();
        if (roomState.mode === 'client' || discoveryOpen) {
            const loading = roomState.discoveredRooms.length === 0 && Date.now() - discoveryStartedAt < 3000;
            document.getElementById('roomDiscoverySkeleton').hidden = !loading;
            noRoomsDiscoveredPrompt.hidden = loading || roomState.discoveredRooms.length > 0;
        }
    });

    // ---------------- 模块二：局域网双向即时互发消息 / 聊天室 (需创建或加入房间后才可发送) ----------------

    const webChatMessages = document.getElementById('webChatMessages');
    const webEmptyChat = document.getElementById('webEmptyChat');
    const webChatMessageInput = document.getElementById('webChatMessageInput');
    const webBtnSendMessage = document.getElementById('webBtnSendMessage');
    const webBtnClearChat = document.getElementById('webBtnClearChat');

    const chatBtnSendImage = document.getElementById('chatBtnSendImage');
    const chatImageFileInput = document.getElementById('chatImageFileInput');
    const chatBtnSendFile = document.getElementById('chatBtnSendFile');
    const chatFileInput = document.getElementById('chatFileInput');
    const chatDropOverlay = document.getElementById('chatDropOverlay');

    const chatImageModal = document.getElementById('chatImageModal');
    const chatModalImage = document.getElementById('chatModalImage');
    const btnCloseChatImageModal = document.getElementById('btnCloseChatImageModal');
    const chatModalDownloadBtn = document.getElementById('chatModalDownloadBtn');
    const chatModalCopyBtn = document.getElementById('chatModalCopyBtn');

    let lastKnownMessageTimestamp = 0;
    const knownMessageIds = new Set();

    async function resetChatRoomHistory({ keepCursor = false } = {}) {
        if (webChatMessages) {
            webChatMessages.innerHTML = '';
            if (webEmptyChat) {
                webEmptyChat.hidden = false;
                webChatMessages.appendChild(webEmptyChat);
            }
        }
        outbox.clear();
        if (!keepCursor) { knownMessageIds.clear(); lastKnownMessageTimestamp = 0; chatHasSynced = false; }
    }

    const chatIdentity = window.WenBoxUI.createChatIdentity(localStorage, sessionStorage);
    const myClientId = chatIdentity.id;
    if (!chatIdentity.persistent) showToast('无法保存本机消息身份，重启后可能需要恢复历史消息显示');

    function refreshMessageAuthors() {
        let previous = null;
        for (const item of webChatMessages.querySelectorAll('.chat-item')) {
            const clientId = item.dataset.clientId;
            const mine = chatIdentity.owns(clientId) || item.dataset.legacyOwn === 'true';
            const sender = mine ? 'self:' + myClientId : clientId || item.dataset.legacySender;
            const current = { sender, mine, timestamp: item.dataset.timestamp };
            item.classList.toggle('is-me', mine);
            item.classList.toggle('grouped', window.WenBoxUI.sameMessageGroup(previous, current));
            item.dataset.sender = sender;
            const header = item.querySelector('.chat-item_user');
            header.classList.toggle('from-me', mine); header.classList.toggle('from-other', !mine);
            header.querySelector('.user-name').textContent = (mine ? '（我）' : '') + item.dataset.authorName;
            const restore = item.querySelector('.chat-identity-restore');
            if (restore) {
                restore.hidden = mine && !chatIdentity.restored(clientId);
                restore.dataset.action = chatIdentity.restored(clientId) ? 'unrestore-message-author' : 'restore-message-author';
                restore.textContent = chatIdentity.restored(clientId) ? '撤销恢复' : '这是我发的';
            }
            previous = current;
        }
    }
    function restoreMessageAuthor(clientId, undo = false) {
        try {
            if (undo) chatIdentity.unclaim(clientId); else chatIdentity.claim(clientId);
            refreshMessageAuthors();
            showToast(undo ? '已撤销历史消息的位置恢复' : '已恢复这台设备的历史消息位置，仅影响本机显示');
        } catch (error) { showToast('无法保存历史归属：' + error.message); }
    }

    function getClientSenderName() {
        const storedNick = localStorage.getItem('wenbox_nickname');
        if (storedNick && storedNick.trim()) {
            return storedNick.trim();
        }
        return whoami_device_name_client();
    }

    function updateChatGatingUi(mode, data) { updateChatStatusBar(mode, data); }

    let isPollingChat = false;

    // 轮询聊天消息
    const pollChatMessages = singleFlight(pollChatMessagesTask);
    async function pollChatMessagesTask() {
        if (isPollingChat) return;
        if (roomState.mode === 'client') return;
        isPollingChat = true;
        const revision = roomRevision;
        const fetch = fetchWithTimeout;
        try {
            let messages = [];
            const effectiveToken = roomState.token || sessionStorage.getItem('wenbox_host_token') || '';
            const tokenParam = effectiveToken ? `&token=${encodeURIComponent(effectiveToken)}` : '';
            const sinceParam = lastKnownMessageTimestamp > 0 ? `&since=${lastKnownMessageTimestamp - 1}` : '';
            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/messages?t=' + Date.now() + tokenParam + sinceParam;
            const headers = { 'Accept': 'application/json' };
            if (effectiveToken) {
                headers['X-Room-Token'] = effectiveToken;
                headers['X-Host-Token'] = effectiveToken;
            }
            const res = await fetch(api, {
                headers,
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(2000) : undefined
            });
            if (revision !== roomRevision) return;
            if (!res.ok) {
                if (roomState.mode === 'joined') {
                    updateRemoteConnection('retrying', '对端暂时不可用，正在重连；消息与文件记录已保留。');
                    if (res.status === 401 || res.status === 403) await resumeJoinedSession();
                }
                return;
            }
            const data = await res.json();
            if (revision !== roomRevision) return;
            // 房间一致性校验：若服务端活跃房间 ID 与当前界面所处的房间 ID 不一致，说明服务端已重置或新建房间！
            const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
            if (roomState.mode === 'joined' && (data.isActive === false || (data.roomId && currentRoomId && data.roomId !== currentRoomId))) {
                updateRemoteConnection('ended', '原房间已结束，记录保留。可手动退出后加入新房间。');
                return;
            }
            messages = data.messages || [];

            if (revision !== roomRevision) return;
            updateRemoteConnection('ready');
            chatHasSynced = true;

            const nearBottom = !webChatMessages || webChatMessages.scrollHeight - webChatMessages.scrollTop - webChatMessages.clientHeight < 80;
            const firstLoad = knownMessageIds.size === 0;
            const batch = document.createDocumentFragment();
            let hasNew = false;
            messages.forEach(msg => {
                if (!knownMessageIds.has(msg.id)) {
                    knownMessageIds.add(msg.id);
                    outbox.reconcile(msg, roomRevision)?.element?.remove();
                    renderChatMessage(msg, batch);
                    hasNew = true;
                    if (msg.timestamp > lastKnownMessageTimestamp) {
                        lastKnownMessageTimestamp = msg.timestamp;
                    }
                }
            });

            if (hasNew && webChatMessages) {
                webChatMessages.appendChild(batch);
                while (webChatMessages.querySelectorAll('.chat-item').length > 500) webChatMessages.querySelector('.chat-item').remove();
                while (knownMessageIds.size > 1000) knownMessageIds.delete(knownMessageIds.values().next().value);
                if (firstLoad || nearBottom) webChatMessages.scrollTop = webChatMessages.scrollHeight;
            }
        } catch (e) {
            if (revision === roomRevision && roomState.mode === 'joined') {
                updateRemoteConnection('retrying', '对端暂时不可用，正在重连；消息与文件记录已保留。');
            }
        } finally {
            isPollingChat = false;
        }
    }

    function formatTime(ts) {
        const d = new Date(ts);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    // escapeHtml 统一定义在文件上部（此处原有一份重复实现，已删除）

    function authHeaders() {
        const token = getEffectiveRoomToken();
        return token ? { 'X-Room-Token': token, ...(roomState.mode === 'host' ? { 'X-Host-Token': token } : {}) } : {};
    }

    function getEffectiveRoomToken() {
        return roomState.token || sessionStorage.getItem('wenbox_host_token') || '';
    }

    // 聊天图片只允许 data:image/、本房间的 /api/download/ 或当前房主 origin 下的图片。
    // 否则访客可以塞入任意 http(s) 地址，借别人的浏览器对内网地址发起 GET (轻度 SSRF/追踪)。
    function isSafeChatImageUrl(rawUrl) {
        if (!rawUrl) return false;
        const value = String(rawUrl).trim();
        if (/^data:image\//i.test(value)) return true;
        if (value.startsWith('/api/download/')) return true;
        if (!/^https?:\/\//i.test(value)) return false;
        try {
            const url = new URL(value);
            const base = currentTargetBaseUrl ? new URL(currentTargetBaseUrl) : null;
            if (base && url.host === base.host) return true;
            const own = new URL(getApiOrigin(), window.location.href);
            return url.host === own.host;
        } catch (_) {
            return false;
        }
    }

    function captureAttachmentContext() {
        return { base: currentTargetBaseUrl || getApiOrigin() || window.location.origin, token: getEffectiveRoomToken(), roomId: roomState.roomInfo?.roomId };
    }
    function resolveChatUrl(value, context = captureAttachmentContext()) {
        if (!value) return '';
        if (value.startsWith('data:')) return value;
        const base = context.base.replace(/\/+$/, '');
        try {
            const url = new URL(value, base + '/');
            const token = context.roomId === roomState.roomInfo?.roomId ? getEffectiveRoomToken() : context.token;
            if (token && url.origin === new URL(base).origin && url.pathname.startsWith('/api/download/')) {
                url.searchParams.set('token', token);
            }
            return url.href;
        } catch (_) { return ''; }
    }

    function getFileIconByExtension(name) {
        const ext = (name || '').split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
        if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'folder';
        if (['js', 'ts', 'rs', 'py', 'java', 'html', 'css', 'json', 'sql'].includes(ext)) return 'braces';
        return 'file';
    }

    // 格式化渲染富文本消息流 (融合 fagedongxi.com / internal-chat 极简流式排版与 WenBox 富媒体)
    function renderChatMessage(msg, target = webChatMessages) {
        if (!webChatMessages) return;
        if (webEmptyChat) webEmptyChat.hidden = true;

        const myName = getClientSenderName();
        const cleanSender = (msg.senderName || '').replace(/^[📱💻👑\s]+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (msg.isFromPhone ? '手机用户' : '成员');
        const isMe = (msg.clientId && chatIdentity.owns(msg.clientId))
            || (!msg.clientId && !msg.isFromPhone && (msg.senderName === myName || cleanSender === myName));

        // 整体条目: .chat-item (带悬停变色)
        const item = document.createElement('div');
        item.className = 'chat-item' + (isMe ? ' is-me' : '');
        const senderKey = isMe ? 'self:' + myClientId : msg.clientId || `${cleanSender}|${msg.senderIp || ''}`;
        item.dataset.clientId = msg.clientId || ''; item.dataset.authorName = cleanSender;
        item.dataset.legacyOwn = String(!msg.clientId && isMe); item.dataset.legacySender = `${cleanSender}|${msg.senderIp || ''}`;
        const previous = target.lastElementChild || webChatMessages.lastElementChild;
        if (window.WenBoxUI.sameMessageGroup(previous && { sender: previous.dataset.sender, mine: previous.classList.contains('is-me'), timestamp: previous.dataset.timestamp }, { sender: senderKey, mine: !!isMe, timestamp: msg.timestamp })) item.classList.add('grouped');
        item.dataset.sender = senderKey; item.dataset.timestamp = String(msg.timestamp);

        // 消息头: .chat-item_user (仅展示纯昵称，不展示不准确的设备图标与IP)
        let senderTitle = cleanSender;
        if (isMe) {
            senderTitle = `（我）${senderTitle}`;
        }

        const userHeader = document.createElement('div');
        userHeader.className = `chat-item_user ${isMe ? 'from-me' : 'from-other'}`;

        const avatar = window.WenBoxUI.avatar(cleanSender);
        const avatarSpan = document.createElement('span'); avatarSpan.className = 'chat-avatar';
        avatarSpan.dataset.tone = String(avatar.tone); avatarSpan.textContent = avatar.initial; avatarSpan.setAttribute('aria-hidden', 'true');
        userHeader.appendChild(avatarSpan);

        const senderSpan = document.createElement('span');
        senderSpan.className = 'user-name';
        senderSpan.textContent = senderTitle;
        userHeader.appendChild(senderSpan);

        if (msg.senderIp) {
            const ipSpan = document.createElement('span');
            ipSpan.className = 'chat-item_ip';
            ipSpan.textContent = msg.senderIp;
            userHeader.appendChild(ipSpan);
        }

        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-item_time';
        timeSpan.textContent = formatTime(msg.timestamp);
        userHeader.appendChild(timeSpan);
        let ownershipButton = null;
        if (chatIdentity.restored(msg.clientId) || (chatIdentity.canRestore(msg.clientId) && (cleanSender === myName || msg.senderName === myName))) {
            const restore = document.createElement('button'); restore.type = 'button';
            restore.className = 'chat-identity-restore'; restore.dataset.value = msg.clientId;
            restore.dataset.action = chatIdentity.restored(msg.clientId) ? 'unrestore-message-author' : 'restore-message-author';
            restore.textContent = chatIdentity.restored(msg.clientId) ? '撤销恢复' : '这是我发的';
            restore.title = '仅调整本机显示，不修改房间消息内容'; ownershipButton = restore;
        }


        // 消息内容与复制按钮容器: .chat-item_content
        const contentWrap = document.createElement('div');
        contentWrap.className = 'chat-item_content';

        const content = msg.content || '';

        // 1. 判断是否为图片消息
        const rawImagePayload = (content.startsWith('[image:') && content.endsWith(']'))
            ? content.slice(7, -1)
            : content;
        const imageAllowed = (content.startsWith('[image:') && content.endsWith(']'))
            ? isSafeChatImageUrl(rawImagePayload)
            : true;
        const isImage = imageAllowed && (content.startsWith('[image:') && content.endsWith(']'))
            || content.startsWith('data:image/')
            || (isSafeChatImageUrl(content) && /^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|bmp|svg)(\?[^\s]*)?$/i.test(content));

        if (isImage) {
            const attachmentContext = captureAttachmentContext();
            let imgSrc = content;
            if (content.startsWith('[image:') && content.endsWith(']')) {
                imgSrc = content.slice(7, -1);
            }
            const rawImageUrl = imgSrc;
            imgSrc = resolveChatUrl(rawImageUrl, attachmentContext);

            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'chat-img-thumb-wrapper';
            thumbWrap.title = '点击查看大图';

            const img = document.createElement('img');
            img.className = 'chat-img-thumb';
            img.alt = '聊天图片';
            img.loading = 'lazy';
            img.saveOriginal = () => {
                openChatImageModal(img.src, resolveChatUrl(rawImageUrl, attachmentContext), attachmentContext);
                chatModalDownloadBtn.click();
            };

            const overlay = document.createElement('span');
            overlay.className = 'chat-img-overlay';
            overlay.textContent = '加载中…';
            let imageFailed = false;
            const loadImage = async (manual = false) => {
                imgSrc = resolveChatUrl(rawImageUrl, attachmentContext);
                thumbWrap.dataset.state = 'loading';
                imageFailed = false; overlay.textContent = '加载中…';
                try { img.src = await resolveRequestUrl(imgSrc); }
                catch (error) { imageFailed = true; thumbWrap.dataset.state = 'error'; overlay.textContent = '加载失败，点击重试'; thumbWrap.title = String(error.message || error); if (manual) showToast(`图片加载失败：${error.message || error}`); }
            };
            img.addEventListener('load', () => { thumbWrap.dataset.state = 'ready'; imageFailed = false; overlay.textContent = '查看原图'; thumbWrap.title = '点击查看大图'; });
            img.addEventListener('error', () => { thumbWrap.dataset.state = 'error'; imageFailed = true; overlay.textContent = '加载失败，点击重试'; });
            thumbWrap.retryImage = () => loadImage();
            loadImage();

            thumbWrap.appendChild(img);
            thumbWrap.appendChild(overlay);
            thumbWrap.addEventListener('click', (e) => {
                e.stopPropagation();
                if (imageFailed) loadImage(true);
                else openChatImageModal(img.src, imgSrc, attachmentContext);
            });

            contentWrap.appendChild(thumbWrap);
            if (getTauriInvoke() && /^https?:/.test(imgSrc) && new URL(imgSrc).pathname.startsWith('/api/download/')) {
                const save = document.createElement('button');
                save.type = 'button'; save.className = 'btn btn--ghost btn--sm'; save.textContent = '保存图片';
                save.addEventListener('click', () => {
                    const type = /^data:image\/([a-z0-9.+-]+)/i.exec(img.src)?.[1];
                    const ext = type === 'jpeg' ? 'jpg' : (type || 'png');
                    window.downloadRemoteFile(decodeURIComponent(new URL(imgSrc).pathname.slice('/api/download/'.length)), `wenbox_img_${Date.now()}.${ext}`, attachmentContext);
                });
                contentWrap.appendChild(save);
            }
        }
        // 2. 判断是否为文件卡片消息 [file:name|size|url]
        else if (content.startsWith('[file:') && content.endsWith(']')) {
            const inner = content.slice(6, -1);
            const parts = inner.split('|');
            const fileName = parts[0] || '未知文件';
            const fileSize = parts[1] || '';
            const rawUrl = parts[2] || '';
            const attachmentContext = captureAttachmentContext();
            const downloadUrl = isSafeChatImageUrl(rawUrl) && !/^data:/i.test(rawUrl) ? resolveChatUrl(rawUrl, attachmentContext) : '';

            const fileCard = document.createElement('div');
            fileCard.className = 'chat-file-card';

            const fileIcon = document.createElement('div');
            fileIcon.className = 'chat-file-icon';
            fileIcon.innerHTML = iconMarkup(getFileIconByExtension(fileName));

            const fileDetails = document.createElement('div');
            fileDetails.className = 'chat-file-details';

            const nameEl = document.createElement('div');
            nameEl.className = 'chat-file-name';
            nameEl.textContent = fileName;
            nameEl.title = fileName;

            const sizeEl = document.createElement('div');
            sizeEl.className = 'chat-file-size';
            sizeEl.textContent = fileSize ? `大小: ${fileSize}` : '局域网分享文件';

            fileDetails.appendChild(nameEl);
            fileDetails.appendChild(sizeEl);

            const downloadLink = document.createElement('a');
            downloadLink.className = 'chat-file-download-btn';
            downloadLink.href = downloadUrl || '#';
            downloadLink.download = fileName;
            downloadLink.target = '_blank';
            downloadLink.rel = 'noopener noreferrer';
            downloadLink.referrerPolicy = 'no-referrer';
            downloadLink.innerHTML = '⬇ 下载';
            downloadLink.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadLink.href = resolveChatUrl(rawUrl, attachmentContext) || '#';
                if (!downloadUrl) { e.preventDefault(); showToast('文件地址无效或不属于当前房间'); return; }
                if (getTauriInvoke() && isSafeChatImageUrl(rawUrl) && new URL(downloadUrl).pathname.startsWith('/api/download/')) {
                    e.preventDefault();
                    window.downloadRemoteFile(decodeURIComponent(new URL(downloadUrl).pathname.slice('/api/download/'.length)), fileName, attachmentContext);
                }
            });

            fileCard.appendChild(fileIcon);
            fileCard.appendChild(fileDetails);
            fileCard.appendChild(downloadLink);

            contentWrap.appendChild(fileCard);
        }
        // 3. 普通文本消息：格式化 Markdown 代码块、行内代码与链接识别，并置于 pre 中
        else {
            const preEl = document.createElement('div');
            preEl.className = 'chat-text';

            // 代码块占位替换，防止与普通标签冲突
            const codeBlocks = [];
            let processed = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
                const idx = codeBlocks.length;
                codeBlocks.push({ lang: lang || 'CODE', code: code.replace(/\n$/, '') });
                return `__CODE_BLOCK_${idx}__`;
            });

            // HTML 转义
            processed = escapeHtml(processed);

            // 行内代码识别 `code`
            processed = processed.replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');

            // URL 超链接自动识别
            // referrerpolicy="no-referrer"：房间令牌可能出现在 /api/ 链接里，
            // 不能让 Referer 把它带到外部站点或浏览器历史。
            processed = processed.replace(
                /(https?:\/\/[^\s<]+)/g,
                '<a href="$1" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" class="chat-link">$1 ↗</a>'
            );

            // 还原并渲染代码块
            codeBlocks.forEach((itemBlock, idx) => {
                const placeholder = `__CODE_BLOCK_${idx}__`;
                const escapedCode = escapeHtml(itemBlock.code);
                const blockHtml = `<div class="chat-code-block"><div class="chat-code-header"><span>${escapeHtml(itemBlock.lang.toUpperCase())}</span><button type="button" class="btn btn--ghost btn--sm" data-action="copy-code">复制代码</button></div><pre class="chat-code-content"><code>${escapedCode}</code></pre></div>`;
                processed = processed.replace(placeholder, blockHtml);
            });

            preEl.innerHTML = processed;
            contentWrap.appendChild(preEl);
        }

        // 右侧极简 SVG 悬停复制按钮 (fagedongxi.com 标志性设计)
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'copy-btn';
        copyBtn.title = '复制消息内容';
        copyBtn.setAttribute('aria-label', '复制消息内容');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="17" height="17">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"></path>
            </svg>
        `;
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isImage) { copyImage(contentWrap.querySelector('img').src, copyBtn); }
            else window.copyChatMessage(content, copyBtn);
        });
        contentWrap.appendChild(copyBtn);

        item.appendChild(userHeader);
        item.appendChild(contentWrap);
        if (ownershipButton) item.appendChild(ownershipButton);
        target.appendChild(item);
        return item;
    }

    // 全局复制消息辅助函数
    window.copyChatMessage = async function(text, btn) {
        if (!text) return;
        let copyText = text;
        if (text.startsWith('[file:') && text.endsWith(']')) {
            const inner = text.slice(6, -1);
            const parts = inner.split('|');
            const fileName = parts[0] || '';
            const rawUrl = parts[2] || '';
            copyText = `${fileName} - ${resolveChatUrl(rawUrl)}`;
        } else if ((text.startsWith('[image:') && text.endsWith(']')) || text.startsWith('data:image/')) {
            try { await copyImage(await resolveRequestUrl(resolveChatUrl(text.startsWith('[image:') ? text.slice(7, -1) : text)), btn); }
            catch (error) { showToast(`复制图片失败：${error.message || error}`); }
            return;
        }

        if (await copyWithFeedback(copyText, '消息已复制')) {
            markCopied(btn, '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>');
        }
    };

    window.copyChatCode = async function(btn) {
        const codeEl = btn.closest('.chat-code-block')?.querySelector('code');
        if (codeEl && await copyWithFeedback(codeEl.textContent, '代码已复制')) {
            markCopied(btn, '已复制');
        }
    };

    function renderDelivery(entry) {
        if (!entry.element?.isConnected) return;
        entry.element.dataset.delivery = entry.status;
        let status = entry.element.querySelector('.chat-delivery');
        if (!status) {
            status = document.createElement('div'); status.className = 'chat-delivery';
            status.setAttribute('role', 'status'); entry.element.appendChild(status);
        }
        status.replaceChildren();
        const text = document.createElement('span');
        text.textContent = ['sending', 'checking'].includes(entry.status) ? '发送中…' : entry.status === 'sent' ? '已发送' : '未确认送达';
        status.appendChild(text);
        if (entry.status === 'failed') {
            const button = document.createElement('button'); button.type = 'button';
            button.className = 'btn btn--ghost btn--sm'; button.textContent = '重试';
            button.dataset.action = 'retry-message'; button.dataset.value = entry.id;
            button.title = '网络中断时消息可能已经送达，重试可能重复发送';
            status.appendChild(button);
        }
    }

    async function transmitMessage(entry) {
        if (entry.revision !== roomRevision || !outbox.get(entry.id)) return;
        entry.status = 'sending'; renderDelivery(entry);
        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                await invoke('send_node_message', {
                    baseUrl: entry.baseUrl, senderName: entry.senderName, content: entry.content,
                    token: entry.token || null, clientId: entry.clientId, senderIp: entry.senderIp
                });
            } else {
                const headers = { 'Content-Type': 'application/json; charset=utf-8' };
                if (entry.token) { headers['X-Room-Token'] = entry.token; headers['X-Host-Token'] = entry.token; }
                const resp = await fetchWithTimeout((entry.baseUrl || getApiOrigin()) + '/api/messages', {
                    method: 'POST', headers,
                    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
                    body: JSON.stringify({ content: entry.content, senderName: entry.senderName, clientId: entry.clientId, senderIp: entry.senderIp || undefined })
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const result = await resp.json();
                if (result.success === false) throw new Error(result.message || '发送失败');
            }
            if (entry.revision !== roomRevision || !outbox.get(entry.id)) return;
            entry.status = 'sent'; renderDelivery(entry);
            await pollChatMessages();
        } catch (_) {
            if (entry.revision !== roomRevision || !outbox.get(entry.id)) return;
            entry.status = 'failed'; renderDelivery(entry);
        }
    }

    async function retryMessage(id) {
        const entry = outbox.get(id);
        if (!entry || entry.status !== 'failed' || entry.revision !== roomRevision) return;
        // Reconcile a possibly delivered request before explicitly retrying it.
        entry.status = 'checking'; renderDelivery(entry);
        await pollChatMessages();
        if (entry.revision === roomRevision && outbox.get(id)) await transmitMessage(entry);
    }

    // A true result means the message is in the visible outbox. Delivery failures keep their own retry action.
    async function sendChatMessageDirect(text) {
        if (!text?.trim() || roomState.mode === 'client') return false;
        const revision = roomRevision;
        if (!chatHasSynced) await pollChatMessages();
        if (revision !== roomRevision || roomState.mode === 'client') return false;
        if (!chatHasSynced) { showToast('暂时无法同步聊天，请检查连接后重试'); return false; }
        const entry = outbox.add(text.trim(), myClientId, revision);
        Object.assign(entry, {
            baseUrl: currentTargetBaseUrl,
            token: roomState.token || sessionStorage.getItem('wenbox_host_token') || '',
            senderName: getClientSenderName(), senderIp: roomState.mode === 'host' ? selfDeviceInfo.ip || null : null
        });
        entry.element = renderChatMessage({ ...entry, timestamp: Date.now() });
        renderDelivery(entry);
        webChatMessages.scrollTop = webChatMessages.scrollHeight;
        void transmitMessage(entry);
        return true;
    }

    // 发送输入框中的消息
    let isSendingChat = false;
    async function sendChatMessage() {
        if (!webChatMessageInput || isSendingChat) return;
        const draft = webChatMessageInput.value;
        if (!draft.trim()) return;
        isSendingChat = true;
        if (webBtnSendMessage) {
            webBtnSendMessage.disabled = true;
            webBtnSendMessage.setAttribute('aria-busy', 'true');
        }
        try {
            const sent = await sendChatMessageDirect(draft);
            if (sent && webChatMessageInput.value === draft) {
                webChatMessageInput.value = '';
                webChatMessageInput.style.height = 'auto';
            }
        } finally {
            isSendingChat = false;
            if (webBtnSendMessage) {
                webBtnSendMessage.disabled = false;
                webBtnSendMessage.removeAttribute('aria-busy');
            }
        }
    }

    // 发送图片文件 (截图或选择的图片)
    async function sendChatImageFile(file) { if (file) uploadFiles([file], true); }
    async function sendChatDocFile(file) { if (file) uploadFiles([file]); }

    // 图片全屏预览 Modal
    function openChatImageModal(src, original = src, context = captureAttachmentContext()) {
        if (!chatImageModal || !chatModalImage) return;
        chatModalImage.src = src;
        if (chatModalDownloadBtn) {
            chatModalDownloadBtn.href = src;
            chatModalDownloadBtn.onclick = async event => {
                event.preventDefault();
                try {
                    const url = new URL(original, context.base + '/');
                    if (url.pathname.startsWith('/api/download/')) {
                        await window.downloadRemoteFile(decodeURIComponent(url.pathname.slice('/api/download/'.length)), chatModalDownloadBtn.download, context);
                    } else if (getTauriInvoke() && getTauriDialog()) {
                        const path = await getTauriDialog().save({ defaultPath: chatModalDownloadBtn.download, title: '保存原图' });
                        if (!path) return;
                        let bytes;
                        if (src.startsWith('data:')) {
                            const comma = src.indexOf(',');
                            bytes = src.slice(0, comma).includes(';base64') ? src.slice(comma + 1) : await blobToBase64(new Blob([decodeURIComponent(src.slice(comma + 1))]));
                        } else {
                            const response = await fetchWithTimeout(original);
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            bytes = await blobToBase64(await response.blob());
                        }
                        const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                        await getTauriInvoke()('save_file_to_directory', { dirPath: path.slice(0, split), folderName: '', fileName: path.slice(split + 1), bytesBase64: bytes });
                        showToast('原图已保存');
                    } else { const link = document.createElement('a'); link.href = src; link.download = chatModalDownloadBtn.download; link.click(); }
                } catch (error) { showToast(`保存原图失败：${error.message || error}`); }
            };
            let ext = 'png';
            const mimeMatch = /data:image\/([a-z0-9.+-]+)[;,]/i.exec(src || '');
            if (mimeMatch) {
                ext = mimeMatch[1].toLowerCase();
                if (ext === 'jpeg') ext = 'jpg';
            } else {
                const urlMatch = /\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.exec(src || '');
                if (urlMatch) ext = urlMatch[1].toLowerCase().replace('jpeg', 'jpg');
            }
            chatModalDownloadBtn.download = `wenbox_img_${Date.now()}.${ext}`;
        }
        openModal(chatImageModal);
    }

    function closeChatImageModal() {
        if (chatImageModal) closeModal(chatImageModal);
        if (chatModalImage) chatModalImage.src = '';
    }

    if (btnCloseChatImageModal) {
        btnCloseChatImageModal.addEventListener('click', closeChatImageModal);
    }
    if (chatImageModal) {
        chatImageModal.addEventListener('click', (e) => {
            if (e.target === chatImageModal) closeChatImageModal();
        });
    }
    async function copyImage(src, button) {
        if (!src) { showToast('图片尚未加载，请重试'); return; }
        try {
            const png = (async () => {
                const image = new Image(); image.crossOrigin = 'anonymous'; image.src = src;
                await image.decode();
                if (image.naturalWidth * image.naturalHeight > 32000000) throw new Error('图片过大，请保存原图');
                const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
                if (getTauriInvoke()) {
                    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    const base64 = await blobToBase64(new Blob([rgba]));
                    await getTauriInvoke()('copy_image', { width: canvas.width, height: canvas.height, rgbaBase64: base64 });
                    return null;
                }
                return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败')), 'image/png'));
            })();
            if (getTauriInvoke()) await png;
            else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            showToast('图片已复制到系统剪贴板'); if (button) markCopied(button, '已复制');
        } catch (error) { showToast(`复制图片失败：${error.message || error}`); }
    }
    if (chatModalCopyBtn) chatModalCopyBtn.addEventListener('click', () => copyImage(chatModalImage.src));

    // Localized context actions use the same image and file paths as the visible toolbar.
    const contextMenu = document.createElement('div');
    contextMenu.id = 'wenboxContextMenu'; contextMenu.className = 'wenbox-context-menu';
    contextMenu.setAttribute('role', 'menu'); contextMenu.hidden = true;
    document.body.appendChild(contextMenu);
    let contextTrigger;
    function closeContextMenu(restore = false) {
        contextMenu.hidden = true;
        if (restore) contextTrigger?.focus?.();
    }
    document.addEventListener('contextmenu', event => {
        event.preventDefault();
        const target = event.target;
        contextTrigger = target;
        const input = target.closest('textarea, input');
        const editable = input && typeof input.selectionStart === 'number';
        const start = editable ? input.selectionStart : 0, end = editable ? input.selectionEnd : 0;
        const selected = editable ? input.value.slice(start, end) : String(window.getSelection());
        const image = target.closest('.chat-img-thumb, #chatModalImage');
        contextMenu.replaceChildren();
        function action(label, run, enabled = true) {
            const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
            button.textContent = label; button.disabled = !enabled;
            button.addEventListener('click', async () => {
                closeContextMenu();
                try { await run(); } catch (error) { showToast(`操作失败：${error.message || error}`); }
            });
            contextMenu.appendChild(button);
        }
        if (image) {
            action('复制图片', () => copyImage(image.src));
            action('保存原图', () => {
                if (image.id === 'chatModalImage') chatModalDownloadBtn.click();
                else image.saveOriginal?.();
            });
        } else {
            action('复制', () => copyWithFeedback(selected), !!selected);
            if (editable && !input.readOnly && !input.disabled) {
                action('剪切', async () => { await copyText(selected); input.focus(); input.setRangeText('', start, end, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }, !!selected);
                action('粘贴', async () => {
                    input.focus();
                    if (input === webChatMessageInput && getTauriInvoke()) {
                        const files = await window.WenBox.clipboardFiles();
                        if (files.length) { uploadFiles(files); return; }
                        const image = await getTauriInvoke()('clipboard_image');
                        if (image) {
                            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                            const rgba = Uint8ClampedArray.from(atob(image.rgbaBase64), c => c.charCodeAt(0));
                            canvas.getContext('2d').putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
                            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                            if (!blob) throw new Error('读取剪贴板图片失败');
                            uploadFiles([new File([blob], '粘贴图片.png', { type: 'image/png' })], true); return;
                        }
                    }
                    const native = window.__TAURI__?.clipboard;
                    const text = native?.readText ? await native.readText() : await navigator.clipboard.readText();
                    input.setRangeText(text || '', start, end, 'end'); input.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
            action('全选', () => {
                if (editable) { input.focus(); input.select(); }
                else { const range = document.createRange(); range.selectNodeContents(target.closest('.chat-item, .toast-message, pre') || target); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
            });
        }
        (target.closest('dialog[open]') || document.body).appendChild(contextMenu);
        contextMenu.hidden = false;
        contextMenu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - 190)) + 'px';
        contextMenu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - contextMenu.offsetHeight - 8)) + 'px';
        contextMenu.querySelector('button:not(:disabled)')?.focus();
    });
    document.addEventListener('pointerdown', event => { if (!contextMenu.contains(event.target)) closeContextMenu(); }, true);
    document.addEventListener('scroll', () => closeContextMenu(), true);
    window.addEventListener('blur', () => closeContextMenu());
    document.addEventListener('keydown', event => {
        if (contextMenu.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu(true); }
        else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const items = [...contextMenu.querySelectorAll('button:not(:disabled)')];
            const next = (items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        } else if (event.key === 'Tab') closeContextMenu();
    }, true);

    // 快捷工具栏按钮绑定
    if (chatBtnSendImage && chatImageFileInput) {
        chatBtnSendImage.addEventListener('click', () => {
            chatImageFileInput.click();
        });
        chatImageFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) sendChatImageFile(file);
            chatImageFileInput.value = '';
        });
    }

    if (chatBtnSendFile && chatFileInput) {
        chatBtnSendFile.addEventListener('click', () => {
            chatFileInput.click();
        });
        chatFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) sendChatDocFile(file);
            chatFileInput.value = '';
        });
    }

    // 输入框按键监听：Enter 发送，Shift+Enter 换行
    if (webChatMessageInput) {
        webChatMessageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    sendChatMessage();
                }
            }
        });

        // Prefer real browser files; Finder/Explorer file lists need native clipboard access.
        webChatMessageInput.addEventListener('paste', async (event) => {
            const clipboard = event.clipboardData;
            if (!clipboard) return;
            const files = Array.from(clipboard.files || []);
            if (!files.length) {
                for (const item of Array.from(clipboard.items || [])) {
                    if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
                }
            }
            if (files.length) { event.preventDefault(); uploadFiles(files); return; }
            if (!window.WenBox.needsNativeTransport()) return;
            // Stop the default filename insertion before awaiting native clipboard results.
            event.preventDefault();
            const text = clipboard.getData('text/plain');
            const value = webChatMessageInput.value;
            const start = webChatMessageInput.selectionStart, end = webChatMessageInput.selectionEnd;
            try {
                const nativeFiles = await window.WenBox.clipboardFiles();
                if (nativeFiles.length) { uploadFiles(nativeFiles); return; }
                if (text) {
                    const unchanged = webChatMessageInput.value === value;
                    webChatMessageInput.setRangeText(text, unchanged ? start : webChatMessageInput.selectionStart, unchanged ? end : webChatMessageInput.selectionEnd, 'end');
                    webChatMessageInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } catch (error) { showToast(`粘贴失败：${error.message || error}；可改用选择文件`); }
        });
    }

    if (webBtnSendMessage) {
        webBtnSendMessage.addEventListener('click', sendChatMessage);
    }

    if (webBtnClearChat) {
        webBtnClearChat.addEventListener('click', async () => {
            await resetChatRoomHistory({ keepCursor: true });
            showToast('已清空当前聊天记录');
        });
    }

    uploadQueue = window.WenBox.createUploadQueue({
        container: document.getElementById('uploadQueue'), history: document.getElementById('sentUploadList'), count: document.getElementById('sentUploadCount'),
        sendNative: window.WenBox.needsNativeTransport() ? window.WenBox.nativeUpload : null,
        onComplete: async (result, file, context) => {
            if (context.revision !== roomRevision) return;
            const url = `/api/download/${encodeURIComponent(result.fileId || result.id)}`;
            // Escape the card delimiter in file names; preserve a readable name in the queue.
            const name = file.name.replace(/[|\[\]]/g, '_');
            const content = context.image ? `[image:${url}]` : `[file:${name}|${formatBytes(file.size)}|${url}]`;
            if (!await sendChatMessageDirect(content)) throw new Error('消息发送失败');
            if (roomState.mode === 'host') loadReceivedFiles();
        }
    });
    demandFiles = window.WenBoxDemandFiles.create({ fetch: fetchWithTimeout, context: captureAttachmentContext, sender: getClientSenderName, nativeUpload: window.WenBox.needsNativeTransport() ? window.WenBox.nativeUpload : null, error: e => showToast(e.message) });
    function dropScope(target) {
        if (currentActiveTab !== 'view-room' || roomState.mode === 'client') return null;
        if (target.closest('#filePanel, #dropZone')) return 'room';
        if (target.closest('#chatPanel, #chatActiveContent, .chat-composer')) return 'chat';
        return null;
    }
    document.addEventListener('dragover', event => {
        if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
        event.preventDefault();
        const scope = dropScope(event.target);
        event.dataTransfer.dropEffect = scope ? 'copy' : 'none';
        for (const panel of document.querySelectorAll('#filePanel, #chatActiveContent')) panel.classList.toggle('file-drag-target', !!scope && panel.contains(event.target));
    });
    function clearDrag() { chatDropOverlay.hidden = true; document.querySelectorAll('.file-drag-target').forEach(el => el.classList.remove('file-drag-target')); }
    document.addEventListener('dragleave', event => { if (!event.relatedTarget) clearDrag(); });
    document.addEventListener('drop', event => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault(); clearDrag();
        const scope = dropScope(event.target);
        if (scope) uploadFiles(event.dataTransfer.files, false, scope);
        else showToast('请将文件拖到房间文件区或聊天区');
    });
    window.addEventListener('blur', clearDrag);
    scheduler.add('messages', 2000, async () => {
        if (currentActiveTab === 'view-room') await pollChatMessages();
    });

    // ---------------- 模块三：JSON 格式化与校验 ----------------
    const webJsonInput = document.getElementById('webJsonInput');
    const webJsonError = document.getElementById('webJsonError');
    const webBtnFormatJson2 = document.getElementById('webBtnFormatJson2');
    const webBtnFormatJson4 = document.getElementById('webBtnFormatJson4');
    const webBtnMinifyJson = document.getElementById('webBtnMinifyJson');
    const webBtnLoadSampleJson = document.getElementById('webBtnLoadSampleJson');
    const webBtnCopyJson = document.getElementById('webBtnCopyJson');
    const webBtnClearJson = document.getElementById('webBtnClearJson');

    const SAMPLE_JSON = `{
  "appName": "WenBox",
  "version": "1.0.0",
  "author": "Wendel",
  "port": 9527,
  "features": [
    "LanPeerToPeerTransfer",
    "ReimbursementDirectSave",
    "LanMultiDeviceChat",
    "UdpNodeDiscovery",
    "JsonToolbox",
    "HexConverter",
    "CronStudio"
  ],
  "compatiblePlatforms": ["Android", "Windows", "macOS"],
  "status": "ready"
}`;

    function formatJson(indent) {
        if (!webJsonInput) return;
        const text = webJsonInput.value.trim();
        if (!text) return;

        try {
            const obj = JSON.parse(text);
            webJsonInput.value = JSON.stringify(obj, null, indent);
            if (webJsonError) webJsonError.hidden = true;
            showToast('格式化成功');
        } catch (e) {
            if (webJsonError) {
                webJsonError.hidden = false;
                webJsonError.textContent = ` JSON 格式错误: ${e.message}`;
            }
        }
    }

    function minifyJson() {
        if (!webJsonInput) return;
        const text = webJsonInput.value.trim();
        if (!text) return;

        try {
            const obj = JSON.parse(text);
            webJsonInput.value = JSON.stringify(obj);
            if (webJsonError) webJsonError.hidden = true;
            showToast('已精简为单行');
        } catch (e) {
            if (webJsonError) {
                webJsonError.hidden = false;
                webJsonError.textContent = ` JSON 格式错误: ${e.message}`;
            }
        }
    }

    if (webBtnFormatJson2) webBtnFormatJson2.addEventListener('click', () => formatJson(2));
    if (webBtnFormatJson4) webBtnFormatJson4.addEventListener('click', () => formatJson(4));
    if (webBtnMinifyJson) webBtnMinifyJson.addEventListener('click', minifyJson);
    if (webBtnLoadSampleJson) {
        webBtnLoadSampleJson.addEventListener('click', () => {
            if (webJsonInput) webJsonInput.value = SAMPLE_JSON;
            if (webJsonError) webJsonError.hidden = true;
            showToast('已载入示例 JSON');
        });
    }
    if (webBtnCopyJson) {
        webBtnCopyJson.addEventListener('click', () => {
            if (webJsonInput && webJsonInput.value) {
                copyWithFeedback(webJsonInput.value, '已复制 JSON 内容');
            }
        });
    }
    if (webBtnClearJson) {
        webBtnClearJson.addEventListener('click', () => {
            if (webJsonInput) webJsonInput.value = '';
            if (webJsonError) webJsonError.hidden = true;
        });
    }

    if (webJsonInput && !webJsonInput.value) {
        webJsonInput.value = SAMPLE_JSON;
    }


    // ---------------- 模块四：网页端多进制实时互转 ----------------
    const webHex = document.getElementById('webHex');
    const webDec = document.getElementById('webDec');
    const webBin = document.getElementById('webBin');
    const webOct = document.getElementById('webOct');
    const webAscii = document.getElementById('webAscii');
    const webBtnClearConverter = document.getElementById('webBtnClearConverter');

    let isConverterUpdating = false;

    function cleanHex(str) {
        return str.replace(/0x/gi, '').replace(/[\s,\-_]/g, '').toUpperCase();
    }

    function updateAllFromBigInt(num, skipField) {
        isConverterUpdating = true;
        try {
            if (skipField !== 'hex') {
                const h = num.toString(16).toUpperCase();
                const padH = h.length % 2 !== 0 ? '0' + h : h;
                webHex.value = padH.match(/.{1,2}/g)?.join(' ') || padH;
            }
            if (skipField !== 'dec') {
                webDec.value = num.toString(10);
            }
            if (skipField !== 'bin') {
                const b = num.toString(2);
                const padLen = Math.ceil(b.length / 4) * 4;
                const padB = b.padStart(padLen, '0');
                webBin.value = padB.match(/.{1,4}/g)?.join(' ') || padB;
            }
            if (skipField !== 'oct') {
                webOct.value = num.toString(8);
            }
            if (skipField !== 'ascii') {
                const h = num.toString(16);
                const clean = h.length % 2 !== 0 ? '0' + h : h;
                let asciiStr = '';
                for (let i = 0; i < clean.length; i += 2) {
                    const code = parseInt(clean.substr(i, 2), 16);
                    asciiStr += String.fromCharCode(code);
                }
                webAscii.value = asciiStr;
            }
        } catch (e) {
            // ignore
        }
        isConverterUpdating = false;
    }

    function clearConverterFields(skipField) {
        isConverterUpdating = true;
        if (skipField !== 'hex' && webHex) webHex.value = '';
        if (skipField !== 'dec' && webDec) webDec.value = '';
        if (skipField !== 'bin' && webBin) webBin.value = '';
        if (skipField !== 'oct' && webOct) webOct.value = '';
        if (skipField !== 'ascii' && webAscii) webAscii.value = '';
        isConverterUpdating = false;
    }

    if (webHex) {
        webHex.addEventListener('input', (e) => {
            if (isConverterUpdating) return;
            const clean = cleanHex(e.target.value);
            if (!clean) return clearConverterFields('hex');
            try {
                const num = BigInt('0x' + clean);
                updateAllFromBigInt(num, 'hex');
            } catch (err) {}
        });
    }

    if (webDec) {
        webDec.addEventListener('input', (e) => {
            if (isConverterUpdating) return;
            const val = e.target.value.trim();
            if (!val) return clearConverterFields('dec');
            try {
                const num = BigInt(val);
                updateAllFromBigInt(num, 'dec');
            } catch (err) {}
        });
    }

    if (webBin) {
        webBin.addEventListener('input', (e) => {
            if (isConverterUpdating) return;
            const clean = e.target.value.replace(/[\s_]/g, '');
            if (!clean) return clearConverterFields('bin');
            try {
                const num = BigInt('0b' + clean);
                updateAllFromBigInt(num, 'bin');
            } catch (err) {}
        });
    }

    if (webOct) {
        webOct.addEventListener('input', (e) => {
            if (isConverterUpdating) return;
            const clean = e.target.value.trim();
            if (!clean) return clearConverterFields('oct');
            try {
                const num = BigInt('0o' + clean);
                updateAllFromBigInt(num, 'oct');
            } catch (err) {}
        });
    }

    if (webAscii) {
        webAscii.addEventListener('input', (e) => {
            if (isConverterUpdating) return;
            const val = e.target.value;
            if (!val) return clearConverterFields('ascii');
            let hex = '';
            for (let i = 0; i < val.length; i++) {
                hex += val.charCodeAt(i).toString(16).padStart(2, '0');
            }
            try {
                const num = BigInt('0x' + hex);
                updateAllFromBigInt(num, 'ascii');
            } catch (err) {}
        });
    }

    if (webBtnClearConverter) {
        webBtnClearConverter.addEventListener('click', () => {
            clearConverterFields();
        });
    }

    document.querySelectorAll('.btn-copy-mini').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const targetInput = document.getElementById(targetId);
            if (targetInput && targetInput.value) {
                copyWithFeedback(targetInput.value, '已复制内容');
            }
        });
    });

    try {
        const initialNum = BigInt('0x1A3F');
        updateAllFromBigInt(initialNum);
    } catch (_) {}


    // ---------------- 模块五：网页端 Cron 表达式工作台 ----------------
    const webCronPresetSelect = document.getElementById('webCronPresetSelect');
    const webCronInput = document.getElementById('webCronInput');
    const webCronMeaning = document.getElementById('webCronMeaning');
    const webCronNextTimes = document.getElementById('webCronNextTimes');
    const webBtnCopyCron = document.getElementById('webBtnCopyCron');

    function explainCronExpression(cron) {
        if (!cron || !cron.trim()) return "请输入 Cron 表达式";
        const parts = cron.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 7) return "无效的 Cron 格式 (标准为 5 到 7 个字段)";

        const hasSec = parts.length >= 6;
        const sec = hasSec ? parts[0] : "0";
        const min = hasSec ? parts[1] : parts[0];
        const hour = hasSec ? parts[2] : parts[1];
        const day = hasSec ? parts[3] : parts[2];
        const month = hasSec ? parts[4] : parts[3];
        const week = hasSec ? parts[5] : parts[4];
        const year = parts.length === 7 ? parts[6] : null;

        if (sec === "*" && min === "*" && hour === "*") return "每秒执行任务";
        if ((sec.includes("/") || sec.startsWith("*/")) && min === "*" && hour === "*") {
            const step = sec.split("/")[1] || "1";
            return `每 ${step} 秒执行任务`;
        }
        if (sec === "0" && min === "*" && hour === "*") return "每分钟执行任务";
        if (sec === "0" && (min.includes("/") || min.startsWith("*/")) && hour === "*") {
            const step = min.split("/")[1] || "1";
            return `每 ${step} 分钟执行任务`;
        }

        let desc = "";
        if (year && year !== "*" && year !== "?") {
            desc += `${year} 年 `;
        }
        if (month && month !== "*" && month !== "?") {
            if (month.includes(",")) {
                desc += `每年 ${month.split(",").join("、")} 月 `;
            } else if (month.includes("-")) {
                desc += `每年 ${month.split("-")[0]}月至${month.split("-")[1]}月 `;
            } else {
                desc += `每年 ${month} 月 `;
            }
        }

        if (week && week !== "*" && week !== "?") {
            const weekUpper = week.toUpperCase();
            if (weekUpper.includes("#")) {
                const [w, n] = weekUpper.split("#");
                const wMap = { "1":"星期日","2":"星期一","3":"星期二","4":"星期三","5":"星期四","6":"星期五","7":"星期六","SUN":"星期日","MON":"星期一","TUE":"星期二","WED":"星期三","THU":"星期四","FRI":"星期五","SAT":"星期六" };
                desc += `每月第 ${n} 个${wMap[w] || "星期" + w} `;
            } else if (weekUpper.endsWith("L")) {
                const w = weekUpper.slice(0, -1);
                const wMap = { "1":"星期日","2":"星期一","3":"星期二","4":"星期三","5":"星期四","6":"星期五","7":"星期六","SUN":"星期日","MON":"星期一","TUE":"星期二","WED":"星期三","THU":"星期四","FRI":"星期五","SAT":"星期六" };
                desc += `每月最后一个${wMap[w] || "星期六"} `;
            } else if (weekUpper === "MON-FRI" || weekUpper === "2-6") {
                desc += "周一至周五(工作日) ";
            } else if (weekUpper === "MON-SAT") {
                desc += "周一至周六 ";
            } else if (weekUpper.includes(",")) {
                const wMap = { "1":"日","2":"一","3":"二","4":"三","5":"四","6":"五","7":"六","SUN":"日","MON":"一","TUE":"二","WED":"三","THU":"四","FRI":"五","SAT":"六" };
                const days = weekUpper.split(",").map(w => "周" + (wMap[w] || w)).join("、");
                desc += `每周(${days}) `;
            } else {
                const weekMap = {
                    "MON": "每个星期一", "TUE": "每个星期二", "WED": "每个星期三", "THU": "每个星期四", "FRI": "每个星期五", "SAT": "每个星期六", "SUN": "每个星期日",
                    "2": "每个星期一", "3": "每个星期二", "4": "每个星期三", "5": "每个星期四", "6": "每个星期五", "7": "每个星期六", "1": "每个星期日"
                };
                desc += (weekMap[weekUpper] || `星期(${week})`) + " ";
            }
        } else if (day && day !== "*" && day !== "?") {
            if (day.toUpperCase() === "L") {
                desc += "每月最后一天 ";
            } else if (day.toUpperCase().endsWith("W")) {
                desc += `每月离 ${day.slice(0, -1)} 日最近的工作日 `;
            } else if (day.includes(",")) {
                desc += `每月 ${day.split(",").join("、")} 日 `;
            } else if (day.includes("-")) {
                desc += `每月 ${day} 日 `;
            } else {
                desc += `每月 ${day} 日 `;
            }
        } else {
            desc += "每天 ";
        }

        let hDesc = "";
        if (hour === "*") {
            hDesc = "每小时";
        } else if (hour.includes("/")) {
            const [s, step] = hour.split("/");
            hDesc = `从 ${s} 点开始每隔 ${step} 小时`;
        } else if (hour.includes("-")) {
            const [s, e] = hour.split("-");
            hDesc = `${s}点至${e}点 期间`;
        } else if (hour.includes(",")) {
            const hList = hour.split(",").map(h => `${h}点`).join("、");
            hDesc = `${hList} `;
        } else {
            const hNum = parseInt(hour, 10);
            if (hNum < 6) hDesc = `凌晨 ${hNum}点`;
            else if (hNum < 12) hDesc = `上午 ${hNum}点`;
            else if (hNum === 12) hDesc = `中午 12点`;
            else if (hNum < 18) hDesc = `下午 ${hNum > 12 ? (hNum - 12) + "点(" + hNum + "点)" : hNum + "点"}`;
            else hDesc = `晚上 ${hNum - 12}点(${hNum}点)`;
        }

        let mDesc = "";
        if (min === "*") {
            mDesc = "每分钟";
        } else if (min.includes("/")) {
            const step = min.split("/")[1];
            mDesc = `每隔 ${step} 分钟`;
        } else if (min.includes("-")) {
            const [s, e] = min.split("-");
            mDesc = `${String(s).padStart(2, "0")}分至${String(e).padStart(2, "0")}分 期间每分钟`;
        } else if (min.includes(",")) {
            const mList = min.split(",").map(m => `${String(m).padStart(2, "0")}分`).join("、");
            mDesc = `${mList}`;
        } else {
            mDesc = `${String(min).padStart(2, "0")}分`;
        }

        let sDesc = "";
        if (sec === "*" || sec === "0") {
            sDesc = "";
        } else if (sec.includes("/")) {
            const step = sec.split("/")[1];
            sDesc = ` 每隔 ${step} 秒`;
        } else if (sec.includes("-")) {
            const [s, e] = sec.split("-");
            sDesc = ` ${String(s).padStart(2, "0")}秒至${String(e).padStart(2, "0")}秒`;
        } else if (sec.includes(",")) {
            const sList = sec.split(",").map(s => `${String(s).padStart(2, "0")}秒`).join("、");
            sDesc = ` ${sList}`;
        } else {
            sDesc = `${String(sec).padStart(2, "0")}秒`;
        }

        let timeStr = "";
        if (hour.includes(",") && min === "0" && (sec === "0" || !sec)) {
            timeStr = `${hDesc} 整`;
        } else if (hour.includes("-") || hour.includes("/") || hour === "*") {
            timeStr = `${hDesc}${mDesc}${sDesc}`;
        } else {
            timeStr = `${hDesc} ${mDesc}${sDesc}`;
        }

        return `${desc}${timeStr} 执行任务`.replace(/\s+/g, " ").trim();
    }

    function matchCronField(field, val, minRange) {
        if (!field || field === "*" || field === "?") return true;
        for (const part of field.split(",")) {
            if (part.includes("/")) {
                let [startStr, stepStr] = part.split("/");
                let start = startStr === "*" ? minRange : parseInt(startStr, 10);
                let step = parseInt(stepStr, 10);
                if (step > 0 && val >= start && (val - start) % step === 0) return true;
            } else if (part.includes("-")) {
                const [s, e] = part.split("-").map(n => parseInt(n, 10));
                if (val >= s && val <= e) return true;
            } else {
                if (parseInt(part, 10) === val) return true;
            }
        }
        return false;
    }

    function matchWeek(weekStr, d) {
        if (!weekStr || weekStr === "*" || weekStr === "?") return true;
        const jsDay = d.getDay(); // 0=Sun, 1=Mon ... 6=Sat
        const qDay = jsDay === 0 ? 1 : jsDay + 1; // Quartz: 1=Sun, 2=Mon... 7=Sat
        const upper = weekStr.toUpperCase();
        if (upper.includes("#")) {
            const [wStr, nStr] = upper.split("#");
            const wMap = { "1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"SUN":1,"MON":2,"TUE":3,"WED":4,"THU":5,"FRI":6,"SAT":7 };
            const targetQ = wMap[wStr];
            const targetN = parseInt(nStr, 10);
            if (qDay !== targetQ) return false;
            const dom = d.getDate();
            return dom > (targetN - 1) * 7 && dom <= targetN * 7;
        }
        const normalized = upper
            .replace(/SUN/g, "1").replace(/MON/g, "2").replace(/TUE/g, "3")
            .replace(/WED/g, "4").replace(/THU/g, "5").replace(/FRI/g, "6").replace(/SAT/g, "7");
        return matchCronField(normalized, qDay, 1);
    }

    function matchDayOfMonth(dayStr, d) {
        if (!dayStr || dayStr === "*" || dayStr === "?") return true;
        if (dayStr.toUpperCase() === "L") {
            const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
            return d.getDate() === lastDay;
        }
        return matchCronField(dayStr, d.getDate(), 1);
    }

    function predictNextTimes(cron, count = 5) {
        const parts = cron.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 7) return ["表达式格式错误，无法预演时间"];

        const hasSec = parts.length >= 6;
        const sec = hasSec ? parts[0] : "0";
        const min = hasSec ? parts[1] : parts[0];
        const hour = hasSec ? parts[2] : parts[1];
        const day = hasSec ? parts[3] : parts[2];
        const month = hasSec ? parts[4] : parts[3];
        const week = hasSec ? parts[5] : parts[4];
        const year = parts.length === 7 ? parts[6] : null;

        const list = [];
        const now = new Date();
        let current = new Date(now.getTime());

        let stepMs = 1000;
        const isSingleNumber = s => /^\d+$/.test(s);

        if (isSingleNumber(sec) && isSingleNumber(min) && isSingleNumber(hour)) {
            current.setHours(parseInt(hour, 10), parseInt(min, 10), parseInt(sec, 10), 0);
            stepMs = 24 * 3600 * 1000;
        } else if (isSingleNumber(sec) && isSingleNumber(min)) {
            current.setMinutes(parseInt(min, 10), parseInt(sec, 10), 0);
            stepMs = 3600 * 1000;
        } else if (isSingleNumber(sec)) {
            current.setSeconds(parseInt(sec, 10), 0);
            stepMs = 60 * 1000;
        }

        function formatDate(d) {
            const Y = d.getFullYear();
            const M = String(d.getMonth() + 1).padStart(2, "0");
            const D = String(d.getDate()).padStart(2, "0");
            const h = String(d.getHours()).padStart(2, "0");
            const m = String(d.getMinutes()).padStart(2, "0");
            const s = String(d.getSeconds()).padStart(2, "0");
            return `${Y}-${M}-${D} ${h}:${m}:${s}`;
        }

        let iterations = 0;
        const maxIterations = 50000;
        while (list.length < count && iterations < maxIterations) {
            iterations++;
            current = new Date(current.getTime() + stepMs);

            if (current.getTime() <= now.getTime()) continue;
            if (year && !matchCronField(year, current.getFullYear(), 1970)) continue;
            if (!matchCronField(month, current.getMonth() + 1, 1)) continue;
            if (!matchDayOfMonth(day, current)) continue;
            if (!matchWeek(week, current)) continue;
            if (!matchCronField(hour, current.getHours(), 0)) continue;
            if (!matchCronField(min, current.getMinutes(), 0)) continue;
            if (!matchCronField(sec, current.getSeconds(), 0)) continue;

            list.push(formatDate(current));
        }

        if (list.length === 0) {
            return ["在未来近期内未匹配到触发时间（如限定历史年份或极小概率时间点）"];
        }
        return list;
    }

    function updateCronUI(cron) {
        if (webCronMeaning) webCronMeaning.textContent = explainCronExpression(cron);
        const times = predictNextTimes(cron, 5);
        if (webCronNextTimes) {
            webCronNextTimes.innerHTML = times.map((t, idx) => `<div>${idx + 1}.  ${t}</div>`).join('');
        }
    }

    if (webCronPresetSelect) {
        webCronPresetSelect.addEventListener('change', (e) => {
            clearTimeout(cronInputTimer);
            if (webCronInput) webCronInput.value = e.target.value;
            updateCronUI(e.target.value);
        });
    }

    let cronInputTimer;
    if (webCronInput) {
        webCronInput.addEventListener('input', (e) => {
            clearTimeout(cronInputTimer);
            const value = e.target.value;
            cronInputTimer = setTimeout(() => updateCronUI(value), 180);
        });
    }

    if (webBtnCopyCron) {
        webBtnCopyCron.addEventListener('click', () => {
            if (webCronInput) {
                copyWithFeedback(webCronInput.value, 'Cron 表达式已复制');
            }
        });
    }

    if (webCronInput) {
        updateCronUI(webCronInput.value);
    }

    [document.getElementById('chatOnlineMemberBadge'), dropZone].filter(Boolean).forEach(element => {
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        element.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault(); element.click();
            }
        });
    });

    if (window.visualViewport) {
        const resize = () => {
            document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport.height}px`);
            document.body.classList.toggle('keyboard-open', window.innerHeight - window.visualViewport.height > 120);
        };
        window.visualViewport.addEventListener('resize', resize); resize();
    }
    document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && currentActiveTab === 'view-tools') {
            if (!document.getElementById('tab-json').hidden) { event.preventDefault(); webBtnFormatJson2?.click(); }
            else if (!document.getElementById('tab-cron').hidden) { event.preventDefault(); updateCronUI(webCronInput.value); }
        }
    });
    initRoomState();
    updateMyNicknameDisplay();
    window.WenBoxTheme?.init();

    // 主题切换按钮在 DOM 就绪后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThemeToggle);
    } else {
        initThemeToggle();
    }
})();
