//! Managed Markdown documents, referenced assets, versions and drafts.
//!
//! Joining a document copies it into application-owned storage. The source file
//! and its adjacent `assets/` directory are read only; all returned paths are
//! local runtime details and are deliberately excluded from sync snapshots.

use crate::file::{write_file_impl, MAX_TEXT_FILE_BYTES};
use crate::library;
use crate::sync;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DOCUMENT_ROOT: &str = "managed-documents";
const BLOB_ROOT: &str = "managed-documents/blobs/sha256";
const MAX_DOCUMENT_BYTES: u64 = MAX_TEXT_FILE_BYTES;
const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
struct WrittenBlob {
    path: PathBuf,
    created_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDocument {
    pub id: String,
    pub content_hash: String,
    pub title: String,
    pub local_path: Option<String>,
    pub availability: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAsset {
    pub hash: String,
    pub relative_path: String,
    pub size: u64,
    pub media_type: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    created_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub id: String,
    pub document_id: String,
    pub blob_hash: String,
    pub size: u64,
    pub device_id: Option<String>,
    pub created_at: i64,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDraft {
    pub id: String,
    pub document_id: Option<String>,
    pub blob_hash: String,
    pub title: Option<String>,
    pub device_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinDocumentResult {
    pub document: ManagedDocument,
    /// 本机运行时路径。它只用于把当前标签切换到受管副本，绝不进入同步快照。
    pub managed_path: String,
    pub content: String,
    pub copied_assets: Vec<ManagedAsset>,
    pub warnings: Vec<String>,
}

fn document_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DOCUMENT_ROOT)
}

fn blob_path(app_data_dir: &Path, hash: &str) -> Result<PathBuf, String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("文档正文哈希无效".to_string());
    }
    Ok(app_data_dir.join(BLOB_ROOT).join(&hash[..2]).join(hash))
}

pub(crate) fn document_blob_path(app_data_dir: &Path, hash: &str) -> Result<PathBuf, String> {
    blob_path(app_data_dir, hash)
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_blob(app_data_dir: &Path, hash: &str, bytes: &[u8]) -> Result<WrittenBlob, String> {
    let path = blob_path(app_data_dir, hash)?;
    if path.is_file() {
        let existing = fs::read(&path).map_err(|error| format!("无法读取已有文档正文: {error}"))?;
        if existing.len() != bytes.len() || hash_bytes(&existing) != hash {
            return Err(format!("已有文档正文校验失败: {}", path.display()));
        }
        return Ok(WrittenBlob {
            path,
            created_file: false,
        });
    }
    let parent = path
        .parent()
        .ok_or_else(|| "文档正文路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建文档正文目录: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建文档正文临时文件: {error}"))?;
    std::io::Write::write_all(&mut temporary, bytes)
        .map_err(|error| format!("无法写入文档正文: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步文档正文: {error}"))?;
    let created_file = match temporary.persist_noclobber(&path) {
        Ok(_) => true,
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another import may have committed the same immutable blob while
            // this copy was in progress. Verify the winner before reusing it.
            let existing = fs::read(&path)
                .map_err(|read_error| format!("无法读取已有文档正文: {read_error}"))?;
            if existing.len() != bytes.len() || hash_bytes(&existing) != hash {
                return Err(format!("已有文档正文校验失败: {}", path.display()));
            }
            false
        }
        Err(error) => return Err(format!("无法提交文档正文: {}", error.error)),
    };
    Ok(WrittenBlob { path, created_file })
}

fn safe_document_id(id: &str) -> Result<(), String> {
    if Uuid::parse_str(id).is_err() {
        return Err("文档标识无效".to_string());
    }
    Ok(())
}

fn safe_asset_reference(reference: &str) -> Result<Vec<String>, String> {
    let value = reference.trim();
    if !value.starts_with("assets/") || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("忽略不安全的资源引用: {reference}"));
    }
    let mut components = Vec::new();
    for component in Path::new(value).components() {
        let Component::Normal(part) = component else {
            return Err(format!("忽略不安全的资源引用: {reference}"));
        };
        let part = part
            .to_str()
            .ok_or_else(|| format!("资源引用不是 UTF-8: {reference}"))?;
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
            return Err(format!("忽略不安全的资源引用: {reference}"));
        }
        components.push(part.to_string());
    }
    if components.first().map(String::as_str) != Some("assets") || components.len() < 2 {
        return Err(format!("忽略不安全的资源引用: {reference}"));
    }
    Ok(components)
}

