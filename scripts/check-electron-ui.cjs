// Optional native smoke check: validates the installed or packaged Electron without changing the clipboard.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

async function main() {
    const root = path.resolve(__dirname, '..');
    const executablePath = process.env.ELECTRON_EXECUTABLE || require('electron');
    const args = process.env.ELECTRON_APP_BUNDLE ? [] : [root];
    const application = await _electron.launch({ executablePath, args, timeout: 30000 });
    try {
        const page = await application.firstWindow();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.waitForLoadState('domcontentloaded');
        await page.locator('[data-view="view-tools"]').click();
        await page.locator('[data-tool="tab-json"]').click();
        await page.locator('#webJsonInput').fill('{"ready":true}');
        await page.locator('#webBtnFormatJson2').click();
        assert.match(await page.locator('#webJsonInput').inputValue(), /\n  "ready": true/);
        const settings = await application.evaluate(({ BrowserWindow, app }) => ({
            version: process.versions.electron,
            name: app.name,
            preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
        }));
        assert.equal(settings.version, '44.8.0');
        assert.equal(settings.preferences.nodeIntegration, false);
        assert.equal(settings.preferences.contextIsolation, true);
        assert.equal(settings.preferences.sandbox, true);
        assert.equal(settings.preferences.webSecurity, true);
        assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
        assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
        assert.equal(await page.evaluate(() => typeof window.wenboxDesktop.writeText), 'function');
        const policy = await page.request.get(page.url());
        assert.match(policy.headers()['content-security-policy'], /script-src 'self';/);
        assert.deepEqual(errors, []);
        const output = path.resolve(process.env.UI_SCREEN_DIR || 'docs/ui-screens/phase-3');
        fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, process.env.ELECTRON_APP_BUNDLE ? 'electron-packaged-tools.png' : 'electron-tools.png') });
        console.log(`Electron ${settings.version}: native launch, HTTP assets/CSP, sandbox/preload and JSON tool passed.`);
    } finally { await application.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
