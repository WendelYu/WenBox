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
}
impl Engine {
    pub fn new(root: PathBuf, resources: PathBuf) -> Self {
        Self {
            root,
            resources,
            child: None,
            applied: None,
            running: false,
            message: "尚未启用流转".into(),
            output: Arc::new(Mutex::new(VecDeque::new())),
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
                self.applied = None;
                let detail = self.diagnostics();
                self.message = if detail.contains("assistive devices does not trust")
                    || detail.contains("process is not trusted")
                {
                    "macOS 辅助功能权限未授权，请在系统设置中允许 WenBox / WenBox Input，然后重启应用".into()
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
        (self.binary().is_file(), self.running, self.message.clone())
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
        profile.validate()?;
        let stamp = fingerprint(&serde_json::to_vec(profile).map_err(|e| e.to_string())?);
        self.view();
        if self.running && self.applied.as_ref() == Some(&stamp) {
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
            self.output = Arc::new(Mutex::new(VecDeque::new()));
            let mut child = Command::new(self.binary())
                .arg(if profile.role == Role::Source {
                    "server"
                } else {
                    "client"
                })
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
            self.child = Some(child);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            return Err("当前系统不支持输入核心".into());
        }
        self.applied = Some(stamp);
        self.running = true;
        self.message = "输入核心运行中，等待或保持对端连接".into();
        Ok(())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if self.running {
                super::broker_client::stop()?;
            }
        }
        if let Some(mut child) = self.child.take() {
            // Send a graceful stop only while our owned process is alive.
            if matches!(child.try_wait(), Ok(None)) {
                let _ = super::ipc::request(super::ipc::Endpoint::Core, super::ipc::Action::Stop);
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
