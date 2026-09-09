//! AI 助手按书对话历史持久化（ADR-6 / R5 / R9）。
//!
//! - 存储：`<app_data_dir>/assistant/<content_hash>.json`，与标注同源的
//!   16-hex 内容哈希键（身份派生在前端 session-annotation，此处只按 key
//!   读写）。原子写复用 [`crate::file::write_file_impl`]（临时文件 + rename）。
//! - JSON 对 Rust 不透明：消息结构 `{messages:[{role,content,createdAt}],…}`
//!   由前端 schema 拥有；本模块只做 key 校验、长度上限与整文件覆写。
//! - 边界：读失败/缺失视为空历史（不阻断面板）；写入超过 2 MiB 拒绝
//!   （流式回答累计 2 MiB 上游已截断，正常历史远小于此）；清除不存在的
//!   历史是幂等 no-op。
//! - 同步（R9）：历史只在 app_data_dir 的 `assistant/` 目录，不经
//!   localStorage/app-state，同步白名单不含它——不上传、不参与同步快照。

use std::fs;
use std::path::Path;

use crate::identifiers::validate_content_hash;

const ASSISTANT_DIR: &str = "assistant";
/// 单本对话历史字节上限：超限拒绝写入（防失控历史撑爆磁盘）。
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;

/// 历史文件路径：`<base_dir>/assistant/<content_hash>.json`。
fn assistant_history_path(
    base_dir: &Path,
    content_hash: &str,
) -> Result<std::path::PathBuf, String> {
    let content_hash = validate_content_hash(content_hash)?;
    Ok(base_dir
        .join(ASSISTANT_DIR)
        .join(format!("{}.json", content_hash)))
}

fn resolve_base_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

/// 读对话历史 JSON。文件缺失或不可读返回空串（视为无历史，不报错）。
pub fn read_history_impl(base_dir: &Path, content_hash: &str) -> Result<String, String> {
    let path = assistant_history_path(base_dir, content_hash)?;
    if !path.exists() {
        return Ok(String::new());
    }
    // 读失败（权限/编码）同样视为空，避免阻断面板。
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// 原子写对话历史 JSON（创建 assistant 目录；拒绝空/超限负载）。
pub fn write_history_impl(base_dir: &Path, content_hash: &str, json: &str) -> Result<(), String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Err("对话历史内容不能为空".to_string());
    }
    if trimmed.len() > MAX_HISTORY_BYTES {
        return Err(format!("对话历史超过 {} 字节上限", MAX_HISTORY_BYTES));
    }
    let path = assistant_history_path(base_dir, content_hash)?;
    let dir = base_dir.join(ASSISTANT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建助手历史目录: {}", e))?;
    crate::file::write_file_impl(&path, trimmed)
}

/// 清除某本书的对话历史（幂等：文件不存在也返回 Ok）。
pub fn clear_history_impl(base_dir: &Path, content_hash: &str) -> Result<(), String> {
    let path = assistant_history_path(base_dir, content_hash)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| format!("无法清除对话历史: {}", e))
}

#[tauri::command]
pub fn assistant_read_history(
    app: tauri::AppHandle,
    content_hash: String,
) -> Result<String, String> {
    read_history_impl(&resolve_base_dir(&app), &content_hash)
}

#[tauri::command]
pub fn assistant_write_history(
    app: tauri::AppHandle,
    content_hash: String,
    json: String,
) -> Result<(), String> {
    write_history_impl(&resolve_base_dir(&app), &content_hash, &json)
}

