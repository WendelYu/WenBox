//! HTTP LAN traffic through Tauri IPC, independent of WebView mixed-content/LNA policies.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

fn validate_target(value: &str) -> Result<url::Url, String> {
    let target = url::Url::parse(value).map_err(|e| e.to_string())?;
    let local = match target.host_str().unwrap_or("").parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        _ => target.host_str() == Some("localhost"),
    };
    if target.scheme() != "http"
        || !local
        || !target.username().is_empty()
        || target.password().is_some()
        || !target.path().starts_with("/api/")
        || target.fragment().is_some()
    {
        return Err("仅支持局域网 WenBox HTTP 接口".into());
    }
    Ok(target)
}

fn client(stream: bool) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(120));
    if stream {
        builder.build()
    } else {
        builder.timeout(Duration::from_secs(4)).build()
    }
}

#[derive(Serialize)]
pub struct NativeResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

fn request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    image: bool,
) -> Result<NativeResponse, String> {
    let url = validate_target(&url)?;
    if !matches!(method.as_str(), "GET" | "POST") || (image && method != "GET") {
        return Err("不支持的请求方法".into());
    }
    if body
        .as_ref()
        .map(|b| b.len() > 1024 * 1024)
        .unwrap_or(false)
    {
        return Err("请求内容过大".into());
    }
    let mut req = client(image).request(&method, url.as_str());
    for (key, value) in headers {
        if [
            "content-type",
            "x-room-token",
            "x-host-token",
            "range",
            "x-share-key",
            "x-share-file",
        ]
        .contains(&key.to_ascii_lowercase().as_str())
        {
            req = req.set(&key, &value);
        }
    }
    let result = match body {
        Some(body) => req.send_string(&body),
        None => req.call(),
    };
    let response = match result {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(format!("连接失败: {}", error)),
    };
    let status = response.status();
    if (300..400).contains(&status) {
        return Err("不支持房间地址重定向".into());
    }
    let mut headers = HashMap::new();
    for name in ["Content-Type", "Retry-After", "Content-Disposition"] {
        if let Some(value) = response.header(name) {
            headers.insert(name.to_ascii_lowercase(), value.to_string());
        }
    }
    let limit = if image {
        32 * 1024 * 1024
    } else {
        4 * 1024 * 1024
    };
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("预览内容过大，请下载原文件查看".into());
    }
    Ok(NativeResponse {
        status,
        headers,
        body: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn native_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    image: bool,
) -> Result<NativeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || request(url, method, headers, body, image))
        .await
        .map_err(|e| e.to_string())?
}

