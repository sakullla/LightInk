//! WebDAV sync for reading progress, annotations, and shelf groups.
//!
//! Credentials use the independent `lightink.webdav` keyring service (see
//! [`crate::remote`]). The sync document is a single JSON file keyed by
//! content hash; newer `updatedAt` wins. Passwords, tokens, and ebook bytes
//! never enter the document.

use crate::annotations::{
    list_annotations_by_hash, merge_annotations_json, merge_remote_annotations_impl,
};
use crate::identifiers::validate_content_hash;
use crate::library::{
    self, add_library_group_member, list_library_group_members, list_library_groups,
    open_database_at, remove_library_group, remove_library_group_member, upsert_library_group,
    LibraryGroup,
};
use crate::remote::{
    apply_credential, build_client, response_error, validate_remote_url, webdav_forget_credential,
    webdav_load_credential, webdav_store_credential, RemoteCredential, RemoteError, RemoteState,
};
use reqwest::header::CONTENT_TYPE;
use reqwest::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};
use url::Url;

const CONFIG_FILE: &str = "webdav.json";
const LAST_SYNC_FILE: &str = "webdav-last-sync.json";
const SYNC_DOCUMENT_NAME: &str = "lightink-sync.json";
const SYNC_DOCUMENT_VERSION: u32 = 1;
const MAX_SYNC_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_CREDENTIAL_REF: &str = "webdav-sync";
const RESERVED_SHELF_FILTERS: &[&str] = &["all", "in-progress", "unread", "text", "comic"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    pub allow_http: bool,
    pub credential_ref: String,
}

