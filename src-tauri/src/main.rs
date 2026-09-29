// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

#[derive(RustEmbed)]
#[folder = "../app/src/main/assets/web"]
struct WebAssets;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SharedFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub path: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ChatMessage {
    pub id: String,
    #[serde(rename = "senderName")]
    pub sender_name: String,
    pub content: String,
    pub timestamp: u64,
    #[serde(rename = "isFromPhone")]
    pub is_from_phone: bool,
    #[serde(rename = "senderIp", default)]
    pub sender_ip: String,
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct LanDevice {
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub platform: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct LocalIpInfo {
    pub ip: String,
    pub name: String,
    pub is_preferred: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RoomConfig {
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "roomName")]
    pub room_name: String,
    #[serde(rename = "pin")]
    pub pin: String,
    #[serde(rename = "needPassword")]
    pub need_password: bool,
    #[serde(rename = "hostDevice")]
    pub host_device: String,
    #[serde(rename = "hostIp")]
    pub host_ip: String,
    #[serde(rename = "hostPort")]
    pub host_port: u16,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            is_active: false,
            room_id: String::new(),
            room_name: String::new(),
            pin: String::new(),
            need_password: false,
            host_device: String::new(),
            host_ip: String::new(),
            host_port: 9527,
            created_at: 0,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RoomMember {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub platform: String,
    #[serde(rename = "accessIp", default)]
    pub access_ip: String,
    #[serde(rename = "joinedAt")]
    pub joined_at: u64,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DiscoveredRoom {
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "roomName")]
    pub room_name: String,
    #[serde(rename = "hostDevice")]
    pub host_device: String,
    #[serde(rename = "hostPlatform")]
    pub host_platform: String,
    pub ip: String,
    pub port: u16,
    #[serde(rename = "needPassword")]
    pub need_password: bool,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
}

struct AppState {
    files: Mutex<HashMap<String, SharedFile>>,
    received_files: Mutex<Vec<SharedFile>>,
    messages: Mutex<Vec<ChatMessage>>,
    devices: Mutex<HashMap<String, LanDevice>>,
    // 房间制体系
    room: Mutex<RoomConfig>,
    members: Mutex<HashMap<String, RoomMember>>,
    discovered_rooms: Mutex<HashMap<String, DiscoveredRoom>>,
    auth_tokens: Mutex<HashSet<String>>,
    host_token: Mutex<String>,
    is_tauri_host: Mutex<bool>,
    selected_ip: Mutex<Option<String>>,
}

// ---------------- 智能获取本机所有可用局域网 IPv4 地址 ----------------
fn get_all_lan_ips() -> Vec<LocalIpInfo> {
    let mut list = Vec::new();
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in interfaces {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() && !ipv4.is_link_local() {
                    let s = ipv4.to_string();
                    let lower_name = name.to_lowercase();
                    let is_virtual = lower_name.contains("vethernet")
                        || lower_name.contains("wsl")
                        || lower_name.contains("virtual")
                        || lower_name.contains("vmnet")
                        || lower_name.contains("docker");

                    let is_lan = s.starts_with("192.168.") || s.starts_with("10.") || s.starts_with("172.");
                    let is_preferred = is_lan && !is_virtual;

                    list.push(LocalIpInfo {
                        ip: s,
                        name: name.clone(),
                        is_preferred,
                    });
                }
            }
        }
    }

    // 优先将真正的 WiFi / 局域网物理网卡排在最前
    list.sort_by(|a, b| b.is_preferred.cmp(&a.is_preferred));

    if list.is_empty() {
        list.push(LocalIpInfo {
            ip: "127.0.0.1".into(),
            name: "本机回环".into(),
            is_preferred: true,
        });
    }

    list
}

fn get_primary_ip() -> String {
    get_all_lan_ips().first().map(|x| x.ip.clone()).unwrap_or_else(|| "127.0.0.1".into())
}

fn get_download_dir() -> PathBuf {
    dirs_next::download_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("WenBox")
}

// ---------------- Tauri 供前端调用的命令 ----------------
#[tauri::command]
fn get_local_ip(state: tauri::State<Arc<AppState>>) -> String {
    state.selected_ip.lock().unwrap().clone().unwrap_or_else(get_primary_ip)
}

#[tauri::command]
fn get_all_lan_ips_cmd() -> Vec<LocalIpInfo> {
    get_all_lan_ips()
}

#[tauri::command]
fn set_room_host_ip_cmd(ip: String, state: tauri::State<Arc<AppState>>) -> Result<(), String> {
    let clean = ip.trim().to_string();
    *state.selected_ip.lock().unwrap() = Some(clean.clone());
    let mut room = state.room.lock().map_err(|e| e.to_string())?;
    room.host_ip = clean.clone();
    let host_port = room.host_port;
    if let Some(host_member) = state.members.lock().unwrap().get_mut("host") {
        host_member.ip = clean.clone();
        host_member.access_ip = format!("{}:{}", clean, host_port);
    }
    Ok(())
}

#[tauri::command]
fn add_share_file(path_str: String, state: tauri::State<Arc<AppState>>) -> Result<SharedFile, String> {
    let p = PathBuf::from(&path_str);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let mime = mime_guess::from_path(&p).first_or_octet_stream().to_string();

    let shared = SharedFile {
        id: id.clone(),
        name,
        size: meta.len(),
        path: path_str,
        mime_type: mime,
    };

    state.files.lock().unwrap().insert(id, shared.clone());
    Ok(shared)
}

#[tauri::command]
fn remove_share_file(id: String, state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    let mut files = state.files.lock().unwrap();
    Ok(files.remove(&id).is_some())
}

#[tauri::command]
fn clear_share_files(state: tauri::State<Arc<AppState>>) {
    state.files.lock().unwrap().clear();
}

#[tauri::command]
fn get_received_files(state: tauri::State<Arc<AppState>>) -> Vec<SharedFile> {
    state.received_files.lock().unwrap().clone()
}

#[tauri::command]
fn open_download_folder() -> Result<String, String> {
    let dir = get_download_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let p_str = dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&p_str).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&p_str).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&p_str).spawn();
    }

    Ok(p_str)
}

#[tauri::command]
fn save_file_to_directory(dir_path: String, folder_name: String, file_name: String, bytes_base64: String) -> Result<String, String> {
    let base_dir = PathBuf::from(&dir_path);
    let target_dir = base_dir.join(&folder_name);
    if !target_dir.exists() {
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建文件夹失败: {}", e))?;
    }

    let file_path = target_dir.join(&file_name);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    let mut file = File::create(&file_path).map_err(|e| format!("写入文件失败: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("写入文件内容失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

// ---------------- 房间制 Tauri 客户端调用命令 ----------------
#[tauri::command]
fn create_room_cmd(
    room_name: String,
    pin: String,
    host_ip: Option<String>,
    creator_name: Option<String>,
    creator_platform: Option<String>,
    state: tauri::State<Arc<AppState>>
) -> Result<RoomConfig, String> {
    {
        let room = state.room.lock().unwrap();
        if room.is_active && *state.is_tauri_host.lock().unwrap() {
            return Err("本机已有进行中的房间，请先解散当前房间".into());
        }
        // 若当前房间由浏览器访客创建 (is_tauri_host=false)，本机原生端作为设备所有者可接管重建
    }
    let dev_name = creator_name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| whoami_device_name());
    let platform = creator_platform.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Windows".to_string());
    let primary_ip = host_ip.filter(|s| !s.trim().is_empty())
        .or_else(|| state.selected_ip.lock().unwrap().clone())
        .unwrap_or_else(get_primary_ip);
    *state.selected_ip.lock().unwrap() = Some(primary_ip.clone());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let clean_pin = pin.trim().to_string();
    let need_password = !clean_pin.is_empty();

    let clean_name = if room_name.trim().is_empty() {
        format!("WenBox-{}", &uuid::Uuid::new_v4().to_string()[..4].to_uppercase())
    } else {
        room_name.trim().to_string()
    };
    let room_id = clean_name.clone();

    let cfg = RoomConfig {
        is_active: true,
        room_id,
        room_name: clean_name,
        pin: clean_pin,
        need_password,
        host_device: dev_name.clone(),
        host_ip: primary_ip.clone(),
        host_port: 9527,
        created_at: now,
    };

    *state.room.lock().unwrap() = cfg.clone();
    state.members.lock().unwrap().clear();
    state.auth_tokens.lock().unwrap().clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    // 房主自身加入 member
    let host_token = uuid::Uuid::new_v4().to_string();
    *state.host_token.lock().unwrap() = host_token.clone();
    *state.is_tauri_host.lock().unwrap() = true;
    state.auth_tokens.lock().unwrap().insert(host_token);
    let host_member = RoomMember {
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} (房主)", dev_name),
        ip: primary_ip.clone(),
        platform: platform,
        access_ip: format!("{}:9527", primary_ip),
        joined_at: now,
        last_seen: now,
    };
    state.members.lock().unwrap().insert("host".into(), host_member);

    Ok(cfg)
}

#[tauri::command]
fn close_room_cmd(state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    let old_room_id = {
        let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
        let id = room.room_id.clone();
        room.is_active = false;
        *room = RoomConfig::default();
        id
    };
    *state.host_token.lock().unwrap() = String::new();
    *state.is_tauri_host.lock().unwrap() = false;
    state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    if !old_room_id.is_empty() {
        thread::spawn(move || {
            let msg = serde_json::json!({
                "action": "wenbox_room_closed",
                "roomId": old_room_id
            }).to_string();
            let bytes = msg.as_bytes();

            // 针对每个物理网卡独立绑定发送
            let ifaces = get_ipv4_interfaces();
            for (_name, iface_ip) in ifaces {
                if let Ok(socket) = UdpSocket::bind((iface_ip, 0)) {
                    let _ = socket.set_broadcast(true);
                    let octets = iface_ip.octets();
                    let subnet_bcast = format!("{}.{}.{}.255:9528", octets[0], octets[1], octets[2]);
                    let _ = socket.send_to(bytes, &subnet_bcast);
                    let _ = socket.send_to(bytes, "255.255.255.255:9528");
                    let _ = socket.send_to(bytes, format!("{}:9528", MULTICAST_IPV4));
                }
            }

            if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
                let _ = socket.set_broadcast(true);
                for target in get_all_broadcast_addrs() {
                    let _ = socket.send_to(bytes, &target);
                }
            }
        });
    }

    Ok(true)
}

