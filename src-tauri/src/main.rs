// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod network;

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

/// 房间控制类接口的请求体上限 (S4)
const CTRL_MAX: u64 = 64 * 1024;
/// 聊天消息请求体上限：需容纳约 400KB 图片的 base64，留足余量 (S4)
const MSG_MAX: u64 = 8 * 1024 * 1024;
/// 单房间保留的最大消息条数 (S4)
const MAX_MESSAGES: usize = 500;
/// 成员/发现列表的最大条目数 (S4)
const MAX_DEVICES: usize = 256;
/// PIN 连续失败锁定阈值与锁定时长 (S8)
const PIN_MAX_FAILURES: u32 = 5;
const PIN_LOCK_SECS: u64 = 60;
/// 浏览器房主心跳超时后自动关房 (S6/Rust 其它)
const BROWSER_HOST_TIMEOUT_SECS: u64 = 30;

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
    /// Only untouched startup rooms participate in automatic wired pairing.
    #[serde(rename = "autoConnect", default)]
    pub auto_connect: bool,
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
            auto_connect: false,
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
    #[serde(rename = "autoConnect", default)]
    pub auto_connect: bool,
    #[serde(rename = "canAutoConnect", default)]
    pub can_auto_connect: bool,
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
    /// 房主 (含浏览器访客房主) 最近一次心跳时间戳 (秒)，用于回收已关闭页面的房间
    host_last_seen: Mutex<u64>,
    /// PIN 失败计数: 客户端 IP -> (最近一次失败时间戳秒, 连续失败次数) (S8)
    pin_failures: Mutex<HashMap<String, (u64, u32)>>,
}

/// 请求的 PIN 频控状态
enum PinGate {
    /// 允许继续校验 PIN
    Allowed,
    /// 已锁定，等待剩余秒数
    Locked(u64),
}

// ---------------- 智能获取本机所有可用局域网 IPv4 地址 ----------------
/// 物理网卡及其子网掩码 / 广播地址。if-addrs 同时提供 netmask，
/// 因此不再假设所有网络都是 /24 (S6/Rust 其它: 子网广播写死为 /24)。
fn get_network_interfaces() -> Vec<(String, std::net::Ipv4Addr, std::net::Ipv4Addr)> {
    let mut list = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let if_addrs::IfAddr::V4(v4) = iface.addr else { continue };
        let ip = v4.ip;
        if !network::usable_ipv4(ip) {
            continue;
        }
        list.push((iface.name, ip, network::effective_mask(ip, v4.netmask)));
    }
    list
}

fn get_lan_interfaces() -> Vec<(String, std::net::Ipv4Addr, std::net::Ipv4Addr)> {
    get_network_interfaces().into_iter()
        .map(|(name, ip, mask)| (name, ip, network::broadcast(ip, mask))).collect()
}

fn get_all_lan_ips() -> Vec<LocalIpInfo> {
    // No address cache: USB adapters can appear or receive APIPA after the app starts.
    let mut list = Vec::new();
    for (name, ipv4, _) in get_network_interfaces() {
        let lower_name = name.to_lowercase();
        let is_virtual = lower_name.contains("vethernet")
            || lower_name.contains("wsl")
            || lower_name.contains("virtual")
            || lower_name.contains("vmnet")
            || lower_name.contains("docker");
        let is_lan = ipv4.is_private() || ipv4.is_link_local();
        list.push(LocalIpInfo {
            ip: ipv4.to_string(), name, is_preferred: is_lan && !is_virtual,
        });
    }

    // 优先将真正的 WiFi / 局域网物理网卡排在最前
    list.sort_by_key(|item| std::cmp::Reverse(item.is_preferred));

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
async fn get_local_ip(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_local_ip_blocking(state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))
}

fn get_local_ip_blocking(state: Arc<AppState>) -> String {
    let ips = get_all_lan_ips();
    state.selected_ip.lock().unwrap().clone()
        .filter(|selected| ips.iter().any(|item| &item.ip == selected))
        .unwrap_or_else(|| ips[0].ip.clone())
}

#[tauri::command]
async fn get_all_lan_ips_cmd() -> Vec<LocalIpInfo> {
    tauri::async_runtime::spawn_blocking(get_all_lan_ips_cmd_blocking)
        .await
        .unwrap_or_default()
}

fn get_all_lan_ips_cmd_blocking() -> Vec<LocalIpInfo> {
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
async fn add_share_file(path_str: String, state: tauri::State<'_, Arc<AppState>>) -> Result<SharedFile, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || add_share_file_blocking(path_str, state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn add_share_file_blocking(path_str: String, state: Arc<AppState>) -> Result<SharedFile, String> {
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
async fn save_file_to_directory(dir_path: String, folder_name: String, file_name: String, bytes_base64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_file_to_directory_blocking(dir_path, folder_name, file_name, bytes_base64))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn save_file_to_directory_blocking(dir_path: String, folder_name: String, file_name: String, bytes_base64: String) -> Result<String, String> {
    let base_dir = PathBuf::from(&dir_path);
    let target_dir = base_dir.join(&folder_name);
    if !target_dir.exists() {
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建文件夹失败: {}", e))?;
    }

    // 只取路径末端作为文件名，并清理 Windows 非法/保留名，避免越权写入目录之外
    let safe_name = sanitize_file_name(&file_name);
    // 不覆盖同名文件：追加 " (1)"、" (2)" 后缀
    let file_path = unique_target_path(&target_dir, &safe_name);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    let mut file = File::create(&file_path).map_err(|e| format!("写入文件失败: {}", e))?;
    if let Err(e) = file.write_all(&bytes) {
        drop(file);
        let _ = std::fs::remove_file(&file_path);
        return Err(format!("写入文件内容失败: {}", e));
    }

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
    let dev_name = creator_name.filter(|s| !s.trim().is_empty()).unwrap_or_else(whoami_device_name);
    let platform = creator_platform.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| desktop_platform().to_string());
    let primary_ip = host_ip.filter(|s| !s.trim().is_empty())
        .or_else(|| state.selected_ip.lock().unwrap().clone())
        .unwrap_or_else(get_primary_ip);
    *state.selected_ip.lock().unwrap() = Some(primary_ip.clone());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let clean_pin = pin.trim().to_string();
    let need_password = !clean_pin.is_empty();

    let clean_name = if room_name.trim().is_empty() {
        format!("WenBox-{}", uuid::Uuid::new_v4().to_string()[..4].to_uppercase())
    } else {
        room_name.trim().to_string()
    };
    // room_id 必须是唯一标识：设备名可能重复，两台 Mac 会互相不可见 (S6)
    let room_id = uuid::Uuid::new_v4().to_string();

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
        auto_connect: false,
    };

    *state.room.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    // 房主自身加入 member
    let host_token = uuid::Uuid::new_v4().to_string();
    *state.host_token.lock().unwrap_or_else(|e| e.into_inner()) = host_token.clone();
    *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner()) = true;
    *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = now;
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(host_token);
    let host_member = RoomMember {
        // 成员 id 与房主 token 分离，公开接口不再泄露房主凭证 (S2)
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} (房主)", dev_name),
        ip: primary_ip.clone(),
        platform,
        access_ip: format!("{}:9527", primary_ip),
        joined_at: now,
        last_seen: now,
    };
    state.members.lock().unwrap_or_else(|e| e.into_inner()).insert("host".into(), host_member);

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
    *state.host_token.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
    *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner()) = false;
    *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = 0;
    state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    // 与 HTTP 关房接口共用同一个逐网卡广播实现
    broadcast_room_closed(old_room_id);

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
        "autoConnect": room.auto_connect,
        "canAutoConnect": can_auto_connect(&state),
    })
}

fn can_auto_connect(state: &AppState) -> bool {
    let room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    room.is_active && room.auto_connect && !room.need_password
        && state.files.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
        && state.messages.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
        && !state.members.lock().unwrap_or_else(|e| e.into_inner()).iter()
            .any(|(key, member)| key != "host" && now.saturating_sub(member.last_seen) < 15)
}

#[tauri::command]
async fn get_discovered_rooms_cmd(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DiscoveredRoom>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_discovered_rooms_cmd_blocking(state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))
}

fn get_discovered_rooms_cmd_blocking(state: Arc<AppState>) -> Vec<DiscoveredRoom> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let self_ips: HashSet<String> = get_all_lan_ips().into_iter().map(|i| i.ip).collect();
    let cur_room_id = state.room.lock().unwrap_or_else(|e| e.into_inner()).room_id.clone();
    let mut disc = state.discovered_rooms.lock().unwrap_or_else(|e| e.into_inner());
    disc.retain(|_, r| {
        // 过滤自身广播：按本机网卡 IP 判断，不再依赖 room_id (S6)
        now.saturating_sub(r.last_seen) < 15
            && !self_ips.contains(&r.ip)
            && (cur_room_id.is_empty() || r.room_id != cur_room_id)
    });
    let mut list: Vec<DiscoveredRoom> = disc.values().cloned().collect();

    let my_room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let is_tauri_host = *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner());
    if my_room.is_active && !is_tauri_host {
        let (host_dev, host_plat) = {
            let members = state.members.lock().unwrap_or_else(|e| e.into_inner());
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
            auto_connect: false,
            can_auto_connect: false,
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
    static CLIENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1200))
        .timeout_read(Duration::from_millis(2000))
        .timeout_write(Duration::from_millis(2000))
        .timeout(Duration::from_millis(4000))
        .build()).clone()
}

// Stream transfers retain read/write timeouts without imposing a total file-size deadline.
fn get_stream_client() -> ureq::Agent {
    static CLIENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(120))
        .build()).clone()
}

fn desktop_platform() -> &'static str {
    if cfg!(target_os = "windows") { "Windows" }
    else if cfg!(target_os = "macos") { "macOS" }
    else { "Linux" }
}

#[tauri::command]
fn clear_chat_messages_cmd(state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();
    Ok(true)
}

#[tauri::command]
async fn join_remote_room_cmd(host_url: String, pin: String, my_name: String, expected_room_id: Option<String>, state: tauri::State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(expected) = expected_room_id {
            join_remote_room_expected(host_url, pin, my_name, state, Some(expected))
        } else {
            join_remote_room_cmd_blocking(host_url, pin, my_name, state)
        }
    })
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn join_remote_room_cmd_blocking(host_url: String, pin: String, my_name: String, state: Arc<AppState>) -> Result<serde_json::Value, String> {
    join_remote_room_expected(host_url, pin, my_name, state, None)
}

fn join_remote_room_expected(host_url: String, pin: String, my_name: String, state: Arc<AppState>, expected: Option<String>) -> Result<serde_json::Value, String> {
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
        "platform": desktop_platform(),
        "expectedRoomId": expected,
    });

    let client = get_http_client();
    let resp = client.post(&url)
        .set("Content-Type", "application/json; charset=utf-8")
        .send_string(&body.to_string());
    let resp = match resp {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(format!("连接房间失败: {}", error)),
    };

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析房间响应失败: {}", e))?;
    if expected.is_none() && val["success"].as_bool() == Some(true) {
        state.room.lock().unwrap_or_else(|e| e.into_inner()).auto_connect = false;
    }
    // Preserve structured PIN lockout metadata; joining another room does not clear our hosted history.
    Ok(val)
}

