//! Local Java/Spring Boot directory, JAR/Fat-JAR bytecode, and OpenAPI JSON endpoint scanner.
//! Runs purely locally inside desktop Tauri commands with strict size/entry bounds.

use flate2::read::DeflateDecoder;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SOURCE_FILES: usize = 4_000;
const MAX_SOURCE_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 20_000;
const MAX_ENTRY_CLASS_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRY_JAR_BYTES: usize = 64 * 1024 * 1024;
const MAX_NESTED_JARS: usize = 128;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCatalogResult {
    pub source_name: String,
    pub source_kind: String,
    pub source_path: String,
    pub base_url: Option<String>,
    pub endpoints: Vec<ApiEndpoint>,
    pub types: BTreeMap<String, ApiTypeDef>,
    pub stats: ApiScanStats,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiScanStats {
    pub files_scanned: usize,
    pub controllers_found: usize,
    pub endpoints_found: usize,
    pub types_indexed: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTypeDef {
    pub name: String,
    pub full_name: String,
    pub kind: String,
    pub super_class: Option<String>,
    pub enum_values: Vec<String>,
    pub fields: Vec<ApiFieldDef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFieldDef {
    pub name: String,
    pub java_name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub required: bool,
    pub example: Option<String>,
    pub description: Option<String>,
    pub constraints: Option<ApiFieldConstraints>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFieldConstraints {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub min_len: Option<usize>,
    pub max_len: Option<usize>,
    pub email: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiParamDef {
    pub name: String,
    pub location: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub required: bool,
    pub default_value: Option<String>,
    pub example: Option<String>,
    pub description: Option<String>,
    pub inferred_name: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEndpoint {
    pub id: String,
    pub group: String,
    pub controller: String,
    pub method_name: String,
    pub summary: String,
    pub method: String,
    pub path: String,
    pub content_type: Option<String>,
    pub params: Vec<ApiParamDef>,
    pub source_file: String,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn api_scan_source(
    window: tauri::Window,
    path: String,
) -> Result<ApiCatalogResult, String> {
    if !crate::api_debug::allowed_window(window.label(), &window.url()) {
        return Err("仅允许本机桌面工具扫描本地接口目录或文件".into());
    }
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("请选择项目目录、JAR 包或 OpenAPI JSON 文件".into());
    }
    tauri::async_runtime::spawn_blocking(move || scan_source_path(Path::new(&trimmed)))
        .await
        .map_err(|e| format!("扫描任务执行失败：{e}"))?
}

pub fn scan_source_path(path: &Path) -> Result<ApiCatalogResult, String> {
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.display()));
    }
    if path.is_dir() {
        return scan_directory(path);
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jar" | "war" => {
            let bytes = fs::read(path).map_err(|e| format!("读取 JAR 失败：{e}"))?;
            scan_jar_bytes(path, &bytes)
        }
        "json" => {
            let text = fs::read_to_string(path).map_err(|e| format!("读取 JSON 失败：{e}"))?;
            scan_openapi_str(
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("openapi.json"),
                &path.to_string_lossy(),
                &text,
            )
        }
        "java" => {
            let text = fs::read_to_string(path).map_err(|e| format!("读取 Java 文件失败：{e}"))?;
            let rel = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Controller.java")
                .to_string();
            let mut acc = ScanAccumulator::new(rel.clone(), "java-file", &path.to_string_lossy());
            acc.stats.files_scanned = 1;
            parse_java_source(&text, &rel, &mut acc);
            Ok(acc.finish())
        }
        _ => Err("仅支持扫描项目目录、.jar/.war 包、.java 文件或 OpenAPI/Swagger .json 文件".into()),
    }
}

struct ScanAccumulator {
    source_name: String,
    source_kind: String,
    source_path: String,
    port: Option<String>,
    context_path: Option<String>,
    explicit_base_url: Option<String>,
    endpoints: Vec<ApiEndpoint>,
    types: BTreeMap<String, ApiTypeDef>,
    controllers: HashSet<String>,
    stats: ApiScanStats,
    warnings: BTreeSet<String>,
}

impl ScanAccumulator {
    fn new(source_name: String, source_kind: &str, source_path: &str) -> Self {
        Self {
            source_name,
            source_kind: source_kind.to_string(),
            source_path: source_path.to_string(),
            port: None,
            context_path: None,
            explicit_base_url: None,
            endpoints: Vec::new(),
            types: BTreeMap::new(),
            controllers: HashSet::new(),
            stats: ApiScanStats::default(),
            warnings: BTreeSet::new(),
        }
    }

    fn resolved_base_url(&self) -> Option<String> {
        if let Some(url) = &self.explicit_base_url {
            return Some(url.clone());
        }
        if self.port.is_none() && self.context_path.is_none() {
            return None;
        }
        let port = self.port.as_deref().unwrap_or("8080");
        let ctx = self.context_path.as_deref().unwrap_or("");
        let clean_ctx = normalize_path_segment(ctx);
        if clean_ctx == "/" || clean_ctx.is_empty() {
            Some(format!("http://127.0.0.1:{port}"))
        } else {
            Some(format!("http://127.0.0.1:{port}{clean_ctx}"))
        }
    }

    fn finish(mut self) -> ApiCatalogResult {
        self.endpoints.sort_by(|a, b| {
            a.group
                .cmp(&b.group)
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.method.cmp(&b.method))
                .then_with(|| a.method_name.cmp(&b.method_name))
        });
        self.stats.controllers_found = self.controllers.len();
        self.stats.endpoints_found = self.endpoints.len();
        self.stats.types_indexed = self.types.len();
        let base_url = self.resolved_base_url();
        ApiCatalogResult {
            source_name: self.source_name,
            source_kind: self.source_kind,
            source_path: self.source_path,
            base_url,
            endpoints: self.endpoints,
            types: self.types,
            stats: self.stats,
            warnings: self.warnings.into_iter().collect(),
        }
    }
}

// ---------- Directory & Config Scanning ----------

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "target"
            | "build"
            | "node_modules"
            | ".idea"
            | ".gradle"
            | ".mvn"
            | "dist"
            | "out"
            | "bin"
            | ".vscode"
    )
}

fn is_test_source_path(rel: &str) -> bool {
    let norm = rel.replace('\\', "/");
    norm.contains("/src/test/")
        || norm.starts_with("src/test/")
        || norm.ends_with("Test.java")
        || norm.ends_with("Tests.java")
}

fn scan_directory(dir: &Path) -> Result<ApiCatalogResult, String> {
    let source_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Project")
        .to_string();
    let mut acc = ScanAccumulator::new(source_name.clone(), "project-dir", &dir.to_string_lossy());
    let mut java_files: Vec<(PathBuf, String)> = Vec::new();
    let mut config_files: Vec<(PathBuf, String)> = Vec::new();
    let mut openapi_candidates: Vec<(PathBuf, String)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if file_type.is_dir() {
                if !should_skip_dir(&name_str) {
                    stack.push(entry_path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let rel = entry_path
                .strip_prefix(dir)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            if is_test_source_path(&rel) {
                continue;
            }
            let lower = name_str.to_ascii_lowercase();
            if lower.ends_with(".java") {
                java_files.push((entry_path, rel));
            } else if matches!(
                lower.as_str(),
                "application.yml"
                    | "application.yaml"
                    | "application.properties"
                    | "bootstrap.yml"
                    | "bootstrap.yaml"
            ) {
                config_files.push((entry_path, rel));
            } else if matches!(lower.as_str(), "openapi.json" | "swagger.json" | "api-docs.json") {
                openapi_candidates.push((entry_path, rel));
            }
            if java_files.len() + config_files.len() > MAX_SOURCE_FILES {
                acc.warnings
                    .insert(format!("项目文件数超过 {MAX_SOURCE_FILES} 上限，已截断部分扫描。"));
                break;
            }
        }
        if java_files.len() + config_files.len() > MAX_SOURCE_FILES {
            break;
        }
    }

    java_files.sort_by(|a, b| a.1.cmp(&b.1));
    config_files.sort_by(|a, b| a.1.cmp(&b.1));

    for (cfg_path, _) in &config_files {
        if let Ok(meta) = fs::metadata(cfg_path) {
            if meta.len() > MAX_SOURCE_FILE_BYTES {
                continue;
            }
        }
        if let Ok(text) = fs::read_to_string(cfg_path) {
            acc.stats.files_scanned += 1;
            let is_props = cfg_path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("properties"));
            if is_props {
                parse_spring_properties(&text, &mut acc.port, &mut acc.context_path);
            } else {
                parse_spring_yaml(&text, &mut acc.port, &mut acc.context_path);
            }
        }
    }

    for (java_path, rel) in &java_files {
        if let Ok(meta) = fs::metadata(java_path) {
            if meta.len() > MAX_SOURCE_FILE_BYTES {
                acc.warnings.insert(format!("跳过超过 2 MiB 的源码文件：{rel}"));
                continue;
            }
        }
        match fs::read_to_string(java_path) {
            Ok(text) => {
                acc.stats.files_scanned += 1;
                parse_java_source(&text, rel, &mut acc);
            }
            Err(_) => {
                acc.warnings.insert(format!("无法以 UTF-8 读取文件：{rel}"));
            }
        }
    }

    if acc.endpoints.is_empty() && !openapi_candidates.is_empty() {
        for (json_path, _) in openapi_candidates {
            if let Ok(text) = fs::read_to_string(&json_path) {
                if let Ok(mut parsed) = scan_openapi_str(
                    &source_name,
                    &dir.to_string_lossy(),
                    &text,
                ) {
                    if parsed.base_url.is_none() {
                        parsed.base_url = acc.resolved_base_url();
                    }
                    return Ok(parsed);
                }
            }
        }
    }

    Ok(acc.finish())
}

fn unwrap_spring_placeholder(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if let Some(inner) = trimmed.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        if let Some((_, default_val)) = inner.split_once(':') {
            return default_val.trim().trim_matches('"').trim_matches('\'').to_string();
        }
        return String::new();
    }
    trimmed.to_string()
}

fn parse_spring_properties(
    text: &str,
    port: &mut Option<String>,
    context_path: &mut Option<String>,
) {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=').or_else(|| trimmed.split_once(':')) else {
            continue;
        };
        let key = k.trim();
        let val = unwrap_spring_placeholder(v);
        if val.is_empty() {
            continue;
        }
        if key == "server.port" && val.chars().all(|c| c.is_ascii_digit()) {
            *port = Some(val);
        } else if key == "server.servlet.context-path" || key == "server.context-path" {
            *context_path = Some(val);
        }
    }
}

fn parse_spring_yaml(text: &str, port: &mut Option<String>, context_path: &mut Option<String>) {
    let mut stack: Vec<(usize, String)> = Vec::new();
    for raw_line in text.lines() {
        let no_comment = strip_yaml_inline_comment(raw_line);
        let trimmed = no_comment.trim();
        if trimmed.is_empty() || trimmed == "---" || trimmed == "..." {
            continue;
        }
        if trimmed.starts_with('-') {
            continue;
        }
        let indent = no_comment.chars().take_while(|c| *c == ' ').count();
        let Some((k_raw, v_raw)) = trimmed.split_once(':') else {
            continue;
        };
        let key = k_raw.trim().trim_matches('"').trim_matches('\'');
        while let Some((prev_indent, _)) = stack.last() {
            if *prev_indent >= indent {
                stack.pop();
            } else {
                break;
            }
        }
        let val = unwrap_spring_placeholder(v_raw);
        if val.is_empty() {
            stack.push((indent, key.to_string()));
            continue;
        }
        let mut path_parts: Vec<&str> = stack.iter().map(|(_, s)| s.as_str()).collect();
        path_parts.push(key);
        let full_key = path_parts.join(".");
        if full_key == "server.port" && val.chars().all(|c| c.is_ascii_digit()) {
            *port = Some(val);
        } else if full_key == "server.servlet.context-path"
            || full_key == "server.context-path"
        {
            *context_path = Some(val);
        }
    }
}

fn strip_yaml_inline_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (idx, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => {
                if idx == 0 || line[..idx].ends_with(' ') || line[..idx].ends_with('\t') {
                    return &line[..idx];
                }
            }
            _ => {}
        }
    }
    line
}

// ---------- Path & Annotation Helpers ----------

