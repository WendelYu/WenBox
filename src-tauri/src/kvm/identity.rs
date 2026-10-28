use super::model::{Identity, Role, Saved, Side};
impl Identity {
    pub fn new() -> Result<Self, String> {
        use base64::Engine;
        let generated = rcgen::generate_simple_self_signed(vec!["wenbox.local".into()])
            .map_err(|e| e.to_string())?;
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            cert: base64::engine::general_purpose::STANDARD.encode(generated.cert.der()),
            key: base64::engine::general_purpose::STANDARD
                .encode(generated.key_pair.serialize_der()),
        })
    }
}

impl Saved {
    pub fn fresh() -> Result<Self, String> {
        Ok(Self {
            identity: Identity::new()?,
            enabled: false,
            role: if cfg!(windows) {
                Role::Target
            } else {
                Role::Source
            },
            side: if cfg!(windows) {
                Side::Left
            } else {
                Side::Right
            },
            peer: None,
        })
    }
}
