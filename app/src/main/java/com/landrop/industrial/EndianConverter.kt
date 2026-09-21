package com.landrop.industrial

import java.nio.ByteBuffer
import java.nio.ByteOrder

data class EndianResult(
    val abcdHex: String,
    val cdabHex: String,
    val badcHex: String,
    val dcbaHex: String,
    val abcdFloat: Float,
    val cdabFloat: Float,
    val badcFloat: Float,
    val dcbaFloat: Float,
    val abcdInt: Long,
    val cdabInt: Long,
    val badcInt: Long,
    val dcbaInt: Long
)

object EndianConverter {

    /**
     * 清洗 HEX 字符串（去除空格、0x前缀、逗号等）
     */
    fun cleanHex(input: String): String {
        return input.replace("0x", "", ignoreCase = true)
            .replace("\\s+".toRegex(), "")
            .replace(",", "")
            .replace("-", "")
            .uppercase()
    }

    /**
     * 将 4 字节 HEX 字符串进行四种字节序转换并解析为浮点数与整型
     * ABCD: Big-Endian (Motorola)
     * CDAB: Word Swap (Modbus 常见)
     * BADC: Byte Swap
     * DCBA: Little-Endian (Intel)
     */
    fun convertEndian4Bytes(hexInput: String): EndianResult? {
        val clean = cleanHex(hexInput)
        if (clean.length < 8) return null
        val hex = clean.substring(0, 8)

        val b0 = hex.substring(0, 2)
        val b1 = hex.substring(2, 4)
        val b2 = hex.substring(4, 6)
        val b3 = hex.substring(6, 8)

        val abcd = "$b0$b1$b2$b3"
        val cdab = "$b2$b3$b0$b1"
        val badc = "$b1$b0$b3$b2"
        val dcba = "$b3$b2$b1$b0"

        return EndianResult(
            abcdHex = formatHexBytes(abcd),
            cdabHex = formatHexBytes(cdab),
            badcHex = formatHexBytes(badc),
            dcbaHex = formatHexBytes(dcba),
            abcdFloat = hexToFloat(abcd),
            cdabFloat = hexToFloat(cdab),
            badcFloat = hexToFloat(badc),
            dcbaFloat = hexToFloat(dcba),
            abcdInt = hexToLong(abcd),
            cdabInt = hexToLong(cdab),
            badcInt = hexToLong(badc),
            dcbaInt = hexToLong(dcba)
        )
    }

    /**
     * 浮点数转标准 4 字节 HEX (Big-Endian)
     */
    fun floatToHex(value: Float): String {
        val bits = java.lang.Float.floatToIntBits(value)
        return String.format("%08X", bits)
    }

    /**
     * 4 字节 HEX 转浮点数
     */
    fun hexToFloat(hex8: String): Float {
        return try {
            val bits = java.lang.Long.parseLong(hex8, 16).toInt()
            java.lang.Float.intBitsToFloat(bits)
        } catch (_: Exception) {
            0.0f
        }
    }

    private fun hexToLong(hex8: String): Long {
        return try {
            java.lang.Long.parseLong(hex8, 16)
        } catch (_: Exception) {
            0L
        }
    }

    fun formatHexBytes(hex: String): String {
        return hex.chunked(2).joinToString(" ")
    }
}
