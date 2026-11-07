package com.landrop.security

import java.io.EOFException
import java.io.FilterInputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Room content encryption shared with the Rust and Web clients.
 *
 * Messages use `wbx1:` + Base64(nonce || AES-GCM ciphertext/tag). Files use a
 * framed stream (`WBXF1` + base nonce + chunk size + length-prefixed AES-GCM
 * chunks) so downloads can be decrypted while streaming.
 */
object ContentCrypto {
    const val TEXT_PREFIX = "wbx1:"
    private val MAGIC = byteArrayOf(0x57, 0x42, 0x58, 0x46, 0x31) // WBXF1
    private const val NONCE_LEN = 12
    private const val TAG_LEN = 16
    private const val CHUNK_LEN = 1024 * 1024
    private const val HEADER_LEN = 5 + NONCE_LEN + 4
    private val random = SecureRandom()

    fun generateKey(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getEncoder().encodeToString(bytes)
    }

    private fun keyBytes(key: String): ByteArray {
        val bytes = Base64.getDecoder().decode(key)
        require(bytes.size == 32) { "房间密钥长度无效" }
        return bytes
    }

    private fun cipher(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher
    }

    private fun chunkNonce(base: ByteArray, index: Long): ByteArray {
        val nonce = base.copyOf()
        var carry = index
        for (i in nonce.indices.reversed()) {
            if (carry == 0L) break
            val sum = (nonce[i].toInt() and 0xff) + (carry and 0xff)
            nonce[i] = sum.toByte()
            carry = (carry ushr 8) + (sum ushr 8)
        }
        return nonce
    }

    fun messageAad(roomId: String): ByteArray = "wenbox-message:v1:$roomId".toByteArray(Charsets.UTF_8)

    fun fileAad(roomId: String, index: Long): ByteArray = "wenbox-file:v1:$roomId:$index".toByteArray(Charsets.UTF_8)

    fun encryptText(key: String, aad: ByteArray, plaintext: String): String {
        val keyBytes = keyBytes(key)
        val nonce = ByteArray(NONCE_LEN).also(random::nextBytes)
        val cipher = cipher(Cipher.ENCRYPT_MODE, keyBytes, nonce, aad)
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val envelope = ByteArray(NONCE_LEN + sealed.size)
        System.arraycopy(nonce, 0, envelope, 0, NONCE_LEN)
        System.arraycopy(sealed, 0, envelope, NONCE_LEN, sealed.size)
        return TEXT_PREFIX + Base64.getEncoder().encodeToString(envelope)
    }

    /** Plaintext without the envelope marker is passed through for older peers. */
    fun decryptText(key: String, aad: ByteArray, value: String): String {
        if (!value.startsWith(TEXT_PREFIX)) return value
        val envelope = Base64.getDecoder().decode(value.removePrefix(TEXT_PREFIX))
        require(envelope.size >= NONCE_LEN + TAG_LEN) { "消息密文长度无效" }
        val nonce = envelope.copyOfRange(0, NONCE_LEN)
        val sealed = envelope.copyOfRange(NONCE_LEN, envelope.size)
        val cipher = cipher(Cipher.DECRYPT_MODE, keyBytes(key), nonce, aad)
        return String(cipher.doFinal(sealed), Charsets.UTF_8)
    }

    fun encryptedLength(plainLength: Long): Long {
        val chunks = (plainLength + CHUNK_LEN - 1) / CHUNK_LEN
        return HEADER_LEN.toLong() + chunks * 4 + plainLength + chunks * TAG_LEN + 20
    }

    fun encryptTo(input: InputStream, output: OutputStream, key: String, roomId: String): Long {
        val keyBytes = keyBytes(key)
        val base = ByteArray(NONCE_LEN).also(random::nextBytes)
        output.write(MAGIC)
        output.write(base)
        writeInt(output, CHUNK_LEN)
        val buffer = ByteArray(CHUNK_LEN)
        var index = 0L
        var total = 0L
        while (true) {
            val count = readChunk(input, buffer)
            val finalChunk = count == 0
            val plain = buffer.copyOf(count)
            val cipher = cipher(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(base, index), fileAad(roomId, index))
            val sealed = cipher.doFinal(plain)
            writeInt(output, sealed.size)
            output.write(sealed)
            total += count
            index++
            if (finalChunk) break
        }
        return total
    }

