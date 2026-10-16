package com.landrop.industrial

import java.math.BigInteger

/**
 * 进制转换的纯逻辑实现（无 Android 依赖，便于 JVM 单测）。
 *
 * 修复了两个原有缺陷：
 * 1. 负数：BigInteger.toString(2) 会输出 "-101"，再补零得到 "0-101"。现在负数直接报错。
 * 2. 前导零字节：Hex↔ASCII 原来经过 BigInteger 中转，"00 41" 会丢掉前导的 00。
 *    现在按字节数组互转，保留每一位。
 */
object RadixConverter {

    data class Conversion(
        val hex: String = "",
        val dec: String = "",
        val bin: String = "",
        val oct: String = "",
        val ascii: String = "",
        val error: String? = null
    )

    /** 把用户输入解析为非负整数；返回 null 表示输入非法 */
    fun parseUnsigned(raw: String, radix: Int): BigInteger? {
        val clean = raw
            .replace("0x", "", ignoreCase = true)
            .replace("\\s+".toRegex(), "")
            .trim()
        if (clean.isEmpty()) return null
        // 负数没有无歧义的补码表示：直接拒绝，而不是输出 "0-101" 这种错误结果
        if (clean.startsWith("-") || clean.startsWith("+")) return null
        return try {
            val value = BigInteger(clean, radix)
            if (value.signum() < 0) null else value
        } catch (_: NumberFormatException) {
            null
        }
    }

    /** 从非负整数构造转换结果 */
    fun fromNumber(num: BigInteger): Conversion {
        if (num.signum() < 0) {
            return Conversion(error = "不支持负数，请输入非负整数")
        }
        val bytes = unsignedToBytes(num)
        return Conversion(
            hex = bytes.joinToString(" ") { String.format("%02X", it) },
            dec = num.toString(10),
            bin = formatBinary(num),
            oct = num.toString(8),
            ascii = bytesToAscii(bytes)
        )
    }

    /** Hex 字符串 -> ASCII 文本，按字节解析，保留 00 等前导零字节 */
    fun hexToAscii(hex: String): String? = parseHexBytes(hex)?.let { bytesToAscii(it) }

    /** ASCII/UTF-8 文本 -> Hex 字符串 */
    fun asciiToHex(text: String): String =
        text.toByteArray(Charsets.UTF_8).joinToString("") { String.format("%02X", it) }

    fun parseHexBytes(hex: String): ByteArray? {
        val clean = hex.replace("0x", "", ignoreCase = true).replace("\\s+".toRegex(), "")
        if (clean.isEmpty() || clean.length % 2 != 0) return null
        if (!clean.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) return null
        return ByteArray(clean.length / 2) { index ->
            clean.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    /** 无符号整数 -> 大端字节数组，0 至少产生一个字节 */
    fun unsignedToBytes(num: BigInteger): ByteArray {
        if (num.signum() == 0) return byteArrayOf(0)
        val raw = num.toByteArray()
        // BigInteger.toByteArray 会为最高位为 1 的正数补一个符号位 0 字节
        return if (raw.isNotEmpty() && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
    }

    /**
     * 可打印字符直接显示，其余字节用 '.' 占位，
     * 避免把二进制内容塞进输入框导致乱码。
     */
    fun bytesToAscii(bytes: ByteArray): String {
        val builder = StringBuilder()
        for (b in bytes) {
            val code = b.toInt() and 0xFF
            when {
                code == 0x0A -> builder.append('\n')
                code == 0x0D -> builder.append('\r')
                code == 0x09 -> builder.append('\t')
                code in 0x20..0x7E -> builder.append(code.toChar())
                else -> builder.append('.')
            }
        }
        return builder.toString()
    }

    fun formatBinary(num: BigInteger): String {
        val raw = num.toString(2)
        val padded = raw.padStart((Math.ceil(raw.length / 4.0).toInt() * 4).coerceAtLeast(4), '0')
        return padded.chunked(4).joinToString(" ")
    }
}
