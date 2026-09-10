//! AI 提供商网络层(ADR-2/ADR-3,R2)。
//!
//! - 配置:`app_data_dir/ai-provider.json` 原子读写(SyncProfile 模式);
//!   API Key 仅存 `credential_store`(`lightink.ai` / `provider`),配置文件、
//!   响应体、错误消息与日志均不出现密钥明文(测试断言把关;本模块不写日志)。
//! - URL:默认仅 HTTPS,`allow_http` 显式勾选后放行 HTTP;拒绝 userinfo/
//!   query/fragment;任意主机(R2 自定义地址)。与 reader_aid 的 Wiktionary 主机
//!   白名单不同,安全边界由「密钥仅 Rust 侧持有 + 超时/大小上限」承担。
//! - 端点:OpenAI Responses / OpenAI Chat Completions / Claude Messages
//!   三种格式各自构造请求并解析文本。Chat 路径可带 `tools`;Claude 在 ①②③
//!   上打 `cache_control` 并附 prompt-caching beta(忽略该字段的网关仍按纯文本
//!   对话成功)。SSE 除 delta 外可推送 `tool_call`;关闭 Channel 即
//!   `AI_STREAM_ABORTED`。
//! - 网络:连接 15s;非流式总超时 60s、响应上限 256KB;流式无总超时、逐块
//!   读取超时 60s、累计 2MB 上限,经 Tauri IPC `Channel` 增量推送。
//!   Chat 请求上限 2MB,翻译等非对话命令仍 512KB。服务器忽略 stream:true
//!   返回整体 JSON 时退化为单次解析(ADR-3 降级路径,功能不丢)。

use crate::credential_store::{delete_credential, get_credential, set_credential};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use url::Url;

const CONFIG_FILE: &str = "ai-provider.json";
const KEYRING_SERVICE: &str = "lightink.ai";
const KEYRING_REFERENCE: &str = "provider";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_BETA_PROMPT_CACHING: &str = "prompt-caching-2024-07-31";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_CHAT_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOOLS: usize = 16;
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AiToolCall>,
}

impl AiChatMessage {
    fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            ..Self::default()
        }
    }
}

/// 前端传入的 function 工具(JSON Schema 在 `parameters`)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

/// 一轮流式结束时带回的完整 tool_call(arguments 为 JSON 字符串)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// `ai_chat_stream` 的终态:`finish` 为 stop/done/incomplete/closed/tool_calls 之一。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDone {
    pub finish: String,
    pub total_chars: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AiToolCall>,
}

/// 经 IPC Channel 增量推送的事件:`delta` 或 `tool_call`(snake_case tag)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Delta {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
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
            "tool" => {
                has_turn = true;
                if message
                    .tool_call_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    return Err(AiError::new(
                        "AI_MESSAGE_INVALID",
                        "工具结果缺少 toolCallId",
                    ));
                }
            }
            other => {
                return Err(AiError::new(
                    "AI_MESSAGE_INVALID",
                    format!("不支持的消息角色: {other}"),
                ))
            }
        }
        let empty_content = message.content.trim().is_empty();
        let has_tool_calls = !message.tool_calls.is_empty();
        if empty_content && !has_tool_calls && message.role != "tool" {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容不能为空"));
        }
        if contains_forbidden_control(&message.content) {
            return Err(AiError::new("AI_MESSAGE_INVALID", "消息内容包含控制字符"));
        }
        for call in &message.tool_calls {
            if call.id.trim().is_empty() || call.name.trim().is_empty() {
                return Err(AiError::new(
                    "AI_MESSAGE_INVALID",
                    "tool_call 缺少 id 或 name",
                ));
            }
            if contains_forbidden_control(&call.id)
                || contains_forbidden_control(&call.name)
                || contains_forbidden_control(&call.arguments)
            {
                return Err(AiError::new("AI_MESSAGE_INVALID", "tool_call 包含控制字符"));
            }
        }
    }
    if kind == AiEndpointKind::ClaudeMessages && !has_turn {
        return Err(AiError::new("AI_MESSAGE_INVALID", "对话缺少用户或助手消息"));
    }
    Ok(())
}

fn validate_tools(tools: &[AiToolDefinition]) -> Result<(), AiError> {
    if tools.len() > MAX_TOOLS {
        return Err(AiError::new(
            "AI_REQUEST_INVALID",
            format!("工具数量超过 {MAX_TOOLS} 个上限"),
        ));
    }
    for tool in tools {
        if tool.name.trim().is_empty() || contains_forbidden_control(&tool.name) {
            return Err(AiError::new("AI_REQUEST_INVALID", "工具名无效"));
        }
        if contains_forbidden_control(&tool.description) {
            return Err(AiError::new("AI_REQUEST_INVALID", "工具描述包含控制字符"));
        }
        if !(tool.parameters.is_object() || tool.parameters.is_null()) {
            return Err(AiError::new(
                "AI_REQUEST_INVALID",
                "工具参数必须是 JSON 对象",
            ));
        }
    }
    Ok(())
}

