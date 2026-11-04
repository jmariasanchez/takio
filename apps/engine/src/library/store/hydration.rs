//! Reconstruct catalogue records from normalized SQLite tables.
//!
//! Callers supply the connection or transaction that owns their read snapshot.
//! This module neither selects catalogue membership nor retains cached records.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use rusqlite::{Connection, params_from_iter};

use crate::error::AppResult;
use crate::model::{BookAuthor, BookFormat, LibraryItem, Provenance};

pub(super) fn read_item_from(connection: &Connection, id: &str) -> AppResult<Option<LibraryItem>> {
    let mut items = read_items_bulk(connection, std::slice::from_ref(&id.to_owned()))?;
    Ok(items.pop())
}

pub(super) fn read_items_required(
    connection: &Connection,
    ids: &[String],
) -> AppResult<Vec<LibraryItem>> {
    let items = read_items_bulk(connection, ids)?;
    if items.len() != ids.len() {
        return Err(crate::app_error!("invalid-stored-data"));
    }
    Ok(items)
}

/// Hydrate many items with one query per child table instead of seven
/// queries per item. Output order matches `ids`. Missing ids are skipped.
pub(super) fn read_items_bulk(
    connection: &Connection,
    ids: &[String],
) -> AppResult<Vec<LibraryItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Large libraries exceed SQLite's bound-parameter limit, so hydrate in
    // chunks and concatenate; order within and across chunks is preserved.
    const CHUNK: usize = 500;
    if ids.len() > CHUNK {
        let mut all = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(CHUNK) {
            all.extend(read_items_bulk(connection, chunk)?);
        }
        return Ok(all);
    }
    let placeholders = (1..=ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");

    let mut bases: HashMap<String, BaseRow> = HashMap::with_capacity(ids.len());
    {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT id, title, added_at, author, series, series_index, publisher, published_date,
             rating, description, cover_path, updated_at FROM library_items WHERE id IN ({placeholders})"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                BaseRow {
                    title: row.get(1)?,
                    added_at: row.get(2)?,
                    author: row.get(3)?,
                    series: row.get(4)?,
                    series_index: row.get(5)?,
                    publisher: row.get(6)?,
                    published_date: row.get(7)?,
                    rating: row.get(8)?,
                    description: row.get(9)?,
                    cover_path: row.get::<_, Option<String>>(10)?.map(PathBuf::from),
                    updated_at: row.get(11)?,
                },
            ))
        })?;
        for row in rows {
            let (id, base) = row?;
            bases.insert(id, base);
        }
    }

    let mut formats: HashMap<String, Vec<BookFormat>> = HashMap::new();
    {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT library_item_id, format, source_path, added_at, provenance FROM library_item_formats
             WHERE library_item_id IN ({placeholders}) ORDER BY library_item_id, position"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (id, format, path, added_at, provenance) = row?;
            let provenance = match provenance.as_str() {
                "managed" => Provenance::Managed,
                "referenced" => Provenance::Referenced,
                _ => return Err(crate::app_error!("invalid-stored-data")),
            };
            formats.entry(id).or_default().push(BookFormat {
                source_path: PathBuf::from(path),
                format: format
                    .parse()
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?,
                added_at,
                provenance,
            });
        }
    }

    let mut authors: HashMap<String, Vec<BookAuthor>> = HashMap::new();
    {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT library_item_id, name, sort_name FROM library_item_authors
             WHERE library_item_id IN ({placeholders}) ORDER BY library_item_id, position"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                BookAuthor {
                    name: row.get(1)?,
                    sort_name: row.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (id, author) = row?;
            authors.entry(id).or_default().push(author);
        }
    }

    let mut languages: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT library_item_id, language FROM library_item_languages
             WHERE library_item_id IN ({placeholders}) ORDER BY library_item_id, position"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, value) = row?;
            languages.entry(id).or_default().push(value);
        }
    }

    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT it.library_item_id, t.name FROM library_item_tags it
             JOIN tags t ON t.normalized_name=it.tag_normalized_name
             WHERE it.library_item_id IN ({placeholders}) ORDER BY it.library_item_id, it.position"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, value) = row?;
            tags.entry(id).or_default().push(value);
        }
    }

    let mut identifiers: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut custom: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    for (table, key, target) in [
        ("library_item_identifiers", "scheme", &mut identifiers),
        ("library_item_custom_metadata", "name", &mut custom),
    ] {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT library_item_id, {key}, value FROM {table}
             WHERE library_item_id IN ({placeholders})"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, key, value) = row?;
            target.entry(id).or_default().insert(key, value);
        }
    }

    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(base) = bases.remove(id) else {
            continue;
        };
        let formats = formats.remove(id).unwrap_or_default();
        let primary = formats
            .first()
            .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
        items.push(LibraryItem {
            id: id.clone(),
            title: base.title,
            source_path: primary.source_path.clone(),
            format: primary.format,
            added_at: base.added_at,
            author: base.author,
            authors: authors.remove(id).unwrap_or_default(),
            series: base.series,
            series_index: base.series_index,
            publisher: base.publisher,
            languages: languages.remove(id).unwrap_or_default(),
            identifiers: identifiers.remove(id).unwrap_or_default(),
            custom_metadata: custom.remove(id).unwrap_or_default(),
            published_date: base.published_date,
            rating: base.rating,
            description: base.description,
            cover_path: base.cover_path,
            tags: tags.remove(id).unwrap_or_default(),
            updated_at: base.updated_at,
            formats,
        });
    }
    Ok(items)
}

struct BaseRow {
    title: String,
    added_at: String,
    author: Option<String>,
    series: Option<String>,
    series_index: Option<f64>,
    publisher: Option<String>,
    published_date: Option<String>,
    rating: Option<f64>,
    description: Option<String>,
    cover_path: Option<PathBuf>,
    updated_at: Option<String>,
}
