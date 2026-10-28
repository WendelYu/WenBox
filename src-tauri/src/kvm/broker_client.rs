use super::{broker_protocol::*, model::EngineProfile};
use std::{
    fs::OpenOptions,
    io::Write,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
};
use windows_sys::Win32::{
    Storage::FileSystem::{SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT},
    System::{Pipes::*, Services::*},
};
fn request(request: &Request) -> Result<Reply, String> {
    unsafe {
        let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
        if scm.is_null() {
            return Err("无法访问输入服务管理器".into());
        }
        let service = OpenServiceW(scm, wide(SERVICE).as_ptr(), SERVICE_QUERY_STATUS);
        CloseServiceHandle(scm);
        if service.is_null() {
            return Err("输入服务尚未安装，请使用完整安装包".into());
        }
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0;
        let valid = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut _ as *mut u8,
            std::mem::size_of_val(&status) as u32,
            &mut needed,
        );
        CloseServiceHandle(service);
        if valid == 0 || status.dwCurrentState != SERVICE_RUNNING {
            return Err("输入后台服务未运行，请检查完整安装包和服务状态".into());
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut file = loop {
            match OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
                .open(PIPE)
            {
                Ok(file) => break file,
                Err(e)
                    if matches!(e.raw_os_error(), Some(2 | 231))
                        && std::time::Instant::now() < until =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => return Err(format!("无法连接本机输入服务：{e}")),
            }
        };
        let mut server = 0;
        if GetNamedPipeServerProcessId(file.as_raw_handle() as _, &mut server) == 0
            || server != status.dwProcessId
        {
            return Err("输入服务身份与系统服务不匹配".into());
        }
        let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
        if SetNamedPipeHandleState(
            file.as_raw_handle() as _,
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        ) == 0
        {
            return Err("无法启用输入服务超时保护".into());
        }
        let mut bytes = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        if bytes.len() > 32768 {
            return Err("输入配置过大".into());
        }
        bytes.push(b'\n');
        file.write_all(&bytes)
            .map_err(|_| "输入服务请求失败".to_string())?;
        let response = receive_reply(&mut file)?;
        if !response.ok {
            return Err(response.error.unwrap_or("输入服务未接受操作".into()));
        }
        Ok(response)
    }
}
pub fn apply(profile: &EngineProfile) -> Result<(), String> {
    request(&Request::Apply(profile.clone())).map(|_| ())
}
pub fn stop() -> Result<(), String> {
    request(&Request::Stop).map(|_| ())
}
pub fn running() -> Result<bool, String> {
    request(&Request::Status).map(|r| r.running)
}
