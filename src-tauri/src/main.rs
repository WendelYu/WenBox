// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

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

struct AppState {
    files: Mutex<HashMap<String, SharedFile>>,
    messages: Mutex<Vec<ChatMessage>>,
    devices: Mutex<HashMap<String, LanDevice>>,
}

// ---------------- Tauri 供前端调用的命令 ----------------
#[tauri::command]
fn add_share_file(path_str: String, state: tauri::State<Arc<AppState>>) -> Result<SharedFile, String> {
    let p = PathBuf::from(&path_str);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let id = uuid::Uuid::new_v4().to_string();

    let mime = if name.ends_with(".pdf") {
        "application/pdf"
    } else if name.ends_with(".png") || name.ends_with(".jpg") || name.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }.to_string();

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
fn clear_share_files(state: tauri::State<Arc<AppState>>) {
    state.files.lock().unwrap().clear();
}

#[tauri::command]
fn get_lan_devices(state: tauri::State<Arc<AppState>>) -> Vec<LanDevice> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut dev = state.devices.lock().unwrap();
    // 清除超过 15 秒未心跳的下线设备
    dev.retain(|_, d| now.saturating_sub(d.last_seen) < 15);
    dev.values().cloned().collect()
}

#[tauri::command]
fn get_local_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

// 在桌面端原生直接保存文件到指定子目录
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
            let url = req.url().to_string();
            let method = req.method().clone();

            let cors_origin = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
            let cors_methods = Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap();
            let cors_headers = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap();

            if method == Method::Options {
                let mut resp = Response::empty(200);
                resp.add_header(cors_origin);
                resp.add_header(cors_methods);
                resp.add_header(cors_headers);
                let _ = req.respond(resp);
                continue;
            }

            // 1. 获取在线节点设备列表
            if url == "/api/devices" && method == Method::Get {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
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

            // 2. 待发文件列表
            if url.starts_with("/api/files") && method == Method::Get {
                let files_map = state.files.lock().unwrap();
                let list: Vec<SharedFile> = files_map.values().cloned().collect();
                let json = serde_json::json!({ "files": list }).to_string();
                let mut resp = Response::from_string(json);
                resp.add_header(cors_origin);
                let _ = req.respond(resp);
                continue;
            }

            // 3. 文件下载
            if url.starts_with("/api/download/") && method == Method::Get {
                let file_id = url.trim_start_matches("/api/download/");
                let file_info = {
                    let files = state.files.lock().unwrap();
                    files.get(file_id).cloned()
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

            // 4. 局域网消息获取与发送
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
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
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

            // 默认返回 404
            let mut resp = Response::empty(404);
            resp.add_header(cors_origin);
            let _ = req.respond(resp);
        }
    });
}

// ---------------- UDP 局域网多设备自发现机制 (9528) ----------------
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

                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
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

    // 2. 启动定时广播线程 (每 3 秒向 255.255.255.255:9528 宣告自身)
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

            let _ = socket.send_to(msg.as_bytes(), "255.255.255.255:9528");
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
            add_share_file,
            clear_share_files,
            get_lan_devices,
            get_local_ip,
            save_file_to_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running wenbox application");
}
