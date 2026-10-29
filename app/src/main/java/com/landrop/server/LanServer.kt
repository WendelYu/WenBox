package com.landrop.server

import android.content.Context
import android.os.Build
import com.landrop.utils.NetworkUtils
import com.landrop.utils.UdpDiscoveryManager
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

class LanServer(
    private val context: Context,
    private val serverPort: Int = 9527
) : NanoHTTPD(serverPort) {

    private val demandFiles = DemandFiles()

    companion object {
        /** 房间控制类接口的请求体上限 (S4) */
        private const val CTRL_MAX_BYTES = 64 * 1024
        /** PIN 连续失败锁定阈值与锁定时长 (S8) */
        private const val PIN_MAX_FAILURES = 5
        private const val PIN_LOCK_MS = 60_000L
    }

    /** PIN 失败计数: 客户端 IP -> (最近失败时间, 连续失败次数) (S8) */
    private val pinFailures = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Int>>()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        // Origin / Host 校验：外部网页（含 DNS rebinding）不得访问本机服务 (S1)
        if (!isOriginAllowed(session) || !isHostAllowed(session)) {
            return cors(newFixedLengthResponse(
                Response.Status.FORBIDDEN,
                "application/json; charset=UTF-8",
                "{\"success\":false,\"forbidden\":true,\"message\":\"拒绝跨站访问：请通过本机界面或局域网地址访问\"}"
            ), session)
        }

        // 统一处理 OPTIONS 请求 (CORS 预检)
        if (method == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, ""), session)
        }

        // 统一鉴权：密码保护房间的敏感接口要求有效房间令牌 (与桌面端行为一致)
        val isProtected = uri == "/api/files" || uri == "/api/files/clear" || uri == "/api/received_files"
                || uri.startsWith("/api/download/") || uri.startsWith("/api/offers") || uri == "/api/upload" || uri.startsWith("/api/messages")
        if (isProtected && !isRequestAuthorized(session)) {
            return cors(newFixedLengthResponse(
                Response.Status.UNAUTHORIZED,
                "application/json; charset=UTF-8",
                "{\"success\":false,\"unauthorized\":true,\"message\":\"未授权：请先输入房间密码加入房间\"}"
            ), session)
        }

        val response = try {
            // 控制类接口的请求体上限，超限直接 413 (S4)
            if (method == Method.POST && !uri.startsWith("/api/offers/transfer/") && session.headers["content-length"]?.toLongOrNull()?.let { it > CTRL_MAX_BYTES } == true) {
                newFixedLengthResponse(
                    Response.Status.PAYLOAD_TOO_LARGE,
                    "application/json; charset=UTF-8",
                    "{\"success\":false,\"message\":\"请求体过大\"}"
                )
            } else {
            when {
                uri.startsWith("/api/offers") || uri.startsWith("/api/download/offer-") -> demandFiles.handle(session, RoomManager.currentRoom?.roomId.orEmpty())
                uri == "/demand-files.js" -> serveAsset("web/demand-files.js", "application/javascript; charset=UTF-8")
                // 1. 静态资源路由
                uri == "/" || uri == "/index.html" -> serveAsset("web/index.html", "text/html; charset=UTF-8")
                uri == "/style.css" -> serveAsset("web/style.css", "text/css; charset=UTF-8")
                uri == "/app.js" -> serveAsset("web/app.js", "application/javascript; charset=UTF-8")
                uri == "/kvm.js" -> serveAsset("web/kvm.js", "application/javascript; charset=UTF-8")
                uri == "/kvm.css" -> serveAsset("web/kvm.css", "text/css; charset=UTF-8")
                uri == "/runtime.js" -> serveAsset("web/runtime.js", "application/javascript; charset=UTF-8")
                uri == "/upload-queue.js" -> serveAsset("web/upload-queue.js", "application/javascript; charset=UTF-8")
                uri == "/ui-state.js" -> serveAsset("web/ui-state.js", "application/javascript; charset=UTF-8")
                uri == "/theme.js" -> serveAsset("web/theme.js", "application/javascript; charset=UTF-8")
                uri == "/workspace.css" -> serveAsset("web/workspace.css", "text/css; charset=UTF-8")
                uri == "/tokens.css" -> serveAsset("web/tokens.css", "text/css; charset=UTF-8")
                uri == "/icons.svg" -> serveAsset("web/icons.svg", "image/svg+xml; charset=UTF-8")
                uri == "/logo.png" || uri == "/favicon.png" || uri == "/apple-touch-icon.png" ->
                    serveAsset("web/logo.png", "image/png")

                // 1.4 已发现房间列表
                method == Method.GET && uri == "/api/discovered_rooms" -> {
                    val rooms = UdpDiscoveryManager.getRooms().toMutableList()
                    val curRoom = RoomManager.currentRoom
                    if (curRoom != null && curRoom.isActive) {
                        val selfIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                        if (rooms.none { it.roomId == curRoom.roomId || it.ip == selfIp }) {
                            rooms.add(0, com.landrop.model.DiscoveredRoom(
                                roomId = curRoom.roomId,
                                roomName = curRoom.roomName,
                                hostDevice = curRoom.hostDevice,
                                ip = selfIp,
                                port = curRoom.hostPort,
                                needPassword = curRoom.needPassword,
                                memberCount = RoomManager.getMembers().size,
                                lastSeen = System.currentTimeMillis()
                            ))
                        }
                    }
                    val jsonArray = JSONArray()
                    for (r in rooms) {
                        val item = JSONObject().apply {
                            put("roomId", r.roomId)
                            put("roomName", r.roomName)
                            put("hostDevice", r.hostDevice)
                            put("ip", r.ip)
                            put("port", r.port)
                            put("needPassword", r.needPassword)
                            put("memberCount", r.memberCount)
                            put("lastSeen", r.lastSeen)
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("rooms", jsonArray)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                }

                // 1.41 房间状态
                method == Method.GET && uri == "/api/room/status" -> {
                    val room = RoomManager.currentRoom
                    val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                    val token = session.headers["x-host-token"] ?: session.headers["x-room-token"]
                    val hostToken = RoomManager.currentHostToken
                    val isHost = room != null && room.isActive && !hostToken.isNullOrBlank() && token == hostToken
                    val json = if (room != null && room.isActive) {
                        JSONObject().apply {
                            put("isActive", true)
                            put("roomId", room.roomId)
                            put("roomName", room.roomName)
                            put("needPassword", room.needPassword)
                            put("hostDevice", room.hostDevice)
                            put("hostIp", primaryIp)
                            put("hostPort", serverPort)
                            put("memberCount", RoomManager.getMembers().size)
                            put("isHost", isHost)
                        }
                    } else {
                        JSONObject().apply {
                            put("isActive", false)
                            put("isHost", false)
                        }
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", json.toString())
                }

                // 1.42 创建房间
                method == Method.POST && uri == "/api/room/create" -> {
                    // 同一服务端同时只有一个活跃房间: 已有房间进行中时拒绝再建，
                    // 防止浏览器访客建房覆盖设备原生端的房间，原房主解散时误伤新房间
                    if (RoomManager.currentRoom?.isActive == true) {
                        newFixedLengthResponse(
                            Response.Status.CONFLICT,
                            "application/json; charset=UTF-8",
                            "{\"success\":false,\"message\":\"本机已有进行中的房间，请直接加入该房间；如需另建新房间，请先由本机解散现有房间\"}"
                        )
                    } else {
                        val map = HashMap<String, String>()
                        try { session.parseBody(map) } catch (_: Exception) {}
                        val postData = getUtf8PostData(map)
                        var rName = ""
                        var pin = ""
                        var creatorName = ""
                        var creatorPlatform = ""
                        if (!postData.isNullOrBlank()) {
                            try {
                                val json = JSONObject(postData)
                                rName = json.optString("roomName", "")
                                pin = json.optString("pin", "")
                                creatorName = json.optString("creatorName", "")
                                creatorPlatform = json.optString("creatorPlatform", "")
                            } catch (_: Exception) {}
                        }
                        val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                        val clientIp = session.remoteIpAddress ?: "127.0.0.1"
                        val hostDev = if (creatorName.isNotBlank()) creatorName else "${Build.BRAND} ${Build.MODEL}"
                        val hostDisplayIp = if (clientIp != "127.0.0.1" && clientIp != "::1") clientIp else primaryIp
                        val cfg = RoomManager.createRoom(
                            roomName = rName,
                            pin = pin,
                            hostDevice = hostDev,
                            hostIp = hostDisplayIp,
                            hostPort = serverPort
                        )
                        val result = JSONObject().apply {
                            put("isActive", cfg.isActive)
                            put("roomId", cfg.roomId)
                            put("roomName", cfg.roomName)
                            put("pin", cfg.pin)
                            put("needPassword", cfg.needPassword)
                            put("hostDevice", cfg.hostDevice)
                            put("hostIp", cfg.hostIp)
                            put("hostPort", cfg.hostPort)
                            put("hostToken", RoomManager.currentHostToken)
                            // 成员 id 与房主 token 分离，公开接口不再泄露凭证 (S2)
                            put("memberId", RoomManager.getHostMemberId())
                        }
                        newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                    }
                }

                // 1.43 解散房间
                method == Method.POST && uri == "/api/room/close" -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    var bodyToken: String? = null
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            bodyToken = if (json.has("hostToken")) json.optString("hostToken") else json.optString("token", null)
                        } catch (_: Exception) {}
                    }
                    val headerToken = session.headers["x-host-token"] ?: session.headers["x-room-token"]
                    val providedToken = if (!headerToken.isNullOrBlank()) headerToken else bodyToken
                    val hostToken = RoomManager.currentHostToken
                    if (hostToken.isNullOrBlank() || providedToken.isNullOrBlank() || !constantTimeEquals(providedToken, hostToken)) {
                        newFixedLengthResponse(Response.Status.FORBIDDEN, "application/json; charset=UTF-8", "{\"success\":false,\"message\":\"无权解散房间：只有房主设备可以解散房间\"}")
                    } else {
                        RoomManager.closeRoom()
                        newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
                    }
                }

                // 1.44 加入房间
                method == Method.POST && uri == "/api/room/join" -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    var pin = ""
                    var clientName = "访客设备"
                    var clientPlatform = "Browser"
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            pin = json.optString("pin", "")
                            clientName = json.optString("name", "访客设备")
                            clientPlatform = json.optString("platform", "Browser")
                        } catch (_: Exception) {}
                    }
                    val clientIp = session.headers["http-client-ip"]
                        ?: session.headers["remote-addr"]
                        ?: session.remoteIpAddress
                        ?: "127.0.0.1"
                    val accessIp = session.headers["host"] ?: ""

                    // PIN 频控：连续失败 5 次锁定 60 秒 (S8)
                    val lockedForMs = lockRemainingMs(clientIp)
                    if (lockedForMs > 0) {
                        val seconds = (lockedForMs + 999) / 1000
                        val lockedJson = JSONObject().apply {
                            put("success", false)
                            put("message", "尝试过多，请 $seconds 秒后再试")
                            put("token", "")
                            put("memberId", "")
                            put("retryAfter", seconds)
                            put("room", JSONObject.NULL)
                        }
                        newFixedLengthResponse(Response.Status.TOO_MANY_REQUESTS, "application/json; charset=UTF-8", lockedJson.toString())
                    } else {
                        val room = RoomManager.currentRoom
                        val pinRejected = room != null && room.isActive && room.needPassword &&
                            !constantTimeEquals(pin.trim(), room.pin.trim())
                        if (pinRejected) recordPinFailure(clientIp) else clearPinFailures(clientIp)

                        val (ok, msg, token) = RoomManager.verifyAndJoin(pin, clientName, clientIp, clientPlatform, accessIp)
                        val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                        val roomObj = if (ok && room != null) {
                            JSONObject().apply {
                                put("roomId", room.roomId)
                                put("roomName", room.roomName)
                                put("hostDevice", room.hostDevice)
                                put("hostIp", primaryIp)
                                put("hostPort", serverPort)
                            }
                        } else JSONObject.NULL

                        val result = JSONObject().apply {
                            put("success", ok)
                            put("message", msg)
                            put("token", token)
                            put("memberId", RoomManager.getMemberIdByToken(token))
                            put("retryAfter", 0)
                            put("room", roomObj)
                        }
                        newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                    }
                }

                // 1.45 房间心跳
                method == Method.POST && uri == "/api/room/heartbeat" -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    var clientName: String? = null
                    var clientPlatform: String? = null
                    var token: String? = session.headers["x-room-token"]
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            clientName = json.optString("name", null)
                            clientPlatform = json.optString("platform", null)
                            if (token.isNullOrBlank()) {
                                token = json.optString("token", null)
                            }
                        } catch (_: Exception) {}
                    }
                    val clientIp = session.headers["http-client-ip"]
                        ?: session.headers["remote-addr"]
                        ?: session.remoteIpAddress
                        ?: "127.0.0.1"
                    val accessIp = session.headers["host"] ?: ""
                    // token == "host" 是房主的保留键，不得被普通客户端改写 (S3)
                    val safeToken = token?.trim()?.takeIf { it.isNotEmpty() && it != "host" }
                    RoomManager.heartbeat(clientIp, clientName, clientPlatform, safeToken, accessIp)
                    val room = RoomManager.currentRoom
                    val result = JSONObject().apply {
                        put("success", true)
                        put("memberId", RoomManager.getMemberIdByToken(safeToken))
                        if (room != null) {
                            put("room", JSONObject().apply {
                                put("isActive", room.isActive)
                                put("roomId", room.roomId)
                                put("roomName", room.roomName)
                                put("hostDevice", room.hostDevice)
                                put("needPassword", room.needPassword)
                            })
                        }
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                }

                // 1.455 离开房间
                method == Method.POST && uri == "/api/room/leave" -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    var token: String? = session.headers["x-room-token"]
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            if (token.isNullOrBlank()) {
                                token = json.optString("token", null)
                            }
                        } catch (_: Exception) {}
                    }
                    // RoomManager.leaveRoom 内部会拒绝保留键 "host" (S3)
                    if (!token.isNullOrBlank()) {
                        RoomManager.leaveRoom(token)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
                }

                // 1.46 房间成员
                method == Method.GET && uri == "/api/room/members" -> {
                    val members = RoomManager.getMembers()
                    // 密码房下未授权访客只能拿到在线人数，成员 id 不对外泄露 (S2)
                    val authorized = isRequestAuthorized(session)
                    val jsonArray = JSONArray()
                    if (authorized) {
                        for (m in members) {
                            val item = JSONObject().apply {
                                put("id", m.id)
                                put("name", m.name)
                                put("ip", m.ip)
                                put("platform", m.platform)
                                put("accessIp", m.accessIp)
                                put("joinedAt", m.joinedAt)
                                put("lastSeen", m.lastSeen)
                            }
                            jsonArray.put(item)
                        }
                    }
                    val result = JSONObject().apply {
                        put("members", jsonArray)
                        put("count", members.size)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                }

                // 1.47 切换展示网卡 IP
                method == Method.POST && uri.startsWith("/api/room/set_ip") -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    var requestedIp = ""
                    if (!postData.isNullOrBlank()) {
                        try {
                            requestedIp = JSONObject(postData).optString("ip", "").trim()
                        } catch (_: Exception) {}
                    }
                    // 只有本机可信回环调用或持有房主令牌的请求才能改地址，
                    // 且该 IP 必须属于本机网卡，否则任意访客都能劫持房间地址 (S5)
                    val trusted = isTrustedLoopback(session) || isHostTokenRequest(session)
                    val isLocalIp = requestedIp.isNotBlank() &&
                        NetworkUtils.getAllLocalIpAddresses(context).any { it.ip == requestedIp }
                    if (!trusted || !isLocalIp) {
                        newFixedLengthResponse(
                            Response.Status.FORBIDDEN,
                            "application/json; charset=UTF-8",
                            "{\"success\":false,\"message\":\"无权修改房间地址，或该 IP 不属于本机网卡\"}"
                        )
                    } else {
                        RoomManager.setHostIp(requestedIp)
                        newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
                    }
                }

                // 1.5 服务状态信息 (供局域网其他设备/网页感知本端信息)
                method == Method.GET && uri == "/api/status" -> {
                    val primaryIp = RoomManager.currentRoom?.hostIp?.ifBlank { null }
                        ?: NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                    val allIps = NetworkUtils.getAllLocalIpAddresses(context).map {
                        JSONObject().apply {
                            put("ip", it.ip)
                            put("name", it.name)
                            put("is_preferred", it.isEthernet || it.isHotspot)
                        }
                    }
                    val room = RoomManager.currentRoom
                    val roomJson = if (room != null && room.isActive) {
                        JSONObject().apply {
                            put("isActive", true)
                            put("roomId", room.roomId)
                            put("roomName", room.roomName)
                            put("needPassword", room.needPassword)
                        }
                    } else {
                        JSONObject().apply {
                            put("isActive", false)
                        }
                    }
                    val json = JSONObject().apply {
                        put("device", "${Build.BRAND} ${Build.MODEL}")
                        put("ip", primaryIp)
                        put("all_ips", JSONArray(allIps))
                        put("port", serverPort)
                        put("running", true)
                        put("platform", "Android")
                        put("version", com.landrop.BuildConfig.VERSION_NAME)
                        put("room", roomJson)
                    }
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=UTF-8",
                        json.toString()
                    )
                }

                // 1.6 在线节点列表
                method == Method.GET && uri == "/api/devices" -> {
                    val devices = UdpDiscoveryManager.getDevices()
                    val jsonArray = JSONArray()
                    for (d in devices) {
                        val item = JSONObject().apply {
                            put("name", d.name)
                            put("ip", d.ip)
                            put("port", d.port)
                            put("platform", d.platform)
                            put("lastSeen", d.lastSeen)
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("devices", jsonArray)
                    }
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=UTF-8",
                        result.toString()
                    )
                }

                // 1.7 局域网节点主动握手 / 探测
                method == Method.POST && uri == "/api/probe" -> {
                    handleProbe(session)
                }

                // 1.8 清空待发共享列表（仅限房主令牌，与桌面端一致）
                method == Method.POST && uri == "/api/files/clear" -> {
                    if (RoomManager.currentRoom?.isActive == true && !isHostTokenRequest(session) && !isTrustedLoopback(session)) {
                        newFixedLengthResponse(
                            Response.Status.FORBIDDEN,
                            "application/json; charset=UTF-8",
                            "{\"success\":false,\"message\":\"无权清空共享列表：仅限房主操作\"}"
                        )
                    } else {
                        FileManager.clearSharedOnly()
                        newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
                    }
                }

                // 2. 获取待下载文件列表
                method == Method.GET && uri == "/api/files" -> {
                    val files = FileManager.getFiles()
                    val jsonArray = JSONArray()
                    for (f in files) {
                        val item = JSONObject().apply {
                            put("id", f.id)
                            put("name", f.name)
                            put("size", f.size)
                            put("mimeType", f.mimeType)
                        }
                        jsonArray.put(item)
                    }
                    val offered = demandFiles.list(RoomManager.currentRoom?.roomId.orEmpty())
                    for (index in 0 until offered.length()) jsonArray.put(offered.getJSONObject(index))
                    val result = JSONObject().apply {
                        put("files", jsonArray)
                    }
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=UTF-8",
                        result.toString()
                    )
                }

                // 2.5 获取已接收文件列表
                method == Method.GET && uri == "/api/received_files" -> {
                    val files = FileManager.getReceivedFiles()
                    val jsonArray = JSONArray()
                    for (f in files) {
                        val item = JSONObject().apply {
                            put("id", f.id)
                            put("name", f.name)
                            put("size", f.size)
                            put("mimeType", f.mimeType)
                            put("path", "Download/WenBox/" + f.name)
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("files", jsonArray)
                    }
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=UTF-8",
                        result.toString()
                    )
                }

                // 3. 单文件流式下载
                method == Method.GET && uri.startsWith("/api/download/") -> {
                    val rawId = uri.removePrefix("/api/download/")
                    val fileId = try {
                        URLDecoder.decode(rawId, StandardCharsets.UTF_8.name())
                    } catch (_: Exception) {
                        rawId
                    }
                    val file = FileManager.getFileById(fileId)
                    if (file == null) {
                        newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "File not found")
                    } else {
                        val inputStream: InputStream? = context.contentResolver.openInputStream(file.uri)
                        if (inputStream == null) {
                            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Cannot open stream")
                        } else {
                            val encodedFilename = URLEncoder.encode(file.name, StandardCharsets.UTF_8.name())
                                .replace("+", "%20")
                            // filename 字段仅保留可见 ASCII (部分服务端/客户端不接受非 ASCII 头), 中文由 RFC 5987 的 filename* 传递
                            val asciiFallback = file.name.map { ch ->
                                if (ch.code in 33..126 && ch != '"' && ch != '\\') ch else '_'
                            }.joinToString("").ifBlank { "file" }
                            val mime = file.mimeType.ifBlank { "application/octet-stream" }
                            val resp = if (file.size > 0) {
                                newFixedLengthResponse(Response.Status.OK, mime, inputStream, file.size)
                            } else {
                                // 部分 ContentProvider 上报大小为 0，定长响应会把传输截断为 0 字节，退化为分块流式
                                newChunkedResponse(Response.Status.OK, mime, inputStream)
                            }
                            resp.addHeader(
                                "Content-Disposition",
                                "attachment; filename=\"$asciiFallback\"; filename*=UTF-8''$encodedFilename"
                            )
                            resp
                        }
                    }
                }

                // 4. 电脑端文件上传到手机
                method == Method.POST && uri == "/api/upload" -> {
                    handleFileUpload(session)
                }

                // 5. 局域网即时消息获取
                method == Method.GET && uri == "/api/messages" -> {
                    val sinceParam = session.parameters["since"]?.firstOrNull()?.toLongOrNull() ?: 0L
                    val messages = MessageManager.getMessages(sinceParam)
                    val jsonArray = JSONArray()
                    for (m in messages) {
                        val item = JSONObject().apply {
                            put("id", m.id)
                            put("senderName", m.senderName)
                            put("content", m.content)
                            put("timestamp", m.timestamp)
                            put("isFromPhone", m.isFromPhone)
                            put("senderIp", m.senderIp)
                            put("clientId", m.clientId)
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("messages", jsonArray)
                        put("roomId", RoomManager.currentRoom?.roomId ?: "")
                        put("isActive", RoomManager.currentRoom != null)
                    }
                    val jsonBytes = result.toString().toByteArray(Charsets.UTF_8)
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=utf-8",
                        ByteArrayInputStream(jsonBytes),
                        jsonBytes.size.toLong()
                    )
                }

                // 6. 局域网即时消息发送 (电脑发往手机)
                method == Method.POST && uri == "/api/messages" -> {
                    handleSendMessage(session)
                }

                else -> {
                    newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "404 Not Found")
                }
            }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "500 Error: ${e.message}")
        }

        return cors(response, session)
    }

    private fun serveAsset(assetPath: String, mimeType: String): Response {
        return try {
            val inputStream = context.assets.open(assetPath)
            newChunkedResponse(Response.Status.OK, mimeType, inputStream)
        } catch (e: Exception) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Asset not found: $assetPath")
        }
    }

    private fun handleFileUpload(session: IHTTPSession): Response {
        val files = HashMap<String, String>()
        session.parseBody(files)

        val tempFilePath = files["file"]
        val params = session.parameters
        val originalName = resolveUploadFileName(session, params["file"]?.firstOrNull())

        if (tempFilePath != null) {
            val tempFile = File(tempFilePath)
            if (tempFile.exists()) {
                val sharedFile = FileInputStream(tempFile).use { inStream ->
                    FileManager.cacheLegacyUpload(context, originalName, inStream)
                }
                tempFile.delete()
                if (sharedFile == null) return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json; charset=utf-8", "{\"success\":false,\"message\":\"保存文件失败\"}")
                val resObj = JSONObject().apply {
                    put("success", true)
                    put("fileId", sharedFile.id)
                    put("name", originalName)
                    put("size", sharedFile.size)
                    put("message", "File cached; explicit download required")
                }
                val resBytes = resObj.toString().toByteArray(Charsets.UTF_8)
                return newFixedLengthResponse(
                    Response.Status.OK,
                    "application/json; charset=utf-8",
                    ByteArrayInputStream(resBytes),
                    resBytes.size.toLong()
                )
            }
        }

        return newFixedLengthResponse(
            Response.Status.BAD_REQUEST,
            "application/json",
            "{\"success\": false, \"message\": \"No file received\"}"
        )
    }

    /**
     * 还原上传文件的真实名称：
     * 1. 优先使用 X-File-Name 头 (Android/桌面客户端始终携带，URL 编码无字符集歧义)；
     * 2. 否则取 multipart 表单字段，NanoHTTPD 以 ISO-8859-1 解析头部，
     *    将字节按 ISO-8859-1 还原为 UTF-8 (与 getUtf8PostData 同样的恢复策略)。
     */
    private fun resolveUploadFileName(session: IHTTPSession, rawFormName: String?): String {
        val headerName = session.headers["x-file-name"]?.trim()
        if (!headerName.isNullOrEmpty()) {
            try {
                val decoded = URLDecoder.decode(headerName, StandardCharsets.UTF_8.name())
                if (decoded.isNotBlank()) return sanitizeFileName(decoded)
            } catch (_: Exception) {
            }
        }
        val name = rawFormName?.trim()?.takeUnless { it.isEmpty() }
            ?: "upload_${System.currentTimeMillis()}"
        val recovered = if (name.any { it.code > 0xFF }) {
            name
        } else {
            try {
                val converted = String(name.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
                if (converted.contains('\uFFFD')) name else converted
            } catch (_: Exception) {
                name
            }
        }
        return sanitizeFileName(recovered)
    }

    private fun sanitizeFileName(name: String): String =
        name.substringAfterLast('/').substringAfterLast('\\')
            .ifBlank { "upload_${System.currentTimeMillis()}" }

    /**
     * 密码保护房间的请求鉴权：校验 X-Room-Token / X-Host-Token 头或 ?token= 参数；
     * 本机回环 **且** Origin 通过校验的请求 (房主自己浏览器打开管理页) 才直接放行 (S1)。
     */
    private fun isRequestAuthorized(session: IHTTPSession): Boolean {
        val room = RoomManager.currentRoom ?: return true
        if (!room.isActive || !room.needPassword) return true
        if (isTrustedLoopback(session)) return true
        val headerToken = session.headers["x-room-token"] ?: session.headers["x-host-token"]
        val queryToken = session.parameters["token"]?.firstOrNull()
        val token = headerToken?.trim()?.takeIf { it.isNotEmpty() }
            ?: queryToken?.trim()?.takeIf { it.isNotEmpty() }
        return RoomManager.isAuthorized(token)
    }

    private fun remoteIp(session: IHTTPSession): String {
        return session.headers["http-client-ip"]
            ?: session.headers["remote-addr"]
            ?: session.remoteIpAddress
            ?: ""
    }

    /** 本机回环 + Origin 可信 = 房主自己打开的界面 */
    private fun isTrustedLoopback(session: IHTTPSession): Boolean {
        val ip = remoteIp(session)
        if (ip != "127.0.0.1" && ip != "::1" && !ip.startsWith("127.")) return false
        val origin = session.headers["origin"]
        if (origin.isNullOrBlank()) return true
        if (origin == "null") return false
        return origin.contains("127.0.0.1") || origin.contains("localhost")
    }

    /** 请求是否携带当前房主令牌 */
    private fun isHostTokenRequest(session: IHTTPSession): Boolean {
        val hostToken = RoomManager.currentHostToken ?: return false
        if (hostToken.isBlank()) return false
        val provided = session.headers["x-host-token"]
            ?: session.headers["x-room-token"]
            ?: session.parameters["token"]?.firstOrNull()
            ?: return false
        return constantTimeEquals(provided.trim(), hostToken)
    }

    /**
     * 判断 Host / Origin 里的主机名是否属于本机或局域网地址。
     * 阻断任意外部网页通过 fetch('http://127.0.0.1:9527/...') 读取本机文件与消息 (S1)。
     */
    private fun isLanOrLoopbackHost(rawHost: String?): Boolean {
        val host = rawHost?.trim().orEmpty()
        if (host.isEmpty()) return false
        val withoutBracket = if (host.startsWith("[")) host.substringAfter("[").substringBefore("]") else host
        val bare = if (withoutBracket.contains(":") && !withoutBracket.contains("::")) {
            withoutBracket.substringBefore(":")
        } else {
            withoutBracket
        }
        if (bare.equals("localhost", ignoreCase = true) || bare.equals("tauri.localhost", ignoreCase = true)) {
            return true
        }
        return try {
            val address = InetAddress.getByName(bare)
            address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress
        } catch (_: Exception) {
            false
        }
    }

    private fun isOriginAllowed(session: IHTTPSession): Boolean {
        val origin = session.headers["origin"]
        if (origin.isNullOrBlank()) return true
        if (origin == "null") return false
        if (origin.startsWith("tauri://") || origin.startsWith("https://tauri.localhost")) return true
        return isLanOrLoopbackHost(origin.substringAfter("://", ""))
    }

    private fun isHostAllowed(session: IHTTPSession): Boolean {
        val host = session.headers["host"] ?: return true
        return isLanOrLoopbackHost(host)
    }

    /** 常量时间比较，避免通过响应时间逐字节推断 PIN / 令牌 (S8) */
    private fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    private fun lockRemainingMs(clientIp: String): Long {
        val entry = pinFailures[clientIp] ?: return 0L
        if (entry.second < PIN_MAX_FAILURES) return 0L
        val elapsed = System.currentTimeMillis() - entry.first
        if (elapsed >= PIN_LOCK_MS) {
            pinFailures.remove(clientIp)
            return 0L
        }
        return PIN_LOCK_MS - elapsed
    }

    private fun recordPinFailure(clientIp: String) {
        val now = System.currentTimeMillis()
        pinFailures.compute(clientIp) { _, existing ->
            if (existing == null || now - existing.first > PIN_LOCK_MS) now to 1
            else now to (existing.second + 1)
        }
        if (pinFailures.size > 256) {
            pinFailures.entries.removeAll { now - it.value.first > PIN_LOCK_MS }
        }
    }

    private fun clearPinFailures(clientIp: String) {
        pinFailures.remove(clientIp)
    }

    private fun handleSendMessage(session: IHTTPSession): Response {
        val map = HashMap<String, String>()
        try { session.parseBody(map) } catch (_: Exception) {}
        val postData = getUtf8PostData(map)
        var content = ""
        var senderName = "成员"
        var senderIp = ""
        var clientId = ""
        val clientIp = session.remoteIpAddress ?: ""

        if (!postData.isNullOrBlank()) {
            try {
                val json = JSONObject(postData)
                content = json.optString("content", "")
                senderName = json.optString("senderName", "成员")
                senderIp = json.optString("senderIp", "")
                clientId = json.optString("clientId", "")
            } catch (_: Exception) {}
        }

        if (content.isBlank()) {
            val params = session.parameters
            content = params["content"]?.firstOrNull() ?: ""
            senderName = params["senderName"]?.firstOrNull() ?: "成员"
            senderIp = params["senderIp"]?.firstOrNull() ?: ""
            clientId = params["clientId"]?.firstOrNull() ?: ""
        }
        if (senderIp.isBlank()) {
            senderIp = if (clientIp == "127.0.0.1" || clientIp == "::1") {
                RoomManager.currentRoom?.hostIp?.ifBlank { null } ?: clientIp
            } else {
                clientIp
            }
        }

        if (content.isNotBlank()) {
            val msg = MessageManager.addClientMessage(content, senderName, senderIp, clientId)
            val respBytes = "{\"success\": true, \"id\": \"${msg.id}\"}".toByteArray(Charsets.UTF_8)
            return newFixedLengthResponse(
                Response.Status.OK,
                "application/json; charset=utf-8",
                ByteArrayInputStream(respBytes),
                respBytes.size.toLong()
            )
        }

        return newFixedLengthResponse(
            Response.Status.BAD_REQUEST,
            "application/json",
            "{\"success\": false, \"message\": \"Content cannot be empty\"}"
        )
    }

    private fun handleProbe(session: IHTTPSession): Response {
        val map = HashMap<String, String>()
        try {
            session.parseBody(map)
        } catch (_: Exception) {}

        val postData = getUtf8PostData(map)
        var devName = "未知设备"
        var devPlatform = "Windows"
        var devPort = 9527
        var clientIp = ""

        if (!postData.isNullOrBlank()) {
            try {
                val json = JSONObject(postData)
                devName = json.optString("device", devName)
                devPlatform = json.optString("platform", devPlatform)
                devPort = json.optInt("port", devPort)
                clientIp = json.optString("ip", "")
            } catch (_: Exception) {}
        }

        if (clientIp.isBlank()) {
            clientIp = session.headers["http-client-ip"]
                ?: session.headers["remote-addr"]
                ?: session.remoteIpAddress
                ?: ""
        }

        if (clientIp.isNotBlank()) {
            UdpDiscoveryManager.registerDevice(devName, clientIp, devPort, devPlatform)
        }

        val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
        val respJson = JSONObject().apply {
            put("device", "${Build.BRAND} ${Build.MODEL}")
            put("ip", primaryIp)
            put("port", serverPort)
            put("running", true)
            put("platform", "Android")
            put("version", com.landrop.BuildConfig.VERSION_NAME)
        }
        val respBytes = respJson.toString().toByteArray(Charsets.UTF_8)
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json; charset=utf-8",
            ByteArrayInputStream(respBytes),
            respBytes.size.toLong()
        )
    }

    private fun getUtf8PostData(map: Map<String, String>): String? {
        val raw = map["postData"] ?: return null
        if (raw.any { it.code > 0xFF }) {
            return raw
        }
        return try {
            val converted = String(raw.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
            if (converted.contains('\uFFFD')) raw else converted
        } catch (_: Exception) {
            raw
        }
    }

    /**
     * 附加 CORS 响应头：只回显已通过校验的 Origin（不再使用 `*`），并声明 Vary: Origin (S1)。
     */
    private fun cors(response: Response, session: IHTTPSession): Response {
        val origin = session.headers["origin"]
        if (!origin.isNullOrBlank() && isOriginAllowed(session)) {
            response.addHeader("Access-Control-Allow-Origin", origin)
            response.addHeader("Vary", "Origin")
        }
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        response.addHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Name, Range, Authorization, X-Room-Token, X-Host-Token, X-Share-Key, X-Share-File")
        return response
    }
}
