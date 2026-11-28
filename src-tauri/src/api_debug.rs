//! User-authored API requests from the local desktop window only.
//! Deliberately separate from the room transport and never routed over LAN HTTP.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

const BODY_LIMIT: usize = 1024 * 1024;
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Deserialize, Serialize)]
pub struct Pair {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiRequest {
    url: String,
    method: String,
    headers: Vec<Pair>,
    body: Option<String>,
    timeout_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    status: u16,
    status_text: String,
    headers: Vec<Pair>,
    body: String,
    elapsed_ms: u128,
    size: usize,
    truncated: bool,
}

pub(crate) fn allowed_window(label: &str, url: &url::Url) -> bool {
    label == "main"
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
}

fn validate(input: &ApiRequest) -> Result<url::Url, String> {
    let url = url::Url::parse(&input.url).map_err(|_| "请输入完整的 HTTP 或 HTTPS 地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("仅支持 HTTP/HTTPS；请将认证信息放在请求头中，地址不能包含片段".into());
    }
    if !matches!(
        input.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        return Err("不支持的 HTTP 方法".into());
    }
    if !(1000..=120_000).contains(&input.timeout_ms) {
        return Err("超时需为 1–120 秒".into());
    }
    if input.body.as_ref().is_some_and(|b| b.len() > BODY_LIMIT) {
        return Err("请求体不能超过 1 MiB".into());
    }
    if matches!(input.method.as_str(), "GET" | "HEAD")
        && input.body.as_ref().is_some_and(|b| !b.is_empty())
    {
        return Err("GET/HEAD 不发送请求体，请改用 Query 参数".into());
    }
    if input.headers.len() > 128
        || input
            .headers
            .iter()
            .map(|h| h.name.len() + h.value.len())
            .sum::<usize>()
            > 65536
    {
        return Err("请求头过多或过大".into());
    }
    for h in &input.headers {
        if h.name.is_empty()
            || !h
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || h.value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
        {
            return Err("请求头名称无效或包含换行".into());
        }
        if [
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "accept-encoding",
            "proxy-authorization",
        ]
        .contains(&h.name.to_ascii_lowercase().as_str())
        {
            return Err(format!("请求头 {} 由客户端管理，请移除后发送", h.name));
        }
    }
    Ok(url)
}

fn execute(input: ApiRequest) -> Result<ApiResponse, String> {
    let url = validate(&input)?;
    let start = Instant::now();
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(Duration::from_millis(input.timeout_ms))
        .build();
    let mut request = agent
        .request(&input.method, url.as_str())
        .set("Accept-Encoding", "identity");
    for header in input.headers {
        request = request.set(&header.name, &header.value);
    }
    let result = match input.body {
        Some(body) => request.send_bytes(body.as_bytes()),
        None => request.call(),
    };
    let response = match result {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(e)) => {
            return Err(format!(
                "请求未完成：{}。请检查网络、证书或超时设置",
                e.kind()
            ))
        }
    };
    let status = response.status();
    let status_text = response.status_text().to_owned();
    let headers = response
        .headers_names()
        .iter()
        .flat_map(|name| {
            response
                .all(name)
                .iter()
                .map(|value| Pair {
                    name: name.clone(),
                    value: value.to_string(),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((RESPONSE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取响应失败或超时")?;
    let truncated = bytes.len() > RESPONSE_LIMIT;
    bytes.truncate(RESPONSE_LIMIT);
    Ok(ApiResponse {
        status,
        status_text,
        headers,
        elapsed_ms: start.elapsed().as_millis(),
        size: bytes.len(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn api_debug_request(
    window: tauri::Window,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    if !allowed_window(window.label(), &window.url()) {
        return Err("仅允许本机桌面工具发起调试请求".into());
    }
    if ACTIVE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 4).then_some(n + 1)
        })
        .is_err()
    {
        return Err("正在进行的调试请求过多，请稍后重试".into());
    }
    let slot = Slot;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        execute(request)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(url: &str) -> ApiRequest {
        ApiRequest {
            url: url.into(),
            method: "GET".into(),
            headers: vec![],
            body: None,
            timeout_ms: 2000,
        }
    }
    #[test]
    fn validates_desktop_origin_and_request_boundaries() {
        assert!(allowed_window(
            "main",
            &url::Url::parse("tauri://localhost/").unwrap()
        ));
        for address in [
            "http://127.0.0.1:9527/",
            "https://example.com/",
            "tauri://localhost/evil",
            "https://user@tauri.localhost/",
        ] {
            assert!(!allowed_window("main", &url::Url::parse(address).unwrap()));
        }
        assert!(!allowed_window(
            "other",
            &url::Url::parse("tauri://localhost/").unwrap()
        ));
        for address in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://user:pass@example.com",
            "https://example.com/#fragment",
        ] {
            assert!(validate(&request(address)).is_err());
        }
        assert!(validate(&request("https://example.com/api")).is_ok());
        let mut input = request("http://127.0.0.1/");
        input.headers.push(Pair {
            name: "X-Test".into(),
            value: "a\r\nb".into(),
        });
        assert!(validate(&input).is_err());
    }
    #[test]
    fn sends_patch_and_preserves_error_responses() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let mut input = request(&format!("http://{}/echo?q=hello", server.server_addr()));
        input.method = "PATCH".into();
        input.body = Some("{\"name\":\"测试\"}".into());
        input.headers.push(Pair {
            name: "Authorization".into(),
            value: "Bearer fixture".into(),
        });
        let task = std::thread::spawn(move || {
            let mut req = server.recv().unwrap();
            assert_eq!(req.method().as_str(), "PATCH");
            assert_eq!(req.url(), "/echo?q=hello");
            assert!(req
                .headers()
                .iter()
                .any(|h| h.field.equiv("Authorization") && h.value.as_str() == "Bearer fixture"));
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            assert_eq!(body, "{\"name\":\"测试\"}");
            req.respond(
                tiny_http::Response::from_string("{\"error\":\"测试\"}").with_status_code(422),
            )
            .unwrap();
        });
        let response = execute(input).unwrap();
        assert_eq!(response.status, 422);
        assert!(response.body.contains("测试"));
        task.join().unwrap();
    }
    #[test]
    fn does_not_follow_redirects() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let input = request(&format!("http://{}/", server.server_addr()));
        let task = std::thread::spawn(move || {
            server
                .recv()
                .unwrap()
                .respond(
                    tiny_http::Response::empty(302).with_header(
                        tiny_http::Header::from_bytes("Location", "http://127.0.0.1:1/private")
                            .unwrap(),
                    ),
                )
                .unwrap()
        });
        assert_eq!(execute(input).unwrap().status, 302);
        task.join().unwrap();
    }
    #[test]
    fn truncates_large_responses_and_times_out() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let input = request(&format!("http://{}/", server.server_addr()));
        let task = std::thread::spawn(move || {
            let _ = server
                .recv()
                .unwrap()
                .respond(tiny_http::Response::from_data(vec![
                    b'x';
                    RESPONSE_LIMIT + 100
                ]));
        });
        let response = execute(input).unwrap();
        assert!(response.truncated);
        assert_eq!(response.size, RESPONSE_LIMIT);
        task.join().unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let mut input = request(&format!("http://{}/", server.server_addr()));
        input.timeout_ms = 1000;
        let task = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            std::thread::sleep(Duration::from_millis(1300));
            let _ = req.respond(tiny_http::Response::empty(200));
        });
        assert!(execute(input).is_err());
        task.join().unwrap();
    }
    #[test]
    fn rejects_untrusted_https_certificate() {
        use std::{net::TcpListener, sync::Arc};
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(generated.key_pair.serialize_der()).into();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![generated.cert.der().clone()], key)
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let input = request(&format!(
            "https://localhost:{}/",
            listener.local_addr().unwrap().port()
        ));
        let task = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let connection = rustls::ServerConnection::new(Arc::new(config)).unwrap();
            let mut stream = rustls::StreamOwned::new(connection, socket);
            assert!(stream.read(&mut [0; 1]).is_err());
        });
        assert!(execute(input).is_err());
        task.join().unwrap();
    }
}
