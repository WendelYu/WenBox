use super::model::*;
use std::{
    collections::VecDeque,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
pub struct Engine {
    root: PathBuf,
    resources: PathBuf,
    child: Option<Child>,
    applied: Option<String>,
    running: bool,
    message: String,
    output: Arc<Mutex<VecDeque<u8>>>,
    runtime: Option<tempfile::TempDir>,
    started: Option<Instant>,
    failed: Option<String>,
    source: bool,
    pointer_speed: u16,
    scroll_speed: u16,
    keyboard_map: KeyboardMap,
    connected: Arc<Mutex<Option<bool>>>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
}
impl Engine {
    pub fn new(root: PathBuf, resources: PathBuf) -> Self {
        let pointer_speed = std::fs::read(root.join("pointer-speed.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<u16>(&b).ok())
            .filter(|v| (50..=200).contains(v))
            .unwrap_or(100);
        let scroll_speed = std::fs::read(root.join("scroll-speed.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<u16>(&b).ok())
            .filter(|v| (50..=200).contains(v))
            .unwrap_or(100);
        let keyboard_map = std::fs::read(root.join("keyboard-map.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<KeyboardMap>(&b).ok())
            .filter(|m| m.validate().is_ok())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    KeyboardMap::shortcuts()
                } else {
                    KeyboardMap::default()
                }
            });
        Self {
            keyboard_map,
            scroll_speed,
            pointer_speed,
            root,
            resources,
            child: None,
            applied: None,
            running: false,
            message: "尚未启用流转".into(),
            output: Arc::new(Mutex::new(VecDeque::new())),
            runtime: None,
            started: None,
            failed: None,
            source: false,
            connected: Arc::new(Mutex::new(None)),
            monitor_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    fn binary(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            self.resources
                .join("resources/kvm/Deskflow.app/Contents/MacOS/deskflow-core")
        }
        #[cfg(windows)]
        {
            self.resources.join("resources/kvm/input/deskflow-core.exe")
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            self.resources.join("unsupported")
        }
    }
    pub fn view(&mut self) -> (bool, bool, String) {
        #[cfg(windows)]
        {
            if self.running {
                match super::broker_client::running() {
                    Ok(true) => {}
                    _ => {
                        self.running = false;
                        self.applied = None;
                        self.message = "输入后台服务尚未就绪".into();
                    }
                }
            }
        }
        if let Some(c) = self.child.as_mut() {
            if let Ok(Some(exit)) = c.try_wait() {
                self.child = None;
                self.running = false;
                self.failed = self.applied.take();
                self.started = None;
                self.runtime = None;
                let detail = self.diagnostics();
                self.message = if detail.contains("assistive devices does not trust")
                    || detail.contains("process is not trusted")
                {
                    "macOS 尚未信任当前版本 WenBox。请检查辅助功能；若开关已开启，移除旧条目并重新添加当前应用，再重启 WenBox。".into()
                } else {
                    format!(
                        "输入核心已退出（{exit}）：{}",
                        detail
                            .chars()
                            .rev()
                            .take(1200)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    )
                };
            }
        }
        #[cfg(target_os = "macos")]
        if self.child.is_some() && !self.running {
            // A PID or a responsive Qt event loop does not imply a listening input server.
            let ready = if self.source {
                let pid = self.child.as_ref().unwrap().id().to_string();
                Command::new("/usr/sbin/lsof")
                    .args(["-nP", "-a", "-p", &pid, "-iTCP:9531", "-sTCP:LISTEN", "-Fn"])
                    .output()
                    .map(|o| o.status.success() && !o.stdout.is_empty())
                    .unwrap_or(false)
            } else {
                self.runtime
                    .as_ref()
                    .map(|r| super::ipc::request_at(r.path(), super::ipc::Action::Probe).is_ok())
                    .unwrap_or(false)
            };
            if ready {
                self.running = true;
                self.message = if self.source {
                    "输入核心已监听，等待或保持对端连接"
                } else {
                    "输入核心已响应，等待或保持对端连接"
                }
                .into();
            } else if self
                .started
                .is_some_and(|t| t.elapsed() >= Duration::from_secs(15))
            {
                let failed = self.applied.clone();
                let _ = self.stop();
                self.failed = failed;
                self.message = "输入核心启动超时，尚未就绪；请检查诊断后停止并重新启动流转".into();
            }
        }
        (self.binary().is_file(), self.running, self.message.clone())
    }
    pub fn keyboard_map(&self) -> KeyboardMap {
        self.keyboard_map.clone()
    }
    pub fn set_keyboard_map(&mut self, mapping: KeyboardMap) -> Result<(), String> {
        mapping.validate()?;
        atomic(
            &self.root.join("keyboard-map.json"),
            &serde_json::to_vec(&mapping).map_err(|e| e.to_string())?,
        )?;
        self.keyboard_map = mapping;
        Ok(())
    }
    pub fn scroll_speed(&self) -> u16 {
        self.scroll_speed
    }
    pub fn set_scroll_speed(&mut self, percent: u16) -> Result<(), String> {
        if !(50..=200).contains(&percent) {
            return Err("滚轮速度范围为 50% 至 200%".into());
        }
        atomic(
            &self.root.join("scroll-speed.json"),
            &serde_json::to_vec(&percent).map_err(|e| e.to_string())?,
        )?;
        self.scroll_speed = percent;
        Ok(())
    }
    pub fn pointer_speed(&self) -> Option<u16> {
        if cfg!(target_os = "macos") {
            Some(self.pointer_speed)
        } else {
            None
        }
    }
    pub fn set_pointer_speed(&mut self, percent: u16) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Err("当前主控平台尚不支持速度调节".into());
        }
        if !(50..=200).contains(&percent) {
            return Err("速度范围为 50% 至 200%".into());
        }
        atomic(
            &self.root.join("pointer-speed.json"),
            &serde_json::to_vec(&percent).map_err(|e| e.to_string())?,
        )?;
        self.pointer_speed = percent;
        Ok(())
    }
    pub fn connected(&self) -> Option<bool> {
        if self.child.is_none() || !self.running {
            return None;
        }
        *self.connected.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn diagnostics(&self) -> String {
        let bytes = self
            .output
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }
    fn capture(
        mut pipe: impl Read + Send + 'static,
        output: Arc<Mutex<VecDeque<u8>>>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut bytes = [0u8; 1024];
            loop {
                match pipe.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let mut tail = output.lock().unwrap_or_else(|e| e.into_inner());
                        tail.extend(&bytes[..count]);
                        while tail.len() > 8192 {
                            tail.pop_front();
                        }
                    }
                }
            }
        })
    }
    pub fn apply(&mut self, profile: &EngineProfile) -> Result<(), String> {
        let mut adjusted = profile.clone();
        adjusted.scroll_speed = self.scroll_speed;
        if adjusted.role == Role::Source {
            adjusted.keyboard_map = self.keyboard_map.clone();
        }
        let profile = &adjusted;
        profile.validate()?;
        let stamp = fingerprint(&serde_json::to_vec(profile).map_err(|e| e.to_string())?);
        self.view();
        if self.failed.as_ref() == Some(&stamp) {
            return Err(self.message.clone());
        }
        if (self.running || self.child.is_some()) && self.applied.as_ref() == Some(&stamp) {
            return Ok(());
        }
        if !self.binary().is_file() {
            return Err("安装包缺少输入组件，请使用包含流转组件的完整安装包".into());
        }
        #[cfg(target_os = "macos")]
        {
            let version = Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .map_err(|_| "无法检测 macOS 版本".to_string())?;
            let major = String::from_utf8_lossy(&version.stdout)
                .trim()
                .split('.')
                .next()
                .and_then(|s| s.parse::<u32>().ok());
            if !version.status.success() || !matches!(major, Some(14..)) {
                return Err("键鼠流转组件要求 macOS 14 或更新版本".into());
            }
        }
        self.stop()?;
        #[cfg(windows)]
        {
            super::broker_client::apply(profile)?;
        }
        #[cfg(target_os = "macos")]
        {
            // Keep M0's independent software untouched; a separate instance must be stopped by its user.
            if super::ipc::request(super::ipc::Endpoint::Core, super::ipc::Action::Probe).is_ok() {
                return Err("独立 Deskflow 会话仍在运行，请先停止它，再从 WenBox 启动".into());
            }
            let path = render_profile(&self.root, profile)?;
            // Qt derives its single-instance semaphore and local socket from TMPDIR.
            // A private short path avoids stale global Deskflow locks and AF_UNIX path limits.
            let runtime = tempfile::Builder::new()
                .prefix("wb-kvm-")
                .tempdir_in("/tmp")
                .map_err(|e| format!("无法创建输入核心运行目录：{e}"))?;
            // Qt exposes the socket broadly; its parent must remain user-only.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(runtime.path(), std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("无法保护输入核心运行目录：{e}"))?;
            self.output = Arc::new(Mutex::new(VecDeque::new()));
            let mut child = Command::new(self.binary())
                .arg(if profile.role == Role::Source {
                    "server"
                } else {
                    "client"
                })
                .env("TMPDIR", runtime.path())
                .env(
                    "DESKFLOW_MOUSE_ADJUSTMENT",
                    format!("{:.2}", f64::from(self.pointer_speed) / 100.0),
                )
                .arg("--settings")
                .arg(path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|_| "输入组件启动失败，请检查系统权限".to_string())?;
            if let Some(pipe) = child.stdout.take() {
                Self::capture(pipe, self.output.clone());
            }
            if let Some(pipe) = child.stderr.take() {
                Self::capture(pipe, self.output.clone());
            }
            self.connected = Arc::new(Mutex::new(None));
            self.monitor_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            if profile.role == Role::Source {
                super::ipc::monitor(
                    runtime.path().into(),
                    screen(&profile.peer.id)?,
                    self.connected.clone(),
                    self.monitor_stop.clone(),
                );
            }
            self.child = Some(child);
            self.runtime = Some(runtime);
            self.started = Some(Instant::now());
            self.source = profile.role == Role::Source;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            return Err("当前系统不支持输入核心".into());
        }
        self.applied = Some(stamp);
        self.running = cfg!(windows);
        self.message = if cfg!(windows) {
            "输入核心运行中，等待或保持对端连接"
        } else {
            "输入核心启动中，等待就绪"
        }
        .into();
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        self.monitor_stop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.connected.lock().unwrap_or_else(|e| e.into_inner()) = None;
        #[cfg(windows)]
        {
            if self.running {
                super::broker_client::stop()?;
            }
        }
        if let Some(mut child) = self.child.take() {
            // Send a graceful stop only while our owned process is alive.
            if matches!(child.try_wait(), Ok(None)) {
                #[cfg(unix)]
                if let Some(runtime) = &self.runtime {
                    let _ = super::ipc::request_at(runtime.path(), super::ipc::Action::Stop);
                }
            }
            let deadline = Instant::now() + Duration::from_millis(400);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        self.running = false;
        self.runtime = None;
        self.started = None;
        self.failed = None;
        self.applied = None;
        self.message = "流转已停止".into();
        Ok(())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn exited_core_keeps_failure_until_explicit_stop() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = Engine::new(dir.path().into(), dir.path().into());
        let profile = EngineProfile {
            keyboard_map: Default::default(),
            scroll_speed: 100,
            identity: Identity::new().unwrap(),
            peer: Peer {
                id: uuid::Uuid::new_v4().to_string(),
                name: "test".into(),
                platform: "Windows".into(),
                fingerprint: "ab".repeat(32),
                ip: "192.168.1.2".parse().unwrap(),
                local_ip: "192.168.1.1".parse().unwrap(),
            },
            role: Role::Source,
            side: Side::Left,
        };
        engine.keyboard_map = profile.keyboard_map.clone();
        engine.applied = Some(fingerprint(&serde_json::to_vec(&profile).unwrap()));
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 4"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        engine.child = Some(child);
        engine.running = true;
        assert!(!engine.view().1);
        let error = engine.message.clone();
        assert!(error.contains("4"));
        for _ in 0..3 {
            assert_eq!(engine.apply(&profile), Err(error.clone()));
        }
        assert!(engine.child.is_none());
        engine.stop().unwrap();
        assert!(engine.failed.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn speed_preferences_are_bounded_persistent_and_independent() {
        let root = tempfile::tempdir().unwrap();
        let mut engine = Engine::new(root.path().into(), root.path().into());
        assert_eq!(engine.pointer_speed(), Some(100));
        assert_eq!(engine.scroll_speed(), 100);
        engine.set_pointer_speed(150).unwrap();
        engine.set_scroll_speed(75).unwrap();
        engine.set_keyboard_map(KeyboardMap::default()).unwrap();
        for invalid in [0, 49, 201, u16::MAX] {
            assert!(engine.set_pointer_speed(invalid).is_err());
            assert!(engine.set_scroll_speed(invalid).is_err());
        }
        let restored = Engine::new(root.path().into(), root.path().into());
        assert_eq!(restored.pointer_speed(), Some(150));
        assert_eq!(restored.scroll_speed(), 75);
        assert_eq!(restored.keyboard_map(), KeyboardMap::default());
    }

    #[test]
    fn startup_output_is_drained_and_retains_only_a_bounded_tail() {
        let mut bytes = vec![b'x'; 100_000];
        bytes.extend_from_slice(b"assistive devices does not trust this process\n");
        let output = Arc::new(Mutex::new(VecDeque::new()));
        Engine::capture(std::io::Cursor::new(bytes), output.clone())
            .join()
            .unwrap();
        let tail = output.lock().unwrap();
        assert_eq!(tail.len(), 8192);
        assert!(
            String::from_utf8_lossy(&tail.iter().copied().collect::<Vec<_>>())
                .ends_with("assistive devices does not trust this process\n")
        );
    }
}
