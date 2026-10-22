const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Give the renderer an HTTP origin. file:// produces Origin:null, which LAN hosts correctly reject.
async function startDesktopServer({ root = path.join(__dirname, 'app/src/main/assets/web'), backendPort = 9527 } = {}) {
    const webRoot = await fs.realpath(root);
    const upstreamRequests = new Set();
    let origin;
    const server = http.createServer(async (req, res) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        const fail = (status, message) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message }));
        };
        if (req.headers.host !== new URL(origin).host) return fail(403, '无效的主机');
        const site = req.headers['sec-fetch-site'];
        if ((req.headers.origin && req.headers.origin !== origin) || (site && !['same-origin', 'none'].includes(site))) return fail(403, '无效的请求来源');
        // Reject traversal before URL normalization, including encoded path separators.
        let pathname;
        try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch (_) { return fail(400, '无效路径'); }
        if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) return fail(403, '无效路径');
        if (pathname.startsWith('/api/')) {
            const headers = { ...req.headers, host: `127.0.0.1:${backendPort}`, connection: 'close' };
            const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, response => {
                const responseHeaders = { ...response.headers };
                delete responseHeaders.connection; delete responseHeaders['transfer-encoding'];
                // The UI server owns its security policy, never a proxied API response.
                delete responseHeaders['content-security-policy'];
                res.writeHead(response.statusCode, responseHeaders);
                response.on('error', () => res.destroy()); response.pipe(res);
            });
            upstreamRequests.add(upstream);
            upstream.on('close', () => upstreamRequests.delete(upstream));
            upstream.on('error', () => { if (!res.headersSent) fail(503, '本机传输服务未运行，请启动 WenBox Tauri，或手动加入其他设备的房间'); else res.destroy(); });
            upstream.setTimeout(30000, () => upstream.destroy());
            res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
            req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
            return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) return fail(405, '不支持的方法');
        try {
            const file = await fs.realpath(path.join(webRoot, pathname === '/' ? 'index.html' : pathname));
            if (!file.startsWith(webRoot + path.sep)) return fail(403, '无效路径');
            const data = await fs.readFile(file);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
            res.end(req.method === 'HEAD' ? undefined : data);
        } catch (_) { fail(404, '文件不存在'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, close: () => new Promise(resolve => { for (const req of upstreamRequests) req.destroy(); server.close(resolve); server.closeAllConnections(); }) };
}
module.exports = { startDesktopServer };
