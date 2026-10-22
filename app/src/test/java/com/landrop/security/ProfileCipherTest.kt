package com.landrop.security

import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import javax.crypto.KeyGenerator

class ProfileCipherTest {
    private fun cipher() = ProfileCipher(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())

    @Test fun unicodeProfilesRoundTripWithoutPersistingPlaintext() {
        val cipher = cipher()
        val plaintext = "[{\"name\":\"研发房间\",\"pin\":\"6888\"}]"
        val encrypted = cipher.encrypt(plaintext)
        assertEquals(plaintext, cipher.decrypt(encrypted))
        assertFalse(String(Base64.getDecoder().decode(encrypted), Charsets.UTF_8).contains("6888"))
    }

    @Test fun repeatedEncryptionUsesFreshNonce() {
        val cipher = cipher()
        assertNotEquals(cipher.encrypt("same PIN"), cipher.encrypt("same PIN"))
    }

    @Test fun tamperingIsRejected() {
        val cipher = cipher()
        val payload = Base64.getDecoder().decode(cipher.encrypt("6888"))
        payload[payload.lastIndex] = (payload.last().toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { cipher.decrypt(Base64.getEncoder().encodeToString(payload)) }
    }

    @Test fun wrongKeyCannotDecrypt() {
        val payload = cipher().encrypt("6888")
        assertThrows(Exception::class.java) { cipher().decrypt(payload) }
    }

    @Test fun truncatedOrUnknownVersionIsRejected() {
        val cipher = cipher()
        assertThrows(Exception::class.java) { cipher.decrypt("AQ==") }
        val payload = Base64.getDecoder().decode(cipher.encrypt("6888")); payload[0] = 2
        assertThrows(Exception::class.java) { cipher.decrypt(Base64.getEncoder().encodeToString(payload)) }
    }
}