struct StreamUpload {
    tx: Mutex<Option<std::sync::mpsc::SyncSender<Vec<u8>>>>,
    result: Mutex<std::sync::mpsc::Receiver<Result<serde_json::Value, String>>>,
    received: AtomicU64,
}
struct ChunkReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    current: std::io::Cursor<Vec<u8>>,
    upload: Arc<Upload>,
}
impl Read for ChunkReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        loop {
            if self.upload.cancelled.load(Ordering::Relaxed) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "已取消",
                ));
            }
            let count = self.current.read(bytes)?;
            if count > 0 {
                self.upload.sent.fetch_add(count as u64, Ordering::Relaxed);
                return Ok(count);
            }
            match self.rx.recv_timeout(Duration::from_secs(30)) {
                Ok(chunk) => self.current = std::io::Cursor::new(chunk),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
                Err(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "文件读取超时",
                    ))
                }
            }
        }
    }
}
struct Upload {
    file: Mutex<Option<tempfile::NamedTempFile>>,
    stream: Option<StreamUpload>,
    target: String,
    name: String,
    token: Option<String>,
    size: u64,
    cancelled: AtomicBool,
    sent: AtomicU64,
}
fn uploads() -> &'static Mutex<HashMap<String, Arc<Upload>>> {
    static UPLOADS: OnceLock<Mutex<HashMap<String, Arc<Upload>>>> = OnceLock::new();
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn upload(id: &str) -> Result<Arc<Upload>, String> {
    uploads()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or("传输已结束或取消".into())
}
#[tauri::command]
pub fn native_upload_begin(
    url: String,
    name: String,
    token: Option<String>,
    size: u64,
) -> Result<String, String> {
    let url = validate_target(&url)?;
    if url.path() != "/api/upload" && !url.path().starts_with("/api/offers/transfer/") {
        return Err("无效的上传接口".into());
    }
    let mut active = uploads().lock().unwrap_or_else(|e| e.into_inner());
    if active.len() >= 8 {
        return Err("同时传输的文件过多".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    if url.path().starts_with("/api/offers/transfer/") {
        let parts: Vec<_> = url
            .path()
            .trim_start_matches("/api/offers/transfer/")
            .split('/')
            .collect();
        if parts.len() != 2
            || uuid::Uuid::parse_str(parts[0]).is_err()
            || parts[1].len() != 64
            || !parts[1].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("无效的下载请求".into());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(2);
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let item = Arc::new(Upload {
            file: Mutex::new(None),
            stream: Some(StreamUpload {
                tx: Mutex::new(Some(tx)),
                result: Mutex::new(result_rx),
                received: AtomicU64::new(0),
            }),
            target: url.to_string(),
            name,
            token,
            size,
            cancelled: AtomicBool::new(false),
            sent: AtomicU64::new(0),
        });
        active.insert(id.clone(), item.clone());
        std::thread::spawn(move || {
            let mut req = client(true)
                .post(&item.target)
                .set("Content-Type", "application/octet-stream")
                .set("Content-Length", &item.size.to_string());
            if let Some(token) = &item.token {
                req = req.set("X-Room-Token", token);
            }
            let result = req
                .send(ChunkReader {
                    rx,
                    current: std::io::Cursor::new(Vec::new()),
                    upload: item.clone(),
                })
                .map_err(|e| format!("传输失败：{e}"))
                .and_then(|response| {
                    let mut body = String::new();
                    response
                        .into_reader()
                        .take(65536)
                        .read_to_string(&mut body)
                        .map_err(|e| e.to_string())?;
                    serde_json::from_str(&body).map_err(|e| e.to_string())
                });
            let _ = result_tx.send(result);
        });
        return Ok(id);
    }
    let file = tempfile::Builder::new()
        .prefix("wenbox-upload-")
        .tempfile()
        .map_err(|e| e.to_string())?;
    active.insert(
        id.clone(),
        Arc::new(Upload {
            file: Mutex::new(Some(file)),
            stream: None,
            target: url.to_string(),
            name: super::sanitize_file_name(&name),
            token,
            size,
            cancelled: AtomicBool::new(false),
            sent: AtomicU64::new(0),
        }),
    );
    Ok(id)
}
#[tauri::command]
pub async fn native_upload_chunk(id: String, offset: u64, bytes: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || chunk(&id, offset, &bytes))
        .await
        .map_err(|e| e.to_string())?
}
fn chunk(id: &str, offset: u64, bytes: &str) -> Result<(), String> {
    if bytes.len() > 700_000 {
        return Err("传输分块过大".into());
    }
    let bytes = STANDARD.decode(bytes).map_err(|e| e.to_string())?;
    let upload = upload(id)?;
    if upload.cancelled.load(Ordering::Relaxed) {
        return Err("已取消".into());
    }
    if let Some(stream) = &upload.stream {
        let tx = stream.tx.lock().unwrap_or_else(|e| e.into_inner());
        if offset != stream.received.load(Ordering::Relaxed)
            || offset
                .checked_add(bytes.len() as u64)
                .filter(|n| *n <= upload.size)
                .is_none()
        {
            return Err("文件分块顺序或长度不正确".into());
        }
        let count = bytes.len() as u64;
        tx.as_ref()
            .ok_or("传输已结束")?
            .send(bytes)
            .map_err(|_| "接收方已停止下载".to_string())?;
        stream.received.fetch_add(count, Ordering::Relaxed);
        return Ok(());
    }
    let mut guard = upload.file.lock().unwrap_or_else(|e| e.into_inner());
    let file = guard.as_mut().ok_or("文件已开始发送")?;
    let length = file.as_file().metadata().map_err(|e| e.to_string())?.len();
    if offset != length
        || offset
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= upload.size)
            .is_none()
    {
        return Err("文件分块顺序或长度不正确".into());
    }
    file.write_all(&bytes).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn native_upload_progress(id: String) -> Result<u64, String> {
    Ok(upload(&id)?.sent.load(Ordering::Relaxed))
}
#[tauri::command]
pub fn native_upload_cancel(id: String) {
    if let Some(upload) = uploads()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
    {
        upload.cancelled.store(true, Ordering::Relaxed);
        if let Some(stream) = &upload.stream {
            stream.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }
}
struct ProgressReader<'a> {
    file: &'a mut std::fs::File,
    upload: &'a Upload,
}
impl Read for ProgressReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.upload.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "Upload cancelled",
            ));
        }
        let count = self.file.read(bytes)?;
        self.upload.sent.fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }
}
fn finish(id: &str) -> Result<serde_json::Value, String> {
    let upload = upload(id)?;
    let result = (|| {
        if let Some(stream) = &upload.stream {
            if stream.received.load(Ordering::Relaxed) != upload.size {
                return Err("文件尚未完整读取".into());
            }
            stream.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
            return stream
                .result
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .recv_timeout(Duration::from_secs(120))
                .map_err(|_| "传输确认超时".to_string())?;
        }
        let mut file = upload
            .file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or("文件已开始发送")?;
        if file.as_file().metadata().map_err(|e| e.to_string())?.len() != upload.size {
            return Err("文件尚未完整读取".into());
        }
        if upload.cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut req = client(true)
            .post(&upload.target)
            .set("Content-Type", "application/octet-stream")
            .set("Content-Length", &upload.size.to_string())
            .set("X-File-Name", &super::percent_encode_utf8(&upload.name));
        if let Some(token) = &upload.token {
            req = req.set("X-Room-Token", token);
        }
        let reader = ProgressReader {
            file: file.as_file_mut(),
            upload: &upload,
        };
        let response = match req.send(reader) {
            Ok(response) => response,
            Err(ureq::Error::Status(status, _)) => {
                return Err(format!("发送失败（HTTP {}）", status))
            }
            Err(error) => return Err(format!("发送失败: {}", error)),
        };
        let mut body = String::new();
        response
            .into_reader()
            .take(1024 * 1024)
            .read_to_string(&mut body)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&body).map_err(|e| format!("解析上传结果失败: {}", e))
    })();
    uploads()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    result
}
#[tauri::command]
pub async fn native_upload_finish(id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || finish(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only IPC harness used by the secure-origin browser regression.
    #[test]
    #[ignore]
    fn browser_fixture() {
        let path = std::env::var("WENBOX_TRANSPORT_FIXTURE").expect("fixture path required");
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let key = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            &path,
            serde_json::json!({"url":format!("http://{}", server.server_addr()), "key":key})
                .to_string(),
        )
        .unwrap();
        for _ in 0..1200 {
            if std::path::Path::new(&format!("{}.stop", path)).exists() {
                return;
            }
            if let Some(mut req) = server.recv_timeout(Duration::from_millis(250)).unwrap() {
                if super::super::header_val(&req, "X-Fixture-Key").as_deref() != Some(&key) {
                    let _ = req.respond(tiny_http::Response::empty(403));
                    continue;
                }
                std::thread::spawn(move || {
                    let mut body = String::new();
                    req.as_reader()
                        .take(1024 * 1024)
                        .read_to_string(&mut body)
                        .unwrap();
                    let input: serde_json::Value = serde_json::from_str(&body).unwrap();
                    let args = &input["args"];
                    let text = |key: &str| args[key].as_str().unwrap_or("").to_owned();
                    let result: Result<serde_json::Value, String> =
                        match input["command"].as_str().unwrap_or("") {
                            "native_request" => request(
                                text("url"),
                                text("method"),
                                serde_json::from_value(args["headers"].clone()).unwrap_or_default(),
                                args["body"].as_str().map(str::to_owned),
                                args["image"].as_bool().unwrap_or(false),
                            )
                            .map(|r| serde_json::to_value(r).unwrap()),
                            "native_upload_begin" => native_upload_begin(
                                text("url"),
                                text("name"),
                                args["token"].as_str().map(str::to_owned),
                                args["size"].as_u64().unwrap(),
                            )
                            .map(serde_json::Value::String),
                            "native_upload_chunk" => chunk(
                                &text("id"),
                                args["offset"].as_u64().unwrap(),
                                &text("bytes"),
                            )
                            .map(|_| serde_json::Value::Null),
                            "native_upload_finish" => finish(&text("id")),
                            "native_upload_cancel" => {
                                native_upload_cancel(text("id"));
                                Ok(serde_json::Value::Null)
                            }
                            "native_upload_progress" => {
                                native_upload_progress(text("id")).map(serde_json::Value::from)
                            }
                            _ => Err("Unknown fixture command".into()),
                        };
                    let _ = req.respond(tiny_http::Response::from_string(
                        match result {
                            Ok(value) => serde_json::json!({"value":value}),
                            Err(error) => serde_json::json!({"error":error}),
                        }
                        .to_string(),
                    ));
                });
            }
        }
        panic!("fixture timed out");
    }

    #[test]
    fn rejects_non_lan_targets() {
        for url in [
            "http://evil.example/api/status",
            "http://8.8.8.8/api/status",
            "http://127.0.0.1/private",
            "http://user@192.168.1.3/api/upload",
            "file:///api/test",
        ] {
            assert!(validate_target(url).is_err());
        }
    }
    #[test]
    fn upload_preserves_binary_authentication_and_cleans_staging() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/upload", server.server_addr());
        let worker = std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            assert_eq!(
                super::super::header_val(&request, "X-Room-Token").as_deref(),
                Some("secret")
            );
            let mut bytes = Vec::new();
            request.as_reader().read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, [0, 255, 128, 13, 10]);
            request
                .respond(tiny_http::Response::from_string(
                    "{\"success\":true,\"fileId\":\"test\"}",
                ))
                .unwrap();
        });
        let id = native_upload_begin(url, "图片.png".into(), Some("secret".into()), 5).unwrap();
        let staged = upload(&id)
            .unwrap()
            .file
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .path()
            .to_owned();
        chunk(&id, 0, &STANDARD.encode([0, 255])).unwrap();
        assert!(chunk(&id, 0, &STANDARD.encode([1])).is_err());
        chunk(&id, 2, &STANDARD.encode([128, 13, 10])).unwrap();
        assert_eq!(finish(&id).unwrap()["fileId"], "test");
        assert!(!staged.exists());
        assert!(upload(&id).is_err());
        worker.join().unwrap();
    }
    #[test]
    fn cancelled_upload_removes_temp_file_and_incomplete_upload_fails() {
        let id = native_upload_begin(
            "http://127.0.0.1:1/api/upload".into(),
            "test".into(),
            None,
            10,
        )
        .unwrap();
        let path = upload(&id)
            .unwrap()
            .file
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .path()
            .to_owned();
        native_upload_cancel(id.clone());
        assert!(!path.exists());
        assert!(upload(&id).is_err());
        let id = native_upload_begin(
            "http://127.0.0.1:1/api/upload".into(),
            "test".into(),
            None,
            10,
        )
        .unwrap();
        assert!(finish(&id).unwrap_err().contains("完整"));
        assert!(upload(&id).is_err());
    }
    #[test]
    fn request_preserves_auth_errors_and_binary_image() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/download/test", server.server_addr());
        let worker = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            request
                .respond(
                    tiny_http::Response::from_string("locked")
                        .with_status_code(429)
                        .with_header(tiny_http::Header::from_bytes("Retry-After", "7").unwrap()),
                )
                .unwrap();
            let request = server.recv().unwrap();
            request
                .respond(
                    tiny_http::Response::from_data(vec![0, 255, 128]).with_header(
                        tiny_http::Header::from_bytes("Content-Type", "image/png").unwrap(),
                    ),
                )
                .unwrap();
        });
        let locked = request(url.clone(), "GET".into(), HashMap::new(), None, false).unwrap();
        assert_eq!(locked.status, 429);
        assert_eq!(locked.headers["retry-after"], "7");
        let image = request(url, "GET".into(), HashMap::new(), None, true).unwrap();
        assert_eq!(STANDARD.decode(image.body).unwrap(), [0, 255, 128]);
        worker.join().unwrap();
    }
}

