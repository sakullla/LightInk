//! Persistent library metadata and bounded sparse-cache index.
//!
//! The database intentionally stores metadata and byte ranges only. Payload bytes
//! live below the application cache directory, and credentials are never written
//! here. The pure range helpers are kept independent from Tauri so they can be
//! tested without a running application.

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DATABASE_FILE: &str = "library.sqlite3";
pub const CACHE_DIRECTORY: &str = "remote-cache";
pub const DEFAULT_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const SCHEMA_VERSION: i64 = 5;
const CACHE_LIMIT_KEY: &str = "cache_limit_bytes";
const RESERVED_SHELF_FILTERS: &[&str] = &["all", "in-progress", "unread", "text", "comic"];
const SMART_KEY_AUTHORS_ROOT: &str = "root:authors";
const SMART_KEY_SERIES_ROOT: &str = "root:series";
const SMART_KEY_KIND_TEXT: &str = "kind:text";
const SMART_KEY_KIND_COMIC: &str = "kind:comic";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsSource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub credential_ref: Option<String>,
    pub allow_http: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub source_id: Option<String>,
    pub source_kind: String,
    pub title: String,
    pub authors: Vec<String>,
    pub cover_url: Option<String>,
    pub local_path: Option<String>,
    pub acquisition_url: Option<String>,
    pub media_type: Option<String>,
    pub extension: Option<String>,
    pub size: Option<i64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub series: Option<String>,
    pub number: Option<String>,
    pub volume: Option<String>,
    pub page_count: Option<i64>,
    pub reading_direction: Option<String>,
    pub cover_page: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryComicMetadata {
    pub series: Option<String>,
    pub number: Option<String>,
    pub volume: Option<String>,
    pub page_count: Option<i64>,
    pub reading_direction: Option<String>,
    pub cover_page: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionLink {
    pub item_id: String,
    pub href: String,
    pub rel: String,
    pub media_type: Option<String>,
    pub extension: Option<String>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCacheStats {
    pub bytes_cached: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroup {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub source: String,
    pub smart_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroupMember {
    pub group_id: String,
    pub item_id: String,
    pub content_hash: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOrganizeHint {
    pub item_id: String,
    pub authors: Vec<String>,
    pub series_stem: Option<String>,
    pub kind: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheObject {
    pub id: String,
    pub source_key: String,
    pub path: String,
    pub total_size: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub complete: bool,
    pub bytes_cached: u64,
    pub last_accessed: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn new(start: u64, end: u64) -> Result<Self, String> {
        if start >= end {
            return Err("cache range must have start < end".to_string());
        }
        Ok(Self { start, end })
    }

    pub fn len(self) -> u64 {
        self.end - self.start
    }

    pub fn overlaps_or_touches(self, other: Self) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

/// Merge a new half-open range into sorted, non-overlapping ranges.
pub fn merge_range(mut ranges: Vec<ByteRange>, incoming: ByteRange) -> Vec<ByteRange> {
    ranges.push(incoming);
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<ByteRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if last.overlaps_or_touches(range) {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

/// Return whether a range is completely covered by sorted cached ranges.
pub fn range_is_covered(ranges: &[ByteRange], requested: ByteRange) -> bool {
    ranges
        .iter()
        .any(|range| range.start <= requested.start && range.end >= requested.end)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> bool {
    connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(rows.flatten().any(|name| name == column))
        })
        .unwrap_or(false)
}

#[cfg(test)]
fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            params![table],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn ensure_group_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS library_groups (
              id TEXT PRIMARY KEY NOT NULL,
              parent_id TEXT REFERENCES library_groups(id) ON DELETE SET NULL,
              name TEXT NOT NULL,
              source TEXT NOT NULL CHECK(source IN ('user', 'smart')),
              smart_key TEXT UNIQUE,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_groups_parent_idx
              ON library_groups(parent_id, name COLLATE NOCASE);
            CREATE TABLE IF NOT EXISTS library_group_members (
              group_id TEXT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
              item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
              content_hash TEXT,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(group_id, item_id)
            );
            CREATE INDEX IF NOT EXISTS library_group_members_item_idx
              ON library_group_members(item_id);
            CREATE TABLE IF NOT EXISTS library_smart_exclusions (
              smart_key TEXT NOT NULL,
              item_id TEXT NOT NULL,
              content_hash TEXT,
              PRIMARY KEY(smart_key, item_id)
            );
            ",
        )
        .map_err(|error| format!("无法迁移书库分组表: {error}"))
}

pub(crate) fn open_database_at(app_data_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建书库数据目录: {error}"))?;
    let path = app_data_dir.join(DATABASE_FILE);
    let mut connection = match Connection::open(&path) {
        Ok(connection) => connection,
        Err(error) => {
            if !matches!(
                error.sqlite_error_code(),
                Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
            ) {
                return Err(format!("无法打开书库数据库: {error}"));
            }
            // 保留损坏文件用于诊断，然后重建空数据库，避免书库索引阻塞应用启动。
            let backup = path.with_extension(format!("sqlite3.corrupt.{}", now_ms()));
            let _ = fs::rename(&path, backup);
            Connection::open(&path)
                .map_err(|retry| format!("无法打开书库数据库: {error}; 重建失败: {retry}"))?
        }
    };
    let quick_check =
        match connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
            Ok(result) => result,
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
                ) =>
            {
                "corrupt".to_string()
            }
            Err(error) => return Err(format!("无法检查书库数据库完整性: {error}")),
        };
    if quick_check != "ok" {
        drop(connection);
        // SQLite 对部分损坏文件仍能成功 Connection::open；quick_check
        // 覆盖这一分支，并让用户的旧索引以带时间戳的文件保留待诊断。
        let backup = path.with_extension(format!("sqlite3.corrupt.{}", now_ms()));
        let _ = fs::rename(&path, backup);
        connection =
            Connection::open(&path).map_err(|error| format!("无法重建书库数据库: {error}"))?;
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("无法启用书库数据库约束: {error}"))?;
    connection
        .execute_batch(
            "\
            CREATE TABLE IF NOT EXISTS schema_meta (
              key TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS opds_sources (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              url TEXT NOT NULL,
              credential_ref TEXT,
              allow_http INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_items (
              id TEXT PRIMARY KEY NOT NULL,
              source_id TEXT REFERENCES opds_sources(id) ON DELETE CASCADE,
              source_kind TEXT NOT NULL,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              cover_url TEXT,
              local_path TEXT,
              acquisition_url TEXT,
              media_type TEXT,
              extension TEXT,
              size INTEGER,
              etag TEXT,
              last_modified TEXT,
              series TEXT,
              number TEXT,
              volume TEXT,
              page_count INTEGER,
              reading_direction TEXT,
              cover_page INTEGER,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_items_source_idx
              ON library_items(source_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS library_groups (
              id TEXT PRIMARY KEY NOT NULL,
              parent_id TEXT REFERENCES library_groups(id) ON DELETE SET NULL,
              name TEXT NOT NULL,
              source TEXT NOT NULL CHECK(source IN ('user', 'smart')),
              smart_key TEXT UNIQUE,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_groups_parent_idx
              ON library_groups(parent_id, name COLLATE NOCASE);
            CREATE TABLE IF NOT EXISTS library_group_members (
              group_id TEXT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
              item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
              content_hash TEXT,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(group_id, item_id)
            );
            CREATE INDEX IF NOT EXISTS library_group_members_item_idx
              ON library_group_members(item_id);
            CREATE TABLE IF NOT EXISTS library_smart_exclusions (
              smart_key TEXT NOT NULL,
              item_id TEXT NOT NULL,
              content_hash TEXT,
              PRIMARY KEY(smart_key, item_id)
            );
            CREATE TABLE IF NOT EXISTS acquisition_links (
              item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
              href TEXT NOT NULL,
              rel TEXT NOT NULL,
              media_type TEXT,
              extension TEXT,
              size INTEGER,
              PRIMARY KEY(item_id, href)
            );
            CREATE TABLE IF NOT EXISTS cache_objects (
              id TEXT PRIMARY KEY NOT NULL,
              source_key TEXT NOT NULL UNIQUE,
              path TEXT NOT NULL,
              total_size INTEGER,
              etag TEXT,
              last_modified TEXT,
              complete INTEGER NOT NULL DEFAULT 0,
              bytes_cached INTEGER NOT NULL DEFAULT 0,
              last_accessed INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cache_ranges (
              object_id TEXT NOT NULL REFERENCES cache_objects(id) ON DELETE CASCADE,
              start INTEGER NOT NULL,
              end INTEGER NOT NULL,
              PRIMARY KEY(object_id, start),
              CHECK(start >= 0 AND end > start)
            );
            CREATE INDEX IF NOT EXISTS cache_ranges_lookup_idx
              ON cache_ranges(object_id, start, end);
            INSERT INTO schema_meta(key, value) VALUES ('version', '5')
              ON CONFLICT(key) DO NOTHING;
            INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', '2147483648')
              ON CONFLICT(key) DO NOTHING;
            ",
        )
        .map_err(|error| format!("无法初始化书库数据库: {error}"))?;
    let version: i64 = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(1);
    if version < SCHEMA_VERSION {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开启书库迁移事务: {error}"))?;
        if !table_has_column(&transaction, "opds_sources", "allow_http") {
            transaction
                .execute(
                    "ALTER TABLE opds_sources ADD COLUMN allow_http INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|error| format!("无法迁移 OPDS 源协议设置: {error}"))?;
        }
        for (column, definition) in [
            ("series", "series TEXT"),
            ("number", "number TEXT"),
            ("volume", "volume TEXT"),
            ("page_count", "page_count INTEGER"),
            ("reading_direction", "reading_direction TEXT"),
            ("cover_page", "cover_page INTEGER"),
        ] {
            if !table_has_column(&transaction, "library_items", column) {
                transaction
                    .execute(
                        &format!("ALTER TABLE library_items ADD COLUMN {definition}"),
                        [],
                    )
                    .map_err(|error| format!("无法迁移漫画元数据列 {column}: {error}"))?;
            }
        }
        transaction
            .execute(
                "INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', ?1)
                 ON CONFLICT(key) DO NOTHING",
                params![DEFAULT_CACHE_LIMIT_BYTES as i64],
            )
            .map_err(|error| format!("无法迁移书库数据库: {error}"))?;
        ensure_group_schema(&transaction)?;
        transaction
            .execute(
                "UPDATE schema_meta SET value=?1 WHERE key='version'",
                params![SCHEMA_VERSION.to_string()],
            )
            .map_err(|error| format!("无法更新书库数据库版本: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交书库迁移事务: {error}"))?;
    }
    Ok(connection)
}

pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位书库数据目录: {error}"))
}

pub(crate) fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位远程缓存目录: {error}"))?
        .join(CACHE_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建远程缓存目录: {error}"))?;
    Ok(directory)
}

#[cfg(test)]
fn database_for_tests(directory: &Path) -> Result<Connection, String> {
    open_database_at(directory)
}

#[tauri::command]
pub fn library_list_sources(app: AppHandle) -> Result<Vec<OpdsSource>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, url, credential_ref, allow_http, created_at, updated_at
             FROM opds_sources ORDER BY title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取 OPDS 源: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(OpdsSource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                credential_ref: row.get(3)?,
                allow_http: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取 OPDS 源: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析 OPDS 源: {error}"))
}

#[tauri::command]
pub fn library_upsert_source(app: AppHandle, source: OpdsSource) -> Result<(), String> {
    if source.id.trim().is_empty() || source.title.trim().is_empty() || source.url.trim().is_empty()
    {
        return Err("OPDS 源缺少必要字段".to_string());
    }
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute(
            "INSERT INTO opds_sources(id, title, url, credential_ref, allow_http, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET title=?2, url=?3, credential_ref=?4,
               allow_http=?5, updated_at=?7",
            params![
                source.id,
                source.title,
                source.url,
                source.credential_ref,
                i64::from(source.allow_http),
                source.created_at,
                source.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存 OPDS 源: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_source(app: AppHandle, source_id: String) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute("DELETE FROM opds_sources WHERE id = ?1", params![source_id])
        .map_err(|error| format!("无法删除 OPDS 源: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_list_items(
    app: AppHandle,
    source_id: Option<String>,
) -> Result<Vec<LibraryItem>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT id, source_id, source_kind, title, authors_json, cover_url,
                    local_path, acquisition_url, media_type, extension, size,
                    etag, last_modified, series, number, volume, page_count,
                    reading_direction, cover_page, updated_at
             FROM library_items
             WHERE (?1 IS NULL OR source_id = ?1)
             ORDER BY updated_at DESC, title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    let rows = statement
        .query_map(params![source_id], |row| {
            let authors_json: String = row.get(4)?;
            let authors = serde_json::from_str(&authors_json).unwrap_or_default();
            Ok(LibraryItem {
                id: row.get(0)?,
                source_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                authors,
                cover_url: row.get(5)?,
                local_path: row.get(6)?,
                acquisition_url: row.get(7)?,
                media_type: row.get(8)?,
                extension: row.get(9)?,
                size: row.get(10)?,
                etag: row.get(11)?,
                last_modified: row.get(12)?,
                series: row.get(13)?,
                number: row.get(14)?,
                volume: row.get(15)?,
                page_count: row.get(16)?,
                reading_direction: row.get(17)?,
                cover_page: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书库条目: {error}"))
}

#[tauri::command]
pub fn library_list_acquisition_links(
    app: AppHandle,
    item_id: String,
) -> Result<Vec<AcquisitionLink>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT item_id, href, rel, media_type, extension, size
             FROM acquisition_links WHERE item_id=?1
             ORDER BY CASE WHEN rel LIKE '%/acquisition' THEN 0 ELSE 1 END, href",
        )
        .map_err(|error| format!("无法读取获取链接: {error}"))?;
    let rows = statement
        .query_map(params![item_id], |row| {
            Ok(AcquisitionLink {
                item_id: row.get(0)?,
                href: row.get(1)?,
                rel: row.get(2)?,
                media_type: row.get(3)?,
                extension: row.get(4)?,
                size: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取获取链接: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析获取链接: {error}"))
}

#[tauri::command]
pub fn library_upsert_item(app: AppHandle, item: LibraryItem) -> Result<(), String> {
    if item.id.trim().is_empty() || item.title.trim().is_empty() {
        return Err("书库条目缺少必要字段".to_string());
    }
    let authors_json = serde_json::to_string(&item.authors)
        .map_err(|error| format!("无法序列化作者信息: {error}"))?;
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("无法开启书库事务: {error}"))?;
    transaction
        .execute(
            "INSERT INTO library_items(
               id, source_id, source_kind, title, authors_json, cover_url,
               local_path, acquisition_url, media_type, extension, size,
               etag, last_modified, series, number, volume, page_count,
               reading_direction, cover_page, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                       ?14, ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(id) DO UPDATE SET
               source_id=?2, source_kind=?3, title=?4, authors_json=?5,
               cover_url=?6, local_path=?7, acquisition_url=?8, media_type=?9,
               extension=?10, size=?11, etag=?12, last_modified=?13,
               series=COALESCE(?14, series), number=COALESCE(?15, number),
               volume=COALESCE(?16, volume), page_count=COALESCE(?17, page_count),
               reading_direction=COALESCE(?18, reading_direction),
               cover_page=COALESCE(?19, cover_page), updated_at=?20",
            params![
                item.id,
                item.source_id,
                item.source_kind,
                item.title,
                authors_json,
                item.cover_url,
                item.local_path,
                item.acquisition_url,
                item.media_type,
                item.extension,
                item.size,
                item.etag,
                item.last_modified,
                item.series,
                item.number,
                item.volume,
                item.page_count,
                item.reading_direction,
                item.cover_page,
                item.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存书库条目: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交书库事务: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_update_comic_metadata(
    app: AppHandle,
    item_id: String,
    metadata: LibraryComicMetadata,
) -> Result<(), String> {
    if item_id.trim().is_empty() {
        return Err("书库条目 ID 不能为空".to_string());
    }
    if metadata.page_count.is_some_and(|value| value <= 0)
        || metadata.cover_page.is_some_and(|value| value < 0)
    {
        return Err("漫画页数元数据无效".to_string());
    }
    if metadata
        .reading_direction
        .as_deref()
        .is_some_and(|value| value != "ltr" && value != "rtl")
    {
        return Err("漫画阅读方向无效".to_string());
    }
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute(
            "UPDATE library_items SET
               series=?2, number=?3, volume=?4, page_count=?5,
               reading_direction=?6, cover_page=?7, updated_at=?8
             WHERE id=?1",
            params![
                item_id,
                metadata.series,
                metadata.number,
                metadata.volume,
                metadata.page_count,
                metadata.reading_direction,
                metadata.cover_page,
                now_ms(),
            ],
        )
        .map_err(|error| format!("无法更新漫画元数据: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute("DELETE FROM library_items WHERE id = ?1", params![item_id])
        .map_err(|error| format!("无法删除书库条目: {error}"))?;
    Ok(())
}

fn is_reserved_shelf_filter(id: &str) -> bool {
    RESERVED_SHELF_FILTERS.contains(&id)
}

fn reject_reserved_shelf_filter(id: &str) -> Result<(), String> {
    if is_reserved_shelf_filter(id) {
        return Err("五个筛选项不能当作用户组改名或删除".to_string());
    }
    Ok(())
}

fn map_group_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryGroup> {
    Ok(LibraryGroup {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        source: row.get(3)?,
        smart_key: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn load_library_group(
    connection: &Connection,
    group_id: &str,
) -> Result<Option<LibraryGroup>, String> {
    connection
        .query_row(
            "SELECT id, parent_id, name, source, smart_key, created_at, updated_at
             FROM library_groups WHERE id=?1",
            params![group_id],
            map_group_row,
        )
        .optional()
        .map_err(|error| format!("无法读取分组: {error}"))
}

fn load_group_by_smart_key(
    connection: &Connection,
    smart_key: &str,
) -> Result<Option<LibraryGroup>, String> {
    connection
        .query_row(
            "SELECT id, parent_id, name, source, smart_key, created_at, updated_at
             FROM library_groups WHERE smart_key=?1",
            params![smart_key],
            map_group_row,
        )
        .optional()
        .map_err(|error| format!("无法读取智能组: {error}"))
}

fn library_item_exists(connection: &Connection, item_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM library_items WHERE id=?1",
            params![item_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| format!("无法读取书库条目: {error}"))
}

fn would_create_group_cycle(
    connection: &Connection,
    group_id: &str,
    parent_id: &str,
) -> Result<bool, String> {
    if group_id == parent_id {
        return Ok(true);
    }
    let mut current = Some(parent_id.to_string());
    for _ in 0..64 {
        let Some(id) = current else {
            return Ok(false);
        };
        if id == group_id {
            return Ok(true);
        }
        current = connection
            .query_row(
                "SELECT parent_id FROM library_groups WHERE id=?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("无法检查分组嵌套: {error}"))?
            .flatten();
    }
    Err("分组嵌套过深".to_string())
}

fn validate_group_parent(
    connection: &Connection,
    group_id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    let Some(parent_id) = parent_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    reject_reserved_shelf_filter(parent_id)?;
    if load_library_group(connection, parent_id)?.is_none() {
        return Err("父分组不存在".to_string());
    }
    if would_create_group_cycle(connection, group_id, parent_id)? {
        return Err("不能把分组挂到自己下面".to_string());
    }
    Ok(())
}

fn classify_library_kind(item: &LibraryItem) -> &'static str {
    let extension = item
        .extension
        .as_deref()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "cbz" | "cbr" | "cb7") {
        return "comic";
    }
    let media_type = item
        .media_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type.contains("comic")
        || matches!(
            media_type.as_str(),
            "application/zip"
                | "application/x-zip"
                | "application/x-zip-compressed"
                | "application/x-cbz"
                | "application/x-cbr"
                | "application/x-cb7"
        )
    {
        return "comic";
    }
    let has_text =
        |value: &Option<String>| value.as_deref().is_some_and(|text| !text.trim().is_empty());
    if has_text(&item.series)
        || has_text(&item.number)
        || has_text(&item.volume)
        || item.page_count.is_some_and(|pages| pages > 0)
        || matches!(item.reading_direction.as_deref(), Some("ltr" | "rtl"))
        || item.cover_page.is_some()
    {
        return "comic";
    }
    "text"
}

fn load_all_library_items(connection: &Connection) -> Result<Vec<LibraryItem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, source_id, source_kind, title, authors_json, cover_url,
                    local_path, acquisition_url, media_type, extension, size,
                    etag, last_modified, series, number, volume, page_count,
                    reading_direction, cover_page, updated_at
             FROM library_items
             ORDER BY updated_at DESC, title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let authors_json: String = row.get(4)?;
            let authors = serde_json::from_str(&authors_json).unwrap_or_default();
            Ok(LibraryItem {
                id: row.get(0)?,
                source_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                authors,
                cover_url: row.get(5)?,
                local_path: row.get(6)?,
                acquisition_url: row.get(7)?,
                media_type: row.get(8)?,
                extension: row.get(9)?,
                size: row.get(10)?,
                etag: row.get(11)?,
                last_modified: row.get(12)?,
                series: row.get(13)?,
                number: row.get(14)?,
                volume: row.get(15)?,
                page_count: row.get(16)?,
                reading_direction: row.get(17)?,
                cover_page: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书库条目: {error}"))
}

fn is_smart_excluded(
    connection: &Connection,
    smart_key: &str,
    item_id: &str,
    content_hash: Option<&str>,
) -> Result<bool, String> {
    let by_item: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_smart_exclusions WHERE smart_key=?1 AND item_id=?2",
            params![smart_key, item_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取智能组移出记录: {error}"))?;
    if by_item > 0 {
        return Ok(true);
    }
    let Some(content_hash) = content_hash.filter(|value| !value.trim().is_empty()) else {
        return Ok(false);
    };
    let by_hash: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_smart_exclusions WHERE smart_key=?1 AND content_hash=?2",
            params![smart_key, content_hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取智能组移出记录: {error}"))?;
    Ok(by_hash > 0)
}

fn clear_smart_exclusion(
    connection: &Connection,
    smart_key: &str,
    item_id: &str,
    content_hash: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM library_smart_exclusions
             WHERE smart_key=?1 AND (item_id=?2 OR (?3 IS NOT NULL AND content_hash=?3))",
            params![smart_key, item_id, content_hash],
        )
        .map_err(|error| format!("无法更新智能组移出记录: {error}"))?;
    Ok(())
}

fn record_smart_exclusion(
    connection: &Connection,
    smart_key: &str,
    item_id: &str,
    content_hash: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO library_smart_exclusions(smart_key, item_id, content_hash)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(smart_key, item_id) DO UPDATE SET
               content_hash=COALESCE(excluded.content_hash, library_smart_exclusions.content_hash)",
            params![smart_key, item_id, content_hash],
        )
        .map_err(|error| format!("无法保存智能组移出记录: {error}"))?;
    Ok(())
}

fn insert_group_member(
    connection: &Connection,
    group_id: &str,
    item_id: &str,
    content_hash: Option<&str>,
    now: i64,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO library_group_members(group_id, item_id, content_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(group_id, item_id) DO UPDATE SET
               content_hash=COALESCE(excluded.content_hash, library_group_members.content_hash),
               updated_at=excluded.updated_at",
            params![group_id, item_id, content_hash, now],
        )
        .map_err(|error| format!("无法加入分组: {error}"))?;
    Ok(())
}

fn ensure_smart_group(
    connection: &Connection,
    smart_key: &str,
    name: &str,
    parent_id: Option<&str>,
    now: i64,
) -> Result<LibraryGroup, String> {
    if let Some(existing) = load_group_by_smart_key(connection, smart_key)? {
        return Ok(existing);
    }
    let id = format!("smart:{smart_key}");
    reject_reserved_shelf_filter(&id)?;
    connection
        .execute(
            "INSERT INTO library_groups(id, parent_id, name, source, smart_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'smart', ?4, ?5, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, parent_id, name, smart_key, now],
        )
        .map_err(|error| format!("无法创建智能组: {error}"))?;
    load_library_group(connection, &id)?.ok_or_else(|| "无法创建智能组".to_string())
}

fn add_to_smart_group_if_allowed(
    connection: &Connection,
    smart_key: &str,
    name: &str,
    parent_id: Option<&str>,
    item_id: &str,
    content_hash: Option<&str>,
    now: i64,
) -> Result<(), String> {
    if is_smart_excluded(connection, smart_key, item_id, content_hash)? {
        return Ok(());
    }
    let group = ensure_smart_group(connection, smart_key, name, parent_id, now)?;
    insert_group_member(connection, &group.id, item_id, content_hash, now)
}

fn non_empty_labels(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn list_library_groups(connection: &Connection) -> Result<Vec<LibraryGroup>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, parent_id, name, source, smart_key, created_at, updated_at
             FROM library_groups
             ORDER BY parent_id IS NOT NULL, name COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取分组: {error}"))?;
    let rows = statement
        .query_map([], map_group_row)
        .map_err(|error| format!("无法读取分组: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析分组: {error}"))
}

pub(crate) fn upsert_library_group(
    connection: &Connection,
    group: LibraryGroup,
) -> Result<LibraryGroup, String> {
    let name = group.name.trim();
    if name.is_empty() {
        return Err("分组缺少必要字段".to_string());
    }
    let now = if group.updated_at > 0 {
        group.updated_at
    } else {
        now_ms()
    };
    let created_at = if group.created_at > 0 {
        group.created_at
    } else {
        now
    };
    let parent_id = group
        .parent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let existing = if group.id.trim().is_empty() {
        None
    } else {
        reject_reserved_shelf_filter(group.id.trim())?;
        load_library_group(connection, group.id.trim())?
    };
    let id = if let Some(existing) = existing.as_ref() {
        existing.id.clone()
    } else if group.id.trim().is_empty() {
        format!("user:{now}")
    } else {
        reject_reserved_shelf_filter(group.id.trim())?;
        group.id.trim().to_string()
    };
    validate_group_parent(connection, &id, parent_id.as_deref())?;
    let (source, smart_key, created_at) = if let Some(existing) = existing {
        (existing.source, existing.smart_key, existing.created_at)
    } else {
        ("user".to_string(), None, created_at)
    };
    connection
        .execute(
            "INSERT INTO library_groups(id, parent_id, name, source, smart_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               parent_id=excluded.parent_id, name=excluded.name, updated_at=excluded.updated_at",
            params![id, parent_id, name, source, smart_key, created_at, now],
        )
        .map_err(|error| format!("无法保存分组: {error}"))?;
    load_library_group(connection, &id)?.ok_or_else(|| "无法保存分组".to_string())
}

pub(crate) fn remove_library_group(connection: &Connection, group_id: &str) -> Result<(), String> {
    reject_reserved_shelf_filter(group_id)?;
    connection
        .execute("DELETE FROM library_groups WHERE id=?1", params![group_id])
        .map_err(|error| format!("无法删除分组: {error}"))?;
    Ok(())
}

pub(crate) fn list_library_group_members(
    connection: &Connection,
    group_id: Option<&str>,
) -> Result<Vec<LibraryGroupMember>, String> {
    if let Some(group_id) = group_id.filter(|value| !value.trim().is_empty()) {
        reject_reserved_shelf_filter(group_id)?;
    }
    let mut statement = connection
        .prepare(
            "SELECT group_id, item_id, content_hash, updated_at
             FROM library_group_members
             WHERE (?1 IS NULL OR group_id=?1)
             ORDER BY group_id, item_id",
        )
        .map_err(|error| format!("无法读取分组成员: {error}"))?;
    let rows = statement
        .query_map(params![group_id], |row| {
            Ok(LibraryGroupMember {
                group_id: row.get(0)?,
                item_id: row.get(1)?,
                content_hash: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| format!("无法读取分组成员: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析分组成员: {error}"))
}

pub(crate) fn add_library_group_member(
    connection: &Connection,
    group_id: &str,
    item_id: &str,
    content_hash: Option<&str>,
) -> Result<(), String> {
    reject_reserved_shelf_filter(group_id)?;
    let group =
        load_library_group(connection, group_id)?.ok_or_else(|| "分组不存在".to_string())?;
    if !library_item_exists(connection, item_id)? {
        return Err("书库条目不存在".to_string());
    }
    insert_group_member(connection, group_id, item_id, content_hash, now_ms())?;
    if group.source == "smart" {
        if let Some(smart_key) = group.smart_key.as_deref() {
            clear_smart_exclusion(connection, smart_key, item_id, content_hash)?;
        }
    }
    Ok(())
}

pub(crate) fn remove_library_group_member(
    connection: &Connection,
    group_id: &str,
    item_id: &str,
) -> Result<(), String> {
    reject_reserved_shelf_filter(group_id)?;
    let group = load_library_group(connection, group_id)?;
    let content_hash = connection
        .query_row(
            "SELECT content_hash FROM library_group_members WHERE group_id=?1 AND item_id=?2",
            params![group_id, item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取分组成员: {error}"))?
        .flatten();
    connection
        .execute(
            "DELETE FROM library_group_members WHERE group_id=?1 AND item_id=?2",
            params![group_id, item_id],
        )
        .map_err(|error| format!("无法移出分组: {error}"))?;
    if let Some(group) = group {
        if group.source == "smart" {
            if let Some(smart_key) = group.smart_key.as_deref() {
                record_smart_exclusion(connection, smart_key, item_id, content_hash.as_deref())?;
            }
        }
    }
    Ok(())
}

pub(crate) fn organize_library_groups(
    connection: &Connection,
    hints: &[LibraryOrganizeHint],
) -> Result<(), String> {
    let now = now_ms();
    let authors_root = ensure_smart_group(connection, SMART_KEY_AUTHORS_ROOT, "作者", None, now)?;
    let series_root = ensure_smart_group(connection, SMART_KEY_SERIES_ROOT, "系列", None, now)?;
    let items = load_all_library_items(connection)?;
    for item in items {
        let hint = hints.iter().find(|hint| hint.item_id == item.id);
        let authors = hint
            .map(|hint| non_empty_labels(&hint.authors))
            .filter(|authors| !authors.is_empty())
            .unwrap_or_else(|| non_empty_labels(&item.authors));
        let series_stem = hint
            .and_then(|hint| hint.series_stem.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() >= 2);
        let kind = hint
            .and_then(|hint| hint.kind.as_deref())
            .map(str::trim)
            .filter(|value| matches!(*value, "text" | "comic"))
            .unwrap_or_else(|| classify_library_kind(&item));
        let content_hash = hint
            .and_then(|hint| hint.content_hash.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        for author in authors {
            add_to_smart_group_if_allowed(
                connection,
                &format!("author:{author}"),
                &author,
                Some(&authors_root.id),
                &item.id,
                content_hash,
                now,
            )?;
        }
        if let Some(series_stem) = series_stem {
            add_to_smart_group_if_allowed(
                connection,
                &format!("series:{series_stem}"),
                series_stem,
                Some(&series_root.id),
                &item.id,
                content_hash,
                now,
            )?;
        }
        let (kind_key, kind_name) = if kind == "comic" {
            (SMART_KEY_KIND_COMIC, "漫画")
        } else {
            (SMART_KEY_KIND_TEXT, "文字书")
        };
        add_to_smart_group_if_allowed(
            connection,
            kind_key,
            kind_name,
            None,
            &item.id,
            content_hash,
            now,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_list_groups(app: AppHandle) -> Result<Vec<LibraryGroup>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    list_library_groups(&connection)
}

#[tauri::command]
pub fn library_upsert_group(app: AppHandle, group: LibraryGroup) -> Result<LibraryGroup, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    upsert_library_group(&connection, group)
}

#[tauri::command]
pub fn library_remove_group(app: AppHandle, group_id: String) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    remove_library_group(&connection, &group_id)
}

#[tauri::command]
pub fn library_list_group_members(
    app: AppHandle,
    group_id: Option<String>,
) -> Result<Vec<LibraryGroupMember>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    list_library_group_members(&connection, group_id.as_deref())
}

#[tauri::command]
pub fn library_add_group_member(
    app: AppHandle,
    group_id: String,
    item_id: String,
    content_hash: Option<String>,
) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    add_library_group_member(&connection, &group_id, &item_id, content_hash.as_deref())
}

#[tauri::command]
pub fn library_remove_group_member(
    app: AppHandle,
    group_id: String,
    item_id: String,
) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    remove_library_group_member(&connection, &group_id, &item_id)
}

#[tauri::command]
pub fn library_organize_groups(
    app: AppHandle,
    hints: Vec<LibraryOrganizeHint>,
) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    organize_library_groups(&connection, &hints)
}

/// Names and function pointers for `generate_handler` in `lib.rs`.
/// Kept referenced so an unregistered split assignment does not trip clippy.
pub fn library_group_command_ids() -> &'static [&'static str] {
    let _ = (
        library_list_groups as *const () as usize,
        library_upsert_group as *const () as usize,
        library_remove_group as *const () as usize,
        library_list_group_members as *const () as usize,
        library_add_group_member as *const () as usize,
        library_remove_group_member as *const () as usize,
        library_organize_groups as *const () as usize,
    );
    &[
        "library_list_groups",
        "library_upsert_group",
        "library_remove_group",
        "library_list_group_members",
        "library_add_group_member",
        "library_remove_group_member",
        "library_organize_groups",
    ]
}

#[used]
static LIBRARY_GROUP_COMMAND_IDS: fn() -> &'static [&'static str] = library_group_command_ids;

#[tauri::command]
pub fn library_clear_cache(app: AppHandle) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let directory = cache_dir(&app)?;
    if directory.exists() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法读取远程缓存: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("无法读取远程缓存条目: {error}"))?
                .path();
            if path.is_file() {
                fs::remove_file(path).map_err(|error| format!("无法删除远程缓存: {error}"))?;
            }
        }
    }
    connection
        .execute_batch("DELETE FROM cache_ranges; DELETE FROM cache_objects;")
        .map_err(|error| format!("无法清理远程缓存索引: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_set_cache_limit(app: AppHandle, limit_bytes: u64) -> Result<(), String> {
    if limit_bytes == 0 {
        return Err("缓存上限必须大于 0".to_string());
    }
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute(
            "INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![limit_bytes.min(i64::MAX as u64) as i64],
        )
        .map_err(|error| format!("无法保存缓存上限: {error}"))?;
    let _ = evict_cache(&mut connection, &cache_dir(&app)?, limit_bytes)?;
    Ok(())
}

#[tauri::command]
pub fn library_cache_stats(app: AppHandle) -> Result<LibraryCacheStats, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let bytes_cached: i64 = connection
        .query_row(
            "SELECT COALESCE(SUM(bytes_cached), 0) FROM cache_objects",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法统计缓存大小: {error}"))?;
    Ok(LibraryCacheStats {
        bytes_cached: u64::try_from(bytes_cached).unwrap_or(0),
        limit_bytes: cache_limit(&connection)?,
    })
}

pub fn cache_limit(connection: &Connection) -> Result<u64, String> {
    let value: Option<i64> = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key=?1",
            params![CACHE_LIMIT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("无法读取缓存上限: {error}"))?;
    Ok(value
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(DEFAULT_CACHE_LIMIT_BYTES))
}

pub(crate) fn confined_cache_path(directory: &Path, stored_path: &Path) -> Option<PathBuf> {
    let relative = if stored_path.is_absolute() {
        stored_path.strip_prefix(directory).ok()?
    } else {
        stored_path
    };
    let mut has_filename = false;
    for component in relative.components() {
        match component {
            Component::Normal(_) => has_filename = true,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    has_filename.then(|| directory.join(relative))
}

/// Create or refresh a cache-object row. Payload bytes are written by the
/// caller, while this metadata operation remains independent and transactional.
pub fn upsert_cache_object(connection: &Connection, object: &CacheObject) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO cache_objects(
               id, source_key, path, total_size, etag, last_modified, complete,
               bytes_cached, last_accessed
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(source_key) DO UPDATE SET
               id=excluded.id, path=excluded.path, total_size=excluded.total_size,
               etag=excluded.etag, last_modified=excluded.last_modified,
               complete=excluded.complete, last_accessed=excluded.last_accessed",
            params![
                object.id,
                object.source_key,
                object.path,
                object
                    .total_size
                    .map(|value| value.min(i64::MAX as u64) as i64),
                object.etag,
                object.last_modified,
                i64::from(object.complete),
                object.bytes_cached.min(i64::MAX as u64) as i64,
                object.last_accessed,
            ],
        )
        .map_err(|error| format!("无法保存缓存对象: {error}"))?;
    Ok(())
}

/// Evict least-recently-used objects until aggregate cached bytes fit `limit`.
/// Returned paths are safe to remove after the database transaction commits.
pub fn evict_cache(
    connection: &mut Connection,
    directory: &Path,
    limit: u64,
) -> Result<Vec<PathBuf>, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启缓存淘汰事务: {error}"))?;
    let mut total: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(bytes_cached), 0) FROM cache_objects",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法计算缓存大小: {error}"))?;
    let mut removed = Vec::new();
    let limit_i64 = limit.min(i64::MAX as u64) as i64;
    while total > limit_i64 {
        let candidate: Option<(String, String, i64)> = transaction
            .query_row(
                "SELECT id, path, bytes_cached FROM cache_objects
                 ORDER BY last_accessed ASC, id ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("无法选择缓存淘汰对象: {error}"))?;
        let Some((id, path, bytes)) = candidate else {
            break;
        };
        transaction
            .execute("DELETE FROM cache_objects WHERE id=?1", params![id])
            .map_err(|error| format!("无法删除缓存索引: {error}"))?;
        total = total.saturating_sub(bytes.max(0));
        let candidate_path = PathBuf::from(path);
        if let Some(path) = confined_cache_path(directory, &candidate_path) {
            removed.push(path);
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交缓存淘汰事务: {error}"))?;
    for path in &removed {
        let _ = fs::remove_file(path);
    }
    Ok(removed)
}

/// Read cached ranges for a source. Used by the remote reader implementation.
pub fn cached_ranges(connection: &Connection, object_id: &str) -> Result<Vec<ByteRange>, String> {
    let mut statement = connection
        .prepare("SELECT start, end FROM cache_ranges WHERE object_id=?1 ORDER BY start")
        .map_err(|error| format!("无法读取缓存区间: {error}"))?;
    let rows = statement
        .query_map(params![object_id], |row| {
            Ok(ByteRange {
                start: row.get::<_, i64>(0)? as u64,
                end: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| format!("无法读取缓存区间: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析缓存区间: {error}"))
}

/// Touch a cache object after metadata or payload access so LRU reflects reads.
pub fn touch_cache_object(connection: &mut Connection, object_id: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE cache_objects SET last_accessed=?1 WHERE id=?2",
            params![now_ms(), object_id],
        )
        .map_err(|error| format!("无法更新缓存访问时间: {error}"))?;
    Ok(())
}

pub fn record_cached_range(
    connection: &mut Connection,
    object_id: &str,
    range: ByteRange,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启缓存事务: {error}"))?;
    let existing = {
        let mut statement = transaction
            .prepare("SELECT start, end FROM cache_ranges WHERE object_id=?1 ORDER BY start")
            .map_err(|error| format!("无法读取缓存区间: {error}"))?;
        let rows = statement
            .query_map(params![object_id], |row| {
                Ok(ByteRange {
                    start: row.get::<_, i64>(0)? as u64,
                    end: row.get::<_, i64>(1)? as u64,
                })
            })
            .map_err(|error| format!("无法读取缓存区间: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法解析缓存区间: {error}"))?
    };
    transaction
        .execute(
            "DELETE FROM cache_ranges WHERE object_id=?1",
            params![object_id],
        )
        .map_err(|error| format!("无法更新缓存区间: {error}"))?;
    for merged in merge_range(existing, range) {
        transaction
            .execute(
                "INSERT INTO cache_ranges(object_id, start, end) VALUES (?1, ?2, ?3)",
                params![object_id, merged.start as i64, merged.end as i64],
            )
            .map_err(|error| format!("无法写入缓存区间: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE cache_objects
             SET bytes_cached = COALESCE((SELECT SUM(end-start) FROM cache_ranges WHERE object_id=?1), 0),
                 last_accessed=?2
             WHERE id=?1",
            params![object_id, now_ms()],
        )
        .map_err(|error| format!("无法更新缓存访问时间: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交缓存事务: {error}"))?;
    Ok(())
}

pub fn find_cache_object(
    connection: &Connection,
    source_key: &str,
) -> Result<Option<(String, PathBuf)>, String> {
    connection
        .query_row(
            "SELECT id, path FROM cache_objects WHERE source_key=?1",
            params![source_key],
            |row| Ok((row.get(0)?, PathBuf::from(row.get::<_, String>(1)?))),
        )
        .optional()
        .map_err(|error| format!("无法读取缓存对象: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlapping_and_adjacent_ranges() {
        let ranges = vec![
            ByteRange::new(20, 30).unwrap(),
            ByteRange::new(0, 10).unwrap(),
        ];
        assert_eq!(
            merge_range(ranges, ByteRange::new(10, 20).unwrap()),
            vec![ByteRange { start: 0, end: 30 }]
        );
    }

    #[test]
    fn coverage_requires_the_requested_range_to_be_whole() {
        let ranges = vec![ByteRange { start: 10, end: 20 }];
        assert!(range_is_covered(&ranges, ByteRange::new(12, 18).unwrap()));
        assert!(!range_is_covered(&ranges, ByteRange::new(8, 18).unwrap()));
    }

    #[test]
    fn schema_is_idempotent_and_round_trips_sources() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        let now = now_ms();
        connection
            .execute(
                "INSERT INTO opds_sources(id,title,url,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                params!["source-1", "测试", "https://example.test/opds", now],
            )
            .unwrap();
        drop(connection);
        let reopened = database_for_tests(directory.path()).unwrap();
        let title: String = reopened
            .query_row(
                "SELECT title FROM opds_sources WHERE id='source-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "测试");
    }

    #[test]
    fn migrates_v3_library_items_to_comic_metadata_without_data_loss() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                INSERT INTO schema_meta(key, value) VALUES ('version', '3');
                CREATE TABLE opds_sources (
                  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
                  credential_ref TEXT, allow_http INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE library_items (
                  id TEXT PRIMARY KEY NOT NULL,
                  source_id TEXT REFERENCES opds_sources(id) ON DELETE CASCADE,
                  source_kind TEXT NOT NULL, title TEXT NOT NULL, authors_json TEXT NOT NULL,
                  cover_url TEXT, local_path TEXT, acquisition_url TEXT, media_type TEXT,
                  extension TEXT, size INTEGER, etag TEXT, last_modified TEXT,
                  updated_at INTEGER NOT NULL
                );
                INSERT INTO library_items(
                  id, source_kind, title, authors_json, local_path, extension, updated_at
                ) VALUES ('local:/comic.cbz', 'local', '旧漫画', '[]', '/comic.cbz', 'cbz', 1);
                ",
            )
            .unwrap();
        drop(legacy);

        let migrated = database_for_tests(directory.path()).unwrap();
        for column in [
            "series",
            "number",
            "volume",
            "page_count",
            "reading_direction",
            "cover_page",
        ] {
            assert!(table_has_column(&migrated, "library_items", column));
        }
        let (version, title): (i64, String) = (
            migrated
                .query_row(
                    "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            migrated
                .query_row(
                    "SELECT title FROM library_items WHERE id='local:/comic.cbz'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        assert_eq!(version, 5);
        assert_eq!(title, "旧漫画");
        assert!(table_exists(&migrated, "library_groups"));
        assert!(table_exists(&migrated, "library_group_members"));
        assert!(table_exists(&migrated, "library_smart_exclusions"));
    }

    fn seed_item(
        connection: &Connection,
        id: &str,
        title: &str,
        authors: &[&str],
        extension: &str,
        series: Option<&str>,
    ) {
        let authors_json = serde_json::to_string(authors).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(
                   id, source_kind, title, authors_json, extension, series, updated_at
                 ) VALUES (?1, 'local', ?2, ?3, ?4, ?5, 1)",
                params![id, title, authors_json, extension, series],
            )
            .unwrap();
    }

    fn member_ids(connection: &Connection, group_id: &str) -> Vec<String> {
        let mut ids = list_library_group_members(connection, Some(group_id))
            .unwrap()
            .into_iter()
            .map(|member| member.item_id)
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    fn group_by_smart_key<'a>(groups: &'a [LibraryGroup], smart_key: &str) -> &'a LibraryGroup {
        groups
            .iter()
            .find(|group| group.smart_key.as_deref() == Some(smart_key))
            .unwrap_or_else(|| panic!("missing smart group {smart_key}"))
    }

    #[test]
    fn migrates_v4_library_to_groups_without_data_loss() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                INSERT INTO schema_meta(key, value) VALUES ('version', '4');
                CREATE TABLE library_items (
                  id TEXT PRIMARY KEY NOT NULL,
                  source_id TEXT,
                  source_kind TEXT NOT NULL, title TEXT NOT NULL, authors_json TEXT NOT NULL,
                  cover_url TEXT, local_path TEXT, acquisition_url TEXT, media_type TEXT,
                  extension TEXT, size INTEGER, etag TEXT, last_modified TEXT,
                  series TEXT, number TEXT, volume TEXT, page_count INTEGER,
                  reading_direction TEXT, cover_page INTEGER,
                  updated_at INTEGER NOT NULL
                );
                INSERT INTO library_items(
                  id, source_kind, title, authors_json, extension, updated_at
                ) VALUES ('local:/kept.epub', 'local', '保留', '[]', 'epub', 1);
                ",
            )
            .unwrap();
        drop(legacy);

        let migrated = database_for_tests(directory.path()).unwrap();
        let (version, title): (i64, String) = (
            migrated
                .query_row(
                    "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            migrated
                .query_row(
                    "SELECT title FROM library_items WHERE id='local:/kept.epub'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        assert_eq!(version, 5);
        assert_eq!(title, "保留");
        assert!(table_exists(&migrated, "library_groups"));
    }

    #[test]
    fn nested_user_groups_keep_one_book_in_many_groups_and_delete_does_not_remove_books() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        seed_item(&connection, "book-1", "一书", &["甲"], "epub", None);
        let authors = upsert_library_group(
            &connection,
            LibraryGroup {
                id: "user:authors".into(),
                parent_id: None,
                name: "作者".into(),
                source: "user".into(),
                smart_key: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let author = upsert_library_group(
            &connection,
            LibraryGroup {
                id: "user:author-a".into(),
                parent_id: Some(authors.id.clone()),
                name: "甲".into(),
                source: "user".into(),
                smart_key: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let series = upsert_library_group(
            &connection,
            LibraryGroup {
                id: "user:series-a".into(),
                parent_id: None,
                name: "某系列".into(),
                source: "user".into(),
                smart_key: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        add_library_group_member(&connection, &author.id, "book-1", None).unwrap();
        add_library_group_member(&connection, &series.id, "book-1", None).unwrap();
        assert_eq!(member_ids(&connection, &author.id), vec!["book-1"]);
        assert_eq!(member_ids(&connection, &series.id), vec!["book-1"]);

        remove_library_group(&connection, &series.id).unwrap();
        let groups = list_library_groups(&connection).unwrap();
        assert!(groups.iter().all(|group| group.id != series.id));
        assert!(library_item_exists(&connection, "book-1").unwrap());
        assert_eq!(member_ids(&connection, &author.id), vec!["book-1"]);
        assert_eq!(author.parent_id.as_deref(), Some("user:authors"));
    }

    #[test]
    fn reserved_shelf_filters_cannot_be_renamed_or_deleted_as_user_groups() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        for id in RESERVED_SHELF_FILTERS {
            let error = upsert_library_group(
                &connection,
                LibraryGroup {
                    id: (*id).into(),
                    parent_id: None,
                    name: "改名".into(),
                    source: "user".into(),
                    smart_key: None,
                    created_at: 1,
                    updated_at: 1,
                },
            )
            .unwrap_err();
            assert!(error.contains("筛选项"), "{id}: {error}");
            assert!(remove_library_group(&connection, id).is_err());
            assert!(add_library_group_member(&connection, id, "book-1", None).is_err());
        }
        assert!(list_library_groups(&connection).unwrap().is_empty());
    }

    #[test]
    fn organize_creates_author_filename_series_and_kind_groups_without_writing_item_series() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        seed_item(
            &connection,
            "text-1",
            "地狱模式 - 01",
            &["某作者"],
            "epub",
            None,
        );
        seed_item(&connection, "comic-1", "画集", &[], "cbz", None);
        organize_library_groups(
            &connection,
            &[LibraryOrganizeHint {
                item_id: "text-1".into(),
                authors: vec!["某作者".into()],
                series_stem: Some("地狱模式".into()),
                kind: Some("text".into()),
                content_hash: None,
            }],
        )
        .unwrap();

        let groups = list_library_groups(&connection).unwrap();
        let authors_root = group_by_smart_key(&groups, SMART_KEY_AUTHORS_ROOT);
        let series_root = group_by_smart_key(&groups, SMART_KEY_SERIES_ROOT);
        let author = group_by_smart_key(&groups, "author:某作者");
        let series = group_by_smart_key(&groups, "series:地狱模式");
        let text = group_by_smart_key(&groups, SMART_KEY_KIND_TEXT);
        let comic = group_by_smart_key(&groups, SMART_KEY_KIND_COMIC);
        assert_eq!(author.parent_id.as_deref(), Some(authors_root.id.as_str()));
        assert_eq!(series.parent_id.as_deref(), Some(series_root.id.as_str()));
        assert_eq!(member_ids(&connection, &author.id), vec!["text-1"]);
        assert_eq!(member_ids(&connection, &series.id), vec!["text-1"]);
        assert_eq!(member_ids(&connection, &text.id), vec!["text-1"]);
        assert_eq!(member_ids(&connection, &comic.id), vec!["comic-1"]);

        let stored_series: Option<String> = connection
            .query_row(
                "SELECT series FROM library_items WHERE id='text-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_series, None);
        let comic_item = load_all_library_items(&connection)
            .unwrap()
            .into_iter()
            .find(|item| item.id == "comic-1")
            .unwrap();
        assert_eq!(classify_library_kind(&comic_item), "comic");
        let text_item = load_all_library_items(&connection)
            .unwrap()
            .into_iter()
            .find(|item| item.id == "text-1")
            .unwrap();
        assert_eq!(classify_library_kind(&text_item), "text");
    }

    #[test]
    fn organize_does_not_use_item_series_as_filename_series_group() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        seed_item(
            &connection,
            "text-1",
            "散文",
            &["作者"],
            "epub",
            Some("漫画元数据系列"),
        );
        organize_library_groups(&connection, &[]).unwrap();
        let groups = list_library_groups(&connection).unwrap();
        assert!(groups
            .iter()
            .all(|group| group.smart_key.as_deref() != Some("series:漫画元数据系列")));
        let comic = group_by_smart_key(&groups, SMART_KEY_KIND_COMIC);
        assert_eq!(member_ids(&connection, &comic.id), vec!["text-1"]);
    }

    #[test]
    fn organize_does_not_readd_a_book_removed_from_a_smart_group() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        seed_item(&connection, "book-1", "一书", &["甲", "乙"], "epub", None);
        let hints = [LibraryOrganizeHint {
            item_id: "book-1".into(),
            authors: vec!["甲".into(), "乙".into()],
            series_stem: Some("一书".into()),
            kind: Some("text".into()),
            content_hash: None,
        }];
        organize_library_groups(&connection, &hints).unwrap();
        let groups = list_library_groups(&connection).unwrap();
        let author_a = group_by_smart_key(&groups, "author:甲").id.clone();
        let author_b = group_by_smart_key(&groups, "author:乙").id.clone();
        let series = group_by_smart_key(&groups, "series:一书").id.clone();
        remove_library_group_member(&connection, &author_a, "book-1").unwrap();
        organize_library_groups(&connection, &hints).unwrap();
        assert!(member_ids(&connection, &author_a).is_empty());
        assert_eq!(member_ids(&connection, &author_b), vec!["book-1"]);
        assert_eq!(member_ids(&connection, &series), vec!["book-1"]);
        assert!(library_item_exists(&connection, "book-1").unwrap());
    }

    #[test]
    fn renaming_or_nesting_a_smart_group_keeps_its_stable_key() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        seed_item(&connection, "book-1", "一书", &["甲"], "epub", None);
        organize_library_groups(
            &connection,
            &[LibraryOrganizeHint {
                item_id: "book-1".into(),
                authors: vec!["甲".into()],
                series_stem: None,
                kind: Some("text".into()),
                content_hash: None,
            }],
        )
        .unwrap();
        let groups = list_library_groups(&connection).unwrap();
        let author = group_by_smart_key(&groups, "author:甲").clone();
        let folder = upsert_library_group(
            &connection,
            LibraryGroup {
                id: "user:folder".into(),
                parent_id: None,
                name: "手建".into(),
                source: "user".into(),
                smart_key: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        let renamed = upsert_library_group(
            &connection,
            LibraryGroup {
                id: author.id.clone(),
                parent_id: Some(folder.id.clone()),
                name: "改名作者".into(),
                source: "user".into(),
                smart_key: None,
                created_at: 99,
                updated_at: 99,
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "改名作者");
        assert_eq!(renamed.source, "smart");
        assert_eq!(renamed.smart_key.as_deref(), Some("author:甲"));
        assert_eq!(renamed.parent_id.as_deref(), Some(folder.id.as_str()));
    }

    #[test]
    fn cache_ranges_are_transactional_and_lru_evicts_oldest_object() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = database_for_tests(directory.path()).unwrap();
        let first_path = directory.path().join("first.bin");
        let second_path = directory.path().join("second.bin");
        fs::write(&first_path, [0u8; 4]).unwrap();
        fs::write(&second_path, [0u8; 4]).unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "first".into(),
                source_key: "url:first".into(),
                path: first_path.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: false,
                bytes_cached: 4,
                last_accessed: 1,
            },
        )
        .unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "second".into(),
                source_key: "url:second".into(),
                path: second_path.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: false,
                bytes_cached: 4,
                last_accessed: 2,
            },
        )
        .unwrap();
        record_cached_range(&mut connection, "first", ByteRange::new(0, 4).unwrap()).unwrap();
        connection
            .execute(
                "UPDATE cache_objects SET last_accessed=1 WHERE id='first'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE cache_objects SET last_accessed=2 WHERE id='second'",
                [],
            )
            .unwrap();
        assert!(range_is_covered(
            &cached_ranges(&connection, "first").unwrap(),
            ByteRange::new(1, 3).unwrap()
        ));
        touch_cache_object(&mut connection, "first").unwrap();
        let removed = evict_cache(&mut connection, directory.path(), 4).unwrap();
        assert_eq!(removed, vec![second_path]);
        assert!(find_cache_object(&connection, "url:first")
            .unwrap()
            .is_some());
        assert!(find_cache_object(&connection, "url:second")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rebuilds_a_database_that_passes_open_but_fails_quick_check() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(DATABASE_FILE);
        fs::write(&path, b"not a sqlite database").unwrap();

        let connection = database_for_tests(directory.path()).unwrap();
        let version: String = connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key='version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert!(directory
            .path()
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt.")));
    }

    #[test]
    fn lru_never_deletes_a_path_outside_the_cache_directory() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let outside = directory.path().join("keep.bin");
        fs::write(&outside, [0_u8; 4]).unwrap();
        let mut connection = database_for_tests(directory.path()).unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "unsafe".into(),
                source_key: "unsafe-source".into(),
                path: outside.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: true,
                bytes_cached: 4,
                last_accessed: 1,
            },
        )
        .unwrap();

        assert!(evict_cache(&mut connection, &cache, 0).unwrap().is_empty());
        assert!(outside.is_file());
        assert!(find_cache_object(&connection, "unsafe-source")
            .unwrap()
            .is_none());
    }
}
