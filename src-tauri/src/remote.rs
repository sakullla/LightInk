//! Secure remote random-access resources backed by a bounded sparse cache.

use crate::library::{
    self, cache_limit, cached_ranges, confined_cache_path, evict_cache, find_cache_object,
    record_cached_range, touch_cache_object, upsert_cache_object, ByteRange, CacheObject,
};
use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use url::Url;

pub const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FRONTEND_SAFE_BYTES: u64 = (1_u64 << 53) - 1;
const KEYRING_SERVICE: &str = "lightink.opds";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteCredential {
    Basic { username: String, password: String },
    Bearer { token: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl RemoteError {
    pub(crate) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }

    pub(crate) fn status(
        code: impl Into<String>,
        message: impl Into<String>,
        status: StatusCode,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: Some(status.as_u16()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpenResult {
    pub resource_id: String,
    pub size: u64,
    pub identity: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub mime_type: Option<String>,
    pub supports_ranges: bool,
    pub cache_complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreResult {
    pub credential_ref: String,
    pub persisted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedContentRange {
    pub start: u64,
    pub end_inclusive: u64,
    pub total: u64,
}

struct RemoteHandle {
    url: Url,
    client: Client,
    identity: String,
    size: u64,
    object_id: String,
    cache_path: PathBuf,
    etag: Option<String>,
    last_modified: Option<String>,
    credential: Option<RemoteCredential>,
    supports_ranges: bool,
    mime_type: Option<String>,
}

struct ActiveRequest {
    resource_id: String,
    token: CancellationToken,
}

struct ActiveRequestGuard<'a> {
    state: &'a RemoteState,
    request_id: String,
}

impl Drop for ActiveRequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.state.active_requests.lock() {
            requests.remove(&self.request_id);
        }
    }
}

pub struct RemoteState {
    handles: Mutex<HashMap<String, Arc<RemoteHandle>>>,
    active_requests: Mutex<HashMap<String, ActiveRequest>>,
    session_credentials: Mutex<HashMap<String, RemoteCredential>>,
    session_id: String,
    sequence: AtomicU64,
}

#[derive(Clone)]
pub(crate) struct RemoteFileInfo {
    pub size: u64,
    pub identity: String,
    pub cache_path: PathBuf,
    pub cache_complete: bool,
}

impl Default for RemoteState {
    fn default() -> Self {
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let session_id = stable_hash(&format!("{}:{started_at}", std::process::id()));
        Self {
            handles: Mutex::new(HashMap::new()),
            active_requests: Mutex::new(HashMap::new()),
            session_credentials: Mutex::new(HashMap::new()),
            session_id,
            sequence: AtomicU64::new(1),
        }
    }
}

fn lock_error() -> RemoteError {
    RemoteError::new("REMOTE_STATE_UNAVAILABLE", "远程资源状态暂时不可用")
}

fn cancelled_error() -> RemoteError {
    RemoteError::new("REMOTE_CANCELLED", "远程读取已取消")
}

fn register_active_request<'a>(
    state: &'a RemoteState,
    request_id: String,
    resource_id: String,
) -> Result<(CancellationToken, ActiveRequestGuard<'a>), RemoteError> {
    let token = CancellationToken::new();
    let mut requests = state.active_requests.lock().map_err(|_| lock_error())?;
    if requests.contains_key(&request_id) {
        return Err(RemoteError::new(
            "REMOTE_REQUEST_CONFLICT",
            "远程请求标识正在使用",
        ));
    }
    requests.insert(
        request_id.clone(),
        ActiveRequest {
            resource_id,
            token: token.clone(),
        },
    );
    Ok((token, ActiveRequestGuard { state, request_id }))
}

pub fn validate_remote_url(raw: &str, allow_http: bool) -> Result<Url, RemoteError> {
    if raw.chars().any(char::is_control) {
        return Err(RemoteError::new("REMOTE_URL_INVALID", "URL 包含控制字符"));
    }
    let mut parsed = Url::parse(raw.trim())
        .map_err(|_| RemoteError::new("REMOTE_URL_INVALID", "URL 格式无效"))?;
    if parsed.host_str().is_none() {
        return Err(RemoteError::new("REMOTE_URL_INVALID", "URL 缺少主机名"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(RemoteError::new(
            "REMOTE_URL_INVALID",
            "URL 不能包含用户名或密码，请使用凭据配置",
        ));
    }
    parsed.set_fragment(None);
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if allow_http => Ok(parsed),
        "http" => Err(RemoteError::new(
            "REMOTE_HTTP_NOT_ALLOWED",
            "HTTP 源需要由用户明确允许",
        )),
        _ => Err(RemoteError::new(
            "REMOTE_SCHEME_UNSUPPORTED",
            "仅支持 HTTP(S) 远程资源",
        )),
    }
}

pub fn redirect_allowed(from: &Url, to: &Url) -> bool {
    matches!(to.scheme(), "http" | "https")
        && to.host_str().is_some()
        && to.username().is_empty()
        && to.password().is_none()
        && !(from.scheme() == "https" && to.scheme() == "http")
}

pub(crate) fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub fn parse_content_range(value: &str) -> Result<ParsedContentRange, RemoteError> {
    let value = value.trim();
    let body = value.strip_prefix("bytes ").ok_or_else(|| {
        RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 格式无效")
    })?;
    let (range, total) = body.split_once('/').ok_or_else(|| {
        RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 缺少总大小")
    })?;
    let (start, end) = range.split_once('-').ok_or_else(|| {
        RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 缺少范围")
    })?;
    let parsed = ParsedContentRange {
        start: start.parse().map_err(|_| {
            RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 起点无效")
        })?,
        end_inclusive: end.parse().map_err(|_| {
            RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 终点无效")
        })?,
        total: total.parse().map_err(|_| {
            RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "Content-Range 总大小无效")
        })?,
    };
    if parsed.start > parsed.end_inclusive || parsed.end_inclusive >= parsed.total {
        return Err(RemoteError::new(
            "REMOTE_CONTENT_RANGE_INVALID",
            "Content-Range 边界无效",
        ));
    }
    Ok(parsed)
}

fn header_string(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn apply_credential(
    builder: RequestBuilder,
    credential: Option<&RemoteCredential>,
) -> RequestBuilder {
    match credential {
        Some(RemoteCredential::Basic { username, password }) => {
            builder.basic_auth(username, Some(password))
        }
        Some(RemoteCredential::Bearer { token }) => builder.bearer_auth(token),
        None => builder,
    }
}

fn response_error(response: &Response) -> Option<RemoteError> {
    match response.status() {
        StatusCode::UNAUTHORIZED => Some(RemoteError::status(
            "REMOTE_AUTH_REQUIRED",
            "远程资源需要鉴权",
            response.status(),
        )),
        StatusCode::FORBIDDEN => Some(RemoteError::status(
            "REMOTE_FORBIDDEN",
            "没有访问远程资源的权限",
            response.status(),
        )),
        status if status.is_client_error() || status.is_server_error() => {
            Some(RemoteError::status(
                "REMOTE_HTTP_ERROR",
                format!("远程服务器返回 HTTP {}", status.as_u16()),
                status,
            ))
        }
        _ => None,
    }
}

fn redirect_allowed_for_request(initial: &Url, from: &Url, to: &Url, authenticated: bool) -> bool {
    redirect_allowed(from, to) && (!authenticated || same_origin(initial, to))
}

fn build_client(initial: &Url, authenticated: bool) -> Result<Client, RemoteError> {
    let first = initial.clone();
    let credential_origin = initial.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("redirect limit exceeded");
        }
        let from = attempt.previous().last().unwrap_or(&first);
        if !redirect_allowed_for_request(&credential_origin, from, attempt.url(), authenticated) {
            return attempt.error("unsafe redirect refused");
        }
        attempt.follow()
    });
    Client::builder()
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .referer(false)
        .user_agent(concat!("LightInk/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| {
            RemoteError::new(
                "REMOTE_CLIENT_ERROR",
                format!("无法创建网络客户端: {error}"),
            )
        })
}

