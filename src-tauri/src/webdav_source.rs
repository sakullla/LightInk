//! WebDAV 书库源：命名源的存储、CRUD 与只读连接探测。
//!
//! 与管理页 WebDAV 同步（`webdav.rs`/`sync.rs`）彻底解耦（R5）：源记录落在
//! `library.sqlite3` 的 `webdav_sources` 表（schema v9），错误码使用独立的
//! `WEBDAV_SOURCE_` 前缀，不同步语义不外溢。凭据复用 `remote.rs` 的凭据通道
//! （service 同为 `lightink.opds`，ref 命名 `webdav-source-{id}`），使
//! `remote_open` 的凭据装载无需改动；删除源时该 ref 的凭据一并清除。
//! 测试连接只做 PROPFIND depth:0 只读探测，禁止复用带 MKCOL/PUT 写副作用的
//! 同步 capability 探测。

use crate::library::{self, WebDavSource};
use crate::opds::{OpdsEntry, OpdsFeed, OpdsLink};
use crate::remote::{
    forget_credential_value, load_credential, redirect_allowed, same_origin,
    store_credential_value, validate_remote_url, RemoteCredential, RemoteError, RemoteState,
};
use futures_util::StreamExt;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{CONTENT_LENGTH, SERVER};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, State};
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BROWSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BROWSE_ENTRIES: usize = 2000;
const MAX_BROWSE_XML_DEPTH: usize = 16;

// 不派生 Debug：input 可能携带凭据本体，避免误入日志。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSourceInput {
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    pub allow_http: Option<bool>,
    pub credential_ref: Option<String>,
    pub credential: Option<RemoteCredential>,
    pub clear_credential: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSourceTestResult {
    pub ok: bool,
    pub final_url: String,
    pub server: Option<String>,
}

fn source_error(code: &str, message: impl Into<String>) -> RemoteError {
    RemoteError::new(format!("WEBDAV_SOURCE_{code}"), message)
}

fn storage_error(message: impl Into<String>) -> RemoteError {
    source_error("STORAGE_ERROR", message)
}

/// URL 策略与 remote.rs 完全一致，仅把错误码改写为书库源前缀，
/// 使 HTTP 未授权等校验失败以 WEBDAV_SOURCE_ 前缀返回表单。
pub(crate) fn validate_source_url(raw: &str, allow_http: bool) -> Result<Url, RemoteError> {
    validate_remote_url(raw, allow_http).map_err(|error| {
        let code = error
            .code
            .strip_prefix("REMOTE_")
            .map(|suffix| format!("WEBDAV_SOURCE_{suffix}"))
            .unwrap_or_else(|| "WEBDAV_SOURCE_URL_INVALID".to_string());
        RemoteError::new(code, error.message)
    })
}

fn validate_credential(credential: &RemoteCredential) -> Result<(), RemoteError> {
    match credential {
        RemoteCredential::Basic { username, password } => {
            if username.trim().is_empty() || password.is_empty() {
                return Err(source_error(
                    "CREDENTIAL_INVALID",
                    "Basic 用户名和密码不能为空",
                ));
            }
        }
        RemoteCredential::Bearer { token } if token.trim().is_empty() => {
            return Err(source_error("CREDENTIAL_INVALID", "Bearer 令牌不能为空"));
        }
        RemoteCredential::Bearer { .. } => {}
    }
    Ok(())
}

