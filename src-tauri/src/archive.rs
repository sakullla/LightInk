//! Native RAR/7z archive sessions for comic reading.
//!
//! Sessions retain only source metadata and an optional in-memory password.
//! Payloads are decoded into a bounded buffer for the requested entry; no
//! external archive executable is invoked and nothing is expanded to a tree.

use crate::library;
use crate::remote::{self, RemoteState};
use rars::{
    Archive as RarArchive, ArchiveMemberDetail, ArchiveReadOptions,
    ArchiveReader as RarArchiveReader, Error as RarError,
};
use serde::Serialize;
use sevenz_rust2::{
    ArchiveReader as SevenZArchiveReader, EncoderMethod, Error as SevenZError, Password,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;
use zip::result::ZipError;
use zip::ZipArchive;

const MAX_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;
const MAX_NESTED_DEPTH: u8 = 3;
const MAX_DECODE_CACHE_BYTES: usize = 128 * 1024 * 1024;
const ZIP_HANDLE_POOL_CAP: usize = 4;

const RAR4_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x00";
const RAR5_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";
const SEVEN_Z_SIGNATURE: &[u8] = b"7z\xbc\xaf\x27\x1c";
const ZIP_SIGNATURES: [&[u8]; 3] = [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveError {
    pub code: String,
    pub message: String,
}

impl ArchiveError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeFormat {
    Rar,
    SevenZ,
    Zip,
}

trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

struct CancellableIo<R> {
    inner: R,
    cancelled: Arc<AtomicBool>,
}

fn cancelled_io_error() -> std::io::Error {
    std::io::Error::other("archive range read cancelled")
}

fn is_cancelled_io(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::Interrupted
        || error.to_string().contains("archive range read cancelled")
}

impl<R: Read> Read for CancellableIo<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(cancelled_io_error());
        }
        self.inner.read(output)
    }
}

impl<R: Seek> Seek for CancellableIo<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(cancelled_io_error());
        }
        self.inner.seek(pos)
    }
}

#[derive(Debug, Clone)]
enum ArchiveSource {
    Local {
        path: PathBuf,
        identity: String,
    },
    Remote {
        resource_id: String,
        cache_path: PathBuf,
        identity: String,
        size: u64,
        cache_complete: bool,
    },
}

impl ArchiveSource {
    fn identity(&self) -> &str {
        match self {
            Self::Local { identity, .. } | Self::Remote { identity, .. } => identity,
        }
    }

    fn cache_path(&self) -> &Path {
        match self {
            Self::Local { path, .. } => path,
            Self::Remote { cache_path, .. } => cache_path,
        }
    }

    fn display_path(&self) -> &Path {
        self.cache_path()
    }

    fn reader(
        &self,
        app: Option<&AppHandle>,
        request_id: &str,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Box<dyn ReadSeek + Send>, ArchiveError> {
        match self {
            Self::Local { path, .. } => {
                let file = File::open(path)
                    .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法打开归档文件"))?;
                Ok(Box::new(CancellableIo {
                    inner: file,
                    cancelled,
                }))
            }
            Self::Remote {
                resource_id, size, ..
            } => Ok(Box::new(RemoteRangeReader {
                app: app.cloned().ok_or_else(|| {
                    ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "远程读取状态不可用")
                })?,
                resource_id: resource_id.clone(),
                request_id: request_id.to_string(),
                size: *size,
                position: 0,
                cancelled,
            })),
        }
    }

    fn temporary_path(&self) -> Option<&Path> {
        match self {
            Self::Local { path, identity } if identity.starts_with("nested:") => Some(path),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct RemoteReadError(remote::RemoteError);

impl std::fmt::Display for RemoteReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0.message)
    }
}

impl std::error::Error for RemoteReadError {}

struct RemoteRangeReader {
    app: AppHandle,
    resource_id: String,
    request_id: String,
    size: u64,
    position: u64,
    cancelled: Arc<AtomicBool>,
}

impl Read for RemoteRangeReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if output.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "archive range read cancelled",
            ));
        }
        let length = (output.len() as u64)
            .min(remote::MAX_RANGE_BYTES)
            .min(self.size - self.position);
        let state = self.app.state::<RemoteState>();
        let bytes = tauri::async_runtime::block_on(remote::read_range_bytes(
            &self.app,
            state.inner(),
            &self.resource_id,
            self.position,
            length,
            Some(self.request_id.clone()),
        ))
        .map_err(|error| std::io::Error::other(RemoteReadError(error)))?;
        output[..bytes.len()].copy_from_slice(&bytes);
        self.position = self.position.saturating_add(bytes.len() as u64);
        Ok(bytes.len())
    }
}

impl Seek for RemoteRangeReader {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::End(value) => i128::from(self.size) + i128::from(value),
            SeekFrom::Current(value) => i128::from(self.position) + i128::from(value),
        };
        if next < 0 || next > i128::from(self.size) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "archive seek is outside the resource",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedArchiveFormat {
    Rar4,
    Rar5,
    SevenZ,
    Zip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeArchiveEntry {
    pub id: String,
    pub filename: String,
    pub directory: bool,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub encrypted: bool,
    pub solid: bool,
    pub split: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOpenResult {
    pub archive_id: String,
    pub format: String,
    pub access_mode: String,
    pub solid: bool,
    pub encrypted: bool,
    pub multivolume: bool,
    pub entries: Vec<NativeArchiveEntry>,
    pub depth: u8,
    pub cumulative_uncompressed_bytes: u64,
}

#[derive(Debug)]
struct InspectedArchive {
    format: NativeFormat,
    format_name: String,
    solid: bool,
    encrypted: bool,
    entries: Vec<NativeArchiveEntry>,
}

struct ZipHandlePool {
    handles: Mutex<Vec<ZipArchive<Box<dyn ReadSeek + Send>>>>,
}

impl ZipHandlePool {
    fn take(
        &self,
        source: &ArchiveSource,
        app: Option<&AppHandle>,
        request_id: &str,
        cancelled: Arc<AtomicBool>,
    ) -> Result<ZipArchive<Box<dyn ReadSeek + Send>>, ArchiveError> {
        if let Some(archive) = self
            .handles
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
            .pop()
        {
            return Ok(archive);
        }
        let reader = source.reader(app, request_id, cancelled)?;
        ZipArchive::new(reader).map_err(map_zip_error)
    }

    fn restore(&self, archive: ZipArchive<Box<dyn ReadSeek + Send>>) {
        if let Ok(mut handles) = self.handles.lock() {
            if handles.len() < ZIP_HANDLE_POOL_CAP {
                handles.push(archive);
            }
        }
    }
}

impl std::fmt::Debug for ZipHandlePool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZipHandlePool").finish()
    }
}

#[derive(Debug)]
struct ArchiveSession {
    source: ArchiveSource,
    format: NativeFormat,
    solid: bool,
    entries: Vec<NativeArchiveEntry>,
    password: Option<Zeroizing<String>>,
    depth: u8,
    cumulative_uncompressed_bytes: u64,
    decode_lock: Arc<Mutex<()>>,
    decoded: Arc<Mutex<DecodedEntryCache>>,
    zip_handles: Arc<ZipHandlePool>,
    active_cancels: Vec<Arc<AtomicBool>>,
    progress: Arc<Mutex<ArchiveProgress>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    phase: String,
    current_entry: usize,
    target_entry: usize,
    decoded_bytes: u64,
}

impl Default for ArchiveProgress {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            current_entry: 0,
            target_entry: 0,
            decoded_bytes: 0,
        }
    }
}

#[derive(Debug, Default)]
struct DecodedEntryCache {
    entries: HashMap<usize, Arc<Vec<u8>>>,
    order: VecDeque<usize>,
    bytes: usize,
}

struct SolidDecodeState {
    cancelled: Arc<AtomicBool>,
    decoded: Arc<Mutex<DecodedEntryCache>>,
    progress: Arc<Mutex<ArchiveProgress>>,
}

impl DecodedEntryCache {
    fn get(&mut self, index: usize) -> Option<Arc<Vec<u8>>> {
        let value = self.entries.get(&index).cloned()?;
        self.order.retain(|candidate| *candidate != index);
        self.order.push_back(index);
        Some(value)
    }

    fn insert(&mut self, index: usize, bytes: Vec<u8>) -> Arc<Vec<u8>> {
        if let Some(previous) = self.entries.remove(&index) {
            self.bytes = self.bytes.saturating_sub(previous.len());
            self.order.retain(|candidate| *candidate != index);
        }
        let value = Arc::new(bytes);
        if value.len() <= MAX_DECODE_CACHE_BYTES {
            self.bytes = self.bytes.saturating_add(value.len());
            self.entries.insert(index, Arc::clone(&value));
            self.order.push_back(index);
            while self.bytes > MAX_DECODE_CACHE_BYTES {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                if let Some(removed) = self.entries.remove(&oldest) {
                    self.bytes = self.bytes.saturating_sub(removed.len());
                }
            }
        }
        value
    }
}

