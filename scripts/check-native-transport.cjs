// Real Rust IPC handlers + secure Windows-style origin; no user rooms/files involved.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenbox-transport-'));
    const endpointFile = path.join(dir, 'endpoint');
    const rust = spawn('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', 'native_transport::tests::browser_fixture', '--', '--ignored'], {
        env: { ...process.env, WENBOX_TRANSPORT_FIXTURE: endpointFile }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = ''; rust.stdout.on('data', bytes => { logs += bytes; }); rust.stderr.on('data', bytes => { logs += bytes; });
    const rustDone = new Promise(resolve => rust.on('exit', resolve));
    let browser, upstream;
    try {
        for (let i = 0; !fs.existsSync(endpointFile); i++) {
            if (i > 2400 || rust.exitCode !== null) throw Error(logs || 'Rust fixture failed to start');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
        let uploads = 0, beats = 0;
        upstream = http.createServer(async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const token = req.headers['x-room-token'] || url.searchParams.get('token');
            if (token !== 'fixture-token') { res.writeHead(401); return res.end('{}'); }
            if (url.pathname === '/api/download/image') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
            if (url.pathname === '/api/upload') {
                const chunks = []; for await (const chunk of req) chunks.push(chunk);
                assert.ok(Buffer.concat(chunks).includes(png)); uploads++;
                res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: true, fileId: 'image' }));
            }
            if (url.pathname === '/api/room/heartbeat') beats++;
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, members: [{ name: 'Mac' }, { name: 'Windows' }] }));
        });
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const peer = `http://127.0.0.1:${upstream.address().port}`;
        browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()); });
        page.on('requestfailed', req => console.error(req.url().replace(/\/[a-f0-9-]{36}\//, '/capability/'), req.failure()));
        await page.exposeFunction('nativeFixtureInvoke', async (command, args) => {
            const response = await fetch(endpoint.url, { method: 'POST', headers: { 'X-Fixture-Key': endpoint.key }, body: JSON.stringify({ command, args }) });
            const result = await response.json();
            if (result.error) throw Error(result.error);
            return result.value;
        });
        await page.addInitScript(() => { window.__TAURI__ = { invoke: (command, args) => window.nativeFixtureInvoke(command, args) }; });
        const browserHttp = [];
        await page.route('http://**', route => { browserHttp.push(route.request().url()); return route.abort(); });
        const root = path.resolve('app/src/main/assets/web');
        await page.route('https://tauri.localhost/**', async route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (!name) return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self' http:; img-src 'self' http: data:" }, body: '<script src="/runtime.js"></script><script src="/upload-queue.js"></script><img id="image">' });
            return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(root, name), 'utf8') });
        });
        await page.goto('https://tauri.localhost/');
        await page.evaluate(async ({ peer, png }) => {
            const token = 'fixture-token';
            const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
            window.queue = WenBox.createUploadQueue({ sendNative: WenBox.nativeUpload, onComplete: () => { window.uploadDone = true; } });
            window.uploadId = queue.enqueue(new File([bytes], '截图.png', { type: 'image/png' }), { url: peer + '/api/upload', token });
            document.getElementById('image').src = await WenBox.resolveRequestUrl(peer + '/api/download/image?token=' + token);
            const heartbeat = await WenBox.fetchWithTimeout(peer + '/api/room/heartbeat', { method: 'POST', headers: { 'X-Room-Token': token }, body: '{}' });
            if (!heartbeat.ok) throw Error('heartbeat failed');
            window.members = await (await WenBox.fetchWithTimeout(peer + '/api/room/members', { headers: { 'X-Room-Token': token } })).json();
        }, { peer, png: png.toString('base64') });
        await page.waitForFunction(() => window.uploadDone && document.getElementById('image').naturalWidth > 0);
        assert.equal(uploads, 1); assert.equal(beats, 1);
        assert.equal(await page.evaluate(() => members.members.length), 2);
        assert.deepEqual(errors, []);
        assert.deepEqual(browserHttp, [], 'all LAN transfers must use IPC, not browser HTTP');
        console.log('Secure-origin native transport passed: real IPC image upload, protected preview, heartbeat and members with browser HTTP blocked.');
    } finally {
        await browser?.close();
        await new Promise(resolve => upstream ? upstream.close(resolve) : resolve());
        fs.writeFileSync(endpointFile + '.stop', 'stop');
        const status = await rustDone;
        fs.rmSync(dir, { recursive: true, force: true });
        if (status !== 0) throw Error(logs);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