fn stable_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validator_key<'a>(etag: Option<&'a str>, last_modified: Option<&'a str>) -> Option<&'a str> {
    etag.or(last_modified)
}

fn resource_version(
    etag: Option<&str>,
    last_modified: Option<&str>,
    session_id: &str,
    handle_sequence: u64,
) -> String {
    validator_key(etag, last_modified)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("session-{session_id}-{handle_sequence}"))
}

fn cache_keys(
    url: &Url,
    etag: Option<&str>,
    last_modified: Option<&str>,
    session_id: &str,
    handle_sequence: u64,
) -> (String, String) {
    let version = resource_version(etag, last_modified, session_id, handle_sequence);
    if validator_key(etag, last_modified).is_some() {
        (url.as_str().to_string(), version)
    } else {
        (format!("{}\n{version}", url.as_str()), version)
    }
}

fn ensure_frontend_safe_size(size: u64) -> Result<u64, RemoteError> {
    if size > MAX_FRONTEND_SAFE_BYTES {
        return Err(RemoteError::new(
            "REMOTE_DOCUMENT_TOO_LARGE",
            "远程资源大小超过前端可精确寻址范围",
        ));
    }
    Ok(size)
}

fn load_credential(state: &RemoteState, credential_ref: &str) -> Option<RemoteCredential> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential_ref) {
        if let Ok(value) = entry.get_password() {
            if let Ok(credential) = serde_json::from_str(&value) {
                return Some(credential);
            }
        }
    }
    state
        .session_credentials
        .lock()
        .ok()
        .and_then(|credentials| credentials.get(credential_ref).cloned())
}