pub(crate) fn stable_source_id(url: &Url) -> String {
    let digest = Sha256::digest(url.as_str().as_bytes());
    format!(
        "webdav-{}",
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

struct SourcePlan {
    source: WebDavSource,
    credential_to_store: Option<(String, RemoteCredential)>,
    stale_credential_ref: Option<String>,
}

/// 将表单输入解析为待保存的源记录与凭据动作；纯函数，便于覆盖失败分支。
fn plan_source(
    input: WebDavSourceInput,
    existing: Option<&WebDavSource>,
) -> Result<SourcePlan, RemoteError> {
    let allow_http = input.allow_http.unwrap_or(false);
    let url = validate_source_url(&input.url, allow_http)?;
    if input.title.trim().is_empty() {
        return Err(source_error("INVALID", "WebDAV 书库源名称不能为空"));
    }
    if input.clear_credential.unwrap_or(false) && input.credential.is_some() {
        return Err(source_error("INVALID", "不能同时清除和设置凭据"));
    }
    if let Some(credential) = input.credential.as_ref() {
        validate_credential(credential)?;
    }
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| stable_source_id(&url));
    let credential_ref = if input.clear_credential.unwrap_or(false) {
        None
    } else {
        input
            .credential_ref
            .or_else(|| existing.and_then(|value| value.credential_ref.clone()))
            .or_else(|| {
                input
                    .credential
                    .as_ref()
                    .map(|_| format!("webdav-source-{id}"))
            })
    };
    let now = library::now_ms();
    let source = WebDavSource {
        id,
        title: input.title.trim().to_string(),
        url: url.to_string(),
        credential_ref,
        allow_http,
        created_at: existing.map_or(now, |value| value.created_at),
        updated_at: now,
    };
    let credential_to_store = match (source.credential_ref.clone(), input.credential) {
        (Some(reference), Some(credential)) => Some((reference, credential)),
        _ => None,
    };
    let stale_credential_ref = existing
        .and_then(|value| value.credential_ref.clone())
        .filter(|old| source.credential_ref.as_deref() != Some(old.as_str()));
    Ok(SourcePlan {
        source,
        credential_to_store,
        stale_credential_ref,
    })
}

#[tauri::command]
pub fn webdav_source_add(
    app: AppHandle,
    state: State<'_, RemoteState>,
    input: WebDavSourceInput,
) -> Result<WebDavSource, RemoteError> {
    let existing = match input.id.as_deref() {
        Some(id) => Some(
            library::webdav_find_source_by_id(&app, id)
                .map_err(storage_error)?
                .ok_or_else(|| source_error("NOT_FOUND", "WebDAV 书库源不存在"))?,
        ),
        None => None,
    };
    let plan = plan_source(input, existing.as_ref())?;
    if let Some((reference, credential)) = plan.credential_to_store {
        store_credential_value(&state, reference, credential)?;
    }
    library::webdav_upsert_source(&app, &plan.source).map_err(storage_error)?;
    if let Some(old_reference) = plan.stale_credential_ref {
        forget_credential_value(state.inner(), &old_reference)?;
    }
    Ok(plan.source)
}

#[tauri::command]
pub fn webdav_source_list(app: AppHandle) -> Result<Vec<WebDavSource>, RemoteError> {
    library::webdav_list_sources(&app).map_err(storage_error)
}

#[tauri::command]
pub fn webdav_source_remove(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
) -> Result<(), RemoteError> {
    let source = library::webdav_find_source_by_id(&app, &source_id)
        .map_err(storage_error)?
        .ok_or_else(|| source_error("NOT_FOUND", "WebDAV 书库源不存在"))?;
    library::webdav_remove_source(&app, &source_id).map_err(storage_error)?;
    if let Some(credential_ref) = source.credential_ref {
        forget_credential_value(state.inner(), &credential_ref)?;
    }
    Ok(())
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

fn build_probe_client(initial: &Url, authenticated: bool) -> Result<Client, RemoteError> {
    let first = initial.clone();
    let credential_origin = initial.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("redirect limit exceeded");
        }
        let from = attempt.previous().last().unwrap_or(&first);
        let target = attempt.url();
        let allowed = redirect_allowed(from, target)
            && (!authenticated || crate::remote::same_origin(&credential_origin, target));
        if !allowed {
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
            source_error(
                "CLIENT_ERROR",
                format!("无法创建 WebDAV 书库源客户端: {error}"),
            )
        })
}

/// 对（可能尚未保存的）url+凭据做 PROPFIND depth:0 只读探测。
pub(crate) async fn probe_source(
    url: &Url,
    credential: Option<&RemoteCredential>,
) -> Result<WebDavSourceTestResult, RemoteError> {
    let client = build_probe_client(url, credential.is_some())?;
    let request = apply_credential(
        client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), url.clone())
            .header("Depth", "0")
            .header(CONTENT_LENGTH, "0"),
        credential,
    );
    let response = request.send().await.map_err(|error| {
        source_error("NETWORK_ERROR", format!("无法连接 WebDAV 书库源: {error}"))
    })?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_AUTH_REQUIRED",
            "WebDAV 书库源需要鉴权",
            status,
        ));
    }
    if status == StatusCode::FORBIDDEN {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_FORBIDDEN",
            "没有 WebDAV 书库源访问权限",
            status,
        ));
    }
    if !(status.is_success() || status == StatusCode::MULTI_STATUS) {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_HTTP_ERROR",
            format!("WebDAV 书库源返回 HTTP {}", status.as_u16()),
            status,
        ));
    }
    let server = response
        .headers()
        .get(SERVER)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    Ok(WebDavSourceTestResult {
        ok: true,
        final_url: response.url().to_string(),
        server,
    })
}

#[tauri::command]
pub async fn webdav_source_test(
    state: State<'_, RemoteState>,
    input: WebDavSourceInput,
) -> Result<WebDavSourceTestResult, RemoteError> {
    let allow_http = input.allow_http.unwrap_or(false);
    let url = validate_source_url(&input.url, allow_http)?;
    let credential = match input.credential {
        Some(credential) => {
            validate_credential(&credential)?;
            Some(credential)
        }
        None => input
            .credential_ref
            .as_deref()
            .and_then(|reference| load_credential(&state, reference)),
    };
    probe_source(&url, credential.as_ref()).await
}

// ---------------------------------------------------------------------------
// T2：目录浏览（PROPFIND depth=1 → OpdsFeed 同构 JSON）
// ---------------------------------------------------------------------------

/// 与 opds.rs 的可读扩展名集合保持一致：其余文件不出现在浏览结果中。
const SUPPORTED_BOOK_EXTENSIONS: [&str; 10] = [
    "epub", "pdf", "cbz", "cbr", "rar", "cb7", "7z", "mobi", "fb2", "txt",
];

