//! File clipboard access is invoked only by an explicit paste gesture.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

fn files() -> &'static Mutex<HashMap<String, PathBuf>> {
    static FILES: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    FILES.get_or_init(|| Mutex::new(HashMap::new()))
}
#[derive(Serialize)]
pub struct ClipboardFile {
    id: String,
    name: String,
    size: u64,
    mime: String,
}

#[cfg(target_os = "macos")]
fn clipboard_paths() -> Result<Vec<PathBuf>, String> {
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};
    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        let pasteboard: *mut Object = msg_send![class!(NSPasteboard), generalPasteboard];
        let kind: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: b"public.file-url\0".as_ptr()];
        let items: *mut Object = msg_send![pasteboard, pasteboardItems];
        let count: usize = if items.is_null() {
            0
        } else {
            msg_send![items, count]
        };
        let mut paths = Vec::new();
        for index in 0..count.min(1024) {
            let item: *mut Object = msg_send![items, objectAtIndex: index];
            let value: *mut Object = msg_send![item, stringForType: kind];
            if value.is_null() {
                continue;
            }
            let utf8: *const std::os::raw::c_char = msg_send![value, UTF8String];
            if !utf8.is_null() {
                let value = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                if let Ok(url) = url::Url::parse(&value) {
                    if let Ok(path) = url.to_file_path() {
                        paths.push(path);
                    }
                }
            }
        }
        let _: () = msg_send![pool, drain];
        Ok(paths)
    }
}

#[cfg(windows)]
fn clipboard_paths() -> Result<Vec<PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(window: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(
            drop: *mut std::ffi::c_void,
            index: u32,
            file: *mut u16,
            size: u32,
        ) -> u32;
    }
    unsafe {
        const CF_HDROP: u32 = 15;
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("剪贴板正被占用，请重试粘贴".into());
        }
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        let _close = Close;
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() {
            return Err("无法读取剪贴板文件".into());
        }
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::new();
        for index in 0..count.min(1024) {
            let size = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            let mut buffer = vec![0u16; size as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), size + 1);
            if copied > 0 {
                paths.push(PathBuf::from(std::ffi::OsString::from_wide(
                    &buffer[..copied as usize],
                )));
            }
        }
        Ok(paths)
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
fn clipboard_paths() -> Result<Vec<PathBuf>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub fn clipboard_files() -> Result<Vec<ClipboardFile>, String> {
    let paths = clipboard_paths()?;
    let mut registry = files().lock().map_err(|_| "剪贴板读取失败")?;
    if registry.len() + paths.len() > 4096 {
        return Err("剪贴板文件记录已满，请重新打开 WenBox".into());
    }
    // Validate the whole selection before enqueueing any files.
    let mut pending = Vec::new();
    for path in paths {
        let metadata = path
            .metadata()
            .map_err(|_| "剪贴板文件不存在或无法读取，请重新复制")?;
        if !metadata.is_file() {
            return Err("暂不支持粘贴文件夹，请压缩成 ZIP 后发送".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let descriptor = ClipboardFile {
            id: id.clone(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            size: metadata.len(),
            mime: mime_guess::from_path(&path)
                .first_or_octet_stream()
                .to_string(),
        };
        pending.push((id, path, descriptor));
    }
    Ok(pending
        .into_iter()
        .map(|(id, path, descriptor)| {
            registry.insert(id, path);
            descriptor
        })
        .collect())
}

#[tauri::command]
pub async fn clipboard_file_chunk(
    id: String,
    offset: u64,
    length: usize,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_chunk(&id, offset, length))
        .await
        .map_err(|e| e.to_string())?
}
fn read_chunk(id: &str, offset: u64, length: usize) -> Result<String, String> {
    if length > 512 * 1024 {
        return Err("读取分块过大".into());
    }
    let path = files()
        .lock()
        .map_err(|_| "剪贴板读取失败")?
        .get(id)
        .cloned()
        .ok_or("请重新复制文件")?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|_| "文件已改变或无法完整读取，请重新复制")?;
    Ok(STANDARD.encode(bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_registered_files_in_bounded_chunks() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"abcdef").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        files()
            .lock()
            .unwrap()
            .insert(id.clone(), file.path().to_owned());
        assert_eq!(
            STANDARD.decode(read_chunk(&id, 2, 3).unwrap()).unwrap(),
            b"cde"
        );
        assert!(read_chunk(&id, 0, 512 * 1024 + 1).is_err());
        assert!(read_chunk("/etc/passwd", 0, 1).is_err());
        assert!(read_chunk(&id, 5, 2).is_err());
        files().lock().unwrap().remove(&id);
    }
}
