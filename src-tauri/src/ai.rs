//! AI 提供商网络层(ADR-2/ADR-3,R2)。
//!
//! - 配置:`app_data_dir/ai-provider.json` 原子读写(SyncProfile 模式);
//!   API Key 仅存 `credential_store`(`lightink.ai` / `provider`),配置文件、
//!   响应体、错误消息与日志均不出现密钥明文(测试断言把关;本模块不写日志)。
//! - URL:默认仅 HTTPS,`allow_http` 显式勾选后放行 HTTP;拒绝 userinfo/
//!   query/fragment;任意主机(R2 自定义地址)。与 reader_aid 的 Wiktionary 主机
//!   白名单不同,安全边界由「密钥仅 Rust 侧持有 + 超时/大小上限」承担。
//! - 端点:OpenAI Responses / OpenAI Chat Completions / Claude Messages
//!   三种格式各自构造请求并解析文本。
//! - 网络:连接 15s;非流式总超时 60s、响应上限 256KB;流式无总超时、逐块
//!   读取超时 60s、累计 2MB 上限,经 Tauri IPC `Channel` 增量推送 delta,
//!   终态(完成或错误码)由命令返回值承载。服务器忽略 stream:true 返回整体
//!   JSON 时退化为单次解析(ADR-3 降级路径,功能不丢)。

use crate::credential_store::{delete_credential, get_credential, set_credential};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use url::Url;

const CONFIG_FILE: &str = "ai-provider.json";
const KEYRING_SERVICE: &str = "lightink.ai";
const KEYRING_REFERENCE: &str = "provider";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 512 * 1024;
/// 助手请求上限(可携带最多 12 章工具结果,独立于翻译/测试请求)。
const MAX_CHAT_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 4 * 1024;
const MAX_TRANSLATE_CHARS: usize = 5000;
const MAX_MESSAGES: usize = 200;
const MAX_MODEL_CHARS: usize = 200;
const TEST_MAX_TOKENS: u32 = 16;
const TRANSLATE_MAX_TOKENS: u32 = 8192;
const CHAT_MAX_TOKENS: u32 = 4096;

// ── 错误模型(与 ReaderAidError 同型:{code,message,status}) ──────────

/// AI 命令统一错误。密钥永远不会出现在 `message` 中(见 `redact_secret`)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl AiError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }
}

// ── 端点格式 ─────────────────────────────────────────────────────────

/// 端点格式三选一(R2):serde kebab-case 恰好得到
/// `openai-responses` / `openai-chat` / `claude-messages`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiEndpointKind {
    OpenaiResponses,
    OpenaiChat,
    ClaudeMessages,
}

impl AiEndpointKind {
    /// Manage 页端点格式切换时联动预填的官方 base URL(ADR-2),可改。
    fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenaiResponses | Self::OpenaiChat => "https://api.openai.com/v1",
            Self::ClaudeMessages => "https://api.anthropic.com/v1",
        }
    }

    fn endpoint_path(self) -> &'static str {
        match self {
            Self::OpenaiResponses => "/responses",
            Self::OpenaiChat => "/chat/completions",
            Self::ClaudeMessages => "/messages",
        }
    }

    /// OpenAI 两式只用 `Authorization: Bearer`;Claude Messages 同时发
    /// `x-api-key` 与 Bearer(官方 Anthropic 认前者,兼容网关常认后者)。
    fn uses_bearer(self) -> bool {
        matches!(self, Self::OpenaiResponses | Self::OpenaiChat)
    }
}

// ── 配置模型与持久化 ─────────────────────────────────────────────────

/// `ai-provider.json` 内容。`has_key` 只是钥匙串有无的快照(与 SyncProfile
/// 的 `needs_credential` 同语义),文件不存任何密钥材料(ADR-2)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub endpoint_kind: AiEndpointKind,
    pub base_url: String,
    pub model: String,
    pub allow_http: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_lang: Option<String>,
    pub has_key: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigInput {
    pub endpoint_kind: AiEndpointKind,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub allow_http: Option<bool>,
    #[serde(default)]
    pub target_lang: Option<String>,
}

/// `ai_get_config` / `ai_save_config` 的返回:现值 + 完备判定 + 各格式默认
/// base URL(UI 联动预填用),不含任何密钥材料。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigStatus {
    pub endpoint_kind: AiEndpointKind,
    pub base_url: String,
    pub model: String,
    pub allow_http: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    pub has_key: bool,
    pub configured: bool,
    pub missing: Vec<String>,
    pub defaults: Vec<AiEndpointDefault>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointDefault {
    pub endpoint_kind: AiEndpointKind,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigured {
    pub configured: bool,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub reply: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTranslationResult {
    pub text: String,
    pub target_lang: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

/// `ai_chat_stream` 的终态:`finish` 为 stop/done/incomplete/closed/tool_calls
/// 之一;`tool_calls` 非空表示模型要求应用执行工具后继续。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDone {
    pub finish: String,
    pub total_chars: usize,
    #[serde(default)]
    pub tool_calls: Vec<AiToolCall>,
}

/// 经 IPC Channel 增量推送的事件:`{"type":"delta","text":"..."}`。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Delta { text: String },
}

// ── 助手对话请求模型(R4/R5/R6):分层上下文 + 内置工具 ─────────────────

/// 内置工具定义(前端固定清单,顺序稳定;是可缓存前缀的第①层)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// 模型发起的一次工具调用(三端点格式归一:id + 名称 + JSON 参数)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// 应用执行工具后的回传(失败/拒绝/超时也必须回传,is_error 标记)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiToolResult {
    pub call_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// 对话一轮:user(可携带工具结果)或 assistant(可携带工具调用)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatTurn {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<AiToolCall>,
    #[serde(default)]
    pub tool_results: Vec<AiToolResult>,
}

/// `ai_chat_stream` 的请求:①tools ②system ③context(当前章)固定顺序在前,
/// ④⑤对话轮次在后。同一章追问 ①②③ 字节级不变(提供商前缀缓存生效)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    /// 前端生成的请求标识(`ai_chat_abort` 用);空串表示不可中断。
    #[serde(default)]
    pub request_id: String,
    pub system: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub tools: Vec<AiToolDef>,
    pub turns: Vec<AiChatTurn>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, AiError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CONFIG_FILE))
        .map_err(|error| AiError::new("AI_STORAGE_ERROR", format!("无法定位应用数据目录: {error}")))
}

fn load_config_at(path: &Path) -> Result<Option<AiProviderConfig>, AiError> {
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| AiError::new("AI_CONFIG_INVALID", format!("AI 配置损坏: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AiError::new(
            "AI_STORAGE_ERROR",
            format!("无法读取 AI 配置: {error}"),
        )),
    }
}

/// 原子写:同目录临时文件 + fsync + rename(SyncProfile 模式)。
fn persist_config_at(path: &Path, config: &AiProviderConfig) -> Result<(), AiError> {
    let Some(directory) = path.parent() else {
        return Err(AiError::new("AI_STORAGE_ERROR", "AI 配置路径无效"));
    };
    fs::create_dir_all(directory).map_err(|error| {
        AiError::new("AI_STORAGE_ERROR", format!("无法创建应用数据目录: {error}"))
    })?;
    let body = serde_json::to_vec_pretty(config).map_err(|error| {
        AiError::new("AI_STORAGE_ERROR", format!("无法序列化 AI 配置: {error}"))
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|error| {
        AiError::new("AI_STORAGE_ERROR", format!("无法创建配置临时文件: {error}"))
    })?;
    temporary
        .write_all(&body)
        .map_err(|error| AiError::new("AI_STORAGE_ERROR", format!("无法写入 AI 配置: {error}")))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| AiError::new("AI_STORAGE_ERROR", format!("无法同步 AI 配置: {error}")))?;
    temporary.persist(path).map_err(|error| {
        AiError::new(
            "AI_STORAGE_ERROR",
            format!("无法提交 AI 配置: {}", error.error),
        )
    })?;
    Ok(())
}

// ── 密钥边界 ─────────────────────────────────────────────────────────

fn load_ai_key() -> Option<String> {
    get_credential(KEYRING_SERVICE, KEYRING_REFERENCE)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_ai_key(raw: &str) -> Result<String, AiError> {
    if raw.chars().any(char::is_control) {
        return Err(AiError::new("AI_KEY_INVALID", "API Key 包含控制字符"));
    }
    let key = raw.trim();
    if key.is_empty() {
        return Err(AiError::new("AI_KEY_INVALID", "API Key 不能为空"));
    }
    Ok(key.to_string())
}

fn contains_forbidden_control(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
}

/// 任何来自服务商的错误文本进入 `AiError.message` 前先剥掉密钥出现。
fn redact_secret(message: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.chars().count() < 8 {
        return message.to_string();
    }
    message.replace(secret, "***")
}

fn clip_detail(detail: &str) -> String {
    if detail.chars().count() <= 300 {
        detail.to_string()
    } else {
        detail.chars().take(300).collect()
    }
}

// ── 完备判定(四要素) ───────────────────────────────────────────────

/// 四要素 = endpoint_kind + base_url + model(文件)+ API Key(钥匙串)。
/// 缺口用字段名回报,前端据此提示(R2 失败边界)。
fn config_gaps(config: Option<&AiProviderConfig>, has_key: bool) -> Vec<String> {
    let mut missing = Vec::new();
    match config {
        None => {
            missing.push("endpoint_kind".to_string());
            missing.push("base_url".to_string());
            missing.push("model".to_string());
        }
        Some(config) => {
            if config.base_url.trim().is_empty() {
                missing.push("base_url".to_string());
            }
            if config.model.trim().is_empty() {
                missing.push("model".to_string());
            }
        }
    }
    if !has_key {
        missing.push("api_key".to_string());
    }
    missing
}

fn not_configured_error(gaps: &[String]) -> AiError {
    AiError::new(
        "AI_NOT_CONFIGURED",
        format!("AI 尚未完成配置,缺少: {}", gaps.join("、")),
    )
}

// ── URL 验证(HTTPS 默认 / HTTP 显式允许 / 无主机白名单) ─────────────

fn validate_ai_url(raw: &str, allow_http: bool) -> Result<Url, AiError> {
    if raw.chars().any(char::is_control) || raw.trim().is_empty() {
        return Err(AiError::new("AI_URL_INVALID", "AI 地址为空或包含控制字符"));
    }
    let url =
        Url::parse(raw.trim()).map_err(|_| AiError::new("AI_URL_INVALID", "AI 地址格式无效"))?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::new(
            "AI_URL_INVALID",
            "AI 地址缺少主机名或包含用户名、密码",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AiError::new(
            "AI_URL_INVALID",
            "AI 地址不能包含查询参数或片段",
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => {
            return Err(AiError::new(
                "AI_HTTP_NOT_ALLOWED",
                "HTTP 地址必须显式勾选允许",
            ))
        }
        _ => return Err(AiError::new("AI_URL_INVALID", "仅支持 HTTP(S) 地址")),
    }
    Ok(url)
}

fn join_endpoint(base: &Url, kind: AiEndpointKind) -> Result<Url, AiError> {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/');
    let path = if kind == AiEndpointKind::ClaudeMessages {
        claude_messages_path(prefix)
    } else if prefix.ends_with(kind.endpoint_path()) {
        // base 已经是完整端点(用户把 /v1/chat/completions 整个贴进来):不再重复
        // 拼接,否则 404 会被归因成「模型不存在」而误导去改模型名。
        prefix.to_string()
    } else {
        format!("{prefix}{}", kind.endpoint_path())
    };
    url.set_path(&path);
    Ok(url)
}

/// Claude Messages 最终路径必须是 `…/v1/messages`。
///
/// 官方默认 base 是 `https://api.anthropic.com/v1`,直接拼 `/messages` 即可;
/// 兼容网关的 base 常是 `https://host/anthropic`(没有 `/v1`),若只拼
/// `/messages` 会 404。已含 `/v1` 或 `/messages` 的 base 不再重复拼接。
fn claude_messages_path(prefix: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    if prefix.ends_with("/messages") {
        prefix.to_string()
    } else if prefix.ends_with("/v1") {
        format!("{prefix}/messages")
    } else {
        format!("{prefix}/v1/messages")
    }
}

fn redirect_target_allowed(first: &Url, target: &Url, allow_http: bool) -> bool {
    let same_origin = first.scheme() == target.scheme()
        && first.host_str() == target.host_str()
        && first.port_or_known_default() == target.port_or_known_default();
    same_origin
        && target.username().is_empty()
        && target.password().is_none()
        && validate_ai_url(target.as_ref(), allow_http).is_ok()
}

// ── Provider 解析与请求构造 ──────────────────────────────────────────

#[derive(Debug)]
pub(crate) struct AiProvider {
    pub(crate) kind: AiEndpointKind,
    pub(crate) url: Url,
    pub(crate) model: String,
    pub(crate) key: String,
    pub(crate) allow_http: bool,
}

/// 读配置 + 钥匙串,四要素齐备才产出可请求的 provider,否则返回指明缺口的
/// `AI_NOT_CONFIGURED`。
pub(crate) fn resolve_provider(app: &AppHandle) -> Result<(AiProviderConfig, AiProvider), AiError> {
    let key = load_ai_key();
    let Some(config) = load_config_at(&config_path(app)?)? else {
        return Err(not_configured_error(&config_gaps(None, key.is_some())));
    };
    let provider = complete_provider(&config, key)?;
    Ok((config, provider))
}

fn complete_provider(
    config: &AiProviderConfig,
    key: Option<String>,
) -> Result<AiProvider, AiError> {
    let gaps = config_gaps(Some(config), key.is_some());
    if !gaps.is_empty() {
        return Err(not_configured_error(&gaps));
    }
    let base = validate_ai_url(&config.base_url, config.allow_http)?;
    let url = join_endpoint(&base, config.endpoint_kind)?;
    Ok(AiProvider {
        kind: config.endpoint_kind,
        url,
        model: config.model.trim().to_owned(),
        key: key.unwrap_or_default(),
        allow_http: config.allow_http,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiPurpose {
    Test,
    Translate,
    Chat,
}

/// Claude Messages 的 `max_tokens` 必填;OpenAI 两式仅测试连接时收紧
/// (翻译/对话省略,由服务端取模型上限,避免请求值超过模型上限被 400)。
fn max_tokens_for(kind: AiEndpointKind, purpose: AiPurpose) -> Option<u32> {
    match (kind, purpose) {
        (_, AiPurpose::Test) => Some(TEST_MAX_TOKENS),
        (AiEndpointKind::ClaudeMessages, AiPurpose::Translate) => Some(TRANSLATE_MAX_TOKENS),
        (AiEndpointKind::ClaudeMessages, AiPurpose::Chat) => Some(CHAT_MAX_TOKENS),
        _ => None,
    }
}

fn validate_chat_messages(kind: AiEndpointKind, messages: &[AiChatMessage]) -> Result<(), AiError> {
    if messages.is_empty() {
        return Err(AiError::new("AI_MESSAGE_INVALID", "对话消息不能为空"));
    }
    if messages.len() > MAX_MESSAGES {
        return Err(AiError::new(
            "AI_MESSAGE_INVALID",
            format!("对话消息超过 {MAX_MESSAGES} 条上限"),
        ));
    }
    let mut has_turn = false;
    for message in messages {
        match message.role.as_str() {
            "system" => {}
            "user" | "assistant" => has_turn = true,
            other => {
                return Err(AiError::new(
                    "AI_MESSAGE_INVALID",
                    format!("不支持的消息角色: {other}"),
                ))
            }
        }
        if message.content.trim().is_empty() {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容不能为空"));
        }
        if contains_forbidden_control(&message.content) {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容包含控制字符"));
        }
    }
    if kind == AiEndpointKind::ClaudeMessages && !has_turn {
        return Err(AiError::new("AI_MESSAGE_INVALID", "对话缺少用户或助手消息"));
    }
    Ok(())
}

fn message_value(message: &AiChatMessage) -> Value {
    json!({ "role": message.role, "content": message.content })
}

/// 三种端点格式各构造请求体;密钥只进请求头,永远不进请求体。
pub(crate) fn build_chat_body(
    kind: AiEndpointKind,
    model: &str,
    messages: &[AiChatMessage],
    max_tokens: Option<u32>,
    stream: bool,
) -> Result<Value, AiError> {
    validate_chat_messages(kind, messages)?;
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), json!(model));
    match kind {
        AiEndpointKind::OpenaiResponses => {
            body.insert(
                "input".to_string(),
                Value::Array(messages.iter().map(message_value).collect()),
            );
            if let Some(max) = max_tokens {
                body.insert("max_output_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::OpenaiChat => {
            body.insert(
                "messages".to_string(),
                Value::Array(messages.iter().map(message_value).collect()),
            );
            if let Some(max) = max_tokens {
                body.insert("max_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::ClaudeMessages => {
            // Claude Messages 不接受 messages 内的 system 角色,提升为顶层。
            let system: Vec<&str> = messages
                .iter()
                .filter(|message| message.role == "system")
                .map(|message| message.content.as_str())
                .collect();
            if !system.is_empty() {
                body.insert("system".to_string(), json!(system.join("\n\n")));
            }
            body.insert(
                "messages".to_string(),
                Value::Array(
                    messages
                        .iter()
                        .filter(|message| message.role != "system")
                        .map(message_value)
                        .collect(),
                ),
            );
            body.insert(
                "max_tokens".to_string(),
                json!(max_tokens.unwrap_or(CHAT_MAX_TOKENS)),
            );
        }
    }
    if stream {
        body.insert("stream".to_string(), json!(true));
    }
    Ok(Value::Object(body))
}

fn serialize_body(body: &Value) -> Result<Vec<u8>, AiError> {
    let payload = serde_json::to_vec(body)
        .map_err(|_| AiError::new("AI_REQUEST_INVALID", "无法构造 AI 请求"))?;
    if payload.len() > MAX_REQUEST_BYTES {
        return Err(AiError::new(
            "AI_REQUEST_TOO_LARGE",
            format!("请求超过 {} 字节上限", MAX_REQUEST_BYTES),
        ));
    }
    Ok(payload)
}

// ── 助手请求构造(分层前缀 + 工具 + 缓存标记) ─────────────────────────

fn validate_chat_turns(turns: &[AiChatTurn]) -> Result<(), AiError> {
    if turns.is_empty() {
        return Err(AiError::new("AI_MESSAGE_INVALID", "对话消息不能为空"));
    }
    if turns.len() > MAX_MESSAGES {
        return Err(AiError::new(
            "AI_MESSAGE_INVALID",
            format!("对话消息超过 {MAX_MESSAGES} 条上限"),
        ));
    }
    for turn in turns {
        match turn.role.as_str() {
            "user" | "assistant" => {}
            other => {
                return Err(AiError::new(
                    "AI_MESSAGE_INVALID",
                    format!("不支持的消息角色: {other}"),
                ))
            }
        }
        let has_tool_payload = !turn.tool_calls.is_empty() || !turn.tool_results.is_empty();
        if turn.content.trim().is_empty() && !has_tool_payload {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容不能为空"));
        }
        if contains_forbidden_control(&turn.content) {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容包含控制字符"));
        }
        for call in &turn.tool_calls {
            if call.id.trim().is_empty() || call.name.trim().is_empty() {
                return Err(AiError::new("AI_MESSAGE_INVALID", "工具调用缺少 id 或名称"));
            }
        }
        for result in &turn.tool_results {
            if result.call_id.trim().is_empty() {
                return Err(AiError::new("AI_MESSAGE_INVALID", "工具结果缺少调用 id"));
            }
            if contains_forbidden_control(&result.content) {
                return Err(AiError::new("AI_MESSAGE_INVALID", "工具结果包含控制字符"));
            }
        }
    }
    Ok(())
}

fn validate_chat_request(request: &AiChatRequest) -> Result<(), AiError> {
    if request.system.trim().is_empty() {
        return Err(AiError::new("AI_MESSAGE_INVALID", "系统提示不能为空"));
    }
    if contains_forbidden_control(&request.system)
        || request
            .context
            .as_deref()
            .is_some_and(contains_forbidden_control)
    {
        return Err(AiError::new("AI_MESSAGE_INVALID", "系统提示包含控制字符"));
    }
    for tool in &request.tools {
        if tool.name.trim().is_empty() || !tool.input_schema.is_object() {
            return Err(AiError::new("AI_MESSAGE_INVALID", "工具定义无效"));
        }
    }
    validate_chat_turns(&request.turns)
}

fn arguments_string(arguments: &Value) -> String {
    match arguments {
        Value::Null => "{}".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// OpenAI 两式把系统提示与当前章合并为一条 system 消息:提示在前、章在后,
/// 换章只改变后半段,工具 + 系统提示前缀依旧可缓存。
fn joined_system(request: &AiChatRequest) -> String {
    match request.context.as_deref().map(str::trim) {
        Some(context) if !context.is_empty() => format!("{}\n\n{}", request.system, context),
        _ => request.system.clone(),
    }
}

fn openai_chat_tools(tools: &[AiToolDef]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }
                })
            })
            .collect(),
    )
}

fn openai_responses_tools(tools: &[AiToolDef]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            })
            .collect(),
    )
}