/// Command-facing config. Secrets stay in the keyring; this only reports presence.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavPublicConfig {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub allow_http: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigInput {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub allow_http: Option<bool>,
    pub clear_credential: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedProgress {
    pub version: u32,
    pub kind: String,
    pub index: i64,
    pub ratio: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedGroup {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub source: String,
    pub smart_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedMember {
    pub group_id: String,
    pub content_hash: String,
    pub updated_at: i64,
    #[serde(default)]
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncDocument {
    pub version: u32,
    #[serde(default)]
    pub progress: BTreeMap<String, SyncedProgress>,
    #[serde(default)]
    pub annotations: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub groups: Vec<SyncedGroup>,
    #[serde(default)]
    pub members: Vec<SyncedMember>,
}

impl Default for SyncDocument {
    fn default() -> Self {
        Self {
            version: SYNC_DOCUMENT_VERSION,
            progress: BTreeMap::new(),
            annotations: BTreeMap::new(),
            groups: Vec::new(),
            members: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncInput {
    #[serde(default)]
    pub progress: BTreeMap<String, SyncedProgress>,
    #[serde(default)]
    pub item_hashes: Vec<ItemHash>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemHash {
    pub item_id: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncResult {
    pub progress: BTreeMap<String, SyncedProgress>,
    pub groups: Vec<SyncedGroup>,
    pub members: Vec<SyncedMember>,
}

#[tauri::command]
pub fn webdav_get_config(
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Result<Option<WebDavPublicConfig>, RemoteError> {
    let Some(config) = load_config(&app_data_dir(&app)?)? else {
        return Ok(None);
    };
    Ok(Some(public_config(&config, state.inner())))
}

#[tauri::command]
pub fn webdav_save_config(
    app: AppHandle,
    state: State<'_, RemoteState>,
    config: WebDavConfigInput,
) -> Result<WebDavPublicConfig, RemoteError> {
    let allow_http = config.allow_http.unwrap_or(false);
    let url = validate_remote_url(&config.url, allow_http)?;
    if config.clear_credential.unwrap_or(false) && config.password.is_some() {
        return Err(RemoteError::new(
            "WEBDAV_CONFIG_INVALID",
            "不能同时清除和设置 WebDAV 凭据",
        ));
    }
    let existing = load_config(&app_data_dir(&app)?)?;
    let credential_ref = existing
        .as_ref()
        .map(|value| value.credential_ref.clone())
        .unwrap_or_else(|| DEFAULT_CREDENTIAL_REF.to_string());
    if config.clear_credential.unwrap_or(false) {
        webdav_forget_credential(state.inner(), &credential_ref)?;
    } else if let Some(password) = config.password.as_deref() {
        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RemoteError::new("WEBDAV_CONFIG_INVALID", "保存密码时需要用户名"))?;
        webdav_store_credential(
            state.inner(),
            credential_ref.clone(),
            RemoteCredential::Basic {
                username: username.to_string(),
                password: password.to_string(),
            },
        )?;
    }
    let saved = WebDavConfig {
        url: url.to_string(),
        username: config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| existing.and_then(|value| value.username)),
        allow_http,
        credential_ref,
    };
    write_config(&app_data_dir(&app)?, &saved)?;
    Ok(public_config(&saved, state.inner()))
}

fn public_config(config: &WebDavConfig, state: &RemoteState) -> WebDavPublicConfig {
    WebDavPublicConfig {
        url: config.url.clone(),
        username: config.username.clone().unwrap_or_default(),
        has_password: webdav_load_credential(state, &config.credential_ref).is_some(),
        allow_http: config.allow_http,
    }
}

#[tauri::command]
pub fn webdav_forget(app: AppHandle, state: State<'_, RemoteState>) -> Result<(), RemoteError> {
    if let Some(config) = load_config(&app_data_dir(&app)?)? {
        webdav_forget_credential(state.inner(), &config.credential_ref)?;
    }
    let directory = app_data_dir(&app)?;
    let _ = fs::remove_file(directory.join(CONFIG_FILE));
    let _ = fs::remove_file(directory.join(LAST_SYNC_FILE));
    Ok(())
}

#[tauri::command]
pub async fn webdav_sync(
    app: AppHandle,
    state: State<'_, RemoteState>,
    input: WebDavSyncInput,
) -> Result<WebDavSyncResult, RemoteError> {
    let directory = app_data_dir(&app)?;
    let config = load_config(&directory)?
        .ok_or_else(|| RemoteError::new("WEBDAV_NOT_CONFIGURED", "尚未配置 WebDAV"))?;
    let url = validate_remote_url(&config.url, config.allow_http)?;
    let document_url = sync_document_url(&url)?;
    let credential = webdav_load_credential(state.inner(), &config.credential_ref);
    let remote_text =
        download_sync_document(&document_url, credential.as_ref(), MAX_SYNC_BYTES).await?;
    let remote = parse_sync_document(&remote_text)?;
    let last = load_last_sync(&directory)?;
    let local = collect_local_document(
        &directory,
        &input.progress,
        &input.item_hashes,
        last.as_ref(),
    )?;
    let merged = merge_sync_documents(&local, &remote);
    let body = serialize_sync_document(&merged)?;
    upload_sync_document(&document_url, credential.as_ref(), &body).await?;
    apply_merged_document(&directory, &merged, &input.item_hashes)?;
    write_last_sync(&directory, &merged)?;
    Ok(WebDavSyncResult {
        progress: merged.progress,
        groups: merged
            .groups
            .into_iter()
            .filter(|group| !group.removed)
            .collect(),
        members: merged
            .members
            .into_iter()
            .filter(|member| !member.removed)
            .collect(),
    })
}

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, RemoteError> {
    library::app_data_dir(app).map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))
}

fn load_config(directory: &Path) -> Result<Option<WebDavConfig>, RemoteError> {
    let path = directory.join(CONFIG_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| {
        RemoteError::new(
            "WEBDAV_STORAGE_ERROR",
            format!("无法读取 WebDAV 配置: {error}"),
        )
    })?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| RemoteError::new("WEBDAV_STORAGE_ERROR", "WebDAV 配置损坏"))
}

fn write_config(directory: &Path, config: &WebDavConfig) -> Result<(), RemoteError> {
    fs::create_dir_all(directory).map_err(|error| {
        RemoteError::new(
            "WEBDAV_STORAGE_ERROR",
            format!("无法保存 WebDAV 配置: {error}"),
        )
    })?;
    let text = serde_json::to_string(config)
        .map_err(|_| RemoteError::new("WEBDAV_STORAGE_ERROR", "无法序列化 WebDAV 配置"))?;
    crate::file::write_file_impl(&directory.join(CONFIG_FILE), &text)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))
}

fn load_last_sync(directory: &Path) -> Result<Option<SyncDocument>, RemoteError> {
    let path = directory.join(LAST_SYNC_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(None);
    }
    match parse_sync_document(&text) {
        Ok(document) => Ok(Some(document)),
        Err(_) => Ok(None),
    }
}

fn write_last_sync(directory: &Path, document: &SyncDocument) -> Result<(), RemoteError> {
    let text = serialize_sync_document(document)?;
    crate::file::write_file_impl(&directory.join(LAST_SYNC_FILE), &text)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))
}

pub(crate) fn sync_document_url(base: &Url) -> Result<Url, RemoteError> {
    if base.path().ends_with(".json") {
        return Ok(base.clone());
    }
    base.join(SYNC_DOCUMENT_NAME)
        .map_err(|_| RemoteError::new("WEBDAV_URL_INVALID", "无法拼接 WebDAV 同步文档地址"))
}

