package com.landrop.industrial

object IndustrialChecksum {

    /**
     * 计算 Modbus-RTU CRC16 校验码
     * 多项式: A001h (逆向)
     * 初始值: FFFFh
     * 返回: Pair(低字节在前格式, 高字节在前格式)
     * 例如: 输入 "01 03 00 00 00 02" -> 输出 Pair("C4 0B", "0B C4")
     */
    fun calculateModbusCrc16(hexInput: String): Pair<String, String>? {
        val clean = EndianConverter.cleanHex(hexInput)
        if (clean.length < 2 || clean.length % 2 != 0) return null

        val bytes = ByteArray(clean.length / 2)
        for (i in bytes.indices) {
            val byteStr = clean.substring(i * 2, i * 2 + 2)
            bytes[i] = byteStr.toInt(16).toByte()
        }

        var crc = 0xFFFF
        for (b in bytes) {
            crc = crc xor (b.toInt() and 0xFF)
            for (j in 0 until 8) {
                crc = if ((crc and 0x0001) != 0) {
                    (crc ushr 1) xor 0xA001
                } else {
                    crc ushr 1
                }
            }
        }

        val low = crc and 0xFF
        val high = (crc ushr 8) and 0xFF

        // Modbus RTU 标准传输协议中通常是低字节在前，高字节在后
        val lowFirst = String.format("%02X %02X", low, high)
        val highFirst = String.format("%02X %02X", high, low)

        return Pair(lowFirst, highFirst)
    }

    /**
     * 计算 XOR 异或校验和 (BCC / 常用串口仪表校验)
     */
    fun calculateXorChecksum(hexInput: String): String? {
        val clean = EndianConverter.cleanHex(hexInput)
        if (clean.length < 2 || clean.length % 2 != 0) return null

        var xor = 0
        for (i in 0 until clean.length step 2) {
            val byteVal = clean.substring(i, i + 2).toInt(16)
            xor = xor xor byteVal
        }
        return String.format("%02X", xor and 0xFF)
    }
}