fn normalize_path_segment(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return String::new();
    }
    let mut s = trimmed.to_string();
    if !s.starts_with('/') {
        s.insert(0, '/');
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

fn combine_paths(prefix: &str, suffix: &str) -> String {
    let p = normalize_path_segment(prefix);
    let s = normalize_path_segment(suffix);
    if p.is_empty() && s.is_empty() {
        "/".to_string()
    } else if p.is_empty() {
        s
    } else if s.is_empty() {
        p
    } else {
        format!("{p}{s}")
    }
}

fn simple_type_name(raw: &str) -> &str {
    let no_gen = raw.split('<').next().unwrap_or(raw).trim();
    no_gen
        .rsplit(['.', '/', '$'])
        .next()
        .unwrap_or(no_gen)
        .trim_end_matches("[]")
}

fn is_ignored_injected_type(type_name: &str) -> bool {
    matches!(
        simple_type_name(type_name),
        "HttpServletRequest"
            | "HttpServletResponse"
            | "HttpSession"
            | "ServletRequest"
            | "ServletResponse"
            | "Model"
            | "ModelMap"
            | "RedirectAttributes"
            | "BindingResult"
            | "Errors"
            | "Principal"
            | "Authentication"
            | "WebRequest"
            | "NativeWebRequest"
            | "ServerWebExchange"
            | "ServerHttpRequest"
            | "ServerHttpResponse"
            | "Locale"
            | "TimeZone"
            | "InputStream"
            | "OutputStream"
            | "Reader"
            | "Writer"
            | "UriComponentsBuilder"
            | "Pageable"
            | "Sort"
    )
}

fn is_scalar_or_collection_type(type_name: &str) -> bool {
    let base = simple_type_name(type_name);
    if type_name.trim_end().ends_with("[]") {
        return true;
    }
    matches!(
        base,
        "String"
            | "CharSequence"
            | "char"
            | "Character"
            | "boolean"
            | "Boolean"
            | "byte"
            | "Byte"
            | "short"
            | "Short"
            | "int"
            | "Integer"
            | "long"
            | "Long"
            | "float"
            | "Float"
            | "double"
            | "Double"
            | "BigDecimal"
            | "BigInteger"
            | "Number"
            | "UUID"
            | "Date"
            | "LocalDate"
            | "LocalDateTime"
            | "LocalTime"
            | "Instant"
            | "OffsetDateTime"
            | "ZonedDateTime"
            | "List"
            | "Set"
            | "Collection"
            | "Iterable"
            | "ArrayList"
            | "LinkedList"
            | "HashSet"
            | "Optional"
            | "Map"
            | "HashMap"
            | "LinkedHashMap"
            | "MultipartFile"
            | "Object"
    )
}

fn normalize_java_type_expr(raw: &str) -> String {
    let mut s = raw
        .replace("java.lang.", "")
        .replace("java.util.", "")
        .replace("java.math.", "")
        .replace("java.time.", "")
        .trim()
        .to_string();
    if let Some(stripped) = s.strip_suffix("...") {
        s = format!("{stripped}[]");
    }
    s
}

// ---------- Java Source Scanner ----------

#[derive(Clone, Debug)]
struct ParsedAnn {
    name: String,
    args: BTreeMap<String, String>,
    raw_args: String,
}

#[derive(Clone, Debug)]
struct CodeSpan {
    body: String,
    javadoc: Option<String>,
}

fn strip_comments_keep_strings(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            // Handle text block """...""" or regular string "..."
            if i + 2 < chars.len() && chars[i + 1] == '"' && chars[i + 2] == '"' {
                out.push_str("\"\"\"");
                i += 3;
                while i < chars.len() {
                    if i + 2 < chars.len()
                        && chars[i] == '"'
                        && chars[i + 1] == '"'
                        && chars[i + 2] == '"'
                    {
                        out.push_str("\"\"\"");
                        i += 3;
                        break;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
            out.push(c);
            i += 1;
            while i < chars.len() {
                let sc = chars[i];
                out.push(sc);
                i += 1;
                if sc == '\\' && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                } else if sc == '"' {
                    break;
                }
            }
        } else if c == '\'' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                let sc = chars[i];
                out.push(sc);
                i += 1;
                if sc == '\\' && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                } else if sc == '\'' {
                    break;
                }
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            if i < chars.len() {
                out.push('\n');
                i += 1;
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            let is_doc = i < chars.len() && chars[i] == '*' && !(i + 1 < chars.len() && chars[i + 1] == '/');
            let mut comment = String::new();
            while i < chars.len() {
                if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                    i += 2;
                    break;
                }
                if is_doc {
                    comment.push(chars[i]);
                } else if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            if is_doc {
                if let Some(summary) = clean_javadoc(&comment) {
                    out.push_str("\n__WENBOX_DOC__(");
                    out.push_str(&serde_json::to_string(&summary).unwrap_or_else(|_| "\"\"".into()));
                    out.push_str(")\n");
                }
            } else {
                out.push(' ');
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn clean_javadoc(raw: &str) -> Option<String> {
    let mut lines = Vec::new();
    for line in raw.lines() {
        let t = line.trim().trim_start_matches('*').trim();
        if t.starts_with('@') {
            break;
        }
        if !t.is_empty() {
            lines.push(t);
        }
    }
    let joined = lines.join(" ");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(120).collect())
    }
}

fn find_matching_delim(chars: &[char], open_idx: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open_idx;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let quote = c;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 2;
                } else if chars[i] == quote {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c == open {
            depth += 1;
        } else if c == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn split_top_level(text: &str, delim: char) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut paren = 0usize;
    let mut brace = 0usize;
    let mut bracket = 0usize;
    let mut angle = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let q = c;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 2;
                } else if chars[i] == q {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        match c {
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            '{' => brace += 1,
            '}' => brace = brace.saturating_sub(1),
            '[' => bracket += 1,
            ']' => bracket = bracket.saturating_sub(1),
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            _ => {}
        }
        if c == delim && paren == 0 && brace == 0 && bracket == 0 && angle == 0 {
            let slice: String = chars[start..i].iter().collect();
            out.push(slice.trim().to_string());
            start = i + 1;
        }
        i += 1;
    }
    let tail: String = chars[start..].iter().collect();
    if !tail.trim().is_empty() {
        out.push(tail.trim().to_string());
    }
    out
}

fn extract_leading_annotations_and_doc(prefix: &str) -> (Vec<ParsedAnn>, Option<String>, String) {
    let mut doc: Option<String> = None;
    let mut anns = Vec::new();
    let chars: Vec<char> = prefix.chars().collect();
    let mut i = 0usize;
    loop {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let rest: String = chars[i..].iter().collect();
        if rest.starts_with("__WENBOX_DOC__(") {
            if let Some(close_idx) = find_matching_delim(&chars, i + "__WENBOX_DOC__".len(), '(', ')') {
                let literal: String = chars[i + "__WENBOX_DOC__(".len()..close_idx].iter().collect();
                if let Ok(parsed) = serde_json::from_str::<String>(literal.trim()) {
                    doc = Some(parsed);
                }
                i = close_idx + 1;
                continue;
            }
        }
        if chars[i] == '@' {
            i += 1;
            let name_start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.' || chars[i] == '$') {
                i += 1;
            }
            let raw_name: String = chars[name_start..i].iter().collect();
            let simple = raw_name.rsplit('.').next().unwrap_or(&raw_name).to_string();
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            let mut raw_args = String::new();
            let mut args = BTreeMap::new();
            if i < chars.len() && chars[i] == '(' {
                if let Some(close_idx) = find_matching_delim(&chars, i, '(', ')') {
                    raw_args = chars[i + 1..close_idx].iter().collect();
                    args = parse_annotation_args(&raw_args);
                    i = close_idx + 1;
                }
            }
            anns.push(ParsedAnn {
                name: simple,
                args,
                raw_args,
            });
            continue;
        }
        break;
    }
    let remainder: String = chars[i..].iter().collect();
    (anns, doc, remainder.trim().to_string())
}

fn parse_annotation_args(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return map;
    }
    let parts = split_top_level(trimmed, ',');
    if parts.len() == 1 && !has_top_level_equals(&parts[0]) {
        map.insert("value".to_string(), parts[0].trim().to_string());
        return map;
    }
    for part in parts {
        if let Some((k, v)) = split_first_top_level_eq(&part) {
            map.insert(k.trim().to_string(), v.trim().to_string());
        } else if !map.contains_key("value") && !part.trim().is_empty() {
            map.insert("value".to_string(), part.trim().to_string());
        }
    }
    map
}

fn has_top_level_equals(s: &str) -> bool {
    split_first_top_level_eq(s).is_some()
}

fn split_first_top_level_eq(s: &str) -> Option<(&str, &str)> {
    let mut in_single = false;
    let mut in_double = false;
    let mut depth = 0usize;
    for (idx, ch) in s.char_indices() {
        match ch {
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '(' | '{' | '[' if !in_single && !in_double => depth += 1,
            ')' | '}' | ']' if !in_single && !in_double => depth = depth.saturating_sub(1),
            '=' if !in_single && !in_double && depth == 0 => {
                return Some((&s[..idx], &s[idx + 1..]));
            }
            _ => {}
        }
    }
    None
}

