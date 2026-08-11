//! 命令行 / 文件关联 / 单实例的启动文件解析（R1）。
//!
//! 纯逻辑 [`extract_file_arg`] 从原始 argv 扫描首个 `.md`/`.markdown`
//! 文件参数，供首实例启动（`env::args`）与第二实例转发（single-instance
//! 回调的 argv）两条路径共用。无文件系统访问，可移植、可单测。
//!
//! 平台差异（文件关联打开）：
//! - Windows / Linux：路径（或 `file://` URL）出现在 argv；第二实例经
//!   single-instance 把 argv + cwd 转发给首实例。
//! - macOS：Finder「打开」/ 双击关联文件走 Apple Event，对应 Tauri
//!   `RunEvent::Opened { urls }`，**不会**可靠地出现在 argv。冷启动与
//!   已运行时都必须处理 Opened，否则只会启动应用、文件不打开。
//!
//! [`PendingFile`] 是经 Tauri 状态托管的「待打开文件」槽：首实例 argv
//! 解析结果在 `run()` 注入，第二实例回调 / Opened 覆盖写入；前端就绪后经
//! [`take_pending_file`] 命令取出并清空（仅消费一次），保证「单实例转发
//! 失败/前端未就绪时回退为正常打开、不丢文件」——文件始终先落入此槽。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 待打开文件槽（单值，取出即清空）。
pub struct PendingFile(pub Mutex<Option<String>>);

/// 把路径写入待打开槽并发出 `open-file`。
///
/// 冷启动（前端尚未 listen）时只靠槽 + 启动后 `take_pending_file`；
/// 已运行时 `open-file` 让前端立刻 `take` 打开。两条路径都先写槽，避免丢文件。
pub fn enqueue_pending_file(app: &AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingFile>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(path);
        }
    }
    let _ = app.emit("open-file", ());
}

/// 扫描 argv（含程序路径，索引 0 跳过），返回首个可打开文件参数
/// （`.md`/`.markdown` 开 markdown 标签，或电子书扩展名开 reader 标签）。
/// 大小写不敏感；无匹配返回 `None`。返回的是原始参数（可能相对 / `file://`）。
pub fn extract_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| has_supported_extension(a))
        .cloned()
}

/// 解析首个 markdown 文件参数为可被首实例进程直接读取的路径：
/// - `file://` URL 转为本地路径；
/// - 绝对路径原样返回；
/// - 相对路径按 `cwd`（第二实例转发的 shell 工作目录，或首实例进程 cwd）
///   拼接为绝对路径。
///
/// 第二实例 cwd 与首实例 cwd 通常不同，故相对路径必须按其来源 cwd 解析，
/// 否则 `read_file` 会取错目录静默失败。不做 canonicalize（避免 Windows UNC
/// 前缀与文件必须存在的前置），`..` 等由 OS 在打开时解析。
pub fn resolve_file_arg(args: &[String], cwd: Option<&str>) -> Option<String> {
    let raw = extract_file_arg(args)?;
    let path = normalize_path_arg(&raw);
    if std::path::Path::new(&path).is_absolute() {
        return Some(path);
    }
    let base = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => std::env::current_dir().unwrap_or_default(),
    };
    Some(base.join(&path).to_string_lossy().into_owned())
}

/// 规范化打开路径：`file://` → 本地路径；其余 trim 后原样返回。
pub fn normalize_path_arg(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(path) = file_url_to_path(raw) {
        return path;
    }
    raw.to_string()
}

