//! 书架与阅读器摸鱼（docs/requirements/2026-09-26-shelf-reader-conceal.md）
//! 桌面专属后端：R2 老板键、R3 最小化/隐藏、R4 退出口、R8 置顶、R6 窗口级
//! 透明（macOS NSWindow 层）、R9 迷你窗口、R13 点击穿透轮询、R14 托盘常驻。
//!
//! 与前端的对接契约（命令名 / camelCase 字段 / 四个事件名）冻结，两侧并行
//! 开发不得擅改：命令 conceal_register_boss_keys / conceal_set_always_on_top /
//! conceal_set_transparent / conceal_set_mini_window /
//! conceal_restore_window_baseline / conceal_set_click_through /
//! conceal_hide_to_tray / conceal_restore_from_tray / conceal_get_status /
//! conceal_exit_app；事件 conceal-quit-requested / conceal-tray-status /
//! conceal-pointer-zone / conceal-zones-stale。
//!
//! 视觉层（渐变背景、内容透明度、DOM 显隐）全部由前端 CSS/状态机承担；
//! 本模块只负责系统窗口层与全局输入层。移动端（R12）整个模块不编译。

use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::window_chrome;

/// 主窗口 label（tauri.conf.json 中唯一窗口）。
const MAIN_WINDOW: &str = "main";

/// R13 点击穿透轮询间隔（契约：60ms）。
const CLICK_THROUGH_POLL_INTERVAL: Duration = Duration::from_millis(60);
/// 穿透等待循环的步进：Resized 事件尽早唤醒，此值只是兜底节拍。
const WINDOW_STATE_POLL_STEP: Duration = Duration::from_millis(25);
/// R9 取消最大化后等待还原完成的预算（契约：800ms，超时 Err 回退）。
const UNMAXIMIZE_WAIT_TIMEOUT: Duration = Duration::from_millis(800);
/// R9 迷你窗口目标缩放与下限（下限对齐 tauri.conf.json minWidth/minHeight
/// 480×360；改窗口最小尺寸时须同步这里）。
const MINI_SCALE: f64 = 0.62;
const MINI_MIN_WIDTH: f64 = 480.0;
const MINI_MIN_HEIGHT: f64 = 360.0;
/// R13 运行期兜底：光标读数连续 5 次（约 300ms）精确 (0,0) 视为 Wayland
/// （tao 在 Wayland 恒返回 0，单次判定会误伤恰好位于桌面原点的 X11 光标）。
const ZERO_CURSOR_STREAK_LIMIT: u32 = 5;
/// R14 macOS 托盘双击判定窗口（tray-icon 0.24 仅 Windows 发 DoubleClick；
/// 纯函数 tray_double_click 的测试在所有桌面平台执行，故随其同 cfg）。
#[cfg(any(target_os = "macos", test))]
const TRAY_DOUBLE_CLICK_WINDOW_MS: u64 = 500;

const TRAY_ID: &str = "lightink-conceal-tray";
const TRAY_MENU_TOGGLE: &str = "lightink-conceal-toggle";
const TRAY_MENU_QUIT: &str = "lightink-conceal-quit";

/// 事件名与载荷 source 常量：与前端契约一字不差。
const EVENT_QUIT_REQUESTED: &str = "conceal-quit-requested";
const EVENT_TRAY_STATUS: &str = "conceal-tray-status";
const EVENT_POINTER_ZONE: &str = "conceal-pointer-zone";
const EVENT_ZONES_STALE: &str = "conceal-zones-stale";
const QUIT_SOURCE_BOSS_SECONDARY: &str = "boss-secondary";
const QUIT_SOURCE_TRAY_MENU: &str = "tray-menu";

// ── 对外返回类型（契约字段，camelCase 序列化） ──────────────────────────

/// R2 注册结果：primary/secondary 报告“当前真实注册在系统的组合”，
/// null 表示该键未注册（含回滚失败后的诚实上报），错误串说明原因。
#[derive(Default, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcealBossKeysStatus {
    pub primary: Option<String>,
    pub secondary: Option<String>,
    pub primary_error: Option<String>,
    pub secondary_error: Option<String>,
}

/// R14/R2 启动状态：前端注册完事件 listener 后以本查询为唯一初始态来源
/// （setup 期首发的 conceal-tray-status 必然早于 webview listener，必丢失）。
#[derive(Default, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcealStatus {
    pub tray_available: bool,
    pub tray_error: Option<String>,
    pub boss_primary: Option<String>,
    pub boss_secondary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConcealQuitRequested {
    source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConcealTrayStatusEvent {
    available: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct ConcealPointerZoneEvent {
    zone: PointerZone,
}

// ── 状态 ────────────────────────────────────────────────────────────

/// R2 老板键当前真实注册在系统的组合（None=该键未注册）。
#[derive(Default, Debug, Clone)]
struct BossRegistration {
    primary: Option<String>,
    secondary: Option<String>,
}

impl BossRegistration {
    fn status(&self) -> ConcealBossKeysStatus {
        ConcealBossKeysStatus {
            primary: self.primary.clone(),
            secondary: self.secondary.clone(),
            primary_error: None,
            secondary_error: None,
        }
    }
}

/// R14 托盘创建结果（仅记录，托盘本体由 tauri 内部状态持有）。
#[derive(Default, Debug, Clone)]
struct TrayStatus {
    available: bool,
    error: Option<String>,
}

impl TrayStatus {
    fn event(&self) -> ConcealTrayStatusEvent {
        ConcealTrayStatusEvent {
            available: self.available,
            error: self.error.clone(),
        }
    }
}

/// 逻辑坐标下的窗口外框矩形（R9 会话内缓存，不持久化）。
#[derive(Debug, Clone, Copy)]
struct RectLogical {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl RectLogical {
    fn from_physical(position: (i32, i32), size: (u32, u32), scale: f64) -> Option<RectLogical> {
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        Some(RectLogical {
            x: f64::from(position.0) / scale,
            y: f64::from(position.1) / scale,
            width: f64::from(size.0) / scale,
            height: f64::from(size.1) / scale,
        })
    }
}

/// R9 迷你窗口会话内状态。
#[derive(Default, Debug, Clone, Copy)]
struct MiniState {
    active: bool,
    /// 开启前是否最大化（恢复 rect 后需再补 maximize）。
    pre_maximized: bool,
    pre: Option<RectLogical>,
}

/// R13 交互带（zone）：逻辑 px，相对窗口客户区（viewport）顶部；前端用
/// getBoundingClientRect 实测，故后端必须以 inner_position（客户区原点，
/// 而非 outer_position——decorations:false 下 Windows 仍有不可见 resize
/// 边框，outer≠inner 几像素）为基准换算，两边坐标系才能对齐。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneRect {
    y: f64,
    height: f64,
}

/// R13 交互控件带：完整视口矩形（逻辑 px，相对窗口客户区原点）。顶/底带
/// 之外的可见控件（书架设置入口/设置页、打开的阅读器 chrome 面板）——
/// 不上报则穿透态点击落到后面的窗口，用户无法用鼠标关掉穿透开关。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiZoneRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PointerZone {
    Top,
    Body,
    Bottom,
    Outside,
}

/// R13 轮询运行时。generation 每次启停/重配置自增，旧轮询线程发现失配
/// 即退出，避免线程堆积与旧 zones 残留生效。
#[derive(Debug, Clone)]
struct ClickThroughState {
    enabled: bool,
    top_zone: Option<ZoneRect>,
    bottom_zone: Option<ZoneRect>,
    top_visible: bool,
    bottom_visible: bool,
    ui_zone: Option<UiZoneRect>,
    generation: u64,
    /// None=刚启动，首个 tick 必发一次 conceal-pointer-zone 完成前端初始同步。
    last_zone: Option<PointerZone>,
    last_ignore: Option<bool>,
    zero_streak: u32,
}

impl Default for ClickThroughState {
    fn default() -> Self {
        ClickThroughState {
            enabled: false,
            top_zone: None,
            bottom_zone: None,
            top_visible: true,
            bottom_visible: true,
            ui_zone: None,
            generation: 0,
            last_zone: None,
            last_ignore: None,
            zero_streak: 0,
        }
    }
}

/// 全部摸鱼运行时状态（managed）。
#[derive(Default)]
pub struct ConcealState {
    boss: Mutex<BossRegistration>,
    tray: Mutex<TrayStatus>,
    mini: Mutex<MiniState>,
    click: Mutex<ClickThroughState>,
    /// macOS 托盘双击合成的上次单击时刻（UNIX 毫秒）；其余平台的单击
    /// 直接切换，无需记录。
    #[cfg(target_os = "macos")]
    tray_last_click_ms: Mutex<Option<u64>>,
    /// 主窗口 Resized 事件的唤醒通道（setup 注册一次，等待方借用后归还）。
    resize_wake: Mutex<Option<mpsc::Receiver<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // 中毒说明持锁线程 panic 过；状态本身无不变量耦合，取数据继续比
    // 连锁 panic 更符合摸鱼功能的可用性取向。
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── R2 老板键：纯逻辑 ──────────────────────────────────────────────

/// 单个组合串校验：空串→『组合不能为空』；解析失败（含仅修饰键，
/// global-hotkey 的 parse_hotkey 对 "Alt" 报 UnsupportedKey、对 "Alt+Shift"
/// 报 InvalidFormat，两类都归入同一条文案）→『无效组合或仅修饰键』。
fn classify_combo(raw: &str) -> Result<Shortcut, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("组合不能为空");
    }
    trimmed
        .parse::<Shortcut>()
        .map_err(|_| "无效组合或仅修饰键")
}

