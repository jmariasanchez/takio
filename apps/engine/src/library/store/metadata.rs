//! Shared metadata normalization, patch validation and normalized-table persistence.
//! Callers retain ownership of transactions and publication/rollback decisions.
use std::collections::BTreeMap;

use chrono::NaiveDate;
use rusqlite::{Transaction, params};

use super::as_i64;
use crate::error::AppResult;
use crate::library::model::{BookAuthor, LibraryItem, LibraryPatch, Patch};

pub const METADATA_AUDIT_KEY: &str = "takio_metadata_audit";
const MAX_CUSTOM_METADATA_USER_ENTRIES: usize = 64;
const MAX_CUSTOM_METADATA_TOTAL_ENTRIES: usize = 65;
const MAX_CUSTOM_METADATA_VALUE_CHARS: usize = 16 * 1024;

pub(crate) fn validate_candidate_patch(patch: &LibraryPatch) -> AppResult<()> {
    validate_library_patch(patch, true)
}

pub(super) fn normalize_texts(values: Vec<String>) -> AppResult<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() || !seen.insert(value.to_lowercase()) {
            return Err(crate::app_error!("invalid-arguments"));
        }
        normalized.push(value);
    }
    Ok(normalized)
}
pub(super) fn normalize_authors(values: Vec<BookAuthor>) -> AppResult<Vec<BookAuthor>> {
    let mut output = Vec::new();
    for value in values {
        let name = value.name.trim();
        if name.is_empty() {
            return Err(crate::app_error!("invalid-arguments"));
        }
        let sort_name = match value.sort_name {
            Some(value) => Some(required_text(value)?),
            None => None,
        };
        output.push(BookAuthor {
            name: name.to_owned(),
            sort_name,
        });
    }
    Ok(output)
}

pub(super) fn validate_library_patch(
    patch: &LibraryPatch,
    allow_reserved_metadata: bool,
) -> AppResult<()> {
    if patch.is_empty() || matches!(patch.title, Patch::Null) || matches!(patch.tags, Patch::Null) {
        return Err(crate::app_error!("invalid-arguments"));
    }
    for value in [
        patch.title.value(),
        patch.series.value(),
        patch.publisher.value(),
        patch.description.value(),
    ]
    .into_iter()
    .flatten()
    {
        required_text(value.clone())?;
    }
    if let Patch::Set(values) = &patch.authors {
        if values.is_empty() {
            return Err(crate::app_error!("invalid-arguments"));
        }
        normalize_authors(values.clone())?;
    }
    if patch
        .series_index
        .value()
        .is_some_and(|value| !value.is_finite())
        || patch
            .rating
            .value()
            .is_some_and(|value| !value.is_finite() || !(0.0..=10.0).contains(value))
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    if let Patch::Set(values) = &patch.languages {
        if values.is_empty() {
            return Err(crate::app_error!("invalid-arguments"));
        }
        normalize_languages(values.clone())?;
    }
    if let Patch::Set(values) = &patch.identifiers {
        normalize_identifiers(values.clone())?;
    }
    if let Patch::Set(values) = &patch.custom_metadata {
        if !allow_reserved_metadata && values.contains_key(METADATA_AUDIT_KEY) {
            return Err(crate::app_error!("invalid-arguments"));
        }
        normalize_custom_metadata(values.clone())?;
    }
    if let Some(value) = patch.published_date.value() {
        normalize_published_date(value.clone())?;
    }
    if let Patch::Set(values) = &patch.tags {
        normalize_texts(values.clone())?;
    }
    Ok(())
}

pub(super) fn required_text(value: String) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        Err(crate::app_error!("invalid-arguments"))
    } else {
        Ok(value.to_owned())
    }
}

pub(super) fn normalize_languages(values: Vec<String>) -> AppResult<Vec<String>> {
    let values = normalize_texts(values)?;
    if values.iter().all(|value| valid_language_tag(value)) {
        Ok(values)
    } else {
        Err(crate::app_error!("invalid-arguments"))
    }
}

