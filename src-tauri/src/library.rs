//! Persistent library metadata and bounded sparse-cache index.
//!
//! The database intentionally stores metadata and byte ranges only. Payload bytes
//! live below the application cache directory, and credentials are never written
//! here. The pure range helpers are kept independent from Tauri so they can be
//! tested without a running application.

use crate::sync;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DATABASE_FILE: &str = "library.sqlite3";
pub const CACHE_DIRECTORY: &str = "remote-cache";
pub const DEFAULT_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const SCHEMA_VERSION: i64 = 8;
const CACHE_LIMIT_KEY: &str = "cache_limit_bytes";

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
    #[serde(default)]
    pub blob_hash: Option<String>,
    #[serde(default = "default_library_availability")]
    pub availability: String,
    #[serde(default)]
    pub offline_pinned: bool,
    #[serde(default)]
    pub subjects: Vec<String>,
    pub updated_at: i64,
}

fn default_library_availability() -> String {
    "external".to_string()
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

fn schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='version'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取书库数据库版本: {error}"))
}

fn managed_assets_use_path_identity(connection: &Connection) -> bool {
    connection
        .prepare("PRAGMA table_info(managed_assets)")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
            })?;
            let columns = rows.collect::<Result<Vec<_>, _>>()?;
            Ok(columns
                .iter()
                .any(|(name, primary_key)| name == "relative_path" && *primary_key == 1)
                && columns
                    .iter()
                    .any(|(name, primary_key)| name == "hash" && *primary_key == 0))
        })
        .unwrap_or(false)
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1
             )",
            params![table],
            |row| row.get(0),
        )
        .unwrap_or(false)
}

/// The first v8 implementation made `content_hash` unique.  That is not a
/// valid identity for a managed document: two files with the same contents
/// still need independent stable UUIDs.  SQLite cannot drop an inline UNIQUE
/// constraint, so rebuild the parent and its known foreign-key children when
/// opening a database created by that implementation.
fn managed_documents_use_content_hash_identity(connection: &Connection) -> bool {
    let Ok(mut statement) = connection.prepare("PRAGMA index_list(managed_documents)") else {
        return false;
    };
    let indexes = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0))
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>());
    let Ok(indexes) = indexes else {
        return false;
    };
    indexes.into_iter().any(|(name, unique)| {
        if !unique {
            return false;
        }
        let escaped = name.replace('\'', "''");
        let pragma = format!("PRAGMA index_info('{escaped}')");
        let Ok(mut info) = connection.prepare(&pragma) else {
            return false;
        };
        let columns = info
            .query_map([], |row| row.get::<_, String>(2))
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .unwrap_or_default();
        columns.len() == 1 && columns[0] == "content_hash"
    })
}

