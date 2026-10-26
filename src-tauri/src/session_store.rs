//! Keep hosted room metadata and attachment IDs stable across application restarts.
use super::{AppState, ChatMessage, RoomConfig, RoomMember, SharedFile, MAX_MESSAGES};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Session {
    schema: u32,
    room: RoomConfig,
    host_token: String,
    native_host: bool,
    members: HashMap<String, RoomMember>,
    tokens: HashSet<String>,
    shared: HashMap<String, SharedFile>,
    received: Vec<SharedFile>,
    messages: Vec<ChatMessage>,
}
fn collect(state: &AppState) -> Session {
    // Clone one field at a time so HTTP handlers' lock order cannot deadlock a save.
    let room = state.room.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let host_token = state
        .host_token
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let native_host = *state
        .is_tauri_host
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let members = state
        .members
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let tokens = state
        .auth_tokens
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let shared = state
        .files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let received = state
        .received_files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let messages = state
        .messages
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .rev()
        .take(MAX_MESSAGES)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Session {
        schema: 1,
        room,
        host_token,
        native_host,
        members,
        tokens,
        shared,
        received,
        messages,
    }
}
fn location() -> Result<PathBuf, String> {
    Ok(dirs_next::data_local_dir()
        .ok_or("无法定位应用数据目录")?
        .join("com.wendel.wenbox")
        .join("session.json"))
}
fn write_at(path: &Path, state: &AppState) -> Result<(), String> {
    let parent = path.parent().ok_or("无效的存档位置")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut snapshot = collect(state);
    for _ in 0..3 {
        let current_room = state
            .room
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .room_id
            .clone();
        if current_room == snapshot.room.room_id {
            break;
        }
        snapshot = collect(state);
    }
    if state.room.lock().unwrap_or_else(|e| e.into_inner()).room_id != snapshot.room.room_id {
        return Err("房间正在变更，请重试保存".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &snapshot).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(not(test))]
pub fn save(state: &AppState) -> Result<(), String> {
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    write_at(&location()?, state)
}
// Tests use explicit temporary directories, never the user's actual archive.
#[cfg(test)]
pub fn save(_state: &AppState) -> Result<(), String> {
    Ok(())
}
pub fn remember(state: &AppState) {
    if let Err(error) = save(state) {
        eprintln!("保存房间记录失败: {}", error);
    }
}

fn restore_at(path: &Path, state: &AppState) -> Result<bool, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let snapshot: Session =
        serde_json::from_reader(file.take(64 * 1024 * 1024)).map_err(|e| e.to_string())?;
    if snapshot.schema != 1 {
        return Err("无法识别的房间存档版本".into());
    }
    let available = |file: &SharedFile| {
        std::fs::metadata(&file.path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    };
    *state.files.lock().unwrap() = snapshot
        .shared
        .into_iter()
        .filter(|(_, file)| available(file))
        .collect();
    *state.received_files.lock().unwrap() =
        snapshot.received.into_iter().filter(available).collect();
    if !snapshot.native_host || !snapshot.room.is_active {
        return Ok(false);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut room = snapshot.room;
    room.host_ip = super::get_primary_ip();
    *state.room.lock().unwrap() = room;
    *state.host_token.lock().unwrap() = snapshot.host_token;
    *state.is_tauri_host.lock().unwrap() = true;
    *state.host_last_seen.lock().unwrap() = now;
    *state.auth_tokens.lock().unwrap() = snapshot.tokens;
    *state.members.lock().unwrap() = snapshot
        .members
        .into_iter()
        .map(|(key, mut member)| {
            member.last_seen = now;
            (key, member)
        })
        .collect();
    *state.messages.lock().unwrap() = snapshot
        .messages
        .into_iter()
        .rev()
        .take(MAX_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(true)
}
pub fn restore(state: &AppState) -> bool {
    let path = match location() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("读取存档位置失败: {}", error);
            return false;
        }
    };
    match restore_at(&path, state) {
        Ok(restored) => restored,
        Err(error) => {
            let backup =
                path.with_file_name(format!("session-invalid-{}.json", uuid::Uuid::new_v4()));
            if let Err(copy_error) = std::fs::copy(&path, &backup) {
                eprintln!("备份异常存档失败: {}", copy_error);
            }
            eprintln!("读取房间记录失败，异常存档已备份: {}", error);
            false
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_keeps_room_messages_credentials_and_attachment_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let binary = dir.path().join("sent.png");
        std::fs::write(&binary, b"image fixture").unwrap();
        let original = super::super::tests::protected_state();
        let attachment = SharedFile {
            id: "stable-image-id".into(),
            name: "sent.png".into(),
            size: 13,
            path: binary.to_string_lossy().into_owned(),
            mime_type: "image/png".into(),
        };
        original.received_files.lock().unwrap().push(attachment);
        write_at(&path, &original).unwrap();
        let restarted = super::super::tests::protected_state();
        restarted.room.lock().unwrap().room_id = "new-default".into();
        assert!(restore_at(&path, &restarted).unwrap());
        assert_eq!(restarted.room.lock().unwrap().room_id, "room-uuid");
        assert_eq!(
            restarted.received_files.lock().unwrap()[0].id,
            "stable-image-id"
        );
        assert_eq!(restarted.messages.lock().unwrap()[0].content, "机密聊天");
        let port = super::super::tests::spawn_test_server(restarted.clone());
        let response = ureq::get(&format!(
            "http://127.0.0.1:{}/api/download/stable-image-id",
            port
        ))
        .set("X-Room-Token", "guest-token")
        .call()
        .unwrap();
        let mut bytes = Vec::new();
        response.into_reader().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"image fixture");
        assert!(restarted
            .auth_tokens
            .lock()
            .unwrap()
            .contains("guest-token"));
        std::fs::remove_file(binary).unwrap();
        assert!(restore_at(&path, &restarted).unwrap());
        assert!(restarted.received_files.lock().unwrap().is_empty());
    }
    #[test]
    fn closed_room_is_not_resurrected_and_corrupt_snapshot_is_not_applied() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let state = super::super::tests::protected_state();
        state.room.lock().unwrap().is_active = false;
        write_at(&path, &state).unwrap();
        assert!(!restore_at(&path, &state).unwrap());
        std::fs::write(&path, b"bad JSON").unwrap();
        assert!(restore_at(&path, &state).is_err());
    }
}
