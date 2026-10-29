package com.landrop.server

import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.Response.Status
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** No file bytes are read or stored until a recipient explicitly requests them. */
class DemandFiles {
    private data class Offer(val id: String, val owner: String, val sender: String, val file: JSONObject, val visible: Boolean, val cancelled: AtomicBoolean = AtomicBoolean())
    private class Transfer(val offer: Offer) {
        val id = UUID.randomUUID().toString()
        val secret = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
        val created = System.nanoTime()
        var claimed = false
        val ready = CountDownLatch(1)
        val queue = ArrayBlockingQueue<ByteArray>(4)
        val closed = AtomicBoolean()
    }
    private val offers = linkedMapOf<String, Offer>()
    private val owners = mutableMapOf<String, Long>()
    private val pending = mutableMapOf<String, Transfer>()
    private var room = ""
    @Synchronized private fun room(id: String) {
        if (room == id) return
        offers.values.forEach { it.cancelled.set(true) }
        pending.values.forEach { it.closed.set(true); it.ready.countDown() }
        offers.clear(); owners.clear(); pending.clear(); room = id
    }
    private fun online(owner: String) = owners[owner]?.let { System.nanoTime() - it < TimeUnit.SECONDS.toNanos(12) } == true
    private fun public(o: Offer) = JSONObject(o.file.toString()).put("id", o.id).put("path", "").put("onDemand", true).put("ownerName", o.sender).put("online", online(o.owner))
    @Synchronized fun list(roomId: String): JSONArray {
        room(roomId)
        return JSONArray().apply { offers.values.filter { it.visible }.forEach { put(public(it)) } }
    }
    private fun json(status: Status, value: JSONObject) = NanoHTTPD.newFixedLengthResponse(status, "application/json; charset=utf-8", value.toString())
    private fun error(status: Status, message: String) = json(status, JSONObject().put("success", false).put("message", message))
    private fun validKey(key: String) = key.length == 64 && key.all { it in "0123456789abcdefABCDEF" }
    fun handle(session: NanoHTTPD.IHTTPSession, roomId: String): NanoHTTPD.Response {
        synchronized(this) { room(roomId); pending.entries.removeAll { System.nanoTime() - it.value.created > TimeUnit.SECONDS.toNanos(20) } }
        val uri = session.uri
        val key = session.headers["x-share-key"].orEmpty()
        return when {
            uri == "/api/offers" && session.method == NanoHTTPD.Method.POST -> {
                val size = session.headers["content-length"]?.toIntOrNull() ?: -1
                if (size !in 1..65536) return error(Status.BAD_REQUEST, "分享信息过大或无效")
                val bytes = ByteArray(size); var offset = 0
                while (offset < size) { val n = session.inputStream.read(bytes, offset, size-offset); if (n <= 0) return error(Status.BAD_REQUEST, "分享信息不完整"); offset += n }
                val body = JSONObject(String(bytes, Charsets.UTF_8))
                val owner = body.optString("ownerKey"); val sender = body.optString("senderName"); val scope = body.optString("scope"); val files = body.optJSONArray("files") ?: JSONArray()
                if (!validKey(owner) || sender.length > 256 || scope !in listOf("room", "chat") || files.length() !in 1..32) return error(Status.BAD_REQUEST, "分享信息无效")
                val input = (0 until files.length()).map { files.getJSONObject(it) }
                if (input.any { f -> runCatching { UUID.fromString(f.getString("clientId")) }.isFailure || f.optString("name").isEmpty() || f.optString("name").length > 1024 || f.optString("name").any { it == '\u0000' || it == '\r' || it == '\n' } || f.optLong("size", -1) !in 0..1099511627776L || f.optString("mimeType").length > 128 }) return error(Status.BAD_REQUEST, "文件信息无效")
                synchronized(this) {
                    if (offers.size + input.size > 512) return error(Status.BAD_REQUEST, "房间分享文件过多")
                    owners[owner] = System.nanoTime()
                    val result = JSONArray()
                    input.forEach { f ->
                        val clean = JSONObject().put("clientId", f.getString("clientId")).put("name", f.getString("name")).put("size", f.getLong("size")).put("mimeType", f.optString("mimeType", "application/octet-stream"))
                        val offer = Offer("offer-${UUID.randomUUID()}", owner, sender, clean, scope == "room")
                        offers[offer.id] = offer; result.put(public(offer))
                    }
                    json(Status.OK, JSONObject().put("success", true).put("files", result))
                }
            }
            uri == "/api/offers/requests" && session.method == NanoHTTPD.Method.GET -> synchronized(this) {
                if (!validKey(key)) return error(Status.FORBIDDEN, "分享凭据无效")
                val jobs = JSONArray()
                if (offers.values.any { it.owner == key }) {
                    owners[key] = System.nanoTime()
                    pending.values.filter { it.offer.owner == key && !it.claimed }.forEach { t ->
                        t.claimed = true
                        jobs.put(JSONObject().put("requestId", t.id).put("secret", t.secret).put("clientId", t.offer.file.getString("clientId")).put("fileId", t.offer.id))
                    }
                }
                json(Status.OK, JSONObject().put("jobs", jobs))
            }
            uri == "/api/offers/revoke" && session.method == NanoHTTPD.Method.POST -> synchronized(this) {
                if (!validKey(key)) return error(Status.FORBIDDEN, "分享凭据无效")
                val id = session.headers["x-share-file"].orEmpty()
                offers.entries.removeAll { (_, o) -> (o.owner == key && (id.isEmpty() || id == o.id)).also { if (it) o.cancelled.set(true) } }
                pending.entries.removeAll { (_, t) -> t.offer.cancelled.get().also { if (it) { t.closed.set(true); t.ready.countDown() } } }
                json(Status.OK, JSONObject().put("success", true))
            }
            uri.startsWith("/api/download/offer-") && session.method == NanoHTTPD.Method.GET -> {
                val transfer = synchronized(this) {
                    val offer = offers[uri.substringAfterLast('/')] ?: return error(Status.GONE, "文件分享已失效")
                    if (!online(offer.owner)) return error(Status.GONE, "发送方已离线，请让对方保持 WenBox 打开")
                    if (pending.size >= 16) return error(Status.SERVICE_UNAVAILABLE, "当前下载较多，请稍后重试")
                    Transfer(offer).also { pending[it.id] = it }
                }
                if (!transfer.ready.await(20, TimeUnit.SECONDS) || transfer.closed.get()) {
                    synchronized(this) { pending.remove(transfer.id) }; transfer.closed.set(true)
                    return error(Status.SERVICE_UNAVAILABLE, "发送方未响应，请确认在线后重试")
                }
                val stream = object : InputStream() {
                    var chunk = ByteArray(0); var offset = 0
                    override fun read(): Int { val b = ByteArray(1); return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 255 }
                    override fun read(b: ByteArray, off: Int, len: Int): Int {
                        if (len == 0) return 0
                        if (transfer.closed.get() || transfer.offer.cancelled.get()) throw IOException("文件分享已取消")
                        if (offset == chunk.size) { chunk = transfer.queue.poll(20, TimeUnit.SECONDS) ?: throw IOException("传输超时"); offset = 0; if (chunk.isEmpty()) return -1 }
                        val n = minOf(len, chunk.size-offset); chunk.copyInto(b, off, offset, offset+n); offset += n; return n
                    }
                    override fun close() { transfer.closed.set(true); transfer.queue.clear() }
                }
                NanoHTTPD.newFixedLengthResponse(Status.OK, "application/octet-stream", stream, transfer.offer.file.getLong("size")).apply {
                    addHeader("Content-Disposition", "attachment; filename*=UTF-8''" + URLEncoder.encode(transfer.offer.file.getString("name"), "UTF-8").replace("+", "%20"))
                }
            }
            uri.startsWith("/api/offers/transfer/") && session.method == NanoHTTPD.Method.POST -> {
                val parts = uri.removePrefix("/api/offers/transfer/").split('/')
                val transfer = synchronized(this) {
                    if (parts.size != 2) return error(Status.FORBIDDEN, "传输凭据无效")
                    val t = pending[parts[0]] ?: return error(Status.GONE, "下载请求已失效")
                    if (t.secret != parts[1]) return error(Status.FORBIDDEN, "传输凭据无效")
                    pending.remove(t.id); t
                }
                var remaining = transfer.offer.file.getLong("size")
                if (session.headers["content-length"]?.toLongOrNull() != remaining) { transfer.closed.set(true); transfer.ready.countDown(); return error(Status.BAD_REQUEST, "文件大小不匹配") }
                transfer.ready.countDown()
                try {
                    val buffer = ByteArray(32768)
                    while (remaining > 0) {
                        if (transfer.closed.get() || transfer.offer.cancelled.get()) throw IOException("下载已取消")
                        val count = session.inputStream.read(buffer, 0, minOf(remaining, buffer.size.toLong()).toInt())
                        if (count <= 0) throw IOException("文件读取中断")
                        if (!transfer.queue.offer(buffer.copyOf(count), 20, TimeUnit.SECONDS)) throw IOException("接收方未响应")
                        remaining -= count
                    }
                    json(Status.OK, JSONObject().put("success", true).put("fileId", transfer.offer.id))
                } catch (_: Exception) { transfer.closed.set(true); error(Status.BAD_REQUEST, "文件传输中断") }
            }
            else -> error(Status.NOT_FOUND, "接口不存在")
        }
    }
}