fn claude_tools(tools: &[AiToolDef]) -> Value {
    let last = tools.len().saturating_sub(1);
    Value::Array(
        tools
            .iter()
            .enumerate()
            .map(|(index, tool)| {
                let mut value = json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                });
                if index == last {
                    value["cache_control"] = json!({ "type": "ephemeral" });
                }
                value
            })
            .collect(),
    )
}

fn openai_chat_turns(turns: &[AiChatTurn]) -> Vec<Value> {
    let mut out = Vec::new();
    for turn in turns {
        if turn.role == "assistant" {
            let mut message = json!({ "role": "assistant" });
            if turn.content.trim().is_empty() {
                message["content"] = Value::Null;
            } else {
                message["content"] = json!(turn.content);
            }
            if !turn.tool_calls.is_empty() {
                message["tool_calls"] = Value::Array(
                    turn.tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": arguments_string(&call.arguments),
                                }
                            })
                        })
                        .collect(),
                );
            }
            out.push(message);
            continue;
        }
        for result in &turn.tool_results {
            out.push(json!({
                "role": "tool",
                "tool_call_id": result.call_id,
                "content": result.content,
            }));
        }
        if !turn.content.trim().is_empty() {
            out.push(json!({ "role": "user", "content": turn.content }));
        }
    }
    out
}

fn openai_responses_turns(turns: &[AiChatTurn]) -> Vec<Value> {
    let mut out = Vec::new();
    for turn in turns {
        if turn.role == "assistant" {
            if !turn.content.trim().is_empty() {
                out.push(json!({ "role": "assistant", "content": turn.content }));
            }
            for call in &turn.tool_calls {
                out.push(json!({
                    "type": "function_call",
                    "call_id": call.id,
                    "name": call.name,
                    "arguments": arguments_string(&call.arguments),
                }));
            }
            continue;
        }
        for result in &turn.tool_results {
            out.push(json!({
                "type": "function_call_output",
                "call_id": result.call_id,
                "output": result.content,
            }));
        }
        if !turn.content.trim().is_empty() {
            out.push(json!({ "role": "user", "content": turn.content }));
        }
    }
    out
}

/// Claude Messages:内容块数组;tool_result 必须排在同一 user 消息的文本之前。
fn claude_turns(turns: &[AiChatTurn]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for turn in turns {
        let mut blocks: Vec<Value> = Vec::new();
        if turn.role == "assistant" {
            if !turn.content.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": turn.content }));
            }
            for call in &turn.tool_calls {
                let input = if call.arguments.is_object() {
                    call.arguments.clone()
                } else {
                    json!({})
                };
                blocks.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": input,
                }));
            }
        } else {
            for result in &turn.tool_results {
                let mut block = json!({
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": result.content,
                });
                if result.is_error {
                    block["is_error"] = json!(true);
                }
                blocks.push(block);
            }
            if !turn.content.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": turn.content }));
            }
        }
        if blocks.is_empty() {
            continue;
        }
        // 同角色连续消息合并为一条(工具结果轮紧接新提问):Claude 要求 user/
        // assistant 交替,块顺序保持 tool_result 在前、文本在后。
        if let Some(previous) = out.last_mut() {
            if previous.get("role").and_then(Value::as_str) == Some(turn.role.as_str()) {
                if let Some(Value::Array(existing)) = previous.get_mut("content") {
                    existing.extend(blocks);
                    continue;
                }
            }
        }
        out.push(json!({ "role": turn.role, "content": Value::Array(blocks) }));
    }
    // 增长的对话:最后一条消息的最后一个块打断点,提供商自动命中更早前缀。
    if let Some(last) = out.last_mut() {
        if let Some(Value::Array(blocks)) = last.get_mut("content") {
            if let Some(block) = blocks.last_mut() {
                block["cache_control"] = json!({ "type": "ephemeral" });
            }
        }
    }
    out
}

/// 助手请求体(三端点格式):①工具 ②系统提示 ③当前章 固定顺序在前,对话在后。
/// Claude 在 ①②③ 与最后一条消息上设显式 `cache_control` 断点;OpenAI 两式
/// 只保证前缀字节稳定(自动前缀缓存)。密钥永不进入请求体。
pub(crate) fn build_chat_request_body(
    kind: AiEndpointKind,
    model: &str,
    request: &AiChatRequest,
    max_tokens: Option<u32>,
    stream: bool,
) -> Result<Value, AiError> {
    validate_chat_request(request)?;
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), json!(model));
    match kind {
        AiEndpointKind::OpenaiResponses => {
            let mut input = vec![json!({ "role": "system", "content": joined_system(request) })];
            input.extend(openai_responses_turns(&request.turns));
            body.insert("input".to_string(), Value::Array(input));
            if !request.tools.is_empty() {
                body.insert("tools".to_string(), openai_responses_tools(&request.tools));
            }
            if let Some(max) = max_tokens {
                body.insert("max_output_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::OpenaiChat => {
            let mut messages = vec![json!({ "role": "system", "content": joined_system(request) })];
            messages.extend(openai_chat_turns(&request.turns));
            body.insert("messages".to_string(), Value::Array(messages));
            if !request.tools.is_empty() {
                body.insert("tools".to_string(), openai_chat_tools(&request.tools));
            }
            if let Some(max) = max_tokens {
                body.insert("max_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::ClaudeMessages => {
            let mut system = vec![json!({
                "type": "text",
                "text": request.system,
                "cache_control": { "type": "ephemeral" },
            })];
            if let Some(context) = request.context.as_deref().map(str::trim) {
                if !context.is_empty() {
                    system.push(json!({
                        "type": "text",
                        "text": context,
                        "cache_control": { "type": "ephemeral" },
                    }));
                }
            }
            body.insert("system".to_string(), Value::Array(system));
            if !request.tools.is_empty() {
                body.insert("tools".to_string(), claude_tools(&request.tools));
            }
            let messages = claude_turns(&request.turns);
            if messages.is_empty() {
                return Err(AiError::new("AI_MESSAGE_INVALID", "对话缺少用户或助手消息"));
            }
            body.insert("messages".to_string(), Value::Array(messages));
            body.insert(
                "max_tokens".to_string(),
                json!(max_tokens.unwrap_or(CHAT_MAX_TOKENS)),
            );
        }
    }
    if stream {
        body.insert("stream".to_string(), json!(true));
    }
    Ok(Value::Object(body))
}

/// 助手请求可携带多章工具结果,上限独立于翻译/测试请求。
fn serialize_chat_body(body: &Value) -> Result<Vec<u8>, AiError> {
    let payload = serde_json::to_vec(body)
        .map_err(|_| AiError::new("AI_REQUEST_INVALID", "无法构造 AI 请求"))?;
    if payload.len() > MAX_CHAT_REQUEST_BYTES {
        return Err(AiError::new(
            "AI_REQUEST_TOO_LARGE",
            format!("请求超过 {} 字节上限", MAX_CHAT_REQUEST_BYTES),
        ));
    }
    Ok(payload)
}

fn auth_headers(kind: AiEndpointKind, key: &str) -> Result<HeaderMap, AiError> {
    let mut headers = HeaderMap::new();
    let bearer = HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| AiError::new("AI_KEY_INVALID", "API Key 包含请求头不允许的字符"))?;
    if kind.uses_bearer() {
        headers.insert(AUTHORIZATION, bearer);
    } else {
        let value = HeaderValue::from_str(key)
            .map_err(|_| AiError::new("AI_KEY_INVALID", "API Key 包含请求头不允许的字符"))?;
        headers.insert(AUTHORIZATION, bearer);
        headers.insert(HeaderName::from_static("x-api-key"), value);
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
    }
    Ok(headers)
}

// ── HTTP 客户端与响应读取 ────────────────────────────────────────────

fn build_client(initial: &Url, allow_http: bool, streaming: bool) -> Result<Client, AiError> {
    let first = initial.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("redirect limit exceeded");
        }
        // 密钥在请求头上随每跳重放:只允许同源跳转(同 scheme/host/port)。
        if !redirect_target_allowed(&first, attempt.url(), allow_http) {
            return attempt.error("unsafe redirect refused");
        }
        attempt.follow()
    });
    let builder = Client::builder()
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .referer(false)
        .user_agent(concat!("LightInk/", env!("CARGO_PKG_VERSION")));
    // 流式无总超时(回答可能持续推送很久),只要求相邻 chunk 间隔有界,
    // 累计大小由调用方按 2MB 截断;非流式维持 60s 总超时。
    let builder = if streaming {
        builder.read_timeout(STREAM_READ_TIMEOUT)
    } else {
        builder.timeout(REQUEST_TIMEOUT)
    };
    builder
        .build()
        .map_err(|error| AiError::new("AI_CLIENT_ERROR", format!("无法创建网络客户端: {error}")))
}

pub(crate) async fn post_chat(provider: &AiProvider, body: &Value) -> Result<Response, AiError> {
    let client = build_client(&provider.url, provider.allow_http, false)?;
    let payload = serialize_body(body)?;
    let request = client
        .post(provider.url.clone())
        .header(CONTENT_TYPE, "application/json")
        .headers(auth_headers(provider.kind, &provider.key)?)
        .body(payload);
    request.send().await.map_err(network_error)
}