#[derive(Debug, Clone)]
struct StagedArchive {
    source: ArchiveSource,
    depth: u8,
    parent_uncompressed_bytes: u64,
}

pub struct ArchiveState {
    sessions: Mutex<HashMap<String, Arc<Mutex<ArchiveSession>>>>,
    staged: Mutex<HashMap<String, StagedArchive>>,
    temporary_paths: Mutex<HashMap<PathBuf, usize>>,
    pending_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    sequence: AtomicU64,
}

impl Default for ArchiveState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
            temporary_paths: Mutex::new(HashMap::new()),
            pending_cancels: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }
}

fn source_cancel_key(source: &ArchiveSource) -> String {
    match source {
        ArchiveSource::Local { path, .. } => format!("path:{}", path.to_string_lossy()),
        ArchiveSource::Remote { resource_id, .. } => format!("resource:{resource_id}"),
    }
}

fn args_cancel_key(path: Option<&str>, resource_id: Option<&str>) -> Option<String> {
    if let Some(path) = path {
        return Some(format!("path:{path}"));
    }
    resource_id.map(|resource_id| format!("resource:{resource_id}"))
}

pub fn detect_archive_format(prefix: &[u8]) -> Option<DetectedArchiveFormat> {
    if prefix.starts_with(RAR5_SIGNATURE) {
        Some(DetectedArchiveFormat::Rar5)
    } else if prefix.starts_with(RAR4_SIGNATURE) {
        Some(DetectedArchiveFormat::Rar4)
    } else if prefix.starts_with(SEVEN_Z_SIGNATURE) {
        Some(DetectedArchiveFormat::SevenZ)
    } else if ZIP_SIGNATURES
        .iter()
        .any(|signature| prefix.starts_with(signature))
    {
        Some(DetectedArchiveFormat::Zip)
    } else {
        None
    }
}

#[cfg(test)]
fn read_magic(path: &Path) -> Result<DetectedArchiveFormat, ArchiveError> {
    let mut file =
        File::open(path).map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法打开归档文件"))?;
    let mut prefix = [0_u8; 8];
    let read = file
        .read(&mut prefix)
        .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法读取归档文件"))?;
    detect_archive_format(&prefix[..read]).ok_or_else(|| {
        ArchiveError::new(
            "ARCHIVE_FORMAT_UNSUPPORTED",
            "文件不是受支持的 ZIP、RAR 或 7z 归档",
        )
    })
}

fn read_source_magic(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    request_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<DetectedArchiveFormat, ArchiveError> {
    let mut reader = source.reader(app, request_id, cancelled)?;
    let mut prefix = [0_u8; 8];
    let read = reader.read(&mut prefix).map_err(|error| {
        if error.kind() == std::io::ErrorKind::Interrupted {
            ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消")
        } else {
            ArchiveError::new("ARCHIVE_IO", "无法读取归档文件")
        }
    })?;
    detect_archive_format(&prefix[..read]).ok_or_else(|| {
        ArchiveError::new(
            "ARCHIVE_FORMAT_UNSUPPORTED",
            "文件不是受支持的 ZIP、RAR 或 7z 归档",
        )
    })
}

fn validate_entries(
    entries: &[NativeArchiveEntry],
    solid: bool,
    parent_uncompressed_bytes: u64,
) -> Result<u64, ArchiveError> {
    if entries.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_LIMIT",
            format!("归档条目数超过上限 {MAX_ARCHIVE_ENTRIES}"),
        ));
    }
    let mut total_uncompressed = 0_u64;
    let mut total_compressed = 0_u64;
    for entry in entries.iter().filter(|entry| !entry.directory) {
        if entry.uncompressed_size > MAX_ENTRY_UNCOMPRESSED_BYTES {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                format!("归档条目超过 {} 字节上限", MAX_ENTRY_UNCOMPRESSED_BYTES),
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.uncompressed_size);
        total_compressed = total_compressed.saturating_add(entry.compressed_size);
        if !solid
            && entry.uncompressed_size > 0
            && (entry.compressed_size == 0
                || entry.uncompressed_size
                    > entry.compressed_size.saturating_mul(MAX_COMPRESSION_RATIO))
        {
            return Err(ArchiveError::new(
                "ARCHIVE_COMPRESSION_RATIO_LIMIT",
                "归档条目的压缩比超过安全上限",
            ));
        }
    }
    let cumulative = parent_uncompressed_bytes.saturating_add(total_uncompressed);
    if cumulative > MAX_TOTAL_UNCOMPRESSED_BYTES {
        return Err(ArchiveError::new(
            "ARCHIVE_TOTAL_SIZE_LIMIT",
            format!(
                "跨层归档累计解压大小超过 {} 字节上限",
                MAX_TOTAL_UNCOMPRESSED_BYTES
            ),
        ));
    }
    if solid
        && total_uncompressed > 0
        && (total_compressed == 0
            || total_uncompressed > total_compressed.saturating_mul(MAX_COMPRESSION_RATIO))
    {
        return Err(ArchiveError::new(
            "ARCHIVE_COMPRESSION_RATIO_LIMIT",
            "固实归档的累计压缩比超过安全上限",
        ));
    }
    Ok(cumulative)
}

fn map_zip_error(error: ZipError) -> ArchiveError {
    match error {
        ZipError::FileNotFound => ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "ZIP 条目不存在"),
        ZipError::Io(error) if is_cancelled_io(&error) => {
            ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消")
        }
        ZipError::Io(error)
            if error
                .get_ref()
                .and_then(|source| source.downcast_ref::<RemoteReadError>())
                .is_some() =>
        {
            let remote = error
                .get_ref()
                .and_then(|source| source.downcast_ref::<RemoteReadError>())
                .expect("guarded remote read error");
            ArchiveError::new(remote.0.code.clone(), remote.0.message.clone())
        }
        ZipError::UnsupportedArchive(_) => ArchiveError::new(
            "ARCHIVE_CODEC_UNSUPPORTED",
            "ZIP 使用了当前版本不支持的压缩或加密能力",
        ),
        ZipError::InvalidArchive(_) => {
            ArchiveError::new("ARCHIVE_CORRUPT", "ZIP 归档损坏或无法解析")
        }
        ZipError::Io(_) => ArchiveError::new("ARCHIVE_IO", "读取 ZIP 归档失败"),
        _ => ArchiveError::new("ARCHIVE_CORRUPT", "ZIP 归档损坏或无法解析"),
    }
}

fn map_rar_error(error: RarError) -> ArchiveError {
    match error {
        RarError::NeedPassword => ArchiveError::new("ARCHIVE_PASSWORD_REQUIRED", "归档需要密码"),
        RarError::WrongPasswordOrCorruptData => {
            ArchiveError::new("ARCHIVE_PASSWORD_INCORRECT", "归档密码错误")
        }
        RarError::UnsupportedCompression { .. }
        | RarError::UnsupportedEncryption { .. }
        | RarError::UnsupportedFeature { .. }
        | RarError::UnsupportedFamilyFeature { .. }
        | RarError::UnsupportedVersion(_) => ArchiveError::new(
            "ARCHIVE_CODEC_UNSUPPORTED",
            "归档使用了当前版本不支持的 RAR 压缩或加密能力",
        ),
        RarError::Cancelled => ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"),
        RarError::MemoryLimitExceeded { .. } => {
            ArchiveError::new("ARCHIVE_MEMORY_LIMIT", "RAR 解码工作区超过内存限制")
        }
        RarError::Rar50BufferedDecodeLimitExceeded { .. } => {
            ArchiveError::new("ARCHIVE_ENTRY_TOO_LARGE", "RAR 条目解码超过大小上限")
        }
        RarError::Io(_) => ArchiveError::new("ARCHIVE_IO", "读取 RAR 归档失败"),
        _ => ArchiveError::new("ARCHIVE_CORRUPT", "RAR 归档损坏或无法解析"),
    }
}

