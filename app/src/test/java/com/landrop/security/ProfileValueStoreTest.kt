package com.landrop.security

import org.junit.Assert.*
import org.junit.Test
import javax.crypto.KeyGenerator

class ProfileValueStoreTest {
    private class MemoryStorage(override var legacy: String? = null, override var encrypted: String? = null) : ProfileValueStorage {
        var failWrites = false
        var writes = 0
        override fun replaceEncrypted(value: String): Boolean {
            writes++
            if (failWrites) return false
            encrypted = value; legacy = null
            return true
        }
    }
    private fun cipher() = ProfileCipher(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())

    @Test fun firstReadMigratesAndRemovesPlaintextInOneTransaction() {
        val backend = MemoryStorage(legacy = "room PIN 6888")
        val cipher = cipher()
        val store = ProfileValueStore(backend) { cipher }
        assertEquals("room PIN 6888", store.read())
        assertNull(backend.legacy)
        assertNotEquals("room PIN 6888", backend.encrypted)
        assertEquals("room PIN 6888", cipher.decrypt(backend.encrypted!!))
        store.read(); assertEquals(1, backend.writes)
    }

    @Test fun encryptionFailurePreservesLegacyData() {
        val backend = MemoryStorage(legacy = "saved PIN")
        val store = ProfileValueStore(backend) { throw IllegalStateException("Keystore unavailable") }
        assertThrows(IllegalStateException::class.java) { store.read() }
        assertEquals("saved PIN", backend.legacy); assertNull(backend.encrypted); assertEquals(0, backend.writes)
    }

    @Test fun failedCommitDoesNotReportSuccessfulMigration() {
        val backend = MemoryStorage(legacy = "saved PIN").apply { failWrites = true }
        val cipher = cipher()
        assertThrows(IllegalStateException::class.java) { ProfileValueStore(backend) { cipher }.read() }
        assertEquals("saved PIN", backend.legacy); assertNull(backend.encrypted)
    }

    @Test fun encryptedReadNeverCreatesAReplacementKeyOrFallsBackToLegacy() {
        val backend = MemoryStorage(legacy = "old PIN", encrypted = cipher().encrypt("encrypted PIN"))
        val store = ProfileValueStore(backend) { create -> assertFalse(create); throw IllegalStateException("key missing") }
        assertThrows(IllegalStateException::class.java) { store.read() }
        assertEquals(0, backend.writes)
        assertNotNull(backend.encrypted)
    }

    @Test fun emptyStoreDoesNotCreateKeys() {
        val store = ProfileValueStore(MemoryStorage()) { throw AssertionError("must not access Keystore") }
        assertNull(store.read())
    }
}
