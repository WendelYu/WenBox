package com.landrop.server

import android.content.Context
import android.os.Build
import com.landrop.utils.NetworkUtils
import com.landrop.utils.UdpDiscoveryManager
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
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

                // 1.5 服务状态信息 (供局域网其他设备/网页感知本端信息)
                method == Method.GET && uri == "/api/status" -> {
                    val primaryIp = NetworkUtils.getAllLocalIpAddresses(context).firstOrNull()?.ip ?: "127.0.0.1"
                    val json = JSONObject().apply {
                        put("device", "${Build.BRAND} ${Build.MODEL}")
                        put("ip", primaryIp)
                        put("port", serverPort)
                        put("running", true)
                        put("platform", "Android")
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
                        }
                        jsonArray.put(item)
                    }
                    val result = JSONObject().apply {
                        put("messages", jsonArray)
                    }
                    newFixedLengthResponse(
                        Response.Status.OK,
                        "application/json; charset=UTF-8",
                        result.toString()
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
                FileInputStream(tempFile).use { inStream ->
                    FileManager.saveIncomingFile(context, originalName, inStream)
                }
                tempFile.delete()
                return newFixedLengthResponse(
                    Response.Status.OK,
                    "application/json",
                    "{\"success\": true, \"message\": \"File saved to Download/LanDrop\"}"
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
        session.parseBody(map)
        val postData = map["postData"]
        var content = ""
        var senderName = "💻 电脑端"

        if (!postData.isNullOrBlank()) {
            try {
                val json = JSONObject(postData)
                content = json.optString("content", "")
                senderName = json.optString("senderName", "💻 电脑端")
            } catch (_: Exception) {}
        }

        if (content.isBlank()) {
            val params = session.parameters
            content = params["content"]?.firstOrNull() ?: ""
            senderName = params["senderName"]?.firstOrNull() ?: "💻 电脑端"
        }

        if (content.isNotBlank()) {
            val msg = MessageManager.addClientMessage(content, senderName)
            return newFixedLengthResponse(
                Response.Status.OK,
                "application/json",
                "{\"success\": true, \"id\": \"${msg.id}\"}"
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

        val postData = map["postData"]
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
        return newFixedLengthResponse(Response.Status.OK, "application/json; charset=UTF-8", respJson.toString())
    }

    private fun addCorsHeaders(response: Response) {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        response.addHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization")
    }
}
