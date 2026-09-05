//! Native window chrome: caption tint and outer rounding.
//!
//! - Windows 11: DWM caption / text tint and `DWMWA_WINDOW_CORNER_PREFERENCE`
//! - macOS: transparent titlebar + window background; contentView layer radius
//! - Linux: GTK CSS on client-side decorations (GNOME). Server-side
//!   window-manager bars (many KDE / XFCE / i3 setups) only follow light/dark.
//!   Outer rounding is a no-op so we do not stack on the compositor.

/// Parse `#rrggbb` into `(red, green, blue)`.
///
/// 仅桌面实现（与 `set_window_caption_color` 的 cfg(desktop) 注册对齐）与
/// 单元测试使用；移动端编译期排除，避免死代码。
#[cfg(any(desktop, test))]
pub fn parse_hex_rgb(raw: &str) -> Option<(u8, u8, u8)> {
    let hex = raw.strip_prefix('#')?;
    if hex.len() != 6 || !hex.as_bytes().iter().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some((
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    ))
}

/// Parse `#rrggbb` into a Windows COLORREF (`0x00bbggrr`).
#[cfg(any(windows, test))]
pub fn parse_hex_colorref(raw: &str) -> Option<u32> {
    let (red, green, blue) = parse_hex_rgb(raw)?;
    Some(u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16))
}

/// Restored windows keep native outer rounding; maximize and fullscreen go square.
#[cfg(test)]
pub fn window_outer_should_round(maximized: bool, fullscreen: bool) -> bool {
    !maximized && !fullscreen
}

/// DWMWA_WINDOW_CORNER_PREFERENCE (Windows 11).
#[cfg(any(windows, test))]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(any(windows, test))]
const DWMWCP_DONOTROUND: u32 = 1;
#[cfg(any(windows, test))]
const DWMWCP_ROUND: u32 = 2;

#[cfg(any(windows, test))]
pub fn windows_corner_preference(rounded: bool) -> u32 {
    if rounded {
        DWMWCP_ROUND
    } else {
        DWMWCP_DONOTROUND
    }
}

/// Restored macOS content layer radius in points (system 10–12pt range).
#[cfg(any(target_os = "macos", test))]
const MACOS_RESTORED_CORNER_RADIUS_PT: f64 = 12.0;

#[cfg(any(target_os = "macos", test))]
pub fn macos_content_corner_radius_pt(rounded: bool) -> f64 {
    if rounded {
        MACOS_RESTORED_CORNER_RADIUS_PT
    } else {
        0.0
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
const LINUX_CAPTION_CLASS: &str = "lightink-reader-caption";

/// GTK CSS that tints our window's CSD titlebar. Empty string restores default.
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn linux_caption_css(caption: Option<&str>, text: Option<&str>) -> String {
    let Some(caption) = caption.filter(|value| parse_hex_rgb(value).is_some()) else {
        return String::new();
    };
    let text = text
        .filter(|value| parse_hex_rgb(value).is_some())
        .unwrap_or(caption);
    format!(
        "\
window.{class},
window.{class}.background,
window.{class} decoration,
window.{class} decoration:backdrop,
window.{class} headerbar,
window.{class} headerbar:backdrop,
window.{class} .titlebar,
window.{class} .titlebar:backdrop {{
  background-image: none;
  background-color: {caption};
  color: {text};
  box-shadow: none;
}}
window.{class} headerbar .title,
window.{class} .title {{
  color: {text};
}}
",
        class = LINUX_CAPTION_CLASS
    )
}

/// 桌面专属命令：lib.rs 中以 `#[cfg(desktop)]` 注册，此处同步门控，
/// 移动端不生成该命令（无非桌面兜底调用的必要）。
#[cfg(desktop)]
#[tauri::command]
pub fn set_window_caption_color(
    window: tauri::WebviewWindow,
    caption: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_windows_caption_color(&window, caption.as_deref(), text.as_deref())
    }
    #[cfg(target_os = "macos")]
    {
        apply_macos_caption_color(&window, caption.as_deref(), text.as_deref())
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        apply_linux_caption_color(&window, caption.as_deref(), text.as_deref())
    }
    #[cfg(not(any(
        windows,
        target_os = "macos",
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    {
        let _ = (window, caption, text);
        Ok(())
    }
}

/// Apply native outer rounding. Linux is a no-op (no app-drawn outer radius).
#[cfg(desktop)]
#[tauri::command]
pub fn set_window_outer_rounded(window: tauri::WebviewWindow, rounded: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_windows_outer_rounded(&window, rounded)
    }
    #[cfg(target_os = "macos")]
    {
        apply_macos_outer_rounded(&window, rounded)
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        let _ = (window, rounded);
        Ok(())
    }
    #[cfg(not(any(
        windows,
        target_os = "macos",
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    {
        let _ = (window, rounded);
        Ok(())
    }
}

#[cfg(windows)]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

