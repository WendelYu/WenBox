/*
 * WenBox 主题切换（Phase 4）
 * 支持「跟随系统 / 深色 / 浅色」三种偏好，选择保存在 localStorage。
 * 颜色值全部来自 tokens.css，本文件只负责切换 data-theme 属性。
 */
(function () {
    const STORAGE_KEY = 'wenbox_theme';
    const MODES = ['system', 'dark', 'light'];

    function readPreference() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return MODES.includes(stored) ? stored : 'system';
        } catch (_) {
            return 'system';
        }
    }

    function systemPrefersLight() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-color-scheme: light)').matches;
    }

    function resolve(preference) {
        if (preference === 'light') return 'light';
        if (preference === 'dark') return 'dark';
        return systemPrefersLight() ? 'light' : 'dark';
    }

    function apply(preference) {
        const resolved = resolve(preference);
        document.documentElement.setAttribute('data-theme', resolved);
        document.documentElement.style.colorScheme = resolved;
        const meta = document.querySelector('meta[name="color-scheme"]');
        if (meta) meta.setAttribute('content', resolved);
    }

    const listeners = new Set();

    function set(preference) {
        if (!MODES.includes(preference)) return;
        try {
            localStorage.setItem(STORAGE_KEY, preference);
        } catch (_) { /* 隐私模式下写不进去，仍然应用当前会话 */ }
        apply(preference);
        listeners.forEach(fn => fn(preference, resolve(preference)));
    }

    function init() {
        apply(readPreference());
        if (typeof window.matchMedia === 'function') {
            const query = window.matchMedia('(prefers-color-scheme: light)');
            const onChange = () => {
                if (readPreference() === 'system') apply('system');
            };
            if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
            else if (typeof query.addListener === 'function') query.addListener(onChange);
        }
    }

    window.WenBoxTheme = {
        init,
        get preference() { return readPreference(); },
        get resolved() { return resolve(readPreference()); },
        set,
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }
    };
})();
