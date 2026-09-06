//! Bounded HTTPS Wiktionary lookup and DeepL translate (ADR-2 / ADR-3).
//!
//! Requests never reuse `fetch_remote_text`. Hosts are allowlisted, HTTPS-only,
//! and DeepL keys go through `credential_store` (`lightink.reader` / `deepl`).

use crate::credential_store::{delete_credential, get_credential, set_credential};
use futures_util::StreamExt;
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Response, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use url::Url;

const KEYRING_SERVICE: &str = "lightink.reader";
const KEYRING_REFERENCE: &str = "deepl";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_LOOKUP_UTF16: usize = 40;
const MAX_LOOKUP_TOKENS: usize = 4;
const MAX_TRANSLATE_CHARS: usize = 5000;
const ALLOWED_HOSTS: &[&str] = &[
    "zh.wiktionary.org",
    "en.wiktionary.org",
    "api-free.deepl.com",
    "api.deepl.com",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderAidError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl ReaderAidError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }

    fn status(code: impl Into<String>, message: impl Into<String>, status: StatusCode) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: Some(status.as_u16()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeeplConfigured {
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WiktionaryDefinition {
    pub definition: String,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WiktionaryEntry {
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_of_speech: Option<String>,
    pub definitions: Vec<WiktionaryDefinition>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WiktionaryLookupResult {
    pub term: String,
    pub host: String,
    pub entries: Vec<WiktionaryEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeeplTranslateResult {
    pub text: String,
    pub target_lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_source_language: Option<String>,
}

#[derive(Clone, Copy)]
enum ReaderService {
    Wiktionary,
    DeepL,
}

#[tauri::command]
pub async fn reader_wiktionary_lookup(
    term: String,
    locale: String,
) -> Result<WiktionaryLookupResult, ReaderAidError> {
    let url = prepare_wiktionary_url(&term, &locale)?;
    let client = build_client(&url)?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(network_error)?;
    let value = read_json_response(ReaderService::Wiktionary, response).await?;
    let host = url.host_str().unwrap_or_default();
    if host == "zh.wiktionary.org" {
        parse_wiktionary_extracts(term.trim(), host, &value)
    } else {
        parse_wiktionary_definitions(term.trim(), host, &value)
    }
}

#[tauri::command]
pub async fn reader_deepl_translate(
    text: String,
    target_lang: String,
) -> Result<DeeplTranslateResult, ReaderAidError> {
    translate_with_key(&text, &target_lang, load_deepl_key()).await
}

#[tauri::command]
pub fn reader_deepl_configured() -> DeeplConfigured {
    deepl_configured_from_secret(load_deepl_key())
}

#[tauri::command]
pub fn reader_deepl_store_key(key: String) -> Result<DeeplConfigured, ReaderAidError> {
    let key = normalize_deepl_key(&key)?;
    if !set_credential(KEYRING_SERVICE, KEYRING_REFERENCE, &key) {
        return Err(ReaderAidError::new(
            "READER_KEY_STORE_FAILED",
            "无法保存 DeepL 密钥",
        ));
    }
    Ok(DeeplConfigured { configured: true })
}

#[tauri::command]
pub fn reader_deepl_forget_key() -> DeeplConfigured {
    delete_credential(KEYRING_SERVICE, KEYRING_REFERENCE);
    deepl_configured_from_secret(load_deepl_key())
}

async fn translate_with_key(
    text: &str,
    target_lang: &str,
    key: Option<String>,
) -> Result<DeeplTranslateResult, ReaderAidError> {
    let (url, payload, normalized_lang, key) =
        prepare_translate(text, target_lang, key.as_deref())?;
    let client = build_client(&url)?;
    let authorization = HeaderValue::from_str(&format!("DeepL-Auth-Key {key}"))
        .map_err(|_| ReaderAidError::new("READER_KEY_INVALID", "DeepL 密钥包含无效字符"))?;
    let response = client
        .post(url)
        .header(AUTHORIZATION, authorization)
        .header(CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(network_error)?;
    let value = read_json_response(ReaderService::DeepL, response).await?;
    parse_deepl_translation(&value, &normalized_lang)
}

fn load_deepl_key() -> Option<String> {
    get_credential(KEYRING_SERVICE, KEYRING_REFERENCE)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn deepl_configured_from_secret(secret: Option<String>) -> DeeplConfigured {
    DeeplConfigured {
        configured: secret.is_some(),
    }
}

fn normalize_deepl_key(raw: &str) -> Result<String, ReaderAidError> {
    if raw.chars().any(char::is_control) {
        return Err(ReaderAidError::new(
            "READER_KEY_INVALID",
            "DeepL 密钥包含控制字符",
        ));
    }
    let key = raw.trim();
    if key.is_empty() {
        return Err(missing_key_error());
    }
    Ok(key.to_string())
}

fn missing_key_error() -> ReaderAidError {
    ReaderAidError::new("READER_KEY_MISSING", "尚未配置 DeepL 密钥")
}

fn prepare_wiktionary_url(term: &str, locale: &str) -> Result<Url, ReaderAidError> {
    let term = normalize_lookup_term(term)?;
    let host = wiktionary_host(locale)?;
    let url = if host == "zh.wiktionary.org" {
        // zh.wiktionary.org does not implement REST /page/definition (HTTP 501).
        let mut url =
            Url::parse("https://zh.wiktionary.org/w/api.php").expect("static Wiktionary URL");
        url.query_pairs_mut()
            .append_pair("action", "query")
            .append_pair("format", "json")
            .append_pair("formatversion", "2")
            .append_pair("redirects", "1")
            .append_pair("prop", "extracts")
            .append_pair("explaintext", "1")
            .append_pair("exchars", "1200")
            .append_pair("uselang", "zh-cn")
            .append_pair("variant", "zh-cn")
            .append_pair("titles", term);
        url
    } else {
        let mut url = Url::parse(&format!("https://{host}/api/rest_v1/page/definition/"))
            .expect("static Wiktionary URL");
        url.path_segments_mut()
            .expect("Wiktionary URL cannot be a base")
            .pop_if_empty()
            .push(term);
        url
    };
    validate_reader_url(&url)
}

fn normalize_lookup_term(term: &str) -> Result<&str, ReaderAidError> {
    if contains_forbidden_control(term) {
        return Err(ReaderAidError::new(
            "READER_TERM_EMPTY",
            "查词文本包含控制字符",
        ));
    }
    let term = term.trim();
    if term.is_empty() {
        return Err(ReaderAidError::new("READER_TERM_EMPTY", "查词文本为空"));
    }
    if term.encode_utf16().count() > MAX_LOOKUP_UTF16
        || term.split_whitespace().count() > MAX_LOOKUP_TOKENS
    {
        return Err(ReaderAidError::new(
            "READER_TERM_TOO_LONG",
            "选区过长，请改用翻译",
        ));
    }
    Ok(term)
}

fn wiktionary_host(locale: &str) -> Result<&'static str, ReaderAidError> {
    let primary = locale
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match primary.as_str() {
        "zh" => Ok("zh.wiktionary.org"),
        "en" => Ok("en.wiktionary.org"),
        _ => Err(ReaderAidError::new(
            "READER_LOCALE_UNSUPPORTED",
            "仅支持中文或英文维基词典",
        )),
    }
}

fn prepare_translate(
    text: &str,
    target_lang: &str,
    key: Option<&str>,
) -> Result<(Url, Vec<u8>, String, String), ReaderAidError> {
    let key = key.ok_or_else(missing_key_error)?;
    let (url, payload, target_lang) = prepare_deepl_request(text, target_lang, key)?;
    Ok((url, payload, target_lang, key.to_string()))
}

fn prepare_deepl_request(
    text: &str,
    target_lang: &str,
    key: &str,
) -> Result<(Url, Vec<u8>, String), ReaderAidError> {
    let text = normalize_translate_text(text)?;
    let target_lang = normalize_target_lang(target_lang)?;
    let url = deepl_url_for_key(key)?;
    let payload = serde_json::to_vec(&serde_json::json!({
        "text": [text],
        "target_lang": target_lang,
    }))
    .map_err(|_| ReaderAidError::new("READER_RESPONSE_INVALID", "无法准备翻译请求"))?;
    if payload.len() > MAX_RESPONSE_BYTES {
        return Err(response_too_large());
    }
    Ok((url, payload, target_lang))
}

fn contains_forbidden_control(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
}

fn normalize_translate_text(text: &str) -> Result<&str, ReaderAidError> {
    if contains_forbidden_control(text) {
        return Err(ReaderAidError::new(
            "READER_TEXT_EMPTY",
            "翻译文本包含控制字符",
        ));
    }
    let text = text.trim();
    if text.is_empty() {
        return Err(ReaderAidError::new("READER_TEXT_EMPTY", "翻译文本为空"));
    }
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        return Err(ReaderAidError::new(
            "READER_TEXT_TOO_LONG",
            "选区超过 5000 字，无法翻译",
        ));
    }
    Ok(text)
}

fn normalize_target_lang(target_lang: &str) -> Result<String, ReaderAidError> {
    let primary = target_lang
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    match primary.as_str() {
        "ZH" => Ok("ZH".to_string()),
        "EN" => Ok("EN".to_string()),
        _ => Err(ReaderAidError::new(
            "READER_TARGET_LANG_INVALID",
            "仅支持翻译为中文或英文",
        )),
    }
}

fn deepl_url_for_key(key: &str) -> Result<Url, ReaderAidError> {
    let host = if key.trim().ends_with(":fx") {
        "api-free.deepl.com"
    } else {
        "api.deepl.com"
    };
    let url = Url::parse(&format!("https://{host}/v2/translate")).expect("static DeepL URL");
    validate_reader_url(&url)
}

#[cfg(test)]
fn validate_reader_url_str(raw: &str) -> Result<Url, ReaderAidError> {
    if raw.chars().any(char::is_control) {
        return Err(ReaderAidError::new(
            "READER_URL_INVALID",
            "URL 包含控制字符",
        ));
    }
    let parsed = Url::parse(raw.trim())
        .map_err(|_| ReaderAidError::new("READER_URL_INVALID", "URL 格式无效"))?;
    validate_reader_url(&parsed)
}

fn validate_reader_url(url: &Url) -> Result<Url, ReaderAidError> {
    if url.host_str().is_none() {
        return Err(ReaderAidError::new("READER_URL_INVALID", "URL 缺少主机名"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ReaderAidError::new(
            "READER_URL_INVALID",
            "URL 不能包含用户名或密码",
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" => {
            return Err(ReaderAidError::new(
                "READER_HTTP_NOT_ALLOWED",
                "查词与翻译仅允许 HTTPS",
            ))
        }
        _ => {
            return Err(ReaderAidError::new(
                "READER_URL_INVALID",
                "查词与翻译仅允许 HTTPS",
            ))
        }
    }
    let host = url.host_str().unwrap_or_default();
    if !ALLOWED_HOSTS.contains(&host) || url.port_or_known_default() != Some(443) {
        return Err(ReaderAidError::new(
            "READER_HOST_NOT_ALLOWED",
            format!("主机不在允许列表中: {host}"),
        ));
    }
    Ok(url.clone())
}

fn redirect_allowed(from: &Url, to: &Url) -> bool {
    validate_reader_url(to).is_ok()
        && from.host_str() == to.host_str()
        && from.port_or_known_default() == to.port_or_known_default()
}

fn build_client(initial: &Url) -> Result<Client, ReaderAidError> {
    let first = initial.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("redirect limit exceeded");
        }
        let from = attempt.previous().last().unwrap_or(&first);
        if !redirect_allowed(from, attempt.url()) {
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
            ReaderAidError::new(
                "READER_CLIENT_ERROR",
                format!("无法创建网络客户端: {error}"),
            )
        })
}

async fn read_json_response(
    service: ReaderService,
    response: Response,
) -> Result<Value, ReaderAidError> {
    if let Some(error) = status_error(service, response.status()) {
        return Err(error);
    }
    if !response.status().is_success() {
        return Err(ReaderAidError::status(
            "READER_HTTP_ERROR",
            format!("远程服务器返回 HTTP {}", response.status().as_u16()),
            response.status(),
        ));
    }
    reject_content_length(response.content_length())?;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        append_bounded(&mut bytes, &chunk)?;
    }
    parse_json_bytes(&bytes)
}

fn status_error(service: ReaderService, status: StatusCode) -> Option<ReaderAidError> {
    match (service, status.as_u16()) {
        (ReaderService::Wiktionary, 404) => Some(ReaderAidError::status(
            "READER_NOT_FOUND",
            "未找到该词条",
            status,
        )),
        (ReaderService::DeepL, 401 | 403) => Some(ReaderAidError::status(
            "READER_KEY_INVALID",
            "DeepL 密钥无效",
            status,
        )),
        (ReaderService::DeepL, 456) => Some(ReaderAidError::status(
            "READER_QUOTA_EXCEEDED",
            "DeepL 额度已用尽",
            status,
        )),
        (_, _) if status.is_success() => None,
        (_, _) => Some(ReaderAidError::status(
            "READER_HTTP_ERROR",
            format!("远程服务器返回 HTTP {}", status.as_u16()),
            status,
        )),
    }
}

fn reject_content_length(length: Option<u64>) -> Result<(), ReaderAidError> {
    if length.is_some_and(|value| value > MAX_RESPONSE_BYTES as u64) {
        return Err(response_too_large());
    }
    Ok(())
}

fn append_bounded(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ReaderAidError> {
    if buffer.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err(response_too_large());
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn response_too_large() -> ReaderAidError {
    ReaderAidError::new("READER_RESPONSE_TOO_LARGE", "响应超过 256 KiB 上限")
}

fn parse_json_bytes(bytes: &[u8]) -> Result<Value, ReaderAidError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ReaderAidError::new("READER_RESPONSE_INVALID", "响应不是有效 UTF-8"))?;
    serde_json::from_str(text)
        .map_err(|_| ReaderAidError::new("READER_RESPONSE_INVALID", "响应不是 JSON"))
}

fn network_error(error: reqwest::Error) -> ReaderAidError {
    if error.is_timeout() {
        ReaderAidError::new("READER_TIMEOUT", "请求超时")
    } else {
        ReaderAidError::new("READER_NETWORK_ERROR", format!("无法连接远程服务: {error}"))
    }
}

fn parse_wiktionary_extracts(
    term: &str,
    host: &str,
    value: &Value,
) -> Result<WiktionaryLookupResult, ReaderAidError> {
    let Some(pages) = value.pointer("/query/pages") else {
        return Err(ReaderAidError::new(
            "READER_RESPONSE_INVALID",
            "维基词典响应缺少词条",
        ));
    };
    let mut entries = Vec::new();
    match pages {
        Value::Array(items) => {
            for page in items {
                if let Some(entry) = extract_entry_from_page(page) {
                    entries.push(entry);
                }
            }
        }
        Value::Object(map) => {
            for page in map.values() {
                if let Some(entry) = extract_entry_from_page(page) {
                    entries.push(entry);
                }
            }
        }
        _ => {}
    }
    if entries.is_empty() {
        return Err(ReaderAidError::new("READER_NOT_FOUND", "未找到该词条"));
    }
    Ok(WiktionaryLookupResult {
        term: term.to_string(),
        host: host.to_string(),
        entries,
    })
}

fn extract_entry_from_page(page: &Value) -> Option<WiktionaryEntry> {
    if page_is_missing(page) {
        return None;
    }
    let title = page
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::zh_t2s::to_simplified);
    let extract =
        crate::zh_t2s::to_simplified(page.get("extract").and_then(Value::as_str).unwrap_or(""));
    let mut part_of_speech = None;
    let mut definitions = Vec::new();
    for line in extract.lines() {
        let line = strip_markup(line.trim());
        if line.is_empty() {
            continue;
        }
        if let Some(heading) = wiki_heading_title(&line) {
            if part_of_speech.is_none() {
                if let Some(pos) = lexical_heading(heading) {
                    part_of_speech = Some(pos.to_string());
                }
            }
            continue;
        }
        if title.as_deref().is_some_and(|value| line == value) {
            continue;
        }
        definitions.push(WiktionaryDefinition {
            definition: line,
            examples: Vec::new(),
        });
        if definitions.len() == 12 {
            break;
        }
    }
    if definitions.is_empty() {
        return None;
    }
    Some(WiktionaryEntry {
        language: "中文".to_string(),
        part_of_speech,
        definitions,
    })
}

fn wiki_heading_title(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if !trimmed.starts_with('=') || !trimmed.ends_with('=') {
        return None;
    }
    let title = trimmed.trim_matches('=').trim();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn lexical_heading(heading: &str) -> Option<&str> {
    match heading {
        "名词" | "名詞" => Some("名词"),
        "动词" | "動詞" => Some("动词"),
        "形容词" | "形容詞" => Some("形容词"),
        "副词" | "副詞" => Some("副词"),
        "量词" | "量詞" => Some("量词"),
        "代词" | "代詞" => Some("代词"),
        "介词" | "介詞" => Some("介词"),
        "连词" | "連詞" => Some("连词"),
        "助词" | "助詞" => Some("助词"),
        "叹词" | "嘆詞" | "感叹词" | "感嘆詞" => Some("叹词"),
        "数词" | "數詞" => Some("数词"),
        _ => None,
    }
}

fn page_is_missing(page: &Value) -> bool {
    page.get("missing").is_some()
}

fn parse_wiktionary_definitions(
    term: &str,
    host: &str,
    value: &Value,
) -> Result<WiktionaryLookupResult, ReaderAidError> {
    let Some(object) = value.as_object() else {
        return Err(ReaderAidError::new(
            "READER_RESPONSE_INVALID",
            "维基词典响应不是 JSON 对象",
        ));
    };
    let mut entries = Vec::new();
    for groups in object.values() {
        let Some(array) = groups.as_array() else {
            continue;
        };
        for item in array {
            let language = item
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let part_of_speech = item
                .get("partOfSpeech")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let mut definitions = Vec::new();
            if let Some(defs) = item.get("definitions").and_then(Value::as_array) {
                for definition in defs {
                    let text = definition
                        .get("definition")
                        .and_then(Value::as_str)
                        .map(strip_markup)
                        .filter(|value| !value.is_empty());
                    let Some(text) = text else {
                        continue;
                    };
                    let examples = definition
                        .get("examples")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(strip_markup)
                                .filter(|value| !value.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    definitions.push(WiktionaryDefinition {
                        definition: text,
                        examples,
                    });
                }
            }
            if !definitions.is_empty() {
                entries.push(WiktionaryEntry {
                    language,
                    part_of_speech,
                    definitions,
                });
            }
        }
    }
    if entries.is_empty() {
        return Err(ReaderAidError::new("READER_NOT_FOUND", "未找到该词条"));
    }
    Ok(WiktionaryLookupResult {
        term: term.to_string(),
        host: host.to_string(),
        entries,
    })
}

fn parse_deepl_translation(
    value: &Value,
    target_lang: &str,
) -> Result<DeeplTranslateResult, ReaderAidError> {
    let translation = value
        .get("translations")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| ReaderAidError::new("READER_RESPONSE_INVALID", "DeepL 未返回译文"))?;
    let text = translation
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ReaderAidError::new("READER_RESPONSE_INVALID", "DeepL 未返回译文"))?;
    let detected_source_language = translation
        .get("detected_source_language")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok(DeeplTranslateResult {
        text: text.to_string(),
        target_lang: target_lang.to_string(),
        detected_source_language,
    })
}

fn strip_markup(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    decode_entities(&output).trim().to_string()
}

fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';') else {
            output.push_str(rest);
            return output;
        };
        let entity = &rest[..=end];
        match entity {
            "&amp;" => output.push('&'),
            "&lt;" => output.push('<'),
            "&gt;" => output.push('>'),
            "&quot;" => output.push('"'),
            "&#39;" | "&apos;" => output.push('\''),
            _ => output.push_str(entity),
        }
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lookup_uses_locale_https_hosts_only() {
        let zh = prepare_wiktionary_url("词典", "zh-CN").unwrap();
        assert_eq!(zh.scheme(), "https");
        assert_eq!(zh.host_str(), Some("zh.wiktionary.org"));
        assert_eq!(zh.path(), "/w/api.php");
        let query: std::collections::HashMap<_, _> = zh.query_pairs().into_owned().collect();
        assert_eq!(query.get("action").map(String::as_str), Some("query"));
        assert_eq!(query.get("variant").map(String::as_str), Some("zh-cn"));
        assert_eq!(query.get("titles").map(String::as_str), Some("词典"));
        let en = prepare_wiktionary_url("hello", "en").unwrap();
        assert_eq!(en.host_str(), Some("en.wiktionary.org"));
        assert!(en.path().contains("/api/rest_v1/page/definition/"));
        assert!(en.username().is_empty());
        assert!(en.password().is_none());
    }

    #[test]
    fn lookup_rejects_empty_and_over_limit_terms() {
        assert_eq!(
            prepare_wiktionary_url("   ", "en").unwrap_err().code,
            "READER_TERM_EMPTY"
        );
        assert_eq!(
            prepare_wiktionary_url(&"a".repeat(41), "en")
                .unwrap_err()
                .code,
            "READER_TERM_TOO_LONG"
        );
        assert_eq!(
            prepare_wiktionary_url("one two three four five", "en")
                .unwrap_err()
                .code,
            "READER_TERM_TOO_LONG"
        );
        assert!(prepare_wiktionary_url(&"a".repeat(40), "en").is_ok());
        assert!(prepare_wiktionary_url("one two three four", "en").is_ok());
    }

    #[test]
    fn http_urls_are_rejected() {
        for raw in [
            "http://zh.wiktionary.org/api/rest_v1/page/definition/hi",
            "http://en.wiktionary.org/api/rest_v1/page/definition/hi",
            "http://api-free.deepl.com/v2/translate",
            "http://api.deepl.com/v2/translate",
        ] {
            assert_eq!(
                validate_reader_url_str(raw).unwrap_err().code,
                "READER_HTTP_NOT_ALLOWED",
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn non_allowlisted_hosts_are_rejected() {
        for raw in [
            "https://www.wiktionary.org/api/rest_v1/page/definition/hi",
            "https://en.wikipedia.org/wiki/Hello",
            "https://api.deepl.io/v2/translate",
            "https://example.com/v2/translate",
            "https://zh.wiktionary.org.evil.test/api/rest_v1/page/definition/hi",
            "https://en.wiktionary.org:444/api/rest_v1/page/definition/hi",
        ] {
            assert_eq!(
                validate_reader_url_str(raw).unwrap_err().code,
                "READER_HOST_NOT_ALLOWED",
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn embedded_userinfo_is_rejected() {
        for raw in [
            "https://user:pass@en.wiktionary.org/api/rest_v1/page/definition/hi",
            "https://user@api.deepl.com/v2/translate",
        ] {
            assert_eq!(
                validate_reader_url_str(raw).unwrap_err().code,
                "READER_URL_INVALID",
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn fx_keys_use_free_deepl_host() {
        let free = deepl_url_for_key("abc:fx").unwrap();
        assert_eq!(free.scheme(), "https");
        assert_eq!(free.host_str(), Some("api-free.deepl.com"));
        assert_eq!(free.path(), "/v2/translate");
        let pro = deepl_url_for_key("abc-pro").unwrap();
        assert_eq!(pro.host_str(), Some("api.deepl.com"));
    }

    #[test]
    fn translate_without_key_fails_closed() {
        assert_eq!(
            prepare_translate("hello", "ZH", None).unwrap_err().code,
            "READER_KEY_MISSING"
        );
    }

    #[test]
    fn translate_rejects_empty_and_over_limit_text() {
        let key = "abc:fx";
        assert_eq!(
            prepare_deepl_request("   ", "ZH", key).unwrap_err().code,
            "READER_TEXT_EMPTY"
        );
        let too_long = "汉".repeat(MAX_TRANSLATE_CHARS + 1);
        assert_eq!(
            prepare_deepl_request(&too_long, "en", key)
                .unwrap_err()
                .code,
            "READER_TEXT_TOO_LONG"
        );
        let (url, payload, lang) = prepare_deepl_request("hello", "zh-CN", key).unwrap();
        assert_eq!(url.host_str(), Some("api-free.deepl.com"));
        assert_eq!(lang, "ZH");
        let body: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(body["text"], json!(["hello"]));
        assert_eq!(body["target_lang"], "ZH");
        assert!(body.get("auth_key").is_none());
    }

    #[test]
    fn response_over_256kib_fails_closed() {
        assert_eq!(
            reject_content_length(Some((MAX_RESPONSE_BYTES as u64) + 1))
                .unwrap_err()
                .code,
            "READER_RESPONSE_TOO_LARGE"
        );
        assert!(reject_content_length(Some(MAX_RESPONSE_BYTES as u64)).is_ok());
        let mut buffer = vec![0u8; MAX_RESPONSE_BYTES];
        assert_eq!(
            append_bounded(&mut buffer, &[1]).unwrap_err().code,
            "READER_RESPONSE_TOO_LARGE"
        );
        let mut ok = Vec::new();
        assert!(append_bounded(&mut ok, &[1, 2, 3]).is_ok());
        assert_eq!(
            parse_json_bytes(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
                .unwrap_err()
                .code,
            "READER_RESPONSE_INVALID"
        );
    }

    #[test]
    fn redirects_cannot_leave_allowlisted_https_host() {
        let from = Url::parse("https://en.wiktionary.org/api/rest_v1/page/definition/hi").unwrap();
        let same = Url::parse("https://en.wiktionary.org/wiki/hello").unwrap();
        let http = Url::parse("http://en.wiktionary.org/wiki/hello").unwrap();
        let other = Url::parse("https://zh.wiktionary.org/wiki/hello").unwrap();
        let userinfo = Url::parse("https://user@en.wiktionary.org/wiki/hello").unwrap();
        assert!(redirect_allowed(&from, &same));
        assert!(!redirect_allowed(&from, &http));
        assert!(!redirect_allowed(&from, &other));
        assert!(!redirect_allowed(&from, &userinfo));
    }

    #[test]
    fn wiktionary_json_becomes_definitions_or_not_found() {
        let value = json!({
            "en": [{
                "partOfSpeech": "Noun",
                "language": "English",
                "definitions": [{
                    "definition": "A <a href=\"/wiki/greeting\">greeting</a> &amp; welcome.",
                    "examples": ["<i>Hello</i>, world."]
                }]
            }]
        });
        let result = parse_wiktionary_definitions("hello", "en.wiktionary.org", &value).unwrap();
        assert_eq!(
            result.entries[0].definitions[0].definition,
            "A greeting & welcome."
        );
        assert_eq!(result.entries[0].definitions[0].examples, ["Hello, world."]);
        assert_eq!(
            parse_wiktionary_definitions("hello", "en.wiktionary.org", &json!({ "en": [] }))
                .unwrap_err()
                .code,
            "READER_NOT_FOUND"
        );
    }

    #[test]
    fn zh_extracts_json_becomes_definitions_or_not_found() {
        let value = json!({
            "query": {
                "pages": [{
                    "pageid": 1,
                    "title": "词典",
                    "extract": "词典是收集词语的工具书。\n\n亦作辞典。"
                }]
            }
        });
        let result = parse_wiktionary_extracts("词典", "zh.wiktionary.org", &value).unwrap();
        assert_eq!(result.entries[0].language, "中文");
        assert_eq!(
            result.entries[0].definitions[0].definition,
            "词典是收集词语的工具书。"
        );
        assert_eq!(result.entries[0].definitions[1].definition, "亦作辞典。");
        let traditional = parse_wiktionary_extracts(
            "外骨骼",
            "zh.wiktionary.org",
            &json!({
                "query": {
                    "pages": [{
                        "pageid": 3,
                        "title": "外骨骼",
                        "extract": "基於動物身體最外層硬化而形成的骨骼系統"
                    }]
                }
            }),
        )
        .unwrap();
        assert_eq!(
            traditional.entries[0].definitions[0].definition,
            "基于动物身体最外层硬化而形成的骨骼系统"
        );

        let headed = json!({
            "query": {
                "pages": [{
                    "pageid": 2,
                    "title": "牙齿",
                    "extract": "== 漢語 ==\n=== 發音 ===\n=== 名詞 ===\n牙齿\n(解剖学) 用于咀嚼食物的钙化组织。(量词：颗)\n==== 同義詞 ====\n==== 翻譯 ===="
                }]
            }
        });
        let cleaned = parse_wiktionary_extracts("牙齿", "zh.wiktionary.org", &headed).unwrap();
        assert_eq!(cleaned.entries[0].part_of_speech.as_deref(), Some("名词"));
        assert_eq!(
            cleaned.entries[0].definitions[0].definition,
            "(解剖学) 用于咀嚼食物的钙化组织。(量词：颗)"
        );
        assert_eq!(cleaned.entries[0].definitions.len(), 1);
        assert_eq!(
            parse_wiktionary_extracts(
                "无此词",
                "zh.wiktionary.org",
                &json!({ "query": { "pages": [{ "title": "无此词", "missing": true }] } })
            )
            .unwrap_err()
            .code,
            "READER_NOT_FOUND"
        );
    }

    #[test]
    fn deepl_status_and_payload_errors_are_visible() {
        assert_eq!(
            status_error(ReaderService::DeepL, StatusCode::FORBIDDEN)
                .unwrap()
                .code,
            "READER_KEY_INVALID"
        );
        assert_eq!(
            status_error(ReaderService::DeepL, StatusCode::from_u16(456).unwrap())
                .unwrap()
                .code,
            "READER_QUOTA_EXCEEDED"
        );
        assert_eq!(
            status_error(ReaderService::Wiktionary, StatusCode::NOT_FOUND)
                .unwrap()
                .code,
            "READER_NOT_FOUND"
        );
        let parsed = parse_deepl_translation(
            &json!({
                "translations": [{
                    "detected_source_language": "EN",
                    "text": "你好"
                }]
            }),
            "ZH",
        )
        .unwrap();
        assert_eq!(parsed.text, "你好");
        assert_eq!(parsed.target_lang, "ZH");
        assert_eq!(parsed.detected_source_language.as_deref(), Some("EN"));
    }

    #[test]
    fn configured_payload_is_boolean_and_never_the_secret() {
        let configured = deepl_configured_from_secret(Some("secret-key:fx".into()));
        let value = serde_json::to_value(&configured).unwrap();
        assert_eq!(value, json!({ "configured": true }));
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 1);
        assert!(!value.to_string().contains("secret-key"));
        assert_eq!(
            serde_json::to_value(deepl_configured_from_secret(None)).unwrap(),
            json!({ "configured": false })
        );
        assert_eq!(
            normalize_deepl_key("  ").unwrap_err().code,
            "READER_KEY_MISSING"
        );
        assert_eq!(normalize_deepl_key("abc:fx").unwrap(), "abc:fx");
    }
}