/// 全网广播目标地址列表（含逐网卡的真实子网广播地址）
fn get_all_broadcast_addrs() -> Vec<String> {
    let mut addrs = vec!["255.255.255.255:9528".to_string(), format!("{}:9528", MULTICAST_IPV4)];
    for (_name, _ip, broadcast) in get_lan_interfaces() {
        let target = format!("{}:9528", broadcast);
        if !addrs.contains(&target) {
            addrs.push(target);
        }
    }
    addrs
}

/// 逐网卡独立绑定发包的广播目标列表：(本地网卡 IP, 该网卡的子网广播地址)
fn get_per_interface_broadcasts() -> Vec<(std::net::Ipv4Addr, String)> {
    get_lan_interfaces()
        .into_iter()
        .map(|(_name, ip, broadcast)| (ip, format!("{}:9528", broadcast)))
        .collect()
}

/// 通知局域网内所有设备：某个房间已解散。
/// 关房命令与 HTTP 关房接口共用，并逐网卡发送 (Rust 其它: 原来只从 0.0.0.0 发一次)。
fn broadcast_room_closed(room_id: String) {
    thread::spawn(move || {
        if room_id.is_empty() {
            return;
        }
        let msg = serde_json::json!({
            "action": "wenbox_room_closed",
            "roomId": room_id
        }).to_string();
        let bytes = msg.as_bytes();

        let per_iface = get_per_interface_broadcasts();
        for (iface_ip, subnet_bcast) in &per_iface {
            if let Ok(socket) = UdpSocket::bind((*iface_ip, 0)) {
                let _ = socket.set_broadcast(true);
                let _ = socket.send_to(bytes, subnet_bcast.as_str());
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

fn is_loopback_ip(ip: &str) -> bool {
    ip == "127.0.0.1" || ip == "::1" || ip.starts_with("127.")
}

fn header_val(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().trim().to_string())
}

/// 判断 Host / Origin 里的主机名是否属于本机或局域网地址。
/// 用于阻断 DNS rebinding 与外部网页对 127.0.0.1 服务的读取 (S1)。
fn is_lan_or_loopback_host(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty() {
        return false;
    }
    // [::1]:9527 -> ::1 ；192.168.1.8:9527 -> 192.168.1.8
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        host
    };
    let bare = if host.contains(':') && !host.contains("::") {
        host.split(':').next().unwrap_or(host)
    } else {
        host
    };
    if bare.eq_ignore_ascii_case("localhost") || bare.eq_ignore_ascii_case("tauri.localhost") {
        return true;
    }
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(std::net::IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// 浏览器发来的 Origin 是否可信。非浏览器请求 (无 Origin，如局域网内的原生客户端、
/// curl) 一律放行；同源导航不受 CORS 约束，也无需拦截。
fn origin_allowed(req: &tiny_http::Request) -> bool {
    match header_val(req, "Origin") {
        None => true,
        Some(o) if o == "null" => false,
        Some(o) if o.starts_with("tauri://") || o.starts_with("https://tauri.localhost") => true,
        Some(o) => o.split("://").nth(1).map(is_lan_or_loopback_host).unwrap_or(false),
    }
}

fn host_allowed(req: &tiny_http::Request) -> bool {
    match header_val(req, "Host") {
        None => true,
        Some(h) => is_lan_or_loopback_host(&h),
    }
}

/// CORS 响应头：只回显已通过校验的 Origin，并声明 Vary: Origin，不再使用 `*` (S1)。
/// 返回 (Access-Control-Allow-Origin, Vary) 两个可选头。
fn cors_headers_for(req: &tiny_http::Request) -> (Option<Header>, Option<Header>) {
    let origin = match header_val(req, "Origin") {
        Some(o) if origin_allowed(req) => o,
        _ => return (None, None),
    };
    let allow = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], origin.as_bytes()).ok();
    let vary = Header::from_bytes(&b"Vary"[..], &b"Origin"[..]).ok();
    (allow, vary)
}

/// 判断请求是否来自"可信的本机调用"：回环地址 **且** Origin 通过校验，
/// 且 Origin 确实是本机自己的界面 (Tauri webview / 本机 loopback 网页)。
fn is_trusted_loopback(req: &tiny_http::Request) -> bool {
    let remote = get_clean_remote_ip(req);
    if !is_loopback_ip(&remote) {
        return false;
    }
    match header_val(req, "Origin") {
        None => true,
        Some(o) if o == "null" => false,
        Some(o) if o.starts_with("tauri://") || o.starts_with("https://tauri.localhost") => true,
        Some(o) => o.contains("127.0.0.1") || o.contains("localhost"),
    }
}

/// 请求是否携带当前房间的房主令牌
fn has_host_token(req: &tiny_http::Request, state: &AppState) -> bool {
    let current = state.host_token.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if current.is_empty() {
        return false;
    }
    let provided = header_val(req, "X-Host-Token")
        .or_else(|| header_val(req, "X-Room-Token"))
        .or_else(|| {
            req.url().find("token=").map(|pos| {
                req.url()[pos + 6..].split('&').next().unwrap_or("").trim().to_string()
            })
        });
    provided.map(|t| constant_time_eq(t.as_bytes(), current.as_bytes())).unwrap_or(false)
}

/// 常量时间比较，避免通过响应时间逐字节推断 PIN / 令牌 (S8)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 有上限地读取请求体。超过 max 返回 Err(413)，读取失败返回 Err(400) (S4)。
fn read_body_limited(req: &mut tiny_http::Request, max: u64) -> Result<String, u16> {
    if req.body_length().map(|len| len as u64 > max).unwrap_or(false) {
        return Err(413);
    }
    let mut raw = Vec::new();
    let mut limited = Read::take(req.as_reader(), max + 1);
    limited.read_to_end(&mut raw).map_err(|_| 400u16)?;
    if raw.len() as u64 > max {
        return Err(413);
    }
    String::from_utf8(raw).map_err(|_| 400u16)
}

/// 对外的文件描述：绝不把本机绝对路径 (含用户名) 序列化给客户端 (Rust 其它)。
fn public_file_view(file: &SharedFile) -> SharedFile {
    let mut view = file.clone();
    view.path = String::new();
    view
}

/// Windows 保留文件名 / 结尾点或空格在保存前加前缀，避免创建失败或文件不可见。
fn sanitize_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let mut cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "uploaded_file.bin".to_string();
    }
    // 结尾的点或空格在 Windows 上会被静默丢弃
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    if cleaned.is_empty() {
        return "uploaded_file.bin".to_string();
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// 在目标目录里挑一个不会覆盖既有文件的路径：name.ext -> name (1).ext -> name (2).ext
fn unique_target_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let name = std::path::Path::new(file_name);
    let stem = name.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let ext = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    for index in 1..1000u32 {
        let candidate = dir.join(format!("{} ({}).{}", stem, index, ext.trim_start_matches('.')));
        if !ext.is_empty() && !candidate.exists() {
            return candidate;
        }
        let candidate = dir.join(format!("{} ({})", stem, index));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}", stem, uuid::Uuid::new_v4()))
}

/// 由 PIN 明文派生的定长比较材料，配合 constant_time_eq 使用
fn pin_matches(expected: &str, provided: &str) -> bool {
    constant_time_eq(expected.trim().as_bytes(), provided.trim().as_bytes())
}

/// PIN 频控检查：返回当前是否允许尝试
fn pin_gate_check(state: &AppState, client_ip: &str) -> PinGate {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut map = state.pin_failures.lock().unwrap_or_else(|e| e.into_inner());
    let Some((last, count)) = map.get(client_ip).copied() else {
        return PinGate::Allowed;
    };
    if count < PIN_MAX_FAILURES {
        return PinGate::Allowed;
    }
    let elapsed = now.saturating_sub(last);
    if elapsed >= PIN_LOCK_SECS {
        map.remove(client_ip);
        PinGate::Allowed
    } else {
        PinGate::Locked(PIN_LOCK_SECS - elapsed)
    }
}

fn pin_gate_record_failure(state: &AppState, client_ip: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut map = state.pin_failures.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(client_ip.to_string()).or_insert((now, 0));
    if now.saturating_sub(entry.0) > PIN_LOCK_SECS {
        *entry = (now, 1);
    } else {
        entry.0 = now;
        entry.1 = entry.1.saturating_add(1);
    }
    // 避免计数表被无限撑大
    if map.len() > MAX_DEVICES {
        let stale: Vec<String> = map.iter()
            .filter(|(_, (last, _))| now.saturating_sub(*last) > PIN_LOCK_SECS)
            .map(|(ip, _)| ip.clone())
            .collect();
        for ip in stale {
            map.remove(&ip);
        }
    }
}

fn pin_gate_record_success(state: &AppState, client_ip: &str) {
    state.pin_failures.lock().unwrap_or_else(|e| e.into_inner()).remove(client_ip);
}

/// 追加当前消息后裁剪到上限，避免无界增长打爆内存 (S4)
fn push_message_bounded(messages: &Mutex<Vec<ChatMessage>>, msg: ChatMessage) {
    let mut guard = messages.lock().unwrap_or_else(|e| e.into_inner());
    guard.push(msg);
    if guard.len() > MAX_MESSAGES {
        let overflow = guard.len() - MAX_MESSAGES;
        guard.drain(..overflow);
    }
}


// 严格百分号解码 (不把 '+' 还原为空格)，用于路径中的文件 id
// 按字节解析十六进制，避免对 `&input[i+1..i+3]` 做字符串切片时遇到非 ASCII 边界 panic。
fn percent_decode_strict(input: &str) -> String {
    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
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
    let room = state.room.lock().unwrap_or_else(|e| e.into_inner());
    let (is_active, need_password) = (room.is_active, room.need_password);
    drop(room);
    if !is_active || !need_password {
        return true;
    }
    // 本机回环免鉴权，但必须是本机自己的界面发起：
    // 校验 Origin 与 Host，避免任意外部网页通过 fetch('http://127.0.0.1:9527/...')
    // 读到密码房的文件与聊天内容，同时阻断 DNS rebinding (S1)。
    if is_trusted_loopback(req) && origin_allowed(req) && host_allowed(req) {
        return true;
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
async fn connect_device_node(target: String, state: tauri::State<'_, Arc<AppState>>) -> Result<LanDevice, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect_device_node_blocking(target, state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

#[allow(clippy::result_large_err)]
fn connect_device_node_blocking(target: String, state: Arc<AppState>) -> Result<LanDevice, String> {
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
        "platform": desktop_platform(),
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
            "platform": desktop_platform(),
            "port": 9527
        }).to_string();
        let _ = socket.send_to(msg.as_bytes(), format!("{}:9528", ip_str));
    }

    Ok(node)
}

#[tauri::command]
async fn fetch_node_files(base_url: String, token: Option<String>, state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SharedFile>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || fetch_node_files_blocking(base_url, token, state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn fetch_node_files_blocking(base_url: String, token: Option<String>, state: Arc<AppState>) -> Result<Vec<SharedFile>, String> {
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
async fn save_remote_file_to_directory(download_url: String, dir_path: String, folder_name: String, file_name: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_remote_file_to_directory_blocking(download_url, dir_path, folder_name, file_name, token))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn save_remote_file_to_directory_blocking(download_url: String, dir_path: String, folder_name: String, file_name: String, token: Option<String>) -> Result<String, String> {
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

    let safe_name = sanitize_file_name(&file_name);
    // 不覆盖同名文件：File::create 会静默清空既有内容，改为冲突时追加序号
    let file_path = unique_target_path(&target_dir, &safe_name);
    let mut dest_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;

    let mut reader = resp.into_reader();
    if let Err(e) = std::io::copy(&mut reader, &mut dest_file) {
        drop(dest_file);
        // 清掉写了一半的文件，避免留下损坏的下载
        let _ = std::fs::remove_file(&file_path);
        return Err(format!("写入文件失败: {}", e));
    }
    drop(dest_file);
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn fetch_node_messages(base_url: String, token: Option<String>, since: Option<u64>, state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<ChatMessage>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || fetch_node_messages_blocking(base_url, token, since, state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn fetch_node_messages_blocking(base_url: String, token: Option<String>, since: Option<u64>, state: Arc<AppState>) -> Result<Vec<ChatMessage>, String> {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let since_ts = since.unwrap_or(0);
        let messages = state.messages.lock().unwrap_or_else(|e| e.into_inner());
        return Ok(messages.iter().filter(|m| since_ts == 0 || m.timestamp > since_ts).cloned().collect());
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
async fn send_node_message(base_url: String, sender_name: String, content: String, token: Option<String>, client_id: Option<String>, sender_ip: Option<String>, state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || send_node_message_blocking(base_url, sender_name, content, token, client_id, sender_ip, state))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn send_node_message_blocking(base_url: String, sender_name: String, content: String, token: Option<String>, client_id: Option<String>, sender_ip: Option<String>, state: Arc<AppState>) -> Result<bool, String> {
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
        push_message_bounded(&state.messages, msg);
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
            push_message_bounded(&state.messages, msg);
            Ok(true)
        }
        Err(e) => Err(format!("发送失败: {}", e)),
    }
}

#[tauri::command]
async fn upload_local_file_to_remote(target_base_url: String, file_path: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || upload_local_file_to_remote_blocking(target_base_url, file_path, token))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn upload_local_file_to_remote_blocking(target_base_url: String, file_path: String, token: Option<String>) -> Result<String, String> {
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

    // Chain multipart headers, the file, and the closing boundary without staging a second copy on disk.
    let file = File::open(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    let mut body = std::io::Cursor::new(head.into_bytes()).chain(file)
        .chain(std::io::Cursor::new(tail.into_bytes()));

    let mut req = get_stream_client().post(&url)
        .set("Content-Type", &content_type)
        .set("Content-Length", &body_len.to_string())
        .set("X-File-Name", &percent_encode_utf8(&file_name));
    if let Some(ref t) = token {
        if !t.is_empty() {
            req = req.set("X-Room-Token", t).set("X-Host-Token", t);
        }
    }

    let send_result = req.send(&mut body);

    match send_result {
        Ok(_) => Ok(format!("成功发送文件: {}", file_name)),
        Err(e) => Err(format!("向对方投送文件失败: {}", e)),
    }
}

// ---------------- 上传文件解析辅助函数 ----------------
#[cfg(test)]
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

    let content_start = if let Some(pos) = find_subsequence(body, b"\r\n\r\n") {
        pos + 4
    } else {
        find_subsequence(body, b"\n\n")? + 2
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

// Read only bounded multipart headers, then stream file bytes with a small boundary tail.
fn read_upload_header(reader: &mut dyn Read, boundary: &str) -> Result<String, String> {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 64 * 1024 { return Err("上传文件头过长".into()); }
        reader.read_exact(&mut byte).map_err(|e| format!("上传文件头不完整: {}", e))?;
        header.push(byte[0]);
    }
    if !header.starts_with(format!("--{}\r\n", boundary).as_bytes()) {
        return Err("上传边界无效".into());
    }
    let header = String::from_utf8(header).map_err(|_| "文件名编码无效".to_string())?;
    let name = header.split("filename=\"").nth(1)
        .and_then(|rest| rest.split('"').next()).filter(|name| !name.is_empty())
        .ok_or_else(|| "未找到上传文件名".to_string())?;
    Ok(name.to_string())
}

fn copy_upload_body(reader: &mut dyn Read, writer: &mut dyn Write, boundary: &str) -> Result<u64, String> {
    let delimiter = format!("\r\n--{}", boundary).into_bytes();
    let keep = delimiter.len() + 2;
    let mut pending = Vec::with_capacity(64 * 1024 + keep);
    let mut chunk = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("接收文件失败: {}", e))?;
        if n == 0 { return Err("上传中断，文件未接收完整".into()); }
        pending.extend_from_slice(&chunk[..n]);
        let mut offset = 0;
        while let Some(found) = find_subsequence(&pending[offset..], &delimiter) {
            let pos = offset + found;
            let suffix = pos + delimiter.len();
            if pending.len() < suffix + 2 { break; }
            if &pending[suffix..suffix + 2] == b"--" || &pending[suffix..suffix + 2] == b"\r\n" {
                writer.write_all(&pending[..pos]).map_err(|e| format!("保存文件失败: {}", e))?;
                written += pos as u64;
                // Drain any remaining multipart fields before responding / reusing the connection.
                std::io::copy(reader, &mut std::io::sink()).map_err(|e| e.to_string())?;
                return Ok(written);
            }
            offset = pos + 1;
        }
        if pending.len() > keep {
            let emit = pending.len() - keep;
            writer.write_all(&pending[..emit]).map_err(|e| format!("保存文件失败: {}", e))?;
            written += emit as u64;
            pending.drain(..emit);
        }
    }
}

fn receive_upload(req: &mut tiny_http::Request, download_dir: &std::path::Path,
    content_type: &str, supplied_name: Option<String>) -> Result<SharedFile, String> {
    std::fs::create_dir_all(download_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;
    let multipart = content_type.to_ascii_lowercase().starts_with("multipart/form-data");
    let boundary = if multipart {
        Some(content_type.split(';').skip(1).find_map(|parameter| {
            let (key, value) = parameter.trim().split_once('=')?;
            if key.eq_ignore_ascii_case("boundary") { Some(value.trim().trim_matches('"').to_string()) } else { None }
        }).filter(|value| !value.is_empty() && value.len() <= 200)
            .ok_or_else(|| "上传边界缺失或无效".to_string())?)
    } else { None };
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, req.as_reader());
    let header_name = if let Some(boundary) = &boundary { Some(read_upload_header(&mut reader, boundary)?) } else { None };
    let raw_name = supplied_name.or(header_name).unwrap_or_else(|| "uploaded_file.bin".into());
    let safe_name = raw_name.rsplit(['/', '\\']).next().filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .unwrap_or("uploaded_file.bin").chars().map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }
        }).collect::<String>();
    let id = uuid::Uuid::new_v4().to_string();
    let mut target_path = download_dir.join(&safe_name);
    let file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&target_path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let name = std::path::Path::new(&safe_name);
            let stem = name.file_stem().unwrap_or_default().to_string_lossy();
            let extension = name.extension().map(|ext| format!(".{}", ext.to_string_lossy())).unwrap_or_default();
            target_path = download_dir.join(format!("{}-{}{}", stem, &id[..8], extension));
            std::fs::OpenOptions::new().write(true).create_new(true).open(&target_path).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(format!("创建文件失败: {}", e)),
    };
    let mut writer = std::io::BufWriter::with_capacity(64 * 1024, file);
    let result = (|| {
        let size = if let Some(boundary) = &boundary { copy_upload_body(&mut reader, &mut writer, boundary)? }
            else { std::io::copy(&mut reader, &mut writer).map_err(|e| e.to_string())? };
        writer.flush().map_err(|e| e.to_string())?;
        Ok(size)
    })();
    drop(writer);
    let size = match result {
        Ok(size) => size,
        Err(error) => { let _ = std::fs::remove_file(&target_path); return Err(error); }
    };
    Ok(SharedFile {
        id, name: target_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        size, path: target_path.to_string_lossy().into_owned(),
        mime_type: mime_guess::from_path(&target_path).first_or_octet_stream().to_string(),
    })
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

        serve_http_requests(Arc::new(server), state, port);
    });
}