/// 两键归一化比较：按解析后的 HotKey（mods+key）相等判定，
/// "Ctrl+Z" 与 "Control+Z" 视为同一组合。
fn combos_same(primary: &Shortcut, secondary: &Shortcut) -> bool {
    primary == secondary
}

// ── R3 老板键 1：纯逻辑 ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BossKeyAction {
    /// 可见且未最小化 → Windows/Linux minimize()、macOS hide()。
    Conceal,
    /// 已最小化或隐藏 → show()+unminimize()+set_focus()。
    Reveal,
}

fn boss_key_action(visible: bool, minimized: bool) -> BossKeyAction {
    if visible && !minimized {
        BossKeyAction::Conceal
    } else {
        BossKeyAction::Reveal
    }
}

// ── R9 迷你窗口：纯逻辑 ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MiniPrologue {
    /// 已最大化：先 unmaximize 并等还原确认，才能取 rect（否则读到最大化
    /// 几何污染 preMiniRect——Windows/GTK 取消最大化返回时 WM 可能未完成）。
    UnmaximizeAndWait,
    RestoreGeometryNow,
}

fn mini_prologue(is_maximized: bool) -> MiniPrologue {
    if is_maximized {
        MiniPrologue::UnmaximizeAndWait
    } else {
        MiniPrologue::RestoreGeometryNow
    }
}

/// 迷你目标尺寸：各维 62%，向下钳到窗口 minWidth/minHeight。
fn mini_target_size(width: f64, height: f64) -> (f64, f64) {
    (
        (width * MINI_SCALE).max(MINI_MIN_WIDTH),
        (height * MINI_SCALE).max(MINI_MIN_HEIGHT),
    )
}

/// 契约要求“宽和高都小于开启前”：任一维不缩小即失败（窗口已过小）。
fn mini_shrink_allowed(original: (f64, f64), target: (f64, f64)) -> bool {
    target.0 < original.0 && target.1 < original.1
}

// ── R13/R7 点击穿透：纯逻辑 ─────────────────────────────────────────

/// 非法 zone（非有限值/非正高度）按“该界面无此区”处理，防止 NaN 比较恒假
/// 让整个带判定失真。
fn sanitize_zone(zone: Option<ZoneRect>) -> Option<ZoneRect> {
    zone.filter(|z| z.y.is_finite() && z.height.is_finite() && z.height > 0.0)
}

/// R13 交互控件带的同口径校验：矩形须有限且宽高为正。
fn sanitize_ui_zone(zone: Option<UiZoneRect>) -> Option<UiZoneRect> {
    zone.filter(|z| {
        z.x.is_finite()
            && z.y.is_finite()
            && z.width.is_finite()
            && z.height.is_finite()
            && z.width > 0.0
            && z.height > 0.0
    })
}

/// 桌面物理坐标 → 客户区逻辑坐标（每 tick 用当前 scale_factor 换算，
/// DPI 变化当 tick 生效）。
fn cursor_to_logical(cursor: (f64, f64), origin: (f64, f64), scale: f64) -> (f64, f64) {
    ((cursor.0 - origin.0) / scale, (cursor.1 - origin.1) / scale)
}

fn zone_contains(zone: ZoneRect, y: f64) -> bool {
    y >= zone.y && y < zone.y + zone.height
}

/// R13 交互控件带命中：含左上，不含右下（与 zone_contains 同口径）。
fn ui_zone_contains(zone: UiZoneRect, x: f64, y: f64) -> bool {
    x >= zone.x && x < zone.x + zone.width && y >= zone.y && y < zone.y + zone.height
}

/// zone 判定：viewport 外→outside；命中 top/bottom 带→对应 zone；
/// 其余（含该区为 None）→body。
fn pointer_zone(
    cursor: (f64, f64),
    viewport: (f64, f64),
    top: Option<ZoneRect>,
    bottom: Option<ZoneRect>,
) -> PointerZone {
    let (x, y) = cursor;
    let (width, height) = viewport;
    if !(x >= 0.0 && y >= 0.0 && x < width && y < height) {
        return PointerZone::Outside;
    }
    if top.is_some_and(|zone| zone_contains(zone, y)) {
        return PointerZone::Top;
    }
    if bottom.is_some_and(|zone| zone_contains(zone, y)) {
        return PointerZone::Bottom;
    }
    PointerZone::Body
}

/// 交互判定：只有“可见的顶/底栏”或 R13 交互控件带（可见按钮所在的矩形，
/// 如书架设置入口/设置页）内的点可交互；正文/背景/已隐藏栏/窗外一律穿透。
fn zone_interactive(zone: PointerZone, top_visible: bool, bottom_visible: bool) -> bool {
    match zone {
        PointerZone::Top => top_visible,
        PointerZone::Bottom => bottom_visible,
        PointerZone::Body | PointerZone::Outside => false,
    }
}

fn should_ignore_cursor(
    zone: PointerZone,
    top_visible: bool,
    bottom_visible: bool,
    ui_zone: Option<UiZoneRect>,
    x: f64,
    y: f64,
) -> bool {
    !(zone_interactive(zone, top_visible, bottom_visible)
        || ui_zone.is_some_and(|rect| ui_zone_contains(rect, x, y)))
}

/// Wayland 会话判定（启用时一次性检查）：WAYLAND_DISPLAY 存在或
/// XDG_SESSION_TYPE=wayland。cursor_position 在 Wayland 恒 (0,0)（tao
/// platform_impl/linux/util.rs），轮询不可用。
fn wayland_session(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some()
        || session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
}

/// 运行期兜底：光标连续多次精确 (0,0) 才认定轮询不可用，避免误伤恰好
/// 位于桌面原点的 X11 光标。
fn zero_cursor_samples_suspicious(streak: u32) -> bool {
    streak >= ZERO_CURSOR_STREAK_LIMIT
}

// ── R1 基线恢复：纯逻辑 ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaselineStep {
    StopClickThrough,
    AlwaysOnTopOff,
    TransparentOff,
    RestoreMiniRect,
}

/// 编辑器基线恢复次序：任一步失败继续其余，最后汇总 Err。轮询只在开启时
/// 需要显式停（幂等：未开启时跳过，可重复调用）。
fn baseline_steps(click_through_enabled: bool, mini_active: bool) -> Vec<BaselineStep> {
    let mut steps = Vec::new();
    if click_through_enabled {
        steps.push(BaselineStep::StopClickThrough);
    }
    steps.push(BaselineStep::AlwaysOnTopOff);
    steps.push(BaselineStep::TransparentOff);
    if mini_active {
        steps.push(BaselineStep::RestoreMiniRect);
    }
    steps
}

