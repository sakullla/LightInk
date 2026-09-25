//! Content-addressed storage for books managed by LightInk.

use crate::file::MAX_READER_FILE_BYTES;
use crate::library::{self, LibraryItem};
use crate::remote::RemoteError;
use crate::sync;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

const MANAGED_DIRECTORY: &str = "library-content";
const HASH_DIRECTORY: &str = "sha256";
/// Heap buffer: a 1 MiB stack array overflows the default Windows thread stack.
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationEntry {
    pub item_id: String,
    pub title: String,
    pub path: String,
    pub status: String,
    pub size: Option<u64>,
    pub blob_hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationPreview {
    pub entries: Vec<ManagedMigrationEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemAlias {
    pub alias_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationResult {
    pub migrated: usize,
    pub duplicates: usize,
    pub failed: Vec<ManagedMigrationEntry>,
    pub aliases: Vec<LibraryItemAlias>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedItemLocation {
    pub item_id: String,
    pub path: String,
    pub availability: String,
}

#[derive(Debug)]
struct StoredBlob {
    hash: String,
    absolute_path: PathBuf,
    size: u64,
    duplicate: bool,
    /// Whether this call created a new file that must be removed if the
    /// surrounding metadata transaction rolls back.
    created_file: bool,
}

fn extension_for(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    if !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        extension
    } else {
        "bin".to_string()
    }
}

fn is_comic_archive_path(path: &Path) -> bool {
    matches!(extension_for(path).as_str(), "cbz" | "cbr" | "cb7")
}

fn local_reference_id(path: &Path) -> String {
    format!("local:{}", path.to_string_lossy())
}

fn insert_local_reference_item(connection: &Connection, source: &Path) -> Result<String, String> {
    if !source.is_file() {
        return Err(format!("无法读取待入库书籍 {}", source.display()));
    }
    let size = source
        .metadata()
        .map_err(|error| format!("无法读取书籍信息 {}: {error}", source.display()))?
        .len();
    if size > MAX_READER_FILE_BYTES {
        return Err(format!("FILE_TOO_LARGE:{size}:{}", MAX_READER_FILE_BYTES));
    }
    let id = local_reference_id(source);
    let title = display_name(source);
    let extension = extension_for(source);
    let now = library::now_ms();
    let path = source.to_string_lossy().into_owned();
    connection
        .execute(
            "INSERT INTO library_items(
               id, source_kind, title, authors_json, local_path, extension, size,
               availability, offline_pinned, subjects_json, updated_at
             ) VALUES (?1,'local',?2,'[]',?3,?4,?5,'local',0,'[]',?6)
             ON CONFLICT(id) DO UPDATE SET local_path=?3, size=?5, extension=?4,
               availability='local', updated_at=?6",
            params![id, title, path, extension, size as i64, now],
        )
        .map_err(|error| format!("无法保存本地书籍条目: {error}"))?;
    sync::write_library_item_record_at(connection, &id, true)?;
    Ok(id)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("无法读取待托管书籍 {}: {error}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|error| format!("无法读取书籍信息 {}: {error}", path.display()))?
        .len();
    if size > MAX_READER_FILE_BYTES {
        return Err(format!("FILE_TOO_LARGE:{size}:{}", MAX_READER_FILE_BYTES));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取待托管书籍 {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn verify_blob_file(path: &Path, expected_hash: &str, expected_size: u64) -> Result<(), String> {
    let (actual_hash, actual_size) = hash_file(path)?;
    if actual_hash != expected_hash || actual_size != expected_size {
        return Err(format!(
            "受管正文校验失败: {} (expected {expected_hash}/{expected_size}, got {actual_hash}/{actual_size})",
            path.display()
        ));
    }
    Ok(())
}

fn managed_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MANAGED_DIRECTORY)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_managed_path(app_data_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("受管内容路径越出应用数据目录".to_string());
    }
    let root = managed_root(app_data_dir);
    let target = app_data_dir.join(relative);
    if !target.starts_with(&root) {
        return Err("受管内容路径不属于书库目录".to_string());
    }
    Ok(target)
}

pub(crate) fn managed_blob_path(
    connection: &Connection,
    app_data_dir: &Path,
    hash: &str,
) -> Result<PathBuf, String> {
    if !is_sha256(hash) {
        return Err("受管正文哈希无效".to_string());
    }
    let relative = connection
        .query_row(
            "SELECT relative_path FROM managed_blobs WHERE hash=?1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取受管正文路径: {error}"))?
        .unwrap_or_else(|| {
            format!(
                "{MANAGED_DIRECTORY}/{HASH_DIRECTORY}/{}/{}.bin",
                &hash[..2],
                hash
            )
        });
    safe_managed_path(app_data_dir, &relative)
}

/// Resolve a content blob path before its first local registration.  The
/// extension is part of the runtime reader contract, so a freshly downloaded
/// EPUB/CBZ/PDF must not fall back to an extension-less `.bin` path.
pub(crate) fn managed_blob_path_for_extension(
    connection: &Connection,
    app_data_dir: &Path,
    hash: &str,
    extension: Option<&str>,
) -> Result<PathBuf, String> {
    if !is_sha256(hash) {
        return Err("受管正文哈希无效".to_string());
    }
    if let Some(relative) = connection
        .query_row(
            "SELECT relative_path FROM managed_blobs WHERE hash=?1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取受管正文路径: {error}"))?
    {
        return safe_managed_path(app_data_dir, &relative);
    }
    let extension = extension
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 16
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_ascii_lowercase();
    safe_managed_path(
        app_data_dir,
        &format!(
            "{MANAGED_DIRECTORY}/{HASH_DIRECTORY}/{}/{}.{}",
            &hash[..2],
            hash,
            extension
        ),
    )
}

pub(crate) fn register_downloaded_blob_at(
    connection: &Connection,
    app_data_dir: &Path,
    hash: &str,
    path: &Path,
    size: u64,
) -> Result<PathBuf, String> {
    if !is_sha256(hash) || !path.is_file() {
        return Err("下载正文不存在或哈希无效".to_string());
    }
    verify_blob_file(path, hash, size)?;
    let relative = path
        .strip_prefix(app_data_dir)
        .map_err(|_| "受管正文路径不在应用目录内".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let safe_path = safe_managed_path(app_data_dir, &relative)?;
    connection
        .execute(
            "INSERT INTO managed_blobs(hash,relative_path,size,created_at,last_verified_at)
             VALUES (?1,?2,?3,?4,?4)
             ON CONFLICT(hash) DO UPDATE SET size=?3,last_verified_at=?4",
            params![hash, relative, size as i64, library::now_ms()],
        )
        .map_err(|error| format!("无法登记下载正文: {error}"))?;
    Ok(safe_path)
}

fn store_blob_at(
    connection: &Connection,
    app_data_dir: &Path,
    source: &Path,
) -> Result<StoredBlob, String> {
    let size = source
        .metadata()
        .map_err(|error| format!("无法读取书籍信息 {}: {error}", source.display()))?
        .len();
    if size > MAX_READER_FILE_BYTES {
        return Err(format!("FILE_TOO_LARGE:{size}:{}", MAX_READER_FILE_BYTES));
    }
    let root = managed_root(app_data_dir);
    let staging = root.join("staging");
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建受管书库目录: {error}"))?;
    let mut input = File::open(source)
        .map_err(|error| format!("无法读取待托管书籍 {}: {error}", source.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&staging)
        .map_err(|error| format!("无法创建书籍临时文件: {error}"))?;
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("无法读取待托管书籍 {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > MAX_READER_FILE_BYTES {
            return Err(format!("FILE_TOO_LARGE:{copied}:{}", MAX_READER_FILE_BYTES));
        }
        hasher.update(&buffer[..read]);
        temporary
            .write_all(&buffer[..read])
            .map_err(|error| format!("无法写入书籍临时文件: {error}"))?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步书籍临时文件: {error}"))?;
    let hash = format!("{:x}", hasher.finalize());
    let known_path = connection
        .query_row(
            "SELECT relative_path FROM managed_blobs WHERE hash=?1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法查询受管书籍: {error}"))?;
    let relative_path = known_path.clone().unwrap_or_else(|| {
        let extension = extension_for(source);
        format!(
            "{MANAGED_DIRECTORY}/{HASH_DIRECTORY}/{}/{}.{}",
            &hash[..2],
            hash,
            extension
        )
    });
    let absolute_path = safe_managed_path(app_data_dir, &relative_path)?;
    let already_present = absolute_path.is_file();
    if already_present {
        // A database row is not enough to trust a blob: interrupted copies or
        // manual edits must never be silently reused on another import.
        verify_blob_file(&absolute_path, &hash, copied)?;
    }
    let mut duplicate = already_present;
    let created_file = if !already_present {
        let parent = absolute_path
            .parent()
            .ok_or_else(|| "受管书籍目标路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建受管书籍目录: {error}"))?;
        match temporary.persist_noclobber(&absolute_path) {
            Ok(_) => true,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify_blob_file(&absolute_path, &hash, copied)?;
                duplicate = true;
                false
            }
            Err(error) => return Err(format!("无法提交受管书籍: {}", error.error)),
        }
    } else {
        false
    };
    let now = library::now_ms();
    if let Err(error) = connection.execute(
        "INSERT INTO managed_blobs(hash, relative_path, size, created_at, last_verified_at)
             VALUES (?1,?2,?3,?4,?4)
             ON CONFLICT(hash) DO UPDATE SET last_verified_at=?4",
        params![hash, relative_path, copied as i64, now],
    ) {
        if created_file {
            let _ = fs::remove_file(&absolute_path);
        }
        return Err(format!("无法记录受管书籍: {error}"));
    }
    Ok(StoredBlob {
        hash,
        absolute_path,
        size: copied,
        duplicate,
        created_file,
    })
}

fn insert_managed_item(
    connection: &Connection,
    source: &Path,
    blob: &StoredBlob,
) -> Result<(), String> {
    let id = format!("managed:{}", blob.hash);
    let title = display_name(source);
    let extension = extension_for(source);
    let now = library::now_ms();
    connection
        .execute(
            "INSERT INTO library_items(
               id, source_kind, title, authors_json, local_path, extension, size,
               blob_hash, availability, offline_pinned, subjects_json, updated_at
             ) VALUES (?1,'managed',?2,'[]',?3,?4,?5,?6,'local',0,'[]',?7)
             ON CONFLICT(id) DO UPDATE SET local_path=?3, size=?5,
               availability='local', updated_at=?7",
            params![
                id,
                title,
                blob.absolute_path.to_string_lossy().into_owned(),
                extension,
                blob.size as i64,
                blob.hash,
                now,
            ],
        )
        .map_err(|error| format!("无法保存受管书籍条目: {error}"))?;
    sync::write_library_item_record_at(connection, &id, true)?;
    Ok(())
}

