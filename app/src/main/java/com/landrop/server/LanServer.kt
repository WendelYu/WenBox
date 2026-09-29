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
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class LanServer(
    private val context: Context,
    private val serverPort: Int = 9527
) : NanoHTTPD(serverPort) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        // 统一处理 OPTIONS 请求 (CORS 预检)
        if (method == Method.OPTIONS) {
            val response = newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, "")
            addCorsHeaders(response)
            return response
        }

        // 统一鉴权：密码保护房间的敏感接口要求有效房间令牌 (与桌面端行为一致)
        val isProtected = uri == "/api/files" || uri == "/api/files/clear" || uri == "/api/received_files"
                || uri.startsWith("/api/download/") || uri == "/api/upload" || uri.startsWith("/api/messages")
        if (isProtected && !isRequestAuthorized(session)) {
            val resp = newFixedLengthResponse(
                Response.Status.UNAUTHORIZED,
                "application/json; charset=UTF-8",
                "{\"success\":false,\"unauthorized\":true,\"message\":\"未授权：请先输入房间密码加入房间\"}"
            )
            addCorsHeaders(resp)
            return resp
        }

        val response = try {
            when {
                // 1. 静态资源路由
                uri == "/" || uri == "/index.html" -> serveAsset("web/index.html", "text/html; charset=UTF-8")
                uri == "/style.css" -> serveAsset("web/style.css", "text/css; charset=UTF-8")
                uri == "/app.js" -> serveAsset("web/app.js", "application/javascript; charset=UTF-8")

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
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
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
                    if (hostToken.isNullOrBlank() || providedToken.isNullOrBlank() || providedToken != hostToken) {
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

                    val (ok, msg, token) = RoomManager.verifyAndJoin(pin, clientName, clientIp, clientPlatform, accessIp)
                    val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                    val room = RoomManager.currentRoom
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
                        put("room", roomObj)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
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
                    RoomManager.heartbeat(clientIp, clientName, clientPlatform, token, accessIp)
                    val room = RoomManager.currentRoom
                    val result = JSONObject().apply {
                        put("success", true)
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
                    if (!token.isNullOrBlank()) {
                        RoomManager.leaveRoom(token)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
                }

                // 1.46 房间成员
                method == Method.GET && uri == "/api/room/members" -> {
                    val members = RoomManager.getMembers()
                    val jsonArray = JSONArray()
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
                    val result = JSONObject().apply {
                        put("members", jsonArray)
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", result.toString())
                }

                // 1.47 切换展示网卡 IP
                method == Method.POST && uri.startsWith("/api/room/set_ip") -> {
                    val map = HashMap<String, String>()
                    try { session.parseBody(map) } catch (_: Exception) {}
                    val postData = getUtf8PostData(map)
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            val ip = json.optString("ip", "")
                            if (ip.isNotBlank()) {
                                RoomManager.setHostIp(ip)
                            }
                        } catch (_: Exception) {}
                    }
                    newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", "{\"success\":true}")
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
        } catch (e: Exception) {
            e.printStackTrace()
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "500 Error: ${e.message}")
        }

        addCorsHeaders(response)
        return response
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
                    FileManager.saveIncomingFile(context, originalName, inStream)
                }
                tempFile.delete()
                val resObj = JSONObject().apply {
                    put("success", true)
                    put("fileId", sharedFile?.id ?: "")
                    put("name", originalName)
                    put("size", sharedFile?.size ?: 0L)
                    put("message", "File saved to Download/WenBox")
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
     * 本机回环请求 (房主自己浏览器打开管理页) 直接放行。
     */
    private fun isRequestAuthorized(session: IHTTPSession): Boolean {
        val room = RoomManager.currentRoom ?: return true
        if (!room.isActive || !room.needPassword) return true
        val remoteIp = session.remoteIpAddress ?: ""
        if (remoteIp == "127.0.0.1" || remoteIp == "::1") return true
        val headerToken = session.headers["x-room-token"] ?: session.headers["x-host-token"]
        val queryToken = session.parameters["token"]?.firstOrNull()
        val token = headerToken?.trim()?.takeIf { it.isNotEmpty() }
            ?: queryToken?.trim()?.takeIf { it.isNotEmpty() }
        return RoomManager.isAuthorized(token)
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

    private fun addCorsHeaders(response: Response) {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        response.addHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, X-Room-Token, X-Host-Token")
    }
}
