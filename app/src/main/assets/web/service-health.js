(() => {
    'use strict';
    const badge = document.getElementById('serviceHealth');
    const text = document.getElementById('serviceHealthText');
    const retry = document.getElementById('retryServiceHealth');
    const version = document.querySelector('meta[name="wenbox-version"]').content;
    document.getElementById('clientVersion').textContent = `v${version}`;
    const native = !!(window.__TAURI__?.invoke || window.__TAURI_INVOKE__)
        || location.hostname === 'tauri.localhost' || location.protocol === 'tauri:';
    let checking = false;
    async function check() {
        if (checking) return;
        checking = true;
        retry.disabled = true;
        try {
            const response = await window.WenBox.fetchWithTimeout((native ? 'http://127.0.0.1:9527' : '') + '/api/status?t=' + Date.now(), {}, 3500, 0);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const status = await response.json();
            if (status.running !== true) throw new Error('服务尚未启动');
            const mismatch = status.version && status.version !== version;
            badge.dataset.state = mismatch ? 'warning' : 'ready';
            text.textContent = mismatch ? `服务版本不一致（v${status.version}）` : '服务正常';
            badge.title = mismatch ? '请退出旧客户端，再打开新版 WenBox。' : `服务接口正常 · 端口 ${status.port || 9527}；对端能否访问还取决于网卡和防火墙。`;
            retry.hidden = !mismatch;
        } catch (error) {
            badge.dataset.state = 'error';
            text.textContent = '服务未就绪';
            badge.title = `未能访问服务，请重新检测；持续失败时退出并重新打开 WenBox。${error.message || ''}`;
            retry.hidden = false;
        } finally { checking = false; retry.disabled = false; }
    }
    retry.addEventListener('click', check);
    window.addEventListener('focus', check);
    setInterval(check, 5000);
    check();
})();
