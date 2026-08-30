use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::conversion::{FormatId, detect_format};
use crate::model::{BookAuthor, BookFormat, LibraryItem, LibraryPatch, Provenance};
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;

pub const LIBRARY_SCHEMA_VERSION: i64 = 10;

pub struct LibraryStore {
    connection: Connection,
    paths: LibraryPaths,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub schema_version: i64,
    pub sqlite_integrity: &'static str,
    pub active_items: u64,
    pub trashed_items: u64,
    pub managed_formats: u64,
    pub referenced_formats: u64,
    pub verified_managed_formats: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub destination_path: PathBuf,
    pub database_path: PathBuf,
    pub managed_files: u64,
}

impl LibraryStore {
    pub fn open(paths: LibraryPaths, create: bool) -> AppResult<Self> {
        if !create && !paths.database.is_file() {
            return Err(AppError::new("storage-unavailable"));
        }
        if create {
            fs::create_dir_all(&paths.root)?;
            fs::create_dir_all(&paths.items)?;
            fs::create_dir_all(&paths.covers)?;
        }
        let connection = Connection::open(&paths.database)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            if !create || has_schema(&connection)? {
                return Err(AppError::new("incompatible-schema"));
            }
            create_schema(&connection)?;
        } else if version != LIBRARY_SCHEMA_VERSION {
            return Err(AppError::new("incompatible-schema"));
        }
        Ok(Self { connection, paths })
    }

    #[must_use]
    pub fn paths(&self) -> &LibraryPaths {
        &self.paths
    }

    pub fn list(&self, include_trashed: bool) -> AppResult<Vec<LibraryItem>> {
        let filter = if include_trashed {
            ""
        } else {
            "WHERE trashed_at IS NULL"
        };
        let mut statement = self.connection.prepare(&format!(
            "SELECT id FROM library_items {filter} ORDER BY title COLLATE NOCASE, id"
        ))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| {
                self.read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))
            })
            .collect()
    }

    pub fn list_trash(&self) -> AppResult<Vec<LibraryItem>> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM library_items WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC, id",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| {
                self.read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> AppResult<Option<LibraryItem>> {
        if id.trim().is_empty() {
            return Err(AppError::new("invalid-arguments"));
        }
        self.read_item(id)
    }

    pub fn search(&self, query: &str) -> AppResult<Vec<LibraryItem>> {
        let needle = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT li.id FROM library_items li
             LEFT JOIN library_item_authors a ON a.library_item_id = li.id
             LEFT JOIN library_item_tags it ON it.library_item_id = li.id
             LEFT JOIN tags t ON t.normalized_name = it.tag_normalized_name
             WHERE li.trashed_at IS NULL AND (
               li.title LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               li.author LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               a.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               li.series LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               t.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE)
             ORDER BY li.title COLLATE NOCASE, li.id",
        )?;
        let ids = statement
            .query_map([needle], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| {
                self.read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))
            })
            .collect()
    }

    pub fn import(
        &mut self,
        source: &Path,
        title: Option<&str>,
        move_source: bool,
    ) -> AppResult<LibraryItem> {
        let source = canonical_file(source)?;
        let format = detect_format(&source).ok_or_else(|| AppError::new("unsupported-format"))?;
        let title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| title_from_path(&source));
        if title.is_empty() {
            return Err(AppError::new("invalid-title"));
        }
        let fingerprint = hash_file(&source)?;
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT library_item_id FROM library_item_formats
             WHERE provenance = 'managed' AND content_bytes = ?1 AND content_sha256 = ?2 LIMIT 1",
                params![as_i64(fingerprint.0)?, fingerprint.1],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return self
                .read_item(&id)?
                .ok_or_else(|| AppError::new("invalid-stored-data"));
        }

        let id = format!("book_{}", Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        let target = self.managed_path(&id, format);
        publish_copy(&source, &target, &fingerprint)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO library_items (id, title, added_at) VALUES (?1, ?2, ?3)",
            params![id, title, now],
        )?;
        transaction.execute(
            "INSERT INTO library_item_formats
             (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
             VALUES (?1, ?2, ?3, ?4, 'managed', 0, ?5, ?6)",
            params![id, format.as_str(), target.to_string_lossy(), now, as_i64(fingerprint.0)?, fingerprint.1],
        )?;
        transaction.commit()?;
        if move_source && fs::remove_file(&source).is_err() {
            self.connection.execute(
                "INSERT OR REPLACE INTO source_file_cleanup (source_path, content_bytes, content_sha256)
                 VALUES (?1, ?2, ?3)",
                params![source.to_string_lossy(), as_i64(fingerprint.0)?, fingerprint.1],
            )?;
        }
        self.read_item(&id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn attach_format(
        &mut self,
        id: &str,
        source: &Path,
        managed: bool,
    ) -> AppResult<LibraryItem> {
        let source = canonical_file(source)?;
        let format = detect_format(&source).ok_or_else(|| AppError::new("unsupported-format"))?;
        if self.read_item(id)?.is_none() {
            return Err(AppError::new("not-found"));
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_item_formats WHERE library_item_id = ?1 AND format = ?2)",
            params![id, format.as_str()],
            |row| row.get(0),
        )?;
        if exists {
            return Err(AppError::new("format-exists"));
        }
        let now = Utc::now().to_rfc3339();
        let position: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM library_item_formats WHERE library_item_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if managed {
            let fingerprint = hash_file(&source)?;
            let target = self.managed_path(id, format);
            publish_copy(&source, &target, &fingerprint)?;
            self.connection.execute(
                "INSERT INTO library_item_formats
                 (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
                 VALUES (?1, ?2, ?3, ?4, 'managed', ?5, ?6, ?7)",
                params![id, format.as_str(), target.to_string_lossy(), now, position, as_i64(fingerprint.0)?, fingerprint.1],
            )?;
        } else {
            self.connection.execute(
                "INSERT INTO library_item_formats
                 (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
                 VALUES (?1, ?2, ?3, ?4, 'referenced', ?5, NULL, NULL)",
                params![id, format.as_str(), source.to_string_lossy(), now, position],
            )?;
        }
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn remove_format(&mut self, id: &str, format: FormatId) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        if item.formats.len() <= 1 {
            return Err(AppError::new("last-format"));
        }
        let stored = self
            .stored_format(id, format)?
            .ok_or_else(|| AppError::new("format-not-found"))?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM library_item_formats WHERE library_item_id = ?1 AND format = ?2",
            params![id, format.as_str()],
        )?;
        transaction.execute(
            "UPDATE library_item_formats SET position = position - 1
             WHERE library_item_id = ?1 AND position > ?2",
            params![id, stored.position],
        )?;
        transaction.commit()?;
        if stored.provenance == Provenance::Managed {
            cleanup_managed(&self.paths.items, &stored.path, stored.fingerprint.as_ref())?;
        }
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn replace_format(
        &mut self,
        id: &str,
        format: FormatId,
        expected: &Value,
        source: &Path,
        managed: bool,
    ) -> AppResult<LibraryItem> {
        let current = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("format-changed"))?
            .formats
            .into_iter()
            .find(|candidate| candidate.format == format)
            .ok_or_else(|| AppError::new("format-changed"))?;
        if expected.get("sourcePath").and_then(Value::as_str) != current.source_path.to_str()
            || expected.get("addedAt").and_then(Value::as_str) != Some(&current.added_at)
            || expected.get("provenance").and_then(Value::as_str)
                != Some(current.provenance.as_str())
        {
            return Err(AppError::new("format-changed"));
        }
        let source = canonical_file(source)?;
        if detect_format(&source) != Some(format) {
            return Err(AppError::new("invalid-arguments"));
        }
        let old = self
            .stored_format(id, format)?
            .ok_or_else(|| AppError::new("format-changed"))?;
        let now = Utc::now().to_rfc3339();
        let (stored_path, fingerprint) = if managed {
            let fingerprint = hash_file(&source)?;
            let target = self.paths.items.join(id).join(format!(
                "book-{}.{}",
                Uuid::new_v4(),
                format.extension()
            ));
            publish_copy(&source, &target, &fingerprint)?;
            (target, Some(fingerprint))
        } else {
            (source, None)
        };
        let result = self.connection.execute(
            "UPDATE library_item_formats SET source_path=?3, added_at=?4, provenance=?5,
             content_bytes=?6, content_sha256=?7 WHERE library_item_id=?1 AND format=?2",
            params![
                id,
                format.as_str(),
                stored_path.to_string_lossy(),
                now,
                if managed { "managed" } else { "referenced" },
                fingerprint
                    .as_ref()
                    .map(|value| value.0)
                    .map(as_i64)
                    .transpose()?,
                fingerprint.as_ref().map(|value| value.1.as_str())
            ],
        );
        if let Err(error) = result {
            if managed {
                let _ = fs::remove_file(&stored_path);
            }
            return Err(error.into());
        }
        if old.provenance == Provenance::Managed && old.path != stored_path {
            cleanup_managed(&self.paths.items, &old.path, old.fingerprint.as_ref())?;
        }
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn remove(&mut self, id: &str) -> AppResult<Option<LibraryItem>> {
        let Some(item) = self.read_item(id)? else {
            return Ok(None);
        };
        let stored = item
            .formats
            .iter()
            .map(|format| self.stored_format(id, format.format))
            .collect::<AppResult<Vec<_>>>()?;
        self.connection
            .execute("DELETE FROM library_items WHERE id=?1", [id])?;
        for format in stored.into_iter().flatten() {
            if format.provenance == Provenance::Managed {
                cleanup_managed(&self.paths.items, &format.path, format.fingerprint.as_ref())?;
            }
        }
        if let Some(path) = &item.cover_path
            && path.starts_with(&self.paths.covers)
        {
            let _ = fs::remove_file(path);
        }
        Ok(Some(item))
    }

    pub fn update(&mut self, id: &str, patch: LibraryPatch) -> AppResult<LibraryItem> {
        let mut item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        if let Some(title) = patch.title {
            let title = title.trim();
            if title.is_empty() {
                return Err(AppError::new("invalid-arguments"));
            }
            item.title = title.to_owned();
        }
        if let Some(value) = patch.author {
            item.author = clean_optional(value);
        }
        if let Some(value) = patch.authors {
            item.authors = normalize_authors(value)?;
        }
        if let Some(value) = patch.series {
            item.series = clean_optional(value);
        }
        if let Some(value) = patch.series_index {
            item.series_index = value;
        }
        if let Some(value) = patch.publisher {
            item.publisher = clean_optional(value);
        }
        if let Some(value) = patch.languages {
            item.languages = normalize_texts(value)?;
        }
        if let Some(value) = patch.identifiers {
            item.identifiers = normalize_map(value)?;
        }
        if let Some(value) = patch.custom_metadata {
            item.custom_metadata = normalize_map(value)?;
        }
        if let Some(value) = patch.published_date {
            item.published_date = clean_optional(value);
        }
        if let Some(value) = patch.rating {
            if value.is_some_and(|rating| !(0.0..=10.0).contains(&rating)) {
                return Err(AppError::new("invalid-arguments"));
            }
            item.rating = value;
        }
        if let Some(value) = patch.description {
            item.description = clean_optional(value);
        }
        if let Some(value) = patch.tags {
            item.tags = normalize_texts(value)?;
        }
        item.updated_at = Some(Utc::now().to_rfc3339());

        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE library_items SET title=?2, author=?3, series=?4, series_index=?5,
             publisher=?6, published_date=?7, rating=?8, description=?9, updated_at=?10 WHERE id=?1",
            params![item.id, item.title, item.author, item.series, item.series_index, item.publisher,
                item.published_date, item.rating, item.description, item.updated_at],
        )?;
        replace_metadata(&transaction, &item)?;
        transaction.commit()?;
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn set_cover(&mut self, id: &str, source: &Path) -> AppResult<LibraryItem> {
        if self.read_item(id)?.is_none() {
            return Err(AppError::new("not-found"));
        }
        let source = canonical_file(source)?;
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("img");
        let target = self
            .paths
            .covers
            .join(format!("{id}-{}.{extension}", Uuid::new_v4()));
        let fingerprint = hash_file(&source)?;
        publish_copy(&source, &target, &fingerprint)?;
        let old: Option<String> = self
            .connection
            .query_row(
                "SELECT cover_path FROM library_items WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        self.connection.execute(
            "UPDATE library_items SET cover_path=?2, updated_at=?3 WHERE id=?1",
            params![id, target.to_string_lossy(), Utc::now().to_rfc3339()],
        )?;
        if let Some(old) = old {
            let old = PathBuf::from(old);
            if old != target && old.starts_with(&self.paths.covers) {
                let _ = fs::remove_file(old);
            }
        }
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn remove_cover(&mut self, id: &str) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        self.connection.execute(
            "UPDATE library_items SET cover_path=NULL, updated_at=?2 WHERE id=?1",
            params![id, Utc::now().to_rfc3339()],
        )?;
        if let Some(path) = item.cover_path
            && path.starts_with(&self.paths.covers)
        {
            let _ = fs::remove_file(path);
        }
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub fn trash(&mut self, id: &str) -> AppResult<LibraryItem> {
        self.set_trash(id, Some(Utc::now().to_rfc3339()))
    }

    pub fn restore(&mut self, id: &str) -> AppResult<LibraryItem> {
        self.set_trash(id, None)
    }

    pub fn purge(&mut self, id: &str) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        let trashed: bool = self.connection.query_row(
            "SELECT trashed_at IS NOT NULL FROM library_items WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        if !trashed {
            return Err(AppError::new("not-trashed"));
        }
        let stored = item
            .formats
            .iter()
            .map(|format| self.stored_format(id, format.format))
            .collect::<AppResult<Vec<_>>>()?;
        self.connection
            .execute("DELETE FROM library_items WHERE id=?1", [id])?;
        for format in stored.into_iter().flatten() {
            if format.provenance == Provenance::Managed {
                cleanup_managed(&self.paths.items, &format.path, format.fingerprint.as_ref())?;
            }
        }
        if let Some(path) = &item.cover_path
            && path.starts_with(&self.paths.covers)
        {
            let _ = fs::remove_file(path);
        }
        Ok(item)
    }

    pub fn verify(&self) -> AppResult<VerifyReport> {
        let version: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != LIBRARY_SCHEMA_VERSION {
            return Err(AppError::new("incompatible-schema"));
        }
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(AppError::new("integrity-failed"));
        }
        let foreign_keys: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        if foreign_keys != 0 {
            return Err(AppError::new("integrity-failed"));
        }
        let active_items = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_items WHERE trashed_at IS NULL",
        )?;
        let trashed_items = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_items WHERE trashed_at IS NOT NULL",
        )?;
        let managed_formats = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_item_formats WHERE provenance='managed'",
        )?;
        let referenced_formats = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_item_formats WHERE provenance='referenced'",
        )?;
        let mut statement = self.connection.prepare(
            "SELECT source_path, content_bytes, content_sha256 FROM library_item_formats WHERE provenance='managed'"
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut verified = 0u64;
        for row in rows {
            let (path, bytes, sha256) = row?;
            let actual =
                hash_file(Path::new(&path)).map_err(|_| AppError::new("integrity-failed"))?;
            if actual.0 != u64::try_from(bytes).map_err(|_| AppError::new("integrity-failed"))?
                || actual.1 != sha256
            {
                return Err(AppError::new("integrity-failed"));
            }
            verified += 1;
        }
        Ok(VerifyReport {
            schema_version: version,
            sqlite_integrity: "ok",
            active_items,
            trashed_items,
            managed_formats,
            referenced_formats,
            verified_managed_formats: verified,
        })
    }

    pub fn backup(&self, destination: &Path) -> AppResult<BackupReport> {
        if destination.exists() {
            return Err(AppError::new("destination-exists"));
        }
        fs::create_dir_all(destination).map_err(|_| AppError::new("backup-failed"))?;
        let database_path = destination.join("library.sqlite");
        let mut output =
            Connection::open(&database_path).map_err(|_| AppError::new("backup-failed"))?;
        let backup = rusqlite::backup::Backup::new(&self.connection, &mut output)
            .map_err(|_| AppError::new("backup-failed"))?;
        backup
            .run_to_completion(16, std::time::Duration::from_millis(10), None)
            .map_err(|_| AppError::new("backup-failed"))?;
        drop(backup);
        copy_tree_if_present(&self.paths.items, &destination.join("items"))?;
        copy_tree_if_present(&self.paths.covers, &destination.join("covers"))?;
        let managed_files = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_item_formats WHERE provenance='managed'",
        )?;
        let manifest = serde_json::json!({
            "version": 1,
            "schemaVersion": LIBRARY_SCHEMA_VERSION,
            "createdAt": Utc::now().to_rfc3339(),
            "managedFiles": managed_files,
        });
        fs::write(
            destination.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|_| AppError::new("backup-failed"))?,
        )
        .map_err(|_| AppError::new("backup-failed"))?;
        Ok(BackupReport {
            destination_path: destination.to_path_buf(),
            database_path,
            managed_files,
        })
    }

    fn set_trash(&mut self, id: &str, timestamp: Option<String>) -> AppResult<LibraryItem> {
        if self.read_item(id)?.is_none() {
            return Err(AppError::new("not-found"));
        }
        self.connection.execute(
            "UPDATE library_items SET trashed_at=?2 WHERE id=?1",
            params![id, timestamp],
        )?;
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    fn managed_path(&self, id: &str, format: FormatId) -> PathBuf {
        self.paths
            .items
            .join(id)
            .join(format!("book.{}", format.extension()))
    }

    fn stored_format(&self, id: &str, format: FormatId) -> AppResult<Option<StoredFormat>> {
        self.connection
            .query_row(
                "SELECT source_path, provenance, position, content_bytes, content_sha256
             FROM library_item_formats WHERE library_item_id=?1 AND format=?2",
                params![id, format.as_str()],
                |row| {
                    let provenance: String = row.get(1)?;
                    Ok(StoredFormat {
                        path: PathBuf::from(row.get::<_, String>(0)?),
                        provenance: if provenance == "managed" {
                            Provenance::Managed
                        } else {
                            Provenance::Referenced
                        },
                        position: row.get(2)?,
                        fingerprint: match (
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ) {
                            (Some(bytes), Some(sha256)) => {
                                Some((u64::try_from(bytes).unwrap_or_default(), sha256))
                            }
                            _ => None,
                        },
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn read_item(&self, id: &str) -> AppResult<Option<LibraryItem>> {
        let base = self
            .connection
            .query_row(
                "SELECT title, added_at, author, series, series_index, publisher, published_date,
             rating, description, cover_path, updated_at FROM library_items WHERE id=?1",
                [id],
                |row| {
                    Ok(BaseRow {
                        title: row.get(0)?,
                        added_at: row.get(1)?,
                        author: row.get(2)?,
                        series: row.get(3)?,
                        series_index: row.get(4)?,
                        publisher: row.get(5)?,
                        published_date: row.get(6)?,
                        rating: row.get(7)?,
                        description: row.get(8)?,
                        cover_path: row.get::<_, Option<String>>(9)?.map(PathBuf::from),
                        updated_at: row.get(10)?,
                    })
                },
            )
            .optional()?;
        let Some(base) = base else {
            return Ok(None);
        };
        let formats = read_formats(&self.connection, id)?;
        let primary = formats
            .first()
            .ok_or_else(|| AppError::new("invalid-stored-data"))?;
        Ok(Some(LibraryItem {
            id: id.to_owned(),
            title: base.title,
            source_path: primary.source_path.clone(),
            format: primary.format,
            added_at: base.added_at,
            formats,
            author: base.author,
            authors: read_authors(&self.connection, id)?,
            series: base.series,
            series_index: base.series_index,
            publisher: base.publisher,
            languages: read_values(&self.connection, "library_item_languages", "language", id)?,
            identifiers: read_map(&self.connection, "library_item_identifiers", "scheme", id)?,
            custom_metadata: read_map(
                &self.connection,
                "library_item_custom_metadata",
                "name",
                id,
            )?,
            published_date: base.published_date,
            rating: base.rating,
            description: base.description,
            cover_path: base.cover_path,
            tags: read_tags(&self.connection, id)?,
            updated_at: base.updated_at,
        }))
    }
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
struct StoredFormat {
    path: PathBuf,
    provenance: Provenance,
    position: i64,
    fingerprint: Option<(u64, String)>,
}

fn create_schema(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE library_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, added_at TEXT NOT NULL,
           author TEXT, series TEXT, series_index REAL, publisher TEXT, published_date TEXT,
           rating REAL CHECK (rating >= 0 AND rating <= 10), description TEXT, cover_path TEXT,
           updated_at TEXT, trashed_at TEXT) STRICT;
         CREATE TABLE tags (normalized_name TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
         CREATE TABLE library_item_tags (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
           position INTEGER NOT NULL, PRIMARY KEY(library_item_id,tag_normalized_name), UNIQUE(library_item_id,position)) STRICT;
         CREATE TABLE library_item_formats (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           format TEXT NOT NULL, source_path TEXT NOT NULL, added_at TEXT NOT NULL,
           provenance TEXT NOT NULL CHECK(provenance IN ('managed','referenced')), position INTEGER NOT NULL CHECK(position>=0),
           content_bytes INTEGER, content_sha256 TEXT,
           CHECK((provenance='managed' AND content_bytes IS NOT NULL AND content_bytes>=0 AND content_sha256 IS NOT NULL
             AND length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*') OR
             (provenance='referenced' AND content_bytes IS NULL AND content_sha256 IS NULL)),
           PRIMARY KEY(library_item_id,format), UNIQUE(library_item_id,position)) STRICT;
         CREATE TABLE library_item_authors (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           name TEXT NOT NULL, sort_name TEXT, position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(library_item_id,position)) STRICT;
         CREATE TABLE library_item_languages (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           language TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(library_item_id,position)) STRICT;
         CREATE TABLE library_item_identifiers (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           scheme TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,scheme)) STRICT;
         CREATE TABLE library_item_custom_metadata (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,name)) STRICT;
         CREATE TABLE saved_library_views (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
         CREATE TABLE duplicate_pair_reviews (left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE, review_token TEXT NOT NULL,
           reviewed_at TEXT NOT NULL, PRIMARY KEY(left_id,right_id)) STRICT;
         CREATE TABLE library_adoptions (id TEXT PRIMARY KEY, library_item_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
           source_path TEXT NOT NULL, target_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL, content_bytes INTEGER NOT NULL,
           content_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
         CREATE TABLE managed_file_cleanup (source_path TEXT PRIMARY KEY,
           kind TEXT NOT NULL DEFAULT 'format' CHECK(kind IN ('format','cover'))) STRICT;
         CREATE TABLE source_file_cleanup (source_path TEXT PRIMARY KEY, content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL) STRICT;
         CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE,id);
         CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE,id);
         CREATE INDEX library_items_by_series ON library_items(series COLLATE NOCASE,series_index,id);
         CREATE INDEX library_items_by_added_at ON library_items(added_at,id);
         CREATE INDEX library_items_by_updated_at ON library_items(updated_at,id);
         CREATE INDEX library_items_by_trash ON library_items(trashed_at,id);
         CREATE INDEX library_item_formats_by_format ON library_item_formats(format,library_item_id);
         CREATE INDEX library_item_formats_by_fingerprint ON library_item_formats(content_bytes,content_sha256,library_item_id,position)
           WHERE provenance='managed';
         CREATE INDEX library_item_authors_by_name ON library_item_authors(name COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_languages_by_language ON library_item_languages(language COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_tags_by_tag ON library_item_tags(tag_normalized_name,library_item_id);
         CREATE INDEX saved_library_views_by_name ON saved_library_views(name COLLATE NOCASE,id);
         PRAGMA user_version=10;
         COMMIT;"
    )?;
    Ok(())
}

fn has_schema(connection: &Connection) -> AppResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn read_formats(connection: &Connection, id: &str) -> AppResult<Vec<BookFormat>> {
    let mut statement = connection.prepare(
        "SELECT format,source_path,added_at,provenance FROM library_item_formats WHERE library_item_id=?1 ORDER BY position"
    )?;
    statement
        .query_map([id], |row| {
            let format: String = row.get(0)?;
            let provenance: String = row.get(3)?;
            Ok((
                format,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                provenance,
            ))
        })?
        .map(|row| {
            let (format, path, added_at, provenance) = row?;
            Ok(BookFormat {
                source_path: PathBuf::from(path),
                format: format
                    .parse()
                    .map_err(|_| AppError::new("invalid-stored-data"))?,
                added_at,
                provenance: if provenance == "managed" {
                    Provenance::Managed
                } else if provenance == "referenced" {
                    Provenance::Referenced
                } else {
                    return Err(AppError::new("invalid-stored-data"));
                },
            })
        })
        .collect()
}

fn read_authors(connection: &Connection, id: &str) -> AppResult<Vec<BookAuthor>> {
    let mut statement = connection.prepare(
        "SELECT name,sort_name FROM library_item_authors WHERE library_item_id=?1 ORDER BY position"
    )?;
    Ok(statement
        .query_map([id], |row| {
            Ok(BookAuthor {
                name: row.get(0)?,
                sort_name: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_values(
    connection: &Connection,
    table: &str,
    column: &str,
    id: &str,
) -> AppResult<Vec<String>> {
    let sql = format!("SELECT {column} FROM {table} WHERE library_item_id=?1 ORDER BY position");
    let mut statement = connection.prepare(&sql)?;
    Ok(statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_tags(connection: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT t.name FROM library_item_tags it JOIN tags t ON t.normalized_name=it.tag_normalized_name
         WHERE it.library_item_id=?1 ORDER BY it.position"
    )?;
    Ok(statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_map(
    connection: &Connection,
    table: &str,
    key: &str,
    id: &str,
) -> AppResult<BTreeMap<String, String>> {
    let sql = format!("SELECT {key},value FROM {table} WHERE library_item_id=?1 ORDER BY {key}");
    let mut statement = connection.prepare(&sql)?;
    Ok(statement
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?)
}

fn replace_metadata(transaction: &Transaction<'_>, item: &LibraryItem) -> AppResult<()> {
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

fn canonical_file(path: &Path) -> AppResult<PathBuf> {
    let path = path
        .canonicalize()
        .map_err(|_| AppError::new("not-found"))?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(AppError::new("invalid-arguments"))
    }
}

fn title_from_path(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    if name.to_ascii_lowercase().ends_with(".kepub.epub") {
        name[..name.len() - 11].to_owned()
    } else {
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled")
            .to_owned()
    }
}

fn hash_file(path: &Path) -> AppResult<(u64, String)> {
    let mut file = File::open(path).map_err(|_| AppError::new("source-unavailable"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AppError::new("source-unavailable"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += u64::try_from(read).map_err(|_| AppError::new("source-unavailable"))?;
    }
    Ok((bytes, hex::encode(hash.finalize())))
}

fn publish_copy(source: &Path, target: &Path, expected: &(u64, String)) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::new("storage-unavailable"))?;
    fs::create_dir_all(parent)?;
    if target.exists() {
        return Err(AppError::new("destination-exists"));
    }
    let temporary = parent.join(format!(".takio-{}.tmp", Uuid::new_v4()));
    let mut input = File::open(source).map_err(|_| AppError::new("source-unavailable"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    if hash_file(&temporary)? != *expected {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::new("source-changed"));
    }
    fs::rename(&temporary, target)?;
    Ok(())
}

fn cleanup_managed(root: &Path, path: &Path, expected: Option<&(u64, String)>) -> AppResult<()> {
    if !path.starts_with(root) {
        return Err(AppError::new("invalid-stored-data"));
    }
    if path.exists()
        && expected.is_some_and(|expected| hash_file(path).ok().as_ref() != Some(expected))
    {
        return Err(AppError::new("source-changed"));
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}
fn normalize_texts(values: Vec<String>) -> AppResult<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() || !seen.insert(value.to_lowercase()) {
            return Err(AppError::new("invalid-arguments"));
        }
        normalized.push(value);
    }
    Ok(normalized)
}
fn normalize_authors(values: Vec<BookAuthor>) -> AppResult<Vec<BookAuthor>> {
    let mut output = Vec::new();
    for value in values {
        let name = value.name.trim();
        if name.is_empty() {
            return Err(AppError::new("invalid-arguments"));
        }
        output.push(BookAuthor {
            name: name.to_owned(),
            sort_name: clean_optional(value.sort_name),
        });
    }
    Ok(output)
}
fn normalize_map(values: BTreeMap<String, String>) -> AppResult<BTreeMap<String, String>> {
    if values
        .iter()
        .any(|(key, value)| key.trim().is_empty() || value.trim().is_empty())
    {
        Err(AppError::new("invalid-arguments"))
    } else {
        Ok(values)
    }
}
fn count(connection: &Connection, sql: &str) -> AppResult<u64> {
    let value: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    u64::try_from(value).map_err(|_| AppError::new("invalid-stored-data"))
}
fn as_i64(value: u64) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| AppError::new("storage-unavailable"))
}
fn copy_tree_if_present(source: &Path, target: &Path) -> AppResult<()> {
    if !source.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry.map_err(|_| AppError::new("backup-failed"))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::new("backup-failed"))?;
        let out = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).map_err(|_| AppError::new("backup-failed"))?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), out).map_err(|_| AppError::new("backup-failed"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_and_round_trips_a_managed_book() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub").unwrap();
        let error = match LibraryStore::open(paths, false) {
            Ok(_) => panic!("opening a missing library must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "storage-unavailable");
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store.import(&source, Some("Book"), false).unwrap();
        assert_eq!(item.title, "Book");
        assert_eq!(store.list(false).unwrap().len(), 1);
        assert_eq!(store.verify().unwrap().managed_formats, 1);
        let first_cover = temp.path().join("first.jpg");
        let second_cover = temp.path().join("second.jpg");
        fs::write(&first_cover, b"first").unwrap();
        fs::write(&second_cover, b"second").unwrap();
        let first = store.set_cover(&item.id, &first_cover).unwrap();
        let first_path = first.cover_path.unwrap();
        let second = store.set_cover(&item.id, &second_cover).unwrap();
        assert!(!first_path.exists());
        assert!(second.cover_path.unwrap().exists());
    }
}