pub(crate) async fn read_success_json(response: Response, key: &str) -> Result<Value, AiError> {
    let status = response.status();
    if !status.is_success() {
        let detail = error_body_message(response).await;
        return Err(compose_http_error(key, status, detail));
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

/// 失败响应体里提取服务商错误消息(有界 4KB;不含密钥,但入口处仍统一 redact)。
async fn error_body_message(response: Response) -> Option<String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ERROR_BODY_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if bytes.len() + chunk.len() > MAX_ERROR_BODY_BYTES {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    for pointer in ["/error/message", "/message", "/error"] {
        if let Some(message) = value.pointer(pointer).and_then(Value::as_str) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 测试连接需要可区分失败:401/403 密钥、404/模型文案 模型、429 额度、
/// 其余 HTTP 通用;带状态码与服务商详情(剥密钥、截 300 字)。
fn compose_http_error(key: &str, status: StatusCode, detail: Option<String>) -> AiError {
    let code = refine_status_code(classify_status(status), detail.as_deref()).to_string();
    let summary = match code.as_str() {
        "AI_KEY_INVALID" => "AI 服务商拒绝了 API Key",
        "AI_MODEL_NOT_FOUND" => "模型不存在或不可用",
        "AI_QUOTA_EXCEEDED" => "请求过于频繁或额度不足",
        _ => "AI 服务商返回错误",
    };
    let message = match detail.map(|value| clip_detail(&redact_secret(&value, key))) {
        Some(detail) if !detail.is_empty() => {
            format!("{summary} (HTTP {}): {detail}", status.as_u16())
        }
        _ => format!("{summary} (HTTP {})", status.as_u16()),
    };
    AiError {
        code,
        message,
        status: Some(status.as_u16()),
    }
}

fn classify_status(status: StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "AI_KEY_INVALID",
        404 => "AI_MODEL_NOT_FOUND",
        429 => "AI_QUOTA_EXCEEDED",
        _ => "AI_HTTP_ERROR",
    }
}

/// 兼容 OpenAI 网关把「模型不存在」报成 400 的形态。
fn refine_status_code(code: &'static str, detail: Option<&str>) -> &'static str {
    if code != "AI_HTTP_ERROR" {
        return code;
    }
    let Some(detail) = detail else {
        return code;
    };
    let lower = detail.to_lowercase();
    if [
        "model_not_found",
        "model not found",
        "does not exist",
        "unknown model",
        "no such model",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "AI_MODEL_NOT_FOUND";
    }
    code
}

fn reject_content_length(length: Option<u64>) -> Result<(), AiError> {
    if length.is_some_and(|value| value > MAX_RESPONSE_BYTES as u64) {
        return Err(AiError::new(
            "AI_RESPONSE_TOO_LARGE",
            "AI 响应超过 256 KiB 上限",
        ));
    }
    Ok(())
}

fn append_bounded(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<(), AiError> {
    if buffer.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err(AiError::new(
            "AI_RESPONSE_TOO_LARGE",
            "AI 响应超过 256 KiB 上限",
        ));
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn parse_json_bytes(bytes: &[u8]) -> Result<Value, AiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AiError::new("AI_RESPONSE_INVALID", "AI 响应不是有效 UTF-8"))?;
    serde_json::from_str(text).map_err(|_| AiError::new("AI_RESPONSE_INVALID", "AI 响应不是 JSON"))
}

fn network_error(error: reqwest::Error) -> AiError {
    if error.is_timeout() {
        AiError::new("AI_TIMEOUT", "请求超时")
    } else {
        AiError::new("AI_NETWORK_ERROR", format!("无法连接 AI 服务: {error}"))
    }
}

// ── 三端点回复文本解析 ──────────────────────────────────────────────

/// 三端点回复文本(可为空;工具调用回合可能没有文本)。
fn reply_text_of(kind: AiEndpointKind, value: &Value) -> String {
    let text = match kind {
        AiEndpointKind::OpenaiResponses => {
            // 标准 Responses JSON 没有 SDK 的顶层 output_text 便利字段;
            // 兼容网关直接给 output_text 的形态。
            if let Some(text) = value.get("output_text").and_then(Value::as_str) {
                text.to_string()
            } else {
                let mut parts: Vec<&str> = Vec::new();
                if let Some(items) = value.get("output").and_then(Value::as_array) {
                    for item in items {
                        if let Some(contents) = item.get("content").and_then(Value::as_array) {
                            for content in contents {
                                match content.get("type").and_then(Value::as_str) {
                                    Some("output_text") => {
                                        if let Some(text) =
                                            content.get("text").and_then(Value::as_str)
                                        {
                                            parts.push(text);
                                        }
                                    }
                                    // 安全拒答:文本在 refusal 字段,同样是给用户看的回复。
                                    Some("refusal") => {
                                        if let Some(text) =
                                            content.get("refusal").and_then(Value::as_str)
                                        {
                                            parts.push(text);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                parts.join("")
            }
        }
        AiEndpointKind::OpenaiChat => match value.pointer("/choices/0/message/content") {
            Some(Value::String(text)) => text.clone(),
            // 拒答时 content 为 null,文本在 message.refusal。
            Some(Value::Null) | None => value
                .pointer("/choices/0/message/refusal")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            // 兼容多模态分段 content:[{type:"text",text}]。
            Some(Value::Array(items)) => items
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        },
        AiEndpointKind::ClaudeMessages => value
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
    };
    text.trim().to_string()
}

pub(crate) fn extract_reply_text(kind: AiEndpointKind, value: &Value) -> Result<String, AiError> {
    let text = reply_text_of(kind, value);
    if text.is_empty() {
        return Err(AiError::new("AI_RESPONSE_INVALID", "AI 未返回文本"));
    }
    Ok(text)
}

// ── SSE 流式解析(文本增量 + 工具调用累加) ───────────────────────────

/// 工具调用增量(三端点归一):`key` 是端点内的块标识(Claude/OpenAI chat 用
/// 块 index,Responses 用 item id),累加器按 key 合并 id/名称/参数片段。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ToolChunk {
    key: String,
    id: Option<String>,
    name: Option<String>,
    arguments_delta: Option<String>,
    /// 端点给出的完整参数串(Responses `output_item.done`):覆盖累加片段。
    arguments_full: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SseData {
    Skip,
    Delta(String),
    Tool(ToolChunk),
    /// 提前告知的结束原因(Claude `message_delta.stop_reason`),终态仍等 Done。
    StopReason(String),
    Done(String),
    Failed(Option<String>),
}

#[derive(Debug, Default)]
struct ToolCallDraft {
    id: String,
    name: String,
    arguments: String,
    full: Option<String>,
}

/// 跨 chunk 累加工具调用:按出现顺序输出,参数串在终态解析为 JSON 对象。
#[derive(Debug, Default)]
struct ToolCallAccumulator {
    order: Vec<String>,
    drafts: HashMap<String, ToolCallDraft>,
}

impl ToolCallAccumulator {
    fn apply(&mut self, chunk: ToolChunk) {
        if !self.drafts.contains_key(&chunk.key) {
            self.order.push(chunk.key.clone());
            self.drafts
                .insert(chunk.key.clone(), ToolCallDraft::default());
        }
        let draft = self
            .drafts
            .get_mut(&chunk.key)
            .expect("draft inserted above");
        if let Some(id) = chunk.id.filter(|value| !value.is_empty()) {
            draft.id = id;
        }
        if let Some(name) = chunk.name.filter(|value| !value.is_empty()) {
            draft.name = name;
        }
        if let Some(delta) = chunk.arguments_delta {
            draft.arguments.push_str(&delta);
        }
        if let Some(full) = chunk.arguments_full {
            draft.full = Some(full);
        }
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn finish(self) -> Result<Vec<AiToolCall>, AiError> {
        let mut calls = Vec::with_capacity(self.order.len());
        let mut drafts = self.drafts;
        for (index, key) in self.order.iter().enumerate() {
            let Some(draft) = drafts.remove(key) else {
                continue;
            };
            if draft.name.trim().is_empty() {
                return Err(AiError::new("AI_RESPONSE_INVALID", "工具调用缺少名称"));
            }
            let raw = draft.full.unwrap_or(draft.arguments);
            let arguments = parse_tool_arguments(&raw)?;
            let id = if draft.id.trim().is_empty() {
                format!("call_{index}")
            } else {
                draft.id
            };
            calls.push(AiToolCall {
                id,
                name: draft.name,
                arguments,
            });
        }
        Ok(calls)
    }
}

/// 工具参数串 → JSON 对象;空串视为无参数,非对象/非 JSON 视为响应无效。
fn parse_tool_arguments(raw: &str) -> Result<Value, AiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(AiError::new(
            "AI_RESPONSE_INVALID",
            "工具调用参数不是 JSON 对象",
        )),
    }
}

/// 按字节缓冲、只在换行到达后切行,保证跨 chunk 拆开的多字节字符在完整
/// 行内重新拼好;`raw` 保留全部原始字节供整体 JSON 降级解析。
#[derive(Default)]
struct SseLines {
    pending: Vec<u8>,
    raw: Vec<u8>,
}

impl SseLines {
    fn new() -> Self {
        Self::default()
    }

    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.raw.extend_from_slice(chunk);
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending[..index].to_vec();
            self.pending.drain(..=index);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&self.pending).into_owned())
        }
    }

    fn raw(&self) -> &[u8] {
        &self.raw
    }
}

fn classify_data_line(kind: AiEndpointKind, line: &str) -> Vec<SseData> {
    let Some(payload) = line.strip_prefix("data:") else {
        return vec![SseData::Skip];
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return vec![SseData::Skip];
    }
    if payload == "[DONE]" {
        return vec![SseData::Done("done".to_string())];
    }
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return vec![SseData::Skip];
    };
    classify_sse_event(kind, &value)
}

fn value_string(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn failure_detail(value: &Value, pointer: &str) -> SseData {
    SseData::Failed(
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned),
    )
}

fn classify_sse_event(kind: AiEndpointKind, value: &Value) -> Vec<SseData> {
    match kind {
        AiEndpointKind::OpenaiResponses => match value.get("type").and_then(Value::as_str) {
            // 安全拒答走 response.refusal.delta,文本同样是给用户看的:按普通增量推送,
            // 否则 completed 时零文本会被当成「服务器忽略了 stream」去整体解析而报错。
            Some("response.output_text.delta") | Some("response.refusal.delta") => value
                .get("delta")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|text| vec![SseData::Delta(text.to_string())])
                .unwrap_or_else(|| vec![SseData::Skip]),
            Some("response.output_item.added") | Some("response.output_item.done") => {
                if value.pointer("/item/type").and_then(Value::as_str) != Some("function_call") {
                    return vec![SseData::Skip];
                }
                let call_id = value_string(value, "/item/call_id");
                let key = value_string(value, "/item/id")
                    .or_else(|| call_id.clone())
                    .unwrap_or_default();
                let done =
                    value.get("type").and_then(Value::as_str) == Some("response.output_item.done");
                vec![SseData::Tool(ToolChunk {
                    key,
                    id: call_id,
                    name: value_string(value, "/item/name"),
                    arguments_delta: None,
                    arguments_full: if done {
                        value_string(value, "/item/arguments")
                    } else {
                        None
                    },
                })]
            }
            Some("response.function_call_arguments.delta") => vec![SseData::Tool(ToolChunk {
                key: value_string(value, "/item_id").unwrap_or_default(),
                id: None,
                name: None,
                arguments_delta: value_string(value, "/delta"),
                arguments_full: None,
            })],
            Some("response.function_call_arguments.done") => vec![SseData::Tool(ToolChunk {
                key: value_string(value, "/item_id").unwrap_or_default(),
                id: None,
                name: None,
                arguments_delta: None,
                arguments_full: value_string(value, "/arguments"),
            })],
            Some("response.completed") => vec![SseData::Done("stop".to_string())],
            Some("response.incomplete") => vec![SseData::Done("incomplete".to_string())],
            Some("response.failed") => vec![failure_detail(value, "/response/error/message")],
            Some("error") => vec![failure_detail(value, "/error/message")],
            _ => vec![SseData::Skip],
        },
        AiEndpointKind::OpenaiChat => {
            let mut events = Vec::new();
            // 拒答走 delta.refusal,与 delta.content 一样按文本推送。
            for pointer in ["/choices/0/delta/content", "/choices/0/delta/refusal"] {
                if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
                    if !text.is_empty() {
                        events.push(SseData::Delta(text.to_string()));
                    }
                }
            }
            if let Some(calls) = value
                .pointer("/choices/0/delta/tool_calls")
                .and_then(Value::as_array)
            {
                for (ordinal, call) in calls.iter().enumerate() {
                    // 标准 OpenAI 按 index 累加(后续片段只带 index 不带 id);网关省略
                    // index 时每块都是完整调用,按 id 区分,再没有才退回数组序号——否则
                    // 多个调用会全部落到 "0",参数串拼在一起解析失败。
                    let key = match call.get("index").and_then(Value::as_u64) {
                        Some(index) => format!("i{index}"),
                        None => value_string(call, "/id")
                            .filter(|id| !id.is_empty())
                            .map(|id| format!("id:{id}"))
                            .unwrap_or_else(|| format!("o{ordinal}")),
                    };
                    events.push(SseData::Tool(ToolChunk {
                        key,
                        id: value_string(call, "/id"),
                        name: value_string(call, "/function/name"),
                        arguments_delta: value_string(call, "/function/arguments"),
                        arguments_full: None,
                    }));
                }
            }
            // 同一事件既带 error 又带 finish_reason 时以失败为准:stream_step 遇到 Done
            // 即返回,Failed 必须排在前面。
            if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
                events.push(SseData::Failed(Some(message.trim().to_string())));
            }
            if let Some(finish) = value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
            {
                if !finish.is_empty() {
                    events.push(SseData::Done(finish.to_string()));
                }
            }
            if events.is_empty() {
                events.push(SseData::Skip);
            }
            events
        }
        AiEndpointKind::ClaudeMessages => match value.get("type").and_then(Value::as_str) {
            Some("content_block_start")
                if value.pointer("/content_block/type").and_then(Value::as_str)
                    == Some("tool_use") =>
            {
                vec![SseData::Tool(ToolChunk {
                    key: value
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .to_string(),
                    id: value_string(value, "/content_block/id"),
                    name: value_string(value, "/content_block/name"),
                    arguments_delta: None,
                    arguments_full: None,
                })]
            }
            Some("content_block_delta") => {
                match value.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => value
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(|text| vec![SseData::Delta(text.to_string())])
                        .unwrap_or_else(|| vec![SseData::Skip]),
                    Some("input_json_delta") => vec![SseData::Tool(ToolChunk {
                        key: value
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            .to_string(),
                        id: None,
                        name: None,
                        arguments_delta: value_string(value, "/delta/partial_json"),
                        arguments_full: None,
                    })],
                    _ => vec![SseData::Skip],
                }
            }
            Some("message_delta") => value
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
                .map(|reason| vec![SseData::StopReason(reason.to_string())])
                .unwrap_or_else(|| vec![SseData::Skip]),
            Some("message_stop") => vec![SseData::Done("stop".to_string())],
            Some("error") => vec![failure_detail(value, "/error/message")],
            _ => vec![SseData::Skip],
        },
    }
}

fn advance_stream_budget(received: usize, chunk: usize) -> Result<usize, AiError> {
    let total = received.saturating_add(chunk);
    if total > MAX_STREAM_BYTES {
        return Err(AiError::new(
            "AI_RESPONSE_TOO_LARGE",
            "流式输出超过 2 MiB 上限",
        ));
    }
    Ok(total)
}

fn stream_failure(key: &str, detail: Option<String>) -> AiError {
    let message = match detail.map(|value| clip_detail(&redact_secret(&value, key))) {
        Some(detail) if !detail.is_empty() => format!("AI 流式输出失败: {detail}"),
        _ => "AI 流式输出失败".to_string(),
    };
    AiError::new("AI_STREAM_FAILED", message)
}

/// 一次流式会话的累积态:字数、工具调用草稿、提前告知的结束原因。
#[derive(Debug, Default)]
struct StreamState {
    total_chars: usize,
    tools: ToolCallAccumulator,
    stop_reason: Option<String>,
}

/// 处理一行 SSE:文本增量即时推送;工具片段累加;Done 返回结束原因。
fn stream_step(
    kind: AiEndpointKind,
    key: &str,
    line: &str,
    on_event: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<Option<String>, AiError> {
    for data in classify_data_line(kind, line) {
        match data {
            SseData::Skip => {}
            SseData::Delta(text) => {
                state.total_chars += text.chars().count();
                if on_event.send(AiStreamEvent::Delta { text }).is_err() {
                    return Err(AiError::new("AI_STREAM_ABORTED", "流式通道已关闭"));
                }
            }
            SseData::Tool(chunk) => state.tools.apply(chunk),
            SseData::StopReason(reason) => state.stop_reason = Some(reason),
            SseData::Done(finish) => {
                return Ok(Some(state.stop_reason.take().unwrap_or(finish)));
            }
            SseData::Failed(detail) => return Err(stream_failure(key, detail)),
        }
    }
    Ok(None)
}

/// 收口本轮工具调用。输出因长度上限被截断时参数 JSON 必然不完整:给出明确原因,
/// 而不是笼统的「响应无效」(用户可缩短备注 / 缩小请求后重试)。
fn finish_tool_calls(
    tools: ToolCallAccumulator,
    finish: Option<&str>,
) -> Result<Vec<AiToolCall>, AiError> {
    if tools.is_empty() {
        return Ok(Vec::new());
    }
    match tools.finish() {
        Ok(calls) => Ok(calls),
        Err(_)
            if matches!(
                finish,
                Some("length") | Some("max_tokens") | Some("incomplete")
            ) =>
        {
            Err(AiError::new(
                "AI_RESPONSE_TRUNCATED",
                "输出达到长度上限,工具调用参数不完整;请缩短内容后重试",
            ))
        }
        Err(error) => Err(error),
    }
}

/// 整体 JSON 里的工具调用(服务器忽略 stream:true 时的降级路径)。
fn extract_tool_calls(kind: AiEndpointKind, value: &Value) -> Result<Vec<AiToolCall>, AiError> {
    let mut calls = Vec::new();
    match kind {
        AiEndpointKind::ClaudeMessages => {
            for item in value
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let input = item.get("input").cloned().unwrap_or_else(|| json!({}));
                calls.push(AiToolCall {
                    id: value_string(item, "/id").unwrap_or_default(),
                    name: value_string(item, "/name").unwrap_or_default(),
                    arguments: if input.is_object() { input } else { json!({}) },
                });
            }
        }
        AiEndpointKind::OpenaiChat => {
            for item in value
                .pointer("/choices/0/message/tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                calls.push(AiToolCall {
                    id: value_string(item, "/id").unwrap_or_default(),
                    name: value_string(item, "/function/name").unwrap_or_default(),
                    arguments: parse_tool_arguments(
                        &value_string(item, "/function/arguments").unwrap_or_default(),
                    )?,
                });
            }
        }
        AiEndpointKind::OpenaiResponses => {
            for item in value
                .get("output")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    continue;
                }
                calls.push(AiToolCall {
                    id: value_string(item, "/call_id").unwrap_or_default(),
                    name: value_string(item, "/name").unwrap_or_default(),
                    arguments: parse_tool_arguments(
                        &value_string(item, "/arguments").unwrap_or_default(),
                    )?,
                });
            }
        }
    }
    for (index, call) in calls.iter_mut().enumerate() {
        if call.name.trim().is_empty() {
            return Err(AiError::new("AI_RESPONSE_INVALID", "工具调用缺少名称"));
        }
        if call.id.trim().is_empty() {
            call.id = format!("call_{index}");
        }
    }
    Ok(calls)
}

