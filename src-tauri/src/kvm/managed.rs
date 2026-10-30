use super::{engine::Engine, model::*, tls::Channel};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Info {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub enabled: bool,
    pub pairing: bool,
    pub role: Role,
    pub side: Side,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub info: Info,
    pub ip: Ipv4Addr,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub session: String,
    pub name: String,
    pub code: String,
    pub local_confirmed: bool,
    pub remote_confirmed: bool,
    pub expires_in: u64,
}
#[derive(Clone)]
struct Pending {
    session: String,
    peer: Peer,
    code: String,
    expires: Instant,
    local: bool,
    remote: bool,
    side: Side,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Offer {
        session: String,
        info: Info,
        side: Side,
    },
    Confirm {
        session: String,
        accept: bool,
    },
    Status,
    InputStatus,
    ScrollSettings,
    Clipboard {
        exchange: super::clipboard::Exchange,
    },
    ScrollSpeed {
        percent: u16,
    },
    Layout {
        side: Side,
    },
    Revoke,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clipboard: Option<super::clipboard::ExchangeReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scroll_speed: Option<u16>,
    ok: bool,
    info: Info,
    accepted: bool,
    error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    time: u64,
    message: String,
}
fn record(s: &mut State, message: &str) {
    if s.events.len() >= 50 {
        s.events.pop_front();
    }
    s.events.push_back(Event {
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        message: message.into(),
    });
}
struct State {
    saved: Saved,
    pending: Option<Pending>,
    pair_until: Option<Instant>,
    attempts: Vec<Instant>,
    events: VecDeque<Event>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub local: Info,
    pub peer: Option<Peer>,
    pub side: Side,
    pub pending: Option<PendingView>,
    pub error: Option<String>,
}
pub struct Managed {
    state: Mutex<State>,
    engine: Mutex<Engine>,
    clipboard: super::clipboard::Clipboard,
    remote_input: Mutex<Option<(Instant, bool)>>,
    remote_scroll: Mutex<Option<(Instant, u16)>>,
    file: PathBuf,
    candidates: Arc<dyn Fn() -> Vec<Ipv4Addr> + Send + Sync>,
    active: AtomicUsize,
    stopping: AtomicBool,
}
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
fn platform() -> String {
    if cfg!(windows) { "Windows" } else { "macOS" }.into()
}
fn name() -> String {
    hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .unwrap_or_else(|| "我的电脑".into())
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect()
}
impl Managed {
    pub fn open(
        root: PathBuf,
        resources: PathBuf,
        candidates: Arc<dyn Fn() -> Vec<Ipv4Addr> + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let file = root.join("device.json");
        let saved = if file.exists() {
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            if bytes.len() > 32768 {
                return Err("流转设备存档过大".into());
            }
            serde_json::from_slice::<Saved>(&bytes)
                .map_err(|_| "流转设备存档损坏；请保留文件并联系排查，不自动重置信任".to_string())?
        } else {
            let s = Saved::fresh()?;
            atomic(&file, &serde_json::to_vec(&s).map_err(|e| e.to_string())?)?;
            s
        };
        saved.identity.screen()?;
        saved.identity.cert_der()?;
        saved.identity.key_der()?;
        if let Some(peer) = saved.peer.clone() {
            EngineProfile {
                keyboard_map: Default::default(),
                scroll_speed: 100,
                identity: saved.identity.clone(),
                peer,
                role: saved.role,
                side: saved.side,
            }
            .validate()?;
        }

        let clipboard = super::clipboard::Clipboard::open(root.clone(), saved.identity.id.clone());
        let this = Arc::new(Self {
            clipboard,
            state: Mutex::new(State {
                saved,
                pending: None,
                pair_until: None,
                attempts: vec![],
                events: VecDeque::new(),
                error: None,
            }),
            engine: Mutex::new(Engine::new(root.join("engine"), resources)),
            remote_input: Mutex::new(None),
            remote_scroll: Mutex::new(None),
            file,
            candidates,
            active: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&this);
        std::thread::spawn(move || Self::worker(weak));
        let weak = Arc::downgrade(&this);
        std::thread::spawn(move || Self::clipboard_worker(weak));
        #[cfg(target_os = "macos")]
        {
            let weak = Arc::downgrade(&this);
            std::thread::spawn(move || Self::health_worker(weak));
        }
        Ok(this)
    }
    fn persist(&self, s: &State) -> Result<(), String> {
        atomic(
            &self.file,
            &serde_json::to_vec(&s.saved).map_err(|e| e.to_string())?,
        )
    }
    fn info_locked(s: &State) -> Info {
        Info {
            id: s.saved.identity.id.clone(),
            name: name(),
            platform: platform(),
            enabled: s.saved.enabled,
            pairing: s.pair_until.is_some_and(|t| t > Instant::now()),
            role: s.saved.role,
            side: s.saved.side,
        }
    }
    pub fn info(&self) -> Info {
        Self::info_locked(&lock(&self.state))
    }
    pub fn view(&self) -> View {
        let s = lock(&self.state);
        View {
            enabled: s.saved.enabled,
            local: Self::info_locked(&s),
            peer: s.saved.peer.clone(),
            side: s.saved.side,
            pending: s
                .pending
                .as_ref()
                .filter(|p| p.expires > Instant::now() && s.saved.peer.is_none())
                .map(|p| PendingView {
                    session: p.session.clone(),
                    name: p.peer.name.clone(),
                    code: p.code.clone(),
                    local_confirmed: p.local,
                    remote_confirmed: p.remote,
                    expires_in: p
                        .expires
                        .saturating_duration_since(Instant::now())
                        .as_secs(),
                }),
            error: s.error.clone(),
        }
    }
    pub fn events(&self) -> Vec<Event> {
        lock(&self.state).events.iter().cloned().collect()
    }
    pub fn clipboard_view(&self) -> super::clipboard::View {
        self.clipboard.view()
    }
    pub fn set_clipboard(&self, enabled: bool) -> Result<(), String> {
        self.clipboard.set_enabled(enabled)
    }
    fn clipboard_context(&self) -> Option<(Identity, Peer)> {
        if !self.clipboard.enabled()
            || self.stopping.load(Ordering::SeqCst)
            || self.input_connected() != Some(true)
        {
            return None;
        }
        let s = lock(&self.state);
        if !s.saved.enabled {
            return None;
        }
        Some((s.saved.identity.clone(), s.saved.peer.clone()?))
    }
    #[cfg(target_os = "macos")]
    fn health_worker(weak: Weak<Self>) {
        let mut last_pid = None;
        let mut armed = false;
        let mut misses = 0;
        let mut last_tick = Instant::now();
        loop {
            let Some(this) = weak.upgrade() else {
                break;
            };
            if this.stopping.load(Ordering::SeqCst) {
                break;
            }
            if last_tick.elapsed() > Duration::from_secs(2) {
                armed = false;
                misses = 0;
            }
            last_tick = Instant::now();
            let target = lock(&this.engine).health_target();
            let current_pid = target.as_ref().map(|t| t.0);
            if current_pid != last_pid {
                last_pid = current_pid;
                armed = false;
                misses = 0;
            }
            if let Some((pid, root)) = target {
                // The private Qt IPC probe is independent of the input core's event loop.
                // A hung loop cannot defer this supervisor's bounded kill of its owned child.
                if super::ipc::request_at(&root, super::ipc::Action::Probe).is_ok() {
                    armed = true;
                    misses = 0;
                } else if armed {
                    misses += 1;
                    if misses >= 2 {
                        let mut state = lock(&this.state);
                        let mut engine = lock(&this.engine);
                        if engine.health_target().is_some_and(|t| t.0 == pid) {
                            state.saved.enabled = false;
                            this.clipboard.pause("输入核心未响应，文本同步暂停");
                            let _ = engine.emergency_stop();
                            state.error =
                                Some("输入核心未响应，已停止流转并收回本机输入；可重新开启".into());
                            record(&mut state, "输入核心连续未响应，已由独立监测停止");
                            let _ = this.persist(&state);
                        }
                        armed = false;
                        misses = 0;
                    }
                }
            }
            drop(this);
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    fn clipboard_worker(weak: Weak<Self>) {
        let mut desktop: Option<arboard::Clipboard> = None;
        loop {
            let Some(this) = weak.upgrade() else {
                break;
            };
            if this.stopping.load(Ordering::SeqCst) {
                break;
            }
            if let Some((id, peer)) = this.clipboard_context() {
                this.clipboard.activate(&peer.id);
                if let Some(exchange) = this.clipboard.request() {
                    let epoch = exchange.epoch().to_owned();
                    let result = (|| -> Result<_, String> {
                        let mut channel = Channel::connect(
                            &id,
                            SocketAddr::from((peer.ip, CONTROL_PORT)),
                            Some(&peer.fingerprint),
                        )?;
                        channel.send_guarded(
                            &Request::Clipboard { exchange },
                            super::clipboard::FRAME_LIMIT,
                            || this.clipboard.is_current(&epoch),
                        )?;
                        let reply: Reply =
                            channel.receive_limited(super::clipboard::FRAME_LIMIT)?;
                        if !reply.ok || reply.info.id != peer.id {
                            return Err("请确认对端已更新并开启文本同步".into());
                        }
                        reply.clipboard.ok_or("对端尚不支持文本同步".into())
                    })();
                    // A stopped/unpaired session must not apply an in-flight response.
                    if this.clipboard_context().is_some_and(|(_, current)| {
                        current.id == peer.id && current.fingerprint == peer.fingerprint
                    }) {
                        match result {
                            Ok(reply) => {
                                if this.clipboard.complete(&epoch, reply).is_err() {
                                    this.clipboard.pause("文本同步消息无效，已暂停");
                                }
                            }
                            Err(_) => this.clipboard.pause("等待对端开启文本同步或恢复连接"),
                        }
                    } else {
                        this.clipboard.pause("输入已断开，文本同步暂停");
                    }
                }
                if this.clipboard.view().active && desktop.is_none() {
                    desktop = arboard::Clipboard::new().ok();
                    if desktop.is_none() {
                        this.clipboard.notice("暂时无法访问系统剪贴板，将自动重试");
                    } else {
                        this.clipboard.notice("已连接，仅同步新复制的文本");
                    }
                }
                if let Some(clipboard) = desktop.as_mut().filter(|_| this.clipboard.view().active) {
                    let text = clipboard.get_text().ok();
                    this.clipboard.observe(text.as_deref(), |text| {
                        clipboard
                            .set_text(text)
                            .map_err(|_| "剪贴板写入失败".into())
                    });
                }
            } else {
                this.clipboard.pause("输入未连接，文本同步暂停");
                desktop = None;
            }
            drop(this);
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    pub fn engine_diagnostics(&self) -> String {
        lock(&self.engine).diagnostics()
    }
    pub fn scroll_speed(&self) -> Option<u16> {
        let target = lock(&self.state).saved.role == Role::Target;
        if target {
            Some(lock(&self.engine).scroll_speed())
        } else {
            lock(&self.remote_scroll)
                .filter(|(at, _)| at.elapsed() < Duration::from_secs(15))
                .map(|(_, speed)| speed)
        }
    }
    pub fn set_scroll_speed(&self, percent: u16) -> Result<(), String> {
        if !(50..=200).contains(&percent) {
            return Err("滚轮倍率范围为 0.5× 至 2.0×".into());
        }
        let s = lock(&self.state);
        let target = s.saved.role == Role::Target;
        if target {
            drop(s);
            lock(&self.engine).set_scroll_speed(percent)?;
            return self.reconfigure();
        }
        if !s.saved.enabled {
            return Err("请先开启流转".into());
        }
        let peer = s.saved.peer.clone().ok_or("请先配对被控电脑")?;
        let id = s.saved.identity.clone();
        drop(s);
        let mut ch = Channel::connect(
            &id,
            SocketAddr::from((peer.ip, CONTROL_PORT)),
            Some(&peer.fingerprint),
        )?;
        ch.send(&Request::ScrollSpeed { percent })?;
        let reply = ch
            .receive::<Reply>()
            .map_err(|_| "被控端未响应滚轮设置，请确认两端均已更新".to_string())?;
        if !reply.ok || reply.info.id != peer.id {
            return Err(reply.error.unwrap_or("被控端拒绝设置".into()));
        }
        *lock(&self.remote_scroll) = Some((Instant::now(), percent));
        Ok(())
    }
    pub fn keyboard_map(&self) -> KeyboardMap {
        let peer = lock(&self.state).saved.peer.as_ref().map(|p| p.id.clone());
        let engine = lock(&self.engine);
        peer.map(|p| engine.keyboard_map_for(&p))
            .unwrap_or_else(|| engine.keyboard_map())
    }
    pub fn set_keyboard_map(&self, mapping: KeyboardMap) -> Result<(), String> {
        let s = lock(&self.state);
        if s.saved.role != Role::Source {
            return Err("请在主控电脑设置按键映射".into());
        }
        let peer = s.saved.peer.as_ref().ok_or("请先配对电脑")?.id.clone();
        drop(s);
        lock(&self.engine).set_keyboard_map_for(&peer, mapping)?;
        self.reconfigure()
    }
    pub fn emergency_release(&self) -> Result<(), String> {
        let mut s = lock(&self.state);
        s.saved.enabled = false;
        s.pending = None;
        s.pair_until = None;
        self.clipboard.pause("已紧急停止流转");
        *lock(&self.remote_input) = None;
        lock(&self.engine).emergency_stop()?;
        record(&mut s, "已收回输入并停止流转，重新开启后才能连接");
        self.persist(&s)
    }
    pub fn pointer_speed(&self) -> Option<u16> {
        lock(&self.engine).pointer_speed()
    }
    pub fn set_pointer_speed(&self, percent: u16) -> Result<(), String> {
        if lock(&self.state).saved.role != Role::Source {
            return Err("请在主控电脑调整被控端速度".into());
        }
        lock(&self.engine).set_pointer_speed(percent)?;
        self.reconfigure()
    }
    pub fn input_connected(&self) -> Option<bool> {
        let s = lock(&self.state);
        if !s.saved.enabled || s.saved.peer.is_none() {
            return None;
        }
        let target = s.saved.role == Role::Target;
        drop(s);
        if target {
            lock(&self.remote_input)
                .filter(|(at, _)| at.elapsed() < Duration::from_secs(10))
                .map(|(_, connected)| connected)
        } else {
            lock(&self.engine).connected()
        }
    }
    pub fn engine_view(&self) -> (bool, bool, String) {
        lock(&self.engine).view()
    }
    pub fn enable(&self, enabled: bool) -> Result<(), String> {
        let mut s = lock(&self.state);
        if !enabled {
            self.clipboard.pause("流转已关闭，文本同步暂停");
            *lock(&self.remote_input) = None;
            lock(&self.engine).stop()?;
        }
        let old = s.saved.enabled;
        s.saved.enabled = enabled;
        if let Err(e) = self.persist(&s) {
            if enabled {
                s.saved.enabled = old;
            } else {
                s.pending = None;
                s.pair_until = None;
            }
            return Err(format!("流转已按本次操作处理，但设置未能保存：{e}"));
        }
        if !enabled {
            s.pending = None;
            s.pair_until = None;
        }
        s.error = None;
        record(
            &mut s,
            if enabled {
                "已开启流转"
            } else {
                "已停止流转"
            },
        );
        Ok(())
    }
    pub fn pairing_window(&self) -> Result<(), String> {
        self.enable(true)?;
        let mut s = lock(&self.state);
        if s.saved.peer.is_some() {
            return Err("请先解除已有设备配对".into());
        }
        s.pair_until = Some(Instant::now() + Duration::from_secs(120));
        s.pending = None;
        record(&mut s, "已打开限时配对窗口");
        Ok(())
    }
    pub fn role(&self, role: Role) -> Result<(), String> {
        let mut s = lock(&self.state);
        if s.saved.peer.is_some() || s.pending.is_some() {
            return Err("已有配对时不能更改输入角色，请先解除配对".into());
        }
        s.saved.role = role;
        s.saved.side = if role == Role::Source {
            Side::Right
        } else {
            Side::Left
        };
        self.persist(&s)
    }
    pub fn pair(&self, ip: Ipv4Addr) -> Result<(), String> {
        if !lan(ip) {
            return Err("请输入局域网 IPv4 地址".into());
        }
        self.pairing_window()?;
        let (id, info, side) = {
            let s = lock(&self.state);
            (
                s.saved.identity.clone(),
                Self::info_locked(&s),
                s.saved.side,
            )
        };
        let mut ch = Channel::connect(&id, SocketAddr::from((ip, CONTROL_PORT)), None)?;
        let session = uuid::Uuid::new_v4().to_string();
        ch.send(&Request::Offer {
            session: session.clone(),
            info: info.clone(),
            side,
        })?;
        let response: Reply = ch.receive()?;
        if !response.ok {
            return Err(response.error.unwrap_or("对端未接受配对".into()));
        }
        if response.info.role == info.role {
            return Err("两端输入角色相同，请选择一端使用本机键鼠、另一端接收输入".into());
        }
        let peer = Self::peer(&ch, &response.info)?;
        let mut s = lock(&self.state);
        if s.saved.peer.is_some() || !s.saved.enabled {
            return Err("配对状态已经变化，请重新开始".into());
        }
        s.pending = Some(Pending {
            session,
            peer,
            code: ch.code,
            expires: Instant::now() + Duration::from_secs(120),
            local: false,
            remote: false,
            side,
        });
        Ok(())
    }
    fn peer(ch: &Channel, info: &Info) -> Result<Peer, String> {
        screen(&info.id)?;
        let remote = match ch.remote.ip() {
            std::net::IpAddr::V4(ip) if lan(ip) || (cfg!(test) && ip.is_loopback()) => ip,
            _ => return Err("对端地址不属于局域网".into()),
        };
        let local = match ch.local.ip() {
            std::net::IpAddr::V4(ip) if lan(ip) || (cfg!(test) && ip.is_loopback()) => ip,
            _ => return Err("本机地址不属于局域网".into()),
        };
        Ok(Peer {
            id: info.id.clone(),
            name: info
                .name
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect(),
            platform: info.platform.chars().take(20).collect(),
            fingerprint: ch.fingerprint.clone(),
            ip: remote,
            local_ip: local,
        })
    }
    pub fn confirm(&self, session: &str, accept: bool) -> Result<(), String> {
        if !accept {
            let committed = {
                let s = lock(&self.state);
                s.pending.as_ref().is_some_and(|p| {
                    p.session == session
                        && s.saved
                            .peer
                            .as_ref()
                            .is_some_and(|v| v.fingerprint == p.peer.fingerprint)
                })
            };
            if committed {
                return self.forget();
            }
        }
        {
            let mut s = lock(&self.state);
            let p = s
                .pending
                .as_mut()
                .filter(|p| p.session == session && p.expires > Instant::now())
                .ok_or("配对已过期，请重新开始")?;
            if accept {
                p.local = true;
            }
        }
        if !accept {
            let p = { lock(&self.state).pending.take() };
            if let Some(p) = p {
                let _ = self.confirm_remote(&p, false);
            }
            return Ok(());
        }
        self.tick_confirm();
        Ok(())
    }
    fn confirm_remote(&self, p: &Pending, accept: bool) -> Result<Reply, String> {
        let id = lock(&self.state).saved.identity.clone();
        let mut ch = Channel::connect(
            &id,
            SocketAddr::from((p.peer.ip, CONTROL_PORT)),
            Some(&p.peer.fingerprint),
        )?;
        ch.send(&Request::Confirm {
            session: p.session.clone(),
            accept,
        })?;
        ch.receive()
    }
    fn authorize(&self, s: &mut State) -> Result<(), String> {
        let p = s
            .pending
            .as_ref()
            .filter(|p| p.local && p.remote && p.expires > Instant::now())
            .ok_or("仍需两端确认")?
            .clone();
        let old = s.saved.clone();
        s.saved.peer = Some(p.peer);
        s.saved.side = p.side;
        if let Err(e) = self.persist(s) {
            s.saved = old;
            return Err(e);
        }
        s.pair_until = None;
        s.error = None;
        record(s, "两端确认完成，已保存设备授权");
        Ok(())
    }
    fn tick_confirm(&self) {
        let pending = {
            let s = lock(&self.state);
            if s.saved.peer.is_some() {
                None
            } else {
                s.pending
                    .as_ref()
                    .filter(|p| p.local && p.expires > Instant::now())
                    .cloned()
            }
        };
        if let Some(p) = pending {
            if let Ok(reply) = self.confirm_remote(&p, true) {
                let mut s = lock(&self.state);
                if let Some(current) = s.pending.as_mut().filter(|v| v.session == p.session) {
                    current.remote = reply.ok && reply.accepted;
                    if current.remote {
                        let _ = self.authorize(&mut s);
                    }
                }
            }
        }
    }
    pub fn forget(&self) -> Result<(), String> {
        self.clipboard.pause("已撤销设备授权");
        let old = {
            let mut s = lock(&self.state);
            lock(&self.engine).stop()?;
            let old = s.saved.peer.clone();
            s.saved.peer = None;
            s.pending = None;
            s.pair_until = None;
            self.persist(&s)?;
            record(&mut s, "已解除设备配对并停止输入");
            old
        };
        if let Some(p) = old {
            let id = lock(&self.state).saved.identity.clone();
            if let Ok(mut ch) = Channel::connect(
                &id,
                SocketAddr::from((p.ip, CONTROL_PORT)),
                Some(&p.fingerprint),
            ) {
                if ch.send(&Request::Revoke).is_ok() {
                    let _ = ch.receive::<Reply>();
                }
            }
        }
        Ok(())
    }
    pub fn layout(&self, side: Side) -> Result<(), String> {
        let (id, peer) = {
            let mut s = lock(&self.state);
            if s.saved.role != Role::Source {
                return Err("请在使用键鼠的主控端调整方位".into());
            }
            let peer = s.saved.peer.clone().ok_or("请先配对设备")?;
            let old = s.saved.side;
            s.saved.side = side;
            if let Err(e) = self.persist(&s) {
                s.saved.side = old;
                return Err(e);
            }
            record(&mut s, "已保存屏幕方位，将同步到已授权对端");
            (s.saved.identity.clone(), peer)
        };
        // Offline edits are retained. The target also reconciles the source's side on its next pinned status request.
        if let Ok(mut ch) = Channel::connect(
            &id,
            SocketAddr::from((peer.ip, CONTROL_PORT)),
            Some(&peer.fingerprint),
        ) {
            if ch
                .send(&Request::Layout {
                    side: side.opposite(),
                })
                .is_ok()
            {
                let _ = ch.receive::<Reply>();
            }
        }
        self.reconfigure()
    }
    fn reconfigure(&self) -> Result<(), String> {
        lock(&self.engine).stop()?;
        let result = self.apply();
        lock(&self.state).error = result.as_ref().err().cloned();
        result
    }
    fn apply(&self) -> Result<(), String> {
        let s = lock(&self.state);
        if !s.saved.enabled || self.stopping.load(Ordering::SeqCst) {
            return Ok(());
        }
        let Some(peer) = s.saved.peer.clone() else {
            return Ok(());
        };
        let profile = EngineProfile {
            keyboard_map: Default::default(),
            scroll_speed: 100,
            identity: s.saved.identity.clone(),
            peer,
            role: s.saved.role,
            side: s.saved.side,
        };
        let mut engine = lock(&self.engine);
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(());
        }
        engine.apply(&profile)
    }
    fn handle(&self, ch: &mut Channel, req: Request) -> Reply {
        let scroll_query = matches!(&req, Request::ScrollSettings | Request::ScrollSpeed { .. });
        let mut clipboard_reply = None;
        let result = (|| -> Result<bool, String> {
            let pending_known = {
                let s = lock(&self.state);
                s.pending.as_ref().is_some_and(|p| {
                    p.peer.fingerprint == ch.fingerprint && p.expires > Instant::now()
                })
            };
            let trusted = {
                let s = lock(&self.state);
                s.saved
                    .peer
                    .as_ref()
                    .is_some_and(|p| p.fingerprint == ch.fingerprint)
            };
            match req {
                Request::Offer {
                    session,
                    info,
                    side,
                } => {
                    let mut s = lock(&self.state);
                    if !s.saved.enabled
                        || s.saved.peer.is_some()
                        || !s.pair_until.is_some_and(|t| t > Instant::now())
                    {
                        return Err("请先在对端打开配对窗口".into());
                    }
                    if s.pending.is_some() {
                        return Err("对端已有配对请求，请先确认或取消".into());
                    }
                    uuid::Uuid::parse_str(&session).map_err(|_| "配对会话标识无效")?;
                    if info.role == s.saved.role {
                        return Err("两端输入角色不能相同".into());
                    }
                    let peer = Self::peer(ch, &info)?;
                    s.pending = Some(Pending {
                        session,
                        peer,
                        code: ch.code.clone(),
                        expires: Instant::now() + Duration::from_secs(120),
                        local: false,
                        remote: false,
                        side: side.opposite(),
                    });
                    Ok(false)
                }
                Request::Confirm { session, accept } => {
                    let mut s = lock(&self.state);
                    let p = s
                        .pending
                        .as_mut()
                        .filter(|p| {
                            p.session == session
                                && p.peer.fingerprint == ch.fingerprint
                                && p.expires > Instant::now()
                        })
                        .ok_or("配对会话已过期或证书不匹配")?;
                    if !accept {
                        // Cancellation can race the other side's final confirmation. Revoke a just-committed pair too.
                        if s.saved
                            .peer
                            .as_ref()
                            .is_some_and(|p| p.fingerprint == ch.fingerprint)
                        {
                            lock(&self.engine).stop()?;
                            s.saved.peer = None;
                            self.persist(&s)?;
                        }
                        s.pending = None;
                        record(&mut s, "配对已取消");
                        return Ok(false);
                    }
                    p.remote = true;
                    let local = p.local;
                    if local {
                        self.authorize(&mut s)?;
                    }
                    Ok(local)
                }
                // The accepted bit is the boolean result of this authenticated query.
                // Older peers reject this optional request; ordinary pairing remains unchanged.
                Request::Clipboard { exchange } if trusted => {
                    let (_, peer) = self
                        .clipboard_context()
                        .ok_or("输入连接未就绪或文本同步已关闭")?;
                    self.clipboard.activate(&peer.id);
                    clipboard_reply = Some(self.clipboard.exchange(&peer.id, exchange)?);
                    Ok(true)
                }
                Request::ScrollSettings if trusted => {
                    let s = lock(&self.state);
                    if !s.saved.enabled || s.saved.role != Role::Target {
                        return Err("对端尚未开启被控功能".into());
                    }
                    Ok(true)
                }
                Request::ScrollSpeed { percent } if trusted => {
                    let s = lock(&self.state);
                    if !s.saved.enabled || s.saved.role != Role::Target {
                        return Err("仅能调整已开启流转的被控电脑".into());
                    }
                    drop(s);
                    self.set_scroll_speed(percent)?;
                    Ok(true)
                }
                Request::InputStatus if trusted => {
                    let s = lock(&self.state);
                    if !s.saved.enabled || s.saved.role != Role::Source {
                        return Ok(false);
                    }
                    drop(s);
                    let mut engine = lock(&self.engine);
                    engine.view();
                    Ok(engine.connected().unwrap_or(false))
                }
                Request::Status if trusted => {
                    let mut s = lock(&self.state);
                    if let Some(p) = s.saved.peer.as_mut() {
                        if let std::net::IpAddr::V4(ip) = ch.remote.ip() {
                            if lan(ip) {
                                p.ip = ip;
                            }
                        }
                        if let std::net::IpAddr::V4(ip) = ch.local.ip() {
                            if lan(ip) {
                                p.local_ip = ip;
                            }
                        }
                    }
                    self.persist(&s)?;
                    Ok(true)
                }
                Request::Layout { side } if trusted => {
                    let mut s = lock(&self.state);
                    if s.saved.role != Role::Target {
                        return Err("方位应由主控端修改".into());
                    }
                    s.saved.side = side;
                    self.persist(&s)?;
                    drop(s);
                    self.reconfigure()?;
                    Ok(true)
                }
                Request::Revoke if trusted || pending_known => {
                    let mut s = lock(&self.state);
                    let matches_peer = s
                        .saved
                        .peer
                        .as_ref()
                        .is_some_and(|p| p.fingerprint == ch.fingerprint);
                    let matches_pending = s
                        .pending
                        .as_ref()
                        .is_some_and(|p| p.peer.fingerprint == ch.fingerprint);
                    if !matches_peer && !matches_pending {
                        return Err("该设备授权已撤销".into());
                    }
                    self.clipboard.pause("已撤销设备授权");
                    lock(&self.engine).stop()?;
                    s.saved.peer = None;
                    s.pending = None;
                    self.persist(&s)?;
                    Ok(true)
                }
                _ => Err("该设备未获控制授权".into()),
            }
        })();
        let info = self.info();
        match result {
            Ok(accepted) => Reply {
                clipboard: clipboard_reply,
                scroll_speed: if scroll_query {
                    Some(lock(&self.engine).scroll_speed())
                } else {
                    None
                },
                ok: true,
                info,
                accepted,
                error: None,
            },
            Err(error) => Reply {
                clipboard: None,
                scroll_speed: None,
                ok: false,
                info,
                accepted: false,
                error: Some(error),
            },
        }
    }
    pub fn discover(&self) -> Vec<Candidate> {
        let own = self.info().id;
        let mut ips = (self.candidates)();
        if let Some(p) = &lock(&self.state).saved.peer {
            ips.push(p.ip)
        }
        ips.sort();
        ips.dedup();
        let mut workers = vec![];
        for ip in ips.into_iter().filter(|ip| lan(*ip)).take(16) {
            workers.push(std::thread::spawn(move || {
                let response = ureq::get(&format!("http://{ip}:9527/api/kvm/info"))
                    .timeout(Duration::from_millis(600))
                    .call()
                    .ok()?;
                let mut reader = response.into_reader().take(4097);
                use std::io::Read;
                let mut bytes = vec![];
                reader.read_to_end(&mut bytes).ok()?;
                if bytes.len() > 4096 {
                    return None;
                }
                let info: Info = serde_json::from_slice(&bytes).ok()?;
                screen(&info.id).ok()?;
                Some(Candidate { info, ip })
            }));
        }
        workers
            .into_iter()
            .filter_map(|w| w.join().ok().flatten())
            .filter(|v| v.info.id != own && v.info.enabled)
            .collect()
    }
    fn tick_peer(&self) {
        let (id, peer) = {
            let s = lock(&self.state);
            if !s.saved.enabled {
                return;
            }
            let Some(p) = s.saved.peer.clone() else {
                return;
            };
            (s.saved.identity.clone(), p)
        };
        let mut addresses = vec![peer.ip];
        let mut discovered = false;
        loop {
            for ip in addresses.drain(..) {
                if let Ok(mut ch) = Channel::connect(
                    &id,
                    SocketAddr::from((ip, CONTROL_PORT)),
                    Some(&peer.fingerprint),
                ) {
                    if ch.send(&Request::Status).is_ok() {
                        if let Ok(r) = ch.receive::<Reply>() {
                            if r.ok && r.info.enabled && r.info.id == peer.id {
                                let mut s = lock(&self.state);
                                if s.saved.role == Role::Target && r.info.role == Role::Source {
                                    s.saved.side = r.info.side.opposite();
                                }
                                if let Some(p) = s.saved.peer.as_mut().filter(|p| p.id == peer.id) {
                                    p.ip = ip;
                                    if let std::net::IpAddr::V4(local) = ch.local.ip() {
                                        p.local_ip = local;
                                    }
                                    let _ = self.persist(&s);
                                }
                                let target = s.saved.role == Role::Target;
                                drop(s);
                                if target {
                                    let input = (|| -> Result<bool, String> {
                                        let mut probe = Channel::connect(
                                            &id,
                                            SocketAddr::from((ip, CONTROL_PORT)),
                                            Some(&peer.fingerprint),
                                        )?;
                                        probe.send(&Request::InputStatus)?;
                                        let result = probe.receive::<Reply>()?;
                                        if !result.ok || result.info.id != peer.id {
                                            return Err("输入状态不可用".into());
                                        }
                                        Ok(result.accepted)
                                    })();
                                    *lock(&self.remote_input) =
                                        input.ok().map(|v| (Instant::now(), v));
                                }
                                if !target {
                                    let speed = (|| -> Result<u16, String> {
                                        let mut probe = Channel::connect(
                                            &id,
                                            SocketAddr::from((ip, CONTROL_PORT)),
                                            Some(&peer.fingerprint),
                                        )?;
                                        probe.send(&Request::ScrollSettings)?;
                                        let reply = probe.receive::<Reply>()?;
                                        if !reply.ok || reply.info.id != peer.id {
                                            return Err("滚轮设置不可用".into());
                                        }
                                        reply
                                            .scroll_speed
                                            .filter(|v| (50..=200).contains(v))
                                            .ok_or("滚轮设置格式无效".into())
                                    })();
                                    *lock(&self.remote_scroll) =
                                        speed.ok().map(|v| (Instant::now(), v));
                                }
                                match self.apply() {
                                    Ok(()) => lock(&self.state).error = None,
                                    Err(e) => lock(&self.state).error = Some(e),
                                }
                                return;
                            }
                        }
                    }
                }
            }
            if discovered {
                break;
            }
            discovered = true;
            addresses = self
                .discover()
                .into_iter()
                .filter(|c| c.info.id == peer.id && c.ip != peer.ip)
                .map(|c| c.ip)
                .collect();
            if addresses.is_empty() {
                break;
            }
        }
    }
    fn worker(weak: Weak<Self>) {
        let mut listeners: Vec<TcpListener> = vec![];
        let mut next = Instant::now();
        let mut bind_next = Instant::now();
        loop {
            let Some(this) = weak.upgrade() else { break };
            if this.stopping.load(Ordering::SeqCst) {
                break;
            }
            let enabled = lock(&this.state).saved.enabled;
            if enabled && Instant::now() >= bind_next {
                bind_next = Instant::now() + Duration::from_secs(3);
                let ips = if_addrs::get_if_addrs()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|i| match i.addr.ip() {
                        std::net::IpAddr::V4(ip) if lan(ip) => Some(ip),
                        _ => None,
                    })
                    .collect::<std::collections::HashSet<_>>();
                listeners.retain(|l| {
                    l.local_addr().ok().is_some_and(
                        |a| matches!(a.ip(),std::net::IpAddr::V4(ip)if ips.contains(&ip)),
                    )
                });
                for ip in ips {
                    if listeners.iter().any(|l| {
                        l.local_addr()
                            .ok()
                            .is_some_and(|a| a.ip() == std::net::IpAddr::V4(ip))
                    }) {
                        continue;
                    }
                    if let Ok(listener) = TcpListener::bind((ip, CONTROL_PORT)) {
                        let _ = listener.set_nonblocking(true);
                        listeners.push(listener);
                    }
                }
                if listeners.is_empty() {
                    lock(&this.state).error =
                        Some("没有可监听的局域网网卡，或流转端口已占用".into());
                }
            }
            if !enabled {
                listeners.clear();
            }
            for listener in &listeners {
                while let Ok((socket, _)) = listener.accept() {
                    if this.active.load(Ordering::SeqCst) >= 4 {
                        drop(socket);
                        continue;
                    }
                    this.active.fetch_add(1, Ordering::SeqCst);
                    let conn = this.clone();
                    std::thread::spawn(move || {
                        let (id, pins, unknown) = {
                            let s = lock(&conn.state);
                            let mut pins = s
                                .saved
                                .peer
                                .as_ref()
                                .map(|p| vec![p.fingerprint.clone()])
                                .unwrap_or_default();
                            if let Some(p) = &s.pending {
                                if p.expires > Instant::now() {
                                    pins.push(p.peer.fingerprint.clone())
                                }
                            }
                            (
                                s.saved.identity.clone(),
                                pins,
                                s.pair_until.is_some_and(|t| t > Instant::now()),
                            )
                        };
                        if let Ok(mut ch) = Channel::accept(&id, socket, pins.clone(), unknown) {
                            let permitted = if !pins.contains(&ch.fingerprint) {
                                let mut s = lock(&conn.state);
                                s.attempts.retain(|t| t.elapsed() < Duration::from_secs(60));
                                if s.attempts.len() >= 3 {
                                    false
                                } else {
                                    s.attempts.push(Instant::now());
                                    true
                                }
                            } else {
                                true
                            };
                            if permitted {
                                if let Ok(req) = ch.receive_limited::<Request>(
                                    if pins.contains(&ch.fingerprint) {
                                        super::clipboard::FRAME_LIMIT
                                    } else {
                                        32768
                                    },
                                ) {
                                    let response = conn.handle(&mut ch, req);
                                    let reply_epoch =
                                        response.clipboard.as_ref().map(|r| r.epoch().to_owned());
                                    let _ = ch.send_guarded(
                                        &response,
                                        super::clipboard::FRAME_LIMIT,
                                        || {
                                            reply_epoch.as_ref().is_none_or(|epoch| {
                                                conn.clipboard.is_current(epoch)
                                            })
                                        },
                                    );
                                }
                            }
                        }
                        conn.active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
            if Instant::now() >= next {
                this.tick_confirm();
                this.tick_peer();
                next = Instant::now() + Duration::from_secs(3);
            }
            {
                let mut s = lock(&this.state);
                if s.pending
                    .as_ref()
                    .is_some_and(|p| p.expires <= Instant::now())
                {
                    s.pending = None;
                }
            }
            drop(this);
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn shutdown(&self) {
        self.clipboard.pause("应用已退出");
        self.stopping.store(true, Ordering::SeqCst);
        let _ = lock(&self.engine).stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &std::path::Path, role: Role) -> Arc<Managed> {
        let mut saved = Saved::fresh().unwrap();
        saved.enabled = true;
        saved.role = role;
        Arc::new(Managed {
            clipboard: crate::kvm::clipboard::Clipboard::open(
                root.into(),
                saved.identity.id.clone(),
            ),
            remote_input: Mutex::new(None),
            remote_scroll: Mutex::new(None),
            state: Mutex::new(State {
                saved,
                pending: None,
                pair_until: Some(Instant::now() + Duration::from_secs(120)),
                attempts: vec![],
                events: VecDeque::new(),
                error: None,
            }),
            engine: Mutex::new(Engine::new(root.join("engine"), root.into())),
            file: root.join("device.json"),
            candidates: Arc::new(Vec::new),
            active: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
        })
    }
    fn channels(
        a: &Managed,
        b: &Managed,
        pin: Option<String>,
    ) -> Result<(Channel, Channel), String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server_id = lock(&b.state).saved.identity.clone();
        let t = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            Channel::accept(&server_id, socket, vec![], true)
        });
        let id = lock(&a.state).saved.identity.clone();
        let client = Channel::connect(&id, addr, pin.as_deref());
        let server = t.join().unwrap();
        Ok((client?, server?))
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn independent_health_monitor_stops_a_previously_responsive_owned_core() {
        use std::io::{BufRead, Write};
        let root = tempfile::tempdir().unwrap();
        let app = fixture(root.path(), Role::Source);
        let runtime = tempfile::tempdir().unwrap();
        let listener =
            std::os::unix::net::UnixListener::bind(runtime.path().join("deskflow-core")).unwrap();
        lock(&app.engine).install_health_fixture(runtime);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let fake = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            {
                let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut hello = String::new();
                reader.read_line(&mut hello).unwrap();
            }
            socket.write_all(b"hello=1.27.0\n").unwrap();
            {
                let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                assert_eq!(request, "noop\n");
            }
            socket.write_all(b"ok\n").unwrap();
            ready_tx.send(()).unwrap();
            let (_hung, _) = listener.accept().unwrap();
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let weak = Arc::downgrade(&app);
        let supervisor = std::thread::spawn(move || Managed::health_worker(weak));
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while lock(&app.state).saved.enabled && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!lock(&app.state).saved.enabled);
        assert!(lock(&app.state)
            .error
            .as_deref()
            .unwrap()
            .contains("未响应"));
        assert!(lock(&app.engine).health_target().is_none());
        app.stopping.store(true, Ordering::SeqCst);
        done_tx.send(()).unwrap();
        fake.join().unwrap();
        supervisor.join().unwrap();
    }
    #[test]
    fn authenticated_clipboard_frame_transports_one_mib_without_plaintext_diagnostics() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        a.clipboard.set_enabled(true).unwrap();
        b.clipboard.set_enabled(true).unwrap();
        let aid = a.info().id;
        let bid = b.info().id;
        a.clipboard.activate(&bid);
        b.clipboard.activate(&aid);
        for _ in 0..3 {
            let req = a.clipboard.request().unwrap();
            let epoch = req.epoch().to_owned();
            let response = b.clipboard.exchange(&aid, req).unwrap();
            a.clipboard.complete(&epoch, response).unwrap();
        }
        a.clipboard.observe(Some("baseline"), |_| panic!());
        let value = "x".repeat(super::super::clipboard::TEXT_LIMIT);
        a.clipboard.observe(Some(&value), |_| panic!());
        let request = Request::Clipboard {
            exchange: a.clipboard.request().unwrap(),
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let sender_id = lock(&a.state).saved.identity.clone();
        let receiver_id = lock(&b.state).saved.identity.clone();
        let sender_pin = sender_id.fingerprint().unwrap();
        let receiver_pin = receiver_id.fingerprint().unwrap();
        let task = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut ch = Channel::accept(&receiver_id, socket, vec![sender_pin], false).unwrap();
            let req: Request = ch
                .receive_limited(super::super::clipboard::FRAME_LIMIT)
                .unwrap();
            let Request::Clipboard { exchange } = req else {
                panic!("expected clipboard");
            };
            let response = b.clipboard.exchange(&aid, exchange).unwrap();
            ch.send_limited(&response, super::super::clipboard::FRAME_LIMIT)
                .unwrap();
            b.clipboard.observe(Some("baseline"), |_| Ok(()));
            assert!(!serde_json::to_string(&b.clipboard.view())
                .unwrap()
                .contains(&"x".repeat(100)));
        });
        let mut ch = Channel::connect(&sender_id, addr, Some(&receiver_pin)).unwrap();
        assert_eq!(
            ch.send_guarded(&request, super::super::clipboard::FRAME_LIMIT, || false),
            Err("设备传输已停止".into())
        );
        ch.send_limited(&request, super::super::clipboard::FRAME_LIMIT)
            .unwrap();
        let _: super::super::clipboard::ExchangeReply = ch
            .receive_limited(super::super::clipboard::FRAME_LIMIT)
            .unwrap();
        task.join().unwrap();
    }
    #[test]
    fn clipboard_rpc_rejects_unpaired_disabled_and_disconnected_devices() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        a.clipboard.set_enabled(true).unwrap();
        a.clipboard.activate(&b.info().id);
        let (_, mut ch) = channels(&a, &b, None).unwrap();
        assert!(
            !b.handle(
                &mut ch,
                Request::Clipboard {
                    exchange: a.clipboard.request().unwrap()
                }
            )
            .ok
        );
        let id = a.info().id;
        lock(&b.state).saved.peer = Some(Peer {
            id,
            name: "source".into(),
            platform: "macOS".into(),
            fingerprint: ch.fingerprint.clone(),
            ip: "192.168.1.1".parse().unwrap(),
            local_ip: "192.168.1.2".parse().unwrap(),
        });
        assert!(
            !b.handle(
                &mut ch,
                Request::Clipboard {
                    exchange: a.clipboard.request().unwrap()
                }
            )
            .ok
        );
        b.clipboard.set_enabled(true).unwrap();
        assert!(
            !b.handle(
                &mut ch,
                Request::Clipboard {
                    exchange: a.clipboard.request().unwrap()
                }
            )
            .ok
        );
        assert!(b.clipboard.request().is_none());
    }
    #[test]
    fn remote_scroll_requires_the_pinned_source_and_enforces_bounds() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        let (_, mut server) = channels(&a, &b, None).unwrap();
        assert!(
            !b.handle(&mut server, Request::ScrollSpeed { percent: 150 })
                .ok
        );
        assert_eq!(lock(&b.engine).scroll_speed(), 100);
        let id = lock(&a.state).saved.identity.clone();
        lock(&b.state).saved.peer = Some(Peer {
            id: id.id,
            name: "source".into(),
            platform: "macOS".into(),
            fingerprint: server.fingerprint.clone(),
            ip: "192.168.1.1".parse().unwrap(),
            local_ip: "192.168.1.2".parse().unwrap(),
        });
        let settings = b.handle(&mut server, Request::ScrollSettings);
        assert!(settings.ok);
        assert_eq!(settings.scroll_speed, Some(100));
        for percent in [0, 49, 201, u16::MAX] {
            assert!(!b.handle(&mut server, Request::ScrollSpeed { percent }).ok);
        }
        assert_eq!(lock(&b.engine).scroll_speed(), 100);
        // The fixture has no OS input core. Suppress core application while testing RPC persistence.
        b.stopping.store(true, Ordering::SeqCst);
        let result = b.handle(&mut server, Request::ScrollSpeed { percent: 150 });
        assert!(result.ok);
        assert_eq!(result.scroll_speed, Some(150));
        lock(&b.state).saved.enabled = false;
        assert!(
            !b.handle(&mut server, Request::ScrollSpeed { percent: 75 })
                .ok
        );
        assert_eq!(lock(&b.engine).scroll_speed(), 150);
        let ordinary = b.handle(&mut server, Request::Status);
        assert!(serde_json::to_value(ordinary)
            .unwrap()
            .get("scrollSpeed")
            .is_none());
    }

    #[test]
    fn pairing_offer_roundtrips_with_nonblocking_accepted_socket() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket.set_nonblocking(true).unwrap();
            let id = lock(&b.state).saved.identity.clone();
            let mut ch = Channel::accept(&id, socket, vec![], true).unwrap();
            let req: Request = ch.receive().expect("server reads offer");
            let response = b.handle(&mut ch, req);
            ch.send(&response).expect("server sends reply");
        });
        let id = lock(&a.state).saved.identity.clone();
        let mut ch = Channel::connect(&id, addr, None).unwrap();
        ch.send(&Request::Offer {
            session: uuid::Uuid::new_v4().to_string(),
            info: a.info(),
            side: Side::Right,
        })
        .unwrap();
        let response: Reply = ch.receive().expect("client reads reply");
        assert!(response.ok, "{:?}", response.error);
        server.join().unwrap();
    }
    #[test]
    fn exporter_codes_match_but_trust_requires_both_confirmations() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        let (client, mut server) = channels(&a, &b, None).unwrap();
        assert_eq!(client.code, server.code);
        assert_eq!(client.code.len(), 8);
        let session = uuid::Uuid::new_v4().to_string();
        let reply = b.handle(
            &mut server,
            Request::Offer {
                session: session.clone(),
                info: a.info(),
                side: Side::Top,
            },
        );
        assert!(reply.ok);
        assert!(b.view().peer.is_none());
        let peer = Managed::peer(&client, &reply.info).unwrap();
        lock(&a.state).pending = Some(Pending {
            session: session.clone(),
            peer,
            code: client.code.clone(),
            expires: Instant::now() + Duration::from_secs(120),
            local: true,
            remote: false,
            side: Side::Top,
        });
        let reply = b.handle(
            &mut server,
            Request::Confirm {
                session: session.clone(),
                accept: true,
            },
        );
        assert!(!reply.accepted);
        assert!(b.view().peer.is_none());
        lock(&b.state).pending.as_mut().unwrap().local = true;
        let reply = b.handle(
            &mut server,
            Request::Confirm {
                session,
                accept: true,
            },
        );
        assert!(reply.ok && reply.accepted);
        assert!(b.view().peer.is_some());
        assert!(b.view().pending.is_none());
        let mut s = lock(&a.state);
        s.pending.as_mut().unwrap().remote = true;
        a.authorize(&mut s).unwrap();
        drop(s);
        assert_eq!(a.view().side, Side::Top);
        assert_eq!(b.view().side, Side::Bottom);
        let view = serde_json::to_string(&a.view()).unwrap();
        assert!(!view.contains(&lock(&a.state).saved.identity.key));
        let session = lock(&b.state).pending.as_ref().unwrap().session.clone();
        let response = b.handle(
            &mut server,
            Request::Confirm {
                session,
                accept: false,
            },
        );
        assert!(response.ok);
        assert!(
            b.view().peer.is_none(),
            "a late cancel must revoke already committed trust"
        );
    }
    #[test]
    fn changed_certificate_is_rejected_before_application_messages() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        assert!(channels(&a, &b, Some("00".repeat(32))).is_err());
    }
    #[test]
    fn expired_or_wrong_certificate_cannot_confirm() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        let (_, mut server) = channels(&a, &b, None).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert!(
            b.handle(
                &mut server,
                Request::Offer {
                    session: session.clone(),
                    info: a.info(),
                    side: Side::Right
                }
            )
            .ok
        );
        let actual = server.fingerprint.clone();
        server.fingerprint = "00".repeat(32);
        assert!(
            !b.handle(
                &mut server,
                Request::Confirm {
                    session: session.clone(),
                    accept: true
                }
            )
            .ok
        );
        server.fingerprint = actual;
        lock(&b.state).pending.as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(
            !b.handle(
                &mut server,
                Request::Confirm {
                    session,
                    accept: true
                }
            )
            .ok
        );
        assert!(b.view().peer.is_none());
    }
    #[test]
    fn revocation_cancels_a_pending_session_before_late_commit() {
        let da = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        let a = fixture(da.path(), Role::Source);
        let b = fixture(db.path(), Role::Target);
        let (_, mut server) = channels(&a, &b, None).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert!(
            b.handle(
                &mut server,
                Request::Offer {
                    session: session.clone(),
                    info: a.info(),
                    side: Side::Right
                }
            )
            .ok
        );
        assert!(b.handle(&mut server, Request::Revoke).ok);
        assert!(b.view().pending.is_none());
        assert!(
            !b.handle(
                &mut server,
                Request::Confirm {
                    session,
                    accept: true
                }
            )
            .ok
        );
        assert!(b.view().peer.is_none());
    }
    #[test]
    fn persistence_failure_does_not_create_in_memory_authorization() {
        let d = tempfile::tempdir().unwrap();
        let m = fixture(d.path(), Role::Source);
        let peer = Peer {
            id: uuid::Uuid::new_v4().to_string(),
            name: "peer".into(),
            platform: "Windows".into(),
            fingerprint: "ab".repeat(32),
            ip: "192.168.1.2".parse().unwrap(),
            local_ip: "192.168.1.1".parse().unwrap(),
        };
        let mut s = lock(&m.state);
        s.pending = Some(Pending {
            session: uuid::Uuid::new_v4().to_string(),
            peer,
            code: "12345678".into(),
            expires: Instant::now() + Duration::from_secs(30),
            local: true,
            remote: true,
            side: Side::Right,
        });
        std::fs::create_dir(m.file.clone()).unwrap();
        assert!(m.authorize(&mut s).is_err());
        assert!(s.saved.peer.is_none());
    }
}