/// 将 `file://` URL 转为本地路径；非 file URL 或解析失败返回 `None`。
fn file_url_to_path(raw: &str) -> Option<String> {
    if !raw.to_ascii_lowercase().starts_with("file:") {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let path = url.to_file_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// 从 `RunEvent::Opened` 的 URL 列表中取首个本地可打开文件路径
/// （Markdown 或电子书）。
///
/// 生产调用点仅在 macOS/iOS/Android 的 `RunEvent::Opened` 分支；其它目标
/// 仍保留实现与单测（file URL 解析与扩展名判断与 argv 路径共用）。
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub fn first_supported_from_urls(urls: impl IntoIterator<Item = url::Url>) -> Option<String> {
    for url in urls {
        if let Ok(path) = url.to_file_path() {
            let s = path.to_string_lossy().into_owned();
            if has_supported_extension(&s) {
                return Some(s);
            }
        }
    }
    None
}

/// 以只读 reader 标签打开的电子书扩展名（小写，与前端 file-drop.ts READER_EXTS 一致）。
const READER_EXTS: &[&str] = &["pdf", "epub", "mobi", "azw3", "fb2", "cbz", "txt"];

/// 把路径参数规范化为用于扩展名判断的候选字符串：`file://` URL 取 path 段
/// （避免 query/fragment 干扰），其余原样返回。不访问文件系统。
fn path_candidate(path: &str) -> String {
    if path.to_ascii_lowercase().starts_with("file:") {
        url::Url::parse(path)
            .ok()
            .map(|u| u.path().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    }
}

/// 取路径的小写扩展名（最后一个 `.` 之后；无点 / 末尾点 / 开头点返回空串）。
fn extension_lower(path: &str) -> String {
    let candidate = path_candidate(path);
    let lower = candidate.to_ascii_lowercase();
    match lower.rfind('.') {
        Some(i) if i > 0 && i < lower.len() - 1 => lower[i + 1..].to_string(),
        _ => String::new(),
    }
}

/// 大小写不敏感的 `.md` / `.markdown` 扩展名判断（不访问文件系统）。
/// 对 `file://.../note.md` 也能匹配（扩展名在查询串之前）。
fn has_markdown_extension(path: &str) -> bool {
    matches!(extension_lower(path).as_str(), "md" | "markdown")
}

/// 是否为以只读 reader 标签打开的电子书扩展名（大小写不敏感，不访问文件系统）。
fn has_reader_extension(path: &str) -> bool {
    let ext = extension_lower(path);
    READER_EXTS.iter().any(|e| *e == ext)
}

/// 是否为应用可打开的文件（Markdown 编辑标签或电子书 reader 标签）。
fn has_supported_extension(path: &str) -> bool {
    has_markdown_extension(path) || has_reader_extension(path)
}

/// 取出并清空待打开文件槽（前端就绪或收到 `open-file` 事件时调用）。
#[tauri::command]
pub fn take_pending_file(state: tauri::State<'_, PendingFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args_yields_none() {
        assert!(extract_file_arg(&argv(&["lightink"])).is_none());
    }

    #[test]
    fn picks_first_markdown_arg() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "note.md"])),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn skips_unsupported_picks_supported() {
        // .zip 不被支持故跳过；.md 被选为首个可打开文件（电子书扩展名同理）。
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "--flag", "a.zip", "b.md"])),
            Some("b.md".to_string())
        );
    }

    #[test]
    fn picks_reader_extension_arg() {
        // 电子书扩展名以 reader 标签打开，CLI/关联入口同样应取到。
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "book.pdf"])),
            Some("book.pdf".to_string())
        );
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "novel.epub", "pic.png"])),
            Some("novel.epub".to_string())
        );
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "readme.md.txt"])),
            Some("readme.md.txt".to_string())
        );
    }

    #[test]
    fn case_insensitive_extension() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "README.MARKDOWN"])),
            Some("README.MARKDOWN".to_string())
        );
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "ReadMe.MD"])),
            Some("ReadMe.MD".to_string())
        );
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "BOOK.PDF"])),
            Some("BOOK.PDF".to_string())
        );
    }

    #[test]
    fn unicode_and_paths_with_spaces() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "/path/with space/笔记.md"])),
            Some("/path/with space/笔记.md".to_string())
        );
    }

    #[test]
    fn bare_without_dot_or_unsupported_ext_is_not_matched() {
        assert!(extract_file_arg(&argv(&["lightink", "markdown"])).is_none());
        assert!(extract_file_arg(&argv(&["lightink", "readme.md.zip"])).is_none());
    }

    #[test]
    fn resolve_relative_joins_cwd() {
        // 相对路径按来源 cwd 拼为绝对路径（OS 无关：两侧同用 PathBuf::join）。
        let resolved =
            resolve_file_arg(&argv(&["lightink", "note.md"]), Some("/home/user")).unwrap();
        assert_eq!(
            resolved,
            std::path::PathBuf::from("/home/user")
                .join("note.md")
                .to_string_lossy()
                .into_owned()
        );
        assert!(std::path::Path::new(&resolved).is_absolute() || resolved.contains("home"));
    }

    #[test]
    fn resolve_absolute_returned_unchanged() {
        let abs = if cfg!(windows) {
            "C:\\docs\\note.md"
        } else {
            "/docs/note.md"
        };
        let resolved = resolve_file_arg(&argv(&["lightink", abs]), Some("/other/cwd")).unwrap();
        assert_eq!(resolved, abs);
    }

    #[test]
    fn resolve_dotdot_against_cwd() {
        let resolved =
            resolve_file_arg(&argv(&["lightink", "sub\\..\\note.md"]), Some("/home/user")).unwrap();
        assert_eq!(
            resolved,
            std::path::PathBuf::from("/home/user")
                .join("sub\\..\\note.md")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn resolve_no_arg_is_none() {
        assert!(resolve_file_arg(&argv(&["lightink"]), Some("/home/user")).is_none());
    }

    #[test]
    fn resolve_file_url_to_local_path() {
        // 桌面 %U / xdg-open / 部分 shell 会传 file:// URL。
        let (file_url, expected) = if cfg!(windows) {
            (
                "file:///C:/Users/docs/hello.md",
                std::path::PathBuf::from("C:\\Users\\docs\\hello.md"),
            )
        } else {
            (
                "file:///home/user/notes/hello.md",
                std::path::PathBuf::from("/home/user/notes/hello.md"),
            )
        };
        let resolved = resolve_file_arg(&argv(&["lightink", file_url]), Some("/other")).unwrap();
        assert_eq!(resolved, expected.to_string_lossy().into_owned());
    }

    #[test]
    fn resolve_file_url_with_percent_encoding() {
        let (file_url, expected) = if cfg!(windows) {
            (
                "file:///C:/Users/docs/my%20note.md",
                std::path::PathBuf::from("C:\\Users\\docs\\my note.md"),
            )
        } else {
            (
                "file:///home/user/my%20note.md",
                std::path::PathBuf::from("/home/user/my note.md"),
            )
        };
        let resolved = resolve_file_arg(&argv(&["lightink", file_url]), None).unwrap();
        assert_eq!(resolved, expected.to_string_lossy().into_owned());
    }

    #[test]
    fn extract_recognizes_file_url_markdown() {
        let (skip, pick) = if cfg!(windows) {
            ("file:///C:/tmp/a.zip", "file:///C:/tmp/b.md")
        } else {
            ("file:///tmp/a.zip", "file:///tmp/b.md")
        };
        assert_eq!(
            extract_file_arg(&argv(&["lightink", skip, pick])),
            Some(pick.to_string())
        );
    }

    #[test]
    fn first_supported_from_urls_picks_markdown() {
        let (skip, pick) = if cfg!(windows) {
            ("file:///C:/tmp/a.zip", "file:///C:/tmp/note.md")
        } else {
            ("file:///tmp/a.zip", "file:///tmp/note.md")
        };
        let urls = vec![
            url::Url::parse(skip).unwrap(),
            url::Url::parse(pick).unwrap(),
        ];
        let path = first_supported_from_urls(urls).unwrap();
        assert!(path.ends_with("note.md"), "unexpected: {path}");
    }

    #[test]
    fn first_supported_from_urls_picks_reader() {
        let pick = if cfg!(windows) {
            "file:///C:/tmp/book.epub"
        } else {
            "file:///tmp/book.epub"
        };
        let urls = vec![url::Url::parse(pick).unwrap()];
        let path = first_supported_from_urls(urls).unwrap();
        assert!(path.ends_with("book.epub"), "unexpected: {path}");
    }

    #[test]
    fn first_supported_from_urls_skips_non_file() {
        let urls = vec![url::Url::parse("https://example.com/x.md").unwrap()];
        assert!(first_supported_from_urls(urls).is_none());
    }
}