fn migrate_item_at(
    connection: &mut Connection,
    app_data_dir: &Path,
    item_id: &str,
) -> Result<(LibraryItemAlias, bool), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启书籍迁移事务: {error}"))?;
    let source_path: String = transaction
        .query_row(
            "SELECT local_path FROM library_items
             WHERE id=?1 AND source_kind='local' AND blob_hash IS NULL",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取待迁移书籍 {item_id}: {error}"))?;
    let source = PathBuf::from(source_path);
    if is_comic_archive_path(&source) {
        return Err("漫画档案按本地引用保存，无需复制到受管库".to_string());
    }
    let blob = store_blob_at(&transaction, app_data_dir, &source)?;
    let cleanup_path = blob.absolute_path.clone();
    let cleanup_blob = blob.created_file;
    let result = (|| -> Result<(LibraryItemAlias, bool), String> {
        let target_id = format!("managed:{}", blob.hash);
        transaction
            .execute(
                "INSERT INTO library_items(
                   id, source_id, source_kind, title, authors_json, cover_url, local_path,
                   acquisition_url, media_type, extension, size, etag, last_modified,
                   series, number, volume, page_count, reading_direction, cover_page,
                   blob_hash, availability, offline_pinned, subjects_json, updated_at
                 ) SELECT ?2, source_id, 'managed', title, authors_json, cover_url, ?3,
                   acquisition_url, media_type, extension, ?4, etag, last_modified,
                   series, number, volume, page_count, reading_direction, cover_page,
                   ?5, 'local', offline_pinned, subjects_json, ?6
                 FROM library_items WHERE id=?1
                 ON CONFLICT(id) DO UPDATE SET source_kind='managed', local_path=?3, size=?4,
                   blob_hash=?5, availability='local', updated_at=?6",
                params![
                    item_id,
                    target_id,
                    blob.absolute_path.to_string_lossy().into_owned(),
                    blob.size as i64,
                    blob.hash.clone(),
                    library::now_ms(),
                ],
            )
            .map_err(|error| format!("无法迁移书籍元数据: {error}"))?;
        if item_id != target_id {
            let group_ids = transaction
                .prepare(
                    "SELECT group_id FROM library_group_members WHERE item_id=?1 ORDER BY group_id",
                )
                .and_then(|mut statement| {
                    let rows =
                        statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
                    rows.collect::<Result<Vec<_>, _>>()
                })
                .map_err(|error| format!("无法读取待迁移书籍分组引用: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO library_group_members(group_id, item_id, created_at)
                     SELECT group_id, ?2, created_at
                     FROM library_group_members WHERE item_id=?1
                     ON CONFLICT(group_id, item_id) DO NOTHING",
                    params![item_id, target_id],
                )
                .map_err(|error| format!("无法迁移书籍分组引用: {error}"))?;
            for group_id in group_ids {
                sync::write_membership_record_at(&transaction, &group_id, item_id, false)?;
                sync::write_membership_record_at(&transaction, &group_id, &target_id, true)?;
            }
            let tag_ids = transaction
                .prepare("SELECT tag_id FROM library_tag_members WHERE item_id=?1 ORDER BY tag_id")
                .and_then(|mut statement| {
                    let rows =
                        statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
                    rows.collect::<Result<Vec<_>, _>>()
                })
                .map_err(|error| format!("无法读取待迁移书籍标签引用: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO library_tag_members(tag_id, item_id, created_at)
                     SELECT tag_id, ?2, created_at
                     FROM library_tag_members WHERE item_id=?1
                     ON CONFLICT DO NOTHING",
                    params![item_id, target_id],
                )
                .map_err(|error| format!("无法迁移书籍标签引用: {error}"))?;
            for tag_id in tag_ids {
                sync::write_tag_membership_record_at(&transaction, &tag_id, item_id, false)?;
                sync::write_tag_membership_record_at(&transaction, &tag_id, &target_id, true)?;
            }
            sync::write_library_item_record_at(&transaction, item_id, false)?;
            sync::write_library_item_record_at(&transaction, &target_id, true)?;
            transaction
                .execute(
                    "INSERT INTO acquisition_links(item_id, href, rel, media_type, extension, size)
                     SELECT ?2, href, rel, media_type, extension, size
                     FROM acquisition_links WHERE item_id=?1
                     ON CONFLICT(item_id, href) DO NOTHING",
                    params![item_id, target_id],
                )
                .map_err(|error| format!("无法迁移书籍获取链接: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO library_item_aliases(alias_id, item_id) VALUES (?1,?2)
                     ON CONFLICT(alias_id) DO UPDATE SET item_id=?2",
                    params![item_id, target_id],
                )
                .map_err(|error| format!("无法记录书籍旧标识: {error}"))?;
            transaction
                .execute("DELETE FROM library_items WHERE id=?1", params![item_id])
                .map_err(|error| format!("无法移除旧书籍条目: {error}"))?;
        }
        Ok((
            LibraryItemAlias {
                alias_id: item_id.to_string(),
                item_id: target_id,
            },
            blob.duplicate,
        ))
    })();
    match result {
        Ok(value) => transaction.commit().map(|_| value).map_err(|error| {
            if cleanup_blob {
                let _ = fs::remove_file(&cleanup_path);
            }
            format!("无法提交书籍迁移: {error}")
        }),
        Err(error) => {
            // Dropping the transaction rolls back the metadata and blob index;
            // remove a newly materialized file as well so a failed migration
            // leaves no orphaned managed content.
            drop(transaction);
            if cleanup_blob {
                let _ = fs::remove_file(cleanup_path);
            }
            Err(error)
        }
    }
}

fn preview_at(connection: &Connection) -> Result<ManagedMigrationPreview, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, local_path FROM library_items
             WHERE source_kind='local' AND blob_hash IS NULL AND local_path IS NOT NULL
             ORDER BY title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取待迁移书籍: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("无法读取待迁移书籍: {error}"))?;
    let known = connection
        .prepare("SELECT hash FROM managed_blobs")
        .and_then(|mut query| {
            let rows = query.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.flatten().collect::<HashSet<_>>())
        })
        .unwrap_or_default();
    let mut seen = known;
    let mut entries = Vec::new();
    for row in rows {
        let (item_id, title, raw_path) =
            row.map_err(|error| format!("无法解析待迁移书籍: {error}"))?;
        let path = PathBuf::from(&raw_path);
        if is_comic_archive_path(&path) {
            continue;
        }
        let mut entry = ManagedMigrationEntry {
            item_id,
            title,
            path: raw_path,
            status: "ready".to_string(),
            size: None,
            blob_hash: None,
            error: None,
        };
        match hash_file(&path) {
            Ok((hash, size)) => {
                entry.size = Some(size);
                entry.status = if seen.insert(hash.clone()) {
                    "ready".to_string()
                } else {
                    "duplicate".to_string()
                };
                entry.blob_hash = Some(hash);
            }
            Err(error) => {
                entry.status = if !path.exists() {
                    "missing".to_string()
                } else if error.starts_with("FILE_TOO_LARGE:") {
                    "tooLarge".to_string()
                } else {
                    "unreadable".to_string()
                };
                entry.error = Some(error);
            }
        }
        entries.push(entry);
    }
    Ok(ManagedMigrationPreview { entries })
}