pub(crate) fn store_credential_value(
    state: &RemoteState,
    credential_ref: String,
    credential: RemoteCredential,
) -> Result<CredentialStoreResult, RemoteError> {
    if credential_ref.trim().is_empty() {
        return Err(RemoteError::new(
            "REMOTE_CREDENTIAL_INVALID",
            "凭据引用不能为空",
        ));
    }
    let serialized = serde_json::to_string(&credential)
        .map_err(|_| RemoteError::new("REMOTE_CREDENTIAL_INVALID", "无法准备远程凭据"))?;
    let persisted = keyring::Entry::new(KEYRING_SERVICE, &credential_ref)
        .and_then(|entry| entry.set_password(&serialized))
        .is_ok();
    let mut session_credentials = state.session_credentials.lock().map_err(|_| lock_error())?;
    if persisted {
        session_credentials.remove(&credential_ref);
    } else {
        session_credentials.insert(credential_ref.clone(), credential);
    }
    Ok(CredentialStoreResult {
        credential_ref,
        persisted,
    })
}

#[tauri::command]
pub fn remote_store_credential(
    state: State<'_, RemoteState>,
    credential_ref: String,
    credential: RemoteCredential,
) -> Result<CredentialStoreResult, RemoteError> {
    store_credential_value(&state, credential_ref, credential)
}

#[tauri::command]
pub fn remote_forget_credential(
    state: State<'_, RemoteState>,
    credential_ref: String,
) -> Result<(), RemoteError> {
    forget_credential_value(state.inner(), &credential_ref)
}

pub(crate) fn forget_credential_value(
    state: &RemoteState,
    credential_ref: &str,
) -> Result<(), RemoteError> {
    state
        .session_credentials
        .lock()
        .map_err(|_| lock_error())?
        .remove(credential_ref);
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential_ref) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub(crate) async fn fetch_remote_text(
    state: &RemoteState,
    raw_url: &str,
    allow_http: bool,
    credential_ref: Option<&str>,
    max_bytes: usize,
) -> Result<(Url, Option<String>, String), RemoteError> {
    let url = validate_remote_url(raw_url, allow_http)?;
    let credential = credential_ref.and_then(|reference| load_credential(state, reference));
    let client = build_client(&url, credential.is_some())?;
    let response = apply_credential(client.get(url), credential.as_ref())
        .send()
        .await
        .map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("无法连接远程目录: {error}"))
        })?;
    if let Some(error) = response_error(&response) {
        return Err(error);
    }
    if !response.status().is_success() {
        return Err(RemoteError::status(
            "REMOTE_HTTP_ERROR",
            format!("远程服务器返回 HTTP {}", response.status().as_u16()),
            response.status(),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(RemoteError::new(
            "REMOTE_DOCUMENT_TOO_LARGE",
            "远程目录响应超过大小限制",
        ));
    }
    let final_url = response.url().clone();
    let content_type = header_string(response.headers(), reqwest::header::CONTENT_TYPE);
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("远程目录传输中断: {error}"))
        })?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(RemoteError::new(
                "REMOTE_DOCUMENT_TOO_LARGE",
                "远程目录响应超过大小限制",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| RemoteError::new("REMOTE_TEXT_ENCODING", "远程目录不是有效的 UTF-8 XML"))?;
    Ok((final_url, content_type, text))
}

async fn open_cache_file(path: &Path, size: u64) -> Result<tokio::fs::File, RemoteError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            RemoteError::new("REMOTE_CACHE_IO", format!("无法创建缓存目录: {error}"))
        })?;
    }
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| {
            RemoteError::new("REMOTE_CACHE_IO", format!("无法打开缓存文件: {error}"))
        })?;
    file.set_len(size).await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法设置缓存文件大小: {error}"))
    })?;
    Ok(file)
}

async fn write_range(path: &Path, offset: u64, bytes: &[u8], size: u64) -> Result<(), RemoteError> {
    let mut file = open_cache_file(path, size).await?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| {
            RemoteError::new("REMOTE_CACHE_IO", format!("无法定位缓存区间: {error}"))
        })?;
    file.write_all(bytes).await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法写入缓存区间: {error}"))
    })?;
    file.flush().await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法刷新缓存文件: {error}"))
    })?;
    Ok(())
}

async fn read_range_file(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, RemoteError> {
    let mut file = tokio::fs::File::open(path).await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法读取缓存文件: {error}"))
    })?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| {
            RemoteError::new("REMOTE_CACHE_IO", format!("无法定位缓存文件: {error}"))
        })?;
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes)
        .await
        .map_err(|error| RemoteError::new("REMOTE_CACHE_IO", format!("缓存区间不完整: {error}")))?;
    Ok(bytes)
}

async fn download_response(
    response: Response,
    path: &Path,
    limit: u64,
    token: Option<&CancellationToken>,
) -> Result<u64, RemoteError> {
    let partial = path.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法创建下载缓存: {error}"))
    })?;
    let mut written = 0_u64;
    let mut stream = response.bytes_stream();
    loop {
        let next = match token {
            Some(token) => tokio::select! {
                _ = token.cancelled() => {
                    let _ = tokio::fs::remove_file(&partial).await;
                    return Err(cancelled_error());
                }
                next = stream.next() => next,
            },
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("远程下载中断: {error}"))
        })?;
        written = written.saturating_add(chunk.len() as u64);
        if written > limit {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(RemoteError::new(
                "REMOTE_CACHE_SPACE_INSUFFICIENT",
                "无 Range 资源超过当前缓存上限",
            ));
        }
        file.write_all(&chunk).await.map_err(|error| {
            RemoteError::new("REMOTE_CACHE_IO", format!("无法写入下载缓存: {error}"))
        })?;
    }
    file.flush().await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法刷新下载缓存: {error}"))
    })?;
    drop(file);
    tokio::fs::rename(&partial, path).await.map_err(|error| {
        RemoteError::new("REMOTE_CACHE_IO", format!("无法提交下载缓存: {error}"))
    })?;
    Ok(written)
}