fn serve_http_requests(server: Arc<Server>, state: Arc<AppState>, port: u16) {
    use std::sync::mpsc::{sync_channel, TrySendError};
    let mut workers = Vec::new();
    let mut queues = Vec::new();
    // Control requests have dedicated workers so slow transfers cannot block heartbeats.
    for _ in 0..2 {
        let (sender, receiver) = sync_channel::<tiny_http::Request>(32);
        queues.push(sender);
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..4 {
            let receiver = receiver.clone();
            let state = state.clone();
            workers.push(thread::spawn(move || loop {
                let request = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok(request) = request else { break; };
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_http_request(request, state.clone(), port);
                })).is_err() {
                    eprintln!("HTTP 请求处理异常，工作线程继续运行");
                }
            }));
        }
    }
    for request in server.incoming_requests() {
        let transfer = request.method() != &Method::Options &&
            (request.url().split('?').next() == Some("/api/upload") || request.url().starts_with("/api/download/"));
        if let Err(TrySendError::Full(request) | TrySendError::Disconnected(request)) = queues[usize::from(transfer)].try_send(request) {
            // 队列已满：回显已校验的 Origin，并提示前端退避重试
            let (allow, vary) = cors_headers_for(&request);
            let mut response = Response::from_string("{\"success\":false,\"message\":\"请求较多，请稍后重试\"}").with_status_code(503);
            if let Some(h) = allow { response.add_header(h); }
            if let Some(h) = vary { response.add_header(h); }
            response.add_header(Header::from_bytes("Retry-After", "1").unwrap());
            let _ = request.respond(response);
        }
    }
    drop(queues);
    for worker in workers { let _ = worker.join(); }
}

