//! OPDS 1.x Atom and 2.0 JSON feed parsing and authenticated browsing.

use crate::library::{self, OpdsSource};
use crate::remote::{
    fetch_remote_text, forget_credential_value, same_origin, store_credential_value,
    validate_remote_url, RemoteCredential, RemoteError, RemoteState,
};
use quick_xml::events::{BytesCData, BytesRef, BytesStart, BytesText, Event};
use quick_xml::Reader;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use url::Url;

const MAX_OPDS_FEED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsLink {
    pub href: String,
    pub rel: String,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub size: Option<u64>,
    pub extension: Option<String>,
    pub acquisition: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsEntry {
    pub id: String,
    pub item_id: Option<String>,
    pub title: String,
    pub authors: Vec<String>,
    pub updated: Option<String>,
    pub summary: Option<String>,
    pub cover_url: Option<String>,
    pub links: Vec<OpdsLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsFeed {
    pub id: Option<String>,
    pub title: String,
    pub updated: Option<String>,
    pub entries: Vec<OpdsEntry>,
    pub links: Vec<OpdsLink>,
    pub next_url: Option<String>,
    pub previous_url: Option<String>,
    pub search_template: Option<String>,
    pub source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsSourceInput {
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    pub allow_http: Option<bool>,
    pub credential_ref: Option<String>,
    pub credential: Option<RemoteCredential>,
    pub clear_credential: Option<bool>,
}

#[derive(Default)]
struct EntryBuilder {
    id: String,
    title: String,
    authors: Vec<String>,
    updated: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    cover_url: Option<String>,
    links: Vec<OpdsLink>,
}

fn local_name(raw: &[u8]) -> String {
    let name = raw.rsplit(|byte| *byte == b':').next().unwrap_or(raw);
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

fn text_value(text: &BytesText<'_>) -> Result<String, RemoteError> {
    text.decode()
        .map(|value| value.into_owned())
        .map_err(|error| RemoteError::new("OPDS_XML_INVALID", format!("XML 文本编码无效: {error}")))
}

fn cdata_value(text: &BytesCData<'_>) -> Result<String, RemoteError> {
    text.decode()
        .map(|value| value.into_owned())
        .map_err(|error| {
            RemoteError::new("OPDS_XML_INVALID", format!("XML CDATA 编码无效: {error}"))
        })
}

fn reference_value(reference: &BytesRef<'_>) -> Result<String, RemoteError> {
    if let Some(value) = reference.resolve_char_ref().map_err(|error| {
        RemoteError::new("OPDS_XML_INVALID", format!("XML 字符引用无效: {error}"))
    })? {
        return Ok(value.to_string());
    }
    let name = reference.decode().map_err(|error| {
        RemoteError::new("OPDS_XML_INVALID", format!("XML 实体编码无效: {error}"))
    })?;
    match name.as_ref() {
        "lt" => Ok("<".into()),
        "gt" => Ok(">".into()),
        "amp" => Ok("&".into()),
        "apos" => Ok("'".into()),
        "quot" => Ok("\"".into()),
        _ => Err(RemoteError::new(
            "OPDS_XML_INVALID",
            format!("OPDS XML 包含未声明实体 &{name};"),
        )),
    }
}

fn attributes(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<Vec<(String, String)>, RemoteError> {
    element
        .attributes()
        .with_checks(true)
        .map(|attribute| {
            let attribute = attribute.map_err(|error| {
                RemoteError::new("OPDS_XML_INVALID", format!("XML 属性无效: {error}"))
            })?;
            let key = local_name(attribute.key.as_ref());
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .map_err(|error| {
                    RemoteError::new("OPDS_XML_INVALID", format!("XML 属性编码无效: {error}"))
                })?
                .into_owned();
            Ok((key, value))
        })
        .collect()
}

fn extension_from_href(href: &str) -> Option<String> {
    let path = Url::parse(href)
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| href.to_string());
    let name = path.rsplit('/').next().unwrap_or(&path);
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    (!extension.is_empty()).then_some(extension)
}

fn extension_from_media_type(media_type: Option<&str>, href: &str) -> Option<String> {
    let media_type = media_type.unwrap_or_default().to_ascii_lowercase();
    match media_type.split(';').next().unwrap_or_default().trim() {
        "application/epub+zip" => Some("epub".into()),
        "application/pdf" => Some("pdf".into()),
        "application/vnd.comicbook+zip" | "application/x-cbz" => Some("cbz".into()),
        "application/vnd.rar" | "application/x-rar-compressed" => Some(
            extension_from_href(href)
                .filter(|ext| ext == "cbr")
                .unwrap_or_else(|| "rar".into()),
        ),
        "application/x-7z-compressed" => Some(
            extension_from_href(href)
                .filter(|ext| ext == "cb7")
                .unwrap_or_else(|| "7z".into()),
        ),
        "application/x-mobipocket-ebook" => Some("mobi".into()),
        "application/x-fictionbook+xml" => Some("fb2".into()),
        "text/plain" => Some("txt".into()),
        _ => extension_from_href(href),
    }
}

fn resolve_link_url(base: &Url, href: &str) -> Result<String, RemoteError> {
    let resolved = base
        .join(href)
        .map_err(|_| RemoteError::new("OPDS_LINK_INVALID", "OPDS link URL 无效"))?;
    if !matches!(resolved.scheme(), "http" | "https")
        || resolved.host_str().is_none()
        || !resolved.username().is_empty()
        || resolved.password().is_some()
        || (base.scheme() == "https" && resolved.scheme() == "http")
    {
        return Err(RemoteError::new(
            "OPDS_LINK_INVALID",
            "OPDS link 必须是不含内嵌凭据且不从 HTTPS 降级的 HTTP(S) URL",
        ));
    }
    Ok(resolved.to_string())
}

fn supported_extension(extension: Option<&str>) -> bool {
    matches!(
        extension,
        Some("epub" | "pdf" | "cbz" | "cbr" | "rar" | "cb7" | "7z" | "mobi" | "fb2" | "txt")
    )
}

fn parse_link(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    base: &Url,
) -> Result<OpdsLink, RemoteError> {
    let mut href = None;
    let mut rel = "alternate".to_string();
    let mut media_type = None;
    let mut title = None;
    let mut size = None;
    for (key, value) in attributes(reader, element)? {
        match key.as_str() {
            "href" => href = Some(value),
            "rel" => rel = value,
            "type" => media_type = Some(value),
            "title" => title = Some(value),
            "length" => size = value.parse().ok(),
            _ => {}
        }
    }
    let href = href.ok_or_else(|| RemoteError::new("OPDS_LINK_INVALID", "OPDS link 缺少 href"))?;
    let href = resolve_link_url(base, &href)?;
    let extension = extension_from_media_type(media_type.as_deref(), &href);
    let rel_tokens = rel.split_ascii_whitespace().collect::<Vec<_>>();
    let acquisition_rel = rel_tokens
        .iter()
        .any(|token| token.contains("opds-spec.org/acquisition") || *token == "acquisition");
    let acquisition = acquisition_rel && supported_extension(extension.as_deref());
    Ok(OpdsLink {
        href,
        rel,
        media_type,
        title,
        size,
        extension,
        acquisition,
    })
}

fn append_text(target: &mut String, value: &str) {
    target.push_str(value);
}

fn append_optional_text(target: &mut Option<String>, value: &str) {
    target.get_or_insert_with(String::new).push_str(value);
}

fn current_text_field(stack: &[String]) -> Option<&str> {
    if let Some(field) = stack
        .iter()
        .rev()
        .find(|part| matches!(part.as_str(), "summary" | "content"))
    {
        return Some(field);
    }
    if stack.iter().any(|part| part == "author") && stack.iter().any(|part| part == "name") {
        return Some("name");
    }
    stack
        .iter()
        .rev()
        .find(|part| matches!(part.as_str(), "id" | "title" | "updated"))
        .map(String::as_str)
}

fn append_field_text(
    stack: &[String],
    entry: &mut Option<EntryBuilder>,
    feed: &mut OpdsFeed,
    author: &mut String,
    value: &str,
) {
    let name = current_text_field(stack).unwrap_or_default();
    if let Some(current) = entry.as_mut() {
        match name {
            "id" => append_text(&mut current.id, value),
            "title" => append_text(&mut current.title, value),
            "updated" => append_optional_text(&mut current.updated, value),
            "summary" => append_optional_text(&mut current.summary, value),
            "content" => append_optional_text(&mut current.content, value),
            "name" if stack.iter().rev().any(|part| part == "author") => append_text(author, value),
            _ => {}
        }
    } else {
        match name {
            "id" => append_optional_text(&mut feed.id, value),
            "title" => append_text(&mut feed.title, value),
            "updated" => append_optional_text(&mut feed.updated, value),
            _ => {}
        }
    }
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn parse_opds_feed(xml: &str, base_url: &Url) -> Result<OpdsFeed, RemoteError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<String> = Vec::new();
    let mut feed = OpdsFeed {
        id: None,
        title: String::new(),
        updated: None,
        entries: Vec::new(),
        links: Vec::new(),
        next_url: None,
        previous_url: None,
        search_template: None,
        source_url: base_url.to_string(),
    };
    let mut entry: Option<EntryBuilder> = None;
    let mut author = String::new();
    let mut ignored_markup_depth = 0_usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local_name(element.name().as_ref());
                if matches!(name.as_str(), "script" | "style" | "iframe" | "object") {
                    ignored_markup_depth = ignored_markup_depth.saturating_add(1);
                }
                if name == "entry" {
                    entry = Some(EntryBuilder::default());
                } else if name == "author" {
                    author.clear();
                } else if name == "link" {
                    let link = parse_link(&reader, &element, base_url)?;
                    if let Some(current) = entry.as_mut() {
                        if link.rel.split_ascii_whitespace().any(|rel| {
                            rel.ends_with("/image")
                                || rel.ends_with("/image/thumbnail")
                                || rel == "cover"
                        }) {
                            current.cover_url.get_or_insert_with(|| link.href.clone());
                        }
                        current.links.push(link);
                    } else {
                        feed.links.push(link);
                    }
                }
                stack.push(name);
            }
            Ok(Event::Empty(element)) => {
                if local_name(element.name().as_ref()) == "link" {
                    let link = parse_link(&reader, &element, base_url)?;
                    if let Some(current) = entry.as_mut() {
                        if link.rel.split_ascii_whitespace().any(|rel| {
                            rel.ends_with("/image")
                                || rel.ends_with("/image/thumbnail")
                                || rel == "cover"
                        }) {
                            current.cover_url.get_or_insert_with(|| link.href.clone());
                        }
                        current.links.push(link);
                    } else {
                        feed.links.push(link);
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if ignored_markup_depth == 0 {
                    let value = text_value(&text)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if ignored_markup_depth == 0 {
                    let value = reference_value(&reference)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::CData(text)) => {
                if ignored_markup_depth == 0 {
                    let value = cdata_value(&text)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::End(element)) => {
                let name = local_name(element.name().as_ref());
                if name == "author" && !author.trim().is_empty() {
                    if let Some(current) = entry.as_mut() {
                        current.authors.push(author.trim().to_string());
                    }
                    author.clear();
                } else if name == "entry" {
                    let mut current = entry.take().unwrap_or_default();
                    current.id = current.id.trim().to_string();
                    current.title = current.title.trim().to_string();
                    current.updated = trimmed_optional(current.updated);
                    current.summary = trimmed_optional(current.summary)
                        .or_else(|| trimmed_optional(current.content));
                    if current.id.is_empty() || current.title.is_empty() {
                        return Err(RemoteError::new(
                            "OPDS_ENTRY_INVALID",
                            "OPDS 条目缺少 id 或 title",
                        ));
                    }
                    feed.entries.push(OpdsEntry {
                        id: current.id,
                        item_id: None,
                        title: current.title,
                        authors: current.authors,
                        updated: current.updated,
                        summary: current.summary,
                        cover_url: current.cover_url,
                        links: current.links,
                    });
                }
                if matches!(name.as_str(), "script" | "style" | "iframe" | "object") {
                    ignored_markup_depth = ignored_markup_depth.saturating_sub(1);
                }
                stack.pop();
            }
            Ok(Event::DocType(_)) => {
                return Err(RemoteError::new(
                    "OPDS_XML_UNSAFE",
                    "OPDS Feed 不允许声明 DTD",
                ));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(RemoteError::new(
                    "OPDS_XML_INVALID",
                    format!("OPDS XML 损坏: {error}"),
                ));
            }
        }
    }
    feed.id = trimmed_optional(feed.id);
    feed.title = feed.title.trim().to_string();
    feed.updated = trimmed_optional(feed.updated);
    if feed.title.is_empty() {
        return Err(RemoteError::new("OPDS_FEED_INVALID", "OPDS Feed 缺少标题"));
    }
    for link in &feed.links {
        let rels = link.rel.split_ascii_whitespace().collect::<Vec<_>>();
        if rels.contains(&"next") {
            feed.next_url = Some(link.href.clone());
        }
        if rels.contains(&"previous") || rels.contains(&"prev") {
            feed.previous_url = Some(link.href.clone());
        }
        if rels.contains(&"search") && link.href.contains("{searchTerms}") {
            feed.search_template = Some(link.href.clone());
        }
    }
    Ok(feed)
}

#[derive(Debug, Default, Deserialize)]
struct Opds2Metadata {
    title: Option<serde_json::Value>,
    identifier: Option<String>,
    #[serde(default)]
    id: Option<String>,
    modified: Option<String>,
    updated: Option<String>,
    description: Option<serde_json::Value>,
    author: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct Opds2LinkObject {
    href: String,
    #[serde(default)]
    rel: serde_json::Value,
    #[serde(rename = "type")]
    media_type: Option<String>,
    title: Option<String>,
    #[serde(default)]
    templated: bool,
    properties: Option<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct Opds2Publication {
    #[serde(default)]
    metadata: Opds2Metadata,
    #[serde(default)]
    links: Vec<Opds2LinkObject>,
    #[serde(default)]
    images: Vec<Opds2LinkObject>,
}

#[derive(Debug, Default, Deserialize)]
struct Opds2Group {
    #[serde(default)]
    publications: Vec<Opds2Publication>,
    #[serde(default)]
    navigation: Vec<Opds2LinkObject>,
}

#[derive(Debug, Default, Deserialize)]
struct Opds2FeedDocument {
    #[serde(default)]
    metadata: Opds2Metadata,
    #[serde(default)]
    links: Vec<Opds2LinkObject>,
    #[serde(default)]
    publications: Vec<Opds2Publication>,
    #[serde(default)]
    navigation: Vec<Opds2LinkObject>,
    #[serde(default)]
    groups: Vec<Opds2Group>,
}

fn looks_like_json(body: &str) -> bool {
    matches!(body.trim_start().as_bytes().first(), Some(b'{' | b'['))
}

fn looks_like_opds_json(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.contains_key("metadata")
        && (object.contains_key("publications")
            || object.contains_key("navigation")
            || object.contains_key("groups"))
}

fn json_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        serde_json::Value::Object(map) => {
            const PREFERRED: &[&str] = &["und", "", "en", "zh", "zh-CN", "zh-Hans", "zh-Hant"];
            for key in PREFERRED {
                if let Some(serde_json::Value::String(text)) = map.get(*key) {
                    let text = text.trim();
                    if !text.is_empty() {
                        return Some(text.to_string());
                    }
                }
            }
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let serde_json::Value::String(text) = &map[key] {
                    let text = text.trim();
                    if !text.is_empty() {
                        return Some(text.to_string());
                    }
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(json_text),
        _ => None,
    }
}

fn contributor_names(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(name) => {
            let name = name.trim();
            if name.is_empty() {
                Vec::new()
            } else {
                vec![name.to_string()]
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(name) = map.get("name") {
                return contributor_names(name);
            }
            json_text(value).into_iter().collect()
        }
        serde_json::Value::Array(items) => items.iter().flat_map(contributor_names).collect(),
        _ => Vec::new(),
    }
}

fn rel_tokens(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(rel) => rel.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => "alternate".into(),
    }
}

fn json_link_size(properties: Option<&serde_json::Value>) -> Option<u64> {
    let object = properties?.as_object()?;
    object
        .get("filesize")
        .or_else(|| object.get("fileSize"))
        .or_else(|| object.get("length"))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|size| u64::try_from(size).ok()))
        })
}

fn is_json_acquisition_rel(rel: &str) -> bool {
    rel.split_ascii_whitespace().any(|token| {
        token.contains("opds-spec.org/acquisition")
            || matches!(
                token,
                "acquisition" | "download" | "borrow" | "buy" | "subscribe"
            )
    })
}

fn is_json_search_template(href: &str) -> bool {
    href.contains("{searchTerms}") || href.contains("{query}") || href.contains("{?query")
}

fn resolve_templated_href(base: &Url, href: &str) -> Result<String, RemoteError> {
    let Some(template_at) = href.find('{') else {
        return resolve_link_url(base, href);
    };
    let (prefix, template) = href.split_at(template_at);
    if prefix.is_empty() {
        return Err(RemoteError::new("OPDS_LINK_INVALID", "OPDS 搜索模板无效"));
    }
    let resolved = resolve_link_url(base, prefix)?;
    Ok(format!("{resolved}{template}"))
}

fn expand_uri_query_var(template: &str, name: &str, value: &str) -> Option<String> {
    for (token, joiner) in [("{?", "?"), ("{&", "&")] {
        let Some(start) = template.find(token) else {
            continue;
        };
        let Some(end) = template[start..].find('}').map(|offset| start + offset) else {
            continue;
        };
        let names = &template[start + token.len()..end];
        if names.split(',').any(|part| part.trim() == name) {
            return Some(format!(
                "{}{joiner}{name}={value}{}",
                &template[..start],
                &template[end + 1..]
            ));
        }
    }
    None
}

fn expand_search_template(template: &str, query: &str) -> Result<String, RemoteError> {
    let encoded = url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect::<String>();
    if template.contains("{searchTerms}") {
        return Ok(template.replace("{searchTerms}", &encoded));
    }
    if let Some(expanded) = expand_uri_query_var(template, "query", &encoded) {
        return Ok(expanded);
    }
    if template.contains("{query}") {
        return Ok(template.replace("{query}", &encoded));
    }
    Err(RemoteError::new(
        "OPDS_SEARCH_UNSUPPORTED",
        "该 OPDS 源未提供搜索模板",
    ))
}

fn parse_json_link(
    link: &Opds2LinkObject,
    base: &Url,
    allow_acquisition: bool,
) -> Result<OpdsLink, RemoteError> {
    let rel = rel_tokens(&link.rel);
    let href = if link.templated || link.href.contains('{') {
        resolve_templated_href(base, &link.href)?
    } else {
        resolve_link_url(base, &link.href)?
    };
    let extension = extension_from_media_type(link.media_type.as_deref(), &href);
    let acquisition = allow_acquisition
        && is_json_acquisition_rel(&rel)
        && supported_extension(extension.as_deref());
    Ok(OpdsLink {
        href,
        rel,
        media_type: link.media_type.clone(),
        title: link.title.clone(),
        size: json_link_size(link.properties.as_ref()),
        extension,
        acquisition,
    })
}

fn is_cover_rel(rel: &str) -> bool {
    rel.split_ascii_whitespace().any(|token| {
        token.ends_with("/image") || token.ends_with("/image/thumbnail") || token == "cover"
    })
}

fn entry_from_publication(
    publication: &Opds2Publication,
    base: &Url,
) -> Result<OpdsEntry, RemoteError> {
    let title = publication
        .metadata
        .title
        .as_ref()
        .and_then(json_text)
        .ok_or_else(|| RemoteError::new("OPDS_ENTRY_INVALID", "OPDS 条目缺少 id 或 title"))?;
    let mut links = Vec::new();
    let mut cover_url = None;
    for image in &publication.images {
        let link = parse_json_link(image, base, false)?;
        cover_url.get_or_insert_with(|| link.href.clone());
        links.push(link);
    }
    for raw in &publication.links {
        let link = parse_json_link(raw, base, true)?;
        if cover_url.is_none() && is_cover_rel(&link.rel) {
            cover_url = Some(link.href.clone());
        }
        links.push(link);
    }
    let id = publication
        .metadata
        .identifier
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            publication
                .metadata
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            links
                .iter()
                .find(|link| link.rel.split_ascii_whitespace().any(|rel| rel == "self"))
                .map(|link| link.href.clone())
        })
        .unwrap_or_else(|| title.clone());
    Ok(OpdsEntry {
        id,
        item_id: None,
        title,
        authors: publication
            .metadata
            .author
            .as_ref()
            .map(contributor_names)
            .unwrap_or_default(),
        updated: publication
            .metadata
            .modified
            .as_deref()
            .or(publication.metadata.updated.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        summary: publication
            .metadata
            .description
            .as_ref()
            .and_then(json_text),
        cover_url,
        links,
    })
}

fn entry_from_navigation(
    link: &Opds2LinkObject,
    base: &Url,
) -> Result<Option<OpdsEntry>, RemoteError> {
    let Some(title) = link
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Ok(None);
    };
    let parsed = parse_json_link(link, base, false)?;
    Ok(Some(OpdsEntry {
        id: parsed.href.clone(),
        item_id: None,
        title,
        authors: Vec::new(),
        updated: None,
        summary: None,
        cover_url: None,
        links: vec![parsed],
    }))
}

fn apply_json_feed_links(feed: &mut OpdsFeed) {
    for link in &feed.links {
        let rels = link.rel.split_ascii_whitespace().collect::<Vec<_>>();
        if rels.contains(&"next") {
            feed.next_url = Some(link.href.clone());
        }
        if rels.contains(&"previous") || rels.contains(&"prev") {
            feed.previous_url = Some(link.href.clone());
        }
        if rels.contains(&"search") && is_json_search_template(&link.href) {
            feed.search_template = Some(link.href.clone());
        }
    }
}

fn map_opds2_document(
    document: Opds2FeedDocument,
    base_url: &Url,
) -> Result<OpdsFeed, RemoteError> {
    let title = document
        .metadata
        .title
        .as_ref()
        .and_then(json_text)
        .ok_or_else(|| RemoteError::new("OPDS_FEED_INVALID", "OPDS Feed 缺少标题"))?;
    let mut feed = OpdsFeed {
        id: document
            .metadata
            .identifier
            .as_deref()
            .or(document.metadata.id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        title,
        updated: document
            .metadata
            .modified
            .as_deref()
            .or(document.metadata.updated.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        entries: Vec::new(),
        links: Vec::new(),
        next_url: None,
        previous_url: None,
        search_template: None,
        source_url: base_url.to_string(),
    };
    for link in &document.links {
        feed.links.push(parse_json_link(link, base_url, false)?);
    }
    for link in &document.navigation {
        if let Some(entry) = entry_from_navigation(link, base_url)? {
            feed.entries.push(entry);
        }
    }
    for publication in &document.publications {
        feed.entries
            .push(entry_from_publication(publication, base_url)?);
    }
    for group in &document.groups {
        for link in &group.navigation {
            if let Some(entry) = entry_from_navigation(link, base_url)? {
                feed.entries.push(entry);
            }
        }
        for publication in &group.publications {
            feed.entries
                .push(entry_from_publication(publication, base_url)?);
        }
    }
    apply_json_feed_links(&mut feed);
    Ok(feed)
}

fn parse_catalog(body: &str, base_url: &Url) -> Result<OpdsFeed, RemoteError> {
    if looks_like_json(body) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            if looks_like_opds_json(&value) {
                let document: Opds2FeedDocument =
                    serde_json::from_value(value).map_err(|error| {
                        RemoteError::new("OPDS_JSON_INVALID", format!("OPDS JSON 损坏: {error}"))
                    })?;
                return map_opds2_document(document, base_url);
            }
            return parse_opds_feed(body, base_url).map_err(|_| {
                RemoteError::new("OPDS_JSON_INVALID", "响应不是有效的 OPDS 2.0 目录")
            });
        }
        return parse_opds_feed(body, base_url)
            .map_err(|_| RemoteError::new("OPDS_JSON_INVALID", "OPDS JSON 损坏"));
    }
    parse_opds_feed(body, base_url)
}

fn stable_source_id(url: &Url) -> String {
    let digest = Sha256::digest(url.as_str().as_bytes());
    format!(
        "opds-{}",
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn item_id(source_id: &str, entry_id: &str) -> String {
    let digest = Sha256::digest(format!("{source_id}\n{entry_id}").as_bytes());
    format!(
        "opds-item-{}",
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn persist_feed(app: &AppHandle, source_id: &str, feed: &OpdsFeed) -> Result<(), RemoteError> {
    let mut connection = library::open_database_at(
        &library::app_data_dir(app)
            .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?,
    )
    .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    let transaction = connection.transaction().map_err(|error| {
        RemoteError::new(
            "OPDS_STORAGE_ERROR",
            format!("无法开启 OPDS 保存事务: {error}"),
        )
    })?;
    for entry in &feed.entries {
        let id = item_id(source_id, &entry.id);
        let acquisitions = entry
            .links
            .iter()
            .filter(|link| link.acquisition)
            .collect::<Vec<_>>();
        let primary = acquisitions.first().copied();
        let authors_json = serde_json::to_string(&entry.authors).map_err(|error| {
            RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存作者信息: {error}"))
        })?;
        transaction
            .execute(
                "INSERT INTO library_items(
                   id, source_id, source_kind, title, authors_json, cover_url,
                   acquisition_url, media_type, extension, size, updated_at
                 ) VALUES (?1,?2,'opds',?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET title=?3, authors_json=?4, cover_url=?5,
                   acquisition_url=?6, media_type=?7, extension=?8, size=?9, updated_at=?10",
                params![
                    id,
                    source_id,
                    entry.title,
                    authors_json,
                    entry.cover_url,
                    primary.map(|link| link.href.as_str()),
                    primary.and_then(|link| link.media_type.as_deref()),
                    primary.and_then(|link| link.extension.as_deref()),
                    primary.and_then(|link| link.size.map(|size| size.min(i64::MAX as u64) as i64)),
                    library::now_ms(),
                ],
            )
            .map_err(|error| {
                RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存 OPDS 条目: {error}"))
            })?;
        transaction
            .execute(
                "DELETE FROM acquisition_links WHERE item_id=?1",
                params![id],
            )
            .map_err(|error| {
                RemoteError::new("OPDS_STORAGE_ERROR", format!("无法更新获取链接: {error}"))
            })?;
        for link in acquisitions {
            transaction
                .execute(
                    "INSERT INTO acquisition_links(item_id, href, rel, media_type, extension, size)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        id,
                        link.href,
                        link.rel,
                        link.media_type,
                        link.extension,
                        link.size.map(|size| size.min(i64::MAX as u64) as i64),
                    ],
                )
                .map_err(|error| {
                    RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存获取链接: {error}"))
                })?;
        }
    }
    transaction.commit().map_err(|error| {
        RemoteError::new(
            "OPDS_STORAGE_ERROR",
            format!("无法提交 OPDS 保存事务: {error}"),
        )
    })?;
    Ok(())
}

fn load_source(app: &AppHandle, source_id: &str) -> Result<OpdsSource, RemoteError> {
    library::library_list_sources(app.clone())
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| RemoteError::new("OPDS_SOURCE_NOT_FOUND", "OPDS 源不存在"))
}

#[tauri::command]
pub fn opds_add_source(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source: OpdsSourceInput,
) -> Result<OpdsSource, RemoteError> {
    let allow_http = source.allow_http.unwrap_or(false);
    let url = validate_remote_url(&source.url, allow_http)?;
    if source.title.trim().is_empty() {
        return Err(RemoteError::new(
            "OPDS_SOURCE_INVALID",
            "OPDS 源标题不能为空",
        ));
    }
    if source.clear_credential.unwrap_or(false) && source.credential.is_some() {
        return Err(RemoteError::new(
            "OPDS_SOURCE_INVALID",
            "不能同时清除和设置 OPDS 凭据",
        ));
    }
    let existing = source
        .id
        .as_deref()
        .map(|id| load_source(&app, id))
        .transpose()?;
    let id = source.id.unwrap_or_else(|| stable_source_id(&url));
    let credential_ref = if source.clear_credential.unwrap_or(false) {
        None
    } else {
        source
            .credential_ref
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|value| value.credential_ref.clone())
            })
            .or_else(|| {
                source
                    .credential
                    .as_ref()
                    .map(|_| format!("opds-source-{id}"))
            })
    };
    if let (Some(reference), Some(credential)) =
        (credential_ref.as_ref(), source.credential.as_ref())
    {
        store_credential_value(&state, reference.clone(), credential.clone())?;
    }
    let now = library::now_ms();
    let saved = OpdsSource {
        id,
        title: source.title.trim().to_string(),
        url: url.to_string(),
        credential_ref,
        allow_http,
        created_at: existing.as_ref().map_or(now, |value| value.created_at),
        updated_at: now,
    };
    library::library_upsert_source(app, saved.clone())
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    if let Some(old_reference) = existing.and_then(|value| value.credential_ref) {
        if saved.credential_ref.as_deref() != Some(old_reference.as_str()) {
            forget_credential_value(state.inner(), &old_reference)?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn opds_list_sources(app: AppHandle) -> Result<Vec<OpdsSource>, RemoteError> {
    library::library_list_sources(app)
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))
}

#[tauri::command]
pub fn opds_remove_source(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
) -> Result<(), RemoteError> {
    let source = load_source(&app, &source_id)?;
    library::library_remove_source(app, source_id)
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    if let Some(credential_ref) = source.credential_ref {
        forget_credential_value(state.inner(), &credential_ref)?;
    }
    Ok(())
}

async fn browse_url(
    app: &AppHandle,
    state: &RemoteState,
    source: &OpdsSource,
    url: &str,
) -> Result<OpdsFeed, RemoteError> {
    let source_url = validate_remote_url(&source.url, source.allow_http)?;
    let target_url = validate_remote_url(url, source.allow_http)?;
    let credential_ref = same_origin(&source_url, &target_url)
        .then_some(source.credential_ref.as_deref())
        .flatten();
    let (final_url, body) = fetch_remote_text(
        state,
        target_url.as_str(),
        source.allow_http,
        credential_ref,
        MAX_OPDS_FEED_BYTES,
    )
    .await?;
    let mut feed = parse_catalog(&body, &final_url)?;
    for entry in &mut feed.entries {
        entry.item_id = Some(item_id(&source.id, &entry.id));
    }
    persist_feed(app, &source.id, &feed)?;
    Ok(feed)
}

#[tauri::command]
pub async fn opds_browse(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
    url: Option<String>,
) -> Result<OpdsFeed, RemoteError> {
    let source = load_source(&app, &source_id)?;
    let url = url.unwrap_or_else(|| source.url.clone());
    browse_url(&app, &state, &source, &url).await
}

#[tauri::command]
pub async fn opds_search(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
    query: String,
) -> Result<OpdsFeed, RemoteError> {
    if query.trim().is_empty() {
        return Err(RemoteError::new("OPDS_SEARCH_INVALID", "搜索词不能为空"));
    }
    let source = load_source(&app, &source_id)?;
    let root = browse_url(&app, &state, &source, &source.url).await?;
    let template = root
        .search_template
        .ok_or_else(|| RemoteError::new("OPDS_SEARCH_UNSUPPORTED", "该 OPDS 源未提供搜索模板"))?;
    let url = expand_search_template(&template, &query)?;
    browse_url(&app, &state, &source, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <id>catalog</id><title>测试书库</title><updated>2026-01-01</updated>
        <link rel="next" href="?page=2" />
        <link rel="search" href="search?q={searchTerms}" type="application/atom+xml" />
        <entry><id>book-1</id><title>Book 10</title><author><name>Alice</name></author>
          <link rel="http://opds-spec.org/acquisition" href="books/a.cbz" type="application/vnd.comicbook+zip" length="123" />
          <link rel="http://opds-spec.org/image" href="covers/a.jpg" type="image/jpeg" />
        </entry>
      </feed>"#;

    #[test]
    fn parses_relative_links_pagination_search_and_cover() {
        let base = Url::parse("https://example.test/opds/index.xml").unwrap();
        let feed = parse_opds_feed(FEED, &base).unwrap();
        assert_eq!(feed.title, "测试书库");
        assert_eq!(
            feed.next_url.as_deref(),
            Some("https://example.test/opds/index.xml?page=2")
        );
        assert_eq!(
            feed.search_template.as_deref(),
            Some("https://example.test/opds/search?q={searchTerms}")
        );
        assert_eq!(feed.entries[0].authors, vec!["Alice"]);
        assert_eq!(
            feed.entries[0].cover_url.as_deref(),
            Some("https://example.test/opds/covers/a.jpg")
        );
        assert!(feed.entries[0].links[0].acquisition);
        assert_eq!(feed.entries[0].links[0].extension.as_deref(), Some("cbz"));
    }

    #[test]
    fn rejects_doctype_and_malformed_documents() {
        let base = Url::parse("https://example.test/opds").unwrap();
        assert_eq!(
            parse_opds_feed("<!DOCTYPE feed><feed><title>x</title></feed>", &base)
                .unwrap_err()
                .code,
            "OPDS_XML_UNSAFE"
        );
        assert!(parse_opds_feed("<feed><title>x</feed>", &base).is_err());
    }

    #[test]
    fn ignores_executable_markup_as_structure() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>safe</title><entry><id>1</id><title>book</title><summary>&lt;script&gt;alert(1)&lt;/script&gt;</summary></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(
            feed.entries[0].summary.as_deref(),
            Some("<script>alert(1)</script>")
        );
    }

    #[test]
    fn joins_text_entities_numeric_references_and_cdata() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>Rock &amp; Roll &#x1F4DA;</title><entry><id>b&#49;</id><title><![CDATA[A < B]]></title><summary>one &lt; two &apos;x&apos; &quot;y&quot;</summary><content>fallback</content></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(feed.title, "Rock & Roll 📚");
        assert_eq!(feed.entries[0].id, "b1");
        assert_eq!(feed.entries[0].title, "A < B");
        assert_eq!(
            feed.entries[0].summary.as_deref(),
            Some("one < two 'x' \"y\"")
        );
    }

    #[test]
    fn rejects_unknown_and_invalid_character_references() {
        let base = Url::parse("https://example.test/opds").unwrap();
        for xml in [
            "<feed><title>&custom;</title></feed>",
            "<feed><title>&#x110000;</title></feed>",
        ] {
            assert_eq!(
                parse_opds_feed(xml, &base).unwrap_err().code,
                "OPDS_XML_INVALID"
            );
        }
    }

    #[test]
    fn flattens_xhtml_summary_without_active_markup() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>safe</title><entry><id>1</id><title><b>book</b></title><summary type=\"xhtml\"><div>Safe <b>text</b><script>alert(1)</script> tail</div></summary></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(feed.entries[0].title, "book");
        assert_eq!(feed.entries[0].summary.as_deref(), Some("Safe text tail"));
    }

    #[test]
    fn rejects_non_http_links_before_they_reach_the_webview() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let error = parse_opds_feed(
            "<feed><title>safe</title><link rel=\"next\" href=\"file:///tmp/feed.xml\" /></feed>",
            &base,
        )
        .unwrap_err();
        assert_eq!(error.code, "OPDS_LINK_INVALID");

        let downgrade = parse_opds_feed(
            "<feed><title>safe</title><link rel=\"next\" href=\"http://example.test/feed.xml\" /></feed>",
            &base,
        )
        .unwrap_err();
        assert_eq!(downgrade.code, "OPDS_LINK_INVALID");
    }

    const JSON_FEED: &str = r#"{
      "metadata": {"title": "测试书库", "modified": "2026-01-01T00:00:00Z"},
      "links": [
        {"rel": "self", "href": "https://example.test/opds", "type": "application/opds+json"},
        {"rel": "next", "href": "?page=2", "type": "application/opds+json"},
        {"rel": ["first", "previous"], "href": "?page=1", "type": "application/opds+json"},
        {"rel": "search", "href": "search{?query}", "type": "application/opds+json", "templated": true}
      ],
      "publications": [
        {
          "metadata": {
            "title": "Book 10",
            "author": {"name": "Alice"},
            "identifier": "book-1",
            "modified": "2026-01-01T00:00:00Z",
            "description": "A comic"
          },
          "links": [
            {"rel": "self", "href": "pub.json", "type": "application/opds-publication+json"},
            {"rel": "download", "href": "books/a.cbz", "type": "application/vnd.comicbook+zip"}
          ],
          "images": [
            {"href": "covers/a.jpg", "type": "image/jpeg"}
          ]
        }
      ]
    }"#;

    #[test]
    fn parses_opds2_json_publications_pagination_search_and_cover() {
        let base = Url::parse("https://example.test/opds/index.json").unwrap();
        let feed = parse_catalog(JSON_FEED, &base).unwrap();
        assert_eq!(feed.title, "测试书库");
        assert_eq!(
            feed.next_url.as_deref(),
            Some("https://example.test/opds/index.json?page=2")
        );
        assert_eq!(
            feed.previous_url.as_deref(),
            Some("https://example.test/opds/index.json?page=1")
        );
        assert_eq!(
            feed.search_template.as_deref(),
            Some("https://example.test/opds/search{?query}")
        );
        assert_eq!(feed.entries[0].id, "book-1");
        assert_eq!(feed.entries[0].authors, vec!["Alice"]);
        assert_eq!(
            feed.entries[0].cover_url.as_deref(),
            Some("https://example.test/opds/covers/a.jpg")
        );
        assert!(feed.entries[0].links.iter().any(|link| link.acquisition));
        assert_eq!(
            feed.entries[0]
                .links
                .iter()
                .find(|link| link.acquisition)
                .and_then(|link| link.extension.as_deref()),
            Some("cbz")
        );
    }

    #[test]
    fn maps_opds2_navigation_and_groups_to_entries() {
        let base = Url::parse("https://example.test/opds/").unwrap();
        let feed = parse_catalog(
            r#"{
              "metadata": {"title": "目录"},
              "links": [{"rel": "self", "href": "/", "type": "application/opds+json"}],
              "groups": [
                {
                  "metadata": {"title": "Main"},
                  "navigation": [
                    {"href": "new", "title": "新书", "type": "application/opds+json"}
                  ]
                },
                {
                  "metadata": {"title": "Featured"},
                  "publications": [
                    {
                      "metadata": {"title": {"en": "Moby-Dick", "zh": "白鲸"}, "author": ["Herman", {"name": "Melville"}]},
                      "links": [
                        {"rel": "http://opds-spec.org/acquisition", "href": "moby.epub", "type": "application/epub+zip"}
                      ]
                    }
                  ]
                }
              ]
            }"#,
            &base,
        )
        .unwrap();
        assert_eq!(feed.entries.len(), 2);
        assert_eq!(feed.entries[0].title, "新书");
        assert_eq!(feed.entries[0].id, "https://example.test/opds/new");
        assert!(!feed.entries[0].links[0].acquisition);
        assert_eq!(feed.entries[1].title, "Moby-Dick");
        assert_eq!(feed.entries[1].authors, vec!["Herman", "Melville"]);
        assert!(feed.entries[1].links[0].acquisition);
    }

    #[test]
    fn catalog_keeps_atom_path_when_body_is_not_json() {
        let base = Url::parse("https://example.test/opds/index.xml").unwrap();
        let feed = parse_catalog(FEED, &base).unwrap();
        assert_eq!(feed.title, "测试书库");
        assert_eq!(
            feed.search_template.as_deref(),
            Some("https://example.test/opds/search?q={searchTerms}")
        );
        assert!(feed.entries[0].links[0].acquisition);
    }

    #[test]
    fn rejects_invalid_opds2_json_without_using_atom_codes() {
        let base = Url::parse("https://example.test/opds").unwrap();
        assert_eq!(
            parse_catalog("{not-json", &base).unwrap_err().code,
            "OPDS_JSON_INVALID"
        );
        assert_eq!(
            parse_catalog(r#"{"title":"not a catalog"}"#, &base)
                .unwrap_err()
                .code,
            "OPDS_JSON_INVALID"
        );
        assert_eq!(
            parse_catalog(r#"{"metadata":{},"publications":[]}"#, &base)
                .unwrap_err()
                .code,
            "OPDS_FEED_INVALID"
        );
    }

    #[test]
    fn rejects_non_http_and_https_downgrade_in_opds2_links() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let error = parse_catalog(
            r#"{"metadata":{"title":"safe"},"links":[{"rel":"next","href":"file:///tmp/feed.json"}],"publications":[]}"#,
            &base,
        )
        .unwrap_err();
        assert_eq!(error.code, "OPDS_LINK_INVALID");

        let downgrade = parse_catalog(
            r#"{"metadata":{"title":"safe"},"links":[{"rel":"next","href":"http://example.test/feed.json"}],"publications":[]}"#,
            &base,
        )
        .unwrap_err();
        assert_eq!(downgrade.code, "OPDS_LINK_INVALID");
    }

    #[test]
    fn expands_opensearch_and_opds2_search_templates() {
        assert_eq!(
            expand_search_template("https://example.test/search?q={searchTerms}", "三体").unwrap(),
            "https://example.test/search?q=%E4%B8%89%E4%BD%93"
        );
        assert_eq!(
            expand_search_template("https://example.test/search{?query,title}", "三体").unwrap(),
            "https://example.test/search?query=%E4%B8%89%E4%BD%93"
        );
        assert_eq!(
            expand_search_template("https://example.test/find?q={query}", "a b").unwrap(),
            "https://example.test/find?q=a+b"
        );
    }
}
