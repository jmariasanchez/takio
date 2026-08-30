use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::conversion::{FormatId, detect_format};
use crate::model::{BookAuthor, LibraryPatch, Patch};
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;
use crate::store::LibraryStore;

const MAX_CUSTOM_FIELDS_PER_BOOK: usize = 64;
const MAX_CUSTOM_VALUE_BYTES: usize = 16 * 1024;

#[derive(Debug)]
struct CalibreFormat {
    format: FormatId,
    path: PathBuf,
}

#[derive(Debug)]
struct CalibreBook {
    title: String,
    authors: Vec<BookAuthor>,
    series: Option<String>,
    series_index: Option<f64>,
    publisher: Option<String>,
    published_date: Option<String>,
    rating: Option<f64>,
    identifiers: BTreeMap<String, String>,
    languages: Vec<String>,
    tags: Vec<String>,
    description: Option<String>,
    custom_metadata: BTreeMap<String, String>,
    formats: Vec<CalibreFormat>,
    cover_path: Option<PathBuf>,
}

pub fn import_calibre_library(paths: LibraryPaths, library_root: &Path) -> AppResult<Value> {
    let root = validate_root(library_root)?;
    let database_path = root
        .join("metadata.db")
        .canonicalize()
        .map_err(|_| AppError::new("unreadable"))?;
    validate_destination(&paths, &root, &database_path)?;
    let (_snapshot, database) = open_database(&database_path)?;
    let books = read_books(&database, &root).map_err(|_| AppError::new("storage-unavailable"))?;
    drop(database);
    let mut store = LibraryStore::open(paths, true)?;
    let original_ids = store
        .list(true)?
        .into_iter()
        .map(|item| item.id)
        .collect::<std::collections::HashSet<_>>();
    let mut outcomes = Vec::with_capacity(books.len());

    for book in books {
        let primary = &book.formats[0];
        match fs::symlink_metadata(&primary.path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                outcomes.push(
                    json!({"status":"skipped","sourcePath":primary.path,"reason":"symbolic-link"}),
                );
                continue;
            }
            Ok(metadata) if !metadata.is_file() => {
                outcomes.push(json!({"status":"skipped","sourcePath":primary.path,"reason":"unsupported-file-type"}));
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                outcomes.push(json!({
                    "status":"failed",
                    "sourcePath":primary.path,
                    "code":if error.kind()==std::io::ErrorKind::NotFound{"not-found"}else{"unreadable"}
                }));
                continue;
            }
        }
        if let Some(existing) = store.find_managed_duplicate(&primary.path)? {
            let reason = if original_ids.contains(&existing.id) {
                "existing-library"
            } else {
                "earlier-in-request"
            };
            outcomes.push(json!({
                "status":"duplicate",
                "sourcePath":primary.path,
                "existing":{"itemId":existing.id,"format":primary.format},
                "reason":reason
            }));
            continue;
        }

        let mut item = match store.import(&primary.path, None, false) {
            Ok(item) => item,
            Err(error) => {
                outcomes.push(json!({
                    "status":"failed",
                    "sourcePath":primary.path,
                    "code":import_failure_code(error.code())
                }));
                continue;
            }
        };
        for extra in &book.formats[1..] {
            if let Ok(attached) = store.attach_format(&item.id, &extra.path, true) {
                item = attached;
            }
        }
        if let Ok(updated) = store.update(&item.id, patch_for(&book)) {
            item = updated;
        }
        if let Some(cover) = &book.cover_path
            && let Ok(covered) = store.set_cover(&item.id, cover)
        {
            item = covered;
        }
        outcomes.push(json!({"status":"imported","sourcePath":primary.path,"item":item}));
    }

    let count = |status: &str| {
        outcomes
            .iter()
            .filter(|outcome| outcome["status"] == status)
            .count()
    };
    Ok(json!({
        "outcomes":outcomes,
        "counts":{
            "total":outcomes.len(),
            "imported":count("imported"),
            "skipped":count("skipped"),
            "duplicates":count("duplicate"),
            "failed":count("failed")
        }
    }))
}

fn validate_root(root: &Path) -> AppResult<PathBuf> {
    if root.as_os_str().is_empty() {
        return Err(AppError::new("invalid-arguments"));
    }
    let metadata = fs::symlink_metadata(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new("not-found")
        } else {
            AppError::new("unreadable")
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::new("not-found"));
    }
    let root = root
        .canonicalize()
        .map_err(|_| AppError::new("unreadable"))?;
    let database = root.join("metadata.db");
    let metadata = fs::symlink_metadata(&database).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new("not-found")
        } else {
            AppError::new("unreadable")
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new("unreadable"));
    }
    Ok(root)
}

