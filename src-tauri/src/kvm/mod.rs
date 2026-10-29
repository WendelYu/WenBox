//! WenBox-managed device pairing and a separately packaged input core.
#[cfg(windows)]
mod broker_client;
#[cfg(any(windows, test))]
mod broker_protocol;
#[cfg(test)]
mod config;
mod engine;
mod identity;
mod ipc;
mod managed;
mod model;
mod tls; // Preserve the M1 security regression cases during migration.
use managed::{Candidate, Info, Managed, View};
use model::{Role, Side};
use serde::Serialize;
use std::{
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, OnceLock},
};
static MANAGED: OnceLock<Arc<Managed>> = OnceLock::new();
static INIT_ERROR: OnceLock<String> = OnceLock::new();
pub fn initialization_failed(error: String) {
    let _ = INIT_ERROR.set(error);
}
pub fn initialize(
    root: PathBuf,
    resources: PathBuf,
    state: Arc<crate::AppState>,
) -> Result<(), String> {
    let candidates = Arc::new(move || {
        let mut ips = state
            .devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|p| p.ip.parse::<Ipv4Addr>().ok())
            .collect::<Vec<_>>();
        ips.extend(
            state
                .members
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .filter_map(|p| p.ip.parse::<Ipv4Addr>().ok()),
        );
        ips
    });
    let resources = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    } else {
        resources
    };
    let managed = Managed::open(root, resources, candidates)?;
    MANAGED
        .set(managed)
        .map_err(|_| "流转模块已初始化".to_string())
}
fn manager() -> Result<&'static Arc<Managed>, String> {
    MANAGED.get().ok_or_else(|| {
        INIT_ERROR
            .get()
            .cloned()
            .unwrap_or("流转模块未初始化，请重新启动应用".into())
    })
}
pub fn public_info() -> Option<Info> {
    MANAGED.get().map(|m| m.info())
}
pub fn shutdown() {
    if let Some(m) = MANAGED.get() {
        m.shutdown();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Permissions {
    accessibility: bool,
    input_monitoring: bool,
}
fn permissions() -> Option<Permissions> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightListenEventAccess() -> bool;
        }
        // Read-only preflight: polling must never trigger permission dialogs.
        Some(unsafe {
            Permissions {
                accessibility: AXIsProcessTrusted(),
                input_monitoring: CGPreflightListenEventAccess(),
            }
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    scroll_speed: Option<u16>,
    pointer_speed: Option<u16>,
    input_connected: Option<bool>,
    permissions: Option<Permissions>,
    platform: String,
    installed: bool,
    backend_running: bool,
    engine_diagnostics: String,
    service_ready: bool,
    service_error: Option<String>,
    kvm_revision: &'static str,
    profile_ready: bool,
    role: Option<Role>,
    tls_configured: bool,
    system_input: bool,
    message: String,
    events: Vec<managed::Event>,
    managed: View,
}
fn status() -> Result<Status, String> {
    let m = manager()?;
    let view = m.view();
    let (installed, running, message) = m.engine_view();
    #[cfg(windows)]
    let service_result = broker_client::running();
    #[cfg(not(windows))]
    let service_result: Result<bool, String> = Ok(false);
    let service = cfg!(windows) && service_result.is_ok();
    let service_error = service_result.err();
    let note = if !installed {
        "当前安装包缺少流转组件，请使用完整安装包".into()
    } else if !view.enabled {
        "流转已关闭".into()
    } else if view.pending.is_some() {
        "请核对两端显示的验证码，分别确认授权".into()
    } else if let Some(e) = &view.error {
        e.clone()
    } else if view.peer.is_none() {
        "打开配对窗口，选择局域网内的另一台电脑".into()
    } else {
        message
    };
    Ok(Status {
        scroll_speed: m.scroll_speed(),
        pointer_speed: m.pointer_speed(),
        input_connected: m.input_connected(),
        permissions: permissions(),
        platform: view.local.platform.clone(),
        installed,
        backend_running: running,
        engine_diagnostics: m.engine_diagnostics(),
        service_ready: service,
        service_error,
        kvm_revision: "m2.5",
        profile_ready: view.peer.is_some(),
        role: Some(view.local.role),
        tls_configured: true,
        system_input: cfg!(windows) && service,
        message: note,
        events: m.events(),
        managed: view,
    })
}
fn allowed_window(label: &str, url: &url::Url) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
}
fn local(window: &tauri::Window) -> Result<(), String> {
    if allowed_window(window.label(), &window.url()) {
        Ok(())
    } else {
        Err("流转控制仅允许本机桌面主窗口使用".into())
    }
}
#[tauri::command]
pub async fn kvm_status(window: tauri::Window) -> Result<Status, String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_start(window: tauri::Window) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(|| manager()?.enable(true))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_stop(window: tauri::Window) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(|| manager()?.enable(false))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_pairing_window(window: tauri::Window) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(|| manager()?.pairing_window())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_discover(window: tauri::Window) -> Result<Vec<Candidate>, String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(|| Ok(manager()?.discover()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_pair(window: tauri::Window, ip: String) -> Result<(), String> {
    local(&window)?;
    let ip = ip
        .parse::<Ipv4Addr>()
        .map_err(|_| "请输入局域网 IPv4 地址")?;
    tauri::async_runtime::spawn_blocking(move || manager()?.pair(ip))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_confirm(
    window: tauri::Window,
    session: String,
    accept: bool,
) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || manager()?.confirm(&session, accept))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_forget(window: tauri::Window) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(|| manager()?.forget())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_layout(window: tauri::Window, side: Side) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || manager()?.layout(side))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_role(window: tauri::Window, role: Role) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || manager()?.role(role))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_scroll_speed(window: tauri::Window, percent: u16) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || manager()?.set_scroll_speed(percent))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kvm_pointer_speed(window: tauri::Window, percent: u16) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || manager()?.set_pointer_speed(percent))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn kvm_open_settings(window: tauri::Window, pane: Option<String>) -> Result<(), String> {
    local(&window)?;
    let pane = pane.as_deref().unwrap_or("accessibility");
    if !matches!(pane, "accessibility" | "input-monitoring" | "reveal-app") {
        return Err("未知的权限页面".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/bin/open");
        if pane == "reveal-app" {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let app = exe
                .ancestors()
                .nth(3)
                .filter(|p| p.extension().is_some_and(|e| e == "app"))
                .ok_or("请先将 WenBox 安装到应用程序文件夹")?;
            command.arg("-R").arg(app);
        } else {
            command.arg(if pane == "input-monitoring" {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            } else {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            });
        }
        command.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_pages_cannot_control_backend() {
        for url in [
            "http://127.0.0.1:9527/",
            "http://192.168.1.1:9527/",
            "https://tauri.localhost.evil/",
        ] {
            assert!(!allowed_window("main", &url::Url::parse(url).unwrap()))
        }
        assert!(allowed_window(
            "main",
            &url::Url::parse("tauri://localhost/").unwrap()
        ));
    }
}