#[tauri::command]
pub fn assistant_clear_history(app: tauri::AppHandle, content_hash: String) -> Result<(), String> {
    clear_history_impl(&resolve_base_dir(&app), &content_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210";

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn missing_history_returns_empty_without_creating_directory() {
        let dir = temp_dir();
        assert_eq!(read_history_impl(dir.path(), HASH_A).unwrap(), "");
        assert!(!dir.path().join(ASSISTANT_DIR).exists());
    }

    #[test]
    fn write_then_read_roundtrip_per_book() {
        let dir = temp_dir();
        let json = r#"{"messages":[{"role":"user","content":"这本书讲什么?","createdAt":1}],"updatedAt":2}"#;
        write_history_impl(dir.path(), HASH_A, json).unwrap();
        write_history_impl(dir.path(), HASH_B, r#"{"messages":[],"updatedAt":3}"#).unwrap();
        assert_eq!(read_history_impl(dir.path(), HASH_A).unwrap(), json);
        assert_eq!(
            read_history_impl(dir.path(), HASH_B).unwrap(),
            r#"{"messages":[],"updatedAt":3}"#
        );
    }

    #[test]
    fn assistant_dir_is_created_and_write_is_atomic() {
        let dir = temp_dir();
        write_history_impl(dir.path(), HASH_A, r#"{"messages":[]}"#).unwrap();
        let path = dir
            .path()
            .join(ASSISTANT_DIR)
            .join(format!("{HASH_A}.json"));
        assert!(path.exists());
        // 原子写不得在目录里残留临时文件。
        let entries: Vec<_> = fs::read_dir(dir.path().join(ASSISTANT_DIR))
            .unwrap()
            .collect();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn clear_history_is_idempotent_and_scoped() {
        let dir = temp_dir();
        write_history_impl(dir.path(), HASH_A, r#"{"messages":[]}"#).unwrap();
        write_history_impl(dir.path(), HASH_B, r#"{"messages":[]}"#).unwrap();
        clear_history_impl(dir.path(), HASH_A).unwrap();
        // 再清一次（文件已不存在）仍是 Ok。
        clear_history_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(read_history_impl(dir.path(), HASH_A).unwrap(), "");
        assert_ne!(read_history_impl(dir.path(), HASH_B).unwrap(), "");
    }

    #[test]
    fn rejects_invalid_hash_and_bad_payload_before_touching_disk() {
        let dir = temp_dir();
        for hash in [
            "",
            "XYZ",
            "../assistant",
            "0123456789abcde",
            "0123456789abcdefg",
        ] {
            assert!(read_history_impl(dir.path(), hash).is_err());
            assert!(write_history_impl(dir.path(), hash, "{}").is_err());
            assert!(clear_history_impl(dir.path(), hash).is_err());
        }
        assert!(write_history_impl(dir.path(), HASH_A, "   ").is_err());
        assert!(write_history_impl(dir.path(), HASH_A, "").is_err());
        assert!(!dir.path().join(ASSISTANT_DIR).exists());
    }

    #[test]
    fn oversized_history_is_rejected_under_two_mebibytes() {
        let dir = temp_dir();
        let mut json = String::from(r#"{"messages":[{"role":"user","content":""#);
        json.push_str(&"汉".repeat(MAX_HISTORY_BYTES));
        json.push_str(r#""}],"updatedAt":1}"#);
        assert!(write_history_impl(dir.path(), HASH_A, &json).is_err());
        // 上限内（含边界裁剪后仍超前的安全余量）可写入。
        let ok = format!(
            "{{\"messages\":[{{\"role\":\"user\",\"content\":\"{}\"}}]}}",
            "a".repeat(1024)
        );
        assert!(write_history_impl(dir.path(), HASH_A, &ok).is_ok());
    }

    #[test]
    fn corrupt_or_unreadable_file_yields_empty_not_error() {
        let dir = temp_dir();
        let path = dir.path().join(ASSISTANT_DIR);
        fs::create_dir_all(&path).unwrap();
        // 非 UTF-8 字节：read_to_string 失败 → 视为空历史，不报错。
        fs::write(path.join(format!("{HASH_A}.json")), b"\xff\xfe\x00").unwrap();
        assert_eq!(read_history_impl(dir.path(), HASH_A).unwrap(), "");
    }

    #[test]
    fn history_stays_out_of_annotation_storage_and_vice_versa() {
        // assistant/ 与 annotations/ 同级但互不可见：写助手历史不落标注目录。
        let dir = temp_dir();
        write_history_impl(dir.path(), HASH_A, r#"{"messages":[]}"#).unwrap();
        assert!(dir
            .path()
            .join(ASSISTANT_DIR)
            .join(format!("{HASH_A}.json"))
            .exists());
        assert!(!dir.path().join("annotations").exists());
    }
}