fn handle_http_request(mut req: tiny_http::Request, state: Arc<AppState>, port: u16) {
    let raw_url = req.url().to_string();
    let url = raw_url.split('?').next().unwrap_or(&raw_url).to_string();
    let method = req.method().clone();

    // CORS: 只回显已通过校验的 Origin，不再使用 `*` (S1)
    let (cors_origin, cors_vary) = cors_headers_for(&req);
    let cors_methods = Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS, PUT, DELETE"[..]).unwrap();
    let cors_headers = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type, X-File-Name, Range, Authorization, X-Room-Token, X-Host-Token"[..]).unwrap();

    // 统一拦截：Origin 不属于本机/局域网的浏览器请求，以及 Host 指向外部域名的
    // 请求 (DNS rebinding)，全部 403。非浏览器客户端 (Android 原生、Rust 客户端、
    // curl) 不带 Origin，因此不受影响。
    if !origin_allowed(&req) || !host_allowed(&req) {
        let mut resp = Response::from_string(
            "{\"success\":false,\"forbidden\":true,\"message\":\"拒绝跨站访问：请通过本机界面或局域网地址访问\"}"
        ).with_status_code(403);
        if let Some(h) = cors_origin.clone() { resp.add_header(h); }
        if let Some(h) = cors_vary.clone() { resp.add_header(h); }
        let _ = req.respond(resp);
        return;
    }

    if method == Method::Options {
        let mut resp = Response::empty(200);
        if let Some(h) = cors_origin.clone() { resp.add_header(h); }
        if let Some(h) = cors_vary.clone() { resp.add_header(h); }
        resp.add_header(cors_methods);
        resp.add_header(cors_headers);
        let _ = req.respond(resp);
        return;
    }

    // 请求体超限统一返回 413 (S4)
    macro_rules! read_body {
        ($limit:expr) => {
            match read_body_limited(&mut req, $limit) {
                Ok(body) => body,
                Err(code) => {
                    let message = if code == 413 {
                        "{\"success\":false,\"message\":\"请求体过大\"}"
                    } else {
                        "{\"success\":false,\"message\":\"请求体无效\"}"
                    };
                    let mut resp = Response::from_string(message).with_status_code(code);
                    if let Some(h) = cors_origin.clone() { resp.add_header(h); }
                    if let Some(h) = cors_vary.clone() { resp.add_header(h); }
                    let _ = req.respond(resp);
                    return;
                }
            }
        };
    }

    // 统一附加 CORS 响应头 (回显 Origin + Vary)
    macro_rules! with_cors {
        ($resp:expr) => {{
            let mut resp = $resp;
            if let Some(h) = cors_origin.clone() { resp.add_header(h); }
            if let Some(h) = cors_vary.clone() { resp.add_header(h); }
            resp
        }};
    }

            // 0. 房间系统接口 (公开接口：查看状态、加入房间、心跳、成员与已发现房间)
            if (url == "/api/room/status" || url == "/api/room/info") && method == Method::Get {
                let room = state.room.lock().unwrap().clone();
                let members_count = state.members.lock().unwrap_or_else(|e| e.into_inner()).len();
                let primary_ip = state.selected_ip.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(get_primary_ip);
                let current_host_token = state.host_token.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let is_host = room.is_active && !current_host_token.is_empty() && req.headers().iter().any(|h| {
                    (h.field.equiv("X-Host-Token") || h.field.equiv("X-Room-Token"))
                        && constant_time_eq(h.value.as_str().trim().as_bytes(), current_host_token.as_bytes())
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
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/create" && method == Method::Post {
                let mut body = read_body!(CTRL_MAX);
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
                body.clear();

                let client_ip = get_clean_remote_ip(&req);
                let is_local = is_loopback_ip(&client_ip);
                let dev_name = creator_name_opt
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        if is_local { whoami_device_name() } else { "访客房主".into() }
                    });
                let platform_str = creator_platform_opt
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        if is_local { desktop_platform().to_string() } else { "Web".into() }
                    });

                let primary_ip = host_ip_opt
                    .or_else(|| state.selected_ip.lock().unwrap().clone())
                    .unwrap_or_else(get_primary_ip);
                *state.selected_ip.lock().unwrap() = Some(primary_ip.clone());
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let clean_pin = pin.trim().to_string();
                let need_password = !clean_pin.is_empty();
                let clean_name = if room_name.trim().is_empty() {
                    format!("WenBox-{}", uuid::Uuid::new_v4().to_string()[..4].to_uppercase())
                } else {
                    room_name.trim().to_string()
                };
                // 房间 ID 使用 UUID：设备名可能重复 (S6)，room_id 只作为唯一标识，
                // room_name 承担展示职责。
                let room_id = uuid::Uuid::new_v4().to_string();
                let host_token = uuid::Uuid::new_v4().to_string();
                let host_member_id = uuid::Uuid::new_v4().to_string();

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
                    auto_connect: false,
                };

                // 建房检查与写入必须在同一个 room 锁作用域内完成，否则两个并发请求
                // 会同时通过 is_active 检查并互相覆盖 (TOCTOU)。
                {
                    let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
                    if room.is_active {
                        let mut resp = Response::from_string(
                            "{\"success\":false,\"message\":\"本机已有进行中的房间，请直接加入该房间；如需另建新房间，请先由本机解散现有房间\"}"
                        ).with_status_code(409);
                        resp = with_cors!(resp);
                        resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                        let _ = req.respond(resp);
                        return;
                    }
                    *room = cfg.clone();
                }
                state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
                state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
                state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

                *state.host_token.lock().unwrap_or_else(|e| e.into_inner()) = host_token.clone();
                *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner()) = false;
                *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = now;
                state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(host_token.clone());

                let host_display_ip = if !is_local { client_ip.clone() } else { primary_ip.clone() };

                let host_member = RoomMember {
                    // 绝不把 hostToken 当成员 id：/api/room/members 是公开接口，
                    // 复用令牌会让任何访客直接拿到房主凭证 (S2)。
                    id: host_member_id.clone(),
                    name: format!("{} (房主)", dev_name),
                    ip: host_display_ip,
                    platform: platform_str,
                    access_ip: format!("{}:{}", primary_ip, port),
                    joined_at: now,
                    last_seen: now,
                };
                state.members.lock().unwrap_or_else(|e| e.into_inner()).insert("host".into(), host_member);

                let mut cfg_val = serde_json::to_value(&cfg).unwrap_or_default();
                if let Some(obj) = cfg_val.as_object_mut() {
                    obj.insert("hostToken".into(), serde_json::Value::String(host_token));
                    obj.insert("memberId".into(), serde_json::Value::String(host_member_id));
                }
                let json = cfg_val.to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
                resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/close" && method == Method::Post {
                let body = read_body!(CTRL_MAX);
                let provided_token = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    val["hostToken"].as_str().or(val["token"].as_str()).map(|s| s.to_string())
                } else {
                    None
                };

                let current_host_token = state.host_token.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let is_token_valid = !current_host_token.is_empty() && (
                    provided_token.map(|t| constant_time_eq(t.as_bytes(), current_host_token.as_bytes())).unwrap_or(false)
                    || has_host_token(&req, &state)
                );

                if !is_token_valid {
                    let mut resp = Response::from_string("{\"success\":false,\"message\":\"无权解散房间：只有房主设备可以解散房间\"}")
                        .with_status_code(403);
                    resp = with_cors!(resp);
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
                *state.host_token.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
                *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner()) = false;
                *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = 0;
                state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
                state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
                state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

                // 逐网卡广播关房通知 (原来只从 0.0.0.0 发一次)
                broadcast_room_closed(old_room_id);

                let mut resp = Response::from_string("{\"success\":true}");
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url.starts_with("/api/room/set_ip") && method == Method::Post {
                // 只有本机可信回环调用或持有房主令牌的请求才能改变对外宣告的 IP，
                // 否则任意访客都能把房间地址劫持到别的机器 (S5)。
                let body = read_body!(CTRL_MAX);
                let requested = serde_json::from_str::<serde_json::Value>(&body).ok()
                    .and_then(|val| val["ip"].as_str().map(|ip| ip.trim().to_string()));
                let Some(clean) = requested.filter(|ip| !ip.is_empty()) else {
                    let mut resp = Response::from_string("{\"success\":false,\"message\":\"缺少 ip 字段\"}")
                        .with_status_code(400);
                    resp = with_cors!(resp);
                    let _ = req.respond(resp);
                    return;
                };

                let ip_is_local = get_all_lan_ips().iter().any(|i| i.ip == clean);
                if !(is_trusted_loopback(&req) || has_host_token(&req, &state)) || !ip_is_local {
                    let mut resp = Response::from_string(
                        "{\"success\":false,\"message\":\"无权修改房间地址，或该 IP 不属于本机网卡\"}"
                    ).with_status_code(403);
                    resp = with_cors!(resp);
                    let _ = req.respond(resp);
                    return;
                }

                *state.selected_ip.lock().unwrap_or_else(|e| e.into_inner()) = Some(clean.clone());
                {
                    let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
                    room.host_ip = clean.clone();
                }
                if let Some(host_member) = state.members.lock().unwrap_or_else(|e| e.into_inner()).get_mut("host") {
                    host_member.ip = clean.clone();
                    host_member.access_ip = format!("{}:{}", clean, port);
                }
                let mut resp = Response::from_string("{\"success\":true}");
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/join" && method == Method::Post {
                let body = read_body!(CTRL_MAX);
                let mut success = false;
                let mut msg = String::new();
                let mut token_str = String::new();
                let mut member_id = String::new();
                let mut locked_secs = 0u64;
                let mut room_info = serde_json::Value::Null;

                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let pin = val["pin"].as_str().unwrap_or("").trim().to_string();
                    let name = val["name"].as_str().unwrap_or("访客设备").to_string();
                    let plat = val["platform"].as_str().unwrap_or("Browser").to_string();
                    let client_ip = get_clean_remote_ip(&req);

                    // PIN 频控：连续失败 5 次锁定 60 秒 (S8)
                    match pin_gate_check(&state, &client_ip) {
                        PinGate::Locked(rest) => {
                            locked_secs = rest;
                            msg = format!("尝试过多，请 {} 秒后再试", rest);
                        }
                        PinGate::Allowed => {
                            let room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            if !room.is_active {
                                msg = "房间尚未开启或已解散".into();
                            } else if val["expectedRoomId"].as_str().map(|id| id != room.room_id || !room.auto_connect).unwrap_or(false) {
                                msg = "对端房间已变更，等待重新发现".into();
                            } else if room.need_password && !pin_matches(&room.pin, &pin) {
                                pin_gate_record_failure(&state, &client_ip);
                                msg = "房间密码错误".into();
                            } else {
                                pin_gate_record_success(&state, &client_ip);
                                success = true;
                                let token = uuid::Uuid::new_v4().to_string();
                                token_str = token.clone();
                                state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(token.clone());

                                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                let clean_name = name.trim();
                                let display_name = if clean_name.is_empty() {
                                    "访客设备".to_string()
                                } else {
                                    clean_name.to_string()
                                };

                                let access_host = header_val(&req, "Host")
                                    .unwrap_or_else(|| format!("{}:9527", client_ip));

                                let new_member_id = uuid::Uuid::new_v4().to_string();
                                member_id = new_member_id.clone();
                                let member = RoomMember {
                                    id: new_member_id,
                                    name: display_name,
                                    ip: client_ip.clone(),
                                    platform: plat,
                                    access_ip: access_host,
                                    joined_at: now,
                                    last_seen: now,
                                };
                                state.members.lock().unwrap_or_else(|e| e.into_inner()).insert(token, member);

                                let host_ip_to_show = state.selected_ip.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(get_primary_ip);
                                room_info = serde_json::json!({
                                    "roomId": room.room_id,
                                    "roomName": room.room_name,
                                    "hostDevice": room.host_device,
                                    "hostIp": host_ip_to_show,
                                    "hostPort": port,
                                    "autoConnect": room.auto_connect,
                                });
                            }
                        }
                    }
                }

                let status = if locked_secs > 0 { 429 } else { 200 };
                let json = serde_json::json!({
                    "success": success,
                    "message": msg,
                    "token": token_str,
                    // 成员 id 与 token 分离：Web 端"哪条消息是我发的"必须用 memberId (S2)
                    "memberId": member_id,
                    "retryAfter": locked_secs,
                    "room": room_info
                }).to_string();
                let mut resp = Response::from_string(json).with_status_code(status);
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/heartbeat" && method == Method::Post {
                let client_ip = get_clean_remote_ip(&req);
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

                let token_header = header_val(&req, "X-Room-Token");
                let access_host = header_val(&req, "Host").unwrap_or_default();

                let body = read_body!(CTRL_MAX);
                let (client_name, client_plat, client_token) = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let n = val["name"].as_str().map(|s| s.to_string());
                    let p = val["platform"].as_str().map(|s| s.to_string());
                    let t = val["token"].as_str()
                        .filter(|s| !s.trim().is_empty() && s.trim() != "host")
                        .map(|s| s.trim().to_string())
                        .or(token_header);
                    (n, p, t)
                } else {
                    (None, None, token_header)
                };

                let room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let mut members = state.members.lock().unwrap_or_else(|e| e.into_inner());
                let mut member_id = String::new();

                if let Some(ref t) = client_token {
                    // 保留键 "host" 绝不能被当成普通成员 token 覆盖 (S3)
                    if t == "host" {
                        // 忽略
                    } else {
                        let cur_host = state.host_token.lock().unwrap_or_else(|e| e.into_inner()).clone();
                        let is_host_token = !cur_host.is_empty() && constant_time_eq(t.as_bytes(), cur_host.as_bytes());
                        if is_host_token {
                            *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = now;
                            if let Some(m) = members.get_mut("host") {
                                m.last_seen = now;
                                member_id = m.id.clone();
                                if !is_loopback_ip(&client_ip) {
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
                            member_id = m.id.clone();
                            if !access_host.is_empty() {
                                m.access_ip = access_host.clone();
                            }
                            if let Some(ref n) = client_name {
                                let clean_n = n.trim();
                                if !clean_n.is_empty() {
                                    m.name = clean_n.to_string();
                                }
                            }
                        } else if state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).contains(t) {
                            let display_name = client_name.unwrap_or_else(|| "访客设备".into());
                            let platform = client_plat.unwrap_or_else(|| "Client".into());
                            let new_id = uuid::Uuid::new_v4().to_string();
                            member_id = new_id.clone();
                            let member = RoomMember {
                                id: new_id,
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
                }
                drop(members);

                let json = serde_json::json!({
                    "success": true,
                    "memberId": member_id,
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "hostDevice": room.host_device,
                        "needPassword": room.need_password
                    }
                }).to_string();

                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/leave" && method == Method::Post {
                let body = read_body!(CTRL_MAX);
                let token_header = header_val(&req, "X-Room-Token");
                let token = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["token"].as_str().map(|s| s.to_string()))
                    .or(token_header);
                if let Some(t) = token {
                    // "host" 是房主的保留键：未鉴权的请求不得借此把房主踢出成员列表 (S3)
                    if t != "host" && !t.trim().is_empty() {
                        state.members.lock().unwrap_or_else(|e| e.into_inner()).remove(&t);
                        state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).remove(&t);
                    }
                }
                let mut resp = Response::from_string("{\"success\":true}");
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            if url == "/api/room/members" && method == Method::Get {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                // 成员超时清理时同时回收 auth_tokens，避免已退出成员的旧令牌永久有效 (S3)
                let expired: Vec<String> = {
                    let mut members_map = state.members.lock().unwrap_or_else(|e| e.into_inner());
                    let expired: Vec<String> = members_map.iter()
                        .filter(|(k, m)| *k != "host" && now.saturating_sub(m.last_seen) >= 15)
                        .map(|(k, _)| k.clone())
                        .collect();
                    members_map.retain(|k, m| k == "host" || now.saturating_sub(m.last_seen) < 15);
                    expired
                };
                if !expired.is_empty() {
                    let mut tokens = state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner());
                    for token in expired {
                        tokens.remove(&token);
                    }
                }

                // 成员 id 已与 auth token 解耦，但密码房仍只向已加入的客户端返回详细列表，
                // 未授权访客只能拿到在线人数 (S2)。
                let authorized = is_authorized(&req, &state);
                let members_map = state.members.lock().unwrap_or_else(|e| e.into_inner());
                let mut list: Vec<RoomMember> = members_map.values().cloned().collect();
                list.sort_by_key(|m| m.joined_at);
                let json = if authorized {
                    serde_json::json!({ "members": list, "count": list.len() }).to_string()
                } else {
                    serde_json::json!({ "members": Vec::<RoomMember>::new(), "count": list.len() }).to_string()
                };
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
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
                        auto_connect: false,
                        can_auto_connect: false,
                    });
                }

                let json = serde_json::json!({ "rooms": list }).to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
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
                    "platform": desktop_platform(),
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "needPassword": room.need_password
                    }
                }).to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
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
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 2.5 节点主动探测握手
            if url == "/api/probe" && method == Method::Post {
                let body = read_body!(CTRL_MAX);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = val["device"].as_str().unwrap_or("Android手机").to_string();
                    let plat = val["platform"].as_str().unwrap_or("Android").to_string();
                    let p = val["port"].as_u64().unwrap_or(9527) as u16;
                    // 一律以 TCP 对端地址为准，不再信任 body 里自报的 ip (Rust 其它)：
                    // 否则任意客户端可以把设备列表伪造成局域网内其它主机。
                    let ip = get_clean_remote_ip(&req);

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
                    let mut devices = state.devices.lock().unwrap_or_else(|e| e.into_inner());
                    devices.retain(|_, d| now.saturating_sub(d.last_seen) < 15);
                    // 设备表上限，避免被探测包撑爆内存 (S4)
                    if devices.len() < MAX_DEVICES || devices.contains_key(&key) {
                        devices.insert(key, node);
                    }
                }

                let primary_ip = state.selected_ip.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(get_primary_ip);
                let dev_name = whoami_device_name();
                let room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let json = serde_json::json!({
                    "device": dev_name,
                    "ip": primary_ip,
                    "all_ips": get_all_lan_ips(),
                    "port": port,
                    "running": true,
                    "platform": desktop_platform(),
                    "room": {
                        "isActive": room.is_active,
                        "roomId": room.room_id,
                        "roomName": room.room_name,
                        "needPassword": room.need_password
                    }
                }).to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 鉴权拦截检查 (当房间处于活跃且设置密码保护时，未授权的客户端拒绝访问敏感文件与消息接口)
            let is_protected = url.starts_with("/api/files")
                || url.starts_with("/api/download/")
                || url == "/api/upload"
                || url == "/api/received_files"
                || url.starts_with("/api/messages");

            if is_protected && !is_authorized(&req, &state) {
                let mut resp = Response::from_string("{\"success\":false,\"unauthorized\":true,\"message\":\"未授权：请先输入房间密码加入房间\"}")
                    .with_status_code(401);
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 3. 待发文件列表 (对外清空绝对路径，避免泄露本机用户名与目录结构)
            if url.starts_with("/api/files") && method == Method::Get {
                let files_map = state.files.lock().unwrap_or_else(|e| e.into_inner());
                let list: Vec<SharedFile> = files_map.values().map(public_file_view).collect();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 3.1 清空待发文件：仅限 POST + 房主令牌
            if url == "/api/files/clear" {
                if method != Method::Post || !has_host_token(&req, &state) {
                    let mut resp = Response::from_string("{\"success\":false,\"message\":\"无权清空共享列表：仅限房主操作\"}")
                        .with_status_code(403);
                    resp = with_cors!(resp);
                    let _ = req.respond(resp);
                    return;
                }
                state.files.lock().unwrap_or_else(|e| e.into_inner()).clear();
                let mut resp = Response::from_string("{\"success\":true}");
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 3.2 接收到的文件列表 (对外清空绝对路径)
            if url == "/api/received_files" && method == Method::Get {
                let list: Vec<SharedFile> = state.received_files.lock().unwrap_or_else(|e| e.into_inner())
                    .iter().map(public_file_view).collect();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp = with_cors!(resp);
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
                        resp = with_cors!(resp);
                        let _ = req.respond(resp);
                        return;
                    }
                }
                let mut resp = Response::from_string("File Not Found").with_status_code(404);
                resp = with_cors!(resp);
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

                match receive_upload(&mut req, &download_dir, &content_type, x_filename) {
                    Ok(file) => {
                        // 不再自动把刚收到的文件放进"共享给全房间"的列表：
                        // 否则访客发给房主的私密文件会对所有成员公开 (Rust 其它)。
                        state.received_files.lock().unwrap_or_else(|e| e.into_inner()).insert(0, file.clone());
                        let json = serde_json::json!({
                            "success": true, "message": format!("文件已保存: {}", file.name),
                            "fileId": file.id, "name": file.name, "size": file.size
                        }).to_string();
                        let mut resp = Response::from_string(json);
                        resp = with_cors!(resp);
                        let _ = req.respond(resp);
                        return;
                    }
                    Err(error) => eprintln!("接收上传失败: {}", error),
                }

                let mut resp = Response::from_string("{\"success\":false,\"message\":\"保存文件失败\"}").with_status_code(500);
                resp = with_cors!(resp);
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
                    let since_ts = raw_url.split('?').nth(1).and_then(|q| {
                        q.split('&').find_map(|pair| {
                            let mut kv = pair.splitn(2, '=');
                            match (kv.next(), kv.next()) {
                                (Some("since"), Some(v)) => v.parse::<u64>().ok(),
                                _ => None,
                            }
                        })
                    }).unwrap_or(0);
                    let msgs: Vec<ChatMessage> = state.messages.lock().unwrap_or_else(|e| e.into_inner())
                        .iter().filter(|m| since_ts == 0 || m.timestamp > since_ts).cloned().collect();
                    let json = serde_json::json!({
                        "messages": msgs,
                        "roomId": room_id,
                        "isActive": is_active
                    }).to_string();
                    let mut resp = Response::from_string(json);
                    resp.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
                    resp = with_cors!(resp);
                    let _ = req.respond(resp);
                    return;
                } else if method == Method::Post {
                    let body = read_body!(MSG_MAX);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                        let content = val["content"].as_str().unwrap_or("").to_string();
                        let sender_name = val["senderName"].as_str().unwrap_or("未知用户").to_string();
                        let sender_ip_field = val["senderIp"].as_str().unwrap_or("").trim().to_string();
                        let remote_ip = get_clean_remote_ip(&req);
                        let sender_ip = if !sender_ip_field.is_empty() {
                            sender_ip_field
                        } else if is_loopback_ip(&remote_ip) {
                            state.selected_ip.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| {
                                let r = state.room.lock().unwrap_or_else(|e| e.into_inner());
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
                        // 只保留最近 MAX_MESSAGES 条，避免消息历史无界增长打爆内存 (S4)
                        push_message_bounded(&state.messages, msg);

                        if let Some(t) = header_val(&req, "X-Room-Token") {
                            let mut members = state.members.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(m) = members.get_mut(&t) {
                                m.last_seen = now_ms / 1000;
                            }
                        }
                    }
                    let mut resp = Response::from_string("{\"success\":true}");
                    resp = with_cors!(resp);
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
                resp = with_cors!(resp);
                let _ = req.respond(resp);
                return;
            }

            // 默认返回 404
            let mut resp = Response::empty(404);
            resp = with_cors!(resp);
            let _ = req.respond(resp);
}

// ---------------- UDP 局域网多网卡自发现与主动探测机制 (9528) ----------------
const MULTICAST_IPV4: &str = "239.255.255.250";
const DISCOVERY_PORT: u16 = 9528;

fn get_ipv4_interfaces() -> Vec<(String, std::net::Ipv4Addr)> {
    get_network_interfaces().into_iter().map(|(name, ip, _)| (name, ip)).collect()
}


#[tauri::command]
async fn send_room_probe_cmd() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(send_room_probe_cmd_blocking)
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

fn send_room_probe_cmd_blocking() -> Result<bool, String> {
    let msg = serde_json::json!({
        "action": "wenbox_search_room"
    }).to_string();
    let bytes = msg.as_bytes();

    for (iface_ip, subnet_bcast) in get_per_interface_broadcasts() {
        if let Ok(socket) = network::discovery_sender(iface_ip) {
            let _ = socket.send_to(bytes, subnet_bcast.as_str());
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
        let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
        let mcast_addr = MULTICAST_IPV4.parse::<std::net::Ipv4Addr>().unwrap();
        let mut joined_interfaces = HashSet::new();
        let mut refreshed_at = None::<std::time::Instant>;

        let mut buf = [0u8; 2048];
        loop {
            if refreshed_at.map(|at| at.elapsed() >= Duration::from_secs(1)).unwrap_or(true) {
                let current = get_ipv4_interfaces().into_iter().map(|(_, ip)| ip).collect();
                network::refresh_memberships(&socket, mcast_addr, &mut joined_interfaces, &current);
                refreshed_at = Some(std::time::Instant::now());
            }
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

                            // 检查是否为自己发送的广播。room_id 现在是 UUID，因此必须同时
                            // 比对"本机当前房间 + 来源为本机网卡"，否则自己的房间会被自己发现 (S6)。
                            let my_room = state_recv.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
                            let is_my_active_room = my_room.is_active && my_room.room_id == room_id;
                            let self_ips: Vec<String> = get_all_lan_ips().into_iter().map(|item| item.ip).collect();
                            let is_self_ip = self_ips.iter().any(|self_ip| *self_ip == ip || *self_ip == src.ip().to_string());

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
                                    auto_connect: val["autoConnect"].as_bool().unwrap_or(false),
                                    can_auto_connect: val["canAutoConnect"].as_bool().unwrap_or(true),
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
                                let interfaces = get_network_interfaces().into_iter()
                                    .map(|(_, ip, mask)| (ip, mask)).collect::<Vec<_>>();
                                let matched = match src.ip() {
                                    std::net::IpAddr::V4(ip) => network::matching_interface(ip, &interfaces),
                                    _ => None,
                                };
                                let matched_iface_ip = matched.map(|ip| ip.to_string())
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
                                    "autoConnect": my_room.auto_connect,
                                    "canAutoConnect": can_auto_connect(&state_recv),
                                    "memberCount": member_count
                                }).to_string();

                                // 同时向对方来源端口以及 9528 发送单播回包，防止对端临时端口已关闭
                                let reply_socket = matched.and_then(|ip| network::discovery_sender(ip).ok());
                                let reply_socket = reply_socket.as_ref().unwrap_or(&socket);
                                let _ = reply_socket.send_to(reply.as_bytes(), src);
                                let _ = reply_socket.send_to(reply.as_bytes(), (src.ip(), DISCOVERY_PORT));
                            }
                        }

                        // 3. 房间解散通知
                        if action == "wenbox_room_closed" {
                            let closed_room_id = val["roomId"].as_str().unwrap_or("");
                            let sender_ip = src.ip().to_string();
                            let mut rooms = state_recv.discovered_rooms.lock().unwrap_or_else(|e| e.into_inner());
                            // 只移除"该 room_id 且来自该发送方"的条目，避免误删同名房间 (S6)
                            rooms.retain(|_k, v| !(v.room_id == closed_room_id && v.ip == sender_ip));
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
            // Probe even while hosting. Both clients start as hosts, and adapters may arrive later.
            let _ = send_room_probe_cmd_blocking();
            // 浏览器建房的场景：房主关掉页面后没有人再发心跳，房间会永远挂着。
            // 非 Tauri 房主超过 BROWSER_HOST_TIMEOUT_SECS 未心跳即自动关房。
            {
                let is_tauri_host = *state_bcast.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner());
                let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let host_seen = *state_bcast.host_last_seen.lock().unwrap_or_else(|e| e.into_inner());
                let room_active = state_bcast.room.lock().unwrap_or_else(|e| e.into_inner()).is_active;
                if room_active && !is_tauri_host && host_seen > 0
                    && now_secs.saturating_sub(host_seen) > BROWSER_HOST_TIMEOUT_SECS
                {
                    let closed_id = {
                        let mut room = state_bcast.room.lock().unwrap_or_else(|e| e.into_inner());
                        let id = room.room_id.clone();
                        *room = RoomConfig::default();
                        id
                    };
                    *state_bcast.host_token.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
                    *state_bcast.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = 0;
                    state_bcast.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    state_bcast.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    state_bcast.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    broadcast_room_closed(closed_id);
                }
            }

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
                let per_interface = get_per_interface_broadcasts();

                // 针对每一个网卡独立绑定 socket 发送，彻底解决多网卡（WiFi+网口）路由限制
                for (iface_ip, subnet_bcast) in &per_interface {
                    if let Ok(socket) = network::discovery_sender(*iface_ip) {

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
                            "autoConnect": room.auto_connect,
                            "canAutoConnect": can_auto_connect(&state_bcast),
                            "memberCount": member_count
                        }).to_string();

                        let bytes = msg.as_bytes();
                        let _ = socket.send_to(bytes, subnet_bcast.as_str());
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
                                "autoConnect": room.auto_connect,
                                "canAutoConnect": can_auto_connect(&state_bcast),
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
    // GUI 启动时 COMPUTERNAME / HOSTNAME 往往为空，macOS 需要显式查询 ComputerName，
    // 否则所有 Mac 都会退化成同一个 "macOS电脑" 名字 (S6)。
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("scutil").arg("--get").arg("ComputerName").output() {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !name.is_empty() {
                    return name;
                }
            }
        }
    }

    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    if let Ok(name) = hostname::get() {
        let name = name.to_string_lossy().trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    format!("{}电脑", desktop_platform())
}

