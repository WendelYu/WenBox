// Electron's local-only IPC adapter. No LAN HTTP proxy route is exposed.
const http = require('node:http');
const https = require('node:https');
const limit = 4 * 1024 * 1024;
function apiRequest(input) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(input.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw Error('仅支持无内嵌凭据的 HTTP/HTTPS 地址');
            if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method)) throw Error('不支持的 HTTP 方法');
            if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000) throw Error('超时需为 1–120 秒');
            if (input.body != null && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 1024 * 1024)) throw Error('请求体不能超过 1 MiB');
            if (['GET', 'HEAD'].includes(input.method) && input.body) throw Error('GET/HEAD 不发送请求体');
            if (!Array.isArray(input.headers) || input.headers.length > 128) throw Error('请求头过多');
        } catch (error) { reject(error); return; }
        const headers = { 'accept-encoding': 'identity' };
        let headerBytes = 0;
        try {
            for (const h of input.headers) {
                http.validateHeaderName(h.name); http.validateHeaderValue(h.name, h.value);
                headerBytes += Buffer.byteLength(h.name + h.value);
                if (headerBytes > 65536) throw Error('请求头过大');
                const name = h.name.toLowerCase();
                if (['host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding', 'proxy-authorization'].includes(name)) throw Error(`请求头 ${h.name} 由客户端管理，请移除后发送`);
                headers[name] = h.value;
            }
        } catch (error) { reject(error); return; }
        const start = performance.now();
        const request = (url.protocol === 'https:' ? https : http).request(url, { method: input.method, headers }, response => {
            const parts = []; let size = 0, settled = false;
            function finish(truncated) {
                if (settled) return; settled = true;
                const responseHeaders = [];
                for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.push({ name: response.rawHeaders[i], value: response.rawHeaders[i + 1] });
                resolve({ status: response.statusCode, statusText: response.statusMessage || '', headers: responseHeaders, body: Buffer.concat(parts).toString('utf8'), size, truncated, elapsedMs: Math.round(performance.now() - start) });
            }
            response.on('data', bytes => {
                const keep = bytes.subarray(0, limit - size); parts.push(keep); size += keep.length;
                if (keep.length < bytes.length) { finish(true); response.destroy(); }
            });
            response.on('end', () => finish(false));
            response.on('error', reject);
        });
        const timer = setTimeout(() => request.destroy(Error('请求超时')), input.timeoutMs);
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
        request.end(input.body ?? undefined);
    });
}
module.exports = { apiRequest };