fn map_sevenz_error(error: SevenZError) -> ArchiveError {
    match error {
        SevenZError::PasswordRequired => {
            ArchiveError::new("ARCHIVE_PASSWORD_REQUIRED", "归档需要密码")
        }
        SevenZError::MaybeBadPassword(_) => {
            ArchiveError::new("ARCHIVE_PASSWORD_INCORRECT", "归档密码错误")
        }
        SevenZError::UnsupportedCompressionMethod(_)
        | SevenZError::ExternalUnsupported
        | SevenZError::Unsupported(_) => ArchiveError::new(
            "ARCHIVE_CODEC_UNSUPPORTED",
            "归档使用了当前版本不支持的 7z 压缩能力",
        ),
        SevenZError::MaxMemLimited { .. } => {
            ArchiveError::new("ARCHIVE_MEMORY_LIMIT", "7z 解码工作区超过内存限制")
        }
        SevenZError::Io(error, _)
            if error
                .get_ref()
                .and_then(|source| source.downcast_ref::<RemoteReadError>())
                .is_some() =>
        {
            let remote = error
                .get_ref()
                .and_then(|source| source.downcast_ref::<RemoteReadError>())
                .expect("guarded remote read error");
            ArchiveError::new(remote.0.code.clone(), remote.0.message.clone())
        }
        SevenZError::Io(error, _) if error.kind() == std::io::ErrorKind::Interrupted => {
            ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消")
        }
        SevenZError::Io(error, _)
            if matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::InvalidData
            ) =>
        {
            ArchiveError::new("ARCHIVE_CORRUPT", "7z 归档损坏或内容不完整")
        }
        SevenZError::Io(_, _) | SevenZError::FileOpen(_, _) => {
            ArchiveError::new("ARCHIVE_IO", "读取 7z 归档失败")
        }
        _ => ArchiveError::new("ARCHIVE_CORRUPT", "7z 归档损坏或无法解析"),
    }
}

fn inspect_rar(
    path: &Path,
    password: Option<&str>,
    parent_uncompressed_bytes: u64,
) -> Result<(InspectedArchive, u64), ArchiveError> {
    let options = ArchiveReadOptions::with_optional_password(password.map(str::as_bytes))
        .with_rar50_buffered_decode_limit(MAX_ENTRY_UNCOMPRESSED_BYTES);
    let archive = RarArchiveReader::read_path_with_options(path, options).map_err(map_rar_error)?;
    let (format_name, solid, multivolume) = match &archive {
        RarArchive::Rar13(value) => ("rar4", value.main.is_solid(), value.main.is_volume()),
        RarArchive::Rar15To40(value) => ("rar4", value.main.is_solid(), value.main.is_volume()),
        RarArchive::Rar50Plus(value) => ("rar5", value.main.is_solid(), value.main.is_volume()),
        _ => {
            return Err(ArchiveError::new(
                "ARCHIVE_CODEC_UNSUPPORTED",
                "当前版本无法读取该 RAR 归档系列",
            ))
        }
    };
    let entries: Vec<NativeArchiveEntry> = archive
        .members()
        .enumerate()
        .map(|(index, member)| {
            let entry_solid = solid
                || matches!(
                    member.detail,
                    ArchiveMemberDetail::Rar15To40 { solid: true, .. }
                );
            NativeArchiveEntry {
                id: format!("entry-{index}"),
                filename: member.meta.name_lossy(),
                directory: member.meta.is_directory,
                compressed_size: member.meta.packed_size,
                uncompressed_size: member.meta.unpacked_size,
                encrypted: member.meta.is_encrypted,
                solid: entry_solid,
                split: member.meta.is_split_before || member.meta.is_split_after,
            }
        })
        .collect();
    if multivolume || entries.iter().any(|entry| entry.split) {
        return Err(ArchiveError::new(
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED",
            "暂不支持多卷 RAR 归档",
        ));
    }
    let cumulative = validate_entries(&entries, solid, parent_uncompressed_bytes)?;
    let encrypted = entries.iter().any(|entry| entry.encrypted);
    if encrypted && password.is_none() {
        return Err(ArchiveError::new(
            "ARCHIVE_PASSWORD_REQUIRED",
            "归档需要密码",
        ));
    }
    Ok((
        InspectedArchive {
            format: NativeFormat::Rar,
            format_name: format_name.to_string(),
            solid,
            encrypted,
            entries,
        },
        cumulative,
    ))
}

fn looks_like_split_sevenz(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.contains(".7z.")
        && name.rsplit('.').next().is_some_and(|part| {
            part.len() == 3 && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn inspect_zip_source(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    parent_uncompressed_bytes: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<(InspectedArchive, u64), ArchiveError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    let reader = source.reader(app, "archive-zip-inspect", Arc::clone(&cancelled))?;
    let mut archive = ZipArchive::new(reader).map_err(map_zip_error)?;
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
        }
        let entry = archive.by_index(index).map_err(map_zip_error)?;
        entries.push(NativeArchiveEntry {
            id: format!("entry-{index}"),
            filename: entry.name().to_string(),
            directory: entry.is_dir(),
            compressed_size: entry.compressed_size(),
            uncompressed_size: entry.size(),
            encrypted: false,
            solid: false,
            split: false,
        });
    }
    let cumulative = validate_entries(&entries, false, parent_uncompressed_bytes)?;
    Ok((
        InspectedArchive {
            format: NativeFormat::Zip,
            format_name: "zip".to_string(),
            solid: false,
            encrypted: false,
            entries,
        },
        cumulative,
    ))
}

fn open_sevenz_reader(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    request_id: &str,
    cancelled: Arc<AtomicBool>,
    password: Option<&str>,
) -> Result<SevenZArchiveReader<Box<dyn ReadSeek + Send>>, ArchiveError> {
    let reader = source.reader(app, request_id, cancelled)?;
    let password_value = password.map(Password::new).unwrap_or_else(Password::empty);
    SevenZArchiveReader::new(reader, password_value).map_err(map_sevenz_error)
}

fn inspect_sevenz_source(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    password: Option<&str>,
    parent_uncompressed_bytes: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<(InspectedArchive, u64), ArchiveError> {
    if looks_like_split_sevenz(source.display_path()) {
        return Err(ArchiveError::new(
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED",
            "暂不支持多卷 7z 归档",
        ));
    }
    let reader = open_sevenz_reader(source, app, "archive-inspect", cancelled, password)?;
    let archive = reader.archive();
    let entries: Vec<NativeArchiveEntry> = archive
        .files
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let encrypted = archive.stream_map.file_block_index[index]
                .and_then(|block_index| archive.blocks.get(block_index))
                .is_some_and(|block| {
                    block
                        .coders
                        .iter()
                        .any(|coder| coder.encoder_method_id() == EncoderMethod::ID_AES256_SHA256)
                });
            NativeArchiveEntry {
                id: format!("entry-{index}"),
                filename: entry.name.clone(),
                directory: entry.is_directory,
                compressed_size: entry.compressed_size,
                uncompressed_size: entry.size,
                encrypted,
                solid: archive.is_solid,
                split: false,
            }
        })
        .collect();
    let cumulative = validate_entries(&entries, archive.is_solid, parent_uncompressed_bytes)?;
    let encrypted = entries.iter().any(|entry| entry.encrypted);
    if encrypted && password.is_none() {
        return Err(ArchiveError::new(
            "ARCHIVE_PASSWORD_REQUIRED",
            "归档需要密码",
        ));
    }
    Ok((
        InspectedArchive {
            format: NativeFormat::SevenZ,
            format_name: "7z".to_string(),
            solid: archive.is_solid,
            encrypted,
            entries,
        },
        cumulative,
    ))
}

#[cfg(test)]
fn inspect_sevenz(path: &Path, password: Option<&str>) -> Result<InspectedArchive, ArchiveError> {
    inspect_sevenz_source(
        &ArchiveSource::Local {
            path: path.to_path_buf(),
            identity: path.to_string_lossy().into_owned(),
        },
        None,
        password,
        0,
        Arc::new(AtomicBool::new(false)),
    )
    .map(|(inspected, _)| inspected)
}

#[cfg(test)]
fn inspect_path(path: &Path, password: Option<&str>) -> Result<InspectedArchive, ArchiveError> {
    match read_magic(path)? {
        DetectedArchiveFormat::Rar4 | DetectedArchiveFormat::Rar5 => {
            inspect_rar(path, password, 0).map(|(inspected, _)| inspected)
        }
        DetectedArchiveFormat::SevenZ => inspect_sevenz(path, password),
        DetectedArchiveFormat::Zip => inspect_zip_source(
            &ArchiveSource::Local {
                path: path.to_path_buf(),
                identity: path.to_string_lossy().into_owned(),
            },
            None,
            0,
            Arc::new(AtomicBool::new(false)),
        )
        .map(|(inspected, _)| inspected),
    }
}

fn inspect_source(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    password: Option<&str>,
    parent_uncompressed_bytes: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<(InspectedArchive, u64), ArchiveError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    let format = read_source_magic(source, app, "archive-magic", Arc::clone(&cancelled))?;
    match format {
        DetectedArchiveFormat::Rar4 | DetectedArchiveFormat::Rar5 => {
            if matches!(
                source,
                ArchiveSource::Remote {
                    cache_complete: false,
                    ..
                }
            ) {
                return Err(ArchiveError::new(
                    "ARCHIVE_REMOTE_CACHE_INCOMPLETE",
                    "远程 RAR 需要先完成磁盘缓存",
                ));
            }
            inspect_rar(source.cache_path(), password, parent_uncompressed_bytes)
        }
        DetectedArchiveFormat::SevenZ => {
            inspect_sevenz_source(source, app, password, parent_uncompressed_bytes, cancelled)
        }
        DetectedArchiveFormat::Zip => {
            inspect_zip_source(source, app, parent_uncompressed_bytes, cancelled)
        }
    }
}