fn extract_ann_strings(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let inner = if trimmed.starts_with('{') && trimmed.ends_with('}') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    split_top_level(inner, ',')
        .into_iter()
        .filter_map(|item| {
            let t = item.trim();
            if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
                serde_json::from_str::<String>(t)
                    .ok()
                    .or_else(|| Some(t[1..t.len() - 1].to_string()))
            } else if !t.is_empty() {
                Some(t.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn extract_ann_single_str(ann: &ParsedAnn, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(raw) = ann.args.get(*key) {
            let list = extract_ann_strings(raw);
            if let Some(first) = list.into_iter().next() {
                if !first.is_empty() {
                    return Some(first);
                }
            }
        }
    }
    None
}

fn extract_ann_bool(ann: &ParsedAnn, key: &str) -> Option<bool> {
    let raw = ann.args.get(key)?.trim();
    match raw {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn extract_ann_number(ann: &ParsedAnn, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(raw) = ann.args.get(*key) {
            let clean = raw
                .trim()
                .trim_matches('"')
                .trim_end_matches(['L', 'l', 'F', 'f', 'D', 'd']);
            if let Ok(n) = clean.parse::<f64>() {
                return Some(n);
            }
        }
    }
    None
}

fn parse_java_source(src: &str, rel_path: &str, acc: &mut ScanAccumulator) {
    let cleaned = strip_comments_keep_strings(src);
    let mut pkg = String::new();
    for line in cleaned.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("package ") {
            if let Some(name) = rest.strip_suffix(';') {
                pkg = name.trim().to_string();
                break;
            }
        }
    }
    let members = split_class_members(&cleaned);
    for span in members {
        let (anns, doc, header_and_rest) = extract_leading_annotations_and_doc(&span.body);
        if is_type_declaration(&header_and_rest) {
            parse_java_type_decl(&anns, doc.or(span.javadoc), &header_and_rest, &pkg, rel_path, acc);
        }
    }
}

fn is_type_declaration(header_and_rest: &str) -> bool {
    let Some(brace_pos) = find_decl_open_brace(header_and_rest) else {
        return false;
    };
    let head = &header_and_rest[..brace_pos];
    has_keyword(head, "class")
        || has_keyword(head, "record")
        || has_keyword(head, "enum")
        || has_keyword(head, "interface")
}

fn has_keyword(head: &str, kw: &str) -> bool {
    head.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|tok| tok == kw)
}

fn find_decl_open_brace(text: &str) -> Option<usize> {
    let chars: Vec<char> = text.chars().collect();
    let mut paren = 0usize;
    let mut angle = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let q = c;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 2;
                } else if chars[i] == q {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        match c {
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            '{' if paren == 0 && angle == 0 => {
                // convert char offset to byte offset
                return Some(chars[..i].iter().collect::<String>().len());
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_class_members(body: &str) -> Vec<CodeSpan> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut seg_start = 0usize;
    let mut paren = 0usize;
    let mut angle = 0usize;
    let mut brace = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let q = c;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 2;
                } else if chars[i] == q {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c == '@' && brace == 0 && paren == 0 && angle == 0 {
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                i += 1;
            }
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '(' {
                if let Some(end) = find_matching_delim(&chars, i, '(', ')') {
                    i = end + 1;
                    continue;
                }
            }
            continue;
        }
        match c {
            '(' => paren += 1,
            ')' => paren = paren.saturating_sub(1),
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            '{' => {
                if brace == 0 && paren == 0 && angle == 0 {
                    // Check if previous tokens look like `= new ...` or static block `{ ... }` without header -> handled after close
                }
                brace += 1;
            }
            '}' => {
                brace = brace.saturating_sub(1);
                if brace == 0 && paren == 0 && angle == 0 {
                    let item: String = chars[seg_start..=i].iter().collect();
                    let t = item.trim().to_string();
                    if !t.is_empty() && !t.starts_with("package ") && !t.starts_with("import ") {
                        out.push(CodeSpan {
                            body: t,
                            javadoc: None,
                        });
                    }
                    seg_start = i + 1;
                }
            }
            ';' if brace == 0 && paren == 0 && angle == 0 => {
                let item: String = chars[seg_start..=i].iter().collect();
                let t = item.trim().to_string();
                if !t.is_empty() && !t.starts_with("package ") && !t.starts_with("import ") {
                    out.push(CodeSpan {
                        body: t,
                        javadoc: None,
                    });
                }
                seg_start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn parse_java_type_decl(
    anns: &[ParsedAnn],
    doc: Option<String>,
    text: &str,
    pkg: &str,
    rel_path: &str,
    acc: &mut ScanAccumulator,
) {
    let Some(open_brace) = find_decl_open_brace(text) else {
        return;
    };
    let header = text[..open_brace].trim();
    let Some(close_brace) = text.rfind('}') else {
        return;
    };
    if close_brace <= open_brace {
        return;
    }
    let body = &text[open_brace + 1..close_brace];

    let kind = if has_keyword(header, "enum") {
        "enum"
    } else if has_keyword(header, "record") {
        "record"
    } else if has_keyword(header, "interface") {
        "interface"
    } else {
        "class"
    };

    let (type_name, super_class, record_components) = parse_type_header(header, kind);
    if type_name.is_empty() {
        return;
    }
    let full_name = if pkg.is_empty() {
        type_name.clone()
    } else {
        format!("{pkg}.{type_name}")
    };

    // Index type definition (record/enum/class)
    if kind == "enum" {
        let enum_values = parse_enum_constants(body);
        acc.types.insert(
            full_name.clone(),
            ApiTypeDef {
                name: type_name.clone(),
                full_name: full_name.clone(),
                kind: "enum".into(),
                super_class: None,
                enum_values,
                fields: Vec::new(),
            },
        );
    }

    let is_controller = anns.iter().any(|a| {
        matches!(
            a.name.as_str(),
            "RestController" | "Controller" | "FeignClient" | "Path"
        )
    });
    let class_mappings = extract_mapping_info(anns, true);

    let mut group_name = anns
        .iter()
        .find(|a| matches!(a.name.as_str(), "Tag" | "Api"))
        .and_then(|a| {
            extract_ann_single_str(a, &["name", "tags", "value", "description"])
        })
        .or(doc)
        .unwrap_or_else(|| type_name.clone());
    if group_name.trim().is_empty() {
        group_name = type_name.clone();
    }

    let mut fields = Vec::new();
    if let Some(rec_params) = record_components {
        for p in parse_param_list_text(&rec_params) {
            if !p.name.is_empty() && !p.type_name.is_empty() {
                fields.push(ApiFieldDef {
                    name: p.json_name.unwrap_or_else(|| p.name.clone()),
                    java_name: p.name,
                    type_name: normalize_java_type_expr(&p.type_name),
                    required: p.required,
                    example: p.example,
                    description: p.description,
                    constraints: p.constraints,
                });
            }
        }
    }

    let members = split_class_members(body);
    let mut found_endpoints = 0usize;
    for member in members {
        let (m_anns, m_doc, m_rest) = extract_leading_annotations_and_doc(&member.body);
        if m_rest.is_empty() {
            continue;
        }
        // Nested class/enum/record
        if is_type_declaration(&m_rest) {
            let nested_pkg = if pkg.is_empty() {
                type_name.clone()
            } else {
                format!("{pkg}.{type_name}")
            };
            parse_java_type_decl(&m_anns, m_doc, &m_rest, &nested_pkg, rel_path, acc);
            continue;
        }
        // Field vs Method
        if let Some(brace_pos) = find_decl_open_brace(&m_rest) {
            let sig = m_rest[..brace_pos].trim();
            if sig.contains('(') && (is_controller || !class_mappings.is_empty()) {
                let eps = parse_controller_method(
                    &m_anns,
                    m_doc,
                    sig,
                    &class_mappings,
                    &group_name,
                    &type_name,
                    rel_path,
                );
                found_endpoints += eps.len();
                acc.endpoints.extend(eps);
            }
        } else if m_rest.ends_with(';') {
            let no_semi = m_rest[..m_rest.len() - 1].trim();
            if kind == "interface" && no_semi.contains('(') && (is_controller || !class_mappings.is_empty()) {
                let eps = parse_controller_method(
                    &m_anns,
                    m_doc,
                    no_semi,
                    &class_mappings,
                    &group_name,
                    &type_name,
                    rel_path,
                );
                found_endpoints += eps.len();
                acc.endpoints.extend(eps);
            } else if !no_semi.contains('(') && kind != "interface" {
                parse_java_field(&m_anns, m_doc, no_semi, &mut fields);
            }
        }
    }

    if found_endpoints > 0 || is_controller {
        acc.controllers.insert(full_name.clone());
    }

    if kind != "enum" && (!is_controller || !fields.is_empty()) {
        acc.types.insert(
            full_name.clone(),
            ApiTypeDef {
                name: type_name,
                full_name,
                kind: kind.to_string(),
                super_class,
                enum_values: Vec::new(),
                fields,
            },
        );
    }
}

fn parse_type_header(header: &str, kind: &str) -> (String, Option<String>, Option<String>) {
    let mut name = String::new();
    let mut super_class = None;
    let mut record_components = None;

    if let Some(kw_idx) = header.find(kind) {
        let after = header[kw_idx + kind.len()..].trim();
        let mut iter = after.chars().peekable();
        while let Some(&c) = iter.peek() {
            if c.is_alphanumeric() || c == '_' || c == '$' {
                name.push(c);
                iter.next();
            } else {
                break;
            }
        }
        let rest_after_name: String = iter.collect();
        let trimmed = rest_after_name.trim();
        let mut scan_from = trimmed;
        if scan_from.starts_with('<') {
            let chars: Vec<char> = scan_from.chars().collect();
            if let Some(end) = find_matching_delim(&chars, 0, '<', '>') {
                let consumed: String = chars[..=end].iter().collect();
                scan_from = &scan_from[consumed.len()..];
            }
        }
        let scan_trimmed = scan_from.trim();
        if kind == "record" && scan_trimmed.starts_with('(') {
            let chars: Vec<char> = scan_trimmed.chars().collect();
            if let Some(end) = find_matching_delim(&chars, 0, '(', ')') {
                let inner: String = chars[1..end].iter().collect();
                record_components = Some(inner);
            }
        }
        if let Some(ext_idx) = scan_trimmed.find("extends ") {
            let ext_after = scan_trimmed[ext_idx + "extends ".len()..].trim();
            let raw_super = ext_after
                .split([' ', '{', '<'])
                .next()
                .unwrap_or("")
                .trim();
            let simple = simple_type_name(raw_super);
            if !simple.is_empty() && simple != "Object" && simple != "implements" {
                super_class = Some(simple.to_string());
            }
        }
    }
    (name, super_class, record_components)
}

fn parse_enum_constants(body: &str) -> Vec<String> {
    let head = body.split(';').next().unwrap_or(body);
    split_top_level(head, ',')
        .into_iter()
        .filter_map(|item| {
            let (_, _, rest) = extract_leading_annotations_and_doc(&item);
            let name = rest
                .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
                .next()
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            }
        })
        .collect()
}

fn extract_mapping_info(anns: &[ParsedAnn], is_class_level: bool) -> Vec<(Vec<String>, Vec<String>, Option<String>)> {
    let mut out = Vec::new();
    for ann in anns {
        let mapped: Option<Vec<&str>> = match ann.name.as_str() {
            "RequestMapping" => {
                let mut ms = Vec::new();
                if let Some(raw_m) = ann.args.get("method") {
                    for part in extract_ann_strings(raw_m) {
                        let m = part.rsplit('.').next().unwrap_or(&part).to_ascii_uppercase();
                        if matches!(m.as_str(), "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS") {
                            ms.push(match m.as_str() {
                                "GET" => "GET",
                                "POST" => "POST",
                                "PUT" => "PUT",
                                "DELETE" => "DELETE",
                                "PATCH" => "PATCH",
                                "HEAD" => "HEAD",
                                _ => "OPTIONS",
                            });
                        }
                    }
                }
                if ms.is_empty() && !is_class_level {
                    ms.push("GET");
                }
                Some(ms)
            }
            "GetMapping" | "GET" => Some(vec!["GET"]),
            "PostMapping" | "POST" => Some(vec!["POST"]),
            "PutMapping" | "PUT" => Some(vec!["PUT"]),
            "DeleteMapping" | "DELETE" => Some(vec!["DELETE"]),
            "PatchMapping" | "PATCH" => Some(vec!["PATCH"]),
            "Path" => Some(Vec::new()),
            _ => None,
        };
        let Some(methods_vec) = mapped else { continue };
        let mut paths = ann
            .args
            .get("path")
            .or_else(|| ann.args.get("value"))
            .map(|v| extract_ann_strings(v))
            .unwrap_or_default();
        if paths.is_empty() {
            paths.push(String::new());
        }
        let consumes = ann
            .args
            .get("consumes")
            .and_then(|v| extract_ann_strings(v).into_iter().next());
        let method_strings: Vec<String> = if methods_vec.is_empty() {
            Vec::new()
        } else {
            methods_vec.into_iter().map(String::from).collect()
        };
        out.push((method_strings, paths, consumes));
    }
    // Merge JAX-RS @Path + @GET/@POST on same method
    let jax_methods: Vec<String> = out
        .iter()
        .filter(|(m, _, _)| !m.is_empty())
        .flat_map(|(m, _, _)| m.clone())
        .collect();
    if anns.iter().any(|a| a.name == "Path") && !jax_methods.is_empty() {
        let jax_paths: Vec<String> = out
            .iter()
            .filter(|(m, p, _)| m.is_empty() || !p.first().is_none_or(|s| s.is_empty()))
            .flat_map(|(_, p, _)| p.clone())
            .collect();
        let clean_paths = if jax_paths.is_empty() {
            vec![String::new()]
        } else {
            jax_paths
        };
        return vec![(jax_methods, clean_paths, None)];
    }
    out
}

fn parse_controller_method(
    anns: &[ParsedAnn],
    doc: Option<String>,
    sig: &str,
    class_mappings: &[(Vec<String>, Vec<String>, Option<String>)],
    group_name: &str,
    controller: &str,
    rel_path: &str,
) -> Vec<ApiEndpoint> {
    let method_mappings = extract_mapping_info(anns, false);
    if method_mappings.is_empty() {
        return Vec::new();
    }
    let open_paren = match sig.find('(') {
        Some(idx) => idx,
        None => return Vec::new(),
    };
    let close_paren = match sig.rfind(')') {
        Some(idx) if idx > open_paren => idx,
        _ => return Vec::new(),
    };
    let before_paren = sig[..open_paren].trim();
    let method_name = before_paren
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .rfind(|s| !s.is_empty())
        .unwrap_or("endpoint")
        .to_string();
    let params_str = &sig[open_paren + 1..close_paren];
    let parsed_params = parse_param_list_text(params_str);

    let summary = anns
        .iter()
        .find(|a| matches!(a.name.as_str(), "Operation" | "ApiOperation"))
        .and_then(|a| extract_ann_single_str(a, &["summary", "value", "notes", "description"]))
        .or(doc)
        .unwrap_or_else(|| method_name.clone());

    let mut class_prefixes: Vec<String> = class_mappings
        .iter()
        .flat_map(|(_, paths, _)| paths.clone())
        .collect();
    if class_prefixes.is_empty() {
        class_prefixes.push(String::new());
    }
    let class_methods: Vec<String> = class_mappings
        .iter()
        .flat_map(|(m, _, _)| m.clone())
        .collect();

    let mut endpoints = Vec::new();
    for (m_methods, m_paths, m_consumes) in method_mappings {
        let http_methods = if !m_methods.is_empty() {
            m_methods
        } else if !class_methods.is_empty() {
            class_methods.clone()
        } else {
            vec!["GET".to_string()]
        };
        for prefix in &class_prefixes {
            for suffix in &m_paths {
                let full_path = combine_paths(prefix, suffix);
                for http_method in &http_methods {
                    let params = finalize_endpoint_params(&parsed_params, &full_path, http_method);
                    let content_type = m_consumes.clone().or_else(|| {
                        if params.iter().any(|p| p.location == "body") {
                            Some("application/json".to_string())
                        } else {
                            None
                        }
                    });
                    endpoints.push(ApiEndpoint {
                        id: format!("{controller}::{method_name}::{http_method}::{full_path}"),
                        group: group_name.to_string(),
                        controller: controller.to_string(),
                        method_name: method_name.clone(),
                        summary: summary.clone(),
                        method: http_method.clone(),
                        path: full_path.clone(),
                        content_type,
                        params,
                        source_file: rel_path.to_string(),
                        warnings: Vec::new(),
                    });
                }
            }
        }
    }
    endpoints
}

#[derive(Clone, Debug)]
struct RawParamMeta {
    name: String,
    json_name: Option<String>,
    explicit_name: Option<String>,
    type_name: String,
    location_hint: Option<String>,
    required: bool,
    default_value: Option<String>,
    example: Option<String>,
    description: Option<String>,
    constraints: Option<ApiFieldConstraints>,
}

fn parse_param_list_text(params_str: &str) -> Vec<RawParamMeta> {
    split_top_level(params_str, ',')
        .into_iter()
        .filter_map(|item| {
            let (anns, _, rest) = extract_leading_annotations_and_doc(&item);
            let cleaned = strip_leading_modifiers(&rest);
            if cleaned.is_empty() {
                return None;
            }
            let mut last_word_start = cleaned.len();
            for (idx, ch) in cleaned.char_indices().rev() {
                if ch.is_whitespace() || ch == '>' || ch == ']' {
                    last_word_start = idx + ch.len_utf8();
                    break;
                }
                if idx == 0 {
                    last_word_start = 0;
                }
            }
            let var_name = cleaned[last_word_start..].trim().trim_end_matches("[]").to_string();
            let raw_type = cleaned[..last_word_start].trim().to_string();
            if var_name.is_empty() || raw_type.is_empty() {
                return None;
            }
            let extra_dims = if cleaned[last_word_start..].trim().ends_with("[]") {
                "[]"
            } else {
                ""
            };
            let type_name = normalize_java_type_expr(&format!("{raw_type}{extra_dims}"));

            let mut location_hint = None;
            let mut explicit_name = None;
            let mut default_value = None;
            let mut required = false;
            let mut example = None;
            let mut description = None;
            let mut json_name = None;
            let mut constraints = ApiFieldConstraints::default();
            let mut has_constraints = false;

            for ann in &anns {
                match ann.name.as_str() {
                    "RequestBody" => {
                        location_hint = Some("body".into());
                        if let Some(req) = extract_ann_bool(ann, "required") {
                            required = req;
                        } else {
                            required = true;
                        }
                    }
                    "PathVariable" | "PathParam" => {
                        location_hint = Some("path".into());
                        explicit_name = extract_ann_single_str(ann, &["value", "name"]);
                        required = extract_ann_bool(ann, "required").unwrap_or(true);
                    }
                    "RequestParam" | "QueryParam" => {
                        location_hint = Some("query".into());
                        explicit_name = extract_ann_single_str(ann, &["value", "name"]);
                        default_value = extract_ann_single_str(ann, &["defaultValue"]);
                        required = extract_ann_bool(ann, "required")
                            .unwrap_or_else(|| default_value.is_none());
                    }
                    "RequestHeader" | "HeaderParam" => {
                        location_hint = Some("header".into());
                        explicit_name = extract_ann_single_str(ann, &["value", "name"]);
                        default_value = extract_ann_single_str(ann, &["defaultValue"]);
                        required = extract_ann_bool(ann, "required")
                            .unwrap_or_else(|| default_value.is_none());
                    }
                    "ModelAttribute" => {
                        location_hint = Some("queryObject".into());
                    }
                    "Schema" | "ApiModelProperty" | "Parameter" | "ApiParam" => {
                        if explicit_name.is_none() {
                            explicit_name = extract_ann_single_str(ann, &["name"]);
                        }
                        if example.is_none() {
                            example = extract_ann_single_str(ann, &["example"]);
                        }
                        if description.is_none() {
                            description = extract_ann_single_str(ann, &["description", "value"]);
                        }
                        if extract_ann_bool(ann, "required") == Some(true) {
                            required = true;
                        }
                    }
                    "JsonProperty" | "SerializedName" => {
                        json_name = extract_ann_single_str(ann, &["value"]);
                    }
                    "NotNull" | "NotBlank" | "NotEmpty" => required = true,
                    "Min" => {
                        constraints.min = extract_ann_number(ann, &["value"]);
                        has_constraints = true;
                    }
                    "Max" => {
                        constraints.max = extract_ann_number(ann, &["value"]);
                        has_constraints = true;
                    }
                    "Size" | "Length" => {
                        constraints.min_len = extract_ann_number(ann, &["min"]).map(|v| v.max(0.0) as usize);
                        constraints.max_len = extract_ann_number(ann, &["max"]).map(|v| v.max(0.0) as usize);
                        has_constraints = true;
                    }
                    "Email" => {
                        constraints.email = true;
                        has_constraints = true;
                    }
                    _ => {}
                }
            }

            Some(RawParamMeta {
                name: var_name,
                json_name,
                explicit_name,
                type_name,
                location_hint,
                required,
                default_value,
                example,
                description,
                constraints: if has_constraints { Some(constraints) } else { None },
            })
        })
        .collect()
}

fn finalize_endpoint_params(
    raw_params: &[RawParamMeta],
    endpoint_path: &str,
    http_method: &str,
) -> Vec<ApiParamDef> {
    let has_body = raw_params
        .iter()
        .any(|p| p.location_hint.as_deref() == Some("body"));
    let mut out = Vec::new();
    for p in raw_params {
        if is_ignored_injected_type(&p.type_name) {
            continue;
        }
        let param_name = p
            .explicit_name
            .clone()
            .unwrap_or_else(|| p.name.clone());
        let location = if let Some(loc) = &p.location_hint {
            if loc == "query" && !is_scalar_or_collection_type(&p.type_name) && p.explicit_name.is_none() {
                "queryObject".to_string()
            } else {
                loc.clone()
            }
        } else if endpoint_path.contains(&format!("{{{param_name}}}"))
            || endpoint_path.contains(&format!("{{{param_name}:"))
        {
            "path".to_string()
        } else if !is_scalar_or_collection_type(&p.type_name) {
            if has_body || matches!(http_method, "GET" | "DELETE" | "HEAD") {
                "queryObject".to_string()
            } else {
                "queryObject".to_string()
            }
        } else {
            "query".to_string()
        };

        out.push(ApiParamDef {
            name: param_name,
            location,
            type_name: p.type_name.clone(),
            required: p.required,
            default_value: p.default_value.clone(),
            example: p.example.clone(),
            description: p.description.clone(),
            inferred_name: false,
        });
    }
    out
}

fn strip_leading_modifiers(raw: &str) -> String {
    let mut s = raw.trim();
    loop {
        let mut matched = false;
        for kw in [
            "public ",
            "private ",
            "protected ",
            "static ",
            "final ",
            "transient ",
            "volatile ",
            "abstract ",
            "default ",
            "synchronized ",
            "native ",
        ] {
            if let Some(rest) = s.strip_prefix(kw) {
                s = rest.trim_start();
                matched = true;
                break;
            }
        }
        if !matched {
            break;
        }
    }
    s.to_string()
}

fn parse_java_field(
    anns: &[ParsedAnn],
    doc: Option<String>,
    decl: &str,
    fields: &mut Vec<ApiFieldDef>,
) {
    // Ignore static/transient fields
    let padded = format!(" {decl} ");
    if padded.contains(" static ") || padded.contains(" transient ") {
        return;
    }
    for ann in anns {
        if ann.name == "JsonIgnore" && extract_ann_bool(ann, "value") != Some(false) {
            return;
        }
    }
    let clean = strip_leading_modifiers(decl);
    // Split multiple declarators: e.g. int a = 3, b
    let decl_parts = split_top_level(&clean, ',');
    if decl_parts.is_empty() {
        return;
    }
    // Extract type from first declarator
    let first_left = split_first_top_level_eq(&decl_parts[0])
        .map(|(l, _)| l.trim())
        .unwrap_or_else(|| decl_parts[0].trim());
    let mut type_end = 0usize;
    for (idx, ch) in first_left.char_indices().rev() {
        if ch.is_whitespace() || ch == '>' || ch == ']' {
            type_end = idx + ch.len_utf8();
            break;
        }
    }
    let raw_type = first_left[..type_end].trim();
    if raw_type.is_empty() {
        return;
    }

    let mut rename: Option<String> = None;
    let mut required = false;
    let mut example: Option<String> = None;
    let mut description = doc;
    let mut constraints = ApiFieldConstraints::default();
    let mut has_constraints = false;

    for ann in anns {
        match ann.name.as_str() {
            "JsonProperty" | "SerializedName" => {
                rename = extract_ann_single_str(ann, &["value"]);
            }
            "Schema" | "ApiModelProperty" => {
                if example.is_none() {
                    example = extract_ann_single_str(ann, &["example"]);
                }
                if description.is_none() {
                    description = extract_ann_single_str(ann, &["description", "value"]);
                }
                if extract_ann_bool(ann, "required") == Some(true) {
                    required = true;
                }
            }
            "NotNull" | "NotBlank" | "NotEmpty" => required = true,
            "Min" => {
                constraints.min = extract_ann_number(ann, &["value"]);
                has_constraints = true;
            }
            "Max" => {
                constraints.max = extract_ann_number(ann, &["value"]);
                has_constraints = true;
            }
            "Size" | "Length" => {
                constraints.min_len = extract_ann_number(ann, &["min"]).map(|v| v.max(0.0) as usize);
                constraints.max_len = extract_ann_number(ann, &["max"]).map(|v| v.max(0.0) as usize);
                has_constraints = true;
            }
            "Email" => {
                constraints.email = true;
                has_constraints = true;
            }
            _ => {}
        }
    }

    for (idx, part) in decl_parts.iter().enumerate() {
        let (lhs, init) = split_first_top_level_eq(part)
            .map(|(l, r)| (l.trim(), Some(r.trim())))
            .unwrap_or((part.trim(), None));
        let java_name_raw = if idx == 0 {
            lhs[type_end..].trim()
        } else {
            lhs
        };
        let extra_dims = if java_name_raw.ends_with("[]") { "[]" } else { "" };
        let java_name = java_name_raw.trim_end_matches("[]").trim().to_string();
        if java_name.is_empty() || !java_name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') {
            continue;
        }
        let field_example = example.clone().or_else(|| {
            let init_val = init?;
            if init_val.starts_with('"') && init_val.ends_with('"') && init_val.len() >= 2 {
                serde_json::from_str::<String>(init_val).ok()
            } else if matches!(init_val, "true" | "false")
                || init_val.trim_start_matches('-').parse::<f64>().is_ok()
            {
                Some(init_val.to_string())
            } else {
                None
            }
        });
        let name = if idx == 0 {
            rename.clone().unwrap_or_else(|| java_name.clone())
        } else {
            java_name.clone()
        };
        fields.push(ApiFieldDef {
            name,
            java_name,
            type_name: normalize_java_type_expr(&format!("{raw_type}{extra_dims}")),
            required,
            example: field_example,
            description: description.clone(),
            constraints: if has_constraints { Some(constraints.clone()) } else { None },
        });
    }
}

// ---------- Safe ZIP & JAR / Fat-JAR Scanner ----------

#[derive(Clone, Debug)]
struct ZipEntry {
    name: String,
    compression_method: u16,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

fn read_u16_le(b: &[u8], off: usize) -> Option<u16> {
    let slice: [u8; 2] = b.get(off..off + 2)?.try_into().ok()?;
    Some(u16::from_le_bytes(slice))
}

fn read_u32_le(b: &[u8], off: usize) -> Option<u32> {
    let slice: [u8; 4] = b.get(off..off + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(slice))
}

fn read_u64_le(b: &[u8], off: usize) -> Option<u64> {
    let slice: [u8; 8] = b.get(off..off + 8)?.try_into().ok()?;
    Some(u64::from_le_bytes(slice))
}

fn parse_zip_directory(data: &[u8]) -> Result<Vec<ZipEntry>, String> {
    if data.len() < 22 {
        return Err("JAR/ZIP 文件过小或格式无效".into());
    }
    let min_pos = data.len().saturating_sub(65_557);
    let mut eocd_pos = None;
    for pos in (min_pos..=data.len() - 22).rev() {
        if read_u32_le(data, pos) == Some(0x0605_4b50) {
            let comment_len = read_u16_le(data, pos + 20).unwrap_or(0) as usize;
            if pos + 22 + comment_len == data.len() {
                eocd_pos = Some(pos);
                break;
            }
        }
    }
    let eocd_pos = eocd_pos.ok_or_else(|| "未找到 ZIP Central Directory 结尾标记".to_string())?;
    let total_entries16 = read_u16_le(data, eocd_pos + 10).unwrap_or(0);
    let cd_size32 = read_u32_le(data, eocd_pos + 12).unwrap_or(0);
    let cd_offset32 = read_u32_le(data, eocd_pos + 16).unwrap_or(0);

    let mut total_entries = total_entries16 as u64;
    let mut cd_size = cd_size32 as u64;
    let mut cd_offset = cd_offset32 as u64;

    if (total_entries16 == u16::MAX || cd_offset32 == u32::MAX || cd_size32 == u32::MAX)
        && eocd_pos >= 20
        && read_u32_le(data, eocd_pos - 20) == Some(0x0706_4b50)
    {
        if let Some(zip64_offset) = read_u64_le(data, eocd_pos - 12).map(|v| v as usize) {
            if read_u32_le(data, zip64_offset) == Some(0x0606_4b50) {
                total_entries = read_u64_le(data, zip64_offset + 32).unwrap_or(total_entries);
                cd_size = read_u64_le(data, zip64_offset + 40).unwrap_or(cd_size);
                cd_offset = read_u64_le(data, zip64_offset + 48).unwrap_or(cd_offset);
            }
        }
    }

    if total_entries > MAX_ZIP_ENTRIES as u64 {
        return Err(format!("压缩包条目数（{total_entries}）超过 {MAX_ZIP_ENTRIES} 安全上限"));
    }
    let cd_start = cd_offset as usize;
    let cd_end = cd_start
        .checked_add(cd_size as usize)
        .filter(|&end| end <= data.len())
        .ok_or_else(|| "ZIP Central Directory 范围越界".to_string())?;

    let mut entries = Vec::with_capacity(total_entries as usize);
    let mut pos = cd_start;
    for _ in 0..total_entries {
        if pos + 46 > cd_end || read_u32_le(data, pos) != Some(0x0201_4b50) {
            return Err("ZIP Central Directory 条目损坏".into());
        }
        let compression_method = read_u16_le(data, pos + 10).unwrap_or(0);
        let mut compressed_size = read_u32_le(data, pos + 20).unwrap_or(0) as u64;
        let mut uncompressed_size = read_u32_le(data, pos + 24).unwrap_or(0) as u64;
        let name_len = read_u16_le(data, pos + 28).unwrap_or(0) as usize;
        let extra_len = read_u16_le(data, pos + 30).unwrap_or(0) as usize;
        let comment_len = read_u16_le(data, pos + 32).unwrap_or(0) as usize;
        let mut local_header_offset = read_u32_le(data, pos + 42).unwrap_or(0) as u64;

        let name_start = pos + 46;
        let name_end = name_start + name_len;
        let extra_end = name_end + extra_len;
        let next_pos = extra_end + comment_len;
        if next_pos > cd_end {
            return Err("ZIP Central Directory 名称越界".into());
        }
        let name = String::from_utf8_lossy(&data[name_start..name_end]).into_owned();

        // Parse ZIP64 extra field (0x0001) if needed
        let extra = &data[name_end..extra_end];
        let mut ex = 0usize;
        while ex + 4 <= extra.len() {
            let hdr_id = read_u16_le(extra, ex).unwrap_or(0);
            let field_sz = read_u16_le(extra, ex + 2).unwrap_or(0) as usize;
            let val_start = ex + 4;
            let val_end = val_start.saturating_add(field_sz).min(extra.len());
            if hdr_id == 0x0001 {
                let mut cur = val_start;
                if uncompressed_size == u32::MAX as u64 && cur + 8 <= val_end {
                    uncompressed_size = read_u64_le(extra, cur).unwrap_or(uncompressed_size);
                    cur += 8;
                }
                if compressed_size == u32::MAX as u64 && cur + 8 <= val_end {
                    compressed_size = read_u64_le(extra, cur).unwrap_or(compressed_size);
                    cur += 8;
                }
                if local_header_offset == u32::MAX as u64 && cur + 8 <= val_end {
                    local_header_offset = read_u64_le(extra, cur).unwrap_or(local_header_offset);
                }
                break;
            }
            ex = val_end;
        }

        entries.push(ZipEntry {
            name,
            compression_method,
            compressed_size,
            uncompressed_size,
            local_header_offset,
        });
        pos = next_pos;
    }

    Ok(entries)
}

fn read_zip_entry(data: &[u8], entry: &ZipEntry, max_bytes: usize) -> Result<Vec<u8>, String> {
    if entry.uncompressed_size > max_bytes as u64 {
        return Err(format!(
            "条目 {} 体积过大（{} 字节）",
            entry.name, entry.uncompressed_size
        ));
    }
    let lfh = entry.local_header_offset as usize;
    if lfh + 30 > data.len() || read_u32_le(data, lfh) != Some(0x0403_4b50) {
        return Err(format!("ZIP Local File Header 损坏：{}", entry.name));
    }
    let name_len = read_u16_le(data, lfh + 26).unwrap_or(0) as usize;
    let extra_len = read_u16_le(data, lfh + 28).unwrap_or(0) as usize;
    let payload_start = lfh + 30 + name_len + extra_len;
    let payload_end = payload_start
        .checked_add(entry.compressed_size as usize)
        .filter(|&e| e <= data.len())
        .ok_or_else(|| format!("条目 {} 压缩载荷越界", entry.name))?;
    let payload = &data[payload_start..payload_end];
    match entry.compression_method {
        0 => {
            if payload.len() > max_bytes {
                return Err(format!("条目 {} 超出大小上限", entry.name));
            }
            Ok(payload.to_vec())
        }
        8 => {
            let mut decoder = DeflateDecoder::new(payload).take((max_bytes + 1) as u64);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|e| format!("解压条目 {} 失败：{e}", entry.name))?;
            if out.len() > max_bytes {
                return Err(format!("条目 {} 解压体积超出上限", entry.name));
            }
            Ok(out)
        }
        other => Err(format!("条目 {} 使用了不支持的压缩方法 {other}", entry.name)),
    }
}

fn should_skip_nested_jar(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    for prefix in [
        "spring-",
        "tomcat-",
        "jackson-",
        "netty-",
        "hibernate-",
        "slf4j-",
        "logback-",
        "log4j-",
        "guava-",
        "junit-",
        "kotlin-",
        "reactor-",
        "micrometer-",
        "mysql-",
        "postgresql-",
        "mariadb-",
        "sqlite-",
        "swagger-",
        "springdoc-",
        "springfox-",
        "jakarta.",
        "javax.",
        "aspectj",
        "byte-buddy",
        "bytebuddy",
        "asm-",
        "cglib-",
        "snakeyaml-",
        "commons-",
        "httpclient",
        "httpcore",
        "okhttp",
        "okio",
        "fastjson",
        "hutool-",
        "mybatis",
        "druid-",
        "hikaricp-",
        "lettuce-",
        "jedis-",
        "protobuf-",
        "grpc-",
        "bouncycastle",
        "bcprov-",
        "checker-qual",
        "annotations-",
        "error_prone",
        "j2objc-",
    ] {
        if base.starts_with(prefix) {
            return true;
        }
    }
    false
}

fn should_skip_class_entry(name: &str) -> bool {
    let clean = name.strip_prefix("BOOT-INF/classes/").unwrap_or(name);
    for prefix in [
        "java/",
        "javax/",
        "jakarta/",
        "sun/",
        "com/sun/",
        "org/springframework/",
        "org/apache/",
        "com/fasterxml/",
        "io/netty/",
        "org/hibernate/",
        "org/slf4j/",
        "ch/qos/logback/",
        "reactor/",
        "io/micrometer/",
        "io/swagger/",
        "org/springdoc/",
        "kotlin/",
    ] {
        if clean.starts_with(prefix) {
            return true;
        }
    }
    clean.ends_with("module-info.class") || clean.ends_with("package-info.class")
}

fn scan_jar_bytes(path: &Path, bytes: &[u8]) -> Result<ApiCatalogResult, String> {
    let source_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("app.jar")
        .to_string();
    let entries = parse_zip_directory(bytes)?;
    let is_fat_jar = entries
        .iter()
        .any(|e| e.name.starts_with("BOOT-INF/classes/") || e.name.starts_with("BOOT-INF/lib/"));
    let mut acc = ScanAccumulator::new(
        source_name,
        if is_fat_jar { "spring-fat-jar" } else { "jar" },
        &path.to_string_lossy(),
    );

    let mut nested_jars = Vec::new();
    for entry in &entries {
        let lower = entry.name.to_ascii_lowercase();
        if lower == "application.yml"
            || lower == "application.yaml"
            || lower == "boot-inf/classes/application.yml"
            || lower == "boot-inf/classes/application.yaml"
            || lower == "bootstrap.yml"
            || lower == "boot-inf/classes/bootstrap.yml"
        {
            if let Ok(raw) = read_zip_entry(bytes, entry, MAX_ENTRY_CLASS_BYTES) {
                acc.stats.files_scanned += 1;
                parse_spring_yaml(
                    &String::from_utf8_lossy(&raw),
                    &mut acc.port,
                    &mut acc.context_path,
                );
            }
            continue;
        }
        if lower == "application.properties" || lower == "boot-inf/classes/application.properties" {
            if let Ok(raw) = read_zip_entry(bytes, entry, MAX_ENTRY_CLASS_BYTES) {
                acc.stats.files_scanned += 1;
                parse_spring_properties(
                    &String::from_utf8_lossy(&raw),
                    &mut acc.port,
                    &mut acc.context_path,
                );
            }
            continue;
        }
        if lower.starts_with("boot-inf/lib/") && lower.ends_with(".jar") {
            nested_jars.push(entry);
            continue;
        }
        if lower.ends_with(".class") {
            if is_fat_jar && !entry.name.starts_with("BOOT-INF/classes/") {
                continue;
            }
            if should_skip_class_entry(&entry.name) {
                continue;
            }
            if let Ok(raw) = read_zip_entry(bytes, entry, MAX_ENTRY_CLASS_BYTES) {
                acc.stats.files_scanned += 1;
                let rel = entry
                    .name
                    .strip_prefix("BOOT-INF/classes/")
                    .unwrap_or(&entry.name);
                if let Err(err) = parse_class_bytes(&raw, rel, &mut acc, false) {
                    acc.warnings.insert(format!("解析字节码 {rel} 失败：{err}"));
                }
            }
        }
    }

    // Pass 2: resolve missing referenced DTO/enum types from BOOT-INF/lib/*.jar (up to 3 transitive passes)
    if !nested_jars.is_empty() {
        let candidate_jars: Vec<&ZipEntry> = nested_jars
            .into_iter()
            .filter(|e| !should_skip_nested_jar(&e.name))
            .take(MAX_NESTED_JARS)
            .collect();
        let mut parsed_nested_classes = Vec::new();
        for jar_entry in candidate_jars {
            let Ok(jar_bytes) = read_zip_entry(bytes, jar_entry, MAX_ENTRY_JAR_BYTES) else {
                continue;
            };
            let Ok(inner_entries) = parse_zip_directory(&jar_bytes) else {
                continue;
            };
            for inner in inner_entries {
                if inner.name.ends_with(".class") && !should_skip_class_entry(&inner.name) {
                    parsed_nested_classes.push((jar_bytes.clone(), inner));
                }
            }
            // Limit memory if too many nested classes buffered
            if parsed_nested_classes.len() > MAX_ZIP_ENTRIES {
                break;
            }
        }
        for _pass in 0..3 {
            let needed = collect_unresolved_type_names(&acc);
            if needed.is_empty() {
                break;
            }
            let before = acc.types.len();
            for (jar_buf, inner) in &parsed_nested_classes {
                let class_full = inner
                    .name
                    .trim_end_matches(".class")
                    .replace('/', ".");
                let class_simple = class_full.rsplit('.').next().unwrap_or(&class_full);
                if !needed.contains(&class_full) && !needed.contains(class_simple) {
                    continue;
                }
                if acc.types.contains_key(&class_full) {
                    continue;
                }
                if let Ok(raw) = read_zip_entry(jar_buf, inner, MAX_ENTRY_CLASS_BYTES) {
                    let _ = parse_class_bytes(&raw, &inner.name, &mut acc, true);
                }
            }
            if acc.types.len() == before {
                break;
            }
        }
    }

    Ok(acc.finish())
}

fn collect_unresolved_type_names(acc: &ScanAccumulator) -> HashSet<String> {
    let mut known_simple = HashSet::new();
    for t in acc.types.values() {
        known_simple.insert(t.name.clone());
        known_simple.insert(t.full_name.clone());
    }
    let mut needed = HashSet::new();
    let mut inspect_type = |expr: &str| {
        for tok in expr.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$' && c != '.') {
            if tok.is_empty() || is_scalar_or_collection_type(tok) || tok == "?" {
                continue;
            }
            let s = simple_type_name(tok);
            if !known_simple.contains(tok) && !known_simple.contains(s) {
                needed.insert(tok.to_string());
                needed.insert(s.to_string());
            }
        }
    };
    for ep in &acc.endpoints {
        for p in &ep.params {
            inspect_type(&p.type_name);
        }
    }
    for t in acc.types.values() {
        if let Some(sup) = &t.super_class {
            inspect_type(sup);
        }
        for f in &t.fields {
            inspect_type(&f.type_name);
        }
    }
    needed
}

// ---------- JVM .class Bytecode Parser ----------

#[derive(Clone, Debug)]
enum CpEntry {
    Empty,
    Utf8(String),
    Int(i32),
    Float(f32),
    Long(i64),
    Double(f64),
    Class(u16),
    StringRef(u16),
    Other,
}

#[derive(Clone, Debug)]
enum AnnVal {
    Str(String),
    Bool(bool),
    Num(String),
    Enum(String, String),
    Class(String),
    Array(Vec<AnnVal>),
    Nested(ClassAnn),
}

#[derive(Clone, Debug)]
struct ClassAnn {
    simple_name: String,
    values: BTreeMap<String, AnnVal>,
}

struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, pos: 0 }
    }
    fn u1(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.pos).ok_or("字节码意外结束")?;
        self.pos += 1;
        Ok(v)
    }
    fn u2(&mut self) -> Result<u16, String> {
        let s: [u8; 2] = self
            .b
            .get(self.pos..self.pos + 2)
            .ok_or("字节码意外结束")?
            .try_into()
            .unwrap();
        self.pos += 2;
        Ok(u16::from_be_bytes(s))
    }
    fn u4(&mut self) -> Result<u32, String> {
        let s: [u8; 4] = self
            .b
            .get(self.pos..self.pos + 4)
            .ok_or("字节码意外结束")?
            .try_into()
            .unwrap();
        self.pos += 4;
        Ok(u32::from_be_bytes(s))
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        if self.pos + n > self.b.len() {
            return Err("字节码长度越界".into());
        }
        self.pos += n;
        Ok(())
    }
    fn slice(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).ok_or("字节码长度溢出")?;
        let s = self.b.get(self.pos..end).ok_or("字节码长度越界")?;
        self.pos = end;
        Ok(s)
    }
}

