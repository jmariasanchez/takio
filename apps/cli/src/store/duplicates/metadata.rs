//! Duplicate-merge metadata contract and persistence within the caller's transaction.
use std::collections::BTreeMap;

use rusqlite::{Transaction, params};
use serde_json::{Map, Value};

use crate::model::{BookAuthor, LibraryItem};
use crate::output::{AppError, AppResult};
use crate::store::metadata::{
    METADATA_AUDIT_KEY, normalize_authors, normalize_custom_metadata, normalize_identifiers,
    normalize_languages, normalize_published_date, normalize_texts, replace_metadata,
};

pub(super) fn apply_duplicate_metadata(item: &mut LibraryItem, metadata: &Value) -> AppResult<()> {
    let object = metadata
        .as_object()
        .filter(|object| !object.is_empty())
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    const FIELDS: &[&str] = &[
        "title",
        "author",
        "authors",
        "series",
        "seriesIndex",
        "publisher",
        "languages",
        "identifiers",
        "customMetadata",
        "publishedDate",
        "rating",
        "description",
        "tags",
    ];
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(AppError::new("invalid-arguments"));
    }
    if let Some(value) = object.get("title") {
        let title = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        item.title = title.to_owned();
    }
    apply_nullable_text(object, "author", &mut item.author)?;
    if let Some(value) = object.get("authors") {
        item.authors = if value.is_null() {
            Vec::new()
        } else {
            let authors = serde_json::from_value::<Vec<BookAuthor>>(value.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            if authors.is_empty() {
                return Err(AppError::new("invalid-arguments"));
            }
            normalize_authors(authors)?
        };
        item.author = (!item.authors.is_empty()).then(|| {
            item.authors
                .iter()
                .map(|author| author.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        });
    }
    apply_nullable_text(object, "series", &mut item.series)?;
    if let Some(value) = object.get("seriesIndex") {
        item.series_index = if value.is_null() {
            None
        } else {
            Some(
                value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
        };
    }
    apply_nullable_text(object, "publisher", &mut item.publisher)?;
    if let Some(value) = object.get("languages") {
        item.languages = if value.is_null() {
            Vec::new()
        } else {
            let languages = serde_json::from_value::<Vec<String>>(value.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            if languages.is_empty() {
                return Err(AppError::new("invalid-arguments"));
            }
            normalize_languages(languages)?
        };
    }
    if let Some(value) = object.get("identifiers") {
        item.identifiers = if value.is_null() {
            BTreeMap::new()
        } else {
            normalize_identifiers(
                serde_json::from_value(value.clone())
                    .map_err(|_| AppError::new("invalid-arguments"))?,
            )?
        };
    }
    if let Some(value) = object.get("customMetadata") {
        let audit = item.custom_metadata.get(METADATA_AUDIT_KEY).cloned();
        let mut metadata = if value.is_null() {
            BTreeMap::new()
        } else {
            let metadata: BTreeMap<String, String> = serde_json::from_value(value.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            if metadata.contains_key(METADATA_AUDIT_KEY) {
                return Err(AppError::new("invalid-arguments"));
            }
            normalize_custom_metadata(metadata)?
        };
        if let Some(audit) = audit {
            metadata.insert(METADATA_AUDIT_KEY.to_owned(), audit);
        }
        item.custom_metadata = metadata;
    }
    if let Some(value) = object.get("publishedDate") {
        item.published_date = if value.is_null() {
            None
        } else {
            Some(normalize_published_date(
                value
                    .as_str()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?
                    .to_owned(),
            )?)
        };
    }
    if let Some(value) = object.get("rating") {
        item.rating = if value.is_null() {
            None
        } else {
            Some(
                value
                    .as_f64()
                    .filter(|value| value.is_finite() && (0.0..=10.0).contains(value))
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
        };
    }
    apply_nullable_text(object, "description", &mut item.description)?;
    if let Some(value) = object.get("tags") {
        item.tags = normalize_texts(
            serde_json::from_value(value.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?,
        )?;
    }
    Ok(())
}

fn apply_nullable_text(
    object: &Map<String, Value>,
    key: &str,
    target: &mut Option<String>,
) -> AppResult<()> {
    if let Some(value) = object.get(key) {
        *target = if value.is_null() {
            None
        } else {
            let text = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            Some(text.to_owned())
        };
    }
    Ok(())
}

pub(super) fn write_duplicate_metadata(
    transaction: &Transaction<'_>,
    item: &LibraryItem,
) -> AppResult<()> {
    transaction.execute(
        "UPDATE library_items SET title=?2,author=?3,series=?4,series_index=?5,publisher=?6,
         published_date=?7,rating=?8,description=?9,updated_at=?10 WHERE id=?1",
        params![
            item.id,
            item.title,
            item.author,
            item.series,
            item.series_index,
            item.publisher,
            item.published_date,
            item.rating,
            item.description,
            item.updated_at
        ],
    )?;
    replace_metadata(transaction, item)
}
