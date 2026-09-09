//! 整本翻译断点缓存与译本入库（ADR-5 / R4 / R7 / R9）。
//!
//! - 存储：`<app_data_dir>/book-translation/<content_hash>.json`（计划/术语表/
//!   完成位的小状态文件，每块完成即原子覆写）+ `<content_hash>.d/<idx>.txt`
//!   （单块译文，写一次不再改写——避免大书逐块重写整份状态文件的 O(n²) 写放大）。
//!   contentHash 与进度/标注身份链同源（16-hex，`identifiers::validate_content_hash`）。
//! - JSON 对 Rust 不透明：状态 schema 由前端 `book-translation/state.ts` 拥有；
//!   本模块只做 key 校验、长度上限与原子写（`crate::file::write_file_impl`，
//!   annotations/assistant 同模式）。
//! - 译本入库：前端以 zip.js 重组 EPUB 后经 `book_translation_import_epub`
//!   base64 传入 → 临时落盘 → 复用 `managed::import_managed_book_at`（内容
//!   哈希去重，译本内容与原书不同即成新条目）→ 删除临时文件。译本阅读进度
//!   独立由 contentHash 身份链天然成立。
//! - 单块翻译：`book_translation_translate_chunk` 复用 `ai::translate_book_chunk`
//!   （与选区翻译同一三端点网络栈，prompt 携带按书术语表）。
//! - 同步（R9）：缓存只在 app_data_dir 的 `book-translation/` 目录，不经
//!   localStorage/app-state，同步白名单不含它；密钥仅存钥匙串（ADR-7）。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::identifiers::validate_content_hash;
use crate::library::{self, LibraryItem};

const BOOK_TRANSLATION_DIR: &str = "book-translation";
/// 状态文件字节上限（完成位 + 术语表为 KB 级，超限说明负载异常，拒绝写入）。
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
/// 单块译文字节上限（前端按 5000 源字符切块，译文正常远小于此）。
const MAX_CHUNK_BYTES: usize = 512 * 1024;
/// 译本 EPUB 解码后字节上限（源书受阅读器 32MB 文本/2GB 二进制上限约束，
/// 重组不应显著放大；超限拒绝在写盘之前）。
const MAX_IMPORT_BYTES: usize = 96 * 1024 * 1024;
/// 单本块数上限（u32 命令参数防御；100 万块 ≈ 45 亿字符，远超可读书量）。
const MAX_CHUNK_INDEX: u32 = 1_000_000;

/// 状态文件路径：`<base>/book-translation/<content_hash>.json`。
fn state_path(base_dir: &Path, content_hash: &str) -> Result<PathBuf, String> {
    let content_hash = validate_content_hash(content_hash)?;
    Ok(base_dir
        .join(BOOK_TRANSLATION_DIR)
        .join(format!("{content_hash}.json")))
}

/// 单块译文目录：`<base>/book-translation/<content_hash>.d/`。
fn chunk_dir(base_dir: &Path, content_hash: &str) -> Result<PathBuf, String> {
    let content_hash = validate_content_hash(content_hash)?;
    Ok(base_dir
        .join(BOOK_TRANSLATION_DIR)
        .join(format!("{content_hash}.d")))
}

fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

/// 读断点状态 JSON。文件缺失或不可读返回空串（视为无进度，重新开始）。
pub fn read_state_impl(base_dir: &Path, content_hash: &str) -> Result<String, String> {
    let path = state_path(base_dir, content_hash)?;
    if !path.exists() {
        return Ok(String::new());
    }
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// 原子写断点状态 JSON（创建目录；拒绝空/超限负载）。
pub fn write_state_impl(base_dir: &Path, content_hash: &str, json: &str) -> Result<(), String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Err("整本翻译状态内容不能为空".to_string());
    }
    if trimmed.len() > MAX_STATE_BYTES {
        return Err(format!("整本翻译状态超过 {} 字节上限", MAX_STATE_BYTES));
    }
    let path = state_path(base_dir, content_hash)?;
    fs::create_dir_all(path.parent().unwrap_or(base_dir))
        .map_err(|error| format!("无法创建整本翻译缓存目录: {error}"))?;
    crate::file::write_file_impl(&path, trimmed)
}

fn chunk_path(base_dir: &Path, content_hash: &str, chunk_index: u32) -> Result<PathBuf, String> {
    if chunk_index >= MAX_CHUNK_INDEX {
        return Err(format!("整本翻译块序号超过 {MAX_CHUNK_INDEX} 上限"));
    }
    Ok(chunk_dir(base_dir, content_hash)?.join(format!("{chunk_index:06}.txt")))
}