fn cp_utf8(cp: &[CpEntry], idx: u16) -> Option<&str> {
    match cp.get(idx as usize)? {
        CpEntry::Utf8(s) => Some(s.as_str()),
        _ => None,
    }
}

fn cp_class_name(cp: &[CpEntry], idx: u16) -> Option<String> {
    match cp.get(idx as usize)? {
        CpEntry::Class(name_idx) => cp_utf8(cp, *name_idx).map(|s| s.replace('/', ".")),
        _ => None,
    }
}

fn read_constant_pool(cur: &mut Cursor<'_>) -> Result<Vec<CpEntry>, String> {
    let count = cur.u2()? as usize;
    let mut cp = vec![CpEntry::Empty; count];
    let mut i = 1usize;
    while i < count {
        let tag = cur.u1()?;
        match tag {
            1 => {
                let len = cur.u2()? as usize;
                let bytes = cur.slice(len)?;
                cp[i] = CpEntry::Utf8(String::from_utf8_lossy(bytes).into_owned());
            }
            3 => {
                let v = cur.u4()? as i32;
                cp[i] = CpEntry::Int(v);
            }
            4 => {
                let v = f32::from_bits(cur.u4()?);
                cp[i] = CpEntry::Float(v);
            }
            5 => {
                let hi = cur.u4()? as u64;
                let lo = cur.u4()? as u64;
                cp[i] = CpEntry::Long(((hi << 32) | lo) as i64);
                i += 1;
            }
            6 => {
                let hi = cur.u4()? as u64;
                let lo = cur.u4()? as u64;
                cp[i] = CpEntry::Double(f64::from_bits((hi << 32) | lo));
                i += 1;
            }
            7 => {
                let idx = cur.u2()?;
                cp[i] = CpEntry::Class(idx);
            }
            8 => {
                let idx = cur.u2()?;
                cp[i] = CpEntry::StringRef(idx);
            }
            9 | 10 | 11 | 12 | 17 | 18 => {
                cur.skip(4)?;
                cp[i] = CpEntry::Other;
            }
            15 => {
                cur.skip(3)?;
                cp[i] = CpEntry::Other;
            }
            16 | 19 | 20 => {
                cur.skip(2)?;
                cp[i] = CpEntry::Other;
            }
            other => return Err(format!("未知常量池标签 {other}")),
        }
        i += 1;
    }
    Ok(cp)
}

