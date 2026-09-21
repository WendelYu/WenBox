package com.landrop.json

import org.json.JSONArray
import org.json.JSONObject

object JsonHelper {

    val SAMPLE_JSON = """
        {
          "deviceId": "TIGHTENING-GUN-01",
          "model": "Atlas-Copco-Tensor-STR",
          "status": "ONLINE",
          "tighteningData": {
            "batchNumber": 20260921,
            "torque": 25.4,
            "unit": "N·m",
            "angle": 128.5,
            "result": "OK"
          },
          "lastCalibration": "2026-09-01T08:00:00Z"
        }
    """.trimIndent()

    /**
     * 美化格式化 JSON（支持 JSONObject 与 JSONArray）
     * 返回: Pair(是否成功, 格式化后的内容或错误提示)
     */
    fun formatJson(raw: String, indentSpaces: Int = 2): Pair<Boolean, String> {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Pair(false, "输入内容为空")

        return try {
            if (trimmed.startsWith("{")) {
                val jsonObject = JSONObject(trimmed)
                Pair(true, jsonObject.toString(indentSpaces))
            } else if (trimmed.startsWith("[")) {
                val jsonArray = JSONArray(trimmed)
                Pair(true, jsonArray.toString(indentSpaces))
            } else {
                Pair(false, "语法错误: JSON 必须以 '{' 或 '[' 开头")
            }
        } catch (e: Exception) {
            Pair(false, "JSON 解析失败: ${e.message}")
        }
    }

    /**
     * 压缩精简 JSON（单行无空格）
     */
    fun minifyJson(raw: String): Pair<Boolean, String> {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Pair(false, "输入内容为空")

        return try {
            if (trimmed.startsWith("{")) {
                val jsonObject = JSONObject(trimmed)
                Pair(true, jsonObject.toString())
            } else if (trimmed.startsWith("[")) {
                val jsonArray = JSONArray(trimmed)
                Pair(true, jsonArray.toString())
            } else {
                Pair(false, "语法错误: JSON 必须以 '{' 或 '[' 开头")
            }
        } catch (e: Exception) {
            Pair(false, "JSON 压缩失败: ${e.message}")
        }
    }
}