    fun decryptTo(input: InputStream, output: OutputStream, key: String, roomId: String): Long {
        val keyBytes = keyBytes(key)
        val header = ByteArray(HEADER_LEN)
        readExactly(input, header)
        require(header[0] == MAGIC[0] && header[1] == MAGIC[1] && header[2] == MAGIC[2] && header[3] == MAGIC[3] && header[4] == MAGIC[4]) {
            "文件未使用受支持的加密格式"
        }
        val base = header.copyOfRange(5, 5 + NONCE_LEN)
        val chunkLen = readInt(header, 5 + NONCE_LEN)
        require(chunkLen in 1024..(8 * 1024 * 1024)) { "加密文件块大小超出范围" }
        var index = 0L
        var total = 0L
        while (true) {
            val length = readOptionalInt(input) ?: throw EOFException("加密文件缺少结束校验")
            require(length in TAG_LEN..(chunkLen + TAG_LEN)) { "加密文件分块长度无效" }
            val sealed = ByteArray(length)
            readExactly(input, sealed)
            val cipher = cipher(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(base, index), fileAad(roomId, index))
            val plain = cipher.doFinal(sealed)
            if (plain.isEmpty()) { require(input.read() == -1) { "加密文件结束后包含额外数据" }; return total }
            output.write(plain)
            total += plain.size
            index++
        }
    }