fn prepare_cache(
    app: &AppHandle,
    url: &Url,
    size: u64,
    etag: Option<&str>,
    last_modified: Option<&str>,
    session_id: &str,
    handle_sequence: u64,
) -> Result<(String, PathBuf), RemoteError> {
    let data_dir = library::app_data_dir(app)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    let cache_dir =
        library::cache_dir(app).map_err(|message| RemoteError::new("REMOTE_CACHE_IO", message))?;
    let mut connection = library::open_database_at(&data_dir)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    let (source_key, version) = cache_keys(url, etag, last_modified, session_id, handle_sequence);
    let object_id = stable_hash(&format!("{}\n{version}", url.as_str()));
    let cache_path = cache_dir.join(format!("{}.bin", &object_id[..32]));
    let transaction = connection.transaction().map_err(|error| {
        RemoteError::new("REMOTE_CACHE_DB", format!("无法开启缓存对象事务: {error}"))
    })?;
    let mut replaced_path = None;
    if let Some((existing_id, existing_path)) = find_cache_object(&transaction, &source_key)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?
    {
        if existing_id != object_id {
            transaction
                .execute(
                    "DELETE FROM cache_objects WHERE id=?1",
                    rusqlite::params![existing_id],
                )
                .map_err(|error| {
                    RemoteError::new("REMOTE_CACHE_DB", format!("无法废弃旧缓存: {error}"))
                })?;
            replaced_path = confined_cache_path(&cache_dir, &existing_path);
        }
    }
    upsert_cache_object(
        &transaction,
        &CacheObject {
            id: object_id.clone(),
            source_key,
            path: cache_path.to_string_lossy().into_owned(),
            total_size: Some(size),
            etag: etag.map(ToOwned::to_owned),
            last_modified: last_modified.map(ToOwned::to_owned),
            complete: false,
            bytes_cached: 0,
            last_accessed: library::now_ms(),
        },
    )
    .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    transaction.commit().map_err(|error| {
        RemoteError::new("REMOTE_CACHE_DB", format!("无法提交缓存对象事务: {error}"))
    })?;
    if let Some(path) = replaced_path {
        let _ = std::fs::remove_file(path);
    }
    Ok((object_id, cache_path))
}

fn mark_cached(
    app: &AppHandle,
    object_id: &str,
    range: ByteRange,
    complete: bool,
) -> Result<(), RemoteError> {
    let data_dir = library::app_data_dir(app)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    let cache_dir =
        library::cache_dir(app).map_err(|message| RemoteError::new("REMOTE_CACHE_IO", message))?;
    let mut connection = library::open_database_at(&data_dir)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    record_cached_range(&mut connection, object_id, range)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    if complete {
        connection
            .execute(
                "UPDATE cache_objects SET complete=1 WHERE id=?1",
                rusqlite::params![object_id],
            )
            .map_err(|error| {
                RemoteError::new("REMOTE_CACHE_DB", format!("无法更新完整缓存: {error}"))
            })?;
    }
    let limit =
        cache_limit(&connection).map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    let removed = evict_cache(&mut connection, &cache_dir, limit)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    if !removed.is_empty() {
        // The active object is touched immediately before eviction. If it was
        // still the oldest object, it alone exceeds the configured bound.
        let active_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_objects WHERE id=?1)",
                rusqlite::params![object_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                RemoteError::new("REMOTE_CACHE_DB", format!("无法检查缓存对象: {error}"))
            })?;
        if !active_exists {
            return Err(RemoteError::new(
                "REMOTE_CACHE_SPACE_INSUFFICIENT",
                "远程资源超过当前缓存上限",
            ));
        }
    }
    Ok(())
}

fn ranges_for(app: &AppHandle, object_id: &str) -> Result<Vec<ByteRange>, RemoteError> {
    let mut connection = library::open_database_at(
        &library::app_data_dir(app)
            .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?,
    )
    .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    let ranges = cached_ranges(&connection, object_id)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    touch_cache_object(&mut connection, object_id)
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
    Ok(ranges)
}