pub(crate) fn parse_sync_document(text: &str) -> Result<SyncDocument, RemoteError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(SyncDocument::default());
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| RemoteError::new("WEBDAV_DOCUMENT_INVALID", "同步文档损坏，无法合并"))?;
    if !parsed.is_object() {
        return Err(RemoteError::new(
            "WEBDAV_DOCUMENT_INVALID",
            "同步文档格式无法识别",
        ));
    }
    let document: SyncDocument = serde_json::from_value(parsed)
        .map_err(|_| RemoteError::new("WEBDAV_DOCUMENT_INVALID", "同步文档字段无法识别"))?;
    if document.version != SYNC_DOCUMENT_VERSION {
        return Err(RemoteError::new(
            "WEBDAV_DOCUMENT_INVALID",
            "同步文档版本无法识别",
        ));
    }
    Ok(sanitize_document(document))
}

pub(crate) fn serialize_sync_document(document: &SyncDocument) -> Result<String, RemoteError> {
    let sanitized = sanitize_document(document.clone());
    let value = serde_json::to_value(&sanitized)
        .map_err(|_| RemoteError::new("WEBDAV_DOCUMENT_INVALID", "无法准备同步文档"))?;
    if document_contains_secrets(&value) {
        return Err(RemoteError::new(
            "WEBDAV_DOCUMENT_INVALID",
            "同步文档不能包含凭据",
        ));
    }
    serde_json::to_string(&sanitized)
        .map_err(|_| RemoteError::new("WEBDAV_DOCUMENT_INVALID", "无法序列化同步文档"))
}

fn sanitize_document(mut document: SyncDocument) -> SyncDocument {
    document.version = SYNC_DOCUMENT_VERSION;
    document.progress.retain(|hash, progress| {
        validate_content_hash(hash).is_ok()
            && (progress.kind == "flow" || progress.kind == "page")
            && progress.version == 1
    });
    document
        .annotations
        .retain(|hash, _| validate_content_hash(hash).is_ok());
    document
        .groups
        .retain(|group| !is_reserved_group(&group.id));
    document.members.retain(|member| {
        validate_content_hash(&member.content_hash).is_ok() && !is_reserved_group(&member.group_id)
    });
    document
}

fn is_reserved_group(id: &str) -> bool {
    RESERVED_SHELF_FILTERS.contains(&id)
}

fn document_contains_secrets(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, child)| {
            let lowered = key.to_ascii_lowercase();
            matches!(
                lowered.as_str(),
                "password" | "token" | "secret" | "credential" | "credentialref"
            ) || document_contains_secrets(child)
        }),
        serde_json::Value::Array(items) => items.iter().any(document_contains_secrets),
        _ => false,
    }
}

pub(crate) fn merge_sync_documents(local: &SyncDocument, remote: &SyncDocument) -> SyncDocument {
    SyncDocument {
        version: SYNC_DOCUMENT_VERSION,
        progress: merge_progress(&local.progress, &remote.progress),
        annotations: merge_annotations_map(&local.annotations, &remote.annotations),
        groups: merge_groups(&local.groups, &remote.groups),
        members: merge_members(&local.members, &remote.members),
    }
}

fn merge_progress(
    local: &BTreeMap<String, SyncedProgress>,
    remote: &BTreeMap<String, SyncedProgress>,
) -> BTreeMap<String, SyncedProgress> {
    let mut merged = BTreeMap::new();
    let mut hashes = local.keys().cloned().collect::<HashSet<_>>();
    hashes.extend(remote.keys().cloned());
    for hash in hashes {
        if validate_content_hash(&hash).is_err() {
            continue;
        }
        match (local.get(&hash), remote.get(&hash)) {
            (Some(left), Some(right)) if right.updated_at > left.updated_at => {
                merged.insert(hash, right.clone());
            }
            (Some(left), _) => {
                merged.insert(hash, left.clone());
            }
            (None, Some(right)) => {
                merged.insert(hash, right.clone());
            }
            (None, None) => {}
        }
    }
    merged
}

fn merge_annotations_map(
    local: &BTreeMap<String, serde_json::Value>,
    remote: &BTreeMap<String, serde_json::Value>,
) -> BTreeMap<String, serde_json::Value> {
    let mut merged = BTreeMap::new();
    let mut hashes = local.keys().cloned().collect::<HashSet<_>>();
    hashes.extend(remote.keys().cloned());
    for hash in hashes {
        if validate_content_hash(&hash).is_err() {
            continue;
        }
        let local_json = local
            .get(&hash)
            .map(|value| value.to_string())
            .unwrap_or_default();
        let remote_json = remote
            .get(&hash)
            .map(|value| value.to_string())
            .unwrap_or_default();
        let merged_json = merge_annotations_json(&local_json, &remote_json);
        if merged_json.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str(&merged_json) {
            merged.insert(hash, value);
        }
    }
    merged
}

