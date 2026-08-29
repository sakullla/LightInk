//! 标注持久化（ebook-reader T6 / R4 / R5）。
//!
//! 标注按「文件内容哈希」关联，存 `<app_data_dir>/annotations/<hash>.json`，
//! 原子写（复用 [`crate::file::write_file_impl`]）。缺失或不可读视为空标注
//! （R4：损坏/缺失不阻断阅读）；标注读写永不触碰源电子书文件。
//!
//! JSON 对 Rust 不透明：备注、颜色等字段由前端 schema 拥有；改备注或删除是
//! 整文件覆写，不在此升跨书索引或「全部标注」目录。同步合并按记录 `id` 比较
//! `updatedAt`（缺失时回退 `createdAt`），较新覆盖；tombstone（`deletedAt`）
//! 参与比较且同刻删除优先，删除可跨端收敛而不复活。
//!
//! 内容哈希由本模块的 [`content_hash`] 命令在 Rust 侧计算（读字节 +
//! [`crate::asset::content_hash_hex`]，FNV-1a 64-bit）；`read_annotations` /
//! `write_annotations` 接收该哈希作为存储 key，只负责按 key 读写 JSON。

use std::fs;
use std::path::Path;

use crate::identifiers::validate_content_hash;

#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use std::collections::{HashMap, HashSet};

const ANNOTATIONS_DIR: &str = "annotations";

/// 标注文件路径：`<base_dir>/annotations/<content_hash>.json`。
fn annotations_path(base_dir: &Path, content_hash: &str) -> Result<std::path::PathBuf, String> {
    let content_hash = validate_content_hash(content_hash)?;
    Ok(base_dir
        .join(ANNOTATIONS_DIR)
        .join(format!("{}.json", content_hash)))
}

/// 读标注 JSON。文件缺失或不可读返回空串（视为无标注，不报错、不阻断）。
pub fn read_annotations_impl(base_dir: &Path, content_hash: &str) -> Result<String, String> {
    let path = annotations_path(base_dir, content_hash)?;
    if !path.exists() {
        return Ok(String::new());
    }
    // 读失败（权限等）同样视为空，避免阻断阅读。
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// 原子写标注 JSON（创建 annotations 目录，复用 file::write_file_impl 的原子写）。
pub fn write_annotations_impl(
    base_dir: &Path,
    content_hash: &str,
    json: &str,
) -> Result<(), String> {
    let path = annotations_path(base_dir, content_hash)?;
    let dir = base_dir.join(ANNOTATIONS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建标注目录: {}", e))?;
    crate::file::write_file_impl(&path, json)
}

fn resolve_base_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

#[cfg(test)]
fn parse_annotation_file(json: &str) -> Option<(u64, Vec<Value>)> {
    if json.trim().is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(json).ok()?;
    let object = parsed.as_object()?;
    let version = object.get("version").and_then(Value::as_u64).unwrap_or(0);
    let annotations = object.get("annotations")?.as_array()?.clone();
    Some((version, annotations))
}

#[cfg(test)]
fn annotation_id(value: &Value) -> Option<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

#[cfg(test)]
fn annotation_updated_at(value: &Value) -> f64 {
    value
        .get("updatedAt")
        .and_then(Value::as_f64)
        .or_else(|| value.get("createdAt").and_then(Value::as_f64))
        .filter(|timestamp| timestamp.is_finite())
        .unwrap_or(0.0)
}

#[cfg(test)]
fn annotation_is_tombstone(value: &Value) -> bool {
    value
        .get("deletedAt")
        .and_then(Value::as_f64)
        .is_some_and(f64::is_finite)
}

/// Merge two annotation documents by record id (v3 模型): The newer `updatedAt`
/// wins; a missing `updatedAt` falls back to `createdAt`. Tombstones
/// (`deletedAt`) participate in the clock comparison and win ties against a
/// live row so deletions converge instead of resurrecting. Corrupt or empty
/// input is treated as no records so a bad remote file cannot wipe local notes.
#[cfg(test)]
pub fn merge_annotations_json(local_json: &str, remote_json: &str) -> String {
    let local = parse_annotation_file(local_json);
    let remote = parse_annotation_file(remote_json);
    match (local, remote) {
        (None, None) => String::new(),
        (Some(_), None) => local_json.to_string(),
        (None, Some(_)) => remote_json.to_string(),
        (Some((_, local_items)), Some((_, remote_items))) => {
            let mut remote_by_id = HashMap::new();
            for item in &remote_items {
                if let Some(id) = annotation_id(item) {
                    remote_by_id.insert(id, item);
                }
            }
            let mut seen = HashSet::new();
            let mut merged = Vec::new();
            for item in &local_items {
                let Some(id) = annotation_id(item) else {
                    continue;
                };
                seen.insert(id);
                if let Some(remote_item) = remote_by_id.get(id) {
                    let remote_clock = annotation_updated_at(remote_item);
                    let local_clock = annotation_updated_at(item);
                    let remote_wins = remote_clock > local_clock
                        || (remote_clock == local_clock
                            && annotation_is_tombstone(remote_item)
                            && !annotation_is_tombstone(item));
                    if remote_wins {
                        merged.push((*remote_item).clone());
                    } else {
                        merged.push(item.clone());
                    }
                } else {
                    merged.push(item.clone());
                }
            }
            for item in &remote_items {
                if let Some(id) = annotation_id(item) {
                    if seen.insert(id) {
                        merged.push(item.clone());
                    }
                }
            }
            serde_json::json!({
                "version": 3,
                "annotations": merged,
            })
            .to_string()
        }
    }
}

/// List locally stored annotation files keyed by content hash.
#[cfg(test)]
pub fn list_annotations_by_hash(base_dir: &Path) -> Result<Vec<(String, String)>, String> {
    let dir = base_dir.join(ANNOTATIONS_DIR);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut listed = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|error| format!("无法读取标注目录: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取标注目录: {error}"))?;
        let file_name = entry.file_name();
        let Some(hash) = file_name
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };
        if validate_content_hash(hash).is_err() {
            continue;
        }
        let json = fs::read_to_string(entry.path()).unwrap_or_default();
        listed.push((hash.to_string(), json));
    }
    listed.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(listed)
}