/// 读单块译文。文件缺失或不可读返回空串（调用方视为需重译该块）。
pub fn read_chunk_impl(
    base_dir: &Path,
    content_hash: &str,
    chunk_index: u32,
) -> Result<String, String> {
    let path = chunk_path(base_dir, content_hash, chunk_index)?;
    if !path.exists() {
        return Ok(String::new());
    }
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// 原子写单块译文（每块恰好写一次；拒绝空/超限负载）。
pub fn write_chunk_impl(
    base_dir: &Path,
    content_hash: &str,
    chunk_index: u32,
    text: &str,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("整本翻译块译文不能为空".to_string());
    }
    if trimmed.len() > MAX_CHUNK_BYTES {
        return Err(format!("整本翻译块译文超过 {} 字节上限", MAX_CHUNK_BYTES));
    }
    let path = chunk_path(base_dir, content_hash, chunk_index)?;
    fs::create_dir_all(path.parent().unwrap_or(base_dir))
        .map_err(|error| format!("无法创建整本翻译缓存目录: {error}"))?;
    crate::file::write_file_impl(&path, trimmed)
}

/// 清除某本书的全部断点缓存（完成入库后调用；幂等：不存在也返回 Ok）。
/// 保留同目录其它书的缓存；`<hash>.d/` 目录连同块文件一并删除。
pub fn clear_impl(base_dir: &Path, content_hash: &str) -> Result<(), String> {
    let state = state_path(base_dir, content_hash)?;
    if state.exists() {
        fs::remove_file(&state).map_err(|error| format!("无法清除整本翻译状态: {error}"))?;
    }
    let dir = chunk_dir(base_dir, content_hash)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("无法清除整本翻译块缓存: {error}"))?;
    }
    Ok(())
}

/// 译本入库（`book_translation_import_epub` 的可测内核）：base64 解码 →
/// 大小校验 → 临时写 `book-translation/import-<pid>-<ms>.epub` → 复用受管
/// 导入（内容哈希去重）→ 删除临时文件。返回新（或同内容已存在）条目 id。
pub fn import_epub_impl(base_dir: &Path, epub_base64: &str) -> Result<String, String> {
    let bytes = crate::asset::decode_base64(epub_base64.trim())?;
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(format!("译本 EPUB 超过 {} 字节上限", MAX_IMPORT_BYTES));
    }
    let staging_dir = base_dir.join(BOOK_TRANSLATION_DIR);
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("无法创建整本翻译缓存目录: {error}"))?;
    let temp = staging_dir.join(format!("import-{}-{}.epub", std::process::id(), now_ms()));
    // write_file_impl 只收 UTF-8 文本；zip 字节用同构的临时文件 + rename 原子写。
    write_bytes_atomically(&temp, &bytes)?;
    let mut connection = library::open_database_at(base_dir)?;
    let imported = crate::managed::import_managed_book_at(&mut connection, base_dir, &temp);
    // 临时副本无论成败都删除；导入产物已入 library-content（受管所有权）。
    let _ = fs::remove_file(&temp);
    imported
}