/// 单次百分号解码，仅用于派生显示标题（last_path_segment）；URL 解析绝不做
/// 整体解码，避免还原出的 '#'/'?'/'%XX' 被解析器二次解释为分隔符或再次解码。
/// 不把 '+' 当作空格（路径语义，非表单编码）。
fn percent_decode(raw: &str) -> Result<String, RemoteError> {
    let invalid = || source_error("HREF_INVALID", "PROPFIND href 的百分号编码无效");
    let bytes = raw.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3).ok_or_else(invalid)?;
            let hex = std::str::from_utf8(pair)
                .ok()
                .filter(|value| value.len() == 2);
            let value = hex
                .and_then(|value| u8::from_str_radix(value, 16).ok())
                .ok_or_else(invalid)?;
            output.push(value);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| invalid())
}

/// 目录浏览统一以结尾斜杠规范化：depth=1 响应的自身识别与相对 href
/// 解析都依赖集合 URL 形态。
fn normalize_collection_url(mut url: Url) -> Url {
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url
}

/// 解析 PROPFIND href（绝对 URL / 服务器绝对路径 / 相对路径，已编码或未编码）。
/// 结果必须是同源、无内嵌凭据、且不从 HTTPS 降级的合法 URL，否则拒绝。
///
/// 必须先对原始 href 做 URL 解析：若先整体百分号解码，`%23`/`%3F`/`%2520`
/// 会分别被当成 fragment、query 或再次解码，acquisition URL 就会指向错误资源。
fn resolve_href(base: &Url, root: &Url, raw_href: &str) -> Result<Url, RemoteError> {
    let trimmed = raw_href.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(source_error(
            "HREF_INVALID",
            "PROPFIND href 为空或包含控制字符",
        ));
    }
    let joined = base
        .join(trimmed)
        .map_err(|_| source_error("HREF_INVALID", "PROPFIND href 不是合法 URL"))?;
    if !matches!(joined.scheme(), "http" | "https") || joined.host_str().is_none() {
        return Err(source_error(
            "HREF_INVALID",
            "PROPFIND href 不是合法 HTTP(S) URL",
        ));
    }
    if !joined.username().is_empty() || joined.password().is_some() {
        return Err(source_error(
            "HREF_INVALID",
            "PROPFIND href 不能包含内嵌凭据",
        ));
    }
    if root.scheme() == "https" && joined.scheme() == "http" {
        return Err(source_error(
            "HREF_INVALID",
            "PROPFIND href 不允许从 HTTPS 降级到 HTTP",
        ));
    }
    if !same_origin(root, &joined) {
        return Err(source_error(
            "HREF_ORIGIN_MISMATCH",
            "PROPFIND href 指向书库源之外的位置",
        ));
    }
    Ok(joined)
}

/// 判断解析后的 href 是否指向被请求的集合自身（忽略结尾斜杠差异）。
fn is_self_reference(request: &Url, href: &Url) -> bool {
    same_origin(request, href)
        && href.path().trim_end_matches('/') == request.path().trim_end_matches('/')
        && href.query() == request.query()
}

/// 解码后的最后一个非空路径段；用于目录/文件标题回退。
/// 从仍编码的 `path()` 取段再单次解码，避免对已解码段再次展开 `%2520` 等。
fn last_path_segment(url: &Url) -> Option<String> {
    let segment = url.path().rsplit('/').find(|part| !part.is_empty())?;
    percent_decode(segment)
        .ok()
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Default)]
struct DavResource {
    href: Option<String>,
    display_name: Option<String>,
    content_length: Option<u64>,
    content_type: Option<String>,
    last_modified: Option<String>,
    is_collection: bool,
}

