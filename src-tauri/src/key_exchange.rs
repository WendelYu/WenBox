//! Ephemeral P-256 ECDH + HKDF-SHA256 key wrapping. No secret crosses HTTP.
//! This prevents passive capture; server identity still needs a trusted channel.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{agreement, hkdf, rand::SystemRandom};
use serde_json::{json, Value};
const CONTEXT: &[u8] = b"wenbox-key-exchange:v1";
pub struct Exchange {
    private: agreement::EphemeralPrivateKey,
    pub public: String,
}
impl Exchange {
    pub fn new() -> Result<Self, String> {
        let private =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new())
                .map_err(|_| "密钥协商初始化失败")?;
        let public = B64.encode(
            private
                .compute_public_key()
                .map_err(|_| "公钥生成失败")?
                .as_ref(),
        );
        Ok(Self { private, public })
    }
    fn derive(self, peer: &str, client: &str, server: &str) -> Result<String, String> {
        let bytes = B64.decode(peer).map_err(|_| "公钥格式无效")?;
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, bytes);
        let mut info = B64.decode(client).map_err(|_| "公钥无效")?;
        info.extend(B64.decode(server).map_err(|_| "公钥无效")?);
        agreement::agree_ephemeral(self.private, &peer, |shared| {
            let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, CONTEXT);
            let prk = salt.extract(shared);
            let infos = [info.as_slice()];
            let okm = prk
                .expand(&infos, hkdf::HKDF_SHA256)
                .map_err(|_| "协商失败")?;
            let mut key = [0u8; 32];
            okm.fill(&mut key).map_err(|_| "协商失败")?;
            Ok(B64.encode(key))
        })
        .map_err(|_| "对端公钥无效".to_string())?
    }
    pub fn open(self, value: &mut Value) -> Result<(), String> {
        if value
            .get("contentKey")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            return Err("对端仍在明文发送密钥，请升级对端".into());
        }
        if value["keyExchangeRequired"].as_bool() == Some(true)
            && value.get("keyEnvelope").is_none()
        {
            return Err("缺少安全密钥协商响应，请升级两端".into());
        }
        if let Some(env) = value.get("keyEnvelope") {
            if env["version"].as_u64() != Some(1) {
                return Err("不支持的密钥协商版本".into());
            }
            let server = env["publicKey"].as_str().ok_or("缺少协商公钥")?.to_string();
            let cipher = env["ciphertext"]
                .as_str()
                .ok_or("缺少密钥密文")?
                .to_string();
            let public = self.public.clone();
            let key = self.derive(&server, &public, &server)?;
            let plain = crate::content_crypto::decrypt_text(&key, "wenbox-key-wrap:v1", &cipher)?;
            if !cipher.starts_with("wbx1:")
                || B64.decode(&plain).map_err(|_| "密钥无效")?.len() != 32
            {
                return Err("协商响应无效".into());
            }
            value
                .as_object_mut()
                .ok_or("协商响应无效")?
                .remove("keyEnvelope");
            value["contentKey"] = plain.into();
            return Ok(());
        }
        // Only one content key is present per response (inside room or at root).
        if let Some(room) = value.get_mut("room") {
            return self.open(room);
        }
        Ok(())
    }
}
pub fn protect(value: &mut Value, client: Option<&str>) -> Result<(), String> {
    if let Some(object) = value.as_object_mut() {
        if let Some(key) = object
            .remove("contentKey")
            .and_then(|v| v.as_str().map(str::to_owned))
        {
            if !key.is_empty() {
                object.insert("keyExchangeRequired".into(), true.into());
                if let Some(client) = client {
                    let exchange = Exchange::new()?;
                    let public = exchange.public.clone();
                    let wrapping = exchange.derive(client, client, &public)?;
                    let cipher =
                        crate::content_crypto::encrypt_text(&wrapping, "wenbox-key-wrap:v1", &key)?;
                    object.insert(
                        "keyEnvelope".into(),
                        json!({"version":1,"publicKey":public,"ciphertext":cipher}),
                    );
                }
            }
        }
        for v in object.values_mut() {
            protect(v, client)?;
        }
    } else if let Some(array) = value.as_array_mut() {
        for v in array {
            protect(v, client)?;
        }
    }
    Ok(())
}
pub fn wire(req: &tiny_http::Request, mut value: Value) -> String {
    let client = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-WenBox-Key"))
        .map(|h| h.value.as_str());
    match protect(&mut value, client) {
        Ok(()) => value.to_string(),
        Err(_) => json!({"success":false,"message":"密钥协商失败，请升级两端后重试"}).to_string(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_without_secret_and_roundtrips() {
        let ex = Exchange::new().unwrap();
        let secret = crate::content_crypto::generate_key().unwrap();
        let mut v = json!({"room":{"contentKey":secret}});
        protect(&mut v, Some(&ex.public)).unwrap();
        assert!(!v.to_string().contains(&secret));
        ex.open(&mut v).unwrap();
        assert_eq!(v["room"]["contentKey"], secret);
    }
    #[test]
    fn legacy_and_invalid_peers_never_receive_keys() {
        let secret = crate::content_crypto::generate_key().unwrap();
        let mut v = json!({"contentKey":secret});
        protect(&mut v, None).unwrap();
        assert!(!v.to_string().contains(&secret));
        assert!(protect(&mut json!({"contentKey":secret}), Some("bad")).is_err());
    }
    #[test]
    fn rejects_plaintext_response() {
        let ex = Exchange::new().unwrap();
        assert!(ex.open(&mut json!({"contentKey":"secret"})).is_err());
    }
}