    /** Restrict NanoHTTPD's raw socket stream to the advertised HTTP body. */
    fun boundedInput(input: InputStream, length: Long): InputStream {
        require(length >= 0)
        return object : FilterInputStream(input) {
            var remaining = length
            override fun read(): Int {
                if (remaining == 0L) return -1
                val value = `in`.read()
                if (value < 0) throw EOFException("HTTP 文件流不完整")
                remaining--; return value
            }
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                if (length == 0) return 0
                if (remaining == 0L) return -1
                val count = `in`.read(bytes, offset, minOf(length.toLong(), remaining).toInt())
                if (count < 0) throw EOFException("HTTP 文件流不完整")
                remaining -= count; return count
            }
        }
    }

    fun encryptingStream(input: InputStream, key: String, roomId: String): InputStream = EncryptingInputStream(input, key, roomId)

    fun decryptingStream(input: InputStream, key: String, roomId: String): InputStream = DecryptingInputStream(input, key, roomId)

    private class EncryptingInputStream(
        input: InputStream,
        key: String,
        roomId: String
    ) : FilterInputStream(input) {
        private val keyBytes = keyBytes(key)
        private val roomId = roomId
        private val base = ByteArray(NONCE_LEN).also(random::nextBytes)
        private var index = 0L
        private var headerSent = false
        private var pending = ByteArray(0)
        private var pendingOffset = 0
        private var finished = false
        private val chunk = ByteArray(CHUNK_LEN)

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (pendingOffset >= pending.size) {
                if (!fill()) return -1
            }
            val count = minOf(length, pending.size - pendingOffset)
            System.arraycopy(pending, pendingOffset, buffer, offset, count)
            pendingOffset += count
            return count
        }

        private fun fill(): Boolean {
            if (!headerSent) {
                val header = ByteArray(HEADER_LEN)
                System.arraycopy(MAGIC, 0, header, 0, MAGIC.size)
                System.arraycopy(base, 0, header, MAGIC.size, NONCE_LEN)
                writeInt(header, MAGIC.size + NONCE_LEN, CHUNK_LEN)
                pending = header
                pendingOffset = 0
                headerSent = true
                return true
            }
            if (finished) return false
            val count = readChunk(`in`, chunk)
            if (count == 0) {
                finished = true
            }
            val plain = chunk.copyOf(count)
            val cipher = cipher(Cipher.ENCRYPT_MODE, keyBytes, chunkNonce(base, index), fileAad(roomId, index))
            val sealed = cipher.doFinal(plain)
            val frame = ByteArray(4 + sealed.size)
            writeInt(frame, 0, sealed.size)
            System.arraycopy(sealed, 0, frame, 4, sealed.size)
            pending = frame
            pendingOffset = 0
            index++
            return true
        }
    }

    private class DecryptingInputStream(
        input: InputStream,
        key: String,
        roomId: String
    ) : FilterInputStream(input) {
        private val keyBytes = keyBytes(key)
        private val roomId = roomId
        private var base: ByteArray? = null
        private var chunkLen = 0
        private var index = 0L
        private var pending = ByteArray(0)
        private var pendingOffset = 0
        private var finished = false

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (pendingOffset >= pending.size) {
                if (!fill()) return -1
            }
            val count = minOf(length, pending.size - pendingOffset)
            System.arraycopy(pending, pendingOffset, buffer, offset, count)
            pendingOffset += count
            return count
        }

        private fun fill(): Boolean {
            if (finished) return false
            if (base == null) {
                val header = ByteArray(HEADER_LEN)
                readExactly(`in`, header)
                require(header[0] == MAGIC[0] && header[1] == MAGIC[1] && header[2] == MAGIC[2] && header[3] == MAGIC[3] && header[4] == MAGIC[4]) {
                    "文件未使用受支持的加密格式"
                }
                base = header.copyOfRange(MAGIC.size, MAGIC.size + NONCE_LEN)
                chunkLen = readInt(header, MAGIC.size + NONCE_LEN)
                require(chunkLen in 1024..(8 * 1024 * 1024)) { "加密文件块大小超出范围" }
            }
            val length = readOptionalInt(`in`) ?: throw EOFException("加密文件缺少结束校验")
            require(length in TAG_LEN..(chunkLen + TAG_LEN)) { "加密文件分块长度无效" }
            val sealed = ByteArray(length)
            readExactly(`in`, sealed)
            val cipher = cipher(Cipher.DECRYPT_MODE, keyBytes, chunkNonce(base!!, index), fileAad(roomId, index))
            pending = cipher.doFinal(sealed)
            if (pending.isEmpty()) { require(`in`.read() == -1) { "加密文件结束后包含额外数据" }; finished = true; return false }
            pendingOffset = 0
            index++
            return true
        }
    }

    private fun readChunk(input: InputStream, buffer: ByteArray): Int {
        var filled = 0
        while (filled < buffer.size) {
            val count = input.read(buffer, filled, buffer.size - filled)
            if (count < 0) break
            if (count == 0) continue
            filled += count
        }
        return filled
    }

    private fun readExactly(input: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val count = input.read(buffer, offset, buffer.size - offset)
            if (count < 0) throw EOFException("加密文件不完整")
            offset += count
        }
    }

    private fun readOptionalInt(input: InputStream): Int? {
        val first = input.read()
        if (first < 0) return null
        val rest = ByteArray(3)
        readExactly(input, rest)
        return (first shl 24) or ((rest[0].toInt() and 0xff) shl 16) or
            ((rest[1].toInt() and 0xff) shl 8) or (rest[2].toInt() and 0xff)
    }

    private fun writeInt(output: OutputStream, value: Int) {
        output.write((value ushr 24) and 0xff)
        output.write((value ushr 16) and 0xff)
        output.write((value ushr 8) and 0xff)
        output.write(value and 0xff)
    }

    private fun writeInt(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = (value ushr 24).toByte()
        buffer[offset + 1] = (value ushr 16).toByte()
        buffer[offset + 2] = (value ushr 8).toByte()
        buffer[offset + 3] = value.toByte()
    }

    private fun readInt(buffer: ByteArray, offset: Int): Int =
        ((buffer[offset].toInt() and 0xff) shl 24) or
            ((buffer[offset + 1].toInt() and 0xff) shl 16) or
            ((buffer[offset + 2].toInt() and 0xff) shl 8) or
            (buffer[offset + 3].toInt() and 0xff)
}
