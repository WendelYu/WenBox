//! In-app GitHub Releases updater with SHA-256 verification and quarantine-free atomic swap.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

const REPO_OWNER: &str = "WendelYu";
const REPO_NAME: &str = "WenBox";
const RELEASES_API: &str = "https://api.github.com/repos/WendelYu/WenBox/releases/latest";
pub const RELEASES_PAGE: &str = "https://github.com/WendelYu/WenBox/releases";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct GitHubAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: u64,
    pub checksum_url: Option<String>,
    pub can_auto_install: bool,
    pub install_hint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
    pub app_path: String,
    pub is_portable: bool,
    pub repo_url: String,
    pub can_auto_install: bool,
    pub install_hint: String,
}

fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn platform_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "Linux"
    }
}

pub fn data_dir_path() -> PathBuf {
    dirs_next::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("WenBox")
}

pub fn compare_semver(a: &str, b: &str) -> Ordering {
    let parse = |raw: &str| -> Vec<u64> {
        let trimmed = raw.trim().trim_start_matches(['v', 'V']);
        let core = trimmed.split(['-', '+']).next().unwrap_or("");
        core.split('.')
            .filter(|part| !part.is_empty())
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    let max_len = va.len().max(vb.len());
    for i in 0..max_len {
        let pa = *va.get(i).unwrap_or(&0);
        let pb = *vb.get(i).unwrap_or(&0);
        match pa.cmp(&pb) {
            Ordering::Equal => continue,
            ord => return ord,
        }
    }
    Ordering::Equal
}

pub fn validate_github_asset_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("下载地址无效: {e}"))?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("只允许从 GitHub HTTPS 下载更新包".into());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let allowed = host == "github.com"
        || host == "api.github.com"
        || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com"
        || host.ends_with(".githubusercontent.com");
    if !allowed {
        return Err(format!("拒绝从非 GitHub 域名下载更新: {host}"));
    }
    Ok(parsed)
}

pub fn parse_sha256_sums(text: &str, asset_name: &str) -> Option<String> {
    let target = asset_name.trim();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(digest) = parts.next() else { continue };
        let Some(file) = parts.next() else { continue };
        let clean_file = file.trim_start_matches('*');
        if (clean_file == target || clean_file.ends_with(&format!("/{target}")))
            && digest.len() == 64
            && digest.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Some(digest.to_ascii_lowercase());
        }
    }
    None
}

pub fn select_release_asset(
    assets: &[GitHubAsset],
    os: &str,
    portable: bool,
) -> (Option<GitHubAsset>, Option<GitHubAsset>) {
    match os {
        "macos" => {
            let pkg = assets
                .iter()
                .find(|a| a.name.starts_with("WenBox-macOS-") && a.name.ends_with("-universal.zip"))
                .cloned();
            let sum = assets
                .iter()
                .find(|a| a.name.starts_with("SHA256SUMS-macOS-") && a.name.ends_with(".txt"))
                .cloned();
            (pkg, sum)
        }
        "windows" => {
            let pkg = if portable {
                assets
                    .iter()
                    .find(|a| a.name.starts_with("WenBox-Windows-") && a.name.contains("Portable") && a.name.ends_with(".exe"))
                    .cloned()
            } else {
                assets
                    .iter()
                    .find(|a| a.name.starts_with("WenBox-Windows-") && a.name.contains("Installer") && a.name.ends_with(".exe"))
                    .cloned()
            };
            (pkg, None)
        }
        _ => (None, None),
    }
}

pub fn resolve_macos_app_bundle(exe: &Path) -> Result<PathBuf, String> {
    let app_bundle = exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .map(Path::to_path_buf);
    let Some(bundle) = app_bundle else {
        return Err("当前为开发运行模式，请打包安装后再使用应用内自动更新".into());
    };
    if bundle.starts_with("/Volumes/") {
        return Err("检测到正从 DMG 镜像运行，请先将 WenBox.app 拖入「应用程序」后再使用自动更新".into());
    }
    Ok(bundle)
}

