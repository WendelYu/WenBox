package com.landrop.security

/** One atomic preference transaction replaces legacy plaintext with an authenticated envelope. */
interface ProfileValueStorage {
    val encrypted: String?
    val legacy: String?
    fun replaceEncrypted(value: String): Boolean
}

class ProfileValueStore(private val storage: ProfileValueStorage, private val cipher: (createKey: Boolean) -> ProfileCipher) {
    fun read(): String? {
        storage.encrypted?.let { return cipher(false).decrypt(it) }
        val legacy = storage.legacy ?: return null
        write(legacy)
        return legacy
    }

    fun write(plaintext: String) {
        val encrypted = cipher(true).encrypt(plaintext)
        check(storage.replaceEncrypted(encrypted)) { "无法保存常用房间" }
    }
}
