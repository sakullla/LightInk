//! 导出辅助服务（T10，R5 / R4）。
//!
//! 导出 HTML / PDF 的唯一 Rust 侧需求：把文档引用的**相对路径图片**
//! 读成 base64，供前端内嵌为 data URI 生成独立 HTML。PDF 打印管线与
//! 样式内嵌全部在前端完成（见 src/export/pdf-export.ts），这里不做 PDF 生成。
//!
//! 路径解析规则：
//!   - 文档已保存（`doc_path` 为 Some）→ 相对路径必须解析到**文档所在
//!     目录之内**的常规文件（`assets/…`、同级 `*-assets/…` 等均可）；
//!   - 文档未保存 → 相对应用数据目录下 `staging-assets/<session_id>/`
//!     解析，此时相对路径必须位于 `assets/` 前缀之下（剥离前缀后即为
//!     暂存目录内的文件名）。粘贴落盘仍只写 `assets/`。
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
            "{}必须位于允许的目录内: {}",
            description,
            path.display()
        ));
    }
    Ok(())
}

fn require_assets_prefix(parts: &[String], rel_path: &str) -> Result<(), String> {
    if parts.first().map(String::as_str) != Some(ASSETS_DIR_NAME) || parts.len() < 2 {
        return Err(format!(
            "图片路径必须位于 {}/ 之下: {:?}",
            ASSETS_DIR_NAME, rel_path
        ));
    }
    Ok(())
}

/// 读取相对路径图片并返回 base64。
///
/// - `doc_dir` 为 Some：`rel_path` 必须解析到文档目录之内的常规文件
///   （`assets/…`、同级 `*-assets/…` 等）；
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

    let (allowed_root, full): (PathBuf, PathBuf) = match doc_dir {
        Some(dir) => {
            let canonical_doc = canonicalize_path(dir, "文档目录")?;
            let full = parts
                .iter()
                .fold(dir.to_path_buf(), |acc, part| acc.join(part));
            (canonical_doc, full)
        }
        None => {
            require_assets_prefix(&parts, rel_path)?;
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
// 图片（无可选文字）。Windows 走 CDP `Page.printToPDF` + `generateDocumentOutline`：
// 官方 `ICoreWebView2_7::PrintToPdf` 没有书签开关，导出 PDF 侧栏会是空的。
//
// 流程：前端把导出文档装进 #lightink-export-print-root（@media print 仅它可见），
// 弹保存对话框取 .pdf 路径，调本命令；本命令经 CallDevToolsProtocolMethod 打
// Page.printToPDF，把返回的 base64 写成文件。标题树变成 PDF 书签。
//
// 必须是 async 命令：同步命令跑在 UI 线程，任何 recv / wait_with_pump 都会堵住
// 消息循环，导致 PrintToPdf 完成回调永远派发不了（PDF 已写出，但 IPC 永不返回，
// 后续打开/关闭全部挂起）。async 命令在 tokio worker 上 await，主线程只负责
// 发起 PrintToPdf 并立刻回到 run loop。

/// 从 CDP `Page.printToPDF` 返回的 JSON 取出 base64 载荷。
/// 仅 Windows 分支的 print_webview_to_pdf 使用；不加 cfg 会在其它平台变成死代码。
#[cfg(windows)]
fn cdp_pdf_base64(json: &str) -> Result<&str, String> {
    let key = "\"data\"";
    let start = json
        .find(key)
        .ok_or_else(|| "CDP Page.printToPDF 未返回 data".to_string())?;
    let after_key = &json[start + key.len()..];
    let colon = after_key
        .find(':')
        .ok_or_else(|| "CDP Page.printToPDF JSON 无效".to_string())?;
    let rest = after_key[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return Err("CDP Page.printToPDF data 不是字符串".to_string());
    }
    let body = &rest[1..];
    let end = body
        .find('"')
        .ok_or_else(|| "CDP Page.printToPDF data 未闭合".to_string())?;
    Ok(&body[..end])
}

/// createPDF 空 rect 会退回「当前显示的网页范围」，导出就变成第一页截图。
/// 宽高必须是装配文档的完整内容尺寸（CSS 像素）。
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn validate_pdf_capture_size(width: f64, height: f64) -> Result<(f64, f64), String> {
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
        return Err("导出内容尺寸无效，无法按整份文档生成 PDF".to_string());
    }
    Ok((width, height))
}

#[cfg(windows)]
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
    #[allow(unused_variables)] content_width: Option<f64>,
    #[allow(unused_variables)] content_height: Option<f64>,
) -> Result<(), String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::PCWSTR;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let mut tx = Some(tx);

    window
        .with_webview(move |wv: tauri::webview::PlatformWebview| {
            // 走 CDP Page.printToPDF，而不是 ICoreWebView2_7::PrintToPdf：
            // 后者没有 generateDocumentOutline，导出 PDF 不会带书签。
            let sync_outcome = (|| -> Result<(), String> {
                let controller = wv.controller();
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败: {e}"))?;

                let method: Vec<u16> = "Page.printToPDF"
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                // 标题树 → PDF 书签；打印背景关（导出根已是浅色正文）。
                let params = "{\"landscape\":false,\"displayHeaderFooter\":false,\"printBackground\":false,\"preferCSSPageSize\":true,\"generateDocumentOutline\":true}";
                let params_wide: Vec<u16> = params
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();

                let Some(tx) = tx.take() else {
                    return Err("打印通道已关闭".to_string());
                };
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |hr: windows::core::Result<()>, json: String| {
                        let result = hr
                            .map_err(|e| format!("Page.printToPDF 失败: {e}"))
                            .map(|_| json);
                        let _ = tx.send(result);
                        Ok(())
                    },
                ));

                unsafe {
                    core.CallDevToolsProtocolMethod(
                        PCWSTR::from_raw(method.as_ptr()),
                        PCWSTR::from_raw(params_wide.as_ptr()),
                        &handler,
                    )
                }
                .map_err(|e| format!("CallDevToolsProtocolMethod 失败: {e}"))
            })();

            if let Err(e) = sync_outcome {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("with_webview 失败: {e}"))?;

    let json = rx
        .await
        .map_err(|_| "打印通道关闭（completion 未派发）".to_string())??;
    let encoded = cdp_pdf_base64(&json)?;
    let bytes = crate::asset::decode_base64(encoded)?;
    std::fs::write(&path, bytes).map_err(|e| format!("写 PDF 失败: {e}"))
}

