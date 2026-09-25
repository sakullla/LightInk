//! 通用书源引擎：结构化规则、来源管理与搜索。
//!
//! 规则以 JSON 描述站点的搜索/目录/正文、分页、编码、请求头与速率；解析与提取
//! 都是纯函数，可在无网络下单元测试。网络访问全部经 Tauri 命令，并复用
//! `remote` 的 URL/重定向/超时/大小策略。规则结构里不存在登录、付费墙、验证码
//! 或 DRM 绕过字段，自定义请求头也拒绝凭据类头部。

use crate::library;
use crate::remote::{build_client, response_error, validate_remote_url, RemoteError};
use encoding_rs::Encoding;
use futures_util::StreamExt;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::Semaphore;
use url::Url;

pub const MAX_BOOK_SOURCE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SEARCH_RESULTS: usize = 50;
const MAX_TITLE_CHARS: usize = 120;
const MAX_RULE_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 8;
const MAX_RATE_LIMIT_MS: u64 = 60_000;
const DEFAULT_RATE_LIMIT_MS: u64 = 500;
const MAX_CONCURRENT_REQUESTS: usize = 2;
const MAX_ATTEMPTS: u32 = 3;
const MAX_IMPORT_SOURCES: usize = 100;
const RULE_VERSION: u32 = 1;

/// 规则里不允许出现的字段名（登录、付费、验证码、DRM 绕过能力的入口）。
const FORBIDDEN_RULE_KEYS: &[&str] = &[
    "login",
    "loginurl",
    "password",
    "username",
    "captcha",
    "verify",
    "verification",
    "paywall",
    "payment",
    "subscribe",
    "subscription",
    "drm",
    "decrypt",
    "cookie",
    "cookies",
    "session",
    "token",
    "authorization",
    "oauth",
    "browser",
    "webview",
    "javascript",
];

/// 凭据类请求头不接受：书源规则不提供登录能力。
const FORBIDDEN_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "host",
];