fn merge_groups(local: &[SyncedGroup], remote: &[SyncedGroup]) -> Vec<SyncedGroup> {
    let mut winners: BTreeMap<String, SyncedGroup> = BTreeMap::new();
    for group in local.iter().chain(remote.iter()) {
        if is_reserved_group(&group.id) {
            continue;
        }
        match winners.get(&group.id) {
            Some(current) if group.updated_at <= current.updated_at => {}
            _ => {
                winners.insert(group.id.clone(), group.clone());
            }
        }
    }
    winners.into_values().collect()
}

fn merge_members(local: &[SyncedMember], remote: &[SyncedMember]) -> Vec<SyncedMember> {
    let mut winners: BTreeMap<(String, String), SyncedMember> = BTreeMap::new();
    for member in local.iter().chain(remote.iter()) {
        if validate_content_hash(&member.content_hash).is_err()
            || is_reserved_group(&member.group_id)
        {
            continue;
        }
        let key = (member.group_id.clone(), member.content_hash.clone());
        match winners.get(&key) {
            Some(current) if member.updated_at <= current.updated_at => {}
            _ => {
                winners.insert(key, member.clone());
            }
        }
    }
    winners.into_values().collect()
}

fn hashes_by_item_id(item_hashes: &[ItemHash]) -> HashMap<String, String> {
    let mut hashes = HashMap::new();
    for item in item_hashes {
        if validate_content_hash(&item.content_hash).is_ok() && !item.item_id.trim().is_empty() {
            hashes
                .entry(item.item_id.clone())
                .or_insert_with(|| item.content_hash.clone());
        }
    }
    hashes
}