#[tauri::command]
fn get_room_status_cmd(state: tauri::State<Arc<AppState>>) -> serde_json::Value {
    let room = state.room.lock().unwrap().clone();
    let is_tauri_host = *state.is_tauri_host.lock().unwrap();
    serde_json::json!({
        "isActive": room.is_active,
        "roomId": room.room_id,
        "roomName": room.room_name,
        "pin": room.pin,
        "needPassword": room.need_password,
        "hostDevice": room.host_device,
        "hostIp": room.host_ip,
        "hostPort": room.host_port,
        "createdAt": room.created_at,
        "isTauriHost": is_tauri_host,
    })
}

#[tauri::command]
fn get_discovered_rooms_cmd(state: tauri::State<Arc<AppState>>) -> Vec<DiscoveredRoom> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let self_ips: HashSet<String> = get_all_lan_ips().into_iter().map(|i| i.ip).collect();
    let cur_room_id = state.room.lock().unwrap().room_id.clone();
    let mut disc = state.discovered_rooms.lock().unwrap();
    disc.retain(|_, r| {
        now.saturating_sub(r.last_seen) < 15
            && !self_ips.contains(&r.ip)
            && (cur_room_id.is_empty() || r.room_id != cur_room_id)
    });
    let mut list: Vec<DiscoveredRoom> = disc.values().cloned().collect();

    let my_room = state.room.lock().unwrap().clone();
    let is_tauri_host = *state.is_tauri_host.lock().unwrap();
    if my_room.is_active && !is_tauri_host {
        let (host_dev, host_plat) = {
            let members = state.members.lock().unwrap();
            if let Some(m) = members.get("host") {
                let clean_name = m.name.replace(" (房主)", "").trim().to_string();
                (if clean_name.is_empty() { my_room.host_device.clone() } else { clean_name }, m.platform.clone())
            } else {
                (my_room.host_device.clone(), "Web".to_string())
            }
        };
        list.retain(|r| r.room_id != my_room.room_id);
        list.insert(0, DiscoveredRoom {
            room_id: my_room.room_id,
            room_name: my_room.room_name,
            host_device: host_dev,
            host_platform: host_plat,
            ip: "127.0.0.1".into(),
            port: 9527,
            need_password: my_room.need_password,
            last_seen: now,
        });
    }
    list
}

#[tauri::command]
fn get_room_members_cmd(state: tauri::State<Arc<AppState>>) -> Vec<RoomMember> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut mem = state.members.lock().unwrap();
    mem.retain(|k, m| k == "host" || now.saturating_sub(m.last_seen) < 15);
    mem.values().cloned().collect()
}

fn get_http_client() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1200))
        .timeout_read(Duration::from_millis(2000))
        .timeout_write(Duration::from_millis(2000))
        .build()
}

// 大文件流式传输专用客户端: 只限制连接/单次读写超时, 不设整体超时, 避免大文件被中断
fn get_stream_client() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(120))
        .build()
}

#[tauri::command]
fn clear_chat_messages_cmd(state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();
    Ok(true)
}

#[tauri::command]
fn join_remote_room_cmd(host_url: String, pin: String, my_name: String, state: tauri::State<Arc<AppState>>) -> Result<serde_json::Value, String> {
    let clean = host_url.trim().trim_end_matches('/');
    let url = format!("{}/api/room/join", clean);
    let dev_name = if my_name.trim().is_empty() {
        whoami_device_name()
    } else {
        my_name.trim().to_string()
    };

    let body = serde_json::json!({
        "pin": pin.trim(),
        "name": dev_name,
        "platform": "Windows"
    });

    let client = get_http_client();
    let resp = client.post(&url)
        .set("Content-Type", "application/json; charset=utf-8")
        .send_string(&body.to_string())
        .map_err(|e| format!("连接房间失败: {}", e))?;

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析房间响应失败: {}", e))?;
    if val["success"].as_bool().unwrap_or(false) {
        state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();
        Ok(val)
    } else {
        Err(val["message"].as_str().unwrap_or("加入房间失败").to_string())
    }
}

// ---------------- 鉴权与网络辅助函数 ----------------
fn get_clean_remote_ip(req: &tiny_http::Request) -> String {
    req.remote_addr().map(|a| {
        let s = a.ip().to_string();
        if s.starts_with("::ffff:") {
            s.trim_start_matches("::ffff:").to_string()
        } else {
            s
        }
    }).unwrap_or_else(|| "127.0.0.1".into())
}

// 严格百分号解码 (不把 '+' 还原为空格)，用于路径中的文件 id
fn percent_decode_strict(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// 表单风格解码 ('+' 还原为空格)，用于 X-File-Name 等表单编码的头
fn form_urldecode(input: &str) -> String {
    percent_decode_strict(&input.replace('+', " "))
}

// 百分号编码 (UTF-8)，用于把非 ASCII 文件名放进 HTTP 头
fn percent_encode_utf8(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b' ') {
            if *b == b' ' {
                out.push_str("%20");
            } else {
                out.push(*b as char);
            }
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// tiny_http 只接受 ASCII 头部值：非 ASCII 文件名必须走 RFC 5987 的 filename*，
// 并提供一个 ASCII 兜底名，避免 Header::from_bytes(...).unwrap() 因中文名 panic 导致下载线程崩溃
fn build_content_disposition(file_name: &str) -> Header {
    let ascii_fallback: String = file_name
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    let fallback = if ascii_fallback.trim().is_empty() { "file".to_string() } else { ascii_fallback };
    let disp = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        fallback,
        percent_encode_utf8(file_name)
    );
    Header::from_bytes(&b"Content-Disposition"[..], disp.as_bytes())
        .unwrap_or_else(|_| Header::from_bytes(&b"Content-Disposition"[..], &b"attachment"[..]).unwrap())
}

fn is_authorized(req: &tiny_http::Request, state: &AppState) -> bool {
    let room = state.room.lock().unwrap();
    if !room.is_active || !room.need_password {
        return true;
    }
    // 本地回环免鉴权 (房主本机请求)
    if let Some(addr) = req.remote_addr() {
        if addr.ip().is_loopback() {
            return true;
        }
    }
    let headers = req.headers();
    // 检查请求头 X-Host-Token (网页端房主身份凭证)
    if let Some(h) = headers.iter().find(|h| h.field.equiv("X-Host-Token")) {
        let token_val = h.value.as_str().trim();
        let cur_host = state.host_token.lock().unwrap().clone();
        if !cur_host.is_empty() && token_val == cur_host {
            return true;
        }
        if state.auth_tokens.lock().unwrap().contains(token_val) {
            return true;
        }
    }
    // 检查请求头 X-Room-Token
    if let Some(h) = headers.iter().find(|h| h.field.equiv("X-Room-Token")) {
        let token_val = h.value.as_str().trim();
        if state.auth_tokens.lock().unwrap().contains(token_val) {
            return true;
        }
    }
    // 检查 URL 查询参数 ?token=...
    let raw_url = req.url();
    if let Some(q_pos) = raw_url.find("token=") {
        let after = &raw_url[q_pos + 6..];
        let token_val = after.split('&').next().unwrap_or("").trim();
        let cur_host = state.host_token.lock().unwrap().clone();
        if !cur_host.is_empty() && token_val == cur_host {
            return true;
        }
        if state.auth_tokens.lock().unwrap().contains(token_val) {
            return true;
        }
    }
    false
}

#[tauri::command]
fn get_lan_devices(state: tauri::State<Arc<AppState>>) -> Vec<LanDevice> {
    let dev = state.devices.lock().unwrap();
    dev.values().cloned().collect()
}

#[tauri::command]
fn connect_device_node(target: String, state: tauri::State<Arc<AppState>>) -> Result<LanDevice, String> {
    let clean = target.trim();
    if clean.is_empty() {
        return Err("目标地址不能为空".into());
    }

    let mut base_url = clean.to_string();
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        base_url = format!("http://{}", base_url);
    }
    // 若未指定端口，补充默认端口 :9527
    if let Ok(parsed) = url::Url::parse(&base_url) {
        if parsed.port().is_none() {
            if let Some(host) = parsed.host_str() {
                base_url = format!("http://{}:9527", host);
            }
        }
    }
    let base_url = base_url.trim_end_matches('/').to_string();

    // 1. 发起 HTTP 主动握手 (优先尝试 /api/probe，退化尝试 /api/status)
    let my_ip = state.selected_ip.lock().unwrap().clone().unwrap_or_else(get_primary_ip);
    let dev_name = whoami_device_name();
    let probe_body = serde_json::json!({
        "action": "wenbox_discovery",
        "device": dev_name,
        "platform": "Windows",
        "port": 9527,
        "ip": my_ip
    });

    let client = get_http_client();
    let resp_res = client.post(&format!("{}/api/probe", base_url))
        .set("Content-Type", "application/json; charset=utf-8")
        .send_json(&probe_body)
        .or_else(|_| {
            client.get(&format!("{}/api/status", base_url))
                .call()
        });

    let resp = match resp_res {
        Ok(r) => r,
        Err(e) => return Err(format!("无法连接到目标设备 ({})，请确认对方 WenBox 服务已开启且在同一WiFi局域网", e)),
    };

    let json_val: serde_json::Value = resp.into_json().map_err(|e| format!("解析设备返回数据失败: {}", e))?;

    let parsed_url = url::Url::parse(&base_url).map_err(|e| e.to_string())?;
    let ip_str = parsed_url.host_str().unwrap_or("127.0.0.1").to_string();
    let port_num = parsed_url.port().unwrap_or(9527);
    let name_str = json_val["device"].as_str().unwrap_or("局域网设备").to_string();
    let plat_str = json_val["platform"].as_str().unwrap_or("Android").to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let key = format!("{}:{}", ip_str, port_num);
    let node = LanDevice {
        name: name_str,
        ip: ip_str.clone(),
        port: port_num,
        platform: plat_str,
        last_seen: now,
    };

    state.devices.lock().unwrap().insert(key, node.clone());

    // 主动往目标设备的 UDP 9528 发一个单播发现包，促成双方双向自动发现
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        let msg = serde_json::json!({
            "action": "wenbox_discovery",
            "device": dev_name,
            "platform": "Windows",
            "port": 9527
        }).to_string();
        let _ = socket.send_to(msg.as_bytes(), format!("{}:9528", ip_str));
    }

    Ok(node)
}