// ── 规则模型 ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookSourceHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookSourceSearchRule {
    /// 搜索地址模板，必须包含 `{{key}}`，可含 `{{page}}`。
    pub url: String,
    /// 结果条目正则，第 1 个捕获组为条目 HTML。
    pub item: String,
    /// 标题正则，第 1 个捕获组为标题文本。
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookSourceTocRule {
    #[serde(default)]
    pub url: Option<String>,
    pub item: String,
    pub title: String,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookSourceContentRule {
    /// 正文正则，第 1 个捕获组为正文 HTML。
    pub text: String,
    /// 依次作用于捕获内容的清理正则（替换为空）。
    #[serde(default)]
    pub cleanup: Vec<String>,
    #[serde(default)]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookSourceRule {
    pub version: u32,
    pub base_url: String,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub rate_limit_ms: Option<u64>,
    #[serde(default)]
    pub headers: Vec<BookSourceHeader>,
    pub search: BookSourceSearchRule,
    #[serde(default)]
    pub toc: Option<BookSourceTocRule>,
    #[serde(default)]
    pub content: Option<BookSourceContentRule>,
}

// ── 对外结构 ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSource {
    pub id: String,
    pub title: String,
    pub rule: BookSourceRule,
    pub enabled: bool,
    pub allow_http: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceInput {
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub allow_http: Option<bool>,
    pub rule: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceIssue {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceCheck {
    pub ok: bool,
    pub issues: Vec<BookSourceIssue>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceBuiltin {
    pub id: String,
    pub title: String,
    pub url: String,
    pub license: String,
    pub rule: BookSourceRule,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceSearchResult {
    pub source_id: String,
    pub source_title: String,
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookSourceSearchEntry {
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceChapter {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookSourceExportFile {
    format: String,
    version: u32,
    sources: Vec<BookSourceExportEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookSourceExportEntry {
    title: String,
    #[serde(default)]
    allow_http: bool,
    rule: Value,
}

// ── 限速与重试状态 ──────────────────────────────────────────────────

/// 每源的最小请求间隔与并发上限；下载管线（R8）复用同一状态。
#[derive(Default)]
pub struct BookSourceState {
    last_request: Mutex<HashMap<String, Instant>>,
    slots: Mutex<HashMap<String, Arc<Semaphore>>>,
}

fn wait_duration(last: Option<Instant>, now: Instant, min_interval: Duration) -> Duration {
    match last {
        Some(last) => min_interval.saturating_sub(now.saturating_duration_since(last)),
        None => Duration::ZERO,
    }
}

fn retry_backoff(attempt: u32) -> Duration {
    Duration::from_millis(300 * (1_u64 << attempt.min(4)))
}

fn transient_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

async fn wait_for_rate_limit(state: &BookSourceState, source_id: &str, min_interval: Duration) {
    let wait = match state.last_request.lock() {
        Ok(mut requests) => {
            let now = Instant::now();
            let wait = wait_duration(requests.get(source_id).copied(), now, min_interval);
            requests.insert(source_id.to_string(), now + wait);
            wait
        }
        Err(_) => Duration::ZERO,
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

fn request_slot(state: &BookSourceState, source_id: &str) -> Arc<Semaphore> {
    state
        .slots
        .lock()
        .map(|mut slots| {
            slots
                .entry(source_id.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)))
                .clone()
        })
        .unwrap_or_else(|_| Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)))
}

// ── 校验 / 自检 ─────────────────────────────────────────────────────

fn issue(field: impl Into<String>, message: impl Into<String>) -> BookSourceIssue {
    BookSourceIssue {
        field: field.into(),
        message: message.into(),
    }
}

fn compile_regex(pattern: &str) -> Result<Regex, String> {
    if pattern.trim().is_empty() {
        return Err("正则不能为空".to_string());
    }
    Regex::new(pattern).map_err(|error| {
        let reason = error
            .to_string()
            .lines()
            .next()
            .unwrap_or("正则语法错误")
            .to_string();
        format!("正则无效: {reason}")
    })
}

fn check_regex(pattern: &str, field: &str, issues: &mut Vec<BookSourceIssue>) {
    if let Err(message) = compile_regex(pattern) {
        issues.push(issue(field, message));
    }
}

fn check_selector(pattern: &str, field: &str, issues: &mut Vec<BookSourceIssue>) {
    match compile_regex(pattern) {
        Ok(regex) => {
            if regex.captures_len() < 2 {
                issues.push(issue(field, "正则必须包含第 1 个捕获组"));
            }
        }
        Err(message) => issues.push(issue(field, message)),
    }
}

fn check_optional_selector(
    pattern: &Option<String>,
    field: &str,
    issues: &mut Vec<BookSourceIssue>,
) {
    if let Some(pattern) = pattern.as_deref() {
        check_selector(pattern, field, issues);
    }
}

fn check_header(header: &BookSourceHeader, index: usize, issues: &mut Vec<BookSourceIssue>) {
    let name_field = format!("headers[{index}].name");
    let name = header.name.trim();
    if name.is_empty() {
        issues.push(issue(&name_field, "请求头名称不能为空"));
        return;
    }
    if reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err() {
        issues.push(issue(&name_field, format!("请求头名称无效: {name}")));
        return;
    }
    if FORBIDDEN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        issues.push(issue(&name_field, "书源不支持凭据类请求头"));
    }
    if reqwest::header::HeaderValue::from_str(&header.value).is_err() {
        issues.push(issue(
            format!("headers[{index}].value"),
            "请求头取值包含非法字符",
        ));
    }
}

fn collect_forbidden_keys(value: &Value, path: &str, issues: &mut Vec<BookSourceIssue>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                if FORBIDDEN_RULE_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
                    issues.push(issue(
                        &child_path,
                        "书源规则不允许登录、付费、验证码或 DRM 绕过能力",
                    ));
                }
                collect_forbidden_keys(child, &child_path, issues);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                collect_forbidden_keys(child, &format!("{path}[{index}]"), issues);
            }
        }
        _ => {}
    }
}

/// 结构化自检：返回全部问题（字段 + 原因），`ok` 表示规则可用。
pub fn check_rule(rule: &BookSourceRule, allow_http: bool) -> BookSourceCheck {
    let mut issues = Vec::new();
    if rule.version != RULE_VERSION {
        issues.push(issue(
            "version",
            format!("仅支持规则版本 {RULE_VERSION}，收到 {}", rule.version),
        ));
    }
    if let Err(error) = validate_remote_url(&rule.base_url, allow_http) {
        issues.push(issue("baseUrl", error.message));
    }
    if let Some(charset) = rule.charset.as_deref() {
        let label = charset.trim();
        if !label.is_empty() && Encoding::for_label(label.as_bytes()).is_none() {
            issues.push(issue("charset", format!("不支持的字符编码: {label}")));
        }
    }
    if let Some(rate) = rule.rate_limit_ms {
        if rate > MAX_RATE_LIMIT_MS {
            issues.push(issue(
                "rateLimitMs",
                format!("请求间隔不能超过 {MAX_RATE_LIMIT_MS} 毫秒"),
            ));
        }
    }
    if rule.headers.len() > MAX_HEADERS {
        issues.push(issue(
            "headers",
            format!("自定义请求头不能超过 {MAX_HEADERS} 个"),
        ));
    }
    for (index, header) in rule.headers.iter().enumerate() {
        check_header(header, index, &mut issues);
    }
    if !rule.search.url.contains("{{key}}") {
        issues.push(issue("search.url", "搜索地址必须包含 {{key}} 占位符"));
    }
    check_selector(&rule.search.item, "search.item", &mut issues);
    check_selector(&rule.search.title, "search.title", &mut issues);
    check_optional_selector(&rule.search.author, "search.author", &mut issues);
    check_optional_selector(&rule.search.link, "search.link", &mut issues);
    check_optional_selector(&rule.search.cover, "search.cover", &mut issues);
    check_optional_selector(&rule.search.next_page, "search.nextPage", &mut issues);
    if let Some(toc) = &rule.toc {
        if toc.url.as_deref().is_some_and(|url| url.trim().is_empty()) {
            issues.push(issue("toc.url", "目录地址模板不能为空"));
        }
        check_selector(&toc.item, "toc.item", &mut issues);
        check_selector(&toc.title, "toc.title", &mut issues);
        check_optional_selector(&toc.link, "toc.link", &mut issues);
        check_optional_selector(&toc.next_page, "toc.nextPage", &mut issues);
    }
    if let Some(content) = &rule.content {
        check_selector(&content.text, "content.text", &mut issues);
        for (index, pattern) in content.cleanup.iter().enumerate() {
            check_regex(pattern, &format!("content.cleanup[{index}]"), &mut issues);
        }
        check_optional_selector(&content.next_page, "content.nextPage", &mut issues);
    }
    BookSourceCheck {
        ok: issues.is_empty(),
        issues,
    }
}

/// 接收未解析的规则 JSON：先拒绝禁用能力字段，再做结构与语法自检。
pub fn check_rule_value(value: &Value, allow_http: bool) -> BookSourceCheck {
    let mut issues = Vec::new();
    collect_forbidden_keys(value, "rule", &mut issues);
    match serde_json::from_value::<BookSourceRule>(value.clone()) {
        Ok(rule) => issues.extend(check_rule(&rule, allow_http).issues),
        Err(error) => issues.push(issue("rule", format!("规则结构无效: {error}"))),
    }
    BookSourceCheck {
        ok: issues.is_empty(),
        issues,
    }
}

fn rule_error(field: &str, message: impl std::fmt::Display) -> RemoteError {
    RemoteError::new(
        "BOOK_SOURCE_RULE_INVALID",
        format!("规则字段 {field} 无效: {message}"),
    )
}

// ── 文本提取（纯函数） ──────────────────────────────────────────────

fn tag_regex() -> &'static Regex {
    static TAG: OnceLock<Regex> = OnceLock::new();
    TAG.get_or_init(|| Regex::new(r"(?s)<[^>]*>").expect("标签正则必须有效"))
}

fn line_break_regex() -> &'static Regex {
    static BREAK: OnceLock<Regex> = OnceLock::new();
    BREAK.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").expect("换行正则必须有效"))
}

fn block_break_regex() -> &'static Regex {
    static BREAK: OnceLock<Regex> = OnceLock::new();
    BREAK.get_or_init(|| {
        Regex::new(r"(?i)</p\s*>|</div\s*>|</h[1-6]\s*>|</li\s*>|</tr\s*>")
            .expect("段落正则必须有效")
    })
}

fn entity_regex() -> &'static Regex {
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    ENTITY.get_or_init(|| Regex::new(r"&#(x?[0-9a-fA-F]+);").expect("实体正则必须有效"))
}