/// Extract only relative `assets/...` references. This intentionally avoids
/// rewriting Markdown or interpreting arbitrary HTML/URLs.
fn asset_references(markdown: &str) -> Vec<String> {
    let mut references = BTreeSet::new();
    let bytes = markdown.as_bytes();
    let needle = b"assets/";
    let mut index = 0;
    while let Some(offset) = bytes[index..]
        .windows(needle.len())
        .position(|window| window == needle)
    {
        let start = index + offset;
        if start > 0 {
            let previous = bytes[start - 1];
            if previous == b'/' || previous == b':' || previous.is_ascii_alphanumeric() {
                index = start + needle.len();
                continue;
            }
        }
        let mut end = start;
        while end < bytes.len() {
            let byte = bytes[end];
            if byte.is_ascii_whitespace() || matches!(byte, b')' | b'"' | b'\'' | b'>') {
                break;
            }
            end += 1;
        }
        let candidate = &markdown[start..end];
        if let Ok(parts) = safe_asset_reference(candidate) {
            references.insert(parts.join("/"));
        }
        index = end.max(start + needle.len());
    }
    references.into_iter().collect()
}

fn media_type_for(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(
        match extension.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        }
        .to_string(),
    )
}

fn copy_asset(
    connection: &Connection,
    app_data_dir: &Path,
    document_id: &str,
    source: &Path,
    relative: &str,
) -> Result<ManagedAsset, String> {
    let metadata = source
        .metadata()
        .map_err(|error| format!("无法读取资源 {}: {error}", source.display()))?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(format!("资源超过大小限制: {}", source.display()));
    }
    let mut file = fs::File::open(source)
        .map_err(|error| format!("无法读取资源 {}: {error}", source.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取资源 {}: {error}", source.display()))?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(format!("资源超过大小限制: {}", source.display()));
    }
    let hash = hash_bytes(&bytes);
    let target = document_root(app_data_dir).join(document_id).join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| "资源目标路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建资源目录: {error}"))?;
    let already_present = target.is_file();
    if already_present {
        let existing = fs::read(&target)
            .map_err(|error| format!("无法读取已有资源 {}: {error}", target.display()))?;
        if existing.len() != bytes.len() || hash_bytes(&existing) != hash {
            return Err(format!("已有资源校验失败: {}", target.display()));
        }
    }
    let created_file = if !already_present {
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("无法创建资源临时文件: {error}"))?;
        std::io::Write::write_all(&mut temporary, &bytes)
            .map_err(|error| format!("无法写入资源: {error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("无法同步资源: {error}"))?;
        match temporary.persist_noclobber(&target) {
            Ok(_) => true,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&target)
                    .map_err(|read_error| format!("无法读取已有资源: {read_error}"))?;
                if existing.len() != bytes.len() || hash_bytes(&existing) != hash {
                    return Err(format!("已有资源校验失败: {}", target.display()));
                }
                false
            }
            Err(error) => return Err(format!("无法提交资源: {}", error.error)),
        }
    } else {
        false
    };
    let stored_relative = target
        .strip_prefix(app_data_dir)
        .map_err(|_| "资源路径不在应用数据目录内".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let now = library::now_ms();
    if let Err(error) = connection.execute(
        "INSERT INTO managed_assets(hash,relative_path,size,media_type,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?5)
             ON CONFLICT(relative_path) DO UPDATE SET hash=?1,size=?3,media_type=?4,updated_at=?5",
        params![
            hash,
            stored_relative,
            bytes.len() as i64,
            media_type_for(source),
            now
        ],
    ) {
        if created_file {
            let _ = fs::remove_file(&target);
        }
        return Err(format!("无法记录受管资源: {error}"));
    }
    Ok(ManagedAsset {
        hash,
        relative_path: stored_relative,
        size: bytes.len() as u64,
        media_type: media_type_for(source),
        created_at: now,
        updated_at: now,
        created_file,
    })
}