fn read_annotation(cur: &mut Cursor<'_>, cp: &[CpEntry]) -> Result<ClassAnn, String> {
    let type_idx = cur.u2()?;
    let desc = cp_utf8(cp, type_idx).unwrap_or("");
    let simple_name = jvm_descriptor_to_java_type(desc);
    let simple = simple_type_name(&simple_name).to_string();
    let num_pairs = cur.u2()?;
    let mut values = BTreeMap::new();
    for _ in 0..num_pairs {
        let name_idx = cur.u2()?;
        let key = cp_utf8(cp, name_idx).unwrap_or("value").to_string();
        let val = read_element_value(cur, cp)?;
        values.insert(key, val);
    }
    Ok(ClassAnn {
        simple_name: simple,
        values,
    })
}

fn read_element_value(cur: &mut Cursor<'_>, cp: &[CpEntry]) -> Result<AnnVal, String> {
    let tag = cur.u1()? as char;
    match tag {
        's' => {
            let idx = cur.u2()?;
            Ok(AnnVal::Str(cp_utf8(cp, idx).unwrap_or("").to_string()))
        }
        'Z' => {
            let idx = cur.u2()?;
            let b = matches!(cp.get(idx as usize), Some(CpEntry::Int(v)) if *v != 0);
            Ok(AnnVal::Bool(b))
        }
        'B' | 'C' | 'S' | 'I' => {
            let idx = cur.u2()?;
            let num = match cp.get(idx as usize) {
                Some(CpEntry::Int(v)) => v.to_string(),
                _ => "0".into(),
            };
            Ok(AnnVal::Num(num))
        }
        'J' => {
            let idx = cur.u2()?;
            let num = match cp.get(idx as usize) {
                Some(CpEntry::Long(v)) => v.to_string(),
                _ => "0".into(),
            };
            Ok(AnnVal::Num(num))
        }
        'F' => {
            let idx = cur.u2()?;
            let num = match cp.get(idx as usize) {
                Some(CpEntry::Float(v)) => v.to_string(),
                _ => "0".into(),
            };
            Ok(AnnVal::Num(num))
        }
        'D' => {
            let idx = cur.u2()?;
            let num = match cp.get(idx as usize) {
                Some(CpEntry::Double(v)) => v.to_string(),
                _ => "0".into(),
            };
            Ok(AnnVal::Num(num))
        }
        'e' => {
            let type_idx = cur.u2()?;
            let const_idx = cur.u2()?;
            let enum_type = jvm_descriptor_to_java_type(cp_utf8(cp, type_idx).unwrap_or(""));
            let enum_const = cp_utf8(cp, const_idx).unwrap_or("").to_string();
            Ok(AnnVal::Enum(
                simple_type_name(&enum_type).to_string(),
                enum_const,
            ))
        }
        'c' => {
            let idx = cur.u2()?;
            let cls = jvm_descriptor_to_java_type(cp_utf8(cp, idx).unwrap_or(""));
            Ok(AnnVal::Class(cls))
        }
        '@' => Ok(AnnVal::Nested(read_annotation(cur, cp)?)),
        '[' => {
            let len = cur.u2()?;
            let mut items = Vec::with_capacity(len as usize);
            for _ in 0..len {
                items.push(read_element_value(cur, cp)?);
            }
            Ok(AnnVal::Array(items))
        }
        other => Err(format!("未知注解值标签 {other}")),
    }
}

fn read_annotations_attr(bytes: &[u8], cp: &[CpEntry]) -> Result<Vec<ClassAnn>, String> {
    let mut cur = Cursor::new(bytes);
    let count = cur.u2()?;
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(read_annotation(&mut cur, cp)?);
    }
    Ok(out)
}

fn read_param_annotations_attr(bytes: &[u8], cp: &[CpEntry]) -> Result<Vec<Vec<ClassAnn>>, String> {
    let mut cur = Cursor::new(bytes);
    let param_count = cur.u1()?;
    let mut out = Vec::with_capacity(param_count as usize);
    for _ in 0..param_count {
        let ann_count = cur.u2()?;
        let mut anns = Vec::with_capacity(ann_count as usize);
        for _ in 0..ann_count {
            anns.push(read_annotation(&mut cur, cp)?);
        }
        out.push(anns);
    }
    Ok(out)
}

fn read_method_parameters_attr(bytes: &[u8], cp: &[CpEntry]) -> Result<Vec<Option<String>>, String> {
    let mut cur = Cursor::new(bytes);
    let count = cur.u1()?;
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let name_idx = cur.u2()?;
        let _flags = cur.u2()?;
        let name = if name_idx == 0 {
            None
        } else {
            cp_utf8(cp, name_idx).map(String::from)
        };
        out.push(name);
    }
    Ok(out)
}

fn read_lvt_param_names(code_bytes: &[u8], cp: &[CpEntry], is_static: bool, param_count: usize) -> Vec<Option<String>> {
    let mut cur = Cursor::new(code_bytes);
    let Ok(_max_stack) = cur.u2() else { return Vec::new(); };
    let Ok(_max_locals) = cur.u2() else { return Vec::new(); };
    let Ok(code_len) = cur.u4() else { return Vec::new(); };
    if cur.skip(code_len as usize).is_err() {
        return Vec::new();
    }
    let Ok(exc_len) = cur.u2() else { return Vec::new(); };
    if cur.skip(exc_len as usize * 8).is_err() {
        return Vec::new();
    }
    let Ok(attr_count) = cur.u2() else { return Vec::new(); };
    let mut slot_names: BTreeMap<u16, String> = BTreeMap::new();
    for _ in 0..attr_count {
        let Ok(name_idx) = cur.u2() else { break; };
        let Ok(len) = cur.u4() else { break; };
        let Ok(slice) = cur.slice(len as usize) else { break; };
        if cp_utf8(cp, name_idx) == Some("LocalVariableTable") {
            let mut lcur = Cursor::new(slice);
            if let Ok(entries) = lcur.u2() {
                for _ in 0..entries {
                    let (Ok(_start_pc), Ok(_len), Ok(n_idx), Ok(_desc_idx), Ok(slot)) =
                        (lcur.u2(), lcur.u2(), lcur.u2(), lcur.u2(), lcur.u2())
                    else {
                        break;
                    };
                    if let Some(n) = cp_utf8(cp, n_idx) {
                        slot_names.entry(slot).or_insert_with(|| n.to_string());
                    }
                }
            }
        }
    }
    if slot_names.is_empty() {
        return Vec::new();
    }
    let start_slot: u16 = if is_static { 0 } else { 1 };
    let mut out = Vec::with_capacity(param_count);
    let mut slot = start_slot;
    for _ in 0..param_count {
        let name = slot_names.get(&slot).cloned();
        out.push(name);
        slot += 1;
    }
    out
}

fn ann_val_strings(val: &AnnVal) -> Vec<String> {
    match val {
        AnnVal::Str(s) => vec![s.clone()],
        AnnVal::Enum(_, c) => vec![c.clone()],
        AnnVal::Num(n) => vec![n.clone()],
        AnnVal::Bool(b) => vec![b.to_string()],
        AnnVal::Array(items) => items.iter().flat_map(ann_val_strings).collect(),
        _ => Vec::new(),
    }
}

fn ann_get_str(ann: &ClassAnn, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = ann.values.get(*k) {
            if let Some(first) = ann_val_strings(v).into_iter().find(|s| !s.is_empty()) {
                return Some(first);
            }
        }
    }
    None
}

fn ann_get_bool(ann: &ClassAnn, key: &str) -> Option<bool> {
    match ann.values.get(key)? {
        AnnVal::Bool(b) => Some(*b),
        _ => None,
    }
}