/// macOS：WKWebView `createPDFWithConfiguration:completionHandler:`（macOS 11+）
/// 生成含原生可选文字的矢量 PDF，与 Windows WebView2 PrintToPdf 对齐。经 tauri
/// `with_webview` 取底层 WKWebView 指针，createPDF 异步回调把 NSData 写入路径。
///
/// **UNVERIFIED on macOS**：本分支在 Windows 开发机编写，无法编译/运行验证。
/// 需 macOS 构建 + 手测确认 PlatformWebview.webview 句柄、objc2 block 与 NSData
/// 写文件的正确性（delivery 阶段 macOS CI/手测）。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
    content_width: Option<f64>,
    content_height: Option<f64>,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    let (width, height) =
        validate_pdf_capture_size(content_width.unwrap_or(0.0), content_height.unwrap_or(0.0))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let mut tx = Some(tx);

    window
        .with_webview(move |wv: tauri::webview::PlatformWebview| {
            // retain WKWebView；失败经 tx 报错并立即返回（不在主线程阻塞等待）。
            let wk: Retained<WKWebView> =
                match unsafe { Retained::retain(wv.inner() as *mut WKWebView) } {
                    Some(w) => w,
                    None => {
                        if let Some(tx) = tx.take() {
                            let _ = tx.send(Err("WKWebView 句柄无效".to_string()));
                        }
                        return;
                    }
                };

            let Some(tx) = tx.take() else {
                return;
            };
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err("createPDF 必须在主线程".to_string()));
                return;
            };
            // 必须先建 config，再把 sender 移进 completion block。
            // None / null rect = 当前可视范围 = 第一页截图。
            let config = unsafe { WKPDFConfiguration::new(mtm) };
            unsafe {
                config.setRect(CGRect::new(CGPoint::ZERO, CGSize::new(width, height)));
            }
            // createPDF completion 即终点：retain NSData → 写盘 → tx.send。
            // 闭包调 createPDF 后立即返回，主线程回到 run loop 派发 completion，
            // 避免在主线程 recv 阻塞 → completion 派发回主队列 → 死锁。
            // oneshot::Sender::send 消耗 self（FnOnce），而 RcBlock::new 要求 Fn；
            // 故用 Cell<Option<Sender>> 提供内部可变性，take() 经 &self 取出，
            // 使 completion 闭包满足 Fn 约束（macOS 11+ completion 仅回调一次）。
            let tx = std::cell::Cell::new(Some(tx));
            let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                let result = if !err.is_null() {
                    Err("createPDF 返回 NSError".to_string())
                } else if data.is_null() {
                    Err("createPDF 返回空数据".to_string())
                } else {
                    match unsafe { Retained::retain(data) } {
                        Some(pdf) => std::fs::write(&path, pdf.to_vec())
                            .map_err(|e| format!("写 PDF 失败: {e}")),
                        None => Err("NSData retain 失败".to_string()),
                    }
                };
                if let Some(tx) = tx.take() {
                    let _ = tx.send(result);
                }
            });
            unsafe {
                wk.createPDFWithConfiguration_completionHandler(Some(&config), &block);
            }
            // 闭包立即返回；最终结果由 completion block 经 oneshot 通知 worker。
        })
        .map_err(|e| format!("with_webview 失败: {e}"))?;

    rx.await
        .map_err(|_| "打印通道关闭（completion 未派发或主线程未返回结果）".to_string())?
}