// ── R14 托盘：纯逻辑 ───────────────────────────────────────────────

struct TrayTexts {
    tooltip: &'static str,
    toggle: &'static str,
    quit: &'static str,
}

/// 托盘文案跟随系统 UI 语言（前端 i18n 触达不了 Rust 托盘；应用内语言
/// 覆盖无法同步到此处，系统语言是最近似的可用信号）。
fn tray_texts(chinese: bool) -> TrayTexts {
    if chinese {
        TrayTexts {
            tooltip: "轻墨 LightInk",
            toggle: "显示 / 隐藏",
            quit: "退出",
        }
    } else {
        TrayTexts {
            tooltip: "LightInk",
            toggle: "Show / Hide",
            quit: "Quit",
        }
    }
}

fn locale_tag_is_chinese(tag: &str) -> bool {
    tag.trim().to_lowercase().starts_with("zh")
}

/// 系统默认 locale 的 BCP-47 风格标签（如 zh-CN / en-US）。三平台统一为
/// “取标签再判定”，托盘文案逻辑只有一份。
#[cfg(windows)]
fn system_locale_tag() -> String {
    // 返回值含结尾 NUL 的字符数；失败（缓冲不足等）返回 0 或负数。
    const LOCALE_NAME_MAX_LENGTH: usize = 85;
    let mut buffer = [0u16; LOCALE_NAME_MAX_LENGTH];
    let written = unsafe { windows::Win32::Globalization::GetUserDefaultLocaleName(&mut buffer) };
    if written <= 0 {
        return String::new();
    }
    let end = (written as usize).min(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
        .trim_end_matches('\0')
        .to_string()
}

#[cfg(target_os = "macos")]
fn system_locale_tag() -> String {
    objc2_foundation::NSLocale::currentLocale()
        .languageCode()
        .to_string()
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn system_locale_tag() -> String {
    // Linux 无统一 UI 语言 API；LANG/LC_ALL 是桌面会话的既成事实来源。
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
}

fn system_locale_is_chinese() -> bool {
    locale_tag_is_chinese(&system_locale_tag())
}

/// macOS 托盘双击合成：两次单击间隔 ≤500ms 判为双击；时钟回拨（NTP 调整）
/// 的负间隔不算。
/// 纯函数，测试在所有桌面平台执行（cfg(any(macos, test)) 与 window_chrome
/// 的 parse_hex_colorref 同模式）。
#[cfg(any(target_os = "macos", test))]
fn tray_double_click(prev_click_ms: Option<u64>, now_ms: u64) -> bool {
    match prev_click_ms {
        Some(prev) => now_ms
            .checked_sub(prev)
            .is_some_and(|delta| delta <= TRAY_DOUBLE_CLICK_WINDOW_MS),
        None => false,
    }
}

#[cfg(target_os = "macos")]
fn now_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ── 窗口操作小助手 ──────────────────────────────────────────────────

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 恢复窗口：show()+unminimize()+set_focus()（R3 恢复、R14 托盘恢复共用）。
fn restore_window(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// 托盘/老板键 1 的显隐切换：可见→隐藏；不可见→恢复。
/// 恢复失败尽力而为（下一次点击/老板键 1 会重试），不弹系统提示。
fn toggle_main_window_visibility(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        let _ = window.hide();
    } else {
        let _ = restore_window(&window);
    }
}

fn emit_zones_stale(app: &AppHandle) {
    // 无载荷；提示前端重测并重推 conceal_set_click_through 的 zones。
    let _ = app.emit_to(MAIN_WINDOW, EVENT_ZONES_STALE, ());
}

// ── R2/R3/R4 命令与处理器 ───────────────────────────────────────────

/// 老板键 1 处理器（R3）：后端直接执行，不碰前端、不重载书。
fn handle_boss_primary(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    match boss_key_action(visible, minimized) {
        BossKeyAction::Conceal => {
            // Windows/Linux 最小化（任务栏按钮保留可切回）；macOS hide()
            // （最小化会进 Dock 缩略图，隐藏更符合“立刻消失”）。
            #[cfg(target_os = "macos")]
            let _ = window.hide();
            #[cfg(not(target_os = "macos"))]
            let _ = window.minimize();
        }
        BossKeyAction::Reveal => {
            let _ = restore_window(&window);
        }
    }
}

/// 注册失败槽位：unregister_all 失败与主键失败记 primary，副键失败记
/// secondary，供状态回填对应 error 字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BossSlot {
    Primary,
    Secondary,
}

fn register_combo<F>(
    gs: &GlobalShortcut<tauri::Wry>,
    combo: Shortcut,
    handler: F,
) -> Result<(), String>
where
    F: Fn(&AppHandle, &Shortcut, ShortcutState) + Send + Sync + 'static,
{
    // on_shortcut 的回调带完整事件；这里收敛为只关心 Pressed 的高阶封装，
    // 避免每个注册点重复 Released 过滤（macOS 会同时上报按下与释放）。
    gs.on_shortcut(combo, move |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handler(app, _shortcut, event.state());
        }
    })
    .map_err(|e| e.to_string())
}

/// 注册一组组合：先全注销（清掉上一组），再逐键带处理器注册。
fn register_group(
    gs: &GlobalShortcut<tauri::Wry>,
    primary: Shortcut,
    secondary: Shortcut,
) -> Result<(), (BossSlot, String)> {
    gs.unregister_all()
        .map_err(|e| (BossSlot::Primary, format!("注销旧组合失败：{e}")))?;
    register_combo(gs, primary, |app, _, _| handle_boss_primary(app))
        .map_err(|e| (BossSlot::Primary, format!("系统拒绝注册：{e}")))?;
    register_combo(gs, secondary, |app, _, _| {
        // R4：老板键 2 → 前端统一编排（先落快照再退出），后端不直接杀进程。
        let _ = app.emit_to(
            MAIN_WINDOW,
            EVENT_QUIT_REQUESTED,
            ConcealQuitRequested {
                source: QUIT_SOURCE_BOSS_SECONDARY,
            },
        );
    })
    .map_err(|e| (BossSlot::Secondary, format!("系统拒绝注册：{e}")))?;
    Ok(())
}

