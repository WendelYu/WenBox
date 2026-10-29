//! Native dependency guidance before creating any WebView windows.
use std::{os::windows::process::CommandExt, process::Command};
const DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";
pub fn ensure_available() -> bool {
    let key = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let available = ["HKLM", "HKCU"].iter().any(|hive| {
        ["32", "64"].iter().any(|view| {
            Command::new("reg.exe")
                .args([
                    "query",
                    &format!("{hive}\\{key}"),
                    "/v",
                    "pv",
                    &format!("/reg:{view}"),
                ])
                .creation_flags(0x08000000)
                .output()
                .ok()
                .is_some_and(|o| {
                    o.status.success()
                        && String::from_utf8_lossy(&o.stdout)
                            .split_whitespace()
                            .any(|v| {
                                v != "0.0.0.0"
                                    && v.split('.').count() == 4
                                    && v.split('.').all(|x| x.parse::<u32>().is_ok())
                            })
                })
        })
    });
    if available {
        return true;
    }
    use tauri::api::dialog::{
        blocking::MessageDialogBuilder, MessageDialogButtons, MessageDialogKind,
    };
    if MessageDialogBuilder::new("需要安装 WebView2 运行库", "WenBox 需要 Microsoft Edge WebView2 才能显示界面。安装包未包含该运行库。\n\n请从微软官网下载并安装 Evergreen x64 运行库，完成后重新打开 WenBox。\n\n现在打开官方下载页面？")
        .kind(MessageDialogKind::Info).buttons(MessageDialogButtons::YesNo).show() {
        let _ = Command::new("explorer.exe").arg(DOWNLOAD).spawn();
    }
    false
}