fn open_database(path: &Path) -> AppResult<(tempfile::TempDir, Connection)> {
    let source = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| AppError::new("unreadable"))?;
    source
        .pragma_update(None, "query_only", "ON")
        .map_err(|_| AppError::new("unreadable"))?;
    source
        .busy_timeout(std::time::Duration::from_millis(250))
        .map_err(|_| AppError::new("unreadable"))?;
    source
        .pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))
        .map_err(|_| AppError::new("unreadable"))?;

    let snapshot = tempfile::tempdir().map_err(|_| AppError::new("storage-unavailable"))?;
    let snapshot_path = snapshot.path().join("metadata.db");
    let mut database = Connection::open(&snapshot_path).map_err(|_| AppError::new("unreadable"))?;
    let backup = rusqlite::backup::Backup::new(&source, &mut database)
        .map_err(|_| AppError::new("unreadable"))?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(5), None)
        .map_err(|_| AppError::new("unreadable"))?;
    drop(backup);
    drop(source);
    database
        .pragma_update(None, "query_only", "ON")
        .map_err(|_| AppError::new("unreadable"))?;
    Ok((snapshot, database))
}

fn validate_destination(paths: &LibraryPaths, root: &Path, database: &Path) -> AppResult<()> {
    let destination_root = resolve_for_creation(&paths.root)?;
    if destination_root == root || destination_root.starts_with(root) {
        return Err(AppError::new("invalid-arguments"));
    }
    if paths.database.exists() && same_file(&paths.database, database)? {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn resolve_for_creation(path: &Path) -> AppResult<PathBuf> {
    let normalized = normalize_absolute(path)?;
    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .ok_or_else(|| AppError::new("invalid-arguments"))?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|_| AppError::new("storage-unavailable"))?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn normalize_absolute(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::new("invalid-arguments"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Ok(normalized)
}

fn same_file(left: &Path, right: &Path) -> AppResult<bool> {
    same_file::is_same_file(left, right).map_err(|_| AppError::new("unreadable"))
}

fn read_books(database: &Connection, root: &Path) -> rusqlite::Result<Vec<CalibreBook>> {
    let authors = author_rows(database)?;
    let series = text_link_rows(database, "series", "books_series_link", "series", "name")?;
    let publishers = text_link_rows(
        database,
        "publishers",
        "books_publishers_link",
        "publisher",
        "name",
    )?;
    let tags = text_link_rows(database, "tags", "books_tags_link", "tag", "name")?;
    let languages = language_rows(database)?;
    let identifiers = identifier_rows(database)?;
    let comments = direct_text_rows(database, "comments", "text")?;
    let ratings = rating_rows(database)?;
    let formats = format_rows(database)?;
    let custom = custom_rows(database)?;
    let mut statement =
        database.prepare("SELECT id, title, path, series_index, pubdate FROM books ORDER BY id")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut books = Vec::new();
    for row in rows {
        let (id, title, relative, series_index, pubdate) = row?;
        let Some(book_dir) = safe_book_dir(root, Path::new(&relative)) else {
            continue;
        };
        let mut book_formats = Vec::new();
        for (format_name, name) in formats.get(&id).into_iter().flatten() {
            let leaf = format!("{name}.{}", format_name.to_lowercase());
            let leaf_path = Path::new(&leaf);
            if leaf_path.is_absolute()
                || leaf_path.components().count() != 1
                || !matches!(leaf_path.components().next(), Some(Component::Normal(_)))
            {
                continue;
            }
            let path = book_dir.join(leaf_path);
            if let Some(format) = detect_format(&path) {
                if book_formats.is_empty() {
                    book_formats.push(CalibreFormat { format, path });
                } else if let Some(path) = safe_existing_file(root, &path) {
                    book_formats.push(CalibreFormat { format, path });
                }
            }
        }
        if book_formats.is_empty() {
            continue;
        }
        let cover = safe_existing_file(root, &book_dir.join("cover.jpg"));
        books.push(CalibreBook {
            title,
            authors: authors.get(&id).cloned().unwrap_or_default(),
            series: first_text(&series, id),
            series_index,
            publisher: first_text(&publishers, id),
            published_date: pubdate.as_deref().and_then(normalize_date),
            rating: ratings.get(&id).copied().map(|value| value * 2.0),
            identifiers: identifiers.get(&id).cloned().unwrap_or_default(),
            languages: languages.get(&id).cloned().unwrap_or_default(),
            tags: tags.get(&id).cloned().unwrap_or_default(),
            description: first_text(&comments, id),
            custom_metadata: custom.get(&id).cloned().unwrap_or_default(),
            formats: book_formats,
            cover_path: cover,
        });
    }
    Ok(books)
}

fn safe_book_dir(root: &Path, relative: &Path) -> Option<PathBuf> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let candidate = root.join(relative);
    match fs::symlink_metadata(&candidate) {
        Ok(_) => safe_path(root, &candidate, true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(candidate),
        Err(_) => None,
    }
}

fn safe_existing_file(root: &Path, candidate: &Path) -> Option<PathBuf> {
    safe_path(root, candidate, false)
}

fn safe_path(root: &Path, candidate: &Path, directory: bool) -> Option<PathBuf> {
    let relative = candidate.strip_prefix(root).ok()?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return None;
        }
        current.push(component);
        let metadata = fs::symlink_metadata(&current).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
    }
    let metadata = fs::symlink_metadata(&current).ok()?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return None;
    }
    let canonical = current.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

fn author_rows(database: &Connection) -> rusqlite::Result<HashMap<i64, Vec<BookAuthor>>> {
    let mut statement = database.prepare(
        "SELECT l.book, a.name, a.sort FROM books_authors_link l JOIN authors a ON a.id=l.author ORDER BY l.book,l.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (book, name, sort_name) = row?;
        if let Some(name) = text(&name) {
            result
                .entry(book)
                .or_insert_with(Vec::new)
                .push(BookAuthor {
                    name,
                    sort_name: sort_name.as_deref().and_then(text),
                });
        }
    }
    Ok(result)
}

fn text_link_rows(
    database: &Connection,
    table: &str,
    link: &str,
    column: &str,
    value_column: &str,
) -> rusqlite::Result<HashMap<i64, Vec<String>>> {
    direct_query_rows(
        database,
        &format!(
            "SELECT l.book,t.{value_column} FROM {link} l JOIN {table} t ON t.id=l.{column} ORDER BY l.book,l.id"
        ),
    )
}

fn direct_text_rows(
    database: &Connection,
    table: &str,
    column: &str,
) -> rusqlite::Result<HashMap<i64, Vec<String>>> {
    direct_query_rows(
        database,
        &format!("SELECT book,{column} FROM {table} ORDER BY book"),
    )
}

fn direct_query_rows(
    database: &Connection,
    query: &str,
) -> rusqlite::Result<HashMap<i64, Vec<String>>> {
    let mut statement = database.prepare(query)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (book, value) = row?;
        if let Some(value) = text(&value) {
            let values = result.entry(book).or_insert_with(Vec::new);
            if !values.contains(&value) {
                values.push(value);
            }
        }
    }
    Ok(result)
}

