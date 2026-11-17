//! Room-scoped offers: metadata first, bounded streaming only after a download request.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tiny_http::{Header, Method, Request, Response, StatusCode};
const WAIT: Duration = Duration::from_secs(20);
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;
const ONLINE: Duration = Duration::from_secs(12);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInput {
    client_id: String,
    name: String,
    size: u64,
    #[serde(default)]
    plain_size: Option<u64>,
    #[serde(default)]
    encrypted: bool,
    mime_type: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publish {
    owner_key: String,
    sender_name: String,
    scope: String,
    files: Vec<FileInput>,
}
#[derive(Clone)]
struct Offer {
    id: String,
    room: String,
    owner: String,
    sender: String,
    file: FileInput,
    visible: bool,
    cancelled: Arc<AtomicBool>,
    cache: Arc<Mutex<Option<CachedOffer>>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    request_id: String,
    secret: String,
    client_id: String,
    file_id: String,
}
struct Pending {
    offer: Offer,
    job: Job,
    claimed: bool,
    created: Instant,
    ready: mpsc::Sender<()>,
    chunks: SyncSender<Vec<u8>>,
}
#[derive(Default)]
struct State {
    offers: HashMap<String, Offer>,
    owners: HashMap<String, Instant>,
    pending: HashMap<String, Pending>,
}
struct CachedOffer {
    file: tempfile::NamedTempFile,
    size: u64,
    usage: Arc<AtomicU64>,
}
impl CachedOffer {
    fn reserve(size: u64, usage: &Arc<AtomicU64>) -> Option<Self> {
        let file = tempfile::NamedTempFile::new().ok()?;
        usage
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(size).filter(|total| *total <= CACHE_LIMIT)
            })
            .ok()?;
        Some(Self {
            file,
            size,
            usage: usage.clone(),
        })
    }
}
impl Drop for CachedOffer {
    fn drop(&mut self) {
        self.usage.fetch_sub(self.size, Ordering::Relaxed);
    }
}
#[derive(Default)]
pub struct DemandFiles {
    state: Mutex<State>,
    cache_usage: Arc<AtomicU64>,
}
impl DemandFiles {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn clean(s: &mut State) {
        s.pending.retain(|_, p| p.created.elapsed() < WAIT);
        s.owners
            .retain(|key, _| s.offers.values().any(|o| &o.owner == key));
    }
    pub fn is_empty(&self) -> bool {
        self.lock().offers.is_empty()
    }
    pub fn list(&self, room: &str) -> Vec<serde_json::Value> {
        let s = self.lock();
        s.offers
            .values()
            .filter(|o| o.room == room && o.visible)
            .map(|o| {
                Self::public(
                    o,
                    s.owners.get(&o.owner).is_some_and(|t| t.elapsed() < ONLINE),
                )
            })
            .collect()
    }
    fn public(o: &Offer, online: bool) -> serde_json::Value {
        let cached = o.cache.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        serde_json::json!({"id":o.id,"clientId":o.file.client_id,"name":o.file.name,"size":o.file.plain_size.unwrap_or(o.file.size),"mimeType":o.file.mime_type,"path":"","onDemand":true,"ownerName":o.sender,"online":online || cached,"cached":cached})
    }
    pub fn clear(&self) {
        let mut s = self.lock();
        for o in s.offers.values() {
            o.cancelled.store(true, Ordering::SeqCst);
        }
        s.offers.clear();
        s.pending.clear();
        s.owners.clear();
    }
    fn publish(&self, room: &str, p: Publish) -> Result<serde_json::Value, String> {
        if !secret_valid(&p.owner_key)
            || p.files.is_empty()
            || p.files.len() > 32
            || !matches!(p.scope.as_str(), "room" | "chat")
            || p.sender_name.len() > 256
        {
            return Err("分享信息无效".into());
        }
        for f in &p.files {
            if uuid::Uuid::parse_str(&f.client_id).is_err()
                || f.name.is_empty()
                || f.name.len() > 1024
                || f.name.chars().any(|c| c == '\0' || c == '\r' || c == '\n')
                || f.size > 1_099_511_627_776
                || f.mime_type.len() > 128
            {
                return Err("文件信息无效".into());
            }
        }
        let mut s = self.lock();
        Self::clean(&mut s);
        if s.offers.len() + p.files.len() > 512 {
            return Err("房间分享文件过多，请先移除不需要的分享".into());
        }
        s.owners.insert(p.owner_key.clone(), Instant::now());
        let mut result = Vec::new();
        for file in p.files {
            let o = Offer {
                id: format!("offer-{}", uuid::Uuid::new_v4()),
                room: room.into(),
                owner: p.owner_key.clone(),
                sender: p.sender_name.clone(),
                file,
                visible: p.scope == "room",
                cancelled: Arc::new(AtomicBool::new(false)),
                cache: Arc::new(Mutex::new(None)),
            };
            result.push(Self::public(&o, true));
            s.offers.insert(o.id.clone(), o);
        }
        Ok(serde_json::json!({"success":true,"files":result}))
    }
    fn jobs(&self, room: &str, key: &str) -> Result<serde_json::Value, String> {
        if !secret_valid(key) {
            return Err("分享凭据无效".into());
        }
        let mut s = self.lock();
        Self::clean(&mut s);
        if !s.offers.values().any(|o| o.room == room && o.owner == key) {
            return Ok(serde_json::json!({"jobs":[]}));
        }
        s.owners.insert(key.into(), Instant::now());
        let jobs = s
            .pending
            .values_mut()
            .filter(|p| p.offer.room == room && p.offer.owner == key && !p.claimed)
            .map(|p| {
                p.claimed = true;
                p.job.clone()
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({"jobs":jobs}))
    }
}
fn secret_valid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}
fn json_response(status: u16, value: serde_json::Value) -> Response<Box<dyn Read + Send>> {
    Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=UTF-8").unwrap())
        .boxed()
}
fn error(status: u16, message: &str) -> Response<Box<dyn Read + Send>> {
    json_response(
        status,
        serde_json::json!({"success":false,"message":message}),
    )
}
struct CachedReader {
    file: std::fs::File,
    offer: Offer,
}
impl Read for CachedReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.offer.cancelled.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "分享已取消",
            ));
        }
        self.file.read(buffer)
    }
}
struct Relay {
    rx: Receiver<Vec<u8>>,
    current: io::Cursor<Vec<u8>>,
    cancelled: Arc<AtomicBool>,
    cache: Option<(CachedOffer, Arc<Mutex<Option<CachedOffer>>>)>,
    remaining: u64,
}
impl Read for Relay {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        if b.is_empty() {
            return Ok(0);
        }
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "分享已取消",
            ));
        }
        if self.remaining == 0 {
            return Ok(0);
        }
        let mut n = self.current.read(b)?;
        if n == 0 {
            self.current = io::Cursor::new(self.rx.recv_timeout(WAIT).map_err(|error| {
                let kind = match error {
                    mpsc::RecvTimeoutError::Timeout => io::ErrorKind::TimedOut,
                    mpsc::RecvTimeoutError::Disconnected => io::ErrorKind::UnexpectedEof,
                };
                io::Error::new(kind, "发送方传输中断")
            })?);
            n = self.current.read(b)?;
        }
        self.remaining -= n as u64;
        if let Some((mut cache, target)) = self.cache.take() {
            if cache.file.write_all(&b[..n]).is_ok() {
                if self.remaining == 0 {
                    let mut slot = target.lock().unwrap_or_else(|e| e.into_inner());
                    if slot.is_none() && !self.cancelled.load(Ordering::SeqCst) {
                        *slot = Some(cache);
                    }
                } else {
                    self.cache = Some((cache, target));
                }
            }
        }
        Ok(n)
    }
}
fn file_response(offer: &Offer, reader: Box<dyn Read + Send>) -> Response<Box<dyn Read + Send>> {
    let mut response = Response::new(
        StatusCode(200),
        vec![crate::build_content_disposition(&offer.file.name)],
        reader,
        Some(offer.file.size as usize),
        None,
    );
    if offer.file.encrypted {
        response.add_header(Header::from_bytes("X-WenBox-Encryption", "v1").unwrap());
    }
    if let Ok(h) = Header::from_bytes("Content-Type", offer.file.mime_type.as_bytes()) {
        response.add_header(h);
    }
    response
}