fn default_link_regex() -> &'static Regex {
    static LINK: OnceLock<Regex> = OnceLock::new();
    LINK.get_or_init(|| Regex::new(r#"href="([^"]+)""#).expect("默认链接正则必须有效"))
}

fn decode_entities(raw: &str) -> String {
    let text = raw
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    if !text.contains("&#") {
        return text;
    }
    entity_regex()
        .replace_all(&text, |captures: &regex::Captures<'_>| {
            let raw = captures.get(1).map(|value| value.as_str()).unwrap_or("");
            let code = match raw.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => raw.parse::<u32>().ok(),
            };
            code.and_then(char::from_u32)
                .map(|value| value.to_string())
                .unwrap_or_default()
        })
        .into_owned()
}

fn clean_text(raw: &str) -> String {
    let stripped = tag_regex().replace_all(raw, " ");
    decode_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn clean_content(raw: &str) -> String {
    let spaced = line_break_regex().replace_all(raw, "\n");
    let spaced = block_break_regex().replace_all(&spaced, "\n\n");
    let stripped = tag_regex().replace_all(&spaced, "");
    let decoded = decode_entities(&stripped);
    let mut lines: Vec<&str> = Vec::new();
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if lines.last().is_some_and(|last| !last.is_empty()) {
                lines.push("");
            }
            continue;
        }
        lines.push(trimmed);
    }
    while lines.last().is_some_and(|last| last.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

fn selector_capture<'a>(regex: &Regex, text: &'a str) -> Option<&'a str> {
    regex
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
}

fn resolve_url(base: &Url, candidate: &str) -> Result<Url, RemoteError> {
    base.join(candidate.trim())
        .map_err(|error| RemoteError::new("BOOK_SOURCE_URL_INVALID", format!("地址无效: {error}")))
}

