// Optional browser regression: PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/check-web-ui.cjs
// Uses a local fixture server; never connects to a real WenBox room or user files.
const engines = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engineName = process.env.BROWSER_ENGINE || 'chromium';
const browserEngine = engines[engineName];
if (!['chromium', 'webkit', 'firefox'].includes(engineName)) throw new Error('Unsupported BROWSER_ENGINE');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    const root = path.resolve(process.env.WEB_ASSET_ROOT || 'app/src/main/assets/web');
    const screenshots = path.resolve(process.env.UI_SCREEN_DIR || 'docs/ui-screens/phase-3');
    fs.mkdirSync(screenshots, { recursive: true });
    let active = false, serial = 0, discoveries = 0;
    const sendAttempts = new Map();
    const room = { roomId: 'fixture-room', roomName: '现场协作', hostDevice: '测试电脑', hostIp: '192.168.1.8', hostPort: 9527, needPassword: true, pin: '6888' };
    const messages = [], received = [], attempts = new Map();
    const failures = [], browserErrors = [];
    const shared = [{ id: 'sample-id', name: '中文说明文档.txt', size: 1024, mimeType: 'text/plain' }];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (!url.pathname.startsWith('/api/')) {
            const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
            if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
            try {
                const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'" });
                return res.end(fs.readFileSync(file));
            } catch (_) { failures.push(req.url); res.writeHead(404); return res.end(); }
        }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const json = () => { try { return JSON.parse(body.toString()); } catch (_) { return {}; } };
        if (url.pathname === '/api/status') return send({ running: true, version: require('../package.json').version, ip: '192.168.1.8', all_ips: ['192.168.1.8', '192.168.2.8'], device: '测试电脑', port: 9527, platform: 'macOS' });
        if (url.pathname === '/api/room/status') return send({ ...room, isActive: active, isHost: req.headers['x-host-token'] === 'host-token' });
        if (url.pathname === '/api/discovered_rooms') { if (++discoveries === 1) await new Promise(resolve => setTimeout(resolve, 900)); return send({ rooms: [{ ...room, ip: '127.0.0.1', port: server.address().port, hostPlatform: 'macOS' }] }); }
        if (url.pathname === '/api/room/create') { active = true; Object.assign(room, json()); return send({ ...room, hostToken: 'host-token' }); }
        if (url.pathname === '/api/room/close') { active = false; return send({ success: true }); }
        if (url.pathname === '/api/room/join') { if (json().pin === '0000') return send({ success: false, message: '尝试过于频繁', retryAfter: 3 }, 429); active = true; return send({ success: true, token: 'guest-token', memberId: 'guest-id', room: { ...room } }); }
        if (url.pathname === '/api/room/heartbeat') return send({ success: true, room: { ...room, isActive: active } });
        if (url.pathname === '/api/room/members') return send({ count: 2, members: [{ id: 'host-id', name: '测试电脑 (房主)', ip: '192.168.1.8', platform: 'macOS' }, { id: 'guest-id', name: '现场工程师', ip: '192.168.1.20', accessIp: '192.168.1.8:9527', platform: 'Android' }] });
        if (url.pathname === '/api/room/leave' || url.pathname === '/api/room/set_ip') return send({ success: true });
        if (url.pathname === '/api/files') return send({ files: shared });
        if (url.pathname === '/api/received_files') return send({ files: received });
        if (url.pathname === '/api/messages' && req.method === 'GET') return send({ messages: messages.filter(m => m.timestamp > Number(url.searchParams.get('since') || 0)), isActive: active, roomId: room.roomId });
        if (url.pathname === '/api/messages' && req.method === 'POST') {
            const input = json();
            sendAttempts.set(input.content, (sendAttempts.get(input.content) || 0) + 1);
            if (input.content === '延迟发送测试') await new Promise(resolve => setTimeout(resolve, 650));
            if (input.content === '重试发送测试' && sendAttempts.get(input.content) === 1) return send({ success: false }, 500);
            const msg = { ...input, id: String(++serial), timestamp: Date.now() + serial };
            messages.push(msg); return send({ success: true, message: msg });
        }
        if (url.pathname === '/api/upload') {
            if (!['host-token', 'guest-token'].includes(req.headers['x-room-token'])) return send({ success: false }, 401);
            const name = /filename="([^"]+)"/.exec(body.toString())?.[1] || 'file.bin';
            attempts.set(name, (attempts.get(name) || 0) + 1);
            if (name.startsWith('retry-') && attempts.get(name) === 1) return send({ success: false }, 500);
            const file = { id: 'upload-' + (++serial), name, size: 1024 };
            const finish = () => { if (res.destroyed) return; received.push(file); send({ success: true, fileId: file.id, name, size: file.size }); };
            if (name.startsWith('slow-')) setTimeout(finish, 1800); else finish();
            return;
        }
        if (url.pathname === '/api/download/preview') {
            if (url.searchParams.get('token') !== 'guest-token') { res.writeHead(401); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
        }
        if (url.pathname.startsWith('/api/download/')) { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); return res.end('WenBox fixture download'); }
        failures.push(req.url); return send({ error: 'unknown fixture route' }, 404);
    });
    let browser, page;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await browserEngine.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
        page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', error => browserErrors.push(error.stack));
        page.on('console', msg => { if (msg.type() === 'error' && /Content Security Policy|Refused to/.test(msg.text())) browserErrors.push(msg.text()); });
        await page.goto(origin);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('#roomDiscoverySkeleton').isVisible(), true);
        assert.equal(await page.locator('.room-skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.locator('[data-action="join-room"]').waitFor();
        const snapshot = async (mode, theme, width) => {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(theme => window.WenBoxTheme.set(theme), theme);
            await page.waitForTimeout(250);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${mode}/${theme}/${width}: horizontal overflow`);
            await page.screenshot({ path: path.join(screenshots, `${mode}-${theme}-${width}.png`), fullPage: true });
        };
        for (const width of [1440, 1024, 768, 390]) await snapshot('lobby', 'dark', width);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('#btnOpenCreateRoomModal').click();
        await page.locator('#modalInputRoomName').fill('现场协作');
        assert.equal(await page.locator('#createPinField').isVisible(), false);
        await page.locator('#requireRoomPin').check();
        await page.locator('#modalBtnConfirmCreateRoom').click();
        await page.locator('#createRoomError').waitFor({ state: 'visible' });
        await page.locator('#modalInputRoomPin').fill('6888');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('createRoomModal').open);
        assert.equal(await page.locator('#btnOpenCreateRoomModal').evaluate(el => document.activeElement === el), true);
        await page.locator('#btnOpenCreateRoomModal').click();
        await page.locator('#modalInputRoomName').fill('现场协作');
        await page.locator('#requireRoomPin').check();
        await page.locator('#modalInputRoomPin').fill('6888');
        await page.waitForTimeout(320);
        await page.screenshot({ path: path.join(screenshots, 'detail-create-pin.png') });
        await page.locator('#btnRevealRoomPin').click();
        assert.equal(await page.locator('#modalInputRoomPin').getAttribute('type'), 'text');
        await page.locator('#btnRevealRoomPin').click();
        await page.locator('#modalBtnConfirmCreateRoom').click();
        await page.waitForFunction(() => document.body.dataset.roomMode === 'host');
        await page.waitForFunction(() => !document.getElementById('createRoomModal').open);
        await page.locator('#btnChangeNicknameChat').click();
        await page.locator('#modalInputEditNickname').fill('现场 MacBook');
        assert.equal(await page.locator('#nicknamePreview').textContent(), '现场 MacBook');
        await page.waitForTimeout(320);
        await page.screenshot({ path: path.join(screenshots, 'detail-nickname.png') });
        await page.locator('#modalInputEditNickname').fill('   ');
        assert.equal(await page.locator('#btnSaveNicknameModal').isDisabled(), true);
        await page.locator('#modalInputEditNickname').fill('现场 MacBook');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('editNicknameModal').open);
        await page.locator('#chatOnlineMemberBadge').click();
        await page.locator('.member-card').first().waitFor();
        await page.waitForTimeout(320);
        await page.screenshot({ path: path.join(screenshots, 'detail-members.png') });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('onlineMembersModal').open);
        await page.locator('#webChatMessageInput').fill('现场设备已连接\n```json\n{"ready":true}\n```');
        await page.locator('#webBtnSendMessage').click();
        await page.locator('.chat-code-block').waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-delivery]'));
        await page.locator('#webChatMessageInput').fill('延迟发送测试');
        await page.locator('#webBtnSendMessage').click();
        await page.locator('[data-delivery="sending"]').waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-delivery]'));
        assert.equal(await page.locator('.chat-text').filter({ hasText: '延迟发送测试' }).count(), 1);
        await page.locator('#webChatMessageInput').fill('重试发送测试');
        await page.locator('#webBtnSendMessage').click();
        await page.locator('[data-delivery="failed"]').waitFor();
        await page.screenshot({ path: path.join(screenshots, 'detail-message-retry.png') });
        await page.locator('[data-delivery="failed"] [data-action="retry-message"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-delivery]'));
        assert.equal(await page.locator('.chat-text').filter({ hasText: '重试发送测试' }).count(), 1);
        assert.equal(sendAttempts.get('重试发送测试'), 2);
        assert.ok(await page.locator('.chat-avatar').count() > 0);
        await page.locator('[data-action="copy-code"]').click();
        await page.locator('#chatOnlineMemberBadge').click();
        await page.locator('#onlineMembersModal[open]').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('#connectionDetails > summary').click();
        await page.locator('#btnShowHostQrCode').click();
        assert.equal(await page.locator('#hostQrCanvas').getAttribute('width'), '240');
        await page.keyboard.press('Escape');
        // Three simultaneous uploads: succeed, fail then retry, and cancel independently.
        const payload = name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
        await page.locator('#fileInput').setInputFiles([payload('成功文件.txt'), payload('retry-report.txt'), payload('slow-cancel.txt')]);
        const row = name => page.locator('#uploadQueue .upload-row').filter({ hasText: name });
        await row('retry-report.txt').locator('[data-action="retry-upload"]').waitFor();
        await page.screenshot({ path: path.join(screenshots, 'detail-transfer-states.png') });
        await row('slow-cancel.txt').locator('[data-action="cancel-upload"]').click();
        await row('retry-report.txt').locator('[data-action="retry-upload"]').click();
        await page.waitForFunction(() => document.querySelectorAll('#uploadQueue [data-state="done"]').length === 2);
        assert.equal(await row('slow-cancel.txt').getAttribute('data-state'), 'cancelled');
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.items.add(new File(['drag fixture'], '拖入文件.txt', { type: 'text/plain' }));
            document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: data }));
            document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        });
        await page.waitForFunction(() => [...document.querySelectorAll('#uploadQueue .upload-row')].some(row => row.textContent.includes('拖入文件.txt') && row.dataset.state === 'done'));
        assert.equal(await page.locator('#chatDropOverlay').isVisible(), false);
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.items.add(new File(['paste file'], '粘贴文件.txt', { type: 'text/plain' }));
            data.setData('text/plain', '粘贴文件.txt');
            document.getElementById('webChatMessageInput').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        });
        await page.waitForFunction(() => [...document.querySelectorAll('#uploadQueue .upload-row')].some(row => row.textContent.includes('粘贴文件.txt') && row.dataset.state === 'done'));
        await page.evaluate(async () => {
            const originalNeeds = WenBox.needsNativeTransport, originalFiles = WenBox.clipboardFiles;
            try {
                WenBox.needsNativeTransport = () => true;
                const input = document.getElementById('webChatMessageInput');
                WenBox.clipboardFiles = async () => [new File(['native paste'], '系统剪贴板.txt', { type: 'text/plain' })];
                const data = new DataTransfer(); data.setData('text/plain', '系统剪贴板.txt');
                input.value = '';
                input.dispatchEvent(new ClipboardEvent('paste', { cancelable: true, clipboardData: data }));
                await new Promise(resolve => setTimeout(resolve, 0));
                if (input.value !== '') throw Error('File paste must not insert filenames');
                WenBox.clipboardFiles = async () => [];
                data.setData('text/plain', '普通文字');
                input.dispatchEvent(new ClipboardEvent('paste', { cancelable: true, clipboardData: data }));
                await new Promise(resolve => setTimeout(resolve, 0));
                if (input.value !== '普通文字') throw Error('Text paste was lost');
                input.value = '';
            } finally { WenBox.needsNativeTransport = originalNeeds; WenBox.clipboardFiles = originalFiles; }
        });
        await page.waitForFunction(() => [...document.querySelectorAll('#uploadQueue .upload-row')].some(row => row.textContent.includes('系统剪贴板.txt') && row.dataset.state === 'done'));

        await page.locator('.chat-file-card').first().waitFor();
        const downloadEvent = page.waitForEvent('download');
        await page.locator('.chat-file-download-btn').first().click();
        const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), 'fixture.txt');
        await download.delete();
        await page.waitForTimeout(3200); // completed rows collapse into history
        for (const theme of ['dark', 'light']) for (const width of [1440, 1024, 768, 390]) await snapshot('host', theme, width);
        // Tablet drawer and mobile file segment remain operable.
        await page.setViewportSize({ width: 768, height: 900 });
        await page.locator('#btnToggleFiles').click(); await page.locator('#filePanel').waitFor({ state: 'visible' });
        const drawerBounds = await page.locator('#filePanel').boundingBox();
        assert.equal(Math.round(drawerBounds.y), 0, 'file drawer stays anchored to the window after page animation');
        assert.equal(Math.round(drawerBounds.height), 900);
        await page.keyboard.press('Escape'); await page.locator('#filePanel').waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator('button[data-room-page="files"]').click(); await page.locator('#filePanel').waitFor({ state: 'visible' });
        await page.locator('button[data-room-page="chat"]').click();
        assert.equal(await page.locator('button[data-room-page="chat"]').getAttribute('aria-pressed'), 'true');
        await page.locator('#webChatMessageInput').click();
        assert.equal(await page.locator('button[data-room-page="chat"]').getAttribute('aria-pressed'), 'true', 'ordinary clicks preserve segment state');
        const inputBounds = await page.locator('#webChatMessageInput').boundingBox();
        const navBounds = await page.locator('.nav-tabs').boundingBox();
        assert.ok(inputBounds.y + inputBounds.height <= navBounds.y, 'mobile composer stays above bottom navigation');
        await page.locator('[data-view="view-tools"]').click();
        for (const tool of ['tab-json', 'tab-converter', 'tab-cron', 'tab-archive']) {
            await page.locator(`[data-tool="${tool}"]`).click();
            assert.equal(await page.locator(`#${tool}`).isVisible(), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, tool);
        }
        await page.setViewportSize({ width: 1100, height: 780 });
        for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => window.WenBoxTheme.set(theme), theme);
            for (const tool of ['tab-json', 'tab-converter', 'tab-cron', 'tab-archive']) {
                await page.locator(`[data-tool="${tool}"]`).click();
                await page.waitForTimeout(320);
                await page.screenshot({ path: path.join(screenshots, `${tool}-${theme}-1100.png`) });
            }
        }
        await page.locator('[data-view="view-room"]').click();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('#webBtnClearChat').click();
        await page.waitForTimeout(2300);
        assert.equal(await page.locator('.chat-item').count(), 0, 'clear screen does not replay history on next poll');
        assert.ok(messages.length >= 3, 'clear screen preserves room history');
        await page.locator('#btnCloseRoom').click(); await page.locator('#appConfirmOkBtn').click();
        await page.waitForFunction(() => document.body.dataset.roomMode === 'client');
        await page.locator('[data-action="join-room"]').click();
        await page.locator('#modalInputJoinPin').fill('legacy-password');
        assert.equal(await page.locator('.pin-entry--full').count(), 1, 'legacy passwords remain usable');
        await page.locator('#modalInputJoinPin').fill('0000');
        assert.equal(await page.locator('#joinPinSlots span').filter({ hasText: '•' }).count(), 4);
        assert.equal(await page.locator('#modalInputJoinPin').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'PIN overlay must leave slots visible');
        await page.locator('#modalBtnConfirmJoinPin').click();
        await page.waitForFunction(() => document.getElementById('modalBtnConfirmJoinPin').disabled);
        await page.locator('#joinPinError').waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(screenshots, 'detail-pin-lockout.png') });
        await page.keyboard.press('Escape');
        await page.locator('[data-action="join-room"]').click();
        assert.equal(await page.locator('#modalBtnConfirmJoinPin').isDisabled(), true, 'reopen retains host cooldown');
        await page.locator('#modalInputJoinPin').fill('6888');
        await page.waitForFunction(() => !document.getElementById('modalBtnConfirmJoinPin').disabled);
        await page.locator('#modalBtnConfirmJoinPin').click();
        await page.waitForFunction(() => document.body.dataset.roomMode === 'joined');
        await page.locator('#joinRoomPinModal').waitFor({ state: 'hidden' });
        for (const width of [1280, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            const heading = await page.locator('#currentViewingDeviceTitle').boundingBox();
            assert.ok(heading.width >= 100 && heading.height < 55, 'file heading must not collapse into one Chinese character per line');
        }
        for (const src of ['/api/download/preview', origin + '/api/download/preview']) {
            messages.push({ id: String(++serial), senderName: 'Mac 图片测试', senderIp: '169.254.142.249', content: `[image:${src}]`, timestamp: Date.now() + serial });
        }
        await page.evaluate(() => WenBox.scheduler.runNow());
        await page.waitForFunction(() => [...document.querySelectorAll('.chat-img-thumb')].filter(img => img.naturalWidth > 0).length === 2);
        await page.locator('.chat-img-thumb').last().click();
        await page.locator('#chatImageModal').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await page.locator('#chatImageModal').waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(screenshots, 'joined-file-sidebar.png') });
        await page.waitForFunction(() => !document.getElementById('joinRoomPinModal').open);
        await page.locator('#webChatMessageInput').fill('加入后仍能发送消息'); await page.locator('#webBtnSendMessage').click();
        await page.locator('.chat-text').filter({ hasText: '加入后仍能发送消息' }).waitFor();
        for (const width of [1440, 1024, 768, 390]) await snapshot('joined', 'dark', width);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator('#btnLeaveRoom').click(); await page.locator('#appConfirmOkBtn').click();
        await page.waitForFunction(() => document.body.dataset.roomMode === 'client');
        assert.deepEqual(browserErrors, []); assert.deepEqual(failures, []);
        console.log('Browser regression passed: strict CSP, create/join/leave, PIN modes/reveal/429 cooldown, optimistic messages/retry/reconciliation/avatars, code copy, upload/cancel/retry, download, tools, tablet drawer, mobile segments, and light/dark screenshots.');
    } catch (error) {
        await page?.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }).catch(() => {});
        console.error('Browser errors:', browserErrors);
        console.error('Fixture routes:', failures);
        throw error;
    } finally {
        await browser?.close(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