fn header(req: &Request, name: &'static str) -> String {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.to_string())
        .unwrap_or_default()
}
fn read_json(req: &mut Request) -> Result<Publish, String> {
    let mut b = Vec::new();
    req.as_reader()
        .take(65537)
        .read_to_end(&mut b)
        .map_err(|e| e.to_string())?;
    if b.len() > 65536 {
        return Err("分享信息过大".into());
    }
    serde_json::from_slice(&b).map_err(|_| "分享信息格式无效".into())
}
pub fn route(
    mut req: Request,
    repo: Arc<DemandFiles>,
    room: String,
    path: &str,
    cors: Vec<Header>,
) {
    let response = if path == "/api/offers" && req.method() == &Method::Post {
        match read_json(&mut req).and_then(|p| repo.publish(&room, p)) {
            Ok(v) => json_response(200, v),
            Err(e) => error(400, &e),
        }
    } else if path == "/api/offers/requests" && req.method() == &Method::Get {
        match repo.jobs(&room, &header(&req, "X-Share-Key")) {
            Ok(v) => json_response(200, v),
            Err(e) => error(403, &e),
        }
    } else if matches!(path, "/api/offers/revoke" | "/api/offers/detach")
        && req.method() == &Method::Post
    {
        let key = header(&req, "X-Share-Key");
        let file_id = header(&req, "X-Share-File");
        if !secret_valid(&key) {
            error(403, "分享凭据无效")
        } else {
            let mut s = repo.lock();
            s.offers.retain(|_, o| {
                if path == "/api/offers/detach"
                    && o.cache.lock().unwrap_or_else(|e| e.into_inner()).is_some()
                {
                    return true;
                }
                if o.room == room && o.owner == key && (file_id.is_empty() || o.id == file_id) {
                    o.cancelled.store(true, Ordering::SeqCst);
                    false
                } else {
                    true
                }
            });
            s.pending.retain(|_, p| {
                p.offer.room != room
                    || p.offer.owner != key
                    || (!file_id.is_empty() && p.offer.id != file_id)
            });
            if file_id.is_empty() {
                s.owners.remove(&key);
            }
            json_response(200, serde_json::json!({"success":true}))
        }
    } else if path.starts_with("/api/download/offer-") && req.method() == &Method::Get {
        let id = path.trim_start_matches("/api/download/offer-");
        let id = format!("offer-{id}");
        let setup = (|| -> Result<_, String> {
            let mut s = repo.lock();
            DemandFiles::clean(&mut s);
            let o = s
                .offers
                .get(&id)
                .filter(|o| o.room == room)
                .cloned()
                .ok_or("文件分享已失效")?;
            let cached = o
                .cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .and_then(|entry| entry.file.reopen().ok());
            if let Some(file) = cached {
                return Ok((o, Some(file), None));
            }
            if !s.owners.get(&o.owner).is_some_and(|t| t.elapsed() < ONLINE) {
                return Err("发送方已离线，请让发送方保持 WenBox 打开后重试".into());
            }
            if s.pending.len() >= 16 {
                return Err("当前下载较多，请稍后重试".into());
            }
            let job = Job {
                request_id: uuid::Uuid::new_v4().to_string(),
                secret: uuid::Uuid::new_v4().simple().to_string()
                    + &uuid::Uuid::new_v4().simple().to_string(),
                client_id: o.file.client_id.clone(),
                file_id: o.id.clone(),
            };
            let (tx, rx) = mpsc::sync_channel(4);
            let (ready_tx, ready_rx) = mpsc::channel();
            s.pending.insert(
                job.request_id.clone(),
                Pending {
                    offer: o.clone(),
                    job: job.clone(),
                    claimed: false,
                    created: Instant::now(),
                    ready: ready_tx,
                    chunks: tx,
                },
            );
            Ok((o, None, Some((job, rx, ready_rx))))
        })();
        match setup {
            Err(e) => error(410, &e),
            Ok((o, Some(file), _)) => file_response(
                &o,
                Box::new(CachedReader {
                    file,
                    offer: o.clone(),
                }),
            ),
            Ok((o, _, Some((job, rx, ready)))) => {
                if ready.recv_timeout(WAIT).is_err() {
                    repo.lock().pending.remove(&job.request_id);
                    error(504, "发送方未响应，请确认对方仍在线后重新下载")
                } else {
                    let cache = if o.file.encrypted {
                        CachedOffer::reserve(o.file.size, &repo.cache_usage)
                            .map(|entry| (entry, o.cache.clone()))
                    } else {
                        None
                    };
                    file_response(
                        &o,
                        Box::new(Relay {
                            rx,
                            current: io::Cursor::new(Vec::new()),
                            cancelled: o.cancelled.clone(),
                            cache,
                            remaining: o.file.size,
                        }),
                    )
                }
            }
            Ok(_) => unreachable!(),
        }
    } else if path.starts_with("/api/offers/transfer/") && req.method() == &Method::Post {
        let parts = path
            .trim_start_matches("/api/offers/transfer/")
            .split('/')
            .collect::<Vec<_>>();
        let pending = if parts.len() == 2 {
            let mut s = repo.lock();
            if s.pending
                .get(parts[0])
                .is_some_and(|p| p.offer.room == room && p.job.secret == parts[1])
            {
                s.pending.remove(parts[0])
            } else {
                None
            }
        } else {
            None
        };
        match pending {
            None => error(403, "下载请求已失效或无权传输"),
            Some(p) => {
                if req.body_length() != Some(p.offer.file.size as usize) {
                    error(400, "文件大小已变化，请重新分享")
                } else {
                    let _ = p.ready.send(());
                    let result = (|| -> Result<(), String> {
                        let mut left = p.offer.file.size;
                        let mut buf = vec![0u8; 256 * 1024];
                        while left > 0 {
                            if p.offer.cancelled.load(Ordering::SeqCst) {
                                return Err("分享已取消".into());
                            }
                            let count = (left as usize).min(buf.len());
                            let n = req
                                .as_reader()
                                .read(&mut buf[..count])
                                .map_err(|e| e.to_string())?;
                            if n == 0 {
                                return Err("发送方文件读取中断".into());
                            }
                            p.chunks
                                .send(buf[..n].to_vec())
                                .map_err(|_| "接收方已取消下载")?;
                            left -= n as u64;
                        }
                        Ok(())
                    })();
                    match result {
                        Ok(()) => json_response(
                            200,
                            serde_json::json!({"success":true,"fileId":p.offer.id}),
                        ),
                        Err(e) => error(409, &e),
                    }
                }
            }
        }
    } else {
        error(404, "文件分享接口不存在")
    };
    let mut response = response;
    for h in cors {
        response.add_header(h)
    }
    let _ = req.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_then_authenticated_stream_and_revoke() {
        let state = crate::tests::protected_state();
        let port = crate::tests::spawn_test_server(state.clone());
        let base = format!("http://127.0.0.1:{port}");
        let key = "a".repeat(64);
        let metadata = serde_json::json!({"ownerKey":key,"senderName":"发送方","scope":"room","files":[{"clientId":uuid::Uuid::new_v4().to_string(),"name":"测试.txt","size":5,"plainSize":5,"encrypted":true,"mimeType":"text/plain"}]}).to_string();
        assert!(ureq::post(&format!("{base}/api/offers"))
            .set("Origin", "http://192.168.1.8:9527")
            .send_string(&metadata)
            .is_err());
        let published: serde_json::Value = serde_json::from_reader(
            ureq::post(&format!("{base}/api/offers"))
                .set("X-Room-Token", "guest-token")
                .send_string(&metadata)
                .unwrap()
                .into_reader(),
        )
        .unwrap();
        let id = published["files"][0]["id"].as_str().unwrap().to_owned();
        assert!(state.received_files.lock().unwrap().is_empty());
        assert!(state.demand_files.lock().pending.is_empty());
        assert!(state.demand_files.list("different-room").is_empty());
        assert!(!published.to_string().contains(&key));
        let download_url = format!("{base}/api/download/{id}");
        let download = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            ureq::get(&download_url)
                .set("X-Room-Token", "guest-token")
                .call()
                .unwrap()
                .into_reader()
                .read_to_end(&mut bytes)
                .unwrap();
            bytes
        });
        let mut job = None;
        for _ in 0..100 {
            let value: serde_json::Value = serde_json::from_reader(
                ureq::get(&format!("{base}/api/offers/requests"))
                    .set("X-Room-Token", "guest-token")
                    .set("X-Share-Key", &key)
                    .call()
                    .unwrap()
                    .into_reader(),
            )
            .unwrap();
            if let Some(j) = value["jobs"].as_array().unwrap().first() {
                job = Some(j.clone());
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let job = job.expect("download creates an owner-only transfer request");
        let transfer = format!(
            "{base}/api/offers/transfer/{}/{}",
            job["requestId"].as_str().unwrap(),
            job["secret"].as_str().unwrap()
        );
        assert!(ureq::post(&transfer)
            .set("Origin", "http://192.168.1.8:9527")
            .send_bytes(b"hello")
            .is_err());
        ureq::post(&transfer)
            .set("X-Room-Token", "guest-token")
            .send_bytes(b"hello")
            .unwrap();
        assert_eq!(download.join().unwrap(), b"hello");
        ureq::post(&format!("{base}/api/offers/detach"))
            .set("X-Room-Token", "guest-token")
            .set("X-Share-Key", &key)
            .call()
            .unwrap();
        assert!(state.demand_files.lock().owners.is_empty());
        let response = ureq::get(&format!("{base}/api/download/{id}"))
            .set("X-Room-Token", "guest-token")
            .call()
            .unwrap();
        assert_eq!(response.header("X-WenBox-Encryption"), Some("v1"));
        let mut cached = Vec::new();
        response.into_reader().read_to_end(&mut cached).unwrap();
        assert_eq!(cached, b"hello");
        assert!(state.demand_files.lock().pending.is_empty());

        assert!(
            state.received_files.lock().unwrap().is_empty(),
            "no automatic Downloads entry"
        );
        ureq::post(&format!("{base}/api/offers/revoke"))
            .set("X-Room-Token", "guest-token")
            .set("X-Share-Key", &"b".repeat(64))
            .call()
            .unwrap();
        assert_eq!(state.demand_files.list("room-uuid").len(), 1);
        ureq::post(&format!("{base}/api/offers/revoke"))
            .set("X-Room-Token", "guest-token")
            .set("X-Share-Key", &key)
            .set("X-Share-File", &id)
            .call()
            .unwrap();
        assert!(state.demand_files.list("room-uuid").is_empty());
    }
    #[test]
    fn offline_and_malformed_offers_do_not_create_jobs() {
        let repo = DemandFiles::default();
        let key = "a".repeat(64);
        let input = || FileInput {
            client_id: uuid::Uuid::new_v4().to_string(),
            name: "x".into(),
            size: 0,
            plain_size: None,
            encrypted: false,
            mime_type: "text/plain".into(),
        };
        assert!(repo
            .publish(
                "r",
                Publish {
                    owner_key: "invalid".into(),
                    sender_name: "s".into(),
                    scope: "room".into(),
                    files: vec![input()]
                }
            )
            .is_err());
        repo.publish(
            "r",
            Publish {
                owner_key: key.clone(),
                sender_name: "s".into(),
                scope: "room".into(),
                files: vec![input()],
            },
        )
        .unwrap();
        repo.lock()
            .owners
            .insert(key, Instant::now() - Duration::from_secs(60));
        assert_eq!(repo.list("r")[0]["online"], false);
        repo.clear();
        assert!(repo.list("r").is_empty());
    }
}
