package com.landrop.industrial

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

class RadixConverterTest {

    @Test
    fun `negative decimal input is rejected instead of producing 0-101`() {
        // 修复前：-5 会显示成 "0-101"（BigInteger.toString(2) 带负号再补零）
        assertNull(RadixConverter.parseUnsigned("-5", 10))
        assertNull(RadixConverter.parseUnsigned("-101", 2))
        assertNull(RadixConverter.parseUnsigned("+5", 10))
    }

    @Test
    fun `positive values convert across all radixes`() {
        val result = RadixConverter.fromNumber(BigInteger.valueOf(6719))
        assertEquals("1A3F", result.hex.replace(" ", ""))
        assertEquals("6719", result.dec)
        assertEquals("0001 1010 0011 1111", result.bin)
        assertEquals("15077", result.oct)
        assertEquals(null, result.error)
    }

    @Test
    fun `hex with leading zero bytes keeps every byte`() {
        // 修复前："00 41" 经 BigInteger 中转会丢掉前导的 00
        val ascii = RadixConverter.hexToAscii("00 41")
        assertEquals("\u0000A".replace("\u0000", "."), ascii)
        val bytes = RadixConverter.parseHexBytes("00 41")!!
        assertEquals(2, bytes.size)
        assertEquals(0, bytes[0].toInt())
        assertEquals(0x41, bytes[1].toInt())
    }

    @Test
    fun `ascii round trips through hex`() {
        val hex = RadixConverter.asciiToHex("Hello")
        assertEquals("48656C6C6F", hex)
        assertEquals("Hello", RadixConverter.hexToAscii(hex))
    }

    @Test
    fun `invalid input returns null rather than throwing`() {
        assertNull(RadixConverter.parseUnsigned("ZZ", 16))
        assertNull(RadixConverter.parseUnsigned("", 10))
        assertNull(RadixConverter.parseUnsigned("12G", 16))
        assertNull(RadixConverter.parseHexBytes("ABC")) // 奇数长度
        assertNull(RadixConverter.parseHexBytes("ZZ"))
    }

    @Test
    fun `whitespace and 0x prefix are tolerated`() {
        assertEquals(BigInteger.valueOf(0x1A3F), RadixConverter.parseUnsigned("0x1A 3F", 16))
        assertEquals(BigInteger.valueOf(255), RadixConverter.parseUnsigned(" FF ", 16))
    }

    @Test
    fun `zero is represented as a single byte`() {
        assertEquals(1, RadixConverter.unsignedToBytes(BigInteger.ZERO).size)
        assertEquals("00", RadixConverter.fromNumber(BigInteger.ZERO).hex)
    }

    @Test
    fun `non printable bytes are replaced with dots`() {
        val text = RadixConverter.bytesToAscii(byteArrayOf(0x41, 0x00, 0x1F, 0x42))
        assertEquals("A..B", text)
    }

    @Test
    fun `large values keep all significant bytes`() {
        val value = BigInteger("123456789012345678901234567890")
        val bytes = RadixConverter.unsignedToBytes(value)
        assertEquals(value, BigInteger(1, bytes))
        assertTrue(RadixConverter.fromNumber(value).hex.replace(" ", "").isNotEmpty())
    }
}