#[cfg(test)]
mod demand_stream_tests {
    use super::*;
    #[test]
    fn demand_upload_streams_without_tempfile_and_preserves_bytes() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let expected = vec![0x93; 2 * 1024 * 1024];
        let copy = expected.clone();
        let server_thread = std::thread::spawn(move || {
            let mut req = server.recv().unwrap();
            assert_eq!(req.body_length(), Some(copy.len()));
            let mut actual = Vec::new();
            req.as_reader().read_to_end(&mut actual).unwrap();
            assert_eq!(actual, copy);
            req.respond(tiny_http::Response::from_string(
                r#"{"success":true,"fileId":"offer-test"}"#,
            ))
            .unwrap();
        });
        let id = native_upload_begin(
            format!(
                "http://127.0.0.1:{port}/api/offers/transfer/{}/{}",
                uuid::Uuid::new_v4(),
                "a".repeat(64)
            ),
            "file.bin".into(),
            Some("room-token".into()),
            expected.len() as u64,
        )
        .unwrap();
        assert!(upload(&id).unwrap().file.lock().unwrap().is_none());
        for (index, part) in expected.chunks(512 * 1024).enumerate() {
            chunk(&id, (index * 512 * 1024) as u64, &STANDARD.encode(part)).unwrap();
        }
        assert_eq!(finish(&id).unwrap()["fileId"], "offer-test");
        assert!(upload(&id).is_err());
        server_thread.join().unwrap();
    }
}
