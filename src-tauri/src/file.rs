//! 字节级文件读写服务（T3）。
//!
//! Rust 侧只做 UTF-8 字节的读取与原子写入，不解析 Markdown —— 文档模型的
//! 唯一 owner 是前端编辑器会话。写入采用「同目录临时文件 + rename」的原子写
//! 策略：失败时清理临时文件并返回错误，目标路径上永远不会留下半截文件。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// 读取 UTF-8 文本文件。io 错误映射为可读的中文错误信息。
pub fn read_file_impl(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("无法读取文件 {}: {}", path.display(), e))
}

/// 原子写入：先写同目录临时文件并 flush/sync，再 rename 覆盖目标。
///
/// 使用 `tempfile::NamedTempFile`：临时文件与目标同目录（保证 rename
/// 不跨文件系统）；`persist` 在 Windows 上走 MoveFileExW +
/// MOVEFILE_REPLACE_EXISTING，目标已存在时同样原子覆盖。任何一步失败，
/// `NamedTempFile` 的 Drop 会自动清理临时文件，目标路径绝不会留下
/// 半截文件，原文件保持不动。
pub fn write_file_impl(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的保存路径: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {}: {}", parent.display(), e))?;

    let mut tmp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法创建临时文件: {}", e))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("同步临时文件失败: {}", e))?;
    tmp.persist(path)
        .map_err(|e| format!("无法保存到 {}: {}", path.display(), e.error))?;
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    read_file_impl(Path::new(&path))
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    write_file_impl(Path::new(&path), &content)
}

/// 文件 stat 结果（返回前端用于外部变更检测）：元数据加内容指纹。
#[derive(serde::Serialize, Debug)]
pub struct FileStat {
    pub mtime_ms: u64,
    pub size: u64,
    pub fingerprint: String,
}

fn fingerprint_reader(mut reader: impl Read) -> Result<String, std::io::Error> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(format!("{:016x}", hash))
}