/// 服务器忽略 stream:true 返回整体 JSON 时的降级解析(ADR-3:功能不丢):
/// 文本与工具调用都取;两者皆空才算无效响应。
fn fallback_stream_reply(
    kind: AiEndpointKind,
    raw: &[u8],
) -> Result<(String, Vec<AiToolCall>), AiError> {
    let value = parse_json_bytes(raw)?;
    let tool_calls = extract_tool_calls(kind, &value)?;
    let text = reply_text_of(kind, &value);
    if text.is_empty() && tool_calls.is_empty() {
        return Err(AiError::new("AI_RESPONSE_INVALID", "AI 未返回文本"));
    }
    Ok((text, tool_calls))
}

/// 翻译/测试连接的降级路径沿用纯文本口径。
#[cfg(test)]
fn fallback_stream_text(kind: AiEndpointKind, raw: &[u8]) -> Result<String, AiError> {
    let (text, _) = fallback_stream_reply(kind, raw)?;
    if text.is_empty() {
        return Err(AiError::new("AI_RESPONSE_INVALID", "AI 未返回文本"));
    }
    Ok(text)
}

// ── 流式中止登记(R1 停止生成) ────────────────────────────────────────

/// 活跃流式请求 id 与已登记的中止 id。中止只对活跃请求登记:请求结束时两者
/// 一起清掉,完成/停止竞态下迟到的中止不会在集合里永久残留。
#[derive(Default)]
struct ChatAbortRegistry {
    /// 活跃请求 → 中止信号:中止时唤醒正在等网络的那个 future,不必等下一块到达。
    active: HashMap<String, Arc<Notify>>,
    aborts: HashSet<String>,
}

static CHAT_ABORTS: OnceLock<Mutex<ChatAbortRegistry>> = OnceLock::new();

fn lock_aborts() -> std::sync::MutexGuard<'static, ChatAbortRegistry> {
    CHAT_ABORTS
        .get_or_init(|| Mutex::new(ChatAbortRegistry::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 请求开始:登记为活跃并返回本次的中止信号;同 id 复用不继承旧登记(旧信号
/// 连同其未消费的唤醒一起丢弃)。空 id 拿到的信号永远不会被唤醒。
fn begin_abortable(request_id: &str) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    if request_id.is_empty() {
        return notify;
    }
    let mut registry = lock_aborts();
    registry.aborts.remove(request_id);
    registry
        .active
        .insert(request_id.to_string(), Arc::clone(&notify));
    notify
}

/// 消费一次中止请求(命中即移除);空 id 永不中止。
fn take_abort(request_id: &str) -> bool {
    if request_id.is_empty() {
        return false;
    }
    lock_aborts().aborts.remove(request_id)
}

/// 请求结束:活跃与中止登记一起清掉。
fn clear_abort(request_id: &str) {
    if !request_id.is_empty() {
        let mut registry = lock_aborts();
        registry.active.remove(request_id);
        registry.aborts.remove(request_id);
    }
}

/// 测试用:某 id 是否(活跃, 已登记中止)。按 id 查而不是数总量,测试并行时不互相干扰。
#[cfg(test)]
fn abort_registered(request_id: &str) -> (bool, bool) {
    let registry = lock_aborts();
    (
        registry.active.contains_key(request_id),
        registry.aborts.contains(request_id),
    )
}

/// 请求前端停止某次流式回答:立即唤醒正在等待网络的流式命令,使其以
/// `AI_STREAM_ABORTED` 结束(不等下一块到达),已推送的增量保留在前端。
/// 未知/已结束的 id 直接忽略(不登记,不报错)。
#[tauri::command]
pub fn ai_chat_abort(request_id: String) -> Result<(), AiError> {
    let id = request_id.trim();
    if id.is_empty() {
        return Err(AiError::new("AI_REQUEST_INVALID", "缺少请求标识"));
    }
    let mut registry = lock_aborts();
    if let Some(notify) = registry.active.get(id) {
        // 先唤醒再登记:notify_one 在无等待者时存一次许可,后到的 notified() 也会立即返回。
        notify.notify_one();
        registry.aborts.insert(id.to_string());
    }
    Ok(())
}

fn stream_aborted() -> AiError {
    AiError::new("AI_STREAM_ABORTED", "已停止生成")
}

/// 让一次网络等待(发送请求 / 读下一块)可被中止信号打断:信号先到或已到时
/// 直接以中止结束,等待中的请求/读取随 future 一起丢弃,不再占用提供商。
async fn abortable<T, F>(future: F, abort: &Notify) -> Result<T, AiError>
where
    F: std::future::Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = abort.notified() => Err(stream_aborted()),
        value = future => Ok(value),
    }
}

// ── 状态视图 ─────────────────────────────────────────────────────────

fn endpoint_defaults() -> Vec<AiEndpointDefault> {
    [
        AiEndpointKind::OpenaiResponses,
        AiEndpointKind::OpenaiChat,
        AiEndpointKind::ClaudeMessages,
    ]
    .iter()
    .map(|&kind| AiEndpointDefault {
        endpoint_kind: kind,
        base_url: kind.default_base_url().to_string(),
    })
    .collect()
}

fn status_from(config: Option<AiProviderConfig>, has_key: bool) -> AiConfigStatus {
    let missing = config_gaps(config.as_ref(), has_key);
    // 从未保存过时给出可预填的默认形态(端点默认取兼容面最广的 openai-chat)。
    let (endpoint_kind, base_url, model, allow_http, target_lang, updated_at) = match config {
        Some(config) => (
            config.endpoint_kind,
            config.base_url,
            config.model,
            config.allow_http,
            config.target_lang,
            Some(config.updated_at),
        ),
        None => (
            AiEndpointKind::OpenaiChat,
            AiEndpointKind::OpenaiChat.default_base_url().to_string(),
            String::new(),
            false,
            None,
            None,
        ),
    };
    AiConfigStatus {
        endpoint_kind,
        base_url,
        model,
        allow_http,
        target_lang,
        updated_at,
        has_key,
        configured: missing.is_empty(),
        missing,
        defaults: endpoint_defaults(),
    }
}

// ── 命令 ─────────────────────────────────────────────────────────────

/// 读取 AI 分组配置:现值 + 钥匙串有无 + 完备判定,永不包含密钥。
#[tauri::command]
pub fn ai_get_config(app: AppHandle) -> Result<AiConfigStatus, AiError> {
    let config = load_config_at(&config_path(&app)?)?;
    Ok(status_from(config, load_ai_key().is_some()))
}

/// 保存非密钥配置(唯一活动配置,切换即覆盖,R8)。HTTP 地址未勾选
/// `allow_http` 时校验拒绝;密钥另走 `ai_store_key`。
#[tauri::command]
pub fn ai_save_config(app: AppHandle, input: AiConfigInput) -> Result<AiConfigStatus, AiError> {
    let model = input.model.trim();
    if model.is_empty() {
        return Err(AiError::new("AI_CONFIG_INVALID", "模型名不能为空"));
    }
    if model.chars().any(char::is_control) || model.chars().count() > MAX_MODEL_CHARS {
        return Err(AiError::new("AI_CONFIG_INVALID", "模型名无效或过长"));
    }
    let allow_http = input.allow_http.unwrap_or(false);
    let url = validate_ai_url(&input.base_url, allow_http)?;
    let base_url = url.to_string().trim_end_matches('/').to_string();
    let target_lang = normalize_target_lang_override(input.target_lang)?;
    let has_key = load_ai_key().is_some();
    let config = AiProviderConfig {
        endpoint_kind: input.endpoint_kind,
        base_url,
        model: model.to_owned(),
        allow_http,
        target_lang,
        has_key,
        updated_at: now_ms(),
    };
    persist_config_at(&config_path(&app)?, &config)?;
    Ok(status_from(Some(config), has_key))
}

fn normalize_target_lang_override(raw: Option<String>) -> Result<Option<String>, AiError> {
    let Some(value) = raw else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if contains_forbidden_control(value) || value.chars().count() > 40 {
        return Err(AiError::new("AI_CONFIG_INVALID", "翻译目标语言覆盖项无效"));
    }
    Ok(Some(value.to_string()))
}

/// API Key 只写入钥匙串(移动端退化凭据文件同 Wiktionary 先例),文件仅更新
/// `has_key` 快照。返回的仍是全量状态,无密钥明文。
#[tauri::command]
pub fn ai_store_key(app: AppHandle, key: String) -> Result<AiConfigStatus, AiError> {
    let key = normalize_ai_key(&key)?;
    if !set_credential(KEYRING_SERVICE, KEYRING_REFERENCE, &key) {
        return Err(AiError::new("AI_KEY_STORE_FAILED", "无法保存 API Key"));
    }
    let path = config_path(&app)?;
    if let Some(mut config) = load_config_at(&path)? {
        config.has_key = true;
        config.updated_at = now_ms();
        persist_config_at(&path, &config)?;
    }
    Ok(status_from(load_config_at(&path)?, true))
}

/// 清除钥匙串中的 API Key,配置其余字段保留(四要素从此不完备)。
#[tauri::command]
pub fn ai_forget_key(app: AppHandle) -> Result<AiConfigStatus, AiError> {
    delete_credential(KEYRING_SERVICE, KEYRING_REFERENCE);
    let path = config_path(&app)?;
    if let Some(mut config) = load_config_at(&path)? {
        config.has_key = false;
        persist_config_at(&path, &config)?;
    }
    Ok(status_from(load_config_at(&path)?, false))
}

/// 四要素完备判定:下游功能(选区翻译/助手/整本翻译)的显隐与放行依据。
#[tauri::command]
pub fn ai_configured(app: AppHandle) -> Result<AiConfigured, AiError> {
    let config = load_config_at(&config_path(&app)?)?;
    let missing = config_gaps(config.as_ref(), load_ai_key().is_some());
    Ok(AiConfigured {
        configured: missing.is_empty(),
        missing,
    })
}

/// 测试连接:最小请求验证配置;正确配置返回成功,错误地址(网络)/密钥
/// (401/403)/模型(404 或模型文案)返回可区分失败码。
#[tauri::command]
pub async fn ai_test_connection(app: AppHandle) -> Result<AiTestResult, AiError> {
    let started = Instant::now();
    let (_config, provider) = resolve_provider(&app)?;
    let probe = [AiChatMessage {
        role: "user".to_string(),
        content: "ping".to_string(),
    }];
    let body = build_chat_body(
        provider.kind,
        &provider.model,
        &probe,
        max_tokens_for(provider.kind, AiPurpose::Test),
        false,
    )?;
    let response = post_chat(&provider, &body).await?;
    let value = read_success_json(response, &provider.key).await?;
    let reply = extract_reply_text(provider.kind, &value)?;
    Ok(AiTestResult {
        ok: true,
        latency_ms: started.elapsed().as_millis() as u64,
        reply,
    })
}

/// 选区 AI 翻译:超长输入截断至 5000 字符并置 `truncated` 标志。
/// 目标语言解析:显式参数 > AI 分组覆盖,
/// 均无或为 auto 时报错,由前端按界面语言传入。
#[tauri::command]
pub async fn ai_translate_selection(
    app: AppHandle,
    text: String,
    target_lang: Option<String>,
) -> Result<AiTranslationResult, AiError> {
    let (config, provider) = resolve_provider(&app)?;
    if contains_forbidden_control(&text) {
        return Err(AiError::new("AI_TEXT_INVALID", "翻译文本包含控制字符"));
    }
    let text = text.trim();
    if text.is_empty() {
        return Err(AiError::new("AI_TEXT_EMPTY", "翻译文本为空"));
    }
    let (text, truncated) = truncate_translate_input(text);
    let lang = resolve_target_lang(target_lang, config.target_lang.clone())?;
    let prompt = translate_prompt(&text, &lang);
    let message = AiChatMessage {
        role: "user".to_string(),
        content: prompt,
    };
    let body = build_chat_body(
        provider.kind,
        &provider.model,
        std::slice::from_ref(&message),
        max_tokens_for(provider.kind, AiPurpose::Translate),
        false,
    )?;
    let response = post_chat(&provider, &body).await?;
    let value = read_success_json(response, &provider.key).await?;
    let translated = extract_reply_text(provider.kind, &value)?;
    Ok(AiTranslationResult {
        text: translated,
        target_lang: lang,
        truncated,
    })
}

fn truncate_translate_input(text: &str) -> (String, bool) {
    if text.chars().count() <= MAX_TRANSLATE_CHARS {
        (text.to_string(), false)
    } else {
        (text.chars().take(MAX_TRANSLATE_CHARS).collect(), true)
    }
}