#[cfg(windows)]
fn apply_windows_caption_color(
    window: &tauri::WebviewWindow,
    caption: Option<&str>,
    text: Option<&str>,
) -> Result<(), String> {
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    // DWMWA_COLOR_DEFAULT — not a paint color; restores the system caption.
    const DWMWA_COLOR_DEFAULT: u32 = 0xffff_ffff;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let caption_color = caption
        .and_then(parse_hex_colorref)
        .unwrap_or(DWMWA_COLOR_DEFAULT);
    let text_color = text
        .and_then(parse_hex_colorref)
        .unwrap_or(DWMWA_COLOR_DEFAULT);
    // Win10 / older builds reject caption tint; light/dark still comes from setTheme.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_CAPTION_COLOR,
            (&caption_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_TEXT_COLOR,
            (&text_color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }
    Ok(())
}

#[cfg(windows)]
fn apply_windows_outer_rounded(window: &tauri::WebviewWindow, rounded: bool) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let preference = windows_corner_preference(rounded);
    // Win10 / older builds reject corner preference; leave the frame as-is.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&preference as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_macos_caption_color(
    window: &tauri::WebviewWindow,
    caption: Option<&str>,
    _text: Option<&str>,
) -> Result<(), String> {
    let caption = caption.map(str::to_string);
    let window = window.clone();
    window
        .clone()
        .run_on_main_thread(move || {
            let Ok(raw) = window.ns_window() else {
                return;
            };
            let Some(ns_window) =
                (unsafe { objc2::rc::Retained::retain(raw.cast::<objc2_app_kit::NSWindow>()) })
            else {
                return;
            };
            if let Some((red, green, blue)) = caption.as_deref().and_then(parse_hex_rgb) {
                let color = objc2_app_kit::NSColor::colorWithSRGBRed_green_blue_alpha(
                    f64::from(red) / 255.0,
                    f64::from(green) / 255.0,
                    f64::from(blue) / 255.0,
                    1.0,
                );
                ns_window.setTitlebarAppearsTransparent(true);
                ns_window.setBackgroundColor(Some(&color));
            } else {
                ns_window.setTitlebarAppearsTransparent(false);
                ns_window
                    .setBackgroundColor(Some(&objc2_app_kit::NSColor::windowBackgroundColor()));
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn apply_macos_outer_rounded(window: &tauri::WebviewWindow, rounded: bool) -> Result<(), String> {
    let radius = macos_content_corner_radius_pt(rounded);
    let window = window.clone();
    window
        .clone()
        .run_on_main_thread(move || {
            let Ok(raw) = window.ns_window() else {
                return;
            };
            let Some(ns_window) =
                (unsafe { objc2::rc::Retained::retain(raw.cast::<objc2_app_kit::NSWindow>()) })
            else {
                return;
            };
            let Some(content_view) = ns_window.contentView() else {
                return;
            };
            content_view.setWantsLayer(true);
            if let Some(layer) = content_view.layer() {
                layer.setCornerRadius(radius);
                layer.setMasksToBounds(true);
            }
            ns_window.invalidateShadow();
        })
        .map_err(|error| error.to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn apply_linux_caption_color(
    window: &tauri::WebviewWindow,
    caption: Option<&str>,
    text: Option<&str>,
) -> Result<(), String> {
    use gtk::prelude::*;

    let css = linux_caption_css(caption, text);
    let tinted = !css.is_empty();
    let window = window.clone();
    let callback_window = window.clone();
    window
        .clone()
        .run_on_main_thread(move || {
            let Ok(gtk_window) = callback_window.gtk_window() else {
                return;
            };
            with_linux_caption_provider(|provider| {
                let _ = provider.load_from_data(css.as_bytes());
            });
            let style = gtk_window.style_context();
            if tinted {
                style.add_class(LINUX_CAPTION_CLASS);
            } else {
                style.remove_class(LINUX_CAPTION_CLASS);
            }
            if let Some(titlebar) = gtk_window.titlebar() {
                let title_style = titlebar.style_context();
                if tinted {
                    title_style.add_class(LINUX_CAPTION_CLASS);
                } else {
                    title_style.remove_class(LINUX_CAPTION_CLASS);
                }
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn with_linux_caption_provider(f: impl FnOnce(&gtk::CssProvider)) {
    thread_local! {
        static PROVIDER: gtk::CssProvider = {
            let provider = gtk::CssProvider::new();
            if let Some(screen) = gtk::gdk::Screen::default() {
                gtk::StyleContext::add_provider_for_screen(
                    &screen,
                    &provider,
                    gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
            }
            provider
        };
    }
    PROVIDER.with(f);
}

/// Monitor / work-area rectangles as `(left, top, right, bottom)`.
/// 仅单元测试使用；生产路径已改为直接套 work area，避免非测试 lib 死代码。
#[cfg(test)]
pub fn constrain_max_extent(
    monitor: (i32, i32, i32, i32),
    work: (i32, i32, i32, i32),
) -> ((i32, i32), (i32, i32)) {
    (
        (work.0 - monitor.0, work.1 - monitor.1),
        (work.2.saturating_sub(work.0), work.3.saturating_sub(work.1)),
    )
}

/// 与 `fit_fullscreen_to_visible_work_area` 对齐；非 Windows lib 仅测试引用。
#[cfg(any(windows, test))]
pub fn work_area_needs_fit(
    position: (i32, i32),
    size: (u32, u32),
    work_position: (i32, i32),
    work_size: (u32, u32),
) -> bool {
    const SLACK: i32 = 2;
    (position.0 - work_position.0).abs() > SLACK
        || (position.1 - work_position.1).abs() > SLACK
        || (size.0 as i32 - work_size.0 as i32).abs() > SLACK
        || (size.1 as i32 - work_size.1 as i32).abs() > SLACK
}

/// Windows 11 often leaves the taskbar on top after F11. Tao already marks
/// fullscreen via `ITaskbarList2::MarkFullscreenWindow` and clamps maximize
/// through `WM_NCCALCSIZE` + `rcWork`. Do not subclass `WM_GETMINMAXINFO`.
/// If the shell still shows the taskbar, shrink only the fullscreen window
/// to the monitor work area (MSDN / Raymond Chen: covering the screen is
/// what triggers fullscreen autodetection).
#[cfg(windows)]
pub fn install_main_window_work_area(app: &tauri::App) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let tracked = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            fit_fullscreen_to_visible_work_area(&tracked);
        }
    });
    fit_fullscreen_to_visible_work_area(&window);
}

#[cfg(windows)]
fn fit_fullscreen_to_visible_work_area(window: &tauri::WebviewWindow) {
    if !window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let work = monitor.work_area();
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if !work_area_needs_fit(
        (position.x, position.y),
        (size.width, size.height),
        (work.position.x, work.position.y),
        (work.size.width, work.size.height),
    ) {
        return;
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(
        work.position.x,
        work.position.y,
    ));
    let _ = window.set_size(tauri::PhysicalSize::new(work.size.width, work.size.height));
}

#[cfg(test)]
mod tests {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    use super::linux_caption_css;
    use super::{
        constrain_max_extent, macos_content_corner_radius_pt, parse_hex_colorref, parse_hex_rgb,
        window_outer_should_round, windows_corner_preference, work_area_needs_fit,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
    };

    #[test]
    fn parses_sepia_page_to_colorref() {
        assert_eq!(parse_hex_rgb("#fbf0d9"), Some((0xfb, 0xf0, 0xd9)));
        assert_eq!(parse_hex_colorref("#fbf0d9"), Some(0x00d9_f0fb));
        assert_eq!(parse_hex_colorref("#121212"), Some(0x0012_1212));
        assert_eq!(parse_hex_colorref("fbf0d9"), None);
        assert_eq!(parse_hex_colorref("#fff"), None);
    }

    #[test]
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    fn linux_css_tints_then_clears() {
        let css = linux_caption_css(Some("#fbf0d9"), Some("#5c4a32"));
        assert!(css.contains("lightink-reader-caption"));
        assert!(css.contains("#fbf0d9"));
        assert!(css.contains("#5c4a32"));
        assert!(linux_caption_css(None, None).is_empty());
        assert!(linux_caption_css(Some("nope"), Some("#121212")).is_empty());
    }

    #[test]
    fn fullscreen_extent_stays_inside_the_taskbar_work_area() {
        assert_eq!(
            constrain_max_extent((0, 0, 1920, 1080), (0, 0, 1920, 1032)),
            ((0, 0), (1920, 1032))
        );
        assert_eq!(
            constrain_max_extent((0, 0, 1920, 1080), (48, 0, 1920, 1080)),
            ((48, 0), (1872, 1080))
        );
        expect_no_fit_when_already_on_work_area();
    }

    fn expect_no_fit_when_already_on_work_area() {
        assert!(!work_area_needs_fit(
            (0, 0),
            (1920, 1032),
            (0, 0),
            (1920, 1032)
        ));
        assert!(work_area_needs_fit(
            (0, 0),
            (1920, 1080),
            (0, 0),
            (1920, 1032)
        ));
    }

    #[test]
    fn restored_windows_round_and_max_or_fullscreen_do_not() {
        assert!(window_outer_should_round(false, false));
        assert!(!window_outer_should_round(true, false));
        assert!(!window_outer_should_round(false, true));
        assert!(!window_outer_should_round(true, true));
        assert_eq!(DWMWA_WINDOW_CORNER_PREFERENCE, 33);
        assert_eq!(windows_corner_preference(true), DWMWCP_ROUND);
        assert_eq!(windows_corner_preference(false), DWMWCP_DONOTROUND);
        let restored = macos_content_corner_radius_pt(true);
        assert!(restored >= 10.0 && restored <= 12.0);
        assert_eq!(macos_content_corner_radius_pt(false), 0.0);
    }
}