#[derive(Clone)]
struct SharedBufferWriter {
    data: Arc<Mutex<Vec<u8>>>,
    overflowed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

impl Write for SharedBufferWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "archive entry read cancelled",
            ));
        }
        let mut data = self
            .data
            .lock()
            .map_err(|_| std::io::Error::other("archive buffer unavailable"))?;
        if data.len().saturating_add(bytes.len()) > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            self.overflowed.store(true, Ordering::Relaxed);
            return Err(std::io::Error::other("archive entry exceeds limit"));
        }
        data.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct DecodedCacheWriter {
    index: usize,
    data: Vec<u8>,
    cache: Arc<Mutex<DecodedEntryCache>>,
    progress: Arc<Mutex<ArchiveProgress>>,
    cancelled: Arc<AtomicBool>,
    overflowed: Arc<AtomicBool>,
}

impl Write for DecodedCacheWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "archive entry read cancelled",
            ));
        }
        if self.data.len().saturating_add(bytes.len()) > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            self.overflowed.store(true, Ordering::Relaxed);
            return Err(std::io::Error::other("archive entry exceeds limit"));
        }
        self.data.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for DecodedCacheWriter {
    fn drop(&mut self) {
        if self.cancelled.load(Ordering::Relaxed) || self.overflowed.load(Ordering::Relaxed) {
            return;
        }
        let data = std::mem::take(&mut self.data);
        let decoded_bytes = data.len() as u64;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(self.index, data);
        }
        if let Ok(mut progress) = self.progress.lock() {
            progress.current_entry = self.index;
            progress.decoded_bytes = progress.decoded_bytes.saturating_add(decoded_bytes);
        }
    }
}

fn read_bounded(input: &mut dyn Read, cancelled: &AtomicBool) -> Result<Vec<u8>, ArchiveError> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
        }
        let read = input
            .read(&mut buffer)
            .map_err(|_| ArchiveError::new("ARCHIVE_CORRUPT", "归档条目解码失败"))?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(output)
}

fn shared_writer(
    cancelled: Arc<AtomicBool>,
) -> (SharedBufferWriter, Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
    let data = Arc::new(Mutex::new(Vec::new()));
    let overflowed = Arc::new(AtomicBool::new(false));
    (
        SharedBufferWriter {
            data: Arc::clone(&data),
            overflowed: Arc::clone(&overflowed),
            cancelled,
        },
        data,
        overflowed,
    )
}

fn take_shared_data(
    data: Arc<Mutex<Vec<u8>>>,
    overflowed: &AtomicBool,
) -> Result<Vec<u8>, ArchiveError> {
    if overflowed.load(Ordering::Relaxed) {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "归档条目解压后超过大小上限",
        ));
    }
    Arc::try_unwrap(data)
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓冲区仍在使用"))?
        .into_inner()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓冲区不可用"))
}

#[cfg(test)]
fn read_rar_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
    solid: bool,
) -> Result<Vec<u8>, ArchiveError> {
    read_rar_entry_cancellable(
        path,
        index,
        password,
        solid,
        Arc::new(AtomicBool::new(false)),
    )
}

fn read_rar_entry_cancellable(
    path: &Path,
    index: usize,
    password: Option<&str>,
    solid: bool,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<u8>, ArchiveError> {
    let options = ArchiveReadOptions::with_optional_password(password.map(str::as_bytes))
        .with_rar50_buffered_decode_limit(MAX_ENTRY_UNCOMPRESSED_BYTES);
    let archive = RarArchiveReader::read_path_with_options(path, options).map_err(map_rar_error)?;
    let (mut writer, data, overflowed) = shared_writer(Arc::clone(&cancelled));
    if solid {
        let mut ordinal = 0_usize;
        let mut target_opened = false;
        let result = archive.extract_to_with_options(options, |meta| {
            if target_opened {
                return Err(RarError::Cancelled);
            }
            let current = ordinal;
            ordinal += 1;
            if current == index {
                target_opened = true;
                Ok(Box::new(writer.clone()))
            } else {
                let _ = meta;
                Ok(Box::new(std::io::sink()))
            }
        });
        if overflowed.load(Ordering::Relaxed) {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        match result {
            Ok(()) | Err(RarError::Cancelled) if target_opened => {}
            Ok(()) => {
                return Err(ArchiveError::new(
                    "ARCHIVE_ENTRY_NOT_FOUND",
                    "归档条目不存在",
                ))
            }
            Err(_) if cancelled.load(Ordering::Relaxed) => {
                return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"))
            }
            Err(error) => return Err(map_rar_error(error)),
        }
    } else {
        let result = match &archive {
            RarArchive::Rar13(value) => value
                .entries
                .get(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            RarArchive::Rar15To40(value) => value
                .files()
                .nth(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            RarArchive::Rar50Plus(value) => value
                .files()
                .nth(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            _ => {
                return Err(ArchiveError::new(
                    "ARCHIVE_CODEC_UNSUPPORTED",
                    "当前版本无法读取该 RAR 归档系列",
                ))
            }
        };
        if overflowed.load(Ordering::Relaxed) {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
        }
        result.map_err(map_rar_error)?;
    }
    drop(writer);
    take_shared_data(data, &overflowed)
}

fn read_rar_solid_until(
    path: &Path,
    target: usize,
    password: Option<&str>,
    cancelled: Arc<AtomicBool>,
    decoded: Arc<Mutex<DecodedEntryCache>>,
    progress: Arc<Mutex<ArchiveProgress>>,
) -> Result<Vec<u8>, ArchiveError> {
    let options = ArchiveReadOptions::with_optional_password(password.map(str::as_bytes))
        .with_rar50_buffered_decode_limit(MAX_ENTRY_UNCOMPRESSED_BYTES);
    let archive = RarArchiveReader::read_path_with_options(path, options).map_err(map_rar_error)?;
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut ordinal = 0_usize;
    let mut reached = false;
    let result = archive.extract_to_with_options(options, |_meta| {
        if cancelled.load(Ordering::Relaxed) {
            return Err(RarError::Cancelled);
        }
        if ordinal > target {
            return Err(RarError::Cancelled);
        }
        let index = ordinal;
        ordinal += 1;
        if index == target {
            reached = true;
        }
        Ok(Box::new(DecodedCacheWriter {
            index,
            data: Vec::new(),
            cache: Arc::clone(&decoded),
            progress: Arc::clone(&progress),
            cancelled: Arc::clone(&cancelled),
            overflowed: Arc::clone(&overflowed),
        }))
    });
    if overflowed.load(Ordering::Relaxed) {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "归档条目解压后超过大小上限",
        ));
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    match result {
        Ok(()) | Err(RarError::Cancelled) if reached => {}
        Ok(()) => {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_NOT_FOUND",
                "归档条目不存在",
            ))
        }
        Err(error) => return Err(map_rar_error(error)),
    }
    decoded
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
        .get(target)
        .map(|bytes| bytes.as_ref().clone())
        .ok_or_else(|| ArchiveError::new("ARCHIVE_CORRUPT", "固实 RAR 未产生目标条目"))
}

#[cfg(test)]
fn read_sevenz_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
) -> Result<Vec<u8>, ArchiveError> {
    read_sevenz_entry_source(
        &ArchiveSource::Local {
            path: path.to_path_buf(),
            identity: path.to_string_lossy().into_owned(),
        },
        None,
        "archive-local-read",
        Arc::new(AtomicBool::new(false)),
        index,
        password,
    )
}

fn read_sevenz_entry_source(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    request_id: &str,
    cancelled: Arc<AtomicBool>,
    index: usize,
    password: Option<&str>,
) -> Result<Vec<u8>, ArchiveError> {
    let mut reader = open_sevenz_reader(source, app, request_id, Arc::clone(&cancelled), password)?;
    let target = reader
        .archive()
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?;
    if !target.has_stream {
        return Ok(Vec::new());
    }
    let duplicate_count = reader
        .archive()
        .files
        .iter()
        .filter(|entry| entry.name == target.name)
        .count();
    if !reader.archive().is_solid && duplicate_count == 1 {
        let bytes = reader.read_file(&target.name).map_err(map_sevenz_error)?;
        if bytes.len() > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        return Ok(bytes);
    }
    let occurrence = reader.archive().files[..index]
        .iter()
        .filter(|entry| entry.name == target.name)
        .count();
    let (mut writer, data, overflowed) = shared_writer(Arc::clone(&cancelled));
    let mut matching = 0_usize;
    let mut found = false;
    let result = reader.for_each_entries(|entry, input| {
        if entry.name == target.name {
            if matching == occurrence {
                std::io::copy(input, &mut writer)?;
                found = true;
                return Ok(false);
            }
            matching += 1;
        }
        std::io::copy(input, &mut std::io::sink())?;
        Ok(true)
    });
    if overflowed.load(Ordering::Relaxed) {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "归档条目解压后超过大小上限",
        ));
    }
    result.map_err(map_sevenz_error)?;
    if !found {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_NOT_FOUND",
            "归档条目不存在",
        ));
    }
    drop(writer);
    take_shared_data(data, &overflowed)
}