/// Read local annotations for a content hash, merge a remote document by
/// `updatedAt`, and write only when the merged result differs.
#[cfg(test)]
pub fn merge_remote_annotations_impl(
    base_dir: &Path,
    content_hash: &str,
    remote_json: &str,
) -> Result<String, String> {
    let local_json = read_annotations_impl(base_dir, content_hash)?;
    let merged = merge_annotations_json(&local_json, remote_json);
    if merged != local_json {
        write_annotations_impl(base_dir, content_hash, &merged)?;
    }
    Ok(merged)
}

#[tauri::command]
pub fn read_annotations(app: tauri::AppHandle, content_hash: String) -> Result<String, String> {
    read_annotations_impl(&resolve_base_dir(&app), &content_hash)
}

/// 计算文件内容哈希（FNV-1a 64-bit → 16 hex），作为标注存储 key。
/// 供前端按内容特征关联标注（R4）；读字节与哈希都在 Rust 侧，避免 JS 大文件 BigInt 开销。
#[tauri::command]
pub fn content_hash(path: String) -> Result<String, String> {
    let bytes = crate::file::read_file_bytes_impl(std::path::Path::new(&path))?;
    Ok(crate::asset::content_hash_hex(&bytes))
}

#[tauri::command]
pub fn write_annotations(
    app: tauri::AppHandle,
    content_hash: String,
    json: String,
) -> Result<(), String> {
    write_annotations_impl(&resolve_base_dir(&app), &content_hash, &json)
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
    fn missing_annotations_return_empty() {
        let dir = temp_dir();
        let got = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(got, "");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = temp_dir();
        let json = r#"{"annotations":[{"id":"a1","kind":"highlight"}]}"#;
        write_annotations_impl(dir.path(), HASH_A, json).unwrap();
        let back = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn distinct_content_hashes_isolate_storage() {
        let dir = temp_dir();
        write_annotations_impl(dir.path(), HASH_A, r#"{"a":1}"#).unwrap();
        write_annotations_impl(dir.path(), HASH_B, r#"{"b":2}"#).unwrap();
        assert_ne!(
            read_annotations_impl(dir.path(), HASH_A).unwrap(),
            read_annotations_impl(dir.path(), HASH_B).unwrap()
        );
    }

    #[test]
    fn annotations_dir_is_created() {
        let dir = temp_dir();
        write_annotations_impl(dir.path(), HASH_A, "{}").unwrap();
        assert!(dir
            .path()
            .join(ANNOTATIONS_DIR)
            .join(format!("{HASH_A}.json"))
            .exists());
    }

    #[test]
    fn unreadable_or_corrupt_file_yields_empty_not_error() {
        let dir = temp_dir();
        // 损坏 JSON（非法字节序列对 read_to_string 而言仍可读为字符串）：
        // 这里写一段非 UTF-8 字节会令 read_to_string 失败 → 视为空。
        let path = dir.path().join(ANNOTATIONS_DIR);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join(format!("{HASH_A}.json")), b"\xff\xfe\x00").unwrap();
        // read_to_string 对非 UTF-8 失败 → unwrap_or_default 返回 ""。
        let got = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(got, "");
    }

    #[test]
    fn rejects_invalid_content_hashes_before_path_construction() {
        let dir = temp_dir();
        for hash in ["", "ABCDEF0123456789", "../annotations", "0123456789abcde"] {
            assert!(read_annotations_impl(dir.path(), hash).is_err());
            assert!(write_annotations_impl(dir.path(), hash, "{}").is_err());
        }
        assert!(!dir.path().join(ANNOTATIONS_DIR).exists());
    }

    #[test]
    fn note_and_color_overwrite_stays_per_hash() {
        // R5：改备注/颜色是整文件覆写；只动本书 key，不写跨书总库。
        let dir = temp_dir();
        let original = r##"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"旧备注","color":"#86c28b"}]}"##;
        let updated = r##"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"新备注","color":"#7eb6d9"}]}"##;
        write_annotations_impl(dir.path(), HASH_A, original).unwrap();
        write_annotations_impl(
            dir.path(),
            HASH_B,
            r#"{"version":3,"annotations":[{"id":"b1"}]}"#,
        )
        .unwrap();
        write_annotations_impl(dir.path(), HASH_A, updated).unwrap();
        assert_eq!(read_annotations_impl(dir.path(), HASH_A).unwrap(), updated);
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":3,"annotations":[{"id":"b1"}]}"#
        );
    }

    #[test]
    fn delete_overwrite_does_not_create_cross_book_index() {
        let dir = temp_dir();
        write_annotations_impl(
            dir.path(),
            HASH_A,
            r##"{"version":3,"annotations":[{"id":"a1","kind":"highlight","color":"#f2d675"}]}"##,
        )
        .unwrap();
        write_annotations_impl(
            dir.path(),
            HASH_B,
            r#"{"version":3,"annotations":[{"id":"b1","kind":"note","note":"留着"}]}"#,
        )
        .unwrap();
        write_annotations_impl(dir.path(), HASH_A, r#"{"version":3,"annotations":[]}"#).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path().join(ANNOTATIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&format!("{HASH_A}.json")));
        assert!(names.contains(&format!("{HASH_B}.json")));
        assert!(!names
            .iter()
            .any(|name| name == "index.json" || name == "all.json"));
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_A).unwrap(),
            r#"{"version":3,"annotations":[]}"#
        );
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":3,"annotations":[{"id":"b1","kind":"note","note":"留着"}]}"#
        );
    }

    #[test]
    fn write_annotations_does_not_touch_source_file() {
        // R4：标注全程不写源文件。用源内容的哈希作 key 写标注，断言源内容/mtime 不变。
        let dir = temp_dir();
        let src = dir.path().join("book.epub");
        let content = b"SOURCE-BYTES";
        fs::write(&src, content).unwrap();
        let mtime_before = fs::metadata(&src).unwrap().modified().unwrap();
        let hash = crate::asset::content_hash_hex(content);
        write_annotations_impl(dir.path(), &hash, r#"{"version":3,"annotations":[]}"#).unwrap();
        assert_eq!(
            fs::read(&src).unwrap(),
            content,
            "source content must not change"
        );
        let mtime_after = fs::metadata(&src).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "source mtime must not change");
        // 标注确实写到了 annotations/<hash>.json，而非源文件。
        assert!(dir
            .path()
            .join(ANNOTATIONS_DIR)
            .join(format!("{hash}.json"))
            .exists());
    }

    fn annotation_ids(json: &str) -> Vec<String> {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        parsed["annotations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn annotation_note(json: &str, id: &str) -> Option<String> {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        parsed["annotations"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|item| {
                (item["id"].as_str() == Some(id))
                    .then(|| {
                        item.get("note")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .flatten()
            })
    }

    #[test]
    fn webdav_annotation_merge_prefers_newer_updated_at() {
        let local = r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"旧","createdAt":1,"updatedAt":10},{"id":"n2","kind":"note","note":"只在本地","createdAt":2,"updatedAt":5}]}"#;
        let remote = r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"新","createdAt":1,"updatedAt":20},{"id":"n3","kind":"note","note":"只在远端","createdAt":3,"updatedAt":8}]}"#;
        let merged = merge_annotations_json(local, remote);
        assert_eq!(annotation_ids(&merged), ["n1", "n2", "n3"]);
        assert_eq!(annotation_note(&merged, "n1").as_deref(), Some("新"));
        assert_eq!(annotation_note(&merged, "n2").as_deref(), Some("只在本地"));
        assert_eq!(annotation_note(&merged, "n3").as_deref(), Some("只在远端"));
    }

    #[test]
    fn webdav_annotation_merge_falls_back_to_created_at() {
        let local =
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"旧","createdAt":10}]}"#;
        let remote =
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"新","createdAt":20}]}"#;
        let merged = merge_annotations_json(local, remote);
        assert_eq!(annotation_note(&merged, "n1").as_deref(), Some("新"));
        let tied = merge_annotations_json(
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"本地","createdAt":5}]}"#,
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"远端","createdAt":5}]}"#,
        );
        assert_eq!(annotation_note(&tied, "n1").as_deref(), Some("本地"));
    }

    #[test]
    fn webdav_annotation_merge_tombstone_wins_tie_and_newer_clock() {
        // 同刻删除优先：远端 tombstone 与本地活跃记录同 updatedAt 时删除收敛。
        let local = r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"本地","createdAt":1,"updatedAt":5}]}"#;
        let remote = r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"远端","createdAt":1,"updatedAt":5,"deletedAt":5}]}"#;
        let merged = merge_annotations_json(local, remote);
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        let item = &parsed["annotations"][0];
        assert_eq!(item["deletedAt"].as_f64(), Some(5.0));

        // tombstone 参与时钟比较：更新的活跃记录可以覆盖较旧的 tombstone。
        let resurrect = merge_annotations_json(
            remote,
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"更新","createdAt":1,"updatedAt":9}]}"#,
        );
        let parsed: serde_json::Value = serde_json::from_str(&resurrect).unwrap();
        let item = &parsed["annotations"][0];
        assert!(item.get("deletedAt").is_none());
        assert_eq!(item["note"].as_str(), Some("更新"));

        // 等刻且双方都活跃：保留本地行。
        let tied = merge_annotations_json(
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"本地","createdAt":5}]}"#,
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"远端","createdAt":5}]}"#,
        );
        assert_eq!(annotation_note(&tied, "n1").as_deref(), Some("本地"));
    }

    #[test]
    fn webdav_annotation_merge_corrupt_remote_leaves_local() {
        let local = r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"留下","createdAt":1}]}"#;
        assert_eq!(merge_annotations_json(local, "{not-json"), local);
        assert_eq!(merge_annotations_json(local, ""), local);
        assert!(merge_annotations_json("", "{not-json").is_empty());
    }

    #[test]
    fn webdav_annotation_merge_does_not_keep_top_level_secrets() {
        let local = r#"{"version":3,"password":"secret","annotations":[{"id":"n1","kind":"note","createdAt":1}]}"#;
        let remote = r#"{"version":3,"token":"abc","annotations":[{"id":"n2","kind":"note","createdAt":2}]}"#;
        let merged = merge_annotations_json(local, remote);
        assert!(!merged.contains("secret"));
        assert!(!merged.contains("abc"));
        assert!(!merged.contains("password"));
        assert!(!merged.contains("token"));
        assert_eq!(annotation_ids(&merged), ["n1", "n2"]);
    }

    #[test]
    fn webdav_list_and_apply_annotations_are_keyed_by_content_hash() {
        let dir = temp_dir();
        write_annotations_impl(
            dir.path(),
            HASH_A,
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"旧","createdAt":1,"updatedAt":10}]}"#,
        )
        .unwrap();
        write_annotations_impl(
            dir.path(),
            HASH_B,
            r#"{"version":3,"annotations":[{"id":"b1","kind":"note","note":"另一本","createdAt":1}]}"#,
        )
        .unwrap();
        let listed = list_annotations_by_hash(dir.path()).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|(hash, _)| hash.as_str())
                .collect::<Vec<_>>(),
            [HASH_A, HASH_B]
        );

        let merged = merge_remote_annotations_impl(
            dir.path(),
            HASH_A,
            r#"{"version":3,"annotations":[{"id":"n1","kind":"note","note":"新","createdAt":1,"updatedAt":20}]}"#,
        )
        .unwrap();
        assert_eq!(annotation_note(&merged, "n1").as_deref(), Some("新"));
        assert_eq!(
            annotation_note(&read_annotations_impl(dir.path(), HASH_A).unwrap(), "n1").as_deref(),
            Some("新")
        );
        assert_eq!(
            annotation_note(&read_annotations_impl(dir.path(), HASH_B).unwrap(), "b1").as_deref(),
            Some("另一本")
        );
    }
}