fn browse_item_id(source_id: &str, url: &str) -> String {
    let digest = Sha256::digest(format!("{source_id}\n{url}").as_bytes());
    format!(
        "webdav-item-{}",
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn record_text(stack: &[String], current: &mut Option<DavResource>, value: &str) {
    if value.is_empty() {
        return;
    }
    if let Some(resource) = current.as_mut() {
        match stack.last().map(String::as_str) {
            Some("href") if stack.iter().any(|part| part == "response") => {
                resource.href.get_or_insert_with(|| value.to_string());
            }
            Some("displayname") => {
                resource
                    .display_name
                    .get_or_insert_with(|| value.to_string());
            }
            Some("getcontentlength") => {
                if resource.content_length.is_none() {
                    resource.content_length = value.parse().ok();
                }
            }
            Some("getcontenttype") => {
                resource
                    .content_type
                    .get_or_insert_with(|| value.to_string());
            }
            Some("getlastmodified") => {
                resource
                    .last_modified
                    .get_or_insert_with(|| value.to_string());
            }
            _ => {}
        }
    }
}

/// 解析 multistatus XML 为资源列表；结构性问题返回 WEBDAV_SOURCE_ 错误，
/// 绝不以空结果伪装成功。
fn parse_multistatus(xml: &str) -> Result<Vec<DavResource>, RemoteError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = true;
    let local = |raw: &[u8]| -> String {
        let name = raw.rsplit(|byte| *byte == b':').next().unwrap_or(raw);
        String::from_utf8_lossy(name).to_ascii_lowercase()
    };
    let mut stack: Vec<String> = Vec::new();
    let mut resources: Vec<DavResource> = Vec::new();
    let mut current: Option<DavResource> = None;
    let mut saw_multistatus = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                if stack.len() >= MAX_BROWSE_XML_DEPTH {
                    return Err(source_error("XML_TOO_DEEP", "multistatus XML 嵌套过深"));
                }
                let name = local(element.name().as_ref());
                if stack.is_empty() {
                    if name == "multistatus" {
                        saw_multistatus = true;
                    }
                } else if name == "response" && current.is_none() {
                    current = Some(DavResource::default());
                } else if name == "collection" && stack.iter().any(|part| part == "resourcetype") {
                    if let Some(resource) = current.as_mut() {
                        resource.is_collection = true;
                    }
                }
                stack.push(name);
            }
            Ok(Event::Empty(element)) => {
                let name = local(element.name().as_ref());
                if name == "collection" && stack.iter().any(|part| part == "resourcetype") {
                    if let Some(resource) = current.as_mut() {
                        resource.is_collection = true;
                    }
                }
            }
            Ok(Event::Text(text)) => {
                let value = text.decode().map_err(|error| {
                    source_error("XML_INVALID", format!("multistatus 文本编码无效: {error}"))
                })?;
                record_text(&stack, &mut current, value.trim());
            }
            Ok(Event::CData(text)) => {
                let value = text.decode().map_err(|error| {
                    source_error(
                        "XML_INVALID",
                        format!("multistatus CDATA 编码无效: {error}"),
                    )
                })?;
                record_text(&stack, &mut current, value.trim());
            }
            Ok(Event::End(element)) => {
                let name = local(element.name().as_ref());
                if name == "response" {
                    if let Some(resource) = current.take() {
                        if resources.len() >= MAX_BROWSE_ENTRIES {
                            return Err(source_error(
                                "TOO_MANY_ENTRIES",
                                "WebDAV 目录条目数量过多",
                            ));
                        }
                        resources.push(resource);
                    }
                }
                stack.pop();
            }
            Ok(Event::DocType(_)) => {
                return Err(source_error("XML_UNSAFE", "multistatus 不允许声明 DTD"));
            }
            Ok(Event::Eof) => {
                if !stack.is_empty() || current.is_some() {
                    return Err(source_error("XML_INVALID", "multistatus XML 未闭合"));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(source_error(
                    "XML_INVALID",
                    format!("multistatus XML 损坏: {error}"),
                ));
            }
        }
    }
    if !saw_multistatus {
        return Err(source_error(
            "MULTISTATUS_INVALID",
            "WebDAV 响应不是 multistatus 文档",
        ));
    }
    Ok(resources)
}

fn book_extension(url: &Url) -> Option<String> {
    let name = last_path_segment(url)?;
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    SUPPORTED_BOOK_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

fn resource_title(resource: &DavResource, url: &Url) -> String {
    resource
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| last_path_segment(url))
        .unwrap_or_else(|| url.to_string())
}

/// 把 depth=1 资源列表映射为 OpdsFeed：子目录=navigation 条目（相对路径
/// navigationUrl），受支持扩展名文件=书籍条目（同源绝对 acquisition URL）。
fn build_browse_feed(
    source: &WebDavSource,
    request_url: &Url,
    root_url: &Url,
    resources: Vec<DavResource>,
) -> Result<OpdsFeed, RemoteError> {
    let mut entries = Vec::new();
    for resource in &resources {
        let raw_href = resource
            .href
            .as_deref()
            .ok_or_else(|| source_error("HREF_INVALID", "multistatus response 缺少 href"))?;
        let resolved = resolve_href(request_url, root_url, raw_href)?;
        if is_self_reference(request_url, &resolved) {
            continue;
        }
        if entries.len() >= MAX_BROWSE_ENTRIES {
            return Err(source_error("TOO_MANY_ENTRIES", "WebDAV 目录条目数量过多"));
        }
        if resource.is_collection {
            let navigation_url = normalize_collection_url(resolved.clone()).to_string();
            entries.push(OpdsEntry {
                id: navigation_url.clone(),
                item_id: None,
                title: resource_title(resource, &resolved),
                authors: Vec::new(),
                updated: resource.last_modified.clone(),
                summary: None,
                cover_url: None,
                links: Vec::new(),
                kind: "navigation".to_string(),
                navigation_url: Some(navigation_url),
                subjects: Vec::new(),
                series: None,
            });
        } else if let Some(extension) = book_extension(&resolved) {
            let href = resolved.to_string();
            entries.push(OpdsEntry {
                id: href.clone(),
                item_id: Some(browse_item_id(&source.id, &href)),
                title: resource_title(resource, &resolved),
                authors: Vec::new(),
                updated: resource.last_modified.clone(),
                summary: None,
                cover_url: None,
                links: vec![OpdsLink {
                    href,
                    rel: "http://opds-spec.org/acquisition".to_string(),
                    media_type: resource.content_type.clone(),
                    title: None,
                    size: resource.content_length,
                    extension: Some(extension),
                    acquisition: true,
                }],
                kind: "publication".to_string(),
                navigation_url: None,
                subjects: Vec::new(),
                series: None,
            });
        }
        // 不支持扩展名的普通文件直接跳过，不出现在浏览结果中。
    }
    // 目录在前、书籍在后，各自按标题排序，行为与文件管理器一致。
    entries.sort_by(|left, right| {
        (left.kind != "navigation")
            .cmp(&(right.kind != "navigation"))
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });
    let title = if is_self_reference(root_url, request_url) {
        source.title.clone()
    } else {
        last_path_segment(request_url).unwrap_or_else(|| source.title.clone())
    };
    Ok(OpdsFeed {
        id: Some(request_url.to_string()),
        title,
        updated: None,
        entries,
        links: Vec::new(),
        next_url: None,
        previous_url: None,
        search_template: None,
        source_url: request_url.to_string(),
        format: "webdav".to_string(),
        groups: Vec::new(),
    })
}