fn language_rows(database: &Connection) -> rusqlite::Result<HashMap<i64, Vec<String>>> {
    let raw = direct_query_rows(
        database,
        "SELECT l.book,v.lang_code FROM books_languages_link l JOIN languages v ON v.id=l.lang_code ORDER BY l.book,l.item_order",
    )?;
    Ok(raw
        .into_iter()
        .map(|(book, values)| {
            let mut normalized = Vec::new();
            for value in values
                .into_iter()
                .filter_map(|value| normalize_language(&value))
            {
                if !normalized
                    .iter()
                    .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
                {
                    normalized.push(value);
                }
            }
            (book, normalized)
        })
        .collect())
}

fn identifier_rows(
    database: &Connection,
) -> rusqlite::Result<HashMap<i64, BTreeMap<String, String>>> {
    let mut statement =
        database.prepare("SELECT book,type,val FROM identifiers ORDER BY book,type,val")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (book, key, value) = row?;
        if let (Some(key), Some(value)) = (text(&key), text(&value)) {
            result
                .entry(book)
                .or_insert_with(BTreeMap::new)
                .insert(key, value);
        }
    }
    Ok(result)
}

fn rating_rows(database: &Connection) -> rusqlite::Result<HashMap<i64, f64>> {
    let mut statement = database.prepare("SELECT l.book,r.rating FROM books_ratings_link l JOIN ratings r ON r.id=l.rating ORDER BY l.book,l.id")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))?;
    rows.collect()
}

fn format_rows(database: &Connection) -> rusqlite::Result<HashMap<i64, Vec<(String, String)>>> {
    let mut statement =
        database.prepare("SELECT book,format,name FROM data ORDER BY book,format,id")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (book, format, name) = row?;
        result
            .entry(book)
            .or_insert_with(Vec::new)
            .push((format, name));
    }
    Ok(result)
}

