//! 导出辅助服务（T10，R5）。
//!
//! 导出 HTML / PDF 的唯一 Rust 侧需求：把文档引用的**相对路径图片**
//! （`assets/<name>.<ext>`）读成 base64，供前端内嵌为 data URI 生成
//! 独立 HTML。PDF 打印管线与样式内嵌全部在前端完成（见
//! src/export/pdf-export.ts），这里不做 PDF 生成。
//!
//! 路径解析规则（与 asset.rs 的落盘布局对应）：
//!   - 文档已保存（`doc_path` 为 Some）→ 仅在 `<文档目录>/assets/` 解析；
//!   - 文档未保存 → 相对应用数据目录下 `staging-assets/<session_id>/`
//!     解析，此时相对路径必须位于 `assets/` 前缀之下（剥离前缀后即为
//!     暂存目录内的文件名）。
//!
//! 安全：相对路径逐段校验并在读取前 canonicalize，拒绝 `..`、盘符/UNC、
//! 绝对路径与 symlink 越界；会话 id 验证规则与 asset.rs 一致。base64
//! 编码器为本模块自带实现（asset.rs 只有解码器），不引入新 crate。

use std::fs;
use std::path::{Path, PathBuf};

use crate::identifiers::validate_session_id;

/// 文档旁的图片目录名（与 asset.rs 同一约定）。
const ASSETS_DIR_NAME: &str = "assets";
/// 应用数据目录下的暂存根目录名（与 asset.rs 同一约定）。
const STAGING_DIR_NAME: &str = "staging-assets";

// ---------------------------------------------------------------------------
// base64 编码（自实现，无新 crate）
// ---------------------------------------------------------------------------

/// 编码标准 base64（含 `=` 填充；空输入编码为空串）。
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 纯逻辑（可注入目录，便于测试）
// ---------------------------------------------------------------------------

/// 相对路径消毒：按 `/` 与 `\` 切段，剔除空段与 `.`，拒绝 `..` 与含
/// 盘符/冒号的段。返回安全的相对段序列；空路径报错。
fn sanitize_rel_path(rel_path: &str) -> Result<Vec<String>, String> {
    if rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err(format!("图片路径必须是相对路径: {:?}", rel_path));
    }
    let mut parts: Vec<String> = Vec::new();
    for seg in rel_path.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains(':') {
            return Err(format!("非法的图片相对路径: {:?}", rel_path));
        }
        parts.push(seg.to_owned());
    }
    if parts.is_empty() {
        return Err("图片相对路径不能为空".to_owned());
    }
    Ok(parts)
}

fn canonicalize_path(path: &Path, description: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("无法解析{} {}: {}", description, path.display(), e))
}

fn require_path_within(path: &Path, root: &Path, description: &str) -> Result<(), String> {
    if path == root || !path.starts_with(root) {
        return Err(format!(
            "{}必须位于允许的 assets 目录内: {}",
            description,
            path.display()
        ));
    }
    Ok(())
}

/// 读取相对路径图片并返回 base64。
///
/// - `doc_dir` 为 Some：`rel_path` 必须位于 `assets/`，解析为
///   `<doc_dir>/assets/<path>`；
/// - 为 None（文档未保存）：`rel_path` 必须以 `assets/` 开头，剥离后解析
///   `<staging_root>/staging-assets/<session_id>/<name>`；`session_id`
///   缺失时报错。
pub fn read_image_base64_impl(
    doc_dir: Option<&Path>,
    staging_root: &Path,
    session_id: Option<&str>,
    rel_path: &str,
) -> Result<String, String> {
    let session_id = session_id.map(validate_session_id).transpose()?;
    let parts = sanitize_rel_path(rel_path)?;
    if parts.first().map(String::as_str) != Some(ASSETS_DIR_NAME) || parts.len() < 2 {
        return Err(format!(
            "图片路径必须位于 {}/ 之下: {:?}",
            ASSETS_DIR_NAME, rel_path
        ));
    }

    let (allowed_root, full): (PathBuf, PathBuf) = match doc_dir {
        Some(dir) => {
            let canonical_doc = canonicalize_path(dir, "文档目录")?;
            let assets_root = canonicalize_path(&dir.join(ASSETS_DIR_NAME), "资源目录")?;
            require_path_within(&assets_root, &canonical_doc, "资源目录")?;
            let full = parts[1..]
                .iter()
                .fold(assets_root.clone(), |acc, part| acc.join(part));
            (assets_root, full)
        }
        None => {
            let session =
                session_id.ok_or_else(|| "文档未保存且缺少会话 id，无法定位暂存图片".to_owned())?;
            let staging_assets = staging_root.join(STAGING_DIR_NAME);
            let canonical_base = canonicalize_path(staging_root, "应用数据目录")?;
            let canonical_staging = canonicalize_path(&staging_assets, "暂存资源根目录")?;
            require_path_within(&canonical_staging, &canonical_base, "暂存资源根目录")?;
            let session_root = canonicalize_path(&staging_assets.join(session), "会话资源目录")?;
            require_path_within(&session_root, &canonical_staging, "会话资源目录")?;
            let full = parts[1..]
                .iter()
                .fold(session_root.clone(), |acc, part| acc.join(part));
            (session_root, full)
        }
    };
    let full = canonicalize_path(&full, "图片")?;
    require_path_within(&full, &allowed_root, "图片")?;
    let metadata =
        fs::metadata(&full).map_err(|e| format!("无法读取图片 {}: {}", full.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("图片路径不是普通文件: {}", full.display()));
    }
    let size = metadata.len();
    if size > crate::asset::MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {} 字节）: {}",
            size,
            crate::asset::MAX_IMAGE_BYTES,
            full.display()
        ));
    }
    let bytes = fs::read(&full).map_err(|e| format!("无法读取图片 {}: {}", full.display(), e))?;
    Ok(encode_base64(&bytes))
}

