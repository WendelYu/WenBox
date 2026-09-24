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
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            rName = json.optString("roomName", "")
                            pin = json.optString("pin", "")
                        } catch (_: Exception) {}
                    }
                    val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                    val cfg = RoomManager.createRoom(
                        roomName = rName,
                        pin = pin,
                        hostDevice = "${Build.BRAND} ${Build.MODEL}",
                        hostIp = primaryIp,
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

                    val (ok, msg, token) = RoomManager.verifyAndJoin(pin, clientName, clientIp, clientPlatform)
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
                    if (!postData.isNullOrBlank()) {
                        try {
                            val json = JSONObject(postData)
                            clientName = json.optString("name", null)
                            clientPlatform = json.optString("platform", null)
                        } catch (_: Exception) {}
                    }
                    val clientIp = session.headers["http-client-ip"]
                        ?: session.headers["remote-addr"]
                        ?: session.remoteIpAddress
                        ?: "127.0.0.1"
                    RoomManager.heartbeat(clientIp, clientName, clientPlatform)
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

                // 1.5 服务状态信息 (供局域网其他设备/网页感知本端信息)
                method == Method.GET && uri == "/api/status" -> {
                    val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
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

                // 3. 单文件流式下载
                method == Method.GET && uri.startsWith("/api/download/") -> {
                    val fileId = uri.removePrefix("/api/download/")
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
                            val resp = newFixedLengthResponse(
                                Response.Status.OK,
                                file.mimeType.ifBlank { "application/octet-stream" },
                                inputStream,
                                file.size
                            )
                            resp.addHeader(
                                "Content-Disposition",
                                "attachment; filename=\"${file.name.replace("\"", "\\\"")}\"; filename*=UTF-8''$encodedFilename"
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
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("messages", jsonArray)
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
        val originalName = params["file"]?.firstOrNull() ?: "upload_${System.currentTimeMillis()}"

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
                    put("message", "File saved to Download/LanDrop")
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

    private fun handleSendMessage(session: IHTTPSession): Response {
        val map = HashMap<String, String>()
        try { session.parseBody(map) } catch (_: Exception) {}
        val postData = getUtf8PostData(map)
        var content = ""
        var senderName = "💻 电脑端"
        var senderIp = ""
        val clientIp = session.remoteIpAddress ?: ""

        if (!postData.isNullOrBlank()) {
            try {
                val json = JSONObject(postData)
                content = json.optString("content", "")
                senderName = json.optString("senderName", "💻 电脑端")
                senderIp = json.optString("senderIp", "")
            } catch (_: Exception) {}
        }

        if (content.isBlank()) {
            val params = session.parameters
            content = params["content"]?.firstOrNull() ?: ""
            senderName = params["senderName"]?.firstOrNull() ?: "💻 电脑端"
            senderIp = params["senderIp"]?.firstOrNull() ?: ""
        }
        if (senderIp.isBlank()) {
            senderIp = clientIp
        }

        if (content.isNotBlank()) {
            val msg = MessageManager.addClientMessage(content, senderName, senderIp)
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
        response.addHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, X-Room-Token")
    }
}