fn custom_rows(database: &Connection) -> rusqlite::Result<HashMap<i64, BTreeMap<String, String>>> {
    let mut result = HashMap::new();
    let mut statement = database.prepare("SELECT name,label FROM custom_columns ORDER BY label")?;
    let columns = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let safe_table = Regex::new(r"^custom_column_\d+$").expect("valid regex");
    let safe_key = Regex::new(r"^[a-z][a-z0-9_]{0,63}$").expect("valid regex");
    for column in columns {
        let (table, label) = column?;
        if !safe_table.is_match(&table) {
            continue;
        }
        let key: String = label
            .trim_start_matches('#')
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '_' {
                    character.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .take(64)
            .collect();
        if !safe_key.is_match(&key) {
            continue;
        }
        let mut values =
            match database.prepare(&format!("SELECT book,value FROM {table} ORDER BY book,id")) {
                Ok(values) => values,
                Err(_) => continue,
            };
        let rows = values.query_map([], |row| {
            let book = row.get::<_, i64>(0)?;
            let value = row.get_ref(1)?;
            let value = match value {
                rusqlite::types::ValueRef::Null => String::new(),
                rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                rusqlite::types::ValueRef::Real(value) => value.to_string(),
                rusqlite::types::ValueRef::Text(value) if value.len() <= MAX_CUSTOM_VALUE_BYTES => {
                    String::from_utf8_lossy(value).into_owned()
                }
                rusqlite::types::ValueRef::Text(_) => return Ok((book, None)),
                rusqlite::types::ValueRef::Blob(_) => return Ok((book, None)),
            };
            Ok((
                book,
                (value.len() <= MAX_CUSTOM_VALUE_BYTES)
                    .then(|| maybe_json(&value))
                    .filter(|value| {
                        value.len() <= MAX_CUSTOM_VALUE_BYTES && !value.trim().is_empty()
                    }),
            ))
        })?;
        for row in rows {
            let (book, value) = row?;
            if let Some(value) = value {
                let fields = result.entry(book).or_insert_with(BTreeMap::new);
                if fields.len() < MAX_CUSTOM_FIELDS_PER_BOOK || fields.contains_key(&key) {
                    fields.insert(key.clone(), value);
                }
            }
        }
    }
    Ok(result)
}

fn patch_for(book: &CalibreBook) -> LibraryPatch {
    fn set<T>(value: Option<T>) -> Patch<T> {
        value.map_or(Patch::Missing, Patch::Set)
    }
    LibraryPatch {
        title: Patch::Set(book.title.clone()),
        author: set(book.authors.first().map(|author| author.name.clone())),
        authors: set((!book.authors.is_empty()).then(|| book.authors.clone())),
        series: set(book.series.clone()),
        series_index: set(book.series_index),
        publisher: set(book.publisher.clone()),
        languages: set((!book.languages.is_empty()).then(|| book.languages.clone())),
        identifiers: set((!book.identifiers.is_empty()).then(|| book.identifiers.clone())),
        custom_metadata: set(
            (!book.custom_metadata.is_empty()).then(|| book.custom_metadata.clone())
        ),
        published_date: set(book.published_date.clone()),
        rating: set(book
            .rating
            .filter(|rating| rating.is_finite() && (0.0..=10.0).contains(rating))),
        description: set(book.description.clone()),
        tags: Patch::Set(book.tags.clone()),
    }
}

fn first_text(values: &HashMap<i64, Vec<String>>, book: i64) -> Option<String> {
    values.get(&book).and_then(|values| values.first()).cloned()
}

fn text(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_date(value: &str) -> Option<String> {
    let captures = Regex::new(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?")
        .expect("valid regex")
        .captures(value)?;
    Some(
        [captures.get(1), captures.get(2), captures.get(3)]
            .into_iter()
            .flatten()
            .map(|capture| capture.as_str())
            .collect::<Vec<_>>()
            .join("-"),
    )
}

fn normalize_language(value: &str) -> Option<String> {
    let value = text(value)?.replace('_', "-");
    Regex::new(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
        .expect("valid regex")
        .is_match(&value)
        .then_some(value)
}

fn maybe_json(value: &str) -> String {
    serde_json::from_str::<Value>(value).map_or_else(
        |_| value.to_owned(),
        |parsed| match parsed {
            Value::String(value) => value,
            other => other.to_string(),
        },
    )
}

fn import_failure_code(code: &str) -> &'static str {
    match code {
        "not-found" => "not-found",
        "source-changed" => "source-changed",
        "cross-device-move" => "cross-device-move",
        "storage-unavailable" => "storage-unavailable",
        "invalid-title" => "invalid-title",
        _ => "unreadable",
    }
}

#[cfg(test)]
mod tests {
    use super::{maybe_json, normalize_date, normalize_language};

    #[test]
    fn normalizes_legacy_date_language_and_custom_json_values() {
        assert_eq!(
            normalize_date("2020-05-02 00:00:00+00:00").as_deref(),
            Some("2020-05-02")
        );
        assert_eq!(normalize_language("pt_BR").as_deref(), Some("pt-BR"));
        assert_eq!(normalize_language("english"), None);
        assert_eq!(maybe_json(r#"{"ready":true}"#), r#"{"ready":true}"#);
        assert_eq!(maybe_json(r#""planned""#), "planned");
    }
}
