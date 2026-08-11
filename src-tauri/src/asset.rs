//! 图片资源持久化服务（T4，R3）。
//!
//! 唯一 owner：Rust 资源服务。前端把剪贴板/拖拽得到的图片字节以 base64
//! 字符串经 IPC 传入；本模块解码、校验扩展名白名单、生成唯一文件名并
//! 原子落盘：
//!   - 文档已保存（`doc_path` 为 Some）→ 写入 `<文档目录>/assets/`；
//!   - 文档未保存 → 写入应用数据目录下按会话隔离的暂存目录
//!     `staging-assets/<session_id>/`，保存（另存为）时与 Markdown 一起
//!     事务式提交进 `<文档目录>/assets/`。
//!
//! 两种情况下返回给前端的引用都是相对路径 `assets/<name>.<ext>`：暂存期
//! 与迁移后的引用形式一致，迁移只是搬动文件，文档内容无需改写；移动整个
//! 文档目录（文档 + assets/ 一起）引用也不丢失。
//!
//! base64 解码器为本模块自带实现（约 60 行，含完整单测），避免引入新
//! crate；纯逻辑均接受可注入的目录参数以便单元测试，Tauri 命令层负责
//! 解析应用数据目录（与 snapshot.rs 同一约定）。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 文档旁的图片目录名；文档内引用形如 `assets/<name>.<ext>`。
const ASSETS_DIR_NAME: &str = "assets";
/// 应用数据目录下的暂存根目录名（未保存文档的图片先落这里）。
const STAGING_DIR_NAME: &str = "staging-assets";
/// 允许的图片扩展名白名单（小写）。svg 经 `<img>` 渲染，不内联解析。
const ALLOWED_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// 进程内单调计数器：与毫秒时间戳、内容哈希共同保证文件名唯一
///（同一毫秒连发多张图也不冲突）。
static NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// base64 解码（自实现，无新 crate）
// ---------------------------------------------------------------------------

/// 解码标准 base64（含 `+` `/` 与 `=` 填充）。拒绝非法字符、非法填充
/// 位置与非 4 倍数长度；空输入解码为空字节串。
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value_of(b: u8) -> Result<u32, String> {
        match b {
            b'A'..=b'Z' => Ok(u32::from(b - b'A')),
            b'a'..=b'z' => Ok(u32::from(b - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(b - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("非法的 base64 字符: 0x{:02x}", b)),
        }
    }

    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("base64 长度必须是 4 的倍数".to_owned());
    }
    let chunk_count = bytes.len() / 4;
    let mut out = Vec::with_capacity(chunk_count * 3);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let is_last = i == chunk_count - 1;
        let pad = if is_last && chunk[3] == b'=' {
            if chunk[2] == b'=' {
                2
            } else {
                1
            }
        } else {
            0
        };
        for &c in chunk {
            if c == b'=' && !(is_last && pad > 0) {
                return Err("base64 填充只能出现在末尾".to_owned());
            }
        }
        let v0 = value_of(chunk[0])?;
        let v1 = value_of(chunk[1])?;
        let v2 = if pad >= 2 { 0 } else { value_of(chunk[2])? };
        let v3 = if pad >= 1 { 0 } else { value_of(chunk[3])? };
        let triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
        out.push((triple >> 16) as u8);
        if pad < 2 {
            out.push((triple >> 8) as u8);
        }
        if pad < 1 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 纯逻辑（可注入目录，便于测试）
// ---------------------------------------------------------------------------

/// 校验扩展名白名单：小写化、拒绝带点/路径分隔符，必须在白名单内。
fn validate_ext(ext: &str) -> Result<String, String> {
    let lowered = ext.trim().to_lowercase();
    if lowered.is_empty()
        || lowered.contains('.')
        || lowered.contains('/')
        || lowered.contains('\\')
    {
        return Err(format!("非法的图片扩展名: {:?}", ext));
    }
    if !ALLOWED_EXTS.contains(&lowered.as_str()) {
        return Err(format!(
            "不支持的图片格式 .{}（仅支持: {}）",
            lowered,
            ALLOWED_EXTS.join("/")
        ));
    }
    Ok(lowered)
}

/// FNV-1a 64-bit（与 snapshot.rs 同一哈希，跨运行稳定）。
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 文件内容的稳定标识（FNV-1a 64-bit → 16 位 hex）。供标注按内容特征关联
/// （R4：降低文件移动/重命名后标注失联）。与 asset 唯一命名同一哈希。
pub fn content_hash_hex(bytes: &[u8]) -> String {
    format!("{:016x}", fnv64(bytes))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 唯一文件名（不含扩展名）：`img-<毫秒时间戳>-<计数器>-<内容哈希8位>`。
fn unique_asset_name(bytes: &[u8]) -> String {
    let ms = now_ms();
    let counter = NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "img-{:x}-{:x}-{:08x}",
        ms,
        counter,
        fnv64(bytes) & 0xffff_ffff
    )
}

/// 会话 id 消毒：只保留字母数字/`-`/`_`，其余替换为 `_`，杜绝路径穿越。
fn sanitize_session_id(session_id: &str) -> Result<String, String> {
    let cleaned: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        return Err("会话 id 不能为空".to_owned());
    }
    Ok(cleaned)
}