#[tauri::command]
fn fetch_node_files(base_url: String, token: Option<String>, state: tauri::State<Arc<AppState>>) -> Result<Vec<SharedFile>, String> {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let files_map = state.files.lock().unwrap();
        return Ok(files_map.values().cloned().collect());
    }

    let url = format!("{}/api/files", clean);
    let client = get_http_client();
    let mut req = client.get(&url);
    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.set("X-Room-Token", t).set("X-Host-Token", t);
        }
    }
    let resp = req.call().map_err(|e| format!("拉取文件列表失败: {}", e))?;

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析文件列表失败: {}", e))?;
    let mut list = Vec::new();
    if let Some(arr) = val["files"].as_array() {
        for item in arr {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let name = item["name"].as_str().unwrap_or("").to_string();
            let size = item["size"].as_u64().unwrap_or(0);
            let mime_type = item["mimeType"].as_str()
                .or_else(|| item["mime_type"].as_str())
                .unwrap_or("application/octet-stream")
                .to_string();
            list.push(SharedFile {
                id,
                name,
                size,
                path: String::new(),
                mime_type,
            });
        }
    }
    Ok(list)
}

#[tauri::command]
fn save_remote_file_to_directory(download_url: String, dir_path: String, folder_name: String, file_name: String, token: Option<String>) -> Result<String, String> {
    let base_dir = PathBuf::from(&dir_path);
    let target_dir = if folder_name.trim().is_empty() {
        base_dir
    } else {
        base_dir.join(&folder_name)
    };
    if !target_dir.exists() {
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    // 携带房间令牌，否则受密码保护房间的下载会被 401 拒绝
    let mut request = get_stream_client().get(&download_url);
    if let Some(ref t) = token {
        if !t.is_empty() {
            request = request
                .set("X-Room-Token", t)
                .set("X-Host-Token", t);
        }
    }
    let resp = request.call().map_err(|e| format!("下载远端文件流失败: {}", e))?;

    let safe_name = PathBuf::from(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".into());
    let file_path = target_dir.join(&safe_name);
    let mut dest_file = File::create(&file_path).map_err(|e| format!("创建文件失败: {}", e))?;

    let mut reader = resp.into_reader();
    std::io::copy(&mut reader, &mut dest_file).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn fetch_node_messages(base_url: String, token: Option<String>, since: Option<u64>, state: tauri::State<Arc<AppState>>) -> Result<Vec<ChatMessage>, String> {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let since_ts = since.unwrap_or(0);
        let msgs: Vec<ChatMessage> = state.messages.lock().unwrap_or_else(|e| e.into_inner()).clone();
        return Ok(if since_ts > 0 {
            msgs.into_iter().filter(|m| m.timestamp > since_ts).collect()
        } else {
            msgs
        });
    }

    let url = if let Some(s) = since.filter(|s| *s > 0) {
        format!("{}/api/messages?since={}", clean, s)
    } else {
        format!("{}/api/messages", clean)
    };
    let client = get_http_client();
    let mut req = client.get(&url);
    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.set("X-Room-Token", t).set("X-Host-Token", t);
        }
    }
    let resp = req.call().map_err(|e| format!("获取消息失败: {}", e))?;

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析消息失败: {}", e))?;
    let mut list = Vec::new();
    if let Some(arr) = val["messages"].as_array() {
        for item in arr {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let sender_name = item["senderName"].as_str().unwrap_or("").to_string();
            let content = item["content"].as_str().unwrap_or("").to_string();
            let timestamp = item["timestamp"].as_u64().unwrap_or(0);
            let is_from_phone = item["isFromPhone"].as_bool().unwrap_or(false);
            let sender_ip = item["senderIp"].as_str().unwrap_or("").to_string();
            let client_id = item["clientId"].as_str().map(|s| s.to_string());
            list.push(ChatMessage {
                id,
                sender_name,
                content,
                timestamp,
                is_from_phone,
                sender_ip,
                client_id,
            });
        }
    }
    Ok(list)
}

#[tauri::command]
fn send_node_message(base_url: String, sender_name: String, content: String, token: Option<String>, client_id: Option<String>, sender_ip: Option<String>, state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    let clean = base_url.trim().trim_end_matches('/');
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let my_ip = sender_ip
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.selected_ip.lock().unwrap().clone())
        .unwrap_or_else(|| {
            let r = state.room.lock().unwrap();
            if !r.host_ip.is_empty() && r.host_ip != "127.0.0.1" {
                r.host_ip.clone()
            } else {
                get_primary_ip()
            }
        });

    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            sender_name,
            content,
            timestamp: now_ms,
            is_from_phone: false,
            sender_ip: my_ip,
            client_id,
        };
        state.messages.lock().unwrap_or_else(|e| e.into_inner()).push(msg);
        return Ok(true);
    }

    let url = format!("{}/api/messages", clean);
    let body = serde_json::json!({
        "senderName": sender_name,
        "content": content,
        "senderIp": my_ip,
        "clientId": client_id
    });

    let client = get_http_client();
    let mut req = client.post(&url)
        .set("Content-Type", "application/json; charset=utf-8");
    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.set("X-Room-Token", t);
        }
    }
    let resp = req.send_string(&body.to_string());

    match resp {
        Ok(_) => {
            let msg = ChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                sender_name,
                content,
                timestamp: now_ms,
                is_from_phone: false,
                sender_ip: my_ip,
                client_id,
            };
            state.messages.lock().unwrap_or_else(|e| e.into_inner()).push(msg);
            Ok(true)
        }
        Err(e) => Err(format!("发送失败: {}", e)),
    }
}

#[tauri::command]
fn upload_local_file_to_remote(target_base_url: String, file_path: String, token: Option<String>) -> Result<String, String> {
    let p = PathBuf::from(&file_path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let file_name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let file_size = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {}", e))?.len();

    let base = target_base_url.trim().trim_end_matches('/');
    let url = format!("{}/api/upload", base);

    let boundary = format!("----WenBoxBoundary{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
    let content_type = format!("multipart/form-data; boundary={}", boundary);

    // 将 multipart 报文落盘为临时文件流式发送，避免把整个文件读入内存导致大文件 OOM
    let head = format!(
        "--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
        boundary, file_name
    );
    let tail = format!("\r\n--{}--\r\n", boundary);
    let body_len = head.len() as u64 + file_size + tail.len() as u64;

    let body_file = tempfile_path();
    {
        use std::io::BufWriter;
        let mut writer = BufWriter::new(File::create(&body_file).map_err(|e| format!("创建临时文件失败: {}", e))?);
        writer.write_all(head.as_bytes()).map_err(|e| format!("写入临时文件失败: {}", e))?;
        let mut src = File::open(&p).map_err(|e| format!("读取文件失败: {}", e))?;
        std::io::copy(&mut src, &mut writer).map_err(|e| format!("写入临时文件失败: {}", e))?;
        writer.write_all(tail.as_bytes()).map_err(|e| format!("写入临时文件失败: {}", e))?;
        writer.flush().ok();
    }

    let mut req = get_stream_client().post(&url)
        .set("Content-Type", &content_type)
        .set("Content-Length", &body_len.to_string())
        .set("X-File-Name", &percent_encode_utf8(&file_name));
    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.set("X-Room-Token", t).set("X-Host-Token", t);
        }
    }

    let send_result = File::open(&body_file).and_then(|mut reader| req.send(&mut reader).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())));

    let _ = std::fs::remove_file(&body_file);

    match send_result {
        Ok(_) => Ok(format!("成功发送文件: {}", file_name)),
        Err(e) => Err(format!("向对方投送文件失败: {}", e)),
    }
}

fn tempfile_path() -> PathBuf {
    std::env::temp_dir().join(format!("wenbox_upload_{}.part", uuid::Uuid::new_v4()))
}

