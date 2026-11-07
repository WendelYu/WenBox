package com.landrop.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class ContentCryptoTest {
    @Test
    fun boundedUploadDoesNotReadTheNextHttpRequestOrWaitForSocketEof() {
        val key=ContentCrypto.generateKey();val plain="upload body".toByteArray()
        val wire=ContentCrypto.encryptingStream(ByteArrayInputStream(plain),key,"room").readBytes()
        val socket=object : java.io.InputStream() {
            var index=0
            override fun read():Int {
                check(index<wire.size) { "attempted to read beyond Content-Length" }
                return wire[index++].toInt() and 255
            }
        }
        val decrypted=ContentCrypto.decryptingStream(ContentCrypto.boundedInput(socket,wire.size.toLong()),key,"room").readBytes()
        assertArrayEquals(plain,decrypted)
        assertTrue(runCatching {
            ContentCrypto.decryptingStream(ByteArrayInputStream(wire.copyOf(wire.size-20)),key,"room").readBytes()
        }.isFailure)
    }

    @Test
    fun textEnvelopeRoundTripsAndIsBoundToRoom() {
        val key = ContentCrypto.generateKey()
        val aad = ContentCrypto.messageAad("room-a")
        val wire = ContentCrypto.encryptText(key, aad, "你好 WenBox")
        assertTrue(wire.startsWith(ContentCrypto.TEXT_PREFIX))
        assertEquals("你好 WenBox", ContentCrypto.decryptText(key, aad, wire))
        assertTrue(runCatching {
            ContentCrypto.decryptText(key, ContentCrypto.messageAad("room-b"), wire)
        }.isFailure)
        assertEquals("legacy plaintext", ContentCrypto.decryptText(key, aad, "legacy plaintext"))
    }

    @Test
    fun fileStreamRoundTripsAcrossChunkBoundaries() {
        val key = ContentCrypto.generateKey()
        val plain = ByteArray(1024 * 1024 * 2 + 37) { (it % 251).toByte() }
        val encrypted = ByteArrayOutputStream()
        val written = ContentCrypto.encryptTo(ByteArrayInputStream(plain), encrypted, key, "room-a")
        assertEquals(plain.size.toLong(), written)
        assertEquals(ContentCrypto.encryptedLength(plain.size.toLong()), encrypted.size().toLong())

        val decrypted = ByteArrayOutputStream()
        val read = ContentCrypto.decryptTo(ByteArrayInputStream(encrypted.toByteArray()), decrypted, key, "room-a")
        assertEquals(plain.size.toLong(), read)
        assertArrayEquals(plain, decrypted.toByteArray())
    }

    @Test
    fun decryptsBrowserGeneratedTextAndFileVectors() {
        val key = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
        assertEquals(
            "跨端互通",
            ContentCrypto.decryptText(
                key,
                ContentCrypto.messageAad("room-test"),
                "wbx1:yMfGxcTDwsHAv769HIDaVhYBEmIvNXuzdTazgAvkBvgzO1RRyqn2vQ=="
            )
        )
        val frame = java.util.Base64.getDecoder().decode(
            "V0JYRjFkZWZnaGlqa2xtbm8AEAAAAAAAIwY2Hym869INnSXA6DXKTbccMI2pAeFgpXyHyTv8t+DoAWqfAAAAEItrXq62CXL/JhZ8HbZp0AM="
        )
        val out = ByteArrayOutputStream()
        ContentCrypto.decryptTo(ByteArrayInputStream(frame), out, key, "room-test")
        assertArrayEquals("file-interop-测试".toByteArray(), out.toByteArray())
    }

    @Test
    fun streamingWrappersMatch() {
        val key = ContentCrypto.generateKey()
        val plain = "streaming body".repeat(5000).toByteArray()
        val encrypted = ContentCrypto.encryptingStream(ByteArrayInputStream(plain), key, "room-a").use { it.readBytes() }
        val decrypted = ContentCrypto.decryptingStream(ByteArrayInputStream(encrypted), key, "room-a").use { it.readBytes() }
        assertArrayEquals(plain, decrypted)
    }
}
