package com.landrop.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.landrop.ui.TransferViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

data class RoomProfile(val name: String, val pin: String)

/** Only ciphertext is persisted; all Keystore and preference IO runs off the main thread. */
class RoomProfileStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(TransferViewModel.PREFS, Context.MODE_PRIVATE)

    private val values = ProfileValueStore(object : ProfileValueStorage {
        override val encrypted get() = prefs.getString(ENCRYPTED, null)
        override val legacy get() = prefs.getString(LEGACY, null)
        override fun replaceEncrypted(value: String) = prefs.edit().putString(ENCRYPTED, value).remove(LEGACY).commit()
    }) { create -> ProfileCipher(key(create)) }

    suspend fun load(): List<RoomProfile> = withContext(Dispatchers.IO) { synchronized(lock) { read() } }

    suspend fun upsert(name: String, pin: String) = withContext(Dispatchers.IO) {
        synchronized(lock) { write((listOf(RoomProfile(name, pin)) + read().filter { it.name != name }).take(10)) }
    }

    suspend fun remove(name: String) = withContext(Dispatchers.IO) {
        synchronized(lock) { write(read().filter { it.name != name }) }
    }

    suspend fun reset() = withContext(Dispatchers.IO) {
        synchronized(lock) {
            check(prefs.edit().remove(ENCRYPTED).remove(LEGACY).commit()) { "无法重置常用房间" }
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        }
    }

    private fun read(): List<RoomProfile> {
        val raw = values.read() ?: return emptyList()
        val array = JSONArray(raw)
        val result = (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            RoomProfile(item.getString("name"), item.optString("pin", ""))
        }.take(10)
        return result
    }

    private fun write(profiles: List<RoomProfile>) {
        val raw = JSONArray(profiles.map { JSONObject().put("name", it.name).put("pin", it.pin) }).toString()
        values.write(raw)
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        check(create) { "无法解密常用房间，请在此设备重新保存配置" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
        }.generateKey()
    }

    companion object {
        private val lock = Any()
        private const val ALIAS = "wenbox.room-profiles.v1"
        private const val ENCRYPTED = "room_profiles_encrypted_v1"
        private const val LEGACY = "room_profiles"
    }
}
