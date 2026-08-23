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
use crate::remote::{
    forget_credential_value, load_credential, redirect_allowed, store_credential_value,
    validate_remote_url, RemoteCredential, RemoteError, RemoteState,
};
use reqwest::header::{CONTENT_LENGTH, SERVER};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, State};
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
}
