//! Opt-in text clipboard for an authenticated, connected pair. Contents stay in memory.
use super::model::{atomic, fingerprint};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
pub const TEXT_LIMIT: usize = 1024 * 1024;
pub const FRAME_LIMIT: usize = 1_410_000;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Version {
    clock: u64,
    origin: String,
}
impl Version {
    fn validate(&self, local: &str, peer: &str) -> Result<(), String> {
        if self.clock == 0
            || self.clock > u64::MAX / 2
            || ![local, peer].contains(&self.origin.as_str())
        {
            return Err("剪贴板版本无效".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Packet {
    version: Version,
    text: String,
}
impl Packet {
    fn decode(&self, local: &str, peer: &str) -> Result<String, String> {
        if self.version.clock == 0
            || self.version.clock > u64::MAX / 2
            || ![local, peer].contains(&self.version.origin.as_str())
            || self.text.len() > TEXT_LIMIT.div_ceil(3) * 4
        {
            return Err("剪贴板消息无效或超过 1 MiB".into());
        }
        let bytes = STANDARD.decode(&self.text).map_err(|_| "剪贴板编码无效")?;
        if bytes.len() > TEXT_LIMIT {
            return Err("文本超过 1 MiB，未同步".into());
        }
        String::from_utf8(bytes).map_err(|_| "剪贴板不是 UTF-8 文本".into())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exchange {
    epoch: String,
    peer_epoch: Option<String>,
    known: Option<Version>,
    packet: Option<Packet>,
}
impl Exchange {
    pub fn epoch(&self) -> &str {
        &self.epoch
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExchangeReply {
    epoch: String,
    known: Option<Version>,
    packet: Option<Packet>,
}
impl ExchangeReply {
    pub fn epoch(&self) -> &str {
        &self.epoch
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub active: bool,
    pub message: String,
    pub limit_bytes: usize,
}
struct Link {
    peer: String,
    epoch: String,
    peer_epoch: Option<String>,
    observed: Option<String>,
    current: Option<Packet>,
    peer_known: Option<Version>,
    pending: Option<Packet>,
    clock: u64,
}
impl Link {
    fn reset_remote(&mut self, epoch: String) {
        self.peer_epoch = Some(epoch);
        self.observed = None;
        self.current = None;
        self.peer_known = None;
        self.pending = None;
        self.clock = 0;
    }
    fn known(&self) -> Option<Version> {
        self.current.as_ref().map(|p| p.version.clone())
    }
    fn newer(&self) -> Option<Packet> {
        self.current
            .as_ref()
            .filter(|p| Some(&p.version) > self.peer_known.as_ref())
            .cloned()
    }
    fn accept(&mut self, packet: Packet, local: &str) -> Result<(), String> {
        packet.decode(local, &self.peer)?;
        self.clock = self.clock.max(packet.version.clock);
        if Some(&packet.version) > self.current.as_ref().map(|p| &p.version) {
            self.pending = Some(packet.clone());
            self.current = Some(packet);
        }
        Ok(())
    }
}
struct State {
    enabled: bool,
    link: Option<Link>,
    message: String,
}
pub struct Clipboard {
    file: PathBuf,
    local: String,
    state: Mutex<State>,
}
impl Clipboard {
    pub fn open(root: PathBuf, local: String) -> Self {
        let file = root.join("clipboard.json");
        let enabled = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<bool>(&b).ok())
            .unwrap_or(false);
        Self {
            file,
            local,
            state: Mutex::new(State {
                enabled,
                link: None,
                message: "等待两端开启并连接".into(),
            }),
        }
    }
    pub fn notice(&self, message: &str) {
        self.lock().message = message.into();
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut s = self.lock();
        if !enabled {
            s.enabled = false;
            s.link = None;
        }
        atomic(
            &self.file,
            &serde_json::to_vec(&enabled).map_err(|_| "剪贴板设置保存失败")?,
        )?;
        s.enabled = enabled;
        s.link = None;
        s.message = "等待两端开启并连接".into();
        Ok(())
    }
    pub fn view(&self) -> View {
        let s = self.lock();
        View {
            enabled: s.enabled,
            active: s.enabled && s.link.as_ref().is_some_and(|l| l.peer_epoch.is_some()),
            message: if s.enabled {
                s.message.clone()
            } else {
                "文本同步已关闭".into()
            },
            limit_bytes: TEXT_LIMIT,
        }
    }
    pub fn pause(&self, message: &str) {
        let mut s = self.lock();
        s.link = None;
        s.message = message.into();
    }
    pub fn activate(&self, peer: &str) {
        let mut s = self.lock();
        if !s.enabled {
            return;
        }
        if !s.link.as_ref().is_some_and(|l| l.peer == peer) {
            s.link = Some(Link {
                peer: peer.into(),
                epoch: uuid::Uuid::new_v4().to_string(),
                peer_epoch: None,
                observed: None,
                current: None,
                peer_known: None,
                pending: None,
                clock: 0,
            });
        }
    }
    pub fn is_current(&self, epoch: &str) -> bool {
        let s = self.lock();
        s.enabled && s.link.as_ref().is_some_and(|l| l.epoch == epoch)
    }
    pub fn request(&self) -> Option<Exchange> {
        let s = self.lock();
        let l = s.link.as_ref()?;
        if !s.enabled {
            return None;
        }
        Some(Exchange {
            epoch: l.epoch.clone(),
            peer_epoch: l.peer_epoch.clone(),
            known: l.known(),
            packet: l.newer(),
        })
    }
    pub fn exchange(&self, peer: &str, req: Exchange) -> Result<ExchangeReply, String> {
        if uuid::Uuid::parse_str(&req.epoch).is_err() {
            return Err("剪贴板会话无效".into());
        }
        let mut s = self.lock();
        if !s.enabled {
            return Err("请在两端分别开启文本剪贴板同步".into());
        }
        let l = s
            .link
            .as_mut()
            .filter(|l| l.peer == peer)
            .ok_or("输入连接尚未就绪")?;
        if l.peer_epoch.as_ref() != Some(&req.epoch) {
            l.reset_remote(req.epoch);
        }
        let matched = req.peer_epoch.as_ref() == Some(&l.epoch);
        if matched {
            if let Some(known) = &req.known {
                known.validate(&self.local, &l.peer)?;
            }
            if let Some(packet) = req.packet {
                l.accept(packet, &self.local)?;
            }
            l.peer_known = req.known;
        }
        Ok(ExchangeReply {
            epoch: l.epoch.clone(),
            known: l.known(),
            packet: if matched { l.newer() } else { None },
        })
    }
    pub fn complete(&self, epoch: &str, reply: ExchangeReply) -> Result<(), String> {
        if uuid::Uuid::parse_str(&reply.epoch).is_err() {
            return Err("剪贴板会话无效".into());
        }
        let mut s = self.lock();
        if !s.enabled {
            return Ok(());
        }
        let Some(l) = s.link.as_mut().filter(|l| l.epoch == epoch) else {
            return Ok(());
        };
        if l.peer_epoch.as_ref() != Some(&reply.epoch) {
            l.reset_remote(reply.epoch);
            return Ok(());
        }
        if let Some(known) = &reply.known {
            known.validate(&self.local, &l.peer)?;
        }
        if let Some(packet) = reply.packet {
            l.accept(packet, &self.local)?;
        }
        l.peer_known = reply.known;
        if !s.message.starts_with("文本超过") && !s.message.starts_with("暂时") {
            s.message = "已连接，仅同步新复制的文本".into();
        }
        Ok(())
    }
    // Clipboard IO is called only by the dedicated desktop worker, never HTTP or SYSTEM service.
    pub fn observe(&self, text: Option<&str>, mut write: impl FnMut(String) -> Result<(), String>) {
        let mut s = self.lock();
        if !s.enabled {
            return;
        }
        let Some(l) = s.link.as_mut().filter(|l| l.peer_epoch.is_some()) else {
            return;
        };
        let mut message = None;
        if let Some(text) = text {
            let hash = fingerprint(text.as_bytes());
            if l.observed.as_ref() != Some(&hash) {
                let first = l.observed.is_none();
                l.observed = Some(hash);
                if !first {
                    if text.len() > TEXT_LIMIT {
                        l.pending = None;
                        message = Some("文本超过 1 MiB，未同步".into());
                    } else {
                        l.clock += 1;
                        l.current = Some(Packet {
                            version: Version {
                                clock: l.clock,
                                origin: self.local.clone(),
                            },
                            text: STANDARD.encode(text.as_bytes()),
                        });
                        l.pending = None;
                        message = Some("已连接，仅同步新复制的文本".into());
                    }
                }
            }
        }
        if let Some(packet) = l.pending.clone() {
            if let Ok(value) = packet.decode(&self.local, &l.peer) {
                let hash = fingerprint(value.as_bytes());
                match write(value) {
                    Ok(()) => {
                        l.observed = Some(hash);
                        l.pending = None;
                        message = Some("已连接，仅同步新复制的文本".into());
                    }
                    Err(_) => message = Some("暂时无法写入系统剪贴板，将自动重试".into()),
                }
            }
        }
        if let Some(message) = message {
            s.message = message;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn round(a: &Clipboard, b: &Clipboard) {
        let request = a.request().unwrap();
        let epoch = request.epoch.clone();
        let reply = b.exchange(&a.local, request).unwrap();
        a.complete(&epoch, reply).unwrap();
    }
    fn pair() -> (tempfile::TempDir, tempfile::TempDir, Clipboard, Clipboard) {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let ca = Clipboard::open(a.path().into(), "a".into());
        let cb = Clipboard::open(b.path().into(), "b".into());
        ca.set_enabled(true).unwrap();
        cb.set_enabled(true).unwrap();
        ca.activate("b");
        cb.activate("a");
        for _ in 0..3 {
            round(&ca, &cb);
            round(&cb, &ca);
        }
        ca.observe(Some("old-a"), |_| panic!("baseline must not write"));
        cb.observe(Some("old-b"), |_| panic!("baseline must not write"));
        (a, b, ca, cb)
    }
    #[test]
    fn utf8_megabyte_roundtrips_both_ways_without_echo() {
        let (_a, _b, a, b) = pair();
        let text = "中文\n".repeat(TEXT_LIMIT / 7);
        a.observe(Some(&text), |_| panic!("local copy must not write"));
        assert!(serde_json::to_vec(&a.request().unwrap()).unwrap().len() < FRAME_LIMIT);
        round(&a, &b);
        let mut writes = vec![];
        b.observe(Some("old-b"), |v| {
            writes.push(v);
            Ok(())
        });
        assert_eq!(writes, vec![text.clone()]);
        b.observe(Some(&text), |_| panic!("remote text must not echo"));
        round(&b, &a);
        a.observe(Some(&text), |_| panic!("already local"));
        b.observe(Some("返程\n第二行"), |_| panic!("local copy"));
        round(&b, &a);
        a.observe(Some(&text), |v| {
            assert_eq!(v, "返程\n第二行");
            Ok(())
        });
    }
    #[test]
    fn oversize_disable_revoke_and_old_epoch_are_safe() {
        let (_a, _b, a, b) = pair();
        a.observe(Some(&"a".repeat(TEXT_LIMIT + 1)), |_| panic!());
        assert!(a.view().message.contains("超过"));
        assert!(a.request().unwrap().packet.is_none());
        b.observe(Some("new"), |_| panic!());
        let req = a.request().unwrap();
        let epoch = req.epoch.clone();
        let late = b.exchange("a", req).unwrap();
        a.set_enabled(false).unwrap();
        a.complete(&epoch, late.clone()).unwrap();
        a.observe(Some("old-a"), |_| panic!("disabled"));
        assert!(a.request().is_none());
        a.set_enabled(true).unwrap();
        a.activate("b");
        a.complete(&epoch, late).unwrap();
        assert!(a.request().unwrap().packet.is_none());
        a.pause("unpaired");
        assert!(a.request().is_none());
    }
    #[test]
    fn simultaneous_copy_converges_and_write_failure_retries() {
        let (_a, _b, a, b) = pair();
        a.observe(Some("a-copy"), |_| panic!());
        b.observe(Some("b-copy"), |_| panic!());
        round(&a, &b);
        round(&b, &a);
        a.observe(Some("a-copy"), |_| Err("busy".into()));
        assert!(a.view().message.contains("自动重试"));
        a.observe(Some("a-copy"), |v| {
            assert_eq!(v, "b-copy");
            Ok(())
        });
        for _ in 0..3 {
            round(&a, &b);
            round(&b, &a);
        }
        a.observe(Some("b-copy"), |_| panic!("no echo"));
        b.observe(Some("b-copy"), |_| panic!("no echo"));
    }
    #[test]
    fn settings_persist_and_malformed_payloads_are_rejected() {
        let (root, _other, a, b) = pair();
        assert!(Clipboard::open(root.path().into(), "a".into()).enabled());
        let mut request = a.request().unwrap();
        request.packet = Some(Packet {
            version: Version {
                clock: 2,
                origin: "stranger".into(),
            },
            text: STANDARD.encode("private"),
        });
        assert!(b.exchange("a", request.clone()).is_err());
        request.packet.as_mut().unwrap().version.origin = "a".into();
        request.packet.as_mut().unwrap().text = "invalid!".into();
        assert!(b.exchange("a", request).is_err());
        a.set_enabled(false).unwrap();
        assert!(!Clipboard::open(root.path().into(), "a".into()).enabled());
    }
}