fn tool_parameters(tool: &AiToolDefinition) -> Value {
    if tool.parameters.is_null() {
        json!({ "type": "object", "properties": {} })
    } else {
        tool.parameters.clone()
    }
}

fn cache_control_ephemeral() -> Value {
    json!({ "type": "ephemeral" })
}

fn openai_chat_tools(tools: &[AiToolDefinition]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool_parameters(tool),
                    }
                })
            })
            .collect(),
    )
}

fn openai_responses_tools(tools: &[AiToolDefinition]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool_parameters(tool),
                })
            })
            .collect(),
    )
}

fn claude_tools(tools: &[AiToolDefinition]) -> Value {
    let mut items: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool_parameters(tool),
            })
        })
        .collect();
    if let Some(last) = items.last_mut() {
        if let Some(object) = last.as_object_mut() {
            object.insert("cache_control".to_string(), cache_control_ephemeral());
        }
    }
    Value::Array(items)
}

fn claude_system_blocks(messages: &[AiChatMessage]) -> Option<Value> {
    let blocks: Vec<Value> = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| {
            json!({
                "type": "text",
                "text": message.content,
                "cache_control": cache_control_ephemeral(),
            })
        })
        .collect();
    if blocks.is_empty() {
        None
    } else {
        Some(Value::Array(blocks))
    }
}

fn parse_tool_arguments(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| json!({ "raw": raw }))
}

fn openai_chat_message(message: &AiChatMessage) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("role".to_string(), json!(message.role));
    if message.role == "tool" {
        object.insert(
            "tool_call_id".to_string(),
            json!(message.tool_call_id.as_deref().unwrap_or("")),
        );
        if let Some(name) = &message.name {
            object.insert("name".to_string(), json!(name));
        }
        object.insert("content".to_string(), json!(message.content));
    } else if !message.tool_calls.is_empty() {
        if message.content.trim().is_empty() {
            object.insert("content".to_string(), Value::Null);
        } else {
            object.insert("content".to_string(), json!(message.content));
        }
        object.insert(
            "tool_calls".to_string(),
            Value::Array(
                message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments,
                            }
                        })
                    })
                    .collect(),
            ),
        );
    } else {
        object.insert("content".to_string(), json!(message.content));
    }
    Value::Object(object)
}

fn openai_responses_items(messages: &[AiChatMessage]) -> Value {
    let mut items = Vec::new();
    for message in messages {
        if message.role == "tool" {
            items.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id.as_deref().unwrap_or(""),
                "output": message.content,
            }));
            continue;
        }
        if !message.tool_calls.is_empty() {
            if !message.content.trim().is_empty() {
                items.push(json!({ "role": message.role, "content": message.content }));
            }
            for call in &message.tool_calls {
                items.push(json!({
                    "type": "function_call",
                    "call_id": call.id,
                    "name": call.name,
                    "arguments": call.arguments,
                }));
            }
            continue;
        }
        items.push(json!({ "role": message.role, "content": message.content }));
    }
    Value::Array(items)
}

fn claude_messages(messages: &[AiChatMessage]) -> Value {
    let mut items: Vec<Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            continue;
        }
        if message.role == "tool" {
            let block = json!({
                "type": "tool_result",
                "tool_use_id": message.tool_call_id.as_deref().unwrap_or(""),
                "content": message.content,
            });
            if let Some(Value::Object(last)) = items.last_mut() {
                if last.get("role").and_then(Value::as_str) == Some("user") {
                    if let Some(Value::Array(content)) = last.get_mut("content") {
                        if content.iter().any(|part| {
                            part.get("type").and_then(Value::as_str) == Some("tool_result")
                        }) {
                            content.push(block);
                            continue;
                        }
                    }
                }
            }
            items.push(json!({
                "role": "user",
                "content": [block],
            }));
            continue;
        }
        if !message.tool_calls.is_empty() {
            let mut content = Vec::new();
            if !message.content.trim().is_empty() {
                content.push(json!({ "type": "text", "text": message.content }));
            }
            for call in &message.tool_calls {
                content.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": parse_tool_arguments(&call.arguments),
                }));
            }
            items.push(json!({ "role": "assistant", "content": content }));
            continue;
        }
        items.push(json!({ "role": message.role, "content": message.content }));
    }
    Value::Array(items)
}

/// 三种端点格式各构造请求体;密钥只进请求头,永远不进请求体。
pub(crate) fn build_chat_body(
    kind: AiEndpointKind,
    model: &str,
    messages: &[AiChatMessage],
    max_tokens: Option<u32>,
    stream: bool,
) -> Result<Value, AiError> {
    build_chat_body_with_tools(kind, model, messages, None, max_tokens, stream)
}

