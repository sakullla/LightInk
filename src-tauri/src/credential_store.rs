//! 凭据存储抽象（android-reader D5 / R3）。
//!
//! desktop target 直通 keyring（行为与既有调用点逐字节等价，`webdav.rs` /
//! `remote.rs` 的 KEYRING_SERVICE 语义不变）；Android（非 desktop）落地为
//! `<app_data_dir>/credentials/` 下的凭据文件，一逻辑条目一文件，消除
//! keyring 缺失时的 session-only 退化。应用私有目录由 Android 沙箱隔离，
//! 等价 0600 语义由系统保证，本模块不再显式 chmod。
//!
//! 文件名映射：`cred-<len>-<encode(service)>-<encode(reference)>`，其中
//! `encode` 为百分号编码（仅 `[A-Za-z0-9._-]` 原样保留，其余字节 `%XX`），
//! `len` 为编码后 service 的十进制长度，保证 (service, reference) 到文件名
//! 是单射、且全平台文件系统安全（Windows 测试亦受此约束，禁 `<>:"/\|?*`）。
//!
//! 移动端启动时由 `lib.rs` setup 调用 [`init_mobile_store`] 安装 base dir
//! （[`std::sync::OnceLock`]）；未安装时 get/set/delete 返回
//! None/false/no-op（防御分支：非 desktop 非 Android 同理）。desktop 上
//! `init_mobile_store` 为 no-op。

#[cfg(any(not(desktop), test))]
use std::fs;
#[cfg(any(not(desktop), test))]
use std::path::Path;
#[cfg(any(not(desktop), test))]
use std::path::PathBuf;
#[cfg(any(not(desktop), test))]
use std::sync::OnceLock;

#[cfg(any(not(desktop), test))]
const CREDENTIALS_DIR: &str = "credentials";

/// 移动端凭据文件 base dir：`<app_data_dir>/credentials/`，由
/// [`init_mobile_store`] 安装一次；未安装时文件后端不可用。
#[cfg(any(not(desktop), test))]
static BASE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 读取凭据。desktop 直通 keyring；非 desktop 读凭据文件，缺失/未初始化
/// 返回 None。
pub fn get_credential(service: &str, reference: &str) -> Option<String> {
    #[cfg(desktop)]
    {
        keyring::Entry::new(service, reference)
            .ok()
            .and_then(|entry| entry.get_password().ok())
    }
    #[cfg(not(desktop))]
    {
        let base = BASE_DIR.get()?;
        file_get(base, service, reference)
    }
}

/// 写入凭据，返回是否真正持久化。desktop 直通 keyring；非 desktop 写凭据
/// 文件，未初始化或 IO 失败返回 false（调用方保留 session-only 兜底）。
pub fn set_credential(service: &str, reference: &str, secret: &str) -> bool {
    #[cfg(desktop)]
    {
        keyring::Entry::new(service, reference)
            .and_then(|entry| entry.set_password(secret))
            .is_ok()
    }
    #[cfg(not(desktop))]
    {
        let Some(base) = BASE_DIR.get() else {
            return false;
        };
        file_set(base, service, reference, secret)
    }
}

/// 删除凭据，best-effort，失败静默（与既有 keyring 删除调用点语义一致）。
pub fn delete_credential(service: &str, reference: &str) {
    #[cfg(desktop)]
    {
        if let Ok(entry) = keyring::Entry::new(service, reference) {
            let _ = entry.delete_credential();
        }
    }
    #[cfg(not(desktop))]
    {
        if let Some(base) = BASE_DIR.get() {
            let _ = fs::remove_file(credential_path(base, service, reference));
        }
    }
}

/// 安装移动端凭据 base dir（`<app_data_dir>/credentials/`）。desktop 为
/// no-op；非 desktop 解析失败或重复安装时静默忽略（幂等，保留首次安装）。
#[cfg(not(desktop))]
pub fn init_mobile_store(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let base = app_data_dir.join(CREDENTIALS_DIR);
    let _ = fs::create_dir_all(&base);
    let _ = BASE_DIR.set(base);
}

/// desktop 上无移动端凭据目录，no-op。
#[cfg(desktop)]
pub fn init_mobile_store(_app: &tauri::AppHandle) {}

/// 测试专用：直接安装 base dir，返回是否首次安装成功。
#[cfg(test)]
fn init_for_test(dir: &Path) -> bool {
    let _ = fs::create_dir_all(dir);
    BASE_DIR.set(dir.to_path_buf()).is_ok()
}