fn ann_get_num(ann: &ClassAnn, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(v) = ann.values.get(*k) {
            match v {
                AnnVal::Num(n) => {
                    if let Ok(parsed) = n.parse::<f64>() {
                        return Some(parsed);
                    }
                }
                AnnVal::Str(s) => {
                    if let Ok(parsed) = s.trim().parse::<f64>() {
                        return Some(parsed);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn parse_jvm_type_at(sig: &[char], pos: &mut usize) -> String {
    if *pos >= sig.len() {
        return "Object".into();
    }
    match sig[*pos] {
        'B' => { *pos += 1; "byte".into() }
        'C' => { *pos += 1; "char".into() }
        'D' => { *pos += 1; "double".into() }
        'F' => { *pos += 1; "float".into() }
        'I' => { *pos += 1; "int".into() }
        'J' => { *pos += 1; "long".into() }
        'S' => { *pos += 1; "short".into() }
        'Z' => { *pos += 1; "boolean".into() }
        'V' => { *pos += 1; "void".into() }
        '[' => {
            *pos += 1;
            format!("{}[]", parse_jvm_type_at(sig, pos))
        }
        'T' => {
            *pos += 1;
            let start = *pos;
            while *pos < sig.len() && sig[*pos] != ';' {
                *pos += 1;
            }
            let name: String = sig[start..*pos].iter().collect();
            if *pos < sig.len() && sig[*pos] == ';' {
                *pos += 1;
            }
            if name.is_empty() { "Object".into() } else { name }
        }
        '+' | '-' => {
            *pos += 1;
            parse_jvm_type_at(sig, pos)
        }
        '*' => {
            *pos += 1;
            "Object".into()
        }
        'L' => {
            *pos += 1;
            let mut segments = Vec::new();
            loop {
                let start = *pos;
                while *pos < sig.len() && sig[*pos] != ';' && sig[*pos] != '<' && sig[*pos] != '.' {
                    *pos += 1;
                }
                let seg: String = sig[start..*pos].iter().collect();
                let clean = seg.replace('/', ".");
                let mut gen_args = Vec::new();
                if *pos < sig.len() && sig[*pos] == '<' {
                    *pos += 1;
                    while *pos < sig.len() && sig[*pos] != '>' {
                        gen_args.push(parse_jvm_type_at(sig, pos));
                    }
                    if *pos < sig.len() && sig[*pos] == '>' {
                        *pos += 1;
                    }
                }
                segments.push((clean, gen_args));
                if *pos < sig.len() && sig[*pos] == '.' {
                    *pos += 1;
                    continue;
                }
                if *pos < sig.len() && sig[*pos] == ';' {
                    *pos += 1;
                }
                break;
            }
            if let Some((last_cls, gen_args)) = segments.pop() {
                let simple = simple_type_name(&last_cls).to_string();
                if gen_args.is_empty() {
                    simple
                } else {
                    format!("{simple}<{}>", gen_args.join(", "))
                }
            } else {
                "Object".into()
            }
        }
        _ => {
            *pos += 1;
            "Object".into()
        }
    }
}

fn jvm_descriptor_to_java_type(desc: &str) -> String {
    let chars: Vec<char> = desc.chars().collect();
    let mut pos = 0usize;
    parse_jvm_type_at(&chars, &mut pos)
}

fn jvm_method_params_from_sig(sig: &str) -> Vec<String> {
    let chars: Vec<char> = sig.chars().collect();
    let mut pos = 0usize;
    if chars.first() == Some(&'<') {
        let mut depth = 0usize;
        while pos < chars.len() {
            match chars[pos] {
                '<' => depth += 1,
                '>' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        pos += 1;
                        break;
                    }
                }
                _ => {}
            }
            pos += 1;
        }
    }
    while pos < chars.len() && chars[pos] != '(' {
        pos += 1;
    }
    if pos >= chars.len() {
        return Vec::new();
    }
    pos += 1;
    let mut params = Vec::new();
    while pos < chars.len() && chars[pos] != ')' {
        params.push(parse_jvm_type_at(&chars, &mut pos));
    }
    params
}

fn class_extract_mappings(anns: &[ClassAnn], is_class_level: bool) -> Vec<(Vec<String>, Vec<String>, Option<String>)> {
    let mut out = Vec::new();
    for ann in anns {
        let mapped: Option<Vec<String>> = match ann.simple_name.as_str() {
            "RequestMapping" => {
                let mut ms = Vec::new();
                if let Some(val) = ann.values.get("method") {
                    for s in ann_val_strings(val) {
                        let up = s.to_ascii_uppercase();
                        if matches!(up.as_str(), "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS") {
                            ms.push(up);
                        }
                    }
                }
                if ms.is_empty() && !is_class_level {
                    ms.push("GET".into());
                }
                Some(ms)
            }
            "GetMapping" | "GET" => Some(vec!["GET".into()]),
            "PostMapping" | "POST" => Some(vec!["POST".into()]),
            "PutMapping" | "PUT" => Some(vec!["PUT".into()]),
            "DeleteMapping" | "DELETE" => Some(vec!["DELETE".into()]),
            "PatchMapping" | "PATCH" => Some(vec!["PATCH".into()]),
            "Path" => Some(Vec::new()),
            _ => None,
        };
        let Some(methods_vec) = mapped else { continue };
        let mut paths = ann
            .values
            .get("path")
            .or_else(|| ann.values.get("value"))
            .map(ann_val_strings)
            .unwrap_or_default();
        if paths.is_empty() {
            paths.push(String::new());
        }
        let consumes = ann
            .values
            .get("consumes")
            .and_then(|v| ann_val_strings(v).into_iter().next());
        out.push((methods_vec, paths, consumes));
    }
    out
}

fn parse_class_bytes(
    bytes: &[u8],
    rel_path: &str,
    acc: &mut ScanAccumulator,
    types_only: bool,
) -> Result<(), String> {
    let mut cur = Cursor::new(bytes);
    if cur.u4()? != 0xCAFE_BABE {
        return Err("不是有效的 Java .class 字节码".into());
    }
    let _minor = cur.u2()?;
    let _major = cur.u2()?;
    let cp = read_constant_pool(&mut cur)?;
    let access_flags = cur.u2()?;
    let this_idx = cur.u2()?;
    let super_idx = cur.u2()?;
    let full_name = cp_class_name(&cp, this_idx).unwrap_or_else(|| rel_path.trim_end_matches(".class").replace('/', "."));
    let simple_name = full_name.rsplit(['.', '$']).next().unwrap_or(&full_name).to_string();
    let super_full = if super_idx == 0 {
        None
    } else {
        cp_class_name(&cp, super_idx)
    };
    let super_class = super_full
        .as_deref()
        .map(simple_type_name)
        .filter(|s| !matches!(*s, "" | "Object" | "Enum" | "Record"))
        .map(String::from);

    let iface_count = cur.u2()? as usize;
    cur.skip(iface_count * 2)?;

    let is_enum = (access_flags & 0x4000) != 0;
    let is_interface = (access_flags & 0x0200) != 0;

    // Parse fields
    let field_count = cur.u2()? as usize;
    let mut enum_values = Vec::new();
    let mut fields = Vec::new();
    for _ in 0..field_count {
        let f_flags = cur.u2()?;
        let f_name_idx = cur.u2()?;
        let f_desc_idx = cur.u2()?;
        let f_attr_count = cur.u2()? as usize;
        let f_name = cp_utf8(&cp, f_name_idx).unwrap_or("").to_string();
        let f_desc = cp_utf8(&cp, f_desc_idx).unwrap_or("").to_string();

        let mut f_sig: Option<String> = None;
        let mut f_anns = Vec::new();
        for _ in 0..f_attr_count {
            let a_name_idx = cur.u2()?;
            let a_len = cur.u4()? as usize;
            let a_slice = cur.slice(a_len)?;
            match cp_utf8(&cp, a_name_idx) {
                Some("Signature") if a_slice.len() >= 2 => {
                    if let Some(idx) = read_u16_le_be(a_slice) {
                        f_sig = cp_utf8(&cp, idx).map(String::from);
                    }
                }
                Some("RuntimeVisibleAnnotations") => {
                    if let Ok(parsed) = read_annotations_attr(a_slice, &cp) {
                        f_anns = parsed;
                    }
                }
                _ => {}
            }
        }

        // Enum constants have ACC_ENUM (0x4000) and ACC_STATIC (0x0008)
        if is_enum && (f_flags & 0x4000) != 0 {
            enum_values.push(f_name);
            continue;
        }
        // Skip static (0x0008), transient (0x0080), synthetic (0x1000)
        if (f_flags & (0x0008 | 0x0080 | 0x1000)) != 0 || f_name.starts_with('$') {
            continue;
        }
        if f_anns.iter().any(|a| a.simple_name == "JsonIgnore" && ann_get_bool(a, "value") != Some(false)) {
            continue;
        }

        let mut json_name = f_name.clone();
        let mut required = false;
        let mut example = None;
        let mut description = None;
        let mut constraints = ApiFieldConstraints::default();
        let mut has_constraints = false;
        for ann in &f_anns {
            match ann.simple_name.as_str() {
                "JsonProperty" | "SerializedName" => {
                    if let Some(r) = ann_get_str(ann, &["value"]) {
                        json_name = r;
                    }
                }
                "Schema" | "ApiModelProperty" => {
                    if example.is_none() {
                        example = ann_get_str(ann, &["example"]);
                    }
                    if description.is_none() {
                        description = ann_get_str(ann, &["description", "value"]);
                    }
                    if ann_get_bool(ann, "required") == Some(true) {
                        required = true;
                    }
                }
                "NotNull" | "NotBlank" | "NotEmpty" => required = true,
                "Min" => {
                    constraints.min = ann_get_num(ann, &["value"]);
                    has_constraints = true;
                }
                "Max" => {
                    constraints.max = ann_get_num(ann, &["value"]);
                    has_constraints = true;
                }
                "Size" | "Length" => {
                    constraints.min_len = ann_get_num(ann, &["min"]).map(|v| v.max(0.0) as usize);
                    constraints.max_len = ann_get_num(ann, &["max"]).map(|v| v.max(0.0) as usize);
                    has_constraints = true;
                }
                "Email" => {
                    constraints.email = true;
                    has_constraints = true;
                }
                _ => {}
            }
        }
        let type_str = jvm_descriptor_to_java_type(f_sig.as_deref().unwrap_or(&f_desc));
        fields.push(ApiFieldDef {
            name: json_name,
            java_name: f_name,
            type_name: type_str,
            required,
            example,
            description,
            constraints: if has_constraints { Some(constraints) } else { None },
        });
    }

    // Parse methods first (buffer raw parsed method records before knowing class annotations)
    struct ParsedByteMethod {
        name: String,
        is_static: bool,
        desc: String,
        sig: Option<String>,
        anns: Vec<ClassAnn>,
        param_anns: Vec<Vec<ClassAnn>>,
        param_names: Vec<Option<String>>,
        lvt_names: Vec<Option<String>>,
    }

    let method_count = cur.u2()? as usize;
    let mut methods = Vec::with_capacity(method_count);
    for _ in 0..method_count {
        let m_flags = cur.u2()?;
        let m_name_idx = cur.u2()?;
        let m_desc_idx = cur.u2()?;
        let m_attr_count = cur.u2()? as usize;
        let m_name = cp_utf8(&cp, m_name_idx).unwrap_or("").to_string();
        let m_desc = cp_utf8(&cp, m_desc_idx).unwrap_or("").to_string();
        let is_static = (m_flags & 0x0008) != 0;
        let is_synthetic = (m_flags & (0x1000 | 0x0040)) != 0;

        let mut m_sig = None;
        let mut m_anns = Vec::new();
        let mut p_anns = Vec::new();
        let mut p_names = Vec::new();
        let mut lvt_names = Vec::new();
        let raw_param_count = jvm_method_params_from_sig(&m_desc).len();

        for _ in 0..m_attr_count {
            let a_name_idx = cur.u2()?;
            let a_len = cur.u4()? as usize;
            let a_slice = cur.slice(a_len)?;
            match cp_utf8(&cp, a_name_idx) {
                Some("Signature") if a_slice.len() >= 2 => {
                    if let Some(idx) = read_u16_le_be(a_slice) {
                        m_sig = cp_utf8(&cp, idx).map(String::from);
                    }
                }
                Some("RuntimeVisibleAnnotations") => {
                    if let Ok(parsed) = read_annotations_attr(a_slice, &cp) {
                        m_anns = parsed;
                    }
                }
                Some("RuntimeVisibleParameterAnnotations") => {
                    if let Ok(parsed) = read_param_annotations_attr(a_slice, &cp) {
                        p_anns = parsed;
                    }
                }
                Some("MethodParameters") => {
                    if let Ok(parsed) = read_method_parameters_attr(a_slice, &cp) {
                        p_names = parsed;
                    }
                }
                Some("Code") if p_names.is_empty() => {
                    lvt_names = read_lvt_param_names(a_slice, &cp, is_static, raw_param_count);
                }
                _ => {}
            }
        }
        if !is_synthetic && !m_name.starts_with('<') && !types_only {
            methods.push(ParsedByteMethod {
                name: m_name,
                is_static,
                desc: m_desc,
                sig: m_sig,
                anns: m_anns,
                param_anns: p_anns,
                param_names: p_names,
                lvt_names,
            });
        }
    }

    // Parse class attributes
    let class_attr_count = cur.u2()? as usize;
    let mut class_anns = Vec::new();
    for _ in 0..class_attr_count {
        let a_name_idx = cur.u2()?;
        let a_len = cur.u4()? as usize;
        let a_slice = cur.slice(a_len)?;
        if cp_utf8(&cp, a_name_idx) == Some("RuntimeVisibleAnnotations") {
            if let Ok(parsed) = read_annotations_attr(a_slice, &cp) {
                class_anns = parsed;
            }
        }
    }

    let is_controller = class_anns.iter().any(|a| {
        matches!(
            a.simple_name.as_str(),
            "RestController" | "Controller" | "FeignClient" | "Path"
        )
    });
    let class_mappings = class_extract_mappings(&class_anns, true);
    let group_name = class_anns
        .iter()
        .find(|a| matches!(a.simple_name.as_str(), "Tag" | "Api"))
        .and_then(|a| ann_get_str(a, &["name", "tags", "value", "description"]))
        .unwrap_or_else(|| simple_name.clone());

    if !types_only && (is_controller || !class_mappings.is_empty()) {
        let mut found_eps = 0usize;
        let mut class_prefixes: Vec<String> = class_mappings
            .iter()
            .flat_map(|(_, ps, _)| ps.clone())
            .collect();
        if class_prefixes.is_empty() {
            class_prefixes.push(String::new());
        }
        let class_methods: Vec<String> = class_mappings
            .iter()
            .flat_map(|(ms, _, _)| ms.clone())
            .collect();

        for m in methods {
            let _ = m.is_static;
            let m_mappings = class_extract_mappings(&m.anns, false);
            if m_mappings.is_empty() {
                continue;
            }
            let summary = m
                .anns
                .iter()
                .find(|a| matches!(a.simple_name.as_str(), "Operation" | "ApiOperation"))
                .and_then(|a| ann_get_str(a, &["summary", "value", "notes", "description"]))
                .unwrap_or_else(|| m.name.clone());
            let mut param_types = jvm_method_params_from_sig(m.sig.as_deref().unwrap_or(&m.desc));
            let raw_desc_types = jvm_method_params_from_sig(&m.desc);
            if param_types.len() != raw_desc_types.len() {
                param_types = raw_desc_types;
            }
            let mut raw_params = Vec::with_capacity(param_types.len());
            for (idx, p_type) in param_types.iter().enumerate() {
                let p_anns = m.param_anns.get(idx).map(|v| v.as_slice()).unwrap_or(&[]);
                let bytecode_name = m
                    .param_names
                    .get(idx)
                    .and_then(|o| o.clone())
                    .or_else(|| m.lvt_names.get(idx).and_then(|o| o.clone()));
                let mut location_hint: Option<String> = None;
                let mut explicit_name = None;
                let mut default_value = None;
                let mut required = false;
                let mut example = None;
                let mut description = None;
                for ann in p_anns {
                    match ann.simple_name.as_str() {
                        "RequestBody" => {
                            location_hint = Some("body".into());
                            required = ann_get_bool(ann, "required").unwrap_or(true);
                        }
                        "PathVariable" | "PathParam" => {
                            location_hint = Some("path".into());
                            explicit_name = ann_get_str(ann, &["value", "name"]);
                            required = ann_get_bool(ann, "required").unwrap_or(true);
                        }
                        "RequestParam" | "QueryParam" => {
                            location_hint = Some("query".into());
                            explicit_name = ann_get_str(ann, &["value", "name"]);
                            default_value = ann_get_str(ann, &["defaultValue"]);
                            required = ann_get_bool(ann, "required").unwrap_or_else(|| default_value.is_none());
                        }
                        "RequestHeader" | "HeaderParam" => {
                            location_hint = Some("header".into());
                            explicit_name = ann_get_str(ann, &["value", "name"]);
                            default_value = ann_get_str(ann, &["defaultValue"]);
                            required = ann_get_bool(ann, "required").unwrap_or_else(|| default_value.is_none());
                        }
                        "ModelAttribute" => location_hint = Some("queryObject".into()),
                        "Schema" | "ApiModelProperty" | "Parameter" | "ApiParam" => {
                            if explicit_name.is_none() {
                                explicit_name = ann_get_str(ann, &["name"]);
                            }
                            if example.is_none() {
                                example = ann_get_str(ann, &["example"]);
                            }
                            if description.is_none() {
                                description = ann_get_str(ann, &["description", "value"]);
                            }
                            if ann_get_bool(ann, "required") == Some(true) {
                                required = true;
                            }
                        }
                        _ => {}
                    }
                }
                let inferred_name = explicit_name.is_none() && bytecode_name.is_none();
                let name = explicit_name
                    .or(bytecode_name)
                    .unwrap_or_else(|| format!("arg{idx}"));
                raw_params.push((
                    name,
                    p_type.clone(),
                    location_hint,
                    required,
                    default_value,
                    example,
                    description,
                    inferred_name,
                ));
            }

            for (m_methods, m_paths, m_consumes) in m_mappings {
                let http_methods = if !m_methods.is_empty() {
                    m_methods
                } else if !class_methods.is_empty() {
                    class_methods.clone()
                } else {
                    vec!["GET".into()]
                };
                for prefix in &class_prefixes {
                    for suffix in &m_paths {
                        let full_path = combine_paths(prefix, suffix);
                        for http_method in &http_methods {
                            let mut ep_warnings = Vec::new();
                            let params: Vec<ApiParamDef> = raw_params
                                .iter()
                                .filter(|(_, t, ..)| !is_ignored_injected_type(t))
                                .map(|(name, t, loc_hint, required, def, ex, desc, inferred)| {
                                    let location = if let Some(loc) = loc_hint {
                                        if loc == "query" && !is_scalar_or_collection_type(t) && *inferred {
                                            "queryObject".to_string()
                                        } else {
                                            loc.clone()
                                        }
                                    } else if full_path.contains(&format!("{{{name}}}")) {
                                        "path".to_string()
                                    } else if !is_scalar_or_collection_type(t) {
                                        "queryObject".to_string()
                                    } else {
                                        "query".to_string()
                                    };
                                    if *inferred && location != "body" && location != "queryObject" {
                                        ep_warnings.push(format!(
                                            "字节码未保留参数名，已使用 {name} 占位，请核对实际参数名。"
                                        ));
                                    }
                                    ApiParamDef {
                                        name: name.clone(),
                                        location,
                                        type_name: t.clone(),
                                        required: *required,
                                        default_value: def.clone(),
                                        example: ex.clone(),
                                        description: desc.clone(),
                                        inferred_name: *inferred,
                                    }
                                })
                                .collect();
                            let content_type = m_consumes.clone().or_else(|| {
                                if params.iter().any(|p| p.location == "body") {
                                    Some("application/json".into())
                                } else {
                                    None
                                }
                            });
                            let _ = http_method.as_str();
                            found_eps += 1;
                            acc.endpoints.push(ApiEndpoint {
                                id: format!("{simple_name}::{}::{http_method}::{full_path}", m.name),
                                group: group_name.clone(),
                                controller: simple_name.clone(),
                                method_name: m.name.clone(),
                                summary: summary.clone(),
                                method: http_method.clone(),
                                path: full_path.clone(),
                                content_type,
                                params,
                                source_file: rel_path.to_string(),
                                warnings: ep_warnings,
                            });
                        }
                    }
                }
            }
        }
        if found_eps > 0 || is_controller {
            acc.controllers.insert(full_name.clone());
        }
    }

    if is_enum || (!is_controller && !is_interface && (!fields.is_empty() || super_class.is_some())) {
        acc.types.insert(
            full_name.clone(),
            ApiTypeDef {
                name: simple_name,
                full_name,
                kind: if is_enum { "enum".into() } else { "class".into() },
                super_class,
                enum_values,
                fields,
            },
        );
    }

    Ok(())
}

fn read_u16_le_be(b: &[u8]) -> Option<u16> {
    let arr: [u8; 2] = b.get(0..2)?.try_into().ok()?;
    Some(u16::from_be_bytes(arr))
}

// ---------- OpenAPI 3.x / Swagger 2.0 JSON Scanner ----------

pub fn scan_openapi_str(
    source_name: &str,
    source_path: &str,
    text: &str,
) -> Result<ApiCatalogResult, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let is_openapi = doc.get("openapi").is_some() || doc.get("swagger").is_some();
    if !is_openapi {
        return Err("不是有效的 OpenAPI / Swagger JSON 文档（缺少 openapi/swagger 字段）".into());
    }
    let mut acc = ScanAccumulator::new(source_name.to_string(), "openapi-json", source_path);
    acc.stats.files_scanned = 1;

    if let Some(servers) = doc.get("servers").and_then(|s| s.as_array()) {
        if let Some(url) = servers.first().and_then(|s| s.get("url")).and_then(|u| u.as_str()) {
            let trimmed = url.trim();
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                acc.explicit_base_url = Some(trimmed.trim_end_matches('/').to_string());
            } else if trimmed.starts_with('/') {
                acc.context_path = Some(trimmed.to_string());
            }
        }
    } else if let Some(host) = doc.get("host").and_then(|h| h.as_str()) {
        let scheme = doc
            .get("schemes")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .unwrap_or("http");
        let base_path = doc
            .get("basePath")
            .and_then(|b| b.as_str())
            .unwrap_or("");
        acc.explicit_base_url = Some(format!(
            "{scheme}://{}{}",
            host.trim(),
            normalize_path_segment(base_path)
        ));
    }

    // Index schemas (OpenAPI 3 components.schemas + Swagger 2 definitions)
    if let Some(schemas) = doc
        .get("components")
        .and_then(|c| c.get("schemas"))
        .and_then(|s| s.as_object())
        .or_else(|| doc.get("definitions").and_then(|d| d.as_object()))
    {
        for (name, schema) in schemas {
            index_openapi_schema(name, schema, &mut acc.types);
        }
    }

    if let Some(paths) = doc.get("paths").and_then(|p| p.as_object()) {
        for (raw_path, path_item) in paths {
            let Some(path_obj) = path_item.as_object() else {
                continue;
            };
            let shared_params = path_obj
                .get("parameters")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();

            for http_method in ["get", "post", "put", "delete", "patch", "head", "options"] {
                let Some(op) = path_obj.get(http_method).and_then(|v| v.as_object()) else {
                    continue;
                };
                let method_upper = http_method.to_ascii_uppercase();
                let group = op
                    .get("tags")
                    .and_then(|t| t.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("OpenAPI")
                    .to_string();
                acc.controllers.insert(group.clone());
                let operation_id = op
                    .get("operationId")
                    .and_then(|v| v.as_str())
                    .unwrap_or(raw_path)
                    .to_string();
                let summary = op
                    .get("summary")
                    .or_else(|| op.get("description"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&operation_id)
                    .to_string();

                let mut params = Vec::new();
                let mut all_raw_params = shared_params.clone();
                if let Some(op_params) = op.get("parameters").and_then(|p| p.as_array()) {
                    all_raw_params.extend(op_params.iter().cloned());
                }
                let mut content_type = None;
                for p in all_raw_params {
                    let Some(p_obj) = p.as_object() else { continue };
                    let loc = p_obj.get("in").and_then(|v| v.as_str()).unwrap_or("query");
                    let p_name = p_obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if p_name.is_empty() {
                        continue;
                    }
                    let required = p_obj.get("required").and_then(|v| v.as_bool()).unwrap_or(loc == "path");
                    let schema = p_obj.get("schema").unwrap_or(&p);
                    let mapped_loc = match loc {
                        "path" => "path",
                        "header" => "header",
                        "body" => {
                            content_type = Some("application/json".into());
                            "body"
                        }
                        _ => "query",
                    };
                    let type_str = openapi_schema_to_type(schema, &mut acc.types, p_name);
                    let example = p_obj
                        .get("example")
                        .or_else(|| schema.get("example"))
                        .and_then(value_to_string);
                    let default_value = schema.get("default").and_then(value_to_string);
                    params.push(ApiParamDef {
                        name: p_name.to_string(),
                        location: mapped_loc.to_string(),
                        type_name: type_str,
                        required,
                        default_value,
                        example,
                        description: p_obj
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        inferred_name: false,
                    });
                }

                if let Some(req_body) = op.get("requestBody").and_then(|r| r.as_object()) {
                    if let Some(content) = req_body.get("content").and_then(|c| c.as_object()) {
                        let (ct, media) = content
                            .get("application/json")
                            .map(|m| ("application/json", m))
                            .or_else(|| content.iter().next().map(|(k, v)| (k.as_str(), v)))
                            .unwrap_or(("application/json", &Value::Null));
                        if let Some(schema) = media.get("schema") {
                            content_type = Some(ct.to_string());
                            let type_str = openapi_schema_to_type(schema, &mut acc.types, &format!("{operation_id}Body"));
                            let example = media
                                .get("example")
                                .or_else(|| schema.get("example"))
                                .and_then(value_to_string);
                            params.push(ApiParamDef {
                                name: "body".into(),
                                location: "body".into(),
                                type_name: type_str,
                                required: req_body.get("required").and_then(|r| r.as_bool()).unwrap_or(true),
                                default_value: None,
                                example,
                                description: req_body
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                inferred_name: false,
                            });
                        }
                    }
                }

                acc.endpoints.push(ApiEndpoint {
                    id: format!("{group}::{operation_id}::{method_upper}::{raw_path}"),
                    group: group.clone(),
                    controller: group,
                    method_name: operation_id,
                    summary,
                    method: method_upper,
                    path: normalize_path_segment(raw_path).max("/".into()),
                    content_type,
                    params,
                    source_file: source_name.to_string(),
                    warnings: Vec::new(),
                });
            }
        }
    }

    Ok(acc.finish())
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => Some(v.to_string()),
    }
}

fn ref_name(r: &str) -> String {
    r.rsplit('/').next().unwrap_or(r).to_string()
}

fn openapi_schema_to_type(
    schema: &Value,
    types: &mut BTreeMap<String, ApiTypeDef>,
    hint_name: &str,
) -> String {
    if let Some(r) = schema.get("$ref").and_then(|v| v.as_str()) {
        return ref_name(r);
    }
    let kind = schema.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let fmt = schema.get("format").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "string" => match fmt {
            "date" => "LocalDate".into(),
            "date-time" => "LocalDateTime".into(),
            "uuid" => "UUID".into(),
            _ => "String".into(),
        },
        "integer" => {
            if fmt == "int64" { "Long".into() } else { "Integer".into() }
        }
        "number" => {
            if fmt == "float" || fmt == "double" { "Double".into() } else { "BigDecimal".into() }
        }
        "boolean" => "Boolean".into(),
        "array" => {
            let item = schema
                .get("items")
                .map(|i| openapi_schema_to_type(i, types, &format!("{hint_name}Item")))
                .unwrap_or_else(|| "Object".into());
            format!("List<{item}>")
        }
        "object" | "" => {
            if schema.get("properties").is_some() || schema.get("allOf").is_some() {
                if !types.contains_key(hint_name) {
                    index_openapi_schema(hint_name, schema, types);
                }
                hint_name.to_string()
            } else {
                "Map<String, Object>".into()
            }
        }
        _ => "Object".into(),
    }
}

fn index_openapi_schema(
    name: &str,
    schema: &Value,
    types: &mut BTreeMap<String, ApiTypeDef>,
) {
    if let Some(enum_arr) = schema.get("enum").and_then(|v| v.as_array()) {
        let enum_values: Vec<String> = enum_arr.iter().filter_map(value_to_string).collect();
        types.insert(
            name.to_string(),
            ApiTypeDef {
                name: name.to_string(),
                full_name: name.to_string(),
                kind: "enum".into(),
                super_class: None,
                enum_values,
                fields: Vec::new(),
            },
        );
        return;
    }

    let mut super_class = None;
    let mut fields = Vec::new();
    let required_set: HashSet<String> = schema
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut prop_sources = Vec::new();
    if let Some(props) = schema.get("properties") {
        prop_sources.push(props);
    }
    if let Some(all_of) = schema.get("allOf").and_then(|a| a.as_array()) {
        for item in all_of {
            if let Some(r) = item.get("$ref").and_then(|v| v.as_str()) {
                if super_class.is_none() {
                    super_class = Some(ref_name(r));
                }
            }
            if let Some(props) = item.get("properties") {
                prop_sources.push(props);
            }
        }
    }

    for props_val in prop_sources {
        let Some(props) = props_val.as_object() else { continue };
        for (prop_name, prop_schema) in props {
            let f_type = if let Some(enum_arr) = prop_schema.get("enum").and_then(|v| v.as_array()) {
                let inline_enum = format!("{name}_{prop_name}_Enum");
                let enum_vals: Vec<String> = enum_arr.iter().filter_map(value_to_string).collect();
                types.insert(
                    inline_enum.clone(),
                    ApiTypeDef {
                        name: inline_enum.clone(),
                        full_name: inline_enum.clone(),
                        kind: "enum".into(),
                        super_class: None,
                        enum_values: enum_vals,
                        fields: Vec::new(),
                    },
                );
                inline_enum
            } else {
                openapi_schema_to_type(prop_schema, types, &format!("{name}_{prop_name}"))
            };
            let constraints = ApiFieldConstraints {
                min: prop_schema.get("minimum").and_then(|v| v.as_f64()),
                max: prop_schema.get("maximum").and_then(|v| v.as_f64()),
                min_len: prop_schema.get("minLength").and_then(|v| v.as_u64()).map(|v| v as usize),
                max_len: prop_schema.get("maxLength").and_then(|v| v.as_u64()).map(|v| v as usize),
                email: prop_schema.get("format").and_then(|v| v.as_str()) == Some("email"),
            };
            let has_constraints = constraints.min.is_some()
                || constraints.max.is_some()
                || constraints.min_len.is_some()
                || constraints.max_len.is_some()
                || constraints.email;
            fields.push(ApiFieldDef {
                name: prop_name.clone(),
                java_name: prop_name.clone(),
                type_name: f_type,
                required: required_set.contains(prop_name),
                example: prop_schema
                    .get("example")
                    .or_else(|| prop_schema.get("default"))
                    .and_then(value_to_string),
                description: prop_schema
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                constraints: if has_constraints { Some(constraints) } else { None },
            });
        }
    }

    types.insert(
        name.to_string(),
        ApiTypeDef {
            name: name.to_string(),
            full_name: name.to_string(),
            kind: "class".into(),
            super_class,
            enum_values: Vec::new(),
            fields,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write;

    fn make_zip_stored_and_deflated(items: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, raw, deflate) in items {
            let local_offset = out.len() as u32;
            let (method, payload): (u16, Vec<u8>) = if *deflate {
                let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
                enc.write_all(raw).unwrap();
                (8, enc.finish().unwrap())
            } else {
                (0, raw.to_vec())
            };
            let name_bytes = name.as_bytes();
            // Local file header
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // crc
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(&payload);

            // Central directory entry
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&(raw.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&local_offset.to_le_bytes());
            central.extend_from_slice(name_bytes);
        }
        let cd_offset = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        // EOCD
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(items.len() as u16).to_le_bytes());
        out.extend_from_slice(&(items.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    struct ClassBuilder {
        cp: Vec<Vec<u8>>,
    }

    impl ClassBuilder {
        fn new() -> Self {
            Self { cp: Vec::new() }
        }
        fn add_utf8(&mut self, s: &str) -> u16 {
            let mut e = vec![1];
            e.extend_from_slice(&(s.len() as u16).to_be_bytes());
            e.extend_from_slice(s.as_bytes());
            self.cp.push(e);
            self.cp.len() as u16
        }
        fn add_class(&mut self, internal_name: &str) -> u16 {
            let name_idx = self.add_utf8(internal_name);
            let mut e = vec![7];
            e.extend_from_slice(&name_idx.to_be_bytes());
            self.cp.push(e);
            self.cp.len() as u16
        }
        fn add_int(&mut self, v: i32) -> u16 {
            let mut e = vec![3];
            e.extend_from_slice(&v.to_be_bytes());
            self.cp.push(e);
            self.cp.len() as u16
        }
    }

    #[test]
    fn scans_spring_boot_project_directory_with_inheritance_and_yaml() {
        let temp = tempfile::tempdir().unwrap();
        let res_dir = temp.path().join("src/main/resources");
        let ctrl_dir = temp.path().join("src/main/java/com/demo/web");
        let dto_dir = temp.path().join("src/main/java/com/demo/dto");
        fs::create_dir_all(&res_dir).unwrap();
        fs::create_dir_all(&ctrl_dir).unwrap();
        fs::create_dir_all(&dto_dir).unwrap();

        fs::write(
            res_dir.join("application.yml"),
            "server:\n  port: ${SERVER_PORT:9091}\n  servlet:\n    context-path: /wms\n",
        )
        .unwrap();

        fs::write(
            dto_dir.join("BaseReq.java"),
            "package com.demo.dto;\npublic class BaseReq {\n  private String traceId;\n}\n",
        )
        .unwrap();
        fs::write(
            dto_dir.join("OrderStatus.java"),
            "package com.demo.dto;\npublic enum OrderStatus { CREATED, PAID, CANCELLED }\n",
        )
        .unwrap();
        fs::write(
            dto_dir.join("TierItem.java"),
            "package com.demo.dto;\npublic record TierItem(String code, int level) {}\n",
        )
        .unwrap();
        fs::write(
            dto_dir.join("CreateOrderReq.java"),
            r#"package com.demo.dto;
import java.util.List;
public class CreateOrderReq extends BaseReq {
  @Schema(example = "ORD-2026")
  private String orderNo;
  private OrderStatus status;
  private List<TierItem> tierList;
}
"#,
        )
        .unwrap();
        fs::write(
            ctrl_dir.join("OrderController.java"),
            r#"package com.demo.web;
@RestController
@Tag(name = "订单管理")
@RequestMapping("/api/orders")
public class OrderController {
  /** 创建入库订单 */
  @PostMapping("/{tenantId}")
  public String create(
      @PathVariable("tenantId") Long tenantId,
      @RequestParam(defaultValue = "false") boolean dryRun,
      @RequestHeader("X-Trace") String trace,
      @RequestBody CreateOrderReq req
  ) { return "ok"; }
}
"#,
        )
        .unwrap();

        let result = scan_source_path(temp.path()).unwrap();
        assert_eq!(result.base_url.as_deref(), Some("http://127.0.0.1:9091/wms"));
        assert_eq!(result.endpoints.len(), 1);
        let ep = &result.endpoints[0];
        assert_eq!(ep.group, "订单管理");
        assert_eq!(ep.method, "POST");
        assert_eq!(ep.path, "/api/orders/{tenantId}");
        assert_eq!(ep.summary, "创建入库订单");
        assert_eq!(ep.params.len(), 4);
        assert_eq!(ep.params[0].location, "path");
        assert_eq!(ep.params[1].default_value.as_deref(), Some("false"));
        assert_eq!(ep.params[2].location, "header");
        assert_eq!(ep.params[3].location, "body");
        assert_eq!(ep.params[3].type_name, "CreateOrderReq");

        let dto = result.types.get("com.demo.dto.CreateOrderReq").unwrap();
        assert_eq!(dto.super_class.as_deref(), Some("BaseReq"));
        assert_eq!(dto.fields[0].example.as_deref(), Some("ORD-2026"));
        assert_eq!(dto.fields[2].type_name, "List<TierItem>");
        assert_eq!(
            result.types.get("com.demo.dto.OrderStatus").unwrap().enum_values,
            vec!["CREATED", "PAID", "CANCELLED"]
        );
        assert_eq!(
            result.types.get("com.demo.dto.TierItem").unwrap().fields.len(),
            2
        );
    }

    #[test]
    fn scans_spring_fat_jar_bytecode_and_boot_inf_lib() {
        // 1. Build DTO class bytes: com/demo/dto/CreateOrderReq (fields: orderNo: String, tierList: List<TierItem>)
        let dto_bytes = {
            let mut b = ClassBuilder::new();
            let this_cls = b.add_class("com/demo/dto/CreateOrderReq");
            let super_cls = b.add_class("java/lang/Object");
            let f1_name = b.add_utf8("orderNo");
            let f1_desc = b.add_utf8("Ljava/lang/String;");
            let f2_name = b.add_utf8("tierList");
            let f2_desc = b.add_utf8("Ljava/util/List;");
            let sig_attr = b.add_utf8("Signature");
            let f2_sig = b.add_utf8("Ljava/util/List<Lcom/demo/dto/TierItem;>;");
            let mut cls = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 61];
            cls.extend_from_slice(&((b.cp.len() + 1) as u16).to_be_bytes());
            for e in &b.cp { cls.extend_from_slice(e); }
            cls.extend_from_slice(&0x0021u16.to_be_bytes());
            cls.extend_from_slice(&this_cls.to_be_bytes());
            cls.extend_from_slice(&super_cls.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes()); // interfaces
            cls.extend_from_slice(&2u16.to_be_bytes()); // 2 fields
            // field 1
            cls.extend_from_slice(&0x0002u16.to_be_bytes());
            cls.extend_from_slice(&f1_name.to_be_bytes());
            cls.extend_from_slice(&f1_desc.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes());
            // field 2 with Signature
            cls.extend_from_slice(&0x0002u16.to_be_bytes());
            cls.extend_from_slice(&f2_name.to_be_bytes());
            cls.extend_from_slice(&f2_desc.to_be_bytes());
            cls.extend_from_slice(&1u16.to_be_bytes());
            cls.extend_from_slice(&sig_attr.to_be_bytes());
            cls.extend_from_slice(&2u32.to_be_bytes());
            cls.extend_from_slice(&f2_sig.to_be_bytes());
            // methods & class attrs
            cls.extend_from_slice(&0u16.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes());
            cls
        };

        // 2. Build TierItem enum bytes: com/demo/dto/TierItem { FAST, SLOW }
        let enum_bytes = {
            let mut b = ClassBuilder::new();
            let this_cls = b.add_class("com/demo/dto/TierItem");
            let super_cls = b.add_class("java/lang/Enum");
            let c1 = b.add_utf8("FAST");
            let c2 = b.add_utf8("SLOW");
            let desc = b.add_utf8("Lcom/demo/dto/TierItem;");
            let mut cls = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 61];
            cls.extend_from_slice(&((b.cp.len() + 1) as u16).to_be_bytes());
            for e in &b.cp { cls.extend_from_slice(e); }
            cls.extend_from_slice(&0x4031u16.to_be_bytes()); // ACC_ENUM | ACC_FINAL | ACC_SUPER | ACC_PUBLIC
            cls.extend_from_slice(&this_cls.to_be_bytes());
            cls.extend_from_slice(&super_cls.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes());
            cls.extend_from_slice(&2u16.to_be_bytes());
            for cname in [c1, c2] {
                cls.extend_from_slice(&0x4019u16.to_be_bytes()); // ACC_ENUM | ACC_FINAL | ACC_STATIC | ACC_PUBLIC
                cls.extend_from_slice(&cname.to_be_bytes());
                cls.extend_from_slice(&desc.to_be_bytes());
                cls.extend_from_slice(&0u16.to_be_bytes());
            }
            cls.extend_from_slice(&0u16.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes());
            cls
        };

        // 3. Build Controller class bytes: com/demo/OrderController with @RestController, @RequestMapping("/v1/orders"), method create(@PathVariable id, @RequestBody CreateOrderReq)
        let ctrl_bytes = {
            let mut b = ClassBuilder::new();
            let this_cls = b.add_class("com/demo/OrderController");
            let super_cls = b.add_class("java/lang/Object");
            let attr_rva = b.add_utf8("RuntimeVisibleAnnotations");
            let attr_rvpa = b.add_utf8("RuntimeVisibleParameterAnnotations");
            let attr_mp = b.add_utf8("MethodParameters");
            let ann_rest = b.add_utf8("Lorg/springframework/web/bind/annotation/RestController;");
            let ann_rm = b.add_utf8("Lorg/springframework/web/bind/annotation/RequestMapping;");
            let ann_pv = b.add_utf8("Lorg/springframework/web/bind/annotation/PathVariable;");
            let ann_rb = b.add_utf8("Lorg/springframework/web/bind/annotation/RequestBody;");
            let k_value = b.add_utf8("value");
            let k_method = b.add_utf8("method");
            let v_cls_path = b.add_utf8("/v1/orders");
            let v_m_path = b.add_utf8("/{id}");
            let rm_enum_desc = b.add_utf8("Lorg/springframework/web/bind/annotation/RequestMethod;");
            let rm_post = b.add_utf8("POST");
            let m_name = b.add_utf8("create");
            let m_desc = b.add_utf8("(JLcom/demo/dto/CreateOrderReq;)Ljava/lang/String;");
            let p1_name = b.add_utf8("id");
            let p2_name = b.add_utf8("req");
            let _unused = b.add_int(1);

            let mut cls = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 61];
            cls.extend_from_slice(&((b.cp.len() + 1) as u16).to_be_bytes());
            for e in &b.cp { cls.extend_from_slice(e); }
            cls.extend_from_slice(&0x0021u16.to_be_bytes());
            cls.extend_from_slice(&this_cls.to_be_bytes());
            cls.extend_from_slice(&super_cls.to_be_bytes());
            cls.extend_from_slice(&0u16.to_be_bytes()); // interfaces
            cls.extend_from_slice(&0u16.to_be_bytes()); // fields
            cls.extend_from_slice(&1u16.to_be_bytes()); // 1 method

            // method create
            cls.extend_from_slice(&0x0001u16.to_be_bytes());
            cls.extend_from_slice(&m_name.to_be_bytes());
            cls.extend_from_slice(&m_desc.to_be_bytes());
            cls.extend_from_slice(&3u16.to_be_bytes()); // 3 attrs: RVA, RVPA, MP

            // RVA: @RequestMapping(value={"/v1/{id}"}, method={RequestMethod.POST}) -> "/{id}"
            let mut m_rva = Vec::new();
            m_rva.extend_from_slice(&1u16.to_be_bytes()); // 1 ann
            m_rva.extend_from_slice(&ann_rm.to_be_bytes());
            m_rva.extend_from_slice(&2u16.to_be_bytes()); // 2 pairs
            m_rva.extend_from_slice(&k_value.to_be_bytes());
            m_rva.push(b'['); m_rva.extend_from_slice(&1u16.to_be_bytes());
            m_rva.push(b's'); m_rva.extend_from_slice(&v_m_path.to_be_bytes());
            m_rva.extend_from_slice(&k_method.to_be_bytes());
            m_rva.push(b'['); m_rva.extend_from_slice(&1u16.to_be_bytes());
            m_rva.push(b'e'); m_rva.extend_from_slice(&rm_enum_desc.to_be_bytes()); m_rva.extend_from_slice(&rm_post.to_be_bytes());
            cls.extend_from_slice(&attr_rva.to_be_bytes());
            cls.extend_from_slice(&(m_rva.len() as u32).to_be_bytes());
            cls.extend_from_slice(&m_rva);

            // RVPA: param 0 -> @PathVariable, param 1 -> @RequestBody
            let mut m_rvpa = vec![2u8]; // 2 params
            m_rvpa.extend_from_slice(&1u16.to_be_bytes());
            m_rvpa.extend_from_slice(&ann_pv.to_be_bytes());
            m_rvpa.extend_from_slice(&0u16.to_be_bytes());
            m_rvpa.extend_from_slice(&1u16.to_be_bytes());
            m_rvpa.extend_from_slice(&ann_rb.to_be_bytes());
            m_rvpa.extend_from_slice(&0u16.to_be_bytes());
            cls.extend_from_slice(&attr_rvpa.to_be_bytes());
            cls.extend_from_slice(&(m_rvpa.len() as u32).to_be_bytes());
            cls.extend_from_slice(&m_rvpa);

            // MethodParameters
            let mut m_mp = vec![2u8];
            m_mp.extend_from_slice(&p1_name.to_be_bytes()); m_mp.extend_from_slice(&0u16.to_be_bytes());
            m_mp.extend_from_slice(&p2_name.to_be_bytes()); m_mp.extend_from_slice(&0u16.to_be_bytes());
            cls.extend_from_slice(&attr_mp.to_be_bytes());
            cls.extend_from_slice(&(m_mp.len() as u32).to_be_bytes());
            cls.extend_from_slice(&m_mp);

            // class attrs: @RestController + @RequestMapping("/v1/orders")
            cls.extend_from_slice(&1u16.to_be_bytes());
            let mut c_rva = Vec::new();
            c_rva.extend_from_slice(&2u16.to_be_bytes());
            c_rva.extend_from_slice(&ann_rest.to_be_bytes());
            c_rva.extend_from_slice(&0u16.to_be_bytes());
            c_rva.extend_from_slice(&ann_rm.to_be_bytes());
            c_rva.extend_from_slice(&1u16.to_be_bytes());
            c_rva.extend_from_slice(&k_value.to_be_bytes());
            c_rva.push(b's'); c_rva.extend_from_slice(&v_cls_path.to_be_bytes());
            cls.extend_from_slice(&attr_rva.to_be_bytes());
            cls.extend_from_slice(&(c_rva.len() as u32).to_be_bytes());
            cls.extend_from_slice(&c_rva);
            cls
        };

        let nested_dto_jar = make_zip_stored_and_deflated(&[
            ("com/demo/dto/CreateOrderReq.class", &dto_bytes, true),
            ("com/demo/dto/TierItem.class", &enum_bytes, true),
        ]);
        let fat_jar = make_zip_stored_and_deflated(&[
            ("BOOT-INF/classes/application.properties", b"server.port=8888\n", false),
            ("BOOT-INF/classes/com/demo/OrderController.class", &ctrl_bytes, true),
            ("BOOT-INF/lib/demo-dto-1.0.0.jar", &nested_dto_jar, false),
        ]);

        let temp = tempfile::tempdir().unwrap();
        let jar_path = temp.path().join("demo-service.jar");
        fs::write(&jar_path, &fat_jar).unwrap();

        let result = scan_source_path(&jar_path).unwrap();
        assert_eq!(result.source_kind, "spring-fat-jar");
        assert_eq!(result.base_url.as_deref(), Some("http://127.0.0.1:8888"));
        assert_eq!(result.endpoints.len(), 1);
        let ep = &result.endpoints[0];
        assert_eq!(ep.method, "POST");
        assert_eq!(ep.path, "/v1/orders/{id}");
        assert_eq!(ep.params[0].name, "id");
        assert_eq!(ep.params[0].location, "path");
        assert_eq!(ep.params[0].type_name, "long");
        assert!(!ep.params[0].inferred_name);
        assert_eq!(ep.params[1].location, "body");
        assert_eq!(ep.params[1].type_name, "CreateOrderReq");

        let dto = result.types.get("com.demo.dto.CreateOrderReq").unwrap();
        assert_eq!(dto.fields[1].type_name, "List<TierItem>");
        assert_eq!(
            result.types.get("com.demo.dto.TierItem").unwrap().enum_values,
            vec!["FAST", "SLOW"]
        );
    }

    #[test]
    fn scans_openapi_json_with_refs_and_servers() {
        let temp = tempfile::tempdir().unwrap();
        let json_path = temp.path().join("openapi.json");
        fs::write(
            &json_path,
            r##"{
  "openapi": "3.0.1",
  "servers": [{ "url": "http://127.0.0.1:8088/api" }],
  "paths": {
    "/users/{userId}": {
      "post": {
        "tags": ["Users"],
        "operationId": "updateUser",
        "summary": "更新用户信息",
        "parameters": [
          { "name": "userId", "in": "path", "required": true, "schema": { "type": "integer", "format": "int64" } }
        ],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/UpdateUserReq" } } }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "UpdateUserReq": {
        "type": "object",
        "required": ["email"],
        "properties": {
          "email": { "type": "string", "format": "email" },
          "age": { "type": "integer", "minimum": 18, "maximum": 120 }
        }
      }
    }
  }
}"##,
        )
        .unwrap();

        let result = scan_source_path(&json_path).unwrap();
        assert_eq!(result.source_kind, "openapi-json");
        assert_eq!(result.base_url.as_deref(), Some("http://127.0.0.1:8088/api"));
        assert_eq!(result.endpoints.len(), 1);
        assert_eq!(result.endpoints[0].method, "POST");
        assert_eq!(result.endpoints[0].path, "/users/{userId}");
        assert_eq!(result.endpoints[0].summary, "更新用户信息");
        let schema = result.types.get("UpdateUserReq").unwrap();
        assert_eq!(schema.fields.len(), 2);
        let email = schema.fields.iter().find(|f| f.name == "email").unwrap();
        assert!(email.required);
        assert!(email.constraints.as_ref().unwrap().email);
    }
}