/// Return the seek metadata for an opaque remote handle. Callers that can read
/// through `read_range_bytes` may use the sparse file immediately; path-only
/// decoders must still require `cache_complete` before opening it.
pub(crate) fn file_info(
    app: &AppHandle,
    state: &RemoteState,
    resource_id: &str,
) -> Result<RemoteFileInfo, RemoteError> {
    let handle = state
        .handles
        .lock()
        .map_err(|_| lock_error())?
        .get(resource_id)
        .cloned()
        .ok_or_else(|| RemoteError::new("REMOTE_HANDLE_NOT_FOUND", "远程资源句柄不存在"))?;
    let cache_complete = if handle.size > 0 {
        let requested = ByteRange::new(0, handle.size)
            .map_err(|message| RemoteError::new("REMOTE_RANGE_INVALID", message))?;
        library::range_is_covered(&ranges_for(app, &handle.object_id)?, requested)
    } else {
        true
    };
    Ok(RemoteFileInfo {
        size: handle.size,
        identity: handle.identity.clone(),
        cache_path: handle.cache_path.clone(),
        cache_complete,
    })
}

#[tauri::command]
pub async fn remote_open(
    app: AppHandle,
    state: State<'_, RemoteState>,
    url: String,
    item_id: String,
    allow_http: Option<bool>,
    credential_ref: Option<String>,
    request_id: Option<String>,
) -> Result<RemoteOpenResult, RemoteError> {
    let url = validate_remote_url(&url, allow_http.unwrap_or(false))?;
    let handle_sequence = state.sequence.fetch_add(1, Ordering::Relaxed);
    let request_id = request_id.unwrap_or_else(|| format!("open-{handle_sequence}"));
    let (token, _request_guard) =
        register_active_request(state.inner(), request_id, String::new())?;
    let credential = credential_ref
        .as_deref()
        .and_then(|reference| load_credential(&state, reference));
    let client = build_client(&url, credential.is_some())?;
    let head = tokio::select! {
        _ = token.cancelled() => return Err(cancelled_error()),
        response = apply_credential(client.head(url.clone()), credential.as_ref()).send() => response.ok(),
    };
    if let Some(response) = head
        .as_ref()
        .filter(|response| response.status() != StatusCode::METHOD_NOT_ALLOWED)
    {
        if let Some(error) = response_error(response) {
            return Err(error);
        }
    }
    let head_size = head
        .as_ref()
        .and_then(|response| response.headers().get(CONTENT_LENGTH))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut etag = head
        .as_ref()
        .and_then(|response| header_string(response.headers(), ETAG));
    let mut last_modified = head
        .as_ref()
        .and_then(|response| header_string(response.headers(), LAST_MODIFIED));
    let mut mime_type = head
        .as_ref()
        .and_then(|response| header_string(response.headers(), CONTENT_TYPE));

    if head_size == Some(0) {
        if token.is_cancelled() {
            return Err(cancelled_error());
        }
        let (object_id, cache_path) = prepare_cache(
            &app,
            &url,
            0,
            etag.as_deref(),
            last_modified.as_deref(),
            &state.session_id,
            handle_sequence,
        )?;
        let _ = tokio::fs::File::create(&cache_path).await;
        if token.is_cancelled() {
            return Err(cancelled_error());
        }
        let resource_id = format!("remote-{handle_sequence}");
        let version = resource_version(
            etag.as_deref(),
            last_modified.as_deref(),
            &state.session_id,
            handle_sequence,
        );
        let identity = format!("{item_id}@{version}");
        state.handles.lock().map_err(|_| lock_error())?.insert(
            resource_id.clone(),
            Arc::new(RemoteHandle {
                url,
                client,
                identity: identity.clone(),
                size: 0,
                object_id,
                cache_path,
                etag: etag.clone(),
                last_modified: last_modified.clone(),
                credential,
                supports_ranges: false,
                mime_type: mime_type.clone(),
            }),
        );
        return Ok(RemoteOpenResult {
            resource_id,
            size: 0,
            identity,
            etag,
            last_modified,
            mime_type,
            supports_ranges: false,
            cache_complete: true,
        });
    }

    let response = tokio::select! {
        _ = token.cancelled() => return Err(cancelled_error()),
        response = apply_credential(
            client.get(url.clone()).header(RANGE, "bytes=0-0"),
            credential.as_ref(),
        ).send() => response.map_err(|error| {
            RemoteError::new("REMOTE_NETWORK_ERROR", format!("无法连接远程资源: {error}"))
        })?,
    };
    if let Some(error) = response_error(&response) {
        return Err(error);
    }
    etag = header_string(response.headers(), ETAG).or(etag);
    last_modified = header_string(response.headers(), LAST_MODIFIED).or(last_modified);
    mime_type = header_string(response.headers(), CONTENT_TYPE).or(mime_type);
    let supports_ranges = response.status() == StatusCode::PARTIAL_CONTENT;
    let (size, object_id, cache_path, cache_complete) = if supports_ranges {
        let raw_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "206 响应缺少 Content-Range")
            })?;
        let parsed = parse_content_range(raw_range)?;
        ensure_frontend_safe_size(parsed.total)?;
        if parsed.start != 0 || parsed.end_inclusive != 0 {
            return Err(RemoteError::new(
                "REMOTE_CONTENT_RANGE_INVALID",
                "服务器返回了错误的探测区间",
            ));
        }
        let bytes = tokio::select! {
            _ = token.cancelled() => return Err(cancelled_error()),
            bytes = response.bytes() => bytes.map_err(|error| {
                RemoteError::new(
                    "REMOTE_NETWORK_ERROR",
                    format!("无法读取远程探测响应: {error}"),
                )
            })?,
        };
        if bytes.len() != 1 {
            return Err(RemoteError::new(
                "REMOTE_CONTENT_RANGE_INVALID",
                "远程探测响应长度无效",
            ));
        }
        let (object_id, cache_path) = prepare_cache(
            &app,
            &url,
            parsed.total,
            etag.as_deref(),
            last_modified.as_deref(),
            &state.session_id,
            handle_sequence,
        )?;
        write_range(&cache_path, 0, &bytes, parsed.total).await?;
        mark_cached(&app, &object_id, ByteRange::new(0, 1).unwrap(), false)?;
        (parsed.total, object_id, cache_path, parsed.total == 1)
    } else if response.status().is_success() {
        let size_hint = ensure_frontend_safe_size(
            head_size
                .or_else(|| response.content_length())
                .ok_or_else(|| RemoteError::new("REMOTE_SIZE_UNKNOWN", "服务器未提供资源大小"))?,
        )?;
        let (object_id, cache_path) = prepare_cache(
            &app,
            &url,
            size_hint,
            etag.as_deref(),
            last_modified.as_deref(),
            &state.session_id,
            handle_sequence,
        )?;
        let connection = library::open_database_at(
            &library::app_data_dir(&app)
                .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?,
        )
        .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
        let limit = cache_limit(&connection)
            .map_err(|message| RemoteError::new("REMOTE_CACHE_DB", message))?;
        let downloaded = download_response(response, &cache_path, limit, Some(&token)).await?;
        if downloaded != size_hint {
            return Err(RemoteError::new(
                "REMOTE_SIZE_CHANGED",
                "远程资源大小与响应头不一致",
            ));
        }
        if downloaded > 0 {
            mark_cached(
                &app,
                &object_id,
                ByteRange::new(0, downloaded).unwrap(),
                true,
            )?;
        }
        (downloaded, object_id, cache_path, true)
    } else {
        return Err(RemoteError::status(
            "REMOTE_HTTP_ERROR",
            format!("远程服务器返回 HTTP {}", response.status().as_u16()),
            response.status(),
        ));
    };

    if token.is_cancelled() {
        return Err(cancelled_error());
    }
    let resource_id = format!("remote-{handle_sequence}");
    let version = resource_version(
        etag.as_deref(),
        last_modified.as_deref(),
        &state.session_id,
        handle_sequence,
    );
    let identity = format!("{item_id}@{version}");
    state.handles.lock().map_err(|_| lock_error())?.insert(
        resource_id.clone(),
        Arc::new(RemoteHandle {
            url,
            client,
            identity: identity.clone(),
            size,
            object_id,
            cache_path,
            etag: etag.clone(),
            last_modified: last_modified.clone(),
            credential,
            supports_ranges,
            mime_type: mime_type.clone(),
        }),
    );
    Ok(RemoteOpenResult {
        resource_id,
        size,
        identity,
        etag,
        last_modified,
        mime_type,
        supports_ranges,
        cache_complete,
    })
}

