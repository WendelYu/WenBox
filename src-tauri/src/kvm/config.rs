//! Read-only, deliberately small subset of the pinned backend's INI settings.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct Profile {
    pub path: PathBuf,
    pub role: &'static str,
    pub tls: bool,
    pub system_input: bool,
}

fn read(path: &Path) -> Result<HashMap<String, String>, String> {
    let file = std::fs::File::open(path)
        .map_err(|_| "未找到已验证的后端配置，请先完成首次设置".to_string())?;
    let mut text = String::new();
    file.take(128 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "后端配置无法读取".to_string())?;
    if text.len() > 128 * 1024 {
        return Err("后端配置过大，请在后端设置中检查".into());
    }
    parse(&text)
}

fn parse(text: &str) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let mut section = String::new();
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with([';', '#']) {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].into();
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let full = format!("{}/{}", section, key.trim());
            if matches!(
                full.as_str(),
                "core/coreMode"
                    | "security/tlsEnabled"
                    | "security/checkPeerFingerprints"
                    | "daemon/elevate"
                    | "daemon/configFile"
                    | "core/enableEnterCommand"
                    | "core/enableExitCommand"
            ) {
                values.insert(full, decode(value.trim())?);
            }
        }
    }
    Ok(values)
}

fn decode(value: &str) -> Result<String, String> {
    if value.starts_with('@') {
        return Err("后端配置使用了暂不支持的编码，请在后端重新保存设置".into());
    }
    let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        value
    };
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            result.push(match chars.next() {
                Some('\\') => '\\',
                Some('"') => '"',
                Some('n') => '\n',
                Some('r') => '\r',
                Some('t') => '\t',
                _ => return Err("后端配置使用了暂不支持的转义，请在后端重新保存设置".into()),
            });
        } else {
            result.push(ch);
        }
    }
    Ok(result)
}

fn flag(values: &HashMap<String, String>, key: &str, default: bool) -> Result<bool, String> {
    match values.get(key).map(String::as_str) {
        None => Ok(default),
        Some("true" | "1") => Ok(true),
        Some("false" | "0") => Ok(false),
        _ => Err("后端配置中的开关值无效，请检查后端设置".into()),
    }
}

fn inspect(path: PathBuf, windows: bool) -> Result<Profile, String> {
    let values = read(&path)?;
    let role = match values.get("core/coreMode").map(String::as_str) {
        Some("2") => "source",
        Some("1") => "target",
        _ => return Err("请先在后端选择使用本机键鼠或接收对端输入".into()),
    };
    let tls = flag(&values, "security/tlsEnabled", true)?
        && flag(&values, "security/checkPeerFingerprints", true)?;
    if !tls {
        return Err("请在后端开启加密和对端证书验证，再启用流转".into());
    }
    if flag(&values, "core/enableEnterCommand", false)?
        || flag(&values, "core/enableExitCommand", false)?
    {
        return Err("请关闭后端的进入/离开屏幕执行命令功能，再启用流转".into());
    }
    let system_input = windows && flag(&values, "daemon/elevate", true)?;
    if windows && !system_input {
        return Err("请在后端开启 system 模式，以支持管理员窗口和 UAC".into());
    }
    Ok(Profile {
        path,
        role,
        tls,
        system_input,
    })
}

pub fn load() -> Result<Profile, String> {
    #[cfg(target_os = "macos")]
    {
        inspect(
            dirs_next::home_dir()
                .ok_or("无法定位用户目录")?
                .join("Library/Deskflow/Deskflow.conf"),
            false,
        )
    }
    #[cfg(windows)]
    {
        let system = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .ok_or("无法定位后台服务配置")?
            .join("Deskflow/Deskflow.conf");
        let values = read(&system)?;
        let persisted = values
            .get("daemon/configFile")
            .ok_or("请先在后端点击一次启动，保存后台服务配置")?;
        if persisted.starts_with(['\\', '/']) || persisted.contains(['\n', '\r', '\0']) {
            return Err("不支持远程或无效的后台服务配置路径".into());
        }
        let requested =
            std::fs::canonicalize(persisted).map_err(|_| "后台服务保存的配置不存在".to_string())?;
        let user = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Deskflow/Deskflow.conf"));
        let allowed = std::iter::once(system)
            .chain(user)
            .any(|p| std::fs::canonicalize(p).ok().as_ref() == Some(&requested));
        if !allowed {
            return Err("后台服务配置不在标准安装目录，请先使用后端标准配置".into());
        }
        inspect(requested, true)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("流转当前仅支持 Windows 和 macOS 桌面客户端".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn security_flags_are_not_confused_by_comments_or_other_sections() {
        let v = parse("[security]\ntlsEnabled=false\ncheckPeerFingerprints=true\n;tlsEnabled=true\n[other]\ntlsEnabled=true\n").unwrap();
        assert!(!flag(&v, "security/tlsEnabled", true).unwrap());
        assert!(flag(&v, "security/checkPeerFingerprints", true).unwrap());
        assert!(parse("[security]\ntlsEnabled=@Variant(bad)\n").is_err());
    }
    #[test]
    fn qt_escaped_path_and_unknown_boolean_fail_closed() {
        assert_eq!(
            decode(r"C:\\Users\\Wen\\Deskflow.conf").unwrap(),
            r"C:\Users\Wen\Deskflow.conf"
        );
        let v = parse("[daemon]\nelevate=maybe\n").unwrap();
        assert!(flag(&v, "daemon/elevate", true).is_err());
    }
    #[test]
    fn disabled_tls_and_screen_commands_block_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.conf");
        for extra in [
            "[security]\ntlsEnabled=false\n",
            "[core]\nenableEnterCommand=true\n",
            "[daemon]\nelevate=false\n",
        ] {
            std::fs::write(&path, format!("[core]\ncoreMode=1\n{extra}")).unwrap();
            assert!(inspect(path.clone(), true).is_err());
        }
        std::fs::write(
            &path,
            "[core]\ncoreMode=1\n[security]\ntlsEnabled=true\ncheckPeerFingerprints=true\n",
        )
        .unwrap();
        assert!(inspect(path, true).unwrap().system_input);
    }
}
