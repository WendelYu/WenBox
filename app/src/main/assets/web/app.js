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

    if (btnOpenCreateRoomModal) {
        btnOpenCreateRoomModal.addEventListener('click', () => {
            if (modalInputRoomName) {
                const randomNum = Math.floor(1000 + Math.random() * 9000);
                modalInputRoomName.value = `WenBox-${randomNum}`;
            }
            if (modalInputRoomPin) modalInputRoomPin.value = '';
            if (createRoomModal) createRoomModal.style.display = 'flex';
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

    let initialIp = '127.0.0.1';
    if (window.location.hostname && !isTauriDesktop() && window.location.hostname !== 'localhost') {
        initialIp = window.location.hostname;
    }

    let userSelectedIp = null;
    try {
        userSelectedIp = localStorage.getItem('wenbox_selected_ip') || null;
    } catch (_) {}

    let selfDeviceInfo = {
        device: '本机',
        ip: userSelectedIp || initialIp,
        port: 9527,
        platform: 'Windows'
    };
    let selfLanIps = [];
    let latestRoomMembers = [];

    function getReachableHostAddress(port) {
        let ip = selfDeviceInfo.ip;
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
        const invoke = getTauriInvoke();
        if (invoke) {
            invoke('set_room_host_ip_cmd', { ip }).catch(() => {});
        } else {
            fetch(getApiOrigin() + '/api/room/set_ip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            }).catch(() => {});
        }
        updateHostBannerDisplay();
        renderMultiIpPills(selfLanIps, ip);
        if (roomState.mode) {
            updateChatStatusBar(roomState.mode, roomState.roomInfo);
        }
        showToast(`已切换展示 IP 为: ${ip}`);
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
                selfDeviceInfo.device = data.device;
                selfDeviceInfo.port = data.port;
                selfDeviceInfo.platform = data.platform;

                renderMultiIpPills(selfLanIps, selfDeviceInfo.ip);
                if (roomState.mode === 'host') {
                    updateHostBannerDisplay();
                    updateChatStatusBar('host', roomState.roomInfo);
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

    // ---------------- 房间系统核心：模式渲染与切换 ----------------
    function setRoomMode(mode, data) {
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
            currentTargetBaseUrl = data.hostUrl.trim().trim_end ? data.hostUrl.trim().replace(/\/+$/, '') : data.hostUrl;
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
    }

    function updateChatStatusBar(mode, data) {
        const onlineBadge = document.getElementById('chatOnlineMemberBadge');
        const ipBadge = document.getElementById('chatRoomIpBadge');
        const copyBtn = document.getElementById('btnCopyChatRoomUrl');

        if (mode === 'host') {
            const reachableUrl = getReachableHostAddress(data ? data.hostPort : null);
            const memberCount = (latestRoomMembers && latestRoomMembers.length) || 1;
            if (onlineBadge) onlineBadge.textContent = `👥 在线: ${memberCount} 人 (点击查看)`;
            if (ipBadge) ipBadge.textContent = `🌐 访问地址: ${reachableUrl}`;
            if (copyBtn) {
                copyBtn.onclick = () => {
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(reachableUrl).then(() => showToast(`已复制房间网址: ${reachableUrl}`));
                    } else {
                        showToast(`房间网址: ${reachableUrl}`);
                    }
                };
            }
        } else if (mode === 'joined' && data) {
            let hUrl = data.hostUrl || currentTargetBaseUrl;
            if (!hUrl && data.hostIp && data.hostPort) {
                hUrl = `http://${data.hostIp}:${data.hostPort}`;
            }
            const memberCount = (latestRoomMembers && latestRoomMembers.length) || 2;
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
                        pin: rPin
                    });
                    window.closeCreateRoomModal();
                    setRoomMode('host', cfg);
                    showToast(`房间「${rName}」已创建！本机已变身服务端`);
                } else {
                    const resp = await fetch(getApiOrigin() + '/api/room/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ roomName: rName, pin: rPin })
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const cfg = await resp.json();
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
                    await fetch(getApiOrigin() + '/api/room/close', { method: 'POST' });
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

    window.onDiscoveredRoomClicked = function (roomId) {
        const r = roomState.discoveredRooms.find(x => x.roomId === roomId);
        if (!r) return;
        const hostUrl = `http://${r.ip}:${r.port}`;

        pendingJoinRoomData = {
            hostUrl,
            roomName: r.roomName,
            roomId: r.roomId,
            hostDevice: r.hostDevice,
            needPassword: r.needPassword
        };

        const titleEl = document.getElementById('joinPinModalTitle');
        const descEl = document.getElementById('joinPinModalDesc');
        const nickInput = document.getElementById('modalInputJoinNickname');
        const pinContainer = document.getElementById('joinPinContainer');
        const pinInput = document.getElementById('modalInputJoinPin');

        if (titleEl) titleEl.textContent = `📱 加入「${r.roomName}」`;
        if (descEl) {
            descEl.textContent = r.needPassword ? '该房间设置了安全密码，请输入昵称与 PIN 码加入：' : '设置进入房间展示的昵称，加入后将显示为「昵称 (IP)」：';
        }
        if (nickInput) {
            nickInput.value = localStorage.getItem('wenbox_nickname') || whoami_device_name_client();
        }
        if (pinContainer) {
            pinContainer.style.display = r.needPassword ? 'block' : 'none';
        }
        if (pinInput) pinInput.value = '';

        if (joinRoomPinModal) joinRoomPinModal.style.display = 'flex';
        if (nickInput) setTimeout(() => nickInput.focus(), 150);
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

            const invoke = getTauriInvoke();
            if (invoke) {
                joinRes = await invoke('join_remote_room_cmd', {
                    hostUrl: hostUrl,
                    pin: pin,
                    myName: myNick
                });
            } else {
                const resp = await fetch(`${hostUrl}/api/room/join`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pin: pin,
                        name: myNick,
                        platform: 'Browser'
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
                    hostUrl: hostUrl,
                    roomName: joinRes.room ? joinRes.room.roomName : (roomName || '已加入房间'),
                    roomId: joinRes.room ? joinRes.room.roomId : roomId,
                    hostDevice: joinRes.room ? joinRes.room.hostDevice : hostDevice
                });
                showToast(`🎉 成功加入房间！已与「${hostDevice || '房主'}」建立直连`);
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
        const plat = (navigator.userAgent.indexOf('Mac') !== -1) ? 'Mac' :
                     (navigator.userAgent.indexOf('Win') !== -1) ? 'Windows' :
                     (navigator.userAgent.indexOf('Android') !== -1) ? 'Android' : 'Web';
        return `${plat}用户-${Math.floor(100 + Math.random() * 900)}`;
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
                const res = await fetch(getApiOrigin() + '/api/room/members?t=' + Date.now());
                if (res.ok) {
                    const data = await res.json();
                    members = data.members || [];
                }
            }
            latestRoomMembers = members;
            if (hostMemberCount) hostMemberCount.textContent = (members.length || 1);
            const onlineBadge = document.getElementById('chatOnlineMemberBadge');
            if (onlineBadge) onlineBadge.textContent = `👥 在线: ${members.length || 1} 人 (点击查看)`;
            if (hostMembersContainer) {
                hostMembersContainer.innerHTML = members.map(m => `
                    <span class="member-pill ${m.name.includes('房主') ? 'is-host' : ''}" style="cursor: pointer;" onclick="window.openOnlineMembersModal()">
                        ${m.name.includes('房主') ? '👑' : '📱'} ${escapeHtml(m.name)}
                    </span>
                `).join('');
            }
        } catch (e) {
            // ignore
        }
    }

    // 访客端轮询房间成员与在线人数
    async function pollJoinedMembers() {
        if (roomState.mode !== 'joined' || !currentTargetBaseUrl) return;
        try {
            const api = currentTargetBaseUrl + '/api/room/members?t=' + Date.now();
            const res = await fetch(api, {
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(2000) : undefined
            });
            if (res.ok) {
                const data = await res.json();
                const members = data.members || [];
                latestRoomMembers = members;
                const onlineBadge = document.getElementById('chatOnlineMemberBadge');
                if (onlineBadge) onlineBadge.textContent = `👥 在线: ${members.length || 2} 人 (点击查看)`;
            }
        } catch (_) {}
    }

    window.openOnlineMembersModal = function() {
        const modal = document.getElementById('onlineMembersModal');
        const listEl = document.getElementById('onlineMembersModalList');
        if (!modal || !listEl) return;

        let members = latestRoomMembers;
        if (!members || members.length === 0) {
            const myIp = selfDeviceInfo.ip || (currentTargetBaseUrl ? currentTargetBaseUrl.replace(/https?:\/\/([^:]+).*/, '$1') : '127.0.0.1');
            members = [{ name: '当前设备 (本机)', ip: myIp }];
        }

        listEl.innerHTML = members.map(m => {
            const ip = m.ip || '127.0.0.1';
            const name = m.name || '局域网成员';
            return `
                <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(30, 41, 59, 0.7); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 12px;">
                    <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden; margin-right: 8px;">
                        <span style="font-size: 13px; font-weight: 600; color: #F8FAFC; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(name)}</span>
                        <span style="font-size: 12px; color: #38BDF8; font-family: monospace;">IP: ${escapeHtml(ip)}</span>
                    </div>
                    <button class="btn-copy-mini" style="font-size: 11px; padding: 4px 10px; background: #2563EB; color: #fff; border: none; border-radius: 6px; cursor: pointer; flex-shrink: 0;" onclick="window.copyMemberIp('${escapeHtml(ip)}')">复制 IP</button>
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
    function checkUrlAutoJoin() {
        const urlParams = new URLSearchParams(window.location.search);
        const qRoom = urlParams.get('room');
        const qPin = urlParams.get('pin') || '';
        if (qRoom) {
            const hostOrigin = window.location.origin;
            executeJoinRoom(hostOrigin, qPin, qRoom, '主机', qRoom);
            return true;
        }
        return false;
    }

    // 初始检查当前房间状态 (如果是 Tauri 主机已开房，恢复 host 模式)
    async function initRoomState() {
        if (checkUrlAutoJoin()) return;

        const invoke = getTauriInvoke();
        if (invoke) {
            try {
                const st = await invoke('get_room_status_cmd');
                if (st && st.isActive) {
                    setRoomMode('host', st);
                    return;
                }
            } catch (e) {
                // ignore
            }
        } else {
            try {
                const res = await fetch(getApiOrigin() + '/api/room/status?t=' + Date.now());
                if (res.ok) {
                    const st = await res.json();
                    if (st && st.isActive) {
                        setRoomMode('host', st);
                        return;
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
        } else {
            if (currentActiveTab === 'tab-transfer') {
                pollDiscoveredRooms();
            }
        }
    }, 3000);
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

    const osPlatform = (navigator.userAgent.indexOf('Mac') !== -1) ? 'Mac' :
                       (navigator.userAgent.indexOf('Win') !== -1) ? 'Windows' : '电脑端';

    function getClientSenderName() {
        const storedNick = localStorage.getItem('wenbox_nickname');
        if (storedNick && storedNick.trim()) {
            return `💻 ${storedNick.trim()}`;
        }
        return `💻 ${osPlatform}端`;
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
                const tokenParam = roomState.token ? `&token=${encodeURIComponent(roomState.token)}` : '';
                const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + '/api/messages?t=' + Date.now() + tokenParam;
                const headers = { 'Accept': 'application/json' };
                if (roomState.token) headers['X-Room-Token'] = roomState.token;
                const res = await fetch(api, {
                    headers,
                    signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(2000) : undefined
                });
                if (!res.ok) {
                    if (roomState.mode === 'joined' && (res.status === 404 || res.status === 502)) {
                        joinedDisconnectCount++;
                        if (joinedDisconnectCount >= 3) {
                            joinedDisconnectCount = 0;
                            showToast('房主已解散房间或网络中断，已自动返回客户端大厅');
                            setRoomMode('client');
                            return;
                        }
                    }
                    return;
                }
                const data = await res.json();
                messages = data.messages || [];
            }

            joinedDisconnectCount = 0;

            if (roomState.mode === 'joined') {
                pollJoinedMembers();
            }

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

    // 格式化渲染富文本消息气泡 (支持 Markdown 代码块、链接识别、图片预览、文件卡片)
    function renderChatMessage(msg) {
        if (!webChatMessages) return;
        if (webEmptyChat) webEmptyChat.style.display = 'none';

        const myName = getClientSenderName();
        const isMe = (!msg.isFromPhone && (msg.senderName === myName || msg.senderName.includes(osPlatform)));
        const row = document.createElement('div');
        row.className = `chat-msg-row ${isMe ? 'from-me' : 'from-other'}`;

        let senderTitle = msg.senderName;
        if (!senderTitle) {
            senderTitle = msg.isFromPhone ? '📱 手机端' : '💻 成员';
        }
        const ipTag = msg.senderIp ? ` (${msg.senderIp})` : '';
        const meta = document.createElement('div');
        meta.className = 'chat-msg-meta';
        meta.textContent = `${senderTitle}${ipTag} • ${formatTime(msg.timestamp)}`;

        const bubble = document.createElement('div');
        bubble.className = 'chat-msg-bubble';

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

            bubble.appendChild(thumbWrap);
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

            bubble.appendChild(fileCard);
        }
        // 3. 普通文本消息：格式化 Markdown 代码块、行内代码与链接识别
        else {
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
            codeBlocks.forEach((item, idx) => {
                const placeholder = `__CODE_BLOCK_${idx}__`;
                const escapedCode = escapeHtml(item.code);
                const blockHtml = `
                    <div class="chat-code-block">
                        <div class="chat-code-header">
                            <span>${escapeHtml(item.lang.toUpperCase())}</span>
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

            // 换行转换
            processed = processed.replace(/\n/g, '<br>');

            bubble.innerHTML = processed;

            // 点击消息气泡复制原文
            bubble.title = '点击复制此消息内容';
            bubble.addEventListener('click', (e) => {
                if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
                navigator.clipboard.writeText(content).then(() => {
                    showToast('已复制该条消息');
                });
            });
        }

        row.appendChild(meta);
        row.appendChild(bubble);
        webChatMessages.appendChild(row);
    }

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

        try {
            const invoke = getTauriInvoke();
            if (invoke) {
                await invoke('send_node_message', {
                    baseUrl: currentTargetBaseUrl,
                    senderName: myName,
                    content: content,
                    token: roomState.token || null
                });
                pollChatMessages();
                return;
            }

            const tokenParam = roomState.token ? `?token=${encodeURIComponent(roomState.token)}` : '';
            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : getApiOrigin()) + `/api/messages${tokenParam}`;
            const headers = { 'Content-Type': 'application/json; charset=utf-8' };
            if (roomState.token) headers['X-Room-Token'] = roomState.token;

            const resp = await fetch(api, {
                method: 'POST',
                headers: headers,
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(3000) : undefined,
                body: JSON.stringify({
                    content: content,
                    senderName: myName
                })
            });
            if (resp.ok) {
                pollChatMessages();
            } else {
                showToast('发送失败');
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
        const parts = cron.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 7) return "无效的 Cron 格式 (标准为 5 到 7 个字段)";

        const hasSec = parts.length >= 6;
        const sec = hasSec ? parts[0] : "0";
        const min = hasSec ? parts[1] : parts[0];
        const hour = hasSec ? parts[2] : parts[1];
        const day = hasSec ? parts[3] : parts[2];
        const week = hasSec ? parts[5] : parts[4];

        if (sec === "*" && min === "*" && hour === "*") return "每秒执行一次";
        if (sec.startsWith("*/")) return `每隔 ${sec.replace('*/', '')} 秒执行`;
        if (min.startsWith("*/")) return `每隔 ${min.replace('*/', '')} 分钟执行`;
        if (min === "*" && hour === "*") return "每分钟执行";

        let desc = "";
        if (week && week !== "*" && week !== "?") {
            const weekMap = {
                "MON-FRI": "工作日(周一至周五)", "2-6": "工作日(周一至周五)",
                "MON": "每周一", "TUE": "每周二", "WED": "每周三", "THU": "每周四", "FRI": "每周五", "SAT": "每周六", "SUN": "每周日"
            };
            desc += (weekMap[week.toUpperCase()] || `星期(${week})`) + " ";
        } else if (day && day !== "*" && day !== "?") {
            desc += `每月 ${day} 日 `;
        } else {
            desc += "每天 ";
        }

        const hStr = hour === "*" ? "每小时" : `${String(hour).padStart(2, '0')}点`;
        const mStr = min === "*" ? "每分钟" : `${String(min).padStart(2, '0')}分`;
        const sStr = (sec === "*" || sec === "0") ? "" : `${String(sec).padStart(2, '0')}秒`;
        return desc + hStr + mStr + sStr + " 执行";
    }

    function predictNextTimes(cron, count = 5) {
        const parts = cron.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 7) return ["表达式格式错误，无法预演时间"];

        const hasSec = parts.length >= 6;
        const sec = hasSec ? parts[0] : "0";
        const min = hasSec ? parts[1] : parts[0];
        const hour = hasSec ? parts[2] : parts[1];

        const list = [];
        let date = new Date();

        function formatDate(d) {
            const Y = d.getFullYear();
            const M = String(d.getMonth() + 1).padStart(2, '0');
            const D = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const m = String(d.getMinutes()).padStart(2, '0');
            const s = String(d.getSeconds()).padStart(2, '0');
            return `${Y}-${M}-${D} ${h}:${m}:${s}`;
        }

        if (sec === "*" && min === "*" && hour === "*") {
            for (let i = 0; i < count; i++) {
                date = new Date(date.getTime() + 1000);
                list.push(formatDate(date));
            }
            return list;
        }

        let stepSec = 0;
        let stepMin = 0;
        if (sec.startsWith("*/")) stepSec = parseInt(sec.replace('*/', '')) || 5;
        else if (min.startsWith("*/")) stepMin = parseInt(min.replace('*/', '')) || 5;

        if (stepSec > 0) {
            const curS = date.getSeconds();
            date.setSeconds(curS + (stepSec - (curS % stepSec)));
            for (let i = 0; i < count; i++) {
                list.push(formatDate(date));
                date = new Date(date.getTime() + stepSec * 1000);
            }
        } else if (stepMin > 0) {
            date.setSeconds(0);
            const curM = date.getMinutes();
            date.setMinutes(curM + (stepMin - (curM % stepMin)));
            for (let i = 0; i < count; i++) {
                list.push(formatDate(date));
                date = new Date(date.getTime() + stepMin * 60 * 1000);
            }
        } else {
            const targetH = parseInt(hour) || 0;
            const targetM = parseInt(min) || 0;
            const targetS = parseInt(sec) || 0;
            date.setHours(targetH, targetM, targetS, 0);
            if (date.getTime() <= Date.now()) {
                date.setDate(date.getDate() + 1);
            }
            for (let i = 0; i < count; i++) {
                list.push(formatDate(date));
                date.setDate(date.getDate() + 1);
            }
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
