package com.landrop.security

import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.AlgorithmParameters
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.math.BigInteger
import java.util.Base64
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/** Ephemeral ECDH protects key delivery against passive packet capture. */
class KeyExchange {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private fun fixed(n: BigInteger): ByteArray = n.toByteArray().let { bytes -> ByteArray(32).also { out -> val count=minOf(bytes.size,32); System.arraycopy(bytes,bytes.size-count,out,32-count,count) } }
    private val publicBytes = (pair.public as ECPublicKey).let { byteArrayOf(4) + fixed(it.w.affineX) + fixed(it.w.affineY) }
    val publicKey: String = Base64.getEncoder().encodeToString(publicBytes)
    private fun derive(peer: String, client: String, server: String): String {
        val bytes=Base64.getDecoder().decode(peer)
        require(bytes.size==65 && bytes[0]==4.toByte()) { "无效的协商公钥" }
        val params=AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        val point=ECPoint(BigInteger(1,bytes.copyOfRange(1,33)),BigInteger(1,bytes.copyOfRange(33,65)))
        val key=KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point,params))
        val shared=KeyAgreement.getInstance("ECDH").apply { init(pair.private);doPhase(key,true) }.generateSecret()
        fun hmac(k:ByteArray,data:ByteArray)=Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(k,"HmacSHA256")) }.doFinal(data)
        val prk=hmac("wenbox-key-exchange:v1".toByteArray(),shared)
        val info=Base64.getDecoder().decode(client)+Base64.getDecoder().decode(server)+byteArrayOf(1)
        return Base64.getEncoder().encodeToString(hmac(prk,info))
    }
    fun open(value: JSONObject): JSONObject {
        require(value.optString("contentKey").isEmpty()) { "对端仍在明文发送密钥，请升级对端" }
        require(!value.optBoolean("keyExchangeRequired") || value.has("keyEnvelope")) { "缺少安全密钥协商响应" }
        value.optJSONObject("keyEnvelope")?.let { env ->
            require(env.optInt("version")==1)
            val server=env.getString("publicKey");val key=derive(server,publicKey,server)
            val cipher=env.getString("ciphertext");require(cipher.startsWith("wbx1:"))
            val plain=ContentCrypto.decryptText(key,"wenbox-key-wrap:v1".toByteArray(),cipher)
            require(Base64.getDecoder().decode(plain).size==32)
            value.remove("keyEnvelope");value.put("contentKey",plain)
        }
        value.keys().asSequence().toList().filter { it!="contentKey" }.forEach { name -> value.optJSONObject(name)?.let { open(it) } }
        return value
    }
    companion object {
        fun protect(value: JSONObject, client: String?): JSONObject {
            val key=value.optString("contentKey");value.remove("contentKey")
            if(key.isNotEmpty()) value.put("keyExchangeRequired",true)
            if(key.isNotEmpty() && !client.isNullOrBlank()) {
                val exchange=KeyExchange();val wrapping=exchange.derive(client,client,exchange.publicKey)
                value.put("keyEnvelope",JSONObject().put("version",1).put("publicKey",exchange.publicKey).put("ciphertext",ContentCrypto.encryptText(wrapping,"wenbox-key-wrap:v1".toByteArray(),key)))
            }
            value.keys().asSequence().toList().forEach { name -> value.optJSONObject(name)?.let { protect(it,client) } }
            return value
        }
    }
}