/// 解析应用数据目录：优先 Tauri app_data_dir，失败回退系统临时目录
/// （与 asset.rs / snapshot.rs 同一约定）。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

// ---------------------------------------------------------------------------
// Tauri 命令层
// ---------------------------------------------------------------------------

/// 读取文档引用的相对路径图片，返回 base64（MIME 由前端按扩展名推导）。
/// `doc_path` 为 None 时按 `session_id` 的暂存目录解析。
#[tauri::command]
pub fn read_image_base64(
    app: tauri::AppHandle,
    doc_path: Option<String>,
    session_id: Option<String>,
    rel_path: String,
) -> Result<String, String> {
    let doc_dir = match doc_path.as_deref() {
        Some(p) => Some(
            Path::new(p)
                .parent()
                .filter(|d| !d.as_os_str().is_empty())
                .ok_or_else(|| format!("无效的文档路径: {}", p))?
                .to_path_buf(),
        ),
        None => None,
    };
    read_image_base64_impl(
        doc_dir.as_deref(),
        &resolve_base_dir(&app),
        session_id.as_deref(),
        &rel_path,
    )
}

// ---------------------------------------------------------------------------
// 原生矢量文字 PDF 导出（Windows：WebView2 PrintToPdf）
// ---------------------------------------------------------------------------
//
// `window.print()` → 系统打印对话框的路径依赖打印驱动，可能把内容栅格化成
// 图片（无可选文字）。WebView2 的 `ICoreWebView2_7::PrintToPdf` 用 Chromium
// PDF 引擎生成**含原生可选文字**的矢量 PDF，保真度与编辑器渲染一致。
//
// 流程：前端把导出文档装进 #lightink-export-print-root（@media print 仅它可见），
// 弹保存对话框取 .pdf 路径，调本命令；本命令取主窗口 WebView2 控制器 →
// CoreWebView2 → cast ICoreWebView2_7 → PrintToPdf 写入路径。回调经
// webview2-com 的 wait_for_async_operation（带消息泵）同步等待，避免主线程
// 阻塞死锁（COM 回调需消息循环派发）。

#[cfg(windows)]
#[tauri::command]
pub fn print_webview_to_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::mpsc;

    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::Interface;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |wv: tauri::webview::PlatformWebview| {
            let outcome = (|| -> Result<(), String> {
                let controller = wv.controller();
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败: {e}"))?;
                let core7: ICoreWebView2_7 = core
                    .cast()
                    .map_err(|e| format!("当前 WebView2 运行时不支持 PrintToPdf: {e}"))?;

                // 路径 → UTF-16 + NUL（PCWSTR 要求）。
                let mut wide: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().collect();
                wide.push(0);

                PrintToPdfCompletedHandler::wait_for_async_operation(
                    Box::new(move |handler| {
                        let pcws = windows::core::PCWSTR::from_raw(wide.as_ptr());
                        // 默认打印设置（背景由前端 @media print 强制浅色：深字白底，
                        // 不依赖「打印背景」即清晰且为矢量文字）。
                        unsafe { core7.PrintToPdf(pcws, None, &handler) }
                            .map_err(webview2_com::Error::WindowsError)
                    }),
                    // 直接透传 COM 调用的 HRESULT 结果（成功/失败）。
                    Box::new(|hr: windows::core::Result<()>, _success: bool| hr),
                )
                .map_err(|e| format!("PrintToPdf 失败: {e}"))
            })();
            let _ = tx.send(outcome);
        })
        .map_err(|e| format!("with_webview 失败: {e}"))?;

    rx.recv()
        .map_err(|_| "打印通道关闭（主线程未返回结果）".to_string())?
}

