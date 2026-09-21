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

    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            navTabs.forEach(t => t.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetId = tab.getAttribute('data-tab');
            const targetPane = document.getElementById(targetId);
            if (targetPane) targetPane.classList.add('active');
        });
    });

    // ---------------- 当前目标服务端 BaseURL (支持局域网多设备节点切换) ----------------
    let currentTargetBaseUrl = ''; // 默认为本端(相对路径)，切换节点时形如 "http://192.168.1.120:9527"
    let currentTargetDeviceName = '本端直连';

    const deviceListContainer = document.getElementById('deviceListContainer');
    const customTargetIp = document.getElementById('customTargetIp');
    const btnConnectCustomIp = document.getElementById('btnConnectCustomIp');
    const currentViewingDeviceTitle = document.getElementById('currentViewingDeviceTitle');
    const phoneNameBadge = document.getElementById('phoneName');

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

    // ---------------- 检查自身服务端状态与真实 IP ----------------
    let selfDeviceInfo = {
        device: '本机',
        ip: window.location.hostname || '127.0.0.1',
        port: 9527,
        platform: 'Windows'
    };

    async function checkSelfServerStatus() {
        // 如果是在 Tauri 桌面客户端运行
        if (window.__TAURI__) {
            try {
                const ip = await window.__TAURI__.invoke('get_local_ip');
                selfDeviceInfo.ip = ip;
                if (phoneNameBadge) {
                    phoneNameBadge.innerHTML = `🟢 本机已开服: <b style="color:#60A5FA;">http://${ip}:9527</b> (其他设备可直接访问)`;
                }
            } catch (e) {
                // fallback
            }
            return;
        }

        // 浏览器环境
        try {
            const res = await fetch('/api/status?t=' + Date.now());
            if (res.ok) {
                const data = await res.json();
                selfDeviceInfo = data;
                if (phoneNameBadge) {
                    phoneNameBadge.innerHTML = `🟢 服务运行中: <b style="color:#60A5FA;">http://${data.ip}:${data.port}</b>`;
                }
            } else {
                if (phoneNameBadge) {
                    phoneNameBadge.innerHTML = `🟢 服务运行中: <b style="color:#60A5FA;">${window.location.host}</b>`;
                }
            }
        } catch (e) {
            if (phoneNameBadge) {
                phoneNameBadge.innerHTML = `🟢 服务运行中: <b style="color:#60A5FA;">${window.location.host}</b>`;
            }
        }
    }

    // ---------------- 局域网在线设备自发现与节点切换 ----------------
    let knownDevices = [];

    function mergeKnownDevices(newDevs) {
        const map = new Map();
        // 现存设备先进入 map
        knownDevices.forEach(d => {
            map.set(`${d.ip}:${d.port}`, d);
        });
        // 用新获取到的设备覆盖/更新
        newDevs.forEach(d => {
            map.set(`${d.ip}:${d.port}`, d);
        });
        knownDevices = Array.from(map.values());
        renderDeviceList();
    }

    async function pollLanDevices() {
        try {
            if (window.__TAURI__) {
                const devs = await window.__TAURI__.invoke('get_lan_devices');
                mergeKnownDevices(devs || []);
                return;
            }
            const res = await fetch('/api/devices?t=' + Date.now());
            if (res.ok) {
                const data = await res.json();
                mergeKnownDevices(data.devices || []);
            }
        } catch (e) {
            // ignore
        }
    }

    function renderDeviceList() {
        if (!deviceListContainer) return;
        const selfCard = `
            <div class="device-card ${currentTargetBaseUrl === '' ? 'active' : ''}" onclick="window.switchDeviceNode('', '本端 (本机)')">
                <div class="device-info-left">
                    <span class="device-platform-icon">🏠</span>
                    <div>
                        <div class="device-name-text">本端设备 (本机已开服)</div>
                        <div class="device-ip-badge">http://${selfDeviceInfo.ip}:${selfDeviceInfo.port}</div>
                    </div>
                </div>
                <span class="device-status-badge">当前直连</span>
            </div>
        `;

        const remoteCards = knownDevices.map(d => {
            const url = `http://${d.ip}:${d.port}`;
            const isAct = currentTargetBaseUrl === url;
            const icon = d.platform === 'Android' ? '📱' : '💻';
            return `
                <div class="device-card ${isAct ? 'active' : ''}" onclick="window.switchDeviceNode('${url}', '${escapeHtml(d.name)}')">
                    <div class="device-info-left">
                        <span class="device-platform-icon">${icon}</span>
                        <div>
                            <div class="device-name-text">${escapeHtml(d.name)}</div>
                            <div class="device-ip-badge">${d.ip}:${d.port}</div>
                        </div>
                    </div>
                    <span class="device-status-badge">在线</span>
                </div>
            `;
        }).join('');

        deviceListContainer.innerHTML = selfCard + remoteCards;
    }

    window.switchDeviceNode = function (baseUrl, name) {
        currentTargetBaseUrl = baseUrl;
        currentTargetDeviceName = name;
        if (currentViewingDeviceTitle) {
            currentViewingDeviceTitle.textContent = `📂 待拉取文件列表 (来自: ${name} ${baseUrl || '本端'})`;
        }
        renderDeviceList();
        loadFiles();
        if (typeof pollChatMessages === 'function') pollChatMessages();
        showToast(`已切换至节点: ${name}`);
    };

    if (btnConnectCustomIp && customTargetIp) {
        btnConnectCustomIp.addEventListener('click', async () => {
            const rawIp = customTargetIp.value.trim();
            if (!rawIp) {
                showToast('请输入目标设备的 IP 地址');
                return;
            }

            btnConnectCustomIp.disabled = true;
            btnConnectCustomIp.textContent = '连接中...';

            try {
                if (window.__TAURI__) {
                    // Tauri 原生模式：通过 Rust 直连探测，绕过 Mixed Content 限制
                    const dev = await window.__TAURI__.invoke('connect_device_node', { target: rawIp });
                    const targetUrl = `http://${dev.ip}:${dev.port}`;
                    mergeKnownDevices([dev]);
                    window.switchDeviceNode(targetUrl, dev.name);
                    showToast(`已成功连接至: ${dev.name} (${dev.ip})`);
                } else {
                    // 纯浏览器模式
                    let base = rawIp;
                    if (!base.startsWith('http://') && !base.startsWith('https://')) {
                        base = 'http://' + base;
                    }
                    if (!base.includes(':', 7)) {
                        base = base + ':9527';
                    }
                    base = base.replace(/\/+$/, '');

                    const probeRes = await fetch(base + '/api/status?t=' + Date.now());
                    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status}`);
                    const devInfo = await probeRes.json();
                    const dev = {
                        name: devInfo.device || '局域网设备',
                        ip: devInfo.ip || rawIp,
                        port: devInfo.port || 9527,
                        platform: devInfo.platform || 'Android',
                        lastSeen: Date.now()
                    };
                    mergeKnownDevices([dev]);
                    window.switchDeviceNode(base, dev.name);
                    showToast(`已成功连接至: ${dev.name}`);
                }
            } catch (err) {
                console.error('手动连接错误:', err);
                alert(`连接失败: ${err.message || err}\n\n排查建议：\n1. 请确认两台设备连接在同一个 WiFi 局域网（关闭路由器的访客隔离）\n2. 确认手机端 WenBox 传输服务已开启\n3. 检查填写的手机 IP 是否完全正确`);
            } finally {
                btnConnectCustomIp.disabled = false;
                btnConnectCustomIp.textContent = '连接设备';
            }
        });
    }

    async function loadFiles() {
        try {
            if (window.__TAURI__) {
                currentFiles = await window.__TAURI__.invoke('fetch_node_files', { baseUrl: currentTargetBaseUrl });
                renderFiles();
                return;
            }

            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + '/api/files?t=' + Date.now();
            const res = await fetch(api);
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
        }
    }
    window.loadFiles = loadFiles;

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
            const downloadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + `/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${file.name}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size} • 按需下载</div>
                        </div>
                    </div>
                    <a href="${downloadUrl}" class="btn-download" download="${escapeHtml(file.name)}">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        按需下载
                    </a>
                </div>
            `;
        }).join('');
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
                alert('当前选定设备还没有待传文件，请先在对方设备上添加待传发票或文件！');
                return;
            }

            const suffix = (customFolderSuffix && customFolderSuffix.value.trim()) ? `_${customFolderSuffix.value.trim()}` : '';
            const dateFolderName = `${getTodayDateStr()}${suffix}`;

            // 模式 A：如果是 Windows / Mac 客户端原生运行 (Tauri 环境) -> 原生文件夹选择 + Rust 极速流式存盘
            if (window.__TAURI__ && window.__TAURI__.dialog) {
                try {
                    const selectedPath = await window.__TAURI__.dialog.open({
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
                            const downloadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : `http://127.0.0.1:9527`) + `/api/download/${f.id}`;
                            await window.__TAURI__.invoke('save_remote_file_to_directory', {
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
    }

    function uploadSingleFile(file) {
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

            const uploadUrl = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + '/api/upload';
            xhr.open('POST', uploadUrl);
            xhr.send(formData);
        });
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            loadFiles();
            pollLanDevices();
            checkSelfServerStatus();
            showToast('已刷新设备与文件列表');
        });
    }

    // 初始数据加载与定时轮询
    checkSelfServerStatus();
    loadFiles();
    pollLanDevices();
    setInterval(loadFiles, 3000);
    setInterval(pollLanDevices, 4000);
    setInterval(checkSelfServerStatus, 5000);


    // ---------------- 模块二：局域网双向即时互发消息 / 聊天室 ----------------
    const webChatMessages = document.getElementById('webChatMessages');
    const webEmptyChat = document.getElementById('webEmptyChat');
    const webChatMessageInput = document.getElementById('webChatMessageInput');
    const webBtnSendMessage = document.getElementById('webBtnSendMessage');
    const webBtnClearChat = document.getElementById('webBtnClearChat');

    let lastKnownMessageTimestamp = 0;
    const knownMessageIds = new Set();

    const osPlatform = (navigator.userAgent.indexOf('Mac') !== -1) ? 'Mac' :
                       (navigator.userAgent.indexOf('Win') !== -1) ? 'Windows' : '电脑端';
    const clientSenderName = `💻 ${osPlatform}端`;

    async function pollChatMessages() {
        try {
            let messages = [];
            if (window.__TAURI__) {
                messages = await window.__TAURI__.invoke('fetch_node_messages', { baseUrl: currentTargetBaseUrl });
            } else {
                const api = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + '/api/messages?t=' + Date.now();
                const res = await fetch(api);
                if (!res.ok) return;
                const data = await res.json();
                messages = data.messages || [];
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
            // 静默失败
        }
    }

    function formatTime(ts) {
        const d = new Date(ts);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    function renderChatMessage(msg) {
        if (!webChatMessages) return;
        if (webEmptyChat) webEmptyChat.style.display = 'none';

        const isMe = !msg.isFromPhone && msg.senderName.includes(osPlatform);
        const row = document.createElement('div');
        row.className = `chat-msg-row ${isMe ? 'from-me' : 'from-other'}`;

        const senderTitle = msg.isFromPhone ? '📱 手机端' : msg.senderName;
        const meta = document.createElement('div');
        meta.className = 'chat-msg-meta';
        meta.textContent = `${senderTitle} • ${formatTime(msg.timestamp)}`;

        const bubble = document.createElement('div');
        bubble.className = 'chat-msg-bubble';
        bubble.textContent = msg.content;
        bubble.title = '点击复制此消息';
        bubble.addEventListener('click', () => {
            navigator.clipboard.writeText(msg.content).then(() => {
                showToast('已复制该条消息');
            });
        });

        row.appendChild(meta);
        row.appendChild(bubble);
        webChatMessages.appendChild(row);
    }

    async function sendChatMessage() {
        if (!webChatMessageInput) return;
        const text = webChatMessageInput.value.trim();
        if (!text) return;

        try {
            if (window.__TAURI__) {
                await window.__TAURI__.invoke('send_node_message', {
                    baseUrl: currentTargetBaseUrl,
                    senderName: clientSenderName,
                    content: text
                });
                webChatMessageInput.value = '';
                pollChatMessages();
                return;
            }

            const api = (currentTargetBaseUrl ? currentTargetBaseUrl : '') + '/api/messages';
            const resp = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: text,
                    senderName: clientSenderName
                })
            });
            if (resp.ok) {
                webChatMessageInput.value = '';
                pollChatMessages();
            } else {
                showToast('发送失败');
            }
        } catch (e) {
            showToast('网络连接失败');
        }
    }

    if (webBtnSendMessage) {
        webBtnSendMessage.addEventListener('click', sendChatMessage);
    }

    if (webChatMessageInput) {
        webChatMessageInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    if (webBtnClearChat) {
        webBtnClearChat.addEventListener('click', () => {
            if (webChatMessages) {
                webChatMessages.innerHTML = '';
                if (webEmptyChat) {
                    webEmptyChat.style.display = 'block';
                    webChatMessages.appendChild(webEmptyChat);
                }
            }
            knownMessageIds.clear();
            showToast('已清空网页聊天记录');
        });
    }

    // 启动轮询获取最新消息
    pollChatMessages();
    setInterval(pollChatMessages, 1500);


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