async fn fetch_multistatus(
    url: &Url,
    credential: Option<&RemoteCredential>,
) -> Result<String, RemoteError> {
    let client = build_probe_client(url, credential.is_some())?;
    let request = apply_credential(
        client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), url.clone())
            .header("Depth", "1")
            .header(CONTENT_LENGTH, "0"),
        credential,
    );
    let response = request.send().await.map_err(|error| {
        source_error("NETWORK_ERROR", format!("无法连接 WebDAV 书库源: {error}"))
    })?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_AUTH_REQUIRED",
            "WebDAV 书库源需要鉴权",
            status,
        ));
    }
    if status == StatusCode::FORBIDDEN {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_FORBIDDEN",
            "没有 WebDAV 书库源访问权限",
            status,
        ));
    }
    if !(status.is_success() || status == StatusCode::MULTI_STATUS) {
        return Err(RemoteError::status(
            "WEBDAV_SOURCE_HTTP_ERROR",
            format!("WebDAV 书库源返回 HTTP {}", status.as_u16()),
            status,
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BROWSE_BYTES as u64)
    {
        return Err(source_error(
            "RESPONSE_TOO_LARGE",
            "WebDAV 目录响应超过大小限制",
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            source_error("NETWORK_ERROR", format!("WebDAV 目录传输中断: {error}"))
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BROWSE_BYTES {
            return Err(source_error(
                "RESPONSE_TOO_LARGE",
                "WebDAV 目录响应超过大小限制",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| source_error("XML_INVALID", "multistatus 不是有效的 UTF-8 XML"))
}

/// 以 PROPFIND depth=1 列举目录并映射为 OpdsFeed 同构 JSON。
#[tauri::command]
pub async fn webdav_source_browse(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
    url: Option<String>,
) -> Result<OpdsFeed, RemoteError> {
    let source = library::webdav_find_source_by_id(&app, &source_id)
        .map_err(storage_error)?
        .ok_or_else(|| source_error("NOT_FOUND", "WebDAV 书库源不存在"))?;
    let root = normalize_collection_url(validate_source_url(&source.url, source.allow_http)?);
    let target = match url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => validate_source_url(raw, source.allow_http)?,
        None => root.clone(),
    };
    let target = normalize_collection_url(target);
    if !same_origin(&root, &target) {
        return Err(source_error(
            "ORIGIN_MISMATCH",
            "只能浏览 WebDAV 书库源同源路径",
        ));
    }
    let credential = source
        .credential_ref
        .as_deref()
        .and_then(|reference| load_credential(&state, reference));
    let body = fetch_multistatus(&target, credential.as_ref()).await?;
    let resources = parse_multistatus(&body)?;
    build_browse_feed(&source, &target, &root, resources)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(url: &str) -> WebDavSourceInput {
        WebDavSourceInput {
            id: None,
            title: "漫画柜".to_string(),
            url: url.to_string(),
            allow_http: None,
            credential_ref: None,
            credential: None,
            clear_credential: None,
        }
    }

    #[test]
    fn url_failures_use_the_source_error_prefix() {
        assert_eq!(
            validate_source_url("http://192.168.1.2/dav", false)
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_HTTP_NOT_ALLOWED"
        );
        assert!(validate_source_url("http://192.168.1.2/dav", true).is_ok());
        assert_eq!(
            validate_source_url("https://user:secret@dav.example/", false)
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_URL_INVALID"
        );
        assert_eq!(
            validate_source_url("ftp://dav.example/books", true)
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_SCHEME_UNSUPPORTED"
        );
        assert_eq!(
            validate_source_url("not a url", false).unwrap_err().code,
            "WEBDAV_SOURCE_URL_INVALID"
        );
    }

    #[test]
    fn plan_rejects_empty_title_conflicting_flags_and_bad_credentials() {
        let mut blank_title = input("https://dav.example/books");
        blank_title.title = "  ".to_string();
        assert_eq!(
            plan_source(blank_title, None).err().unwrap().code,
            "WEBDAV_SOURCE_INVALID"
        );

        let mut conflict = input("https://dav.example/books");
        conflict.clear_credential = Some(true);
        conflict.credential = Some(RemoteCredential::Bearer {
            token: "token".to_string(),
        });
        assert_eq!(
            plan_source(conflict, None).err().unwrap().code,
            "WEBDAV_SOURCE_INVALID"
        );

        let mut empty_basic = input("https://dav.example/books");
        empty_basic.credential = Some(RemoteCredential::Basic {
            username: " ".to_string(),
            password: "x".to_string(),
        });
        assert_eq!(
            plan_source(empty_basic, None).err().unwrap().code,
            "WEBDAV_SOURCE_CREDENTIAL_INVALID"
        );

        let mut empty_bearer = input("https://dav.example/books");
        empty_bearer.credential = Some(RemoteCredential::Bearer {
            token: String::new(),
        });
        assert_eq!(
            plan_source(empty_bearer, None).err().unwrap().code,
            "WEBDAV_SOURCE_CREDENTIAL_INVALID"
        );
    }

    #[test]
    fn plan_assigns_stable_ids_and_source_scoped_credential_refs() {
        let mut with_credential = input("https://dav.example/books");
        with_credential.credential = Some(RemoteCredential::Basic {
            username: "reader".to_string(),
            password: "secret".to_string(),
        });
        let plan = plan_source(with_credential, None).unwrap();
        assert!(plan.source.id.starts_with("webdav-"));
        assert_eq!(
            plan.source.credential_ref.as_deref(),
            Some(format!("webdav-source-{}", plan.source.id).as_str())
        );
        assert_eq!(
            plan.credential_to_store
                .as_ref()
                .map(|(reference, _)| reference.as_str()),
            plan.source.credential_ref.as_deref()
        );
        // 同地址重建得到同一 id，保证重复添加同一源是编辑而非复制。
        let again = plan_source(input("https://dav.example/books"), None).unwrap();
        assert_eq!(again.source.id, plan.source.id);
        assert!(again.credential_to_store.is_none());
    }

    #[test]
    fn plan_edit_preserves_or_clears_existing_credentials() {
        let existing = WebDavSource {
            id: "webdav-a".to_string(),
            title: "旧名".to_string(),
            url: "https://dav.example/books".to_string(),
            credential_ref: Some("webdav-source-webdav-a".to_string()),
            allow_http: false,
            created_at: 1,
            updated_at: 1,
        };
        // 编辑但不重填凭据：保留既有 ref，不清除凭据。
        let mut rename = input("https://dav.example/books");
        rename.id = Some("webdav-a".to_string());
        rename.title = "新名".to_string();
        let plan = plan_source(rename, Some(&existing)).unwrap();
        assert_eq!(
            plan.source.credential_ref.as_deref(),
            Some("webdav-source-webdav-a")
        );
        assert!(plan.credential_to_store.is_none());
        assert!(plan.stale_credential_ref.is_none());
        assert_eq!(plan.source.created_at, 1);

        // 显式清除：ref 置空并上报待清理的旧 ref。
        let mut cleared = input("https://dav.example/books");
        cleared.id = Some("webdav-a".to_string());
        cleared.clear_credential = Some(true);
        let plan = plan_source(cleared, Some(&existing)).unwrap();
        assert!(plan.source.credential_ref.is_none());
        assert_eq!(
            plan.stale_credential_ref.as_deref(),
            Some("webdav-source-webdav-a")
        );
    }

    #[test]
    fn forget_credential_clears_the_shared_remote_channel() {
        // 删源走 remote.rs 凭据通道：store 之后 forget，同 ref 凭据必须消失，
        // 而其它 ref（如同步 profile 凭据）不受影响。
        let state = RemoteState::default();
        let credential = RemoteCredential::Basic {
            username: "reader".to_string(),
            password: "secret".to_string(),
        };
        store_credential_value(
            &state,
            "webdav-source-webdav-a".to_string(),
            credential.clone(),
        )
        .unwrap();
        store_credential_value(&state, "sync-profile-keep".to_string(), credential).unwrap();
        assert!(load_credential(&state, "webdav-source-webdav-a").is_some());

        forget_credential_value(&state, "webdav-source-webdav-a").unwrap();
        assert!(load_credential(&state, "webdav-source-webdav-a").is_none());
        assert!(load_credential(&state, "sync-profile-keep").is_some());
    }

    // -----------------------------------------------------------------------
    // T2：目录浏览（PROPFIND depth=1 → OpdsFeed）
    // -----------------------------------------------------------------------

    fn browse_source() -> WebDavSource {
        WebDavSource {
            id: "webdav-a".to_string(),
            title: "漫画柜".to_string(),
            url: "https://dav.example/dav/books/".to_string(),
            credential_ref: Some("webdav-source-webdav-a".to_string()),
            allow_http: false,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn browse_root() -> Url {
        Url::parse("https://dav.example/dav/books/").unwrap()
    }

    const MULTISTATUS: &str = r#"<?xml version="1.0" encoding="utf-8"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/books/</D:href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/></D:resourcetype>
            <D:displayname>books</D:displayname>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/books/%E7%94%BB%E5%86%8C/</D:href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/></D:resourcetype>
            <D:displayname>画册</D:displayname>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
        <D:response>
          <D:href>https://dav.example/dav/books/One%20Piece%2001.cbz</D:href>
          <D:propstat><D:prop>
            <D:resourcetype/>
            <D:displayname>One Piece 01.cbz</D:displayname>
            <D:getcontentlength>12345</D:getcontentlength>
            <D:getcontenttype>application/vnd.comicbook+zip</D:getcontenttype>
            <D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/books/no-name.txt</D:href>
          <D:propstat><D:prop>
            <D:resourcetype/>
            <D:getcontentlength>7</D:getcontentlength>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/books/cover.jpg</D:href>
          <D:propstat><D:prop>
            <D:resourcetype/>
            <D:displayname>cover.jpg</D:displayname>
            <D:getcontentlength>99</D:getcontentlength>
            <D:getcontenttype>image/jpeg</D:getcontenttype>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
      </D:multistatus>"#;

    #[test]
    fn browse_maps_directories_books_and_filters_unsupported_files() {
        let source = browse_source();
        let root = browse_root();
        let resources = parse_multistatus(MULTISTATUS).unwrap();
        let feed = build_browse_feed(&source, &root, &root, resources).unwrap();
        assert_eq!(feed.format, "webdav");
        assert_eq!(feed.title, "漫画柜");
        assert_eq!(feed.source_url, "https://dav.example/dav/books/");
        // 自身、不支持扩展名（cover.jpg）均不出现；目录在前、书籍在后。
        assert_eq!(feed.entries.len(), 3);
        let directory = &feed.entries[0];
        assert_eq!(directory.kind, "navigation");
        assert_eq!(directory.title, "画册");
        assert_eq!(
            directory.navigation_url.as_deref(),
            Some("https://dav.example/dav/books/%E7%94%BB%E5%86%8C/")
        );
        assert!(directory.links.is_empty());

        let book = feed
            .entries
            .iter()
            .find(|entry| entry.title == "One Piece 01.cbz")
            .unwrap();
        assert_eq!(book.kind, "publication");
        assert_eq!(
            book.item_id.as_deref().map(|id| &id[..12]),
            Some("webdav-item-")
        );
        assert_eq!(book.links.len(), 1);
        let link = &book.links[0];
        assert!(link.acquisition);
        assert_eq!(
            link.href,
            "https://dav.example/dav/books/One%20Piece%2001.cbz"
        );
        assert_eq!(link.extension.as_deref(), Some("cbz"));
        assert_eq!(link.size, Some(12345));
        assert_eq!(
            link.media_type.as_deref(),
            Some("application/vnd.comicbook+zip")
        );
        assert_eq!(
            book.updated.as_deref(),
            Some("Mon, 01 Jan 2024 00:00:00 GMT")
        );

        // 无 displayname 时标题回退为解码后的文件名。
        let fallback = feed
            .entries
            .iter()
            .find(|entry| entry.title == "no-name.txt")
            .unwrap();
        assert_eq!(fallback.kind, "publication");
        assert!(feed
            .entries
            .iter()
            .all(|entry| entry.title != "cover.jpg" && entry.title != "books"));
    }

    #[test]
    fn href_percent_decoding_is_single_pass_and_safe() {
        assert_eq!(percent_decode("%25").unwrap(), "%");
        assert_eq!(percent_decode("One%20Piece").unwrap(), "One Piece");
        assert_eq!(percent_decode("%E7%94%BB").unwrap(), "画");
        // 单次解码：双重编码不会被意外展开为路径分隔符等。
        assert_eq!(percent_decode("%2520").unwrap(), "%20");
        assert_eq!(percent_decode("raw text").unwrap(), "raw text");
        assert_eq!(
            percent_decode("%zz").unwrap_err().code,
            "WEBDAV_SOURCE_HREF_INVALID"
        );
        assert_eq!(
            percent_decode("tail%2").unwrap_err().code,
            "WEBDAV_SOURCE_HREF_INVALID"
        );
        // 编码与未编码 href 解析到同一 URL。
        let root = browse_root();
        let encoded = resolve_href(&root, &root, "/dav/books/%E7%94%BB%E5%86%8C/").unwrap();
        let raw = resolve_href(&root, &root, "/dav/books/画册/").unwrap();
        assert_eq!(encoded, raw);
        let spaced = resolve_href(&root, &root, "/dav/books/One Piece 01.cbz").unwrap();
        let spaced_encoded = resolve_href(&root, &root, "/dav/books/One%20Piece%2001.cbz").unwrap();
        assert_eq!(spaced, spaced_encoded);
    }

    #[test]
    fn href_encoded_hash_query_and_literal_percent_are_not_reparsed() {
        let root = browse_root();
        let hash = resolve_href(&root, &root, "/dav/books/a%23b.cbz").unwrap();
        assert_eq!(hash.as_str(), "https://dav.example/dav/books/a%23b.cbz");
        assert!(hash.fragment().is_none());
        assert_eq!(last_path_segment(&hash).as_deref(), Some("a#b.cbz"));

        let query = resolve_href(&root, &root, "/dav/books/a%3Fb.cbz").unwrap();
        assert_eq!(query.as_str(), "https://dav.example/dav/books/a%3Fb.cbz");
        assert!(query.query().is_none());
        assert_eq!(last_path_segment(&query).as_deref(), Some("a?b.cbz"));

        let literal_percent = resolve_href(&root, &root, "/dav/books/%2520.cbz").unwrap();
        assert_eq!(
            literal_percent.as_str(),
            "https://dav.example/dav/books/%2520.cbz"
        );
        assert_eq!(
            last_path_segment(&literal_percent).as_deref(),
            Some("%20.cbz")
        );

        // 绝对 URL 形态同样不能先解码；集合规范化不得把 %23 再次编码成 %2523。
        let absolute =
            resolve_href(&root, &root, "https://dav.example/dav/books/a%23b.cbz").unwrap();
        assert_eq!(absolute, hash);
        let collection =
            normalize_collection_url(resolve_href(&root, &root, "/dav/books/a%23b").unwrap());
        assert_eq!(collection.as_str(), "https://dav.example/dav/books/a%23b/");
    }

    #[test]
    fn browse_preserves_encoded_delimiters_in_acquisition_hrefs() {
        let source = browse_source();
        let root = browse_root();
        let body = r#"<?xml version="1.0"?>
          <multistatus xmlns="DAV:">
            <response><href>/dav/books/</href>
              <propstat><prop><resourcetype><collection/></resourcetype></prop></propstat>
            </response>
            <response><href>/dav/books/a%23b.cbz</href>
              <propstat><prop><resourcetype/></prop></propstat>
            </response>
            <response><href>/dav/books/a%3Fb.cbz</href>
              <propstat><prop><resourcetype/></prop></propstat>
            </response>
            <response><href>/dav/books/%2520.cbz</href>
              <propstat><prop><resourcetype/></prop></propstat>
            </response>
          </multistatus>"#;
        let feed =
            build_browse_feed(&source, &root, &root, parse_multistatus(body).unwrap()).unwrap();
        let hrefs: Vec<&str> = feed
            .entries
            .iter()
            .filter_map(|entry| entry.links.first().map(|link| link.href.as_str()))
            .collect();
        assert_eq!(
            hrefs,
            vec![
                "https://dav.example/dav/books/%2520.cbz",
                "https://dav.example/dav/books/a%23b.cbz",
                "https://dav.example/dav/books/a%3Fb.cbz",
            ]
        );
        assert_eq!(
            feed.entries
                .iter()
                .map(|entry| entry.title.as_str())
                .collect::<Vec<_>>(),
            vec!["%20.cbz", "a#b.cbz", "a?b.cbz"]
        );
    }

    #[test]
    fn href_userinfo_cross_origin_and_downgrade_are_rejected() {
        let root = browse_root();
        assert_eq!(
            resolve_href(&root, &root, "https://reader:secret@dav.example/dav/x")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_HREF_INVALID"
        );
        assert_eq!(
            resolve_href(&root, &root, "https://evil.example/dav/x")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_HREF_ORIGIN_MISMATCH"
        );
        assert_eq!(
            resolve_href(&root, &root, "http://dav.example/dav/x")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_HREF_INVALID"
        );
        // 相对 href 以请求目录为 base 解析。
        assert_eq!(
            resolve_href(&root, &root, "child/").unwrap().as_str(),
            "https://dav.example/dav/books/child/"
        );
    }

    #[test]
    fn empty_directory_returns_empty_feed_not_error() {
        let source = browse_source();
        let root = browse_root();
        let body = r#"<?xml version="1.0"?>
          <multistatus xmlns="DAV:">
            <response><href>/dav/books</href>
              <propstat><prop><resourcetype><collection/></resourcetype></prop></propstat>
            </response>
          </multistatus>"#;
        let feed =
            build_browse_feed(&source, &root, &root, parse_multistatus(body).unwrap()).unwrap();
        assert!(feed.entries.is_empty());
        assert_eq!(feed.title, "漫画柜");
    }

    #[test]
    fn subdirectory_feed_takes_decoded_directory_title() {
        let mut source = browse_source();
        source.title = "漫画柜".to_string();
        let root = browse_root();
        let sub = Url::parse("https://dav.example/dav/books/%E7%94%BB%E5%86%8C/").unwrap();
        let feed = build_browse_feed(&source, &sub, &root, Vec::new()).unwrap();
        assert_eq!(feed.title, "画册");
    }

    #[test]
    fn multistatus_entry_cap_and_structure_failures_are_readable_errors() {
        let many = (0..=MAX_BROWSE_ENTRIES)
            .map(|index| {
                format!(
                    "<response><href>/dav/books/{index}.cbz</href>\
                     <propstat><prop><resourcetype/></prop></propstat></response>"
                )
            })
            .collect::<String>();
        assert_eq!(
            parse_multistatus(&format!("<multistatus>{many}</multistatus>"))
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_TOO_MANY_ENTRIES"
        );
        // 非 multistatus 文档不允许伪装为空目录。
        assert_eq!(
            parse_multistatus("<html><body>oops</body></html>")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_MULTISTATUS_INVALID"
        );
        assert_eq!(
            parse_multistatus("<!DOCTYPE d><multistatus/>")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_XML_UNSAFE"
        );
        assert_eq!(
            parse_multistatus("<multistatus><response>")
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_XML_INVALID"
        );
        // response 缺少 href 直接报错而非静默跳过。
        let source = browse_source();
        let root = browse_root();
        let body = "<multistatus><response><propstat><prop><resourcetype/></prop></propstat></response></multistatus>";
        assert_eq!(
            build_browse_feed(&source, &root, &root, parse_multistatus(body).unwrap())
                .unwrap_err()
                .code,
            "WEBDAV_SOURCE_HREF_INVALID"
        );
    }

    #[test]
    fn collection_urls_are_normalized_with_trailing_slash() {
        let normalized = normalize_collection_url(Url::parse("https://dav.example/dav").unwrap());
        assert_eq!(normalized.as_str(), "https://dav.example/dav/");
        let already = normalize_collection_url(Url::parse("https://dav.example/dav/").unwrap());
        assert_eq!(already.as_str(), "https://dav.example/dav/");
    }
}
