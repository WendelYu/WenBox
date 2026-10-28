//! Bounded, local-only adapter for Deskflow 1.27.0's public text IPC.
//! Independently implemented from observed protocol; no upstream source is vendored.
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_millis(800);
const LIMIT: usize = 4096;

#[derive(Clone, Copy)]
pub enum Endpoint {
    Core,
    Daemon,
}
impl Endpoint {
    fn name(self) -> &'static str {
        match self {
            Self::Core => "deskflow-core",
            Self::Daemon => "deskflow-daemon",
        }
    }
}
#[derive(Clone, Copy)]
pub enum Action {
    Probe,
    Start,
    Stop,
}
impl Action {
    fn message(self) -> &'static [u8] {
        match self {
            Self::Probe => b"noop\n",
            Self::Start => b"start\n",
            Self::Stop => b"stop\n",
        }
    }
}

fn line<S: Read>(stream: &mut S, deadline: Instant) -> Result<String, String> {
    let mut bytes = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err("输入后端响应超时".into());
        }
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => return Err("输入后端已断开".into()),
            Ok(_) if byte[0] == b'\n' => {
                return String::from_utf8(bytes).map_err(|_| "输入后端响应格式无效".into())
            }
            Ok(_) => {
                if bytes.len() >= LIMIT {
                    return Err("输入后端响应过长".into());
                }
                bytes.push(byte[0]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) || (cfg!(windows) && e.raw_os_error() == Some(232)) =>
            {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(e) => return Err(format!("输入后端读取失败：{e}")),
        }
    }
}

fn exchange<S: Read + Write>(stream: &mut S, action: Action) -> Result<(), String> {
    let deadline = Instant::now() + TIMEOUT;
    stream
        .write_all(b"hello=wenbox-m1\n")
        .map_err(|e| format!("输入后端握手失败：{e}"))?;
    let greeting = line(stream, deadline)?;
    let version = greeting
        .strip_prefix("hello=")
        .or_else(|| greeting.strip_prefix("versionMismatch="))
        .ok_or("输入后端握手无效")?;
    // Compatibility guard only, not peer authentication: IPC is local to the installed backend.
    // The adapter's wire semantics are only verified against this exact release.
    if !matches!(version.split('+').next(), Some("1.27.0" | "1.27.0.0")) {
        return Err("仅支持已验证的 Deskflow 1.27.0，请使用匹配版本".into());
    }
    stream
        .write_all(action.message())
        .map_err(|e| format!("输入后端请求失败：{e}"))?;
    // Pending notifications can be replayed after hello; never treat one as an ack.
    loop {
        let reply = line(stream, deadline)?;
        if reply == "ok" {
            return Ok(());
        }
        if reply == "error" || reply.starts_with("error=") || reply == "bye" {
            return Err("输入后端拒绝操作或正在退出".into());
        }
    }
}

#[cfg(unix)]
pub fn request(endpoint: Endpoint, action: Action) -> Result<(), String> {
    use std::os::unix::net::UnixStream;
    let mut roots = vec![std::env::temp_dir(), std::path::PathBuf::from("/tmp")];
    roots.dedup();
    for root in roots {
        if let Ok(mut stream) = UnixStream::connect(root.join(endpoint.name())) {
            stream
                .set_read_timeout(Some(Duration::from_millis(50)))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(TIMEOUT))
                .map_err(|e| e.to_string())?;
            return exchange(&mut stream, action);
        }
    }
    Err("输入后端未运行，或本地通信不可用".into())
}

#[cfg(windows)]
pub fn request(endpoint: Endpoint, action: Action) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT};
    use windows_sys::Win32::System::Pipes::{
        SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE,
    };
    let path = format!(r"\\.\pipe\{}", endpoint.name());
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        .open(path)
        .map_err(|_| "输入后台服务未运行，请先完成安装及首次配置".to_string())?;
    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle() as _,
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err("无法设置输入后端通信超时保护".into());
    }
    exchange(&mut pipe, action)
}

#[cfg(not(any(unix, windows)))]
pub fn request(_: Endpoint, _: Action) -> Result<(), String> {
    Err("当前系统不支持输入后端".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    struct Wire {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }
    impl Read for Wire {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for Wire {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn wire(reply: &str) -> Wire {
        Wire {
            input: Cursor::new(reply.as_bytes().to_vec()),
            output: Vec::new(),
        }
    }
    #[test]
    fn ack_requires_verified_version_and_skips_notifications() {
        let mut w = wire("versionMismatch=1.27.0.0+081f6478\nconnected=peer\nok\n");
        exchange(&mut w, Action::Stop).unwrap();
        assert_eq!(w.output, b"hello=wenbox-m1\nstop\n");
    }
    #[test]
    fn different_version_cannot_receive_control_request() {
        for version in ["1.28.0", "1.27.0.1", "1.27.00", "1.27.0-malformed"] {
            let mut w = wire(&format!("versionMismatch={version}+abcdef\n"));
            assert!(exchange(&mut w, Action::Start).is_err());
            assert_eq!(w.output, b"hello=wenbox-m1\n");
        }
    }
    #[test]
    fn bounded_response_and_eof_fail_closed() {
        assert!(exchange(&mut wire("hello=1.27.0+x\n"), Action::Start).is_err());
        assert!(line(
            &mut Cursor::new(vec![b'a'; LIMIT + 2]),
            Instant::now() + TIMEOUT
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn fragmented_and_unresponsive_local_streams_are_bounded() {
        use std::os::unix::net::UnixStream;
        let (mut client, mut server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let worker = std::thread::spawn(move || {
            let mut hello = [0u8; 16];
            server.read_exact(&mut hello).unwrap();
            for piece in [
                b"versionMismatch=1.27".as_slice(),
                b".0+fixture\n".as_slice(),
            ] {
                server.write_all(piece).unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
            let mut command = [0u8; 5];
            server.read_exact(&mut command).unwrap();
            assert_eq!(&command, b"stop\n");
            server.write_all(b"ok\n").unwrap();
        });
        exchange(&mut client, Action::Stop).unwrap();
        worker.join().unwrap();
        let (mut client, _server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let start = Instant::now();
        assert!(exchange(&mut client, Action::Probe).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