/// 取文件的修改时间、大小与内容指纹。读不到文件/修改时间时报可读中文错误
/// （R13 失败行为：stat 失败 → 前端提示文件不可读，不做自动动作）。
pub fn stat_file_impl(path: &Path) -> Result<FileStat, String> {
    let file =
        File::open(path).map_err(|e| format!("无法读取文件信息 {}: {}", path.display(), e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息 {}: {}", path.display(), e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("无法读取修改时间 {}: {}", path.display(), e))?;
    // mtime 早于 UNIX_EPOCH（极端情况）视为 0；正常文件不会触发。
    let mtime_ms = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let fingerprint = fingerprint_reader(file)
        .map_err(|e| format!("无法计算文件指纹 {}: {}", path.display(), e))?;
    Ok(FileStat {
        mtime_ms,
        size: meta.len(),
        fingerprint,
    })
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    stat_file_impl(Path::new(&path))
}

/// 标准 base64 编码表（与 asset.rs 自实现 decoder 的字母表一致，无新 crate）。
const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 编码为标准 base64（含 `+` `/` 与 `=` 填充）。供 `read_file_bytes` 把二进制电子书
/// 字节以字符串形式经 IPC 传给前端（前端 atob 解码）。输入可以是任意字节（含中文、
/// 二进制）；输出长度 = ceil(len/3)*4。逐 3 字节分组、u32 移位不溢出。
pub fn encode_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 读取文件的原始字节（不做 UTF-8 解码，电子书多为二进制）。io 错误映射为可读中文信息。
pub fn read_file_bytes_impl(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("无法读取文件 {}: {}", path.display(), e))
}

/// 读取文件字节并以标准 base64 返回（供前端 reader 解析二进制电子书格式）。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<String, String> {
    let bytes = read_file_bytes_impl(Path::new(&path))?;
    Ok(encode_base64(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn roundtrip_chinese_and_special_chars() {
        let dir = temp_dir();
        let path = dir.path().join("笔记.md");
        let content =
            "# 标题 🎉\n\n中文内容、特殊字符 <>&\"'\\、emoji 🚀、零宽\u{200b}字符。\n\n第二行\n";
        write_file_impl(&path, content).expect("write");
        let back = read_file_impl(&path).expect("read");
        assert_eq!(back, content);
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = temp_dir();
        let path = dir.path().join("a.md");
        write_file_impl(&path, "old content").expect("write old");
        write_file_impl(&path, "new content").expect("write new");
        assert_eq!(read_file_impl(&path).unwrap(), "new content");
        // 临时文件不应残留：目录里应只有目标文件
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["a.md".to_string()], "unexpected leftovers");
    }

    #[test]
    fn failed_write_leaves_original_intact() {
        // 目标位于不存在的深层路径且父目录创建失败时：
        // 用一个「文件」当作目录，create_dir_all 必然失败。
        let dir = temp_dir();
        let blocker = dir.path().join("blocker");
        write_file_impl(&blocker, "i am a file").expect("write blocker");
        let bad_target = blocker.join("sub").join("x.md");
        let err = write_file_impl(&bad_target, "data").expect_err("must fail");
        assert!(err.contains("无法创建目录"), "unexpected error: {}", err);
        // 原文件不受影响
        assert_eq!(read_file_impl(&blocker).unwrap(), "i am a file");
        assert!(!bad_target.exists(), "partial file must not exist");
    }

    #[test]
    fn read_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.md");
        let err = read_file_impl(&missing).expect_err("must fail");
        assert!(err.contains("无法读取文件"), "unexpected error: {}", err);
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let dir = temp_dir();
        let path = dir.path().join("deep").join("nested").join("f.md");
        write_file_impl(&path, "hello").expect("write");
        assert_eq!(read_file_impl(&path).unwrap(), "hello");
    }

    #[test]
    fn stat_returns_mtime_and_size() {
        let dir = temp_dir();
        let path = dir.path().join("stat.md");
        let content = "# 笔记 📝\n中文内容\n";
        write_file_impl(&path, content).expect("write");
        let st = stat_file_impl(&path).expect("stat");
        assert_eq!(st.size, content.len() as u64);
        assert!(st.mtime_ms > 0, "mtime should be a real epoch ms");
        assert_eq!(st.fingerprint.len(), 16);
        write_file_impl(&path, "different").expect("replace");
        let changed = stat_file_impl(&path).expect("stat changed");
        assert_ne!(st.fingerprint, changed.fingerprint);
    }

    #[test]
    fn stat_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.md");
        let err = stat_file_impl(&missing).expect_err("must fail");
        assert!(
            err.contains("无法读取文件信息"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn base64_known_vectors() {
        // RFC 4648 标准测试向量（覆盖 0/1/2/3 字节与全部填充分支）。
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(encode_base64(b"lightink"), "bGlnaHRpbms=");
        assert_eq!(encode_base64(b"Hello, World!"), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_length_and_padding_for_binary() {
        // 非 UTF-8 二进制边界值（0x00/0xff）：长度恒为 4 的倍数，填充正确。
        assert_eq!(encode_base64(&[0xffu8]).len(), 4); // 1 字节 → 2 填充
        assert_eq!(encode_base64(&[0xffu8, 0x00]).len(), 4); // 2 字节 → 1 填充
        let bin = [0x00u8, 0xff, 0x80, 0x7f, 0x01];
        let enc = encode_base64(&bin);
        assert_eq!(enc.len(), 8);
        assert_eq!(enc.matches('=').count(), 1); // 5 字节 → 1 填充
                                                 // 中文 UTF-8 字节同样满足长度约束。
        let zh = encode_base64("轻墨 🚀".as_bytes());
        assert_eq!(zh.len() % 4, 0);
    }

    #[test]
    fn read_file_bytes_returns_raw_bytes() {
        let dir = temp_dir();
        let path = dir.path().join("book.epub");
        // 二进制内容（含非 UTF-8 字节）：read_file_bytes_impl 必须原样返回字节，不做 UTF-8 解码。
        let raw = [0x50u8, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f];
        std::fs::write(&path, raw).expect("write");
        let bytes = super::read_file_bytes_impl(&path).expect("read bytes");
        assert_eq!(bytes, raw.to_vec());
        // base64 编码长度正确（read_file_bytes 命令的返回形态）。
        let b64 = super::encode_base64(&bytes);
        assert_eq!(b64.len(), ((raw.len() + 2) / 3) * 4);
    }

    #[test]
    fn read_file_bytes_large_file_does_not_overflow() {
        // 大文件：base64 编码不得 panic/溢出（u32 移位安全、String 可增长）。
        let dir = temp_dir();
        let path = dir.path().join("big.bin");
        let size = 1_000_003u64; // 非 3 的倍数，触发尾部填充分支
        let mut big = Vec::with_capacity(size as usize);
        let mut x = 1u8;
        for _ in 0..size {
            big.push(x);
            x = x.wrapping_mul(31).wrapping_add(1);
        }
        std::fs::write(&path, &big).expect("write");
        let bytes = super::read_file_bytes_impl(&path).expect("read");
        assert_eq!(bytes.len() as u64, size);
        let b64 = super::encode_base64(&bytes);
        assert_eq!(b64.len(), ((size as usize + 2) / 3) * 4);
    }

    #[test]
    fn read_file_bytes_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.epub");
        let err = super::read_file_bytes_impl(&missing).expect_err("must fail");
        assert!(err.contains("无法读取文件"), "unexpected error: {}", err);
    }
}