fn read_sevenz_solid_until(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    request_id: &str,
    target: usize,
    password: Option<&str>,
    state: SolidDecodeState,
) -> Result<Vec<u8>, ArchiveError> {
    let SolidDecodeState {
        cancelled,
        decoded,
        progress,
    } = state;
    let mut reader = open_sevenz_reader(source, app, request_id, Arc::clone(&cancelled), password)?;
    if target >= reader.archive().files.len() {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_NOT_FOUND",
            "归档条目不存在",
        ));
    }
    let mut occurrences = HashMap::<String, usize>::new();
    let indexes: HashMap<(String, usize), usize> = {
        let mut counts = HashMap::<String, usize>::new();
        reader
            .archive()
            .files
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let occurrence = counts.entry(entry.name.clone()).or_insert(0);
                let key = (entry.name.clone(), *occurrence);
                *occurrence += 1;
                (key, index)
            })
            .collect()
    };
    let mut reached = false;
    reader
        .for_each_entries(|entry, input| {
            if cancelled.load(Ordering::Relaxed) {
                return Err(SevenZError::Io(
                    std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "archive entry read cancelled",
                    ),
                    entry.name.clone().into(),
                ));
            }
            let occurrence = occurrences.entry(entry.name.clone()).or_insert(0);
            let index = indexes
                .get(&(entry.name.clone(), *occurrence))
                .copied()
                .ok_or_else(|| SevenZError::Other("7z entry index is inconsistent".into()))?;
            *occurrence += 1;
            let bytes = read_bounded(input, &cancelled).map_err(|error| {
                SevenZError::Io(
                    std::io::Error::other(error.message),
                    entry.name.clone().into(),
                )
            })?;
            let decoded_bytes = bytes.len() as u64;
            decoded
                .lock()
                .map_err(|_| SevenZError::Other("archive cache unavailable".into()))?
                .insert(index, bytes);
            if let Ok(mut value) = progress.lock() {
                value.current_entry = index;
                value.decoded_bytes = value.decoded_bytes.saturating_add(decoded_bytes);
            }
            if index == target {
                reached = true;
                Ok(false)
            } else {
                Ok(true)
            }
        })
        .map_err(map_sevenz_error)?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    if !reached {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_NOT_FOUND",
            "归档条目不存在",
        ));
    }
    let target_bytes = decoded
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
        .get(target)
        .map(|bytes| bytes.as_ref().clone())
        .ok_or_else(|| ArchiveError::new("ARCHIVE_CORRUPT", "固实 7z 未产生目标条目"));
    target_bytes
}

fn read_zip_entry_source(
    source: &ArchiveSource,
    app: Option<&AppHandle>,
    request_id: &str,
    cancelled: Arc<AtomicBool>,
    index: usize,
    pool: &ZipHandlePool,
) -> Result<Vec<u8>, ArchiveError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    let mut archive = pool.take(source, app, request_id, Arc::clone(&cancelled))?;
    let mut entry = archive.by_index(index).map_err(map_zip_error)?;
    if entry.is_dir() {
        drop(entry);
        pool.restore(archive);
        return Ok(Vec::new());
    }
    let (mut writer, data, overflowed) = shared_writer(cancelled);
    let copied = std::io::copy(&mut entry, &mut writer).map_err(|error| {
        if error.kind() == std::io::ErrorKind::Interrupted {
            ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消")
        } else {
            ArchiveError::new("ARCHIVE_IO", "读取 ZIP 条目失败")
        }
    });
    drop(entry);
    drop(writer);
    if copied.is_ok() {
        pool.restore(archive);
    }
    copied?;
    take_shared_data(data, &overflowed)
}

fn parse_entry_index(entry_id: &str) -> Result<usize, ArchiveError> {
    entry_id
        .strip_prefix("entry-")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目 ID 无效"))
}

#[tauri::command]
pub async fn archive_open(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    remote_state: State<'_, RemoteState>,
    path: Option<String>,
    resource_id: Option<String>,
    password: Option<String>,
) -> Result<ArchiveOpenResult, ArchiveError> {
    let password = password.map(Zeroizing::new);
    let source = match (path, resource_id) {
        (Some(path), None) => {
            let path = PathBuf::from(path);
            if !path.is_file() {
                return Err(ArchiveError::new("ARCHIVE_IO", "归档文件不存在或不可读"));
            }
            ArchiveSource::Local {
                identity: path.to_string_lossy().into_owned(),
                path,
            }
        }
        (None, Some(resource_id)) => {
            let info = remote::file_info(&app, &remote_state, &resource_id)
                .map_err(|error| ArchiveError::new(error.code, error.message))?;
            ArchiveSource::Remote {
                resource_id,
                cache_path: info.cache_path,
                identity: info.identity,
                size: info.size,
                cache_complete: info.cache_complete,
            }
        }
        _ => {
            return Err(ArchiveError::new(
                "ARCHIVE_SOURCE_INVALID",
                "必须且只能提供一个本地路径或远程资源句柄",
            ))
        }
    };
    open_archive_source(&app, state.inner(), source, password, 0, 0).await
}

async fn open_archive_source(
    app: &AppHandle,
    state: &ArchiveState,
    source: ArchiveSource,
    password: Option<Zeroizing<String>>,
    depth: u8,
    parent_uncompressed_bytes: u64,
) -> Result<ArchiveOpenResult, ArchiveError> {
    if depth > MAX_NESTED_DEPTH {
        return Err(ArchiveError::new(
            "ARCHIVE_NESTING_LIMIT",
            format!("归档嵌套深度超过上限 {MAX_NESTED_DEPTH}"),
        ));
    }
    let parse_source = source.clone();
    let parse_app = app.clone();
    let inspect_password = password
        .as_deref()
        .map(|value| Zeroizing::new(value.to_owned()));
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_key = source_cancel_key(&source);
    {
        let mut pending = state
            .pending_cancels
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        pending.insert(cancel_key.clone(), Arc::clone(&cancelled));
    }
    let inspect_cancelled = Arc::clone(&cancelled);
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        inspect_source(
            &parse_source,
            Some(&parse_app),
            inspect_password.as_deref().map(String::as_str),
            parent_uncompressed_bytes,
            inspect_cancelled,
        )
    })
    .await
    .map_err(|_| ArchiveError::new("ARCHIVE_TASK_FAILED", "归档解析任务异常终止"));
    if let Ok(mut pending) = state.pending_cancels.lock() {
        pending.remove(&cancel_key);
    }
    let (inspected, cumulative_uncompressed_bytes) = inspected??;
    if cancelled.load(Ordering::Relaxed) {
        return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
    }
    let archive_id = format!("archive-{}", state.sequence.fetch_add(1, Ordering::Relaxed));
    let result = ArchiveOpenResult {
        archive_id: archive_id.clone(),
        format: inspected.format_name,
        access_mode: if inspected.solid {
            "sequential".to_string()
        } else {
            "random".to_string()
        },
        solid: inspected.solid,
        encrypted: inspected.encrypted,
        multivolume: false,
        entries: inspected.entries.clone(),
        depth,
        cumulative_uncompressed_bytes,
    };
    state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .insert(
            archive_id,
            Arc::new(Mutex::new(ArchiveSession {
                source,
                format: inspected.format,
                solid: inspected.solid,
                entries: inspected.entries,
                password,
                depth,
                cumulative_uncompressed_bytes,
                decode_lock: Arc::new(Mutex::new(())),
                decoded: Arc::new(Mutex::new(DecodedEntryCache::default())),
                zip_handles: Arc::new(ZipHandlePool {
                    handles: Mutex::new(Vec::new()),
                }),
                active_cancels: Vec::new(),
                progress: Arc::new(Mutex::new(ArchiveProgress::default())),
            })),
        );
    Ok(result)
}

fn next_id(state: &ArchiveState, prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        state.sequence.fetch_add(1, Ordering::Relaxed)
    )
}