/// 百分号编码：仅保留 `[A-Za-z0-9._-]`，其余字节编为 `%XX`（大写十六进制）。
#[cfg(any(not(desktop), test))]
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 凭据文件名：`cred-<len>-<encode(service)>-<encode(reference)>`。
/// `len` 前缀使拼接单射（编码输出不含长度信息，仅靠分隔符会有歧义）。
#[cfg(any(not(desktop), test))]
fn credential_file_name(service: &str, reference: &str) -> String {
    let encoded_service = encode_component(service);
    format!(
        "cred-{}-{}-{}",
        encoded_service.len(),
        encoded_service,
        encode_component(reference)
    )
}

#[cfg(any(not(desktop), test))]
fn credential_path(base: &Path, service: &str, reference: &str) -> PathBuf {
    base.join(credential_file_name(service, reference))
}

#[cfg(any(not(desktop), test))]
fn file_get(base: &Path, service: &str, reference: &str) -> Option<String> {
    fs::read_to_string(credential_path(base, service, reference)).ok()
}

#[cfg(any(not(desktop), test))]
fn file_set(base: &Path, service: &str, reference: &str, secret: &str) -> bool {
    if fs::create_dir_all(base).is_err() {
        return false;
    }
    fs::write(credential_path(base, service, reference), secret).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn encode_component_leaves_unreserved_and_escapes_rest() {
        assert_eq!(encode_component("abcXYZ-0.9_ok"), "abcXYZ-0.9_ok");
        assert_eq!(encode_component("a/b c:d"), "a%2Fb%20c%3Ad");
        assert_eq!(encode_component("100%"), "100%25");
        assert_eq!(encode_component(""), "");
    }

    #[test]
    fn credential_file_name_is_deterministic_and_fs_safe() {
        let name = credential_file_name("lightink-sync", "sync-profile-1");
        assert_eq!(
            name,
            credential_file_name("lightink-sync", "sync-profile-1")
        );
        assert!(name.starts_with("cred-"));
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '%')),
            "file name must be filesystem-safe on all targets: {name}"
        );
    }

    #[test]
    fn credential_file_name_is_injective_across_pairs() {
        // 仅靠 "--" 分隔会有歧义的对儿（service 以 '-' 结尾）必须得到不同文件名。
        let a = credential_file_name("svc-", "ref");
        let b = credential_file_name("svc", "-ref");
        assert_ne!(a, b);
        assert_ne!(
            credential_file_name("svc", "ref-1"),
            credential_file_name("svc", "ref-2")
        );
        assert_ne!(
            credential_file_name("svc-a", "ref"),
            credential_file_name("svc-b", "ref")
        );
    }

    #[test]
    fn file_backed_round_trip_and_delete() {
        let dir = temp_dir();
        let base = dir.path().join(CREDENTIALS_DIR);

        assert!(file_get(&base, "svc", "ref").is_none());
        assert!(file_set(&base, "svc", "ref", "secret-值"));
        assert_eq!(file_get(&base, "svc", "ref").as_deref(), Some("secret-值"));

        // 覆盖写与同 reference 不同 service 互不干扰。
        assert!(file_set(&base, "svc", "ref", "secret-2"));
        assert!(file_set(&base, "other", "ref", "secret-3"));
        assert_eq!(file_get(&base, "svc", "ref").as_deref(), Some("secret-2"));
        assert_eq!(file_get(&base, "other", "ref").as_deref(), Some("secret-3"));

        let _ = fs::remove_file(credential_path(&base, "svc", "ref"));
        assert!(file_get(&base, "svc", "ref").is_none());
        assert_eq!(file_get(&base, "other", "ref").as_deref(), Some("secret-3"));
    }

    #[test]
    fn file_set_creates_missing_base_dir() {
        let dir = temp_dir();
        let base = dir.path().join("nested").join(CREDENTIALS_DIR);
        assert!(file_set(&base, "svc", "ref", "v"));
        assert_eq!(file_get(&base, "svc", "ref").as_deref(), Some("v"));
    }

    #[test]
    fn init_for_test_installs_base_dir_once() {
        let dir = temp_dir();
        let installed = init_for_test(dir.path());
        if installed {
            // 本进程内首次安装成功；重复安装必须被拒绝（OnceLock 语义）。
            assert!(!init_for_test(dir.path()));
            assert_eq!(BASE_DIR.get().map(PathBuf::as_path), Some(dir.path()));
        } else {
            // 其它测试已安装：OnceLock 只承认首个 base dir。
            assert!(BASE_DIR.get().is_some());
        }
    }
}