/// Linux：WebKitGTK 无等价编程式 PrintToPdf；返回错误由前端回退到 `window.print()`
/// 系统打印对话框（WebKitGTK 的「打印为 PDF」输出矢量文字）。
#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub async fn print_webview_to_pdf(
    _window: tauri::WebviewWindow,
    _path: String,
    _content_width: Option<f64>,
    _content_height: Option<f64>,
) -> Result<(), String> {
    Err("当前平台不支持原生 PrintToPdf，请使用打印对话框".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    // -- base64 编码（与 asset.rs 解码测试向量互逆） --

    #[cfg(windows)]
    #[test]
    fn cdp_pdf_base64_extracts_payload() {
        assert_eq!(
            cdp_pdf_base64(r#"{"data":"SGVsbG8="}"#).unwrap(),
            "SGVsbG8="
        );
        assert!(cdp_pdf_base64("{}").is_err());
        assert!(cdp_pdf_base64(r#"{"data":1}"#).is_err());
    }

    #[test]
    fn rejects_missing_or_tiny_capture_size() {
        assert!(validate_pdf_capture_size(0.0, 800.0).is_err());
        assert!(validate_pdf_capture_size(800.0, 0.0).is_err());
        assert!(validate_pdf_capture_size(f64::NAN, 800.0).is_err());
        assert_eq!(
            validate_pdf_capture_size(800.0, 2400.0).unwrap(),
            (800.0, 2400.0)
        );
    }

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
    fn read_image_base64_relative_to_doc_dir() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        fs::write(doc_dir.join("assets").join("a.png"), b"\x89PNG fake").unwrap();
        let b64 =
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/a.png").expect("read");
        assert_eq!(b64, encode_base64(b"\x89PNG fake"));
    }

    #[test]
    fn read_image_base64_from_session_staging_when_unsaved() {
        let dir = temp_dir();
        let staged = dir.path().join(STAGING_DIR_NAME).join("untitled-ab12");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("b.gif"), b"GIF89a").unwrap();
        let b64 = read_image_base64_impl(None, dir.path(), Some("untitled-ab12"), "assets/b.gif")
            .expect("read staged");
        assert_eq!(b64, encode_base64(b"GIF89a"));
    }

    #[test]
    fn read_image_base64_unsaved_requires_session_and_assets_prefix() {
        let dir = temp_dir();
        // 缺 session id
        assert!(read_image_base64_impl(None, dir.path(), None, "assets/a.png").is_err());
        // 暂存模式拒绝 assets/ 之外的路径
        assert!(read_image_base64_impl(None, dir.path(), Some("s"), "other/a.png").is_err());
    }

    #[test]
    fn read_image_base64_saved_document_sibling_folder() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        let sibling = doc_dir.join("note-jira-summary-assets");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("image.png"), b"sibling-img").unwrap();
        let b64 = read_image_base64_impl(
            Some(&doc_dir),
            dir.path(),
            None,
            "note-jira-summary-assets/image.png",
        )
        .expect("sibling folder inside document directory");
        assert_eq!(b64, encode_base64(b"sibling-img"));
    }

    #[test]
    fn read_image_base64_saved_document_sandbox() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        fs::write(doc_dir.join("assets").join("a.png"), b"in-assets").unwrap();
        fs::write(doc_dir.join("outside.png"), b"in-doc").unwrap();
        fs::write(dir.path().join("secret.png"), b"secret").unwrap();

        assert_eq!(
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/a.png").unwrap(),
            encode_base64(b"in-assets")
        );
        assert_eq!(
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "outside.png").unwrap(),
            encode_base64(b"in-doc")
        );
        assert_eq!(
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "./outside.png").unwrap(),
            encode_base64(b"in-doc")
        );
        assert!(read_image_base64_impl(Some(&doc_dir), dir.path(), None, "../secret.png").is_err());
    }

    #[test]
    fn read_image_base64_rejects_traversal_and_reports_missing() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join(ASSETS_DIR_NAME)).unwrap();
        assert!(read_image_base64_impl(Some(&doc_dir), dir.path(), None, "../secret.png").is_err());
        let err = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/nope.png")
            .expect_err("must fail");
        assert!(err.contains("无法解析图片"), "unexpected: {}", err);
    }

    #[test]
    fn read_image_base64_staging_session_id_is_rejected_instead_of_rewritten() {
        let dir = temp_dir();
        let staged = dir.path().join(STAGING_DIR_NAME).join("valid-session");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("c.png"), b"png-c").unwrap();
        assert!(
            read_image_base64_impl(None, dir.path(), Some("../evil/../x"), "assets/c.png").is_err()
        );
    }

    #[test]
    fn read_image_base64_rejects_oversized_image() {
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
    fn read_image_base64_rejects_symlink_escape_from_document_directory() {
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
        assert!(error.contains("允许的目录内"), "unexpected: {}", error);
    }
}