/// Return metadata for an already opened backend handle. The frontend keeps
/// only the opaque resource id; URL and credentials never cross this boundary.
#[tauri::command]
pub fn remote_info(
    app: AppHandle,
    state: State<'_, RemoteState>,
    resource_id: String,
) -> Result<RemoteOpenResult, RemoteError> {
    let handle = state
        .handles
        .lock()
        .map_err(|_| lock_error())?
        .get(&resource_id)
        .cloned()
        .ok_or_else(|| RemoteError::new("REMOTE_HANDLE_NOT_FOUND", "远程资源句柄不存在"))?;
    let cache_complete = if handle.size == 0 {
        true
    } else {
        let ranges = ranges_for(&app, &handle.object_id)?;
        library::range_is_covered(
            &ranges,
            ByteRange::new(0, handle.size)
                .map_err(|message| RemoteError::new("REMOTE_RANGE_INVALID", message))?,
        )
    };
    Ok(RemoteOpenResult {
        resource_id,
        size: handle.size,
        identity: handle.identity.clone(),
        etag: handle.etag.clone(),
        last_modified: handle.last_modified.clone(),
        mime_type: handle.mime_type.clone(),
        supports_ranges: handle.supports_ranges,
        cache_complete,
    })
}

fn validators_match(handle: &RemoteHandle, headers: &HeaderMap) -> bool {
    let etag = header_string(headers, ETAG);
    let modified = header_string(headers, LAST_MODIFIED);
    (etag.is_none() || handle.etag.is_none() || etag == handle.etag)
        && (modified.is_none()
            || handle.last_modified.is_none()
            || modified == handle.last_modified)
}

