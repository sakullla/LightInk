//! Persistent library tags and their many-to-many book memberships.
//!
//! Tags are a first-class library dimension: names are trimmed and a repeated
//! name refers to the same tag, deleting a tag removes only its relations, and
//! every mutation writes the same sync records that groups use.

use crate::{groups, library, sync};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::AppHandle;

const MAX_TAG_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTag {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTagMembership {
    pub tag_id: String,
    pub item_id: String,
}

fn validate_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_TAG_NAME_CHARS {
        return Err(format!(
            "标签名称长度必须为 1 至 {MAX_TAG_NAME_CHARS} 个字符"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("标签名称不能包含控制字符".to_string());
    }
    Ok(name.to_string())
}

fn read_tag(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTag> {
    Ok(LibraryTag {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn tag_at(connection: &Connection, tag_id: &str) -> Result<LibraryTag, String> {
    connection
        .query_row(
            "SELECT id,name,created_at,updated_at FROM library_tags WHERE id=?1",
            params![tag_id],
            read_tag,
        )
        .optional()
        .map_err(|error| format!("无法读取标签: {error}"))?
        .ok_or_else(|| "标签不存在".to_string())
}

fn tag_by_name(connection: &Connection, name: &str) -> Result<Option<LibraryTag>, String> {
    connection
        .query_row(
            "SELECT id,name,created_at,updated_at FROM library_tags
             WHERE name=?1 ORDER BY id LIMIT 1",
            params![name],
            read_tag,
        )
        .optional()
        .map_err(|error| format!("无法读取标签: {error}"))
}

fn write_tag_sync_record(connection: &Connection, tag: &LibraryTag) -> Result<(), String> {
    let value =
        serde_json::to_value(tag).map_err(|error| format!("无法序列化标签同步状态: {error}"))?;
    sync::write_tag_state_record_at(connection, &tag.id, Some(value)).map(|_| ())
}

fn create_tag_at(connection: &mut Connection, name: String) -> Result<LibraryTag, String> {
    let name = validate_name(&name)?;
    if let Some(existing) = tag_by_name(connection, &name)? {
        return Ok(existing);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = library::now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启创建标签事务: {error}"))?;
    transaction
        .execute(
            "INSERT INTO library_tags(id,name,created_at,updated_at) VALUES (?1,?2,?3,?3)",
            params![id, name, now],
        )
        .map_err(|error| format!("无法创建标签: {error}"))?;
    let tag = tag_at(&transaction, &id)?;
    write_tag_sync_record(&transaction, &tag)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交创建标签: {error}"))?;
    Ok(tag)
}

fn rename_tag_at(
    connection: &mut Connection,
    tag_id: &str,
    name: String,
) -> Result<LibraryTag, String> {
    let tag = tag_at(connection, tag_id)?;
    let name = validate_name(&name)?;
    if let Some(existing) = tag_by_name(connection, &name)? {
        if existing.id != tag.id {
            return Err("标签名称已存在".to_string());
        }
        return Ok(existing);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启重命名标签事务: {error}"))?;
    transaction
        .execute(
            "UPDATE library_tags SET name=?1,updated_at=?2 WHERE id=?3",
            params![name, library::now_ms(), tag_id],
        )
        .map_err(|error| format!("无法重命名标签: {error}"))?;
    let tag = tag_at(&transaction, tag_id)?;
    write_tag_sync_record(&transaction, &tag)?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交重命名标签: {error}"))?;
    Ok(tag)
}

/// Delete a tag and its book relations. Books themselves are never touched.
fn delete_tag_at(connection: &mut Connection, tag_id: &str) -> Result<(), String> {
    let _tag = tag_at(connection, tag_id)?;
    let member_item_ids = connection
        .prepare("SELECT item_id FROM library_tag_members WHERE tag_id=?1 ORDER BY item_id")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![tag_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("无法读取待删除标签的书籍: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启删除标签事务: {error}"))?;
    transaction
        .execute("DELETE FROM library_tags WHERE id=?1", params![tag_id])
        .map_err(|error| format!("无法删除标签: {error}"))?;
    sync::write_tag_state_record_at(&transaction, tag_id, None)?;
    for item_id in member_item_ids {
        sync::write_tag_membership_record_at(&transaction, tag_id, &item_id, false)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交删除标签: {error}"))
}

fn validate_tags(connection: &Connection, tag_ids: &[String]) -> Result<HashSet<String>, String> {
    let mut unique = HashSet::new();
    for tag_id in tag_ids {
        if !unique.insert(tag_id.clone()) {
            continue;
        }
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM library_tags WHERE id=?1)",
                params![tag_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("无法检查标签: {error}"))?;
        if !exists {
            return Err("标签不存在".to_string());
        }
    }
    Ok(unique)
}

fn set_item_tags_at(
    connection: &mut Connection,
    item_id: &str,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let item_id = groups::resolve_item_id(connection, item_id)?;
    let requested = validate_tags(connection, &tag_ids)?;
    let previous = connection
        .prepare("SELECT tag_id FROM library_tag_members WHERE item_id=?1")
        .and_then(|mut statement| {
            let rows = statement.query_map(params![item_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<HashSet<_>, _>>()
        })
        .map_err(|error| format!("无法读取现有书籍标签: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启标签关系事务: {error}"))?;
    transaction
        .execute(
            "DELETE FROM library_tag_members WHERE item_id=?1",
            params![item_id],
        )
        .map_err(|error| format!("无法清除书籍标签: {error}"))?;
    let now = library::now_ms();
    for tag_id in &requested {
        transaction
            .execute(
                "INSERT INTO library_tag_members(tag_id,item_id,created_at) VALUES (?1,?2,?3)",
                params![tag_id, item_id, now],
            )
            .map_err(|error| format!("无法添加书籍标签: {error}"))?;
    }
    for tag_id in previous.union(&requested) {
        sync::write_tag_membership_record_at(
            &transaction,
            tag_id,
            &item_id,
            requested.contains(tag_id),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交书籍标签: {error}"))
}

#[tauri::command]
pub fn library_list_tags(app: AppHandle) -> Result<Vec<LibraryTag>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare("SELECT id,name,created_at,updated_at FROM library_tags ORDER BY name COLLATE NOCASE,id")
        .map_err(|error| format!("无法读取书库标签: {error}"))?;
    let tags = statement
        .query_map([], read_tag)
        .map_err(|error| format!("无法读取书库标签: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书库标签: {error}"))?;
    Ok(tags)
}

#[tauri::command]
pub fn library_list_tag_memberships(app: AppHandle) -> Result<Vec<LibraryTagMembership>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare("SELECT tag_id,item_id FROM library_tag_members ORDER BY tag_id,item_id")
        .map_err(|error| format!("无法读取标签关系: {error}"))?;
    let memberships = statement
        .query_map([], |row| {
            Ok(LibraryTagMembership {
                tag_id: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("无法读取标签关系: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析标签关系: {error}"))?;
    Ok(memberships)
}

#[tauri::command]
pub fn library_create_tag(app: AppHandle, name: String) -> Result<LibraryTag, String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    create_tag_at(&mut connection, name)
}

#[tauri::command]
pub fn library_rename_tag(
    app: AppHandle,
    tag_id: String,
    name: String,
) -> Result<LibraryTag, String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    rename_tag_at(&mut connection, &tag_id, name)
}

#[tauri::command]
pub fn library_delete_tag(app: AppHandle, tag_id: String) -> Result<(), String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    delete_tag_at(&mut connection, &tag_id)
}

#[tauri::command]
pub fn library_set_item_tags(
    app: AppHandle,
    item_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let mut connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    set_item_tags_at(&mut connection, &item_id, tag_ids)
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
    fn trims_names_and_reuses_the_same_tag_instead_of_duplicating_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();

        let first = create_tag_at(&mut connection, "  科幻  ".to_string()).unwrap();
        let second = create_tag_at(&mut connection, "科幻".to_string()).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(first.name, "科幻");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(create_tag_at(&mut connection, "   ".to_string()).is_err());

        let renamed = rename_tag_at(&mut connection, &first.id, " 太空 ".to_string()).unwrap();
        assert_eq!(renamed.name, "太空");
        let other = create_tag_at(&mut connection, "历史".to_string()).unwrap();
        assert!(rename_tag_at(&mut connection, &other.id, "太空".to_string()).is_err());
        assert_eq!(
            rename_tag_at(&mut connection, &other.id, "历史".to_string()).unwrap(),
            other
        );
    }

    #[test]
    fn batch_assignment_and_deletion_keep_books_and_write_sync_records() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        insert_item(&connection, "book-a");
        insert_item(&connection, "book-b");
        let first = create_tag_at(&mut connection, "科幻".to_string()).unwrap();
        let second = create_tag_at(&mut connection, "历史".to_string()).unwrap();

        set_item_tags_at(
            &mut connection,
            "book-a",
            vec![first.id.clone(), second.id.clone(), first.id.clone()],
        )
        .unwrap();
        set_item_tags_at(&mut connection, "book-b", vec![first.id.clone()]).unwrap();
        let members: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_tag_members", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(members, 3);

        // 批量替换：book-a 只保留第二个标签。
        set_item_tags_at(&mut connection, "book-a", vec![second.id.clone()]).unwrap();
        let book_a_tags: Vec<String> = connection
            .prepare(
                "SELECT tag_id FROM library_tag_members WHERE item_id='book-a' ORDER BY tag_id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(book_a_tags, vec![second.id.clone()]);

        delete_tag_at(&mut connection, &first.id).unwrap();
        let books: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        let remaining: Vec<(String, String)> = connection
            .prepare("SELECT tag_id,item_id FROM library_tag_members ORDER BY tag_id,item_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(books, 2);
        assert_eq!(remaining, vec![(second.id.clone(), "book-a".to_string())]);

        let records = sync::list_records_at(&connection).unwrap();
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-tag:{}", first.id) && record.tombstone
        }));
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-tag-membership:{}:book-b", first.id)
                && record.tombstone
        }));
        assert!(records.iter().any(|record| {
            record.object_id == format!("library-tag:{}", second.id) && !record.tombstone
        }));
    }

    #[test]
    fn assigning_unknown_tags_or_books_is_rejected_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = library::open_database_at(directory.path()).unwrap();
        insert_item(&connection, "book-a");
        let tag = create_tag_at(&mut connection, "科幻".to_string()).unwrap();

        assert!(set_item_tags_at(&mut connection, "book-a", vec!["missing".to_string()]).is_err());
        assert!(set_item_tags_at(&mut connection, "missing", vec![tag.id.clone()]).is_err());
        let members: i64 = connection
            .query_row("SELECT COUNT(*) FROM library_tag_members", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(members, 0);
        assert!(delete_tag_at(&mut connection, "missing").is_err());
    }
}
