package com.landrop.security

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Versioned authenticated envelope; the Android adapter supplies a non-exportable key. */
class ProfileCipher(private val key: SecretKey) {
    fun encrypt(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(CONTEXT)
        val encrypted = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        require(cipher.iv.size == IV_BYTES)
        return Base64.getEncoder().encodeToString(byteArrayOf(VERSION) + cipher.iv + encrypted)
    }

    fun decrypt(envelope: String): String {
        val bytes = Base64.getDecoder().decode(envelope)
        require(bytes.size >= 1 + IV_BYTES + TAG_BYTES && bytes[0] == VERSION) { "无效的房间配置" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, bytes.copyOfRange(1, 1 + IV_BYTES)))
        cipher.updateAAD(CONTEXT)
        return String(cipher.doFinal(bytes.copyOfRange(1 + IV_BYTES, bytes.size)), Charsets.UTF_8)
    }

    companion object {
        private const val VERSION: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16
        private val CONTEXT = "wenbox.room-profiles.v1".toByteArray(Charsets.UTF_8)
    }
}