// 打开软件即自动创建的默认免密房间 (设备所有者身份, 可随时解散后改建密码房)
fn start_default_open_room(state: &Arc<AppState>) {
    let dev_name = whoami_device_name();
    let primary_ip = get_primary_ip();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let room_name = format!("WenBox·{}", dev_name);
    let cfg = RoomConfig {
        is_active: true,
        // 唯一 room_id，避免同名设备互相过滤导致"发现房间"里看不到对方 (S6)
        room_id: uuid::Uuid::new_v4().to_string(),
        room_name: room_name.clone(),
        pin: String::new(),
        need_password: false,
        host_device: dev_name.clone(),
        host_ip: primary_ip.clone(),
        host_port: 9527,
        created_at: now,
        auto_connect: true,
    };

    *state.room.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    state.members.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.messages.lock().unwrap_or_else(|e| e.into_inner()).clear();

    let host_token = uuid::Uuid::new_v4().to_string();
    *state.host_token.lock().unwrap_or_else(|e| e.into_inner()) = host_token.clone();
    *state.is_tauri_host.lock().unwrap_or_else(|e| e.into_inner()) = true;
    *state.host_last_seen.lock().unwrap_or_else(|e| e.into_inner()) = now;
    state.auth_tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(host_token.clone());

    let host_member = RoomMember {
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} (房主)", dev_name),
        ip: primary_ip.clone(),
        platform: desktop_platform().to_string(),
        access_ip: format!("{}:9527", primary_ip),
        joined_at: now,
        last_seen: now,
    };
    state.members.lock().unwrap().insert("host".into(), host_member);

    println!("已自动创建免密房间「{}」，局域网内可通过 http://{}:9527 直接加入", room_name, primary_ip);
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
        host_last_seen: Mutex::new(0),
        pin_failures: Mutex::new(HashMap::new()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_direct_pairing_only_leaves_untouched_startup_rooms() {
        let state = protected_state();
        assert!(!can_auto_connect(&state));
        {
            let mut room = state.room.lock().unwrap();
            room.auto_connect = true;
            room.need_password = false;
            room.pin.clear();
        }
        assert!(!can_auto_connect(&state), "shared files must keep the local room in place");
        state.files.lock().unwrap().clear();
        assert!(!can_auto_connect(&state), "pre-existing messages also keep the room in place");
        state.messages.lock().unwrap().clear();
        assert!(can_auto_connect(&state));
        state.messages.lock().unwrap().push(ChatMessage {
            id: "message".into(), sender_name: "房主".into(), content: "工作记录".into(),
            timestamp: 0, is_from_phone: false, sender_ip: String::new(), client_id: None,
        });
        assert!(!can_auto_connect(&state), "existing conversations must stay visible");
        state.messages.lock().unwrap().clear();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        state.members.lock().unwrap().insert("guest".into(), RoomMember {
            id: "guest-id".into(), name: "同事".into(), ip: "169.254.8.8".into(),
            platform: "Windows".into(), access_ip: "169.254.18.3:9527".into(),
            joined_at: now, last_seen: now,
        });
        assert!(!can_auto_connect(&state), "an online peer must not be abandoned");
        state.members.lock().unwrap().get_mut("guest").unwrap().last_seen = now - 16;
        assert!(can_auto_connect(&state), "a disconnected peer must not block recovery forever");
        state.room.lock().unwrap().is_active = false;
        assert!(!can_auto_connect(&state));
    }

    #[test]
    fn test_automatic_join_rejects_stale_or_manually_replaced_rooms() {
        let host = protected_state();
        {
            let mut room = host.room.lock().unwrap();
            room.auto_connect = true;
            room.need_password = false;
            room.pin.clear();
        }
        let port = spawn_test_server(host.clone());
        let local = protected_state();
        let url = format!("http://127.0.0.1:{}", port);
        let tokens_before = host.auth_tokens.lock().unwrap().len();
        let stale = join_remote_room_expected(url.clone(), String::new(), "访客".into(), local.clone(), Some("old-room-id".into())).unwrap();
        assert_eq!(stale["success"], false);
        assert_eq!(host.auth_tokens.lock().unwrap().len(), tokens_before);
        host.room.lock().unwrap().auto_connect = false;
        let replaced = join_remote_room_expected(url.clone(), String::new(), "访客".into(), local.clone(), Some("room-uuid".into())).unwrap();
        assert_eq!(replaced["success"], false);
        host.room.lock().unwrap().auto_connect = true;
        let current = join_remote_room_expected(url, String::new(), "访客".into(), local, Some("room-uuid".into())).unwrap();
        assert_eq!(current["success"], true);
        assert_eq!(current["room"]["roomId"], "room-uuid");
    }

    #[test]
    fn test_percent_decode_strict_non_ascii_does_not_panic() {
        // 修复前 percent_decode_strict 对 &input[i+1..i+3] 做字符串切片，
        // 遇到非 ASCII 字节会 panic，这里必须保持不 panic 且原样保留
        assert_eq!(percent_decode_strict("发票%"), "发票%");
        assert_eq!(percent_decode_strict("%E5%8F%91%"), "发%");
        assert_eq!(percent_decode_strict("中文abc"), "中文abc");
        assert_eq!(percent_decode_strict("%zz"), "%zz"); // 非法十六进制原样保留
        assert_eq!(percent_decode_strict("%41"), "A");
    }

    #[test]
    fn test_is_lan_or_loopback_host() {
        // 局域网 / 回环 / Tauri 内部主机名放行
        assert!(is_lan_or_loopback_host("127.0.0.1:9527"));
        assert!(is_lan_or_loopback_host("localhost:9527"));
        assert!(is_lan_or_loopback_host("192.168.1.8:9527"));
        assert!(is_lan_or_loopback_host("10.0.0.5"));
        assert!(is_lan_or_loopback_host("172.16.3.4:9527"));
        assert!(is_lan_or_loopback_host("[::1]:9527"));
        assert!(is_lan_or_loopback_host("tauri.localhost"));
        // DNS rebinding / 公网域名必须拒绝
        assert!(!is_lan_or_loopback_host("example.com"));
        assert!(!is_lan_or_loopback_host("evil.test:9527"));
        assert!(!is_lan_or_loopback_host("8.8.8.8:9527"));
        assert!(!is_lan_or_loopback_host("172.32.0.1")); // 私有段之外
        assert!(!is_lan_or_loopback_host(""));
    }

    #[test]
    fn test_sanitize_file_name() {
        // 目录穿越只保留末端文件名
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Users\\a\\b.txt"), "b.txt");
        // Windows 保留名加前缀
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("NUL.txt"), "_NUL.txt");
        assert_eq!(sanitize_file_name("com1.log"), "_com1.log");
        // 非法字符与结尾点/空格
        assert_eq!(sanitize_file_name("a<b>c.txt"), "a_b_c.txt");
        assert_eq!(sanitize_file_name("name.  "), "name");
        // 空 / 点 兜底
        assert_eq!(sanitize_file_name(""), "uploaded_file.bin");
        assert_eq!(sanitize_file_name(".."), "uploaded_file.bin");
    }

    #[test]
    fn test_unique_target_path_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("wenbox_unique_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_target_path(&dir, "报告.pdf");
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "报告.pdf");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_target_path(&dir, "报告.pdf");
        assert_ne!(second, first, "同名文件不得被覆盖");
        std::fs::write(&second, b"y").unwrap();
        let third = unique_target_path(&dir, "报告.pdf");
        assert_ne!(third, second);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_constant_time_eq_and_pin_matches() {
        assert!(constant_time_eq(b"abcd", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abce"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(pin_matches("1234", " 1234 "));
        assert!(!pin_matches("1234", "1235"));
    }

    #[test]
    fn test_broadcast_addrs_are_not_hardcoded_slash24() {
        // /16 之类的网段不能用 x.y.z.255 作为广播地址
        let ip = std::net::Ipv4Addr::new(10, 1, 2, 3);
        let mask = std::net::Ipv4Addr::new(255, 255, 0, 0);
        let broadcast = std::net::Ipv4Addr::from(u32::from(ip) | !u32::from(mask));
        assert_eq!(broadcast, std::net::Ipv4Addr::new(10, 1, 255, 255));
        let mask24 = std::net::Ipv4Addr::new(255, 255, 255, 0);
        let b24 = std::net::Ipv4Addr::from(u32::from(std::net::Ipv4Addr::new(192, 168, 1, 8)) | !u32::from(mask24));
        assert_eq!(b24, std::net::Ipv4Addr::new(192, 168, 1, 255));
    }

    #[test]
    fn test_push_message_bounded_trims_history() {
        let store: Mutex<Vec<ChatMessage>> = Mutex::new(Vec::new());
        for index in 0..(MAX_MESSAGES + 25) {
            push_message_bounded(&store, ChatMessage {
                id: index.to_string(),
                sender_name: "tester".into(),
                content: "x".into(),
                timestamp: index as u64,
                is_from_phone: false,
                sender_ip: String::new(),
                client_id: None,
            });
        }
        let guard = store.lock().unwrap();
        assert_eq!(guard.len(), MAX_MESSAGES);
        // 保留的是最近的消息
        assert_eq!(guard.first().unwrap().id, "25");
        assert_eq!(guard.last().unwrap().id, (MAX_MESSAGES + 24).to_string());
    }

    #[test]
    fn test_pin_public_file_view_hides_path() {
        let file = SharedFile {
            id: "1".into(), name: "a.txt".into(), size: 3,
            path: "/Users/someone/Downloads/a.txt".into(),
            mime_type: "text/plain".into(),
        };
        let view = public_file_view(&file);
        assert!(view.path.is_empty(), "对外响应不得包含绝对路径");
        assert_eq!(view.name, "a.txt");
        assert_eq!(file.path, "/Users/someone/Downloads/a.txt", "内部数据保持不变");
    }

    #[test]
    fn test_percent_decode_strict() {
        assert_eq!(percent_decode_strict("%E5%8F%91%E7%A5%A8.pdf"), "发票.pdf");
        assert_eq!(percent_decode_strict("a+b"), "a+b"); // 不把 '+' 还原为空格
        assert_eq!(percent_decode_strict("abc%2"), "abc%2"); // 残缺转义原样保留
        assert_eq!(percent_decode_strict("plain-id"), "plain-id");
    }

    /// 把 smallest possible HTTP 客户端封装成裸 TCP 请求，便于自定义 Origin/Host 头
    fn raw_http(port: u16, request: &str) -> String {
        use std::io::Read as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut buf = String::new();
        let _ = stream.read_to_string(&mut buf);
        buf
    }

    fn spawn_test_server(state: Arc<AppState>) -> u16 {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let serving = server.clone();
        thread::spawn(move || {
            for req in serving.incoming_requests() {
                let s = state.clone();
                thread::spawn(move || handle_http_request(req, s, port));
            }
        });
        port
    }

    fn protected_state() -> Arc<AppState> {
        let state = Arc::new(AppState {
            files: Mutex::new(HashMap::new()),
            received_files: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            room: Mutex::new(RoomConfig {
                is_active: true,
                room_id: "room-uuid".into(),
                room_name: "密码房".into(),
                pin: "246810".into(),
                need_password: true,
                host_device: "房主Mac".into(),
                host_ip: "192.168.1.8".into(),
                host_port: 9527,
                created_at: 0,
                auto_connect: false,
            }),
            members: Mutex::new(HashMap::new()),
            discovered_rooms: Mutex::new(HashMap::new()),
            auth_tokens: Mutex::new(HashSet::new()),
            host_token: Mutex::new("host-token-secret".into()),
            is_tauri_host: Mutex::new(true),
            selected_ip: Mutex::new(Some("192.168.1.8".into())),
            host_last_seen: Mutex::new(0),
            pin_failures: Mutex::new(HashMap::new()),
        });
        state.files.lock().unwrap().insert("secret".into(), SharedFile {
            id: "secret".into(), name: "机密.txt".into(), size: 2,
            path: "/tmp/secret.txt".into(), mime_type: "text/plain".into(),
        });
        state.messages.lock().unwrap().push(ChatMessage {
            id: "m1".into(), sender_name: "房主".into(), content: "机密聊天".into(),
            timestamp: 1, is_from_phone: false, sender_ip: String::new(), client_id: None,
        });
        state.auth_tokens.lock().unwrap().insert("guest-token".into());
        state.members.lock().unwrap().insert("host".into(), RoomMember {
            id: "member-host-id".into(), name: "房主Mac (房主)".into(), ip: "192.168.1.8".into(),
            platform: "macOS".into(), access_ip: "192.168.1.8:9527".into(),
            joined_at: 0, last_seen: u64::MAX / 2,
        });
        state
    }

    #[test]
    fn test_cross_site_loopback_fetch_is_blocked() {
        // 复现 S1：本机浏览器打开外部网页后 fetch('http://127.0.0.1:9527/api/files')。
        // 请求来自回环地址，但 Origin 是外部站点，必须被拒绝且不返回文件数据。
        let state = protected_state();
        let port = spawn_test_server(state);

        for endpoint in ["/api/files", "/api/messages", "/api/download/secret", "/api/received_files"] {
            let response = raw_http(port, &format!(
                "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n",
                endpoint, port
            ));
            assert!(response.starts_with("HTTP/1.1 403"), "{} 应被拒绝: {}", endpoint, response.lines().next().unwrap_or(""));
            assert!(!response.contains("机密"), "{} 泄露了内容", endpoint);
            assert!(!response.contains("Access-Control-Allow-Origin: *"), "{} 仍返回通配 CORS", endpoint);
        }

        // 本机自己的界面（Tauri webview / 本机网页）仍可正常访问
        let allowed = raw_http(port, &format!(
            "GET /api/files HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: tauri://localhost\r\nConnection: close\r\n\r\n",
            port
        ));
        assert!(allowed.starts_with("HTTP/1.1 200"), "本机 Tauri 界面不应被拦截: {}", allowed.lines().next().unwrap_or(""));

        // CORS 只回显已校验的 Origin
        assert!(allowed.contains("Access-Control-Allow-Origin: tauri://localhost"), "{}", allowed);
        assert!(allowed.contains("Vary: Origin"), "{}", allowed);
    }

    #[test]
    fn test_dns_rebinding_host_header_is_blocked() {
        // Host 指向外部域名时，即使是回环来源也不得放行
        let state = protected_state();
        let port = spawn_test_server(state);
        let response = raw_http(port, "GET /api/files HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n");
        assert!(response.starts_with("HTTP/1.1 403"), "{}", response);
    }

    #[test]
    fn test_room_members_never_expose_tokens() {
        // 复现 S2：未授权访客 GET /api/room/members 不得拿到房主令牌
        let state = protected_state();
        let port = spawn_test_server(state);
        let response = raw_http(port, &format!(
            "GET /api/room/members HTTP/1.1\r\nHost: 192.168.1.8:{}\r\nConnection: close\r\n\r\n",
            port
        ));
        assert!(response.starts_with("HTTP/1.1 200"), "{}", response);
        assert!(!response.contains("host-token-secret"), "成员接口泄露了房主令牌");
        assert!(!response.contains("guest-token"), "成员接口泄露了成员令牌");
        assert!(response.contains("\"count\":1"), "未授权时应只返回人数: {}", response);
    }

    #[test]
    fn test_room_leave_cannot_remove_host_reserved_key() {
        // 复现 S3：POST /api/room/leave {"token":"host"} 不能删掉房主
        let state = protected_state();
        let port = spawn_test_server(state.clone());
        let body = r#"{"token":"host"}"#;
        let response = raw_http(port, &format!(
            "POST /api/room/leave HTTP/1.1\r\nHost: 192.168.1.8:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port, body.len(), body
        ));
        assert!(response.starts_with("HTTP/1.1 200"), "{}", response);
        assert!(state.members.lock().unwrap().contains_key("host"), "房主被移出成员列表");
    }

    #[test]
    fn test_oversized_control_body_is_rejected_with_413() {
        // 复现 S4：控制接口读取无上限 body
        let state = protected_state();
        let port = spawn_test_server(state);
        let payload = "x".repeat((CTRL_MAX + 1024) as usize);
        let response = raw_http(port, &format!(
            "POST /api/room/leave HTTP/1.1\r\nHost: 192.168.1.8:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port, payload.len(), payload
        ));
        assert!(response.starts_with("HTTP/1.1 413"), "{}", response);
    }

    #[test]
    fn test_set_ip_requires_authorization_and_local_ip() {
        // 复现 S5：未鉴权访客不得劫持房间宣告的 IP
        let state = protected_state();
        let port = spawn_test_server(state.clone());
        let body = r#"{"ip":"10.9.9.9"}"#;
        let response = raw_http(port, &format!(
            "POST /api/room/set_ip HTTP/1.1\r\nHost: 192.168.1.8:{}\r\nOrigin: http://192.168.1.50\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port, body.len(), body
        ));
        assert!(response.starts_with("HTTP/1.1 403"), "{}", response);
        assert_eq!(state.selected_ip.lock().unwrap().as_deref(), Some("192.168.1.8"));
    }

    #[test]
    fn test_pin_bruteforce_is_locked_out() {
        // 复现 S8：连续失败 5 次后必须返回 429
        let state = protected_state();
        let port = spawn_test_server(state);
        let attempt = |pin: &str| {
            let body = format!(r#"{{"pin":"{}","name":"攻击者","platform":"Browser"}}"#, pin);
            raw_http(port, &format!(
                "POST /api/room/join HTTP/1.1\r\nHost: 192.168.1.8:{}\r\nOrigin: http://192.168.1.50\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                port, body.len(), body
            ))
        };
        for index in 1..=PIN_MAX_FAILURES {
            let response = attempt("000000");
            assert!(response.starts_with("HTTP/1.1 200"), "第 {} 次应正常返回密码错误: {}", index, response);
            assert!(response.contains("密码错误"), "{}", response);
        }
        let locked = attempt("000000");
        assert!(locked.starts_with("HTTP/1.1 429"), "锁定后应返回 429: {}", locked);
        assert!(locked.contains("尝试过多"), "{}", locked);
        // 锁定期间即使猜对了 PIN 也不放行
        let correct = attempt("246810");
        assert!(correct.starts_with("HTTP/1.1 429"), "{}", correct);
    }

    #[test]
    fn test_native_join_preserves_lockout_metadata_and_hosted_history() {
        let remote = protected_state();
        let port = spawn_test_server(remote);
        let local = protected_state();
        let host = format!("http://127.0.0.1:{}", port);
        for _ in 0..PIN_MAX_FAILURES {
            let result = join_remote_room_cmd_blocking(host.clone(), "000000".into(), "访客".into(), local.clone()).unwrap();
            assert_eq!(result["success"], false);
        }
        let locked = join_remote_room_cmd_blocking(host, "246810".into(), "访客".into(), local.clone()).unwrap();
        assert_eq!(locked["success"], false);
        assert!(locked["retryAfter"].as_u64().unwrap() > 0);
        assert_eq!(local.messages.lock().unwrap().len(), 1);
        let other_port = spawn_test_server(protected_state());
        let joined = join_remote_room_cmd_blocking(format!("http://127.0.0.1:{}", other_port), "246810".into(), "访客".into(), local.clone()).unwrap();
        assert_eq!(joined["success"], true);
        assert_eq!(local.messages.lock().unwrap().len(), 1);
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
        assert!(!v.contains("filename*=\""));
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
    fn test_slow_downloads_do_not_block_status_requests() {
        use std::io::Read;
        let dir = std::env::temp_dir().join(format!("wenbox_pool_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("large.bin");
        File::create(&path).unwrap().set_len(16 * 1024 * 1024).unwrap();
        let state = Arc::new(AppState {
            files: Mutex::new(HashMap::new()), received_files: Mutex::new(Vec::new()),
            messages: Mutex::new(Vec::new()), devices: Mutex::new(HashMap::new()),
            room: Mutex::new(RoomConfig::default()), members: Mutex::new(HashMap::new()),
            discovered_rooms: Mutex::new(HashMap::new()), auth_tokens: Mutex::new(HashSet::new()),
            host_token: Mutex::new(String::new()), is_tauri_host: Mutex::new(false), selected_ip: Mutex::new(None),
            host_last_seen: Mutex::new(0), pin_failures: Mutex::new(HashMap::new()),
        });
        state.files.lock().unwrap().insert("large".into(), SharedFile {
            id: "large".into(), name: "large.bin".into(), size: 16 * 1024 * 1024,
            path: path.to_string_lossy().into_owned(), mime_type: "application/octet-stream".into(),
        });
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let serving = server.clone();
        let dispatcher = thread::spawn(move || serve_http_requests(serving, state, port));
        let mut slow_clients = Vec::new();
        for _ in 0..4 {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            stream.write_all(b"GET /api/download/large HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut header = Vec::new();
            let mut byte = [0; 1];
            while !header.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap(); header.push(byte[0]);
            }
            slow_clients.push(stream); // Keep each transfer blocked by not reading its file body.
        }
        let response = get_http_client().get(&format!("http://127.0.0.1:{}/api/status", port)).call();
        drop(slow_clients);
        server.unblock();
        dispatcher.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(response.expect("control requests must respond even when every transfer worker is busy").status(), 200);
    }

    #[test]
    fn test_stream_upload_preserves_binary_and_split_boundaries() {
        struct Fragmented<'a> { bytes: &'a [u8], chunk: usize }
        impl Read for Fragmented<'_> {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                let n = out.len().min(self.chunk).min(self.bytes.len());
                out[..n].copy_from_slice(&self.bytes[..n]);
                self.bytes = &self.bytes[n..];
                Ok(n)
            }
        }
        let boundary = "wenbox-boundary";
        let payload = [vec![0xff; 65531], b"\0\r\n--wenbox-boundary!!not-a-delimiter".to_vec()].concat();
        let mut body = format!("--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"测试文件.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n", boundary).into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
        for chunk in [1, 3, 7, 65536] {
            let mut reader = Fragmented { bytes: &body, chunk };
            assert_eq!(read_upload_header(&mut reader, boundary).unwrap(), "测试文件.bin");
            let mut received = Vec::new();
            assert_eq!(copy_upload_body(&mut reader, &mut received, boundary).unwrap(), payload.len() as u64);
            assert_eq!(received, payload, "boundary split at chunk size {}", chunk);
        }
    }

    #[test]
    fn test_stream_upload_is_bounded_and_accepts_empty_files() {
        struct Counter { bytes: u64, largest_write: usize }
        impl Write for Counter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes += bytes.len() as u64;
                self.largest_write = self.largest_write.max(bytes.len());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let size = 32 * 1024 * 1024;
        let mut reader = std::io::repeat(0xa5).take(size).chain(std::io::Cursor::new(b"\r\n--test--\r\n"));
        let mut writer = Counter { bytes: 0, largest_write: 0 };
        assert_eq!(copy_upload_body(&mut reader, &mut writer, "test").unwrap(), size);
        assert_eq!(writer.bytes, size);
        assert!(writer.largest_write <= 65536);
        let mut empty = std::io::Cursor::new(b"\r\n--test--\r\n");
        assert_eq!(copy_upload_body(&mut empty, &mut std::io::sink(), "test").unwrap(), 0);
    }

    #[test]
    fn test_stream_upload_rejects_incomplete_body_and_oversized_header() {
        assert!(copy_upload_body(&mut &b"incomplete"[..], &mut Vec::new(), "test").is_err());
        let mut oversized = std::io::repeat(b'a').take(65537);
        assert!(read_upload_header(&mut oversized, "test").is_err());
    }

    #[test]
    fn test_upload_keeps_existing_file_and_handles_empty_raw_file() {
        let dir = std::env::temp_dir().join(format!("wenbox_upload_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("重复文件.txt"), b"original").unwrap();
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let download_dir = dir.clone();
        let worker = thread::spawn(move || {
            for mut req in server.incoming_requests().take(2) {
                let file = receive_upload(&mut req, &download_dir, "application/octet-stream", Some("重复文件.txt".into())).unwrap();
                let _ = req.respond(Response::from_string(serde_json::to_string(&file).unwrap()));
            }
        });
        for content in [b"replacement".as_slice(), b"".as_slice()] {
            let file: SharedFile = get_http_client().post(&format!("http://127.0.0.1:{}/upload", port))
                .send_bytes(content).unwrap().into_json().unwrap();
            assert_ne!(file.name, "重复文件.txt");
            assert_eq!(file.size, content.len() as u64);
            assert_eq!(std::fs::read(&file.path).unwrap(), content);
        }
        worker.join().unwrap();
        assert_eq!(std::fs::read(dir.join("重复文件.txt")).unwrap(), b"original");
        std::fs::remove_dir_all(dir).unwrap();
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
            host_last_seen: Mutex::new(0),
            pin_failures: Mutex::new(HashMap::new()),
        });

        let port = 39528;
        let server = Arc::new(tiny_http::Server::http(format!("127.0.0.1:{}", port)).unwrap());
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
                Err(ureq::Error::Status(_code, r)) => r,
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
        assert!(!val["hostToken"].as_str().unwrap_or("").is_empty());

        // 第二次建房 (另一个浏览器) 被 409 拒绝，原房间保持不变
        let (status2, val2) = post_create(&client);
        assert_eq!(status2, 409, "second create must be rejected");
        assert_eq!(val2["success"].as_bool(), Some(false));
        assert_eq!(state.room.lock().unwrap().room_name, "Browser-Room");
        assert!(state.room.lock().unwrap().is_active);
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
            host_last_seen: Mutex::new(0),
            pin_failures: Mutex::new(HashMap::new()),
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
        let server = tiny_http::Server::http(format!("127.0.0.1:{}", port)).unwrap();
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