fn nested_cache_path(
    app: &AppHandle,
    parent_identity: &str,
    entry_id: &str,
    bytes: &[u8],
) -> Result<(PathBuf, String), ArchiveError> {
    if bytes.len() > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "内层归档超过单条目大小上限",
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(parent_identity.as_bytes());
    hasher.update([0]);
    hasher.update(entry_id.as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let directory = library::cache_dir(app)
        .map_err(|message| ArchiveError::new("ARCHIVE_IO", message))?
        .join("nested-archives");
    fs::create_dir_all(&directory)
        .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法创建内层归档缓存目录"))?;
    let path = directory.join(format!("{digest}.archive"));
    if !path.is_file() {
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法创建内层归档缓存文件"))?;
        temporary
            .write_all(bytes)
            .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法写入内层归档缓存文件"))?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if path.is_file() => drop(error.file),
            Err(_) => return Err(ArchiveError::new("ARCHIVE_IO", "无法保存内层归档缓存文件")),
        }
    }
    Ok((path, format!("nested:{digest}")))
}

fn retain_temporary_path(state: &ArchiveState, path: &Path) -> Result<(), ArchiveError> {
    let mut paths = state
        .temporary_paths
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?;
    *paths.entry(path.to_path_buf()).or_insert(0) += 1;
    Ok(())
}

fn release_temporary_path(state: &ArchiveState, path: &Path) -> Result<(), ArchiveError> {
    let should_remove = {
        let mut paths = state
            .temporary_paths
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?;
        match paths.get_mut(path) {
            Some(count) if *count > 1 => {
                *count -= 1;
                false
            }
            Some(_) => {
                paths.remove(path);
                true
            }
            None => false,
        }
    };
    if should_remove {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

async fn decode_session_entry(
    app: &AppHandle,
    archive_id: &str,
    session: Arc<Mutex<ArchiveSession>>,
    index: usize,
    supplied_password: Option<Zeroizing<String>>,
) -> Result<Vec<u8>, ArchiveError> {
    let (
        source,
        format,
        solid,
        session_password,
        decode_lock,
        decoded,
        zip_handles,
        cancelled,
        progress,
    ) = {
        let mut session = session
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        if index >= session.entries.len() {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_NOT_FOUND",
                "归档条目不存在",
            ));
        }
        if let Some(bytes) = session
            .decoded
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
            .get(index)
        {
            return Ok(bytes.as_ref().clone());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        session.active_cancels.push(Arc::clone(&cancelled));
        (
            session.source.clone(),
            session.format,
            session.solid,
            session.password.clone(),
            Arc::clone(&session.decode_lock),
            Arc::clone(&session.decoded),
            Arc::clone(&session.zip_handles),
            cancelled,
            Arc::clone(&session.progress),
        )
    };
    let decode_password = supplied_password
        .as_deref()
        .or(session_password.as_deref())
        .map(|value| Zeroizing::new(value.to_owned()));
    let decode_app = app.clone();
    let request_id = format!("{archive_id}-entry-{index}");
    let decode_cancel = Arc::clone(&cancelled);
    let decode_progress = Arc::clone(&progress);
    let result = tauri::async_runtime::spawn_blocking(move || {
        // ZIP pages are independent seeks. Do not serialize them behind the
        // solid-archive lock the way RAR/7z must be.
        let _guard = match format {
            NativeFormat::Zip => None,
            NativeFormat::Rar | NativeFormat::SevenZ => Some(decode_lock.lock().map_err(|_| {
                ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档解码队列不可用")
            })?),
        };
        if let Some(bytes) = decoded
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
            .get(index)
        {
            return Ok(bytes.as_ref().clone());
        }
        if decode_cancel.load(Ordering::Relaxed) {
            return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
        }
        if let Ok(mut value) = decode_progress.lock() {
            value.phase = if solid { "sequential" } else { "decoding" }.to_string();
            value.current_entry = 0;
            value.target_entry = index;
            value.decoded_bytes = 0;
        }
        let bytes = match format {
            NativeFormat::Rar if solid => read_rar_solid_until(
                source.cache_path(),
                index,
                decode_password.as_deref().map(String::as_str),
                Arc::clone(&decode_cancel),
                Arc::clone(&decoded),
                Arc::clone(&decode_progress),
            ),
            NativeFormat::Rar => read_rar_entry_cancellable(
                source.cache_path(),
                index,
                decode_password.as_deref().map(String::as_str),
                false,
                Arc::clone(&decode_cancel),
            ),
            NativeFormat::SevenZ if solid => read_sevenz_solid_until(
                &source,
                Some(&decode_app),
                &request_id,
                index,
                decode_password.as_deref().map(String::as_str),
                SolidDecodeState {
                    cancelled: Arc::clone(&decode_cancel),
                    decoded: Arc::clone(&decoded),
                    progress: Arc::clone(&decode_progress),
                },
            ),
            NativeFormat::SevenZ => read_sevenz_entry_source(
                &source,
                Some(&decode_app),
                &request_id,
                Arc::clone(&decode_cancel),
                index,
                decode_password.as_deref().map(String::as_str),
            ),
            NativeFormat::Zip => read_zip_entry_source(
                &source,
                Some(&decode_app),
                &request_id,
                Arc::clone(&decode_cancel),
                index,
                zip_handles.as_ref(),
            ),
        }?;
        if decode_cancel.load(Ordering::Relaxed) {
            return Err(ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"));
        }
        let cached = decoded
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓存状态不可用"))?
            .insert(index, bytes);
        if let Ok(mut value) = decode_progress.lock() {
            value.phase = "ready".to_string();
            value.current_entry = index;
            value.target_entry = index;
            value.decoded_bytes = cached.len() as u64;
        }
        Ok(cached.as_ref().clone())
    })
    .await
    .map_err(|_| ArchiveError::new("ARCHIVE_TASK_FAILED", "归档解码任务异常终止"))?;
    {
        let mut current = session
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        current
            .active_cancels
            .retain(|value| !Arc::ptr_eq(value, &cancelled));
        if result.is_ok() {
            if let Some(password) = supplied_password {
                current.password = Some(password);
            }
        } else if let Ok(mut value) = current.progress.lock() {
            value.phase = if cancelled.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "error"
            }
            .to_string();
        }
    }
    result
}

#[tauri::command]
pub async fn archive_read_entry(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    archive_id: String,
    entry_id: String,
    password: Option<String>,
) -> Result<tauri::ipc::Response, ArchiveError> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .get(&archive_id)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_SESSION_NOT_FOUND", "归档会话不存在"))?;
    let bytes = decode_session_entry(
        &app,
        &archive_id,
        session,
        parse_entry_index(&entry_id)?,
        password.map(Zeroizing::new),
    )
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn archive_open_nested(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    parent_archive_id: String,
    entry_id: String,
    password: Option<String>,
) -> Result<ArchiveOpenResult, ArchiveError> {
    let parent = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .get(&parent_archive_id)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_SESSION_NOT_FOUND", "父归档会话不存在"))?;
    let index = parse_entry_index(&entry_id)?;
    let (depth, cumulative, identity) = {
        let session = parent
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        (
            session.depth.saturating_add(1),
            session.cumulative_uncompressed_bytes,
            session.source.identity().to_string(),
        )
    };
    if depth > MAX_NESTED_DEPTH {
        return Err(ArchiveError::new(
            "ARCHIVE_NESTING_LIMIT",
            format!("归档嵌套深度超过上限 {MAX_NESTED_DEPTH}"),
        ));
    }
    let bytes = decode_session_entry(&app, &parent_archive_id, parent, index, None).await?;
    let (path, nested_identity) = nested_cache_path(&app, &identity, &entry_id, &bytes)?;
    retain_temporary_path(state.inner(), &path)?;
    let opened = open_archive_source(
        &app,
        state.inner(),
        ArchiveSource::Local {
            path: path.clone(),
            identity: nested_identity,
        },
        password.map(Zeroizing::new),
        depth,
        cumulative,
    )
    .await;
    if opened.is_err() {
        release_temporary_path(state.inner(), &path)?;
    }
    opened
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStageResult {
    stage_id: String,
}

fn request_header<'a>(
    request: &'a tauri::ipc::Request<'_>,
    name: &str,
) -> Result<&'a str, ArchiveError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ArchiveError::new("ARCHIVE_SOURCE_INVALID", "内层归档请求缺少元数据"))
}