async fn fetch_range(
    app: &AppHandle,
    handle: &RemoteHandle,
    requested: ByteRange,
    token: &CancellationToken,
) -> Result<Vec<u8>, RemoteError> {
    let mut builder = handle.client.get(handle.url.clone()).header(
        RANGE,
        format!("bytes={}-{}", requested.start, requested.end - 1),
    );
    if let Some(validator) = handle.etag.as_ref().or(handle.last_modified.as_ref()) {
        builder = builder.header(IF_RANGE, validator);
    }
    let response = tokio::select! {
        _ = token.cancelled() => return Err(RemoteError::new("REMOTE_CANCELLED", "远程读取已取消")),
        response = apply_credential(builder, handle.credential.as_ref()).send() => response
            .map_err(|error| RemoteError::new("REMOTE_NETWORK_ERROR", format!("远程区间读取失败: {error}")))?,
    };
    if let Some(error) = response_error(&response) {
        return Err(error);
    }
    if !validators_match(handle, response.headers()) {
        return Err(RemoteError::new(
            "REMOTE_RESOURCE_CHANGED",
            "远程资源已发生变化，请重新打开",
        ));
    }
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(RemoteError::new(
            "REMOTE_RANGE_UNAVAILABLE",
            "服务器不再支持区间读取，请重新打开以建立完整缓存",
        ));
    }
    let raw_range = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            RemoteError::new("REMOTE_CONTENT_RANGE_INVALID", "206 响应缺少 Content-Range")
        })?;
    let parsed = parse_content_range(raw_range)?;
    if parsed.start != requested.start
        || parsed.end_inclusive + 1 != requested.end
        || parsed.total != handle.size
    {
        return Err(RemoteError::new(
            "REMOTE_CONTENT_RANGE_INVALID",
            "服务器返回了错误的区间边界",
        ));
    }
    let bytes = tokio::select! {
        _ = token.cancelled() => return Err(RemoteError::new("REMOTE_CANCELLED", "远程读取已取消")),
        bytes = response.bytes() => bytes
            .map_err(|error| RemoteError::new("REMOTE_NETWORK_ERROR", format!("远程区间传输中断: {error}")))?,
    };
    if bytes.len() as u64 != requested.len() {
        return Err(RemoteError::new(
            "REMOTE_CONTENT_RANGE_INVALID",
            "远程区间响应长度无效",
        ));
    }
    write_range(&handle.cache_path, requested.start, &bytes, handle.size).await?;
    mark_cached(app, &handle.object_id, requested, false)?;
    Ok(bytes.to_vec())
}