pub(crate) fn import_managed_book_at(
    connection: &mut Connection,
    app_data_dir: &Path,
    source: &Path,
) -> Result<String, String> {
    if is_comic_archive_path(source) {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开启本地书籍事务: {error}"))?;
        let id = insert_local_reference_item(&transaction, source)?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交本地书籍: {error}"))?;
        return Ok(id);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启受管书籍事务: {error}"))?;
    let blob = store_blob_at(&transaction, app_data_dir, source)?;
    let cleanup_path = blob.absolute_path.clone();
    let cleanup_file = blob.created_file;
    let result = (|| -> Result<String, String> {
        insert_managed_item(&transaction, source, &blob)?;
        Ok(format!("managed:{}", blob.hash))
    })();
    match result {
        Ok(item_id) => transaction.commit().map(|_| item_id).map_err(|error| {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            format!("无法提交受管书籍: {error}")
        }),
        Err(error) => {
            drop(transaction);
            if cleanup_file {
                let _ = fs::remove_file(cleanup_path);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn library_import_managed_book(app: AppHandle, path: String) -> Result<LibraryItem, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let mut connection = library::open_database_at(&app_data_dir)?;
    let source = PathBuf::from(path);
    let id = import_managed_book_at(&mut connection, &app_data_dir, &source)?;
    library::library_list_items(app, None)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "受管书籍写入后无法读取".to_string())
}

#[tauri::command]
pub fn library_preview_managed_migration(
    app: AppHandle,
) -> Result<ManagedMigrationPreview, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    preview_at(&connection)
}

#[tauri::command]
pub fn library_apply_managed_migration(
    app: AppHandle,
    item_ids: Vec<String>,
) -> Result<ManagedMigrationResult, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let mut connection = library::open_database_at(&app_data_dir)?;
    let mut result = ManagedMigrationResult {
        migrated: 0,
        duplicates: 0,
        failed: Vec::new(),
        aliases: Vec::new(),
    };
    for item_id in item_ids {
        match migrate_item_at(&mut connection, &app_data_dir, &item_id) {
            Ok((alias, duplicate)) => {
                result.migrated += 1;
                result.duplicates += usize::from(duplicate);
                result.aliases.push(alias);
            }
            Err(error) => result.failed.push(ManagedMigrationEntry {
                item_id,
                title: String::new(),
                path: String::new(),
                status: "failed".to_string(),
                size: None,
                blob_hash: None,
                error: Some(error),
            }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn library_materialize_item(
    app: AppHandle,
    item_id: String,
) -> Result<ManagedItemLocation, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data_dir)?;
    let resolved_id = connection
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析书籍标识: {error}"))?
        .unwrap_or_else(|| item_id.clone());
    let record = connection
        .query_row(
            "SELECT i.local_path, i.availability, b.relative_path
             FROM library_items i
             LEFT JOIN managed_blobs b ON b.hash=i.blob_hash
             WHERE i.id=?1",
            params![resolved_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("无法读取书籍位置: {error}"))?
        .ok_or_else(|| "书籍不在书库中".to_string())?;
    let path = if let Some(relative_path) = record.2 {
        safe_managed_path(&app_data_dir, &relative_path)?
    } else if let Some(local_path) = record.0 {
        PathBuf::from(local_path)
    } else {
        return Err("书籍正文尚未下载".to_string());
    };
    if !path.is_file() {
        connection
            .execute(
                "UPDATE library_items SET availability='missing' WHERE id=?1",
                params![resolved_id],
            )
            .map_err(|error| format!("无法更新书籍可用状态: {error}"))?;
        return Err("书籍正文不可用，请重新定位或下载".to_string());
    }
    Ok(ManagedItemLocation {
        item_id: resolved_id,
        path: path.to_string_lossy().into_owned(),
        availability: record.1,
    })
}

// ── R8 下载管线（作业/章节状态 + 合成入库） ──────────────────────────
//
// 前端编排「搜索 → 聚合去重 → 选源 → 章节断点下载 → 合成」；本模块只提供窄
// 命令：创建作业、按章抓取（写 `book_download_chapters` 状态）、读作业状态、
// 合成入库与删除作业。章节正文落盘 `app_data_dir/book-downloads/<job>/<n>.txt`，
// 状态持久化支撑断点续传（只补缺失章节）与单章重试；合成复用受管链
// `store_blob_at`（SHA-256 去重），失败时不落库、不留半成品。

const DOWNLOAD_DIRECTORY: &str = "book-downloads";
const MAX_DOWNLOAD_CHAPTERS: usize = 2000;
const MAX_DOWNLOAD_TITLE_CHARS: usize = 200;
const MAX_DOWNLOAD_URL_CHARS: usize = 2048;
const DOWNLOAD_FORMATS: &[&str] = &["txt", "epub"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDownloadChapterInput {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDownloadJobInput {
    pub source_id: String,
    pub title: String,
    pub author: Option<String>,
    pub book_url: String,
    pub output_format: String,
    pub chapters: Vec<BookDownloadChapterInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookDownloadChapterState {
    pub index_no: i64,
    pub title: String,
    pub url: String,
    pub status: String,
    pub bytes: Option<i64>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookDownloadJob {
    pub id: String,
    pub source_id: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub book_url: String,
    pub output_format: String,
    pub status: String,
    pub total_chapters: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub chapters: Vec<BookDownloadChapterState>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookDownloadFinalizeResult {
    pub item_id: String,
    pub duplicate: bool,
}

fn download_storage(message: impl std::fmt::Display) -> RemoteError {
    RemoteError::new("BOOK_DOWNLOAD_STORAGE_ERROR", message.to_string())
}

fn download_invalid(message: impl std::fmt::Display) -> RemoteError {
    RemoteError::new("BOOK_DOWNLOAD_INVALID", message.to_string())
}

fn download_not_found() -> RemoteError {
    RemoteError::new("BOOK_DOWNLOAD_NOT_FOUND", "下载作业不存在")
}

fn valid_download_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn chapter_relative_path(job_id: &str, index_no: i64) -> String {
    format!("{DOWNLOAD_DIRECTORY}/{job_id}/{index_no:06}.txt")
}

fn safe_download_path(app_data_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("下载章节路径越出应用数据目录".to_string());
    }
    let root = app_data_dir.join(DOWNLOAD_DIRECTORY);
    let target = app_data_dir.join(relative_path);
    if !target.starts_with(&root) {
        return Err("下载章节路径不属于下载目录".to_string());
    }
    Ok(target)
}

fn validate_download_input(input: &BookDownloadJobInput) -> Result<(String, String), RemoteError> {
    let title = input.title.trim();
    let title_chars = title.chars().count();
    if title_chars == 0 || title_chars > MAX_DOWNLOAD_TITLE_CHARS {
        return Err(download_invalid(format!(
            "书名长度必须为 1 至 {MAX_DOWNLOAD_TITLE_CHARS} 个字符"
        )));
    }
    if !valid_download_id(&input.source_id) {
        return Err(download_invalid("书源标识无效"));
    }
    let book_url = input.book_url.trim();
    if book_url.is_empty() || book_url.len() > MAX_DOWNLOAD_URL_CHARS {
        return Err(download_invalid("书籍地址无效"));
    }
    if !DOWNLOAD_FORMATS.contains(&input.output_format.as_str()) {
        return Err(download_invalid(format!(
            "输出格式仅支持 {}",
            DOWNLOAD_FORMATS.join("/")
        )));
    }
    if input.chapters.is_empty() || input.chapters.len() > MAX_DOWNLOAD_CHAPTERS {
        return Err(download_invalid(format!(
            "章节数量必须为 1 至 {MAX_DOWNLOAD_CHAPTERS}"
        )));
    }
    for chapter in &input.chapters {
        if chapter.title.trim().is_empty()
            || chapter.url.trim().is_empty()
            || chapter.url.len() > MAX_DOWNLOAD_URL_CHARS
        {
            return Err(download_invalid("章节标题或地址无效"));
        }
    }
    Ok((title.to_string(), book_url.to_string()))
}

fn create_download_job_at(
    connection: &Connection,
    input: &BookDownloadJobInput,
) -> Result<BookDownloadJob, RemoteError> {
    let (title, book_url) = validate_download_input(input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = library::now_ms();
    let author = input
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    connection
        .execute(
            "INSERT INTO book_download_jobs(
               id, source_id, title, author, book_url, output_format, status,
               total_chapters, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,'downloading',?7,?8,?8)",
            params![
                id,
                input.source_id,
                title,
                author,
                book_url,
                input.output_format,
                input.chapters.len() as i64,
                now
            ],
        )
        .map_err(|error| download_storage(format!("无法创建下载作业: {error}")))?;
    let mut statement = connection
        .prepare(
            "INSERT INTO book_download_chapters(
               job_id, index_no, title, url, status, updated_at
             ) VALUES (?1,?2,?3,?4,'pending',?5)",
        )
        .map_err(|error| download_storage(format!("无法创建下载章节: {error}")))?;
    for (index, chapter) in input.chapters.iter().enumerate() {
        statement
            .execute(params![
                id,
                index as i64,
                chapter.title.trim(),
                chapter.url.trim(),
                now
            ])
            .map_err(|error| download_storage(format!("无法创建下载章节: {error}")))?;
    }
    Ok(BookDownloadJob {
        id,
        source_id: Some(input.source_id.clone()),
        title,
        author,
        book_url,
        output_format: input.output_format.clone(),
        status: "downloading".to_string(),
        total_chapters: input.chapters.len() as i64,
        created_at: now,
        updated_at: now,
        chapters: input
            .chapters
            .iter()
            .enumerate()
            .map(|(index, chapter)| BookDownloadChapterState {
                index_no: index as i64,
                title: chapter.title.trim().to_string(),
                url: chapter.url.trim().to_string(),
                status: "pending".to_string(),
                bytes: None,
                error: None,
                content: None,
            })
            .collect(),
    })
}

type ChapterRow = (
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);

fn read_chapter_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChapterRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

const CHAPTER_COLUMNS: &str =
    "index_no,title,url,status,content_path,bytes,error FROM book_download_chapters";

fn read_chapters_at(
    connection: &Connection,
    job_id: &str,
) -> Result<Vec<BookDownloadChapterState>, String> {
    let sql = format!("SELECT {CHAPTER_COLUMNS} WHERE job_id=?1 ORDER BY index_no",);
    let rows: Vec<_> = connection
        .prepare(&sql)
        .and_then(|mut statement| {
            statement
                .query_map(params![job_id], read_chapter_row)?
                .collect()
        })
        .map_err(|error| format!("无法读取下载章节: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| BookDownloadChapterState {
            index_no: row.0,
            title: row.1,
            url: row.2,
            status: row.3,
            bytes: row.5,
            error: row.6,
            content: None,
        })
        .collect())
}

/// 读取作业并核对已完成章节的落盘文件：文件缺失的章节回退为 pending，
/// 断点续传因此只补真正缺失的章节。`include_content` 时附带正文文本
/// （前端 EPUB 合成在断点续传时需要已完成章节的内容）。
fn load_download_job_at(
    connection: &Connection,
    app_data_dir: &Path,
    job_id: &str,
    include_content: bool,
) -> Result<BookDownloadJob, String> {
    let (source_id, title, author, book_url, output_format, stored_status, total, created, updated) =
        connection
            .query_row(
                "SELECT source_id,title,author,book_url,output_format,status,total_chapters,
                        created_at,updated_at
                 FROM book_download_jobs WHERE id=?1",
                params![job_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("无法读取下载作业: {error}"))?
            .ok_or_else(|| "下载作业不存在".to_string())?;
    let mut chapters = read_chapters_at(connection, job_id)?;
    for chapter in &mut chapters {
        if chapter.status != "done" {
            continue;
        }
        let Some(content_path) = chapter_stored_content_path(connection, job_id, chapter.index_no)?
        else {
            continue;
        };
        let path = safe_download_path(app_data_dir, &content_path)?;
        if !path.is_file() {
            // 文件已丢失：状态回退 pending，续传时重抓该章。
            connection
                .execute(
                    "UPDATE book_download_chapters
                     SET status='pending', content_path=NULL, bytes=NULL, error=NULL, updated_at=?2
                     WHERE job_id=?1 AND index_no=?3",
                    params![job_id, library::now_ms(), chapter.index_no],
                )
                .map_err(|error| format!("无法重置丢失章节状态: {error}"))?;
            chapter.status = "pending".to_string();
            chapter.bytes = None;
            chapter.error = None;
            continue;
        }
        if include_content {
            let bytes = fs::read(&path)
                .map_err(|error| format!("无法读取下载章节 {}: {error}", path.display()))?;
            chapter.content = Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    let status = if stored_status == "done" {
        stored_status
    } else if !chapters.is_empty() && chapters.iter().all(|chapter| chapter.status == "done") {
        "ready".to_string()
    } else {
        "downloading".to_string()
    };
    Ok(BookDownloadJob {
        id: job_id.to_string(),
        source_id,
        title,
        author,
        book_url,
        output_format,
        status,
        total_chapters: total,
        created_at: created,
        updated_at: updated,
        chapters,
    })
}

fn chapter_stored_content_path(
    connection: &Connection,
    job_id: &str,
    index_no: i64,
) -> Result<Option<String>, String> {
    connection
        .prepare("SELECT content_path FROM book_download_chapters WHERE job_id=?1 AND index_no=?2")
        .and_then(|mut statement| {
            statement.query_row(params![job_id, index_no], |row| {
                row.get::<_, Option<String>>(0)
            })
        })
        .optional()
        .map(|value| value.flatten())
        .map_err(|error| format!("无法读取下载章节路径: {error}"))
}

fn store_chapter_content_at(
    connection: &Connection,
    app_data_dir: &Path,
    job_id: &str,
    index_no: i64,
    content: &str,
) -> Result<BookDownloadChapterState, String> {
    let relative = chapter_relative_path(job_id, index_no);
    let path = safe_download_path(app_data_dir, &relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建下载章节目录 {}: {error}", parent.display()))?;
    }
    let bytes = content.as_bytes();
    fs::write(&path, bytes)
        .map_err(|error| format!("无法写入下载章节 {}: {error}", path.display()))?;
    let now = library::now_ms();
    let changed = connection
        .execute(
            "UPDATE book_download_chapters
             SET status='done', content_path=?3, bytes=?4, error=NULL, updated_at=?5
             WHERE job_id=?1 AND index_no=?2",
            params![job_id, index_no, relative, bytes.len() as i64, now],
        )
        .map_err(|error| format!("无法保存下载章节状态: {error}"))?;
    if changed == 0 {
        return Err("下载章节不存在".to_string());
    }
    connection
        .execute(
            "UPDATE book_download_jobs SET updated_at=?2 WHERE id=?1",
            params![job_id, now],
        )
        .map_err(|error| format!("无法更新下载作业: {error}"))?;
    let (title, url) = connection
        .query_row(
            "SELECT title,url FROM book_download_chapters WHERE job_id=?1 AND index_no=?2",
            params![job_id, index_no],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("无法读取下载章节: {error}"))?;
    Ok(BookDownloadChapterState {
        index_no,
        title,
        url,
        status: "done".to_string(),
        bytes: Some(bytes.len() as i64),
        error: None,
        content: Some(content.to_string()),
    })
}

fn mark_chapter_failed_at(connection: &Connection, job_id: &str, index_no: i64, message: &str) {
    let _ = connection.execute(
        "UPDATE book_download_chapters
         SET status='failed', error=?3, updated_at=?4
         WHERE job_id=?1 AND index_no=?2",
        params![job_id, index_no, message, library::now_ms()],
    );
}

fn compose_txt_bytes(chapters: &[(String, String)]) -> Vec<u8> {
    let mut text = String::new();
    for (title, content) in chapters {
        text.push_str(title);
        text.push_str("\n\n");
        text.push_str(content);
        text.push_str("\n\n\n");
    }
    text.into_bytes()
}

/// 合成并入库：全部章节完成后，TXT 在此拼接，EPUB 接收前端 `epub-builder`
/// 产出的字节（base64）。入库复用 `store_blob_at`（相同 SHA-256 只更新元数据，
/// 不重复建条目）；任何失败都不落库、不留半成品文件，作业保持可重试状态。
fn finalize_download_at(
    connection: &mut Connection,
    app_data_dir: &Path,
    job_id: &str,
    epub_base64: Option<&str>,
) -> Result<BookDownloadFinalizeResult, String> {
    if !valid_download_id(job_id) {
        return Err("下载作业标识无效".to_string());
    }
    let (source_title, author, output_format) = connection
        .query_row(
            "SELECT title,author,output_format FROM book_download_jobs WHERE id=?1",
            params![job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("无法读取下载作业: {error}"))?
        .ok_or_else(|| "下载作业不存在".to_string())?;
    let chapters = read_chapters_at(connection, job_id)?;
    if chapters.is_empty() {
        return Err("下载作业没有章节".to_string());
    }
    let mut composed: Vec<(String, String)> = Vec::with_capacity(chapters.len());
    for chapter in &chapters {
        if chapter.status != "done" {
            return Err(format!("章节《{}》尚未完成下载", chapter.title));
        }
        let relative = chapter_stored_content_path(connection, job_id, chapter.index_no)?
            .ok_or_else(|| format!("章节《{}》缺少正文文件", chapter.title))?;
        let path = safe_download_path(app_data_dir, &relative)?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("无法读取章节正文 {}: {error}", path.display()))?;
        composed.push((
            chapter.title.clone(),
            String::from_utf8_lossy(&bytes).into_owned(),
        ));
    }
    let extension = if output_format == "epub" {
        "epub"
    } else {
        "txt"
    };
    let bytes = match (output_format.as_str(), epub_base64) {
        ("txt", _) => compose_txt_bytes(&composed),
        ("epub", Some(base64)) => base64_decode_standard(base64)?,
        _ => return Err("EPUB 下载缺少合成字节".to_string()),
    };
    let staging = managed_root(app_data_dir).join("staging");
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建受管书库目录: {error}"))?;
    let mut temporary = tempfile::Builder::new()
        .suffix(extension)
        .tempfile_in(&staging)
        .map_err(|error| format!("无法创建合成临时文件: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("无法写入合成临时文件: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启下载入库事务: {error}"))?;
    let blob = store_blob_at(&transaction, app_data_dir, temporary.path())?;
    let cleanup_path = blob.absolute_path.clone();
    let cleanup_file = blob.created_file;
    let result = (|| -> Result<BookDownloadFinalizeResult, String> {
        let item_id = format!("managed:{}", blob.hash);
        let authors = match author.as_deref() {
            Some(author) => serde_json::to_string(&[author])
                .map_err(|error| format!("无法序列化作者: {error}"))?,
            None => "[]".to_string(),
        };
        let now = library::now_ms();
        transaction
            .execute(
                "INSERT INTO library_items(
                   id, source_kind, title, authors_json, local_path, extension, size,
                   blob_hash, availability, offline_pinned, subjects_json, updated_at
                 ) VALUES (?1,'managed',?2,?3,?4,?5,?6,?7,'local',0,'[]',?8)
                 ON CONFLICT(id) DO UPDATE SET title=?2, authors_json=?3, local_path=?4,
                   size=?6, availability='local', updated_at=?8",
                params![
                    item_id,
                    source_title,
                    authors,
                    blob.absolute_path.to_string_lossy().into_owned(),
                    extension,
                    blob.size as i64,
                    blob.hash,
                    now
                ],
            )
            .map_err(|error| format!("无法保存下载书籍条目: {error}"))?;
        sync::write_library_item_record_at(&transaction, &item_id, true)?;
        transaction
            .execute(
                "UPDATE book_download_jobs SET status='done', updated_at=?2 WHERE id=?1",
                params![job_id, now],
            )
            .map_err(|error| format!("无法完结下载作业: {error}"))?;
        Ok(BookDownloadFinalizeResult {
            item_id,
            duplicate: blob.duplicate,
        })
    })();
    match result {
        Ok(value) => transaction.commit().map(|_| value).map_err(|error| {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            format!("无法提交下载入库: {error}")
        }),
        Err(error) => {
            // 回滚元数据与 blob 索引，并清掉新落盘文件：合成失败不产生半成品。
            drop(transaction);
            if cleanup_file {
                let _ = fs::remove_file(cleanup_path);
            }
            Err(error)
        }
    }
}

fn base64_decode_standard(value: &str) -> Result<Vec<u8>, String> {
    crate::asset::decode_base64(value.trim()).map_err(|error| format!("EPUB 合成字节无效: {error}"))
}

fn remove_download_job_at(
    connection: &Connection,
    app_data_dir: &Path,
    job_id: &str,
) -> Result<(), String> {
    if !valid_download_id(job_id) {
        return Err("下载作业标识无效".to_string());
    }
    let changed = connection
        .execute(
            "DELETE FROM book_download_jobs WHERE id=?1",
            params![job_id],
        )
        .map_err(|error| format!("无法删除下载作业: {error}"))?;
    if changed == 0 {
        return Err("下载作业不存在".to_string());
    }
    let directory = app_data_dir.join(DOWNLOAD_DIRECTORY).join(job_id);
    let _ = fs::remove_dir_all(directory);
    Ok(())
}

#[tauri::command]
pub fn book_download_job_create(
    app: AppHandle,
    input: BookDownloadJobInput,
) -> Result<BookDownloadJob, RemoteError> {
    let app_data_dir = library::app_data_dir(&app).map_err(download_storage)?;
    let connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
    create_download_job_at(&connection, &input)
}

#[tauri::command]
pub fn book_download_job_get(
    app: AppHandle,
    job_id: String,
    include_content: Option<bool>,
) -> Result<BookDownloadJob, RemoteError> {
    let app_data_dir = library::app_data_dir(&app).map_err(download_storage)?;
    let connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
    load_download_job_at(
        &connection,
        &app_data_dir,
        &job_id,
        include_content.unwrap_or(false),
    )
    .map_err(|message| {
        if message == "下载作业不存在" {
            download_not_found()
        } else {
            download_storage(message)
        }
    })
}

#[tauri::command]
pub async fn book_download_chapter_fetch(
    app: AppHandle,
    state: tauri::State<'_, crate::book_source::BookSourceState>,
    job_id: String,
    index_no: i64,
) -> Result<BookDownloadChapterState, RemoteError> {
    // 连接不能跨 await 持有：先读取作业/章节，网络抓取后重开连接写状态。
    let app_data_dir = library::app_data_dir(&app).map_err(download_storage)?;
    let (source_id, chapter_url) = {
        let connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
        let existing = load_download_job_at(&connection, &app_data_dir, &job_id, false).map_err(
            |message| {
                if message == "下载作业不存在" {
                    download_not_found()
                } else {
                    download_storage(message)
                }
            },
        )?;
        let source_id = existing
            .source_id
            .clone()
            .ok_or_else(|| download_storage("下载作业的书源已被删除"))?;
        let chapter = existing
            .chapters
            .iter()
            .find(|c| c.index_no == index_no)
            .ok_or_else(|| download_invalid("下载章节不存在"))?;
        if chapter.status == "done" {
            return Ok(chapter.clone());
        }
        (source_id, chapter.url.clone())
    };
    let text = match crate::book_source::book_source_chapter_text(
        app.clone(),
        state,
        source_id,
        chapter_url,
    )
    .await
    {
        Ok(text) => text,
        Err(error) => {
            // 单章失败：记录可重试状态后原样返回错误，不影响已完成章节。
            if let Ok(connection) = library::open_database_at(&app_data_dir) {
                mark_chapter_failed_at(&connection, &job_id, index_no, &error.message);
            }
            return Err(error);
        }
    };
    let connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
    store_chapter_content_at(&connection, &app_data_dir, &job_id, index_no, &text)
        .map_err(download_storage)
}

#[tauri::command]
pub fn book_download_finalize(
    app: AppHandle,
    job_id: String,
    epub_base64: Option<String>,
) -> Result<BookDownloadFinalizeResult, RemoteError> {
    let app_data_dir = library::app_data_dir(&app).map_err(download_storage)?;
    let mut connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
    finalize_download_at(
        &mut connection,
        &app_data_dir,
        &job_id,
        epub_base64.as_deref(),
    )
    .map_err(|message| {
        if message == "下载作业不存在" {
            download_not_found()
        } else {
            download_storage(message)
        }
    })
}

#[tauri::command]
pub fn book_download_job_remove(app: AppHandle, job_id: String) -> Result<(), RemoteError> {
    let app_data_dir = library::app_data_dir(&app).map_err(download_storage)?;
    let connection = library::open_database_at(&app_data_dir).map_err(download_storage)?;
    remove_download_job_at(&connection, &app_data_dir, &job_id).map_err(|message| {
        if message == "下载作业不存在" {
            download_not_found()
        } else {
            download_storage(message)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_content_by_hash_without_modifying_the_source() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("book.epub");
        fs::write(&source, b"book bytes").unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();

        let first = store_blob_at(&connection, app_data.path(), &source).unwrap();
        let second = store_blob_at(&connection, app_data.path(), &source).unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"book bytes");
        assert_eq!(first.hash, second.hash);
        assert!(first.absolute_path.is_file());
        assert!(!first.duplicate);
        assert!(second.duplicate);
        assert!(first.created_file);
        assert!(!second.created_file);

        fs::write(&first.absolute_path, b"corrupted").unwrap();
        let error = store_blob_at(&connection, app_data.path(), &source).unwrap_err();
        assert!(error.contains("校验失败"));
    }

    #[test]
    fn deduplicates_identical_content_across_file_extensions() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let epub = source_dir.path().join("book.epub");
        let bin = source_dir.path().join("book.bin");
        fs::write(&epub, b"same bytes").unwrap();
        fs::write(&bin, b"same bytes").unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();

        let first = store_blob_at(&connection, app_data.path(), &epub).unwrap();
        let second = store_blob_at(&connection, app_data.path(), &bin).unwrap();

        assert_eq!(first.absolute_path, second.absolute_path);
        assert!(second.duplicate);
        assert!(!app_data
            .path()
            .join("library-content/sha256")
            .join(&second.hash[..2])
            .join(format!("{}.bin", second.hash))
            .exists());
    }

    #[test]
    fn preview_keeps_missing_items_out_of_the_ready_set() {
        let app_data = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_kind,title,authors_json,local_path,availability,subjects_json,updated_at
                 ) VALUES ('local:missing','local','Missing','[]','/not/here.epub','external','[]',1)",
                [],
            )
            .unwrap();
        let preview = preview_at(&connection).unwrap();
        assert_eq!(preview.entries.len(), 1);
        assert_eq!(preview.entries[0].status, "missing");
    }

    #[test]
    fn rejects_paths_outside_the_managed_directory() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_managed_path(root.path(), "../outside").is_err());
        assert!(safe_managed_path(root.path(), "/outside").is_err());
    }

    #[test]
    fn first_download_path_keeps_the_book_extension() {
        let app_data = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();
        let hash = "a".repeat(64);
        let path =
            managed_blob_path_for_extension(&connection, app_data.path(), &hash, Some("EPUB"))
                .unwrap();
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("epub")
        );
        assert!(path.starts_with(app_data.path().join(MANAGED_DIRECTORY)));
    }

    #[test]
    fn migration_preserves_groups_and_tombstones_the_old_membership() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("book.epub");
        fs::write(&source, b"grouped book").unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();
        let group_id = "11111111-1111-4111-8111-111111111111";
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_kind,title,authors_json,local_path,availability,subjects_json,updated_at
                 ) VALUES ('local:book','local','Book','[]',?1,'external','[]',1)",
                params![source.to_string_lossy()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_groups(
                   id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at
                 ) VALUES (?1,NULL,'Group','custom',NULL,0,1,1)",
                params![group_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_group_members(group_id,item_id,created_at)
                 VALUES (?1,'local:book',1)",
                params![group_id],
            )
            .unwrap();

        let (alias, _) = migrate_item_at(&mut connection, app_data.path(), "local:book").unwrap();
        let membership_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM library_group_members WHERE group_id=?1 AND item_id=?2",
                params![group_id, alias.item_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(membership_count, 1);
        let records = sync::list_records_at(&connection).unwrap();
        assert!(records
            .iter()
            .any(|record| { record.object_id.ends_with(":local:book") && record.tombstone }));
        assert!(records.iter().any(|record| {
            record.object_id.ends_with(&format!(":{}", alias.item_id)) && !record.tombstone
        }));
    }

    #[test]
    fn migration_preserves_tags_and_tombstones_the_old_membership() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("book.epub");
        fs::write(&source, b"tagged book").unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();
        let tag_id = "22222222-2222-4222-8222-222222222222";
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_kind,title,authors_json,local_path,availability,subjects_json,updated_at
                 ) VALUES ('local:tagged','local','Tagged','[]',?1,'external','[]',1)",
                params![source.to_string_lossy()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_tags(id,name,created_at,updated_at) VALUES (?1,'科幻',1,1)",
                params![tag_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_tag_members(tag_id,item_id,created_at)
                 VALUES (?1,'local:tagged',1)",
                params![tag_id],
            )
            .unwrap();

        let (alias, _) = migrate_item_at(&mut connection, app_data.path(), "local:tagged").unwrap();

        let members: Vec<String> = connection
            .prepare("SELECT item_id FROM library_tag_members WHERE tag_id=?1 ORDER BY item_id")
            .unwrap()
            .query_map(params![tag_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(members, vec![alias.item_id.clone()]);
        let records = sync::list_records_at(&connection).unwrap();
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-tag-membership:{tag_id}:local:tagged")
                && record.tombstone
        }));
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-tag-membership:{tag_id}:{}", alias.item_id)
                && !record.tombstone
        }));
    }

    #[test]
    fn comic_import_references_the_source_without_copying() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("vol.cbz");
        fs::write(&source, vec![0_u8; 4096]).unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();

        let id = import_managed_book_at(&mut connection, app_data.path(), &source).unwrap();

        assert_eq!(id, format!("local:{}", source.to_string_lossy()));
        let (kind, path, hash): (String, String, Option<String>) = connection
            .query_row(
                "SELECT source_kind, local_path, blob_hash FROM library_items WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "local");
        assert_eq!(path, source.to_string_lossy());
        assert!(hash.is_none());
        assert!(!app_data.path().join(MANAGED_DIRECTORY).exists());
        assert!(preview_at(&connection).unwrap().entries.is_empty());
        let error = migrate_item_at(&mut connection, app_data.path(), &id).unwrap_err();
        assert!(error.contains("本地引用"));
        assert!(!app_data.path().join(MANAGED_DIRECTORY).exists());
    }

    #[test]
    fn epub_import_still_copies_into_managed_storage() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("book.epub");
        fs::write(&source, b"epub bytes").unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();

        let id = import_managed_book_at(&mut connection, app_data.path(), &source).unwrap();

        assert!(id.starts_with("managed:"));
        let path: String = connection
            .query_row(
                "SELECT local_path FROM library_items WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(path.contains(MANAGED_DIRECTORY));
        assert!(PathBuf::from(&path).is_file());
        assert_eq!(fs::read(&source).unwrap(), b"epub bytes");
    }

    // ── R8 下载管线 ──────────────────────────────────────────────────

    fn download_input(chapters: &[(&str, &str)]) -> BookDownloadJobInput {
        download_input_owned(
            chapters
                .iter()
                .map(|(title, url)| BookDownloadChapterInput {
                    title: title.to_string(),
                    url: url.to_string(),
                })
                .collect(),
        )
    }

    fn ready_job_with_content(
        app_data: &tempfile::TempDir,
        contents: &[&str],
    ) -> (Connection, BookDownloadJob) {
        let connection = library::open_database_at(app_data.path()).unwrap();
        connection
            .execute(
                "INSERT OR IGNORE INTO book_sources(id,title,rule_json,enabled,allow_http,created_at,updated_at)
                 VALUES ('source-1','示例源','{}',1,0,1,1)",
                [],
            )
            .unwrap();
        let chapters: Vec<BookDownloadChapterInput> = contents
            .iter()
            .enumerate()
            .map(|(index, _)| BookDownloadChapterInput {
                title: format!("第{}章", index + 1),
                url: format!("https://books.example/ch/{}", index + 1),
            })
            .collect();
        let job = create_download_job_at(&connection, &download_input_owned(chapters)).unwrap();
        for (index, content) in contents.iter().enumerate() {
            store_chapter_content_at(
                &connection,
                app_data.path(),
                &job.id,
                index as i64,
                &format!("{content}\n正文"),
            )
            .unwrap();
        }
        (connection, job)
    }

    fn download_input_owned(chapters: Vec<BookDownloadChapterInput>) -> BookDownloadJobInput {
        BookDownloadJobInput {
            source_id: "source-1".to_string(),
            title: "下载书".to_string(),
            author: Some("作者甲".to_string()),
            book_url: "https://books.example/book/1".to_string(),
            output_format: "txt".to_string(),
            chapters,
        }
    }

    #[test]
    fn download_job_resume_only_refetches_missing_chapters() {
        let app_data = tempfile::tempdir().unwrap();
        let (connection, job) = ready_job_with_content(&app_data, &["甲", "乙", "丙"]);

        let loaded = load_download_job_at(&connection, app_data.path(), &job.id, true).unwrap();
        assert_eq!(loaded.status, "ready");
        assert!(loaded.chapters.iter().all(|c| c.status == "done"));
        assert_eq!(loaded.chapters[0].content.as_deref(), Some("甲\n正文"));
        assert!(loaded.chapters[0].bytes.is_some_and(|bytes| bytes > 0));

        // 中断后的续传口径：删掉已完成章节的文件 → 状态回退 pending，其余保持 done。
        let first_path =
            safe_download_path(app_data.path(), &chapter_relative_path(&job.id, 0)).unwrap();
        fs::remove_file(&first_path).unwrap();
        let reloaded = load_download_job_at(&connection, app_data.path(), &job.id, false).unwrap();
        assert_eq!(reloaded.chapters[0].status, "pending");
        assert_eq!(reloaded.chapters[1].status, "done");
        assert_eq!(reloaded.chapters[2].status, "done");
        assert_eq!(reloaded.status, "downloading");
    }

    #[test]
    fn failed_chapters_are_retryable_without_touching_completed_ones() {
        let app_data = tempfile::tempdir().unwrap();
        let (connection, job) = ready_job_with_content(&app_data, &["甲"]);

        mark_chapter_failed_at(&connection, &job.id, 0, "网络中断");
        let chapter = read_chapters_at(&connection, &job.id).unwrap().remove(0);
        assert_eq!(chapter.status, "failed");
        assert_eq!(chapter.error.as_deref(), Some("网络中断"));
        // 正文文件仍在：单章失败不影响已完成内容，重试直接覆写状态。
        assert!(
            safe_download_path(app_data.path(), &chapter_relative_path(&job.id, 0))
                .unwrap()
                .is_file()
        );

        store_chapter_content_at(&connection, app_data.path(), &job.id, 0, "甲\n重试成功").unwrap();
        let recovered = read_chapters_at(&connection, &job.id).unwrap().remove(0);
        assert_eq!(recovered.status, "done");
        assert!(recovered.error.is_none());
    }

    #[test]
    fn finalize_dedupes_by_hash_and_failure_leaves_no_half_product() {
        let app_data = tempfile::tempdir().unwrap();
        let (mut connection, job) = ready_job_with_content(&app_data, &["甲", "乙"]);

        let first = finalize_download_at(&mut connection, app_data.path(), &job.id, None).unwrap();
        assert!(first.item_id.starts_with("managed:"));
        assert!(!first.duplicate);
        let stored_status: String = connection
            .query_row(
                "SELECT status FROM book_download_jobs WHERE id=?1",
                params![job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_status, "done");

        // 相同 SHA-256 重复入库：只返回同一受管条目，不新建第二本书。
        let second = finalize_download_at(&mut connection, app_data.path(), &job.id, None).unwrap();
        assert_eq!(second.item_id, first.item_id);
        assert!(second.duplicate);

        let (_, other_job) = ready_job_with_content(&app_data, &["甲", "乙"]);
        let cross =
            finalize_download_at(&mut connection, app_data.path(), &other_job.id, None).unwrap();
        assert_eq!(cross.item_id, first.item_id);
        assert!(cross.duplicate);
        let item_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(item_count, 1);
        let (title, authors): (String, String) = connection
            .query_row(
                "SELECT title,authors_json FROM library_items WHERE id=?1",
                params![first.item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "下载书");
        assert_eq!(authors, "[\"作者甲\"]");

        // EPUB 作业缺合成字节：入库失败，不落条目、不留半成品，作业仍可重试。
        let (mut epub_connection, epub_job) = {
            let connection = library::open_database_at(app_data.path()).unwrap();
            let mut input = download_input(&[("第一章", "https://books.example/ch/9")]);
            input.output_format = "epub".to_string();
            // source-1 已由 ready_job_with_content 写入同一数据库。
            let job = create_download_job_at(&connection, &input).unwrap();
            store_chapter_content_at(&connection, app_data.path(), &job.id, 0, "EPUB 正文")
                .unwrap();
            (connection, job)
        };
        let error = finalize_download_at(&mut epub_connection, app_data.path(), &epub_job.id, None)
            .unwrap_err();
        assert!(error.contains("EPUB"));
        let epub_status: String = epub_connection
            .query_row(
                "SELECT status FROM book_download_jobs WHERE id=?1",
                params![epub_job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(epub_status, "downloading");
        let epub_items: i64 = epub_connection
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(epub_items, 1, "失败路径不得新增条目");

        let epub_bytes = b"pk\x03\x04epub-bytes".to_vec();
        let encoded = epub_base64_for_tests(&epub_bytes);
        let recovered = finalize_download_at(
            &mut epub_connection,
            app_data.path(),
            &epub_job.id,
            Some(&encoded),
        )
        .unwrap();
        assert!(recovered.item_id.starts_with("managed:"));
        let extension: String = epub_connection
            .query_row(
                "SELECT extension FROM library_items WHERE id=?1",
                params![recovered.item_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extension, "epub");
    }

    #[test]
    fn finalize_requires_every_chapter_done() {
        let app_data = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();
        connection
            .execute(
                "INSERT INTO book_sources(id,title,rule_json,enabled,allow_http,created_at,updated_at)
                 VALUES ('source-1','示例源','{}',1,0,1,1)",
                [],
            )
            .unwrap();
        let job = create_download_job_at(
            &connection,
            &download_input(&[("第一章", "u1"), ("第二章", "u2")]),
        )
        .unwrap();
        store_chapter_content_at(&connection, app_data.path(), &job.id, 0, "只有第一章").unwrap();
        let error =
            finalize_download_at(&mut connection, app_data.path(), &job.id, None).unwrap_err();
        assert!(error.contains("第二章"));
        let items: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(items, 0);
    }

    #[test]
    fn removing_a_job_deletes_rows_and_chapter_files() {
        let app_data = tempfile::tempdir().unwrap();
        let (connection, job) = ready_job_with_content(&app_data, &["甲"]);
        let chapter_dir = app_data.path().join(DOWNLOAD_DIRECTORY).join(&job.id);
        assert!(chapter_dir.is_dir());

        remove_download_job_at(&connection, app_data.path(), &job.id).unwrap();

        assert!(!chapter_dir.exists());
        let chapters: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM book_download_chapters WHERE job_id=?1",
                params![job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(chapters, 0);
        assert_eq!(
            remove_download_job_at(&connection, app_data.path(), &job.id).unwrap_err(),
            "下载作业不存在"
        );
        assert!(remove_download_job_at(&connection, app_data.path(), "../escape").is_err());
    }

    #[test]
    fn download_input_is_validated_before_any_write() {
        let app_data = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();
        let mut empty_title = download_input(&[("第一章", "u1")]);
        empty_title.title = "  ".to_string();
        assert_eq!(
            create_download_job_at(&connection, &empty_title)
                .unwrap_err()
                .code,
            "BOOK_DOWNLOAD_INVALID"
        );
        let mut bad_format = download_input(&[("第一章", "u1")]);
        bad_format.output_format = "pdf".to_string();
        assert!(create_download_job_at(&connection, &bad_format).is_err());
        assert!(create_download_job_at(&connection, &download_input(&[])).is_err());
        let jobs: i64 = connection
            .query_row("SELECT COUNT(*) FROM book_download_jobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(jobs, 0);
    }

    /// 测试侧本地 base64 编码（与 `book_translation.rs` 测试同口径）。
    fn epub_base64_for_tests(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            let byte = |index: usize| -> u8 { chunk.get(index).copied().unwrap_or(0) };
            let triple =
                (u32::from(byte(0)) << 16) | (u32::from(byte(1)) << 8) | u32::from(byte(2));
            for shift in [18, 12, 6, 0] {
                let index = ((triple >> shift) & 0x3f) as usize;
                if chunk.len() * 8 > shift {
                    output.push(TABLE[index] as char);
                }
            }
        }
        while !output.len().is_multiple_of(4) {
            output.push('=');
        }
        output
    }
}
