package com.landrop.security

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

object RoomDownloadClient {
    fun <T> download(
        origin: String,
        resource: String,
        token: String,
        contentKey: String? = null,
        roomId: String = "",
        consume: (InputStream) -> T
    ): T {
        val url = RoomResource.resolve(origin, resource)
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8000
            connection.readTimeout = 30000
            if (token.isNotBlank()) connection.setRequestProperty("X-Room-Token", token)
            if (!contentKey.isNullOrBlank()) connection.setRequestProperty("X-WenBox-Encryption", "v1")
            check(connection.responseCode in 200..299) { "下载失败（HTTP ${connection.responseCode}）" }
            val encrypted = connection.getHeaderField("X-WenBox-Encryption")?.equals("v1", true) == true
            val stream = connection.inputStream
            if (encrypted) {
                check(!contentKey.isNullOrBlank()) { "接收端缺少房间密钥，无法解密下载文件" }
                return ContentCrypto.decryptingStream(stream, contentKey, roomId).use(consume)
            }
            return stream.use(consume)
        } finally {
            connection.disconnect()
        }
    }
}