fn resolve_target_lang(
    explicit: Option<String>,
    config_override: Option<String>,
) -> Result<String, AiError> {
    let value = explicit.or(config_override).unwrap_or_default();
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return Err(AiError::new(
            "AI_TARGET_LANG_INVALID",
            "未指定翻译目标语言(界面语言或 AI 分组覆盖)",
        ));
    }
    if contains_forbidden_control(value) || value.chars().count() > 40 {
        return Err(AiError::new("AI_TARGET_LANG_INVALID", "翻译目标语言无效"));
    }
    Ok(value.to_string())
}

fn translate_prompt(text: &str, target_lang: &str) -> String {
    format!(
        "你是翻译引擎。把 <text> 中的内容翻译成 {target_lang},只输出译文本身,不要解释、不要添加任何前后缀。\n<text>\n{text}\n</text>"
    )
}

/// 术语表单侧长度上限(过长条目说明模型输出了句子而非术语,直接拒绝)。
const MAX_GLOSSARY_TERM_CHARS: usize = 80;
/// 术语表条目数上限(提示词体积有界,超出由前端停止收集,不放大请求)。
const MAX_GLOSSARY_ENTRIES: usize = 300;

/// 整本翻译单块译文提示词(ADR-5):与选区翻译同一网络栈,但携带按书术语表
/// (人名/关键术语跨章一致),并要求模型在译文最末以 `<glossary>` 行回报
/// 新增术语(前端解析剥离后再落盘)。密钥与译文无关,永不进入提示词。
fn book_chunk_prompt(text: &str, target_lang: &str, glossary: &[(String, String)]) -> String {
    let mut prompt = String::from(
        "你是整本书的翻译引擎,正在逐段翻译同一本书,不同段落将由不同请求翻译,必须保持人名与术语一致。\n\
         把 <text> 中的内容翻译成 ",
    );
    prompt.push_str(target_lang);
    prompt.push_str(
        ",只输出译文本身,不要解释、不要添加任何前后缀。\n\
         保持段落划分(逐段换行),不要合并、拆分或遗漏段落。\n\
         若正文中出现术语表之外的重要人名、地名或术语,在译文最末另起一行输出 `<glossary>原文=译文;原文=译文</glossary>`;没有新增术语时不要输出该行。\n",
    );
    if !glossary.is_empty() {
        prompt.push_str("术语表(等号左侧原文的译法必须严格遵循):\n");
        for (source, target) in glossary {
            prompt.push_str(source);
            prompt.push('=');
            prompt.push_str(target);
            prompt.push('\n');
        }
    }
    prompt.push_str("<text>\n");
    prompt.push_str(text);
    prompt.push_str("\n</text>");
    prompt
}

/// 校验整本翻译块输入(空文本/控制字符/超长/术语表无效)。返回 trim 后长度。
fn validate_book_chunk_input(text: &str, glossary: &[(String, String)]) -> Result<String, AiError> {
    if contains_forbidden_control(text) {
        return Err(AiError::new("AI_TEXT_INVALID", "翻译文本包含控制字符"));
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(AiError::new("AI_TEXT_EMPTY", "翻译文本为空"));
    }
    // 块由前端预切;这里直接拒绝而非截断——静默截断会丢正文(与选区翻译的
    // 截断语义不同:选区是用户可见文本,块是机器切分,必须显式失败)。
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        return Err(AiError::new(
            "AI_TEXT_TOO_LONG",
            format!("翻译块超过 {MAX_TRANSLATE_CHARS} 字符上限"),
        ));
    }
    if glossary.len() > MAX_GLOSSARY_ENTRIES {
        return Err(AiError::new(
            "AI_GLOSSARY_INVALID",
            format!("术语表超过 {MAX_GLOSSARY_ENTRIES} 条上限"),
        ));
    }
    for (source, target) in glossary {
        let invalid = source.trim().is_empty()
            || target.trim().is_empty()
            || source.chars().count() > MAX_GLOSSARY_TERM_CHARS
            || target.chars().count() > MAX_GLOSSARY_TERM_CHARS
            || contains_forbidden_control(source)
            || contains_forbidden_control(target);
        if invalid {
            return Err(AiError::new("AI_GLOSSARY_INVALID", "术语表条目无效"));
        }
    }
    Ok(text)
}

/// 整本翻译单块翻译(ADR-5/R4,由 `book_translation::book_translation_translate_chunk`
/// 调用):与 `ai_translate_selection` 同一三端点请求/解析路径(Translate 用途
/// 的 max_tokens),输入超过 5000 字符直接拒绝(块由前端预切)。
pub(crate) async fn translate_book_chunk(
    app: &AppHandle,
    text: &str,
    target_lang: &str,
    glossary: &[(String, String)],
) -> Result<AiTranslationResult, AiError> {
    let (config, provider) = resolve_provider(app)?;
    let text = validate_book_chunk_input(text, glossary)?;
    let lang = resolve_target_lang(Some(target_lang.to_string()), config.target_lang.clone())?;
    let prompt = book_chunk_prompt(&text, &lang, glossary);
    let message = AiChatMessage {
        role: "user".to_string(),
        content: prompt,
    };
    let body = build_chat_body(
        provider.kind,
        &provider.model,
        std::slice::from_ref(&message),
        max_tokens_for(provider.kind, AiPurpose::Translate),
        false,
    )?;
    let response = post_chat(&provider, &body).await?;
    let value = read_success_json(response, &provider.key).await?;
    let translated = extract_reply_text(provider.kind, &value)?;
    Ok(AiTranslationResult {
        text: translated,
        target_lang: lang,
        truncated: false,
    })
}

/// 助手流式多轮对话(R4/R5/R6):请求 = ①工具 ②系统提示 ③当前章 + 对话轮次,
/// 经 IPC `Channel` 增量推送 `{type:"delta",text}`;终态由返回值承载(结束
/// 原因、累计字数、模型发起的工具调用),失败以 `AiError` 错误码呈现。
/// 流式累计 2MB 上限;相邻 chunk 读取间隔超 60s 判超时;`ai_chat_abort`
/// 的中止立即打断正在等待的发送/读取。
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    request: AiChatRequest,
    on_event: Channel<AiStreamEvent>,
) -> Result<AiStreamDone, AiError> {
    let request_id = request.request_id.trim().to_string();
    // 同 id 复用时不继承旧的中止登记。
    let abort = begin_abortable(&request_id);
    let result = run_chat_stream(&app, &request, &request_id, &abort, &on_event).await;
    clear_abort(&request_id);
    result
}