#[tauri::command]
pub fn archive_stage_nested(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    request: tauri::ipc::Request<'_>,
) -> Result<ArchiveStageResult, ArchiveError> {
    let parent_identity = request_header(&request, "x-lightink-parent-identity")?;
    let entry_id = request_header(&request, "x-lightink-entry-id")?;
    let depth: u8 = request_header(&request, "x-lightink-depth")?
        .parse()
        .map_err(|_| ArchiveError::new("ARCHIVE_SOURCE_INVALID", "内层归档深度无效"))?;
    let parent_uncompressed_bytes: u64 =
        request_header(&request, "x-lightink-parent-uncompressed-bytes")?
            .parse()
            .map_err(|_| ArchiveError::new("ARCHIVE_SOURCE_INVALID", "内层归档预算无效"))?;
    if depth == 0 || depth > MAX_NESTED_DEPTH {
        return Err(ArchiveError::new(
            "ARCHIVE_NESTING_LIMIT",
            format!("归档嵌套深度超过上限 {MAX_NESTED_DEPTH}"),
        ));
    }
    if parent_uncompressed_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES {
        return Err(ArchiveError::new(
            "ARCHIVE_TOTAL_SIZE_LIMIT",
            "父归档已超过跨层累计解压预算",
        ));
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => {
            return Err(ArchiveError::new(
                "ARCHIVE_SOURCE_INVALID",
                "内层归档必须使用原始字节传输",
            ))
        }
    };
    let (path, identity) = nested_cache_path(&app, parent_identity, entry_id, bytes)?;
    retain_temporary_path(state.inner(), &path)?;
    let stage_id = next_id(state.inner(), "archive-stage");
    state
        .staged
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档暂存状态不可用"))?
        .insert(
            stage_id.clone(),
            StagedArchive {
                source: ArchiveSource::Local { path, identity },
                depth,
                parent_uncompressed_bytes,
            },
        );
    Ok(ArchiveStageResult { stage_id })
}

#[tauri::command]
pub async fn archive_open_staged(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    stage_id: String,
    password: Option<String>,
) -> Result<ArchiveOpenResult, ArchiveError> {
    let staged = state
        .staged
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档暂存状态不可用"))?
        .get(&stage_id)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_STAGE_NOT_FOUND", "内层归档暂存对象不存在"))?;
    let opened = open_archive_source(
        &app,
        state.inner(),
        staged.source.clone(),
        password.map(Zeroizing::new),
        staged.depth,
        staged.parent_uncompressed_bytes,
    )
    .await;
    if opened.is_ok() {
        state
            .staged
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档暂存状态不可用"))?
            .remove(&stage_id);
    }
    opened
}

