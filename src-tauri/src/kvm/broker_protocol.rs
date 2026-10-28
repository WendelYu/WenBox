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
// A byte-mode named pipe discards unread output on DisconnectNamedPipe.
// Wait for the client to consume a complete reply before disconnecting; both
// endpoints use nonblocking IO and the same bounded read deadline.
pub fn send_reply<T: std::io::Read + std::io::Write>(
    file: &mut T,
    reply: &Reply,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(reply).map_err(|_| "输入服务响应编码失败")?;
    bytes.push(b'\n');
    file.write_all(&bytes).map_err(|_| "输入服务响应发送失败")?;
    if !read_line(file)?.is_empty() {
        return Err("输入服务响应确认无效".into());
    }
    Ok(())
}
pub fn receive_reply<T: std::io::Read + std::io::Write>(file: &mut T) -> Result<Reply, String> {
    let bytes = read_line(file)?;
    file.write_all(b"\n").map_err(|_| "输入服务响应确认失败")?;
    serde_json::from_slice(&bytes).map_err(|_| "输入服务响应格式错误".into())
}
#[cfg(windows)]
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn delayed_windows_pipe_reader_receives_reply_before_disconnect() {
        use std::{
            fs::OpenOptions,
            io::Write,
            os::windows::{
                fs::OpenOptionsExt,
                io::{AsRawHandle, FromRawHandle},
            },
            time::Duration,
        };
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
            Storage::FileSystem::PIPE_ACCESS_DUPLEX,
            System::Pipes::*,
        };
        let name = format!(r"\\.\pipe\WenBox.Kvm.Test.{}", uuid::Uuid::new_v4());
        let raw = unsafe {
            CreateNamedPipeW(
                wide(&name).as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                65536,
                65536,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        let mut server = unsafe { std::fs::File::from_raw_handle(raw as _) };
        let worker = std::thread::spawn(move || {
            unsafe {
                let connected = ConnectNamedPipe(server.as_raw_handle() as _, std::ptr::null_mut());
                assert!(connected != 0 || GetLastError() == ERROR_PIPE_CONNECTED);
                let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
                assert_ne!(
                    SetNamedPipeHandleState(
                        server.as_raw_handle() as _,
                        &mode,
                        std::ptr::null(),
                        std::ptr::null()
                    ),
                    0
                );
            }
            let _: Request = serde_json::from_slice(&read_line(&mut server).unwrap()).unwrap();
            send_reply(
                &mut server,
                &Reply {
                    ok: true,
                    running: false,
                    error: None,
                },
            )
            .unwrap();
            unsafe {
                DisconnectNamedPipe(server.as_raw_handle() as _);
            }
        });
        let mut client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .unwrap();
        unsafe {
            let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
            assert_ne!(
                SetNamedPipeHandleState(
                    client.as_raw_handle() as _,
                    &mode,
                    std::ptr::null(),
                    std::ptr::null()
                ),
                0
            );
        }
        client.write_all(b"{\"action\":\"status\"}\n").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let reply = receive_reply(&mut client).unwrap();
        assert!(reply.ok && !reply.running);
        worker.join().unwrap();
    }
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