fn build_chat_body_with_tools(
    kind: AiEndpointKind,
    model: &str,
    messages: &[AiChatMessage],
    tools: Option<&[AiToolDefinition]>,
    max_tokens: Option<u32>,
    stream: bool,
) -> Result<Value, AiError> {
    validate_chat_messages(kind, messages)?;
    let tools = tools.filter(|items| !items.is_empty());
    if let Some(tools) = tools {
        validate_tools(tools)?;
    }
    let cache_prefix = tools.is_some()
        || messages
            .iter()
            .filter(|message| message.role == "system")
            .count()
            > 1;
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), json!(model));
    if let Some(tools) = tools {
        let encoded = match kind {
            AiEndpointKind::OpenaiResponses => openai_responses_tools(tools),
            AiEndpointKind::OpenaiChat => openai_chat_tools(tools),
            AiEndpointKind::ClaudeMessages => claude_tools(tools),
        };
        body.insert("tools".to_string(), encoded);
    }
    match kind {
        AiEndpointKind::OpenaiResponses => {
            body.insert("input".to_string(), openai_responses_items(messages));
            if let Some(max) = max_tokens {
                body.insert("max_output_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::OpenaiChat => {
            body.insert(
                "messages".to_string(),
                Value::Array(messages.iter().map(openai_chat_message).collect()),
            );
            if let Some(max) = max_tokens {
                body.insert("max_tokens".to_string(), json!(max));
            }
        }
        AiEndpointKind::ClaudeMessages => {
            // Claude Messages 不接受 messages 内的 system 角色,提升为顶层。
            // 分层请求把 ②③ 做成带 cache_control 的内容块;无 tools 的单段
            // system(翻译等)仍拼成字符串,兼容只认 string 的网关。
            if cache_prefix {
                if let Some(system) = claude_system_blocks(messages) {
                    body.insert("system".to_string(), system);
                }
            } else {
                let system: Vec<&str> = messages
                    .iter()
                    .filter(|message| message.role == "system")
                    .map(|message| message.content.as_str())
                    .collect();
                if !system.is_empty() {
                    body.insert("system".to_string(), json!(system.join("\n\n")));
                }
            }
            body.insert("messages".to_string(), claude_messages(messages));
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
    serialize_body_limited(body, MAX_REQUEST_BYTES)
}

fn serialize_body_limited(body: &Value, limit: usize) -> Result<Vec<u8>, AiError> {
    let payload = serde_json::to_vec(body)
        .map_err(|_| AiError::new("AI_REQUEST_INVALID", "无法构造 AI 请求"))?;
    if payload.len() > limit {
        return Err(AiError::new(
            "AI_REQUEST_TOO_LARGE",
            format!("请求超过 {limit} 字节上限"),
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
        headers.insert(
            HeaderName::from_static("anthropic-beta"),
            HeaderValue::from_static(ANTHROPIC_BETA_PROMPT_CACHING),
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

pub(crate) fn extract_reply_text(kind: AiEndpointKind, value: &Value) -> Result<String, AiError> {
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
                                if content.get("type").and_then(Value::as_str)
                                    == Some("output_text")
                                {
                                    if let Some(text) = content.get("text").and_then(Value::as_str)
                                    {
                                        parts.push(text);
                                    }
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
    let text = text.trim();
    if text.is_empty() {
        return Err(AiError::new("AI_RESPONSE_INVALID", "AI 未返回文本"));
    }
    Ok(text.to_string())
}

// ── SSE 流式解析 ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum SseData {
    Skip,
    Delta(String),
    ToolCall(AiToolCall),
    Done(String),
    Failed(Option<String>),
}

#[derive(Default)]
struct PendingToolCall {
    index: i64,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ToolCallAccumulator {
    pending: Vec<PendingToolCall>,
    completed: Vec<AiToolCall>,
    finish_hint: Option<String>,
}

impl ToolCallAccumulator {
    fn already_completed(&self, id: &str) -> bool {
        !id.is_empty() && self.completed.iter().any(|call| call.id == id)
    }

    fn pending_at(&mut self, index: i64) -> &mut PendingToolCall {
        if let Some(position) = self.pending.iter().position(|item| item.index == index) {
            return &mut self.pending[position];
        }
        self.pending.push(PendingToolCall {
            index,
            ..PendingToolCall::default()
        });
        self.pending.last_mut().expect("just pushed")
    }

    fn upsert_openai_delta(&mut self, item: &Value) {
        let index = item.get("index").and_then(Value::as_i64).unwrap_or(0);
        let slot = self.pending_at(index);
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if !id.is_empty() {
                slot.id = id.to_string();
            }
        }
        if let Some(name) = item
            .pointer("/function/name")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str))
        {
            if !name.is_empty() {
                slot.name = name.to_string();
            }
        }
        if let Some(arguments) = item
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .or_else(|| item.get("arguments").and_then(Value::as_str))
        {
            slot.arguments.push_str(arguments);
        }
    }

    fn start_named(&mut self, index: i64, id: &str, name: &str) {
        let slot = self.pending_at(index);
        if !id.is_empty() {
            slot.id = id.to_string();
        }
        if !name.is_empty() {
            slot.name = name.to_string();
        }
    }

    fn append_arguments(&mut self, index: i64, delta: &str) {
        self.pending_at(index).arguments.push_str(delta);
    }

    fn complete_index(&mut self, index: i64) -> Option<AiToolCall> {
        let position = self.pending.iter().position(|item| item.index == index)?;
        let pending = self.pending.remove(position);
        self.finish_pending(pending)
    }

    fn complete_all(&mut self) -> Vec<AiToolCall> {
        let pending = std::mem::take(&mut self.pending);
        pending
            .into_iter()
            .filter_map(|item| self.finish_pending(item))
            .collect()
    }

    fn finish_pending(&mut self, pending: PendingToolCall) -> Option<AiToolCall> {
        if pending.id.is_empty() && pending.name.is_empty() {
            return None;
        }
        let call = AiToolCall {
            id: pending.id,
            name: pending.name,
            arguments: pending.arguments,
        };
        self.completed.push(call.clone());
        Some(call)
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

fn classify_data_line(
    kind: AiEndpointKind,
    line: &str,
    pending: &mut ToolCallAccumulator,
) -> SseData {
    let Some(payload) = line.strip_prefix("data:") else {
        return SseData::Skip;
    };
    let payload = payload.trim();
    if payload.is_empty() || payload == ": keep-alive" {
        return SseData::Skip;
    }
    if payload == "[DONE]" {
        return SseData::Done(
            pending
                .finish_hint
                .clone()
                .unwrap_or_else(|| "done".to_string()),
        );
    }
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return SseData::Skip;
    };
    classify_sse_event(kind, &value, pending)
}

fn classify_sse_event(
    kind: AiEndpointKind,
    value: &Value,
    pending: &mut ToolCallAccumulator,
) -> SseData {
    match kind {
        AiEndpointKind::OpenaiResponses => classify_openai_responses_event(value, pending),
        AiEndpointKind::OpenaiChat => classify_openai_chat_event(value, pending),
        AiEndpointKind::ClaudeMessages => classify_claude_event(value, pending),
    }
}

fn classify_openai_responses_event(value: &Value, pending: &mut ToolCallAccumulator) -> SseData {
    match value.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => value
            .get("delta")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| SseData::Delta(text.to_string()))
            .unwrap_or(SseData::Skip),
        Some("response.output_item.added") => {
            let item = value.get("item").unwrap_or(value);
            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                let index = value
                    .get("output_index")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                pending.start_named(index, id, name);
                if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                    pending.append_arguments(index, arguments);
                }
            }
            SseData::Skip
        }
        Some("response.function_call_arguments.delta") => {
            let index = value
                .get("output_index")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                pending.append_arguments(index, delta);
            }
            SseData::Skip
        }
        Some("response.function_call_arguments.done") => {
            let index = value
                .get("output_index")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
                let slot = pending.pending_at(index);
                if slot.arguments.is_empty() {
                    slot.arguments = arguments.to_string();
                }
            }
            pending
                .complete_index(index)
                .map(SseData::ToolCall)
                .unwrap_or(SseData::Skip)
        }
        Some("response.output_item.done")
            if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") =>
        {
            let index = value
                .get("output_index")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let item = value.get("item");
            let id = item
                .and_then(|item| item.get("call_id").or_else(|| item.get("id")))
                .and_then(Value::as_str)
                .unwrap_or("");
            if pending.already_completed(id) {
                return SseData::Skip;
            }
            if let Some(item) = item {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                pending.start_named(index, id, name);
                if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                    let slot = pending.pending_at(index);
                    if slot.arguments.is_empty() {
                        slot.arguments = arguments.to_string();
                    }
                }
            }
            pending
                .complete_index(index)
                .map(SseData::ToolCall)
                .unwrap_or(SseData::Skip)
        }
        Some("response.completed") => SseData::Done("stop".to_string()),
        Some("response.incomplete") => SseData::Done("incomplete".to_string()),
        Some("response.failed") => SseData::Failed(
            value
                .pointer("/response/error/message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
        ),
        Some("error") => SseData::Failed(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
        ),
        _ => SseData::Skip,
    }
}

fn classify_openai_chat_event(value: &Value, pending: &mut ToolCallAccumulator) -> SseData {
    if let Some(calls) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    {
        for call in calls {
            pending.upsert_openai_delta(call);
        }
    }
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        if !text.is_empty() {
            return SseData::Delta(text.to_string());
        }
    }
    if let Some(finish) = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
    {
        if !finish.is_empty() {
            pending.finish_hint = Some(finish.to_string());
            return SseData::Done(finish.to_string());
        }
    }
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return SseData::Failed(Some(message.trim().to_string()));
    }
    SseData::Skip
}

