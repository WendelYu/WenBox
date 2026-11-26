// In-app GitHub Releases updater & About runtime panel.
(function () {
    'use strict';
    const STORAGE_KEY = 'wenbox_auto_check_update';
    const RELEASES_FALLBACK_URL = 'https://github.com/WendelYu/WenBox/releases';

    const metaVersion = document.querySelector('meta[name="wenbox-version"]')?.content || '1.0.0';
    const badgeEl = document.getElementById('aboutVersionBadge');
    const statusEl = document.getElementById('aboutUpdateStatus');
    const dotEl = document.getElementById('aboutUpdateDot');
    const btnCheck = document.getElementById('btnCheckUpdate');
    const btnInstall = document.getElementById('btnInstallUpdate');
    const updatePanel = document.getElementById('aboutUpdatePanel');
    const updateTitle = document.getElementById('aboutUpdateTitle');
    const updateNotes = document.getElementById('aboutUpdateNotes');
    const progressEl = document.getElementById('aboutUpdateProgress');
    const progressTextEl = document.getElementById('aboutUpdateProgressText');
    const toggleAuto = document.getElementById('toggleAutoCheckUpdate');
    const runtimeEnvEl = document.getElementById('aboutRuntimeEnv');
    const dataDirEl = document.getElementById('aboutDataDir');
    const btnOpenDataDir = document.getElementById('btnOpenDataDir');
    const btnOpenReleases = document.getElementById('btnOpenGithubReleases');

    if (!badgeEl || !statusEl || !btnCheck) return;

    let runtimeInfo = null;
    let latestUpdate = null;
    let checking = false;
    let installing = false;
    let progressUnlistenBound = false;
    let speedSampleAt = 0;
    let speedSampleBytes = 0;
    let smoothSpeed = 0;

    function getInvoke() {
        const fn = window.__TAURI__?.invoke || window.__TAURI_INVOKE__;
        return typeof fn === 'function' ? (cmd, args) => fn.call(window.__TAURI__, cmd, args) : null;
    }

    function isDesktop() {
        return !!getInvoke()
            && (window.location?.protocol === 'tauri:' || window.location?.hostname === 'tauri.localhost');
    }

    function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${bytes} B`;
    }

    function setStatus(state, text) {
        statusEl.dataset.state = state;
        statusEl.textContent = text;
    }

    function loadAutoCheckPreference() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw === null ? true : raw === 'true';
        } catch (_) {
            return true;
        }
    }

    function saveAutoCheckPreference(enabled) {
        try {
            localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
        } catch (_) {}
    }

    function openExternal(url) {
        const target = url || runtimeInfo?.repoUrl || RELEASES_FALLBACK_URL;
        const tauriOpen = window.__TAURI__?.shell?.open;
        if (typeof tauriOpen === 'function') {
            Promise.resolve(tauriOpen(target)).catch(() => window.open(target, '_blank', 'noopener'));
            return;
        }
        window.open(target, '_blank', 'noopener');
    }

    function bindProgressListener() {
        if (progressUnlistenBound) return;
        const listen = window.__TAURI__?.event?.listen;
        if (typeof listen !== 'function') return;
        progressUnlistenBound = true;
        Promise.resolve(listen('updater-progress', event => {
            const p = event?.payload;
            if (!p || !updatePanel || !progressEl || !progressTextEl) return;
            updatePanel.hidden = false;
            progressEl.hidden = false;
            const loaded = Number(p.loaded) || 0;
            const total = Number(p.total) || 0;
            if (p.stage === 'downloading') {
                const now = Date.now();
                const dt = (now - speedSampleAt) / 1000;
                if (speedSampleAt === 0) {
                    speedSampleAt = now;
                    speedSampleBytes = loaded;
                } else if (dt >= 0.25) {
                    const inst = (loaded - speedSampleBytes) / dt;
                    smoothSpeed = smoothSpeed > 0 ? (smoothSpeed * 0.65 + inst * 0.35) : inst;
                    speedSampleAt = now;
                    speedSampleBytes = loaded;
                }
                if (total > 0) {
                    const ratio = Math.min(1, loaded / total);
                    const pct = Math.round(ratio * 100);
                    progressEl.value = ratio;
                    const spd = smoothSpeed > 0 ? ` · ${formatSize(smoothSpeed)}/s` : '';
                    progressTextEl.textContent = `正在下载 (${pct}%) · ${formatSize(loaded)} / ${formatSize(total)}${spd}`;
                } else {
                    progressEl.removeAttribute('value');
                    progressTextEl.textContent = loaded > 0 ? `正在下载 · 已接收 ${formatSize(loaded)}` : (p.message || '正在下载更新包…');
                }
            } else if (p.stage === 'verifying') {
                progressEl.removeAttribute('value');
                progressTextEl.textContent = p.message || '正在校验文件完整性…';
            } else if (p.stage === 'installing' || p.stage === 'restarting') {
                progressEl.value = 1;
                progressTextEl.textContent = p.message || '正在安装并重启…';
            }
        })).catch(() => { progressUnlistenBound = false; });
    }

    async function loadRuntimeInfo() {
        badgeEl.textContent = `v${metaVersion}`;
        const invoke = getInvoke();
        if (!invoke || !isDesktop()) {
            if (runtimeEnvEl) runtimeEnvEl.textContent = 'Web 浏览器（随房主实时同步）';
            if (dataDirEl) dataDirEl.textContent = '由房主桌面端托管';
            if (btnOpenDataDir) btnOpenDataDir.hidden = true;
            setStatus('latest', '浏览器端随房主自动保持一致');
            return;
        }
        try {
            runtimeInfo = await invoke('get_app_runtime_info_cmd');
            if (runtimeInfo?.version) badgeEl.textContent = `v${runtimeInfo.version}`;
            if (runtimeEnvEl) {
                const modeLabel = runtimeInfo?.isPortable ? ' · 免安装版' : '';
                runtimeEnvEl.textContent = `${runtimeInfo?.platform || '桌面端'} (${runtimeInfo?.arch || ''})${modeLabel}`;
            }
            if (dataDirEl) {
                dataDirEl.textContent = runtimeInfo?.dataDir || '';
                dataDirEl.title = runtimeInfo?.dataDir || '';
            }
            if (btnOpenDataDir) {
                btnOpenDataDir.hidden = false;
                btnOpenDataDir.textContent = runtimeInfo?.platform === 'macOS' ? '在访达中显示' : '打开目录';
            }
            if (runtimeInfo && !runtimeInfo.canAutoInstall && runtimeInfo.installHint) {
                setStatus('warning', runtimeInfo.installHint);
            } else {
                setStatus('latest', '点击「检查更新」查看最新版本');
            }
        } catch (_) {
            setStatus('idle', '点击「检查更新」查看最新版本');
        }
    }

    function renderUpdateResult(info, silent = false) {
        latestUpdate = info;
        if (dotEl) dotEl.hidden = !info.hasUpdate;
        if (!info.hasUpdate) {
            if (btnInstall) btnInstall.hidden = true;
            if (updatePanel) updatePanel.hidden = true;
            setStatus('latest', '已是最新版本');
            return;
        }

        const sizeNote = info.assetSize > 0 ? `（${formatSize(info.assetSize)}）` : '';
        setStatus('available', `发现新版本 v${info.latestVersion}${sizeNote}`);
        if (updatePanel) updatePanel.hidden = false;
        if (updateTitle) updateTitle.textContent = `WenBox v${info.latestVersion} 已发布`;
        if (updateNotes) {
            updateNotes.textContent = info.releaseNotes || '前往 GitHub Releases 查看完整更新内容。';
        }
        if (progressEl) {
            progressEl.hidden = true;
            progressEl.value = 0;
        }
        if (progressTextEl) {
            progressTextEl.textContent = info.canAutoInstall
                ? '点击「立即更新并重启」，将自动下载校验并无感覆盖升级。'
                : (info.installHint || '请点击右下角 GitHub 按钮下载安装包。');
        }
        if (btnInstall) {
            btnInstall.hidden = !(info.canAutoInstall && info.assetUrl);
            btnInstall.disabled = false;
        }
        if (!silent) {
            const toastMsg = info.canAutoInstall
                ? `发现 WenBox v${info.latestVersion}，可在「关于」页一键更新`
                : `发现 WenBox v${info.latestVersion}`;
            document.dispatchEvent(new CustomEvent('wenbox:update-available', { detail: { info, message: toastMsg } }));
        }
    }

    async function checkForUpdates(silent = false) {
        if (checking || installing) return null;
        const invoke = getInvoke();
        if (!invoke || !isDesktop()) {
            if (!silent) openExternal(RELEASES_FALLBACK_URL);
            return null;
        }
        checking = true;
        btnCheck.disabled = true;
        btnCheck.textContent = '检查中…';
        if (!silent) setStatus('checking', '正在检查 GitHub 最新版本…');
        try {
            const info = await invoke('updater_check_cmd');
            renderUpdateResult(info, silent);
            return info;
        } catch (err) {
            if (!silent) {
                setStatus('error', String(err?.message || err || '检查更新失败'));
            }
            return null;
        } finally {
            checking = false;
            btnCheck.disabled = false;
            btnCheck.textContent = '检查更新';
        }
    }

    async function installAvailableUpdate() {
        if (installing || !latestUpdate?.assetUrl || !latestUpdate?.assetName) return;
        const invoke = getInvoke();
        if (!invoke || !isDesktop()) return;
        bindProgressListener();
        installing = true;
        speedSampleAt = 0;
        speedSampleBytes = 0;
        smoothSpeed = 0;
        btnCheck.disabled = true;
        if (btnInstall) {
            btnInstall.disabled = true;
            btnInstall.textContent = '更新中…';
        }
        if (updatePanel) updatePanel.hidden = false;
        if (progressEl) {
            progressEl.hidden = false;
            progressEl.removeAttribute('value');
        }
        if (progressTextEl) progressTextEl.textContent = '正在准备下载更新包…';
        setStatus('checking', `正在下载并更新到 v${latestUpdate.latestVersion}…`);
        try {
            await invoke('updater_install_cmd', {
                assetUrl: latestUpdate.assetUrl,
                assetName: latestUpdate.assetName,
                checksumUrl: latestUpdate.checksumUrl || null
            });
        } catch (err) {
            installing = false;
            btnCheck.disabled = false;
            if (btnInstall) {
                btnInstall.disabled = false;
                btnInstall.textContent = '立即更新并重启';
            }
            const msg = String(err?.message || err || '自动更新失败');
            setStatus('error', msg);
            if (progressTextEl) progressTextEl.textContent = msg;
        }
    }

    if (toggleAuto) {
        toggleAuto.checked = loadAutoCheckPreference();
        toggleAuto.addEventListener('change', () => {
            saveAutoCheckPreference(toggleAuto.checked);
        });
    }

    btnCheck.addEventListener('click', () => { checkForUpdates(false); });
    btnInstall?.addEventListener('click', () => { installAvailableUpdate(); });
    btnOpenDataDir?.addEventListener('click', () => {
        const invoke = getInvoke();
        if (invoke && isDesktop()) invoke('open_data_dir_cmd').catch(() => {});
    });
    btnOpenReleases?.addEventListener('click', () => {
        openExternal(latestUpdate?.releaseUrl || runtimeInfo?.repoUrl || RELEASES_FALLBACK_URL);
    });

    loadRuntimeInfo();
    if (isDesktop() && loadAutoCheckPreference()) {
        setTimeout(() => { checkForUpdates(true); }, 4000);
    }

    window.WenBoxUpdater = { check: checkForUpdates, install: installAvailableUpdate };
})();
