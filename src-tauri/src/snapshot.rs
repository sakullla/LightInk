//! 崩溃恢复快照服务（T3）。
//!
//! 唯一 owner：Rust 快照服务。前端在编辑防抖后写入本地快照（应用数据目录
//! `snapshots/` 下，按文件路径的稳定哈希命名）；意外退出后重启时检测
//! 「快照比磁盘文件新」并提示恢复；正常保存/关闭后删除对应快照。
//!
//! 纯函数均接受可注入的 `base_dir` 以便单元测试；Tauri 命令层负责解析
//! 应用数据目录（失败时回退到系统临时目录）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::file::write_file_impl;

const SNAPSHOT_DIR_NAME: &str = "snapshots";
const SNAPSHOT_EXT: &str = "snapshot";
/// 未命名标签快照索引：快照文件按哈希命名无法反推键，故维护
/// `untitled-index.json`（键 → 写入毫秒时间戳），使启动时可枚举崩溃遗留的
/// 未命名草稿。正常保存/关闭会同时移除索引条目与快照文件。
const UNTITLED_INDEX_NAME: &str = "untitled-index.json";
const UNTITLED_KEY_PREFIX: &str = "untitled-";
static UNTITLED_INDEX_LOCK: Mutex<()> = Mutex::new(());

/// FNV-1a 64-bit 哈希 —— 跨进程/跨运行稳定（std 的 DefaultHasher 不保证
/// 稳定，不能用于持久化命名）。对规范化后的路径字符串计算，输出 hex。
fn stable_path_hash(file_path: &str) -> String {
    // 规范化：统一分隔符并去结尾分隔符。Windows 路径大小写不敏感，仅在
    // Windows 上小写化，避免大小写敏感文件系统（Linux/macOS）下仅大小写
    // 不同的两个文件映射到同一快照而串档。
    let unified = file_path.replace('/', "\\");
    let trimmed = unified.trim_end_matches('\\');
    let normalized = if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

/// 快照文件完整路径：`<base_dir>/<hash>.snapshot`。
pub fn snapshot_path_for(base_dir: &Path, file_path: &str) -> PathBuf {
    base_dir.join(SNAPSHOT_DIR_NAME).join(format!(
        "{}.{}",
        stable_path_hash(file_path),
        SNAPSHOT_EXT
    ))
}

/// 未命名草稿索引条目（序列化进 untitled-index.json）。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct UntitledIndexEntry {
    key: String,
    written_at_ms: u64,
}

/// 返回给前端的未命名崩溃草稿。
#[derive(serde::Serialize)]
pub struct UntitledDraft {
    pub key: String,
    pub content: String,
}

fn untitled_index_path(base_dir: &Path) -> PathBuf {
    base_dir.join(SNAPSHOT_DIR_NAME).join(UNTITLED_INDEX_NAME)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_untitled_index(base_dir: &Path) -> Vec<UntitledIndexEntry> {
    let path = untitled_index_path(base_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Vec::new(), // 索引不存在等同空
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_untitled_index(base_dir: &Path, entries: &[UntitledIndexEntry]) -> Result<(), String> {
    let path = untitled_index_path(base_dir);
    let body =
        serde_json::to_string(entries).map_err(|e| format!("无法序列化未命名快照索引: {}", e))?;
    write_file_impl(&path, &body)
}

fn lock_untitled_index() -> Result<MutexGuard<'static, ()>, String> {
    UNTITLED_INDEX_LOCK
        .lock()
        .map_err(|_| "未命名快照索引锁已损坏".to_string())
}

fn remove_snapshot_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法删除快照 {}: {}", path.display(), e)),
    }
}

/// 原子写快照（复用 file 模块的原子写实现）；未命名键同步登记索引。
pub fn write_snapshot_impl(base_dir: &Path, file_path: &str, content: &str) -> Result<(), String> {
    let snap = snapshot_path_for(base_dir, file_path);
    if file_path.starts_with(UNTITLED_KEY_PREFIX) {
        let _guard = lock_untitled_index()?;
        write_file_impl(&snap, content)?;
        let mut entries = load_untitled_index(base_dir);
        entries.retain(|e| e.key != file_path);
        entries.push(UntitledIndexEntry {
            key: file_path.to_owned(),
            written_at_ms: now_ms(),
        });
        save_untitled_index(base_dir, &entries)?;
    } else {
        write_file_impl(&snap, content)?;
    }
    Ok(())
}