fn render_template(template: &str, values: &[(&str, &str)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in values {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }
    rendered
}

fn encode_query(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn search_target(rule: &BookSourceRule, allow_http: bool, query: &str) -> Result<Url, RemoteError> {
    let base = validate_remote_url(&rule.base_url, allow_http)?;
    let template = render_template(
        &rule.search.url,
        &[("key", &encode_query(query)), ("page", "1")],
    );
    let target = resolve_url(&base, &template)?;
    validate_remote_url(target.as_str(), allow_http)
}

pub fn extract_search_entries(
    rule: &BookSourceSearchRule,
    html: &str,
    base: &Url,
) -> Result<Vec<BookSourceSearchEntry>, RemoteError> {
    let item = compile_regex(&rule.item).map_err(|message| rule_error("search.item", message))?;
    let title =
        compile_regex(&rule.title).map_err(|message| rule_error("search.title", message))?;
    let author = rule
        .author
        .as_deref()
        .map(compile_regex)
        .transpose()
        .map_err(|message| rule_error("search.author", message))?;
    let link = rule
        .link
        .as_deref()
        .map(compile_regex)
        .transpose()
        .map_err(|message| rule_error("search.link", message))?;
    let cover = rule
        .cover
        .as_deref()
        .map(compile_regex)
        .transpose()
        .map_err(|message| rule_error("search.cover", message))?;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for captures in item.captures_iter(html) {
        let Some(block) = captures.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let Some(title_text) = selector_capture(&title, block)
            .map(clean_text)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let href = match &link {
            Some(link) => selector_capture(link, block).map(str::to_string),
            None => selector_capture(default_link_regex(), block).map(str::to_string),
        };
        let Some(href) = href else {
            continue;
        };
        let Ok(url) = resolve_url(base, &href) else {
            continue;
        };
        if !seen.insert(url.to_string()) {
            continue;
        }
        let author = author
            .as_ref()
            .and_then(|regex| selector_capture(regex, block))
            .map(clean_text)
            .filter(|value| !value.is_empty());
        let cover_url = cover
            .as_ref()
            .and_then(|regex| selector_capture(regex, block))
            .and_then(|href| resolve_url(base, href).ok())
            .map(|url| url.to_string());
        entries.push(BookSourceSearchEntry {
            title: title_text,
            author,
            url: url.to_string(),
            cover_url,
        });
        if entries.len() >= MAX_SEARCH_RESULTS {
            break;
        }
    }
    Ok(entries)
}

pub fn extract_chapters(
    rule: &BookSourceTocRule,
    html: &str,
    base: &Url,
) -> Result<Vec<BookSourceChapter>, RemoteError> {
    let item = compile_regex(&rule.item).map_err(|message| rule_error("toc.item", message))?;
    let title = compile_regex(&rule.title).map_err(|message| rule_error("toc.title", message))?;
    let link = rule
        .link
        .as_deref()
        .map(compile_regex)
        .transpose()
        .map_err(|message| rule_error("toc.link", message))?;
    let mut chapters = Vec::new();
    let mut seen = HashSet::new();
    for captures in item.captures_iter(html) {
        let Some(block) = captures.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let Some(title_text) = selector_capture(&title, block)
            .map(clean_text)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let href = match &link {
            Some(link) => selector_capture(link, block).map(str::to_string),
            None => selector_capture(default_link_regex(), block).map(str::to_string),
        };
        let Some(href) = href else {
            continue;
        };
        let Ok(url) = resolve_url(base, &href) else {
            continue;
        };
        if !seen.insert(url.to_string()) {
            continue;
        }
        chapters.push(BookSourceChapter {
            title: title_text,
            url: url.to_string(),
        });
    }
    Ok(chapters)
}

pub fn extract_content(rule: &BookSourceContentRule, html: &str) -> Result<String, RemoteError> {
    let text = compile_regex(&rule.text).map_err(|message| rule_error("content.text", message))?;
    let Some(raw) = selector_capture(&text, html) else {
        return Err(RemoteError::new(
            "BOOK_SOURCE_CONTENT_MISSING",
            "正文规则未匹配到内容",
        ));
    };
    let mut cleaned = raw.to_string();
    for (index, pattern) in rule.cleanup.iter().enumerate() {
        let field = format!("content.cleanup[{index}]");
        let regex = compile_regex(pattern).map_err(|message| rule_error(&field, message))?;
        cleaned = regex.replace_all(&cleaned, "").into_owned();
    }
    Ok(clean_content(&cleaned))
}

// ── 网络读取 ────────────────────────────────────────────────────────

fn decode_body(bytes: &[u8], charset: Option<&str>) -> Result<String, RemoteError> {
    let encoding = charset
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (decoded, _, _) = encoding.decode(bytes);
    Ok(decoded.into_owned())
}

async fn fetch_text_once(
    rule: &BookSourceRule,
    url: &Url,
) -> Result<(Url, String), (RemoteError, bool)> {
    let client = build_client(url, false).map_err(|error| (error, false))?;
    let mut request = client.get(url.clone());
    for header in &rule.headers {
        let name = reqwest::header::HeaderName::from_bytes(header.name.trim().as_bytes())
            .map_err(|_| (rule_error("headers", "请求头名称无效"), false))?;
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|_| (rule_error("headers", "请求头取值无效"), false))?;
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|error| {
        (
            RemoteError::new(
                "BOOK_SOURCE_NETWORK_ERROR",
                format!("无法连接书源: {error}"),
            ),
            true,
        )
    })?;
    if let Some(error) = response_error(&response) {
        let transient = transient_status(response.status());
        return Err((error, transient));
    }
    if !response.status().is_success() {
        let status = response.status();
        return Err((
            RemoteError::status(
                "BOOK_SOURCE_HTTP_ERROR",
                format!("书源返回 HTTP {}", status.as_u16()),
                status,
            ),
            transient_status(status),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BOOK_SOURCE_BYTES as u64)
    {
        return Err((
            RemoteError::new("BOOK_SOURCE_TOO_LARGE", "书源响应超过大小限制"),
            false,
        ));
    }
    let final_url = response.url().clone();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            (
                RemoteError::new(
                    "BOOK_SOURCE_NETWORK_ERROR",
                    format!("书源传输中断: {error}"),
                ),
                true,
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BOOK_SOURCE_BYTES {
            return Err((
                RemoteError::new("BOOK_SOURCE_TOO_LARGE", "书源响应超过大小限制"),
                false,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = decode_body(&bytes, rule.charset.as_deref()).map_err(|error| (error, false))?;
    Ok((final_url, text))
}

async fn fetch_source_text(
    state: &BookSourceState,
    source_id: &str,
    rule: &BookSourceRule,
    url: &Url,
) -> Result<(Url, String), RemoteError> {
    let slot = request_slot(state, source_id);
    let _permit = slot
        .acquire()
        .await
        .map_err(|_| RemoteError::new("BOOK_SOURCE_STATE_UNAVAILABLE", "书源请求通道暂时不可用"))?;
    let min_interval = Duration::from_millis(rule.rate_limit_ms.unwrap_or(DEFAULT_RATE_LIMIT_MS));
    let mut last_error = RemoteError::new("BOOK_SOURCE_NETWORK_ERROR", "书源请求失败");
    for attempt in 0..MAX_ATTEMPTS {
        wait_for_rate_limit(state, source_id, min_interval).await;
        match fetch_text_once(rule, url).await {
            Ok(result) => return Ok(result),
            Err((error, transient)) => {
                let exhausted = attempt + 1 >= MAX_ATTEMPTS;
                last_error = error;
                if !transient || exhausted {
                    break;
                }
                tokio::time::sleep(retry_backoff(attempt)).await;
            }
        }
    }
    Err(last_error)
}

// ── 持久化 ──────────────────────────────────────────────────────────

fn storage_error(message: impl std::fmt::Display) -> RemoteError {
    RemoteError::new("BOOK_SOURCE_STORAGE_ERROR", message.to_string())
}

fn open_library(app: &AppHandle) -> Result<Connection, RemoteError> {
    let directory = library::app_data_dir(app).map_err(storage_error)?;
    library::open_database_at(&directory).map_err(storage_error)
}

fn read_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookSource> {
    let rule_json: String = row.get(2)?;
    let rule: BookSourceRule = serde_json::from_str(&rule_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(BookSource {
        id: row.get(0)?,
        title: row.get(1)?,
        rule,
        enabled: row.get::<_, i64>(3)? != 0,
        allow_http: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn list_sources_at(connection: &Connection) -> Result<Vec<BookSource>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,title,rule_json,enabled,allow_http,created_at,updated_at
             FROM book_sources ORDER BY title COLLATE NOCASE,id",
        )
        .map_err(|error| format!("无法读取书源列表: {error}"))?;
    let sources = statement
        .query_map([], read_source)
        .map_err(|error| format!("无法读取书源列表: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书源列表: {error}"))?;
    Ok(sources)
}

fn source_at(connection: &Connection, source_id: &str) -> Result<Option<BookSource>, String> {
    connection
        .prepare(
            "SELECT id,title,rule_json,enabled,allow_http,created_at,updated_at
             FROM book_sources WHERE id=?1",
        )
        .and_then(|mut statement| {
            statement
                .query_row(params![source_id], read_source)
                .optional()
        })
        .map_err(|error| format!("无法读取书源: {error}"))
}

fn write_source_at(connection: &Connection, source: &BookSource) -> Result<(), String> {
    let rule_json = serde_json::to_string(&source.rule)
        .map_err(|error| format!("无法序列化书源规则: {error}"))?;
    if rule_json.len() > MAX_RULE_BYTES {
        return Err(format!("书源规则不能超过 {MAX_RULE_BYTES} 字节"));
    }
    connection
        .execute(
            "INSERT INTO book_sources(id,title,rule_json,enabled,allow_http,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title,
               rule_json=excluded.rule_json,
               enabled=excluded.enabled,
               allow_http=excluded.allow_http,
               updated_at=excluded.updated_at",
            params![
                source.id,
                source.title,
                rule_json,
                source.enabled as i64,
                source.allow_http as i64,
                source.created_at,
                source.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存书源: {error}"))?;
    Ok(())
}

fn set_enabled_at(
    connection: &Connection,
    source_id: &str,
    enabled: bool,
) -> Result<BookSource, String> {
    let changed = connection
        .execute(
            "UPDATE book_sources SET enabled=?1,updated_at=?2 WHERE id=?3",
            params![enabled as i64, library::now_ms(), source_id],
        )
        .map_err(|error| format!("无法更新书源状态: {error}"))?;
    if changed == 0 {
        return Err("书源不存在".to_string());
    }
    source_at(connection, source_id)?.ok_or_else(|| "书源不存在".to_string())
}

fn remove_at(connection: &Connection, source_id: &str) -> Result<(), String> {
    let changed = connection
        .execute("DELETE FROM book_sources WHERE id=?1", params![source_id])
        .map_err(|error| format!("无法删除书源: {error}"))?;
    if changed == 0 {
        return Err("书源不存在".to_string());
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<String, RemoteError> {
    let title = title.trim();
    let length = title.chars().count();
    if length == 0 || length > MAX_TITLE_CHARS {
        return Err(RemoteError::new(
            "BOOK_SOURCE_INVALID",
            format!("书源名称长度必须为 1 至 {MAX_TITLE_CHARS} 个字符"),
        ));
    }
    Ok(title.to_string())
}

fn parse_rule(value: &Value, allow_http: bool) -> Result<BookSourceRule, RemoteError> {
    let check = check_rule_value(value, allow_http);
    if !check.ok {
        let first = check.issues.first();
        let message = match first {
            Some(first) => format!("规则字段 {} 无效: {}", first.field, first.message),
            None => "书源规则无效".to_string(),
        };
        return Err(RemoteError::new("BOOK_SOURCE_RULE_INVALID", message));
    }
    serde_json::from_value(value.clone()).map_err(|error| {
        RemoteError::new("BOOK_SOURCE_RULE_INVALID", format!("规则结构无效: {error}"))
    })
}

fn validated_source(
    existing: Option<&BookSource>,
    id: Option<String>,
    title: &str,
    allow_http: bool,
    rule_value: &Value,
) -> Result<BookSource, RemoteError> {
    let title = validate_title(title)?;
    let rule = parse_rule(rule_value, allow_http)?;
    let now = library::now_ms();
    Ok(BookSource {
        id: id
            .or_else(|| existing.map(|value| value.id.clone()))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        title,
        rule,
        enabled: existing.is_none_or(|value| value.enabled),
        allow_http,
        created_at: existing.map_or(now, |value| value.created_at),
        updated_at: now,
    })
}

fn parse_import(json: &str) -> Result<Vec<BookSourceExportEntry>, RemoteError> {
    let value: Value = serde_json::from_str(json).map_err(|error| {
        RemoteError::new(
            "BOOK_SOURCE_IMPORT_INVALID",
            format!("导入内容不是有效 JSON: {error}"),
        )
    })?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|error| {
            RemoteError::new(
                "BOOK_SOURCE_IMPORT_INVALID",
                format!("导入列表结构无效: {error}"),
            )
        })
    } else {
        serde_json::from_value::<BookSourceExportFile>(value)
            .map(|file| file.sources)
            .map_err(|error| {
                RemoteError::new(
                    "BOOK_SOURCE_IMPORT_INVALID",
                    format!("导入文件结构无效: {error}"),
                )
            })
    }
}

fn export_payload(sources: &[BookSource]) -> Result<String, RemoteError> {
    let file = BookSourceExportFile {
        format: "lightink.book-sources".to_string(),
        version: RULE_VERSION,
        sources: sources
            .iter()
            .map(|source| BookSourceExportEntry {
                title: source.title.clone(),
                allow_http: source.allow_http,
                rule: serde_json::to_value(&source.rule).unwrap_or(Value::Null),
            })
            .collect(),
    };
    serde_json::to_string_pretty(&file).map_err(|error| {
        RemoteError::new(
            "BOOK_SOURCE_EXPORT_FAILED",
            format!("无法导出书源: {error}"),
        )
    })
}

/// 导出内容再导入时逐条重建，测试与命令行共用。
fn validated_import_entries(
    entries: Vec<BookSourceExportEntry>,
) -> Result<Vec<BookSource>, RemoteError> {
    if entries.is_empty() {
        return Err(RemoteError::new(
            "BOOK_SOURCE_IMPORT_INVALID",
            "导入内容不包含书源",
        ));
    }
    if entries.len() > MAX_IMPORT_SOURCES {
        return Err(RemoteError::new(
            "BOOK_SOURCE_IMPORT_INVALID",
            format!("单次导入不能超过 {MAX_IMPORT_SOURCES} 个书源"),
        ));
    }
    let mut sources = Vec::with_capacity(entries.len());
    for entry in entries {
        sources.push(validated_source(
            None,
            None,
            &entry.title,
            entry.allow_http,
            &entry.rule,
        )?);
    }
    Ok(sources)
}

// ── 内置示例源（仅公版/合法来源） ───────────────────────────────────

fn builtin(id: &str, title: &str, license: &str, rule_json: &str) -> BookSourceBuiltin {
    let rule: BookSourceRule =
        serde_json::from_str(rule_json).expect("内置书源规则必须是有效 JSON");
    BookSourceBuiltin {
        id: id.to_string(),
        title: title.to_string(),
        url: rule.base_url.clone(),
        license: license.to_string(),
        rule,
    }
}

pub fn builtin_sources() -> Vec<BookSourceBuiltin> {
    vec![
        builtin(
            "builtin-gutenberg",
            "Project Gutenberg",
            "public-domain",
            r#"{
              "version": 1,
              "baseUrl": "https://www.gutenberg.org",
              "search": {
                "url": "/ebooks/search/?query={{key}}",
                "item": "<li class=\"booklink\">(?s)(.*?)</li>",
                "title": "<span class=\"title\">(?s)(.*?)</span>",
                "author": "<span class=\"subtitle\">(?s)(.*?)</span>",
                "link": "<a class=\"link\" href=\"([^\"]+)\"",
                "cover": "<img class=\"cover-thumb\" src=\"([^\"]+)\""
              }
            }"#,
        ),
        builtin(
            "builtin-standard-ebooks",
            "Standard Ebooks",
            "cc0-1.0",
            r#"{
              "version": 1,
              "baseUrl": "https://standardebooks.org",
              "search": {
                "url": "/ebooks?query={{key}}",
                "item": "<li typeof=\"schema:Book\"(?s)(.*?)</li>",
                "title": "<span property=\"schema:name\">(?s)(.*?)</span>",
                "author": "property=\"schema:author\"(?s).*?<span property=\"schema:name\">(?s)(.*?)</span>",
                "link": "<a href=\"([^\"]+)\"",
                "cover": "<img src=\"([^\"]+)\""
              }
            }"#,
        ),
    ]
}

// ── Tauri 命令 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn book_source_list(app: AppHandle) -> Result<Vec<BookSource>, RemoteError> {
    let connection = open_library(&app)?;
    list_sources_at(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn book_source_upsert(
    app: AppHandle,
    input: BookSourceInput,
) -> Result<BookSource, RemoteError> {
    let connection = open_library(&app)?;
    let existing = match input.id.as_deref() {
        Some(id) => source_at(&connection, id).map_err(storage_error)?,
        None => None,
    };
    if input.id.is_some() && existing.is_none() {
        return Err(RemoteError::new("BOOK_SOURCE_NOT_FOUND", "书源不存在"));
    }
    let allow_http = input.allow_http.unwrap_or(false);
    let saved = validated_source(
        existing.as_ref(),
        input.id,
        &input.title,
        allow_http,
        &input.rule,
    )?;
    write_source_at(&connection, &saved).map_err(storage_error)?;
    Ok(saved)
}

#[tauri::command]
pub fn book_source_remove(app: AppHandle, source_id: String) -> Result<(), RemoteError> {
    let connection = open_library(&app)?;
    remove_at(&connection, &source_id).map_err(|message| {
        if message == "书源不存在" {
            RemoteError::new("BOOK_SOURCE_NOT_FOUND", message)
        } else {
            storage_error(message)
        }
    })
}

#[tauri::command]
pub fn book_source_set_enabled(
    app: AppHandle,
    source_id: String,
    enabled: bool,
) -> Result<BookSource, RemoteError> {
    let connection = open_library(&app)?;
    set_enabled_at(&connection, &source_id, enabled).map_err(|message| {
        if message == "书源不存在" {
            RemoteError::new("BOOK_SOURCE_NOT_FOUND", message)
        } else {
            storage_error(message)
        }
    })
}

#[tauri::command]
pub fn book_source_import(app: AppHandle, json: String) -> Result<Vec<BookSource>, RemoteError> {
    let entries = parse_import(&json)?;
    let sources = validated_import_entries(entries)?;
    let mut connection = open_library(&app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| storage_error(format!("无法开启书源导入事务: {error}")))?;
    for source in &sources {
        write_source_at(&transaction, source).map_err(storage_error)?;
    }
    transaction
        .commit()
        .map_err(|error| storage_error(format!("无法提交书源导入: {error}")))?;
    Ok(sources)
}

#[tauri::command]
pub fn book_source_export(
    app: AppHandle,
    source_ids: Option<Vec<String>>,
) -> Result<String, RemoteError> {
    let connection = open_library(&app)?;
    let all = list_sources_at(&connection).map_err(storage_error)?;
    let selected = match source_ids {
        Some(ids) => {
            let wanted: HashSet<String> = ids.into_iter().collect();
            all.into_iter()
                .filter(|source| wanted.contains(&source.id))
                .collect()
        }
        None => all,
    };
    export_payload(&selected)
}

#[tauri::command]
pub fn book_source_self_check(rule: Value, allow_http: Option<bool>) -> BookSourceCheck {
    check_rule_value(&rule, allow_http.unwrap_or(false))
}

#[tauri::command]
pub fn book_source_builtins() -> Vec<BookSourceBuiltin> {
    builtin_sources()
}

#[tauri::command]
pub async fn book_source_search(
    app: AppHandle,
    state: State<'_, BookSourceState>,
    source_id: String,
    query: String,
) -> Result<Vec<BookSourceSearchResult>, RemoteError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(RemoteError::new(
            "BOOK_SOURCE_QUERY_EMPTY",
            "搜索关键词不能为空",
        ));
    }
    let source = load_ready_source(&app, &source_id)?;
    let target = search_target(&source.rule, source.allow_http, &query)?;
    let (final_url, html) = fetch_source_text(&state, &source.id, &source.rule, &target).await?;
    let entries = extract_search_entries(&source.rule.search, &html, &final_url)?;
    Ok(entries
        .into_iter()
        .map(|entry| BookSourceSearchResult {
            source_id: source.id.clone(),
            source_title: source.title.clone(),
            title: entry.title,
            author: entry.author,
            url: entry.url,
            cover_url: entry.cover_url,
        })
        .collect())
}

fn load_ready_source(app: &AppHandle, source_id: &str) -> Result<BookSource, RemoteError> {
    let connection = open_library(app)?;
    let source = source_at(&connection, source_id)
        .map_err(storage_error)?
        .ok_or_else(|| RemoteError::new("BOOK_SOURCE_NOT_FOUND", "书源不存在"))?;
    if !source.enabled {
        return Err(RemoteError::new("BOOK_SOURCE_DISABLED", "书源已停用"));
    }
    let check = check_rule(&source.rule, source.allow_http);
    if !check.ok {
        let message = match check.issues.first() {
            Some(first) => format!("规则字段 {} 无效: {}", first.field, first.message),
            None => "书源规则无效".to_string(),
        };
        return Err(RemoteError::new("BOOK_SOURCE_RULE_INVALID", message));
    }
    Ok(source)
}

/// 目录/正文页的目标地址：模板可含 `{{url}}`，缺省直接用传入地址。
fn document_target(
    source: &BookSource,
    template: Option<&str>,
    document_url: &str,
) -> Result<Url, RemoteError> {
    let base = validate_remote_url(&source.rule.base_url, source.allow_http)?;
    let document = validate_remote_url(document_url, source.allow_http)?;
    match template {
        Some(template) => {
            let rendered = render_template(template, &[("url", document.as_str())]);
            let target = resolve_url(&base, &rendered)?;
            validate_remote_url(target.as_str(), source.allow_http)
        }
        None => Ok(document),
    }
}

#[tauri::command]
pub async fn book_source_chapters(
    app: AppHandle,
    state: State<'_, BookSourceState>,
    source_id: String,
    book_url: String,
) -> Result<Vec<BookSourceChapter>, RemoteError> {
    let source = load_ready_source(&app, &source_id)?;
    let toc = source
        .rule
        .toc
        .as_ref()
        .ok_or_else(|| RemoteError::new("BOOK_SOURCE_TOC_MISSING", "书源规则未配置目录提取"))?;
    let target = document_target(&source, toc.url.as_deref(), &book_url)?;
    let (final_url, html) = fetch_source_text(&state, &source.id, &source.rule, &target).await?;
    extract_chapters(toc, &html, &final_url)
}

#[tauri::command]
pub async fn book_source_chapter_text(
    app: AppHandle,
    state: State<'_, BookSourceState>,
    source_id: String,
    chapter_url: String,
) -> Result<String, RemoteError> {
    let source = load_ready_source(&app, &source_id)?;
    let content =
        source.rule.content.as_ref().ok_or_else(|| {
            RemoteError::new("BOOK_SOURCE_CONTENT_MISSING", "书源规则未配置正文提取")
        })?;
    let target = document_target(&source, None, &chapter_url)?;
    let (_, html) = fetch_source_text(&state, &source.id, &source.rule, &target).await?;
    extract_content(content, &html)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_rule_value() -> Value {
        json!({
            "version": 1,
            "baseUrl": "https://books.example",
            "charset": "utf-8",
            "rateLimitMs": 500,
            "search": {
                "url": "/search?q={{key}}&page={{page}}",
                "item": "<li class=\"entry\">(?s)(.*?)</li>",
                "title": "<span class=\"title\">(?s)(.*?)</span>",
                "author": "<span class=\"author\">(?s)(.*?)</span>",
                "link": "href=\"([^\"]+)\"",
                "cover": "<img src=\"([^\"]+)\"",
            },
        })
    }

    fn sample_rule() -> BookSourceRule {
        serde_json::from_value(sample_rule_value()).unwrap()
    }

    fn base_url() -> Url {
        Url::parse("https://books.example/search?q=x").unwrap()
    }

    #[test]
    fn builtins_are_https_legal_examples_with_valid_rules() {
        let builtins = builtin_sources();
        assert_eq!(builtins.len(), 2);
        let allowed_hosts = ["www.gutenberg.org", "standardebooks.org"];
        for builtin in &builtins {
            let url = Url::parse(&builtin.url).unwrap();
            assert_eq!(url.scheme(), "https", "{}", builtin.id);
            assert!(
                allowed_hosts.contains(&url.host_str().unwrap()),
                "{}",
                builtin.id
            );
            assert!(!builtin.license.is_empty(), "{}", builtin.id);
            let check = check_rule(&builtin.rule, false);
            assert!(check.ok, "{}: {:?}", builtin.id, check.issues);
            let value = serde_json::to_value(&builtin.rule).unwrap();
            let value_check = check_rule_value(&value, false);
            assert!(value_check.ok, "{}: {:?}", builtin.id, value_check.issues);
        }
    }

    #[test]
    fn http_sources_require_explicit_allow() {
        let mut value = sample_rule_value();
        value["baseUrl"] = json!("http://books.example");
        let rule = serde_json::from_value::<BookSourceRule>(value.clone()).unwrap();
        let blocked = check_rule(&rule, false);
        assert!(!blocked.ok);
        assert_eq!(blocked.issues[0].field, "baseUrl");
        assert!(check_rule(&rule, true).ok);
        let error = validated_source(None, None, "本地源", false, &value).unwrap_err();
        assert_eq!(error.code, "BOOK_SOURCE_RULE_INVALID");
        assert!(error.message.contains("baseUrl"));
    }

    #[test]
    fn self_check_points_at_the_failing_field() {
        let mut broken = sample_rule_value();
        broken["search"]["item"] = json!("(");
        let check = check_rule_value(&broken, false);
        assert!(!check.ok);
        assert!(check
            .issues
            .iter()
            .any(|issue| issue.field == "search.item"));

        let mut missing_key = sample_rule_value();
        missing_key["search"]["url"] = json!("/search?q=");
        let check = check_rule_value(&missing_key, false);
        assert!(!check.ok);
        assert!(check.issues.iter().any(|issue| issue.field == "search.url"));

        let mut bad_charset = sample_rule_value();
        bad_charset["charset"] = json!("not-a-charset");
        let check = check_rule_value(&bad_charset, false);
        assert!(!check.ok);
        assert!(check.issues.iter().any(|issue| issue.field == "charset"));

        let mut no_group = sample_rule_value();
        no_group["search"]["title"] = json!("<span class=\"title\">.*?</span>");
        let check = check_rule_value(&no_group, false);
        assert!(!check.ok);
        assert!(check
            .issues
            .iter()
            .any(|issue| issue.field == "search.title"));
    }

    #[test]
    fn rules_reject_login_paywall_captcha_and_drm_capabilities() {
        for key in ["login", "paywall", "captcha", "drm", "cookie", "token"] {
            let mut value = sample_rule_value();
            value["search"][key] = json!("https://evil.example/login");
            let check = check_rule_value(&value, false);
            assert!(!check.ok, "accepted forbidden key {key}");
            assert!(
                check
                    .issues
                    .iter()
                    .any(|issue| issue.field.contains(key) && issue.message.contains("不允许")),
                "missing forbidden issue for {key}: {:?}",
                check.issues
            );
        }

        let mut header = sample_rule_value();
        header["headers"] = json!([{ "name": "Authorization", "value": "Bearer secret" }]);
        let check = check_rule_value(&header, false);
        assert!(!check.ok);
        assert!(check
            .issues
            .iter()
            .any(|issue| issue.field == "headers[0].name"));

        let mut bad_name = sample_rule_value();
        bad_name["headers"] = json!([{ "name": "X Bad", "value": "1" }]);
        assert!(!check_rule_value(&bad_name, false).ok);

        let mut unknown = sample_rule_value();
        unknown["search"]["javascript"] = json!("document.cookie");
        assert!(!check_rule_value(&unknown, false).ok);
    }

    #[test]
    fn extracts_search_results_and_resolves_relative_links() {
        let rule = sample_rule();
        let html = r#"
            <ul>
              <li class="entry"><a href="/book/1"><span class="title">第一本</span><span class="author">作者甲</span><img src="/cover/1.jpg"></a></li>
              <li class="entry"><a href="/book/2?from=list"><span class="title">第二本</span><span class="author">作者乙</span><img src="/cover/2.jpg"></a></li>
              <li class="entry"><a href="/book/1"><span class="title">重复条目</span></a></li>
            </ul>
        "#;
        let entries = extract_search_entries(&rule.search, html, &base_url()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "第一本");
        assert_eq!(entries[0].author.as_deref(), Some("作者甲"));
        assert_eq!(entries[0].url, "https://books.example/book/1");
        assert_eq!(
            entries[0].cover_url.as_deref(),
            Some("https://books.example/cover/1.jpg")
        );
        assert_eq!(entries[1].url, "https://books.example/book/2?from=list");
    }

    #[test]
    fn extracts_chapters_and_content_with_cleanup() {
        let toc: BookSourceTocRule = serde_json::from_value(json!({
            "item": "<li>(?s)(.*?)</li>",
            "title": "<a href=\"[^\"]+\">(?s)(.*?)</a>",
            "link": "href=\"([^\"]+)\"",
        }))
        .unwrap();
        let html = r#"<ul>
            <li><a href="/ch/1">第一章</a></li>
            <li><a href="/ch/2">第二章</a></li>
            <li><a href="/ch/1">重复章节</a></li>
        </ul>"#;
        let chapters = extract_chapters(&toc, html, &base_url()).unwrap();
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "第一章");
        assert_eq!(chapters[0].url, "https://books.example/ch/1");

        let content: BookSourceContentRule = serde_json::from_value(json!({
            "text": "<div id=\"content\">(?s)(.*?)</div>",
            "cleanup": ["<script(?s).*?</script>"],
        }))
        .unwrap();
        let body =
            r#"<div id="content"><p>第一段<br>续行</p><script>bad()</script><p>第二段</p></div>"#;
        let text = extract_content(&content, body).unwrap();
        assert_eq!(text, "第一段\n续行\n\n第二段");

        let missing = extract_content(&content, "<p>其他</p>").unwrap_err();
        assert_eq!(missing.code, "BOOK_SOURCE_CONTENT_MISSING");
    }

    #[test]
    fn decodes_declared_charset_and_rejects_unknown_labels() {
        let (encoded, _, _) = encoding_rs::GBK.encode("中文书源");
        assert_eq!(decode_body(&encoded, Some("gbk")).unwrap(), "中文书源");
        assert_ne!(decode_body(&encoded, None).unwrap(), "中文书源");

        let mut value = sample_rule_value();
        value["charset"] = json!("gb18030");
        assert!(check_rule_value(&value, false).ok);
    }

    #[test]
    fn builds_search_target_with_encoded_key_and_page_placeholder() {
        let rule = sample_rule();
        let target = search_target(&rule, false, "sherlock holmes").unwrap();
        assert_eq!(
            target.as_str(),
            "https://books.example/search?q=sherlock+holmes&page=1"
        );
        let http = BookSourceRule {
            base_url: "http://books.example".to_string(),
            ..rule
        };
        assert_eq!(
            search_target(&http, false, "a").unwrap_err().code,
            "REMOTE_HTTP_NOT_ALLOWED"
        );
        assert!(search_target(&http, true, "a").is_ok());
    }

    #[test]
    fn rate_limit_and_retry_helpers_follow_policy() {
        let now = Instant::now();
        let interval = Duration::from_millis(500);
        assert_eq!(wait_duration(None, now, interval), Duration::ZERO);
        assert_eq!(wait_duration(Some(now), now, interval), interval);
        assert_eq!(
            wait_duration(Some(now - interval), now, interval),
            Duration::ZERO
        );
        let half = now - Duration::from_millis(250);
        assert_eq!(
            wait_duration(Some(half), now, interval),
            Duration::from_millis(250)
        );
        assert!(transient_status(reqwest::StatusCode::SERVICE_UNAVAILABLE));
        assert!(transient_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(!transient_status(reqwest::StatusCode::NOT_FOUND));
        assert!(retry_backoff(0) < retry_backoff(1));
    }

    #[test]
    fn persists_toggles_and_removes_sources() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        assert!(list_sources_at(&connection).unwrap().is_empty());

        let source = validated_source(None, None, " 示例源 ", false, &sample_rule_value()).unwrap();
        write_source_at(&connection, &source).unwrap();
        let loaded = source_at(&connection, &source.id).unwrap().unwrap();
        assert_eq!(loaded.title, "示例源");
        assert!(loaded.enabled);
        assert_eq!(loaded.rule, sample_rule());

        let disabled = set_enabled_at(&connection, &source.id, false).unwrap();
        assert!(!disabled.enabled);
        assert!(!source_at(&connection, &source.id).unwrap().unwrap().enabled);

        let edited = validated_source(
            Some(&disabled),
            Some(disabled.id.clone()),
            "改名源",
            true,
            &sample_rule_value(),
        )
        .unwrap();
        assert_eq!(edited.id, disabled.id);
        assert_eq!(edited.created_at, loaded.created_at);
        assert!(edited.allow_http);
        assert!(!edited.enabled, "编辑保留启停状态");
        write_source_at(&connection, &edited).unwrap();
        assert_eq!(list_sources_at(&connection).unwrap().len(), 1);

        remove_at(&connection, &source.id).unwrap();
        assert!(source_at(&connection, &source.id).unwrap().is_none());
        assert_eq!(
            remove_at(&connection, &source.id).unwrap_err(),
            "书源不存在"
        );
    }

    #[test]
    fn import_export_round_trips_and_rejects_invalid_batches() {
        let rule = sample_rule_value();
        let source = validated_source(None, None, "导出源", false, &rule).unwrap();
        let exported = export_payload(std::slice::from_ref(&source)).unwrap();
        assert!(exported.contains("lightink.book-sources"));

        let entries = parse_import(&exported).unwrap();
        let imported = validated_import_entries(entries).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].title, "导出源");
        assert_eq!(imported[0].rule, source.rule);

        let array = serde_json::to_string(&vec![json!({
            "title": "数组源",
            "allowHttp": false,
            "rule": rule,
        })])
        .unwrap();
        assert_eq!(parse_import(&array).unwrap().len(), 1);
        assert!(parse_import("not json").is_err());

        let mut bad = sample_rule_value();
        bad["search"]["item"] = json!("(");
        let invalid = serde_json::to_string(&vec![
            json!({ "title": "好源", "rule": sample_rule_value() }),
            json!({ "title": "坏源", "rule": bad }),
        ])
        .unwrap();
        let entries = parse_import(&invalid).unwrap();
        let error = validated_import_entries(entries).unwrap_err();
        assert_eq!(error.code, "BOOK_SOURCE_RULE_INVALID");
        assert!(error.message.contains("search.item"));
        assert!(validated_import_entries(Vec::new()).is_err());
    }

    #[test]
    fn rejects_long_titles_and_oversized_rules() {
        let error = validated_source(None, None, "", false, &sample_rule_value()).unwrap_err();
        assert_eq!(error.code, "BOOK_SOURCE_INVALID");
        let long = "长".repeat(MAX_TITLE_CHARS + 1);
        assert!(validated_source(None, None, &long, false, &sample_rule_value()).is_err());

        let mut nested = sample_rule_value();
        nested["search"]["nextPage"] = json!("x".repeat(MAX_RULE_BYTES));
        let source = validated_source(None, None, "超大规则", false, &nested);
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        // 规则体积在写入时兜底；超长正则要么自检先拒绝，要么写库前拒绝。
        match source {
            Ok(source) => assert!(write_source_at(&connection, &source).is_err()),
            Err(error) => assert_eq!(error.code, "BOOK_SOURCE_RULE_INVALID"),
        }
    }
}