fn read_document_at(
    connection: &Connection,
    app_data_dir: &Path,
    document_id: &str,
) -> Result<(ManagedDocument, String), String> {
    safe_document_id(document_id)?;
    let document = connection
        .query_row(
            "SELECT id,content_hash,title,local_path,availability,created_at,updated_at
             FROM managed_documents WHERE id=?1",
            params![document_id],
            |row| {
                Ok(ManagedDocument {
                    id: row.get(0)?,
                    content_hash: row.get(1)?,
                    title: row.get(2)?,
                    local_path: row.get(3)?,
                    availability: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("无法读取受管文档: {error}"))?
        .ok_or_else(|| "受管文档不存在".to_string())?;
    let path = document
        .local_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            document_root(app_data_dir)
                .join(&document.id)
                .join("document.md")
        });
    let content =
        fs::read_to_string(&path).map_err(|error| format!("无法读取受管文档正文: {error}"))?;
    Ok((document, content))
}

fn join_document_at(
    app_data_dir: &Path,
    connection: &mut Connection,
    source: &Path,
) -> Result<JoinDocumentResult, String> {
    let metadata = source
        .metadata()
        .map_err(|error| format!("无法读取 Markdown 文件: {error}"))?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "FILE_TOO_LARGE:{}:{MAX_DOCUMENT_BYTES}",
            metadata.len()
        ));
    }
    let content =
        fs::read_to_string(source).map_err(|error| format!("Markdown 不是有效 UTF-8: {error}"))?;
    let content_hash = hash_bytes(content.as_bytes());
    let id = Uuid::new_v4().to_string();
    let title = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
        .to_string();
    let target = document_root(app_data_dir).join(&id).join("document.md");
    let target_was_present = target.is_file();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启文档事务: {error}"))?;
    let mut cleanup_paths = Vec::<PathBuf>::new();
    let result = (|| -> Result<JoinDocumentResult, String> {
        if target_was_present {
            let existing = fs::read_to_string(&target)
                .map_err(|error| format!("无法读取已有受管文档: {error}"))?;
            if existing != content {
                return Err("受管文档目标路径已存在且内容不同".to_string());
            }
        } else {
            write_file_impl(&target, &content)?;
            cleanup_paths.push(target.clone());
        }

        let mut warnings = Vec::new();
        let mut copied_assets = Vec::new();
        let source_assets = source
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("assets");
        let canonical_assets = source_assets.canonicalize().ok();
        for reference in asset_references(&content) {
            let relative = reference.strip_prefix("assets/").unwrap_or_default();
            let source_asset = source_assets.join(relative);
            let Some(canonical_root) = canonical_assets.as_ref() else {
                warnings.push(format!("资源目录不存在: {reference}"));
                continue;
            };
            let canonical_source = match source_asset.canonicalize() {
                Ok(value) if value.starts_with(canonical_root) => value,
                _ => {
                    warnings.push(format!("资源不存在或越出 assets/: {reference}"));
                    continue;
                }
            };
            let asset_target = document_root(app_data_dir).join(&id).join(&reference);
            match copy_asset(
                &transaction,
                app_data_dir,
                &id,
                &canonical_source,
                &reference,
            ) {
                Ok(asset) => {
                    if asset.created_file {
                        cleanup_paths.push(asset_target);
                    }
                    copied_assets.push(asset);
                }
                Err(error) => warnings.push(error),
            }
        }

        let now = library::now_ms();
        transaction
            .execute(
                "INSERT INTO managed_documents(id,content_hash,title,local_path,availability,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,'local',?5,?5)",
                params![id, content_hash, title, target.to_string_lossy(), now],
            )
            .map_err(|error| format!("无法记录受管文档: {error}"))?;
        let blob_hash = hash_bytes(content.as_bytes());
        let written_blob = write_blob(app_data_dir, &blob_hash, content.as_bytes())?;
        if written_blob.created_file {
            cleanup_paths.push(written_blob.path);
        }
        let version_id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO document_versions(id,document_id,blob_hash,size,device_id,created_at,is_current)
                 VALUES (?1,?2,?3,?4,NULL,?5,1)",
                params![version_id, id, blob_hash, content.len() as i64, now],
            )
            .map_err(|error| format!("无法记录文档初始版本: {error}"))?;
        let document = ManagedDocument {
            id: id.clone(),
            content_hash: content_hash.clone(),
            title: title.clone(),
            local_path: Some(target.to_string_lossy().into_owned()),
            availability: "local".into(),
            created_at: now,
            updated_at: now,
        };
        Ok(JoinDocumentResult {
            managed_path: target.to_string_lossy().into_owned(),
            document,
            content: content.clone(),
            copied_assets,
            warnings,
        })
    })();
    match result {
        Ok(value) => transaction.commit().map(|_| value).map_err(|error| {
            for path in cleanup_paths.iter().rev() {
                let _ = fs::remove_file(path);
            }
            format!("无法提交受管文档: {error}")
        }),
        Err(error) => {
            drop(transaction);
            for path in cleanup_paths.iter().rev() {
                let _ = fs::remove_file(path);
            }
            Err(error)
        }
    }
}