fn compute_local_item_hash(connection: &rusqlite::Connection, item_id: &str) -> Option<String> {
    let path = connection
        .query_row(
            "SELECT local_path FROM library_items WHERE id=?1",
            params![item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    let bytes = fs::read(path).ok()?;
    let hash = crate::asset::content_hash_hex(&bytes);
    validate_content_hash(&hash).ok().map(str::to_string)
}

fn resolve_member_content_hash(
    connection: &rusqlite::Connection,
    item_id: &str,
    stored: Option<&str>,
    hashes_by_item: &HashMap<String, String>,
) -> Option<String> {
    if let Some(hash) = stored.filter(|hash| validate_content_hash(hash).is_ok()) {
        return Some(hash.to_string());
    }
    if let Some(hash) = hashes_by_item.get(item_id) {
        if validate_content_hash(hash).is_ok() {
            return Some(hash.clone());
        }
    }
    compute_local_item_hash(connection, item_id)
}

fn persist_member_content_hash(
    connection: &rusqlite::Connection,
    group_id: &str,
    item_id: &str,
    content_hash: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE library_group_members SET content_hash=?3
             WHERE group_id=?1 AND item_id=?2",
            params![group_id, item_id, content_hash],
        )
        .map_err(|error| format!("无法写入分组成员哈希: {error}"))?;
    Ok(())
}

fn collect_local_document(
    directory: &Path,
    progress: &BTreeMap<String, SyncedProgress>,
    item_hashes: &[ItemHash],
    last: Option<&SyncDocument>,
) -> Result<SyncDocument, RemoteError> {
    let mut document = SyncDocument {
        version: SYNC_DOCUMENT_VERSION,
        progress: progress
            .iter()
            .filter(|(hash, _)| validate_content_hash(hash).is_ok())
            .map(|(hash, value)| (hash.clone(), value.clone()))
            .collect(),
        annotations: BTreeMap::new(),
        groups: Vec::new(),
        members: Vec::new(),
    };
    for (hash, json) in list_annotations_by_hash(directory)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?
    {
        if json.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str(&json) {
            document.annotations.insert(hash, value);
        }
    }
    let connection = open_database_at(directory)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?;
    document.groups = list_library_groups(&connection)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?
        .into_iter()
        .filter(|group| !is_reserved_group(&group.id))
        .map(synced_group_from_library)
        .collect();
    let hashes_by_item = hashes_by_item_id(item_hashes);
    document.members = list_library_group_members(&connection, None)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?
        .into_iter()
        .filter_map(|member| {
            if is_reserved_group(&member.group_id) {
                return None;
            }
            let content_hash = resolve_member_content_hash(
                &connection,
                &member.item_id,
                member.content_hash.as_deref(),
                &hashes_by_item,
            )?;
            if member.content_hash.as_deref() != Some(content_hash.as_str()) {
                let _ = persist_member_content_hash(
                    &connection,
                    &member.group_id,
                    &member.item_id,
                    &content_hash,
                );
            }
            Some(SyncedMember {
                group_id: member.group_id,
                content_hash,
                updated_at: member.updated_at,
                removed: false,
            })
        })
        .collect();
    if let Some(last) = last {
        document
            .groups
            .extend(tombstone_groups(&document.groups, &last.groups));
        document
            .members
            .extend(tombstone_members(&document.members, &last.members));
    }
    Ok(sanitize_document(document))
}

fn synced_group_from_library(group: LibraryGroup) -> SyncedGroup {
    SyncedGroup {
        id: group.id,
        parent_id: group.parent_id,
        name: group.name,
        source: group.source,
        smart_key: group.smart_key,
        created_at: group.created_at,
        updated_at: group.updated_at,
        removed: false,
    }
}

fn tombstone_groups(current: &[SyncedGroup], last: &[SyncedGroup]) -> Vec<SyncedGroup> {
    let current_ids = current
        .iter()
        .map(|group| group.id.as_str())
        .collect::<HashSet<_>>();
    let now = library::now_ms();
    last.iter()
        .filter(|group| !group.removed && !current_ids.contains(group.id.as_str()))
        .map(|group| SyncedGroup {
            updated_at: now.max(group.updated_at),
            removed: true,
            ..group.clone()
        })
        .collect()
}

fn tombstone_members(current: &[SyncedMember], last: &[SyncedMember]) -> Vec<SyncedMember> {
    let current_keys = current
        .iter()
        .map(|member| (member.group_id.as_str(), member.content_hash.as_str()))
        .collect::<HashSet<_>>();
    let now = library::now_ms();
    last.iter()
        .filter(|member| {
            !member.removed
                && !current_keys.contains(&(member.group_id.as_str(), member.content_hash.as_str()))
        })
        .map(|member| SyncedMember {
            updated_at: now.max(member.updated_at),
            removed: true,
            ..member.clone()
        })
        .collect()
}

fn apply_merged_document(
    directory: &Path,
    document: &SyncDocument,
    item_hashes: &[ItemHash],
) -> Result<(), RemoteError> {
    for (hash, value) in &document.annotations {
        let remote_json = value.to_string();
        merge_remote_annotations_impl(directory, hash, &remote_json)
            .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?;
    }
    let connection = open_database_at(directory)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?;
    apply_groups(&connection, &document.groups)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?;
    apply_members(&connection, &document.members, item_hashes)
        .map_err(|message| RemoteError::new("WEBDAV_STORAGE_ERROR", message))?;
    Ok(())
}

fn apply_groups(connection: &rusqlite::Connection, groups: &[SyncedGroup]) -> Result<(), String> {
    for group in groups.iter().filter(|group| group.removed) {
        let _ = remove_library_group(connection, &group.id);
    }
    let mut pending = groups
        .iter()
        .filter(|group| !group.removed)
        .cloned()
        .collect::<Vec<_>>();
    let mut applied = list_library_groups(connection)?
        .into_iter()
        .map(|group| group.id)
        .collect::<HashSet<_>>();
    for _ in 0..64 {
        if pending.is_empty() {
            break;
        }
        let mut deferred = Vec::new();
        let mut progressed = false;
        for group in pending {
            let parent_ready = group
                .parent_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map_or(true, |parent| applied.contains(parent));
            if !parent_ready {
                deferred.push(group);
                continue;
            }
            apply_one_group(connection, &group)?;
            applied.insert(group.id.clone());
            progressed = true;
        }
        if !progressed {
            for mut group in deferred {
                group.parent_id = None;
                apply_one_group(connection, &group)?;
            }
            break;
        }
        pending = deferred;
    }
    Ok(())
}

fn apply_one_group(connection: &rusqlite::Connection, group: &SyncedGroup) -> Result<(), String> {
    if is_reserved_group(&group.id) {
        return Ok(());
    }
    let exists = list_library_groups(connection)?
        .iter()
        .any(|existing| existing.id == group.id);
    if exists {
        upsert_library_group(
            connection,
            LibraryGroup {
                id: group.id.clone(),
                parent_id: group.parent_id.clone(),
                name: group.name.clone(),
                source: group.source.clone(),
                smart_key: group.smart_key.clone(),
                created_at: group.created_at,
                updated_at: group.updated_at,
            },
        )?;
        return Ok(());
    }
    let source = if group.source == "smart" {
        "smart"
    } else {
        "user"
    };
    connection
        .execute(
            "INSERT INTO library_groups(id, parent_id, name, source, smart_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                group.id,
                group.parent_id,
                group.name,
                source,
                group.smart_key,
                group.created_at,
                group.updated_at
            ],
        )
        .map_err(|error| format!("无法写入同步分组: {error}"))?;
    Ok(())
}

