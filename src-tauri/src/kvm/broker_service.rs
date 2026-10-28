//! Narrow SYSTEM service: fixed installed core, fixed protected state, typed configuration.
//! The caller must be the installed WenBox executable in the active console session.
use super::{broker_protocol::*, model::*};
use std::{
    io::Write,
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{
        Diagnostics::ToolHelp::*, Environment::*, JobObjects::*, Pipes::*, RemoteDesktop::*,
        Services::*, Threading::*,
    },
};
static STOP: AtomicBool = AtomicBool::new(false);
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}
struct Process {
    handle: Handle,
    _job: Handle,
}
impl Process {
    fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle.0, 0) == WAIT_TIMEOUT }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            if self.alive() {
                TerminateProcess(self.handle.0, 0);
                WaitForSingleObject(self.handle.0, 1000);
            }
        }
    }
}
struct Runtime {
    process: Option<Process>,
    profile: Option<EngineProfile>,
    owner: u32,
    owner_process: Option<Handle>,
    retry: Instant,
    root: PathBuf,
    core: PathBuf,
}
fn fail() -> String {
    format!("Windows 输入服务错误 {}", unsafe { GetLastError() })
}
fn install_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .ok_or("服务安装位置无效".into())
}
fn unlocked(session: u32) -> bool {
    unsafe {
        let mut buffer = std::ptr::null_mut();
        let mut len = 0;
        let ok = WTSQuerySessionInformationW(
            std::ptr::null_mut(),
            session,
            WTSSessionInfoEx,
            &mut buffer,
            &mut len,
        );
        if ok == 0 || buffer.is_null() {
            return false;
        }
        let result = if len as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(buffer as *const WTSINFOEXW);
            info.Level == 1
                && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_UNLOCK as i32
        } else {
            false
        };
        WTSFreeMemory(buffer as _);
        result
    }
}
fn authorized(pipe: HANDLE, root: &std::path::Path) -> Result<(u32, Handle), String> {
    unsafe {
        let mut pid = 0;
        if GetNamedPipeClientProcessId(pipe, &mut pid) == 0 {
            return Err(fail());
        }
        let mut session = 0;
        if ProcessIdToSessionId(pid, &mut session) == 0
            || session != WTSGetActiveConsoleSessionId()
            || !unlocked(session)
        {
            return Err("只允许已登录的本机控制台用户使用输入服务".into());
        }
        let process = Handle(OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000,
            0,
            pid,
        ));
        if process.0.is_null() {
            return Err(fail());
        }
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        if QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length) == 0 {
            return Err(fail());
        }
        let actual = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
        let expected = root.join("wenbox.exe");
        let a = std::fs::canonicalize(actual).map_err(|_| "请求程序不存在")?;
        let b = std::fs::canonicalize(expected).map_err(|_| "WenBox 安装位置无效")?;
        if a.to_string_lossy().to_lowercase() != b.to_string_lossy().to_lowercase() {
            return Err("请求程序不是已安装的 WenBox".into());
        }
        Ok((session, process))
    }
}
fn spawn(
    core: &std::path::Path,
    config: &std::path::Path,
    role: Role,
    session: u32,
) -> Result<Process, String> {
    unsafe {
        if !unlocked(session) {
            return Err("当前控制台未解锁".into());
        }
        let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
        if snapshot.0 == INVALID_HANDLE_VALUE {
            return Err(fail());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut more = Process32FirstW(snapshot.0, &mut entry);
        // Never steal or terminate a separately running input application.
        while more != 0 {
            let n = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..n])
                .eq_ignore_ascii_case("deskflow-core.exe")
            {
                return Err("独立 Deskflow 输入核心仍在运行，请先停止它".into());
            }
            more = Process32NextW(snapshot.0, &mut entry);
        }
        more = Process32FirstW(snapshot.0, &mut entry);
        let mut source = None;
        while more != 0 {
            let n = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..n]).eq_ignore_ascii_case("winlogon.exe")
            {
                let mut found = 0;
                if ProcessIdToSessionId(entry.th32ProcessID, &mut found) != 0 && found == session {
                    source = Some(Handle(OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        entry.th32ProcessID,
                    )));
                    break;
                }
            }
            more = Process32NextW(snapshot.0, &mut entry);
        }
        let source = source.ok_or("找不到交互会话的系统输入进程")?;
        if source.0.is_null() {
            return Err(fail());
        }
        let mut raw = std::ptr::null_mut();
        if OpenProcessToken(source.0, TOKEN_DUPLICATE | TOKEN_QUERY, &mut raw) == 0 {
            return Err(fail());
        }
        let source_token = Handle(raw);
        let mut raw = std::ptr::null_mut();
        if DuplicateTokenEx(
            source_token.0,
            TOKEN_ALL_ACCESS,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut raw,
        ) == 0
        {
            return Err(fail());
        }
        let token = Handle(raw);
        let ui: u32 = 1;
        if SetTokenInformation(token.0, TokenUIAccess, &ui as *const _ as _, 4) == 0 {
            return Err(fail());
        }
        let mut env = std::ptr::null_mut();
        if CreateEnvironmentBlock(&mut env, token.0, 0) == 0 {
            return Err(fail());
        }
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of_val(&si) as u32;
        let mut desktop = wide("winsta0\\Default");
        si.lpDesktop = desktop.as_mut_ptr();
        let core_text = core.to_str().ok_or("输入组件路径无效")?;
        let config_text = config.to_str().ok_or("输入配置路径无效")?;
        let mut line = wide(&format!(
            "\"{core_text}\" {} --settings \"{config_text}\"",
            if role == Role::Source {
                "server"
            } else {
                "client"
            }
        ));
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            token.0,
            wide(core_text).as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            env,
            std::ptr::null(),
            &si,
            &mut pi,
        );
        let error = fail();
        DestroyEnvironmentBlock(env);
        if ok == 0 {
            return Err(error);
        }
        let thread = Handle(pi.hThread);
        let job = Handle(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
        let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if job.0.is_null()
            || SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limit as *const _ as _,
                std::mem::size_of_val(&limit) as u32,
            ) == 0
            || AssignProcessToJobObject(job.0, pi.hProcess) == 0
        {
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hProcess);
            return Err(fail());
        }
        let process = Process {
            handle: Handle(pi.hProcess),
            _job: job,
        };
        if ResumeThread(thread.0) == u32::MAX {
            return Err(fail());
        }
        Ok(process)
    }
}
impl Runtime {
    fn tick(&mut self) {
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        if session != self.owner
            || self
                .owner_process
                .as_ref()
                .is_some_and(|h| unsafe { WaitForSingleObject(h.0, 0) } != WAIT_TIMEOUT)
        {
            self.process = None;
            self.profile = None;
            self.owner_process = None;
            return;
        }
        if !unlocked(session) {
            self.process = None;
            return;
        }
        if self.process.as_ref().is_some_and(|p| !p.alive()) {
            self.process = None;
        }
        if self.process.is_none() && self.profile.is_some() && Instant::now() >= self.retry {
            self.retry = Instant::now() + Duration::from_secs(3);
            if let Some(p) = &self.profile {
                if let Ok(config) = render_profile(&self.root, p) {
                    self.process = spawn(&self.core, &config, p.role, session).ok();
                }
            }
        }
    }
    fn handle(&mut self, req: Request, caller: (u32, Handle)) -> Reply {
        let (session, owner_process) = caller;
        let result = (|| -> Result<(), String> {
            match req {
                Request::Apply(profile) => {
                    profile.validate()?;
                    let same = self.profile.as_ref().is_some_and(|p| {
                        serde_json::to_vec(p).ok() == serde_json::to_vec(&profile).ok()
                    });
                    if !same || self.process.as_ref().is_none_or(|p| !p.alive()) {
                        self.process = None;
                        let config = render_profile(&self.root, &profile)?;
                        let child = spawn(&self.core, &config, profile.role, session)?;
                        self.process = Some(child);
                    }
                    self.owner = session;
                    self.owner_process = Some(owner_process);
                    self.profile = Some(profile);
                    Ok(())
                }
                Request::Stop => {
                    self.process = None;
                    self.profile = None;
                    Ok(())
                }
                Request::Status => Ok(()),
            }
        })();
        Reply {
            ok: result.is_ok(),
            running: self.process.as_ref().is_some_and(|p| p.alive()),
            error: result.err(),
        }
    }
}
unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::SeqCst)
    }
    0
}
unsafe fn report(handle: SERVICE_STATUS_HANDLE, state: u32) {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: 0,
    };
    SetServiceStatus(handle, &status);
}
unsafe fn resume_user_app(root: &std::path::Path) {
    let session = WTSGetActiveConsoleSessionId();
    if !unlocked(session) {
        return;
    }
    let mut raw = std::ptr::null_mut();
    if WTSQueryUserToken(session, &mut raw) == 0 {
        return;
    }
    let token = Handle(raw);
    let mut environment = std::ptr::null_mut();
    if CreateEnvironmentBlock(&mut environment, token.0, 0) == 0 {
        return;
    }
    let executable = root.join("wenbox.exe");
    let Some(exe) = executable.to_str() else {
        DestroyEnvironmentBlock(environment);
        return;
    };
    let mut line = wide(&format!("\"{exe}\""));
    let mut desktop = wide("winsta0\\Default");
    let mut si: STARTUPINFOW = std::mem::zeroed();
    si.cb = std::mem::size_of_val(&si) as u32;
    si.lpDesktop = desktop.as_mut_ptr();
    let mut info: PROCESS_INFORMATION = std::mem::zeroed();
    if CreateProcessAsUserW(
        token.0,
        wide(exe).as_ptr(),
        line.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        0,
        CREATE_UNICODE_ENVIRONMENT,
        environment,
        std::ptr::null(),
        &si,
        &mut info,
    ) != 0
    {
        CloseHandle(info.hProcess);
        CloseHandle(info.hThread);
    }
    DestroyEnvironmentBlock(environment);
}
unsafe extern "system" fn service_main(argc: u32, argv: *mut *mut u16) {
    let name = wide(SERVICE);
    let handle = RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(control), std::ptr::null());
    if handle.is_null() {
        return;
    }
    report(handle, SERVICE_START_PENDING);
    if let Ok(root) = install_root() {
        let state = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .map(|p| p.join("WenBoxKvm"));
        if let Some(state) = state {
            let mut runtime = Runtime {
                process: None,
                profile: None,
                owner: u32::MAX,
                owner_process: None,
                retry: Instant::now(),
                root: state,
                core: root.join("resources/kvm/input/deskflow-core.exe"),
            };
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)").as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) != 0
            {
                let sa = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                };
                // Keep one pipe instance for the whole service lifetime; a squatter makes startup fail closed.
                let pipe = CreateNamedPipeW(
                    wide(PIPE).as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    65536,
                    65536,
                    0,
                    &sa,
                );
                LocalFree(descriptor as _);
                if pipe != INVALID_HANDLE_VALUE {
                    let mut file = std::fs::File::from_raw_handle(pipe as _);
                    report(handle, SERVICE_RUNNING);
                    if argc == 2 && !argv.is_null() {
                        let arg = *argv.add(1);
                        if !arg.is_null() {
                            let mut len = 0;
                            while len < 64 && *arg.add(len) != 0 {
                                len += 1;
                            }
                            if String::from_utf16_lossy(std::slice::from_raw_parts(arg, len))
                                == "resume-user-app"
                            {
                                resume_user_app(&root);
                            }
                        }
                    }
                    while !STOP.load(Ordering::SeqCst) {
                        runtime.tick();
                        let connected =
                            ConnectNamedPipe(file.as_raw_handle() as _, std::ptr::null_mut());
                        if connected != 0 || GetLastError() == ERROR_PIPE_CONNECTED {
                            if let Ok(session) = authorized(file.as_raw_handle() as _, &root) {
                                let response = match read_line(&mut file).and_then(|bytes| {
                                    serde_json::from_slice::<Request>(&bytes)
                                        .map_err(|_| "输入服务请求无效".into())
                                }) {
                                    Ok(req) => runtime.handle(req, session),
                                    Err(e) => Reply {
                                        ok: false,
                                        running: false,
                                        error: Some(e),
                                    },
                                };
                                if let Ok(mut bytes) = serde_json::to_vec(&response) {
                                    bytes.push(b'\n');
                                    let _ = file.write_all(&bytes);
                                }
                            }
                            DisconnectNamedPipe(file.as_raw_handle() as _);
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    runtime.process = None;
                }
            }
        }
    }
    report(handle, SERVICE_STOPPED);
}
pub fn run() {
    unsafe {
        let mut name = wide(SERVICE);
        let entries = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: name.as_mut_ptr(),
                lpServiceProc: Some(service_main),
            },
            SERVICE_TABLE_ENTRYW {
                lpServiceName: std::ptr::null_mut(),
                lpServiceProc: None,
            },
        ];
        StartServiceCtrlDispatcherW(entries.as_ptr());
    }
}