/// 原子写字节版（与 file.rs 的字符串版同一策略：同目录临时文件 +
/// flush/sync + rename；失败时 NamedTempFile 自动清理，不留半截文件）。
/// file.rs 不在本任务 scope，故字节变体放在这里。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的保存路径: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {}: {}", parent.display(), e))?;

    let mut tmp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法创建临时文件: {}", e))?;
    tmp.write_all(bytes)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("同步临时文件失败: {}", e))?;
    tmp.persist(path)
        .map_err(|e| format!("无法保存到 {}: {}", path.display(), e.error))?;
    Ok(())
}

/// 保存图片字节，返回文档内使用的相对引用 `assets/<name>.<ext>`。
///
/// - `doc_dir` 为 Some：写入 `<doc_dir>/assets/`；
/// - 为 None（文档未保存）：写入 `<staging_root>/staging-assets/<session_id>/`，
///   返回同样的相对引用 —— 保存时 `save_document_as_impl` 按原名提交到
///   `<文档目录>/assets/`，引用保持有效。
pub fn save_asset_impl(
    doc_dir: Option<&Path>,
    staging_root: &Path,
    session_id: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let ext = validate_ext(ext)?;
    if bytes.is_empty() {
        return Err("图片内容为空，未保存".to_owned());
    }
    let name = format!("{}.{}", unique_asset_name(bytes), ext);
    let dir = match doc_dir {
        Some(d) => d.join(ASSETS_DIR_NAME),
        None => staging_root
            .join(STAGING_DIR_NAME)
            .join(sanitize_session_id(session_id)?),
    };
    write_bytes_atomic(&dir.join(&name), bytes)?;
    Ok(format!("{}/{}", ASSETS_DIR_NAME, name))
}

fn files_have_same_content(left: &Path, right: &Path) -> Result<bool, String> {
    let left_meta =
        fs::metadata(left).map_err(|e| format!("无法读取资源信息 {}: {}", left.display(), e))?;
    let right_meta =
        fs::metadata(right).map_err(|e| format!("无法读取资源信息 {}: {}", right.display(), e))?;
    if left_meta.len() != right_meta.len() {
        return Ok(false);
    }

    let mut left_file =
        File::open(left).map_err(|e| format!("无法读取资源 {}: {}", left.display(), e))?;
    let mut right_file =
        File::open(right).map_err(|e| format!("无法读取资源 {}: {}", right.display(), e))?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_count = left_file
            .read(&mut left_buffer)
            .map_err(|e| format!("无法读取资源 {}: {}", left.display(), e))?;
        let right_count = right_file
            .read(&mut right_buffer)
            .map_err(|e| format!("无法读取资源 {}: {}", right.display(), e))?;
        if left_count != right_count || left_buffer[..left_count] != right_buffer[..right_count] {
            return Ok(false);
        }
        if left_count == 0 {
            return Ok(true);
        }
    }
}

fn rollback_created_assets(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        let _ = fs::remove_file(path);
    }
}