fn apply_members(
    connection: &rusqlite::Connection,
    members: &[SyncedMember],
    item_hashes: &[ItemHash],
) -> Result<(), String> {
    let mut items_by_hash: HashMap<String, HashSet<String>> = HashMap::new();
    for member in list_library_group_members(connection, None)? {
        if let Some(hash) = member.content_hash {
            if validate_content_hash(&hash).is_ok() {
                items_by_hash
                    .entry(hash)
                    .or_default()
                    .insert(member.item_id);
            }
        }
    }
    for item in item_hashes {
        if validate_content_hash(&item.content_hash).is_ok() && !item.item_id.trim().is_empty() {
            items_by_hash
                .entry(item.content_hash.clone())
                .or_default()
                .insert(item.item_id.clone());
        }
    }
    for member in members {
        let Some(item_ids) = items_by_hash.get(&member.content_hash) else {
            continue;
        };
        for item_id in item_ids {
            if !library_item_exists(connection, item_id)? {
                continue;
            }
            if member.removed {
                let _ = remove_library_group_member(connection, &member.group_id, item_id);
                continue;
            }
            if member_exists(connection, &member.group_id, item_id)? {
                connection
                    .execute(
                        "UPDATE library_group_members
                         SET content_hash=?3, updated_at=?4
                         WHERE group_id=?1 AND item_id=?2",
                        params![
                            member.group_id,
                            item_id,
                            member.content_hash,
                            member.updated_at
                        ],
                    )
                    .map_err(|error| format!("无法更新分组成员: {error}"))?;
            } else {
                add_library_group_member(
                    connection,
                    &member.group_id,
                    item_id,
                    Some(member.content_hash.as_str()),
                )?;
                connection
                    .execute(
                        "UPDATE library_group_members SET updated_at=?3
                         WHERE group_id=?1 AND item_id=?2",
                        params![member.group_id, item_id, member.updated_at],
                    )
                    .map_err(|error| format!("无法更新分组成员时间: {error}"))?;
            }
        }
    }
    Ok(())
}

fn library_item_exists(connection: &rusqlite::Connection, item_id: &str) -> Result<bool, String> {
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

fn member_exists(
    connection: &rusqlite::Connection,
    group_id: &str,
    item_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM library_group_members WHERE group_id=?1 AND item_id=?2",
            params![group_id, item_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| format!("无法读取分组成员: {error}"))
}

async fn download_sync_document(
    url: &Url,
    credential: Option<&RemoteCredential>,
    max_bytes: usize,
) -> Result<String, RemoteError> {
    let client = build_client(url, credential.is_some())?;
    let response = apply_credential(client.get(url.clone()), credential)
        .send()
        .await
        .map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("无法连接 WebDAV: {error}"))
        })?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(String::new());
    }
    if let Some(error) = response_error(&response) {
        return Err(error);
    }
    if !response.status().is_success() {
        return Err(RemoteError::status(
            "REMOTE_HTTP_ERROR",
            format!("WebDAV 返回 HTTP {}", response.status().as_u16()),
            response.status(),
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("WebDAV 传输中断: {error}"))
        })?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(RemoteError::new(
                "REMOTE_DOCUMENT_TOO_LARGE",
                "同步文档超过大小限制",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| RemoteError::new("WEBDAV_DOCUMENT_INVALID", "同步文档不是有效的 UTF-8"))
}