fn ensure_managed_document_schema(connection: &mut Connection) -> Result<(), String> {
    if !managed_documents_use_content_hash_identity(connection) {
        return Ok(());
    }

    // Foreign-key enforcement must be disabled while the old parent table is
    // replaced.  The operation itself remains one SQLite transaction; the
    // pragma is restored on every exit path below.
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .map_err(|error| format!("无法暂时关闭文档外键约束: {error}"))?;
    let has_versions = table_exists(connection, "document_versions");
    let has_drafts = table_exists(connection, "document_drafts");
    let result = (|| {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开启文档表修复事务: {error}"))?;

        for (table, index) in [
            ("managed_documents", "managed_documents_updated_idx"),
            ("managed_documents", "managed_documents_content_hash_idx"),
            ("document_versions", "document_versions_document_idx"),
            ("document_drafts", "document_drafts_document_idx"),
        ] {
            transaction
                .execute(&format!("DROP INDEX IF EXISTS {index}"), [])
                .map_err(|error| format!("无法移除旧文档索引 {table}/{index}: {error}"))?;
        }

        if has_versions {
            transaction
                .execute(
                    "ALTER TABLE document_versions RENAME TO document_versions_v8_old",
                    [],
                )
                .map_err(|error| format!("无法暂存旧文档版本表: {error}"))?;
        }
        if has_drafts {
            transaction
                .execute(
                    "ALTER TABLE document_drafts RENAME TO document_drafts_v8_old",
                    [],
                )
                .map_err(|error| format!("无法暂存旧文档草稿表: {error}"))?;
        }
        transaction
            .execute(
                "ALTER TABLE managed_documents RENAME TO managed_documents_v8_old",
                [],
            )
            .map_err(|error| format!("无法暂存旧受管文档表: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE managed_documents (
                   id TEXT PRIMARY KEY NOT NULL,
                   content_hash TEXT NOT NULL,
                   title TEXT NOT NULL,
                   local_path TEXT,
                   availability TEXT NOT NULL DEFAULT 'local',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO managed_documents(
                   id,content_hash,title,local_path,availability,created_at,updated_at
                 ) SELECT id,content_hash,title,local_path,availability,created_at,updated_at
                   FROM managed_documents_v8_old;
                 DROP TABLE managed_documents_v8_old;",
            )
            .map_err(|error| format!("无法重建受管文档表: {error}"))?;

        if has_versions {
            transaction
                .execute_batch(
                    "CREATE TABLE document_versions (
                       id TEXT PRIMARY KEY NOT NULL,
                       document_id TEXT NOT NULL REFERENCES managed_documents(id) ON DELETE CASCADE,
                       blob_hash TEXT NOT NULL,
                       size INTEGER NOT NULL CHECK(size >= 0),
                       device_id TEXT,
                       created_at INTEGER NOT NULL,
                       is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1))
                     );
                     INSERT INTO document_versions(
                       id,document_id,blob_hash,size,device_id,created_at,is_current
                     ) SELECT id,document_id,blob_hash,size,device_id,created_at,is_current
                       FROM document_versions_v8_old;
                     DROP TABLE document_versions_v8_old;
                     CREATE INDEX document_versions_document_idx
                       ON document_versions(document_id,created_at DESC);",
                )
                .map_err(|error| format!("无法重建文档版本表: {error}"))?;
        }
        if has_drafts {
            transaction
                .execute_batch(
                    "CREATE TABLE document_drafts (
                       id TEXT PRIMARY KEY NOT NULL,
                       document_id TEXT REFERENCES managed_documents(id) ON DELETE CASCADE,
                       blob_hash TEXT NOT NULL,
                       title TEXT,
                       device_id TEXT NOT NULL,
                       created_at INTEGER NOT NULL,
                       updated_at INTEGER NOT NULL
                     );
                     INSERT INTO document_drafts(
                       id,document_id,blob_hash,title,device_id,created_at,updated_at
                     ) SELECT id,document_id,blob_hash,title,device_id,created_at,updated_at
                       FROM document_drafts_v8_old;
                     DROP TABLE document_drafts_v8_old;
                     CREATE INDEX document_drafts_document_idx
                       ON document_drafts(document_id,updated_at DESC);",
                )
                .map_err(|error| format!("无法重建文档草稿表: {error}"))?;
        }
        transaction
            .execute_batch(
                "CREATE INDEX managed_documents_updated_idx
                   ON managed_documents(updated_at DESC);
                 CREATE INDEX managed_documents_content_hash_idx
                   ON managed_documents(content_hash);",
            )
            .map_err(|error| format!("无法重建受管文档索引: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交受管文档表修复: {error}"))
    })();
    let restore = connection.pragma_update(None, "foreign_keys", "ON");
    result.and_then(|_| {
        restore.map_err(|error| format!("无法恢复文档外键约束: {error}"))?;
        Ok(())
    })
}