/// 删除快照；快照不存在不算错误。未命名键同步移除索引条目。
pub fn clear_snapshot_impl(base_dir: &Path, file_path: &str) -> Result<(), String> {
    let snap = snapshot_path_for(base_dir, file_path);
    if file_path.starts_with(UNTITLED_KEY_PREFIX) {
        let _guard = lock_untitled_index()?;
        remove_snapshot_file(&snap)?;
        let mut entries = load_untitled_index(base_dir);
        let before = entries.len();
        entries.retain(|e| e.key != file_path);
        if entries.len() != before {
            save_untitled_index(base_dir, &entries)?;
        }
    } else {
        remove_snapshot_file(&snap)?;
    }
    Ok(())
}

/// 枚举仍存在的未命名草稿快照（启动崩溃恢复用）。索引与快照文件相互
/// 校验：索引指向的快照缺失时自动剔除该条目（并回写索引）。
pub fn list_untitled_drafts_impl(base_dir: &Path) -> Result<Vec<UntitledDraft>, String> {
    let _guard = lock_untitled_index()?;
    let entries = load_untitled_index(base_dir);
    let mut drafts: Vec<UntitledDraft> = Vec::new();
    let mut surviving: Vec<UntitledIndexEntry> = Vec::new();
    let mut pruned = false;
    for entry in entries {
        let snap = snapshot_path_for(base_dir, &entry.key);
        match fs::read_to_string(&snap) {
            Ok(content) => {
                drafts.push(UntitledDraft {
                    key: entry.key.clone(),
                    content,
                });
                surviving.push(entry);
            }
            Err(_) => pruned = true,
        }
    }
    if pruned {
        save_untitled_index(base_dir, &surviving)?;
    }
    // 稳定顺序：按写入时间升序（最旧草稿排前）。
    drafts.sort_by_key(|d| {
        surviving
            .iter()
            .find(|e| e.key == d.key)
            .map(|e| e.written_at_ms)
            .unwrap_or(0)
    });
    Ok(drafts)
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// 「崩溃新于保存」启发式：快照存在且其 mtime 晚于磁盘文件 mtime 时，
/// 返回快照内容；否则返回 None。磁盘文件不存在时视为 epoch 0，
/// 任何存在的快照都算「更新」。
pub fn read_stale_snapshot_impl(
    base_dir: &Path,
    file_path: &str,
) -> Result<Option<String>, String> {
    let snap = snapshot_path_for(base_dir, file_path);
    let snap_mtime = match mtime(&snap) {
        Some(t) => t,
        None => return Ok(None), // 快照不存在
    };
    let disk_mtime = mtime(Path::new(file_path)).unwrap_or(UNIX_EPOCH);
    if snap_mtime > disk_mtime {
        let content = fs::read_to_string(&snap)
            .map_err(|e| format!("无法读取快照 {}: {}", snap.display(), e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

/// 解析快照根目录：优先应用数据目录，失败时回退系统临时目录。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

#[tauri::command]
pub fn write_snapshot(
    app: tauri::AppHandle,
    file_path: String,
    content: String,
) -> Result<(), String> {
    write_snapshot_impl(&resolve_base_dir(&app), &file_path, &content)
}

#[tauri::command]
pub fn clear_snapshot(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    clear_snapshot_impl(&resolve_base_dir(&app), &file_path)
}

#[tauri::command]
pub fn read_stale_snapshot(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<Option<String>, String> {
    read_stale_snapshot_impl(&resolve_base_dir(&app), &file_path)
}

#[tauri::command]
pub fn list_untitled_drafts(app: tauri::AppHandle) -> Result<Vec<UntitledDraft>, String> {
    list_untitled_drafts_impl(&resolve_base_dir(&app))
}

// ── 本地版本快照（R13）──────────────────────────────────────────────
// 与崩溃恢复快照并存但独立：版本按文件分组存于 `<base>/versions/<hash>/`，
// 每个版本是 `<单调时间戳>.version` 文件（内容=快照时的文档全文）。每文件
// 数量上限 [`MAX_VERSIONS_PER_FILE`]，超出按时间最旧淘汰。纯逻辑 [`evict_ids`]
// 与排序可单测；Tauri 命令薄封装定位 app data 目录。

/// 每文件版本数量上限（超出最旧淘汰）。
pub const MAX_VERSIONS_PER_FILE: usize = 20;
const VERSIONS_DIR_NAME: &str = "versions";
const VERSION_EXT: &str = "version";

/// 版本元数据（返回前端：列表/预览/恢复 UI）。
#[derive(serde::Serialize, Clone)]
pub struct VersionMeta {
    /// 版本 id（单调毫秒时间戳字符串，即文件名 stem）。
    pub id: String,
    /// 创建毫秒时间戳。
    pub created_at_ms: u64,
}

/// 某文件的版本目录：`<base>/versions/<hash>/`（hash 与崩溃快照同源，路径规范化一致）。
fn version_dir_for(base_dir: &Path, file_path: &str) -> PathBuf {
    base_dir
        .join(VERSIONS_DIR_NAME)
        .join(stable_path_hash(file_path))
}

/// 列出某文件版本目录下的版本 id（文件名 stem），按数值升序（最旧在前）。
fn list_version_ids(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                e.path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .filter(|s| s.parse::<u64>().is_ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    ids.sort_by_key(|id| id.parse::<u64>().unwrap_or(0));
    ids
}

/// 纯逻辑：给定升序版本 id 与上限，返回应淘汰的最旧 id（保留最新 cap 个）。
pub fn evict_ids(asc_ids: &[String], cap: usize) -> Vec<String> {
    if asc_ids.len() <= cap {
        return Vec::new();
    }
    asc_ids[..asc_ids.len() - cap].to_vec()
}

/// 创建一个版本（保存时自动 / 手动）。id 取 max(now, max_existing+1) 保证单调
/// 唯一；写入后按上限淘汰最旧。返回新版本元数据。
pub fn create_version_impl(
    base_dir: &Path,
    file_path: &str,
    content: &str,
) -> Result<VersionMeta, String> {
    let dir = version_dir_for(base_dir, file_path);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建版本目录 {}: {}", dir.display(), e))?;
    let max_existing = list_version_ids(&dir)
        .iter()
        .filter_map(|i| i.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let id = now_ms().max(max_existing + 1);
    let id_str = id.to_string();
    let path = dir.join(format!("{id_str}.{VERSION_EXT}"));
    write_file_impl(&path, content)?;
    // 淘汰超上限的最旧版本（应用不报错：删除失败忽略）。
    for old in evict_ids(&list_version_ids(&dir), MAX_VERSIONS_PER_FILE) {
        let _ = fs::remove_file(dir.join(format!("{old}.{VERSION_EXT}")));
    }
    Ok(VersionMeta {
        id: id_str,
        created_at_ms: id,
    })
}

/// 列出某文件全部版本，按时间降序（最新在前，供 UI 呈现）。
pub fn list_versions_impl(base_dir: &Path, file_path: &str) -> Result<Vec<VersionMeta>, String> {
    let dir = version_dir_for(base_dir, file_path);
    Ok(list_version_ids(&dir)
        .into_iter()
        .rev()
        .map(|id| VersionMeta {
            created_at_ms: id.parse::<u64>().unwrap_or(0),
            id,
        })
        .collect())
}

/// 读取某版本完整内容（预览用）。
pub fn read_version_impl(
    base_dir: &Path,
    file_path: &str,
    version_id: &str,
) -> Result<String, String> {
    let path = version_dir_for(base_dir, file_path).join(format!("{version_id}.{VERSION_EXT}"));
    fs::read_to_string(&path).map_err(|e| format!("无法读取版本 {version_id}: {e}"))
}

/// 恢复某版本：先读取目标内容，再把「当前内容」存为一份新版本（防误操作），
/// 最后返回目标内容（由前端写回编辑器并置脏）。先读后存保证目标不会被
/// 随后淘汰误删。
pub fn restore_version_impl(
    base_dir: &Path,
    file_path: &str,
    version_id: &str,
    current_content: &str,
) -> Result<String, String> {
    let target = read_version_impl(base_dir, file_path, version_id)?;
    // 恢复前自动生成当前内容快照（失败不阻断恢复）。
    let _ = create_version_impl(base_dir, file_path, current_content);
    Ok(target)
}

#[tauri::command]
pub fn create_version(
    app: tauri::AppHandle,
    file_path: String,
    content: String,
) -> Result<VersionMeta, String> {
    create_version_impl(&resolve_base_dir(&app), &file_path, &content)
}

#[tauri::command]
pub fn list_versions(app: tauri::AppHandle, file_path: String) -> Result<Vec<VersionMeta>, String> {
    list_versions_impl(&resolve_base_dir(&app), &file_path)
}

#[tauri::command]
pub fn read_version(
    app: tauri::AppHandle,
    file_path: String,
    version_id: String,
) -> Result<String, String> {
    read_version_impl(&resolve_base_dir(&app), &file_path, &version_id)
}

#[tauri::command]
pub fn restore_version(
    app: tauri::AppHandle,
    file_path: String,
    version_id: String,
    current_content: String,
) -> Result<String, String> {
    restore_version_impl(
        &resolve_base_dir(&app),
        &file_path,
        &version_id,
        &current_content,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn hash_is_stable_and_path_form_insensitive() {
        // 同一字符串多次哈希一致（跨运行稳定是 FNV-1a 的算法属性）
        assert_eq!(
            stable_path_hash("C:\\a\\b.md"),
            stable_path_hash("C:\\a\\b.md")
        );
        // 正/反斜杠差异映射到同一快照
        assert_eq!(
            stable_path_hash("C:/Docs/Note.md"),
            stable_path_hash("C:\\Docs\\Note.md")
        );
        // 大小写不敏感仅在 Windows（路径大小写不敏感文件系统）成立
        if cfg!(windows) {
            assert_eq!(
                stable_path_hash("C:/Docs/Note.md"),
                stable_path_hash("c:\\docs\\note.md")
            );
        } else {
            assert_ne!(
                stable_path_hash("/Docs/Note.md"),
                stable_path_hash("/docs/note.md")
            );
        }
        // 不同路径哈希不同
        assert_ne!(stable_path_hash("C:\\a.md"), stable_path_hash("C:\\b.md"));
        // hex 格式
        assert_eq!(stable_path_hash("x").len(), 16);
    }

    #[test]
    fn untitled_write_then_list_then_clear() {
        let dir = temp_dir();
        write_snapshot_impl(dir.path(), "untitled-a1b2c3", "草稿甲").expect("write a");
        write_snapshot_impl(dir.path(), "untitled-d4e5f6", "草稿乙").expect("write b");
        // 文件路径键不进索引
        write_snapshot_impl(dir.path(), "C:\\doc.md", "正式文件").expect("write file");

        let drafts = list_untitled_drafts_impl(dir.path()).expect("list");
        assert_eq!(drafts.len(), 2);
        assert!(drafts
            .iter()
            .any(|d| d.key == "untitled-a1b2c3" && d.content == "草稿甲"));
        assert!(drafts
            .iter()
            .any(|d| d.key == "untitled-d4e5f6" && d.content == "草稿乙"));

        clear_snapshot_impl(dir.path(), "untitled-a1b2c3").expect("clear");
        let drafts = list_untitled_drafts_impl(dir.path()).expect("list after clear");
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].key, "untitled-d4e5f6");
    }

    #[test]
    fn concurrent_untitled_writes_keep_every_index_entry() {
        let dir = temp_dir();
        let base = Arc::new(dir.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(12));
        let handles: Vec<_> = (0..12)
            .map(|index| {
                let base = Arc::clone(&base);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    let key = format!("untitled-concurrent-{index}");
                    write_snapshot_impl(&base, &key, &format!("draft {index}"))
                })
            })
            .collect();

        for handle in handles {
            handle
                .join()
                .expect("writer thread")
                .expect("write snapshot");
        }
        let drafts = list_untitled_drafts_impl(&base).expect("list drafts");
        assert_eq!(drafts.len(), 12);
        for index in 0..12 {
            assert!(drafts
                .iter()
                .any(|draft| draft.key == format!("untitled-concurrent-{index}")));
        }
    }

    #[test]
    fn untitled_list_prunes_index_when_snapshot_missing() {
        let dir = temp_dir();
        write_snapshot_impl(dir.path(), "untitled-g7h8i9", "草稿").expect("write");
        // 手动删掉快照文件但保留索引 → list 应剔除并回写索引
        let snap = snapshot_path_for(dir.path(), "untitled-g7h8i9");
        fs::remove_file(&snap).unwrap();
        let drafts = list_untitled_drafts_impl(dir.path()).expect("list");
        assert!(drafts.is_empty());
        assert!(load_untitled_index(dir.path()).is_empty());
    }

    #[test]
    fn untitled_overwrite_same_key_keeps_single_entry() {
        let dir = temp_dir();
        write_snapshot_impl(dir.path(), "untitled-j1k2l3", "v1").expect("write v1");
        write_snapshot_impl(dir.path(), "untitled-j1k2l3", "v2").expect("write v2");
        let drafts = list_untitled_drafts_impl(dir.path()).expect("list");
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].content, "v2");
    }

    #[test]
    fn write_then_clear_cycle() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &target_str, "快照内容 中文").expect("write snapshot");
        let snap = snapshot_path_for(dir.path(), &target_str);
        assert!(snap.exists());
        assert_eq!(fs::read_to_string(&snap).unwrap(), "快照内容 中文");
        clear_snapshot_impl(dir.path(), &target_str).expect("clear");
        assert!(!snap.exists());
    }

    #[test]
    fn clear_missing_snapshot_is_ok() {
        let dir = temp_dir();
        clear_snapshot_impl(dir.path(), "C:\\never\\existed.md").expect("clear missing");
    }

    #[test]
    fn stale_snapshot_newer_than_disk_returns_content() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        fs::write(&target, "磁盘旧内容").unwrap();
        // 确保快照 mtime 严格更晚
        thread::sleep(Duration::from_millis(20));
        write_snapshot_impl(dir.path(), &target_str, "崩溃前的新内容").expect("snapshot");
        let stale = read_stale_snapshot_impl(dir.path(), &target_str).expect("read stale");
        assert_eq!(stale.as_deref(), Some("崩溃前的新内容"));
    }

    #[test]
    fn snapshot_older_than_disk_is_not_stale() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &target_str, "旧快照").expect("snapshot");
        thread::sleep(Duration::from_millis(20));
        fs::write(&target, "已保存的新内容").unwrap();
        let stale = read_stale_snapshot_impl(dir.path(), &target_str).expect("read stale");
        assert_eq!(stale, None);
    }

    #[test]
    fn missing_disk_file_makes_any_snapshot_stale() {
        let dir = temp_dir();
        let missing = dir.path().join("gone.md");
        let missing_str = missing.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &missing_str, "未保存的草稿").expect("snapshot");
        let stale = read_stale_snapshot_impl(dir.path(), &missing_str).expect("read stale");
        assert_eq!(stale.as_deref(), Some("未保存的草稿"));
    }

    #[test]
    fn no_snapshot_returns_none() {
        let dir = temp_dir();
        let stale = read_stale_snapshot_impl(dir.path(), "C:\\nothing.md").expect("read stale");
        assert_eq!(stale, None);
    }

    // ── R13 版本快照 ──
    #[test]
    fn evict_ids_keeps_newest_cap() {
        let ids: Vec<String> = (0..10).map(|i| i.to_string()).collect();
        assert!(evict_ids(&ids, 10).is_empty());
        // 保留最新 4 个（6,7,8,9），淘汰 0..6。
        let evict = evict_ids(&ids, 4);
        assert_eq!(evict, vec!["0", "1", "2", "3", "4", "5"]);
    }

    #[test]
    fn version_create_then_list_newest_first() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let path = target.to_string_lossy().into_owned();
        let m1 = create_version_impl(dir.path(), &path, "v1").expect("create v1");
        thread::sleep(Duration::from_millis(5));
        let m2 = create_version_impl(dir.path(), &path, "v2").expect("create v2");

        let list = list_versions_impl(dir.path(), &path).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, m2.id); // 最新在前
        assert_eq!(list[1].id, m1.id);
        assert!(m2.created_at_ms > m1.created_at_ms);
    }

    #[test]
    fn version_read_returns_full_content() {
        let dir = temp_dir();
        let path = dir.path().join("d.md").to_string_lossy().into_owned();
        let m = create_version_impl(dir.path(), &path, "完整内容 🚀").expect("create");
        assert_eq!(
            read_version_impl(dir.path(), &path, &m.id).expect("read"),
            "完整内容 🚀"
        );
    }

    #[test]
    fn version_evicts_oldest_beyond_cap() {
        let dir = temp_dir();
        let path = dir.path().join("cap.md").to_string_lossy().into_owned();
        let mut first_id = String::new();
        for i in 0..(MAX_VERSIONS_PER_FILE + 5) {
            let m = create_version_impl(dir.path(), &path, &format!("v{i}")).expect("create");
            if i == 0 {
                first_id = m.id;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let list = list_versions_impl(dir.path(), &path).expect("list");
        assert_eq!(list.len(), MAX_VERSIONS_PER_FILE);
        // 最旧版本已被淘汰。
        assert!(list.iter().all(|m| m.id != first_id));
    }

    #[test]
    fn restore_snapshots_current_and_returns_target() {
        let dir = temp_dir();
        let path = dir.path().join("r.md").to_string_lossy().into_owned();
        let old = create_version_impl(dir.path(), &path, "旧版本").expect("old");
        thread::sleep(Duration::from_millis(5));
        let _new = create_version_impl(dir.path(), &path, "新版本").expect("new");

        // 当前编辑器内容为「当前」；恢复 old → 返回 old，并把「当前」存为新版本。
        let restored = restore_version_impl(dir.path(), &path, &old.id, "当前").expect("restore");
        assert_eq!(restored, "旧版本");
        let list = list_versions_impl(dir.path(), &path).expect("list");
        assert!(list
            .iter()
            .any(|m| read_version_impl(dir.path(), &path, &m.id).unwrap_or_default() == "当前"));
    }
}
