use super::model::EngineProfile;
use serde::{Deserialize, Serialize};
pub const SERVICE: &str = "WenBoxKvm";
pub const PIPE: &str = r"\\.\pipe\WenBox.Kvm.v1";
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "profile",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Apply(EngineProfile),
    Stop,
    Status,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub ok: bool,
    pub running: bool,
    pub error: Option<String>,
}
pub fn read_line<T: std::io::Read>(file: &mut T) -> Result<Vec<u8>, String> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut result = vec![];
    loop {
        if result.len() > 32768 || std::time::Instant::now() > until {
            return Err("输入服务响应超时或消息过大".into());
        }
        let mut b = [0];
        match file.read(&mut b) {
            Ok(0) => return Err("输入服务已断开".into()),
            Ok(_) => {
                if b[0] == b'\n' {
                    return Ok(result);
                }
                result.push(b[0]);
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock || e.raw_os_error() == Some(232) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(_) => return Err("输入服务通信失败".into()),
        }
    }
}
#[cfg(windows)]
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_commands_and_paths_are_not_service_operations() {
        for bad in [
            r#"{"action":"exec","command":"cmd.exe"}"#,
            r#"{"action":"stop","path":"C:/x"}"#,
            r#"{"action":"status","profile":{}}"#,
        ] {
            assert!(serde_json::from_str::<Request>(bad).is_err());
        }
    }
    #[test]
    fn oversized_or_incomplete_pipe_messages_fail_closed() {
        let mut cursor = std::io::Cursor::new(vec![b'x'; 32770]);
        assert!(read_line(&mut cursor).is_err());
        assert!(read_line(&mut std::io::Cursor::new(b"{\"action\":\"stop\"}".to_vec())).is_err());
    }
}