fn ensure_managed_asset_schema(connection: &mut Connection) -> Result<(), String> {
    if !table_exists(connection, "managed_assets") {
        connection
            .execute_batch(
                "CREATE TABLE managed_assets (
                   relative_path TEXT PRIMARY KEY NOT NULL,
                   hash TEXT NOT NULL,
                   size INTEGER NOT NULL CHECK(size >= 0),
                   media_type TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX managed_assets_hash_idx ON managed_assets(hash);",
            )
            .map_err(|error| format!("无法补建受管资源表: {error}"))?;
        return Ok(());
    }
    if managed_assets_use_path_identity(connection) {
        connection
            .execute(
                "CREATE INDEX IF NOT EXISTS managed_assets_hash_idx ON managed_assets(hash)",
                [],
            )
            .map_err(|error| format!("无法创建受管资源哈希索引: {error}"))?;
        return Ok(());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启受管资源表修复事务: {error}"))?;
    transaction
        .execute_batch(
            "DROP TABLE IF EXISTS managed_assets_v8_rebuild;
             CREATE TABLE managed_assets_v8_rebuild (
               relative_path TEXT PRIMARY KEY NOT NULL,
               hash TEXT NOT NULL,
               size INTEGER NOT NULL CHECK(size >= 0),
               media_type TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO managed_assets_v8_rebuild(
               relative_path,hash,size,media_type,created_at,updated_at
             ) SELECT relative_path,hash,size,media_type,created_at,updated_at
               FROM managed_assets;
             DROP TABLE managed_assets;
             ALTER TABLE managed_assets_v8_rebuild RENAME TO managed_assets;
             CREATE INDEX managed_assets_hash_idx ON managed_assets(hash);",
        )
        .map_err(|error| format!("无法修复受管资源表: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交受管资源表修复: {error}"))
}

fn migrate_schema(connection: &mut Connection) -> Result<(), String> {
    let mut version = schema_version(connection)?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "书库数据库版本 {version} 高于当前支持的版本 {SCHEMA_VERSION}"
        ));
    }
    while version < SCHEMA_VERSION {
        let target = version + 1;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("无法开启书库迁移事务: {error}"))?;
        match target {
            2 => {
                if !table_has_column(&transaction, "opds_sources", "allow_http") {
                    transaction
                        .execute(
                            "ALTER TABLE opds_sources ADD COLUMN allow_http INTEGER NOT NULL DEFAULT 0",
                            [],
                        )
                        .map_err(|error| format!("无法迁移 OPDS 源协议设置: {error}"))?;
                }
            }
            3 => {
                transaction
                    .execute(
                        "INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', ?1)
                         ON CONFLICT(key) DO NOTHING",
                        params![DEFAULT_CACHE_LIMIT_BYTES as i64],
                    )
                    .map_err(|error| format!("无法迁移书库缓存设置: {error}"))?;
            }
            4 => {
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
            }
            5 => {
                for (column, definition) in [
                    ("blob_hash", "blob_hash TEXT"),
                    (
                        "availability",
                        "availability TEXT NOT NULL DEFAULT 'external'",
                    ),
                    (
                        "offline_pinned",
                        "offline_pinned INTEGER NOT NULL DEFAULT 0",
                    ),
                    ("subjects_json", "subjects_json TEXT NOT NULL DEFAULT '[]'"),
                ] {
                    if !table_has_column(&transaction, "library_items", column) {
                        transaction
                            .execute(
                                &format!("ALTER TABLE library_items ADD COLUMN {definition}"),
                                [],
                            )
                            .map_err(|error| format!("无法迁移受管书籍字段 {column}: {error}"))?;
                    }
                }
                transaction
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS managed_blobs (
                           hash TEXT PRIMARY KEY NOT NULL,
                           relative_path TEXT NOT NULL UNIQUE,
                           size INTEGER NOT NULL CHECK(size >= 0),
                           created_at INTEGER NOT NULL,
                           last_verified_at INTEGER NOT NULL
                         );
                         CREATE TABLE IF NOT EXISTS library_item_aliases (
                           alias_id TEXT PRIMARY KEY NOT NULL,
                           item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE
                         );
                         CREATE INDEX IF NOT EXISTS library_items_blob_idx
                           ON library_items(blob_hash);",
                    )
                    .map_err(|error| format!("无法创建受管内容表: {error}"))?;
                transaction
                    .execute(
                        "UPDATE library_items SET availability =
                           CASE WHEN source_kind='local' THEN 'external' ELSE 'remote' END
                         WHERE blob_hash IS NULL",
                        [],
                    )
                    .map_err(|error| format!("无法迁移书籍可用状态: {error}"))?;
            }
            6 => {
                transaction
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS library_groups (
                           id TEXT PRIMARY KEY NOT NULL,
                           parent_id TEXT REFERENCES library_groups(id) ON DELETE SET NULL,
                           name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
                           kind TEXT NOT NULL CHECK(kind IN ('custom', 'smart')),
                           rule_json TEXT,
                           sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
                           created_at INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL
                         );
                         CREATE INDEX IF NOT EXISTS library_groups_parent_idx
                           ON library_groups(parent_id, sort_order, id);
                         CREATE TABLE IF NOT EXISTS library_group_members (
                           group_id TEXT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
                           item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
                           created_at INTEGER NOT NULL,
                           PRIMARY KEY(group_id, item_id)
                         );
                         CREATE INDEX IF NOT EXISTS library_group_members_item_idx
                           ON library_group_members(item_id, group_id);",
                    )
                    .map_err(|error| format!("无法创建书架分组表: {error}"))?;
            }
            7 => {
                transaction
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS sync_records (
                           record_id TEXT PRIMARY KEY NOT NULL,
                           object_id TEXT NOT NULL,
                           field TEXT NOT NULL,
                           value_json TEXT,
                           device_id TEXT NOT NULL,
                           version INTEGER NOT NULL CHECK(version >= 0),
                           context_json TEXT NOT NULL DEFAULT '{}',
                           modified_at INTEGER NOT NULL,
                           tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
                           UNIQUE(object_id, field, device_id)
                         );
                         CREATE INDEX IF NOT EXISTS sync_records_object_idx
                           ON sync_records(object_id, field, modified_at DESC);
                         CREATE TABLE IF NOT EXISTS sync_conflicts (
                           id TEXT PRIMARY KEY NOT NULL,
                           object_id TEXT NOT NULL,
                           field TEXT NOT NULL,
                           winner_json TEXT,
                           loser_json TEXT,
                           winner_device_id TEXT NOT NULL,
                           loser_device_id TEXT NOT NULL,
                           created_at INTEGER NOT NULL,
                           resolved_at INTEGER
                         );
                         CREATE INDEX IF NOT EXISTS sync_conflicts_open_idx
                           ON sync_conflicts(resolved_at, created_at DESC);
                         CREATE TABLE IF NOT EXISTS sync_meta (
                           key TEXT PRIMARY KEY NOT NULL,
                           value TEXT NOT NULL
                         );",
                    )
                    .map_err(|error| format!("无法创建同步记录表: {error}"))?;
            }
            8 => {
                transaction
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS managed_documents (
                           id TEXT PRIMARY KEY NOT NULL,
                           content_hash TEXT NOT NULL,
                           title TEXT NOT NULL,
                           local_path TEXT,
                           availability TEXT NOT NULL DEFAULT 'local',
                           created_at INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL
                         );
                         CREATE INDEX IF NOT EXISTS managed_documents_updated_idx
                           ON managed_documents(updated_at DESC);
                         CREATE INDEX IF NOT EXISTS managed_documents_content_hash_idx
                           ON managed_documents(content_hash);
                         CREATE TABLE IF NOT EXISTS managed_assets (
                           relative_path TEXT PRIMARY KEY NOT NULL,
                           hash TEXT NOT NULL,
                           size INTEGER NOT NULL CHECK(size >= 0),
                           media_type TEXT,
                           created_at INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL
                         );
                         CREATE INDEX IF NOT EXISTS managed_assets_hash_idx
                           ON managed_assets(hash);
                         CREATE TABLE IF NOT EXISTS document_versions (
                           id TEXT PRIMARY KEY NOT NULL,
                           document_id TEXT NOT NULL REFERENCES managed_documents(id) ON DELETE CASCADE,
                           blob_hash TEXT NOT NULL,
                           size INTEGER NOT NULL CHECK(size >= 0),
                           device_id TEXT,
                           created_at INTEGER NOT NULL,
                           is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1))
                         );
                         CREATE INDEX IF NOT EXISTS document_versions_document_idx
                           ON document_versions(document_id, created_at DESC);
                         CREATE TABLE IF NOT EXISTS document_drafts (
                           id TEXT PRIMARY KEY NOT NULL,
                           document_id TEXT REFERENCES managed_documents(id) ON DELETE CASCADE,
                           blob_hash TEXT NOT NULL,
                           title TEXT,
                           device_id TEXT NOT NULL,
                           created_at INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL
                         );
                         CREATE INDEX IF NOT EXISTS document_drafts_document_idx
                           ON document_drafts(document_id, updated_at DESC);",
                    )
                    .map_err(|error| format!("无法创建受管文档表: {error}"))?;
            }
            _ => return Err(format!("缺少书库数据库 v{target} 迁移实现")),
        }
        transaction
            .execute(
                "UPDATE schema_meta SET value=?1 WHERE key='version'",
                params![target.to_string()],
            )
            .map_err(|error| format!("无法更新书库数据库版本: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法提交书库 v{target} 迁移事务: {error}"))?;
        version = target;
    }
    Ok(())
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
            -- 新数据库先建立 v4 基线，再与已有 v4 数据库走同一条迁移链。
            INSERT INTO schema_meta(key, value) VALUES ('version', '4')
              ON CONFLICT(key) DO NOTHING;
            INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', '2147483648')
              ON CONFLICT(key) DO NOTHING;
            ",
        )
        .map_err(|error| format!("无法初始化书库数据库: {error}"))?;
    migrate_schema(&mut connection)?;
    ensure_managed_asset_schema(&mut connection)?;
    ensure_managed_document_schema(&mut connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS library_items_blob_idx ON library_items(blob_hash)",
            [],
        )
        .map_err(|error| format!("无法创建受管内容索引: {error}"))?;
    crate::groups::ensure_smart_groups(&connection)?;
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
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启 OPDS 源删除事务: {error}"))?;
    let item_ids = transaction
        .prepare("SELECT id FROM library_items WHERE source_id=?1 ORDER BY id")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![&source_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("无法读取 OPDS 源书籍: {error}"))?;
    for item_id in &item_ids {
        let group_ids = transaction
            .prepare(
                "SELECT group_id FROM library_group_members WHERE item_id=?1 ORDER BY group_id",
            )
            .and_then(|mut statement| {
                let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| format!("无法读取 OPDS 源书籍分组: {error}"))?;
        for group_id in group_ids {
            sync::write_membership_record_at(&transaction, &group_id, item_id, false)?;
        }
        sync::write_library_item_record_at(&transaction, item_id, false)?;
    }
    transaction
        .execute(
            "DELETE FROM opds_sources WHERE id = ?1",
            params![&source_id],
        )
        .map_err(|error| format!("无法删除 OPDS 源: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交 OPDS 源删除: {error}"))
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
                    reading_direction, cover_page, blob_hash, availability,
                    offline_pinned, subjects_json, updated_at
             FROM library_items
             WHERE (?1 IS NULL OR source_id = ?1)
             ORDER BY updated_at DESC, title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    let rows = statement
        .query_map(params![source_id], |row| {
            let authors_json: String = row.get(4)?;
            let authors = serde_json::from_str(&authors_json).unwrap_or_default();
            let subjects_json: String = row.get(22)?;
            let subjects = serde_json::from_str(&subjects_json).unwrap_or_default();
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
                blob_hash: row.get(19)?,
                availability: row.get(20)?,
                offline_pinned: row.get::<_, i64>(21)? != 0,
                subjects,
                updated_at: row.get(23)?,
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
    let subjects_json = serde_json::to_string(&item.subjects)
        .map_err(|error| format!("无法序列化主题信息: {error}"))?;
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
               reading_direction, cover_page, blob_hash, availability,
               offline_pinned, subjects_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                       ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
             ON CONFLICT(id) DO UPDATE SET
               source_id=?2, source_kind=?3, title=?4, authors_json=?5,
               cover_url=?6, local_path=?7, acquisition_url=?8, media_type=?9,
               extension=?10, size=?11, etag=?12, last_modified=?13,
               series=COALESCE(?14, series), number=COALESCE(?15, number),
               volume=COALESCE(?16, volume), page_count=COALESCE(?17, page_count),
               reading_direction=COALESCE(?18, reading_direction),
               cover_page=COALESCE(?19, cover_page), blob_hash=COALESCE(?20, blob_hash),
               availability=?21, offline_pinned=?22, subjects_json=?23, updated_at=?24",
            params![
                item.id.clone(),
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
                item.blob_hash,
                item.availability,
                i64::from(item.offline_pinned),
                subjects_json,
                item.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存书库条目: {error}"))?;
    sync::write_library_item_record_at(&transaction, &item.id, true)?;
    sync::write_library_item_offline_pinned_record_at(&transaction, &item.id, item.offline_pinned)?;
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
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启漫画元数据事务: {error}"))?;
    let resolved_id = transaction
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析书籍标识: {error}"))?
        .unwrap_or_else(|| item_id.clone());
    let changed = transaction
        .execute(
            "UPDATE library_items SET
               series=?2, number=?3, volume=?4, page_count=?5,
               reading_direction=?6, cover_page=?7, updated_at=?8
             WHERE id=?1",
            params![
                resolved_id,
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
    if changed == 0 {
        return Err("书籍不存在".to_string());
    }
    sync::write_library_item_record_at(&transaction, &resolved_id, true)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交漫画元数据: {error}"))
}

#[tauri::command]
pub fn library_set_offline_pinned(
    app: AppHandle,
    item_id: String,
    pinned: bool,
) -> Result<(), String> {
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启离线保留事务: {error}"))?;
    let resolved_id = transaction
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析书籍标识: {error}"))?
        .unwrap_or_else(|| item_id.clone());
    let changed = transaction
        .execute(
            "UPDATE library_items SET offline_pinned=?1,updated_at=?2 WHERE id=?3",
            params![i64::from(pinned), now_ms(), &resolved_id],
        )
        .map_err(|error| format!("无法更新离线保留设置: {error}"))?;
    if changed == 0 {
        return Err("书籍不存在".to_string());
    }
    sync::write_library_item_offline_pinned_record_at(&transaction, &resolved_id, pinned)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交离线保留设置: {error}"))
}

#[tauri::command]
pub fn library_remove_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启书籍删除事务: {error}"))?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM library_items WHERE id=?1)",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法检查书籍: {error}"))?;
    if !exists {
        return Err("书籍不存在".to_string());
    }
    let memberships = transaction
        .prepare("SELECT group_id FROM library_group_members WHERE item_id=?1")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("无法读取书籍分组: {error}"))?;
    sync::write_library_item_record_at(&transaction, &item_id, false)?;
    for group_id in memberships {
        sync::write_membership_record_at(&transaction, &group_id, &item_id, false)?;
    }
    transaction
        .execute("DELETE FROM library_items WHERE id = ?1", params![item_id])
        .map_err(|error| format!("无法删除书库条目: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交书籍删除: {error}"))
}

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
    fn repairs_the_early_v8_document_hash_unique_constraint() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = database_for_tests(directory.path()).unwrap();
        let hash = "a".repeat(64);
        legacy.pragma_update(None, "foreign_keys", "OFF").unwrap();
        legacy
            .execute_batch(
                "
                DROP TABLE document_versions;
                DROP TABLE document_drafts;
                DROP TABLE managed_documents;
                CREATE TABLE managed_documents (
                  id TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL UNIQUE,
                  title TEXT NOT NULL, local_path TEXT,
                  availability TEXT NOT NULL DEFAULT 'local',
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE document_versions (
                  id TEXT PRIMARY KEY NOT NULL,
                  document_id TEXT NOT NULL REFERENCES managed_documents(id) ON DELETE CASCADE,
                  blob_hash TEXT NOT NULL, size INTEGER NOT NULL,
                  device_id TEXT, created_at INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE document_drafts (
                  id TEXT PRIMARY KEY NOT NULL,
                  document_id TEXT REFERENCES managed_documents(id) ON DELETE CASCADE,
                  blob_hash TEXT NOT NULL, title TEXT, device_id TEXT NOT NULL,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                ",
            )
            .unwrap();
        legacy
            .execute(
                "INSERT INTO managed_documents(
                   id,content_hash,title,created_at,updated_at
                 ) VALUES (?1,?2,'one',1,1)",
                params!["11111111-1111-4111-8111-111111111111", &hash],
            )
            .unwrap();
        legacy
            .execute(
                "INSERT INTO document_versions(
                   id,document_id,blob_hash,size,created_at,is_current
                 ) VALUES (?1,?2,?3,3,1,1)",
                params![
                    "22222222-2222-4222-8222-222222222222",
                    "11111111-1111-4111-8111-111111111111",
                    &hash
                ],
            )
            .unwrap();
        drop(legacy);

        let repaired = database_for_tests(directory.path()).unwrap();
        repaired
            .execute(
                "INSERT INTO managed_documents(
                   id,content_hash,title,created_at,updated_at
                ) VALUES (?1,?2,'two',2,2)",
                params!["33333333-3333-4333-8333-333333333333", &hash],
            )
            .unwrap();
        let version_count: i64 = repaired
            .query_row("SELECT COUNT(*) FROM document_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version_count, 1);
        assert!(repaired
            .query_row(
                "SELECT 1 FROM document_versions WHERE document_id=?1",
                params!["11111111-1111-4111-8111-111111111111"],
                |_| Ok(1),
            )
            .is_ok());
        assert!(!managed_documents_use_content_hash_identity(&repaired));
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
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(title, "旧漫画");
    }

    #[test]
    fn migrates_each_schema_version_in_order() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                INSERT INTO schema_meta(key, value) VALUES ('version', '1');
                CREATE TABLE opds_sources (
                  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
                  credential_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE library_items (
                  id TEXT PRIMARY KEY NOT NULL, source_id TEXT, source_kind TEXT NOT NULL,
                  title TEXT NOT NULL, authors_json TEXT NOT NULL, cover_url TEXT,
                  local_path TEXT, acquisition_url TEXT, media_type TEXT, extension TEXT,
                  size INTEGER, etag TEXT, last_modified TEXT, updated_at INTEGER NOT NULL
                );
                ",
            )
            .unwrap();
        drop(legacy);

        let migrated = database_for_tests(directory.path()).unwrap();
        assert_eq!(schema_version(&migrated).unwrap(), SCHEMA_VERSION);
        assert!(table_has_column(&migrated, "opds_sources", "allow_http"));
        assert!(table_has_column(&migrated, "library_items", "cover_page"));
        let cache_limit: i64 = migrated
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='cache_limit_bytes'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cache_limit, DEFAULT_CACHE_LIMIT_BYTES as i64);
    }

    #[test]
    fn migrates_v6_to_sync_record_schema_without_losing_library_rows() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = Connection::open(directory.path().join(DATABASE_FILE)).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                INSERT INTO schema_meta(key, value) VALUES ('version', '6');
                CREATE TABLE opds_sources (
                  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
                  credential_ref TEXT, allow_http INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE library_items (
                  id TEXT PRIMARY KEY NOT NULL, source_id TEXT, source_kind TEXT NOT NULL,
                  title TEXT NOT NULL, authors_json TEXT NOT NULL, cover_url TEXT,
                  local_path TEXT, acquisition_url TEXT, media_type TEXT, extension TEXT,
                  size INTEGER, etag TEXT, last_modified TEXT, series TEXT, number TEXT,
                  volume TEXT, page_count INTEGER, reading_direction TEXT, cover_page INTEGER,
                  blob_hash TEXT, availability TEXT NOT NULL DEFAULT 'external',
                  offline_pinned INTEGER NOT NULL DEFAULT 0,
                  subjects_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
                );
                INSERT INTO library_items(id,source_kind,title,authors_json,updated_at)
                  VALUES ('managed:old','managed','旧书','[]',1);
                CREATE TABLE managed_blobs (
                  hash TEXT PRIMARY KEY NOT NULL, relative_path TEXT NOT NULL UNIQUE,
                  size INTEGER NOT NULL, created_at INTEGER NOT NULL,last_verified_at INTEGER NOT NULL
                );
                CREATE TABLE library_item_aliases (alias_id TEXT PRIMARY KEY NOT NULL,item_id TEXT NOT NULL);
                CREATE TABLE library_groups (
                  id TEXT PRIMARY KEY NOT NULL,parent_id TEXT,name TEXT NOT NULL,kind TEXT NOT NULL,
                  rule_json TEXT,sort_order INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
                );
                CREATE TABLE library_group_members (
                  group_id TEXT NOT NULL,item_id TEXT NOT NULL,created_at INTEGER NOT NULL,
                  PRIMARY KEY(group_id,item_id)
                );
                ",
            )
            .unwrap();
        drop(legacy);

        let migrated = database_for_tests(directory.path()).unwrap();
        assert_eq!(schema_version(&migrated).unwrap(), SCHEMA_VERSION);
        assert!(table_has_column(&migrated, "sync_records", "context_json"));
        assert!(table_has_column(
            &migrated,
            "sync_conflicts",
            "winner_device_id"
        ));
        assert!(table_has_column(
            &migrated,
            "managed_documents",
            "content_hash"
        ));
        let title: String = migrated
            .query_row(
                "SELECT title FROM library_items WHERE id='managed:old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "旧书");
    }

    #[test]
    fn managed_assets_allow_the_same_blob_at_multiple_document_paths() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        let hash = "a".repeat(64);
        for path in [
            "managed-documents/11111111-1111-4111-8111-111111111111/assets/cover.png",
            "managed-documents/22222222-2222-4222-8222-222222222222/assets/cover.png",
        ] {
            connection
                .execute(
                    "INSERT INTO managed_assets(relative_path,hash,size,created_at,updated_at)
                     VALUES (?1,?2,1,1,1)",
                    params![path, hash],
                )
                .unwrap();
        }
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_assets WHERE hash=?1",
                params![hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn repairs_the_early_v8_asset_hash_primary_key_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = database_for_tests(directory.path()).unwrap();
        connection
            .execute_batch(
                "DROP TABLE managed_assets;
                 CREATE TABLE managed_assets (
                   hash TEXT PRIMARY KEY NOT NULL,
                   relative_path TEXT NOT NULL UNIQUE,
                   size INTEGER NOT NULL,
                   media_type TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO managed_assets VALUES (
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   'managed-documents/11111111-1111-4111-8111-111111111111/assets/a.png',
                   1,NULL,1,1
                 );",
            )
            .unwrap();

        ensure_managed_asset_schema(&mut connection).unwrap();
        ensure_managed_asset_schema(&mut connection).unwrap();
        assert!(managed_assets_use_path_identity(&connection));
        connection
            .execute(
                "INSERT INTO managed_assets(relative_path,hash,size,created_at,updated_at)
                 VALUES (?1,?2,1,1,1)",
                params![
                    "managed-documents/22222222-2222-4222-8222-222222222222/assets/a.png",
                    "a".repeat(64)
                ],
            )
            .unwrap();
    }

    #[test]
    fn refuses_a_schema_newer_than_the_application() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        connection
            .execute(
                "UPDATE schema_meta SET value=?1 WHERE key='version'",
                params![(SCHEMA_VERSION + 1).to_string()],
            )
            .unwrap();
        drop(connection);

        let error = database_for_tests(directory.path()).unwrap_err();
        assert!(error.contains("高于当前支持的版本"), "{error}");
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
