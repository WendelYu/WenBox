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

    // ---------------- 模块一：局域网快传与报销直存 ----------------
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

    // 报销直存按钮与状态
    const btnSelectReimburseDir = document.getElementById('btnSelectReimburseDir');
    const reimburseStatus = document.getElementById('reimburseStatus');
    const previewFolderName = document.getElementById('previewFolderName');

    // 初始化日期预览
    const todayStr = getTodayDateStr();
    if (previewFolderName) {
        previewFolderName.textContent = `${todayStr}_报销`;
    }

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

    async function loadFiles() {
        try {
            const res = await fetch('/api/files?t=' + Date.now());
            if (!res.ok) throw new Error('网络异常');
            const data = await res.json();
            currentFiles = data.files || [];
            renderFiles();
        } catch (err) {
            // 静默失败
        }
    }

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
            const downloadUrl = `/api/download/${file.id}`;

            return `
                <div class="file-item">
                    <div class="file-info">
                        <span class="file-type-icon">${icon}</span>
                        <div class="file-meta">
                            <div class="file-name" title="${file.name}">${escapeHtml(file.name)}</div>
                            <div class="file-size">${size}</div>
                        </div>
                    </div>
                    <a href="${downloadUrl}" class="btn-download" download="${escapeHtml(file.name)}">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        下载
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

    // 报销模式：直接通过 File System Access API 存入日期目录
    if (btnSelectReimburseDir) {
        btnSelectReimburseDir.addEventListener('click', async () => {
            if (!window.showDirectoryPicker) {
                alert('您的当前浏览器不支持直接文件夹访问 API，请使用现代 Chrome、Edge 或 Chromium 核心浏览器访问本页面。');
                return;
            }

            if (!currentFiles || currentFiles.length === 0) {
                alert('当前手机端还没有待传文件，请先在手机上添加待传发票或文件！');
                return;
            }

            try {
                // 1. 用户选择电脑上的报销根目录（例如 D:\财务报销 或 Mac 的 ~/报销）
                const rootDirHandle = await window.showDirectoryPicker({
                    id: 'wenbox_reimburse_dir',
                    mode: 'readwrite'
                });

                const dateFolderName = `${getTodayDateStr()}_报销`;
                reimburseStatus.style.display = 'block';
                reimburseStatus.textContent = `📁 正在「${rootDirHandle.name}」中创建文件夹「${dateFolderName}」...`;

                // 2. 在根目录下自动创建当天报销子文件夹
                const targetDirHandle = await rootDirHandle.getDirectoryHandle(dateFolderName, { create: true });

                // 3. 逐个将待传发票直写入该文件夹
                let successCount = 0;
                for (let i = 0; i < currentFiles.length; i++) {
                    const f = currentFiles[i];
                    reimburseStatus.textContent = `⏳ 正在直存 [${i + 1}/${currentFiles.length}]: ${f.name}...`;

                    try {
                        const fileResp = await fetch(`/api/download/${f.id}`);
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
                showToast(`已成功直存 ${successCount} 个发票文件！`);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    reimburseStatus.style.display = 'block';
                    reimburseStatus.textContent = `直存遇到异常: ${err.message || err}`;
                }
            }
        });
    }

    // 拖拽与反向上传
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
                    showToast(`已成功保存到手机: ${file.name}`);
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

            xhr.open('POST', '/api/upload');
            xhr.send(formData);
        });
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            loadFiles();
            showToast('已刷新文件列表');
        });
    }

    // 初始快传数据加载与定时轮询
    loadFiles();
    setInterval(loadFiles, 3000);


    // ---------------- 模块二：局域网双向即时互发消息 / 聊天室 ----------------
    const webChatMessages = document.getElementById('webChatMessages');
    const webEmptyChat = document.getElementById('webEmptyChat');
    const webChatMessageInput = document.getElementById('webChatMessageInput');
    const webBtnSendMessage = document.getElementById('webBtnSendMessage');
    const webBtnClearChat = document.getElementById('webBtnClearChat');

    let lastKnownMessageTimestamp = 0;
    const knownMessageIds = new Set();

    // 智能识别当前操作系统
    const osPlatform = (navigator.userAgent.indexOf('Mac') !== -1) ? 'Mac' :
                       (navigator.userAgent.indexOf('Win') !== -1) ? 'Windows' : '电脑端';
    const clientSenderName = `💻 ${osPlatform}端`;

    async function pollChatMessages() {
        try {
            const res = await fetch('/api/messages?t=' + Date.now());
            if (!res.ok) return;
            const data = await res.json();
            const messages = data.messages || [];

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

        // 判断消息是来自本端(电脑Web)还是对方(手机)
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
            const resp = await fetch('/api/messages', {
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
  "version": "1.2.0",
  "author": "Wendel",
  "port": 9527,
  "features": [
    "LanDirectTransfer",
    "ReimbursementMode",
    "LanTwoWayChat",
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

    // 默认载入示例
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

    // 复制按钮
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

    // 初始化转换器数值
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

    // 默认预演
    if (webCronInput) {
        updateCronUI(webCronInput.value);
    }
})();