fn list_versions_at(
    connection: &Connection,
    document_id: &str,
) -> Result<Vec<DocumentVersion>, String> {
    safe_document_id(document_id)?;
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,size,device_id,created_at,is_current
         FROM document_versions WHERE document_id=?1 ORDER BY created_at DESC,id",
        )
        .map_err(|error| format!("无法读取文档版本: {error}"))?;
    let versions = statement
        .query_map(params![document_id], |row| {
            Ok(DocumentVersion {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                size: row.get::<_, i64>(3)?.max(0) as u64,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                is_current: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|error| format!("无法读取文档版本: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析文档版本: {error}"))?;
    Ok(versions)
}

#[tauri::command]
pub fn managed_document_join(app: AppHandle, path: String) -> Result<JoinDocumentResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    fs::create_dir_all(document_root(&app_data))
        .map_err(|error| format!("无法创建受管文档目录: {error}"))?;
    let mut connection = library::open_database_at(&app_data)?;
    join_document_at(&app_data, &mut connection, Path::new(&path))
}

#[tauri::command]
pub fn managed_document_read(app: AppHandle, document_id: String) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    read_document_at(&connection, &app_data, &document_id).map(|(_, content)| content)
}

#[tauri::command]
pub fn managed_document_list(app: AppHandle) -> Result<Vec<ManagedDocument>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    let mut statement = connection.prepare("SELECT id,content_hash,title,local_path,availability,created_at,updated_at FROM managed_documents ORDER BY updated_at DESC,id").map_err(|error| format!("无法读取受管文档: {error}"))?;
    let documents = statement
        .query_map([], |row| {
            Ok(ManagedDocument {
                id: row.get(0)?,
                content_hash: row.get(1)?,
                title: row.get(2)?,
                local_path: row.get(3)?,
                availability: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取受管文档: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析受管文档: {error}"))?;
    Ok(documents)
}

#[tauri::command]
pub fn managed_document_create_version(
    app: AppHandle,
    document_id: String,
    content: String,
    device_id: Option<String>,
) -> Result<DocumentVersion, String> {
    if content.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("文档版本超过大小限制".to_string());
    }
    if device_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value).is_err())
    {
        return Err("设备标识无效".to_string());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let mut connection = library::open_database_at(&app_data)?;
    let (document, _) = read_document_at(&connection, &app_data, &document_id)?;
    let hash = hash_bytes(content.as_bytes());
    let written_blob = write_blob(&app_data, &hash, content.as_bytes())?;
    let cleanup_path = written_blob.path.clone();
    let cleanup_file = written_blob.created_file;
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            return Err(format!("无法开启版本事务: {error}"));
        }
    };
    let now = library::now_ms();
    let version_id = Uuid::new_v4().to_string();
    let result = (|| -> Result<DocumentVersion, String> {
        transaction
            .execute(
                "UPDATE document_versions SET is_current=0 WHERE document_id=?1",
                params![document.id],
            )
            .map_err(|error| format!("无法更新当前版本: {error}"))?;
        transaction
            .execute(
                "INSERT INTO document_versions(id,document_id,blob_hash,size,device_id,created_at,is_current)
                 VALUES (?1,?2,?3,?4,?5,?6,1)",
                params![
                    version_id,
                    document.id,
                    hash,
                    content.len() as i64,
                    device_id,
                    now
                ],
            )
            .map_err(|error| format!("无法写入文档版本: {error}"))?;
        transaction
            .execute(
                "UPDATE managed_documents SET content_hash=?1,updated_at=?2 WHERE id=?3",
                params![hash, now, document.id],
            )
            .map_err(|error| format!("无法更新文档正文标识: {error}"))?;
        Ok(DocumentVersion {
            id: version_id.clone(),
            document_id: document.id.clone(),
            blob_hash: hash.clone(),
            size: content.len() as u64,
            device_id: device_id.clone(),
            created_at: now,
            is_current: true,
        })
    })();
    match result {
        Ok(value) => transaction.commit().map(|_| value).map_err(|error| {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            format!("无法提交文档版本: {error}")
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
pub fn managed_document_list_versions(
    app: AppHandle,
    document_id: String,
) -> Result<Vec<DocumentVersion>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    list_versions_at(&connection, &document_id)
}

#[tauri::command]
pub fn managed_document_read_version(
    app: AppHandle,
    document_id: String,
    version_id: String,
) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    let hash: String = connection
        .query_row(
            "SELECT blob_hash FROM document_versions WHERE id=?1 AND document_id=?2",
            params![version_id, document_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取文档版本: {error}"))?;
    let path = blob_path(&app_data, &hash)?;
    fs::read_to_string(path).map_err(|error| format!("无法读取文档版本正文: {error}"))
}

#[tauri::command]
pub fn managed_document_save_draft(
    app: AppHandle,
    draft_id: Option<String>,
    document_id: Option<String>,
    title: Option<String>,
    device_id: String,
    content: String,
) -> Result<DocumentDraft, String> {
    if content.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("草稿超过大小限制".to_string());
    }
    if Uuid::parse_str(&device_id).is_err() {
        return Err("设备标识无效".to_string());
    }
    if title
        .as_ref()
        .is_some_and(|value| value.len() > 1024 || value.chars().any(char::is_control))
    {
        return Err("草稿标题无效".to_string());
    }
    if let Some(id) = document_id.as_deref() {
        safe_document_id(id)?;
    }
    if let Some(id) = draft_id.as_deref() {
        safe_document_id(id)?;
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let mut connection = library::open_database_at(&app_data)?;
    let hash = hash_bytes(content.as_bytes());
    let written_blob = write_blob(&app_data, &hash, content.as_bytes())?;
    let cleanup_path = written_blob.path.clone();
    let cleanup_file = written_blob.created_file;
    let now = library::now_ms();
    let id = draft_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            return Err(format!("无法开启草稿事务: {error}"));
        }
    };
    let result = (|| -> Result<DocumentDraft, String> {
        transaction
            .execute(
                "INSERT INTO document_drafts(id,document_id,blob_hash,title,device_id,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?6)
                 ON CONFLICT(id) DO UPDATE SET
                   document_id=excluded.document_id,blob_hash=excluded.blob_hash,
                   title=excluded.title,device_id=excluded.device_id,updated_at=excluded.updated_at",
                params![&id, &document_id, &hash, &title, &device_id, now],
            )
            .map_err(|error| format!("无法保存文档草稿: {error}"))?;
        sync::write_document_draft_record_at(&transaction, &id, true)?;
        let created_at = transaction
            .query_row(
                "SELECT created_at FROM document_drafts WHERE id=?1",
                params![&id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法读取文档草稿时间: {error}"))?;
        Ok(DocumentDraft {
            id: id.clone(),
            document_id: document_id.clone(),
            blob_hash: hash.clone(),
            title: title.clone(),
            device_id: device_id.clone(),
            created_at,
            updated_at: now,
        })
    })();
    match result {
        Ok(value) => transaction.commit().map(|_| value).map_err(|error| {
            if cleanup_file {
                let _ = fs::remove_file(&cleanup_path);
            }
            format!("无法提交草稿: {error}")
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
pub fn managed_document_list_drafts(app: AppHandle) -> Result<Vec<DocumentDraft>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,title,device_id,created_at,updated_at
             FROM document_drafts ORDER BY updated_at DESC,id",
        )
        .map_err(|error| format!("无法读取文档草稿: {error}"))?;
    let drafts = statement
        .query_map([], |row| {
            Ok(DocumentDraft {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                title: row.get(3)?,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取文档草稿: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析文档草稿: {error}"))?;
    Ok(drafts)
}

#[tauri::command]
pub fn managed_document_read_draft(app: AppHandle, draft_id: String) -> Result<String, String> {
    safe_document_id(&draft_id)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let connection = library::open_database_at(&app_data)?;
    let hash: String = connection
        .query_row(
            "SELECT blob_hash FROM document_drafts WHERE id=?1",
            params![draft_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取文档草稿: {error}"))?;
    let path = blob_path(&app_data, &hash)?;
    fs::read_to_string(path).map_err(|error| format!("无法读取文档草稿正文: {error}"))
}

#[tauri::command]
pub fn managed_document_delete_draft(app: AppHandle, draft_id: String) -> Result<(), String> {
    safe_document_id(&draft_id)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let mut connection = library::open_database_at(&app_data)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启草稿删除事务: {error}"))?;
    transaction
        .execute("DELETE FROM document_drafts WHERE id=?1", params![draft_id])
        .map_err(|error| format!("无法删除文档草稿: {error}"))?;
    sync::write_document_draft_record_at(&transaction, &draft_id, false)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交草稿删除: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_safe_relative_asset_references_are_collected() {
        let refs = asset_references(
            "![ok](assets/img/a.png) ![bad](assets/../secret) ![x](https://x/assets/x.png)",
        );
        assert_eq!(refs, vec!["assets/img/a.png"]);
    }

    #[test]
    fn document_blob_hash_is_stable_sha256() {
        assert_eq!(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn blob_paths_require_lowercase_sha256() {
        let directory = tempfile::tempdir().unwrap();
        assert!(blob_path(directory.path(), &"A".repeat(64)).is_err());
        assert!(blob_path(directory.path(), &"g".repeat(64)).is_err());
    }

    #[test]
    fn identical_markdown_files_keep_independent_document_ids() {
        let app_data = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let first_path = sources.path().join("first.md");
        let second_path = sources.path().join("second.md");
        fs::write(&first_path, "same markdown").unwrap();
        fs::write(&second_path, "same markdown").unwrap();
        let mut connection = library::open_database_at(app_data.path()).unwrap();

        let first = join_document_at(app_data.path(), &mut connection, &first_path).unwrap();
        let second = join_document_at(app_data.path(), &mut connection, &second_path).unwrap();

        assert_ne!(first.document.id, second.document.id);
        assert_eq!(first.document.content_hash, second.document.content_hash);
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_documents WHERE content_hash=?1",
                params![first.document.content_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn identical_assets_keep_one_reference_per_document_path() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        let source = directory.path().join("source.png");
        fs::write(&source, b"same image").unwrap();
        let first = copy_asset(
            &connection,
            directory.path(),
            "11111111-1111-4111-8111-111111111111",
            &source,
            "assets/image.png",
        )
        .unwrap();
        let second = copy_asset(
            &connection,
            directory.path(),
            "22222222-2222-4222-8222-222222222222",
            &source,
            "assets/image.png",
        )
        .unwrap();
        assert_eq!(first.hash, second.hash);
        assert_ne!(first.relative_path, second.relative_path);
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_assets WHERE hash=?1",
                params![first.hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn existing_asset_content_is_verified_before_reuse() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        let source = directory.path().join("source.png");
        fs::write(&source, b"original").unwrap();
        copy_asset(
            &connection,
            directory.path(),
            "11111111-1111-4111-8111-111111111111",
            &source,
            "assets/image.png",
        )
        .unwrap();
        let target = directory
            .path()
            .join("managed-documents/11111111-1111-4111-8111-111111111111/assets/image.png");
        fs::write(target, b"changed").unwrap();
        assert!(copy_asset(
            &connection,
            directory.path(),
            "11111111-1111-4111-8111-111111111111",
            &source,
            "assets/image.png",
        )
        .unwrap_err()
        .contains("校验失败"));
    }
}