// ---------------- 上传文件解析辅助函数 ----------------
fn parse_multipart_body<'a>(body: &'a [u8], boundary: &str) -> Option<(String, &'a [u8])> {
    if boundary.is_empty() {
        return None;
    }

    let body_str = String::from_utf8_lossy(&body[..body.len().min(4096)]);
    let filename_idx = body_str.find("filename=\"")?;
    let after_fn = &body_str[filename_idx + 10..];
    let end_fn = after_fn.find('"')?;
    let raw_filename = &after_fn[..end_fn];
    let filename = if raw_filename.is_empty() {
        "file.bin".to_string()
    } else {
        raw_filename.to_string()
    };

    let (_header_end, content_start) = if let Some(pos) = find_subsequence(body, b"\r\n\r\n") {
        (pos, pos + 4)
    } else if let Some(pos) = find_subsequence(body, b"\n\n") {
        (pos, pos + 2)
    } else {
        return None;
    };

    let boundary_bytes = format!("--{}", boundary);
    let rest = &body[content_start..];

    let content_len = if let Some(pos) = find_subsequence(rest, boundary_bytes.as_bytes()) {
        if pos >= 2 && rest[pos - 2..pos] == *b"\r\n" {
            pos - 2
        } else if pos >= 1 && rest[pos - 1] == b'\n' {
            pos - 1
        } else {
            pos
        }
    } else {
        rest.len()
    };

    Some((filename, &rest[..content_len]))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

// ---------------- 启动内置 HTTP 服务端 (9527) ----------------
fn start_embedded_http_server(state: Arc<AppState>, port: u16) {
    thread::spawn(move || {
        let addr = format!("0.0.0.0:{}", port);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("无法绑定端口 {}: {}", port, e);
                return;
            }
        };

        println!("WenBox 内置服务已在端口 {} 启动", port);

        for req in server.incoming_requests() {
            let state_clone = state.clone();
            thread::spawn(move || {
                handle_http_request(req, state_clone, port);
            });
        }
    });
}

