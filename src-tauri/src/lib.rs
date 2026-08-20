// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

#[cfg(all(test, windows, target_env = "msvc", lightink_windows_test_manifest))]
#[link(name = "lightink_windows_test_manifest", kind = "static")]
extern "C" {}

mod annotations;
mod archive;
mod asset;
mod cli;
mod documents;
mod export;
mod file;
mod groups;
mod identifiers;
mod library;
mod managed;
mod opds;
mod recents;
mod remote;
mod snapshot;
mod sync;
mod webdav;
mod window_chrome;

use tauri_plugin_opener::OpenerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 首实例启动时的命令行/关联文件参数（如 `lightink note.md` 或双击 .md）。
    // 相对路径按首实例进程 cwd 解析（首实例 cwd 即 shell cwd）。
    //
    // 注意：macOS 上 Finder 双击/「打开」走 Apple Event → RunEvent::Opened，
    // 不会可靠地出现在 argv；argv 解析主要服务 Windows / Linux 与 CLI。
    let first_file = cli::resolve_file_arg(&std::env::args().collect::<Vec<_>>(), None);

    let builder = tauri::Builder::default();
    // 单实例（桌面）：第二实例启动时把 argv 解析出的文件写入待打开槽并发出
    // `open-file` 信号，由前端取出开新标签，避免出现第二个窗口。
    // 回调把文件始终先落入 PendingFile 槽，转发/前端就绪失败时亦可经
    // take_pending_file 回退打开，不丢文件。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        // 相对路径必须按第二实例转发的 cwd 解析（首/第二实例 cwd 通常不同），
        // 否则 read_file 取错目录静默失败、文件被丢。
        // Linux 桌面可能传 file:// URL（MimeType + %U），resolve_file_arg 会归一。
        if let Some(path) = cli::resolve_file_arg(&args, Some(&cwd)) {
            cli::enqueue_pending_file(app, path);
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(cli::PendingFile(std::sync::Mutex::new(first_file)))
        .manage(remote::RemoteState::default())
        .manage(archive::ArchiveState::default())
        .manage(webdav::WebDavState::default())
        .manage(sync::SyncTaskState::default())
        .invoke_handler(tauri::generate_handler![
            file::read_file,
            file::read_file_bytes,
            file::write_file,
            file::stat_file,
            snapshot::write_snapshot,
            snapshot::clear_snapshot,
            snapshot::read_stale_snapshot,
            snapshot::list_untitled_drafts,
            asset::save_asset,
            asset::save_document_as,
            asset::import_image_asset,
            documents::managed_document_join,
            documents::managed_document_read,
            documents::managed_document_list,
            documents::managed_document_create_version,
            documents::managed_document_list_versions,
            documents::managed_document_read_version,
            documents::managed_document_save_draft,
            documents::managed_document_list_drafts,
            documents::managed_document_read_draft,
            documents::managed_document_delete_draft,
            export::read_image_base64,
            export::print_webview_to_pdf,
            cli::take_pending_file,
            recents::list_recents,
            recents::add_recent,
            recents::remove_recent,
            recents::clear_recents,
            library::library_list_sources,
            library::library_upsert_source,
            library::library_remove_source,
            library::library_list_items,
            library::library_list_acquisition_links,
            library::library_upsert_item,
            library::library_update_comic_metadata,
            library::library_set_offline_pinned,
            library::library_remove_item,
            library::library_clear_cache,
            library::library_set_cache_limit,
            library::library_cache_stats,
            groups::library_list_groups,
            groups::library_create_group,
            groups::library_update_group,
            groups::library_move_group,
            groups::library_delete_group,
            groups::library_list_group_memberships,
            groups::library_set_group_member,
            groups::library_set_item_groups,
            managed::library_import_managed_book,
            managed::library_preview_managed_migration,
            managed::library_apply_managed_migration,
            managed::library_materialize_item,
            remote::remote_open,
            remote::remote_info,
            remote::remote_read_range,
            remote::remote_close,
            remote::remote_cancel,
            remote::remote_store_credential,
            remote::remote_forget_credential,
            webdav::sync_get_profile,
            webdav::sync_save_profile,
            webdav::sync_test_profile,
            webdav::sync_forget_profile,
            webdav::sync_store_credential,
            sync::sync_device_id,
            sync::sync_list_records,
            sync::sync_write_record,
            sync::sync_list_conflicts,
            sync::sync_resolve_conflict,
            sync::sync_status,
            sync::sync_run,
            sync::sync_cancel,
            sync::sync_download_book,
            sync::sync_download_document,
            sync::sync_download_draft,
            archive::archive_open,
            archive::archive_open_nested,
            archive::archive_stage_nested,
            archive::archive_open_staged,
            archive::archive_discard_staged,
            archive::archive_read_entry,
            archive::archive_cancel,
            archive::archive_progress,
            archive::archive_close,
            opds::opds_add_source,
            opds::opds_list_sources,
            opds::opds_browse,
            opds::opds_search,
            opds::opds_remove_source,
            annotations::read_annotations,
            annotations::write_annotations,
            annotations::content_hash,
            snapshot::create_version,
            snapshot::list_versions,
            snapshot::read_version,
            snapshot::restore_version,
            open_in_browser,
            open_path_default,
            reveal_path_in_files,
            window_chrome::set_window_caption_color,
        ])
        // 用 build + run 才能接 RunEvent::Opened（macOS/iOS/Android 文件关联）。
        // Builder::run 会消费 builder 且不暴露事件循环钩子。
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS：Finder 打开关联文件 → Opened；冷启动与已运行时都可能触发。
            // 路径写入 PendingFile 槽 + emit open-file（与 single-instance 同口径）。
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(path) = cli::first_supported_from_urls(urls) {
                    cli::enqueue_pending_file(app, path);
                }
            }
            // 非 Apple/Android 目标：事件循环钩子仍需接住参数，避免 unused 警告。
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            {
                let _ = (app, event);
            }
        });
}

