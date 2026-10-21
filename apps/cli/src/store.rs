use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::cell::Cell;

use chrono::{NaiveDate, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
    params_from_iter,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::candidate_cover::{self, CandidateCoverDescriptor};
use crate::conversion::{FormatId, detect_format};
use crate::model::{
    BookAuthor, BookFormat, CustomColumnDefinition, LibraryItem, LibraryPatch, Patch, Provenance,
};
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;

mod migration;

pub const LIBRARY_SCHEMA_VERSION: i64 = 12;
pub const METADATA_AUDIT_KEY: &str = "takio_metadata_audit";
const MAX_CUSTOM_METADATA_USER_ENTRIES: usize = 64;
const MAX_CUSTOM_METADATA_TOTAL_ENTRIES: usize = 65;
const MAX_CUSTOM_METADATA_VALUE_CHARS: usize = 16 * 1024;
const MAX_CUSTOM_COLUMN_DEFINITIONS: usize = 64;

#[cfg(test)]
thread_local! {
    static ARM_POST_COMMIT_READ_FAULT: Cell<bool> = const { Cell::new(false) };
    static POST_COMMIT_READ_FAULT: Cell<bool> = const { Cell::new(false) };
}

pub struct LibraryStore {
    connection: Connection,
    paths: LibraryPaths,
}

#[derive(Clone, Copy)]
pub struct LibraryQueryFilters<'a> {
    pub authors: &'a [String],
    pub tags: &'a [String],
    pub series: &'a [String],
    pub languages: &'a [String],
    pub formats: &'a [String],
}

#[derive(Clone, Copy)]
pub enum LibraryQuerySyntax {
    Literal,
    StructuredV1,
}

#[derive(Clone, Copy)]
pub struct LibraryQueryScope<'a> {
    pub query: &'a str,
    pub syntax: LibraryQuerySyntax,
    pub filters: LibraryQueryFilters<'a>,
}

pub(crate) fn validate_candidate_patch(patch: &LibraryPatch) -> AppResult<()> {
    validate_library_patch(patch, true)
}