pub(crate) async fn read_range_bytes(
    app: &AppHandle,
    state: &RemoteState,
    resource_id: &str,
    offset: u64,
    length: u64,
    request_id: Option<String>,
) -> Result<Vec<u8>, RemoteError> {
    if length > MAX_RANGE_BYTES {
        return Err(RemoteError::new(
            "REMOTE_RANGE_TOO_LARGE",
            format!("单次区间读取不能超过 {MAX_RANGE_BYTES} 字节"),
        ));
    }
    let handle = state
        .handles
        .lock()
        .map_err(|_| lock_error())?
        .get(resource_id)
        .cloned()
        .ok_or_else(|| RemoteError::new("REMOTE_HANDLE_NOT_FOUND", "远程资源句柄不存在"))?;
    let end = offset
        .checked_add(length)
        .ok_or_else(|| RemoteError::new("REMOTE_RANGE_INVALID", "远程区间溢出"))?;
    if end > handle.size {
        return Err(RemoteError::new(
            "REMOTE_RANGE_INVALID",
            "远程区间超出资源大小",
        ));
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    let requested = ByteRange::new(offset, end)
        .map_err(|message| RemoteError::new("REMOTE_RANGE_INVALID", message))?;
    let ranges = ranges_for(app, &handle.object_id)?;
    if library::range_is_covered(&ranges, requested) {
        return read_range_file(&handle.cache_path, offset, length).await;
    }
    if !handle.supports_ranges {
        return Err(RemoteError::new(
            "REMOTE_CACHE_INCOMPLETE",
            "完整缓存尚未就绪",
        ));
    }
    let request_id = request_id
        .unwrap_or_else(|| format!("request-{}", state.sequence.fetch_add(1, Ordering::Relaxed)));
    let (token, _request_guard) =
        register_active_request(state, request_id, resource_id.to_string())?;
    fetch_range(app, &handle, requested, &token).await
}

#[tauri::command]
pub async fn remote_read_range(
    app: AppHandle,
    state: State<'_, RemoteState>,
    resource_id: String,
    offset: u64,
    length: u64,
    request_id: Option<String>,
) -> Result<tauri::ipc::Response, RemoteError> {
    Ok(tauri::ipc::Response::new(
        read_range_bytes(
            &app,
            state.inner(),
            &resource_id,
            offset,
            length,
            request_id,
        )
        .await?,
    ))
}

pub(crate) fn cancel_requests(
    state: &RemoteState,
    resource_id: Option<&str>,
    request_id: Option<&str>,
) -> Result<(), RemoteError> {
    let requests = state.active_requests.lock().map_err(|_| lock_error())?;
    for (id, request) in requests.iter() {
        if request_id.is_some_and(|candidate| candidate == id.as_str())
            || resource_id.is_some_and(|candidate| candidate == request.resource_id.as_str())
        {
            request.token.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remote_cancel(
    state: State<'_, RemoteState>,
    resource_id: Option<String>,
    request_id: Option<String>,
) -> Result<(), RemoteError> {
    cancel_requests(state.inner(), resource_id.as_deref(), request_id.as_deref())
}

#[tauri::command]
pub fn remote_close(state: State<'_, RemoteState>, resource_id: String) -> Result<(), RemoteError> {
    state
        .handles
        .lock()
        .map_err(|_| lock_error())?
        .remove(&resource_id);
    let requests = state.active_requests.lock().map_err(|_| lock_error())?;
    for request in requests.values() {
        if request.resource_id == resource_id {
            request.token.cancel();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_policy_requires_explicit_http_and_blocks_other_schemes() {
        assert!(validate_remote_url("https://example.test/book.cbz", false).is_ok());
        assert_eq!(
            validate_remote_url("http://192.168.1.2/book.cbz", false)
                .unwrap_err()
                .code,
            "REMOTE_HTTP_NOT_ALLOWED"
        );
        assert!(validate_remote_url("http://192.168.1.2/book.cbz", true).is_ok());
        assert!(validate_remote_url("file:///tmp/book.cbz", true).is_err());
        assert_eq!(
            validate_remote_url("https://reader:secret@example.test/book.cbz", false)
                .unwrap_err()
                .code,
            "REMOTE_URL_INVALID"
        );
    }

    #[test]
    fn redirects_never_downgrade_https() {
        let secure = Url::parse("https://example.test/a").unwrap();
        let insecure = Url::parse("http://example.test/b").unwrap();
        let other_secure = Url::parse("https://cdn.example.test/b").unwrap();
        let embedded_credential = Url::parse("https://reader:secret@example.test/b").unwrap();
        assert!(!redirect_allowed(&secure, &insecure));
        assert!(redirect_allowed(&secure, &other_secure));
        assert!(!redirect_allowed(&secure, &embedded_credential));
        assert!(!redirect_allowed_for_request(
            &secure,
            &secure,
            &other_secure,
            true
        ));
        assert!(redirect_allowed_for_request(
            &secure,
            &secure,
            &other_secure,
            false
        ));
    }

    #[test]
    fn credential_origins_include_scheme_host_and_effective_port() {
        let source = Url::parse("https://books.example/opds").unwrap();
        assert!(same_origin(
            &source,
            &Url::parse("https://books.example:443/book.cbz").unwrap()
        ));
        assert!(!same_origin(
            &source,
            &Url::parse("https://cdn.example/book.cbz").unwrap()
        ));
        assert!(!same_origin(
            &source,
            &Url::parse("http://books.example/book.cbz").unwrap()
        ));
    }

    #[test]
    fn content_range_parser_is_strict() {
        assert_eq!(
            parse_content_range("bytes 10-19/100").unwrap(),
            ParsedContentRange {
                start: 10,
                end_inclusive: 19,
                total: 100,
            }
        );
        for invalid in ["bytes */100", "items 0-1/2", "bytes 2-1/3", "bytes 0-3/3"] {
            assert!(parse_content_range(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn rejects_sizes_that_javascript_cannot_address_exactly() {
        assert_eq!(
            ensure_frontend_safe_size(MAX_FRONTEND_SAFE_BYTES + 1)
                .unwrap_err()
                .code,
            "REMOTE_DOCUMENT_TOO_LARGE"
        );
        assert_eq!(
            ensure_frontend_safe_size(MAX_FRONTEND_SAFE_BYTES).unwrap(),
            MAX_FRONTEND_SAFE_BYTES
        );
    }

    #[test]
    fn unvalidated_cache_keys_are_isolated_by_session() {
        let url = Url::parse("https://example.test/book.cbz").unwrap();
        let first = cache_keys(&url, None, None, "application-a", 1);
        let second = cache_keys(&url, None, None, "application-b", 1);
        assert_ne!(first, second);
        assert_eq!(
            cache_keys(&url, Some("\"v1\""), None, "application-a", 1),
            cache_keys(&url, Some("\"v1\""), None, "application-b", 2)
        );
    }

    #[test]
    fn opening_requests_can_be_cancelled_before_a_resource_handle_exists() {
        let state = RemoteState::default();
        let (token, guard) =
            register_active_request(&state, "open-test".into(), String::new()).unwrap();
        cancel_requests(&state, None, Some("open-test")).unwrap();
        assert!(token.is_cancelled());
        drop(guard);
        assert!(state.active_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn duplicate_request_ids_do_not_replace_active_cancellation_tokens() {
        let state = RemoteState::default();
        let (token, guard) =
            register_active_request(&state, "request-test".into(), "remote-1".into()).unwrap();
        let duplicate = register_active_request(&state, "request-test".into(), "remote-2".into());
        let error = match duplicate {
            Ok(_) => panic!("duplicate request id should be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, "REMOTE_REQUEST_CONFLICT");
        cancel_requests(&state, None, Some("request-test")).unwrap();
        assert!(token.is_cancelled());
        drop(guard);
        assert!(state.active_requests.lock().unwrap().is_empty());
    }
}