#[tauri::command]
pub fn archive_discard_staged(
    state: State<'_, ArchiveState>,
    stage_id: String,
) -> Result<(), ArchiveError> {
    let staged = state
        .staged
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档暂存状态不可用"))?
        .remove(&stage_id);
    if let Some(path) =
        staged.and_then(|value| value.source.temporary_path().map(Path::to_path_buf))
    {
        release_temporary_path(state.inner(), &path)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_cancel(
    state: State<'_, ArchiveState>,
    remote_state: State<'_, RemoteState>,
    archive_id: String,
) -> Result<(), ArchiveError> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .get(&archive_id)
        .cloned();
    let Some(session) = session else {
        return Ok(());
    };
    let resource_id = {
        let session = session
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        for cancelled in &session.active_cancels {
            cancelled.store(true, Ordering::Relaxed);
        }
        match &session.source {
            ArchiveSource::Remote { resource_id, .. } => Some(resource_id.clone()),
            ArchiveSource::Local { .. } => None,
        }
    };
    if let Some(resource_id) = resource_id {
        remote::cancel_requests(remote_state.inner(), Some(&resource_id), None)
            .map_err(|error| ArchiveError::new(error.code, error.message))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_cancel_open(
    state: State<'_, ArchiveState>,
    remote_state: State<'_, RemoteState>,
    path: Option<String>,
    resource_id: Option<String>,
) -> Result<(), ArchiveError> {
    if let Some(key) = args_cancel_key(path.as_deref(), resource_id.as_deref()) {
        if let Ok(pending) = state.pending_cancels.lock() {
            if let Some(cancelled) = pending.get(&key) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
    if let Some(resource_id) = resource_id {
        remote::cancel_requests(remote_state.inner(), Some(&resource_id), None)
            .map_err(|error| ArchiveError::new(error.code, error.message))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_progress(
    state: State<'_, ArchiveState>,
    archive_id: String,
) -> Result<ArchiveProgress, ArchiveError> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .get(&archive_id)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_SESSION_NOT_FOUND", "归档会话不存在"))?;
    let progress = session
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .progress
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档进度状态不可用"))?
        .clone();
    Ok(progress)
}

#[tauri::command]
pub async fn archive_close(
    state: State<'_, ArchiveState>,
    archive_id: String,
) -> Result<(), ArchiveError> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .remove(&archive_id);
    if let Some(session) = session {
        let temporary = {
            let session = session.lock().map_err(|_| {
                ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用")
            })?;
            for cancelled in &session.active_cancels {
                cancelled.store(true, Ordering::Relaxed);
            }
            session.source.temporary_path().map(Path::to_path_buf)
        };
        if let Some(path) = temporary {
            release_temporary_path(state.inner(), &path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rars::{rar15_40, rar50, ArchiveVersion, FeatureSet};
    use sevenz_rust2::{
        ArchiveEntry as SevenZEntry, ArchiveWriter as SevenZWriter,
        SourceReader as SevenZSourceReader,
    };
    use std::io::Cursor;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn write_fixture(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).expect("write archive fixture");
    }

    fn rar4_bytes(solid: bool, password: Option<&[u8]>) -> Vec<u8> {
        let mut features = FeatureSet::store_only();
        features.solid = solid;
        features.file_encryption = password.is_some();
        rar15_40::write_compressed_archive(
            &[
                rar15_40::FileEntry {
                    name: b"page1.png",
                    data: b"first-image",
                    file_time: 0,
                    file_attr: 0x20,
                    host_os: 3,
                    password,
                    file_comment: None,
                },
                rar15_40::FileEntry {
                    name: b"page2.png",
                    data: b"second-image",
                    file_time: 0,
                    file_attr: 0x20,
                    host_os: 3,
                    password,
                    file_comment: None,
                },
            ],
            rar15_40::WriterOptions::new(ArchiveVersion::Rar29, features),
        )
        .expect("create RAR4 fixture")
    }

    fn rar5_bytes() -> Vec<u8> {
        rar50::Rar50Writer::new(rar50::WriterOptions::new(
            ArchiveVersion::Rar50,
            FeatureSet::store_only(),
        ))
        .stored_entries(&[
            rar50::StoredEntry {
                name: b"page1.png",
                data: b"rar5-first",
                mtime: None,
                attributes: 0x20,
                host_os: 3,
            },
            rar50::StoredEntry {
                name: b"page2.png",
                data: b"rar5-second",
                mtime: None,
                attributes: 0x20,
                host_os: 3,
            },
        ])
        .finish()
        .expect("create RAR5 fixture")
    }

    fn write_sevenz(path: &Path, solid: bool) {
        let mut writer = SevenZWriter::create(path).expect("create 7z fixture");
        if solid {
            writer
                .push_archive_entries(
                    vec![
                        SevenZEntry::new_file("page1.png"),
                        SevenZEntry::new_file("page2.png"),
                    ],
                    vec![
                        SevenZSourceReader::new(Cursor::new(b"7z-first".as_slice())),
                        SevenZSourceReader::new(Cursor::new(b"7z-second".as_slice())),
                    ],
                )
                .expect("write solid 7z entries");
        } else {
            writer
                .push_archive_entry(
                    SevenZEntry::new_file("page1.png"),
                    Some(Cursor::new(b"7z-first")),
                )
                .expect("write first 7z entry");
            writer
                .push_archive_entry(
                    SevenZEntry::new_file("page2.png"),
                    Some(Cursor::new(b"7z-second")),
                )
                .expect("write second 7z entry");
        }
        writer.finish().expect("finish 7z fixture");
    }

    fn write_zip(path: &Path) {
        let file = File::create(path).expect("create zip fixture");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file("page1.png", options).unwrap();
        writer.write_all(b"zip-first").unwrap();
        writer.start_file("folder/page2.png", options).unwrap();
        writer.write_all(b"zip-second").unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn detects_rar4_rar5_sevenz_and_zip_by_magic() {
        assert_eq!(
            detect_archive_format(RAR4_SIGNATURE),
            Some(DetectedArchiveFormat::Rar4)
        );
        assert_eq!(
            detect_archive_format(RAR5_SIGNATURE),
            Some(DetectedArchiveFormat::Rar5)
        );
        assert_eq!(
            detect_archive_format(SEVEN_Z_SIGNATURE),
            Some(DetectedArchiveFormat::SevenZ)
        );
        assert_eq!(
            detect_archive_format(b"PK\x03\x04fixture"),
            Some(DetectedArchiveFormat::Zip)
        );
        assert_eq!(detect_archive_format(b"not archive"), None);
    }

    #[test]
    fn rejects_unsafe_entry_budgets() {
        let oversized = NativeArchiveEntry {
            id: "entry-0".to_string(),
            filename: "page.png".to_string(),
            directory: false,
            compressed_size: 1,
            uncompressed_size: MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
            encrypted: false,
            solid: false,
            split: false,
        };
        assert_eq!(
            validate_entries(&[oversized], false, 0).unwrap_err().code,
            "ARCHIVE_ENTRY_TOO_LARGE"
        );

        let nested = NativeArchiveEntry {
            id: "entry-0".to_string(),
            filename: "page.png".to_string(),
            directory: false,
            compressed_size: 1024,
            uncompressed_size: 1024,
            encrypted: false,
            solid: false,
            split: false,
        };
        assert_eq!(
            validate_entries(&[nested], false, MAX_TOTAL_UNCOMPRESSED_BYTES,)
                .unwrap_err()
                .code,
            "ARCHIVE_TOTAL_SIZE_LIMIT"
        );
    }

    #[test]
    fn rejects_split_sevenz_names_without_relying_on_extension_routing() {
        assert!(looks_like_split_sevenz(Path::new("comic.7z.001")));
        assert!(!looks_like_split_sevenz(Path::new("comic.cb7")));
    }

    #[test]
    fn inspects_and_reads_rar4_rar5_and_solid_rar() {
        let directory = tempfile::tempdir().expect("tempdir");
        let rar4 = directory.path().join("comic.cbr");
        let solid = directory.path().join("solid.rar");
        let rar5 = directory.path().join("comic-rar5.cbr");
        write_fixture(&rar4, &rar4_bytes(false, None));
        write_fixture(&solid, &rar4_bytes(true, None));
        write_fixture(&rar5, &rar5_bytes());

        let inspected_rar4 = inspect_path(&rar4, None).expect("inspect RAR4");
        assert_eq!(inspected_rar4.format_name, "rar4");
        assert!(!inspected_rar4.solid);
        assert_eq!(
            read_rar_entry(&rar4, 1, None, false).unwrap(),
            b"second-image"
        );

        let inspected_rar5 = inspect_path(&rar5, None).expect("inspect RAR5");
        assert_eq!(inspected_rar5.format_name, "rar5");
        assert_eq!(
            read_rar_entry(&rar5, 0, None, false).unwrap(),
            b"rar5-first"
        );

        let inspected_solid = inspect_path(&solid, None).expect("inspect solid RAR");
        assert!(inspected_solid.solid);
        assert_eq!(
            read_rar_entry(&solid, 1, None, true).unwrap(),
            b"second-image"
        );
    }

    #[test]
    fn reports_rar_password_errors_without_persisting_credentials() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("secret.cbr");
        write_fixture(&path, &rar4_bytes(false, Some(b"secret")));

        assert_eq!(
            inspect_path(&path, None).unwrap_err().code,
            "ARCHIVE_PASSWORD_REQUIRED"
        );
        assert_eq!(
            read_rar_entry(&path, 0, Some("wrong"), false)
                .unwrap_err()
                .code,
            "ARCHIVE_PASSWORD_INCORRECT"
        );
        assert_eq!(
            read_rar_entry(&path, 0, Some("secret"), false).unwrap(),
            b"first-image"
        );
    }

    #[test]
    fn inspects_and_reads_regular_and_solid_sevenz() {
        let directory = tempfile::tempdir().expect("tempdir");
        let regular = directory.path().join("comic.cb7");
        let solid = directory.path().join("solid.7z");
        write_sevenz(&regular, false);
        write_sevenz(&solid, true);

        let inspected_regular = inspect_path(&regular, None).expect("inspect regular 7z");
        assert!(!inspected_regular.solid);
        assert_eq!(read_sevenz_entry(&regular, 1, None).unwrap(), b"7z-second");

        let inspected_solid = inspect_path(&solid, None).expect("inspect solid 7z");
        assert!(inspected_solid.solid);
        assert_eq!(read_sevenz_entry(&solid, 1, None).unwrap(), b"7z-second");
    }

    #[test]
    fn inspects_and_reads_zip_by_magic_for_nested_archives() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("nested.archive");
        write_zip(&path);

        let inspected = inspect_path(&path, None).expect("inspect ZIP");
        assert_eq!(inspected.format_name, "zip");
        assert_eq!(inspected.entries.len(), 2);
        let source = ArchiveSource::Local {
            path: path.clone(),
            identity: "nested:test".to_string(),
        };
        let pool = ZipHandlePool {
            handles: Mutex::new(Vec::new()),
        };
        assert_eq!(
            read_zip_entry_source(
                &source,
                None,
                "zip-test",
                Arc::new(AtomicBool::new(false)),
                1,
                &pool,
            )
            .unwrap(),
            b"zip-second"
        );
        let cancelled = Arc::new(AtomicBool::new(true));
        assert_eq!(
            inspect_zip_source(&source, None, 0, Arc::clone(&cancelled))
                .expect_err("cancelled inspect")
                .code,
            "ARCHIVE_CANCELLED"
        );
        assert_eq!(
            read_zip_entry_source(&source, None, "zip-test", cancelled, 1, &pool)
                .expect_err("cancelled read")
                .code,
            "ARCHIVE_CANCELLED"
        );
        assert_eq!(
            read_zip_entry_source(
                &source,
                None,
                "zip-test-reuse",
                Arc::new(AtomicBool::new(false)),
                0,
                &pool,
            )
            .unwrap(),
            b"zip-first"
        );
    }

    #[test]
    fn solid_decoders_cache_preceding_entries_and_honor_cancellation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let rar = directory.path().join("solid.rar");
        let sevenz = directory.path().join("solid.7z");
        write_fixture(&rar, &rar4_bytes(true, None));
        write_sevenz(&sevenz, true);

        let rar_cache = Arc::new(Mutex::new(DecodedEntryCache::default()));
        let progress = Arc::new(Mutex::new(ArchiveProgress::default()));
        assert_eq!(
            read_rar_solid_until(
                &rar,
                1,
                None,
                Arc::new(AtomicBool::new(false)),
                Arc::clone(&rar_cache),
                Arc::clone(&progress),
            )
            .unwrap(),
            b"second-image"
        );
        assert_eq!(
            rar_cache.lock().unwrap().get(0).unwrap().as_ref(),
            b"first-image"
        );
        assert_eq!(progress.lock().unwrap().current_entry, 1);

        let sevenz_cache = Arc::new(Mutex::new(DecodedEntryCache::default()));
        let source = ArchiveSource::Local {
            path: sevenz,
            identity: "nested:solid".to_string(),
        };
        assert_eq!(
            read_sevenz_solid_until(
                &source,
                None,
                "solid-test",
                1,
                None,
                SolidDecodeState {
                    cancelled: Arc::new(AtomicBool::new(false)),
                    decoded: Arc::clone(&sevenz_cache),
                    progress: Arc::new(Mutex::new(ArchiveProgress::default())),
                },
            )
            .unwrap(),
            b"7z-second"
        );
        assert_eq!(
            sevenz_cache.lock().unwrap().get(0).unwrap().as_ref(),
            b"7z-first"
        );

        let cancelled = Arc::new(AtomicBool::new(true));
        assert_eq!(
            read_rar_solid_until(
                &rar,
                1,
                None,
                cancelled,
                Arc::new(Mutex::new(DecodedEntryCache::default())),
                Arc::new(Mutex::new(ArchiveProgress::default())),
            )
            .unwrap_err()
            .code,
            "ARCHIVE_CANCELLED"
        );
    }

    #[test]
    fn rejects_multivolume_and_corrupt_archives_with_structured_errors() {
        let directory = tempfile::tempdir().expect("tempdir");
        let payload = b"split archive payload".repeat(20);
        let parts = rar50::Rar50VolumeWriter::new(rar50::WriterOptions::new(
            ArchiveVersion::Rar50,
            FeatureSet::store_only(),
        ))
        .stored_entry(rar50::StoredEntry {
            name: b"page.png",
            data: &payload,
            mtime: None,
            attributes: 0x20,
            host_os: 3,
        })
        .max_payload_per_volume(80)
        .finish()
        .expect("create split RAR fixture");
        let split = directory.path().join("split.rar");
        write_fixture(&split, &parts[0]);
        assert_eq!(
            inspect_path(&split, None).unwrap_err().code,
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED"
        );

        let corrupt = directory.path().join("broken.7z");
        write_fixture(&corrupt, SEVEN_Z_SIGNATURE);
        assert_eq!(
            inspect_path(&corrupt, None).unwrap_err().code,
            "ARCHIVE_CORRUPT"
        );
    }

    #[test]
    fn supports_concurrent_independent_entry_reads() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("parallel.cbr");
        write_fixture(&path, &rar5_bytes());
        let first_path = path.clone();
        let second_path = path.clone();
        let first = std::thread::spawn(move || read_rar_entry(&first_path, 0, None, false));
        let second = std::thread::spawn(move || read_rar_entry(&second_path, 1, None, false));

        assert_eq!(first.join().unwrap().unwrap(), b"rar5-first");
        assert_eq!(second.join().unwrap().unwrap(), b"rar5-second");
    }
}