async fn upload_sync_document(
    url: &Url,
    credential: Option<&RemoteCredential>,
    body: &str,
) -> Result<(), RemoteError> {
    let client = build_client(url, credential.is_some())?;
    let response = apply_credential(
        client
            .put(url.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string()),
        credential,
    )
    .send()
    .await
    .map_err(|error| {
        RemoteError::new("REMOTE_NETWORK_ERROR", format!("无法写入 WebDAV: {error}"))
    })?;
    if let Some(error) = response_error(&response) {
        return Err(error);
    }
    if !response.status().is_success() {
        return Err(RemoteError::status(
            "REMOTE_HTTP_ERROR",
            format!("WebDAV 返回 HTTP {}", response.status().as_u16()),
            response.status(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::write_annotations_impl;

    const HASH_A: &str = "0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210";

    fn progress(updated_at: i64, index: i64) -> SyncedProgress {
        SyncedProgress {
            version: 1,
            kind: "flow".into(),
            index,
            ratio: 0.25,
            updated_at,
        }
    }

    fn group(id: &str, name: &str, updated_at: i64) -> SyncedGroup {
        SyncedGroup {
            id: id.into(),
            parent_id: None,
            name: name.into(),
            source: "user".into(),
            smart_key: None,
            created_at: 1,
            updated_at,
            removed: false,
        }
    }

    fn member(group_id: &str, hash: &str, updated_at: i64) -> SyncedMember {
        SyncedMember {
            group_id: group_id.into(),
            content_hash: hash.into(),
            updated_at,
            removed: false,
        }
    }

    fn annotation_file(id: &str, updated_at: i64) -> serde_json::Value {
        serde_json::json!({
            "version": 2,
            "annotations": [{
                "id": id,
                "kind": "note",
                "locator": { "format": "cbz", "page": 1 },
                "createdAt": 1,
                "updatedAt": updated_at
            }]
        })
    }

    #[test]
    fn webdav_keyring_service_is_independent_from_opds() {
        assert_eq!(crate::remote::WEBDAV_KEYRING_SERVICE, "lightink.webdav");
        assert_ne!(
            crate::remote::WEBDAV_KEYRING_SERVICE,
            crate::remote::OPDS_KEYRING_SERVICE
        );
    }

    #[test]
    fn http_webdav_url_is_rejected_until_allowed() {
        let error = validate_remote_url("http://dav.example.test/sync", false).unwrap_err();
        assert_eq!(error.code, "REMOTE_HTTP_NOT_ALLOWED");
        assert!(validate_remote_url("https://dav.example.test/sync", false).is_ok());
        assert!(validate_remote_url("http://192.168.1.8/sync", true).is_ok());
    }

    #[test]
    fn sync_document_url_appends_json_name() {
        let directory = Url::parse("https://dav.example.test/books/").unwrap();
        assert_eq!(
            sync_document_url(&directory).unwrap().as_str(),
            "https://dav.example.test/books/lightink-sync.json"
        );
        let file = Url::parse("https://dav.example.test/books/custom.json").unwrap();
        assert_eq!(sync_document_url(&file).unwrap().as_str(), file.as_str());
    }

    #[test]
    fn merge_progress_keeps_newer_updated_at() {
        let mut local = BTreeMap::new();
        local.insert(HASH_A.into(), progress(10, 1));
        local.insert(HASH_B.into(), progress(30, 4));
        let mut remote = BTreeMap::new();
        remote.insert(HASH_A.into(), progress(20, 2));
        remote.insert(HASH_B.into(), progress(25, 3));
        remote.insert("not-a-hash".into(), progress(99, 9));
        let merged = merge_progress(&local, &remote);
        assert_eq!(merged.get(HASH_A).unwrap().index, 2);
        assert_eq!(merged.get(HASH_B).unwrap().index, 4);
        assert!(!merged.contains_key("not-a-hash"));
    }

    #[test]
    fn merge_annotations_use_record_updated_at() {
        let mut local = BTreeMap::new();
        local.insert(HASH_A.into(), annotation_file("n1", 10));
        let mut remote = BTreeMap::new();
        remote.insert(HASH_A.into(), annotation_file("n1", 20));
        let merged = merge_annotations_map(&local, &remote);
        assert_eq!(merged[HASH_A]["annotations"][0]["updatedAt"], 20);
    }

    #[test]
    fn merge_groups_and_members_by_newer_clock() {
        let local_groups = vec![group("user:a", "旧名", 10)];
        let remote_groups = vec![group("user:a", "新名", 20), group("user:b", "另一组", 5)];
        let merged_groups = merge_groups(&local_groups, &remote_groups);
        let renamed = merged_groups
            .iter()
            .find(|group| group.id == "user:a")
            .unwrap();
        assert_eq!(renamed.name, "新名");
        assert_eq!(merged_groups.len(), 2);

        let local_members = vec![member("user:a", HASH_A, 40)];
        let remote_members = vec![
            member("user:a", HASH_A, 10),
            SyncedMember {
                removed: true,
                ..member("user:a", HASH_B, 50)
            },
        ];
        let merged_members = merge_members(&local_members, &remote_members);
        let kept = merged_members
            .iter()
            .find(|member| member.content_hash == HASH_A)
            .unwrap();
        assert_eq!(kept.updated_at, 40);
        assert!(!kept.removed);
        let removed = merged_members
            .iter()
            .find(|member| member.content_hash == HASH_B)
            .unwrap();
        assert!(removed.removed);
    }

    #[test]
    fn serialized_document_omits_secrets_and_ebook_bytes() {
        let mut document = SyncDocument::default();
        document.progress.insert(HASH_A.into(), progress(1, 0));
        document
            .annotations
            .insert(HASH_A.into(), annotation_file("n1", 1));
        document.groups.push(group("user:a", "组", 1));
        document.members.push(member("user:a", HASH_A, 1));
        let json = serialize_sync_document(&document).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["version"], 1);
        assert!(value.get("password").is_none());
        assert!(value.get("token").is_none());
        assert!(value.get("credentialRef").is_none());
        assert!(!json.contains("password"));
        assert!(!json.contains("token"));
        assert!(!json.contains("%PDF"));
        assert!(!json.contains("PK\u{3}\u{4}"));
        let keys: HashSet<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            HashSet::from(["version", "progress", "annotations", "groups", "members"])
        );
    }

    #[test]
    fn corrupt_remote_document_is_rejected() {
        for payload in ["{not-json", "[]", "{\"version\":2}", "\"ebook\""] {
            let error = parse_sync_document(payload).unwrap_err();
            assert_eq!(error.code, "WEBDAV_DOCUMENT_INVALID", "{payload}");
        }
        assert_eq!(parse_sync_document("").unwrap(), SyncDocument::default());
    }

    #[test]
    fn apply_merged_document_writes_annotations_and_hash_members() {
        let directory = tempfile::tempdir().unwrap();
        write_annotations_impl(
            directory.path(),
            HASH_A,
            &annotation_file("n1", 5).to_string(),
        )
        .unwrap();
        let connection = open_database_at(directory.path()).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(id, source_kind, title, authors_json, updated_at)
                 VALUES ('book-1', 'local', '一书', '[]', 1)",
                [],
            )
            .unwrap();
        let mut document = SyncDocument::default();
        document
            .annotations
            .insert(HASH_A.into(), annotation_file("n1", 9));
        document.groups.push(group("user:series", "系列", 3));
        document.members.push(member("user:series", HASH_A, 3));
        apply_merged_document(
            directory.path(),
            &document,
            &[ItemHash {
                item_id: "book-1".into(),
                content_hash: HASH_A.into(),
            }],
        )
        .unwrap();
        let stored = crate::annotations::read_annotations_impl(directory.path(), HASH_A).unwrap();
        assert!(stored.contains("\"updatedAt\":9"));
        let groups = list_library_groups(&connection).unwrap();
        assert_eq!(groups[0].name, "系列");
        let members = list_library_group_members(&connection, Some("user:series")).unwrap();
        assert_eq!(members[0].item_id, "book-1");
        assert_eq!(members[0].content_hash.as_deref(), Some(HASH_A));
    }

    #[test]
    fn collect_local_document_attaches_missing_member_hashes() {
        let directory = tempfile::tempdir().unwrap();
        let book_path = directory.path().join("never-opened.epub");
        fs::write(&book_path, b"local-epub-bytes").unwrap();
        let computed = crate::asset::content_hash_hex(b"local-epub-bytes");
        let connection = open_database_at(directory.path()).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(id, source_kind, title, authors_json, local_path, updated_at)
                 VALUES ('book-alias', 'local', '已打开', '[]', NULL, 1),
                        ('book-file', 'local', '未打开', '[]', ?1, 1)",
                params![book_path.to_string_lossy()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_groups(id, parent_id, name, source, smart_key, created_at, updated_at)
                 VALUES ('user:a', NULL, '组', 'user', NULL, 1, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO library_group_members(group_id, item_id, content_hash, updated_at)
                 VALUES ('user:a', 'book-alias', NULL, 4),
                        ('user:a', 'book-file', NULL, 5)",
                [],
            )
            .unwrap();
        let document = collect_local_document(
            directory.path(),
            &BTreeMap::new(),
            &[ItemHash {
                item_id: "book-alias".into(),
                content_hash: HASH_A.into(),
            }],
            None,
        )
        .unwrap();
        let by_hash: HashMap<_, _> = document
            .members
            .iter()
            .map(|member| (member.content_hash.as_str(), member.updated_at))
            .collect();
        assert_eq!(by_hash.get(HASH_A), Some(&4));
        assert_eq!(by_hash.get(computed.as_str()), Some(&5));
        let stored = list_library_group_members(&connection, Some("user:a")).unwrap();
        assert!(stored.iter().any(|member| {
            member.item_id == "book-alias" && member.content_hash.as_deref() == Some(HASH_A)
        }));
        assert!(stored.iter().any(|member| {
            member.item_id == "book-file" && member.content_hash.as_deref() == Some(computed.as_str())
        }));
    }

    #[test]
    fn public_config_reports_password_without_writing_secrets() {
        let view = WebDavPublicConfig {
            url: "https://dav.example.test/sync".into(),
            username: "reader".into(),
            has_password: true,
            allow_http: false,
        };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["hasPassword"], true);
        assert_eq!(json["username"], "reader");
        assert!(json.get("password").is_none());
        assert!(json.get("credentialRef").is_none());

        let directory = tempfile::tempdir().unwrap();
        write_config(
            directory.path(),
            &WebDavConfig {
                url: view.url.clone(),
                username: Some("reader".into()),
                allow_http: false,
                credential_ref: "webdav-sync".into(),
            },
        )
        .unwrap();
        let disk = fs::read_to_string(directory.path().join(CONFIG_FILE)).unwrap();
        assert!(!disk.contains("password"));
        assert!(!disk.contains("hasPassword"));
        let loaded = load_config(directory.path()).unwrap().unwrap();
        assert_eq!(loaded.username.as_deref(), Some("reader"));
        assert_eq!(loaded.credential_ref, "webdav-sync");
    }
}