fn auto_install_capability() -> (bool, String, String) {
    match current_os() {
        "macos" => match std::env::current_exe() {
            Ok(exe) => match resolve_macos_app_bundle(&exe) {
                Ok(bundle) => (true, bundle.to_string_lossy().into_owned(), String::new()),
                Err(hint) => (false, exe.to_string_lossy().into_owned(), hint),
            },
            Err(_) => (false, String::new(), "无法定位当前应用程序路径".into()),
        },
        "windows" => match std::env::current_exe() {
            Ok(exe) => (true, exe.to_string_lossy().into_owned(), String::new()),
            Err(_) => (false, String::new(), "无法定位当前可执行文件路径".into()),
        },
        _ => (
            false,
            std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            "当前系统暂不支持应用内自动更新，请前往 GitHub Releases 下载".into(),
        ),
    }
}

fn github_client(timeout_secs: Option<u64>) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .redirects(5)
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(60));
    if let Some(total) = timeout_secs {
        builder = builder.timeout(Duration::from_secs(total));
    }
    builder.build()
}

#[tauri::command]
pub fn get_app_runtime_info_cmd() -> Result<AppRuntimeInfo, String> {
    let (can_auto_install, app_path, install_hint) = auto_install_capability();
    Ok(AppRuntimeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: platform_label().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: data_dir_path().to_string_lossy().into_owned(),
        app_path,
        is_portable: cfg!(feature = "portable"),
        repo_url: RELEASES_PAGE.to_string(),
        can_auto_install,
        install_hint,
    })
}

#[tauri::command]
pub fn open_data_dir_cmd() -> Result<(), String> {
    let dir = data_dir_path();
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法访问数据目录: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开访达: {e}"))?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
    }
    Ok(())
}

fn check_release_blocking() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let user_agent = format!("{REPO_NAME}/{current}");
    let resp = github_client(Some(12))
        .get(RELEASES_API)
        .set("User-Agent", &user_agent)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("检查更新失败，请检查网络连接: {e}"))?;

    let release: GitHubRelease = resp
        .into_json()
        .map_err(|e| format!("解析发布信息失败: {e}"))?;
    let latest = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    if latest.is_empty() {
        return Err("GitHub Release 版本号为空".into());
    }
    let has_update = compare_semver(&latest, &current) == Ordering::Greater;
    let (pkg_asset, checksum_asset) =
        select_release_asset(&release.assets, current_os(), cfg!(feature = "portable"));
    let (can_auto_install, _app_path, mut install_hint) = auto_install_capability();
    let can_install_now = can_auto_install && pkg_asset.is_some();
    if can_auto_install && pkg_asset.is_none() {
        install_hint = "最新 Release 暂未包含当前平台的安装包，请稍后再试或前往 Releases 查看".into();
    }

    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        has_update,
        release_url: if release.html_url.is_empty() {
            format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases")
        } else {
            release.html_url
        },
        release_notes: release.body.trim().to_string(),
        published_at: release.published_at,
        asset_name: pkg_asset.as_ref().map(|a| a.name.clone()),
        asset_url: pkg_asset.as_ref().map(|a| a.browser_download_url.clone()),
        asset_size: pkg_asset.as_ref().map(|a| a.size).unwrap_or(0),
        checksum_url: checksum_asset.map(|a| a.browser_download_url),
        can_auto_install: can_install_now,
        install_hint,
    })
}

#[tauri::command]
pub async fn updater_check_cmd() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(check_release_blocking)
        .await
        .map_err(|e| format!("检查更新任务异常: {e}"))?
}

fn emit_progress(
    window: &tauri::Window,
    stage: &str,
    loaded: u64,
    total: u64,
    message: &str,
) {
    let _ = window.emit(
        "updater-progress",
        serde_json::json!({
            "stage": stage,
            "loaded": loaded,
            "total": total,
            "message": message,
        }),
    );
}

