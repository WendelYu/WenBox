use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::Path;

pub const CONTROL_PORT: u16 = 9530;
pub const INPUT_PORT: u16 = 9531;
pub fn fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn lan(ip: Ipv4Addr) -> bool {
    (ip.is_private() || ip.is_link_local()) && !ip.is_loopback() && !ip.is_unspecified()
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}
impl Side {
    pub fn opposite(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
            Self::Top => Self::Bottom,
            Self::Bottom => Self::Top,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "up",
            Self::Bottom => "down",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Source,
    Target,
}
impl Role {
    pub fn opposite(self) -> Self {
        if self == Self::Source {
            Self::Target
        } else {
            Self::Source
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub cert: String,
    pub key: String,
}
impl Identity {
    pub fn cert_der(&self) -> Result<Vec<u8>, String> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(&self.cert)
            .map_err(|_| "设备证书无效".into())
    }
    pub fn key_der(&self) -> Result<Vec<u8>, String> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(&self.key)
            .map_err(|_| "设备密钥无效".into())
    }
    pub fn fingerprint(&self) -> Result<String, String> {
        Ok(fingerprint(&self.cert_der()?))
    }
    pub fn screen(&self) -> Result<String, String> {
        screen(&self.id)
    }
}
pub fn screen(id: &str) -> Result<String, String> {
    Ok(format!(
        "wenbox-{}",
        uuid::Uuid::parse_str(id)
            .map_err(|_| "设备标识无效")?
            .simple()
    ))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub fingerprint: String,
    pub ip: Ipv4Addr,
    pub local_ip: Ipv4Addr,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Saved {
    pub identity: Identity,
    pub enabled: bool,
    pub role: Role,
    pub side: Side,
    pub peer: Option<Peer>,
}
pub fn normal_speed() -> u16 {
    100
}
fn is_normal_speed(v: &u16) -> bool {
    *v == 100
}
// Used solely on the local service pipe. Never return or log this structure in UI/HTTP.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineProfile {
    #[serde(default = "normal_speed", skip_serializing_if = "is_normal_speed")]
    pub scroll_speed: u16,
    pub identity: Identity,
    pub peer: Peer,
    pub role: Role,
    pub side: Side,
}
impl EngineProfile {
    pub fn validate(&self) -> Result<(), String> {
        if !(50..=200).contains(&self.scroll_speed) {
            return Err("滚轮速度范围为 50% 至 200%".into());
        }
        self.identity.screen()?;
        screen(&self.peer.id)?;
        if self.identity.id == self.peer.id {
            return Err("不能配对本机".into());
        }
        if !lan(self.peer.ip) || !lan(self.peer.local_ip) {
            return Err("仅支持私有或链路本地 IPv4 地址".into());
        }
        if self.peer.fingerprint.len() != 64
            || !self.peer.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("对端证书指纹无效".into());
        }
        if self.identity.cert_der()?.len() > 8192 || self.identity.key_der()?.len() > 8192 {
            return Err("设备证书过大".into());
        }
        Ok(())
    }
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存目录无效")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn ini_path(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('"', "\\\"")
    )
}
fn pem(label: &str, encoded: &str) -> String {
    let mut result = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        result.push_str(std::str::from_utf8(line).unwrap_or_default());
        result.push('\n')
    }
    result.push_str(&format!("-----END {label}-----\n"));
    result
}
pub fn render_profile(root: &Path, p: &EngineProfile) -> Result<std::path::PathBuf, String> {
    p.validate()?;
    let own = p.identity.screen()?;
    let peer = screen(&p.peer.id)?;
    let tls = root.join("tls");
    std::fs::create_dir_all(&tls).map_err(|e| e.to_string())?;
    atomic(
        &tls.join("device.pem"),
        (pem("CERTIFICATE", &p.identity.cert) + &pem("PRIVATE KEY", &p.identity.key)).as_bytes(),
    )?;
    for file in ["trusted-servers", "trusted-clients"] {
        atomic(
            &tls.join(file),
            format!("v2:sha256:{}\n", p.peer.fingerprint.to_lowercase()).as_bytes(),
        )?;
    }
    let layout=format!("section: links\n  {own}:\n    {} = {peer}\n  {peer}:\n    {} = {own}\nend\nsection: options\n  keystroke(Control+Alt+Escape) = switchToScreen({own})\nend\n",p.side.name(),p.side.opposite().name());
    atomic(&root.join("screens.conf"), layout.as_bytes())?;
    let config=format!("[computer_{own}]\nname={own}\n[computer_{peer}]\nname={peer}\n[core]\ncoreMode={}\ncomputerName={own}\ninterface={}\nport={INPUT_PORT}\nprocessMode=1\nenableEnterCommand=false\nenableExitCommand=false\n[security]\ntlsEnabled=true\ncheckPeerFingerprints=true\ncertificate={}\n[client]\nremoteHost={}\n[server]\nexternalConfig=true\nexternalConfigFile={}\nenableClipboard=false\nenableHeartbeat=true\nheartbeat=500\n[daemon]\nelevate=true\n[gui]\nstartCoreWithGui=false\nenableUpdateCheck=false\n[log]\nlevel=INFO\n",if p.role==Role::Source{2}else{1},p.peer.local_ip,ini_path(&tls.join("device.pem")),p.peer.ip,ini_path(&root.join("screens.conf")));
    let config = config.replace(
        "[client]\n",
        &format!(
            "[client]\nxScrollScale={:.2}\nyScrollScale={:.2}\n",
            f64::from(p.scroll_speed) / 100.0,
            f64::from(p.scroll_speed) / 100.0
        ),
    );
    let path = root.join("input.ini");
    atomic(&path, config.as_bytes())?;
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_are_symmetric_and_commands_are_fixed() {
        let id = Identity::new().unwrap();
        let peer = Peer {
            id: uuid::Uuid::new_v4().to_string(),
            name: "injected\ncommand".into(),
            platform: "Windows".into(),
            fingerprint: "ab".repeat(32),
            ip: "192.168.1.2".parse().unwrap(),
            local_ip: "192.168.1.1".parse().unwrap(),
        };
        for side in [Side::Left, Side::Right, Side::Top, Side::Bottom] {
            let d = tempfile::tempdir().unwrap();
            let path = render_profile(
                d.path(),
                &EngineProfile {
                    scroll_speed: 100,
                    identity: id.clone(),
                    peer: peer.clone(),
                    role: Role::Source,
                    side,
                },
            )
            .unwrap();
            let s = std::fs::read_to_string(path).unwrap();
            assert!(s.contains("enableClipboard=false"));
            assert!(s.contains(&format!(
                "[computer_{}]\nname={}\n",
                id.screen().unwrap(),
                id.screen().unwrap()
            )));
            assert!(s.contains(&format!(
                "[computer_{}]\nname={}\n",
                screen(&peer.id).unwrap(),
                screen(&peer.id).unwrap()
            )));
            let l = std::fs::read_to_string(d.path().join("screens.conf")).unwrap();
            assert!(l.contains(&format!("{} =", side.name())));
            assert!(l.contains(&format!("{} =", side.opposite().name())));
            assert!(!l.contains("injected"));
            assert!(!l.contains("section: screens"));
        }
    }
    #[test]
    fn scroll_config_and_old_profile_defaults_remain_compatible() {
        let mut profile = EngineProfile {
            identity: Identity::new().unwrap(),
            peer: Peer {
                id: uuid::Uuid::new_v4().to_string(),
                name: "test".into(),
                platform: "Windows".into(),
                fingerprint: "ab".repeat(32),
                ip: "192.168.1.2".parse().unwrap(),
                local_ip: "192.168.1.1".parse().unwrap(),
            },
            role: Role::Target,
            side: Side::Left,
            scroll_speed: 100,
        };
        let old = serde_json::to_value(&profile).unwrap();
        assert!(old.get("scrollSpeed").is_none());
        assert_eq!(
            serde_json::from_value::<EngineProfile>(old)
                .unwrap()
                .scroll_speed,
            100
        );
        profile.scroll_speed = 175;
        let root = tempfile::tempdir().unwrap();
        let file = render_profile(root.path(), &profile).unwrap();
        let ini = std::fs::read_to_string(file).unwrap();
        assert!(ini.contains("xScrollScale=1.75\nyScrollScale=1.75"));
        for invalid in [0, 49, 201, u16::MAX] {
            profile.scroll_speed = invalid;
            assert!(profile.validate().is_err());
        }
    }

    #[test]
    fn public_addresses_and_config_injection_are_rejected() {
        assert!(!lan("8.8.8.8".parse().unwrap()));
        assert!(screen("x\ncommands").is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod pem_tests {
    use super::*;
    #[test]
    fn generated_identity_is_accepted_by_openssl_and_matches_the_pinned_digest() {
        let root = tempfile::tempdir().unwrap();
        let identity = Identity::new().unwrap();
        let path = root.path().join("identity.pem");
        atomic(
            &path,
            (pem("CERTIFICATE", &identity.cert) + &pem("PRIVATE KEY", &identity.key)).as_bytes(),
        )
        .unwrap();
        let cert = std::process::Command::new("/usr/bin/openssl")
            .args(["x509", "-in"])
            .arg(&path)
            .args(["-noout", "-fingerprint", "-sha256"])
            .output()
            .unwrap();
        assert!(cert.status.success());
        let digest = String::from_utf8(cert.stdout)
            .unwrap()
            .split('=')
            .last()
            .unwrap()
            .trim()
            .replace(':', "")
            .to_lowercase();
        assert_eq!(digest, identity.fingerprint().unwrap());
        let key = std::process::Command::new("/usr/bin/openssl")
            .args(["pkey", "-in"])
            .arg(&path)
            .arg("-noout")
            .output()
            .unwrap();
        assert!(key.status.success());
    }
}