/// 字节版原子写（file::write_file_impl 的二进制同构：同目录临时文件 + rename）。
fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的保存路径: {}", path.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建临时文件: {error}"))?;
    temp.write_all(bytes)
        .map_err(|error| format!("写入临时文件失败: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("无法保存到 {}: {}", path.display(), error.error))?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// 术语表条目（前端 `book-translation/glossary.ts` 同型；serde camelCase）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BookGlossaryTerm {
    pub source: String,
    pub target: String,
}

#[tauri::command]
pub fn book_translation_read_state(
    app: tauri::AppHandle,
    content_hash: String,
) -> Result<String, String> {
    read_state_impl(&resolve_base_dir(&app), &content_hash)
}

#[tauri::command]
pub fn book_translation_write_state(
    app: tauri::AppHandle,
    content_hash: String,
    json: String,
) -> Result<(), String> {
    write_state_impl(&resolve_base_dir(&app), &content_hash, &json)
}

#[tauri::command]
pub fn book_translation_read_chunk(
    app: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
) -> Result<String, String> {
    read_chunk_impl(&resolve_base_dir(&app), &content_hash, chunk_index)
}

#[tauri::command]
pub fn book_translation_write_chunk(
    app: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
    text: String,
) -> Result<(), String> {
    write_chunk_impl(&resolve_base_dir(&app), &content_hash, chunk_index, &text)
}

#[tauri::command]
pub fn book_translation_clear(app: tauri::AppHandle, content_hash: String) -> Result<(), String> {
    clear_impl(&resolve_base_dir(&app), &content_hash)
}

#[tauri::command]
pub fn book_translation_import_epub(
    app: tauri::AppHandle,
    epub_base64: String,
) -> Result<LibraryItem, String> {
    let base_dir = library::app_data_dir(&app)?;
    let item_id = import_epub_impl(&base_dir, &epub_base64)?;
    // 与 managed::library_import_managed_book 同口径：按 id 取回完整条目。
    library::library_list_items(app, None)?
        .into_iter()
        .find(|item| item.id == item_id)
        .ok_or_else(|| "整本译本写入后无法读取".to_string())
}

/// 单块整本翻译（ADR-5）：复用 `ai::translate_book_chunk`（同一三端点网络栈，
/// prompt 携带按书术语表；错误码族与选区翻译一致，密钥不出现在任何返回中）。
#[tauri::command]
pub async fn book_translation_translate_chunk(
    app: tauri::AppHandle,
    text: String,
    target_lang: String,
    glossary: Vec<BookGlossaryTerm>,
) -> Result<crate::ai::AiTranslationResult, crate::ai::AiError> {
    let terms: Vec<(String, String)> = glossary
        .into_iter()
        .map(|term| (term.source, term.target))
        .collect();
    crate::ai::translate_book_chunk(&app, &text, &target_lang, &terms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210";

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    /// 标准 base64 编码（asset.rs 只自带解码；测试侧本地实现）。
    fn b64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for group in bytes.chunks(3) {
            let byte0 = group[0] as u32;
            let byte1 = *group.get(1).unwrap_or(&0) as u32;
            let byte2 = *group.get(2).unwrap_or(&0) as u32;
            let triple = (byte0 << 16) | (byte1 << 8) | byte2;
            out.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
            out.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
            out.push(if group.len() > 1 {
                TABLE[(triple >> 6) as usize & 0x3f] as char
            } else {
                '='
            });
            out.push(if group.len() > 2 {
                TABLE[triple as usize & 0x3f] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn missing_state_and_chunk_return_empty_without_creating_directory() {
        let dir = temp_dir();
        assert_eq!(read_state_impl(dir.path(), HASH_A).unwrap(), "");
        assert_eq!(read_chunk_impl(dir.path(), HASH_A, 0).unwrap(), "");
        assert!(!dir.path().join(BOOK_TRANSLATION_DIR).exists());
    }

    #[test]
    fn state_roundtrip_is_per_book_and_atomic() {
        let dir = temp_dir();
        let json = r#"{"version":1,"targetLang":"zh-CN","totalChunks":3,"done":[true,false,false],"glossary":[{"source":"Harry","target":"哈利"}],"sourceChars":9000,"updatedAt":1}"#;
        write_state_impl(dir.path(), HASH_A, json).unwrap();
        write_state_impl(dir.path(), HASH_B, r#"{"version":1}"#).unwrap();
        assert_eq!(read_state_impl(dir.path(), HASH_A).unwrap(), json);
        assert_eq!(
            read_state_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":1}"#
        );
        // 原子写不得在目录里残留临时文件。
        let entries: Vec<_> = fs::read_dir(dir.path().join(BOOK_TRANSLATION_DIR))
            .unwrap()
            .collect();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn chunk_roundtrip_pads_index_and_keeps_files_separate_from_state() {
        let dir = temp_dir();
        write_chunk_impl(dir.path(), HASH_A, 0, "第一块译文\n第二段").unwrap();
        write_chunk_impl(dir.path(), HASH_A, 42, "第四十三块").unwrap();
        assert_eq!(
            read_chunk_impl(dir.path(), HASH_A, 0).unwrap(),
            "第一块译文\n第二段"
        );
        assert_eq!(
            read_chunk_impl(dir.path(), HASH_A, 42).unwrap(),
            "第四十三块"
        );
        assert_eq!(read_chunk_impl(dir.path(), HASH_A, 7).unwrap(), "");
        // 块文件在独立目录中，命名稳定（续译/重组按序读取）。
        let chunk_entries: Vec<_> = fs::read_dir(chunk_dir(dir.path(), HASH_A).unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(chunk_entries.contains(&"000000.txt".to_string()));
        assert!(chunk_entries.contains(&"000042.txt".to_string()));
        // 状态与块分属不同路径，互不串目录。
        assert!(!state_path(dir.path(), HASH_A).unwrap().exists());
        assert!(!chunk_dir(dir.path(), HASH_A)
            .unwrap()
            .join(format!("{HASH_A}.json"))
            .exists());
    }

    #[test]
    fn clear_removes_state_and_chunks_but_keeps_other_books() {
        let dir = temp_dir();
        write_state_impl(dir.path(), HASH_A, r#"{"version":1}"#).unwrap();
        write_chunk_impl(dir.path(), HASH_A, 0, "译文").unwrap();
        write_state_impl(dir.path(), HASH_B, r#"{"version":1}"#).unwrap();
        clear_impl(dir.path(), HASH_A).unwrap();
        // 幂等：再清一次仍是 Ok。
        clear_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(read_state_impl(dir.path(), HASH_A).unwrap(), "");
        assert_eq!(read_chunk_impl(dir.path(), HASH_A, 0).unwrap(), "");
        assert!(!chunk_dir(dir.path(), HASH_A).unwrap().exists());
        assert_eq!(
            read_state_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":1}"#
        );
    }

    #[test]
    fn rejects_invalid_hash_and_bad_payloads_before_touching_disk() {
        let dir = temp_dir();
        for hash in [
            "",
            "XYZ",
            "../cache",
            "0123456789abcde",
            "0123456789abcdefg",
        ] {
            assert!(read_state_impl(dir.path(), hash).is_err());
            assert!(write_state_impl(dir.path(), hash, "{}").is_err());
            assert!(read_chunk_impl(dir.path(), hash, 0).is_err());
            assert!(write_chunk_impl(dir.path(), hash, 0, "x").is_err());
            assert!(clear_impl(dir.path(), hash).is_err());
        }
        assert!(write_state_impl(dir.path(), HASH_A, "  ").is_err());
        assert!(write_state_impl(dir.path(), HASH_A, "").is_err());
        assert!(write_chunk_impl(dir.path(), HASH_A, 0, "   ").is_err());
        // 块序号越界在写盘前拒绝。
        assert!(write_chunk_impl(dir.path(), HASH_A, MAX_CHUNK_INDEX, "x").is_err());
        assert!(read_chunk_impl(dir.path(), HASH_A, MAX_CHUNK_INDEX).is_err());
        assert!(!dir.path().join(BOOK_TRANSLATION_DIR).exists());
    }

    #[test]
    fn oversized_state_and_chunk_payloads_are_rejected() {
        let dir = temp_dir();
        let huge = format!("{{\"pad\":\"{}\"}}", "汉".repeat(MAX_STATE_BYTES));
        assert!(write_state_impl(dir.path(), HASH_A, &huge).is_err());
        let big_chunk = "汉".repeat(MAX_CHUNK_BYTES + 1);
        assert!(write_chunk_impl(dir.path(), HASH_A, 0, &big_chunk).is_err());
        assert!(!dir.path().join(BOOK_TRANSLATION_DIR).exists());
    }

    #[test]
    fn import_epub_stores_managed_entry_and_removes_temp_copy() {
        let dir = temp_dir();
        // 最小合法 EPUB 字节（受管导入按文件哈希落 library-content，不校验 zip）。
        let epub: &[u8] = b"PK\x03\x04 minimal epub placeholder bytes";
        let encoded = b64(epub);
        let item_id = import_epub_impl(dir.path(), &encoded).unwrap();
        assert!(item_id.starts_with("managed:"), "unexpected id {item_id}");
        // 临时副本已删除，缓存目录不残留 import-* 文件。
        let staging = dir.path().join(BOOK_TRANSLATION_DIR);
        let leftovers: Vec<String> = fs::read_dir(&staging)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            leftovers.iter().all(|name| !name.starts_with("import-")),
            "temp copy left behind: {leftovers:?}"
        );
        // 同内容再次导入：内容哈希去重，条目 id 不变，不产生第二份 blob。
        let again = import_epub_impl(dir.path(), &encoded).unwrap();
        assert_eq!(again, item_id);
    }

    #[test]
    fn import_epub_rejects_bad_base64_and_oversized_payload() {
        let dir = temp_dir();
        assert!(import_epub_impl(dir.path(), "not!!base64@@").is_err());
        let big = b64(&vec![0u8; MAX_IMPORT_BYTES + 1]);
        assert!(import_epub_impl(dir.path(), &big).is_err());
        assert!(!dir.path().join(BOOK_TRANSLATION_DIR).exists());
    }

    #[test]
    fn book_translation_cache_stays_out_of_assistant_and_annotation_storage() {
        let dir = temp_dir();
        write_state_impl(dir.path(), HASH_A, r#"{"version":1}"#).unwrap();
        write_chunk_impl(dir.path(), HASH_A, 0, "译文").unwrap();
        assert!(dir.path().join(BOOK_TRANSLATION_DIR).exists());
        assert!(!dir.path().join("assistant").exists());
        assert!(!dir.path().join("annotations").exists());
    }

    #[test]
    fn glossary_term_deserializes_from_camel_case_payload() {
        let term: BookGlossaryTerm =
            serde_json::from_str(r#"{"source":"Harry","target":"哈利"}"#).unwrap();
        assert_eq!(term.source, "Harry");
        assert_eq!(term.target, "哈利");
        assert!(serde_json::from_str::<BookGlossaryTerm>(r#"{"src":"Harry"}"#).is_err());
    }
}