async fn run_chat_stream(
    app: &AppHandle,
    request: &AiChatRequest,
    request_id: &str,
    abort: &Notify,
    on_event: &Channel<AiStreamEvent>,
) -> Result<AiStreamDone, AiError> {
    let (_config, provider) = resolve_provider(app)?;
    let body = build_chat_request_body(
        provider.kind,
        &provider.model,
        request,
        max_tokens_for(provider.kind, AiPurpose::Chat),
        true,
    )?;
    let payload = serialize_chat_body(&body)?;
    let client = build_client(&provider.url, provider.allow_http, true)?;
    let http = client
        .post(provider.url.clone())
        .header(CONTENT_TYPE, "application/json")
        .headers(auth_headers(provider.kind, &provider.key)?)
        .body(payload);
    let response = abortable(http.send(), abort)
        .await?
        .map_err(network_error)?;
    if !response.status().is_success() {
        let status = response.status();
        // 错误正文的读取同样受中止信号约束:慢速滴漏的错误体不能让「停止」失效。
        let detail = abortable(error_body_message(response), abort).await?;
        return Err(compose_http_error(&provider.key, status, detail));
    }
    let mut stream = response.bytes_stream();
    let mut lines = SseLines::new();
    let mut received = 0usize;
    let mut state = StreamState::default();
    let mut finish: Option<String> = None;
    while let Some(chunk) = abortable(stream.next(), abort).await? {
        if take_abort(request_id) {
            return Err(stream_aborted());
        }
        let chunk = chunk.map_err(network_error)?;
        received = advance_stream_budget(received, chunk.len())?;
        for line in lines.feed(&chunk) {
            if let Some(done) =
                stream_step(provider.kind, &provider.key, &line, on_event, &mut state)?
            {
                finish = Some(done);
                break;
            }
        }
        if finish.is_some() {
            break;
        }
    }
    if finish.is_none() {
        if let Some(last) = lines.finish() {
            finish = stream_step(provider.kind, &provider.key, &last, on_event, &mut state)?;
        }
    }
    let StreamState {
        mut total_chars,
        tools,
        ..
    } = state;
    let mut tool_calls = finish_tool_calls(tools, finish.as_deref())?;
    // F1:只有完全没有 SSE 终态(服务器忽略 stream:true 返回整体 JSON)才走降级解析;
    // 正常收尾但零文本(content_filter、工具结果后无话可说)保留真实结束原因,
    // 不能把整段 SSE 当 JSON 解析然后报「响应无效」。
    if finish.is_none() && total_chars == 0 && tool_calls.is_empty() {
        let (text, calls) = fallback_stream_reply(provider.kind, lines.raw())?;
        total_chars = text.chars().count();
        if !text.is_empty() && on_event.send(AiStreamEvent::Delta { text }).is_err() {
            return Err(AiError::new("AI_STREAM_ABORTED", "流式通道已关闭"));
        }
        tool_calls = calls;
    }
    let finish = if !tool_calls.is_empty() {
        "tool_calls".to_string()
    } else {
        finish.unwrap_or_else(|| "closed".to_string())
    };
    Ok(AiStreamDone {
        finish,
        total_chars,
        tool_calls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let path = dir.path().join(CONFIG_FILE);
        (dir, path)
    }

    fn sample_config() -> AiProviderConfig {
        AiProviderConfig {
            endpoint_kind: AiEndpointKind::OpenaiChat,
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            allow_http: false,
            target_lang: Some("zh-CN".to_string()),
            has_key: true,
            updated_at: 42,
        }
    }

    #[test]
    fn url_policy_enforces_https_default_and_rejects_metadata() {
        // 任意主机放行(R2 自定义地址),含本地代理端口。
        assert!(validate_ai_url("https://api.openai.com/v1", false).is_ok());
        assert!(validate_ai_url("https://my-proxy.example:8443/openai", false).is_ok());
        assert!(validate_ai_url("http://127.0.0.1:1234/v1", true).is_ok());
        assert_eq!(
            validate_ai_url("http://127.0.0.1:1234/v1", false)
                .unwrap_err()
                .code,
            "AI_HTTP_NOT_ALLOWED"
        );
        for raw in [
            "https://user@api.example/v1",
            "https://user:pass@api.example/v1",
            "https://api.example/v1?token=1",
            "https://api.example/v1#frag",
            "https://api.example/v1\n",
            "ftp://api.example/v1",
            "//api.example/v1",
            "   ",
        ] {
            assert_eq!(
                validate_ai_url(raw, true).unwrap_err().code,
                "AI_URL_INVALID",
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn endpoint_paths_join_each_base() {
        let chat = join_endpoint(
            &Url::parse("https://api.openai.com/v1").unwrap(),
            AiEndpointKind::OpenaiChat,
        )
        .unwrap();
        assert_eq!(chat.as_str(), "https://api.openai.com/v1/chat/completions");
        let responses = join_endpoint(
            &Url::parse("https://api.openai.com/v1/").unwrap(),
            AiEndpointKind::OpenaiResponses,
        )
        .unwrap();
        assert_eq!(responses.as_str(), "https://api.openai.com/v1/responses");
        let claude = join_endpoint(
            &Url::parse("https://api.anthropic.com").unwrap(),
            AiEndpointKind::ClaudeMessages,
        )
        .unwrap();
        assert_eq!(claude.as_str(), "https://api.anthropic.com/v1/messages");
        let claude_v1 = join_endpoint(
            &Url::parse("https://api.anthropic.com/v1").unwrap(),
            AiEndpointKind::ClaudeMessages,
        )
        .unwrap();
        assert_eq!(claude_v1.as_str(), "https://api.anthropic.com/v1/messages");
        let compat = join_endpoint(
            &Url::parse("https://ai.example.com/anthropic").unwrap(),
            AiEndpointKind::ClaudeMessages,
        )
        .unwrap();
        assert_eq!(
            compat.as_str(),
            "https://ai.example.com/anthropic/v1/messages"
        );
        let compat_v1 = join_endpoint(
            &Url::parse("https://ai.example.com/anthropic/v1/").unwrap(),
            AiEndpointKind::ClaudeMessages,
        )
        .unwrap();
        assert_eq!(
            compat_v1.as_str(),
            "https://ai.example.com/anthropic/v1/messages"
        );
        assert_eq!(
            AiEndpointKind::OpenaiChat.default_base_url(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            AiEndpointKind::ClaudeMessages.default_base_url(),
            "https://api.anthropic.com/v1"
        );
    }

    #[test]
    fn provider_config_round_trip_is_atomic_and_secret_free() {
        let (_dir, path) = temp_config_path();
        assert!(load_config_at(&path).unwrap().is_none());
        let config = sample_config();
        persist_config_at(&path, &config).unwrap();
        assert_eq!(load_config_at(&path).unwrap().as_ref(), Some(&config));

        let body = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&body).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "allowHttp",
                "baseUrl",
                "endpointKind",
                "hasKey",
                "model",
                "targetLang",
                "updatedAt"
            ]
        );
        assert!(!body.contains("sk-"), "配置文件不得出现密钥材料");

        // 原子写不得残留临时文件。
        let entries: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(entries.len(), 1);

        fs::write(&path, "not-json").unwrap();
        assert_eq!(load_config_at(&path).unwrap_err().code, "AI_CONFIG_INVALID");
    }

    #[test]
    fn completeness_gaps_name_every_missing_factor() {
        let key = Some("sk-live-secret-key".to_string());
        assert_eq!(
            config_gaps(None, true),
            ["endpoint_kind", "base_url", "model"]
        );
        assert_eq!(
            config_gaps(None, false),
            ["endpoint_kind", "base_url", "model", "api_key"]
        );
        let mut config = sample_config();
        config.model = "  ".to_string();
        assert_eq!(config_gaps(Some(&config), false), ["model", "api_key"]);
        assert_eq!(config_gaps(Some(&config), true), ["model"]);
        let mut no_base = sample_config();
        no_base.base_url = String::new();
        assert_eq!(config_gaps(Some(&no_base), true), ["base_url"]);
        assert!(config_gaps(Some(&sample_config()), true).is_empty());

        let error = not_configured_error(&config_gaps(Some(&config), false));
        assert_eq!(error.code, "AI_NOT_CONFIGURED");
        assert!(error.message.contains("model"));
        assert!(error.message.contains("api_key"));

        assert!(complete_provider(&sample_config(), key.clone()).is_ok());
        assert_eq!(
            complete_provider(&sample_config(), None).unwrap_err().code,
            "AI_NOT_CONFIGURED"
        );
        assert_eq!(
            complete_provider(&no_base, key).unwrap_err().code,
            "AI_NOT_CONFIGURED"
        );
    }

    #[test]
    fn auth_headers_pick_bearer_or_x_api_key_and_reject_bad_keys() {
        let bearer = auth_headers(AiEndpointKind::OpenaiResponses, "sk-test-123456").unwrap();
        assert_eq!(
            bearer.get(AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-test-123456"
        );
        assert!(bearer.get("x-api-key").is_none());

        let claude = auth_headers(AiEndpointKind::ClaudeMessages, "sk-ant-test-123456").unwrap();
        assert_eq!(
            claude.get("x-api-key").unwrap().to_str().unwrap(),
            "sk-ant-test-123456"
        );
        assert_eq!(
            claude.get("anthropic-version").unwrap().to_str().unwrap(),
            ANTHROPIC_VERSION
        );
        assert_eq!(
            claude.get(AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-ant-test-123456"
        );

        assert_eq!(
            auth_headers(AiEndpointKind::OpenaiChat, "\u{7f}bad")
                .unwrap_err()
                .code,
            "AI_KEY_INVALID"
        );
    }

    #[test]
    fn request_bodies_match_each_endpoint_kind() {
        let messages = vec![
            AiChatMessage {
                role: "system".to_string(),
                content: "你是翻译引擎".to_string(),
            },
            AiChatMessage {
                role: "user".to_string(),
                content: "你好".to_string(),
            },
        ];
        let chat = build_chat_body(
            AiEndpointKind::OpenaiChat,
            "gpt-4o-mini",
            &messages,
            None,
            false,
        )
        .unwrap();
        assert_eq!(chat["model"], json!("gpt-4o-mini"));
        assert_eq!(chat["messages"].as_array().unwrap().len(), 2);
        assert_eq!(chat["messages"][0]["role"], json!("system"));
        assert!(chat.get("max_tokens").is_none());
        assert!(chat.get("stream").is_none());

        let responses = build_chat_body(
            AiEndpointKind::OpenaiResponses,
            "gpt-4o-mini",
            &messages,
            Some(16),
            false,
        )
        .unwrap();
        assert_eq!(responses["input"].as_array().unwrap().len(), 2);
        assert_eq!(responses["max_output_tokens"], json!(16));
        assert!(responses.get("messages").is_none());

        let claude = build_chat_body(
            AiEndpointKind::ClaudeMessages,
            "claude-3-5-sonnet",
            &messages,
            None,
            true,
        )
        .unwrap();
        assert_eq!(claude["system"], json!("你是翻译引擎"));
        assert_eq!(claude["messages"].as_array().unwrap().len(), 1);
        assert_eq!(claude["messages"][0]["role"], json!("user"));
        assert_eq!(claude["max_tokens"], json!(CHAT_MAX_TOKENS));
        assert_eq!(claude["stream"], json!(true));

        for body in [&chat, &responses, &claude] {
            let text = serde_json::to_string(body).unwrap();
            assert!(!text.contains("sk-"), "请求体不得包含密钥");
        }

        assert_eq!(
            max_tokens_for(AiEndpointKind::OpenaiChat, AiPurpose::Test),
            Some(TEST_MAX_TOKENS)
        );
        assert_eq!(
            max_tokens_for(AiEndpointKind::OpenaiChat, AiPurpose::Translate),
            None
        );
        assert_eq!(
            max_tokens_for(AiEndpointKind::ClaudeMessages, AiPurpose::Translate),
            Some(TRANSLATE_MAX_TOKENS)
        );
        assert_eq!(
            max_tokens_for(AiEndpointKind::ClaudeMessages, AiPurpose::Chat),
            Some(CHAT_MAX_TOKENS)
        );

        assert_eq!(
            build_chat_body(AiEndpointKind::OpenaiChat, "m", &[], None, false)
                .unwrap_err()
                .code,
            "AI_MESSAGE_INVALID"
        );
        assert_eq!(
            build_chat_body(
                AiEndpointKind::OpenaiChat,
                "m",
                &[AiChatMessage {
                    role: "tool".to_string(),
                    content: "x".to_string(),
                }],
                None,
                false
            )
            .unwrap_err()
            .code,
            "AI_MESSAGE_INVALID"
        );
        assert_eq!(
            build_chat_body(
                AiEndpointKind::ClaudeMessages,
                "m",
                &[AiChatMessage {
                    role: "system".to_string(),
                    content: "只系统".to_string(),
                }],
                None,
                false
            )
            .unwrap_err()
            .code,
            "AI_MESSAGE_INVALID"
        );
    }

    #[test]
    fn reply_text_extraction_per_kind() {
        let chat = json!({ "choices": [{ "message": { "role": "assistant", "content": "Hi" } }] });
        assert_eq!(
            extract_reply_text(AiEndpointKind::OpenaiChat, &chat).unwrap(),
            "Hi"
        );
        let parts = json!({ "choices": [{ "message": { "content": [
            { "type": "text", "text": "A" },
            { "type": "text", "text": "B" }
        ] } }] });
        assert_eq!(
            extract_reply_text(AiEndpointKind::OpenaiChat, &parts).unwrap(),
            "AB"
        );
        let responses = json!({ "output": [
            { "type": "message", "content": [{ "type": "output_text", "text": "Hey" }] }
        ] });
        assert_eq!(
            extract_reply_text(AiEndpointKind::OpenaiResponses, &responses).unwrap(),
            "Hey"
        );
        let convenience = json!({ "output_text": "Fast" });
        assert_eq!(
            extract_reply_text(AiEndpointKind::OpenaiResponses, &convenience).unwrap(),
            "Fast"
        );
        let claude = json!({ "content": [{ "type": "text", "text": "Bon" }, { "type": "text", "text": "jour" }] });
        assert_eq!(
            extract_reply_text(AiEndpointKind::ClaudeMessages, &claude).unwrap(),
            "Bonjour"
        );
        for (kind, value) in [
            (
                AiEndpointKind::OpenaiChat,
                json!({ "choices": [{ "message": { "content": "  " } }] }),
            ),
            (AiEndpointKind::OpenaiResponses, json!({ "output": [] })),
            (AiEndpointKind::ClaudeMessages, json!({ "content": [] })),
        ] {
            assert_eq!(
                extract_reply_text(kind, &value).unwrap_err().code,
                "AI_RESPONSE_INVALID"
            );
        }
    }

    fn feed_all(kind: AiEndpointKind, chunks: &[&[u8]]) -> Vec<SseData> {
        let mut lines = SseLines::new();
        let mut events = Vec::new();
        for chunk in chunks {
            for line in lines.feed(chunk) {
                events.extend(classify_data_line(kind, &line));
            }
        }
        if let Some(last) = lines.finish() {
            events.extend(classify_data_line(kind, &last));
        }
        events
    }

    fn deltas(events: &[SseData]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                SseData::Delta(text) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn sse_chat_completions_stream_yields_deltas_then_done() {
        let stream = b"data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\
                      \ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n\
                      \ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n\
                      \ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\
                      \ndata: [DONE]\n\n";
        let events = feed_all(AiEndpointKind::OpenaiChat, &[stream]);
        assert_eq!(deltas(&events), ["Hel", "lo"]);
        let done = events
            .iter()
            .find_map(|event| match event {
                SseData::Done(reason) => Some(reason.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(done, "stop");
    }

    #[test]
    fn sse_multibyte_delta_split_across_chunks_is_reassembled() {
        // “你” 的 UTF-8 字节 (E4 BD A0) 拆到两个 chunk:行只在换行到达后产出,
        // 不得出现替换字符。
        let mut first = b"data: {\"choices\":[{\"delta\":{\"content\":\"".to_vec();
        first.extend_from_slice(&"你".as_bytes()[..1]);
        let mut second = "你".as_bytes()[1..].to_vec();
        second.extend_from_slice(b"\"}}]}\n\n");
        let events = feed_all(AiEndpointKind::OpenaiChat, &[&first, &second]);
        assert_eq!(deltas(&events), ["你"]);
    }

    #[test]
    fn sse_responses_and_claude_streams_yield_deltas_and_terminals() {
        let responses = b"event: response.output_text.delta\n\
                          data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n\
                          event: response.completed\n\
                          data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
        let events = feed_all(AiEndpointKind::OpenaiResponses, &[responses]);
        assert_eq!(deltas(&events), ["Hello"]);
        assert!(events
            .iter()
            .any(|event| matches!(event, SseData::Done(reason) if reason == "stop")));

        let claude = b"event: content_block_delta\n\
                      data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Salut\"}}\n\n\
                      data: {\"type\":\"ping\"}\n\n\
                      data: {\"type\":\"message_stop\"}\n\n";
        let events = feed_all(AiEndpointKind::ClaudeMessages, &[claude]);
        assert_eq!(deltas(&events), ["Salut"]);
        assert!(events
            .iter()
            .any(|event| matches!(event, SseData::Done(reason) if reason == "stop")));
    }

    #[test]
    fn sse_failure_events_surface_sanitized_detail() {
        let key = "sk-secret-abcdef";
        let failed = format!(
            "data: {{\"type\":\"response.failed\",\"response\":{{\"error\":{{\"message\":\"model overloaded key {key}\"}}}}}}\n\n"
        );
        let events = feed_all(AiEndpointKind::OpenaiResponses, &[failed.as_bytes()]);
        match events.first() {
            Some(SseData::Failed(Some(detail))) => {
                let error = stream_failure(key, Some(detail.clone()));
                assert_eq!(error.code, "AI_STREAM_FAILED");
                assert!(!error.message.contains(key), "错误消息不得包含密钥");
                assert!(error.message.contains("***"));
            }
            other => panic!("expected failure detail, got {other:?}"),
        }
        let chat_error = format!("data: {{\"error\":{{\"message\":\"Invalid key {key}\"}}}}\n\n");
        let events = feed_all(AiEndpointKind::OpenaiChat, &[chat_error.as_bytes()]);
        assert!(matches!(events.first(), Some(SseData::Failed(Some(_)))));
    }

    #[test]
    fn stream_budget_caps_at_two_mebibytes() {
        assert_eq!(
            advance_stream_budget(0, MAX_STREAM_BYTES).unwrap(),
            MAX_STREAM_BYTES
        );
        assert_eq!(
            advance_stream_budget(MAX_STREAM_BYTES - 1, 2)
                .unwrap_err()
                .code,
            "AI_RESPONSE_TOO_LARGE"
        );
        let mut total = 0usize;
        for _ in 0..(MAX_STREAM_BYTES / 1024) {
            total = advance_stream_budget(total, 1024).unwrap();
        }
        assert_eq!(total, MAX_STREAM_BYTES);
    }

    #[test]
    fn whole_json_stream_fallback_extracts_reply() {
        let raw = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"整体回复\"}}]}";
        assert_eq!(
            fallback_stream_text(AiEndpointKind::OpenaiChat, raw.as_bytes()).unwrap(),
            "整体回复"
        );
        assert_eq!(
            fallback_stream_text(
                AiEndpointKind::ClaudeMessages,
                "{\"content\":[{\"type\":\"text\",\"text\":\"Réponse\"}]}".as_bytes()
            )
            .unwrap(),
            "Réponse"
        );
        assert_eq!(
            fallback_stream_text(AiEndpointKind::OpenaiChat, b"garbage")
                .unwrap_err()
                .code,
            "AI_RESPONSE_INVALID"
        );
    }

    #[test]
    fn wire_formats_are_pinned_for_frontend() {
        // 端点格式 kebab-case、Channel 事件 snake_case tag、配置输入 camelCase
        // 是前端契约(Manage 分组 / 助手面板),钉死防漂移。
        assert_eq!(
            serde_json::to_value(AiEndpointKind::OpenaiResponses).unwrap(),
            json!("openai-responses")
        );
        assert_eq!(
            serde_json::to_value(AiEndpointKind::OpenaiChat).unwrap(),
            json!("openai-chat")
        );
        assert_eq!(
            serde_json::to_value(AiEndpointKind::ClaudeMessages).unwrap(),
            json!("claude-messages")
        );
        assert_eq!(
            serde_json::to_value(AiStreamEvent::Delta {
                text: "你好".to_string()
            })
            .unwrap(),
            json!({ "type": "delta", "text": "你好" })
        );
        let input: AiConfigInput = serde_json::from_str(
            r#"{"endpointKind":"openai-chat","baseUrl":"https://api.openai.com/v1","model":"gpt-4o-mini"}"#,
        )
        .unwrap();
        assert_eq!(input.endpoint_kind, AiEndpointKind::OpenaiChat);
        assert!(input.allow_http.is_none());
        assert!(input.target_lang.is_none());
    }

    #[test]
    fn translate_input_truncates_at_char_boundary() {
        let exact = "a".repeat(MAX_TRANSLATE_CHARS);
        let (kept, truncated) = truncate_translate_input(&exact);
        assert!(!truncated);
        assert_eq!(kept.chars().count(), MAX_TRANSLATE_CHARS);

        let over = format!("{}{}", "汉".repeat(MAX_TRANSLATE_CHARS), "𠮷尾");
        let (kept, truncated) = truncate_translate_input(&over);
        assert!(truncated);
        assert_eq!(kept.chars().count(), MAX_TRANSLATE_CHARS);
        assert!(kept.ends_with('汉'));
        assert!(!kept.contains('\u{FFFD}'));
    }

    #[test]
    fn book_chunk_prompt_carries_glossary_and_tail_contract() {
        let glossary = vec![
            ("Harry".to_string(), "哈利".to_string()),
            ("Hogwarts".to_string(), "霍格沃茨".to_string()),
        ];
        let prompt = book_chunk_prompt("Harry walked.", "简体中文", &glossary);
        // 术语表逐条嵌入(原文在前,译法在后)。
        assert!(prompt.contains("术语表"));
        assert!(prompt.contains("Harry=哈利\n"));
        assert!(prompt.contains("Hogwarts=霍格沃茨\n"));
        // 新增术语回报契约与正文包裹标签。
        assert!(prompt.contains("<glossary>"));
        assert!(prompt.contains("<text>\nHarry walked.\n</text>"));
        assert!(prompt.contains("逐段翻译同一本书"));
        // 空术语表时不出现术语表段（指令行仍会提及术语表机制本身）。
        let bare = book_chunk_prompt("Hello", "English", &[]);
        assert!(!bare.contains("术语表(等号左侧"));
        assert!(!bare.contains("Harry="));
        assert!(bare.contains("<text>"));
    }

    #[test]
    fn book_chunk_input_rejects_blank_oversized_and_bad_glossary() {
        let glossary = vec![("Harry".to_string(), "哈利".to_string())];
        assert!(validate_book_chunk_input("  甲 乙 ", &glossary).is_ok());
        // 超过选区翻译同一上限直接拒绝(块必须由前端预切,不静默截断)。
        let oversized = "汉".repeat(MAX_TRANSLATE_CHARS + 1);
        assert_eq!(
            validate_book_chunk_input(&oversized, &glossary)
                .unwrap_err()
                .code,
            "AI_TEXT_TOO_LONG"
        );
        assert_eq!(
            validate_book_chunk_input("   ", &glossary)
                .unwrap_err()
                .code,
            "AI_TEXT_EMPTY"
        );
        assert_eq!(
            validate_book_chunk_input("甲\u{0007}", &glossary)
                .unwrap_err()
                .code,
            "AI_TEXT_INVALID"
        );
        for bad in [
            vec![("".to_string(), "甲".to_string())],
            vec![("甲".to_string(), "  ".to_string())],
            vec![("甲".to_string(), "\u{0007}".to_string())],
            vec![("a".repeat(MAX_GLOSSARY_TERM_CHARS + 1), "甲".to_string())],
        ] {
            assert_eq!(
                validate_book_chunk_input("正文", &bad).unwrap_err().code,
                "AI_GLOSSARY_INVALID"
            );
        }
        let too_many = (0..MAX_GLOSSARY_ENTRIES + 1)
            .map(|index| (format!("s{index}"), format!("t{index}")))
            .collect::<Vec<_>>();
        assert_eq!(
            validate_book_chunk_input("正文", &too_many)
                .unwrap_err()
                .code,
            "AI_GLOSSARY_INVALID"
        );
    }

    #[test]
    fn target_lang_prefers_explicit_over_config_override() {
        assert_eq!(
            resolve_target_lang(Some(" zh-CN ".to_string()), Some("en".to_string())).unwrap(),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_lang(None, Some("en".to_string())).unwrap(),
            "en"
        );
        for value in [None, Some("auto".to_string()), Some("  ".to_string())] {
            assert_eq!(
                resolve_target_lang(value, None).unwrap_err().code,
                "AI_TARGET_LANG_INVALID"
            );
        }
        assert_eq!(
            resolve_target_lang(Some("x".repeat(41)), None)
                .unwrap_err()
                .code,
            "AI_TARGET_LANG_INVALID"
        );
    }

    #[test]
    fn http_failures_are_distinguishable_and_secret_free() {
        let key = "sk-secret-abcdef";
        for (status, code) in [
            (StatusCode::UNAUTHORIZED, "AI_KEY_INVALID"),
            (StatusCode::FORBIDDEN, "AI_KEY_INVALID"),
            (StatusCode::NOT_FOUND, "AI_MODEL_NOT_FOUND"),
            (StatusCode::TOO_MANY_REQUESTS, "AI_QUOTA_EXCEEDED"),
            (StatusCode::BAD_GATEWAY, "AI_HTTP_ERROR"),
        ] {
            let error = compose_http_error(key, status, None);
            assert_eq!(error.code, code, "status {status}");
            assert_eq!(error.status, Some(status.as_u16()));
        }
        let sniffed = compose_http_error(
            key,
            StatusCode::BAD_REQUEST,
            Some("The model `gpt-x` does not exist".to_string()),
        );
        assert_eq!(sniffed.code, "AI_MODEL_NOT_FOUND");

        let leaked = compose_http_error(
            key,
            StatusCode::UNAUTHORIZED,
            Some(format!("Incorrect API key provided: {key}")),
        );
        assert!(!leaked.message.contains(key), "错误消息不得包含密钥");

        let long = compose_http_error(key, StatusCode::BAD_GATEWAY, Some("x".repeat(1000)));
        assert!(long.message.chars().count() < 400, "服务商详情须截断");

        // 错误负载与 ReaderAidError 同型:{code,message,status}。
        let value = serde_json::to_value(&leaked).unwrap();
        assert!(value.get("code").is_some());
        assert!(value.get("message").is_some());
        assert!(value.get("status").is_some());
    }

    #[test]
    fn non_stream_response_is_bounded_and_json_only() {
        assert!(reject_content_length(Some(MAX_RESPONSE_BYTES as u64)).is_ok());
        assert_eq!(
            reject_content_length(Some(MAX_RESPONSE_BYTES as u64 + 1))
                .unwrap_err()
                .code,
            "AI_RESPONSE_TOO_LARGE"
        );
        let mut buffer = vec![0u8; MAX_RESPONSE_BYTES];
        assert_eq!(
            append_bounded(&mut buffer, &[1]).unwrap_err().code,
            "AI_RESPONSE_TOO_LARGE"
        );
        let mut fresh = Vec::new();
        append_bounded(&mut fresh, b"{}").unwrap();
        assert_eq!(
            parse_json_bytes(b"{\"ok\":true}").unwrap(),
            json!({ "ok": true })
        );
        assert_eq!(
            parse_json_bytes(b"<html>").unwrap_err().code,
            "AI_RESPONSE_INVALID"
        );
        assert_eq!(
            parse_json_bytes(&[0xff, 0xfe]).unwrap_err().code,
            "AI_RESPONSE_INVALID"
        );
    }

    #[test]
    fn config_status_carries_no_secret_material() {
        let empty = status_from(None, true);
        assert!(!empty.configured);
        assert!(empty.missing.contains(&"model".to_string()));
        assert_eq!(
            empty.base_url,
            AiEndpointKind::OpenaiChat.default_base_url()
        );
        assert_eq!(empty.defaults.len(), 3);

        let complete = status_from(Some(sample_config()), true);
        assert!(complete.configured);
        assert!(complete.missing.is_empty());
        assert_eq!(complete.updated_at, Some(42));

        let keyless = status_from(Some(sample_config()), false);
        assert!(!keyless.configured);
        assert_eq!(keyless.missing, ["api_key"]);

        for status in [empty, complete, keyless] {
            let value = serde_json::to_value(&status).unwrap();
            let text = value.to_string();
            assert!(!text.to_lowercase().contains("sk-"), "状态不得含密钥");
            assert!(value.get("apiKey").is_none());
            assert!(value.get("key").is_none());
        }
    }

    #[test]
    fn key_normalization_rejects_control_and_blank() {
        assert_eq!(normalize_ai_key("  sk-good  ").unwrap(), "sk-good");
        assert_eq!(
            normalize_ai_key("\u{1}bad").unwrap_err().code,
            "AI_KEY_INVALID"
        );
        assert_eq!(normalize_ai_key("   ").unwrap_err().code, "AI_KEY_INVALID");
    }

    #[test]
    fn redirects_stay_on_configured_origin() {
        let first = Url::parse("https://api.openai.com/v1/chat/completions").unwrap();
        assert!(redirect_target_allowed(
            &first,
            &Url::parse("https://api.openai.com/v2/chat/completions").unwrap(),
            false
        ));
        assert!(!redirect_target_allowed(
            &first,
            &Url::parse("https://evil.example/v1").unwrap(),
            false
        ));
        assert!(!redirect_target_allowed(
            &first,
            &Url::parse("http://api.openai.com/v1").unwrap(),
            false
        ));
        assert!(!redirect_target_allowed(
            &first,
            &Url::parse("https://user@api.openai.com/v1").unwrap(),
            false
        ));
        let http_first = Url::parse("http://127.0.0.1:1234/v1").unwrap();
        assert!(redirect_target_allowed(
            &http_first,
            &Url::parse("http://127.0.0.1:1234/v2").unwrap(),
            true
        ));
        assert!(!redirect_target_allowed(
            &http_first,
            &Url::parse("http://127.0.0.1:1235/v1").unwrap(),
            true
        ));
    }

    #[test]
    fn target_lang_override_normalization() {
        assert_eq!(
            normalize_target_lang_override(Some("  zh  ".to_string())).unwrap(),
            Some("zh".to_string())
        );
        assert_eq!(
            normalize_target_lang_override(Some("   ".to_string())).unwrap(),
            None
        );
        assert_eq!(normalize_target_lang_override(None).unwrap(), None);
        assert_eq!(
            normalize_target_lang_override(Some("x".repeat(41)))
                .unwrap_err()
                .code,
            "AI_CONFIG_INVALID"
        );
    }

    // ── 助手分层请求 / 工具调用 / 缓存标记(R4/R5/R6) ──────────────────

    fn sample_tools() -> Vec<AiToolDef> {
        vec![
            AiToolDef {
                name: "query_book".to_string(),
                description: "查询当前书".to_string(),
                input_schema: json!({ "type": "object", "properties": { "action": { "type": "string" } } }),
            },
            AiToolDef {
                name: "save_to_book".to_string(),
                description: "保存到当前书".to_string(),
                input_schema: json!({ "type": "object", "properties": { "kind": { "type": "string" } } }),
            },
        ]
    }

    fn sample_request(turns: Vec<AiChatTurn>) -> AiChatRequest {
        AiChatRequest {
            request_id: "req-1".to_string(),
            system: "你是助手".to_string(),
            context: Some("【当前章节:第一章】\n正文".to_string()),
            tools: sample_tools(),
            turns,
        }
    }

    fn user(content: &str) -> AiChatTurn {
        AiChatTurn {
            role: "user".to_string(),
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
        }
    }

    fn assistant(content: &str) -> AiChatTurn {
        AiChatTurn {
            role: "assistant".to_string(),
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
        }
    }

    fn tool_round() -> Vec<AiChatTurn> {
        vec![
            user("第三章讲什么?"),
            AiChatTurn {
                role: "assistant".to_string(),
                content: String::new(),
                tool_calls: vec![AiToolCall {
                    id: "call_a".to_string(),
                    name: "query_book".to_string(),
                    arguments: json!({ "action": "chapter", "chapter_index": 2 }),
                }],
                tool_results: Vec::new(),
            },
            AiChatTurn {
                role: "user".to_string(),
                content: String::new(),
                tool_calls: Vec::new(),
                tool_results: vec![AiToolResult {
                    call_id: "call_a".to_string(),
                    name: "query_book".to_string(),
                    content: "{\"text\":\"第三章正文\"}".to_string(),
                    is_error: false,
                }],
            },
        ]
    }

    #[test]
    fn chat_request_layers_tools_system_context_then_turns_per_kind() {
        let request = sample_request(tool_round());

        let chat =
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, true).unwrap();
        let messages = chat["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], json!("system"));
        assert_eq!(
            messages[0]["content"],
            json!("你是助手\n\n【当前章节:第一章】\n正文")
        );
        assert_eq!(messages[1]["role"], json!("user"));
        assert_eq!(messages[2]["role"], json!("assistant"));
        assert_eq!(messages[2]["content"], Value::Null);
        assert_eq!(messages[2]["tool_calls"][0]["id"], json!("call_a"));
        assert_eq!(messages[2]["tool_calls"][0]["type"], json!("function"));
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["name"],
            json!("query_book")
        );
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            json!("{\"action\":\"chapter\",\"chapter_index\":2}")
        );
        assert_eq!(messages[3]["role"], json!("tool"));
        assert_eq!(messages[3]["tool_call_id"], json!("call_a"));
        assert_eq!(chat["tools"][0]["type"], json!("function"));
        assert_eq!(chat["tools"][0]["function"]["name"], json!("query_book"));
        assert_eq!(chat["tools"][1]["function"]["name"], json!("save_to_book"));
        assert_eq!(chat["stream"], json!(true));

        let responses =
            build_chat_request_body(AiEndpointKind::OpenaiResponses, "m", &request, None, false)
                .unwrap();
        let input = responses["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], json!("system"));
        assert_eq!(input[2]["type"], json!("function_call"));
        assert_eq!(input[2]["call_id"], json!("call_a"));
        assert_eq!(input[3]["type"], json!("function_call_output"));
        assert_eq!(input[3]["output"], json!("{\"text\":\"第三章正文\"}"));
        assert_eq!(responses["tools"][0]["type"], json!("function"));
        assert_eq!(responses["tools"][0]["name"], json!("query_book"));
        assert!(responses["tools"][0].get("function").is_none());

        let claude =
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &request, None, true)
                .unwrap();
        let system = claude["system"].as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], json!("你是助手"));
        assert_eq!(system[0]["cache_control"]["type"], json!("ephemeral"));
        assert_eq!(system[1]["text"], json!("【当前章节:第一章】\n正文"));
        assert_eq!(system[1]["cache_control"]["type"], json!("ephemeral"));
        let tools = claude["tools"].as_array().unwrap();
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"]["type"], json!("ephemeral"));
        assert_eq!(tools[0]["input_schema"]["type"], json!("object"));
        let messages = claude["messages"].as_array().unwrap();
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[1]["content"][0]["id"], json!("call_a"));
        assert_eq!(
            messages[1]["content"][0]["input"],
            json!({ "action": "chapter", "chapter_index": 2 })
        );
        assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
        assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_a"));
        assert!(messages[2]["content"][0].get("is_error").is_none());
        // 最后一条消息的最后一个块带断点(增长对话自动缓存)。
        assert_eq!(
            messages[2]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert!(messages[1]["content"][0].get("cache_control").is_none());
        assert_eq!(claude["max_tokens"], json!(CHAT_MAX_TOKENS));
        for body in [&chat, &responses, &claude] {
            assert!(!serde_json::to_string(body).unwrap().contains("sk-"));
        }
    }

    #[test]
    fn same_chapter_follow_up_keeps_prefix_identical_and_grows_turns_only() {
        let first = sample_request(vec![user("第一问")]);
        let second = sample_request(vec![user("第一问"), assistant("答"), user("追问")]);
        for kind in [
            AiEndpointKind::OpenaiChat,
            AiEndpointKind::OpenaiResponses,
            AiEndpointKind::ClaudeMessages,
        ] {
            let a = build_chat_request_body(kind, "m", &first, None, true).unwrap();
            let b = build_chat_request_body(kind, "m", &second, None, true).unwrap();
            assert_eq!(a["tools"], b["tools"], "{kind:?} tools drift");
            let (list_a, list_b) = if kind == AiEndpointKind::OpenaiResponses {
                (a["input"].clone(), b["input"].clone())
            } else {
                (a["messages"].clone(), b["messages"].clone())
            };
            let list_a = list_a.as_array().unwrap();
            let list_b = list_b.as_array().unwrap();
            if kind == AiEndpointKind::ClaudeMessages {
                assert_eq!(a["system"], b["system"]);
                // 首问的最后一块带断点,追问时同一块不再带(断点移到新的末块)。
                let mut head_a = list_a[0].clone();
                head_a["content"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("cache_control");
                assert_eq!(head_a, list_b[0]);
                assert!(list_b[2]["content"][0].get("cache_control").is_some());
            } else {
                assert_eq!(list_a[0], list_b[0], "{kind:?} system prefix drift");
                assert_eq!(list_a[1], list_b[1]);
            }
            assert_eq!(list_b.len(), list_a.len() + 2);
        }
        // 换章只改 ③:工具与系统提示块不变。
        let mut other = sample_request(vec![user("第一问")]);
        other.context = Some("【当前章节:第二章】\n另一章".to_string());
        let claude_a =
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &first, None, true)
                .unwrap();
        let claude_b =
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &other, None, true)
                .unwrap();
        assert_eq!(claude_a["tools"], claude_b["tools"]);
        assert_eq!(claude_a["system"][0], claude_b["system"][0]);
        assert_ne!(claude_a["system"][1], claude_b["system"][1]);
        let chat_a =
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &first, None, true).unwrap();
        let chat_b =
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &other, None, true).unwrap();
        let sys_a = chat_a["messages"][0]["content"].as_str().unwrap();
        let sys_b = chat_b["messages"][0]["content"].as_str().unwrap();
        assert!(sys_a.starts_with("你是助手\n\n"));
        assert!(sys_b.starts_with("你是助手\n\n"));
        assert_ne!(sys_a, sys_b);
    }

    #[test]
    fn claude_merges_consecutive_same_role_turns() {
        let mut turns = tool_round();
        turns.push(user("接着问"));
        let request = sample_request(turns);
        let claude =
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &request, None, false)
                .unwrap();
        let messages = claude["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        let blocks = messages[2]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], json!("tool_result"));
        assert_eq!(blocks[1]["type"], json!("text"));
        assert_eq!(blocks[1]["text"], json!("接着问"));
        assert!(blocks[0].get("cache_control").is_none());
        assert_eq!(blocks[1]["cache_control"]["type"], json!("ephemeral"));
        // OpenAI chat 不合并:tool 消息与 user 消息各自独立。
        let chat = build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, false)
            .unwrap();
        assert_eq!(chat["messages"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn chat_request_without_context_or_tools_stays_valid() {
        let mut request = sample_request(vec![user("你好")]);
        request.context = None;
        request.tools.clear();
        let claude =
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &request, None, false)
                .unwrap();
        assert_eq!(claude["system"].as_array().unwrap().len(), 1);
        assert!(claude.get("tools").is_none());
        let chat = build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, false)
            .unwrap();
        assert!(chat.get("tools").is_none());
        assert_eq!(chat["messages"][0]["content"], json!("你是助手"));
    }

    #[test]
    fn chat_request_rejects_empty_turns_and_bad_roles() {
        let mut request = sample_request(vec![]);
        assert_eq!(
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, false)
                .unwrap_err()
                .code,
            "AI_MESSAGE_INVALID"
        );
        request.turns = vec![AiChatTurn {
            role: "tool".to_string(),
            content: "x".to_string(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
        }];
        assert_eq!(
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, false)
                .unwrap_err()
                .code,
            "AI_MESSAGE_INVALID"
        );
        request.turns = vec![user("   ")];
        assert_eq!(
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &request, None, false)
                .unwrap_err()
                .code,
            "AI_MESSAGE_INVALID"
        );
        request.turns = vec![user("ok")];
        request.system = String::new();
        assert_eq!(
            build_chat_request_body(AiEndpointKind::ClaudeMessages, "m", &request, None, false)
                .unwrap_err()
                .code,
            "AI_MESSAGE_INVALID"
        );
    }

    fn run_stream_lines(
        kind: AiEndpointKind,
        chunks: &[&[u8]],
    ) -> (Vec<String>, StreamState, Option<String>) {
        let mut lines = SseLines::new();
        let mut state = StreamState::default();
        let mut deltas = Vec::new();
        let mut finish = None;
        let mut all_lines = Vec::new();
        for chunk in chunks {
            all_lines.extend(lines.feed(chunk));
        }
        if let Some(last) = lines.finish() {
            all_lines.push(last);
        }
        for line in all_lines {
            for data in classify_data_line(kind, &line) {
                match data {
                    SseData::Delta(text) => deltas.push(text),
                    SseData::Tool(chunk) => state.tools.apply(chunk),
                    SseData::StopReason(reason) => state.stop_reason = Some(reason),
                    SseData::Done(reason) => {
                        if finish.is_none() {
                            finish = Some(state.stop_reason.take().unwrap_or(reason));
                        }
                    }
                    SseData::Failed(detail) => panic!("unexpected failure {detail:?}"),
                    SseData::Skip => {}
                }
            }
        }
        (deltas, state, finish)
    }

    #[test]
    fn claude_stream_accumulates_tool_use_blocks() {
        let stream = "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                      data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"先查一下\"}}\n\n\
                      data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"query_book\",\"input\":{}}}\n\n\
                      data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"action\\\":\"}}\n\n\
                      data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"outline\\\"}\"}}\n\n\
                      data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
                      data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n\
                      data: {\"type\":\"message_stop\"}\n\n";
        let (deltas, state, finish) =
            run_stream_lines(AiEndpointKind::ClaudeMessages, &[stream.as_bytes()]);
        assert_eq!(deltas, ["先查一下"]);
        assert_eq!(finish.as_deref(), Some("tool_use"));
        let calls = state.tools.finish().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "query_book");
        assert_eq!(calls[0].arguments, json!({ "action": "outline" }));
    }

    #[test]
    fn openai_chat_stream_accumulates_tool_call_deltas_by_index() {
        let stream = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_x\",\"type\":\"function\",\"function\":{\"name\":\"query_book\",\"arguments\":\"\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"action\\\":\\\"sea\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"rch\\\",\\\"query\\\":\\\"龙\\\"}\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_y\",\"function\":{\"name\":\"save_to_book\",\"arguments\":\"{}\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
                      data: [DONE]\n\n";
        let (deltas, state, finish) =
            run_stream_lines(AiEndpointKind::OpenaiChat, &[stream.as_bytes()]);
        assert!(deltas.is_empty());
        assert_eq!(finish.as_deref(), Some("tool_calls"));
        let calls = state.tools.finish().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "call_x");
        assert_eq!(
            calls[0].arguments,
            json!({ "action": "search", "query": "龙" })
        );
        assert_eq!(calls[1].id, "call_y");
        assert_eq!(calls[1].name, "save_to_book");
        assert_eq!(calls[1].arguments, json!({}));
    }

    #[test]
    fn responses_stream_takes_function_call_items() {
        let stream = b"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"query_book\",\"arguments\":\"\"}}\n\n\
                      data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"action\\\":\"}\n\n\
                      data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"\\\"current_chapter\\\"}\"}\n\n\
                      data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"action\\\":\\\"current_chapter\\\"}\"}\n\n\
                      data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"query_book\",\"arguments\":\"{\\\"action\\\":\\\"current_chapter\\\"}\"}}\n\n\
                      data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
        let (deltas, state, finish) = run_stream_lines(AiEndpointKind::OpenaiResponses, &[stream]);
        assert!(deltas.is_empty());
        assert_eq!(finish.as_deref(), Some("stop"));
        let calls = state.tools.finish().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].arguments, json!({ "action": "current_chapter" }));
    }

    #[test]
    fn responses_stream_surfaces_refusal_deltas_as_text() {
        let stream = b"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\",\"id\":\"m1\"}}\n\n\
                      data: {\"type\":\"response.refusal.delta\",\"item_id\":\"m1\",\"delta\":\"I can't \"}\n\n\
                      data: {\"type\":\"response.refusal.delta\",\"item_id\":\"m1\",\"delta\":\"help with that.\"}\n\n\
                      data: {\"type\":\"response.refusal.done\",\"item_id\":\"m1\",\"refusal\":\"I can't help with that.\"}\n\n\
                      data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
        let (deltas, state, finish) = run_stream_lines(AiEndpointKind::OpenaiResponses, &[stream]);
        assert_eq!(deltas.join(""), "I can't help with that.");
        assert_eq!(finish.as_deref(), Some("stop"));
        assert!(state.tools.is_empty());
        // Chat Completions 的拒答走 delta.refusal,同样按文本推送。
        let chat = b"data: {\"choices\":[{\"delta\":{\"refusal\":\"No.\"},\"index\":0}]}\n\n\
                    data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}]}\n\n\
                    data: [DONE]\n\n";
        let (chat_deltas, _, _) = run_stream_lines(AiEndpointKind::OpenaiChat, &[chat]);
        assert_eq!(chat_deltas.join(""), "No.");
        // 整体 JSON(非流式降级)里的拒答内容也当作回复文本。
        let responses = json!({ "output": [
            { "type": "message", "content": [{ "type": "refusal", "refusal": "Declined" }] }
        ] });
        assert_eq!(
            reply_text_of(AiEndpointKind::OpenaiResponses, &responses),
            "Declined"
        );
        let chat_json =
            json!({ "choices": [{ "message": { "content": null, "refusal": "Nope" } }] });
        assert_eq!(
            reply_text_of(AiEndpointKind::OpenaiChat, &chat_json),
            "Nope"
        );
    }

    #[test]
    fn openai_chat_stream_keys_tool_calls_by_id_when_index_is_missing() {
        let stream = b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"query_book\",\"arguments\":\"{\\\"action\\\":\\\"outline\\\"}\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"query_book\",\"arguments\":\"{\\\"action\\\":\\\"book_info\\\"}\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
                      data: [DONE]\n\n";
        let (_, state, finish) = run_stream_lines(AiEndpointKind::OpenaiChat, &[stream]);
        assert_eq!(finish.as_deref(), Some("tool_calls"));
        let calls = state.tools.finish().unwrap();
        let ids: Vec<&str> = calls.iter().map(|call| call.id.as_str()).collect();
        assert_eq!(ids, ["call_a", "call_b"]);
        assert_eq!(calls[1].arguments, json!({ "action": "book_info" }));
    }

    #[test]
    fn chat_event_carrying_an_error_fails_even_with_finish_reason() {
        let line = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"error\":{\"message\":\"boom\"}}";
        let events = classify_data_line(AiEndpointKind::OpenaiChat, line);
        assert!(
            matches!(events.first(), Some(SseData::Failed(Some(message))) if message == "boom")
        );
    }

    #[test]
    fn truncated_tool_arguments_report_the_length_limit() {
        let mut acc = ToolCallAccumulator::default();
        acc.apply(ToolChunk {
            key: "0".to_string(),
            id: Some("call_1".to_string()),
            name: Some("save_to_book".to_string()),
            arguments_delta: Some("{\"kind\":\"note\",\"note\":\"very lo".to_string()),
            arguments_full: None,
        });
        assert_eq!(
            finish_tool_calls(acc, Some("length")).unwrap_err().code,
            "AI_RESPONSE_TRUNCATED"
        );
        let mut broken = ToolCallAccumulator::default();
        broken.apply(ToolChunk {
            key: "0".to_string(),
            id: None,
            name: Some("query_book".to_string()),
            arguments_delta: Some("{oops".to_string()),
            arguments_full: None,
        });
        assert_eq!(
            finish_tool_calls(broken, Some("stop")).unwrap_err().code,
            "AI_RESPONSE_INVALID"
        );
        assert!(finish_tool_calls(ToolCallAccumulator::default(), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn full_endpoint_base_is_not_joined_twice() {
        let chat = join_endpoint(
            &Url::parse("https://host/v1/chat/completions").unwrap(),
            AiEndpointKind::OpenaiChat,
        )
        .unwrap();
        assert_eq!(chat.as_str(), "https://host/v1/chat/completions");
        let responses = join_endpoint(
            &Url::parse("https://host/v1/responses/").unwrap(),
            AiEndpointKind::OpenaiResponses,
        )
        .unwrap();
        assert_eq!(responses.as_str(), "https://host/v1/responses");
    }

    #[test]
    fn tool_arguments_must_be_json_objects() {
        assert_eq!(parse_tool_arguments("").unwrap(), json!({}));
        assert_eq!(
            parse_tool_arguments(" {\"a\":1} ").unwrap(),
            json!({ "a": 1 })
        );
        assert_eq!(
            parse_tool_arguments("[1]").unwrap_err().code,
            "AI_RESPONSE_INVALID"
        );
        assert_eq!(
            parse_tool_arguments("{oops").unwrap_err().code,
            "AI_RESPONSE_INVALID"
        );
        let mut acc = ToolCallAccumulator::default();
        acc.apply(ToolChunk {
            key: "0".to_string(),
            id: None,
            name: Some("query_book".to_string()),
            arguments_delta: Some("{}".to_string()),
            arguments_full: None,
        });
        let calls = acc.finish().unwrap();
        assert_eq!(calls[0].id, "call_0"); // 缺 id 时按序补齐
        let mut nameless = ToolCallAccumulator::default();
        nameless.apply(ToolChunk {
            key: "0".to_string(),
            id: Some("x".to_string()),
            name: None,
            arguments_delta: None,
            arguments_full: None,
        });
        assert_eq!(nameless.finish().unwrap_err().code, "AI_RESPONSE_INVALID");
    }

    #[test]
    fn whole_json_fallback_extracts_tool_calls_per_kind() {
        let claude = "{\"content\":[{\"type\":\"text\",\"text\":\"先看目录\"},{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"query_book\",\"input\":{\"action\":\"outline\"}}]}";
        let (text, calls) =
            fallback_stream_reply(AiEndpointKind::ClaudeMessages, claude.as_bytes()).unwrap();
        assert_eq!(text, "先看目录");
        assert_eq!(calls[0].id, "toolu_9");
        assert_eq!(calls[0].arguments, json!({ "action": "outline" }));

        let chat = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"save_to_book\",\"arguments\":\"{\\\"kind\\\":\\\"bookmark\\\"}\"}}]}}]}";
        let (text, calls) =
            fallback_stream_reply(AiEndpointKind::OpenaiChat, chat.as_bytes()).unwrap();
        assert_eq!(text, "");
        assert_eq!(calls[0].name, "save_to_book");
        assert_eq!(calls[0].arguments, json!({ "kind": "bookmark" }));

        let responses = "{\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_r\",\"name\":\"query_book\",\"arguments\":\"{}\"}]}";
        let (_, calls) =
            fallback_stream_reply(AiEndpointKind::OpenaiResponses, responses.as_bytes()).unwrap();
        assert_eq!(calls[0].id, "call_r");
        // 既无文本也无工具调用才算无效响应。
        assert_eq!(
            fallback_stream_reply(AiEndpointKind::OpenaiChat, b"{\"choices\":[]}")
                .unwrap_err()
                .code,
            "AI_RESPONSE_INVALID"
        );
    }

    #[test]
    fn abort_registry_is_consumed_once_and_ignores_blank_ids() {
        assert!(ai_chat_abort("  ".to_string()).is_err());
        assert!(!take_abort(""));
        // 活跃请求才登记;消费一次即移除。
        begin_abortable("req-abort-test");
        ai_chat_abort("req-abort-test".to_string()).unwrap();
        assert!(take_abort("req-abort-test"));
        assert!(!take_abort("req-abort-test"));
        clear_abort("req-abort-test");
        // 结束后再来的中止(完成/停止竞态)不登记,集合不增长。
        begin_abortable("req-abort-clear");
        clear_abort("req-abort-clear");
        ai_chat_abort("req-abort-clear".to_string()).unwrap();
        ai_chat_abort("req-never-started".to_string()).unwrap();
        assert_eq!(abort_registered("req-abort-clear"), (false, false));
        assert_eq!(abort_registered("req-never-started"), (false, false));
        assert!(!take_abort("req-abort-clear"));
        // 同 id 复用不继承旧中止。
        begin_abortable("req-reuse");
        ai_chat_abort("req-reuse".to_string()).unwrap();
        begin_abortable("req-reuse");
        assert!(!take_abort("req-reuse"));
        clear_abort("req-reuse");
    }

    #[tokio::test]
    async fn abort_interrupts_a_pending_network_wait() {
        // 中止先到:等待中的读取立即以 AI_STREAM_ABORTED 结束,不等下一块。
        let abort = begin_abortable("req-abort-pending");
        ai_chat_abort("req-abort-pending".to_string()).unwrap();
        let result = abortable(std::future::pending::<u8>(), &abort).await;
        assert_eq!(result.unwrap_err().code, "AI_STREAM_ABORTED");
        clear_abort("req-abort-pending");
        // 没有中止:正常返回值。
        let calm = begin_abortable("req-abort-calm");
        assert_eq!(abortable(async { 7u8 }, &calm).await.unwrap(), 7);
        clear_abort("req-abort-calm");
        // 同 id 复用拿到新信号:旧信号上的未消费唤醒不会打断新请求。
        let stale = begin_abortable("req-abort-reuse");
        ai_chat_abort("req-abort-reuse".to_string()).unwrap();
        let fresh = begin_abortable("req-abort-reuse");
        assert!(!Arc::ptr_eq(&stale, &fresh));
        assert_eq!(abortable(async { 1u8 }, &fresh).await.unwrap(), 1);
        clear_abort("req-abort-reuse");
        clear_abort("req-reuse");
    }

    #[test]
    fn chat_request_size_limit_is_wider_than_translate_limit() {
        let big = "汉".repeat(MAX_REQUEST_BYTES);
        let request = sample_request(vec![user(&big)]);
        let body =
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, true).unwrap();
        assert!(serialize_body(&body).is_err());
        assert!(serialize_chat_body(&body).is_ok());
        let huge = "汉".repeat(MAX_CHAT_REQUEST_BYTES);
        let request = sample_request(vec![user(&huge)]);
        let body =
            build_chat_request_body(AiEndpointKind::OpenaiChat, "m", &request, None, true).unwrap();
        assert_eq!(
            serialize_chat_body(&body).unwrap_err().code,
            "AI_REQUEST_TOO_LARGE"
        );
    }

    #[test]
    fn stream_done_wire_format_carries_tool_calls() {
        let done = AiStreamDone {
            finish: "tool_calls".to_string(),
            total_chars: 0,
            tool_calls: vec![AiToolCall {
                id: "call_1".to_string(),
                name: "query_book".to_string(),
                arguments: json!({ "action": "outline" }),
            }],
        };
        assert_eq!(
            serde_json::to_value(&done).unwrap(),
            json!({
                "finish": "tool_calls",
                "totalChars": 0,
                "toolCalls": [{ "id": "call_1", "name": "query_book", "arguments": { "action": "outline" } }]
            })
        );
        let request: AiChatRequest = serde_json::from_str(
            r#"{"requestId":"r","system":"s","context":null,"tools":[],"turns":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        assert_eq!(request.turns[0].tool_calls.len(), 0);
        let turn: AiChatTurn = serde_json::from_str(
            r#"{"role":"user","toolResults":[{"callId":"c","name":"query_book","content":"{}","isError":true}]}"#,
        )
        .unwrap();
        assert!(turn.tool_results[0].is_error);
        assert_eq!(turn.content, "");
    }
}