/// 回滚：重注册上一组 active 组合（unregister_all 已在失败路径清场，
/// 这里再清一次防止部分注册残留）。失败如实返回错误。
fn register_previous_group(
    gs: &GlobalShortcut<tauri::Wry>,
    previous: &BossRegistration,
) -> Result<(), String> {
    let _ = gs.unregister_all();
    let mut first_error: Option<String> = None;
    let mut attach = |combo_str: &Option<String>, install: bool| -> Result<(), ()> {
        let Some(raw) = combo_str else {
            return Ok(());
        };
        let Ok(combo) = classify_combo(raw) else {
            return Ok(()); // 状态里的字符串必然经过校验；防御式跳过
        };
        if install {
            register_combo(gs, combo, |app, _, _| handle_boss_primary(app))
        } else {
            register_combo(gs, combo, |app, _, _| {
                let _ = app.emit_to(
                    MAIN_WINDOW,
                    EVENT_QUIT_REQUESTED,
                    ConcealQuitRequested {
                        source: QUIT_SOURCE_BOSS_SECONDARY,
                    },
                );
            })
        }
        .map_err(|e| {
            first_error.get_or_insert_with(|| format!("恢复上一组合失败：{e}"));
        })
    };
    let _ = attach(&previous.primary, true);
    let _ = attach(&previous.secondary, false);
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// R2 老板键注册（唯一入口，last-good 语义）。
#[tauri::command]
pub fn conceal_register_boss_keys(
    app: AppHandle,
    state: State<'_, ConcealState>,
    primary: String,
    secondary: String,
) -> ConcealBossKeysStatus {
    let gs = app.global_shortcut();
    let previous = lock(&state.boss).clone();
    // 状态字段先按“当前真实注册态”填充：校验失败/注册失败时它就是答案。
    let mut status = previous.status();

    let primary_combo = match classify_combo(&primary) {
        Ok(combo) => Some(combo),
        Err(reason) => {
            status.primary_error = Some(reason.to_string());
            None
        }
    };
    let secondary_combo = match classify_combo(&secondary) {
        Ok(combo) => Some(combo),
        Err(reason) => {
            status.secondary_error = Some(reason.to_string());
            None
        }
    };
    if let (Some(p), Some(s)) = (primary_combo, secondary_combo) {
        if combos_same(&p, &s) {
            status.secondary_error = Some("与老板键 1 相同".to_string());
        }
    }
    // 任一键不合法：不注销旧组、不注册新组（失败的修改不触发任何 R3/R4）。
    if status.primary_error.is_some() || status.secondary_error.is_some() {
        return status;
    }
    let (primary_combo, secondary_combo) = (
        primary_combo.expect("checked"),
        secondary_combo.expect("checked"),
    );

    match register_group(gs, primary_combo, secondary_combo) {
        Ok(()) => {
            let registered = BossRegistration {
                primary: Some(primary.trim().to_string()),
                secondary: Some(secondary.trim().to_string()),
            };
            *lock(&state.boss) = registered.clone();
            registered.status()
        }
        Err((slot, reason)) => {
            // 回滚重注册上一组；成功则 last-good 继续生效并保留失败原因，
            // 失败则必须诚实上报 null+原因（绝不虚报“上一组仍可用”）。
            match register_previous_group(gs, &previous) {
                Ok(()) => {
                    *lock(&state.boss) = previous.clone();
                    match slot {
                        BossSlot::Primary => status.primary_error = Some(reason),
                        BossSlot::Secondary => status.secondary_error = Some(reason),
                    }
                    status
                }
                Err(rollback_error) => {
                    *lock(&state.boss) = BossRegistration::default();
                    let honest = format!("{reason}；恢复上一组合也失败：{rollback_error}");
                    ConcealBossKeysStatus {
                        primary: None,
                        secondary: None,
                        primary_error: Some(honest.clone()),
                        secondary_error: Some(honest),
                    }
                }
            }
        }
    }
}

/// R15 总开关关闭：注销当前老板键组（unregister_all 幂等；无注册时同样 Ok）。
#[tauri::command]
pub fn conceal_unregister_boss_keys(
    app: AppHandle,
    state: State<'_, ConcealState>,
) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("注销组合失败：{e}"))?;
    *lock(&state.boss) = BossRegistration::default();
    Ok(())
}

// ── R8/R6 简单窗口开关命令 ──────────────────────────────────────────

/// R8 置顶：失败返回系统错误文本（前端把开关回 false 并提示）。
#[tauri::command]
pub fn conceal_set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

/// R6 窗口级透明的窗口层应用：视觉透明由前端 CSS 承担，这里处理——
/// - 全平台：透明态摘掉系统外框（Windows 11 给无装饰窗口画的 DWM 投影/
///   描边/圆角一整套来自创建期 `shadow: true`，透明悬浮时不应残留）；
///   关闭态恢复 tauri.conf.json 默认，编辑器外观与升级前一致（R1/R10）。
/// - macOS：再走 window_chrome 统一 paint（transparent 优先，与圆角同一
///   函数改 NSWindow；paint 在后，NSWindow 状态以 paint 为准不冲突）。
fn apply_window_transparent(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_shadow(!enabled).map_err(|e| e.to_string())?;
    window_chrome::apply_macos_window_transparent(window, enabled)
}

/// R6 窗口级透明命令。
#[tauri::command]
pub fn conceal_set_transparent(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    apply_window_transparent(&window, enabled)
}

// ── R9 迷你窗口 ─────────────────────────────────────────────────────

/// 等待取消最大化完成：Resized 事件尽早唤醒 + 轮询校验 is_maximized()
/// 为 false（set_maximized 返回时 WM 可能尚未完成，立即读几何会拿到
/// 最大化尺寸污染 preMiniRect）。阻塞式实现，须在 blocking 上下文调用。
fn wait_for_unmaximize_blocking(
    rx: Option<&mpsc::Receiver<()>>,
    window: &WebviewWindow,
    timeout: Duration,
) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if !window.is_maximized().unwrap_or(false) {
            return Ok(());
        }
        if start.elapsed() >= timeout {
            return Err("窗口状态未稳定".to_string());
        }
        match rx {
            Some(channel) => {
                let _ = channel.recv_timeout(WINDOW_STATE_POLL_STEP);
            }
            None => std::thread::sleep(WINDOW_STATE_POLL_STEP),
        }
    }
}