/// 非 Windows：原生 PrintToPdf 仅 WebView2（Windows）有；Linux/macOS 走
/// `window.print()` 系统对话框（WebKitGTK/WKWebView 的「打印为 PDF」本就输出
/// 矢量文字）。返回错误，由前端回退到打印对话框路径。
#[cfg(not(windows))]
#[tauri::command]
pub fn print_webview_to_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), String> {
    Err("当前平台不支持原生 PrintToPdf，请使用打印对话框".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    // -- base64 编码（与 asset.rs 解码测试向量互逆） --

    #[test]
    fn base64_encode_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"Hello"), "SGVsbG8=");
        assert_eq!(encode_base64(b"Hello!"), "SGVsbG8h");
        assert_eq!(encode_base64("🎭".as_bytes()), "8J+OrQ==");
        assert_eq!(encode_base64(&[0xfb, 0xff]), "+/8=");
        // 与解码器 roundtrip
        let data: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        assert_eq!(
            crate::asset::decode_base64(&encode_base64(&data)).unwrap(),
            data
        );
    }

    // -- 相对路径消毒 --

    #[test]
    fn rel_path_sanitization() {
        assert_eq!(
            sanitize_rel_path("assets/img-a.png").unwrap(),
            vec!["assets", "img-a.png"]
        );
        // 反斜杠与冗余段归一
        assert_eq!(
            sanitize_rel_path("assets\\./sub\\x.png").unwrap(),
            vec!["assets", "sub", "x.png"]
        );
        for bad in [
            "../x.png",
            "assets/../../etc",
            "C:/x.png",
            "/assets/x.png",
            "\\\\server\\assets\\x.png",
            "",
            "./",
        ] {
            assert!(sanitize_rel_path(bad).is_err(), "should reject {:?}", bad);
        }
    }

    // -- 读取 --

    #[test]
    fn reads_image_relative_to_doc_dir() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        fs::write(doc_dir.join("assets").join("a.png"), b"\x89PNG fake").unwrap();
        let b64 =
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/a.png").expect("read");
        assert_eq!(b64, encode_base64(b"\x89PNG fake"));
    }

    #[test]
    fn reads_image_from_session_staging_when_unsaved() {
        let dir = temp_dir();
        let staged = dir.path().join(STAGING_DIR_NAME).join("untitled-ab12");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("b.gif"), b"GIF89a").unwrap();
        let b64 = read_image_base64_impl(None, dir.path(), Some("untitled-ab12"), "assets/b.gif")
            .expect("read staged");
        assert_eq!(b64, encode_base64(b"GIF89a"));
    }

    #[test]
    fn unsaved_requires_session_and_assets_prefix() {
        let dir = temp_dir();
        // 缺 session id
        assert!(read_image_base64_impl(None, dir.path(), None, "assets/a.png").is_err());
        // 暂存模式拒绝 assets/ 之外的路径
        assert!(read_image_base64_impl(None, dir.path(), Some("s"), "other/a.png").is_err());
    }

    #[test]
    fn saved_document_requires_assets_prefix() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        fs::write(doc_dir.join("outside.png"), b"outside").unwrap();

        assert!(read_image_base64_impl(Some(&doc_dir), dir.path(), None, "outside.png").is_err());
        assert!(read_image_base64_impl(Some(&doc_dir), dir.path(), None, "./outside.png").is_err());
    }

    #[test]
    fn rejects_traversal_and_reports_missing() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join(ASSETS_DIR_NAME)).unwrap();
        assert!(read_image_base64_impl(Some(&doc_dir), dir.path(), None, "../secret.png").is_err());
        let err = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/nope.png")
            .expect_err("must fail");
        assert!(err.contains("无法解析图片"), "unexpected: {}", err);
    }

    #[test]
    fn staging_session_id_is_rejected_instead_of_rewritten() {
        let dir = temp_dir();
        let staged = dir.path().join(STAGING_DIR_NAME).join("valid-session");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("c.png"), b"png-c").unwrap();
        assert!(
            read_image_base64_impl(None, dir.path(), Some("../evil/../x"), "assets/c.png").is_err()
        );
    }

    #[test]
    fn rejects_oversized_image() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        // 用稀疏文件快速构造超限体积
        let big = doc_dir.join("assets").join("big.png");
        let f = fs::File::create(&big).unwrap();
        f.set_len(crate::asset::MAX_IMAGE_BYTES + 1).unwrap();
        drop(f);
        let err = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/big.png")
            .expect_err("must fail on oversize");
        assert!(err.contains("图片过大"), "unexpected: {}", err);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_from_assets_directory() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        let assets = doc_dir.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let secret = dir.path().join("secret.png");
        fs::write(&secret, b"secret").unwrap();
        symlink(&secret, assets.join("linked.png")).unwrap();

        let error = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/linked.png")
            .expect_err("symlink escape must fail");
        assert!(error.contains("assets 目录内"), "unexpected: {}", error);
    }
}