fn handle_http_request(mut req: tiny_http::Request, state: Arc<AppState>, port: u16) {
    let raw_url = req.url().to_string();
    let url = raw_url.split('?').next().unwrap_or(&raw_url).to_string();
    let method = req.method().clone();

    let cors_origin = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
    let cors_methods = Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS, PUT, DELETE"[..]).unwrap();
    let cors_headers = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type, X-File-Name, Range, Authorization, X-Room-Token, X-Host-Token"[..]).unwrap();

    if method == Method::Options {
        let mut resp = Response::empty(200);
        resp.add_header(cors_origin);
        resp.add_header(cors_methods);
        resp.add_header(cors_headers);
        let _ = req.respond(resp);
        return;
    }

            // 0. 房间系统接口 (公开接口：查看状态、加入房间、心跳、成员与已发现房间)
            if (url == "/api/room/status" || url == "/api/room/info") && method == Method::Get {
                let room = state.room.lock().unwrap().clone();
                let members_count = state.members.lock().unwrap().len();
                let primary_ip = get_primary_ip();
                let current_host_token = state.host_token.lock().unwrap().clone();
                let is_host = room.is_active && !current_host_token.is_empty() && req.headers().iter().any(|h| {
                    (h.field.equiv("X-Host-Token") || h.field.equiv("X-Room-Token")) && h.value == current_host_token
                });
                let json = serde_json::json!({
                    "isActive": room.is_active,
                    "roomId": room.room_id,
                    "roomName": room.room_name,
                    "needPassword": room.need_password,
                    "hostDevice": room.host_device,
                    "hostIp": primary_ip,
                    "hostPort": port,
                    "memberCount": members_count,
                    "isHost": is_host
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/create" && method == Method::Post {
                // 同一服务端同时只有一个活跃房间: 已有房间进行中时拒绝再建。
                // 否则浏览器访客创建的新房间会覆盖设备原生端的房间 (清空成员/令牌/消息),
                // 原房主随后点击解散会误伤新房间。访客应直接加入现有房间。
                if state.room.lock().unwrap().is_active {
                    let mut resp = Response::from_string(
                        "{\"success\":false,\"message\":\"本机已有进行中的房间，请直接加入该房间；如需另建新房间，请先由本机解散现有房间\"}"
                    ).with_status_code(409);
                    resp.add_header(cors_origin);
                    resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                    let _ = req.respond(resp);
                    return;
                }
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let mut room_name = String::new();
                let mut pin = String::new();
                let mut host_ip_opt = None;
                let mut creator_name_opt = None;
                let mut creator_platform_opt = None;
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(rn) = val["roomName"].as_str() {
                        room_name = rn.trim().to_string();
                    }
                    if let Some(p) = val["pin"].as_str() {
                        pin = p.trim().to_string();
                    }
                    if let Some(hip) = val["hostIp"].as_str() {
                        if !hip.trim().is_empty() {
                            host_ip_opt = Some(hip.trim().to_string());
                        }
                    }
                    if let Some(cn) = val["creatorName"].as_str() {
                        if !cn.trim().is_empty() {
                            creator_name_opt = Some(cn.trim().to_string());
                        }
                    }
                    if let Some(cp) = val["creatorPlatform"].as_str() {
                        if !cp.trim().is_empty() {
                            creator_platform_opt = Some(cp.trim().to_string());
                        }
                    }
                }

                let client_ip = get_clean_remote_ip(&req);
                let dev_name = creator_name_opt
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        if client_ip == "127.0.0.1" || client_ip == "::1" { whoami_device_name() } else { "访客房主".into() }
                    });
                let platform_str = creator_platform_opt
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        if client_ip == "127.0.0.1" || client_ip == "::1" { "Windows".into() } else { "Web".into() }
                    });

                let primary_ip = host_ip_opt
                    .or_else(|| state.selected_ip.lock().unwrap().clone())
                    .unwrap_or_else(get_primary_ip);
                *state.selected_ip.lock().unwrap() = Some(primary_ip.clone());
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let clean_pin = pin.trim().to_string();
                let need_password = !clean_pin.is_empty();
                let clean_name = if room_name.trim().is_empty() {
                    format!("WenBox-{}", &uuid::Uuid::new_v4().to_string()[..4].to_uppercase())
                } else {
                    room_name.trim().to_string()
                };
                let room_id = clean_name.clone();

                let cfg = RoomConfig {
                    is_active: true,
                    room_id,
                    room_name: clean_name,
                    pin: clean_pin,
                    need_password,
                    host_device: dev_name.clone(),
                    host_ip: primary_ip.clone(),
                    host_port: port,
                    created_at: now,
                };

                *state.room.lock().unwrap() = cfg.clone();
                state.members.lock().unwrap().clear();
                state.auth_tokens.lock().unwrap().clear();
                state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

                let host_token = uuid::Uuid::new_v4().to_string();
                *state.host_token.lock().unwrap() = host_token.clone();
                *state.is_tauri_host.lock().unwrap() = false;
                state.auth_tokens.lock().unwrap().insert(host_token.clone());

                let host_display_ip = if client_ip != "127.0.0.1" && client_ip != "::1" {
                    client_ip.clone()
                } else {
                    primary_ip.clone()
                };

                let host_member = RoomMember {
                    id: host_token.clone(),
                    name: format!("{} (房主)", dev_name),
                    ip: host_display_ip,
                    platform: platform_str,
                    access_ip: format!("{}:{}", primary_ip, port),
                    joined_at: now,
                    last_seen: now,
                };
                state.members.lock().unwrap().insert("host".into(), host_member);

                let mut cfg_val = serde_json::to_value(&cfg).unwrap_or_default();
                if let Some(obj) = cfg_val.as_object_mut() {
                    obj.insert("hostToken".into(), serde_json::Value::String(host_token));
                }
                let json = cfg_val.to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/close" && method == Method::Post {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let provided_token = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    val["hostToken"].as_str().or(val["token"].as_str()).map(|s| s.to_string())
                } else {
                    None
                };

                let current_host_token = state.host_token.lock().unwrap().clone();
                let is_token_valid = !current_host_token.is_empty() && (
                    provided_token.as_deref() == Some(&current_host_token)
                    || req.headers().iter().any(|h| (h.field.equiv("X-Host-Token") || h.field.equiv("X-Room-Token")) && h.value == current_host_token)
                );

                if !is_token_valid {
                    let mut resp = Response::from_string("{\"success\":false,\"message\":\"无权解散房间：只有房主设备可以解散房间\"}")
                        .with_status_code(403);
                    resp.add_header(cors_origin);
                    let _ = req.respond(resp);
                    return;
                }

                let old_room_id = {
                    let mut room = state.room.lock().unwrap();
                    let id = room.room_id.clone();
                    room.is_active = false;
                    *room = RoomConfig::default();
                    id
                };
                *state.host_token.lock().unwrap() = String::new();
                *state.is_tauri_host.lock().unwrap() = false;
                state.members.lock().unwrap().clear();
                state.auth_tokens.lock().unwrap().clear();
                state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

                if !old_room_id.is_empty() {
                    thread::spawn(move || {
                        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
                            let _ = socket.set_broadcast(true);
                            let msg = serde_json::json!({
                                "action": "wenbox_room_closed",
                                "roomId": old_room_id
                            }).to_string();
                            for target in get_all_broadcast_addrs() {
                                let _ = socket.send_to(msg.as_bytes(), &target);
                            }
                        }
                    });
                }

                let mut resp = Response::from_string("{\"success\":true}");
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url.starts_with("/api/room/set_ip") && method == Method::Post {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(ip) = val["ip"].as_str() {
                        let clean = ip.trim().to_string();
                        *state.selected_ip.lock().unwrap() = Some(clean.clone());
                        let mut room = state.room.lock().unwrap();
                        room.host_ip = clean.clone();
                        if let Some(host_member) = state.members.lock().unwrap().get_mut("host") {
                            host_member.ip = clean.clone();
                            host_member.access_ip = format!("{}:{}", clean, port);
                        }
                    }
                }
                let mut resp = Response::from_string("{\"success\":true}");
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/join" && method == Method::Post {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let mut success = false;
                let mut msg = String::new();
                let mut token_str = String::new();
                let mut room_info = serde_json::Value::Null;

                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let pin = val["pin"].as_str().unwrap_or("").trim();
                    let name = val["name"].as_str().unwrap_or("访客设备").to_string();
                    let plat = val["platform"].as_str().unwrap_or("Browser").to_string();
                    let client_ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "127.0.0.1".into());

                    let room = state.room.lock().unwrap().clone();
                    if !room.is_active {
                        msg = "房间尚未开启或已解散".into();
                    } else if room.need_password && room.pin != pin {
                        msg = "房间密码错误".into();
                    } else {
                        success = true;
                        let token = uuid::Uuid::new_v4().to_string();
                        token_str = token.clone();
                        state.auth_tokens.lock().unwrap().insert(token.clone());

                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                        let clean_name = name.trim();
                        let display_name = if clean_name.is_empty() {
                            "访客设备".to_string()
                        } else {
                            clean_name.to_string()
                        };

                        let access_host = req.headers().iter()
                            .find(|h| h.field.equiv("Host"))
                            .map(|h| h.value.as_str().to_string())
                            .unwrap_or_else(|| format!("{}:9527", client_ip));

                        let member = RoomMember {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: display_name,
                            ip: client_ip.clone(),
                            platform: plat,
                            access_ip: access_host,
                            joined_at: now,
                            last_seen: now,
                        };
                        state.members.lock().unwrap().insert(token, member);

                        let host_ip_to_show = state.selected_ip.lock().unwrap().clone().unwrap_or_else(get_primary_ip);
                        room_info = serde_json::json!({
                            "roomId": room.room_id,
                            "roomName": room.room_name,
                            "hostDevice": room.host_device,
                            "hostIp": host_ip_to_show,
                            "hostPort": port,
                        });
                    }
                }

                let json = serde_json::json!({
                    "success": success,
                    "message": msg,
                    "token": token_str,
                    "room": room_info
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/heartbeat" && method == Method::Post {
                let client_ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "127.0.0.1".into());
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

                let token_header = req.headers().iter()
                    .find(|h| h.field.equiv("X-Room-Token"))
                    .map(|h| h.value.as_str().to_string());

                let access_host = req.headers().iter()
                    .find(|h| h.field.equiv("Host"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default();

                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let (client_name, client_plat, client_token) = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let n = val["name"].as_str().map(|s| s.to_string());
                    let p = val["platform"].as_str().map(|s| s.to_string());
                    let t = val["token"].as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.trim().to_string())
                        .or(token_header);
                    (n, p, t)
                } else {
                    (None, None, token_header)
                };

                let room = state.room.lock().unwrap().clone();
                let mut members = state.members.lock().unwrap();

                if let Some(ref t) = client_token {
                    let cur_host = state.host_token.lock().unwrap().clone();
                    let is_host_token = !cur_host.is_empty() && t == &cur_host;
                    if is_host_token {
                        if let Some(m) = members.get_mut("host") {
                            m.last_seen = now;
                            if client_ip != "127.0.0.1" && client_ip != "::1" {
                                m.ip = client_ip.clone();
                            }
                            if let Some(ref n) = client_name {
                                let clean_n = n.trim();
                                if !clean_n.is_empty() {
                                    m.name = if clean_n.contains("房主") { clean_n.to_string() } else { format!("{} (房主)", clean_n) };
                                }
                            }
                        }
                    } else if let Some(m) = members.get_mut(t) {
                        m.last_seen = now;
                        if !access_host.is_empty() {
                            m.access_ip = access_host.clone();
                        }
                        if let Some(ref n) = client_name {
                            let clean_n = n.trim();
                            if !clean_n.is_empty() {
                                m.name = clean_n.to_string();
                            }
                        }
                    } else if state.auth_tokens.lock().unwrap().contains(t) {
                        let display_name = client_name.unwrap_or_else(|| "访客设备".into());
                        let platform = client_plat.unwrap_or_else(|| "Client".into());
                        let member = RoomMember {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: display_name,
                            ip: client_ip.clone(),
                            platform,
                            access_ip: access_host,
                            joined_at: now,
                            last_seen: now,
                        };
                        members.insert(t.clone(), member);
                    }
                }

                let json = serde_json::json!({
                    "success": true,
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "hostDevice": room.host_device,
                        "needPassword": room.need_password
                    }
                }).to_string();

                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/leave" && method == Method::Post {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let token_header = req.headers().iter()
                    .find(|h| h.field.equiv("X-Room-Token"))
                    .map(|h| h.value.as_str().to_string());
                let token = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["token"].as_str().map(|s| s.to_string()))
                    .or(token_header);
                if let Some(t) = token {
                    let mut members = state.members.lock().unwrap();
                    members.remove(&t);
                }
                let mut resp = Response::from_string("{\"success\":true}");
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/members" && method == Method::Get {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let mut members_map = state.members.lock().unwrap();
                members_map.retain(|k, m| k == "host" || now.saturating_sub(m.last_seen) < 15);
                let list: Vec<RoomMember> = members_map.values().cloned().collect();
                let json = serde_json::json!({ "members": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=UTF-8"[..]).unwrap());
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/discovered_rooms" && method == Method::Get {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let mut rooms_map = state.discovered_rooms.lock().unwrap();
                rooms_map.retain(|_, r| now.saturating_sub(r.last_seen) < 15);
                let mut list: Vec<DiscoveredRoom> = rooms_map.values().cloned().collect();

                let my_room = state.room.lock().unwrap().clone();
                if my_room.is_active {
                    let primary_ip = state.selected_ip.lock().unwrap().clone().unwrap_or_else(get_primary_ip);
                    let (host_dev, host_plat) = {
                        let members = state.members.lock().unwrap();
                        if let Some(m) = members.get("host") {
                            let clean_name = m.name.replace(" (房主)", "").trim().to_string();
                            (if clean_name.is_empty() { my_room.host_device.clone() } else { clean_name }, m.platform.clone())
                        } else {
                            (my_room.host_device.clone(), "Web".to_string())
                        }
                    };
                    list.retain(|r| r.room_id != my_room.room_id && r.ip != primary_ip);
                    list.insert(0, DiscoveredRoom {
                        room_id: my_room.room_id,
                        room_name: my_room.room_name,
                        host_device: host_dev,
                        host_platform: host_plat,
                        ip: primary_ip,
                        port,
                        need_password: my_room.need_password,
                        last_seen: now,
                    });
                }

                let json = serde_json::json!({ "rooms": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 1. 获取本端信息 (供前端展示自身 IP 与服务状态)
            if url == "/api/status" && method == Method::Get {
                let primary_ip = state.selected_ip.lock().unwrap().clone().unwrap_or_else(get_primary_ip);
                let all_ips = get_all_lan_ips();
                let dev_name = whoami_device_name();
                let room = state.room.lock().unwrap().clone();
                let json = serde_json::json!({
                    "device": dev_name,
                    "ip": primary_ip,
                    "all_ips": all_ips,
                    "port": port,
                    "running": true,
                    "platform": "Windows",
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "needPassword": room.need_password
                    }
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 2. 获取在线节点设备列表
            if url == "/api/devices" && method == Method::Get {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let mut dev = state.devices.lock().unwrap();
                dev.retain(|_, d| now.saturating_sub(d.last_seen) < 15);
                let list: Vec<LanDevice> = dev.values().cloned().collect();
                let json = serde_json::json!({ "devices": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 2.5 节点主动探测握手
            if url == "/api/probe" && method == Method::Post {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = val["device"].as_str().unwrap_or("Android手机").to_string();
                    let plat = val["platform"].as_str().unwrap_or("Android").to_string();
                    let p = val["port"].as_u64().unwrap_or(9527) as u16;
                    let client_ip = val["ip"].as_str().unwrap_or("").to_string();
                    let ip = if !client_ip.is_empty() {
                        client_ip
                    } else {
                        req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "127.0.0.1".into())
                    };

                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    let key = format!("{}:{}", ip, p);
                    let node = LanDevice {
                        name,
                        ip,
                        port: p,
                        platform: plat,
                        last_seen: now,
                    };
                    state.devices.lock().unwrap().insert(key, node);
                }

                let primary_ip = get_primary_ip();
                let dev_name = whoami_device_name();
                let room = state.room.lock().unwrap().clone();
                let json = serde_json::json!({
                    "device": dev_name,
                    "ip": primary_ip,
                    "all_ips": get_all_lan_ips(),
                    "port": port,
                    "running": true,
                    "platform": "Windows",
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "needPassword": room.need_password
                    }
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 鉴权拦截检查 (当房间处于活跃且设置密码保护时，未授权的客户端拒绝访问敏感文件与消息接口)
            let is_protected = url.starts_with("/api/files")
                || url.starts_with("/api/download/")
                || url == "/api/upload"
                || url.starts_with("/api/messages");

            if is_protected && !is_authorized(&req, &state) {
                let mut resp = Response::from_string("{\"success\":false,\"unauthorized\":true,\"message\":\"未授权：请先输入房间密码加入房间\"}")
                    .with_status_code(401);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 3. 待发文件列表
            if url.starts_with("/api/files") && method == Method::Get {
                let files_map = state.files.lock().unwrap();
                let list: Vec<SharedFile> = files_map.values().cloned().collect();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 3.1 清空待发文件
            if url == "/api/files/clear" || (url == "/api/files" && method == Method::Delete) {
                state.files.lock().unwrap().clear();
                let mut resp = Response::from_string("{\"success\":true}");
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 3.2 接收到的文件列表
            if url == "/api/received_files" && method == Method::Get {
                let list = state.received_files.lock().unwrap().clone();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 4. 文件下载 (支持下载分享的文件或接收到的文件)
            if url.starts_with("/api/download/") && method == Method::Get {
                let file_id = percent_decode_strict(url.trim_start_matches("/api/download/"));
                let file_info = {
                    let files = state.files.lock().unwrap();
                    let f = files.get(&file_id).cloned();
                    if f.is_some() {
                        f
                    } else {
                        let rec = state.received_files.lock().unwrap();
                        rec.iter().find(|x| x.id == file_id).cloned()
                    }
                };

                if let Some(info) = file_info {
                    if let Ok(f) = File::open(&info.path) {
                        let mut resp = Response::from_file(f);
                        resp.add_header(build_content_disposition(&info.name));
                        if let Ok(ct) = Header::from_bytes(&b"Content-Type"[..], info.mime_type.as_bytes()) {
                            resp.add_header(ct);
                        }
                        resp.add_header(cors_origin);
                        let _ = req.respond(resp);
                        return;
                    }
                }
                let mut resp = Response::from_string("File Not Found").with_status_code(404);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 4.5 电脑接收文件上传 (手机或其他设备向这台电脑发送文件)
            if url == "/api/upload" && method == Method::Post {
                let download_dir = get_download_dir();
                if !download_dir.exists() {
                    let _ = std::fs::create_dir_all(&download_dir);
                }

                let headers = req.headers().to_vec();
                let content_type = headers.iter()
                    .find(|h| h.field.equiv("Content-Type"))
                    .map(|h| h.value.to_string())
                    .unwrap_or_default();

                let x_filename = headers.iter()
                    .find(|h| h.field.equiv("X-File-Name"))
                    .map(|h| form_urldecode(h.value.as_str()));

                let mut body_bytes = Vec::new();
                if req.as_reader().read_to_end(&mut body_bytes).is_ok() && !body_bytes.is_empty() {
                    let (raw_name, data) = if content_type.contains("multipart/form-data") {
                        let boundary = content_type.split("boundary=")
                            .nth(1)
                            .unwrap_or("")
                            .trim()
                            .trim_matches('"');
                        parse_multipart_body(&body_bytes, boundary).unwrap_or_else(|| {
                            let name = x_filename.unwrap_or_else(|| format!("upload_{}.bin", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()));
                            (name, &body_bytes[..])
                        })
                    } else {
                        let name = x_filename.unwrap_or_else(|| format!("upload_{}.bin", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()));
                        (name, &body_bytes[..])
                    };

                    let safe_name = PathBuf::from(&raw_name)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "uploaded_file.bin".into());

                    let target_path = download_dir.join(&safe_name);
                    if std::fs::write(&target_path, data).is_ok() {
                        let id = uuid::Uuid::new_v4().to_string();
                        let size = data.len() as u64;
                        let mime = mime_guess::from_path(&target_path).first_or_octet_stream().to_string();
                        let rec_file = SharedFile {
                            id: id.clone(),
                            name: safe_name.clone(),
                            size,
                            path: target_path.to_string_lossy().to_string(),
                            mime_type: mime.clone(),
                        };
                        state.received_files.lock().unwrap().insert(0, rec_file.clone());
                        state.files.lock().unwrap().insert(id.clone(), rec_file);

                        let json = serde_json::json!({
                            "success": true,
                            "message": format!("文件已成功保存到: {}", target_path.to_string_lossy()),
                            "fileId": id,
                            "name": safe_name,
                            "size": size
                        }).to_string();
                        let mut resp = Response::from_string(json);
                        resp.add_header(cors_origin);
                        let _ = req.respond(resp);
                        return;
                    }
                }

                let mut resp = Response::from_string("{\"success\":false,\"message\":\"保存文件失败\"}").with_status_code(500);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 5. 局域网消息获取与发送
            if url.starts_with("/api/messages") {
                if method == Method::Get {
                    let room = state.room.lock().unwrap();
                    let room_id = room.room_id.clone();
                    let is_active = room.is_active;
                    drop(room);
                    // 支持 ?since= 时间戳增量拉取，避免每 2s 全量传输历史消息（含大图 base64）
                    let since_ts = raw_url.split('?').nth(1).map(|q| {
                        q.split('&').find_map(|pair| {
                            let mut kv = pair.splitn(2, '=');
                            match (kv.next(), kv.next()) {
                                (Some("since"), Some(v)) => v.parse::<u64>().ok(),
                                _ => None,
                            }
                        })
                    }).flatten().unwrap_or(0);
                    let msgs: Vec<ChatMessage> = state.messages.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    let msgs: Vec<ChatMessage> = if since_ts > 0 {
                        msgs.into_iter().filter(|m| m.timestamp > since_ts).collect()
                    } else {
                        msgs
                    };
                    let json = serde_json::json!({
                        "messages": msgs,
                        "roomId": room_id,
                        "isActive": is_active
                    }).to_string();
                    let mut resp = Response::from_string(json);
                    resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                    resp.add_header(cors_origin);
                    let _ = req.respond(resp);
                    return;
                } else if method == Method::Post {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                        let content = val["content"].as_str().unwrap_or("").to_string();
                        let sender_name = val["senderName"].as_str().unwrap_or("未知用户").to_string();
                        let sender_ip_field = val["senderIp"].as_str().unwrap_or("").trim().to_string();
                        let remote_ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "127.0.0.1".into());
                        let sender_ip = if !sender_ip_field.is_empty() {
                            sender_ip_field
                        } else if remote_ip == "127.0.0.1" || remote_ip == "::1" {
                            state.selected_ip.lock().unwrap().clone().unwrap_or_else(|| {
                                let r = state.room.lock().unwrap();
                                if !r.host_ip.is_empty() && r.host_ip != "127.0.0.1" { r.host_ip.clone() } else { get_primary_ip() }
                            })
                        } else {
                            remote_ip
                        };
                        let client_id = val["clientId"].as_str().map(|s| s.to_string());
                        let is_from_phone = sender_name.contains("手机") || sender_name.contains("Android") || sender_name.contains("iPhone") || sender_name.contains("iPad");
                        let now_ms = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;

                        let msg = ChatMessage {
                            id: uuid::Uuid::new_v4().to_string(),
                            sender_name: sender_name.clone(),
                            content,
                            timestamp: now_ms,
                            is_from_phone,
                            sender_ip: sender_ip.clone(),
                            client_id,
                        };
                        state.messages.lock().unwrap_or_else(|e| e.into_inner()).push(msg);

                        let token_header = req.headers().iter()
                            .find(|h| h.field.equiv("X-Room-Token"))
                            .map(|h| h.value.as_str().to_string());
                        if let Some(t) = token_header {
                            let mut members = state.members.lock().unwrap();
                            if let Some(m) = members.get_mut(&t) {
                                m.last_seen = now_ms / 1000;
                            }
                        }
                    }
                    let mut resp = Response::from_string("{\"success\":true}");
                    resp.add_header(cors_origin);
                    let _ = req.respond(resp);
                    return;
                }
            }

            // 6. 静态网页资源直接服务 (让局域网其他手机/电脑用浏览器打开这台 Windows 的 IP:9527 也能看)
            let asset_path = if url == "/" || url.is_empty() {
                "index.html"
            } else {
                url.trim_start_matches('/')
            };

            if let Some(asset) = WebAssets::get(asset_path) {
                let mime = mime_guess::from_path(asset_path).first_or_octet_stream().to_string();
                let mut resp = Response::from_data(asset.data.into_owned());
                let content_type = format!("{}; charset=utf-8", mime);
                resp.add_header(Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap());
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                return;
            }

            // 默认返回 404
            let mut resp = Response::empty(404);
            resp.add_header(cors_origin);
            let _ = req.respond(resp);
}

// ---------------- UDP 局域网多网卡自发现与主动探测机制 (9528) ----------------
const MULTICAST_IPV4: &str = "239.255.255.250";
const DISCOVERY_PORT: u16 = 9528;

fn get_ipv4_interfaces() -> Vec<(String, std::net::Ipv4Addr)> {
    let mut list = Vec::new();
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in interfaces {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() && !ipv4.is_link_local() {
                    list.push((name, ipv4));
                }
            }
        }
    }
    list
}

fn get_all_broadcast_addrs() -> Vec<String> {
    let mut addrs = vec!["255.255.255.255:9528".to_string(), format!("{}:9528", MULTICAST_IPV4)];
    for (_name, ipv4) in get_ipv4_interfaces() {
        let octets = ipv4.octets();
        let bcast = format!("{}.{}.{}.255:9528", octets[0], octets[1], octets[2]);
        if !addrs.contains(&bcast) {
            addrs.push(bcast);
        }
    }
    addrs
}

#[tauri::command]
fn send_room_probe_cmd() -> Result<bool, String> {
    let msg = serde_json::json!({
        "action": "wenbox_search_room"
    }).to_string();
    let bytes = msg.as_bytes();

    let ifaces = get_ipv4_interfaces();
    for (_name, iface_ip) in ifaces {
        if let Ok(socket) = UdpSocket::bind((iface_ip, 0)) {
            let _ = socket.set_broadcast(true);
            let octets = iface_ip.octets();
            let subnet_bcast = format!("{}.{}.{}.255:9528", octets[0], octets[1], octets[2]);
            let _ = socket.send_to(bytes, &subnet_bcast);
            let _ = socket.send_to(bytes, "255.255.255.255:9528");
            let _ = socket.send_to(bytes, format!("{}:9528", MULTICAST_IPV4));
        }
    }
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        let _ = s.set_broadcast(true);
        let _ = s.send_to(bytes, "255.255.255.255:9528");
        let _ = s.send_to(bytes, format!("{}:9528", MULTICAST_IPV4));
    }
    Ok(true)
}

fn start_udp_discovery(state: Arc<AppState>, my_port: u16) {
    // 1. 启动接收监听线程
    let state_recv = state.clone();
    thread::spawn(move || {
        let socket = match UdpSocket::bind("0.0.0.0:9528") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to bind UDP 9528: {}", e);
                return;
            }
        };
        let _ = socket.set_broadcast(true);

        // 加入多播组
        if let Ok(mcast_addr) = MULTICAST_IPV4.parse::<std::net::Ipv4Addr>() {
            for (_name, iface_ip) in get_ipv4_interfaces() {
                let _ = socket.join_multicast_v4(&mcast_addr, &iface_ip);
            }
            let _ = socket.join_multicast_v4(&mcast_addr, &std::net::Ipv4Addr::UNSPECIFIED);
        }

        let mut buf = [0u8; 2048];
        loop {
            if let Ok((len, src)) = socket.recv_from(&mut buf) {
                if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                        let action = val["action"].as_str().unwrap_or("");
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();

                        // 1. 房间发现广播
                        if action == "wenbox_room_broadcast" {
                            let room_id = val["roomId"].as_str().unwrap_or("").to_string();
                            let room_name = val["roomName"].as_str().unwrap_or(&room_id).to_string();
                            let host_dev = val["hostDevice"].as_str().unwrap_or("").to_string();
                            let plat = val["platform"].as_str().unwrap_or("Windows").to_string();
                            let port = val["port"].as_u64().or_else(|| val["hostPort"].as_u64()).unwrap_or(9527) as u16;
                            let need_password = val["needPassword"].as_bool().unwrap_or(false);
                            let host_ip_field = val["hostIp"].as_str().unwrap_or("").trim().to_string();
                            let src_ip_str = src.ip().to_string();
                            // 优先以物理网络到达的真实 UDP 源 IP 作为房间连接 IP，防止被对端的多网卡/虚拟网卡 IP 干扰
                            let ip = if !src_ip_str.starts_with("127.") && !src_ip_str.is_empty() {
                                src_ip_str
                            } else if !host_ip_field.is_empty() {
                                host_ip_field
                            } else {
                                src.ip().to_string()
                            };

                            // 检查是否为自己发送的广播
                            let my_room = state_recv.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            let is_my_active_room = my_room.is_active && my_room.room_id == room_id;
                            let is_self_ip = get_all_lan_ips().iter().any(|item| item.ip == ip || item.ip == src.ip().to_string());

                            if !(is_my_active_room && is_self_ip) {
                                let key = format!("{}:{}", ip, port);
                                let disc = DiscoveredRoom {
                                    room_id: room_id.clone(),
                                    room_name: room_name.clone(),
                                    host_device: host_dev.clone(),
                                    host_platform: plat.clone(),
                                    ip: ip.clone(),
                                    port,
                                    need_password,
                                    last_seen: now,
                                };
                                state_recv.discovered_rooms.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), disc);

                                // 同时也作为普通在线节点缓存
                                let node = LanDevice {
                                    name: format!("{} [{}]", host_dev, room_name),
                                    ip,
                                    port,
                                    platform: plat,
                                    last_seen: now,
                                };
                                state_recv.devices.lock().unwrap_or_else(|e| e.into_inner()).insert(key, node);
                            }
                        }

                        // 2. 主动探测请求 (Ping): 如果本机开房中，单播秒级应答
                        if action == "wenbox_search_room" {
                            let my_room = state_recv.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            if my_room.is_active {
                                let member_count = state_recv.members.lock().unwrap_or_else(|e| e.into_inner()).len();
                                let (host_dev, host_plat) = {
                                    let members = state_recv.members.lock().unwrap_or_else(|e| e.into_inner());
                                    if let Some(m) = members.get("host") {
                                        let clean_name = m.name.replace(" (房主)", "").trim().to_string();
                                        (if clean_name.is_empty() { my_room.host_device.clone() } else { clean_name }, m.platform.clone())
                                    } else {
                                        (my_room.host_device.clone(), "Web".to_string())
                                    }
                                };
                                // 如果发来探测的 src 在某个物理网卡子网，优先以该子网的 IP 应答
                                let target_ip = src.ip();
                                let matched_iface_ip = get_ipv4_interfaces()
                                    .into_iter()
                                    .find(|(_name, ipv4)| {
                                        if let std::net::IpAddr::V4(target_v4) = target_ip {
                                            let o1 = ipv4.octets();
                                            let o2 = target_v4.octets();
                                            o1[0] == o2[0] && o1[1] == o2[1] && o1[2] == o2[2]
                                        } else {
                                            false
                                        }
                                    })
                                    .map(|(_name, ip)| ip.to_string())
                                    .unwrap_or_else(|| my_room.host_ip.clone());

                                let reply = serde_json::json!({
                                    "action": "wenbox_room_broadcast",
                                    "roomId": my_room.room_id,
                                    "roomName": my_room.room_name,
                                    "hostDevice": host_dev,
                                    "platform": host_plat,
                                    "port": my_port,
                                    "hostPort": my_port,
                                    "hostIp": matched_iface_ip,
                                    "needPassword": my_room.need_password,
                                    "memberCount": member_count
                                }).to_string();

                                // 同时向对方来源端口以及 9528 发送单播回包，防止对端临时端口已关闭
                                let _ = socket.send_to(reply.as_bytes(), src);
                                let _ = socket.send_to(reply.as_bytes(), (src.ip(), DISCOVERY_PORT));
                            }
                        }

                        // 3. 房间解散通知
                        if action == "wenbox_room_closed" {
                            let closed_room_id = val["roomId"].as_str().unwrap_or("");
                            let sender_ip = src.ip().to_string();
                            let mut rooms = state_recv.discovered_rooms.lock().unwrap_or_else(|e| e.into_inner());
                            rooms.retain(|_k, v| v.room_id != closed_room_id && v.ip != sender_ip);
                            let mut devs = state_recv.devices.lock().unwrap_or_else(|e| e.into_inner());
                            devs.retain(|_k, v| v.ip != sender_ip);
                        }

                        // 4. 传统设备节点探测广播
                        if action == "wenbox_discovery" {
                            let name = val["device"].as_str().unwrap_or("").to_string();
                            let plat = val["platform"].as_str().unwrap_or("Android").to_string();
                            let port = val["port"].as_u64().unwrap_or(9527) as u16;
                            let ip = src.ip().to_string();

                            let key = format!("{}:{}", ip, port);
                            let node = LanDevice {
                                name,
                                ip,
                                port,
                                platform: plat,
                                last_seen: now,
                            };
                            state_recv.devices.lock().unwrap_or_else(|e| e.into_inner()).insert(key, node);
                        }
                    }
                }
            }
        }
    });

    // 2. 启动定时广播线程 (遍历每个物理网卡独立绑定发包，保障多网卡环境稳定发现)
    let state_bcast = state.clone();
    thread::spawn(move || {
        loop {
            let active_room = {
                let r = state_bcast.room.lock().unwrap_or_else(|e| e.into_inner());
                if r.is_active {
                    Some(r.clone())
                } else {
                    None
                }
            };

            // 仅当房主开房后，才对外进行房间广播；默认客户端模式下绝不广播
            if let Some(room) = active_room {
                let member_count = state_bcast.members.lock().unwrap_or_else(|e| e.into_inner()).len();
                let (host_dev, host_plat) = {
                    let members = state_bcast.members.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(m) = members.get("host") {
                        let clean_name = m.name.replace(" (房主)", "").trim().to_string();
                        (if clean_name.is_empty() { room.host_device.clone() } else { clean_name }, m.platform.clone())
                    } else {
                        (room.host_device.clone(), "Web".to_string())
                    }
                };
                let ifaces = get_ipv4_interfaces();

                // 针对每一个网卡独立绑定 socket 发送，彻底解决多网卡（WiFi+网口）路由限制
                for (_name, iface_ip) in &ifaces {
                    if let Ok(socket) = UdpSocket::bind((*iface_ip, 0)) {
                        let _ = socket.set_broadcast(true);
                        let _ = socket.set_multicast_loop_v4(false);

                        let octets = iface_ip.octets();
                        let subnet_bcast = format!("{}.{}.{}.255:9528", octets[0], octets[1], octets[2]);
                        let host_ip_str = iface_ip.to_string();

                        let msg = serde_json::json!({
                            "action": "wenbox_room_broadcast",
                            "roomId": room.room_id,
                            "roomName": room.room_name,
                            "hostDevice": host_dev,
                            "platform": host_plat,
                            "port": my_port,
                            "hostPort": my_port,
                            "hostIp": host_ip_str,
                            "needPassword": room.need_password,
                            "memberCount": member_count
                        }).to_string();

                        let bytes = msg.as_bytes();
                        let _ = socket.send_to(bytes, &subnet_bcast);
                        let _ = socket.send_to(bytes, "255.255.255.255:9528");
                        let _ = socket.send_to(bytes, format!("{}:9528", MULTICAST_IPV4));
                    }
                }

                // 额外向已发现的在线节点单播发包，彻底穿透路由器针对广播包的睡眠抑制与过滤
                let known_ips: Vec<String> = state_bcast.devices.lock().unwrap_or_else(|e| e.into_inner())
                    .values()
                    .map(|d| d.ip.clone())
                    .collect();
                if let Ok(unicast_socket) = UdpSocket::bind("0.0.0.0:0") {
                    for tip in known_ips {
                        if !tip.starts_with("127.") {
                            let msg = serde_json::json!({
                                "action": "wenbox_room_broadcast",
                                "roomId": room.room_id,
                                "roomName": room.room_name,
                                "hostDevice": host_dev,
                                "platform": host_plat,
                                "port": my_port,
                                "hostPort": my_port,
                                "hostIp": room.host_ip,
                                "needPassword": room.need_password,
                                "memberCount": member_count
                            }).to_string();
                            let _ = unicast_socket.send_to(msg.as_bytes(), format!("{}:9528", tip));
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(2500));
        }
    });
}

fn whoami_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Windows电脑".into())
}

// 打开软件即自动创建的默认免密房间 (设备所有者身份, 可随时解散后改建密码房)
fn start_default_open_room(state: &Arc<AppState>) {
    let dev_name = whoami_device_name();
    let primary_ip = get_primary_ip();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let room_name = format!("WenBox·{}", dev_name);
    let cfg = RoomConfig {
        is_active: true,
        room_id: room_name.clone(),
        room_name: room_name.clone(),
        pin: String::new(),
        need_password: false,
        host_device: dev_name.clone(),
        host_ip: primary_ip.clone(),
        host_port: 9527,
        created_at: now,
    };

    *state.room.lock().unwrap() = cfg.clone();
    state.members.lock().unwrap().clear();
    state.auth_tokens.lock().unwrap().clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    let host_token = uuid::Uuid::new_v4().to_string();
    *state.host_token.lock().unwrap() = host_token.clone();
    *state.is_tauri_host.lock().unwrap() = true;
    state.auth_tokens.lock().unwrap().insert(host_token.clone());

    let host_member = RoomMember {
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} (房主)", dev_name),
        ip: primary_ip.clone(),
        platform: "Windows".to_string(),
        access_ip: format!("{}:9527", primary_ip),
        joined_at: now,
        last_seen: now,
    };
    state.members.lock().unwrap().insert("host".into(), host_member);

    println!("已自动创建免密房间「{}」，局域网内可通过 http://{}:9527 直接加入", room_name, primary_ip);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode_strict() {
        assert_eq!(percent_decode_strict("%E5%8F%91%E7%A5%A8.pdf"), "发票.pdf");
        assert_eq!(percent_decode_strict("a+b"), "a+b"); // 不把 '+' 还原为空格
        assert_eq!(percent_decode_strict("abc%2"), "abc%2"); // 残缺转义原样保留
        assert_eq!(percent_decode_strict("plain-id"), "plain-id");
    }

    #[test]
    fn test_form_urldecode() {
        assert_eq!(form_urldecode("%E5%8F%91%E7%A5%A8.pdf"), "发票.pdf");
        assert_eq!(form_urldecode("my+file.pdf"), "my file.pdf"); // '+' 还原为空格
    }

    #[test]
    fn test_percent_encode_utf8() {
        assert_eq!(percent_encode_utf8("发票.pdf"), "%E5%8F%91%E7%A5%A8.pdf");
        assert_eq!(percent_encode_utf8("my file.pdf"), "my%20file.pdf");
        let encoded = percent_encode_utf8("发票.pdf");
        assert_eq!(percent_decode_strict(&encoded), "发票.pdf");
    }

    #[test]
    fn test_content_disposition_ascii_safe() {
        // tiny_http 只接受 ASCII 头部值: 非 ASCII 文件名必须走 filename*, 不得 panic
        let h = build_content_disposition("报销发票-2026.pdf");
        let v = h.value.as_str();
        assert!(v.contains("filename*=\"") == false);
        assert!(v.contains("filename*=UTF-8''%E6%8A%A5%E9%94%80%E5%8F%91%E7%A5%A8-2026.pdf"), "{}", v);
        assert!(v.starts_with("attachment; filename=\""));
        // ASCII 名保持原样
        let h2 = build_content_disposition("plain-name.pdf");
        assert!(h2.value.as_str().contains("filename=\"plain-name.pdf\""));
    }

    #[test]
    fn test_parse_multipart_body_utf8_filename() {
        let boundary = "----WenBoxBoundary123";
        let filename = "截图-测试.png";
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        body.extend_from_slice(format!("Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n", filename).as_bytes());
        body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        body.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

        let (name, data) = parse_multipart_body(&body, boundary).expect("parse failed");
        assert_eq!(name, filename);
        assert_eq!(data, &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn test_http_create_room_rejects_when_active() {
        // 端到端复现用户报告的场景: 浏览器在已开房的服务端上再建新房间应被 409 拒绝,
        // 否则会覆盖设备原生端的房间, 原房主解散时误伤新房间
        let state = Arc::new(AppState {
            files: Mutex::new(HashMap::new()),
            received_files: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            room: Mutex::new(RoomConfig::default()),
            members: Mutex::new(HashMap::new()),
            discovered_rooms: Mutex::new(HashMap::new()),
            auth_tokens: Mutex::new(HashSet::new()),
            host_token: Mutex::new(String::new()),
            is_tauri_host: Mutex::new(false),
            selected_ip: Mutex::new(None),
        });

        let port = 39528;
        let server = Arc::new(tiny_http::Server::http(&format!("127.0.0.1:{}", port)).unwrap());
        let server_clone = server.clone();
        let state_clone = state.clone();
        std::thread::spawn(move || {
            for req in server_clone.incoming_requests() {
                let s = state_clone.clone();
                std::thread::spawn(move || handle_http_request(req, s, port));
            }
        });

        let post_create = |client: &ureq::Agent| -> (u16, serde_json::Value) {
            let resp = client.post(&format!("http://127.0.0.1:{}/api/room/create", port))
                .set("Content-Type", "application/json; charset=utf-8")
                .send_string(r#"{"roomName":"Browser-Room","pin":""}"#);
            // ureq 对非 2xx 返回 Err(Status(code, resp))，需从错误中取回响应体
            let resp = match resp {
                Ok(r) => r,
                Err(ureq::Error::Status(code, r)) => r,
                Err(e) => panic!("unexpected transport error: {}", e),
            };
            let status = resp.status();
            let val: serde_json::Value = resp.into_json().unwrap();
            (status, val)
        };

        // 第一次建房 (浏览器访客视角) 成功
        let client = get_http_client();
        let (status, val) = post_create(&client);
        assert_eq!(status, 200, "first create should succeed");
        assert!(val["isActive"].as_bool().unwrap());
        assert!(val["hostToken"].as_str().unwrap_or("").len() > 0);

        // 第二次建房 (另一个浏览器) 被 409 拒绝，原房间保持不变
        let (status2, val2) = post_create(&client);
        assert_eq!(status2, 409, "second create must be rejected");
        assert_eq!(val2["success"].as_bool(), Some(false));
        assert_eq!(state.room.lock().unwrap().room_name, "Browser-Room");
        assert_eq!(state.room.lock().unwrap().is_active, true);
    }

    #[test]
    fn test_http_download_chinese_filename() {
        // 端到端复现修复前的崩溃场景: HTTP 下载中文文件名的共享文件
        let dir = std::env::temp_dir().join(format!("wenbox_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("测试文件-报销.pdf");
        let content = b"%PDF-1.4 test content";
        std::fs::write(&file_path, content).unwrap();

        let state = Arc::new(AppState {
            files: Mutex::new(HashMap::new()),
            received_files: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            room: Mutex::new(RoomConfig::default()),
            members: Mutex::new(HashMap::new()),
            discovered_rooms: Mutex::new(HashMap::new()),
            auth_tokens: Mutex::new(HashSet::new()),
            host_token: Mutex::new(String::new()),
            is_tauri_host: Mutex::new(false),
            selected_ip: Mutex::new(None),
        });
        let file_id = "test-file-id".to_string();
        state.files.lock().unwrap().insert(file_id.clone(), SharedFile {
            id: file_id.clone(),
            name: "测试文件-报销.pdf".to_string(),
            size: content.len() as u64,
            path: file_path.to_string_lossy().to_string(),
            mime_type: "application/pdf".to_string(),
        });

        let port = 39527;
        let server = tiny_http::Server::http(&format!("127.0.0.1:{}", port)).unwrap();
        let server = Arc::new(server);
        let server_clone = server.clone();
        let state_clone = state.clone();
        std::thread::spawn(move || {
            for req in server_clone.incoming_requests() {
                let s = state_clone.clone();
                std::thread::spawn(move || handle_http_request(req, s, port));
            }
        });

        let resp = get_stream_client().get(&format!("http://127.0.0.1:{}/api/download/{}", port, file_id)).call().expect("download failed");
        assert_eq!(resp.status(), 200);
        let disp = resp.header("Content-Disposition").expect("missing Content-Disposition").to_string();
        assert!(disp.contains("filename*=UTF-8''"), "missing RFC5987 field: {}", disp);
        let body: Vec<u8> = std::io::Read::bytes(resp.into_reader()).collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(body, content);
        std::fs::remove_dir_all(&dir).ok();
    }
}

fn main() {
    let state = Arc::new(AppState {
        files: Mutex::new(HashMap::new()),
        received_files: Mutex::new(Vec::new()),
        messages: Mutex::new(Vec::new()),
        devices: Mutex::new(HashMap::new()),
        room: Mutex::new(RoomConfig::default()),
        members: Mutex::new(HashMap::new()),
        discovered_rooms: Mutex::new(HashMap::new()),
        auth_tokens: Mutex::new(HashSet::new()),
        host_token: Mutex::new(String::new()),
        is_tauri_host: Mutex::new(false),
        selected_ip: Mutex::new(None),
    });

    // 启动 HTTP 服务端 (默认 9527)
    start_embedded_http_server(state.clone(), 9527);

    // 启动 UDP 自动发现与设备节点探测 (9528)
    start_udp_discovery(state.clone(), 9527);

    // 软件打开即自动创建一个免密房间并对外广播:
    // 局域网内其他设备通过 IP 访问后无需任何操作即可直接加入互传
    start_default_open_room(&state);

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_local_ip,
            get_all_lan_ips_cmd,
            set_room_host_ip_cmd,
            get_lan_devices,
            connect_device_node,
            create_room_cmd,
            close_room_cmd,
            get_room_status_cmd,
            get_discovered_rooms_cmd,
            get_room_members_cmd,
            join_remote_room_cmd,
            add_share_file,
            remove_share_file,
            clear_share_files,
            get_received_files,
            open_download_folder,
            fetch_node_files,
            save_remote_file_to_directory,
            save_file_to_directory,
            upload_local_file_to_remote,
            fetch_node_messages,
            send_node_message,
            send_room_probe_cmd,
            clear_chat_messages_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running wenbox application");
}