/// 恢复 preMiniRect：先回几何，再按 pre_maximized 补 maximize（先最大化
/// 会被随后的 set_position/set_size 覆盖）。
fn restore_mini_rect(window: &WebviewWindow, mini: &MiniState) -> Result<(), String> {
    let Some(pre) = mini.pre else {
        return Ok(());
    };
    window
        .set_position(tauri::LogicalPosition::new(pre.x, pre.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(pre.width, pre.height))
        .map_err(|e| e.to_string())?;
    if mini.pre_maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// R9 迷你窗口（会话内 preMiniRect，不持久化）。
#[tauri::command]
pub async fn conceal_set_mini_window(
    app: AppHandle,
    state: State<'_, ConcealState>,
    window: WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        {
            let mini = lock(&state.mini);
            if mini.active {
                return Ok(()); // 已 mini：幂等
            }
        }
        let maximized = window.is_maximized().map_err(|e| e.to_string())?;
        let mut pre_maximized = false;
        if mini_prologue(maximized) == MiniPrologue::UnmaximizeAndWait {
            window.unmaximize().map_err(|e| e.to_string())?;
            // 借用 Resized 唤醒通道（用完归还），阻塞等待放到独立线程执行。
            let rx = lock(&state.resize_wake).take();
            let wait_window = window.clone();
            let (outcome, rx) = tauri::async_runtime::spawn_blocking(move || {
                let result = wait_for_unmaximize_blocking(
                    rx.as_ref(),
                    &wait_window,
                    UNMAXIMIZE_WAIT_TIMEOUT,
                );
                (result, rx)
            })
            .await
            .map_err(|e| e.to_string())?;
            *lock(&state.resize_wake) = rx;
            // 超时：开关回退（不记 rect、不改尺寸），错误文本固定。
            outcome.map_err(|_| "窗口状态未稳定".to_string())?;
            pre_maximized = true;
        }
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let Some(pre) =
            RectLogical::from_physical((position.x, position.y), (size.width, size.height), scale)
        else {
            return Err("窗口状态未稳定".to_string());
        };
        let target = mini_target_size(pre.width, pre.height);
        if !mini_shrink_allowed((pre.width, pre.height), target) {
            return Err("窗口已过小，无法再缩小".to_string());
        }
        window
            .set_size(tauri::LogicalSize::new(target.0, target.1))
            .map_err(|e| e.to_string())?;
        {
            let mut mini = lock(&state.mini);
            mini.active = true;
            mini.pre_maximized = pre_maximized;
            mini.pre = Some(pre);
        }
        emit_zones_stale(&app);
        Ok(())
    } else {
        // 快照后立即放锁：restore 的 set_position/set_size/maximize 均要派发
        // 主线程执行，持 mini 锁等待会与取锁方互等成死锁；且无论恢复成败都
        // 要清理 active，否则「关闭失败→仍 active→再开启命中幂等早退」会让
        // 前后端状态失步（开关显示开启而窗口不缩小）。
        let snapshot = {
            let mini = lock(&state.mini);
            if !mini.active {
                return Ok(()); // 未 mini：幂等
            }
            *mini
        };
        let restore = restore_mini_rect(&window, &snapshot);
        {
            let mut mini = lock(&state.mini);
            mini.active = false;
            mini.pre_maximized = false;
            mini.pre = None;
        }
        restore?;
        emit_zones_stale(&app);
        Ok(())
    }
}

// ── R1 基线恢复 ─────────────────────────────────────────────────────

/// 停穿透轮询并恢复接收指针；失败记入 errors 继续后续步骤。
fn disable_click_through(state: &ConcealState, window: &WebviewWindow, errors: &mut Vec<String>) {
    {
        let mut click = lock(&state.click);
        click.enabled = false;
        click.generation += 1;
        click.last_zone = None;
        click.last_ignore = None;
        click.zero_streak = 0;
        click.ui_zone = None;
    }
    // set_ignore_cursor_events 要派发主线程执行，不得持 click 锁等待，
    // 否则与主线程上的取锁方互等成 ABBA 死锁（整窗冻结）。
    if let Err(error) = window.set_ignore_cursor_events(false) {
        errors.push(format!("恢复指针接收失败：{error}"));
    }
}

/// R1 进入编辑器：一键撤销全部窗口效果（幂等，可重复调用）。任一步失败
/// 继续其余，最后汇总 Err（前端收到 Err 仅提示，编辑器表面仍按无效果呈现）。
#[tauri::command]
pub async fn conceal_restore_window_baseline(
    app: AppHandle,
    state: State<'_, ConcealState>,
    window: WebviewWindow,
) -> Result<(), String> {
    let click_through_enabled = lock(&state.click).enabled;
    let mini = *lock(&state.mini);
    let mut errors = Vec::new();
    // 次序与 baseline_steps 一致：停穿透→摘置顶→关窗口透明→恢复 mini 几何。
    for step in baseline_steps(click_through_enabled, mini.active) {
        match step {
            BaselineStep::StopClickThrough => {
                disable_click_through(&state, &window, &mut errors);
            }
            BaselineStep::AlwaysOnTopOff => {
                if let Err(error) = window.set_always_on_top(false) {
                    errors.push(format!("取消置顶失败：{error}"));
                }
            }
            BaselineStep::TransparentOff => {
                if let Err(error) = apply_window_transparent(&window, false) {
                    errors.push(format!("关闭透明失败：{error}"));
                }
            }
            BaselineStep::RestoreMiniRect => {
                // 同 conceal_set_mini_window 关闭分支：快照放锁再恢复，
                // 恢复成败都清理 mini 状态，避免失败后 active 残留失步。
                let snapshot = *lock(&state.mini);
                if let Err(error) = restore_mini_rect(&window, &snapshot) {
                    errors.push(format!("恢复窗口几何失败：{error}"));
                }
                let mut mini = lock(&state.mini);
                mini.active = false;
                mini.pre_maximized = false;
                mini.pre = None;
            }
        }
    }
    if mini.active && errors.is_empty() {
        emit_zones_stale(&app);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

// ── R13 点击穿透轮询 ────────────────────────────────────────────────

/// 单次轮询：三段式——锁内快照决策输入 → 锁外做窗口往返 → 锁内写回。
/// cursor/scale/inner 几何与 set_ignore_cursor_events 都要派发到主线程
/// 等待执行，绝不能持 click 锁跨这些调用：Tauri 的同步命令在主线程上
/// 运行并取同一把锁，会互等成 ABBA 死锁（整窗冻结）。写回以 generation
/// 失配作废，被重配置接管的新轮询线程会重推窗口状态。
fn click_through_tick(app: &AppHandle, window: &WebviewWindow, state: &ConcealState) -> bool {
    let (
        generation,
        mut zero_streak,
        top_zone,
        bottom_zone,
        ui_zone,
        top_visible,
        bottom_visible,
        mut last_zone,
        mut last_ignore,
    ) = {
        let click = lock(&state.click);
        if !click.enabled {
            return false;
        }
        (
            click.generation,
            click.zero_streak,
            click.top_zone,
            click.bottom_zone,
            click.ui_zone,
            click.top_visible,
            click.bottom_visible,
            click.last_zone,
            click.last_ignore,
        )
    };
    let Ok(cursor) = window.cursor_position() else {
        return true;
    };
    // Wayland 恒 (0,0)：连续多次精确零读数才停轮询（单次会误伤 X11 原点）。
    let mut stop = false;
    if cursor.x == 0.0 && cursor.y == 0.0 {
        zero_streak += 1;
        if zero_cursor_samples_suspicious(zero_streak) {
            stop = true;
            let _ = window.set_ignore_cursor_events(false);
        }
    } else {
        zero_streak = 0;
    }
    let Ok(scale) = window.scale_factor() else {
        return true;
    };
    if !scale.is_finite() || scale <= 0.0 {
        return true;
    }
    let Ok(inner_position) = window.inner_position() else {
        return true;
    };
    let Ok(inner_size) = window.inner_size() else {
        return true;
    };
    let logical = cursor_to_logical(
        (cursor.x, cursor.y),
        (f64::from(inner_position.x), f64::from(inner_position.y)),
        scale,
    );
    let viewport = (
        f64::from(inner_size.width) / scale,
        f64::from(inner_size.height) / scale,
    );
    let zone = pointer_zone(logical, viewport, top_zone, bottom_zone);
    let mut zone_changed = false;
    if last_zone != Some(zone) {
        // 穿透态下 R7 的唯一指针输入源（与 DOM pointermove 同一前端状态机入口）。
        let _ = app.emit_to(
            MAIN_WINDOW,
            EVENT_POINTER_ZONE,
            ConcealPointerZoneEvent { zone },
        );
        last_zone = Some(zone);
        zone_changed = true;
    }
    let ignore = should_ignore_cursor(
        zone,
        top_visible,
        bottom_visible,
        ui_zone,
        logical.0,
        logical.1,
    );
    let mut ignore_applied = false;
    if last_ignore != Some(ignore) {
        // 可见栏可点；正文/背景/已隐藏栏点击落到后面窗口。
        if window.set_ignore_cursor_events(ignore).is_ok() {
            last_ignore = Some(ignore);
            ignore_applied = true;
        }
    }
    {
        let mut click = lock(&state.click);
        if !click.enabled || click.generation != generation {
            // 已被禁用/重配置接管：本 tick 的窗口副作用由接管方校正，直接退线。
            return false;
        }
        click.zero_streak = zero_streak;
        if zone_changed {
            click.last_zone = last_zone;
        }
        if ignore_applied {
            click.last_ignore = last_ignore;
        }
        if stop {
            click.enabled = false;
        }
    }
    !stop
}

fn spawn_click_through_poll(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let Some(window) = main_window(&app) else {
            return;
        };
        loop {
            let state = app.state::<ConcealState>();
            // tick 内部分段持锁且不跨窗口调用；generation 失配即被接管退线。
            if lock(&state.click).generation != generation {
                break;
            }
            if !click_through_tick(&app, &window, &state) {
                break;
            }
            std::thread::sleep(CLICK_THROUGH_POLL_INTERVAL);
        }
    });
}

/// R13+R7 点击穿透与指针分区（后端 60ms 轮询，zones 为逻辑 px、相对窗口
/// 客户区顶部）。每次调用即时替换 zones/visible（前端在显隐变化、resize、
/// DPI、mini 开关、表面切换后重推）。契约参数：enabled/topZone/bottomZone/
/// topVisible/bottomVisible/uiZone（uiZone 为 R13 交互控件带矩形，可空）。
/// 参数数量超过 clippy 默认上限是契约形状决定的，此处显式豁免。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn conceal_set_click_through(
    app: AppHandle,
    state: State<'_, ConcealState>,
    enabled: bool,
    top_zone: Option<ZoneRect>,
    bottom_zone: Option<ZoneRect>,
    ui_zone: Option<UiZoneRect>,
    top_visible: bool,
    bottom_visible: bool,
) -> Result<(), String> {
    let Some(window) = main_window(&app) else {
        return Err("主窗口不存在".to_string());
    };
    if !enabled {
        let mut click = lock(&state.click);
        click.enabled = false;
        click.generation += 1;
        click.last_zone = None;
        click.last_ignore = None;
        click.zero_streak = 0;
        click.ui_zone = None;
        drop(click);
        return window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string());
    }
    // Wayland（cursor_position 恒 0）轮询不可用：启用即拒，前端关开关并提示。
    if wayland_session(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    ) {
        return Err("当前会话不支持点击穿透".to_string());
    }
    let generation = {
        let mut click = lock(&state.click);
        click.enabled = true;
        click.top_zone = sanitize_zone(top_zone);
        click.bottom_zone = sanitize_zone(bottom_zone);
        click.ui_zone = sanitize_ui_zone(ui_zone);
        click.top_visible = top_visible;
        click.bottom_visible = bottom_visible;
        click.generation += 1;
        // 重置 last_zone：首个 tick 必发一次 zone 事件，完成前端初始同步。
        click.last_zone = None;
        click.last_ignore = None;
        click.zero_streak = 0;
        click.generation
    };
    spawn_click_through_poll(app, generation);
    Ok(())
}

