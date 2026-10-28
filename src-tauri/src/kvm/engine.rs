use super::model::*;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
pub struct Engine {
    root: PathBuf,
    resources: PathBuf,
    child: Option<Child>,
    applied: Option<String>,
    running: bool,
    message: String,
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
            if let Ok(Some(_)) = c.try_wait() {
                self.child = None;
                self.running = false;
                self.applied = None;
                self.message = "输入核心已退出，请检查系统权限或诊断信息".into();
            }
        }
        (self.binary().is_file(), self.running, self.message.clone())
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
            let child = Command::new(self.binary())
                .arg(if profile.role == Role::Source {
                    "server"
                } else {
                    "client"
                })
                .arg("--settings")
                .arg(path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "输入组件启动失败，请检查系统权限".to_string())?;
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