fn classify_claude_event(value: &Value, pending: &mut ToolCallAccumulator) -> SseData {
    match value.get("type").and_then(Value::as_str) {
        Some("content_block_start")
            if value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") =>
        {
            let index = value.get("index").and_then(Value::as_i64).unwrap_or(0);
            let id = value
                .pointer("/content_block/id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let name = value
                .pointer("/content_block/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            pending.start_named(index, id, name);
            SseData::Skip
        }
        Some("content_block_delta")
            if value.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") =>
        {
            value
                .pointer("/delta/text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|text| SseData::Delta(text.to_string()))
                .unwrap_or(SseData::Skip)
        }
        Some("content_block_delta")
            if value.pointer("/delta/type").and_then(Value::as_str) == Some("input_json_delta") =>
        {
            let index = value.get("index").and_then(Value::as_i64).unwrap_or(0);
            if let Some(partial) = value.pointer("/delta/partial_json").and_then(Value::as_str) {
                pending.append_arguments(index, partial);
            }
            SseData::Skip
        }
        Some("content_block_stop") => {
            let index = value.get("index").and_then(Value::as_i64).unwrap_or(0);
            pending
                .complete_index(index)
                .map(SseData::ToolCall)
                .unwrap_or(SseData::Skip)
        }
        Some("message_delta") => {
            if let Some(reason) = value
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                pending.finish_hint = Some(reason.to_string());
            }
            SseData::Skip
        }
        Some("message_stop") => SseData::Done(
            pending
                .finish_hint
                .clone()
                .unwrap_or_else(|| "stop".to_string()),
        ),
        Some("error") => SseData::Failed(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
        ),
        _ => SseData::Skip,
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

fn send_stream_event(
    on_event: &Channel<AiStreamEvent>,
    event: AiStreamEvent,
) -> Result<(), AiError> {
    on_event
        .send(event)
        .map_err(|_| AiError::new("AI_STREAM_ABORTED", "流式通道已关闭"))
}

fn send_tool_call(on_event: &Channel<AiStreamEvent>, call: AiToolCall) -> Result<(), AiError> {
    send_stream_event(
        on_event,
        AiStreamEvent::ToolCall {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
        },
    )
}

fn stream_step(
    kind: AiEndpointKind,
    key: &str,
    line: &str,
    on_event: &Channel<AiStreamEvent>,
    total_chars: &mut usize,
    pending: &mut ToolCallAccumulator,
) -> Result<Option<AiStreamDone>, AiError> {
    match classify_data_line(kind, line, pending) {
        SseData::Skip => Ok(None),
        SseData::Done(finish) => {
            for call in pending.complete_all() {
                send_tool_call(on_event, call)?;
            }
            Ok(Some(AiStreamDone {
                finish,
                total_chars: *total_chars,
                tool_calls: pending.completed.clone(),
            }))
        }
        SseData::Delta(text) => {
            *total_chars += text.chars().count();
            send_stream_event(on_event, AiStreamEvent::Delta { text })?;
            Ok(None)
        }
        SseData::ToolCall(call) => {
            send_tool_call(on_event, call)?;
            Ok(None)
        }
        SseData::Failed(detail) => Err(stream_failure(key, detail)),
    }
}

fn extract_tool_calls(kind: AiEndpointKind, value: &Value) -> Vec<AiToolCall> {
    match kind {
        AiEndpointKind::OpenaiChat => value
            .pointer("/choices/0/message/tool_calls")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("id").and_then(Value::as_str)?;
                        let name = item.pointer("/function/name").and_then(Value::as_str)?;
                        let arguments = item
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        Some(AiToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments: arguments.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        AiEndpointKind::OpenaiResponses => value
            .get("output")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("type").and_then(Value::as_str) == Some("function_call")
                    })
                    .filter_map(|item| {
                        let id = item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)?;
                        let name = item.get("name").and_then(Value::as_str)?;
                        let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
                        Some(AiToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments: arguments.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        AiEndpointKind::ClaudeMessages => value
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .filter_map(|item| {
                        let id = item.get("id").and_then(Value::as_str)?;
                        let name = item.get("name").and_then(Value::as_str)?;
                        let arguments = item.get("input").map(|input| {
                            if input.is_string() {
                                input.as_str().unwrap_or("").to_string()
                            } else {
                                input.to_string()
                            }
                        })?;
                        Some(AiToolCall {
                            id: id.to_string(),
                            name: name.to_string(),
                            arguments,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn fallback_stream_payload(
    kind: AiEndpointKind,
    raw: &[u8],
) -> Result<(Option<String>, Vec<AiToolCall>), AiError> {
    let value = parse_json_bytes(raw)?;
    let tool_calls = extract_tool_calls(kind, &value);
    let text = extract_reply_text(kind, &value).ok();
    if text.is_none() && tool_calls.is_empty() {
        return Err(AiError::new("AI_RESPONSE_INVALID", "AI 未返回文本"));
    }
    Ok((text, tool_calls))
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
    let probe = [AiChatMessage::text("user", "ping")];
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
    let message = AiChatMessage::text("user", prompt);
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
    let message = AiChatMessage::text("user", prompt);
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

/// 流式多轮对话:经 IPC `Channel` 增量推送 `{type:\"delta\",text}` 或
/// `{type:\"tool_call\",...}`,终态由返回值承载(完成含 finish、累计字数与
/// tool_calls)或以 `AiError` 错误码失败。Channel 发送失败即 `AI_STREAM_ABORTED`。
/// Chat 请求上限 2MB;流式累计 2MB;相邻 chunk 读取间隔超 60s 判超时。
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    messages: Vec<AiChatMessage>,
    on_event: Channel<AiStreamEvent>,
    tools: Option<Vec<AiToolDefinition>>,
) -> Result<AiStreamDone, AiError> {
    let (_config, provider) = resolve_provider(&app)?;
    let body = build_chat_body_with_tools(
        provider.kind,
        &provider.model,
        &messages,
        tools.as_deref(),
        max_tokens_for(provider.kind, AiPurpose::Chat),
        true,
    )?;
    let payload = serialize_body_limited(&body, MAX_CHAT_REQUEST_BYTES)?;
    let client = build_client(&provider.url, provider.allow_http, true)?;
    let request = client
        .post(provider.url.clone())
        .header(CONTENT_TYPE, "application/json")
        .headers(auth_headers(provider.kind, &provider.key)?)
        .body(payload);
    let response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = error_body_message(response).await;
        return Err(compose_http_error(&provider.key, status, detail));
    }
    let mut stream = response.bytes_stream();
    let mut lines = SseLines::new();
    let mut received = 0usize;
    let mut total_chars = 0usize;
    let mut pending = ToolCallAccumulator::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        received = advance_stream_budget(received, chunk.len())?;
        for line in lines.feed(&chunk) {
            if let Some(done) = stream_step(
                provider.kind,
                &provider.key,
                &line,
                &on_event,
                &mut total_chars,
                &mut pending,
            )? {
                return Ok(done);
            }
        }
    }
    if let Some(last) = lines.finish() {
        if let Some(done) = stream_step(
            provider.kind,
            &provider.key,
            &last,
            &on_event,
            &mut total_chars,
            &mut pending,
        )? {
            return Ok(done);
        }
    }
    if total_chars == 0 && pending.completed.is_empty() && pending.pending.is_empty() {
        // 服务器忽略 stream:true 返回整体 JSON:单次解析后一次性推送。
        let (text, tool_calls) = fallback_stream_payload(provider.kind, lines.raw())?;
        if let Some(text) = text {
            total_chars = text.chars().count();
            send_stream_event(&on_event, AiStreamEvent::Delta { text })?;
        }
        for call in tool_calls.clone() {
            send_tool_call(&on_event, call)?;
        }
        return Ok(AiStreamDone {
            finish: if tool_calls.is_empty() {
                "closed".to_string()
            } else {
                "tool_calls".to_string()
            },
            total_chars,
            tool_calls,
        });
    }
    for call in pending.complete_all() {
        send_tool_call(&on_event, call)?;
    }
    Ok(AiStreamDone {
        finish: "closed".to_string(),
        total_chars,
        tool_calls: pending.completed,
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
            claude.get("anthropic-beta").unwrap().to_str().unwrap(),
            ANTHROPIC_BETA_PROMPT_CACHING
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
            AiChatMessage::text("system", "你是翻译引擎"),
            AiChatMessage::text("user", "你好"),
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
                &[AiChatMessage::text("function", "x")],
                None,
                false
            )
            .unwrap_err()
            .code,
            "AI_MESSAGE_INVALID"
        );
        assert_eq!(
            build_chat_body(
                AiEndpointKind::OpenaiChat,
                "m",
                &[AiChatMessage::text("tool", "x")],
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
                &[AiChatMessage::text("system", "只系统")],
                None,
                false
            )
            .unwrap_err()
            .code,
            "AI_MESSAGE_INVALID"
        );
        assert!(chat.get("tools").is_none());
        assert!(responses.get("tools").is_none());
        assert!(claude.get("tools").is_none());
        let claude_text = serde_json::to_string(&claude).unwrap();
        assert!(
            !claude_text.contains("cache_control"),
            "无 tools 的单段 system 不得打 cache 断点"
        );
    }

    #[test]
    fn same_chapter_prefix_bytes_stay_identical_and_claude_blocks_cache() {
        let tools = sample_tools();
        let first = layered_messages("这章讲什么？", &[]);
        let second = layered_messages(
            "再详细点",
            &[
                AiChatMessage::text("user", "这章讲什么？"),
                AiChatMessage::text("assistant", "潮水"),
            ],
        );
        for kind in [
            AiEndpointKind::OpenaiChat,
            AiEndpointKind::OpenaiResponses,
            AiEndpointKind::ClaudeMessages,
        ] {
            let a =
                build_chat_body_with_tools(kind, "m", &first, Some(&tools), None, true).unwrap();
            let b =
                build_chat_body_with_tools(kind, "m", &second, Some(&tools), None, true).unwrap();
            assert_eq!(
                serde_json::to_vec(&prefix_value(kind, &a)).unwrap(),
                serde_json::to_vec(&prefix_value(kind, &b)).unwrap(),
                "{kind:?} 同章两问前缀字节应一致"
            );
            assert!(a.get("tools").is_some());
            assert_eq!(a["tools"], b["tools"]);
        }

        let claude = build_chat_body_with_tools(
            AiEndpointKind::ClaudeMessages,
            "m",
            &first,
            Some(&tools),
            None,
            true,
        )
        .unwrap();
        let claude_tools = claude["tools"].as_array().unwrap();
        assert_eq!(claude_tools.len(), 2);
        assert!(claude_tools[0].get("cache_control").is_none());
        assert_eq!(
            claude_tools[1]["cache_control"],
            json!({ "type": "ephemeral" })
        );
        let system = claude["system"].as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], json!("你是阅读器助手。"));
        assert_eq!(system[0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(system[1]["cache_control"], json!({ "type": "ephemeral" }));
        assert!(system[1]["text"].as_str().unwrap().contains("<chapter>"));

        let chat = build_chat_body_with_tools(
            AiEndpointKind::OpenaiChat,
            "m",
            &first,
            Some(&tools),
            None,
            true,
        )
        .unwrap();
        let chat_json = serde_json::to_string(&chat).unwrap();
        assert!(
            !chat_json.contains("cache_control"),
            "OpenAI 不得发明 cache_control"
        );
        assert_eq!(chat["tools"][0]["type"], json!("function"));
        assert_eq!(chat["tools"][0]["function"]["name"], json!("query_book"));
        assert_eq!(chat["messages"][0]["role"], json!("system"));
        assert_eq!(chat["messages"][1]["role"], json!("system"));
    }

    #[test]
    fn chat_request_limit_is_two_mebibytes_translate_stays_512kib() {
        let over_translate = json!({ "text": "a".repeat(MAX_REQUEST_BYTES) });
        assert_eq!(
            serialize_body(&over_translate).unwrap_err().code,
            "AI_REQUEST_TOO_LARGE"
        );
        assert!(serialize_body_limited(&over_translate, MAX_CHAT_REQUEST_BYTES).is_ok());
        let over_chat = json!({ "text": "a".repeat(MAX_CHAT_REQUEST_BYTES) });
        assert_eq!(
            serialize_body_limited(&over_chat, MAX_CHAT_REQUEST_BYTES)
                .unwrap_err()
                .code,
            "AI_REQUEST_TOO_LARGE"
        );
        let small = json!({ "ok": true });
        assert!(serialize_body(&small).is_ok());
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
        let mut pending = ToolCallAccumulator::default();
        for chunk in chunks {
            for line in lines.feed(chunk) {
                let event = classify_data_line(kind, &line, &mut pending);
                if matches!(event, SseData::Done(_)) {
                    for call in pending.complete_all() {
                        events.push(SseData::ToolCall(call));
                    }
                }
                events.push(event);
            }
        }
        if let Some(last) = lines.finish() {
            let event = classify_data_line(kind, &last, &mut pending);
            if matches!(event, SseData::Done(_)) {
                for call in pending.complete_all() {
                    events.push(SseData::ToolCall(call));
                }
            }
            events.push(event);
        }
        events
    }

    fn tool_calls(events: &[SseData]) -> Vec<(String, String, String)> {
        events
            .iter()
            .filter_map(|event| match event {
                SseData::ToolCall(call) => {
                    Some((call.id.clone(), call.name.clone(), call.arguments.clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn sample_tools() -> Vec<AiToolDefinition> {
        vec![
            AiToolDefinition {
                name: "query_book".to_string(),
                description: "查询当前书".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "action": { "type": "string" } },
                    "required": ["action"]
                }),
            },
            AiToolDefinition {
                name: "save_to_book".to_string(),
                description: "保存到当前书".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "kind": { "type": "string" } },
                    "required": ["kind"]
                }),
            },
        ]
    }

    fn layered_messages(user: &str, extra: &[AiChatMessage]) -> Vec<AiChatMessage> {
        let mut messages = vec![
            AiChatMessage::text("system", "你是阅读器助手。"),
            AiChatMessage::text("system", "【当前章节：一】\n<chapter>\n正文\n</chapter>"),
        ];
        messages.extend(extra.iter().cloned());
        messages.push(AiChatMessage::text("user", user));
        messages
    }

    fn prefix_value(kind: AiEndpointKind, body: &Value) -> Value {
        match kind {
            AiEndpointKind::OpenaiChat => json!({
                "tools": body.get("tools"),
                "messages": body["messages"].as_array().unwrap().iter().take(2).cloned().collect::<Vec<_>>(),
            }),
            AiEndpointKind::OpenaiResponses => json!({
                "tools": body.get("tools"),
                "input": body["input"].as_array().unwrap().iter().take(2).cloned().collect::<Vec<_>>(),
            }),
            AiEndpointKind::ClaudeMessages => json!({
                "tools": body.get("tools"),
                "system": body.get("system"),
            }),
        }
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
    fn sse_streams_emit_text_delta_and_tool_call() {
        let chat = b"data: {\"choices\":[{\"delta\":{\"content\":\"Look\"}}]}\n\
                      \ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"query_book\",\"arguments\":\"\"}}]}}]}\n\
                      \ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"action\\\":\\\"toc\\\"}\"}}]}}]}\n\
                      \ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\
                      \ndata: [DONE]\n\n";
        let events = feed_all(AiEndpointKind::OpenaiChat, &[chat]);
        assert_eq!(deltas(&events), ["Look"]);
        assert_eq!(
            tool_calls(&events),
            [(
                "call_1".to_string(),
                "query_book".to_string(),
                "{\"action\":\"toc\"}".to_string()
            )]
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, SseData::Done(reason) if reason == "tool_calls")));

        let claude = b"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Check\"}}\n\n\
                      data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"query_book\",\"input\":{}}}\n\n\
                      data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"action\\\":\\\"toc\\\"}\"}}\n\n\
                      data: {\"type\":\"content_block_stop\",\"index\":1}\n\n\
                      data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n\
                      data: {\"type\":\"message_stop\"}\n\n";
        let events = feed_all(AiEndpointKind::ClaudeMessages, &[claude]);
        assert_eq!(deltas(&events), ["Check"]);
        assert_eq!(
            tool_calls(&events),
            [(
                "toolu_1".to_string(),
                "query_book".to_string(),
                "{\"action\":\"toc\"}".to_string()
            )]
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, SseData::Done(reason) if reason == "tool_use")));

        let responses = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n\
                          data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_9\",\"name\":\"save_to_book\",\"arguments\":\"\"}}\n\n\
                          data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"kind\\\":\\\"bookmark\\\"}\"}\n\n\
                          data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"arguments\":\"{\\\"kind\\\":\\\"bookmark\\\"}\"}\n\n\
                          data: {\"type\":\"response.completed\"}\n\n";
        let events = feed_all(AiEndpointKind::OpenaiResponses, &[responses]);
        assert_eq!(deltas(&events), ["Hi"]);
        assert_eq!(
            tool_calls(&events),
            [(
                "call_9".to_string(),
                "save_to_book".to_string(),
                "{\"kind\":\"bookmark\"}".to_string()
            )]
        );
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
        let (text, tools) =
            fallback_stream_payload(AiEndpointKind::OpenaiChat, raw.as_bytes()).unwrap();
        assert_eq!(text.as_deref(), Some("整体回复"));
        assert!(tools.is_empty());
        let (text, tools) = fallback_stream_payload(
            AiEndpointKind::ClaudeMessages,
            "{\"content\":[{\"type\":\"text\",\"text\":\"Réponse\"}]}".as_bytes(),
        )
        .unwrap();
        assert_eq!(text.as_deref(), Some("Réponse"));
        assert!(tools.is_empty());
        assert_eq!(
            fallback_stream_payload(AiEndpointKind::OpenaiChat, b"garbage")
                .unwrap_err()
                .code,
            "AI_RESPONSE_INVALID"
        );
        let tool_only = "{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"query_book\",\"arguments\":\"{}\"}}]}}]}";
        let (text, tools) =
            fallback_stream_payload(AiEndpointKind::OpenaiChat, tool_only.as_bytes()).unwrap();
        assert!(text.is_none());
        assert_eq!(tools[0].name, "query_book");
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
        assert_eq!(
            serde_json::to_value(AiStreamEvent::ToolCall {
                id: "call_1".to_string(),
                name: "query_book".to_string(),
                arguments: "{\"action\":\"toc\"}".to_string(),
            })
            .unwrap(),
            json!({
                "type": "tool_call",
                "id": "call_1",
                "name": "query_book",
                "arguments": "{\"action\":\"toc\"}"
            })
        );
        let done = serde_json::to_value(AiStreamDone {
            finish: "stop".to_string(),
            total_chars: 2,
            tool_calls: Vec::new(),
        })
        .unwrap();
        assert_eq!(done, json!({ "finish": "stop", "totalChars": 2 }));
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
}
