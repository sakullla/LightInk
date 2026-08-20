//! Persistent custom shelf groups and their many-to-many book memberships.

use crate::{library, sync};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::AppHandle;

pub const MAX_GROUP_DEPTH: usize = 8;
const MAX_GROUP_NAME_CHARS: usize = 80;

pub(crate) fn ensure_smart_groups(connection: &Connection) -> Result<(), String> {
    let presets = [
        (
            "smart:in-progress",
            "在读",
            r#"{"type":"progress","value":"in-progress"}"#,
            0_i64,
        ),
        (
            "smart:unread",
            "未读",
            r#"{"type":"progress","value":"unread"}"#,
            1,
        ),
        (
            "smart:text",
            "文字书",
            r#"{"type":"kind","value":"text"}"#,
            2,
        ),
        (
            "smart:comic",
            "漫画",
            r#"{"type":"kind","value":"comic"}"#,
            3,
        ),
        (
            "smart:managed",
            "受管书籍",
            r#"{"type":"source","value":"managed"}"#,
            4,
        ),
        (
            "smart:remote",
            "远程书籍",
            r#"{"type":"source","value":"remote"}"#,
            5,
        ),
        (
            "smart:epub",
            "EPUB",
            r#"{"type":"format","value":"epub"}"#,
            6,
        ),
        ("smart:pdf", "PDF", r#"{"type":"format","value":"pdf"}"#, 7),
    ];
    let now = library::now_ms();
    for (id, name, rule, sort_order) in presets {
        connection
            .execute(
                "INSERT INTO library_groups(
                   id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at
                 ) VALUES (?1,NULL,?2,'smart',?3,?4,?5,?5)
                 ON CONFLICT(id) DO UPDATE SET parent_id=NULL,name=?2,kind='smart',rule_json=?3,
                   sort_order=?4,updated_at=?5",
                params![id, name, rule, sort_order, now],
            )
            .map_err(|error| format!("无法初始化智能分组: {error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroup {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<serde_json::Value>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroupMembership {
    pub group_id: String,
    pub item_id: String,
}

fn validate_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_GROUP_NAME_CHARS {
        return Err(format!(
            "分组名称长度必须为 1 至 {MAX_GROUP_NAME_CHARS} 个字符"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("分组名称不能包含控制字符".to_string());
    }
    Ok(name.to_string())
}

fn read_group(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryGroup> {
    let rule_json: Option<String> = row.get(4)?;
    Ok(LibraryGroup {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        rule: rule_json.and_then(|value| serde_json::from_str(&value).ok()),
        sort_order: row.get(5)?,
    })
}

fn group_at(connection: &Connection, group_id: &str) -> Result<LibraryGroup, String> {
    connection
        .query_row(
            "SELECT id,parent_id,name,kind,rule_json,sort_order
             FROM library_groups WHERE id=?1",
            params![group_id],
            read_group,
        )
        .optional()
        .map_err(|error| format!("无法读取分组: {error}"))?
        .ok_or_else(|| "分组不存在".to_string())
}

fn write_group_sync_record(connection: &Connection, group: &LibraryGroup) -> Result<(), String> {
    let value =
        serde_json::to_value(group).map_err(|error| format!("无法序列化分组同步状态: {error}"))?;
    sync::write_group_state_record_at(connection, &group.id, Some(value)).map(|_| ())
}

fn parent_depth_and_cycle(
    connection: &Connection,
    parent_id: Option<&str>,
    moving_id: Option<&str>,
) -> Result<usize, String> {
    let mut current = parent_id.map(str::to_string);
    let mut depth = 0_usize;
    let mut seen = HashSet::new();
    while let Some(group_id) = current {
        if Some(group_id.as_str()) == moving_id {
            return Err("分组不能移动到自身或后代中".to_string());
        }
        if !seen.insert(group_id.clone()) {
            return Err("现有分组树包含循环".to_string());
        }
        let (parent, kind): (Option<String>, String) = connection
            .query_row(
                "SELECT parent_id,kind FROM library_groups WHERE id=?1",
                params![group_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("无法检查父分组: {error}"))?
            .ok_or_else(|| "父分组不存在".to_string())?;
        if kind != "custom" {
            return Err("自定义组不能嵌套在智能组下".to_string());
        }
        depth += 1;
        if depth >= MAX_GROUP_DEPTH && parent.is_some() {
            return Err(format!("分组最多允许 {MAX_GROUP_DEPTH} 层"));
        }
        current = parent;
    }
    Ok(depth)
}

fn subtree_height(connection: &Connection, group_id: &str) -> Result<usize, String> {
    connection
        .query_row(
            "WITH RECURSIVE descendants(id,depth) AS (
               SELECT id,1 FROM library_groups WHERE id=?1
               UNION ALL
               SELECT child.id,descendants.depth+1
               FROM library_groups child JOIN descendants ON child.parent_id=descendants.id
               WHERE descendants.depth <= ?2
             ) SELECT COALESCE(MAX(depth),0) FROM descendants",
            params![group_id, MAX_GROUP_DEPTH as i64 + 1],
            |row| row.get::<_, i64>(0),
        )
        .map(|height| height.max(1) as usize)
        .map_err(|error| format!("无法检查子分组深度: {error}"))
}

fn validate_placement(
    connection: &Connection,
    moving_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<(), String> {
    let parent_depth = parent_depth_and_cycle(connection, parent_id, moving_id)?;
    let height = match moving_id {
        Some(group_id) => subtree_height(connection, group_id)?,
        None => 1,
    };
    if parent_depth + height > MAX_GROUP_DEPTH {
        return Err(format!("分组最多允许 {MAX_GROUP_DEPTH} 层"));
    }
    Ok(())
}

fn sibling_ids(
    connection: &Connection,
    parent_id: Option<&str>,
    excluding: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id FROM library_groups
             WHERE parent_id IS ?1 AND kind='custom' AND (?2 IS NULL OR id<>?2)
             ORDER BY sort_order,id",
        )
        .map_err(|error| format!("无法读取同级分组: {error}"))?;
    let siblings = statement
        .query_map(params![parent_id, excluding], |row| row.get::<_, String>(0))
        .map_err(|error| format!("无法读取同级分组: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同级分组: {error}"))?;
    Ok(siblings)
}

fn write_order(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    ids: &[String],
) -> Result<(), String> {
    for (index, group_id) in ids.iter().enumerate() {
        transaction
            .execute(
                "UPDATE library_groups SET parent_id=?1,sort_order=?2,updated_at=?3 WHERE id=?4",
                params![parent_id, index as i64, library::now_ms(), group_id],
            )
            .map_err(|error| format!("无法重排分组: {error}"))?;
    }
    Ok(())
}

fn create_group_at(
    connection: &mut Connection,
    parent_id: Option<String>,
    name: String,
) -> Result<LibraryGroup, String> {
    let name = validate_name(&name)?;
    validate_placement(connection, None, parent_id.as_deref())?;
    let sort_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order)+1,0) FROM library_groups
             WHERE parent_id IS ?1 AND kind='custom'",
            params![parent_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法确定分组顺序: {error}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = library::now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启创建分组事务: {error}"))?;
    transaction
        .execute(
            "INSERT INTO library_groups(id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at)
             VALUES (?1,?2,?3,'custom',NULL,?4,?5,?5)",
            params![id, parent_id, name, sort_order, now],
        )
        .map_err(|error| format!("无法创建分组: {error}"))?;
    let group = group_at(&transaction, &id)?;
    write_group_sync_record(&transaction, &group)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交创建分组: {error}"))?;
    Ok(group)
}

fn update_group_at(
    connection: &mut Connection,
    group_id: &str,
    name: String,
) -> Result<LibraryGroup, String> {
    let group = group_at(connection, group_id)?;
    if group.kind != "custom" {
        return Err("智能组为只读分组".to_string());
    }
    let name = validate_name(&name)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启重命名分组事务: {error}"))?;
    transaction
        .execute(
            "UPDATE library_groups SET name=?1,updated_at=?2 WHERE id=?3",
            params![name, library::now_ms(), group_id],
        )
        .map_err(|error| format!("无法重命名分组: {error}"))?;
    let group = group_at(&transaction, group_id)?;
    write_group_sync_record(&transaction, &group)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交重命名分组: {error}"))?;
    Ok(group)
}

fn move_group_at(
    connection: &mut Connection,
    group_id: &str,
    parent_id: Option<String>,
    sort_order: usize,
) -> Result<LibraryGroup, String> {
    let group = group_at(connection, group_id)?;
    if group.kind != "custom" {
        return Err("智能组为只读分组".to_string());
    }
    validate_placement(connection, Some(group_id), parent_id.as_deref())?;
    let old_parent = group.parent_id.clone();
    let mut destination = sibling_ids(connection, parent_id.as_deref(), Some(group_id))?;
    destination.insert(sort_order.min(destination.len()), group_id.to_string());
    let old_siblings = if old_parent != parent_id {
        Some(sibling_ids(
            connection,
            old_parent.as_deref(),
            Some(group_id),
        )?)
    } else {
        None
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启分组移动事务: {error}"))?;
    if let Some(siblings) = old_siblings.as_ref() {
        write_order(&transaction, old_parent.as_deref(), siblings)?;
    }
    write_order(&transaction, parent_id.as_deref(), &destination)?;
    let changed = old_siblings
        .iter()
        .flatten()
        .chain(destination.iter())
        .collect::<HashSet<_>>();
    for changed_id in changed {
        write_group_sync_record(&transaction, &group_at(&transaction, changed_id)?)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交分组移动: {error}"))?;
    group_at(connection, group_id)
}

fn delete_group_at(connection: &mut Connection, group_id: &str) -> Result<(), String> {
    let group = group_at(connection, group_id)?;
    if group.kind != "custom" {
        return Err("智能组为只读分组".to_string());
    }
    let children = sibling_ids(connection, Some(group_id), None)?;
    let member_item_ids = connection
        .prepare("SELECT item_id FROM library_group_members WHERE group_id=?1 ORDER BY item_id")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![group_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("无法读取待删除分组成员: {error}"))?;
    let mut promoted = sibling_ids(connection, group.parent_id.as_deref(), Some(group_id))?;
    let insertion = (group.sort_order.max(0) as usize).min(promoted.len());
    promoted.splice(insertion..insertion, children);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启删除分组事务: {error}"))?;
    transaction
        .execute("DELETE FROM library_groups WHERE id=?1", params![group_id])
        .map_err(|error| format!("无法删除分组: {error}"))?;
    write_order(&transaction, group.parent_id.as_deref(), &promoted)?;
    for changed_id in &promoted {
        write_group_sync_record(&transaction, &group_at(&transaction, changed_id)?)?;
    }
    sync::write_group_state_record_at(&transaction, group_id, None)?;
    for item_id in member_item_ids {
        sync::write_membership_record_at(&transaction, group_id, &item_id, false)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交删除分组: {error}"))
}

fn resolve_item_id(connection: &Connection, item_id: &str) -> Result<String, String> {
    let resolved = connection
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析书籍标识: {error}"))?
        .unwrap_or_else(|| item_id.to_string());
    let exists = connection
        .query_row(
            "SELECT 1 FROM library_items WHERE id=?1",
            params![resolved],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("无法检查书籍: {error}"))?
        .is_some();
    if !exists {
        return Err("书籍不在书库中".to_string());
    }
    Ok(resolved)
}

fn validate_custom_groups(connection: &Connection, group_ids: &[String]) -> Result<(), String> {
    let mut unique = HashSet::new();
    for group_id in group_ids {
        if !unique.insert(group_id) {
            continue;
        }
        if group_at(connection, group_id)?.kind != "custom" {
            return Err("智能组成员由规则决定，不能手动修改".to_string());
        }
    }
    Ok(())
}

fn set_item_groups_at(
    connection: &mut Connection,
    item_id: &str,
    group_ids: Vec<String>,
) -> Result<(), String> {
    let item_id = resolve_item_id(connection, item_id)?;
    validate_custom_groups(connection, &group_ids)?;
    let previous = connection
        .prepare("SELECT group_id FROM library_group_members WHERE item_id=?1")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<HashSet<_>, _>>()
        })
        .map_err(|error| format!("无法读取现有书籍分组: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启分组成员事务: {error}"))?;
    transaction
        .execute(
            "DELETE FROM library_group_members WHERE item_id=?1",
            params![item_id],
        )
        .map_err(|error| format!("无法清除书籍分组: {error}"))?;
    let now = library::now_ms();
    let mut unique = HashSet::new();
    for group_id in group_ids {
        if unique.insert(group_id.clone()) {
            transaction
                .execute(
                    "INSERT INTO library_group_members(group_id,item_id,created_at)
                     VALUES (?1,?2,?3)",
                    params![group_id, item_id, now],
                )
                .map_err(|error| format!("无法添加书籍分组: {error}"))?;
        }
    }
    for group_id in previous.union(&unique) {
        sync::write_membership_record_at(
            &transaction,
            group_id,
            &item_id,
            unique.contains(group_id),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交书籍分组: {error}"))
}

#[tauri::command]
pub fn library_list_groups(app: AppHandle) -> Result<Vec<LibraryGroup>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT id,parent_id,name,kind,rule_json,sort_order FROM library_groups
             ORDER BY parent_id IS NOT NULL,parent_id,sort_order,id",
        )
        .map_err(|error| format!("无法读取书架分组: {error}"))?;
    let groups = statement
        .query_map([], read_group)
        .map_err(|error| format!("无法读取书架分组: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书架分组: {error}"))?;
    Ok(groups)
}

#[tauri::command]
pub fn library_create_group(
    app: AppHandle,
    parent_id: Option<String>,
    name: String,
) -> Result<LibraryGroup, String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    create_group_at(&mut connection, parent_id, name)
}

#[tauri::command]
pub fn library_update_group(
    app: AppHandle,
    group_id: String,
    name: String,
) -> Result<LibraryGroup, String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    update_group_at(&mut connection, &group_id, name)
}

#[tauri::command]
pub fn library_move_group(
    app: AppHandle,
    group_id: String,
    parent_id: Option<String>,
    sort_order: usize,
) -> Result<LibraryGroup, String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    move_group_at(&mut connection, &group_id, parent_id, sort_order)
}

#[tauri::command]
pub fn library_delete_group(app: AppHandle, group_id: String) -> Result<(), String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    delete_group_at(&mut connection, &group_id)
}

#[tauri::command]
pub fn library_list_group_memberships(
    app: AppHandle,
) -> Result<Vec<LibraryGroupMembership>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare("SELECT group_id,item_id FROM library_group_members ORDER BY group_id,item_id")
        .map_err(|error| format!("无法读取分组成员: {error}"))?;
    let memberships = statement
        .query_map([], |row| {
            Ok(LibraryGroupMembership {
                group_id: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("无法读取分组成员: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析分组成员: {error}"))?;
    Ok(memberships)
}

#[tauri::command]
pub fn library_set_group_member(
    app: AppHandle,
    group_id: String,
    item_id: String,
    present: bool,
) -> Result<(), String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let item_id = resolve_item_id(&connection, &item_id)?;
    validate_custom_groups(&connection, std::slice::from_ref(&group_id))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启分组成员事务: {error}"))?;
    if present {
        transaction
            .execute(
                "INSERT INTO library_group_members(group_id,item_id,created_at)
                 VALUES (?1,?2,?3) ON CONFLICT(group_id,item_id) DO NOTHING",
                params![group_id, item_id, library::now_ms()],
            )
            .map_err(|error| format!("无法添加分组成员: {error}"))?;
    } else {
        transaction
            .execute(
                "DELETE FROM library_group_members WHERE group_id=?1 AND item_id=?2",
                params![group_id, item_id],
            )
            .map_err(|error| format!("无法移除分组成员: {error}"))?;
    }
    sync::write_membership_record_at(&transaction, &group_id, &item_id, present)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交分组成员: {error}"))
}

#[tauri::command]
pub fn library_set_item_groups(
    app: AppHandle,
    item_id: String,
    group_ids: Vec<String>,
) -> Result<(), String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    set_item_groups_at(&mut connection, &item_id, group_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_item(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO library_items(id,source_kind,title,authors_json,updated_at)
                 VALUES (?1,'managed',?1,'[]',1)",
                params![id],
            )
            .unwrap();
    }

    #[test]
    fn supports_many_to_many_membership_and_rejects_a_ninth_level() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        insert_item(&connection, "book-a");
        let mut parent = None;
        let mut ids = Vec::new();
        for depth in 1..=MAX_GROUP_DEPTH {
            let group = create_group_at(&mut connection, parent, format!("Level {depth}")).unwrap();
            parent = Some(group.id.clone());
            ids.push(group.id);
        }
        assert!(create_group_at(&mut connection, parent, "Too deep".to_string()).is_err());

        set_item_groups_at(
            &mut connection,
            "book-a",
            vec![ids[0].clone(), ids[3].clone()],
        )
        .unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM library_group_members WHERE item_id='book-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn custom_root_order_does_not_rewrite_smart_groups() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        let smart_before: Vec<(String, Option<String>, i64)> = connection
            .prepare(
                "SELECT id,parent_id,sort_order FROM library_groups WHERE kind='smart' ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        let first = create_group_at(&mut connection, None, "First".to_string()).unwrap();
        assert_eq!(first.sort_order, 0);
        let second = create_group_at(&mut connection, None, "Second".to_string()).unwrap();
        move_group_at(&mut connection, &second.id, None, 0).unwrap();

        let smart_after: Vec<(String, Option<String>, i64)> = connection
            .prepare(
                "SELECT id,parent_id,sort_order FROM library_groups WHERE kind='smart' ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(smart_after, smart_before);
    }

    #[test]
    fn rejects_cycles_and_promotes_children_when_deleting_a_parent() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        insert_item(&connection, "book-a");
        let root = create_group_at(&mut connection, None, "Root".to_string()).unwrap();
        let child =
            create_group_at(&mut connection, Some(root.id.clone()), "Child".to_string()).unwrap();
        let leaf =
            create_group_at(&mut connection, Some(child.id.clone()), "Leaf".to_string()).unwrap();
        assert!(move_group_at(&mut connection, &root.id, Some(leaf.id.clone()), 0).is_err());
        set_item_groups_at(&mut connection, "book-a", vec![child.id.clone()]).unwrap();

        delete_group_at(&mut connection, &child.id).unwrap();

        assert_eq!(
            group_at(&connection, &leaf.id).unwrap().parent_id,
            Some(root.id)
        );
        let book_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM library_items WHERE id='book-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let member_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_group_members", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(book_count, 1);
        assert_eq!(member_count, 0);
        let records = sync::list_records_at(&connection).unwrap();
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-group:{}", child.id) && record.tombstone
        }));
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-membership:{}:book-a", child.id)
                && record.tombstone
        }));
    }
}
