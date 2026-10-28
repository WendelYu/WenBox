//! Self-signed mutual TLS: proof-of-key signatures are always verified by rustls.
//! First-contact certificates are accepted only during an explicit pairing window.
use super::model::{fingerprint, Identity};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};
#[derive(Debug)]
struct Verify {
    pins: Vec<String>,
    unknown: bool,
}
impl Verify {
    fn check(&self, cert: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        if self.unknown || self.pins.contains(&fingerprint(cert.as_ref())) {
            Ok(())
        } else {
            Err(rustls::Error::General(
                "device certificate not authorized".into(),
            ))
        }
    }
    fn algorithms(&self) -> rustls::crypto::WebPkiSupportedAlgorithms {
        rustls::crypto::ring::default_provider().signature_verification_algorithms
    }
}
impl rustls::client::danger::ServerCertVerifier for Verify {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        self.check(end)?;
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, s, &self.algorithms())
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, s, &self.algorithms())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms().supported_schemes()
    }
}
impl rustls::server::danger::ClientCertVerifier for Verify {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<rustls::server::danger::ClientCertVerified, rustls::Error> {
        self.check(end)?;
        Ok(rustls::server::danger::ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, s, &self.algorithms())
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, s, &self.algorithms())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms().supported_schemes()
    }
}
pub struct Channel {
    connection: rustls::Connection,
    socket: TcpStream,
    pub fingerprint: String,
    pub code: String,
    pub remote: SocketAddr,
    pub local: SocketAddr,
}
impl Channel {
    fn finish(mut connection: rustls::Connection, mut socket: TcpStream) -> Result<Self, String> {
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let until = Instant::now() + Duration::from_secs(4);
        while connection.is_handshaking() {
            if Instant::now() > until {
                return Err("设备安全握手超时".into());
            }
            connection
                .complete_io(&mut socket)
                .map_err(|_| "设备安全握手失败或证书未获授权".to_string())?;
        }
        if connection.alpn_protocol() != Some(b"wenbox-kvm/1".as_slice()) {
            return Err("对端不支持 WenBox 流转配对协议".into());
        }
        let cert = connection
            .peer_certificates()
            .and_then(|c| c.first())
            .ok_or("对端没有提供设备证书")?;
        let fingerprint = fingerprint(cert.as_ref());
        let key = connection
            .export_keying_material([0u8; 32], b"EXPORTER-WenBox-KVM-Pair-v1", None)
            .map_err(|_| "无法生成配对验证码")?;
        let code = format!(
            "{:08}",
            u64::from_be_bytes(key[..8].try_into().unwrap()) % 100_000_000
        );
        let remote = socket.peer_addr().map_err(|e| e.to_string())?;
        let local = socket.local_addr().map_err(|e| e.to_string())?;
        Ok(Self {
            connection,
            socket,
            fingerprint,
            code,
            remote,
            local,
        })
    }
    pub fn connect(id: &Identity, address: SocketAddr, pin: Option<&str>) -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cert = CertificateDer::from(id.cert_der()?);
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key_der()?));
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Verify {
                pins: pin.map(|p| vec![p.into()]).unwrap_or_default(),
                unknown: pin.is_none(),
            }))
            .with_client_auth_cert(vec![cert], key)
            .map_err(|_| "设备证书或密钥不匹配")?;
        cfg.resumption = rustls::client::Resumption::disabled();
        cfg.alpn_protocols = vec![b"wenbox-kvm/1".to_vec()];
        let conn = rustls::ClientConnection::new(
            Arc::new(cfg),
            ServerName::try_from("wenbox.local").unwrap(),
        )
        .map_err(|e| e.to_string())?;
        Self::finish(
            rustls::Connection::Client(conn),
            TcpStream::connect_timeout(&address, Duration::from_secs(2))
                .map_err(|_| "无法连接设备，请检查流转开关和网络".to_string())?,
        )
    }
    pub fn accept(
        id: &Identity,
        socket: TcpStream,
        pins: Vec<String>,
        unknown: bool,
    ) -> Result<Self, String> {
        let cert = CertificateDer::from(id.cert_der()?);
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key_der()?));
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(Verify { pins, unknown }))
        .with_single_cert(vec![cert], key)
        .map_err(|_| "设备证书或密钥不匹配")?;
        cfg.send_tls13_tickets = 0;
        cfg.alpn_protocols = vec![b"wenbox-kvm/1".to_vec()];
        Self::finish(
            rustls::Connection::Server(
                rustls::ServerConnection::new(Arc::new(cfg)).map_err(|e| e.to_string())?,
            ),
            socket,
        )
    }
    pub fn send<T: serde::Serialize>(&mut self, value: &T) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > 32768 {
            return Err("设备消息过大".into());
        }
        bytes.push(b'\n');
        self.connection
            .writer()
            .write_all(&bytes)
            .map_err(|_| "发送设备消息失败")?;
        let until = Instant::now() + Duration::from_secs(4);
        while self.connection.wants_write() {
            if Instant::now() > until {
                return Err("发送设备消息超时".into());
            }
            self.connection
                .write_tls(&mut self.socket)
                .map_err(|_| "发送设备消息失败")?;
        }
        Ok(())
    }
    pub fn receive<T: serde::de::DeserializeOwned>(&mut self) -> Result<T, String> {
        let until = Instant::now() + Duration::from_secs(4);
        let mut bytes = Vec::new();
        loop {
            if bytes.len() > 32768 || Instant::now() > until {
                return Err("设备消息过大或读取超时".into());
            }
            let mut b = [0];
            match self.connection.reader().read(&mut b) {
                Ok(0) => return Err("设备消息中断".into()),
                Ok(_) => {
                    if b[0] == b'\n' {
                        break;
                    }
                    bytes.push(b[0]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    self.connection
                        .complete_io(&mut self.socket)
                        .map_err(|_| "设备消息读取失败")?;
                }
                Err(_) => return Err("设备消息读取失败".into()),
            }
        }
        serde_json::from_slice(&bytes).map_err(|_| "设备消息格式无效".into())
    }
}
