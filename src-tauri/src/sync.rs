//! Device-local sync records, causal merge and conflict persistence.
//!
//! WebDAV transports immutable blobs and device snapshots. This module owns the
//! small, structured records contained in those snapshots: one value per
//! object/field/device, with a dotted causal context so offline edits can merge
//! without relying on wall-clock order alone.

use crate::documents;
use crate::file::write_file_impl;
use crate::library;
use crate::managed;
use crate::webdav::{self, WebDavError, WebDavState, MAX_SYNC_RESPONSE_BYTES};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::State;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncRunState {
    Idle,
    Running,
    Success,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncRunState,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
    pub uploaded: u64,
    pub downloaded: u64,
    pub conflicts: u64,
}

#[derive(Default)]
pub struct SyncTaskState {
    task: std::sync::Mutex<Option<(String, CancellationToken)>>,
    status: std::sync::Mutex<SyncStatus>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            state: SyncRunState::Idle,
            started_at: None,
            finished_at: None,
            last_error: None,
            uploaded: 0,
            downloaded: 0,
            conflicts: 0,
        }
    }
}

fn status_snapshot(state: &SyncTaskState) -> Result<SyncStatus, String> {
    state
        .status
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "同步状态不可用".to_string())
}

fn start_task(state: &SyncTaskState) -> Result<(String, CancellationToken), String> {
    let mut task = state
        .task
        .lock()
        .map_err(|_| "同步任务状态不可用".to_string())?;
    if task.is_some() {
        return Err("已有同步任务正在运行".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    *task = Some((id.clone(), token.clone()));
    let mut status = state
        .status
        .lock()
        .map_err(|_| "同步状态不可用".to_string())?;
    *status = SyncStatus {
        state: SyncRunState::Running,
        started_at: Some(library::now_ms()),
        ..SyncStatus::default()
    };
    Ok((id, token))
}

fn finish_task(state: &SyncTaskState, task_id: &str, result: &Result<SyncStatus, WebDavError>) {
    if let Ok(mut task) = state.task.lock() {
        if task.as_ref().is_some_and(|(id, _)| id == task_id) {
            *task = None;
        }
    }
    if let Ok(mut status) = state.status.lock() {
        match result {
            Ok(value) => *status = value.clone(),
            Err(error) => {
                status.state = if error.code == "SYNC_CANCELLED" {
                    SyncRunState::Cancelled
                } else {
                    SyncRunState::Error
                };
                status.finished_at = Some(library::now_ms());
                status.last_error = Some(error.message.clone());
            }
        }
    }
}

const DEVICE_ID_KEY: &str = "sync.device_id";
const GROUP_OBJECT_PREFIX: &str = "library-group:";
const GROUP_STATE_FIELD: &str = "state";
const MEMBERSHIP_OBJECT_PREFIX: &str = "library-membership:";
const MEMBERSHIP_STATE_FIELD: &str = "present";
const ITEM_OBJECT_PREFIX: &str = "library-item:";
const ITEM_STATE_FIELD: &str = "present";
const ITEM_OFFLINE_FIELD: &str = "offlinePinned";
const DRAFT_OBJECT_PREFIX: &str = "document-draft:";
const DRAFT_STATE_FIELD: &str = "present";
const MAX_SNAPSHOT_RECORDS: usize = 100_000;
const MAX_SNAPSHOT_ITEMS: usize = 100_000;
const MAX_SNAPSHOT_GROUPS: usize = 10_000;
const MAX_SNAPSHOT_MEMBERSHIPS: usize = 200_000;
const MAX_SNAPSHOT_DOCUMENTS: usize = 100_000;
const MAX_SNAPSHOT_ASSETS: usize = 200_000;
const MAX_SNAPSHOT_VERSIONS: usize = 200_000;
const MAX_SNAPSHOT_DRAFTS: usize = 100_000;
const BLOB_GC_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionPoint {
    pub device_id: String,
    pub version: u64,
    #[serde(default)]
    pub context: BTreeMap<String, u64>,
    pub modified_at: i64,
}

impl VersionPoint {
    fn counter_for(&self, device_id: &str) -> u64 {
        if self.device_id == device_id {
            self.version
        } else {
            self.context.get(device_id).copied().unwrap_or(0)
        }
    }

    fn merged_context(left: &Self, right: &Self) -> BTreeMap<String, u64> {
        let mut devices: BTreeSet<&str> = left.context.keys().map(String::as_str).collect();
        devices.extend(right.context.keys().map(String::as_str));
        devices.insert(left.device_id.as_str());
        devices.insert(right.device_id.as_str());
        devices
            .into_iter()
            .map(|device| {
                (
                    device.to_string(),
                    left.counter_for(device).max(right.counter_for(device)),
                )
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CausalOrder {
    Equal,
    Dominates,
    IsDominated,
    Concurrent,
}

/// Compare two dotted version vectors. Wall-clock time is intentionally not
/// used here; it is only a deterministic tie-breaker for concurrent edits.
pub fn compare_version_points(left: &VersionPoint, right: &VersionPoint) -> CausalOrder {
    let mut devices: BTreeSet<&str> = left.context.keys().map(String::as_str).collect();
    devices.extend(right.context.keys().map(String::as_str));
    devices.insert(left.device_id.as_str());
    devices.insert(right.device_id.as_str());
    let mut left_greater = false;
    let mut right_greater = false;
    for device in devices {
        match left.counter_for(device).cmp(&right.counter_for(device)) {
            Ordering::Greater => left_greater = true,
            Ordering::Less => right_greater = true,
            Ordering::Equal => {}
        }
    }
    match (left_greater, right_greater) {
        (false, false) => CausalOrder::Equal,
        (true, false) => CausalOrder::Dominates,
        (false, true) => CausalOrder::IsDominated,
        (true, true) => CausalOrder::Concurrent,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub record_id: String,
    pub object_id: String,
    pub field: String,
    pub value: Option<Value>,
    pub point: VersionPoint,
    #[serde(default)]
    pub tombstone: bool,
}

impl SyncRecord {
    pub fn validate(&self) -> Result<(), String> {
        if self.record_id.trim().is_empty()
            || self.object_id.trim().is_empty()
            || self.field.trim().is_empty()
            || self.point.device_id.trim().is_empty()
        {
            return Err("同步记录缺少标识或字段".to_string());
        }
        if self.object_id.len() > 512 || self.field.len() > 160 || self.point.context.len() > 256 {
            return Err("同步记录超过大小限制".to_string());
        }
        if self
            .value
            .as_ref()
            .and_then(|value| serde_json::to_vec(value).ok())
            .is_some_and(|bytes| bytes.len() > 4 * 1024 * 1024)
        {
            return Err("同步记录值超过大小限制".to_string());
        }
        if self.tombstone && self.value.is_some() {
            return Err("删除记录不能同时携带值".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub id: String,
    pub object_id: String,
    pub field: String,
    pub winner: Option<Value>,
    pub loser: Option<Value>,
    pub winner_device_id: String,
    pub loser_device_id: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    pub record: SyncRecord,
    pub conflict: Option<SyncConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupParentEdge {
    pub group_id: String,
    pub parent_id: Option<String>,
    pub point: VersionPoint,
}

fn json_equal(left: &Option<Value>, right: &Option<Value>) -> bool {
    left == right
}

fn deterministic_winner(left: &SyncRecord, right: &SyncRecord) -> bool {
    (
        left.point.modified_at,
        left.point.device_id.as_str(),
        left.point.version,
        left.record_id.as_str(),
    ) >= (
        right.point.modified_at,
        right.point.device_id.as_str(),
        right.point.version,
        right.record_id.as_str(),
    )
}

fn conflict_id(left: &SyncRecord, right: &SyncRecord) -> String {
    let (first, second) = if left.record_id <= right.record_id {
        (&left.record_id, &right.record_id)
    } else {
        (&right.record_id, &left.record_id)
    };
    let digest = Sha256::digest(
        format!("{}\n{}\n{}\n{}", left.object_id, left.field, first, second).as_bytes(),
    );
    format!(
        "conflict-{}",
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

/// Merge two values for the same logical object/field. A concurrent tie keeps
/// a deterministic winner and records the losing value for UI recovery.
pub fn merge_record_pair(left: &SyncRecord, right: &SyncRecord) -> Result<MergeOutcome, String> {
    left.validate()?;
    right.validate()?;
    if left.object_id != right.object_id || left.field != right.field {
        return Err("只能合并同一对象字段的同步记录".to_string());
    }
    let order = compare_version_points(&left.point, &right.point);
    let left_wins = match order {
        CausalOrder::Dominates | CausalOrder::Equal => true,
        CausalOrder::IsDominated => false,
        CausalOrder::Concurrent => deterministic_winner(left, right),
    };
    let (winner, loser) = if left_wins {
        (left, right)
    } else {
        (right, left)
    };
    let mut record = winner.clone();
    // Preserve both causal histories so the next local edit will dominate both
    // concurrent ancestors rather than creating the same conflict repeatedly.
    record.point.context = VersionPoint::merged_context(&left.point, &right.point);
    record.point.context.remove(&record.point.device_id);
    let conflict = (order == CausalOrder::Concurrent
        && (winner.tombstone != loser.tombstone || !json_equal(&winner.value, &loser.value)))
    .then(|| SyncConflict {
        id: conflict_id(left, right),
        object_id: winner.object_id.clone(),
        field: winner.field.clone(),
        winner: winner.value.clone(),
        loser: loser.value.clone(),
        winner_device_id: winner.point.device_id.clone(),
        loser_device_id: loser.point.device_id.clone(),
        created_at: library::now_ms(),
        resolved_at: None,
    });
    Ok(MergeOutcome { record, conflict })
}

fn edge_is_older(left: &GroupParentEdge, right: &GroupParentEdge) -> bool {
    match compare_version_points(&left.point, &right.point) {
        CausalOrder::IsDominated => true,
        CausalOrder::Dominates => false,
        CausalOrder::Equal | CausalOrder::Concurrent => {
            (
                left.point.modified_at,
                left.point.device_id.as_str(),
                left.point.version,
                left.group_id.as_str(),
            ) < (
                right.point.modified_at,
                right.point.device_id.as_str(),
                right.point.version,
                right.group_id.as_str(),
            )
        }
    }
}

/// Return a cycle-free set of group parent edges. A remote merge can create a
/// cycle despite each device having validated its local tree, so retain the
/// newest edge and detach the deterministically oldest edge in every cycle.
pub fn resolve_group_parent_cycles(mut edges: Vec<GroupParentEdge>) -> Vec<GroupParentEdge> {
    loop {
        let lookup: HashMap<String, usize> = edges
            .iter()
            .enumerate()
            .map(|(index, edge)| (edge.group_id.clone(), index))
            .collect();
        let mut changed = false;
        for start in 0..edges.len() {
            let mut path = Vec::<usize>::new();
            let mut seen = HashMap::<String, usize>::new();
            let mut current = Some(start);
            while let Some(index) = current {
                let group_id = edges[index].group_id.clone();
                if let Some(cycle_start) = seen.get(&group_id).copied() {
                    let cycle = &path[cycle_start..];
                    let oldest = *cycle
                        .iter()
                        .min_by(|left, right| {
                            if edge_is_older(&edges[**left], &edges[**right]) {
                                Ordering::Less
                            } else if edge_is_older(&edges[**right], &edges[**left]) {
                                Ordering::Greater
                            } else {
                                Ordering::Equal
                            }
                        })
                        .expect("cycle contains at least one edge");
                    edges[oldest].parent_id = None;
                    changed = true;
                    break;
                }
                seen.insert(group_id, path.len());
                path.push(index);
                current = edges[index]
                    .parent_id
                    .as_ref()
                    .and_then(|parent| lookup.get(parent).copied());
            }
            if changed {
                break;
            }
        }
        if !changed {
            return edges;
        }
    }
}

fn resolve_group_parent_constraints(mut edges: Vec<GroupParentEdge>) -> Vec<GroupParentEdge> {
    edges = resolve_group_parent_cycles(edges);
    loop {
        let lookup: HashMap<String, usize> = edges
            .iter()
            .enumerate()
            .map(|(index, edge)| (edge.group_id.clone(), index))
            .collect();
        let mut changed = false;
        for start in 0..edges.len() {
            let mut path = Vec::new();
            let mut current = Some(start);
            while let Some(index) = current {
                path.push(index);
                current = edges[index]
                    .parent_id
                    .as_ref()
                    .and_then(|parent| lookup.get(parent).copied());
            }
            if path.len() <= crate::groups::MAX_GROUP_DEPTH {
                continue;
            }
            if let Some(oldest) = path
                .into_iter()
                .filter(|index| edges[*index].parent_id.is_some())
                .min_by(|left, right| {
                    if edge_is_older(&edges[*left], &edges[*right]) {
                        Ordering::Less
                    } else if edge_is_older(&edges[*right], &edges[*left]) {
                        Ordering::Greater
                    } else {
                        Ordering::Equal
                    }
                })
            {
                edges[oldest].parent_id = None;
                changed = true;
                break;
            }
        }
        if !changed {
            return edges;
        }
    }
}

pub(crate) fn device_id(connection: &Connection) -> Result<String, String> {
    let existing = connection
        .query_row(
            "SELECT value FROM sync_meta WHERE key=?1",
            params![DEVICE_ID_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取同步设备标识: {error}"))?;
    if let Some(value) = existing.filter(|value| Uuid::parse_str(value).is_ok()) {
        return Ok(value);
    }
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO sync_meta(key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![DEVICE_ID_KEY, id],
        )
        .map_err(|error| format!("无法保存同步设备标识: {error}"))?;
    Ok(id)
}

fn parse_value(raw: Option<String>) -> rusqlite::Result<Option<Value>> {
    raw.map(|value| serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

fn parse_context(raw: String) -> rusqlite::Result<BTreeMap<String, u64>> {
    serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncRecord> {
    Ok(SyncRecord {
        record_id: row.get(0)?,
        object_id: row.get(1)?,
        field: row.get(2)?,
        value: parse_value(row.get(3)?)?,
        point: VersionPoint {
            device_id: row.get(4)?,
            version: row.get::<_, i64>(5)?.max(0) as u64,
            context: parse_context(row.get(6)?)?,
            modified_at: row.get(7)?,
        },
        tombstone: row.get::<_, i64>(8)? != 0,
    })
}

pub(crate) fn list_records_at(connection: &Connection) -> Result<Vec<SyncRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             FROM sync_records ORDER BY object_id,field,device_id",
        )
        .map_err(|error| format!("无法读取同步记录: {error}"))?;
    let records = statement
        .query_map([], row_to_record)
        .map_err(|error| format!("无法读取同步记录: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步记录: {error}"))?;
    Ok(records)
}

pub(crate) fn put_record_at(connection: &Connection, record: &SyncRecord) -> Result<(), String> {
    record.validate()?;
    let value_json = record
        .value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("无法序列化同步记录: {error}"))?;
    let context_json = serde_json::to_string(&record.point.context)
        .map_err(|error| format!("无法序列化同步上下文: {error}"))?;
    connection
        .execute(
            "INSERT INTO sync_records(
               record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(object_id,field,device_id) DO UPDATE SET
               record_id=excluded.record_id,value_json=excluded.value_json,version=excluded.version,
               context_json=excluded.context_json,modified_at=excluded.modified_at,tombstone=excluded.tombstone",
            params![
                record.record_id,
                record.object_id,
                record.field,
                value_json,
                record.point.device_id,
                record.point.version as i64,
                context_json,
                record.point.modified_at,
                i64::from(record.tombstone),
            ],
        )
        .map_err(|error| format!("无法写入同步记录: {error}"))?;
    Ok(())
}

fn record_for_device(
    connection: &Connection,
    object_id: &str,
    field: &str,
    device_id: &str,
) -> Result<Option<SyncRecord>, String> {
    connection
        .query_row(
            "SELECT record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             FROM sync_records WHERE object_id=?1 AND field=?2 AND device_id=?3",
            params![object_id, field, device_id],
            row_to_record,
        )
        .optional()
        .map_err(|error| format!("无法读取本地同步记录: {error}"))
}

pub(crate) fn write_local_record_at(
    connection: &Connection,
    object_id: String,
    field: String,
    value: Option<Value>,
    tombstone: bool,
) -> Result<SyncRecord, String> {
    if object_id.trim().is_empty() || field.trim().is_empty() {
        return Err("同步对象和字段不能为空".to_string());
    }
    if tombstone && value.is_some() {
        return Err("删除同步记录不能携带值".to_string());
    }
    let local_device = device_id(connection)?;
    let existing = record_for_device(connection, &object_id, &field, &local_device)?;
    let mut context = existing
        .as_ref()
        .map(|record| record.point.context.clone())
        .unwrap_or_default();
    let next_version = existing
        .as_ref()
        .map(|record| record.point.version.saturating_add(1))
        .unwrap_or(1);
    // Incorporate observed records from other devices for this field.
    for record in list_records_at(connection)?
        .into_iter()
        .filter(|record| record.object_id == object_id && record.field == field)
    {
        for (device, version) in VersionPoint::merged_context(
            &VersionPoint {
                device_id: local_device.clone(),
                version: next_version.saturating_sub(1),
                context: context.clone(),
                modified_at: 0,
            },
            &record.point,
        ) {
            if device != local_device {
                context
                    .entry(device)
                    .and_modify(|current| *current = (*current).max(version))
                    .or_insert(version);
            }
        }
    }
    let record = SyncRecord {
        record_id: Uuid::new_v4().to_string(),
        object_id,
        field,
        value,
        point: VersionPoint {
            device_id: local_device,
            version: next_version,
            context,
            modified_at: library::now_ms(),
        },
        tombstone,
    };
    put_record_at(connection, &record)?;
    Ok(record)
}

pub(crate) fn write_group_state_record_at(
    connection: &Connection,
    group_id: &str,
    value: Option<Value>,
) -> Result<SyncRecord, String> {
    write_local_record_at(
        connection,
        format!("{GROUP_OBJECT_PREFIX}{group_id}"),
        GROUP_STATE_FIELD.to_string(),
        value.clone(),
        value.is_none(),
    )
}

pub(crate) fn write_membership_record_at(
    connection: &Connection,
    group_id: &str,
    item_id: &str,
    present: bool,
) -> Result<SyncRecord, String> {
    write_local_record_at(
        connection,
        format!("{MEMBERSHIP_OBJECT_PREFIX}{group_id}:{item_id}"),
        MEMBERSHIP_STATE_FIELD.to_string(),
        present.then_some(Value::Bool(true)),
        !present,
    )
}

pub(crate) fn write_library_item_record_at(
    connection: &Connection,
    item_id: &str,
    present: bool,
) -> Result<SyncRecord, String> {
    write_local_record_at(
        connection,
        format!("{ITEM_OBJECT_PREFIX}{item_id}"),
        ITEM_STATE_FIELD.to_string(),
        present.then_some(Value::Bool(true)),
        !present,
    )
}

pub(crate) fn write_library_item_offline_pinned_record_at(
    connection: &Connection,
    item_id: &str,
    pinned: bool,
) -> Result<SyncRecord, String> {
    write_local_record_at(
        connection,
        format!("{ITEM_OBJECT_PREFIX}{item_id}"),
        ITEM_OFFLINE_FIELD.to_string(),
        Some(Value::Bool(pinned)),
        false,
    )
}

pub(crate) fn write_document_draft_record_at(
    connection: &Connection,
    draft_id: &str,
    present: bool,
) -> Result<SyncRecord, String> {
    if Uuid::parse_str(draft_id).is_err() {
        return Err("草稿标识无效".to_string());
    }
    write_local_record_at(
        connection,
        format!("{DRAFT_OBJECT_PREFIX}{draft_id}"),
        DRAFT_STATE_FIELD.to_string(),
        present.then_some(Value::Bool(true)),
        !present,
    )
}

fn current_record_for_key(records: Vec<SyncRecord>) -> Result<Option<SyncRecord>, String> {
    records
        .into_iter()
        .try_fold(None, |current, record| match current {
            Some(current) => {
                merge_record_pair(&current, &record).map(|outcome| Some(outcome.record))
            }
            None => Ok(Some(record)),
        })
}

fn current_records_with_prefix(
    connection: &Connection,
    prefix: &str,
    field: &str,
) -> Result<Vec<SyncRecord>, String> {
    let mut grouped: BTreeMap<String, Vec<SyncRecord>> = BTreeMap::new();
    for record in list_records_at(connection)? {
        if record.object_id.starts_with(prefix) && record.field == field {
            grouped
                .entry(record.object_id.clone())
                .or_default()
                .push(record);
        }
    }
    grouped
        .into_values()
        .map(current_record_for_key)
        .filter_map(|result| match result {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

pub(crate) fn persist_conflict_at(
    connection: &Connection,
    conflict: &SyncConflict,
) -> Result<bool, String> {
    let changed = connection
        .execute(
            "INSERT INTO sync_conflicts(
               id,object_id,field,winner_json,loser_json,winner_device_id,loser_device_id,created_at,resolved_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO NOTHING",
            params![
                conflict.id,
                conflict.object_id,
                conflict.field,
                conflict.winner.as_ref().map(serde_json::to_string).transpose().map_err(|error| format!("无法序列化冲突胜者: {error}"))?,
                conflict.loser.as_ref().map(serde_json::to_string).transpose().map_err(|error| format!("无法序列化冲突失败版本: {error}"))?,
                conflict.winner_device_id,
                conflict.loser_device_id,
                conflict.created_at,
                conflict.resolved_at,
            ],
        )
        .map_err(|error| format!("无法写入同步冲突: {error}"))?;
    Ok(changed != 0)
}

pub(crate) fn merge_remote_records_at(
    connection: &Connection,
    remote: impl IntoIterator<Item = SyncRecord>,
) -> Result<Vec<SyncConflict>, String> {
    let mut by_key: HashMap<(String, String), Vec<SyncRecord>> = HashMap::new();
    for record in list_records_at(connection)? {
        by_key
            .entry((record.object_id.clone(), record.field.clone()))
            .or_default()
            .push(record);
    }
    let mut conflicts = Vec::new();
    for incoming in remote {
        incoming.validate()?;
        let key = (incoming.object_id.clone(), incoming.field.clone());
        let records = by_key.entry(key).or_default();
        // Keep each device's source record so a later edit can acknowledge all
        // observed ancestors. Still compare a new device record with every
        // existing device record now, otherwise a concurrent edit would be
        // silently hidden until a later local write.
        for existing in records
            .iter()
            .filter(|record| record.point.device_id != incoming.point.device_id)
        {
            if let Some(conflict) = merge_record_pair(existing, &incoming)?.conflict {
                if persist_conflict_at(connection, &conflict)? {
                    conflicts.push(conflict);
                }
            }
        }
        if let Some(index) = records
            .iter()
            .position(|record| record.point.device_id == incoming.point.device_id)
        {
            let outcome = merge_record_pair(&records[index], &incoming)?;
            if let Some(conflict) = outcome.conflict {
                if persist_conflict_at(connection, &conflict)? {
                    conflicts.push(conflict);
                }
            }
            put_record_at(connection, &outcome.record)?;
            records[index] = outcome.record;
        } else {
            put_record_at(connection, &incoming)?;
            records.push(incoming);
        }
    }
    Ok(conflicts)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SnapshotItem {
    id: String,
    source_id: Option<String>,
    source_kind: String,
    title: String,
    authors: Vec<String>,
    cover_url: Option<String>,
    acquisition_url: Option<String>,
    media_type: Option<String>,
    extension: Option<String>,
    size: Option<i64>,
    etag: Option<String>,
    last_modified: Option<String>,
    series: Option<String>,
    number: Option<String>,
    volume: Option<String>,
    page_count: Option<i64>,
    reading_direction: Option<String>,
    cover_page: Option<i64>,
    blob_hash: Option<String>,
    availability: String,
    offline_pinned: bool,
    subjects: Vec<String>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SnapshotGroup {
    id: String,
    parent_id: Option<String>,
    name: String,
    kind: String,
    rule: Option<Value>,
    sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotMembership {
    group_id: String,
    item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocument {
    id: String,
    content_hash: String,
    title: String,
    availability: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotAsset {
    hash: String,
    relative_path: String,
    size: u64,
    media_type: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocumentVersion {
    id: String,
    document_id: String,
    blob_hash: String,
    size: u64,
    device_id: Option<String>,
    created_at: i64,
    is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDraft {
    id: String,
    document_id: Option<String>,
    blob_hash: String,
    title: Option<String>,
    device_id: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSnapshot {
    schema: u32,
    device_id: String,
    generated_at: i64,
    records: Vec<SyncRecord>,
    items: Vec<SnapshotItem>,
    groups: Vec<SnapshotGroup>,
    memberships: Vec<SnapshotMembership>,
    #[serde(default)]
    documents: Vec<SnapshotDocument>,
    #[serde(default)]
    assets: Vec<SnapshotAsset>,
    #[serde(default)]
    document_versions: Vec<SnapshotDocumentVersion>,
    #[serde(default)]
    drafts: Vec<SnapshotDraft>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProfileDescriptor {
    id: String,
    name: String,
    url: String,
    auth_type: webdav::SyncAuthKind,
    needs_credential: bool,
    updated_at: i64,
}

async fn upload_profile_descriptor(
    profile: &webdav::SyncProfile,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<(), WebDavError> {
    let descriptor = RemoteProfileDescriptor {
        id: profile.id.clone(),
        name: profile.name.clone(),
        url: profile.url.clone(),
        auth_type: profile.auth_type.clone(),
        // Credentials are device-local even when this device currently has
        // one. A client discovering the remote descriptor must always prompt.
        needs_credential: true,
        updated_at: profile.updated_at,
    };
    let body = serde_json::to_vec(&descriptor).map_err(|error| {
        WebDavError::new(
            "SYNC_PROFILE_INVALID",
            format!("无法序列化同步目标描述: {error}"),
        )
    })?;
    let path = webdav::remote_profile_path()?;
    client.put_atomic(&path, &body, Some(token)).await
}

fn local_items(connection: &Connection) -> Result<Vec<SnapshotItem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,source_id,source_kind,title,authors_json,cover_url,acquisition_url,
                    media_type,extension,size,etag,last_modified,series,number,volume,page_count,
                    reading_direction,cover_page,blob_hash,availability,offline_pinned,subjects_json,updated_at
             FROM library_items
             WHERE source_kind<>'local' OR blob_hash IS NOT NULL
             ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步书籍: {error}"))?;
    let items = statement
        .query_map([], |row| {
            let authors: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default();
            let subjects: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(21)?).unwrap_or_default();
            Ok(SnapshotItem {
                id: row.get(0)?,
                source_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                authors,
                cover_url: row.get(5)?,
                acquisition_url: row.get(6)?,
                media_type: row.get(7)?,
                extension: row.get(8)?,
                size: row.get(9)?,
                etag: row.get(10)?,
                last_modified: row.get(11)?,
                series: row.get(12)?,
                number: row.get(13)?,
                volume: row.get(14)?,
                page_count: row.get(15)?,
                reading_direction: row.get(16)?,
                cover_page: row.get(17)?,
                blob_hash: row.get(18)?,
                availability: row.get(19)?,
                offline_pinned: row.get::<_, i64>(20)? != 0,
                subjects,
                updated_at: row.get(22)?,
            })
        })
        .map_err(|error| format!("无法读取同步书籍: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步书籍: {error}"))?;
    Ok(items)
}

fn local_groups(connection: &Connection) -> Result<Vec<SnapshotGroup>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,parent_id,name,kind,rule_json,sort_order
             FROM library_groups WHERE kind='custom' ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步分组: {error}"))?;
    let groups = statement
        .query_map([], |row| {
            let rule: Option<String> = row.get(4)?;
            Ok(SnapshotGroup {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                rule: rule.and_then(|value| serde_json::from_str(&value).ok()),
                sort_order: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步分组: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步分组: {error}"))?;
    Ok(groups)
}

fn local_memberships(connection: &Connection) -> Result<Vec<SnapshotMembership>, String> {
    let mut statement = connection
        .prepare("SELECT group_id,item_id FROM library_group_members ORDER BY group_id,item_id")
        .map_err(|error| format!("无法读取同步分组成员: {error}"))?;
    let memberships = statement
        .query_map([], |row| {
            Ok(SnapshotMembership {
                group_id: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("无法读取同步分组成员: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步分组成员: {error}"))?;
    Ok(memberships)
}

fn local_documents(connection: &Connection) -> Result<Vec<SnapshotDocument>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,content_hash,title,availability,created_at,updated_at
             FROM managed_documents ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步文档: {error}"))?;
    let documents = statement
        .query_map([], |row| {
            Ok(SnapshotDocument {
                id: row.get(0)?,
                content_hash: row.get(1)?,
                title: row.get(2)?,
                availability: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步文档: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步文档: {error}"))?;
    Ok(documents)
}

fn local_assets(connection: &Connection) -> Result<Vec<SnapshotAsset>, String> {
    let mut statement = connection
        .prepare(
            "SELECT hash,relative_path,size,media_type,created_at,updated_at
             FROM managed_assets ORDER BY relative_path",
        )
        .map_err(|error| format!("无法读取同步资源: {error}"))?;
    let assets = statement
        .query_map([], |row| {
            Ok(SnapshotAsset {
                hash: row.get(0)?,
                relative_path: row.get(1)?,
                size: row.get::<_, i64>(2)?.max(0) as u64,
                media_type: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步资源: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步资源: {error}"))?;
    Ok(assets)
}

fn local_document_versions(
    connection: &Connection,
) -> Result<Vec<SnapshotDocumentVersion>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,size,device_id,created_at,is_current
             FROM document_versions ORDER BY document_id,created_at DESC,id",
        )
        .map_err(|error| format!("无法读取同步文档版本: {error}"))?;
    let versions = statement
        .query_map([], |row| {
            Ok(SnapshotDocumentVersion {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                size: row.get::<_, i64>(3)?.max(0) as u64,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                is_current: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|error| format!("无法读取同步文档版本: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步文档版本: {error}"))?;
    Ok(versions)
}

fn local_drafts(connection: &Connection) -> Result<Vec<SnapshotDraft>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,title,device_id,created_at,updated_at
             FROM document_drafts ORDER BY updated_at DESC,id",
        )
        .map_err(|error| format!("无法读取同步草稿: {error}"))?;
    let drafts = statement
        .query_map([], |row| {
            Ok(SnapshotDraft {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                title: row.get(3)?,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取同步草稿: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步草稿: {error}"))?;
    Ok(drafts)
}

fn local_snapshot(connection: &Connection, device_id: String) -> Result<SyncSnapshot, String> {
    Ok(SyncSnapshot {
        schema: 1,
        device_id,
        generated_at: library::now_ms(),
        records: list_records_at(connection)?,
        items: local_items(connection)?,
        groups: local_groups(connection)?,
        memberships: local_memberships(connection)?,
        documents: local_documents(connection)?,
        assets: local_assets(connection)?,
        document_versions: local_document_versions(connection)?,
        drafts: local_drafts(connection)?,
    })
}

fn backfill_group_records(connection: &Connection) -> Result<(), String> {
    let item_records =
        current_records_with_prefix(connection, ITEM_OBJECT_PREFIX, ITEM_STATE_FIELD)?
            .into_iter()
            .map(|record| (record.object_id.clone(), record))
            .collect::<HashMap<_, _>>();
    for item in local_items(connection)? {
        let object_id = format!("{ITEM_OBJECT_PREFIX}{}", item.id);
        if item_records
            .get(&object_id)
            .is_none_or(|record| record.tombstone)
        {
            write_library_item_record_at(connection, &item.id, true)?;
        }
        let offline_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_records WHERE object_id=?1 AND field=?2)",
                params![object_id, ITEM_OFFLINE_FIELD],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法检查书籍离线设置同步记录: {error}"))?;
        if !offline_exists {
            write_library_item_offline_pinned_record_at(connection, &item.id, item.offline_pinned)?;
        }
    }
    for group in local_groups(connection)? {
        let object_id = format!("{GROUP_OBJECT_PREFIX}{}", group.id);
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_records WHERE object_id=?1 AND field=?2)",
                params![object_id, GROUP_STATE_FIELD],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法检查分组同步记录: {error}"))?;
        if !exists {
            write_group_state_record_at(
                connection,
                &group.id,
                Some(
                    serde_json::to_value(&group)
                        .map_err(|error| format!("无法序列化分组同步状态: {error}"))?,
                ),
            )?;
        }
    }
    for membership in local_memberships(connection)? {
        let object_id = format!(
            "{MEMBERSHIP_OBJECT_PREFIX}{}:{}",
            membership.group_id, membership.item_id
        );
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_records WHERE object_id=?1 AND field=?2)",
                params![object_id, MEMBERSHIP_STATE_FIELD],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法检查分组成员同步记录: {error}"))?;
        if !exists {
            write_membership_record_at(
                connection,
                &membership.group_id,
                &membership.item_id,
                true,
            )?;
        }
    }
    let draft_records =
        current_records_with_prefix(connection, DRAFT_OBJECT_PREFIX, DRAFT_STATE_FIELD)?
            .into_iter()
            .map(|record| (record.object_id.clone(), record))
            .collect::<HashMap<_, _>>();
    for draft in local_drafts(connection)? {
        let object_id = format!("{DRAFT_OBJECT_PREFIX}{}", draft.id);
        if draft_records
            .get(&object_id)
            .is_none_or(|record| record.tombstone)
        {
            write_document_draft_record_at(connection, &draft.id, true)?;
        }
    }
    Ok(())
}

fn snapshot_blob_hashes(snapshot: &SyncSnapshot, hashes: &mut BTreeSet<String>) {
    hashes.extend(
        snapshot
            .items
            .iter()
            .filter_map(|item| item.blob_hash.clone()),
    );
    hashes.extend(
        snapshot
            .documents
            .iter()
            .map(|document| document.content_hash.clone()),
    );
    hashes.extend(snapshot.assets.iter().map(|asset| asset.hash.clone()));
    hashes.extend(
        snapshot
            .document_versions
            .iter()
            .map(|version| version.blob_hash.clone()),
    );
    hashes.extend(snapshot.drafts.iter().map(|draft| draft.blob_hash.clone()));
}

fn href_last_path_component(href: &str) -> Option<String> {
    let path = Url::parse(href)
        .ok()
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|| href.to_owned());
    let component = path.trim_end_matches('/').rsplit('/').next()?;
    (!component.is_empty() && !component.contains(['?', '#', '\\'])).then(|| component.to_owned())
}

async fn cleanup_unreferenced_blobs(
    connection: &mut Connection,
    client: &webdav::WebDavClient,
    local_snapshot: &SyncSnapshot,
    remote_snapshots: &[SyncSnapshot],
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let mut referenced = BTreeSet::new();
    snapshot_blob_hashes(local_snapshot, &mut referenced);
    for snapshot in remote_snapshots {
        snapshot_blob_hashes(snapshot, &mut referenced);
    }
    let prefixes = client
        .list_hrefs("LightInk/v1/blobs/sha256")
        .await?
        .into_iter()
        .filter_map(|href| href_last_path_component(&href))
        .filter(|prefix| {
            prefix.len() == 2
                && prefix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .collect::<BTreeSet<_>>();
    let now = library::now_ms();
    let mut deleted = 0_u64;
    for prefix in prefixes {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let directory = format!("LightInk/v1/blobs/sha256/{prefix}");
        let hashes = match client.list_hrefs(&directory).await {
            Ok(hrefs) => hrefs,
            Err(error) if error.status == Some(404) => continue,
            Err(error) => return Err(error),
        };
        for href in hashes {
            if token.is_cancelled() {
                return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
            }
            let Some(hash) = href_last_path_component(&href) else {
                continue;
            };
            if !is_sha256(&hash) || !hash.starts_with(&prefix) {
                continue;
            }
            let key = format!("sync.gc.unreferenced.{hash}");
            if referenced.contains(&hash) {
                connection
                    .execute("DELETE FROM sync_meta WHERE key=?1", params![key])
                    .map_err(|error| {
                        WebDavError::new(
                            "SYNC_STORAGE_ERROR",
                            format!("无法清理 blob 标记: {error}"),
                        )
                    })?;
                continue;
            }
            let observed: Option<i64> = connection
                .query_row(
                    "SELECT value FROM sync_meta WHERE key=?1",
                    params![key],
                    |row| {
                        let value: String = row.get(0)?;
                        Ok(value.parse::<i64>().unwrap_or(now))
                    },
                )
                .optional()
                .map_err(|error| {
                    WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取 blob 标记: {error}"))
                })?;
            let first_seen = observed.unwrap_or(now);
            if observed.is_none() {
                connection
                    .execute(
                        "INSERT INTO sync_meta(key,value) VALUES (?1,?2)
                         ON CONFLICT(key) DO NOTHING",
                        params![key, now.to_string()],
                    )
                    .map_err(|error| {
                        WebDavError::new(
                            "SYNC_STORAGE_ERROR",
                            format!("无法记录 blob 标记: {error}"),
                        )
                    })?;
            } else if now.saturating_sub(first_seen) >= BLOB_GC_GRACE_MS {
                client.delete(&webdav::remote_blob_path(&hash)?).await?;
                connection
                    .execute("DELETE FROM sync_meta WHERE key=?1", params![key])
                    .map_err(|error| {
                        WebDavError::new(
                            "SYNC_STORAGE_ERROR",
                            format!("无法删除 blob 标记: {error}"),
                        )
                    })?;
                deleted = deleted.saturating_add(1);
            }
        }
    }
    Ok(deleted)
}

async fn ensure_remote_layout(client: &webdav::WebDavClient) -> Result<(), WebDavError> {
    // Creating each parent explicitly works with servers that reject a deep
    // collection in one request.
    for path in [
        "LightInk",
        "LightInk/v1",
        "LightInk/v1/devices",
        "LightInk/v1/blobs",
        "LightInk/v1/blobs/sha256",
    ] {
        client.mkcol(path).await?;
    }
    Ok(())
}

async fn ensure_sync_capabilities(client: &webdav::WebDavClient) -> Result<(), WebDavError> {
    let capability = client.capability().await?;
    let mut missing = Vec::new();
    if !capability.reachable {
        missing.push("连接");
    }
    if !capability.supports_propfind {
        missing.push("PROPFIND");
    }
    if !capability.supports_mkcol {
        missing.push("MKCOL");
    }
    if !capability.supports_move {
        missing.push("MOVE");
    }
    if !capability.supports_conditional_put {
        missing.push("If-None-Match");
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(WebDavError::new(
        "SYNC_CAPABILITY_UNSUPPORTED",
        format!("WebDAV 服务器缺少同步所需能力: {}", missing.join(", ")),
    ))
}

async fn ensure_blob_prefix(
    client: &webdav::WebDavClient,
    hash: &str,
    created: &mut BTreeSet<String>,
) -> Result<(), WebDavError> {
    if !is_sha256(hash) {
        return Err(WebDavError::new(
            "SYNC_HASH_INVALID",
            "正文哈希必须是 64 位十六进制 SHA-256",
        ));
    }
    let prefix = hash[..2].to_ascii_lowercase();
    if created.insert(prefix.clone()) {
        client
            .mkcol(&format!("{}/blobs/sha256/{prefix}", webdav::WEBDAV_ROOT))
            .await?;
    }
    Ok(())
}

fn snapshot_device_from_href(href: &str) -> Option<String> {
    let path = Url::parse(href)
        .ok()
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|| href.to_owned());
    let name = path.trim_end_matches('/').rsplit('/').next()?.to_owned();
    if name.ends_with(".json")
        && name.len() <= 200
        && !name.contains(['\\', '?', '#'])
        && uuid::Uuid::parse_str(name.trim_end_matches(".json")).is_ok()
    {
        Some(name.trim_end_matches(".json").to_owned())
    } else {
        None
    }
}

async fn read_remote_snapshots(
    client: &webdav::WebDavClient,
    own_device: &str,
    token: &CancellationToken,
) -> Result<Vec<SyncSnapshot>, WebDavError> {
    let hrefs = client.list_hrefs("LightInk/v1/devices").await?;
    let mut snapshots = Vec::new();
    for href in hrefs {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let Some(device) = snapshot_device_from_href(&href) else {
            continue;
        };
        if device == own_device {
            continue;
        }
        let path = webdav::remote_state_path(&format!("{device}.json"))?;
        let (bytes, _, _) = client
            .get_bytes(&path, MAX_SYNC_RESPONSE_BYTES, Some(token))
            .await?;
        let snapshot: SyncSnapshot = serde_json::from_slice(&bytes).map_err(|error| {
            WebDavError::new(
                "SYNC_REMOTE_SNAPSHOT_INVALID",
                format!("远端设备快照无效: {error}"),
            )
        })?;
        if snapshot.schema != 1
            || snapshot.device_id != device
            || Uuid::parse_str(&snapshot.device_id).is_err()
            || snapshot.generated_at < 0
            || snapshot.records.len() > MAX_SNAPSHOT_RECORDS
            || snapshot.items.len() > MAX_SNAPSHOT_ITEMS
            || snapshot.groups.len() > MAX_SNAPSHOT_GROUPS
            || snapshot.memberships.len() > MAX_SNAPSHOT_MEMBERSHIPS
            || snapshot.documents.len() > MAX_SNAPSHOT_DOCUMENTS
            || snapshot.assets.len() > MAX_SNAPSHOT_ASSETS
            || snapshot.document_versions.len() > MAX_SNAPSHOT_VERSIONS
            || snapshot.drafts.len() > MAX_SNAPSHOT_DRAFTS
        {
            return Err(WebDavError::new(
                "SYNC_REMOTE_SNAPSHOT_INVALID",
                "远端设备快照版本或设备标识无效",
            ));
        }
        for record in &snapshot.records {
            record
                .validate()
                .map_err(|error| WebDavError::new("SYNC_REMOTE_SNAPSHOT_INVALID", error))?;
        }
        snapshots.push(snapshot);
    }
    Ok(snapshots)
}

fn apply_snapshot_items(connection: &Connection, items: &[SnapshotItem]) -> Result<(), String> {
    for item in items {
        validate_snapshot_item(item)?;
        let local_updated = connection
            .query_row(
                "SELECT updated_at FROM library_items WHERE id=?1",
                params![item.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("无法读取本地书籍时间: {error}"))?;
        if local_updated.is_some_and(|value| value > item.updated_at) {
            continue;
        }
        let authors = serde_json::to_string(&item.authors)
            .map_err(|error| format!("无法序列化作者: {error}"))?;
        let subjects = serde_json::to_string(&item.subjects)
            .map_err(|error| format!("无法序列化主题: {error}"))?;
        let source_id = item.source_id.as_ref().and_then(|source_id| {
            connection
                .query_row(
                    "SELECT 1 FROM opds_sources WHERE id=?1",
                    params![source_id],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .map(|_| source_id.clone())
        });
        let remote_availability = if item.blob_hash.is_some() {
            "remote"
        } else {
            item.availability.as_str()
        };
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_id,source_kind,title,authors_json,cover_url,acquisition_url,media_type,
                   extension,size,etag,last_modified,series,number,volume,page_count,reading_direction,
                   cover_page,blob_hash,availability,offline_pinned,subjects_json,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
                 ON CONFLICT(id) DO UPDATE SET source_id=?2,source_kind=?3,title=?4,authors_json=?5,
                   cover_url=?6,acquisition_url=?7,media_type=?8,extension=?9,size=?10,etag=?11,
                   last_modified=?12,series=?13,number=?14,volume=?15,page_count=?16,reading_direction=?17,
                   cover_page=?18,blob_hash=?19,availability=CASE WHEN library_items.local_path IS NULL THEN ?20 ELSE library_items.availability END,
                   offline_pinned=?21,subjects_json=?22,updated_at=?23",
                params![
                    item.id, source_id, item.source_kind, item.title, authors, item.cover_url,
                    item.acquisition_url, item.media_type, item.extension, item.size, item.etag,
                    item.last_modified, item.series, item.number, item.volume, item.page_count,
                    item.reading_direction, item.cover_page, item.blob_hash, remote_availability,
                    i64::from(item.offline_pinned), subjects, item.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端书籍元数据: {error}"))?;
    }
    apply_current_item_records(connection)?;
    apply_current_item_fields(connection)?;
    Ok(())
}

fn apply_current_item_records(connection: &Connection) -> Result<(), String> {
    for record in current_records_with_prefix(connection, ITEM_OBJECT_PREFIX, ITEM_STATE_FIELD)? {
        let item_id = record
            .object_id
            .strip_prefix(ITEM_OBJECT_PREFIX)
            .unwrap_or_default();
        if item_id.trim().is_empty() || item_id.len() > 512 || item_id.chars().any(char::is_control)
        {
            return Err("同步书籍记录标识无效".to_string());
        }
        if record.tombstone {
            connection
                .execute("DELETE FROM library_items WHERE id=?1", params![item_id])
                .map_err(|error| format!("无法应用同步书籍删除: {error}"))?;
        } else if record.value != Some(Value::Bool(true)) {
            return Err("同步书籍记录值无效".to_string());
        }
    }
    Ok(())
}

fn apply_current_item_fields(connection: &Connection) -> Result<(), String> {
    for record in current_records_with_prefix(connection, ITEM_OBJECT_PREFIX, ITEM_OFFLINE_FIELD)? {
        let item_id = record
            .object_id
            .strip_prefix(ITEM_OBJECT_PREFIX)
            .unwrap_or_default();
        if item_id.trim().is_empty() || item_id.len() > 512 || item_id.chars().any(char::is_control)
        {
            return Err("同步书籍字段标识无效".to_string());
        }
        if record.tombstone {
            continue;
        }
        let Some(Value::Bool(pinned)) = record.value else {
            return Err("同步书籍离线设置值无效".to_string());
        };
        connection
            .execute(
                "UPDATE library_items SET offline_pinned=?1,updated_at=MAX(updated_at,?2) WHERE id=?3",
                params![i64::from(pinned), record.point.modified_at, item_id],
            )
            .map_err(|error| format!("无法应用同步书籍离线设置: {error}"))?;
    }
    Ok(())
}

fn validate_snapshot_url(value: Option<&String>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("远端书籍 URL 无效".to_string());
    }
    if value.starts_with("data:image/") {
        return Ok(());
    }
    let url = Url::parse(value).map_err(|_| "远端书籍 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("远端书籍 URL 必须是不含凭据的 HTTP(S) 地址".to_string());
    }
    Ok(())
}

fn validate_snapshot_item(item: &SnapshotItem) -> Result<(), String> {
    if item.id.trim().is_empty()
        || item.id.len() > 512
        || item.source_kind.trim().is_empty()
        || item.source_kind.len() > 32
        || item.source_kind.chars().any(char::is_control)
        || item.source_id.as_ref().is_some_and(|source_id| {
            source_id.is_empty() || source_id.len() > 512 || source_id.chars().any(char::is_control)
        })
        || item.title.trim().is_empty()
        || item.title.len() > 1024
        || item.title.chars().any(char::is_control)
        || item.updated_at < 0
        || item
            .size
            .is_some_and(|size| size < 0 || size as u64 > webdav::MAX_SYNC_BLOB_BYTES)
        || item.blob_hash.as_ref().is_some_and(|hash| !is_sha256(hash))
        || item.authors.len() > 64
        || item.subjects.len() > 64
        || item
            .authors
            .iter()
            .chain(item.subjects.iter())
            .any(|value| value.len() > 512 || value.chars().any(char::is_control))
        || item.extension.as_ref().is_some_and(|extension| {
            extension.len() > 16
                || extension
                    .bytes()
                    .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
        })
        || !matches!(
            item.availability.as_str(),
            "external" | "local" | "remote" | "missing"
        )
        || (item.source_kind == "managed"
            && item
                .blob_hash
                .as_ref()
                .is_none_or(|hash| item.id.strip_prefix("managed:") != Some(hash.as_str())))
    {
        return Err("远端书籍元数据无效".to_string());
    }
    validate_snapshot_url(item.cover_url.as_ref())?;
    validate_snapshot_url(item.acquisition_url.as_ref())?;
    Ok(())
}

fn apply_snapshot_groups(
    connection: &Connection,
    groups: &[SnapshotGroup],
    memberships: &[SnapshotMembership],
) -> Result<(), String> {
    // Insert/update nodes without parents first, then apply validated edges.
    for group in groups.iter().filter(|group| group.kind == "custom") {
        validate_snapshot_group(group)?;
        let rule = group
            .rule
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("无法序列化分组规则: {error}"))?;
        connection
            .execute(
                "INSERT INTO library_groups(id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at)
                 VALUES (?1,NULL,?2,'custom',?3,?4,?5,?5)
                 ON CONFLICT(id) DO UPDATE SET name=?2,kind='custom',rule_json=?3,sort_order=?4,updated_at=?5",
                params![group.id, group.name, rule, group.sort_order, library::now_ms()],
            )
            .map_err(|error| format!("无法合并远端分组: {error}"))?;
    }
    let edges: Vec<GroupParentEdge> = groups
        .iter()
        .filter(|group| group.kind == "custom")
        .map(|group| GroupParentEdge {
            group_id: group.id.clone(),
            parent_id: group.parent_id.clone(),
            point: VersionPoint {
                device_id: "remote".into(),
                version: 0,
                context: BTreeMap::new(),
                modified_at: 0,
            },
        })
        .collect();
    for edge in resolve_group_parent_constraints(edges) {
        let parent_exists: bool = edge
            .parent_id
            .as_ref()
            .and_then(|parent| {
                connection
                    .query_row(
                        "SELECT 1 FROM library_groups WHERE id=?1",
                        params![parent],
                        |_| Ok(1),
                    )
                    .optional()
                    .ok()
            })
            .flatten()
            .is_some();
        connection
            .execute(
                "UPDATE library_groups SET parent_id=?1 WHERE id=?2",
                params![edge.parent_id.filter(|_| parent_exists), edge.group_id],
            )
            .map_err(|error| format!("无法合并分组层级: {error}"))?;
    }
    for member in memberships {
        if Uuid::parse_str(&member.group_id).is_err() || member.item_id.trim().is_empty() {
            return Err("远端分组成员标识无效".to_string());
        }
        let valid: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id=?1 AND kind='custom') AND EXISTS(SELECT 1 FROM library_items WHERE id=?2)",
                params![member.group_id, member.item_id],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if valid {
            connection
                .execute(
                    "INSERT INTO library_group_members(group_id,item_id,created_at) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                    params![member.group_id, member.item_id, library::now_ms()],
                )
                .map_err(|error| format!("无法合并分组成员: {error}"))?;
        }
    }
    apply_current_group_records(connection)?;
    Ok(())
}

fn validate_snapshot_group(group: &SnapshotGroup) -> Result<(), String> {
    if Uuid::parse_str(&group.id).is_err()
        || group
            .parent_id
            .as_ref()
            .is_some_and(|parent| Uuid::parse_str(parent).is_err())
        || group.kind != "custom"
        || group.sort_order < 0
        || group.name.trim().is_empty()
        || group.name.chars().count() > 80
        || group.name.chars().any(char::is_control)
    {
        return Err("远端自定义分组数据无效".to_string());
    }
    Ok(())
}

fn apply_current_group_records(connection: &Connection) -> Result<(), String> {
    let mut active = BTreeMap::<String, (SnapshotGroup, VersionPoint)>::new();
    let mut deleted = BTreeSet::new();
    for record in current_records_with_prefix(connection, GROUP_OBJECT_PREFIX, GROUP_STATE_FIELD)? {
        let group_id = record
            .object_id
            .strip_prefix(GROUP_OBJECT_PREFIX)
            .unwrap_or_default()
            .to_string();
        if Uuid::parse_str(&group_id).is_err() {
            return Err("同步分组记录标识无效".to_string());
        }
        if record.tombstone {
            deleted.insert(group_id);
            continue;
        }
        let group: SnapshotGroup = serde_json::from_value(
            record
                .value
                .clone()
                .ok_or_else(|| "同步分组记录缺少状态".to_string())?,
        )
        .map_err(|error| format!("同步分组记录无效: {error}"))?;
        validate_snapshot_group(&group)?;
        if group.id != group_id {
            return Err("同步分组记录与对象标识不匹配".to_string());
        }
        active.insert(group_id, (group, record.point));
    }

    for (group, _) in active.values() {
        let rule = group
            .rule
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("无法序列化同步分组规则: {error}"))?;
        connection
            .execute(
                "INSERT INTO library_groups(id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at)
                 VALUES (?1,NULL,?2,'custom',?3,?4,?5,?5)
                 ON CONFLICT(id) DO UPDATE SET name=?2,kind='custom',rule_json=?3,
                   sort_order=?4,updated_at=?5",
                params![
                    group.id,
                    group.name,
                    rule,
                    group.sort_order,
                    library::now_ms()
                ],
            )
            .map_err(|error| format!("无法应用同步分组状态: {error}"))?;
    }
    for group_id in deleted {
        connection
            .execute(
                "DELETE FROM library_groups WHERE id=?1 AND kind='custom'",
                params![group_id],
            )
            .map_err(|error| format!("无法应用同步分组删除: {error}"))?;
    }

    let mut statement = connection
        .prepare("SELECT id,parent_id FROM library_groups WHERE kind='custom' ORDER BY id")
        .map_err(|error| format!("无法读取同步分组层级: {error}"))?;
    let edges = statement
        .query_map([], |row| {
            let group_id: String = row.get(0)?;
            let stored_parent: Option<String> = row.get(1)?;
            let (parent_id, point) = active
                .get(&group_id)
                .map(|(group, point)| (group.parent_id.clone(), point.clone()))
                .unwrap_or((stored_parent, VersionPoint::default()));
            Ok(GroupParentEdge {
                group_id,
                parent_id,
                point,
            })
        })
        .map_err(|error| format!("无法读取同步分组层级: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步分组层级: {error}"))?;
    drop(statement);
    for edge in resolve_group_parent_constraints(edges) {
        let parent_exists: bool = edge
            .parent_id
            .as_ref()
            .map(|parent| {
                connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id=?1 AND kind='custom')",
                        params![parent],
                        |row| row.get(0),
                    )
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        connection
            .execute(
                "UPDATE library_groups SET parent_id=?1 WHERE id=?2 AND kind='custom'",
                params![edge.parent_id.filter(|_| parent_exists), edge.group_id],
            )
            .map_err(|error| format!("无法应用同步分组层级: {error}"))?;
    }

    for record in
        current_records_with_prefix(connection, MEMBERSHIP_OBJECT_PREFIX, MEMBERSHIP_STATE_FIELD)?
    {
        let suffix = record
            .object_id
            .strip_prefix(MEMBERSHIP_OBJECT_PREFIX)
            .unwrap_or_default();
        let (group_id, item_id) = suffix
            .split_once(':')
            .ok_or_else(|| "同步分组成员记录标识无效".to_string())?;
        if Uuid::parse_str(group_id).is_err() || item_id.trim().is_empty() {
            return Err("同步分组成员记录标识无效".to_string());
        }
        if record.tombstone {
            connection
                .execute(
                    "DELETE FROM library_group_members WHERE group_id=?1 AND item_id=?2",
                    params![group_id, item_id],
                )
                .map_err(|error| format!("无法应用同步分组成员删除: {error}"))?;
            continue;
        }
        if record.value != Some(Value::Bool(true)) {
            return Err("同步分组成员记录值无效".to_string());
        }
        let valid: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id=?1 AND kind='custom')
                        AND EXISTS(SELECT 1 FROM library_items WHERE id=?2)",
                params![group_id, item_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法校验同步分组成员: {error}"))?;
        if valid {
            connection
                .execute(
                    "INSERT INTO library_group_members(group_id,item_id,created_at)
                     VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                    params![group_id, item_id, library::now_ms()],
                )
                .map_err(|error| format!("无法应用同步分组成员: {error}"))?;
        }
    }
    Ok(())
}

fn apply_snapshot_documents(
    connection: &Connection,
    app_data_dir: &Path,
    documents: &[SnapshotDocument],
    assets: &[SnapshotAsset],
    versions: &[SnapshotDocumentVersion],
    drafts: &[SnapshotDraft],
) -> Result<(), String> {
    let document_ids = documents
        .iter()
        .map(|document| document.id.as_str())
        .collect::<BTreeSet<_>>();

    // Validate all remote document metadata before changing any local rows. A
    // malformed snapshot must never leave a partially merged asset index.
    for document in documents {
        if Uuid::parse_str(&document.id).is_err()
            || !is_sha256(&document.content_hash)
            || document.title.trim().is_empty()
            || document.title.len() > 1024
            || document.title.chars().any(char::is_control)
            || !matches!(
                document.availability.as_str(),
                "local" | "remote" | "missing"
            )
            || document.updated_at < 0
            || document.created_at < 0
            || document.updated_at < document.created_at
        {
            return Err("远端文档标识或哈希无效".to_string());
        }
    }
    for asset in assets {
        let (document_id, _) = validate_managed_asset_path(app_data_dir, &asset.relative_path)
            .map_err(|error| error.message)?;
        if !is_sha256(&asset.hash)
            || asset.size > webdav::MAX_SYNC_BLOB_BYTES
            || asset.created_at < 0
            || asset.updated_at < asset.created_at
            || asset.media_type.as_ref().is_some_and(|media_type| {
                media_type.len() > 255 || media_type.chars().any(char::is_control)
            })
            || (!document_ids.contains(document_id.as_str())
                && !document_exists(connection, &document_id)?)
        {
            return Err("远端文档资源标识或路径无效".to_string());
        }
    }
    for version in versions {
        if Uuid::parse_str(&version.id).is_err()
            || Uuid::parse_str(&version.document_id).is_err()
            || !is_sha256(&version.blob_hash)
            || version.size > webdav::MAX_SYNC_BLOB_BYTES
            || version.created_at < 0
            || version
                .device_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
            || (!document_ids.contains(version.document_id.as_str())
                && !document_exists(connection, &version.document_id)?)
        {
            return Err("远端文档版本标识无效".to_string());
        }
    }
    for draft in drafts {
        let document_reference_exists = match draft.document_id.as_deref() {
            Some(id) if document_ids.contains(id) => true,
            Some(id) => document_exists(connection, id)?,
            None => true,
        };
        if Uuid::parse_str(&draft.id).is_err()
            || draft
                .document_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
            || !is_sha256(&draft.blob_hash)
            || Uuid::parse_str(&draft.device_id).is_err()
            || draft
                .title
                .as_ref()
                .is_some_and(|title| title.len() > 1024 || title.chars().any(char::is_control))
            || draft.created_at < 0
            || draft.updated_at < 0
            || draft.updated_at < draft.created_at
            || !document_reference_exists
        {
            return Err("远端草稿标识无效".to_string());
        }
    }

    for document in documents {
        let local_state: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT content_hash,local_path FROM managed_documents WHERE id=?1",
                params![document.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("无法读取本地文档路径: {error}"))?;
        // A local managed file may be open or dirty. Keep it intact when a
        // remote version arrives; the remote version is still retained below
        // and can be explicitly downloaded/recovered by the user.
        if local_state
            .as_ref()
            .is_some_and(|(hash, path)| path.is_some() && hash != &document.content_hash)
        {
            continue;
        }
        let local_path = local_state.and_then(|(_, path)| path);
        let availability = if local_path.is_some() {
            document.availability.as_str()
        } else {
            "remote"
        };
        connection
            .execute(
                "INSERT INTO managed_documents(id,content_hash,title,local_path,availability,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET
                   content_hash=CASE
                     WHEN ?7 > managed_documents.updated_at
                       OR (?7 = managed_documents.updated_at AND ?3 > managed_documents.title)
                     THEN ?2 ELSE managed_documents.content_hash END,
                   title=CASE
                     WHEN ?7 > managed_documents.updated_at
                       OR (?7 = managed_documents.updated_at AND ?3 > managed_documents.title)
                     THEN ?3 ELSE managed_documents.title END,
                   local_path=COALESCE(managed_documents.local_path,?4),availability=CASE
                     WHEN managed_documents.local_path IS NULL THEN ?5 ELSE managed_documents.availability END,
                   updated_at=MAX(managed_documents.updated_at,?7)",
                params![
                    document.id,
                    document.content_hash,
                    document.title,
                    local_path,
                    availability,
                    document.created_at,
                    document.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端文档: {error}"))?;
    }
    for version in versions {
        connection
            .execute(
                "INSERT INTO document_versions(id,document_id,blob_hash,size,device_id,created_at,is_current)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO NOTHING",
                params![
                    version.id,
                    version.document_id,
                    version.blob_hash,
                    version.size as i64,
                    version.device_id,
                    version.created_at,
                    i64::from(version.is_current),
                ],
            )
            .map_err(|error| format!("无法合并远端文档版本: {error}"))?;
    }
    let affected_documents = documents
        .iter()
        .map(|document| document.id.clone())
        .chain(versions.iter().map(|version| version.document_id.clone()))
        .collect::<BTreeSet<_>>();
    reconcile_document_current_versions(connection, &affected_documents)?;
    for draft in drafts {
        connection
            .execute(
                "INSERT INTO document_drafts(id,document_id,blob_hash,title,device_id,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET document_id=?2,blob_hash=?3,title=?4,
                   device_id=?5,created_at=MIN(document_drafts.created_at,?6),updated_at=?7
                 WHERE ?7 > document_drafts.updated_at
                    OR (?7 = document_drafts.updated_at AND (
                      ?3 > document_drafts.blob_hash
                      OR (?3 = document_drafts.blob_hash AND ?5 > document_drafts.device_id)
                      OR (?3 = document_drafts.blob_hash AND ?5 = document_drafts.device_id
                          AND COALESCE(?4,'') > COALESCE(document_drafts.title,''))
                    ))",
                params![
                    draft.id,
                    draft.document_id,
                    draft.blob_hash,
                    draft.title,
                    draft.device_id,
                    draft.created_at,
                    draft.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端草稿: {error}"))?;
    }
    for asset in assets {
        connection
            .execute(
                "INSERT INTO managed_assets(hash,relative_path,size,media_type,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(relative_path) DO UPDATE SET hash=?1,size=?3,media_type=?4,
                   created_at=MIN(managed_assets.created_at,?5),updated_at=?6
                 WHERE ?6 > managed_assets.updated_at
                    OR (?6 = managed_assets.updated_at AND ?1 > managed_assets.hash)",
                params![
                    asset.hash,
                    asset.relative_path,
                    asset.size as i64,
                    asset.media_type,
                    asset.created_at,
                    asset.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端文档资源: {error}"))?;
    }
    Ok(())
}

fn reconcile_document_current_versions(
    connection: &Connection,
    document_ids: &BTreeSet<String>,
) -> Result<(), String> {
    for document_id in document_ids {
        let document: Option<(String, bool)> = connection
            .query_row(
                "SELECT content_hash,local_path IS NOT NULL FROM managed_documents WHERE id=?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|error| format!("无法读取当前文档版本: {error}"))?;
        let Some((content_hash, materialized)) = document else {
            continue;
        };

        // A materialized document may be open with unsaved editor changes.
        // Keep its last local version current until the user explicitly
        // downloads/recovers another version. Remote-only documents converge
        // on the newest deterministically flagged current version.
        let local_version = if materialized {
            connection
                .query_row(
                    "SELECT id,blob_hash,created_at FROM document_versions
                     WHERE document_id=?1 AND blob_hash=?2
                     ORDER BY created_at DESC,id DESC LIMIT 1",
                    params![document_id, content_hash],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("无法读取本地文档版本: {error}"))?
        } else {
            None
        };
        let winner = match local_version {
            Some(version) => Some(version),
            None => connection
                .query_row(
                    "SELECT id,blob_hash,created_at FROM document_versions
                     WHERE document_id=?1
                     ORDER BY created_at DESC,id DESC LIMIT 1",
                    params![document_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("无法选择当前文档版本: {error}"))?,
        };
        let Some((version_id, blob_hash, created_at)) = winner else {
            continue;
        };
        connection
            .execute(
                "UPDATE document_versions SET is_current=(id=?1) WHERE document_id=?2",
                params![version_id, document_id],
            )
            .map_err(|error| format!("无法收敛当前文档版本: {error}"))?;
        connection
            .execute(
                "UPDATE managed_documents
                 SET content_hash=?1,updated_at=MAX(updated_at,?2) WHERE id=?3",
                params![blob_hash, created_at, document_id],
            )
            .map_err(|error| format!("无法更新当前文档正文标识: {error}"))?;
    }
    Ok(())
}

fn apply_current_draft_records(connection: &Connection) -> Result<(), String> {
    for record in current_records_with_prefix(connection, DRAFT_OBJECT_PREFIX, DRAFT_STATE_FIELD)? {
        let draft_id = record
            .object_id
            .strip_prefix(DRAFT_OBJECT_PREFIX)
            .unwrap_or_default();
        if Uuid::parse_str(draft_id).is_err() {
            return Err("同步草稿记录标识无效".to_string());
        }
        if record.tombstone {
            connection
                .execute("DELETE FROM document_drafts WHERE id=?1", params![draft_id])
                .map_err(|error| format!("无法应用同步草稿删除: {error}"))?;
        } else if record.value != Some(Value::Bool(true)) {
            return Err("同步草稿记录值无效".to_string());
        }
    }
    Ok(())
}

fn apply_remote_snapshot(
    connection: &mut Connection,
    app_data_dir: &Path,
    snapshot: &SyncSnapshot,
) -> Result<u64, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启远端快照合并事务: {error}"))?;
    let conflict_count = merge_remote_records_at(&transaction, snapshot.records.clone())?.len();
    apply_snapshot_items(&transaction, &snapshot.items)?;
    apply_snapshot_groups(&transaction, &snapshot.groups, &snapshot.memberships)?;
    apply_snapshot_documents(
        &transaction,
        app_data_dir,
        &snapshot.documents,
        &snapshot.assets,
        &snapshot.document_versions,
        &snapshot.drafts,
    )?;
    apply_current_draft_records(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交远端快照合并: {error}"))?;
    Ok(conflict_count as u64)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn document_exists(connection: &Connection, document_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_documents WHERE id=?1)",
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法校验远端文档引用: {error}"))
}

/// Resolve a stored asset path without allowing a remote snapshot to escape
/// the application data directory. The path also carries the owning document
/// id so assets cannot be attached to an arbitrary directory.
fn validate_managed_asset_path(
    app_data_dir: &Path,
    relative: &str,
) -> Result<(String, PathBuf), WebDavError> {
    let path = safe_app_relative_path(app_data_dir, relative)?;
    let components = relative.split('/').collect::<Vec<_>>();
    if components.len() < 4
        || components[0] != "managed-documents"
        || components[2] != "assets"
        || components[3..].iter().any(|part| part.is_empty())
        || components[3..]
            .iter()
            .any(|part| *part == "." || *part == "..")
        || Uuid::parse_str(components[1]).is_err()
    {
        return Err(WebDavError::new(
            "SYNC_PATH_INVALID",
            "受管文档资源路径无效",
        ));
    }
    Ok((components[1].to_string(), path))
}

fn safe_app_relative_path(
    app_data: &std::path::Path,
    relative: &str,
) -> Result<PathBuf, WebDavError> {
    let path = std::path::Path::new(relative);
    if path.is_absolute()
        || relative.is_empty()
        || relative.chars().any(char::is_control)
        || relative.contains('\\')
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(WebDavError::new("SYNC_PATH_INVALID", "本地资源路径无效"));
    }
    let target = app_data.join(path);
    if !target.starts_with(app_data) {
        return Err(WebDavError::new(
            "SYNC_PATH_INVALID",
            "本地资源路径越出应用目录",
        ));
    }
    Ok(target)
}

async fn upload_local_blobs(
    connection: &mut Connection,
    app_data_dir: &std::path::Path,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let rows = {
        let mut statement = connection
            .prepare("SELECT hash,size FROM managed_blobs ORDER BY hash")
            .map_err(|error| {
                WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取受管正文: {error}"))
            })?;
        let mapped = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| {
                WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取受管正文: {error}"))
            })?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };
    let mut uploaded = 0_u64;
    let mut prefixes = BTreeSet::new();
    for (hash, size) in rows {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        if size < 0 || size as u64 > webdav::MAX_SYNC_BLOB_BYTES {
            return Err(WebDavError::new(
                "SYNC_BLOB_TOO_LARGE",
                "本地受管正文大小无效或超过限制",
            ));
        }
        let path = managed::managed_blob_path(connection, app_data_dir, &hash)
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
        if !path.is_file() {
            continue;
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| WebDavError::new("SYNC_STORAGE_ERROR", "无法读取受管正文"))?;
        if bytes.len() as i64 != size {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "本地受管正文大小不一致",
            ));
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != hash {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "本地受管正文 SHA-256 校验失败",
            ));
        }
        ensure_blob_prefix(client, &hash, &mut prefixes).await?;
        let remote_path = webdav::remote_blob_path(&hash)?;
        client.put_bytes(&remote_path, &bytes, true).await?;
        uploaded = uploaded.saturating_add(1);
    }
    Ok(uploaded)
}

async fn upload_document_blobs(
    connection: &mut Connection,
    app_data_dir: &std::path::Path,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let mut candidates: BTreeMap<String, PathBuf> = BTreeMap::new();
    let document_hashes = {
        let mut statement = connection
            .prepare("SELECT content_hash FROM managed_documents")
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        let mapped = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };
    for hash in document_hashes {
        candidates.insert(
            hash.clone(),
            documents::document_blob_path(app_data_dir, &hash)
                .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?,
        );
    }
    let hashes = {
        let mut statement = connection
            .prepare(
                "SELECT blob_hash FROM document_versions UNION SELECT blob_hash FROM document_drafts",
            )
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        let mapped = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };
    for hash in hashes {
        candidates.insert(
            hash.clone(),
            documents::document_blob_path(app_data_dir, &hash)
                .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?,
        );
    }
    let assets = {
        let mut statement = connection
            .prepare("SELECT hash,relative_path,size FROM managed_assets")
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };
    for (hash, relative, size) in assets {
        let (_, path) = validate_managed_asset_path(app_data_dir, &relative)?;
        if size < 0 {
            return Err(WebDavError::new("SYNC_STORAGE_ERROR", "文档资源大小无效"));
        }
        match candidates.get_mut(&hash) {
            Some(candidate) if !candidate.is_file() && path.is_file() => *candidate = path,
            Some(_) => {}
            None => {
                candidates.insert(hash, path);
            }
        }
    }
    let mut uploaded = 0_u64;
    let mut prefixes = BTreeSet::new();
    for (hash, path) in candidates {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        if !is_sha256(&hash) || !path.is_file() {
            continue;
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| WebDavError::new("SYNC_STORAGE_ERROR", "无法读取文档资源"))?;
        if bytes.len() as u64 > webdav::MAX_SYNC_BLOB_BYTES {
            return Err(WebDavError::new(
                "SYNC_BLOB_TOO_LARGE",
                "文档资源超过大小限制",
            ));
        }
        let actual = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != hash {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "本地文档资源 SHA-256 校验失败",
            ));
        }
        ensure_blob_prefix(client, &hash, &mut prefixes).await?;
        client
            .put_bytes(&webdav::remote_blob_path(&hash)?, &bytes, true)
            .await?;
        uploaded = uploaded.saturating_add(1);
    }
    Ok(uploaded)
}

/// Materialize pinned managed books after metadata from every device has been
/// merged. Bodies remain lazy by default; only an explicit offline pin causes a
/// verified blob download during the next sync.
async fn download_pinned_books(
    connection: &mut Connection,
    app_data_dir: &std::path::Path,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT id,blob_hash,size,extension
                 FROM library_items
                 WHERE source_kind='managed' AND offline_pinned=1 AND blob_hash IS NOT NULL
                 ORDER BY id",
            )
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        let mapped = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?.map(|size| size.max(0) as u64),
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };

    let mut downloaded = 0_u64;
    for (item_id, hash, size, extension) in rows {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let path = managed::managed_blob_path_for_extension(
            connection,
            app_data_dir,
            &hash,
            extension.as_deref(),
        )
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
        let valid_local = if path.is_file() {
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    let actual = Sha256::digest(&bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    actual == hash && size.is_none_or(|expected| bytes.len() as u64 == expected)
                }
                Err(_) => false,
            }
        } else {
            false
        };
        if !valid_local {
            let remote_path = webdav::remote_blob_path(&hash)?;
            client
                .download_verified(&remote_path, &path, &hash, size, Some(token))
                .await?;
            downloaded = downloaded.saturating_add(1);
        }
        let actual_size = tokio::fs::metadata(&path)
            .await
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
            .len();
        let registered = managed::register_downloaded_blob_at(
            connection,
            app_data_dir,
            &hash,
            &path,
            actual_size,
        )
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
        connection
            .execute(
                "UPDATE library_items
                 SET local_path=?1,availability='local',updated_at=?2 WHERE id=?3",
                params![
                    registered.to_string_lossy().into_owned(),
                    library::now_ms(),
                    item_id
                ],
            )
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    }
    Ok(downloaded)
}

async fn download_document_assets(
    connection: &mut Connection,
    app_data_dir: &Path,
    client: &webdav::WebDavClient,
    document_id: &str,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let prefix = format!("managed-documents/{document_id}/assets/");
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT hash,relative_path,size FROM managed_assets
                 WHERE relative_path LIKE ?1 ORDER BY relative_path",
            )
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        let mapped = statement
            .query_map(params![format!("{prefix}%")], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
    };

    let mut downloaded = 0_u64;
    for (hash, relative_path, size) in rows {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let (owner, path) = validate_managed_asset_path(app_data_dir, &relative_path)?;
        if owner != document_id || !is_sha256(&hash) || size < 0 {
            return Err(WebDavError::new("SYNC_PATH_INVALID", "文档资源记录无效"));
        }
        let size = size as u64;
        if size > webdav::MAX_SYNC_BLOB_BYTES {
            return Err(WebDavError::new(
                "SYNC_BLOB_TOO_LARGE",
                "文档资源超过大小限制",
            ));
        }

        // A prior partial run may have left a file behind. Reuse it only after
        // checking both size and content hash; otherwise download atomically.
        let valid_local = if path.is_file() {
            match tokio::fs::read(&path).await {
                Ok(bytes) if bytes.len() as u64 == size => {
                    let actual = Sha256::digest(&bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    actual == hash
                }
                _ => false,
            }
        } else {
            false
        };
        if !valid_local {
            let remote_path = webdav::remote_blob_path(&hash)?;
            client
                .download_verified(&remote_path, &path, &hash, Some(size), Some(token))
                .await?;
            downloaded = downloaded.saturating_add(1);
        }
    }
    Ok(downloaded)
}

async fn sync_once(
    app: &AppHandle,
    webdav_state: &WebDavState,
    token: &CancellationToken,
) -> Result<SyncStatus, WebDavError> {
    let (profile, client) = webdav::active_profile_client(app, webdav_state)?;
    ensure_sync_capabilities(&client).await?;
    ensure_remote_layout(&client).await?;
    upload_profile_descriptor(&profile, &client, token).await?;
    let app_data = library::app_data_dir(app)
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let mut connection = library::open_database_at(&app_data)
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let device =
        device_id(&connection).map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let uploaded_books = upload_local_blobs(&mut connection, &app_data, &client, token).await?;
    let uploaded_documents =
        upload_document_blobs(&mut connection, &app_data, &client, token).await?;
    let remote = read_remote_snapshots(&client, &device, token).await?;
    let mut conflicts = 0_u64;
    for snapshot in &remote {
        conflicts = conflicts.saturating_add(
            apply_remote_snapshot(&mut connection, &app_data, snapshot)
                .map_err(|error| WebDavError::new("SYNC_MERGE_ERROR", error))?,
        );
    }
    backfill_group_records(&connection)
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let downloaded_books =
        download_pinned_books(&mut connection, &app_data, &client, token).await?;
    let snapshot = local_snapshot(&connection, device.clone())
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let _ = cleanup_unreferenced_blobs(&mut connection, &client, &snapshot, &remote, token).await?;
    let body = serde_json::to_vec(&snapshot).map_err(|error| {
        WebDavError::new(
            "SYNC_SNAPSHOT_INVALID",
            format!("无法序列化同步快照: {error}"),
        )
    })?;
    let path = webdav::remote_state_path(&format!("{device}.json"))?;
    client.put_atomic(&path, &body, Some(token)).await?;
    Ok(SyncStatus {
        state: SyncRunState::Success,
        started_at: None,
        finished_at: Some(library::now_ms()),
        last_error: None,
        uploaded: uploaded_books.saturating_add(uploaded_documents),
        downloaded: downloaded_books,
        conflicts,
    })
}

#[tauri::command]
pub fn sync_status(state: State<'_, SyncTaskState>) -> Result<SyncStatus, String> {
    status_snapshot(state.inner())
}

#[tauri::command]
pub async fn sync_run(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    state: State<'_, SyncTaskState>,
) -> Result<SyncStatus, String> {
    let (task_id, token) = start_task(state.inner())?;
    let result = sync_once(&app, webdav_state.inner(), &token).await;
    match result {
        Ok(status) => {
            finish_task(state.inner(), &task_id, &Ok(status.clone()));
            Ok(status)
        }
        Err(error) => {
            finish_task(state.inner(), &task_id, &Err(error.clone()));
            Err(error.message)
        }
    }
}

#[tauri::command]
pub fn sync_cancel(state: State<'_, SyncTaskState>) -> Result<(), String> {
    let task = state
        .task
        .lock()
        .map_err(|_| "同步任务状态不可用".to_string())?;
    if let Some((_, token)) = task.as_ref() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_download_book(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    item_id: String,
) -> Result<String, String> {
    let (_, client) =
        webdav::active_profile_client(&app, webdav_state.inner()).map_err(|error| error.message)?;
    let app_data = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data)?;
    let resolved_id = connection
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析待下载书籍标识: {error}"))?
        .unwrap_or(item_id);
    let (hash, size, extension): (String, Option<u64>, Option<String>) = connection
        .query_row(
            "SELECT id,blob_hash,size,extension FROM library_items
             WHERE id=?1 AND blob_hash IS NOT NULL",
            params![resolved_id],
            |row| {
                Ok((
                    row.get(1)?,
                    row.get::<_, Option<i64>>(2)?
                        .map(|value| value.max(0) as u64),
                    row.get(3)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取待下载书籍: {error}"))?;
    let path = managed::managed_blob_path_for_extension(
        &connection,
        &app_data,
        &hash,
        extension.as_deref(),
    )?;
    let token = CancellationToken::new();
    let valid_local = if path.is_file() {
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let actual = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                actual == hash && size.is_none_or(|expected| bytes.len() as u64 == expected)
            }
            Err(_) => false,
        }
    } else {
        false
    };
    if !valid_local {
        let remote_path = webdav::remote_blob_path(&hash).map_err(|error| error.message)?;
        client
            .download_verified(&remote_path, &path, &hash, size, Some(&token))
            .await
            .map_err(|error| error.message)?;
    }
    let actual_size = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("无法读取下载书籍大小: {error}"))?
        .len();
    managed::register_downloaded_blob_at(&connection, &app_data, &hash, &path, actual_size)?;
    connection
        .execute(
            "UPDATE library_items SET local_path=?1,availability='local',updated_at=?2 WHERE id=?3",
            params![path.to_string_lossy(), library::now_ms(), resolved_id],
        )
        .map_err(|error| format!("无法更新下载书籍状态: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_download_document(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    document_id: String,
) -> Result<String, String> {
    let (_, client) =
        webdav::active_profile_client(&app, webdav_state.inner()).map_err(|error| error.message)?;
    if Uuid::parse_str(&document_id).is_err() {
        return Err("文档标识无效".to_string());
    }
    let app_data = library::app_data_dir(&app)?;
    let mut connection = library::open_database_at(&app_data)?;
    let (hash, size, local_path): (String, Option<u64>, Option<String>) = connection
        .query_row(
            "SELECT d.content_hash,
                    (SELECT size FROM document_versions v
                     WHERE v.document_id=d.id AND v.blob_hash=d.content_hash
                     ORDER BY v.created_at DESC LIMIT 1),
                    d.local_path
             FROM managed_documents d WHERE d.id=?1",
            params![document_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<i64>>(1)?
                        .map(|value| value.max(0) as u64),
                    row.get(2)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取待下载文档: {error}"))?;
    let path = local_path.map(PathBuf::from).unwrap_or_else(|| {
        app_data
            .join("managed-documents")
            .join(&document_id)
            .join("document.md")
    });
    if path.is_file() {
        let existing = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("无法读取现有文档正文: {error}"))?;
        let existing_hash = Sha256::digest(&existing)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if existing_hash != hash {
            return Err("文档存在未保存或未同步修改，请先处理冲突".to_string());
        }
    }
    let blob = documents::document_blob_path(&app_data, &hash)?;
    let token = CancellationToken::new();
    let remote_path = webdav::remote_blob_path(&hash).map_err(|error| error.message)?;
    let valid_blob = if blob.is_file() {
        match tokio::fs::read(&blob).await {
            Ok(bytes) => {
                let actual = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                actual == hash && size.is_none_or(|expected| bytes.len() as u64 == expected)
            }
            Err(_) => false,
        }
    } else {
        false
    };
    if !valid_blob {
        client
            .download_verified(&remote_path, &blob, &hash, size, Some(&token))
            .await
            .map_err(|error| error.message)?;
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("无法创建文档目录: {error}"))?;
    }
    let content = tokio::fs::read_to_string(&blob)
        .await
        .map_err(|error| format!("无法读取已校验的文档正文: {error}"))?;
    write_file_impl(&path, &content)?;
    download_document_assets(&mut connection, &app_data, &client, &document_id, &token)
        .await
        .map_err(|error| error.message)?;
    connection
        .execute(
            "UPDATE managed_documents SET local_path=?1,availability='local',updated_at=?2 WHERE id=?3",
            params![path.to_string_lossy(), library::now_ms(), document_id],
        )
        .map_err(|error| format!("无法更新文档状态: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_download_draft(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    draft_id: String,
) -> Result<String, String> {
    if Uuid::parse_str(&draft_id).is_err() {
        return Err("草稿标识无效".to_string());
    }
    let (_, client) =
        webdav::active_profile_client(&app, webdav_state.inner()).map_err(|error| error.message)?;
    let app_data = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data)?;
    let hash: String = connection
        .query_row(
            "SELECT blob_hash FROM document_drafts WHERE id=?1",
            params![draft_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取待下载草稿: {error}"))?;
    drop(connection);
    if !is_sha256(&hash) {
        return Err("草稿正文哈希无效".to_string());
    }
    let path = documents::document_blob_path(&app_data, &hash)?;
    let valid_local = if path.is_file() {
        match tokio::fs::read(&path).await {
            Ok(bytes) => format!("{:x}", Sha256::digest(&bytes)) == hash,
            Err(_) => false,
        }
    } else {
        false
    };
    if !valid_local {
        let remote_path = webdav::remote_blob_path(&hash).map_err(|error| error.message)?;
        let token = CancellationToken::new();
        client
            .download_verified(&remote_path, &path, &hash, None, Some(&token))
            .await
            .map_err(|error| error.message)?;
    }
    tokio::fs::read_to_string(path)
        .await
        .map_err(|error| format!("无法读取草稿正文: {error}"))
}

pub(crate) fn list_conflicts_at(
    connection: &Connection,
    include_resolved: bool,
) -> Result<Vec<SyncConflict>, String> {
    let where_clause = if include_resolved {
        ""
    } else {
        "WHERE resolved_at IS NULL"
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT id,object_id,field,winner_json,loser_json,winner_device_id,loser_device_id,created_at,resolved_at
             FROM sync_conflicts {where_clause} ORDER BY created_at DESC,id"
        ))
        .map_err(|error| format!("无法读取同步冲突: {error}"))?;
    let conflicts = statement
        .query_map([], |row| {
            Ok(SyncConflict {
                id: row.get(0)?,
                object_id: row.get(1)?,
                field: row.get(2)?,
                winner: parse_value(row.get(3)?)?,
                loser: parse_value(row.get(4)?)?,
                winner_device_id: row.get(5)?,
                loser_device_id: row.get(6)?,
                created_at: row.get(7)?,
                resolved_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("无法读取同步冲突: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步冲突: {error}"))?;
    Ok(conflicts)
}

#[tauri::command]
pub fn sync_device_id(app: AppHandle) -> Result<String, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    device_id(&connection)
}

#[tauri::command]
pub fn sync_list_records(app: AppHandle) -> Result<Vec<SyncRecord>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    list_records_at(&connection)
}

#[tauri::command]
pub fn sync_write_record(
    app: AppHandle,
    object_id: String,
    field: String,
    value: Option<Value>,
    tombstone: Option<bool>,
) -> Result<SyncRecord, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    write_local_record_at(
        &connection,
        object_id,
        field,
        value,
        tombstone.unwrap_or(false),
    )
}

#[tauri::command]
pub fn sync_list_conflicts(
    app: AppHandle,
    include_resolved: Option<bool>,
) -> Result<Vec<SyncConflict>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    list_conflicts_at(&connection, include_resolved.unwrap_or(false))
}

#[tauri::command]
pub fn sync_resolve_conflict(app: AppHandle, conflict_id: String) -> Result<(), String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let changed = connection
        .execute(
            "UPDATE sync_conflicts SET resolved_at=?1 WHERE id=?2 AND resolved_at IS NULL",
            params![library::now_ms(), conflict_id],
        )
        .map_err(|error| format!("无法处理同步冲突: {error}"))?;
    if changed == 0 {
        return Err("同步冲突不存在或已处理".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(device_id: &str, version: u64, context: &[(&str, u64)]) -> VersionPoint {
        VersionPoint {
            device_id: device_id.into(),
            version,
            context: context
                .iter()
                .map(|(id, version)| ((*id).to_string(), *version))
                .collect(),
            modified_at: 100,
        }
    }

    fn record(device: &str, version: u64, context: &[(&str, u64)], value: Value) -> SyncRecord {
        SyncRecord {
            record_id: format!("r-{device}-{version}"),
            object_id: "book:one".into(),
            field: "progress".into(),
            value: Some(value),
            point: point(device, version, context),
            tombstone: false,
        }
    }

    #[test]
    fn causal_order_distinguishes_before_after_and_concurrency() {
        let first = point("a", 1, &[]);
        let later = point("a", 2, &[]);
        let concurrent = point("b", 1, &[]);
        assert_eq!(
            compare_version_points(&later, &first),
            CausalOrder::Dominates
        );
        assert_eq!(
            compare_version_points(&first, &later),
            CausalOrder::IsDominated
        );
        assert_eq!(
            compare_version_points(&first, &concurrent),
            CausalOrder::Concurrent
        );
    }

    #[test]
    fn concurrent_same_field_keeps_deterministic_winner_and_conflict() {
        let mut left = record("a", 1, &[], serde_json::json!({"chapter": 2}));
        let mut right = record("b", 1, &[], serde_json::json!({"chapter": 3}));
        left.point.modified_at = 20;
        right.point.modified_at = 21;
        let merged = merge_record_pair(&left, &right).unwrap();
        assert_eq!(merged.record.value, right.value);
        assert_eq!(merged.conflict.as_ref().unwrap().loser, left.value);
        assert_eq!(merged.record.point.context.get("a"), Some(&1));
    }

    #[test]
    fn later_write_dominates_observed_concurrent_values() {
        let left = record("a", 1, &[], serde_json::json!(1));
        let right = record("b", 1, &[], serde_json::json!(2));
        let merged = merge_record_pair(&left, &right).unwrap().record;
        let later = SyncRecord {
            record_id: "r-a-2".into(),
            object_id: "book:one".into(),
            field: "progress".into(),
            value: Some(serde_json::json!(3)),
            point: point("a", 2, &[("b", 1)]),
            tombstone: false,
        };
        assert_eq!(
            compare_version_points(&later.point, &merged.point),
            CausalOrder::Dominates
        );
    }

    #[test]
    fn tombstone_is_a_real_value_for_concurrent_conflicts() {
        let left = record("a", 1, &[], serde_json::json!("present"));
        let mut right = record("b", 1, &[], serde_json::json!("ignored"));
        right.value = None;
        right.tombstone = true;
        assert!(merge_record_pair(&left, &right).unwrap().conflict.is_some());
    }

    #[test]
    fn group_and_membership_tombstones_override_a_stale_full_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(id,source_kind,title,authors_json,updated_at)
                 VALUES ('managed:book','managed','Book','[]',1)",
                [],
            )
            .unwrap();
        let group_id = "11111111-1111-4111-8111-111111111111";
        let group = SnapshotGroup {
            id: group_id.into(),
            parent_id: None,
            name: "Shelf".into(),
            kind: "custom".into(),
            rule: None,
            sort_order: 0,
        };
        let active_group = write_group_state_record_at(
            &connection,
            group_id,
            Some(serde_json::to_value(&group).unwrap()),
        )
        .unwrap();
        let active_member =
            write_membership_record_at(&connection, group_id, "managed:book", true).unwrap();
        let remote_device = "22222222-2222-4222-8222-222222222222";
        merge_remote_records_at(
            &connection,
            vec![
                SyncRecord {
                    record_id: "remote-group-delete".into(),
                    object_id: format!("{GROUP_OBJECT_PREFIX}{group_id}"),
                    field: GROUP_STATE_FIELD.into(),
                    value: None,
                    point: VersionPoint {
                        device_id: remote_device.into(),
                        version: 1,
                        context: BTreeMap::from([(
                            active_group.point.device_id.clone(),
                            active_group.point.version,
                        )]),
                        modified_at: active_group.point.modified_at + 1,
                    },
                    tombstone: true,
                },
                SyncRecord {
                    record_id: "remote-member-delete".into(),
                    object_id: format!("{MEMBERSHIP_OBJECT_PREFIX}{group_id}:managed:book"),
                    field: MEMBERSHIP_STATE_FIELD.into(),
                    value: None,
                    point: VersionPoint {
                        device_id: remote_device.into(),
                        version: 2,
                        context: BTreeMap::from([(
                            active_member.point.device_id.clone(),
                            active_member.point.version,
                        )]),
                        modified_at: active_member.point.modified_at + 1,
                    },
                    tombstone: true,
                },
            ],
        )
        .unwrap();
        apply_snapshot_groups(
            &connection,
            std::slice::from_ref(&group),
            &[SnapshotMembership {
                group_id: group_id.into(),
                item_id: "managed:book".into(),
            }],
        )
        .unwrap();

        let groups: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM library_groups WHERE id=?1",
                params![group_id],
                |row| row.get(0),
            )
            .unwrap();
        let members: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM library_group_members WHERE group_id=?1",
                params![group_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((groups, members), (0, 0));
    }

    #[test]
    fn invalid_remote_snapshot_rolls_back_records_and_library_rows() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        let remote_device = "22222222-2222-4222-8222-222222222222";
        let hash = "a".repeat(64);
        let snapshot = SyncSnapshot {
            schema: 1,
            device_id: remote_device.into(),
            generated_at: 1,
            records: vec![SyncRecord {
                record_id: "remote-record".into(),
                object_id: "app-state".into(),
                field: "lightink.locale".into(),
                value: Some(Value::String("zh-CN".into())),
                point: VersionPoint {
                    device_id: remote_device.into(),
                    version: 1,
                    context: BTreeMap::new(),
                    modified_at: 1,
                },
                tombstone: false,
            }],
            items: vec![SnapshotItem {
                id: format!("managed:{hash}"),
                source_id: None,
                source_kind: "managed".into(),
                title: "Remote book".into(),
                authors: Vec::new(),
                cover_url: None,
                acquisition_url: None,
                media_type: Some("application/epub+zip".into()),
                extension: Some("epub".into()),
                size: Some(3),
                etag: None,
                last_modified: None,
                series: None,
                number: None,
                volume: None,
                page_count: None,
                reading_direction: None,
                cover_page: None,
                blob_hash: Some(hash),
                availability: "local".into(),
                offline_pinned: false,
                subjects: Vec::new(),
                updated_at: 1,
            }],
            groups: Vec::new(),
            memberships: Vec::new(),
            documents: vec![SnapshotDocument {
                id: "11111111-1111-4111-8111-111111111111".into(),
                content_hash: "not-a-sha256".into(),
                title: "Broken".into(),
                availability: "remote".into(),
                created_at: 1,
                updated_at: 1,
            }],
            assets: Vec::new(),
            document_versions: Vec::new(),
            drafts: Vec::new(),
        };

        assert!(apply_remote_snapshot(&mut connection, directory.path(), &snapshot).is_err());
        let item_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        let record_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!((item_count, record_count), (0, 0));
    }

    #[test]
    fn concurrent_document_currents_converge_to_one_version() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        let document_id = "11111111-1111-4111-8111-111111111111";
        let older_hash = "a".repeat(64);
        let newer_hash = "b".repeat(64);
        apply_snapshot_documents(
            &connection,
            directory.path(),
            &[SnapshotDocument {
                id: document_id.into(),
                content_hash: newer_hash.clone(),
                title: "Synced".into(),
                availability: "remote".into(),
                created_at: 1,
                updated_at: 20,
            }],
            &[],
            &[
                SnapshotDocumentVersion {
                    id: "22222222-2222-4222-8222-222222222222".into(),
                    document_id: document_id.into(),
                    blob_hash: older_hash,
                    size: 1,
                    device_id: None,
                    created_at: 10,
                    is_current: true,
                },
                SnapshotDocumentVersion {
                    id: "33333333-3333-4333-8333-333333333333".into(),
                    document_id: document_id.into(),
                    blob_hash: newer_hash.clone(),
                    size: 1,
                    device_id: None,
                    created_at: 20,
                    is_current: true,
                },
            ],
            &[],
        )
        .unwrap();

        let current: Vec<(String, String)> = connection
            .prepare(
                "SELECT id,blob_hash FROM document_versions
                 WHERE document_id=?1 AND is_current=1",
            )
            .unwrap()
            .query_map(params![document_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let document_hash: String = connection
            .query_row(
                "SELECT content_hash FROM managed_documents WHERE id=?1",
                params![document_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].1, newer_hash);
        assert_eq!(document_hash, newer_hash);
    }

    #[test]
    fn document_version_winner_does_not_depend_on_snapshot_order() {
        fn apply_version(
            connection: &Connection,
            app_data: &Path,
            document_id: &str,
            version_id: &str,
            hash: &str,
            title: &str,
            timestamp: i64,
        ) {
            apply_snapshot_documents(
                connection,
                app_data,
                &[SnapshotDocument {
                    id: document_id.into(),
                    content_hash: hash.into(),
                    title: title.into(),
                    availability: "remote".into(),
                    created_at: 1,
                    updated_at: timestamp,
                }],
                &[],
                &[SnapshotDocumentVersion {
                    id: version_id.into(),
                    document_id: document_id.into(),
                    blob_hash: hash.into(),
                    size: 1,
                    device_id: None,
                    created_at: timestamp,
                    is_current: true,
                }],
                &[],
            )
            .unwrap();
        }

        let document_id = "11111111-1111-4111-8111-111111111111";
        let older_id = "22222222-2222-4222-8222-222222222222";
        let newer_id = "33333333-3333-4333-8333-333333333333";
        let older_hash = "a".repeat(64);
        let newer_hash = "b".repeat(64);
        let mut results = Vec::new();
        for newer_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let connection = library::open_database_at(directory.path()).unwrap();
            let versions = if newer_first {
                [
                    (newer_id, newer_hash.as_str(), "Newer", 20),
                    (older_id, older_hash.as_str(), "Older", 10),
                ]
            } else {
                [
                    (older_id, older_hash.as_str(), "Older", 10),
                    (newer_id, newer_hash.as_str(), "Newer", 20),
                ]
            };
            for (version_id, hash, title, timestamp) in versions {
                apply_version(
                    &connection,
                    directory.path(),
                    document_id,
                    version_id,
                    hash,
                    title,
                    timestamp,
                );
            }
            results.push(
                connection
                    .query_row(
                        "SELECT d.content_hash,d.title,v.id
                         FROM managed_documents d
                         JOIN document_versions v ON v.document_id=d.id AND v.is_current=1
                         WHERE d.id=?1",
                        params![document_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .unwrap(),
            );
        }
        assert_eq!(results[0], results[1]);
        assert_eq!(results[0], (newer_hash, "Newer".into(), newer_id.into()));
    }

    #[test]
    fn materialized_document_keeps_its_local_current_version() {
        let directory = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(directory.path()).unwrap();
        let document_id = "11111111-1111-4111-8111-111111111111";
        let local_hash = "a".repeat(64);
        let remote_hash = "b".repeat(64);
        connection
            .execute(
                "INSERT INTO managed_documents(
                   id,content_hash,title,local_path,availability,created_at,updated_at
                 ) VALUES (?1,?2,'Local','/managed/document.md','local',1,10)",
                params![document_id, local_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO document_versions(
                   id,document_id,blob_hash,size,device_id,created_at,is_current
                 ) VALUES ('22222222-2222-4222-8222-222222222222',?1,?2,1,NULL,10,1)",
                params![document_id, local_hash],
            )
            .unwrap();

        apply_snapshot_documents(
            &connection,
            directory.path(),
            &[SnapshotDocument {
                id: document_id.into(),
                content_hash: remote_hash.clone(),
                title: "Remote".into(),
                availability: "remote".into(),
                created_at: 1,
                updated_at: 20,
            }],
            &[],
            &[SnapshotDocumentVersion {
                id: "33333333-3333-4333-8333-333333333333".into(),
                document_id: document_id.into(),
                blob_hash: remote_hash,
                size: 1,
                device_id: None,
                created_at: 20,
                is_current: true,
            }],
            &[],
        )
        .unwrap();

        let current_hash: String = connection
            .query_row(
                "SELECT blob_hash FROM document_versions
                 WHERE document_id=?1 AND is_current=1",
                params![document_id],
                |row| row.get(0),
            )
            .unwrap();
        let document_hash: String = connection
            .query_row(
                "SELECT content_hash FROM managed_documents WHERE id=?1",
                params![document_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current_hash, local_hash);
        assert_eq!(document_hash, local_hash);
    }

    #[test]
    fn merged_group_edges_are_bounded_to_eight_levels() {
        let edges = (0..9)
            .map(|index| GroupParentEdge {
                group_id: format!("g-{index}"),
                parent_id: (index < 8).then(|| format!("g-{}", index + 1)),
                point: point("a", index as u64 + 1, &[]),
            })
            .collect();
        let resolved = resolve_group_parent_constraints(edges);
        let lookup = resolved
            .iter()
            .map(|edge| (edge.group_id.as_str(), edge.parent_id.as_deref()))
            .collect::<HashMap<_, _>>();
        let mut depth = 0;
        let mut current = Some("g-0");
        while let Some(group) = current {
            depth += 1;
            current = lookup.get(group).copied().flatten();
        }
        assert!(depth <= crate::groups::MAX_GROUP_DEPTH);
    }

    #[test]
    fn group_cycles_drop_the_deterministically_oldest_parent_edge() {
        let mut oldest = point("a", 1, &[]);
        oldest.modified_at = 10;
        let mut newest = point("b", 1, &[]);
        newest.modified_at = 20;
        let resolved = resolve_group_parent_cycles(vec![
            GroupParentEdge {
                group_id: "a".into(),
                parent_id: Some("b".into()),
                point: oldest,
            },
            GroupParentEdge {
                group_id: "b".into(),
                parent_id: Some("a".into()),
                point: newest,
            },
        ]);
        assert_eq!(resolved[0].parent_id, None);
        assert_eq!(resolved[1].parent_id.as_deref(), Some("a"));
    }
}