fn valid_language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    (2..=3).contains(&primary.len())
        && primary.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

pub(super) fn normalize_identifiers(
    values: BTreeMap<String, String>,
) -> AppResult<BTreeMap<String, String>> {
    values
        .into_iter()
        .map(|(key, value)| Ok((required_text(key)?, required_text(value)?)))
        .collect()
}

pub(crate) fn normalize_custom_metadata(
    values: BTreeMap<String, String>,
) -> AppResult<BTreeMap<String, String>> {
    let user_entries = values
        .keys()
        .filter(|key| key.as_str() != METADATA_AUDIT_KEY)
        .count();
    if user_entries > MAX_CUSTOM_METADATA_USER_ENTRIES
        || values.len() > MAX_CUSTOM_METADATA_TOTAL_ENTRIES
        || values.iter().any(|(key, value)| {
            !valid_custom_metadata_key(key)
                || value.encode_utf16().count() > MAX_CUSTOM_METADATA_VALUE_CHARS
        })
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(values)
}

pub(crate) fn user_custom_metadata(values: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    values
        .iter()
        .filter(|(key, _)| key.as_str() != METADATA_AUDIT_KEY)
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub(super) fn valid_custom_metadata_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

pub(super) fn normalize_published_date(value: String) -> AppResult<String> {
    let value = value.trim();
    let valid = match value.len() {
        4 => value.bytes().all(|byte| byte.is_ascii_digit()),
        7 => {
            value.as_bytes().get(4) == Some(&b'-')
                && value[..4].bytes().all(|byte| byte.is_ascii_digit())
                && value[5..]
                    .parse::<u32>()
                    .is_ok_and(|month| (1..=12).contains(&month))
        }
        10 => NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        _ => false,
    };
    if valid {
        Ok(value.to_owned())
    } else {
        Err(crate::app_error!("invalid-arguments"))
    }
}

pub(super) fn replace_metadata(transaction: &Transaction<'_>, item: &LibraryItem) -> AppResult<()> {
    for table in [
        "library_item_tags",
        "library_item_authors",
        "library_item_languages",
        "library_item_identifiers",
        "library_item_custom_metadata",
    ] {
        transaction.execute(
            &format!("DELETE FROM {table} WHERE library_item_id=?1"),
            [&item.id],
        )?;
    }
    for (position, tag) in item.tags.iter().enumerate() {
        let normalized = tag.to_lowercase();
        transaction.execute("INSERT INTO tags(normalized_name,name) VALUES(?1,?2) ON CONFLICT(normalized_name) DO UPDATE SET name=excluded.name", params![normalized,tag])?;
        transaction.execute("INSERT INTO library_item_tags(library_item_id,tag_normalized_name,position) VALUES(?1,?2,?3)", params![item.id,normalized,as_i64(position as u64)?])?;
    }
    for (position, author) in item.authors.iter().enumerate() {
        transaction.execute("INSERT INTO library_item_authors(library_item_id,name,sort_name,position) VALUES(?1,?2,?3,?4)", params![item.id,author.name,author.sort_name,as_i64(position as u64)?])?;
    }
    for (position, language) in item.languages.iter().enumerate() {
        transaction.execute("INSERT INTO library_item_languages(library_item_id,language,position) VALUES(?1,?2,?3)", params![item.id,language,as_i64(position as u64)?])?;
    }
    for (key, value) in &item.identifiers {
        transaction.execute(
            "INSERT INTO library_item_identifiers(library_item_id,scheme,value) VALUES(?1,?2,?3)",
            params![item.id, key, value],
        )?;
    }
    for (key, value) in &item.custom_metadata {
        transaction.execute(
            "INSERT INTO library_item_custom_metadata(library_item_id,name,value) VALUES(?1,?2,?3)",
            params![item.id, key, value],
        )?;
    }
    transaction.execute("DELETE FROM tags WHERE NOT EXISTS(SELECT 1 FROM library_item_tags WHERE tag_normalized_name=tags.normalized_name)", [])?;
    Ok(())
}
