package com.landrop.utils

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object HttpHelper {

    suspend fun postJson(
        urlStr: String,
        json: JSONObject,
        headers: Map<String, String> = emptyMap()
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }

            OutputStreamWriter(conn.outputStream, "UTF-8").use {
                it.write(json.toString())
                it.flush()
            }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val response = BufferedReader(InputStreamReader(stream, "UTF-8")).use { it.readText() }
            Pair(code, response)
        } finally {
            conn.disconnect()
        }
    }

    suspend fun getJson(
        urlStr: String,
        headers: Map<String, String> = emptyMap()
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val response = BufferedReader(InputStreamReader(stream, "UTF-8")).use { it.readText() }
            Pair(code, response)
        } finally {
            conn.disconnect()
        }
    }

    suspend fun uploadFile(
        urlStr: String,
        fileName: String,
        inputStream: java.io.InputStream,
        headers: Map<String, String> = emptyMap()
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val boundary = "===WenBoxBoundary${System.currentTimeMillis()}==="
        val lineEnd = "\r\n"
        val twoHyphens = "--"
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            conn.doOutput = true
            conn.doInput = true
            conn.useCaches = false
            // 声明 UTF-8 编码，服务端 (NanoHTTPD) 据此以 UTF-8 解析 multipart 头部中的文件名
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary; charset=UTF-8")
            conn.setRequestProperty("X-File-Name", java.net.URLEncoder.encode(fileName, "UTF-8"))
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }

            conn.outputStream.use { out ->
                val writer = java.io.DataOutputStream(out)
                // 不能用 writeBytes: 它按 ISO-8859-1 截断字符, 中文文件名会被写成乱码字节
                writer.write((twoHyphens + boundary + lineEnd).toByteArray(Charsets.UTF_8))
                writer.write(("Content-Disposition: form-data; name=\"file\"; filename=\"$fileName\"$lineEnd").toByteArray(Charsets.UTF_8))
                writer.write(("Content-Type: application/octet-stream$lineEnd$lineEnd").toByteArray(Charsets.UTF_8))
                writer.flush()

                val buffer = ByteArray(32768)
                var bytesRead: Int
                while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                    out.write(buffer, 0, bytesRead)
                }
                out.flush()

                writer.write(lineEnd.toByteArray(Charsets.UTF_8))
                writer.write((twoHyphens + boundary + twoHyphens + lineEnd).toByteArray(Charsets.UTF_8))
                writer.flush()
            }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val response = BufferedReader(InputStreamReader(stream, "UTF-8")).use { it.readText() }
            Pair(code, response)
        } finally {
            conn.disconnect()
        }
    }
}
