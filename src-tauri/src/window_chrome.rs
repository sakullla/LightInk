//! Native title-bar colors for reader paper.
//!
//! - Windows 11: DWM caption / text tint
//! - macOS: transparent titlebar + window background
//! - Linux: GTK CSS on client-side decorations (GNOME). Server-side
//!   window-manager bars (many KDE / XFCE / i3 setups) only follow light/dark.

/// Parse `#rrggbb` into `(red, green, blue)`.
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
    use super::{parse_hex_colorref, parse_hex_rgb};

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
}