/// Persist a Save As operation as one logical transaction. Staged assets are
/// prepared and promoted without overwriting existing files before the
/// Markdown document is atomically written. If document persistence fails,
/// every asset created by this transaction is removed and staging is kept.
pub fn save_document_as_impl(
    staging_root: &Path,
    session_id: &str,
    doc_path: &Path,
    content: &str,
) -> Result<Vec<String>, String> {
    let session_id = sanitize_session_id(session_id)?;
    let doc_dir = doc_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的文档路径: {}", doc_path.display()))?;
    let staging = staging_root.join(STAGING_DIR_NAME).join(session_id);

    if !staging.exists() {
        crate::file::write_file_impl(doc_path, content)?;
        return Ok(Vec::new());
    }

    let mut assets = Vec::new();
    for entry in fs::read_dir(&staging)
        .map_err(|e| format!("无法读取暂存目录 {}: {}", staging.display(), e))?
    {
        let entry = entry.map_err(|e| format!("无法读取暂存目录项: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("无法读取暂存文件类型: {}", e))?;
        if file_type.is_file() {
            assets.push((entry.path(), entry.file_name()));
        }
    }
    assets.sort_by(|left, right| left.1.cmp(&right.1));

    let target_dir = doc_dir.join(ASSETS_DIR_NAME);
    if !assets.is_empty() {
        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("无法创建目录 {}: {}", target_dir.display(), e))?;
    }

    // Preflight every collision before creating any target file. Existing
    // identical assets are safe to reuse; different content is never replaced.
    let mut missing = Vec::new();
    let mut persisted = Vec::with_capacity(assets.len());
    for (source, name) in &assets {
        let target = target_dir.join(name);
        let relative = format!("{}/{}", ASSETS_DIR_NAME, name.to_string_lossy());
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() || !files_have_same_content(source, &target)? {
                    return Err(format!("目标资源已存在且内容不同: {}", target.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push((source.clone(), target));
            }
            Err(error) => {
                return Err(format!("无法检查目标资源 {}: {}", target.display(), error));
            }
        }
        persisted.push(relative);
    }

    // Copy all missing assets into synced temporary files first. No visible
    // target is created until every source can be read completely.
    let mut prepared = Vec::with_capacity(missing.len());
    for (source, target) in missing {
        let mut source_file = File::open(&source)
            .map_err(|e| format!("无法读取暂存资源 {}: {}", source.display(), e))?;
        let mut temporary = tempfile::NamedTempFile::new_in(&target_dir)
            .map_err(|e| format!("无法创建资源临时文件: {}", e))?;
        std::io::copy(&mut source_file, &mut temporary)
            .map_err(|e| format!("无法准备资源 {}: {}", target.display(), e))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|e| format!("无法同步资源 {}: {}", target.display(), e))?;
        prepared.push((target, temporary));
    }

    let mut created = Vec::with_capacity(prepared.len());
    for (target, temporary) in prepared {
        match temporary.persist_noclobber(&target) {
            Ok(_) => created.push(target),
            Err(error) => {
                rollback_created_assets(&created);
                return Err(format!(
                    "无法提交资源 {}（目标可能已存在）: {}",
                    target.display(),
                    error.error
                ));
            }
        }
    }

    if let Err(error) = crate::file::write_file_impl(doc_path, content) {
        rollback_created_assets(&created);
        return Err(error);
    }

    // Persistence is already committed. Cleanup is deliberately best-effort:
    // a stale staging copy is recoverable, while reporting failure here would
    // make the frontend believe a successfully written document was not saved.
    for (source, _) in &assets {
        let _ = fs::remove_file(source);
    }
    let _ = fs::remove_dir(&staging);
    persisted.sort();
    Ok(persisted)
}

/// 解析应用数据目录：优先 Tauri app_data_dir，失败回退系统临时目录
/// （与 snapshot.rs 同一约定）。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

/// 解析文档目录：Some(文档路径) → 其父目录；None（未保存）→ None（走暂存）。
fn resolve_doc_dir(doc_path: Option<&str>) -> Result<Option<PathBuf>, String> {
    match doc_path {
        Some(p) => Ok(Some(
            Path::new(p)
                .parent()
                .filter(|d| !d.as_os_str().is_empty())
                .ok_or_else(|| format!("无效的文档路径: {}", p))?
                .to_path_buf(),
        )),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令层
// ---------------------------------------------------------------------------

/// 保存粘贴/拖拽进来的图片。`doc_path` 为 None 时落暂存目录。
/// 成功返回相对引用 `assets/<name>.<ext>`；失败返回错误且不落任何文件，
/// 前端据此决定不插入引用。
#[tauri::command]
pub fn save_asset(
    app: tauri::AppHandle,
    doc_path: Option<String>,
    session_id: String,
    bytes_base64: String,
    ext: String,
) -> Result<String, String> {
    let bytes = decode_base64(&bytes_base64)?;
    let staging_root = resolve_base_dir(&app);
    let doc_dir = resolve_doc_dir(doc_path.as_deref())?;
    save_asset_impl(doc_dir.as_deref(), &staging_root, &session_id, &bytes, &ext)
}

/// 「插入图片」从本地文件导入（纯逻辑）：读取源文件字节，按与粘贴/拖拽
/// 完全相同的规则落盘（文档旁 assets/ 或会话暂存目录），返回相对引用
/// `assets/<name>.<ext>`。扩展名取自源文件名，必须在白名单内。
pub fn import_image_asset_impl(
    doc_dir: Option<&Path>,
    staging_root: &Path,
    session_id: &str,
    source_path: &Path,
) -> Result<String, String> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| format!("无法识别图片扩展名: {}", source_path.display()))?;
    let bytes = fs::read(source_path)
        .map_err(|e| format!("无法读取图片 {}: {}", source_path.display(), e))?;
    save_asset_impl(doc_dir, staging_root, session_id, &bytes, ext)
}

/// 「插入图片」从本地文件导入。`doc_path` 为 None 时落暂存目录（保存时迁移）。
#[tauri::command]
pub fn import_image_asset(
    app: tauri::AppHandle,
    doc_path: Option<String>,
    session_id: String,
    source_path: String,
) -> Result<String, String> {
    let staging_root = resolve_base_dir(&app);
    let doc_dir = resolve_doc_dir(doc_path.as_deref())?;
    import_image_asset_impl(
        doc_dir.as_deref(),
        &staging_root,
        &session_id,
        Path::new(&source_path),
    )
}

/// Atomically persist a Save As request together with any assets staged for
/// the untitled editor session.
#[tauri::command]
pub fn save_document_as(
    app: tauri::AppHandle,
    session_id: String,
    doc_path: String,
    content: String,
) -> Result<Vec<String>, String> {
    save_document_as_impl(
        &resolve_base_dir(&app),
        &session_id,
        Path::new(&doc_path),
        &content,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    // -- base64 --

    #[test]
    fn base64_roundtrip_vectors() {
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(decode_base64("SGVsbG8h").unwrap(), b"Hello!");
        assert_eq!(decode_base64("8J+OrQ==").unwrap(), "🎭".as_bytes());
        // 含 + 与 /
        assert_eq!(decode_base64("+/8=").unwrap(), vec![0xfb, 0xff]);
    }

    #[test]
    fn base64_rejects_invalid() {
        assert!(decode_base64("SGVsbG8").is_err(), "非 4 倍数长度");
        assert!(decode_base64("SGVs bG8=").is_err(), "含空格");
        assert!(decode_base64("S=Vs").is_err(), "填充不在末尾");
        assert!(decode_base64("====").is_err(), "纯填充");
        assert!(decode_base64("SG*sbG8=").is_err(), "非法字符");
    }

    // -- ext 白名单 --

    #[test]
    fn ext_whitelist() {
        for ok in ["png", "PNG", " jpg ", "jpeg", "gif", "webp", "svg"] {
            assert!(validate_ext(ok).is_ok(), "should accept {}", ok);
        }
        for bad in ["exe", "html", ".png", "p/ng", "p\\ng", "", "js"] {
            assert!(validate_ext(bad).is_err(), "should reject {:?}", bad);
        }
    }

    // -- 保存 --

    #[test]
    fn save_to_doc_dir_writes_assets_and_returns_relative_path() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        let rel = save_asset_impl(
            Some(&doc_dir),
            dir.path(),
            "untitled-x",
            b"\x89PNG fake",
            "png",
        )
        .expect("save");
        assert!(rel.starts_with("assets/"), "rel = {}", rel);
        assert!(rel.ends_with(".png"));
        let on_disk = doc_dir.join(&rel);
        assert_eq!(fs::read(&on_disk).unwrap(), b"\x89PNG fake");
    }

    #[test]
    fn save_without_doc_goes_to_session_staging() {
        let dir = temp_dir();
        let rel =
            save_asset_impl(None, dir.path(), "untitled-ab12", b"GIF89a", "gif").expect("save");
        assert!(rel.starts_with("assets/") && rel.ends_with(".gif"));
        let file_name = rel.strip_prefix("assets/").unwrap();
        let staged = dir
            .path()
            .join(STAGING_DIR_NAME)
            .join("untitled-ab12")
            .join(file_name);
        assert_eq!(fs::read(&staged).unwrap(), b"GIF89a");
    }

    #[test]
    fn same_bytes_saved_twice_get_unique_names() {
        let dir = temp_dir();
        let a = save_asset_impl(Some(dir.path()), dir.path(), "s", b"same", "png").unwrap();
        let b = save_asset_impl(Some(dir.path()), dir.path(), "s", b"same", "png").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn failed_save_returns_error_and_leaves_nothing() {
        let dir = temp_dir();
        // 用一个「文件」挡住目录创建，写入必然失败。
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, b"i am a file").unwrap();
        let doc_dir = blocker.join("sub");
        let err = save_asset_impl(Some(&doc_dir), dir.path(), "s", b"data", "png")
            .expect_err("must fail");
        assert!(err.contains("无法创建目录"), "unexpected: {}", err);
        assert!(!doc_dir.join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn rejects_empty_bytes_and_bad_ext_before_writing() {
        let dir = temp_dir();
        assert!(save_asset_impl(Some(dir.path()), dir.path(), "s", b"", "png").is_err());
        assert!(save_asset_impl(Some(dir.path()), dir.path(), "s", b"x", "exe").is_err());
        assert!(!dir.path().join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn session_id_is_sanitized_against_traversal() {
        let dir = temp_dir();
        let rel = save_asset_impl(None, dir.path(), "../evil/../x", b"data", "png").unwrap();
        let file_name = rel.strip_prefix("assets/").unwrap();
        // 消毒后不会逃出 staging 根目录
        let staged_root = dir.path().join(STAGING_DIR_NAME);
        let mut found = false;
        for entry in fs::read_dir(&staged_root).unwrap() {
            let session = entry.unwrap();
            let candidate = session.path().join(file_name);
            if candidate.exists() {
                assert!(candidate.starts_with(&staged_root));
                found = true;
            }
        }
        assert!(
            found,
            "sanitized staging file must exist under staging root"
        );
        assert!(save_asset_impl(None, dir.path(), "", b"data", "png").is_err());
    }

    // -- transactional Save As --

    #[test]
    fn save_document_as_commits_document_and_assets_then_cleans_staging() {
        let dir = temp_dir();
        let session = "untitled-transaction";
        let rel_a = save_asset_impl(None, dir.path(), session, b"asset-a", "png").unwrap();
        let rel_b = save_asset_impl(None, dir.path(), session, b"asset-b", "webp").unwrap();
        let doc_path = dir.path().join("docs").join("note.md");

        let persisted = save_document_as_impl(dir.path(), session, &doc_path, "![a](assets/a.png)")
            .expect("transaction succeeds");

        assert_eq!(fs::read_to_string(&doc_path).unwrap(), "![a](assets/a.png)");
        assert_eq!(persisted, {
            let mut expected = vec![rel_a.clone(), rel_b.clone()];
            expected.sort();
            expected
        });
        assert_eq!(
            fs::read(doc_path.parent().unwrap().join(rel_a)).unwrap(),
            b"asset-a"
        );
        assert_eq!(
            fs::read(doc_path.parent().unwrap().join(rel_b)).unwrap(),
            b"asset-b"
        );
        assert!(!dir.path().join(STAGING_DIR_NAME).join(session).exists());
    }

    #[test]
    fn save_document_as_reuses_identical_targets_without_overwriting() {
        let dir = temp_dir();
        let session = "untitled-reuse";
        let rel = save_asset_impl(None, dir.path(), session, b"same", "png").unwrap();
        let doc_path = dir.path().join("docs").join("note.md");
        let target = doc_path.parent().unwrap().join(&rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"same").unwrap();

        save_document_as_impl(dir.path(), session, &doc_path, "body").expect("reuse");

        assert_eq!(fs::read(&target).unwrap(), b"same");
        assert_eq!(fs::read_to_string(&doc_path).unwrap(), "body");
        assert!(!dir.path().join(STAGING_DIR_NAME).join(session).exists());
    }

    #[test]
    fn save_document_as_rejects_different_target_content_before_writing() {
        let dir = temp_dir();
        let session = "untitled-conflict";
        let rel = save_asset_impl(None, dir.path(), session, b"staged", "png").unwrap();
        let doc_path = dir.path().join("docs").join("note.md");
        let target = doc_path.parent().unwrap().join(&rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"existing").unwrap();

        let error = save_document_as_impl(dir.path(), session, &doc_path, "body")
            .expect_err("conflict must fail");

        assert!(error.contains("内容不同"), "unexpected error: {}", error);
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        assert!(!doc_path.exists());
        assert!(dir.path().join(STAGING_DIR_NAME).join(session).exists());
    }

    #[test]
    fn save_document_as_rolls_back_new_assets_when_document_write_fails() {
        let dir = temp_dir();
        let session = "untitled-rollback";
        let rel = save_asset_impl(None, dir.path(), session, b"asset", "png").unwrap();
        let doc_path = dir.path().join("docs").join("note.md");
        fs::create_dir_all(&doc_path).unwrap();

        save_document_as_impl(dir.path(), session, &doc_path, "body")
            .expect_err("document write must fail");

        assert!(!doc_path.parent().unwrap().join(&rel).exists());
        let staged_name = rel.strip_prefix("assets/").unwrap();
        assert_eq!(
            fs::read(
                dir.path()
                    .join(STAGING_DIR_NAME)
                    .join(session)
                    .join(staged_name)
            )
            .unwrap(),
            b"asset"
        );
    }

    #[test]
    fn save_document_as_without_staging_still_writes_document() {
        let dir = temp_dir();
        let doc_path = dir.path().join("docs").join("plain.md");
        let persisted = save_document_as_impl(dir.path(), "untitled-empty", &doc_path, "plain")
            .expect("save document");
        assert!(persisted.is_empty());
        assert_eq!(fs::read_to_string(doc_path).unwrap(), "plain");
    }

    // -- 本地文件导入（插入图片） --

    #[test]
    fn import_reads_source_file_and_saves_to_doc_assets() {
        let dir = temp_dir();
        let source = dir.path().join("照片.JPG");
        fs::write(&source, b"\xff\xd8jpeg-bytes").unwrap();
        let doc_dir = dir.path().join("docs");
        let rel =
            import_image_asset_impl(Some(&doc_dir), dir.path(), "s", &source).expect("import");
        // 扩展名小写化（JPG → jpg），内容一致。
        assert!(
            rel.starts_with("assets/") && rel.ends_with(".jpg"),
            "rel = {}",
            rel
        );
        assert_eq!(fs::read(doc_dir.join(&rel)).unwrap(), b"\xff\xd8jpeg-bytes");
    }

    #[test]
    fn import_without_doc_goes_to_session_staging() {
        let dir = temp_dir();
        let source = dir.path().join("p.webp");
        fs::write(&source, b"RIFFwebp").unwrap();
        let rel = import_image_asset_impl(None, dir.path(), "untitled-z", &source).expect("import");
        let name = rel.strip_prefix("assets/").unwrap();
        let staged = dir
            .path()
            .join(STAGING_DIR_NAME)
            .join("untitled-z")
            .join(name);
        assert_eq!(fs::read(staged).unwrap(), b"RIFFwebp");
    }

    #[test]
    fn import_rejects_bad_ext_missing_file_and_empty_content() {
        let dir = temp_dir();
        let exe = dir.path().join("virus.exe");
        fs::write(&exe, b"MZ").unwrap();
        assert!(import_image_asset_impl(Some(dir.path()), dir.path(), "s", &exe).is_err());
        let missing = dir.path().join("gone.png");
        assert!(import_image_asset_impl(Some(dir.path()), dir.path(), "s", &missing).is_err());
        let empty = dir.path().join("empty.png");
        fs::write(&empty, b"").unwrap();
        assert!(import_image_asset_impl(Some(dir.path()), dir.path(), "s", &empty).is_err());
        assert!(!dir.path().join(ASSETS_DIR_NAME).exists());
    }
}