// ── R14 链接跳转 / R3 在文件管理器中显示 ──────────────────────────────
// 经 tauri-plugin-opener 的 Rust API（OpenerExt）实现：外部链接走系统浏览器、
// 本地文件走系统默认程序、reveal 在文件管理器中定位（T8 已 invoke 此命令）。

/// 在系统默认浏览器打开外部 URL（http(s) 等）。
#[tauri::command]
fn open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn validate_external_url(raw: &str) -> Result<url::Url, String> {
    if raw.chars().any(char::is_control) || contains_percent_encoded_control(raw) {
        return Err("external URL contains control characters".to_string());
    }
    let parsed = url::Url::parse(raw.trim()).map_err(|_| "invalid external URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("unsupported external URL scheme".to_string());
    }
    Ok(parsed)
}

fn contains_percent_encoded_control(raw: &str) -> bool {
    raw.as_bytes().windows(3).any(|part| {
        if part[0] != b'%' {
            return false;
        }
        let Some(high) = (part[1] as char).to_digit(16) else {
            return false;
        };
        let Some(low) = (part[2] as char).to_digit(16) else {
            return false;
        };
        let value = (high * 16 + low) as u8;
        value <= 0x1f || value == 0x7f
    })
}

/// 以系统默认方式打开本地文件（非 .md）。
#[tauri::command]
fn open_path_default(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 在系统文件管理器中定位该文件（R3 标签页右键「在文件管理器中显示」）。
#[tauri::command]
fn reveal_path_in_files(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn main_window_can_destroy_after_close_confirmation() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability must be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("default capability permissions must be an array");

        assert!(permissions
            .iter()
            .any(|permission| { permission.as_str() == Some("core:window:allow-destroy") }));
    }

    #[test]
    fn accepts_only_canonical_browser_schemes() {
        assert_eq!(
            validate_external_url("HTTPS://Example.COM/path")
                .unwrap()
                .as_str(),
            "https://example.com/path"
        );
        assert!(validate_external_url("http://localhost:8080/").is_ok());
    }

    #[test]
    fn rejects_custom_encoded_and_control_character_urls() {
        for value in [
            "mailto:a@example.com",
            "javascript:alert(1)",
            "file:///tmp/a",
            "//example.com/path",
            "%68%74%74%70%73%3A%2F%2Fevil.example",
            "https://example.com/%0aheader",
            "https://example.com/path\n",
            "https://",
        ] {
            assert!(validate_external_url(value).is_err(), "accepted {value:?}");
        }
    }
}