pub struct ImportWatchObservation {
    pub canonical_source_path: PathBuf,
    pub content_bytes: u64,
    pub content_sha256: String,
    pub outcome: &'static str,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub source_path: PathBuf,
    pub database_path: PathBuf,
    pub report: VerifyReport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub definition: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DuplicateSignal {
    SameContent {
        #[serde(rename = "leftFormat")]
        left_format: FormatId,
        #[serde(rename = "rightFormat")]
        right_format: FormatId,
        bytes: u64,
        sha256: String,
    },
    SameIdentifier {
        scheme: String,
        value: String,
    },
    SameTitleAuthor {
        title: String,
        author: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub left: LibraryItem,
    pub right: LibraryItem,
    pub signals: Vec<DuplicateSignal>,
    pub review_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanSummary {
    pub files_hashed: u64,
    pub fingerprints_reused: u64,
    pub unreadable_formats: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidatePage {
    pub candidates: Vec<DuplicateCandidate>,
    pub total: usize,
    pub page: DuplicatePageRequest,
    pub scan: DuplicateScanSummary,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicatePageRequest {
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDuplicateCandidatesRequest {
    pub page: DuplicatePageRequest,
    pub disposition: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicatePairReviewRequest {
    pub left_id: String,
    pub right_id: String,
    pub review_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeDuplicatePairRequest {
    pub target_id: String,
    pub source_id: String,
    pub review_token: String,
    pub metadata: Value,
    pub add_source_formats: Vec<FormatId>,
    pub cover: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDuplicatePairResult {
    pub target: LibraryItem,
    pub trashed_source: LibraryItem,
    pub cleanup_pending: bool,
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

impl LibraryStore {
    pub fn list_custom_column_definitions(&self) -> AppResult<Vec<CustomColumnDefinition>> {
        let mut statement = self.connection.prepare(
            "SELECT key,label,type,position FROM library_custom_column_definitions ORDER BY position",
        )?;
        let definitions = statement
            .query_map([], |row| {
                Ok(CustomColumnDefinition {
                    key: row.get(0)?,
                    label: row.get(1)?,
                    column_type: row.get(2)?,
                    position: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        validate_custom_column_definitions(&definitions)
            .map_err(|_| AppError::new("incompatible-schema"))?;
        Ok(definitions)
    }

    pub fn create_custom_column_definition(
        &mut self,
        key: &str,
        label: &str,
    ) -> AppResult<CustomColumnDefinition> {
        let label = validate_custom_column_definition(key, label)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: usize = transaction.query_row(
            "SELECT COUNT(*) FROM library_custom_column_definitions",
            [],
            |row| row.get(0),
        )?;
        if count >= MAX_CUSTOM_COLUMN_DEFINITIONS {
            return Err(AppError::new("invalid-arguments"));
        }
        transaction.execute(
            "INSERT INTO library_custom_column_definitions(key,label,type,position) VALUES(?1,?2,'text',?3)",
            params![key, label, count],
        ).map_err(|error| if matches!(error, rusqlite::Error::SqliteFailure(_, _)) {
            AppError::new("invalid-arguments")
        } else { error.into() })?;
        transaction.commit()?;
        Ok(CustomColumnDefinition {
            key: key.to_owned(),
            label,
            column_type: "text".to_owned(),
            position: count as u32,
        })
    }

    pub fn rename_custom_column_definition(
        &mut self,
        key: &str,
        label: &str,
    ) -> AppResult<CustomColumnDefinition> {
        let label = validate_custom_column_definition(key, label)?;
        let changed = self.connection.execute(
            "UPDATE library_custom_column_definitions SET label=?2 WHERE key=?1",
            params![key, label],
        )?;
        if changed == 0 {
            return Err(AppError::new("not-found"));
        }
        self.connection.query_row(
            "SELECT key,label,type,position FROM library_custom_column_definitions WHERE key=?1",
            [key],
            |row| Ok(CustomColumnDefinition { key: row.get(0)?, label: row.get(1)?, column_type: row.get(2)?, position: row.get(3)? }),
        ).map_err(Into::into)
    }

    pub fn remove_custom_column_definition(
        &mut self,
        key: &str,
    ) -> AppResult<CustomColumnDefinition> {
        if !valid_custom_column_key(key) {
            return Err(AppError::new("invalid-arguments"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let definition = transaction.query_row(
            "SELECT key,label,type,position FROM library_custom_column_definitions WHERE key=?1",
            [key],
            |row| Ok(CustomColumnDefinition { key: row.get(0)?, label: row.get(1)?, column_type: row.get(2)?, position: row.get(3)? }),
        ).optional()?.ok_or_else(|| AppError::new("not-found"))?;
        transaction.execute(
            "DELETE FROM library_custom_column_definitions WHERE key=?1",
            [key],
        )?;
        transaction.execute(
            "UPDATE library_custom_column_definitions SET position=position-1 WHERE position>?1",
            [definition.position],
        )?;
        transaction.commit()?;
        Ok(definition)
    }

    pub(crate) fn replace_custom_column_definitions(
        &mut self,
        definitions: &[CustomColumnDefinition],
    ) -> AppResult<()> {
        validate_custom_column_definitions(definitions)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM library_custom_column_definitions", [])?;
        for definition in definitions {
            transaction.execute("INSERT INTO library_custom_column_definitions(key,label,type,position) VALUES(?1,?2,'text',?3)", params![definition.key, definition.label, definition.position])?;
        }
        transaction.commit().map_err(Into::into)
    }
    pub fn open_read_only(paths: LibraryPaths) -> AppResult<Self> {
        if !paths.database.is_file() {
            return Err(AppError::new("storage-unavailable"));
        }
        let connection =
            Connection::open_with_flags(&paths.database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != LIBRARY_SCHEMA_VERSION {
            return Err(AppError::new("incompatible-schema"));
        }
        migration::verify_schema_version(&connection, version)?;
        Ok(Self { connection, paths })
    }

    pub fn open(paths: LibraryPaths, create: bool) -> AppResult<Self> {
        if !create && !paths.database.is_file() {
            return Err(AppError::new("storage-unavailable"));
        }
        if create {
            fs::create_dir_all(&paths.root)?;
            fs::create_dir_all(&paths.items)?;
            fs::create_dir_all(&paths.covers)?;
        }
        let mut connection = Connection::open(&paths.database)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            if !create || has_schema(&connection)? {
                return Err(AppError::new("incompatible-schema"));
            }
            create_schema(&connection)?;
        } else if (1..LIBRARY_SCHEMA_VERSION).contains(&version) && create {
            migration::migrate(&mut connection, &paths, version)?;
        } else if version != LIBRARY_SCHEMA_VERSION {
            return Err(AppError::new("incompatible-schema"));
        } else {
            migration::verify_schema_version(&connection, version)?;
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

    pub fn query_items(
        &self,
        query: &str,
        filters: LibraryQueryFilters<'_>,
    ) -> AppResult<Vec<LibraryItem>> {
        self.query_items_scoped(&[LibraryQueryScope {
            query,
            syntax: LibraryQuerySyntax::Literal,
            filters,
        }])
    }

    pub fn query_items_scoped(
        &self,
        scopes: &[LibraryQueryScope<'_>],
    ) -> AppResult<Vec<LibraryItem>> {
        let mut sql =
            String::from("SELECT li.id FROM library_items li WHERE li.trashed_at IS NULL");
        let mut values = Vec::<SqlValue>::new();
        for scope in scopes {
            append_query_scope(&mut sql, &mut values, *scope)?;
        }
        sql.push_str(" ORDER BY li.title COLLATE NOCASE, li.id");

        let mut statement = self.connection.prepare(&sql)?;
        let ids = statement
            .query_map(params_from_iter(values.iter()), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| {
                self.read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))
            })
            .collect()
    }

    pub fn saved_view(&self, id: &str) -> AppResult<Option<SavedView>> {
        self.connection
            .query_row(
                "SELECT id,name,definition_json,created_at,updated_at FROM saved_library_views WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?
            .map(|(id, name, definition, created_at, updated_at)| {
                let definition = serde_json::from_str(&definition)
                    .map_err(|_| AppError::new("invalid-stored-data"))?;
                validate_saved_view_definition(&definition)
                    .map_err(|_| AppError::new("invalid-stored-data"))?;
                Ok(SavedView {
                    id,
                    name,
                    definition,
                    created_at,
                    updated_at,
                })
            })
            .transpose()
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

    pub fn find_managed_duplicate(
        &self,
        source: &Path,
    ) -> AppResult<Option<(LibraryItem, FormatId)>> {
        let source = canonical_file(source)?;
        let fingerprint = hash_file(&source)?;
        let duplicate = self
            .connection
            .query_row(
                "SELECT library_item_id,format FROM library_item_formats
                 WHERE provenance = 'managed' AND content_bytes = ?1 AND content_sha256 = ?2
                 ORDER BY library_item_id,position
                 LIMIT 1",
                params![as_i64(fingerprint.0)?, fingerprint.1],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        duplicate
            .map(|(id, format)| {
                let item = self
                    .read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))?;
                let format = format
                    .parse::<FormatId>()
                    .map_err(|_| AppError::new("invalid-stored-data"))?;
                Ok((item, format))
            })
            .transpose()
    }

    pub fn import_watch_accounted(
        &self,
        canonical_source_path: &Path,
        fingerprint: &(u64, String),
    ) -> AppResult<bool> {
        self.connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM import_watch_observations
                   WHERE canonical_source_path=?1 AND content_bytes=?2 AND content_sha256=?3
                     AND outcome<>'failed'
                 )",
                params![
                    canonical_source_path.to_string_lossy(),
                    as_i64(fingerprint.0)?,
                    fingerprint.1
                ],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn record_import_watch_observation(
        &mut self,
        observation: ImportWatchObservation,
    ) -> AppResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO import_watch_observations
             (canonical_source_path,content_bytes,content_sha256,outcome,accounted_at)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(canonical_source_path) DO UPDATE SET
               content_bytes=excluded.content_bytes,
               content_sha256=excluded.content_sha256,
               outcome=excluded.outcome,
               accounted_at=excluded.accounted_at",
            params![
                observation.canonical_source_path.to_string_lossy(),
                as_i64(observation.content_bytes)?,
                observation.content_sha256,
                observation.outcome,
                Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;
        Ok(())
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

    pub fn attach_verified_artifact(
        &mut self,
        id: &str,
        source: &Path,
        format: FormatId,
        expected_bytes: u64,
        expected_sha256: &str,
    ) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        let expected = (expected_bytes, expected_sha256.to_owned());
        if let Some(existing) = read_stored_format(&self.connection, id, format)? {
            if existing.provenance == Provenance::Managed
                && existing.fingerprint.as_ref() == Some(&expected)
                && hash_file(&existing.path).ok().as_ref() == Some(&expected)
            {
                return Ok(item);
            }
            return Err(AppError::new("format-exists"));
        }
        let source = canonical_file(source)?;
        if detect_format(&source) != Some(format) || hash_file(&source)? != expected {
            return Err(AppError::new("artifact-invalid"));
        }
        let now = Utc::now().to_rfc3339();
        let content_bytes = as_i64(expected_bytes)?;
        let target = self.managed_path(id, format);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = read_stored_format(&transaction, id, format)? {
            if existing.provenance == Provenance::Managed
                && existing.fingerprint.as_ref() == Some(&expected)
                && hash_file(&existing.path).ok().as_ref() == Some(&expected)
            {
                return Ok(item);
            }
            return Err(AppError::new("format-exists"));
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM library_item_formats WHERE library_item_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        publish_copy(&source, &target, &expected)?;
        let inserted = transaction.execute(
            "INSERT INTO library_item_formats
             (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
             VALUES (?1, ?2, ?3, ?4, 'managed', ?5, ?6, ?7)",
            params![id, format.as_str(), target.to_string_lossy(), now, position, content_bytes, expected_sha256],
        );
        if let Err(error) = inserted {
            let _ = fs::remove_file(&target);
            return Err(error.into());
        }
        transaction.commit()?;
        self.read_item(id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub(crate) fn restore_portable_item(
        &mut self,
        item: &LibraryItem,
        formats: &[(FormatId, PathBuf)],
        cover: Option<&Path>,
    ) -> AppResult<LibraryItem> {
        if !crate::portable_library::valid_item_id(&item.id)
            || formats.is_empty()
            || formats.len() != item.formats.len()
        {
            return Err(AppError::new("invalid-arguments"));
        }
        let mut published = Vec::new();
        let result = (|| -> AppResult<()> {
            let mut format_targets = Vec::with_capacity(formats.len());
            for (format, source) in formats {
                let fingerprint = hash_file(source)?;
                let target = self.managed_path(&item.id, *format);
                publish_copy(source, &target, &fingerprint)?;
                published.push(target.clone());
                format_targets.push(target);
            }
            let cover_target = cover
                .map(|source| -> AppResult<PathBuf> {
                    let extension = source
                        .extension()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| AppError::new("invalid-arguments"))?;
                    let target = self.paths.covers.join(format!("{}.{}", item.id, extension));
                    publish_copy(source, &target, &hash_file(source)?)?;
                    published.push(target.clone());
                    Ok(target)
                })
                .transpose()?;
            let transaction = self.connection.transaction()?;
            transaction.execute(
                "INSERT INTO library_items
                 (id,title,added_at,author,series,series_index,publisher,published_date,rating,description,cover_path,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![item.id,item.title,item.added_at,item.author,item.series,item.series_index,
                    item.publisher,item.published_date,item.rating,item.description,
                    cover_target.as_ref().map(|path| path.to_string_lossy()),item.updated_at],
            )?;
            for (position, (((format, _), original), target)) in formats
                .iter()
                .zip(&item.formats)
                .zip(&format_targets)
                .enumerate()
            {
                if *format != original.format {
                    return Err(AppError::new("invalid-arguments"));
                }
                let fingerprint = hash_file(target)?;
                transaction.execute(
                    "INSERT INTO library_item_formats
                     (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                     VALUES (?1,?2,?3,?4,'managed',?5,?6,?7)",
                    params![item.id,format.as_str(),target.to_string_lossy(),original.added_at,
                        as_i64(position as u64)?,as_i64(fingerprint.0)?,fingerprint.1],
                )?;
            }
            replace_metadata(&transaction, item)?;
            transaction.commit()?;
            Ok(())
        })();
        if result.is_err() {
            for path in published {
                let _ = fs::remove_file(path);
            }
            return Err(AppError::new("storage-unavailable"));
        }
        self.read_item(&item.id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
    }

    pub(crate) fn rebase_portable_paths(&mut self, destination: &LibraryPaths) -> AppResult<()> {
        rebase_owned_paths(&mut self.connection, &self.paths, destination)
    }

    pub fn catalog_page(&self, limit: usize, offset: usize) -> AppResult<(u64, Vec<LibraryItem>)> {
        let total = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_items WHERE trashed_at IS NULL",
        )?;
        let mut statement = self.connection.prepare(
            "SELECT id FROM library_items WHERE trashed_at IS NULL ORDER BY title COLLATE NOCASE,id LIMIT ?1 OFFSET ?2",
        )?;
        let limit = u64::try_from(limit).map_err(|_| AppError::new("invalid-arguments"))?;
        let offset = u64::try_from(offset).map_err(|_| AppError::new("invalid-arguments"))?;
        let ids = statement
            .query_map(params![as_i64(limit)?, as_i64(offset)?], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let items = ids
            .into_iter()
            .map(|id| {
                self.read_item(&id)?
                    .ok_or_else(|| AppError::new("invalid-stored-data"))
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok((total, items))
    }

    pub fn list_duplicate_candidates(
        &self,
        request: &ListDuplicateCandidatesRequest,
    ) -> AppResult<DuplicateCandidatePage> {
        validate_duplicate_page(request)?;
        let (candidates, scan) = self.scan_duplicate_candidates()?;
        let mut reviews = HashMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT left_id,right_id,review_token FROM duplicate_pair_reviews")?;
        for row in statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (left, right, token) = row?;
            if !valid_pair(&left, &right) || !valid_review_token(&token) {
                return Err(AppError::new("invalid-stored-data"));
            }
            reviews.insert((left, right), token);
        }
        let matching = candidates
            .into_iter()
            .filter(|candidate| {
                let reviewed = reviews
                    .get(&(candidate.left.id.clone(), candidate.right.id.clone()))
                    == Some(&candidate.review_token);
                (request.disposition == "kept-both") == reviewed
            })
            .collect::<Vec<_>>();
        let total = matching.len();
        let candidates = matching
            .into_iter()
            .skip(request.page.offset)
            .take(request.page.limit)
            .collect();
        Ok(DuplicateCandidatePage {
            candidates,
            total,
            page: request.page,
            scan,
        })
    }

    pub fn keep_duplicate_pair(&mut self, request: &DuplicatePairReviewRequest) -> AppResult<()> {
        validate_pair_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| {
                candidate.left.id == request.left_id && candidate.right.id == request.right_id
            })
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| AppError::new("stale-review"))?;
        transaction.execute(
            "INSERT INTO duplicate_pair_reviews (left_id,right_id,review_token,reviewed_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(left_id,right_id) DO UPDATE SET review_token=excluded.review_token,reviewed_at=excluded.reviewed_at",
            params![candidate.left.id, candidate.right.id, candidate.review_token, Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reopen_duplicate_pair(&mut self, request: &DuplicatePairReviewRequest) -> AppResult<()> {
        validate_pair_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| {
                candidate.left.id == request.left_id && candidate.right.id == request.right_id
            })
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| AppError::new("stale-review"))?;
        let stored: Option<String> = transaction
            .query_row(
                "SELECT review_token FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
                params![current.left.id, current.right.id],
                |row| row.get(0),
            )
            .optional()?;
        if stored.as_deref() != Some(&request.review_token) {
            return Err(AppError::new("stale-review"));
        }
        transaction.execute(
            "DELETE FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
            params![request.left_id, request.right_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn merge_duplicate_pair(
        &mut self,
        request: &MergeDuplicatePairRequest,
    ) -> AppResult<MergeDuplicatePairResult> {
        validate_merge_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (left_id, right_id) = canonical_pair(&request.target_id, &request.source_id);
        let candidate = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| candidate.left.id == left_id && candidate.right.id == right_id)
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| AppError::new("stale-review"))?;
        let mut target = if candidate.left.id == request.target_id {
            candidate.left.clone()
        } else {
            candidate.right.clone()
        };
        apply_duplicate_metadata(&mut target, &request.metadata)?;
        target.updated_at = Some(Utc::now().to_rfc3339());

        let target_formats = target
            .formats
            .iter()
            .map(|format| format.format.as_str())
            .collect::<Vec<_>>();
        let mut source_rows =
            HashMap::<String, (String, String, String, Option<i64>, Option<String>)>::new();
        let mut statement = transaction.prepare(
            "SELECT format,source_path,added_at,provenance,content_bytes,content_sha256
             FROM library_item_formats WHERE library_item_id=?1 ORDER BY position",
        )?;
        for row in statement.query_map([&request.source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })? {
            let row = row?;
            source_rows.insert(row.0.clone(), (row.1, row.2, row.3, row.4, row.5));
        }
        drop(statement);
        let mut selected = Vec::new();
        for format in &request.add_source_formats {
            let key = format.as_str();
            if target_formats.contains(&key)
                || selected.contains(&key)
                || !source_rows.contains_key(key)
            {
                return Err(AppError::new("invalid-arguments"));
            }
            selected.push(key);
        }

        let (target_cover, source_cover): (Option<String>, Option<String>) = transaction
            .query_row(
                "SELECT (SELECT cover_path FROM library_items WHERE id=?1),
                    (SELECT cover_path FROM library_items WHERE id=?2)",
                params![request.target_id, request.source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let selected_cover = match request.cover.as_str() {
            "target" => target_cover.clone(),
            "source" => Some(
                source_cover
                    .clone()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            ),
            "none" => None,
            _ => return Err(AppError::new("invalid-arguments")),
        };
        if let Some(path) = &selected_cover
            && !Path::new(path).starts_with(&self.paths.covers)
        {
            return Err(AppError::new("invalid-stored-data"));
        }

        write_duplicate_metadata(&transaction, &target)?;
        let next_position =
            i64::try_from(target.formats.len()).map_err(|_| AppError::new("invalid-arguments"))?;
        for (index, format) in request.add_source_formats.iter().enumerate() {
            let (path, added_at, provenance, bytes, sha) = source_rows
                .get(format.as_str())
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            transaction.execute(
                "INSERT INTO library_item_formats
                 (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![request.target_id, format.as_str(), path, added_at, provenance,
                    next_position + i64::try_from(index).map_err(|_| AppError::new("invalid-arguments"))?, bytes, sha],
            )?;
        }
        transaction.execute(
            "UPDATE library_items SET cover_path=?2 WHERE id=?1",
            params![request.target_id, selected_cover],
        )?;
        let changed = transaction.execute(
            "UPDATE library_items SET trashed_at=?2,updated_at=?2 WHERE id=?1 AND trashed_at IS NULL",
            params![request.source_id, target.updated_at],
        )?;
        if changed != 1 {
            return Err(AppError::new("stale-review"));
        }
        transaction.execute(
            "DELETE FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
            params![left_id, right_id],
        )?;
        let target = read_item_from(&transaction, &request.target_id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))?;
        let trashed_source = read_item_from(&transaction, &request.source_id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))?;
        transaction.commit()?;

        let cleanup_pending = if let Some(old) = target_cover
            && Some(&old) != selected_cover.as_ref()
            && !self.path_is_referenced(&old)?
        {
            fs::remove_file(old).is_err()
        } else {
            false
        };
        Ok(MergeDuplicatePairResult {
            target,
            trashed_source,
            cleanup_pending,
        })
    }

    fn scan_duplicate_candidates(
        &self,
    ) -> AppResult<(Vec<DuplicateCandidate>, DuplicateScanSummary)> {
        scan_duplicate_candidates_in(&self.connection)
    }

    fn path_is_referenced(&self, path: &str) -> AppResult<bool> {
        let formats = count_with_param(
            &self.connection,
            "SELECT COUNT(*) FROM library_item_formats WHERE source_path=?1",
            path,
        )?;
        let covers = count_with_param(
            &self.connection,
            "SELECT COUNT(*) FROM library_items WHERE cover_path=?1",
            path,
        )?;
        Ok(formats + covers > 0)
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
        if stored.provenance == Provenance::Managed
            && !self.path_is_referenced(&stored.path.to_string_lossy())?
        {
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
        if old.provenance == Provenance::Managed
            && old.path != stored_path
            && !self.path_is_referenced(&old.path.to_string_lossy())?
        {
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
            if format.provenance == Provenance::Managed
                && !self.path_is_referenced(&format.path.to_string_lossy())?
            {
                cleanup_managed(&self.paths.items, &format.path, format.fingerprint.as_ref())?;
            }
        }
        if let Some(path) = &item.cover_path
            && path.starts_with(&self.paths.covers)
            && !self.path_is_referenced(&path.to_string_lossy())?
        {
            let _ = fs::remove_file(path);
        }
        Ok(Some(item))
    }

    pub fn update(&mut self, id: &str, patch: LibraryPatch) -> AppResult<LibraryItem> {
        self.update_inner(id, patch, false, None)
    }

    pub(crate) fn apply_metadata_candidate(
        &mut self,
        id: &str,
        patch: LibraryPatch,
        cover: Option<&CandidateCoverDescriptor>,
        candidate_id: &str,
        source: &str,
        provenance: &str,
    ) -> AppResult<LibraryItem> {
        let claimed = cover
            .map(|descriptor| {
                candidate_cover::claim(
                    &self.paths.root,
                    id,
                    candidate_id,
                    source,
                    provenance,
                    descriptor,
                )
            })
            .transpose()?;
        let old_cover = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("item-not-found"))?
            .cover_path;
        let published = if let Some(claimed) = &claimed {
            let target = self.paths.covers.join(format!(
                "{id}-{}.{}",
                Uuid::new_v4(),
                claimed.descriptor.extension.trim_start_matches('.')
            ));
            let fingerprint = hash_file(&claimed.source)?;
            publish_copy(&claimed.source, &target, &fingerprint)?;
            Some(target)
        } else {
            None
        };
        let applied = match self.update_inner(id, patch, true, published.as_deref()) {
            Ok(item) => item,
            Err(error) => {
                if let Some(path) = &published {
                    let _ = fs::remove_file(path);
                }
                if let Some(claimed) = claimed {
                    let _ = claimed.restore();
                }
                return Err(error);
            }
        };
        if let Some(claimed) = claimed {
            claimed.consume();
            if let Some(old) = old_cover
                && published.as_ref().is_none_or(|target| target != &old)
                && old.starts_with(&self.paths.covers)
                && self
                    .path_is_referenced(&old.to_string_lossy())
                    .is_ok_and(|referenced| !referenced)
            {
                let _ = fs::remove_file(old);
            }
        }
        Ok(applied)
    }

    fn update_inner(
        &mut self,
        id: &str,
        patch: LibraryPatch,
        allow_reserved_metadata: bool,
        cover_path: Option<&Path>,
    ) -> AppResult<LibraryItem> {
        validate_library_patch(&patch, allow_reserved_metadata)?;
        let mut item = self
            .read_item(id)?
            .ok_or_else(|| AppError::new("not-found"))?;
        // Patch semantics, uniform across every nullable field the contract
        // allows: `Missing` leaves the stored value untouched, `Null` clears it
        // to the documented empty value, `Set` replaces it.
        if patch.is_empty() && cover_path.is_none() {
            return Err(AppError::new("invalid-arguments"));
        }
        // `title` is non-nullable: an explicit null is a client error.
        if matches!(patch.title, Patch::Null) {
            return Err(AppError::new("invalid-arguments"));
        }
        if let Some(title) = patch.title.into_set() {
            let title = title.trim();
            if title.is_empty() {
                return Err(AppError::new("invalid-arguments"));
            }
            item.title = title.to_owned();
        }
        match patch.author {
            Patch::Missing => {}
            Patch::Null => item.author = None,
            Patch::Set(value) => item.author = Some(required_text(value)?),
        }
        match patch.authors {
            Patch::Missing => {}
            Patch::Null => item.authors = Vec::new(),
            Patch::Set(value) => {
                // The contract requires at least one author when present;
                // clearing is expressed only as an explicit null.
                if value.is_empty() {
                    return Err(AppError::new("invalid-arguments"));
                }
                item.authors = normalize_authors(value)?;
            }
        }
        match patch.series {
            Patch::Missing => {}
            Patch::Null => item.series = None,
            Patch::Set(value) => item.series = Some(required_text(value)?),
        }
        match patch.series_index {
            Patch::Missing => {}
            Patch::Null => item.series_index = None,
            Patch::Set(value) => {
                if !value.is_finite() {
                    return Err(AppError::new("invalid-arguments"));
                }
                item.series_index = Some(value);
            }
        }
        match patch.publisher {
            Patch::Missing => {}
            Patch::Null => item.publisher = None,
            Patch::Set(value) => item.publisher = Some(required_text(value)?),
        }
        match patch.languages {
            Patch::Missing => {}
            Patch::Null => item.languages = Vec::new(),
            Patch::Set(value) => {
                // The contract requires at least one language when present;
                // clearing is expressed only as an explicit null.
                if value.is_empty() {
                    return Err(AppError::new("invalid-arguments"));
                }
                item.languages = normalize_languages(value)?;
            }
        }
        match patch.identifiers {
            Patch::Missing => {}
            Patch::Null => item.identifiers = BTreeMap::new(),
            Patch::Set(value) => item.identifiers = normalize_identifiers(value)?,
        }
        match patch.custom_metadata {
            Patch::Missing => {}
            Patch::Null => {
                let audit = item.custom_metadata.get(METADATA_AUDIT_KEY).cloned();
                item.custom_metadata.clear();
                if let Some(audit) = audit {
                    item.custom_metadata
                        .insert(METADATA_AUDIT_KEY.to_owned(), audit);
                }
            }
            Patch::Set(value) => {
                if !allow_reserved_metadata && value.contains_key(METADATA_AUDIT_KEY) {
                    return Err(AppError::new("invalid-arguments"));
                }
                let existing_audit = item.custom_metadata.get(METADATA_AUDIT_KEY).cloned();
                item.custom_metadata = normalize_custom_metadata(value)?;
                if !allow_reserved_metadata && let Some(audit) = existing_audit {
                    item.custom_metadata
                        .insert(METADATA_AUDIT_KEY.to_owned(), audit);
                }
            }
        }
        match patch.published_date {
            Patch::Missing => {}
            Patch::Null => item.published_date = None,
            Patch::Set(value) => item.published_date = Some(normalize_published_date(value)?),
        }
        match patch.rating {
            Patch::Missing => {}
            Patch::Null => item.rating = None,
            Patch::Set(value) => {
                if !value.is_finite() || !(0.0..=10.0).contains(&value) {
                    return Err(AppError::new("invalid-arguments"));
                }
                item.rating = Some(value);
            }
        }
        match patch.description {
            Patch::Missing => {}
            Patch::Null => item.description = None,
            Patch::Set(value) => item.description = Some(required_text(value)?),
        }
        match patch.tags {
            Patch::Missing => {}
            // `tags` is not nullable in the contract; an empty array clears it.
            Patch::Null => return Err(AppError::new("invalid-arguments")),
            Patch::Set(value) => item.tags = normalize_texts(value)?,
        }
        item.updated_at = Some(Utc::now().to_rfc3339());

        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE library_items SET title=?2, author=?3, series=?4, series_index=?5,
             publisher=?6, published_date=?7, rating=?8, description=?9, updated_at=?10 WHERE id=?1",
            params![item.id, item.title, item.author, item.series, item.series_index, item.publisher,
                item.published_date, item.rating, item.description, item.updated_at],
        )?;
        if let Some(cover_path) = cover_path {
            transaction.execute(
                "UPDATE library_items SET cover_path=?2 WHERE id=?1",
                params![id, cover_path.to_string_lossy()],
            )?;
        }
        replace_metadata(&transaction, &item)?;
        transaction.commit()?;
        #[cfg(test)]
        ARM_POST_COMMIT_READ_FAULT.with(|armed| {
            if armed.replace(false) {
                POST_COMMIT_READ_FAULT.with(|fault| fault.set(true));
            }
        });
        if let Some(cover_path) = cover_path {
            item.cover_path = Some(cover_path.to_path_buf());
        }
        Ok(item)
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
            if format.provenance == Provenance::Managed
                && !self.path_is_referenced(&format.path.to_string_lossy())?
            {
                cleanup_managed(&self.paths.items, &format.path, format.fingerprint.as_ref())?;
            }
        }
        if let Some(path) = &item.cover_path
            && path.starts_with(&self.paths.covers)
            && !self.path_is_referenced(&path.to_string_lossy())?
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
        migration::verify_current(&self.connection, &self.paths)?;
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
        let destination = safe_new_tree_path(destination, &self.paths.root)?;
        if destination.exists() {
            return Err(AppError::new("destination-exists"));
        }
        let result = (|| -> AppResult<BackupReport> {
            fs::create_dir_all(&destination).map_err(|_| AppError::new("backup-failed"))?;
            let database_path = destination.join("library.sqlite");
            let backup_paths = LibraryPaths::resolve(None, Some(&database_path))?;
            let mut output =
                Connection::open(&database_path).map_err(|_| AppError::new("backup-failed"))?;
            let backup = rusqlite::backup::Backup::new(&self.connection, &mut output)
                .map_err(|_| AppError::new("backup-failed"))?;
            backup
                .run_to_completion(16, std::time::Duration::from_millis(10), None)
                .map_err(|_| AppError::new("backup-failed"))?;
            drop(backup);
            rebase_owned_paths(&mut output, &self.paths, &backup_paths)
                .map_err(|_| AppError::new("backup-failed"))?;
            drop(output);
            copy_tree_if_present(&self.paths.items, &backup_paths.items)?;
            copy_tree_if_present(&self.paths.covers, &backup_paths.covers)?;
            let report = Self::open(backup_paths.clone(), false)?.verify()?;
            let managed_files = report.managed_formats;
            let manifest = serde_json::json!({
                "version": 1,
                "schemaVersion": LIBRARY_SCHEMA_VERSION,
                "createdAt": Utc::now().to_rfc3339(),
                "sourceRoot": backup_paths.root,
                "managedFiles": managed_files,
            });
            fs::write(
                destination.join("manifest.json"),
                serde_json::to_vec_pretty(&manifest).map_err(|_| AppError::new("backup-failed"))?,
            )
            .map_err(|_| AppError::new("backup-failed"))?;
            Ok(BackupReport {
                destination_path: backup_paths.root,
                database_path: backup_paths.database,
                managed_files,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&destination);
        }
        result
    }

    pub fn restore_backup(source: &Path, paths: LibraryPaths) -> AppResult<RestoreReport> {
        let source = source
            .canonicalize()
            .map_err(|_| AppError::new("source-invalid"))?;
        let destinations = [&paths.database, &paths.jobs, &paths.items, &paths.covers];
        let destination_exists = destinations.iter().any(|path| path.exists());
        let destination_overlaps_source = destinations.iter().any(|path| path.starts_with(&source));
        if !source.is_dir() || destination_overlaps_source || destination_exists {
            return Err(AppError::new(if destination_exists {
                "destination-exists"
            } else {
                "source-invalid"
            }));
        }
        let manifest: Value = serde_json::from_slice(
            &fs::read(source.join("manifest.json")).map_err(|_| AppError::new("source-invalid"))?,
        )
        .map_err(|_| AppError::new("source-invalid"))?;
        if manifest.get("version").and_then(Value::as_u64) != Some(1)
            || manifest.get("schemaVersion").and_then(Value::as_i64) != Some(LIBRARY_SCHEMA_VERSION)
            || manifest.get("sourceRoot").and_then(Value::as_str).is_none()
            || !source.join("library.sqlite").is_file()
        {
            return Err(AppError::new("source-invalid"));
        }
        let source_paths = LibraryPaths::resolve(
            None,
            Some(
                &Path::new(
                    manifest
                        .get("sourceRoot")
                        .and_then(Value::as_str)
                        .ok_or_else(|| AppError::new("source-invalid"))?,
                )
                .join("library.sqlite"),
            ),
        )?;
        let created_root = !paths.root.exists();
        let result = (|| -> AppResult<RestoreReport> {
            fs::create_dir_all(&paths.root).map_err(|_| AppError::new("restore-failed"))?;
            fs::copy(source.join("library.sqlite"), &paths.database)
                .map_err(|_| AppError::new("restore-failed"))?;
            copy_tree_if_present(&source.join("items"), &paths.items)
                .map_err(|_| AppError::new("restore-failed"))?;
            copy_tree_if_present(&source.join("covers"), &paths.covers)
                .map_err(|_| AppError::new("restore-failed"))?;
            let mut connection =
                Connection::open(&paths.database).map_err(|_| AppError::new("restore-failed"))?;
            rebase_owned_paths(&mut connection, &source_paths, &paths)
                .map_err(|_| AppError::new("restore-failed"))?;
            drop(connection);
            let report = Self::open(paths.clone(), false)?.verify()?;
            Ok(RestoreReport {
                source_path: source,
                database_path: paths.database.clone(),
                report,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&paths.database);
            let _ = fs::remove_dir_all(&paths.items);
            let _ = fs::remove_dir_all(&paths.covers);
            if created_root {
                let _ = fs::remove_dir(&paths.root);
            }
        }
        result
    }

    pub fn list_saved_views(&self) -> AppResult<Vec<SavedView>> {
        let mut statement = self.connection.prepare(
            "SELECT id,name,definition_json,created_at,updated_at FROM saved_library_views ORDER BY name COLLATE NOCASE,id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, name, definition, created_at, updated_at)| {
                let definition: Value = serde_json::from_str(&definition)
                    .map_err(|_| AppError::new("invalid-stored-data"))?;
                validate_saved_view_definition(&definition)
                    .map_err(|_| AppError::new("invalid-stored-data"))?;
                Ok(SavedView {
                    id,
                    name,
                    definition,
                    created_at,
                    updated_at,
                })
            })
            .collect()
    }

    pub fn save_view(&self, request: &Value) -> AppResult<SavedView> {
        let request_object = request
            .as_object()
            .filter(|object| {
                object.len() == 3
                    && object.contains_key("id")
                    && object.contains_key("name")
                    && object.contains_key("definition")
            })
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 256)
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let name = request
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 120)
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let definition = request_object
            .get("definition")
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        validate_saved_view_definition(definition)?;
        let now = Utc::now().to_rfc3339();
        let definition_json =
            serde_json::to_string(definition).map_err(|_| AppError::new("invalid-arguments"))?;
        self.connection.execute(
            "INSERT INTO saved_library_views(id,name,definition_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition_json=excluded.definition_json,updated_at=excluded.updated_at",
            params![id, name, definition_json, now],
        )?;
        self.connection.query_row(
            "SELECT id,name,definition_json,created_at,updated_at FROM saved_library_views WHERE id=?1",
            [id],
            |row| {
                let definition: String = row.get(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    definition,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(AppError::from)
        .and_then(|(id, name, definition, created_at, updated_at)| {
            Ok(SavedView {
                id,
                name,
                definition: serde_json::from_str(&definition)
                    .map_err(|_| AppError::new("invalid-stored-data"))?,
                created_at,
                updated_at,
            })
        })
    }

    pub fn remove_view(&self, id: &str) -> AppResult<Option<SavedView>> {
        let view = self
            .list_saved_views()?
            .into_iter()
            .find(|view| view.id == id);
        if view.is_none() {
            return Ok(None);
        }
        self.connection
            .execute("DELETE FROM saved_library_views WHERE id=?1", [id])?;
        Ok(view)
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
        read_stored_format(&self.connection, id, format)
    }

    fn read_item(&self, id: &str) -> AppResult<Option<LibraryItem>> {
        #[cfg(test)]
        if POST_COMMIT_READ_FAULT.with(|fault| fault.replace(false)) {
            return Err(AppError::new("storage-unavailable"));
        }
        read_item_from(&self.connection, id)
    }
}

fn read_item_from(connection: &Connection, id: &str) -> AppResult<Option<LibraryItem>> {
    let base = connection
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
    let formats = read_formats(connection, id)?;
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
        authors: read_authors(connection, id)?,
        series: base.series,
        series_index: base.series_index,
        publisher: base.publisher,
        languages: read_values(connection, "library_item_languages", "language", id)?,
        identifiers: read_map(connection, "library_item_identifiers", "scheme", id)?,
        custom_metadata: read_map(connection, "library_item_custom_metadata", "name", id)?,
        published_date: base.published_date,
        rating: base.rating,
        description: base.description,
        cover_path: base.cover_path,
        tags: read_tags(connection, id)?,
        updated_at: base.updated_at,
    }))
}

fn append_query_scope(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    scope: LibraryQueryScope<'_>,
) -> AppResult<()> {
    match scope.syntax {
        LibraryQuerySyntax::Literal => {
            if !scope.query.is_empty() {
                append_structured_term(sql, values, None, scope.query, false);
            }
        }
        LibraryQuerySyntax::StructuredV1 => {
            for term in parse_structured_query(scope.query)? {
                append_structured_term(
                    sql,
                    values,
                    term.field.as_deref(),
                    &term.value,
                    term.negated,
                );
            }
        }
    }
    if !scope.filters.authors.is_empty() {
        let legacy = query_placeholders(scope.filters.authors, values);
        let ordered = query_placeholders(scope.filters.authors, values);
        sql.push_str(&format!(
            " AND (li.author COLLATE NOCASE IN ({legacy})
               OR EXISTS(SELECT 1 FROM library_item_authors fa
                         WHERE fa.library_item_id=li.id
                           AND fa.name COLLATE NOCASE IN ({ordered})))"
        ));
    }
    if !scope.filters.tags.is_empty() {
        let placeholders = query_placeholders(scope.filters.tags, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_tags fit
                         JOIN tags ft ON ft.normalized_name=fit.tag_normalized_name
                         WHERE fit.library_item_id=li.id
                           AND ft.name COLLATE NOCASE IN ({placeholders}))"
        ));
    }
    if !scope.filters.series.is_empty() {
        let placeholders = query_placeholders(scope.filters.series, values);
        sql.push_str(&format!(
            " AND li.series COLLATE NOCASE IN ({placeholders})"
        ));
    }
    if !scope.filters.languages.is_empty() {
        let placeholders = query_placeholders(scope.filters.languages, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_languages fl
                         WHERE fl.library_item_id=li.id
                           AND fl.language COLLATE NOCASE IN ({placeholders}))"
        ));
    }
    if !scope.filters.formats.is_empty() {
        let placeholders = query_placeholders(scope.filters.formats, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_formats ff
                         WHERE ff.library_item_id=li.id
                           AND ff.format IN ({placeholders}))"
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct StructuredQueryTerm {
    field: Option<String>,
    value: String,
    negated: bool,
}

fn parse_structured_query(query: &str) -> AppResult<Vec<StructuredQueryTerm>> {
    if query.encode_utf16().count() > 1024 {
        return Err(AppError::new("invalid-arguments"));
    }
    let mut tokens = Vec::<(String, Option<usize>, bool)>::new();
    let mut token = String::new();
    let mut field_separator = None;
    let mut token_was_quoted = false;
    let mut quoted = false;
    let mut escaped = false;
    for character in query.chars() {
        if escaped {
            if !matches!(character, '"' | '\\') {
                return Err(AppError::new("invalid-query"));
            }
            token.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
            token_was_quoted = true;
        } else if character.is_ascii_whitespace() && !quoted {
            if !token.is_empty() {
                tokens.push((
                    std::mem::take(&mut token),
                    field_separator.take(),
                    std::mem::take(&mut token_was_quoted),
                ));
            }
        } else if character == ':' && !quoted && field_separator.is_none() {
            field_separator = Some(token.len());
            token.push(character);
        } else if matches!(character, '(' | ')') && !quoted {
            return Err(AppError::new("invalid-query"));
        } else {
            token.push(character);
        }
    }
    if escaped || quoted {
        return Err(AppError::new("invalid-query"));
    }
    if !token.is_empty() {
        tokens.push((token, field_separator, token_was_quoted));
    }
    if tokens.len() > 64 {
        return Err(AppError::new("invalid-query"));
    }

    let mut terms = Vec::new();
    let mut negated = false;
    let mut explicit_and_pending = false;
    for (token, field_separator, token_was_quoted) in tokens {
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("and") {
            if terms.is_empty() || explicit_and_pending || negated {
                return Err(AppError::new("invalid-query"));
            }
            explicit_and_pending = true;
            continue;
        }
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("or") {
            return Err(AppError::new("invalid-query"));
        }
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("not") {
            if negated {
                return Err(AppError::new("invalid-query"));
            }
            negated = true;
            continue;
        }
        let (field, value) = field_separator.map_or((None, token.as_str()), |separator| {
            let field = &token[..separator];
            (
                Some(if field.starts_with('#') {
                    field.to_owned()
                } else {
                    field.to_ascii_lowercase()
                }),
                &token[separator + 1..],
            )
        });
        if value.is_empty() || value.encode_utf16().count() > 256 {
            return Err(AppError::new("invalid-query"));
        }
        if let Some(field) = field.as_deref() {
            let valid = matches!(
                field,
                "title"
                    | "author"
                    | "authors"
                    | "tag"
                    | "tags"
                    | "series"
                    | "publisher"
                    | "language"
                    | "languages"
                    | "format"
                    | "formats"
                    | "identifier"
                    | "identifiers"
                    | "comments"
                    | "description"
            ) || field
                .strip_prefix('#')
                .is_some_and(|key| valid_custom_metadata_key(key) && key != METADATA_AUDIT_KEY);
            if !valid {
                return Err(AppError::new("invalid-query"));
            }
        }
        terms.push(StructuredQueryTerm {
            field,
            value: value.to_owned(),
            negated,
        });
        negated = false;
        explicit_and_pending = false;
        if terms.len() > 32 {
            return Err(AppError::new("invalid-query"));
        }
    }
    if negated || explicit_and_pending {
        return Err(AppError::new("invalid-query"));
    }
    Ok(terms)
}

fn append_structured_term(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    field: Option<&str>,
    value: &str,
    negated: bool,
) {
    let needle = format!(
        "%{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    sql.push_str(if negated { " AND NOT (" } else { " AND (" });
    match field {
        None => {
            sql.push_str(
                "li.title LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR COALESCE(li.author,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_authors qa
                           WHERE qa.library_item_id=li.id
                             AND qa.name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                 OR COALESCE(li.series,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_tags qit
                           JOIN tags qt ON qt.normalized_name=qit.tag_normalized_name
                           WHERE qit.library_item_id=li.id
                             AND qt.name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                 OR EXISTS(SELECT 1 FROM library_item_custom_metadata qm
                           WHERE qm.library_item_id=li.id
                             AND qm.name<>?
                             AND (qm.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                                  OR qm.value LIKE ? ESCAPE '\\' COLLATE NOCASE))",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle.clone()), 5));
            values.push(SqlValue::Text(METADATA_AUDIT_KEY.to_owned()));
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("title") => append_like(sql, values, "li.title", needle),
        Some("author" | "authors") => {
            sql.push_str(
                "COALESCE(li.author,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_authors qa
                           WHERE qa.library_item_id=li.id
                             AND qa.name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("tag" | "tags") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_tags qit
                        JOIN tags qt ON qt.normalized_name=qit.tag_normalized_name
                        WHERE qit.library_item_id=li.id
                          AND qt.name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("series") => append_like(sql, values, "li.series", needle),
        Some("publisher") => append_like(sql, values, "li.publisher", needle),
        Some("language" | "languages") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_languages ql
                        WHERE ql.library_item_id=li.id
                          AND ql.language LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("format" | "formats") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_formats qf
                        WHERE qf.library_item_id=li.id
                          AND qf.format LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("identifier" | "identifiers") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_identifiers qi
                        WHERE qi.library_item_id=li.id
                          AND (qi.scheme LIKE ? ESCAPE '\\' COLLATE NOCASE
                               OR qi.value LIKE ? ESCAPE '\\' COLLATE NOCASE))",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("comments" | "description") => append_like(sql, values, "li.description", needle),
        Some(field) if field.starts_with('#') => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_custom_metadata qm
                        WHERE qm.library_item_id=li.id
                          AND qm.name=?
                          AND qm.value LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(field[1..].to_owned()));
            values.push(SqlValue::Text(needle));
        }
        Some(_) => unreachable!("structured query fields are validated"),
    }
    sql.push(')');
}

fn append_like(sql: &mut String, values: &mut Vec<SqlValue>, column: &str, needle: String) {
    sql.push_str("COALESCE(");
    sql.push_str(column);
    sql.push_str(",'') LIKE ? ESCAPE '\\' COLLATE NOCASE");
    values.push(SqlValue::Text(needle));
}

fn query_placeholders(values: &[String], parameters: &mut Vec<SqlValue>) -> String {
    parameters.extend(values.iter().cloned().map(SqlValue::Text));
    std::iter::repeat_n("?", values.len())
        .collect::<Vec<_>>()
        .join(",")
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

fn normalize_duplicate_text(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn compare_duplicate_strings(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn canonical_pair(left: &str, right: &str) -> (String, String) {
    if compare_duplicate_strings(left, right).is_lt() {
        (left.to_owned(), right.to_owned())
    } else {
        (right.to_owned(), left.to_owned())
    }
}

fn valid_pair(left: &str, right: &str) -> bool {
    !left.is_empty() && compare_duplicate_strings(left, right).is_lt()
}

fn valid_review_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_duplicate_page(request: &ListDuplicateCandidatesRequest) -> AppResult<()> {
    if request.page.limit == 0
        || request.page.limit > 100
        || !matches!(request.disposition.as_str(), "unreviewed" | "kept-both")
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn validate_pair_request(request: &DuplicatePairReviewRequest) -> AppResult<()> {
    if !valid_pair(&request.left_id, &request.right_id)
        || !valid_review_token(&request.review_token)
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn validate_merge_request(request: &MergeDuplicatePairRequest) -> AppResult<()> {
    if request.target_id.is_empty()
        || request.source_id.is_empty()
        || request.target_id == request.source_id
        || !valid_review_token(&request.review_token)
        || !request.metadata.is_object()
        || request.metadata.as_object().is_some_and(Map::is_empty)
        || !matches!(request.cover.as_str(), "target" | "source" | "none")
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn signal_sort_key(signal: &DuplicateSignal) -> String {
    match signal {
        DuplicateSignal::SameContent {
            left_format,
            right_format,
            bytes,
            sha256,
        } => format!(
            "0\0{}\0{}\0{bytes:016}\0{sha256}",
            left_format.as_str(),
            right_format.as_str()
        ),
        DuplicateSignal::SameIdentifier { scheme, value } => {
            format!("1\0{}\0{value}", normalize_duplicate_text(scheme))
        }
        DuplicateSignal::SameTitleAuthor { title, author } => format!(
            "2\0{}\0{}",
            normalize_duplicate_text(title),
            normalize_duplicate_text(author)
        ),
    }
}

fn add_duplicate_signal(
    signals: &mut BTreeMap<(String, String), BTreeMap<String, DuplicateSignal>>,
    left: &str,
    right: &str,
    signal: DuplicateSignal,
) -> AppResult<()> {
    if left == right {
        return Ok(());
    }
    let pair = canonical_pair(left, right);
    let key = serde_json::to_string(&signal).map_err(|_| AppError::new("invalid-stored-data"))?;
    signals.entry(pair).or_default().insert(key, signal);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateReviewSeed<'a> {
    version: u8,
    left_id: &'a str,
    right_id: &'a str,
    signals: &'a [DuplicateSignal],
}

fn scan_duplicate_candidates_in(
    connection: &Connection,
) -> AppResult<(Vec<DuplicateCandidate>, DuplicateScanSummary)> {
    let mut ids = Vec::new();
    let mut statement =
        connection.prepare("SELECT id FROM library_items WHERE trashed_at IS NULL ORDER BY id")?;
    for id in statement.query_map([], |row| row.get::<_, String>(0))? {
        ids.push(id?);
    }
    drop(statement);
    let mut items = HashMap::new();
    for id in ids {
        let item =
            read_item_from(connection, &id)?.ok_or_else(|| AppError::new("invalid-stored-data"))?;
        items.insert(id, item);
    }

    let mut signals = BTreeMap::<(String, String), BTreeMap<String, DuplicateSignal>>::new();
    let mut fingerprints = HashMap::<(u64, String), Vec<(String, FormatId)>>::new();
    let mut files_hashed = 0;
    let mut fingerprints_reused = 0;
    let mut unreadable_formats = 0;
    let mut statement = connection.prepare(
        "SELECT f.library_item_id,f.format,f.source_path,f.provenance,f.content_bytes,f.content_sha256
         FROM library_item_formats f JOIN library_items i ON i.id=f.library_item_id
         WHERE i.trashed_at IS NULL ORDER BY f.library_item_id,f.position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    for row in rows {
        let (item_id, format, path, provenance, bytes, sha) = row?;
        let format = FormatId::ALL
            .into_iter()
            .find(|candidate| candidate.as_str() == format)
            .ok_or_else(|| AppError::new("invalid-stored-data"))?;
        let fingerprint = if provenance == "managed" {
            let bytes = bytes
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| AppError::new("invalid-stored-data"))?;
            if bytes > MAX_SAFE_INTEGER {
                return Err(AppError::new("invalid-stored-data"));
            }
            let sha = sha
                .filter(|value| valid_review_token(value))
                .ok_or_else(|| AppError::new("invalid-stored-data"))?;
            fingerprints_reused += 1;
            Some((bytes, sha))
        } else if provenance == "referenced" {
            match hash_file(Path::new(&path)) {
                Ok(value) => {
                    files_hashed += 1;
                    if value.0 > MAX_SAFE_INTEGER {
                        return Err(AppError::new("invalid-stored-data"));
                    }
                    Some(value)
                }
                Err(_) => {
                    unreadable_formats += 1;
                    None
                }
            }
        } else {
            return Err(AppError::new("invalid-stored-data"));
        };
        if let Some((bytes, sha)) = fingerprint
            && bytes > 0
        {
            fingerprints
                .entry((bytes, sha))
                .or_default()
                .push((item_id, format));
        }
    }
    drop(statement);
    for ((bytes, sha256), entries) in fingerprints {
        for left_index in 0..entries.len() {
            for right_index in (left_index + 1)..entries.len() {
                let (left, right) = (&entries[left_index], &entries[right_index]);
                let ((left_id, left_format), (right_id, right_format)) =
                    if compare_duplicate_strings(&left.0, &right.0).is_lt() {
                        (left, right)
                    } else {
                        (right, left)
                    };
                add_duplicate_signal(
                    &mut signals,
                    left_id,
                    right_id,
                    DuplicateSignal::SameContent {
                        left_format: *left_format,
                        right_format: *right_format,
                        bytes,
                        sha256: sha256.clone(),
                    },
                )?;
            }
        }
    }

    let mut identifiers = HashMap::<(String, String), Vec<(String, String, String)>>::new();
    let mut titles = HashMap::<(String, String), Vec<(String, String, String)>>::new();
    let mut item_ids = items.keys().cloned().collect::<Vec<_>>();
    item_ids.sort_by(|left, right| compare_duplicate_strings(left, right));
    for item_id in item_ids {
        let item = items
            .get(&item_id)
            .ok_or_else(|| AppError::new("invalid-stored-data"))?;
        for (scheme, value) in &item.identifiers {
            let normalized_scheme = normalize_duplicate_text(scheme);
            let value = value.trim();
            if !normalized_scheme.is_empty() && !value.is_empty() {
                identifiers
                    .entry((normalized_scheme, value.to_owned()))
                    .or_default()
                    .push((item.id.clone(), scheme.trim().to_owned(), value.to_owned()));
            }
        }
        let title = normalize_duplicate_text(&item.title);
        let authors = if item.authors.is_empty() {
            item.author.iter().cloned().collect::<Vec<_>>()
        } else {
            item.authors
                .iter()
                .map(|author| author.name.clone())
                .collect()
        };
        let mut unique_authors = BTreeMap::new();
        for author in authors {
            let normalized = normalize_duplicate_text(&author);
            if !normalized.is_empty() {
                unique_authors
                    .entry(normalized)
                    .or_insert_with(|| author.trim().to_owned());
            }
        }
        for (author_key, author) in unique_authors {
            if !title.is_empty() {
                titles
                    .entry((title.clone(), author_key))
                    .or_default()
                    .push((item.id.clone(), item.title.trim().to_owned(), author));
            }
        }
    }
    for entries in identifiers.values() {
        for left in 0..entries.len() {
            for right in (left + 1)..entries.len() {
                add_duplicate_signal(
                    &mut signals,
                    &entries[left].0,
                    &entries[right].0,
                    DuplicateSignal::SameIdentifier {
                        scheme: entries[left].1.clone(),
                        value: entries[left].2.clone(),
                    },
                )?;
            }
        }
    }
    for entries in titles.values() {
        for left in 0..entries.len() {
            for right in (left + 1)..entries.len() {
                add_duplicate_signal(
                    &mut signals,
                    &entries[left].0,
                    &entries[right].0,
                    DuplicateSignal::SameTitleAuthor {
                        title: entries[left].1.clone(),
                        author: entries[left].2.clone(),
                    },
                )?;
            }
        }
    }

    let mut candidates = Vec::new();
    for ((left_id, right_id), signal_map) in signals {
        let mut pair_signals = signal_map.into_values().collect::<Vec<_>>();
        pair_signals.sort_by(|left, right| {
            compare_duplicate_strings(&signal_sort_key(left), &signal_sort_key(right))
        });
        let bytes = serde_json::to_vec(&DuplicateReviewSeed {
            version: 1,
            left_id: &left_id,
            right_id: &right_id,
            signals: &pair_signals,
        })
        .map_err(|_| AppError::new("invalid-stored-data"))?;
        let review_token = hex::encode(Sha256::digest(bytes));
        candidates.push(DuplicateCandidate {
            left: items
                .get(&left_id)
                .cloned()
                .ok_or_else(|| AppError::new("invalid-stored-data"))?,
            right: items
                .get(&right_id)
                .cloned()
                .ok_or_else(|| AppError::new("invalid-stored-data"))?,
            signals: pair_signals,
            review_token,
        });
    }
    candidates.sort_by(|left, right| {
        compare_duplicate_strings(
            &signal_sort_key(&left.signals[0]),
            &signal_sort_key(&right.signals[0]),
        )
        .then_with(|| {
            compare_duplicate_strings(
                &normalize_duplicate_text(&left.left.title),
                &normalize_duplicate_text(&right.left.title),
            )
        })
        .then_with(|| {
            compare_duplicate_strings(
                &normalize_duplicate_text(&left.right.title),
                &normalize_duplicate_text(&right.right.title),
            )
        })
        .then_with(|| compare_duplicate_strings(&left.left.id, &right.left.id))
        .then_with(|| compare_duplicate_strings(&left.right.id, &right.right.id))
    });
    Ok((
        candidates,
        DuplicateScanSummary {
            files_hashed,
            fingerprints_reused,
            unreadable_formats,
        },
    ))
}

fn apply_duplicate_metadata(item: &mut LibraryItem, metadata: &Value) -> AppResult<()> {
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

fn write_duplicate_metadata(transaction: &Transaction<'_>, item: &LibraryItem) -> AppResult<()> {
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
         CREATE TABLE library_custom_column_definitions (
           key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
           label TEXT NOT NULL CHECK(length(label)>0),
           type TEXT NOT NULL CHECK(type='text'),
           position INTEGER NOT NULL UNIQUE CHECK(position>=0)) STRICT;
         CREATE TABLE saved_library_views (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
         CREATE TABLE duplicate_pair_reviews (left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           review_token TEXT NOT NULL CHECK(length(review_token)=64 AND review_token NOT GLOB '*[^0-9a-f]*'),
           reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)>0), PRIMARY KEY(left_id,right_id), CHECK(left_id<right_id)) STRICT;
         CREATE TABLE library_adoptions (id TEXT PRIMARY KEY CHECK(length(id)>0),
           library_item_id TEXT NOT NULL UNIQUE CHECK(length(library_item_id)>0), title TEXT NOT NULL CHECK(length(title)>0),
           source_path TEXT NOT NULL CHECK(length(source_path)>0), target_path TEXT NOT NULL UNIQUE CHECK(length(target_path)>0),
           format TEXT NOT NULL CHECK(format IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
           state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
           created_at TEXT NOT NULL CHECK(length(created_at)>0), updated_at TEXT NOT NULL CHECK(length(updated_at)>0),
           CHECK(source_path<>target_path)) STRICT;
         CREATE TABLE managed_file_cleanup (source_path TEXT PRIMARY KEY,
           kind TEXT NOT NULL DEFAULT 'format' CHECK(kind IN ('format','cover'))) STRICT;
         CREATE TABLE source_file_cleanup (source_path TEXT PRIMARY KEY CHECK(length(source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')) STRICT;
         CREATE TABLE import_watch_observations (
           canonical_source_path TEXT PRIMARY KEY CHECK(length(canonical_source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
           outcome TEXT NOT NULL CHECK(outcome IN ('imported','duplicate','unsupported','failed')),
           accounted_at TEXT NOT NULL CHECK(length(accounted_at)>0)) STRICT;
         CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE,id);
         CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE,id);
         CREATE INDEX library_items_by_series ON library_items(series COLLATE NOCASE,series_index,id);
         CREATE INDEX library_items_by_published_date ON library_items(published_date,id);
         CREATE INDEX library_items_by_rating ON library_items(rating,id);
         CREATE INDEX library_items_by_added_at ON library_items(added_at,id);
         CREATE INDEX library_items_by_updated_at ON library_items(updated_at,id);
         CREATE INDEX library_items_by_trashed_at
           ON library_items(trashed_at DESC,id ASC) WHERE trashed_at IS NOT NULL;
         CREATE INDEX library_item_formats_by_format ON library_item_formats(format,library_item_id);
         CREATE INDEX library_item_formats_by_fingerprint ON library_item_formats(content_bytes,content_sha256,library_item_id,position)
           WHERE provenance='managed';
         CREATE INDEX library_item_authors_by_name ON library_item_authors(name COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_languages_by_language ON library_item_languages(language COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_tags_by_tag ON library_item_tags(tag_normalized_name,library_item_id);
         CREATE INDEX saved_library_views_by_name ON saved_library_views(name COLLATE NOCASE,id);
         CREATE INDEX library_adoptions_by_state ON library_adoptions(state,updated_at,id);
         CREATE INDEX import_watch_observations_by_accounted_at
           ON import_watch_observations(accounted_at,canonical_source_path);
         CREATE INDEX import_watch_observations_by_fingerprint
           ON import_watch_observations(content_bytes,content_sha256,canonical_source_path);
         PRAGMA user_version=12;
         COMMIT;"
    )?;
    Ok(())
}

pub(crate) fn validate_custom_column_definitions(
    definitions: &[CustomColumnDefinition],
) -> AppResult<()> {
    if definitions.len() > MAX_CUSTOM_COLUMN_DEFINITIONS {
        return Err(AppError::new("invalid-arguments"));
    }
    let mut keys = std::collections::HashSet::new();
    for (position, definition) in definitions.iter().enumerate() {
        if definition.column_type != "text"
            || definition.position as usize != position
            || !keys.insert(&definition.key)
        {
            return Err(AppError::new("invalid-arguments"));
        }
        let label = validate_custom_column_definition(&definition.key, &definition.label)?;
        if label != definition.label {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    Ok(())
}

fn validate_custom_column_definition(key: &str, label: &str) -> AppResult<String> {
    if !valid_custom_column_key(key) {
        return Err(AppError::new("invalid-arguments"));
    }
    let label = label.trim();
    if label.is_empty() || label.encode_utf16().count() > 120 {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(label.to_owned())
}

fn valid_custom_column_key(key: &str) -> bool {
    key != METADATA_AUDIT_KEY
        && key.len() <= 64
        && key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
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

fn read_stored_format(
    connection: &Connection,
    id: &str,
    format: FormatId,
) -> AppResult<Option<StoredFormat>> {
    connection
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
    crate::fingerprint::hash_file(path).map_err(|_| AppError::new("source-unavailable"))
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

fn validate_saved_view_definition(definition: &Value) -> AppResult<()> {
    let object = definition
        .as_object()
        .filter(|object| {
            (object.len() == 4 || object.len() == 5)
                && object.contains_key("version")
                && object.contains_key("query")
                && object.contains_key("filters")
                && object.contains_key("sort")
                && object.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "version" | "querySyntax" | "query" | "filters" | "sort"
                    )
                })
        })
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let query_syntax_valid = match object.get("querySyntax") {
        None => true,
        Some(Value::String(value)) => matches!(value.as_str(), "literal" | "structured-v1"),
        Some(_) => false,
    };
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object
            .get("query")
            .and_then(Value::as_str)
            .is_none_or(|query| query.encode_utf16().count() > 1024)
        || !query_syntax_valid
    {
        return Err(AppError::new("invalid-arguments"));
    }
    if object.get("querySyntax").and_then(Value::as_str) == Some("structured-v1") {
        parse_structured_query(
            object
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("invalid-arguments"))?,
        )?;
    }
    let filters = object
        .get("filters")
        .and_then(Value::as_object)
        .filter(|filters| {
            filters.len() == 5
                && filters.contains_key("authors")
                && filters.contains_key("tags")
                && filters.contains_key("series")
                && filters.contains_key("languages")
                && filters.contains_key("formats")
        })
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    for key in ["authors", "tags", "series", "languages"] {
        let values = filters
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let mut seen = std::collections::HashSet::new();
        if values.iter().any(|value| {
            value
                .as_str()
                .map(str::trim)
                .is_none_or(|value| value.is_empty() || !seen.insert(value.to_ascii_lowercase()))
        }) {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    let formats = filters
        .get("formats")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let mut seen_formats = std::collections::HashSet::new();
    if formats.iter().any(|value| {
        value
            .as_str()
            .and_then(|value| value.parse::<FormatId>().ok())
            .is_none_or(|format| !seen_formats.insert(format.as_str()))
    }) {
        return Err(AppError::new("invalid-arguments"));
    }
    let sort = object
        .get("sort")
        .and_then(Value::as_object)
        .filter(|sort| {
            sort.len() == 2 && sort.contains_key("field") && sort.contains_key("direction")
        })
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let field = sort.get("field").and_then(Value::as_str);
    let direction = sort.get("direction").and_then(Value::as_str);
    if !matches!(
        field,
        Some("title" | "author" | "series" | "publishedDate" | "rating" | "addedAt" | "updatedAt")
    ) || !matches!(direction, Some("ascending" | "descending"))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
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

fn validate_library_patch(patch: &LibraryPatch, allow_reserved_metadata: bool) -> AppResult<()> {
    if patch.is_empty() || matches!(patch.title, Patch::Null) || matches!(patch.tags, Patch::Null) {
        return Err(AppError::new("invalid-arguments"));
    }
    for value in [
        patch.title.set(),
        patch.author.set(),
        patch.series.set(),
        patch.publisher.set(),
        patch.description.set(),
    ]
    .into_iter()
    .flatten()
    {
        required_text(value.clone())?;
    }
    if let Patch::Set(values) = &patch.authors {
        if values.is_empty() {
            return Err(AppError::new("invalid-arguments"));
        }
        normalize_authors(values.clone())?;
    }
    if patch
        .series_index
        .set()
        .is_some_and(|value| !value.is_finite())
        || patch
            .rating
            .set()
            .is_some_and(|value| !value.is_finite() || !(0.0..=10.0).contains(value))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    if let Patch::Set(values) = &patch.languages {
        if values.is_empty() {
            return Err(AppError::new("invalid-arguments"));
        }
        normalize_languages(values.clone())?;
    }
    if let Patch::Set(values) = &patch.identifiers {
        normalize_identifiers(values.clone())?;
    }
    if let Patch::Set(values) = &patch.custom_metadata {
        if !allow_reserved_metadata && values.contains_key(METADATA_AUDIT_KEY) {
            return Err(AppError::new("invalid-arguments"));
        }
        normalize_custom_metadata(values.clone())?;
    }
    if let Some(value) = patch.published_date.set() {
        normalize_published_date(value.clone())?;
    }
    if let Patch::Set(values) = &patch.tags {
        normalize_texts(values.clone())?;
    }
    Ok(())
}

fn required_text(value: String) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        Err(AppError::new("invalid-arguments"))
    } else {
        Ok(value.to_owned())
    }
}

fn normalize_languages(values: Vec<String>) -> AppResult<Vec<String>> {
    let values = normalize_texts(values)?;
    if values.iter().all(|value| valid_language_tag(value)) {
        Ok(values)
    } else {
        Err(AppError::new("invalid-arguments"))
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

fn normalize_identifiers(values: BTreeMap<String, String>) -> AppResult<BTreeMap<String, String>> {
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
        return Err(AppError::new("invalid-arguments"));
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

fn valid_custom_metadata_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn normalize_published_date(value: String) -> AppResult<String> {
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
        Err(AppError::new("invalid-arguments"))
    }
}
fn count(connection: &Connection, sql: &str) -> AppResult<u64> {
    let value: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    u64::try_from(value).map_err(|_| AppError::new("invalid-stored-data"))
}

fn count_with_param(connection: &Connection, sql: &str, value: &str) -> AppResult<u64> {
    connection
        .query_row(sql, [value], |row| row.get::<_, i64>(0))
        .map_err(Into::into)
        .and_then(|value| u64::try_from(value).map_err(|_| AppError::new("invalid-stored-data")))
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

fn safe_new_tree_path(path: &Path, owned_root: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if path == owned_root || path.starts_with(owned_root) {
        return Err(AppError::new("invalid-arguments"));
    }
    if let Some(parent) = path.parent()
        && let Ok(parent) = parent.canonicalize()
        && (parent == owned_root || parent.starts_with(owned_root))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(path)
}

fn rebase_owned_paths(
    connection: &mut Connection,
    source: &LibraryPaths,
    destination: &LibraryPaths,
) -> AppResult<()> {
    let formats = {
        let mut statement = connection.prepare(
            "SELECT library_item_id,format,source_path FROM library_item_formats WHERE provenance='managed'",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let covers = {
        let mut statement = connection
            .prepare("SELECT id,cover_path FROM library_items WHERE cover_path IS NOT NULL")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let transaction = connection.transaction()?;
    for (id, format, stored) in formats {
        let relative = Path::new(&stored)
            .strip_prefix(&source.items)
            .map_err(|_| AppError::new("invalid-stored-data"))?;
        let rebased = destination.items.join(relative);
        transaction.execute(
            "UPDATE library_item_formats SET source_path=?3 WHERE library_item_id=?1 AND format=?2 AND provenance='managed'",
            params![id, format, rebased.to_string_lossy()],
        )?;
    }
    for (id, stored) in covers {
        let relative = Path::new(&stored)
            .strip_prefix(&source.covers)
            .map_err(|_| AppError::new("invalid-stored-data"))?;
        let rebased = destination.covers.join(relative);
        transaction.execute(
            "UPDATE library_items SET cover_path=?2 WHERE id=?1",
            params![id, rebased.to_string_lossy()],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_column_lists_reject_invalid_untrimmed_reserved_and_noncontiguous_rows() {
        let cases = [
            "INSERT INTO library_custom_column_definitions VALUES ('valid',' padded ','text',0)",
            "INSERT INTO library_custom_column_definitions VALUES ('takio_metadata_audit','Audit','text',0)",
            "INSERT INTO library_custom_column_definitions VALUES ('valid','Valid','text',1)",
        ];
        for sql in cases {
            let temp = tempfile::tempdir().unwrap();
            let database = temp.path().join("library.sqlite");
            let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
            let store = LibraryStore::open(paths, true).unwrap();
            store.connection.execute(sql, []).unwrap();
            assert_eq!(
                store.list_custom_column_definitions().unwrap_err().code(),
                "incompatible-schema"
            );
        }
    }

    #[test]
    fn structured_queries_parse_fields_quotes_negation_and_literal_colons() {
        let terms = parse_structured_query(
            r#"author:"Ursula K. Le Guin" and tag:Classic not publisher:Tor #shelf:favorites "https://example.test" "or""#,
        )
        .unwrap();
        assert_eq!(terms.len(), 6);
        assert_eq!(terms[0].field.as_deref(), Some("author"));
        assert_eq!(terms[0].value, "Ursula K. Le Guin");
        assert_eq!(terms[1].field.as_deref(), Some("tag"));
        assert!(terms[2].negated);
        assert_eq!(terms[3].field.as_deref(), Some("#shelf"));
        assert_eq!(terms[4].field, None);
        assert_eq!(terms[4].value, "https://example.test");
        assert_eq!(terms[5].value, "or");

        for invalid in [
            "author:\"unfinished",
            "unknown:value",
            "author:Asimov or author:Butler",
            "and author:Asimov",
            "author:Asimov and",
            "not",
            "(author:Asimov)",
            "#Bad:value",
            "#bad-key:value",
            "#takio_metadata_audit:value",
        ] {
            assert_eq!(
                parse_structured_query(invalid).unwrap_err().code(),
                "invalid-query"
            );
        }
    }

    #[test]
    fn custom_metadata_queries_match_safe_fields_and_literals_without_exposing_audit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let source = temp.path().join("earthsea.txt");
        fs::write(&source, "earthsea").unwrap();
        let item = store.import(&source, Some("Earthsea"), false).unwrap();
        store
            .update(
                &item.id,
                LibraryPatch {
                    custom_metadata: Patch::Set(BTreeMap::from([(
                        "shelf".to_owned(),
                        "Favorite Classics".to_owned(),
                    )])),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO library_item_custom_metadata(library_item_id,name,value) VALUES(?1,?2,?3)",
                params![item.id, METADATA_AUDIT_KEY, "hidden provenance"],
            )
            .unwrap();
        let empty = Vec::<String>::new();
        let filters = LibraryQueryFilters {
            authors: &empty,
            tags: &empty,
            series: &empty,
            languages: &empty,
            formats: &empty,
        };

        for (query, syntax) in [
            ("#shelf:favorite", LibraryQuerySyntax::StructuredV1),
            ("shelf", LibraryQuerySyntax::Literal),
            ("classics", LibraryQuerySyntax::Literal),
        ] {
            assert_eq!(
                store
                    .query_items_scoped(&[LibraryQueryScope {
                        query,
                        syntax,
                        filters
                    }])
                    .unwrap()
                    .len(),
                1
            );
        }
        assert!(
            store
                .query_items_scoped(&[LibraryQueryScope {
                    query: "provenance",
                    syntax: LibraryQuerySyntax::Literal,
                    filters,
                }])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn structured_queries_execute_conjunctive_field_and_negation_terms() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        for (file, title, author, tag, publisher) in [
            (
                "earthsea.txt",
                "Classic Earthsea",
                "Ursula K. Le Guin",
                "Classic",
                "Parnassus",
            ),
            (
                "modern.txt",
                "Modern Earthsea",
                "Ursula K. Le Guin",
                "Modern",
                "Tor",
            ),
            (
                "kindred.txt",
                "Classic Kindred",
                "Octavia E. Butler",
                "Classic",
                "Beacon",
            ),
        ] {
            let source = temp.path().join(file);
            fs::write(&source, file).unwrap();
            let item = store.import(&source, Some(title), false).unwrap();
            store
                .update(
                    &item.id,
                    LibraryPatch {
                        authors: Patch::Set(vec![BookAuthor {
                            name: author.to_owned(),
                            sort_name: None,
                        }]),
                        tags: Patch::Set(vec![tag.to_owned()]),
                        publisher: Patch::Set(publisher.to_owned()),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let empty = Vec::<String>::new();
        let items = store
            .query_items_scoped(&[LibraryQueryScope {
                query: "author:\"Ursula K. Le Guin\" tag:Classic not publisher:Tor",
                syntax: LibraryQuerySyntax::StructuredV1,
                filters: LibraryQueryFilters {
                    authors: &empty,
                    tags: &empty,
                    series: &empty,
                    languages: &empty,
                    formats: &empty,
                },
            }])
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Classic Earthsea");
    }

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

    #[test]
    fn candidate_cover_apply_rolls_back_metadata_and_keeps_stage_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store
            .import(&source, Some("Original title"), false)
            .unwrap();
        let descriptor = crate::candidate_cover::stage(
            &store.paths.root,
            &item.id,
            "embedded:cover",
            "embedded",
            "proof",
            &crate::candidate_cover::CapturedCover {
                bytes: vec![0xff, 0xd8, 0xff, 1, 2, 3],
                media_type: "image/jpeg".to_owned(),
                extension: ".jpg".to_owned(),
            },
        )
        .unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_candidate_cover
                 BEFORE UPDATE OF cover_path ON library_items
                 BEGIN SELECT RAISE(FAIL, 'reject candidate cover'); END;",
            )
            .unwrap();

        let error = store
            .apply_metadata_candidate(
                &item.id,
                LibraryPatch {
                    title: Patch::Set("Changed title".to_owned()),
                    ..LibraryPatch::default()
                },
                Some(&descriptor),
                "embedded:cover",
                "embedded",
                "proof",
            )
            .unwrap_err();

        assert_eq!(error.code(), "storage-unavailable");
        let unchanged = store.get(&item.id).unwrap().unwrap();
        assert_eq!(unchanged.title, "Original title");
        assert!(unchanged.cover_path.is_none());
        assert_eq!(fs::read_dir(&store.paths.covers).unwrap().count(), 0);
        assert!(
            crate::candidate_cover::validate(
                &store.paths.root,
                &item.id,
                "embedded:cover",
                "embedded",
                "proof",
                &descriptor,
            )
            .is_ok(),
            "failed application must retain the staged artifact for a retry"
        );
    }

    #[test]
    fn candidate_cover_apply_returns_committed_item_without_post_commit_hydration() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store
            .import(&source, Some("Original title"), false)
            .unwrap();
        let descriptor = crate::candidate_cover::stage(
            &store.paths.root,
            &item.id,
            "embedded:cover",
            "embedded",
            "proof",
            &crate::candidate_cover::CapturedCover {
                bytes: vec![0xff, 0xd8, 0xff, 1, 2, 3],
                media_type: "image/jpeg".to_owned(),
                extension: ".jpg".to_owned(),
            },
        )
        .unwrap();
        ARM_POST_COMMIT_READ_FAULT.with(|armed| armed.set(true));

        let applied = store
            .apply_metadata_candidate(
                &item.id,
                LibraryPatch {
                    title: Patch::Set("Changed title".to_owned()),
                    ..LibraryPatch::default()
                },
                Some(&descriptor),
                "embedded:cover",
                "embedded",
                "proof",
            )
            .unwrap();

        assert_eq!(applied.title, "Changed title");
        assert!(
            applied
                .cover_path
                .as_ref()
                .is_some_and(|path| path.exists())
        );
        assert_eq!(
            store.get(&item.id).unwrap_err().code(),
            "storage-unavailable"
        );
        let committed = store.get(&item.id).unwrap().unwrap();
        assert_eq!(committed.title, "Changed title");
        assert!(committed.cover_path.unwrap().exists());
        assert_eq!(
            crate::candidate_cover::validate(
                &store.paths.root,
                &item.id,
                "embedded:cover",
                "embedded",
                "proof",
                &descriptor,
            )
            .unwrap_err()
            .code(),
            "candidate-cover-unavailable"
        );
    }

    #[test]
    fn verified_artifact_attachment_rejects_mutation_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store.import(&source, Some("Book"), false).unwrap();
        let artifact = temp.path().join("converted.pdf");
        fs::write(&artifact, b"verified pdf").unwrap();
        let expected = hash_file(&artifact).unwrap();

        fs::write(&artifact, b"mutated pdf").unwrap();
        let error = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, expected.0, &expected.1)
            .unwrap_err();
        assert_eq!(error.code(), "artifact-invalid");

        fs::write(&artifact, b"verified pdf").unwrap();
        let attached = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, expected.0, &expected.1)
            .unwrap();
        assert_eq!(attached.formats.len(), 2);

        fs::write(&artifact, b"changed after attachment").unwrap();
        let retried = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, expected.0, &expected.1)
            .unwrap();
        assert_eq!(retried.formats.len(), 2);
    }

    #[test]
    fn verified_artifact_attachment_cleans_up_after_database_failure() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store.import(&source, Some("Book"), false).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_pdf_attachment
                 BEFORE INSERT ON library_item_formats
                 WHEN NEW.format = 'pdf'
                 BEGIN SELECT RAISE(FAIL, 'reject pdf attachment'); END;",
            )
            .unwrap();
        let artifact = temp.path().join("converted.pdf");
        fs::write(&artifact, b"verified pdf").unwrap();
        let expected = hash_file(&artifact).unwrap();
        let target = store.managed_path(&item.id, FormatId::Pdf);

        let error = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, expected.0, &expected.1)
            .unwrap_err();

        assert_eq!(error.code(), "storage-unavailable");
        assert!(!target.exists());
        assert_eq!(store.get(&item.id).unwrap().unwrap().formats.len(), 1);
    }

    #[test]
    fn concurrent_verified_attachment_retries_preserve_the_published_file() {
        use std::sync::{Arc, Barrier};

        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("library.sqlite");
        let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let item = store.import(&source, Some("Book"), false).unwrap();
        drop(store);

        let artifact = temp.path().join("converted.pdf");
        fs::write(&artifact, vec![b'p'; 4 * 1024 * 1024]).unwrap();
        let expected = hash_file(&artifact).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let database = database.clone();
            let artifact = artifact.clone();
            let item_id = item.id.clone();
            let expected = expected.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
                let mut store = LibraryStore::open(paths, false).unwrap();
                barrier.wait();
                store.attach_verified_artifact(
                    &item_id,
                    &artifact,
                    FormatId::Pdf,
                    expected.0,
                    &expected.1,
                )
            }));
        }
        barrier.wait();
        for worker in workers {
            assert!(worker.join().unwrap().is_ok());
        }

        let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
        let store = LibraryStore::open(paths, false).unwrap();
        let attached = store.get(&item.id).unwrap().unwrap();
        assert_eq!(attached.formats.len(), 2);
        let pdf = attached
            .formats
            .iter()
            .find(|format| format.format == FormatId::Pdf)
            .unwrap();
        assert_eq!(hash_file(&pdf.source_path).unwrap(), expected);
    }

    #[test]
    fn duplicate_reviews_are_stable_idempotent_and_reject_stale_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let left_path = temp.path().join("left.epub");
        let right_path = temp.path().join("right.pdf");
        fs::write(&left_path, b"left duplicate bytes").unwrap();
        fs::write(&right_path, b"right duplicate bytes").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let left = store.import(&left_path, Some("Dune"), false).unwrap();
        let right = store.import(&right_path, Some(" dune "), false).unwrap();
        for id in [&left.id, &right.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        authors: Patch::Set(vec![BookAuthor {
                            name: "Frank Herbert".to_owned(),
                            sort_name: None,
                        }]),
                        identifiers: Patch::Set(BTreeMap::from([(
                            "ISBN".to_owned(),
                            "9780441172719".to_owned(),
                        )])),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let request = ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 1,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        };
        let first = store.list_duplicate_candidates(&request).unwrap();
        let second = store.list_duplicate_candidates(&request).unwrap();
        assert_eq!(first.total, 1);
        assert_eq!(first.scan.fingerprints_reused, 2);
        assert_eq!(
            first.candidates[0].review_token,
            second.candidates[0].review_token
        );
        assert_eq!(first.candidates[0].signals.len(), 2);
        let candidate = &first.candidates[0];
        let review = DuplicatePairReviewRequest {
            left_id: candidate.left.id.clone(),
            right_id: candidate.right.id.clone(),
            review_token: candidate.review_token.clone(),
        };
        store.keep_duplicate_pair(&review).unwrap();
        store.keep_duplicate_pair(&review).unwrap();
        assert_eq!(store.list_duplicate_candidates(&request).unwrap().total, 0);
        store.reopen_duplicate_pair(&review).unwrap();
        assert_eq!(store.list_duplicate_candidates(&request).unwrap().total, 1);
        store
            .update(
                &right.id,
                LibraryPatch {
                    title: Patch::Set("Dune revised".to_owned()),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
        assert_eq!(
            store.keep_duplicate_pair(&review).unwrap_err().code(),
            "stale-review"
        );
    }

    #[test]
    fn duplicate_merge_rolls_back_and_purge_preserves_transferred_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let target_path = temp.path().join("target.epub");
        let source_path = temp.path().join("source.mobi");
        let source_pdf = temp.path().join("source.pdf");
        let target_cover = temp.path().join("target.jpg");
        let source_cover = temp.path().join("source.jpg");
        fs::write(&target_path, b"target").unwrap();
        fs::write(&source_path, b"source").unwrap();
        fs::write(&source_pdf, b"transferred pdf").unwrap();
        fs::write(&target_cover, b"target cover").unwrap();
        fs::write(&source_cover, b"source cover").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let target = store.import(&target_path, Some("Target"), false).unwrap();
        let source = store.import(&source_path, Some("Source"), false).unwrap();
        for id in [&target.id, &source.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        identifiers: Patch::Set(BTreeMap::from([(
                            "isbn".to_owned(),
                            "shared".to_owned(),
                        )])),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let source = store.attach_format(&source.id, &source_pdf, true).unwrap();
        store.set_cover(&target.id, &target_cover).unwrap();
        let source = store.set_cover(&source.id, &source_cover).unwrap();
        let transferred_pdf = source
            .formats
            .iter()
            .find(|format| format.format == FormatId::Pdf)
            .unwrap()
            .source_path
            .clone();
        let transferred_cover = source.cover_path.clone().unwrap();
        let page = store
            .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                page: DuplicatePageRequest {
                    limit: 100,
                    offset: 0,
                },
                disposition: "unreviewed".to_owned(),
            })
            .unwrap();
        let token = page.candidates[0].review_token.clone();
        let merge = MergeDuplicatePairRequest {
            target_id: target.id.clone(),
            source_id: source.id.clone(),
            review_token: token.clone(),
            metadata: serde_json::json!({"title":"Merged","tags":["reviewed"]}),
            add_source_formats: vec![FormatId::Pdf],
            cover: "source".to_owned(),
        };
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_duplicate_merge BEFORE UPDATE OF trashed_at ON library_items
                 WHEN NEW.id IS NOT NULL BEGIN SELECT RAISE(FAIL, 'rollback'); END;",
            )
            .unwrap();
        assert_eq!(
            store.merge_duplicate_pair(&merge).unwrap_err().code(),
            "storage-unavailable"
        );
        assert_eq!(store.get(&target.id).unwrap().unwrap().formats.len(), 1);
        store
            .connection
            .execute_batch("DROP TRIGGER reject_duplicate_merge")
            .unwrap();
        let merged = store.merge_duplicate_pair(&merge).unwrap();
        assert_eq!(merged.target.title, "Merged");
        assert_eq!(merged.target.formats.len(), 2);
        assert_eq!(merged.trashed_source.id, source.id);
        assert!(!merged.cleanup_pending);
        store.purge(&source.id).unwrap();
        assert_eq!(fs::read(transferred_pdf).unwrap(), b"transferred pdf");
        assert_eq!(fs::read(transferred_cover).unwrap(), b"source cover");
    }

    #[test]
    fn duplicate_merge_rolls_back_when_result_hydration_fails() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let target_path = temp.path().join("target.epub");
        let source_path = temp.path().join("source.pdf");
        fs::write(&target_path, b"target").unwrap();
        fs::write(&source_path, b"source").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let target = store.import(&target_path, Some("Target"), false).unwrap();
        let source = store.import(&source_path, Some("Source"), false).unwrap();
        for id in [&target.id, &source.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        identifiers: Patch::Set(BTreeMap::from([(
                            "isbn".to_owned(),
                            "shared".to_owned(),
                        )])),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let candidate = store
            .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                page: DuplicatePageRequest {
                    limit: 100,
                    offset: 0,
                },
                disposition: "unreviewed".to_owned(),
            })
            .unwrap()
            .candidates
            .remove(0);
        store
            .connection
            .execute_batch(&format!(
                "CREATE TRIGGER delete_merged_source AFTER UPDATE OF trashed_at ON library_items
                 WHEN NEW.id='{}' BEGIN DELETE FROM library_items WHERE id=NEW.id; END;",
                source.id
            ))
            .unwrap();
        let error = store
            .merge_duplicate_pair(&MergeDuplicatePairRequest {
                target_id: target.id.clone(),
                source_id: source.id.clone(),
                review_token: candidate.review_token,
                metadata: serde_json::json!({"title":"Merged"}),
                add_source_formats: vec![FormatId::Pdf],
                cover: "none".to_owned(),
            })
            .unwrap_err();
        assert_eq!(error.code(), "storage-unavailable");
        let unchanged = store.get(&target.id).unwrap().unwrap();
        assert_eq!(unchanged.title, "Target");
        assert_eq!(unchanged.formats.len(), 1);
        assert!(store.get(&source.id).unwrap().is_some());
    }

    #[test]
    fn shared_merged_formats_survive_target_remove_and_replace() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let target_path = temp.path().join("target.epub");
        let source_path = temp.path().join("source.mobi");
        let source_pdf = temp.path().join("source.pdf");
        fs::write(&target_path, b"target").unwrap();
        fs::write(&source_path, b"source").unwrap();
        fs::write(&source_pdf, b"shared pdf").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let target = store.import(&target_path, Some("Target"), false).unwrap();
        let source = store.import(&source_path, Some("Source"), false).unwrap();
        for id in [&target.id, &source.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        identifiers: Patch::Set(BTreeMap::from([(
                            "isbn".to_owned(),
                            "shared".to_owned(),
                        )])),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let source = store.attach_format(&source.id, &source_pdf, true).unwrap();
        let shared_path = source
            .formats
            .iter()
            .find(|format| format.format == FormatId::Pdf)
            .unwrap()
            .source_path
            .clone();
        let request = ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 100,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        };
        let merge = |store: &mut LibraryStore| {
            let token = store
                .list_duplicate_candidates(&request)
                .unwrap()
                .candidates
                .remove(0)
                .review_token;
            store
                .merge_duplicate_pair(&MergeDuplicatePairRequest {
                    target_id: target.id.clone(),
                    source_id: source.id.clone(),
                    review_token: token,
                    metadata: serde_json::json!({"title":"Merged"}),
                    add_source_formats: vec![FormatId::Pdf],
                    cover: "none".to_owned(),
                })
                .unwrap();
        };
        merge(&mut store);
        store.remove_format(&target.id, FormatId::Pdf).unwrap();
        assert_eq!(fs::read(&shared_path).unwrap(), b"shared pdf");

        store.restore(&source.id).unwrap();
        merge(&mut store);
        let current = store
            .get(&target.id)
            .unwrap()
            .unwrap()
            .formats
            .into_iter()
            .find(|format| format.format == FormatId::Pdf)
            .unwrap();
        let replacement = temp.path().join("replacement.pdf");
        fs::write(&replacement, b"replacement").unwrap();
        store
            .replace_format(
                &target.id,
                FormatId::Pdf,
                &serde_json::json!({
                    "sourcePath":current.source_path,
                    "addedAt":current.added_at,
                    "provenance":current.provenance
                }),
                &replacement,
                true,
            )
            .unwrap();
        assert_eq!(fs::read(shared_path).unwrap(), b"shared pdf");
    }

    #[test]
    fn duplicate_signals_use_javascript_string_order_and_safe_numbers() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let left_path = temp.path().join("left.epub");
        let right_path = temp.path().join("right.pdf");
        fs::write(&left_path, b"left").unwrap();
        fs::write(&right_path, b"right").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let left = store.import(&left_path, Some("Left"), false).unwrap();
        let right = store.import(&right_path, Some("Right"), false).unwrap();
        let identifiers = BTreeMap::from([
            ("\u{1f600}".to_owned(), "shared-emoji".to_owned()),
            ("\u{e000}".to_owned(), "shared-private".to_owned()),
        ]);
        for id in [&left.id, &right.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        identifiers: Patch::Set(identifiers.clone()),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let page = store
            .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                page: DuplicatePageRequest {
                    limit: 100,
                    offset: 0,
                },
                disposition: "unreviewed".to_owned(),
            })
            .unwrap();
        assert!(matches!(
            &page.candidates[0].signals[0],
            DuplicateSignal::SameIdentifier { scheme, .. } if scheme == "\u{1f600}"
        ));
        store
            .connection
            .execute(
                "UPDATE library_item_formats SET content_bytes=?2 WHERE library_item_id=?1",
                params![left.id, i64::try_from(MAX_SAFE_INTEGER + 1).unwrap()],
            )
            .unwrap();
        assert_eq!(
            store
                .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                    page: DuplicatePageRequest {
                        limit: 100,
                        offset: 0,
                    },
                    disposition: "unreviewed".to_owned(),
                })
                .unwrap_err()
                .code(),
            "invalid-stored-data"
        );
    }

    #[test]
    fn duplicate_merge_rejects_empty_contract_arrays() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let left_path = temp.path().join("left.epub");
        let right_path = temp.path().join("right.pdf");
        fs::write(&left_path, b"left").unwrap();
        fs::write(&right_path, b"right").unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let left = store.import(&left_path, Some("Shared"), false).unwrap();
        let right = store.import(&right_path, Some("Shared"), false).unwrap();
        for id in [&left.id, &right.id] {
            store
                .update(
                    id,
                    LibraryPatch {
                        authors: Patch::Set(vec![BookAuthor {
                            name: "Author".to_owned(),
                            sort_name: None,
                        }]),
                        ..LibraryPatch::default()
                    },
                )
                .unwrap();
        }
        let token = store
            .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                page: DuplicatePageRequest {
                    limit: 100,
                    offset: 0,
                },
                disposition: "unreviewed".to_owned(),
            })
            .unwrap()
            .candidates
            .remove(0)
            .review_token;
        for metadata in [
            serde_json::json!({"authors":[]}),
            serde_json::json!({"languages":[]}),
        ] {
            assert_eq!(
                store
                    .merge_duplicate_pair(&MergeDuplicatePairRequest {
                        target_id: left.id.clone(),
                        source_id: right.id.clone(),
                        review_token: token.clone(),
                        metadata,
                        add_source_formats: vec![FormatId::Pdf],
                        cover: "none".to_owned(),
                    })
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
        }
        assert_eq!(store.get(&left.id).unwrap().unwrap().formats.len(), 1);
        assert!(store.get(&right.id).unwrap().is_some());
    }
}
