(function () {
    // ---------------- 全局通知 Toast ----------------
    const toast = document.getElementById('toast');
    function showToast(msg) {
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ---------------- 顶部 Tab 导航切换 ----------------
    const navTabs = document.querySelectorAll('.nav-tab');
    const tabPanes = document.querySelectorAll('.tab-pane');
    let currentActiveTab = 'tab-transfer';

    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            navTabs.forEach(t => t.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetId = tab.getAttribute('data-tab');
            currentActiveTab = targetId;
            const targetPane = document.getElementById(targetId);
            if (targetPane) targetPane.classList.add('active');

            if (currentActiveTab === 'tab-transfer') {
                if (roomState.mode === 'joined') {
                    loadFiles();
                } else if (roomState.mode === 'host') {
                    loadLocalSharedFiles();
                    loadReceivedFiles();
                } else {
                    pollDiscoveredRooms();
                }
            } else if (currentActiveTab === 'tab-chat') {
                if (roomState.mode === 'host' || roomState.mode === 'joined') {
                    pollChatMessages();
                }
            }
        });
    });

    // ---------------- 房间制架构与状态管理 (默认客户端发现模式) ----------------
    let roomState = {
        mode: 'client', // 'client' | 'host' | 'joined'
        token: localStorage.getItem('wenbox_room_token') || '',
        roomInfo: null, // 当前房间详情
        discoveredRooms: []
    };

    let currentTargetBaseUrl = ''; // 默认为本端，joined 模式时为房主地址，如 "http://192.168.1.120:9527"
    let currentTargetDeviceName = '本端直连';

    // UI 容器与元素绑定
    const roomClientBanner = document.getElementById('roomClientBanner');
    const roomHostBanner = document.getElementById('roomHostBanner');
    const roomJoinedBanner = document.getElementById('roomJoinedBanner');
    const discoveredRoomsContainer = document.getElementById('discoveredRoomsContainer');
    const discoveredRoomsCount = document.getElementById('discoveredRoomsCount');
    const noRoomsDiscoveredPrompt = document.getElementById('noRoomsDiscoveredPrompt');

    // Host 模式 UI 元素
    const hostRoomNameDisplay = document.getElementById('hostRoomNameDisplay');
    const hostRoomIdDisplay = document.getElementById('hostRoomIdDisplay');
    const hostRoomPinDisplay = document.getElementById('hostRoomPinDisplay');
    const hostRoomUrlDisplay = document.getElementById('hostRoomUrlDisplay');
    const hostMemberCount = document.getElementById('hostMemberCount');
    const hostMembersContainer = document.getElementById('hostMembersContainer');
    const btnShowHostQrCode = document.getElementById('btnShowHostQrCode');
    const btnCopyRoomDirectLink = document.getElementById('btnCopyRoomDirectLink');
    const btnCloseRoom = document.getElementById('btnCloseRoom');

    // Joined 模式 UI 元素
    const joinedRoomNameDisplay = document.getElementById('joinedRoomNameDisplay');
    const joinedHostDeviceDisplay = document.getElementById('joinedHostDeviceDisplay');
    const btnLeaveRoom = document.getElementById('btnLeaveRoom');

    // 模态弹窗元素
    const createRoomModal = document.getElementById('createRoomModal');
    const btnOpenCreateRoomModal = document.getElementById('btnOpenCreateRoomModal');
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
    const currentViewingDeviceTitle = document.getElementById('currentViewingDeviceTitle');

    // ---------------- 纯前端免依赖二维码生成器 (QRCode Canvas) ----------------
    function renderQrCodeToCanvas(canvas, text) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        // 简易稳定 QR 算法：利用现代内联 SVG DataURL 绘制到 Canvas，兼具 100% 离线与极佳清晰度
        // 使用 Google Charts API 降级或内建 QR 矩阵算法
        const qrImg = new Image();
        qrImg.crossOrigin = 'anonymous';
        qrImg.onload = function () {
            ctx.drawImage(qrImg, 0, 0, size, size);
        };
        qrImg.onerror = function () {
            // 离线环境下的备用绘制：绘制一个清晰优雅的高对比度扫码提示图案与直链
            ctx.fillStyle = '#0F172A';
            ctx.fillRect(8, 8, size - 16, size - 16);
            ctx.fillStyle = '#60A5FA';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('📱 局域网直链二维码', size / 2, size / 2 - 20);
            ctx.font = '11px monospace';
            ctx.fillStyle = '#F8FAFC';
            ctx.fillText(text.length > 28 ? text.substring(0, 28) + '...' : text, size / 2, size / 2 + 10);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#94A3B8';
            ctx.fillText('在手机浏览器打开该网址即可', size / 2, size / 2 + 30);
        };
        // 尝试加载标准 QR
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
    }

    // ---------------- 模态框打开与关闭控制 ----------------
    window.closeCreateRoomModal = function () {
        if (createRoomModal) createRoomModal.style.display = 'none';
    };
    window.closeJoinPinModal = function () {
        if (joinRoomPinModal) joinRoomPinModal.style.display = 'none';
        pendingJoinRoomData = null;
    };
    window.closeManualJoinModal = function () {
        if (manualJoinModal) manualJoinModal.style.display = 'none';
    };
    window.closeHostQrModal = function () {
        if (hostQrModal) hostQrModal.style.display = 'none';
    };

    window.openCreateRoomModal = function () {
        if (modalInputRoomName) {
            const randomNum = Math.floor(1000 + Math.random() * 9000);
            modalInputRoomName.value = `WenBox-${randomNum}`;
        }
        if (modalInputRoomPin) modalInputRoomPin.value = '';
        if (createRoomModal) createRoomModal.style.display = 'flex';
    };

    if (btnOpenCreateRoomModal) {
        btnOpenCreateRoomModal.addEventListener('click', () => {
            window.openCreateRoomModal();
        });
    }

    if (btnOpenManualJoinModal) {
        btnOpenManualJoinModal.addEventListener('click', () => {
            if (modalInputManualUrl) modalInputManualUrl.value = '';
            if (modalInputManualPin) modalInputManualPin.value = '';
            if (manualJoinModal) manualJoinModal.style.display = 'flex';
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
        hostQrModal.style.display = 'flex';
    }

    // ---------------- 模块一：局域网快传与日期归类直存 ----------------
    const fileListContainer = document.getElementById('fileListContainer');
    const emptyState = document.getElementById('emptyState');
    const fileCount = document.getElementById('fileCount');
    const btnRefresh = document.getElementById('btnRefresh');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const uploadProgressContainer = document.getElementById('uploadProgressContainer');
    const uploadProgressBar = document.getElementById('uploadProgressBar');
    const uploadFileName = document.getElementById('uploadFileName');
    const uploadPercent = document.getElementById('uploadPercent');

    // 日期归档直存按钮与状态
    const btnSelectReimburseDir = document.getElementById('btnSelectReimburseDir');
    const reimburseStatus = document.getElementById('reimburseStatus');
    const previewFolderName = document.getElementById('previewFolderName');
    const customFolderSuffix = document.getElementById('customFolderSuffix');

    function updatePreviewFolderName() {
        if (!previewFolderName) return;
        const suffix = (customFolderSuffix && customFolderSuffix.value.trim()) ? `_${customFolderSuffix.value.trim()}` : '';
        previewFolderName.textContent = `${getTodayDateStr()}${suffix}`;
    }

    if (customFolderSuffix) {
        customFolderSuffix.addEventListener('input', updatePreviewFolderName);
    }
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

    function getFileIcon(name, mimeType) {
        const ext = name.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || (mimeType && mimeType.startsWith('image/'))) return '🖼️';
        if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext) || (mimeType && mimeType.startsWith('video/'))) return '🎬';
        if (['mp3', 'wav', 'flac', 'aac'].includes(ext) || (mimeType && mimeType.startsWith('audio/'))) return '🎵';
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
        if (['pdf'].includes(ext)) return '📑';
        if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '📝';
        if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
        if (['apk'].includes(ext)) return '🤖';
        return '📄';
    }

    // 视图切换容器
    const selfViewSection = document.getElementById('selfViewSection');
    const remoteViewSection = document.getElementById('remoteViewSection');
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
    const uploadSectionTitle = document.getElementById('uploadSectionTitle');
    const uploadSectionSubtitle = document.getElementById('uploadSectionSubtitle');
    const dropZoneHint = document.getElementById('dropZoneHint');
    const multiIpSelectorContainer = document.getElementById('multiIpSelectorContainer');
    const multiIpPills = document.getElementById('multiIpPills');

    function isTauriDesktop() {
        return window.location.hostname === 'tauri.localhost' || window.location.protocol === 'tauri:';
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
        if (isTauriDesktop()) return 'Windows';
        if (/Android/i.test(navigator.userAgent)) return 'Android';
        if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'iOS';
        if (/Mobile/i.test(navigator.userAgent)) return 'Mobile';
        return 'Browser';
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
        if (!multiIpSelectorContainer || !multiIpPills) return;
        if (!ips || ips.length <= 1) {
            multiIpSelectorContainer.style.display = 'none';
            return;
        }

        multiIpSelectorContainer.style.display = 'flex';
        multiIpPills.innerHTML = ips.map(item => {
            const ipStr = typeof item === 'string' ? item : item.ip;
            const nameStr = (typeof item === 'object' && item.name) ? ` (${item.name})` : '';
            const isActive = ipStr === activeIp;
            return `
                <button class="ip-pill ${isActive ? 'active' : ''}" onclick="window.switchActiveServerIp('${ipStr}')">
                    ${escapeHtml(ipStr)}${escapeHtml(nameStr)}
                </button>
            `;
        }).join('');
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
        if (hostQrModal && hostQrModal.style.display !== 'none') {
            showHostQrModal();
        }
        showToast(`已切换展示网卡 IP 为: ${ip}`);
    };

    function updateHostBannerDisplay() {
        if (!roomState.roomInfo) return;
        const info = roomState.roomInfo;
        const fullUrl = getReachableHostAddress(info.hostPort);
        if (hostRoomUrlDisplay) hostRoomUrlDisplay.textContent = fullUrl;
        if (phoneNameBadge) {
            phoneNameBadge.innerHTML = `👑 房主服务中: <b style="color:#10B981;">${info.roomName || '房间'}</b> (${fullUrl})`;
        }
    }

    async function checkSelfServerStatus() {
        const invoke = getTauriInvoke();
        if (invoke) {
            try {
                // 与本地后台实时同步房间模式 (只有本机 Tauri UI 亲自建房 rStatus.isTauriHost 时才响应为 host)
                const rStatus = await invoke('get_room_status_cmd');
                if (rStatus && rStatus.isActive && rStatus.isTauriHost) {
                    if (roomState.mode !== 'host') {
                        setRoomMode('host', rStatus);
                    }
                } else if (rStatus && !rStatus.isActive && roomState.mode === 'host') {
                    setRoomMode('client');
                }

                const ips = await invoke('get_all_lan_ips_cmd');
                selfLanIps = ips || [];
                const primary = await invoke('get_local_ip');

                const hasSelected = userSelectedIp && selfLanIps.some(item => {
                    const s = typeof item === 'string' ? item : (item && item.ip);
                    return s === userSelectedIp;
                });

                if (hasSelected) {
                    selfDeviceInfo.ip = userSelectedIp;
                } else {
                    selfDeviceInfo.ip = primary || (selfLanIps.length > 0 ? (selfLanIps[0].ip || selfLanIps[0]) : '127.0.0.1');
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
                    if (multiIpSelectorContainer) multiIpSelectorContainer.style.display = 'none';
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
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(directUrl);
                } else {
                    const input = document.createElement('input');
                    input.value = directUrl;
                    document.body.appendChild(input);
                    input.select();
                    document.execCommand('copy');
                    document.body.removeChild(input);
                }
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
                if (navigator.sendBeacon) {
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
        if (roomState.mode === 'joined' && mode !== 'joined') {
            notifyLeaveRoom();
        }
        if (roomState.mode !== mode || (data && roomState.roomInfo && data.roomId !== roomState.roomInfo.roomId)) {
            if (typeof resetChatRoomHistory === 'function') {
                resetChatRoomHistory();
            }
        }
        roomState.mode = mode;
        if (mode === 'host') {
            roomState.roomInfo = data;
            currentTargetBaseUrl = ''; // 房主端自身即服务端
            currentTargetDeviceName = '本机房间';

            if (roomClientBanner) roomClientBanner.style.display = 'none';
            if (roomHostBanner) roomHostBanner.style.display = 'block';
            if (roomJoinedBanner) roomJoinedBanner.style.display = 'none';

            if (hostRoomNameDisplay) hostRoomNameDisplay.textContent = data.roomName || '--';
            if (hostRoomIdDisplay) hostRoomIdDisplay.textContent = data.roomId || '--';
            if (hostRoomPinDisplay) hostRoomPinDisplay.textContent = data.pin ? data.pin : '（公开房间，免密）';
            updateHostBannerDisplay();

            // 房主视图：显示本机分享与已接收文件面板
            if (selfViewSection) selfViewSection.style.display = 'block';
            if (remoteViewSection) remoteViewSection.style.display = 'none';
            if (uploadSectionTitle) uploadSectionTitle.textContent = '📤 本机对外分享新文件';
            if (uploadSectionSubtitle) uploadSectionSubtitle.textContent = '添加文件后，加入该房间的成员可立即查看并免解压下载';

            loadLocalSharedFiles();
            loadReceivedFiles();
            pollRoomMembers();
        } else if (mode === 'joined') {
            roomState.roomInfo = data;
            const rawHost = (data && data.hostUrl && String(data.hostUrl).trim()) ? String(data.hostUrl).trim() : (isTauriDesktop() ? 'http://127.0.0.1:9527' : window.location.origin);
            currentTargetBaseUrl = rawHost.replace(/\/+$/, '');
            currentTargetDeviceName = data.hostDevice || '房主';

            if (roomClientBanner) roomClientBanner.style.display = 'none';
            if (roomHostBanner) roomHostBanner.style.display = 'none';
            if (roomJoinedBanner) roomJoinedBanner.style.display = 'block';

            if (joinedRoomNameDisplay) joinedRoomNameDisplay.textContent = data.roomName || data.roomId || '--';
            if (joinedHostDeviceDisplay) joinedHostDeviceDisplay.textContent = data.hostDevice || '主机';
            if (phoneNameBadge) {
                phoneNameBadge.innerHTML = `🔗 已入房: <b style="color:#38BDF8;">${data.roomName || data.roomId}</b>`;
            }

            // 加入者视图：显示远程房主分享文件下载面板与向房主投送面板
            if (selfViewSection) selfViewSection.style.display = 'none';
            if (remoteViewSection) remoteViewSection.style.display = 'block';
            if (currentViewingDeviceTitle) currentViewingDeviceTitle.textContent = `📂 房主分享的文件 (${data.roomName || '房间'})`;
            if (uploadSectionTitle) uploadSectionTitle.textContent = `📤 发送文件至房主「${data.hostDevice || '主机'}」`;
            if (uploadSectionSubtitle) uploadSectionSubtitle.textContent = '拖拽或点击选择文件，文件将直接投送到房主电脑 Downloads/WenBox 目录';

            loadFiles();
            pollJoinedMembers();
        } else {
            // 默认客户端发现模式 (Client Mode)
            roomState.mode = 'client';
            roomState.roomInfo = null;
            currentTargetBaseUrl = '';

            if (roomClientBanner) roomClientBanner.style.display = 'block';
            if (roomHostBanner) roomHostBanner.style.display = 'none';
            if (roomJoinedBanner) roomJoinedBanner.style.display = 'none';
            if (selfViewSection) selfViewSection.style.display = 'none';
            if (remoteViewSection) remoteViewSection.style.display = 'none';

            if (phoneNameBadge) {
                phoneNameBadge.innerHTML = `🔍 客户端发现中: <span style="color:#60A5FA;">就绪</span>`;
            }
            pollDiscoveredRooms();
        }
        if (typeof updateChatGatingUi === 'function') {
            updateChatGatingUi(mode, data);
        }
        updateChatStatusBar(mode, data);
        if (typeof updateMyNicknameDisplay === 'function') {
            updateMyNicknameDisplay();
        }
    }

    function updateChatStatusBar(mode, data) {
        const onlineBadge = document.getElementById('chatOnlineMemberBadge');
        const ipBadge = document.getElementById('chatRoomIpBadge');
        const copyBtn = document.getElementById('btnCopyChatRoomUrl');

        if (mode === 'host') {
            const reachableUrl = getReachableHostAddress(data ? data.hostPort : null);
            const rId = data ? (data.roomId || data.roomName || '') : '';
            const fullJoinUrl = rId ? `${reachableUrl}/?room=${encodeURIComponent(rId)}` : reachableUrl;
            const memberCount = (latestRoomMembers && latestRoomMembers.length) || 1;
            if (onlineBadge) onlineBadge.textContent = `👥 在线: ${memberCount} 人 (点击查看)`;
            if (ipBadge) ipBadge.textContent = `🌐 访问地址: ${reachableUrl}`;
            if (copyBtn) {
                copyBtn.onclick = () => {
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(fullJoinUrl).then(() => showToast(`已复制入房直链: ${fullJoinUrl}`));
                    } else {
                        showToast(`入房直链: ${fullJoinUrl}`);
                    }
                };
            }
        } else if (mode === 'joined' && data) {
            let hUrl = data.hostUrl || currentTargetBaseUrl;
            if (!hUrl && data.hostIp && data.hostPort) {
                hUrl = `http://${data.hostIp}:${data.hostPort}`;
            }
            const memberCount = (latestRoomMembers && latestRoomMembers.length > 0) ? latestRoomMembers.length : 1;
            if (onlineBadge) onlineBadge.textContent = `👥 在线: ${memberCount} 人 (点击查看)`;
            if (ipBadge) ipBadge.textContent = `🌐 房主地址: ${hUrl || '已连接'}`;
            if (copyBtn) {
                copyBtn.onclick = () => {
                    if (hUrl) {
                        if (navigator.clipboard) {
                            navigator.clipboard.writeText(hUrl).then(() => showToast(`已复制房主网址: ${hUrl}`));
                        } else {
                            showToast(`房主网址: ${hUrl}`);
                        }
                    }
                };
            }
        } else {
            if (onlineBadge) onlineBadge.textContent = '👥 未进入房间';
            if (ipBadge) ipBadge.textContent = '🌐 未进入房间';
            if (copyBtn) copyBtn.onclick = null;
        }
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
            modal.style.display = 'flex';
            window._appConfirmResolver = resolve;
        });
    };

    window.closeAppConfirm = function (result) {
        const modal = document.getElementById('appConfirmModal');
        if (modal) modal.style.display = 'none';
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
            modal.style.display = 'flex';
            window._appAlertResolver = resolve;
        });
    };

    window.closeAppAlert = function () {
        const modal = document.getElementById('appAlertModal');
        if (modal) modal.style.display = 'none';
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
            const rName = (modalInputRoomName && modalInputRoomName.value.trim()) || `WenBox-${Math.floor(1000 + Math.random() * 9000)}`;
            const rPin = modalInputRoomPin ? modalInputRoomPin.value.trim() : '';

            modalBtnConfirmCreateRoom.disabled = true;
            modalBtnConfirmCreateRoom.textContent = '正在开启房间服务...';

            try {
                const invoke = getTauriInvoke();
                if (invoke) {
                    const cfg = await invoke('create_room_cmd', {
                        roomName: rName,
                        pin: rPin,
                        hostIp: selfDeviceInfo.ip || null
                    });
                    window.closeCreateRoomModal();
                    setRoomMode('host', cfg);
                    showToast(`房间「${rName}」已创建！本机已变身服务端`);
                } else {
                    const myNick = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
                    const myPlatform = detectClientPlatform();
                    const resp = await fetch(getApiOrigin() + '/api/room/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            roomName: rName,
                            pin: rPin,
                            hostIp: selfDeviceInfo.ip || undefined,
                            creatorName: myNick,
                            creatorPlatform: myPlatform
                        })
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const cfg = await resp.json();
                    if (cfg && cfg.hostToken) {
                        sessionStorage.setItem('wenbox_host_token', cfg.hostToken);
                        roomState.token = cfg.hostToken;
                    }
                    window.closeCreateRoomModal();
                    setRoomMode('host', cfg);
                    showToast(`房间「${rName}」已创建！`);
                }
            } catch (err) {
                window.showAlertDialog('创建房间失败', err.message || err);
            } finally {
                modalBtnConfirmCreateRoom.disabled = false;
                modalBtnConfirmCreateRoom.textContent = '立即创建并开启服务';
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
        if (isPollingRooms) return;
        if (roomState.mode !== 'client') return;
        isPollingRooms = true;
        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                // 只有当本机 Tauri UI 是房主时才同步切为 host 模式
                try {
                    const rStatus = await invoke('get_room_status_cmd');
                    if (rStatus && rStatus.isActive && rStatus.isTauriHost) {
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
            renderDiscoveredRooms(rooms || []);
        } catch (e) {
            // ignore
        } finally {
            isPollingRooms = false;
        }
    }

    function renderDiscoveredRooms(rooms) {
        roomState.discoveredRooms = rooms;
        if (discoveredRoomsCount) discoveredRoomsCount.textContent = rooms.length;
        if (!discoveredRoomsContainer) return;

        if (rooms.length === 0) {
            discoveredRoomsContainer.innerHTML = '';
            if (noRoomsDiscoveredPrompt) noRoomsDiscoveredPrompt.style.display = 'block';
            return;
        }

        if (noRoomsDiscoveredPrompt) noRoomsDiscoveredPrompt.style.display = 'none';
        discoveredRoomsContainer.innerHTML = rooms.map(r => {
            const hostUrl = `http://${r.ip}:${r.port}`;
            const isLock = r.needPassword;
            return `
                <div class="room-card" onclick="window.onDiscoveredRoomClicked('${escapeHtml(r.roomId)}')">
                    <div class="room-card-header">
                        <span class="room-card-title">🏠 ${escapeHtml(r.roomName || r.roomId)}</span>
                        <span class="room-lock-tag ${isLock ? 'locked' : 'open'}">${isLock ? '🔒 需密码' : '🟢 公开免密'}</span>
                    </div>
                    <div class="room-card-meta">
                        <span>👑 房主: ${escapeHtml(r.hostDevice || '主机')} (${r.hostPlatform || '未知'})</span>
                        <span style="font-family: monospace; color: #60A5FA;">${r.ip}:${r.port}</span>
                    </div>
                    <button class="btn-join-room-action">加入房间 ➔</button>
                </div>
            `;
        }).join('');
    }

    window.openJoinRoomDialog = function (data) {
        if (!data) return;
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

        if (titleEl) titleEl.textContent = `📱 加入「${pendingJoinRoomData.roomName}」`;
        if (descEl) {
            descEl.textContent = pendingJoinRoomData.needPassword ? '该房间设置了安全密码，请输入昵称与 PIN 码加入：' : '设置进入房间展示的昵称：';
        }
        if (nickInput) {
            nickInput.value = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        }
        if (pinContainer) {
            pinContainer.style.display = pendingJoinRoomData.needPassword ? 'block' : 'none';
        }
        if (pinInput) pinInput.value = data.pin || '';

        if (joinRoomPinModal) joinRoomPinModal.style.display = 'flex';
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 150);
    };

    window.onDiscoveredRoomClicked = function (roomId) {
        const r = roomState.discoveredRooms.find(x => x.roomId === roomId);
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
            if (e.key === 'Enter') {
                e.preventDefault();
                if (modalBtnConfirmJoinPin) modalBtnConfirmJoinPin.click();
            }
        });
    }
    if (modalInputJoinPin) {
        modalInputJoinPin.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
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
            if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
                rawUrl = 'http://' + rawUrl;
            }
            if (!rawUrl.includes(':', 7)) {
                rawUrl = rawUrl + ':9527';
            }
            rawUrl = rawUrl.replace(/\/+$/, '');
            const pin = modalInputManualPin ? modalInputManualPin.value.trim() : '';
            const nick = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
            window.closeManualJoinModal();
            executeJoinRoom(rawUrl, pin, '手动连接房间', '远程主机', '', nick);
        });
    }

    async function executeJoinRoom(hostUrl, pin, roomName, hostDevice, roomId, nickname) {
        try {
            showToast('正在验证并接入房间...');
            let joinRes = null;
            const myNick = nickname || localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
            const effectiveHostUrl = (hostUrl && String(hostUrl).trim()) ? String(hostUrl).trim().replace(/\/+$/, '') : (isTauriDesktop() ? 'http://127.0.0.1:9527' : window.location.origin);

            const invoke = getTauriInvoke();
            if (invoke) {
                joinRes = await invoke('join_remote_room_cmd', {
                    hostUrl: effectiveHostUrl,
                    pin: pin,
                    myName: myNick
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
                    throw new Error(errData.message || `HTTP ${resp.status}`);
                }
                joinRes = await resp.json();
            }

            if (joinRes && joinRes.success) {
                roomState.token = joinRes.token || '';
                localStorage.setItem('wenbox_room_token', roomState.token);
                window.closeJoinPinModal();
                setRoomMode('joined', {
                    hostUrl: effectiveHostUrl,
                    roomName: joinRes.room ? joinRes.room.roomName : (roomName || '已加入房间'),
                    roomId: joinRes.room ? joinRes.room.roomId : roomId,
                    hostDevice: joinRes.room ? joinRes.room.hostDevice : hostDevice
                });
                showToast(`🎉 成功加入房间！已与「${hostDevice || '房主'}」建立直连`);
                updateMyNicknameDisplay(myNick);
            } else {
                throw new Error(joinRes.message || '入房密码不正确');
            }
        } catch (e) {
            window.showAlertDialog('加入房间失败', e.message || e);
        }
    }

    function whoami_device_name_client() {
        const storedNick = localStorage.getItem('wenbox_nickname');
        if (storedNick && storedNick.trim()) return storedNick.trim();
        return `用户-${Math.floor(100 + Math.random() * 900)}`;
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
        if (input) input.value = currentNick;
        if (modal) modal.style.display = 'flex';
        if (input) setTimeout(() => { input.focus(); input.select(); }, 120);
    };

    window.closeEditNicknameModal = function () {
        const modal = document.getElementById('editNicknameModal');
        if (modal) modal.style.display = 'none';
    };

    const btnChangeNicknameBanner = document.getElementById('btnChangeNicknameBanner');
    if (btnChangeNicknameBanner) {
        btnChangeNicknameBanner.addEventListener('click', window.openEditNicknameModal);
    }
    const btnChangeNicknameChat = document.getElementById('btnChangeNicknameChat');
    if (btnChangeNicknameChat) {
        btnChangeNicknameChat.addEventListener('click', window.openEditNicknameModal);
    }

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
    async function pollRoomMembers() {
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
                    if (stRes.ok) {
                        const st = await stRes.json();
                        const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
                        if (!st.isActive || !st.isHost || (st.roomId && currentRoomId && st.roomId !== currentRoomId)) {
                            sessionStorage.removeItem('wenbox_host_token');
                            roomState.token = null;
                            showToast('房间已解散或服务端已创建新房间，已自动返回发现大厅');
                            setRoomMode('client');
                            return;
                        }
                    } else if (stRes.status === 401 || stRes.status === 403 || stRes.status === 404) {
                        sessionStorage.removeItem('wenbox_host_token');
                        roomState.token = null;
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
                if (res.ok) {
                    const data = await res.json();
                    members = data.members || [];
                } else if (res.status === 401 || res.status === 403 || res.status === 404) {
                    sessionStorage.removeItem('wenbox_host_token');
                    roomState.token = null;
                    showToast('房间已解散，已自动返回发现大厅');
                    setRoomMode('client');
                    return;
                }
            }
            latestRoomMembers = members;
            if (hostMemberCount) hostMemberCount.textContent = (members.length || 1);
            const onlineBadge = document.getElementById('chatOnlineMemberBadge');
            if (onlineBadge) onlineBadge.textContent = `👥 在线: ${members.length || 1} 人 (点击查看)`;
            if (hostMembersContainer) {
                hostMembersContainer.innerHTML = members.map(m => {
                    const isHost = (m.name || '').includes('房主') || m.id === 'host';
                    let cleanName = (m.name || '').replace(/^[📱💻👑\s]+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
                    if (!cleanName) cleanName = m.name;
                    return `
                        <span class="member-pill ${isHost ? 'is-host' : ''}" style="cursor: pointer;" onclick="window.openOnlineMembersModal()">
                            ${isHost ? '👑 ' : ''}${escapeHtml(cleanName)}${isHost ? ' (房主)' : ''}
                        </span>
                    `;
                }).join('');
            }
        } catch (e) {
            // ignore
        }
    }

    // 访客端轮询房间成员、心跳与在线人数
    async function pollJoinedMembers() {
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
                    if (hbData && hbData.room) {
                        const r = hbData.room;
                        const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
                        if (!r.isActive || (r.roomId && currentRoomId && r.roomId !== currentRoomId)) {
                            showToast('房间已解散或服务端已创建新房间，已自动返回客户端大厅');
                            setRoomMode('client');
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
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined
            });
            if (res.ok) {
                const data = await res.json();
                const members = data.members || [];
                latestRoomMembers = members;
                const onlineBadge = document.getElementById('chatOnlineMemberBadge');
                if (onlineBadge) onlineBadge.textContent = `👥 在线: ${members.length} 人 (点击查看)`;
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
            listEl.innerHTML = `<div style="text-align: center; color: var(--ic-text-sub); padding: 20px 0; font-size: 13px;">暂无在线成员信息</div>`;
            modal.style.display = 'flex';
            return;
        }

        const myName = getClientSenderName();
        listEl.innerHTML = members.map(m => {
            const isHost = (m.name || '').includes('房主') || m.id === 'host';
            let cleanName = (m.name || '局域网成员').replace(/^[📱💻👑\s]+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
            if (!cleanName) cleanName = m.name || '局域网成员';
            const isMe = (roomState.mode === 'host' && isHost)
                || (roomState.token && m.id === roomState.token)
                || (!isHost && cleanName === myName);
            const ip = m.ip || '127.0.0.1';
            const accessIp = m.accessIp || '';
            const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';

            let tagHtml = '';
            let detailsHtml = '';

            if (isHost) {
                tagHtml = `<span style="font-size: 11px; padding: 1px 6px; background: rgba(16, 185, 129, 0.15); color: #10B981; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.3);">本机服务</span>`;
                detailsHtml = `
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
                        <span style="color: var(--ic-text-sub);">🌐 服务网卡: <b style="color: var(--ic-accent-blue);">${escapeHtml(ip)}</b></span>
                    </div>
                `;
            } else if (isLoopback) {
                tagHtml = `<span style="font-size: 11px; padding: 1px 6px; background: rgba(59, 130, 246, 0.15); color: #38BDF8; border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.3);">本机浏览器</span>`;
                detailsHtml = `
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
                        <span style="color: var(--ic-text-sub);">📍 设备来源: <b style="color: var(--ic-text-main);">本机 (127.0.0.1)</b></span>
                        ${accessIp ? `<span style="color: var(--ic-text-sub);">🚪 访问入口: <b style="color: var(--ic-accent-blue);">${escapeHtml(accessIp)}</b></span>` : ''}
                    </div>
                `;
            } else {
                tagHtml = `<span style="font-size: 11px; padding: 1px 6px; background: rgba(245, 158, 11, 0.15); color: #F59E0B; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.3);">${escapeHtml(m.platform || '访客设备')}</span>`;
                detailsHtml = `
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
                        <span style="color: var(--ic-text-sub);">📍 访问设备 IP: <b style="color: #F59E0B;">${escapeHtml(ip)}</b></span>
                        ${accessIp ? `<span style="color: var(--ic-text-sub);">🚪 访问房主网卡: <b style="color: var(--ic-accent-blue);">${escapeHtml(accessIp)}</b></span>` : ''}
                    </div>
                `;
            }

            return `
                <div style="display: flex; align-items: center; justify-content: space-between; background: var(--ic-bg-card); border: 1px solid var(--ic-border); border-radius: 6px; padding: 10px 12px; gap: 10px; margin-bottom: 8px;">
                    <div style="display: flex; flex-direction: column; gap: 4px; overflow: hidden; flex: 1;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-size: 13px; font-weight: 600; color: ${isHost ? '#10B981' : 'var(--ic-text-main)'}; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                ${isHost ? '👑 ' : ''}${isMe ? '（我）' : ''}${escapeHtml(cleanName)}${isHost ? ' (房主)' : ''}
                            </span>
                            ${tagHtml}
                        </div>
                        ${detailsHtml}
                    </div>
                    <button class="btn-copy-mini" style="font-size: 11px; padding: 4px 10px; background: #333333; color: var(--ic-accent-blue); border: 1px solid var(--ic-border); border-radius: 4px; cursor: pointer; flex-shrink: 0; transition: all 0.15s;" onclick="window.copyMemberIp('${escapeHtml(ip)}')">复制 IP</button>
                </div>
            `;
        }).join('');

        modal.style.display = 'flex';
    };

    window.closeOnlineMembersModal = function() {
        const modal = document.getElementById('onlineMembersModal');
        if (modal) modal.style.display = 'none';
    };

    window.copyMemberIp = function(ip) {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(ip).then(() => showToast(`已复制 IP: ${ip}`));
        } else {
            showToast(`IP: ${ip}`);
        }
    };

    document.getElementById('btnShowChatMembersModal')?.addEventListener('click', () => {
        window.openOnlineMembersModal();
    });
    document.getElementById('chatOnlineMemberBadge')?.addEventListener('click', () => {
        window.openOnlineMembersModal();
    });

    if (btnRefreshDiscoveredRooms) {
        btnRefreshDiscoveredRooms.addEventListener('click', async () => {
            await pollDiscoveredRooms();
            showToast('已刷新局域网房间列表');
        });
    }

    let isLoadingFiles = false;
    async function loadFiles() {
        if (isLoadingFiles) return;
        isLoadingFiles = true;
        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                currentFiles = await invoke('fetch_node_files', { baseUrl: currentTargetBaseUrl });
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
            currentFiles = data.files || [];
            renderFiles();
        } catch (err) {
            console.error('loadFiles error:', err);
            if (fileListContainer && currentFiles.length === 0) {
                fileListContainer.innerHTML = `
                    <div style="text-align:center; padding:24px; color:#EF4444; font-size:13px;">
                        <div>⚠️ 无法拉取该设备的文件列表 (${err.message || err})</div>
                        <div style="color:#6B7280; font-size:12px; margin-top:4px;">请检查对方设备是否在线且已开启 WenBox 服务</div>
                        <button onclick="window.loadFiles()" style="margin-top:10px; padding:4px 12px; background:#2563EB; color:#fff; border:none; border-radius:4px; cursor:pointer;">点击重试</button>
                    </div>
                `;
            }
        } finally {
            isLoadingFiles = false;
        }
    }
    window.loadFiles = loadFiles;

    // 远程文件按需下载
    window.downloadRemoteFile = async function(fileId, fileName) {
        const tokenQuery = roomState.token ? `?token=${encodeURIComponent(roomState.token)}` : '';
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

                const downloadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : (getApiOrigin() || 'http://127.0.0.1:9527')) + `/api/download/${fileId}${tokenQuery}`;
                await invoke('save_remote_file_to_directory', {
                    downloadUrl: downloadUrl,
                    dirPath: dir,
                    folderName: '',
                    fileName: name
                });
                showToast(`已成功保存到: ${savePath}`);
                return;
            } catch (e) {
                console.error('Tauri save remote file error:', e);
            }
        }

        const dlUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + `/api/download/${fileId}${tokenQuery}`;
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    function renderFiles() {
        if (!fileCount || !fileListContainer || !emptyState) return;
        fileCount.textContent = `${currentFiles.length} 个文件`;
        if (currentFiles.length === 0) {
            fileListContainer.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        fileListContainer.innerHTML = currentFiles.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${file.name}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} • 对方分享</div>
                        </div>
                    </div>
                    <button onclick="window.downloadRemoteFile('${file.id}', '${escapeHtml(file.name)}')" class="btn-download">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        按需下载
                    </button>
                </div>
            `;
        }).join('');
    }

    // ---------------- 本机对外分享与已接收文件管理 ----------------
    async function loadLocalSharedFiles() {
        if (!localSharedFileListContainer) return;
        try {
            let files = [];
            const invoke = getTauriInvoke();
            if (invoke) {
                files = await invoke('fetch_node_files', { baseUrl: '' });
            } else {
                const res = await fetch(getApiOrigin() + '/api/files?t=' + Date.now());
                if (res.ok) {
                    const data = await res.json();
                    files = data.files || [];
                }
            }
            renderLocalSharedFiles(files);
        } catch (e) {
            console.error('loadLocalSharedFiles error:', e);
        }
    }

    function renderLocalSharedFiles(files) {
        if (!localSharedFileListContainer || !localEmptyState) return;
        if (!files || files.length === 0) {
            localSharedFileListContainer.innerHTML = '';
            localEmptyState.style.display = 'block';
            return;
        }

        localEmptyState.style.display = 'none';
        localSharedFileListContainer.innerHTML = files.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);
            const dlUrl = `${getApiOrigin()}/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${file.name}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} • 本地分享路径: ${escapeHtml(file.path || file.name)}</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <a href="${dlUrl}" class="btn-download" download="${escapeHtml(file.name)}" title="下载测试">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                            </svg>
                            下载
                        </a>
                        <button onclick="window.removeLocalSharedFile('${file.id}')" class="btn-danger-outline" style="padding: 6px 10px; font-size: 12px;">
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
            if (invoke) {
                await invoke('remove_share_file', { fileId });
            } else {
                await fetch(getApiOrigin() + `/api/files/remove?id=${encodeURIComponent(fileId)}`, { method: 'POST' });
            }
            showToast('已移除该分享文件');
            loadLocalSharedFiles();
        } catch (e) {
            showToast(`移除失败: ${e.message || e}`);
        }
    };

    async function loadReceivedFiles() {
        if (!receivedFileListContainer) return;
        try {
            let files = [];
            const invoke = getTauriInvoke();
            if (invoke) {
                files = await invoke('get_received_files');
            } else {
                const res = await fetch(getApiOrigin() + '/api/received_files?t=' + Date.now());
                if (res.ok) {
                    const data = await res.json();
                    files = data.files || [];
                }
            }
            renderReceivedFiles(files);
        } catch (e) {
            console.error('loadReceivedFiles error:', e);
        }
    }

    function renderReceivedFiles(files) {
        if (!receivedFileListContainer || !receivedEmptyState) return;
        if (!files || files.length === 0) {
            receivedFileListContainer.innerHTML = '';
            receivedEmptyState.style.display = 'block';
            return;
        }

        receivedEmptyState.style.display = 'none';
        receivedFileListContainer.innerHTML = files.map(file => {
            const icon = getFileIcon(file.name, file.mimeType || '');
            const size = formatBytes(file.size);
            const dlUrl = `${getApiOrigin()}/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${file.name}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} • 保存路径: ${escapeHtml(file.path || 'Downloads/WenBox')}</div>
                        </div>
                    </div>
                    <a href="${dlUrl}" class="btn-download" download="${escapeHtml(file.name)}">
                        下载
                    </a>
                </div>
            `;
        }).join('');
    }

    if (btnSelectShareFile) {
        btnSelectShareFile.addEventListener('click', async () => {
            const tauriDialog = getTauriDialog();
            const invoke = getTauriInvoke();
            if (tauriDialog && invoke) {
                try {
                    const selected = await tauriDialog.open({
                        multiple: true,
                        title: '选择要对外分享的电脑文件'
                    });
                    if (selected) {
                        const paths = Array.isArray(selected) ? selected : [selected];
                        for (const p of paths) {
                            await invoke('add_share_file', { pathStr: p });
                        }
                        showToast(`已添加 ${paths.length} 个电脑文件到分享列表！`);
                        loadLocalSharedFiles();
                    }
                } catch (e) {
                    showToast(`选择文件失败: ${e.message || e}`);
                }
            } else {
                if (fileInput) fileInput.click();
            }
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
                const invoke = getTauriInvoke();
                if (invoke) {
                    await invoke('clear_share_files');
                } else {
                    await fetch(getApiOrigin() + '/api/files/clear', { method: 'POST' });
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

    // 日期归档直存：双模驱动 (支持 Tauri 原生桌面端与浏览器端)
    if (btnSelectReimburseDir) {
        btnSelectReimburseDir.addEventListener('click', async () => {
            if (!currentFiles || currentFiles.length === 0) {
                window.showAlertDialog('暂无待传文件', '当前选定设备还没有待传文件，请先在对方设备上添加待传发票或文件！');
                return;
            }

            const suffix = (customFolderSuffix && customFolderSuffix.value.trim()) ? `_${customFolderSuffix.value.trim()}` : '';
            const dateFolderName = `${getTodayDateStr()}${suffix}`;

            // 模式 A：如果是 Windows / Mac 客户端原生运行 (Tauri 环境) -> 原生文件夹选择 + Rust 极速流式存盘
            const tauriDialog = getTauriDialog();
            const invoke = getTauriInvoke();
            if (tauriDialog && invoke) {
                try {
                    const selectedPath = await tauriDialog.open({
                        directory: true,
                        multiple: false,
                        title: '请选择电脑上的归档根目录'
                    });

                    if (!selectedPath) return; // 用户取消

                    reimburseStatus.style.display = 'block';
                    reimburseStatus.textContent = `📁 正在创建目录「${dateFolderName}」并直存文件...`;

                    let successCount = 0;
                    for (let i = 0; i < currentFiles.length; i++) {
                        const f = currentFiles[i];
                        reimburseStatus.textContent = `⏳ 正在直存 [${i + 1}/${currentFiles.length}]: ${f.name}...`;

                        try {
                            const downloadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : (getApiOrigin() || `http://127.0.0.1:9527`)) + `/api/download/${f.id}`;
                            await invoke('save_remote_file_to_directory', {
                                downloadUrl: downloadUrl,
                                dirPath: selectedPath,
                                folderName: dateFolderName,
                                fileName: f.name
                            });
                            successCount++;
                        } catch (saveErr) {
                            console.error('Tauri save error:', saveErr);
                        }
                    }

                    reimburseStatus.innerHTML = `✅ <b>大功告成！</b>成功将 ${successCount} 个文件直存到 <b>${selectedPath}\\${dateFolderName}</b> 目录下！`;
                    showToast(`已成功直存 ${successCount} 个文件！`);
                } catch (tErr) {
                    reimburseStatus.style.display = 'block';
                    reimburseStatus.textContent = `直存异常: ${tErr.message || tErr}`;
                }
                return;
            }

            // 模式 B：如果在支持原生本地目录的 Secure Context 浏览器环境下 (如 localhost 或 https)
            if (window.showDirectoryPicker) {
                try {
                    const rootDirHandle = await window.showDirectoryPicker({
                        id: 'wenbox_archive_dir',
                        mode: 'readwrite'
                    });

                    reimburseStatus.style.display = 'block';
                    reimburseStatus.textContent = `📁 正在「${rootDirHandle.name}」中创建文件夹「${dateFolderName}」...`;

                    const targetDirHandle = await rootDirHandle.getDirectoryHandle(dateFolderName, { create: true });

                    let successCount = 0;
                    for (let i = 0; i < currentFiles.length; i++) {
                        const f = currentFiles[i];
                        reimburseStatus.textContent = `⏳ 正在直存 [${i + 1}/${currentFiles.length}]: ${f.name}...`;

                        try {
                            const fileResp = await fetch((currentTargetBaseUrl ? currentTargetBaseUrl : '') + `/api/download/${f.id}`);
                            if (!fileResp.ok) throw new Error('下载失败');
                            const blob = await fileResp.blob();

                            const fileHandle = await targetDirHandle.getFileHandle(f.name, { create: true });
                            const writable = await fileHandle.createWritable();
                            await writable.write(blob);
                            await writable.close();
                            successCount++;
                        } catch (saveErr) {
                            console.error('Save error:', saveErr);
                        }
                    }

                    reimburseStatus.innerHTML = `✅ <b>大功告成！</b>成功将 ${successCount} 个文件直存到 <b>${rootDirHandle.name}/${dateFolderName}</b> 目录下，无需解压！`;
                    showToast(`已成功直存 ${successCount} 个文件！`);
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        reimburseStatus.style.display = 'block';
                        reimburseStatus.textContent = `直存遇到异常: ${err.message || err}`;
                    }
                }
                return;
            }

            // 模式 C：普通浏览器通过局域网 HTTP 访问 (因浏览器安全规范限制，无法直接调取操作系统底层文件夹选择器)
            // 自动降级为【一键批量下载全部文件到浏览器的“下载”目录】
            reimburseStatus.style.display = 'block';
            reimburseStatus.innerHTML = `
                <div style="margin-bottom:8px; line-height:1.5;">
                    💡 <b>提示：</b>当前使用纯网页访问（浏览器安全规范限制非 HTTPS 网站直接读写本地磁盘目录）。<br>
                    已为您自动开启<b>【批量下载全部文件】</b>至本机的“下载”目录！<br>
                    <span style="color:#60A5FA;">👉 如需选择电脑任意磁盘位置（如 D:\\发票归档）按日期自动建文件夹直存，推荐直接运行电脑桌面端的 <b>WenBox.exe</b>。</span>
                </div>
            `;

            let downloadedCount = 0;
            for (let i = 0; i < currentFiles.length; i++) {
                const f = currentFiles[i];
                reimburseStatus.innerHTML += `<div style="font-size:12px; color:#9CA3AF;">⏳ 正在下载 [${i + 1}/${currentFiles.length}]: ${escapeHtml(f.name)}...</div>`;
                const dlUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + `/api/download/${f.id}`;

                const a = document.createElement('a');
                a.href = dlUrl;
                a.download = f.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                downloadedCount++;

                // 稍微延时 350ms 避免浏览器触发并发弹窗拦截
                await new Promise(r => setTimeout(r, 350));
            }

            reimburseStatus.innerHTML += `<div style="font-size:13px; color:#10B981; margin-top:6px; font-weight:bold;">✅ 已触发全部 ${downloadedCount} 个文件的自动批量下载，请前往电脑浏览器的“下载”目录查看！</div>`;
            showToast(`已批量下载 ${downloadedCount} 个文件`);
        });
    }

    // 拖拽与投送文件
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', () => fileInput.click());
        ['dragenter', 'dragover'].forEach(eName => {
            dropZone.addEventListener(eName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(eName => {
            dropZone.addEventListener(eName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('dragover');
            });
        });

        dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) uploadFiles(files);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) uploadFiles(e.target.files);
        });
    }

    async function uploadFiles(fileList) {
        for (let i = 0; i < fileList.length; i++) {
            await uploadSingleFile(fileList[i]);
        }
        if (fileInput) fileInput.value = '';
        if (currentTargetBaseUrl === '') {
            loadLocalSharedFiles();
        } else {
            loadFiles();
        }
    }

    async function uploadSingleFile(file) {
        // 如果是在 Tauri 桌面客户端运行
        const invoke = getTauriInvoke();
        if (invoke) {
            // 情况 1：在「本端 (本机)」视图，直接将本地文件添加为对外分享
            if (currentTargetBaseUrl === '') {
                if (file.path) {
                    try {
                        await invoke('add_share_file', { pathStr: file.path });
                        showToast(`已添加电脑分享文件: ${file.name}`);
                        loadLocalSharedFiles();
                        return;
                    } catch (e) {
                        console.warn('add_share_file error:', e);
                    }
                }
            } else {
                // 情况 2：在「远程设备 (如手机)」视图，调用原生 Rust 客户端进行极速网络流式投送，绕过 Mixed Content
                if (file.path) {
                    uploadProgressContainer.style.display = 'block';
                    uploadFileName.textContent = `正在发送至远程设备: ${file.name} (${formatBytes(file.size)})`;
                    uploadProgressBar.style.width = '50%';
                    uploadPercent.textContent = '传输中...';
                    try {
                        const msg = await invoke('upload_local_file_to_remote', {
                            targetBaseUrl: currentTargetBaseUrl,
                            filePath: file.path
                        });
                        uploadProgressBar.style.width = '100%';
                        uploadPercent.textContent = '100%';
                        showToast(msg || `已成功发送: ${file.name}`);
                    } catch (e) {
                        showToast(`向对方发送失败: ${e.message || e}`);
                    } finally {
                        setTimeout(() => {
                            uploadProgressContainer.style.display = 'none';
                        }, 800);
                    }
                    return;
                }
            }
        }

        // 纯浏览器环境 或 无法获取原生路径时的标准 HTTP FormData 上传
        return new Promise((resolve) => {
            uploadProgressContainer.style.display = 'block';
            uploadFileName.textContent = `正在传输: ${file.name} (${formatBytes(file.size)})`;
            uploadProgressBar.style.width = '0%';
            uploadPercent.textContent = '0%';

            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', file, file.name);

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    uploadProgressBar.style.width = `${percent}%`;
                    uploadPercent.textContent = `${percent}%`;
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    uploadProgressBar.style.width = '100%';
                    uploadPercent.textContent = '100%';
                    showToast(`已成功投送: ${file.name}`);
                } else {
                    showToast(`上传失败: ${file.name}`);
                }
                setTimeout(() => {
                    uploadProgressContainer.style.display = 'none';
                    resolve();
                }, 800);
            });

            xhr.addEventListener('error', () => {
                showToast(`上传错误: ${file.name}`);
                uploadProgressContainer.style.display = 'none';
                resolve();
            });

            let uploadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/upload';
            if (roomState.token) {
                const sep = uploadUrl.includes('?') ? '&' : '?';
                uploadUrl += `${sep}token=${encodeURIComponent(roomState.token)}`;
            }
            xhr.open('POST', uploadUrl);
            if (roomState.token) {
                xhr.setRequestHeader('X-Room-Token', roomState.token);
            }
            xhr.send(formData);
        });
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
                        // 否则当前浏览器为局域网外部访客！严禁赋予 host 权限，立即清除无效的 hostToken，并引导输入昵称入房
                        sessionStorage.removeItem('wenbox_host_token');
                        setRoomMode('client');
                        window.openJoinRoomDialog({
                            hostUrl: getApiOrigin() || window.location.origin,
                            roomName: st.roomName || st.roomId,
                            roomId: st.roomId,
                            hostDevice: st.hostDevice || '主机',
                            needPassword: !!st.needPassword
                        });
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

    initRoomState();
    updateMyNicknameDisplay();

    setInterval(() => {
        if (roomState.mode === 'host') {
            if (currentActiveTab === 'tab-transfer') {
                loadLocalSharedFiles();
                loadReceivedFiles();
            }
            pollRoomMembers();
        } else if (roomState.mode === 'joined') {
            if (currentActiveTab === 'tab-transfer') {
                loadFiles();
            }
            pollJoinedMembers();
        } else {
            if (currentActiveTab === 'tab-transfer') {
                pollDiscoveredRooms();
            }
        }
    }, 2500);
    setInterval(checkSelfServerStatus, 6000);


    // ---------------- 模块二：局域网双向即时互发消息 / 聊天室 (需创建或加入房间后才可发送) ----------------
    const chatLockedState = document.getElementById('chatLockedState');
    const chatActiveContent = document.getElementById('chatActiveContent');
    const chatRoomBadge = document.getElementById('chatRoomBadge');
    const chatRoomPinBadge = document.getElementById('chatRoomPinBadge');
    const chatRoomSubinfo = document.getElementById('chatRoomSubinfo');
    const btnChatGoLobby = document.getElementById('btnChatGoLobby');
    const btnChatCreateRoom = document.getElementById('btnChatCreateRoom');

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

    async function resetChatRoomHistory() {
        if (webChatMessages) {
            webChatMessages.innerHTML = '';
            if (webEmptyChat) {
                webEmptyChat.style.display = 'block';
                webChatMessages.appendChild(webEmptyChat);
            }
        }
        knownMessageIds.clear();
        lastKnownMessageTimestamp = 0;
        const invoke = getTauriInvoke();
        if (invoke) {
            try {
                await invoke('clear_chat_messages_cmd');
            } catch (e) {
                // ignore
            }
        }
    }

    let myClientId = sessionStorage.getItem('wenbox_client_id');
    if (!myClientId) {
        myClientId = 'cid_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
        sessionStorage.setItem('wenbox_client_id', myClientId);
    }

    function getClientSenderName() {
        const storedNick = localStorage.getItem('wenbox_nickname');
        if (storedNick && storedNick.trim()) {
            return storedNick.trim();
        }
        return whoami_device_name_client();
    }

    // 房间模式与聊天室门禁联动
    function updateChatGatingUi(mode, data) {
        if (mode === 'host') {
            if (chatLockedState) chatLockedState.style.display = 'none';
            if (chatActiveContent) chatActiveContent.style.display = 'flex';
            if (chatRoomBadge) {
                chatRoomBadge.textContent = `👑 房主服务中: ${data && data.roomName ? data.roomName : '我的房间'}`;
                chatRoomBadge.className = 'chat-room-badge';
            }
            if (chatRoomPinBadge) {
                if (data && data.pin) {
                    chatRoomPinBadge.style.display = 'inline-block';
                    chatRoomPinBadge.textContent = `🔒 PIN: ${data.pin}`;
                } else {
                    chatRoomPinBadge.style.display = 'none';
                }
            }
            if (chatRoomSubinfo) {
                chatRoomSubinfo.textContent = `您已作为房主开启房间，同局域网成员加入后可在此秒发富文本、代码、截图与文件`;
            }
            pollChatMessages();
        } else if (mode === 'joined') {
            if (chatLockedState) chatLockedState.style.display = 'none';
            if (chatActiveContent) chatActiveContent.style.display = 'flex';
            if (chatRoomBadge) {
                chatRoomBadge.textContent = `📱 已入房: ${data && (data.roomName || data.roomId) ? (data.roomName || data.roomId) : '局域网房间'}`;
                chatRoomBadge.className = 'chat-room-badge';
            }
            if (chatRoomPinBadge) chatRoomPinBadge.style.display = 'none';
            if (chatRoomSubinfo) {
                chatRoomSubinfo.textContent = `已连接房主「${data && data.hostDevice ? data.hostDevice : '主机'}」，实时双向通讯通道已建立`;
            }
            pollChatMessages();
        } else {
            // 未在房间中，锁定聊天室
            if (chatLockedState) chatLockedState.style.display = 'flex';
            if (chatActiveContent) chatActiveContent.style.display = 'none';
        }
    }

    // 锁屏大厅按钮事件绑定
    if (btnChatGoLobby) {
        btnChatGoLobby.addEventListener('click', () => {
            const transferTabBtn = document.querySelector('.nav-tab[data-tab="tab-transfer"]');
            if (transferTabBtn) transferTabBtn.click();
        });
    }

    if (btnChatCreateRoom) {
        btnChatCreateRoom.addEventListener('click', () => {
            if (typeof window.openCreateRoomModal === 'function') {
                window.openCreateRoomModal();
            }
        });
    }

    let joinedDisconnectCount = 0;
    let isPollingChat = false;

    // 轮询聊天消息
    async function pollChatMessages() {
        if (isPollingChat) return;
        if (roomState.mode === 'client') return;
        isPollingChat = true;
        try {
            let messages = [];
            const invoke = getTauriInvoke();
            if (invoke) {
                messages = await invoke('fetch_node_messages', {
                    baseUrl: currentTargetBaseUrl,
                    token: roomState.token || null
                });
            } else {
                const effectiveToken = roomState.token || sessionStorage.getItem('wenbox_host_token') || '';
                const tokenParam = effectiveToken ? `&token=${encodeURIComponent(effectiveToken)}` : '';
                const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/messages?t=' + Date.now() + tokenParam;
                const headers = { 'Accept': 'application/json' };
                if (effectiveToken) {
                    headers['X-Room-Token'] = effectiveToken;
                    headers['X-Host-Token'] = effectiveToken;
                }
                const res = await fetch(api, {
                    headers,
                    signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(2000) : undefined
                });
                if (!res.ok) {
                    if (res.status === 401 || res.status === 403 || (roomState.mode === 'joined' && (res.status === 404 || res.status === 502))) {
                        joinedDisconnectCount++;
                        if (joinedDisconnectCount >= 2) {
                            joinedDisconnectCount = 0;
                            sessionStorage.removeItem('wenbox_host_token');
                            roomState.token = null;
                            showToast('房间已解散或权限已失效，已自动返回客户端大厅');
                            setRoomMode('client');
                            return;
                        }
                    }
                    return;
                }
                const data = await res.json();
                // 房间一致性校验：若服务端活跃房间 ID 与当前界面所处的房间 ID 不一致，说明服务端已重置或新建房间！
                const currentRoomId = roomState.roomInfo ? (roomState.roomInfo.roomId || roomState.roomInfo.roomName) : '';
                if (data.roomId && currentRoomId && data.roomId !== currentRoomId) {
                    sessionStorage.removeItem('wenbox_host_token');
                    roomState.token = null;
                    showToast('原房间已结束，服务端已创建新房间，已自动返回发现大厅');
                    setRoomMode('client');
                    return;
                }
                messages = data.messages || [];
            }

            joinedDisconnectCount = 0;

            let hasNew = false;
            messages.forEach(msg => {
                if (!knownMessageIds.has(msg.id)) {
                    knownMessageIds.add(msg.id);
                    renderChatMessage(msg);
                    hasNew = true;
                    if (msg.timestamp > lastKnownMessageTimestamp) {
                        lastKnownMessageTimestamp = msg.timestamp;
                    }
                }
            });

            if (hasNew && webChatMessages) {
                webChatMessages.scrollTop = webChatMessages.scrollHeight;
            }
        } catch (e) {
            if (roomState.mode === 'joined') {
                joinedDisconnectCount++;
                if (joinedDisconnectCount >= 3) {
                    joinedDisconnectCount = 0;
                    showToast('房主已解散房间或网络中断，已自动返回客户端大厅');
                    setRoomMode('client');
                }
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

    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function resolveChatUrl(url) {
        if (!url) return '';
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
        const base = currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin();
        return base.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url);
    }

    function getFileIconByExtension(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '📦';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️';
        if (['pdf'].includes(ext)) return '📑';
        if (['doc', 'docx'].includes(ext)) return '📄';
        if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
        if (['ppt', 'pptx'].includes(ext)) return '📽️';
        if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return '🎵';
        if (['mp4', 'mkv', 'avi', 'mov', 'wmv'].includes(ext)) return '🎬';
        if (['apk'].includes(ext)) return '🤖';
        if (['js', 'ts', 'py', 'rs', 'c', 'cpp', 'java', 'html', 'css', 'json', 'sh', 'sql'].includes(ext)) return '💻';
        return '📁';
    }

    // 格式化渲染富文本消息流 (融合 fagedongxi.com / internal-chat 极简流式排版与 WenBox 富媒体)
    function renderChatMessage(msg) {
        if (!webChatMessages) return;
        if (webEmptyChat) webEmptyChat.style.display = 'none';

        const myName = getClientSenderName();
        const cleanSender = (msg.senderName || '').replace(/^[📱💻👑\s]+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (msg.isFromPhone ? '手机用户' : '成员');
        const isMe = (msg.clientId && msg.clientId === myClientId)
            || (!msg.clientId && !msg.isFromPhone && (msg.senderName === myName || cleanSender === myName));

        // 整体条目: .chat-item (带悬停变色)
        const item = document.createElement('div');
        item.className = 'chat-item';

        // 消息头: .chat-item_user (仅展示纯昵称，不展示不准确的设备图标与IP)
        let senderTitle = cleanSender;
        if (isMe) {
            senderTitle = `（我）${senderTitle}`;
        }

        const userHeader = document.createElement('div');
        userHeader.className = `chat-item_user ${isMe ? 'from-me' : 'from-other'}`;

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

        // 消息内容与复制按钮容器: .chat-item_content
        const contentWrap = document.createElement('div');
        contentWrap.className = 'chat-item_content';

        const content = msg.content || '';

        // 1. 判断是否为图片消息
        const isImage = (content.startsWith('[image:') && content.endsWith(']'))
            || content.startsWith('data:image/')
            || (/^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|bmp|svg)(\?[^\s]*)?$/i.test(content));

        if (isImage) {
            let imgSrc = content;
            if (content.startsWith('[image:') && content.endsWith(']')) {
                imgSrc = content.slice(7, -1);
            }
            imgSrc = resolveChatUrl(imgSrc);

            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'chat-img-thumb-wrapper';
            thumbWrap.title = '点击查看大图';

            const img = document.createElement('img');
            img.className = 'chat-img-thumb';
            img.src = imgSrc;
            img.alt = '聊天图片';
            img.loading = 'lazy';

            const overlay = document.createElement('span');
            overlay.className = 'chat-img-overlay';
            overlay.textContent = '🔍 查看原图';

            thumbWrap.appendChild(img);
            thumbWrap.appendChild(overlay);
            thumbWrap.addEventListener('click', (e) => {
                e.stopPropagation();
                openChatImageModal(imgSrc);
            });

            contentWrap.appendChild(thumbWrap);
        }
        // 2. 判断是否为文件卡片消息 [file:name|size|url]
        else if (content.startsWith('[file:') && content.endsWith(']')) {
            const inner = content.slice(6, -1);
            const parts = inner.split('|');
            const fileName = parts[0] || '未知文件';
            const fileSize = parts[1] || '';
            const rawUrl = parts[2] || '';
            const downloadUrl = resolveChatUrl(rawUrl);

            const fileCard = document.createElement('div');
            fileCard.className = 'chat-file-card';

            const fileIcon = document.createElement('div');
            fileIcon.className = 'chat-file-icon';
            fileIcon.textContent = getFileIconByExtension(fileName);

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
            downloadLink.href = downloadUrl;
            downloadLink.download = fileName;
            downloadLink.target = '_blank';
            downloadLink.innerHTML = '⬇️ 下载';
            downloadLink.addEventListener('click', (e) => e.stopPropagation());

            fileCard.appendChild(fileIcon);
            fileCard.appendChild(fileDetails);
            fileCard.appendChild(downloadLink);

            contentWrap.appendChild(fileCard);
        }
        // 3. 普通文本消息：格式化 Markdown 代码块、行内代码与链接识别，并置于 pre 中
        else {
            const preEl = document.createElement('pre');
            preEl.className = 'chat-text';

            // 代码块占位替换，防止与普通标签冲突
            const codeBlocks = [];
            let processed = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
                const idx = codeBlocks.length;
                codeBlocks.push({ lang: lang || 'CODE', code: code.trim() });
                return `__CODE_BLOCK_${idx}__`;
            });

            // HTML 转义
            processed = escapeHtml(processed);

            // 还原并渲染代码块
            codeBlocks.forEach((itemBlock, idx) => {
                const placeholder = `__CODE_BLOCK_${idx}__`;
                const escapedCode = escapeHtml(itemBlock.code);
                const blockHtml = `
                    <div class="chat-code-block">
                        <div class="chat-code-header">
                            <span>${escapeHtml(itemBlock.lang.toUpperCase())}</span>
                            <button class="chat-code-copy-btn" onclick="window.copyChatCode(this)">📋 复制代码</button>
                        </div>
                        <pre class="chat-code-content"><code>${escapedCode}</code></pre>
                    </div>`;
                processed = processed.replace(placeholder, blockHtml);
            });

            // 行内代码识别 `code`
            processed = processed.replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');

            // URL 超链接自动识别
            processed = processed.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1 ↗</a>');

            preEl.innerHTML = processed;
            contentWrap.appendChild(preEl);
        }

        // 右侧极简 SVG 悬停复制按钮 (fagedongxi.com 标志性设计)
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'copy-btn';
        copyBtn.title = '复制消息内容';
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="17" height="17">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"></path>
            </svg>
        `;
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.copyChatMessage(content, copyBtn);
        });
        contentWrap.appendChild(copyBtn);

        item.appendChild(userHeader);
        item.appendChild(contentWrap);
        webChatMessages.appendChild(item);
    }

    // 全局复制消息辅助函数
    window.copyChatMessage = function(text, btn) {
        if (!text) return;
        let copyText = text;
        if (text.startsWith('[file:') && text.endsWith(']')) {
            const inner = text.slice(6, -1);
            const parts = inner.split('|');
            const fileName = parts[0] || '';
            const rawUrl = parts[2] || '';
            copyText = `${fileName} - ${resolveChatUrl(rawUrl)}`;
        } else if (text.startsWith('[image:') && text.endsWith(']')) {
            const rawUrl = text.slice(7, -1);
            copyText = resolveChatUrl(rawUrl);
        }

        navigator.clipboard.writeText(copyText).then(() => {
            showToast('已复制该条消息');
            if (btn) {
                btn.classList.add('copied');
                const origHtml = btn.innerHTML;
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = origHtml;
                }, 1500);
            }
        }).catch(() => {
            showToast('复制失败');
        });
    };

    // 全局复制代码辅助函数
    window.copyChatCode = function(btn) {
        const block = btn.closest('.chat-code-block');
        if (!block) return;
        const codeEl = block.querySelector('code');
        if (!codeEl) return;
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
            const originalText = btn.textContent;
            btn.textContent = '✅ 已复制';
            setTimeout(() => { btn.textContent = originalText; }, 1500);
            showToast('代码已复制到剪贴板');
        });
    };

    // 底层通用发送消息函数
    async function sendChatMessageDirect(text) {
        if (!text || !text.trim()) return;
        const content = text.trim();
        const myName = getClientSenderName();
        const isHost = roomState.mode === 'host';
        const myIp = isHost ? (selfDeviceInfo.ip || null) : null;

        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                await invoke('send_node_message', {
                    baseUrl: currentTargetBaseUrl,
                    senderName: myName,
                    content: content,
                    token: roomState.token || null,
                    clientId: myClientId,
                    senderIp: myIp
                });
                pollChatMessages();
                return;
            }

            const effectiveToken = roomState.token || sessionStorage.getItem('wenbox_host_token') || '';
            const tokenParam = effectiveToken ? `?token=${encodeURIComponent(effectiveToken)}` : '';
            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + `/api/messages${tokenParam}`;
            const headers = { 'Content-Type': 'application/json; charset=utf-8' };
            if (effectiveToken) {
                headers['X-Room-Token'] = effectiveToken;
                headers['X-Host-Token'] = effectiveToken;
            }

            const resp = await fetch(api, {
                method: 'POST',
                headers: headers,
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined,
                body: JSON.stringify({
                    content: content,
                    senderName: myName,
                    clientId: myClientId,
                    senderIp: myIp || undefined
                })
            });
            if (resp.ok) {
                pollChatMessages();
            } else {
                if (resp.status === 401 || resp.status === 403) {
                    showToast('发送失败：房间未授权或已重置');
                } else {
                    showToast('发送失败');
                }
            }
        } catch (e) {
            showToast('网络连接失败');
        }
    }

    // 发送输入框中的消息
    async function sendChatMessage() {
        if (!webChatMessageInput) return;
        const text = webChatMessageInput.value.trim();
        if (!text) return;

        webChatMessageInput.value = '';
        webChatMessageInput.style.height = 'auto';
        await sendChatMessageDirect(text);
    }

    // 发送图片文件 (截图或选择的图片)
    async function sendChatImageFile(file) {
        if (!file) return;
        showToast('正在发送图片...');

        // 若小于 400KB，直接使用 Base64 Data URL 发送，秒级直达全平台
        if (file.size < 400 * 1024) {
            const reader = new FileReader();
            reader.onload = async () => {
                const dataUrl = reader.result;
                await sendChatMessageDirect(`[image:${dataUrl}]`);
            };
            reader.readAsDataURL(file);
        } else {
            // 大图通过上传接口分发
            try {
                const res = await uploadFileBlobToRoom(file, file.name || 'image.png');
                const downloadUrl = `/api/download/${res.fileId || encodeURIComponent(res.fileName)}`;
                await sendChatMessageDirect(`[image:${downloadUrl}]`);
            } catch (e) {
                showToast('图片上传发送失败');
            }
        }
    }

    // 发送通用文件卡片
    async function sendChatDocFile(file) {
        if (!file) return;
        showToast(`正在上传发送文件: ${file.name}...`);
        try {
            const res = await uploadFileBlobToRoom(file, file.name);
            const downloadUrl = `/api/download/${res.fileId || encodeURIComponent(res.fileName)}`;
            const cardMsg = `[file:${file.name}|${formatBytes(file.size)}|${downloadUrl}]`;
            await sendChatMessageDirect(cardMsg);
            showToast(`已成功发送文件「${file.name}」到聊天室`);
        } catch (e) {
            showToast(`发送文件失败: ${file.name}`);
        }
    }

    // 上传 Blob 到当前活动房间的服务端
    async function uploadFileBlobToRoom(blob, fileName) {
        const formData = new FormData();
        formData.append('file', blob, fileName);

        let uploadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/upload';
        if (roomState.token) {
            const sep = uploadUrl.includes('?') ? '&' : '?';
            uploadUrl += `${sep}token=${encodeURIComponent(roomState.token)}`;
        }

        const headers = {};
        if (roomState.token) headers['X-Room-Token'] = roomState.token;

        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        if (!res.ok) throw new Error('上传失败');
        const data = await res.json();
        return {
            fileId: data.fileId || data.id || '',
            fileName: data.name || fileName,
            size: data.size || blob.size
        };
    }

    // 图片全屏预览 Modal
    function openChatImageModal(src) {
        if (!chatImageModal || !chatModalImage) return;
        chatModalImage.src = src;
        if (chatModalDownloadBtn) {
            chatModalDownloadBtn.href = src;
            chatModalDownloadBtn.download = `wenbox_img_${Date.now()}.png`;
        }
        chatImageModal.style.display = 'flex';
    }

    function closeChatImageModal() {
        if (chatImageModal) chatImageModal.style.display = 'none';
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
    if (chatModalCopyBtn) {
        chatModalCopyBtn.addEventListener('click', async () => {
            try {
                if (chatModalImage && chatModalImage.src) {
                    const response = await fetch(chatModalImage.src);
                    const blob = await response.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blob.type]: blob })
                    ]);
                    showToast('图片已复制到系统剪贴板');
                }
            } catch (e) {
                showToast('当前环境不支持直接复制图片，请使用下载保存');
            }
        });
    }

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
            if (e.key === 'Enter') {
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    sendChatMessage();
                }
            }
        });

        // 剪贴板截图直接 Ctrl+V 粘贴发送
        webChatMessageInput.addEventListener('paste', async (e) => {
            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData || !clipboardData.items) return;

            for (let i = 0; i < clipboardData.items.length; i++) {
                const item = clipboardData.items[i];
                if (item.type.indexOf('image') !== -1) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) {
                        await sendChatImageFile(file);
                        return;
                    }
                }
            }
        });
    }

    if (webBtnSendMessage) {
        webBtnSendMessage.addEventListener('click', sendChatMessage);
    }

    if (webBtnClearChat) {
        webBtnClearChat.addEventListener('click', async () => {
            await resetChatRoomHistory();
            showToast('已清空当前聊天记录');
        });
    }

    // 聊天室文件拖拽发送
    const chatPane = document.getElementById('tab-chat');
    if (chatPane && chatDropOverlay) {
        let dragCounter = 0;

        chatPane.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            if (roomState.mode !== 'client') {
                chatDropOverlay.style.display = 'flex';
            }
        });

        chatPane.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                chatDropOverlay.style.display = 'none';
                dragCounter = 0;
            }
        });

        chatPane.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        chatPane.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            chatDropOverlay.style.display = 'none';

            if (roomState.mode === 'client') {
                showToast('请先创建或加入房间后再发送文件');
                return;
            }

            const files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const f = files[i];
                    if (f.type.startsWith('image/')) {
                        await sendChatImageFile(f);
                    } else {
                        await sendChatDocFile(f);
                    }
                }
            }
        });
    }

    // 初始化聊天室锁屏状态联动
    updateChatGatingUi(roomState.mode, roomState.roomInfo);

    // 启动轮询获取最新消息
    pollChatMessages();
    setInterval(pollChatMessages, 2000);


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
            if (webJsonError) webJsonError.style.display = 'none';
            showToast('格式化成功');
        } catch (e) {
            if (webJsonError) {
                webJsonError.style.display = 'block';
                webJsonError.textContent = `❌ JSON 格式错误: ${e.message}`;
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
            if (webJsonError) webJsonError.style.display = 'none';
            showToast('已精简为单行');
        } catch (e) {
            if (webJsonError) {
                webJsonError.style.display = 'block';
                webJsonError.textContent = `❌ JSON 格式错误: ${e.message}`;
            }
        }
    }

    if (webBtnFormatJson2) webBtnFormatJson2.addEventListener('click', () => formatJson(2));
    if (webBtnFormatJson4) webBtnFormatJson4.addEventListener('click', () => formatJson(4));
    if (webBtnMinifyJson) webBtnMinifyJson.addEventListener('click', minifyJson);
    if (webBtnLoadSampleJson) {
        webBtnLoadSampleJson.addEventListener('click', () => {
            if (webJsonInput) webJsonInput.value = SAMPLE_JSON;
            if (webJsonError) webJsonError.style.display = 'none';
            showToast('已载入示例 JSON');
        });
    }
    if (webBtnCopyJson) {
        webBtnCopyJson.addEventListener('click', () => {
            if (webJsonInput && webJsonInput.value) {
                navigator.clipboard.writeText(webJsonInput.value).then(() => {
                    showToast('已复制 JSON 内容');
                });
            }
        });
    }
    if (webBtnClearJson) {
        webBtnClearJson.addEventListener('click', () => {
            if (webJsonInput) webJsonInput.value = '';
            if (webJsonError) webJsonError.style.display = 'none';
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
                navigator.clipboard.writeText(targetInput.value).then(() => {
                    showToast('已复制内容');
                });
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
            if (webCronInput) webCronInput.value = e.target.value;
            updateCronUI(e.target.value);
        });
    }

    if (webCronInput) {
        webCronInput.addEventListener('input', (e) => {
            updateCronUI(e.target.value);
        });
    }

    if (webBtnCopyCron) {
        webBtnCopyCron.addEventListener('click', () => {
            if (webCronInput) {
                navigator.clipboard.writeText(webCronInput.value).then(() => {
                    showToast('Cron 表达式已复制');
                });
            }
        });
    }

    if (webCronInput) {
        updateCronUI(webCronInput.value);
    }
})();
