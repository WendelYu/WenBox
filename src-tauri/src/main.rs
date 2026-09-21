// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
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

struct AppState {
    files: Mutex<HashMap<String, SharedFile>>,
    received_files: Mutex<Vec<SharedFile>>,
    messages: Mutex<Vec<ChatMessage>>,
    devices: Mutex<HashMap<String, LanDevice>>,
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
fn get_local_ip() -> String {
    get_primary_ip()
}

#[tauri::command]
fn get_all_lan_ips_cmd() -> Vec<LocalIpInfo> {
    get_all_lan_ips()
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
    let my_ip = get_local_ip();
    let dev_name = whoami_device_name();
    let probe_body = serde_json::json!({
        "action": "wenbox_discovery",
        "device": dev_name,
        "platform": "Windows",
        "port": 9527,
        "ip": my_ip
    });

    let resp_res = ureq::post(&format!("{}/api/probe", base_url))
        .timeout(Duration::from_secs(3))
        .send_json(&probe_body)
        .or_else(|_| {
            ureq::get(&format!("{}/api/status", base_url))
                .timeout(Duration::from_secs(3))
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
fn fetch_node_files(base_url: String, state: tauri::State<Arc<AppState>>) -> Result<Vec<SharedFile>, String> {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let files_map = state.files.lock().unwrap();
        return Ok(files_map.values().cloned().collect());
    }

    let url = format!("{}/api/files", clean);
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("拉取文件列表失败: {}", e))?;

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析文件列表失败: {}", e))?;
    let mut list = Vec::new();
    if let Some(arr) = val["files"].as_array() {
        for item in arr {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let name = item["name"].as_str().unwrap_or("").to_string();
            let size = item["size"].as_u64().unwrap_or(0);
            let mime_type = item["mimeType"].as_str().unwrap_or("application/octet-stream").to_string();
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
fn save_remote_file_to_directory(download_url: String, dir_path: String, folder_name: String, file_name: String) -> Result<String, String> {
    let base_dir = PathBuf::from(&dir_path);
    let target_dir = base_dir.join(&folder_name);
    if !target_dir.exists() {
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    let file_path = target_dir.join(&file_name);
    let mut dest_file = File::create(&file_path).map_err(|e| format!("创建文件失败: {}", e))?;

    let resp = ureq::get(&download_url)
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|e| format!("下载远端文件流失败: {}", e))?;

    let mut reader = resp.into_reader();
    std::io::copy(&mut reader, &mut dest_file).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn fetch_node_messages(base_url: String, state: tauri::State<Arc<AppState>>) -> Result<Vec<ChatMessage>, String> {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let msgs = state.messages.lock().unwrap().clone();
        return Ok(msgs);
    }

    let url = format!("{}/api/messages", clean);
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("获取消息失败: {}", e))?;

    let val: serde_json::Value = resp.into_json().map_err(|e| format!("解析消息失败: {}", e))?;
    let mut list = Vec::new();
    if let Some(arr) = val["messages"].as_array() {
        for item in arr {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let sender_name = item["senderName"].as_str().unwrap_or("").to_string();
            let content = item["content"].as_str().unwrap_or("").to_string();
            let timestamp = item["timestamp"].as_u64().unwrap_or(0);
            let is_from_phone = item["isFromPhone"].as_bool().unwrap_or(false);
            list.push(ChatMessage {
                id,
                sender_name,
                content,
                timestamp,
                is_from_phone,
            });
        }
    }
    Ok(list)
}

#[tauri::command]
fn send_node_message(base_url: String, sender_name: String, content: String, state: tauri::State<Arc<AppState>>) -> Result<bool, String> {
    let clean = base_url.trim().trim_end_matches('/');
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    if clean.is_empty() || clean.contains("localhost") || clean.contains("127.0.0.1") {
        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            sender_name,
            content,
            timestamp: now_ms,
            is_from_phone: false,
        };
        state.messages.lock().unwrap().push(msg);
        return Ok(true);
    }

    let url = format!("{}/api/messages", clean);
    let body = serde_json::json!({
        "senderName": sender_name,
        "content": content
    });

    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .send_string(&body.to_string());

    match resp {
        Ok(_) => {
            let msg = ChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                sender_name,
                content,
                timestamp: now_ms,
                is_from_phone: false,
            };
            state.messages.lock().unwrap().push(msg);
            Ok(true)
        }
        Err(e) => Err(format!("发送失败: {}", e)),
    }
}

#[tauri::command]
fn upload_local_file_to_remote(target_base_url: String, file_path: String) -> Result<String, String> {
    let p = PathBuf::from(&file_path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let file_name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let file_data = std::fs::read(&p).map_err(|e| format!("读取文件失败: {}", e))?;

    let base = target_base_url.trim().trim_end_matches('/');
    let url = format!("{}/api/upload", base);

    let boundary = format!("----WenBoxBoundary{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(format!("Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n", file_name).as_bytes());
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&file_data);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let content_type = format!("multipart/form-data; boundary={}", boundary);
    let resp = ureq::post(&url)
        .set("Content-Type", &content_type)
        .timeout(Duration::from_secs(300))
        .send_bytes(&body);

    match resp {
        Ok(_) => Ok(format!("成功发送文件: {}", file_name)),
        Err(e) => Err(format!("向对方投送文件失败: {}", e)),
    }
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

        for mut req in server.incoming_requests() {
            let raw_url = req.url().to_string();
            let url = raw_url.split('?').next().unwrap_or(&raw_url).to_string();
            let method = req.method().clone();

            let cors_origin = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
            let cors_methods = Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS, PUT, DELETE"[..]).unwrap();
            let cors_headers = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type, X-File-Name, Range, Authorization"[..]).unwrap();

            if method == Method::Options {
                let mut resp = Response::empty(200);
                resp.add_header(cors_origin);
                resp.add_header(cors_methods);
                resp.add_header(cors_headers);
                let _ = req.respond(resp);
                continue;
            }

            // 1. 获取本端信息 (供前端展示自身 IP 与服务状态)
            if url == "/api/status" && method == Method::Get {
                let primary_ip = get_primary_ip();
                let all_ips = get_all_lan_ips();
                let dev_name = whoami_device_name();
                let json = serde_json::json!({
                    "device": dev_name,
                    "ip": primary_ip,
                    "all_ips": all_ips,
                    "port": port,
                    "running": true,
                    "platform": "Windows"
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
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
                continue;
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
                let json = serde_json::json!({
                    "device": dev_name,
                    "ip": primary_ip,
                    "all_ips": get_all_lan_ips(),
                    "port": port,
                    "running": true,
                    "platform": "Windows"
                }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 3. 待发文件列表
            if url.starts_with("/api/files") && method == Method::Get {
                let files_map = state.files.lock().unwrap();
                let list: Vec<SharedFile> = files_map.values().cloned().collect();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 3.1 清空待发文件
            if url == "/api/files/clear" || (url == "/api/files" && method == Method::Delete) {
                state.files.lock().unwrap().clear();
                let mut resp = Response::from_string("{\"success\":true}");
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 3.2 接收到的文件列表
            if url == "/api/received_files" && method == Method::Get {
                let list = state.received_files.lock().unwrap().clone();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 4. 文件下载 (支持下载分享的文件或接收到的文件)
            if url.starts_with("/api/download/") && method == Method::Get {
                let file_id = url.trim_start_matches("/api/download/");
                let file_info = {
                    let files = state.files.lock().unwrap();
                    let f = files.get(file_id).cloned();
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
                        let disp = format!("attachment; filename=\"{}\"", info.name);
                        resp.add_header(Header::from_bytes(&b"Content-Disposition"[..], disp.as_bytes()).unwrap());
                        resp.add_header(cors_origin);
                        let _ = req.respond(resp);
                        continue;
                    }
                }
                let mut resp = Response::from_string("File Not Found").with_status_code(404);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
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
                    .map(|h| h.value.to_string());

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
                        state.files.lock().unwrap().insert(id, rec_file);

                        let json = serde_json::json!({
                            "success": true,
                            "message": format!("文件已成功保存到: {}", target_path.to_string_lossy()),
                            "name": safe_name,
                            "size": size
                        }).to_string();
                        let mut resp = Response::from_string(json);
                        resp.add_header(cors_origin);
                        let _ = req.respond(resp);
                        continue;
                    }
                }

                let mut resp = Response::from_string("{\"success\":false,\"message\":\"保存文件失败\"}").with_status_code(500);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 5. 局域网消息获取与发送
            if url.starts_with("/api/messages") {
                if method == Method::Get {
                    let msgs = state.messages.lock().unwrap().clone();
                    let json = serde_json::json!({ "messages": msgs }).to_string();
                    let mut resp = Response::from_string(json);
                    resp.add_header(cors_origin);
                    let _ = req.respond(resp);
                    continue;
                } else if method == Method::Post {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                        let content = val["content"].as_str().unwrap_or("").to_string();
                        let sender_name = val["senderName"].as_str().unwrap_or("💻 Windows端").to_string();
                        let now_ms = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;

                        let msg = ChatMessage {
                            id: uuid::Uuid::new_v4().to_string(),
                            sender_name,
                            content,
                            timestamp: now_ms,
                            is_from_phone: false,
                        };
                        state.messages.lock().unwrap().push(msg);
                    }
                    let mut resp = Response::from_string("{\"success\":true}");
                    resp.add_header(cors_origin);
                    let _ = req.respond(resp);
                    continue;
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
                continue;
            }

            // 默认返回 404
            let mut resp = Response::empty(404);
            resp.add_header(cors_origin);
            let _ = req.respond(resp);
        }
    });
}

// ---------------- UDP 局域网多设备自发现机制 (9528) ----------------
fn get_all_broadcast_addrs() -> Vec<String> {
    let mut addrs = vec!["255.255.255.255:9528".to_string()];
    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in interfaces {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() {
                    let octets = ipv4.octets();
                    let bcast = format!("{}.{}.{}.255:9528", octets[0], octets[1], octets[2]);
                    if !addrs.contains(&bcast) {
                        addrs.push(bcast);
                    }
                }
            }
        }
    }
    addrs
}

fn start_udp_discovery(state: Arc<AppState>, my_port: u16) {
    let dev_name = whoami_device_name();
    let platform = "Windows".to_string();

    // 1. 启动接收监听线程
    let state_recv = state.clone();
    thread::spawn(move || {
        let socket = match UdpSocket::bind("0.0.0.0:9528") {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = socket.set_broadcast(true);
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((len, src)) = socket.recv_from(&mut buf) {
                if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                        if val["action"] == "wenbox_discovery" {
                            let name = val["device"].as_str().unwrap_or("").to_string();
                            let plat = val["platform"].as_str().unwrap_or("Android").to_string();
                            let port = val["port"].as_u64().unwrap_or(9527) as u16;
                            let ip = src.ip().to_string();

                            let now = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();

                            let key = format!("{}:{}", ip, port);
                            let node = LanDevice {
                                name,
                                ip,
                                port,
                                platform: plat,
                                last_seen: now,
                            };
                            state_recv.devices.lock().unwrap().insert(key, node);
                        }
                    }
                }
            }
        }
    });

    // 2. 启动定时广播线程 (向所有网卡子网广播与 255.255.255.255:9528 宣告自身)
    thread::spawn(move || {
        let socket = match UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = socket.set_broadcast(true);

        loop {
            let msg = serde_json::json!({
                "action": "wenbox_discovery",
                "device": dev_name,
                "platform": platform,
                "port": my_port
            }).to_string();

            let targets = get_all_broadcast_addrs();
            for target in targets {
                let _ = socket.send_to(msg.as_bytes(), &target);
            }
            thread::sleep(Duration::from_secs(3));
        }
    });
}

fn whoami_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Windows电脑".into())
}

fn main() {
    let state = Arc::new(AppState {
        files: Mutex::new(HashMap::new()),
        received_files: Mutex::new(Vec::new()),
        messages: Mutex::new(Vec::new()),
        devices: Mutex::new(HashMap::new()),
    });

    // 启动 HTTP 服务端 (默认 9527)
    start_embedded_http_server(state.clone(), 9527);

    // 启动 UDP 自动发现与设备节点探测 (9528)
    start_udp_discovery(state.clone(), 9527);

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_local_ip,
            get_all_lan_ips_cmd,
            get_lan_devices,
            connect_device_node,
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
            send_node_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running wenbox application");
}
