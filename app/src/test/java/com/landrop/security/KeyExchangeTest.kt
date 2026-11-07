package com.landrop.security
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class KeyExchangeTest {
 @Test fun roomKeyNeverAppearsOnWireAndRoundTrips() {
  val client=KeyExchange();val secret=ContentCrypto.generateKey()
  val wire=KeyExchange.protect(JSONObject().put("room",JSONObject().put("contentKey",secret)),client.publicKey)
  assertFalse(wire.toString().contains(secret));assertEquals(secret,client.open(wire).getJSONObject("room").getString("contentKey"))
 }
 @Test fun invalidAndLegacyRequestsNeverReceiveAKey() {
  val secret=ContentCrypto.generateKey();val wire=KeyExchange.protect(JSONObject().put("contentKey",secret),null)
  assertFalse(wire.toString().contains(secret));assertTrue(runCatching { KeyExchange.protect(JSONObject().put("contentKey",secret),"bad") }.isFailure)
 }
 @Test fun wrongClientAndPlaintextResponseAreRejected() {
  val a=KeyExchange();val b=KeyExchange();val wire=KeyExchange.protect(JSONObject().put("contentKey",ContentCrypto.generateKey()),a.publicKey)
  assertTrue(runCatching { b.open(wire) }.isFailure)
  assertTrue(runCatching { KeyExchange().open(JSONObject().put("contentKey","plaintext")) }.isFailure)
 }
}
