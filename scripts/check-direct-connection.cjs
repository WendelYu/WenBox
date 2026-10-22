// Browser regression with a mocked Tauri bridge; no real devices or files are accessed.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { startDesktopServer } = require('../desktop-server');

async function main() {
    const server = await startDesktopServer();
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
        const errors = [];
        async function client(roomId, ip) {
            const page = await browser.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({ roomId, ip }) => {
                const local = { roomId, roomName: `WenBox ${roomId}`, hostDevice: roomId, hostIp: ip, hostPort: 9527,
                    isActive: true, isTauriHost: true, autoConnect: true, canAutoConnect: true, needPassword: false };
                window.fixture = { local, ips: [{ ip: '192.168.8.2', name: 'office' }], rooms: [], joins: [], disconnected: false, failJoin: false };
                window.__TAURI__ = { invoke: async (command, args) => {
                    const f = window.fixture;
                    switch (command) {
                        case 'get_room_status_cmd': return { ...local };
                        case 'get_all_lan_ips_cmd': return f.ips;
                        case 'get_local_ip': return f.ips[0]?.ip || '127.0.0.1';
                        case 'get_discovered_rooms_cmd': return f.rooms;
                        case 'get_room_members_cmd': return [{ id: 'host', name: local.hostDevice, ip }];
                        case 'join_remote_room_cmd': {
                            f.joins.push(args);
                            if (f.failJoin) throw Error('temporary connection failure');
                            await new Promise(resolve => setTimeout(resolve, f.joinDelay || 0));
                            const room = f.rooms.find(room => args.hostUrl === `http://${room.ip}:${room.port}`);
                            return { success: true, token: 'fixture-token', memberId: 'fixture-member', room };
                        }
                        case 'fetch_node_messages':
                            if (f.disconnected) throw Error('cable unplugged');
                            return [];
                        case 'fetch_node_files': case 'get_received_files': return [];
                        default: return true;
                    }
                } };
            }, { roomId, ip });
            await page.route('http://169.254.*/**', async route => {
                const fixture = await page.evaluate(() => ({ disconnected: fixture.disconnected, rooms: fixture.rooms }));
                if (fixture.disconnected) return route.abort();
                const url = new URL(route.request().url());
                const room = fixture.rooms.find(room => room.ip === url.hostname);
                const body = url.pathname === '/api/room/heartbeat' ? { success: true, room: { ...room, isActive: true } }
                    : url.pathname === '/api/room/members' ? { members: [{ id: 'host', name: 'fixture-host', ip: url.hostname }] }
                    : { success: true };
                await route.fulfill({ status: 200, contentType: 'application/json',
                    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Room-Token' }, body: JSON.stringify(body) });
            });
            await page.goto(server.origin);
            await page.waitForFunction(() => document.body.dataset.roomMode === 'host');
            return page;
        }
        const host = await client('aaa', '169.254.18.3');
        const guest = await client('bbb', '169.254.207.8');
        const peer = (roomId, ip) => ({ roomId, roomName: `WenBox ${roomId}`, hostDevice: roomId, ip,
            port: 9527, autoConnect: true, canAutoConnect: true, needPassword: false });
        // No direct-link address yet: office network must not trigger automatic joining.
        await guest.evaluate(() => WenBox.scheduler.runNow());
        await guest.waitForTimeout(400);
        assert.equal(await guest.evaluate(() => fixture.joins.length), 0);
        // USB hotplug after startup, with an office adapter still connected on each end.
        for (const [page, ip, room] of [[host, '169.254.18.3', peer('bbb', '169.254.207.8')], [guest, '169.254.207.8', peer('aaa', '169.254.18.3')]]) {
            await page.evaluate(({ ip, room }) => {
                fixture.ips.push({ ip, name: 'USB Ethernet' }); fixture.rooms = [room]; WenBox.scheduler.runNow();
            }, { ip, room });
        }
        await guest.waitForFunction(() => document.body.dataset.roomMode === 'joined');
        assert.equal(await host.evaluate(() => fixture.joins.length), 0, 'both ends must elect one host');
        assert.doesNotMatch(await host.locator('#directConnectionStatus').innerText(), /已连接/, 'own host address must not count as a connected peer');
        assert.equal(await guest.locator('dialog[open]').count(), 0, 'pairing requires no join dialog');
        assert.match(await guest.locator('#directConnectionStatus').innerText(), /已自动连接/);
        assert.equal(await guest.evaluate(() => fixture.joins[0].expectedRoomId), 'aaa');
        for (const width of [1100, 800, 390]) {
            await guest.setViewportSize({ width, height: 900 });
            assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
        await guest.setViewportSize({ width: 1100, height: 900 });
        // Unplug: repeated failed polling returns to the local room, then reconnects on replug.
        await guest.evaluate(() => { fixture.disconnected = true; fixture.rooms = []; fixture.ips.pop(); WenBox.scheduler.runNow(); });
        await guest.waitForFunction(() => document.body.dataset.roomMode !== 'joined', null, { timeout: 20000 });
        await guest.evaluate(room => {
            fixture.disconnected = false; fixture.rooms = [room]; fixture.ips.push({ ip: '169.254.207.8', name: 'USB Ethernet' }); WenBox.scheduler.runNow();
        }, peer('aaa', '169.254.18.3'));
        await guest.waitForFunction(() => document.body.dataset.roomMode === 'joined');
        assert.equal(await guest.evaluate(() => fixture.joins.length), 2);
        // Explicit leave must not immediately connect again.
        await guest.locator('#btnLeaveRoom').click();
        await guest.locator('#appConfirmOkBtn').click();
        await guest.evaluate(() => WenBox.scheduler.runNow());
        await guest.waitForTimeout(3000);
        assert.equal(await guest.evaluate(() => fixture.joins.length), 2);
        assert.equal(await guest.locator('#directConnectionStatus').isVisible(), false);
        // If the owner uses their room while a join is in flight, keep their local session.
        const busy = await client('ccc', '169.254.22.3');
        await busy.evaluate(room => {
            fixture.ips.push({ ip: '169.254.22.3' }); fixture.rooms = [room]; fixture.joinDelay = 700; WenBox.scheduler.runNow();
        }, peer('aaa', '169.254.18.3'));
        await busy.waitForFunction(() => fixture.joins.length === 1);
        await busy.evaluate(() => { fixture.local.canAutoConnect = false; });
        await busy.waitForTimeout(1000);
        assert.equal(await busy.evaluate(() => document.body.dataset.roomMode), 'host');
        assert.deepEqual(errors, []);
        console.log('Direct connection UI: election, hotplug, disconnect/reconnect, explicit leave and in-flight room use passed.');
    } finally { await browser?.close(); await server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