#[cfg(target_os = "macos")]
fn shell_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    format!("'{}'", raw.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn dir_writable(dir: &Path) -> bool {
    tempfile::NamedTempFile::new_in(dir).is_ok()
}

#[cfg(target_os = "macos")]
fn stage_and_apply_macos(
    zip_path: &Path,
    stage_dir: &Path,
    target_app: &Path,
) -> Result<(), String> {
    let extract_dir = stage_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("创建解压目录失败: {e}"))?;

    let status = std::process::Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip_path)
        .arg(&extract_dir)
        .status()
        .map_err(|e| format!("调用 ditto 解压失败: {e}"))?;
    if !status.success() {
        return Err("解压更新包失败".into());
    }

    let mut staged_app = extract_dir.join("WenBox.app");
    if !staged_app.is_dir() {
        staged_app = std::fs::read_dir(&extract_dir)
            .map_err(|e| format!("读取解压目录失败: {e}"))?
            .filter_map(|e| e.ok().map(|entry| entry.path()))
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
            .ok_or_else(|| "更新压缩包中缺少 WenBox.app".to_string())?;
    }
    if !staged_app.join("Contents/MacOS/WenBox").is_file() {
        return Err("更新包中的应用结构不完整".into());
    }

    // Clear quarantine proactively on the staged app before moving into /Applications.
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(&staged_app)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let backup_app = stage_dir.join("WenBox.backup.app");
    let pid = std::process::id();
    let parent_dir = target_app
        .parent()
        .ok_or_else(|| "无法识别应用安装目录".to_string())?;
    let writable = dir_writable(parent_dir);

    let swap_cmd = format!(
        "rm -rf {bak}; if [ -e {dst} ]; then mv {dst} {bak}; fi; if mv {src} {dst}; then /usr/bin/xattr -dr com.apple.quarantine {dst} >/dev/null 2>&1 || true; rm -rf {bak}; else if [ -e {bak} ] && [ ! -e {dst} ]; then mv {bak} {dst}; fi; exit 1; fi",
        src = shell_quote(&staged_app),
        dst = shell_quote(target_app),
        bak = shell_quote(&backup_app),
    );

    let apply_block = if writable {
        swap_cmd
    } else {
        let escaped_for_applescript = swap_cmd.replace('\\', "\\\\").replace('"', "\\\"");
        format!("/usr/bin/osascript -e \"do shell script \\\"{escaped_for_applescript}\\\" with administrator privileges\"")
    };

    let script = format!(
        "#!/bin/sh\nOLD_PID={pid}\nWAITED=0\nwhile /bin/kill -0 \"$OLD_PID\" >/dev/null 2>&1; do\n  WAITED=$((WAITED + 1))\n  if [ \"$WAITED\" -ge 150 ]; then break; fi\n  /bin/sleep 0.1\ndone\n{apply_block}\n/usr/bin/open -n {dst} >/dev/null 2>&1 &\nrm -rf {stage}\n",
        dst = shell_quote(target_app),
        stage = shell_quote(stage_dir),
    );

    let script_path = stage_dir.join("apply-update.sh");
    std::fs::write(&script_path, script).map_err(|e| format!("生成更新脚本失败: {e}"))?;

    std::process::Command::new("/bin/sh")
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动更新安装器失败: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn stage_and_apply_windows(
    downloaded: &Path,
    stage_dir: &Path,
    portable: bool,
) -> Result<(), String> {
    if portable {
        let current_exe = std::env::current_exe().map_err(|e| format!("无法获取程序路径: {e}"))?;
        let pid = std::process::id();
        let src = downloaded.to_string_lossy();
        let dst = current_exe.to_string_lossy();
        let stage = stage_dir.to_string_lossy();
        let cmd_script = format!(
            "@echo off\r\n\
             setlocal\r\n\
             for /L %%i in (1,1,60) do (\r\n\
               tasklist /FI \"PID eq {pid}\" 2>NUL | find /I \"{pid}\" >NUL || goto replace\r\n\
               ping -n 2 127.0.0.1 >NUL\r\n\
             )\r\n\
             :replace\r\n\
             move /Y \"{src}\" \"{dst}\" >NUL 2>&1\r\n\
             if errorlevel 1 copy /Y \"{src}\" \"{dst}\" >NUL 2>&1\r\n\
             start \"\" \"{dst}\"\r\n\
             rmdir /S /Q \"{stage}\" >NUL 2>&1\r\n"
        );
        let script_path = stage_dir.join("apply-update.cmd");
        std::fs::write(&script_path, cmd_script).map_err(|e| format!("生成更新脚本失败: {e}"))?;
        std::process::Command::new("cmd")
            .args(["/C", &script_path.to_string_lossy()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动便携版更新器失败: {e}"))?;
    } else {
        std::process::Command::new(downloaded)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn updater_install_cmd(
    window: tauri::Window,
    app: tauri::AppHandle,
    asset_url: String,
    asset_name: String,
    checksum_url: Option<String>,
    state: tauri::State<'_, Arc<crate::AppState>>,
) -> Result<(), String> {
    let clean_name = crate::sanitize_file_name(&asset_name);
    if clean_name.is_empty() {
        return Err("更新包文件名无效".into());
    }
    let validated_asset = validate_github_asset_url(&asset_url)?;
    let validated_checksum = match checksum_url.filter(|s| !s.trim().is_empty()) {
        Some(url) => Some(validate_github_asset_url(&url)?),
        None => None,
    };

    #[cfg(target_os = "macos")]
    let target_app = resolve_macos_app_bundle(
        &std::env::current_exe().map_err(|e| format!("无法获取应用路径: {e}"))?,
    )?;

    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("当前操作系统暂不支持应用内自动更新".into());

    let state = state.inner().clone();
    let window_clone = window.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let stage_dir = std::env::temp_dir().join(format!("wenbox-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&stage_dir).map_err(|e| format!("创建临时更新目录失败: {e}"))?;
        let download_path = stage_dir.join(&clean_name);

        let work = (|| -> Result<(), String> {
            let ua = format!("{REPO_NAME}/{}", env!("CARGO_PKG_VERSION"));
            emit_progress(&window_clone, "downloading", 0, 0, "正在连接 GitHub 下载更新包…");

            let resp = github_client(None)
                .get(validated_asset.as_str())
                .set("User-Agent", &ua)
                .call()
                .map_err(|e| format!("下载更新包失败: {e}"))?;
            let _ = validate_github_asset_url(resp.get_url())?;

            let total = resp
                .header("Content-Length")
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0);

            let out_file = std::fs::File::create(&download_path)
                .map_err(|e| format!("创建更新文件失败: {e}"))?;
            let mut writer = std::io::BufWriter::with_capacity(256 * 1024, out_file);
            let mut reader = resp.into_reader();
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 256 * 1024];
            let mut loaded: u64 = 0;
            let mut last_emit = Instant::now();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        writer
                            .write_all(&buf[..n])
                            .map_err(|e| format!("写入更新包失败: {e}"))?;
                        hasher.update(&buf[..n]);
                        loaded = loaded.saturating_add(n as u64);
                        if last_emit.elapsed() >= Duration::from_millis(120) {
                            emit_progress(&window_clone, "downloading", loaded, total, "正在下载更新包…");
                            last_emit = Instant::now();
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(format!("读取更新数据流失败: {e}")),
                }
            }
            writer
                .flush()
                .map_err(|e| format!("刷新更新文件缓冲失败: {e}"))?;
            drop(writer);
            emit_progress(
                &window_clone,
                "downloading",
                loaded,
                total.max(loaded),
                "更新包下载完成",
            );

            if let Some(sum_url) = validated_checksum {
                emit_progress(
                    &window_clone,
                    "verifying",
                    loaded,
                    total.max(loaded),
                    "正在校验 SHA-256 完整性…",
                );
                let sum_resp = github_client(Some(15))
                    .get(sum_url.as_str())
                    .set("User-Agent", &ua)
                    .call()
                    .map_err(|e| format!("获取校验文件失败: {e}"))?;
                let _ = validate_github_asset_url(sum_resp.get_url())?;
                let sum_text = sum_resp
                    .into_string()
                    .map_err(|e| format!("读取校验文件失败: {e}"))?;
                let expected = parse_sha256_sums(&sum_text, &clean_name)
                    .ok_or_else(|| format!("校验文件中未找到 {clean_name} 的摘要"))?;
                let actual = format!("{:x}", hasher.finalize());
                if actual != expected {
                    return Err(format!(
                        "更新包 SHA-256 校验未通过（期望 {expected}，实际 {actual}）"
                    ));
                }
            }

            emit_progress(
                &window_clone,
                "installing",
                loaded,
                total.max(loaded),
                "正在安装新版本并准备重启…",
            );

            #[cfg(target_os = "macos")]
            stage_and_apply_macos(&download_path, &stage_dir, &target_app)?;

            #[cfg(windows)]
            stage_and_apply_windows(&download_path, &stage_dir, cfg!(feature = "portable"))?;

            Ok(())
        })();

        if let Err(err) = work {
            let _ = std::fs::remove_dir_all(&stage_dir);
            return Err(err);
        }

        emit_progress(&window_clone, "restarting", 1, 1, "正在重启 WenBox 完成更新…");
        let _ = crate::close_default_room_if_active(&state);
        #[cfg(not(feature = "portable"))]
        crate::kvm::shutdown();
        std::thread::sleep(Duration::from_millis(120));
        app.exit(0);
        Ok(())
    })
    .await
    .map_err(|e| format!("安装更新任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_semver_handles_multi_digit_and_v_prefix() {
        assert_eq!(compare_semver("v1.4.18", "1.4.18"), Ordering::Equal);
        assert_eq!(compare_semver("v1.4.19", "1.4.18"), Ordering::Greater);
        assert_eq!(compare_semver("1.4.10", "1.4.9"), Ordering::Greater);
        assert_eq!(compare_semver("1.4.18-beta.1", "1.4.18"), Ordering::Equal);
        assert_eq!(compare_semver("1.4.17", "1.4.18"), Ordering::Less);
    }

    #[test]
    fn validate_github_asset_url_enforces_https_and_github_hosts() {
        assert!(validate_github_asset_url(
            "https://github.com/WendelYu/WenBox/releases/download/v1.4.18/WenBox.zip"
        )
        .is_ok());
        assert!(validate_github_asset_url(
            "https://objects.githubusercontent.com/github-production-release-asset/123"
        )
        .is_ok());
        assert!(validate_github_asset_url("http://github.com/foo").is_err());
        assert!(validate_github_asset_url("https://evil.example.com/WenBox.zip").is_err());
    }

    #[test]
    fn parse_sha256_sums_matches_exact_asset_name() {
        let sum_a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let sum_b = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        let text = format!("{sum_a}  WenBox-macOS-v1.4.18-universal.dmg\n{sum_b} *WenBox-macOS-v1.4.18-universal.zip\n");
        assert_eq!(
            parse_sha256_sums(&text, "WenBox-macOS-v1.4.18-universal.zip").as_deref(),
            Some(sum_b)
        );
        assert_eq!(parse_sha256_sums(&text, "missing.zip"), None);
    }

    #[test]
    fn select_release_asset_picks_expected_platform_package() {
        let assets = vec![
            GitHubAsset {
                name: "WenBox-macOS-v1.4.18-universal.dmg".into(),
                browser_download_url: "https://github.com/a/dmg".into(),
                size: 100,
            },
            GitHubAsset {
                name: "WenBox-macOS-v1.4.18-universal.zip".into(),
                browser_download_url: "https://github.com/a/zip".into(),
                size: 90,
            },
            GitHubAsset {
                name: "SHA256SUMS-macOS-v1.4.18.txt".into(),
                browser_download_url: "https://github.com/a/sha".into(),
                size: 1,
            },
            GitHubAsset {
                name: "WenBox-Windows-v1.4.18-Installer.exe".into(),
                browser_download_url: "https://github.com/a/inst".into(),
                size: 80,
            },
            GitHubAsset {
                name: "WenBox-Windows-v1.4.18-Portable-x64.exe".into(),
                browser_download_url: "https://github.com/a/port".into(),
                size: 70,
            },
        ];
        let (mac_pkg, mac_sum) = select_release_asset(&assets, "macos", false);
        assert_eq!(mac_pkg.unwrap().name, "WenBox-macOS-v1.4.18-universal.zip");
        assert_eq!(mac_sum.unwrap().name, "SHA256SUMS-macOS-v1.4.18.txt");

        let (win_inst, _) = select_release_asset(&assets, "windows", false);
        assert_eq!(win_inst.unwrap().name, "WenBox-Windows-v1.4.18-Installer.exe");

        let (win_port, _) = select_release_asset(&assets, "windows", true);
        assert_eq!(win_port.unwrap().name, "WenBox-Windows-v1.4.18-Portable-x64.exe");
    }

    #[test]
    fn resolve_macos_app_bundle_rejects_dmg_and_dev_mode() {
        assert_eq!(
            resolve_macos_app_bundle(Path::new("/Applications/WenBox.app/Contents/MacOS/WenBox"))
                .unwrap(),
            PathBuf::from("/Applications/WenBox.app")
        );
        assert!(resolve_macos_app_bundle(Path::new("/Volumes/WenBox/WenBox.app/Contents/MacOS/WenBox")).is_err());
        assert!(resolve_macos_app_bundle(Path::new("/Users/dev/target/debug/wenbox")).is_err());
    }
}