// ── R14 托盘与退出 ──────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let texts = tray_texts(system_locale_is_chinese());
    let toggle = MenuItem::with_id(app, TRAY_MENU_TOGGLE, texts.toggle, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT, texts.quit, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&toggle, &quit]).map_err(|e| e.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "缺少默认窗口图标，无法创建托盘".to_string())?;

    // 左键不弹菜单（Windows/Linux 左键=切换显隐，macOS 左键留给双击合成，
    // 菜单经右键打开），菜单事件与图标事件共用显隐切换与退出编排。
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(texts.tooltip)
        .icon(icon)
        .on_menu_event(|app, event| match event.id().as_ref() {
            id if id == TRAY_MENU_TOGGLE => toggle_main_window_visibility(app),
            id if id == TRAY_MENU_QUIT => {
                // 退出走前端 conceal-quit 编排（先落快照），后端不直接杀进程。
                let _ = app.emit_to(
                    MAIN_WINDOW,
                    EVENT_QUIT_REQUESTED,
                    ConcealQuitRequested {
                        source: QUIT_SOURCE_TRAY_MENU,
                    },
                );
            }
            _ => {}
        })
        // Linux 单击切换（R14）已启用：tray-icon 0.25 起 Linux 侧有 ksni
        // （StatusNotifier DBus）后端，会发出左键/中键激活事件；本 crate 在
        // Cargo.toml 以 features=["ksni"] 直接依赖 tray-icon 0.25，与 tauri
        // 自带的 libappindicator feature 统一到同一实例——两个后端 feature
        // 同启时 ksni 胜出（Cargo 会发一条无害警告，属预期）。ksni 的
        // activate（左键）/secondary_activate（中键）经
        // TrayIconEvent::send 发 Click{Left/Middle, Up}，正好命中下面的
        // 分支；托盘菜单（on_menu_event 走 muda 快照）仍为右键备用路径。
        // 注意：ksni 发出的事件 rect 恒为空（Rect::default() 零位置零尺寸），
        // 当前代码不消费 rect；将来若要取 rect 必须判空。
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                #[cfg(not(target_os = "macos"))]
                toggle_main_window_visibility(app);
                // macOS：tray-icon 0.25 仍只发 Click（无 DoubleClick），双击需自行合成。
                #[cfg(target_os = "macos")]
                handle_macos_tray_click(app);
            }
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                // Windows 的单击路径已处理，这里只兜 macOS（当前版本不发，
                // 保留以防 tray-icon 升级后语义变化）。
                #[cfg(target_os = "macos")]
                toggle_main_window_visibility(tray.app_handle());
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    // 返回的句柄可安全 drop：tauri 的 resources table 已持有同一实例，
    // 托盘常驻直到 conceal_exit_app 的 remove_tray_by_id 显式摘除。
    drop(tray);
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_macos_tray_click(app: &AppHandle) {
    let now = now_unix_millis();
    let state = app.state::<ConcealState>();
    let mut last = lock(&state.tray_last_click_ms);
    let is_double = tray_double_click(*last, now);
    *last = if is_double { None } else { Some(now) };
    drop(last);
    if is_double {
        toggle_main_window_visibility(app);
    }
}

