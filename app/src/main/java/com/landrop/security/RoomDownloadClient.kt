package com.landrop.security

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

object RoomDownloadClient {
    fun <T> download(origin: String, resource: String, token: String, consume: (InputStream) -> T): T {
        val url = RoomResource.resolve(origin, resource)
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8000
            connection.readTimeout = 30000
            if (token.isNotBlank()) connection.setRequestProperty("X-Room-Token", token)
            check(connection.responseCode in 200..299) { "下载失败（HTTP ${connection.responseCode}）" }
            return connection.inputStream.use(consume)
        } finally {
            connection.disconnect()
        }
    }
}