/// R14 点关闭收到托盘：仅 window.hide()，进度/未保存编辑/界面全保留。
#[tauri::command]
pub fn conceal_hide_to_tray(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// R14 托盘恢复（托盘单击/双击/菜单与第二实例路径共用）。
#[tauri::command]
pub fn conceal_restore_from_tray(window: WebviewWindow) -> Result<(), String> {
    restore_window(&window)
}

/// R15 总开关关闭：摘除托盘图标并广播不可用（幂等；托盘本就不在时同样 Ok）。
/// 托盘菜单的退出/显隐入口随图标消失而失效，无残留窗口效果。
#[tauri::command]
pub fn conceal_remove_tray(app: AppHandle, state: State<'_, ConcealState>) -> Result<(), String> {
    let _ = app.remove_tray_by_id(TRAY_ID);
    let status = TrayStatus {
        available: false,
        error: None,
    };
    *lock(&state.tray) = status.clone();
    let _ = app.emit_to(MAIN_WINDOW, EVENT_TRAY_STATUS, status.event());
    Ok(())
}

/// R15 重新开启：托盘缺位时原地重建（幂等；已存在直接 Ok），结果经
/// conceal-tray-status 事件与 conceal_get_status 双通道同步给前端。
#[tauri::command]
pub fn conceal_ensure_tray(app: AppHandle, state: State<'_, ConcealState>) -> Result<(), String> {
    if lock(&state.tray).available {
        return Ok(()); // 已在：幂等
    }
    let status = match build_tray(&app) {
        Ok(()) => TrayStatus {
            available: true,
            error: None,
        },
        Err(error) => TrayStatus {
            available: false,
            error: Some(error),
        },
    };
    *lock(&state.tray) = status.clone();
    let _ = app.emit_to(MAIN_WINDOW, EVENT_TRAY_STATUS, status.event());
    match status.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 启动与托盘状态同步的唯一权威来源。
#[tauri::command]
pub fn conceal_get_status(state: State<'_, ConcealState>) -> ConcealStatus {
    let tray = lock(&state.tray).clone();
    let boss = lock(&state.boss).clone();
    ConcealStatus {
        tray_available: tray.available,
        tray_error: tray.error,
        boss_primary: boss.primary,
        boss_secondary: boss.secondary,
    }
}

/// R4 终退出口（老板键 2、托盘菜单退出、File→退出菜单共用；仅在前端完成
/// 快照落盘后调用）：摘除托盘图标后 app.exit(0)。
#[tauri::command]
pub fn conceal_exit_app(app: AppHandle) -> Result<(), String> {
    // drop 返回的 TrayIcon 使托盘立即消失（进程随后结束也会被系统回收，
    // 这里显式摘除保证时序）。
    let _ = app.remove_tray_by_id(TRAY_ID);
    app.exit(0);
    Ok(())
}

// ── setup 期初始化（lib.rs 调用） ───────────────────────────────────

/// 桌面 setup：注册主窗口 Resized 唤醒通道（R9 等待还原用，一次性注册
/// 避免每次等待泄漏一个事件闭包），并创建 R14 托盘。
pub fn setup_desktop(app: &AppHandle) {
    let (resize_tx, resize_rx) = mpsc::channel::<()>();
    *lock(&app.state::<ConcealState>().resize_wake) = Some(resize_rx);
    if let Some(main) = main_window(app) {
        main.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let _ = resize_tx.send(());
            }
        });
    }

    let tray_status = match build_tray(app) {
        Ok(()) => TrayStatus {
            available: true,
            error: None,
        },
        Err(error) => TrayStatus {
            available: false,
            error: Some(error),
        },
    };
    *lock(&app.state::<ConcealState>().tray) = tray_status.clone();
    // 运行期重推信号；setup 期首发时 webview listener 必然未就绪、必丢失，
    // 启动初始态以 conceal_get_status 查询为准（契约明示）。
    let _ = app.emit_to(MAIN_WINDOW, EVENT_TRAY_STATUS, tray_status.event());
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── R2 组合校验/归一化 ───────────────────────────────────────────

    #[test]
    fn boss_combo_classification_covers_empty_invalid_and_valid() {
        assert_eq!(classify_combo(""), Err("组合不能为空"));
        assert_eq!(classify_combo("   "), Err("组合不能为空"));
        // 仅修饰键：单 token 走 parse_key 拒绝，多 token 缺主键拒绝。
        assert_eq!(classify_combo("Alt"), Err("无效组合或仅修饰键"));
        assert_eq!(classify_combo("Alt+Shift"), Err("无效组合或仅修饰键"));
        assert_eq!(classify_combo("Control+Shift"), Err("无效组合或仅修饰键"));
        assert_eq!(classify_combo("Alt+Z+X"), Err("无效组合或仅修饰键"));
        assert!(classify_combo("Alt+Z").is_ok());
        assert!(classify_combo("Control+Shift+X").is_ok());
        assert!(classify_combo(" alt+z ").is_ok(), "输入应容忍空白");
    }

    #[test]
    fn boss_combo_normalization_treats_aliases_as_same() {
        let ctrl = classify_combo("Control+Z").expect("valid");
        let alias = classify_combo("Ctrl+Z").expect("valid");
        let lower = classify_combo("control+z").expect("valid");
        let alt = classify_combo("Alt+Z").expect("valid");
        assert!(combos_same(&ctrl, &alias));
        assert!(combos_same(&ctrl, &lower));
        assert!(!combos_same(&ctrl, &alt), "Alt 与 Control 是不同组合");
        let shift = classify_combo("Control+Shift+Z").expect("valid");
        assert!(!combos_same(&ctrl, &shift), "修饰键差异必须区分");
    }

    #[test]
    fn boss_registration_status_reflects_active_combos() {
        let registration = BossRegistration {
            primary: Some("Alt+Z".into()),
            secondary: Some("Alt+X".into()),
        };
        let status = registration.status();
        assert_eq!(status.primary.as_deref(), Some("Alt+Z"));
        assert_eq!(status.secondary.as_deref(), Some("Alt+X"));
        assert!(status.primary_error.is_none() && status.secondary_error.is_none());
    }

    // ── R3 判定 ──────────────────────────────────────────────────────

    #[test]
    fn boss_key_action_conceals_only_when_visible_and_not_minimized() {
        assert_eq!(boss_key_action(true, false), BossKeyAction::Conceal);
        assert_eq!(boss_key_action(true, true), BossKeyAction::Reveal);
        assert_eq!(boss_key_action(false, false), BossKeyAction::Reveal);
        assert_eq!(boss_key_action(false, true), BossKeyAction::Reveal);
    }

    // ── R9 迷你窗口 ──────────────────────────────────────────────────

    #[test]
    fn mini_prologue_waits_only_when_maximized() {
        assert_eq!(
            mini_prologue(true),
            MiniPrologue::UnmaximizeAndWait,
            "最大化态必须先取消并等还原确认再取 rect"
        );
        assert_eq!(mini_prologue(false), MiniPrologue::RestoreGeometryNow);
    }

    #[test]
    fn mini_target_size_scales_then_clamps_to_window_minimums() {
        let (width, height) = mini_target_size(1024.0, 768.0);
        assert!((width - 634.88).abs() < 1e-9, "got {width}");
        assert!((height - 476.16).abs() < 1e-9, "got {height}");
        // 62% 低于下限时钳到 480×360（对齐 tauri.conf.json）。
        assert_eq!(mini_target_size(500.0, 400.0), (480.0, 360.0));
    }

    #[test]
    fn mini_requires_both_dimensions_to_shrink() {
        let original = (1024.0, 768.0);
        assert!(mini_shrink_allowed(
            original,
            mini_target_size(original.0, original.1)
        ));
        // 已在下限附近：钳后任一维不小于原值 → 拒绝。
        assert!(!mini_shrink_allowed(
            (480.0, 360.0),
            mini_target_size(480.0, 360.0)
        ));
        assert!(!mini_shrink_allowed(
            (480.0, 768.0),
            mini_target_size(480.0, 768.0)
        ));
        assert!(!mini_shrink_allowed(
            (1024.0, 360.0),
            mini_target_size(1024.0, 360.0)
        ));
    }

    #[test]
    fn rect_logical_conversion_uses_scale() {
        let rect =
            RectLogical::from_physical((1920, 1080), (2048, 1536), 2.0).expect("valid scale");
        assert!((rect.x - 960.0).abs() < f64::EPSILON);
        assert!((rect.y - 540.0).abs() < f64::EPSILON);
        assert!((rect.width - 1024.0).abs() < f64::EPSILON);
        assert!((rect.height - 768.0).abs() < f64::EPSILON);
        assert!(RectLogical::from_physical((0, 0), (100, 100), 0.0).is_none());
        assert!(RectLogical::from_physical((0, 0), (100, 100), f64::NAN).is_none());
    }

    // ── R13/R7 zone 与交互带 ─────────────────────────────────────────

    fn zone(y: f64, height: f64) -> Option<ZoneRect> {
        Some(ZoneRect { y, height })
    }

    #[test]
    fn pointer_zone_matrix_covers_all_bands_and_outside() {
        let top = zone(0.0, 48.0);
        let bottom = zone(700.0, 40.0);
        let viewport = (1024.0, 768.0);
        assert_eq!(
            pointer_zone((10.0, 10.0), viewport, top, bottom),
            PointerZone::Top
        );
        assert_eq!(
            pointer_zone((10.0, 100.0), viewport, top, bottom),
            PointerZone::Body
        );
        assert_eq!(
            pointer_zone((10.0, 720.0), viewport, top, bottom),
            PointerZone::Bottom
        );
        assert_eq!(
            pointer_zone((-1.0, 10.0), viewport, top, bottom),
            PointerZone::Outside
        );
        assert_eq!(
            pointer_zone((10.0, -0.5), viewport, top, bottom),
            PointerZone::Outside
        );
        assert_eq!(
            pointer_zone((1024.0, 10.0), viewport, top, bottom),
            PointerZone::Outside,
            "右边界外（x==width）视为窗外"
        );
        assert_eq!(
            pointer_zone((10.0, 768.0), viewport, top, bottom),
            PointerZone::Outside
        );
        // 书架无底栏：bottomZone=null 时底部命中按 body 处理。
        assert_eq!(
            pointer_zone((10.0, 720.0), viewport, top, None),
            PointerZone::Body
        );
        // 带边界：含头不含尾。
        assert_eq!(
            pointer_zone((5.0, 48.0), viewport, top, bottom),
            PointerZone::Body
        );
    }

    #[test]
    fn only_visible_bands_stay_interactive() {
        // 可见顶带→不穿透；隐藏顶带→穿透；正文/窗外恒穿透。
        assert!(!should_ignore_cursor(
            PointerZone::Top,
            true,
            false,
            None,
            0.0,
            0.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Top,
            false,
            false,
            None,
            0.0,
            0.0
        ));
        assert!(!should_ignore_cursor(
            PointerZone::Bottom,
            false,
            true,
            None,
            0.0,
            0.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Bottom,
            false,
            false,
            None,
            0.0,
            0.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            None,
            0.0,
            0.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Outside,
            true,
            true,
            None,
            0.0,
            0.0
        ));
    }

    #[test]
    fn ui_zone_keeps_visible_controls_clickable_in_body_band() {
        // R13：书架设置入口/设置页等可见控件矩形内的点击由 LightInk 接收，
        // 矩形外（封面墙/正文/背景）仍穿透；带为 None 时正文带全穿透。
        let ui = UiZoneRect {
            x: 8.0,
            y: 300.0,
            width: 240.0,
            height: 360.0,
        };
        assert!(!should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            Some(ui),
            100.0,
            400.0
        ));
        // 含左上、不含右下（与顶/底带同口径）。
        assert!(!should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            Some(ui),
            8.0,
            300.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            Some(ui),
            248.0,
            660.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            Some(ui),
            600.0,
            400.0
        ));
        assert!(should_ignore_cursor(
            PointerZone::Body,
            true,
            true,
            None,
            100.0,
            400.0
        ));
    }

    #[test]
    fn ui_zone_sanitizing_rejects_non_finite_or_empty_rects() {
        let valid = UiZoneRect {
            x: 0.0,
            y: 10.0,
            width: 100.0,
            height: 50.0,
        };
        assert_eq!(sanitize_ui_zone(Some(valid)), Some(valid));
        assert_eq!(sanitize_ui_zone(None), None);
        assert_eq!(
            sanitize_ui_zone(Some(UiZoneRect {
                x: 0.0,
                y: 10.0,
                width: 0.0,
                height: 50.0
            })),
            None,
            "零宽矩形无效"
        );
        assert_eq!(
            sanitize_ui_zone(Some(UiZoneRect {
                x: f64::NAN,
                y: 10.0,
                width: 100.0,
                height: 50.0
            })),
            None
        );
        assert_eq!(
            sanitize_ui_zone(Some(UiZoneRect {
                x: 0.0,
                y: 10.0,
                width: 100.0,
                height: f64::INFINITY
            })),
            None
        );
    }

    #[test]
    fn cursor_dpi_conversion_and_zone_sanitizing() {
        // 200% DPI：物理 (200,300) 相对客户区原点 (100,100) → 逻辑 (50,100)。
        let logical = cursor_to_logical((200.0, 300.0), (100.0, 100.0), 2.0);
        assert_eq!(logical, (50.0, 100.0));
        assert_eq!(sanitize_zone(zone(10.0, 20.0)), zone(10.0, 20.0));
        assert_eq!(sanitize_zone(None), None);
        assert_eq!(sanitize_zone(zone(10.0, 0.0)), None, "零高度带无效");
        assert_eq!(sanitize_zone(zone(f64::NAN, 20.0)), None);
        assert_eq!(sanitize_zone(zone(10.0, f64::INFINITY)), None);
    }

    #[test]
    fn wayland_detection_needs_env_evidence_or_persistent_zero() {
        assert!(wayland_session(Some("wayland-0"), None));
        assert!(wayland_session(None, Some("wayland")));
        assert!(wayland_session(None, Some("Wayland")), "大小写不敏感");
        assert!(!wayland_session(None, Some("x11")));
        assert!(!wayland_session(None, None));
        // X11 光标恰好停在桌面原点：单次零读数不判定，连续多次才停。
        assert!(!zero_cursor_samples_suspicious(0));
        assert!(!zero_cursor_samples_suspicious(4));
        assert!(zero_cursor_samples_suspicious(5));
    }

    // ── R1 基线次序与幂等 ───────────────────────────────────────────

    #[test]
    fn baseline_steps_order_and_idempotent_repeats() {
        assert_eq!(
            baseline_steps(true, true),
            vec![
                BaselineStep::StopClickThrough,
                BaselineStep::AlwaysOnTopOff,
                BaselineStep::TransparentOff,
                BaselineStep::RestoreMiniRect,
            ]
        );
        // 再次调用（全部已关）：只剩恒等步骤，天然幂等。
        assert_eq!(
            baseline_steps(false, false),
            vec![BaselineStep::AlwaysOnTopOff, BaselineStep::TransparentOff]
        );
        assert_eq!(
            baseline_steps(true, false),
            vec![
                BaselineStep::StopClickThrough,
                BaselineStep::AlwaysOnTopOff,
                BaselineStep::TransparentOff
            ]
        );
    }

    // ── R14 托盘 ─────────────────────────────────────────────────────

    #[test]
    fn tray_texts_follow_system_language() {
        let chinese = tray_texts(true);
        let english = tray_texts(false);
        assert_eq!(chinese.toggle, "显示 / 隐藏");
        assert_eq!(chinese.quit, "退出");
        assert_eq!(english.toggle, "Show / Hide");
        assert_eq!(english.quit, "Quit");
        assert!(!chinese.tooltip.is_empty() && !english.tooltip.is_empty());
    }

    #[test]
    fn locale_tags_detect_chinese_variants_only() {
        assert!(locale_tag_is_chinese("zh-CN"));
        assert!(locale_tag_is_chinese("zh_TW.UTF-8"));
        assert!(locale_tag_is_chinese(" ZH-Hans "));
        assert!(!locale_tag_is_chinese("en-US"));
        assert!(!locale_tag_is_chinese("ja_JP"));
        assert!(!locale_tag_is_chinese(""));
    }

    #[test]
    fn macos_tray_double_click_needs_two_clicks_in_window() {
        assert!(!tray_double_click(None, 1_000));
        assert!(!tray_double_click(Some(1_000), 1_600), "间隔超窗不算");
        assert!(tray_double_click(Some(1_000), 1_400));
        assert!(tray_double_click(Some(1_000), 1_500), "恰好 500ms 算双击");
        assert!(!tray_double_click(Some(2_000), 1_000), "时钟回拨不算");
    }

    // ── R2 回滚上报诚实性 ───────────────────────────────────────────

    #[test]
    fn rollback_failure_reports_null_slots_with_reason() {
        // 回滚重注册也失败：绝不按 last-good 虚报，两键 null + 双侧错误。
        let status = ConcealBossKeysStatus {
            primary: None,
            secondary: None,
            primary_error: Some("系统拒绝注册：busy；恢复上一组合也失败：denied".into()),
            secondary_error: Some("系统拒绝注册：busy；恢复上一组合也失败：denied".into()),
        };
        assert!(status.primary.is_none() && status.secondary.is_none());
        assert!(status
            .primary_error
            .as_deref()
            .unwrap()
            .contains("恢复上一组合也失败"));
        assert!(status
            .secondary_error
            .as_deref()
            .unwrap()
            .contains("恢复上一组合也失败"));
    }

    #[test]
    fn serde_payloads_use_camel_case_and_contract_event_names() {
        let quit = serde_json::to_value(ConcealQuitRequested {
            source: QUIT_SOURCE_BOSS_SECONDARY,
        })
        .expect("serialize");
        assert_eq!(quit["source"], "boss-secondary");
        let tray = serde_json::to_value(TrayStatus::default().event()).expect("serialize");
        assert_eq!(tray["available"], false);
        assert!(tray["error"].is_null());
        let zone = serde_json::to_value(ConcealPointerZoneEvent {
            zone: PointerZone::Bottom,
        })
        .expect("serialize");
        assert_eq!(zone["zone"], "bottom");
        let status = serde_json::to_value(ConcealStatus::default()).expect("serialize");
        assert_eq!(status["trayAvailable"], false);
        assert!(status["bossPrimary"].is_null());
        assert!(status["bossSecondary"].is_null());
        let keys = serde_json::to_value(ConcealBossKeysStatus {
            primary: Some("Alt+Z".into()),
            secondary: None,
            primary_error: None,
            secondary_error: Some("与老板键 1 相同".into()),
        })
        .expect("serialize");
        assert_eq!(keys["primary"], "Alt+Z");
        assert_eq!(keys["secondaryError"], "与老板键 1 相同");
        // 契约事件名冻结，防手滑改动。
        assert_eq!(EVENT_QUIT_REQUESTED, "conceal-quit-requested");
        assert_eq!(EVENT_TRAY_STATUS, "conceal-tray-status");
        assert_eq!(EVENT_POINTER_ZONE, "conceal-pointer-zone");
        assert_eq!(EVENT_ZONES_STALE, "conceal-zones-stale");
    }

    #[test]
    fn zone_rect_deserializes_camel_case_fields() {
        let parsed: ZoneRect =
            serde_json::from_str("{\"y\":12.5,\"height\":40.0}").expect("deserialize");
        assert_eq!(
            parsed,
            ZoneRect {
                y: 12.5,
                height: 40.0
            }
        );
    }

    #[test]
    fn ui_zone_rect_deserializes_contract_fields() {
        let parsed: UiZoneRect =
            serde_json::from_str("{\"x\":8.0,\"y\":300.0,\"width\":240.0,\"height\":360.0}")
                .expect("deserialize");
        assert_eq!(
            parsed,
            UiZoneRect {
                x: 8.0,
                y: 300.0,
                width: 240.0,
                height: 360.0
            }
        );
    }
}
