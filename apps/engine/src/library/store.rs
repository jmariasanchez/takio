use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::cell::Cell;

use crate::fingerprint::Fingerprint;
use chrono::Utc;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::format::{FormatId, detect_format};
use crate::library::model::{BookAuthor, ImportMode, LibraryItem, LibraryPatch, Patch, Provenance};
use crate::library::paths::LibraryPaths;
use crate::metadata::candidate_cover::{self, CandidateCoverDescriptor};

mod columns;
mod contracts;
mod duplicates;
mod hydration;
mod item_id;
mod metadata;
mod migration;
mod query;
mod query_cache;
mod recovery;
mod schema;

use contracts::validate_saved_view_definition;
pub use contracts::{
    ExpectedFormatSnapshot, SaveViewRequest, SavedViewDefinition, SavedViewFilters, SavedViewSort,
    SavedViewSortDirection, SavedViewSortField,
};
pub(crate) use item_id::valid_item_id;
use schema::{create_schema, has_schema};

use hydration::read_item_from;
use query::parse_structured_query;

pub const LIBRARY_SCHEMA_VERSION: i64 = 12;
pub(crate) use columns::validate_custom_column_definitions;
pub use metadata::METADATA_AUDIT_KEY;
use metadata::{
    normalize_authors, normalize_identifiers, normalize_languages, normalize_published_date,
    normalize_texts, replace_metadata, required_text,
};
pub(crate) use metadata::{
    normalize_custom_metadata, user_custom_metadata, validate_candidate_patch,
};

#[cfg(test)]
thread_local! {
    static ARM_POST_COMMIT_READ_FAULT: Cell<bool> = const { Cell::new(false) };
    static POST_COMMIT_READ_FAULT: Cell<bool> = const { Cell::new(false) };
}

/// A catalogue and its managed files.
///
/// Lookup methods such as `get` and `saved_view` return `Ok(None)` for an absent
/// identifier. Mutations targeting an existing item or saved view return an
/// error with code `not-found` when that identifier does not exist.
pub struct LibraryStore {
    connection: Connection,
    paths: LibraryPaths,
    query_cache: RefCell<query_cache::QueryCache>,
}

/// A catalogue opened without write access. Shared dereferencing permits reads,
/// but no mutable access to the underlying store is available.
///
/// ```compile_fail
/// use takio::library::store::ReadOnlyLibraryStore;
/// fn cannot_trash(mut store: ReadOnlyLibraryStore) {
///     store.trash("book").unwrap();
/// }
/// ```
pub struct ReadOnlyLibraryStore(LibraryStore);

impl std::ops::Deref for ReadOnlyLibraryStore {
    type Target = LibraryStore;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// A committed catalogue mutation. Cleanup failures never turn a committed
/// change into an error, and every preserved orphan path is reported here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub item: LibraryItem,
    pub cleanup_pending: bool,
    pub cleanup_pending_paths: Vec<PathBuf>,
}

impl From<LibraryItem> for MutationResult {
    fn from(item: LibraryItem) -> Self {
        Self::new(item)
    }
}

impl MutationResult {
    fn new(item: LibraryItem) -> Self {
        Self {
            item,
            cleanup_pending: false,
            cleanup_pending_paths: Vec::new(),
        }
    }

    fn pending(&mut self, path: &Path) {
        self.cleanup_pending = true;
        self.cleanup_pending_paths.push(path.to_path_buf());
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatus {
    Imported,
    Duplicate,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub item: LibraryItem,
    pub status: ImportStatus,
    pub source_preserved: bool,
}

/// Facet groups are conjunctive, values within one group are alternatives.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub series: Vec<String>,
    pub languages: Vec<String>,
    #[serde(deserialize_with = "contracts::saved_view_formats")]
    pub formats: Vec<FormatId>,
}

impl Filters {
    pub fn is_empty(&self) -> bool {
        self.authors.is_empty()
            && self.tags.is_empty()
            && self.series.is_empty()
            && self.languages.is_empty()
            && self.formats.is_empty()
    }

    pub fn validate(&self) -> AppResult<()> {
        self.validate_values(false)
    }

    fn validate_values(&self, unique: bool) -> AppResult<()> {
        for values in [&self.authors, &self.tags, &self.series, &self.languages] {
            let mut seen = std::collections::HashSet::new();
            if values.iter().any(|value| {
                let value = value.trim();
                value.is_empty() || (unique && !seen.insert(value.to_ascii_lowercase()))
            }) {
                return Err(crate::app_error!("invalid-arguments"));
            }
        }
        let mut seen = std::collections::HashSet::new();
        if unique
            && self
                .formats
                .iter()
                .any(|format| !seen.insert(format.as_str()))
        {
            return Err(crate::app_error!("invalid-arguments"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum LibraryQuerySyntax {
    #[serde(rename = "literal")]
    Literal,
    #[serde(rename = "structured-v1")]
    StructuredV1,
}

#[derive(Clone, Copy)]
pub struct LibraryQueryScope<'a> {
    pub query: &'a str,
    pub syntax: LibraryQuerySyntax,
    pub filters: &'a Filters,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImportWatchOutcome {
    Imported,
    Duplicate,
    Unsupported,
    Failed,
}

impl ImportWatchOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Imported => "imported",
            Self::Duplicate => "duplicate",
            Self::Unsupported => "unsupported",
            Self::Failed => "failed",
        }
    }
}

pub struct ImportWatchObservation {
    pub canonical_source_path: PathBuf,
    pub fingerprint: Fingerprint,
    pub outcome: ImportWatchOutcome,
}

/// One active book, and one managed format's recorded fingerprint when it has one.
#[derive(Clone, Debug)]
pub struct ActiveFingerprint {
    pub item_id: String,
    pub title: String,
    pub fingerprint: Option<Fingerprint>,
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
    pub definition: SavedViewDefinition,
    pub created_at: String,
    pub updated_at: String,
}

pub use duplicates::{
    DuplicateCandidate, DuplicateCandidatePage, DuplicateDisposition, DuplicatePageRequest,
    DuplicatePairReviewRequest, DuplicateScanSummary, DuplicateSignal,
    ListDuplicateCandidatesRequest, MergeCoverChoice, MergeDuplicatePairRequest,
    MergeDuplicatePairResult,
};

impl LibraryStore {
    /// Backup markers belong to the engine. Even malformed or symlinked markers
    /// reserve a directory for restore, never writable library activation.
    pub fn is_backup_root(root: &Path) -> AppResult<bool> {
        recovery::is_backup_root(root)
    }

    pub fn open_read_only(paths: LibraryPaths) -> AppResult<ReadOnlyLibraryStore> {
        if !paths.database.is_file() {
            return Err(crate::app_error!("storage-unavailable"));
        }
        let connection =
            Connection::open_with_flags(&paths.database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != LIBRARY_SCHEMA_VERSION {
            return Err(crate::app_error!("incompatible-schema"));
        }
        migration::verify_schema_version(&connection, version)?;
        Ok(ReadOnlyLibraryStore(Self {
            connection,
            paths,
            query_cache: RefCell::default(),
        }))
    }

    /// Validate an existing default before writable startup opening. Returns true
    /// only for a supported legacy catalogue requiring the verified migration.
    pub fn requires_verified_migration(paths: LibraryPaths) -> AppResult<bool> {
        recovery::reject_backup_root(&paths.root)?;
        if !fs::symlink_metadata(&paths.database)?.file_type().is_file() {
            return Err(crate::app_error!("storage-unavailable"));
        }
        // SQLite NOFOLLOW rejects aliased ancestors too. Resolve the parent only,
        // retaining the final-entry symlink rejection and NOFOLLOW protection.
        let database = paths
            .database
            .parent()
            .ok_or_else(|| crate::app_error!("invalid-arguments"))?
            .canonicalize()?
            .join(
                paths
                    .database
                    .file_name()
                    .ok_or_else(|| crate::app_error!("invalid-arguments"))?,
            );
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if !(1..=LIBRARY_SCHEMA_VERSION).contains(&version) {
            return Err(crate::app_error!("incompatible-schema"));
        }
        let mut store = Self {
            connection,
            paths,
            query_cache: RefCell::default(),
        };
        if version == LIBRARY_SCHEMA_VERSION {
            store.validate_catalog()?;
            return Ok(false);
        }
        migration::verify_schema_version(&store.connection, version)?;
        let integrity: String =
            store
                .connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(crate::app_error!("integrity-failed"));
        }
        Ok(true)
    }

    /// Open a current, readable catalogue without creating or migrating it.
    /// Managed file contents are not read: missing attachments remain manageable.
    pub fn open_existing(paths: LibraryPaths) -> AppResult<Self> {
        recovery::reject_backup_root(&paths.root)?;
        fn regular_database(paths: &LibraryPaths) -> AppResult<()> {
            if !fs::symlink_metadata(&paths.database)?.file_type().is_file() {
                return Err(crate::app_error!("storage-unavailable"));
            }
            Ok(())
        }

        regular_database(&paths)?;
        let connection = Connection::open_with_flags(
            &paths.database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut preflight = Self {
            connection,
            paths: paths.clone(),
            query_cache: RefCell::default(),
        };
        preflight.validate_catalog()?;
        let paths = preflight.paths.clone();
        drop(preflight);

        regular_database(&paths)?;
        let connection = Connection::open_with_flags(
            &paths.database,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self {
            connection,
            paths,
            query_cache: RefCell::default(),
        };
        // Validate the actual writable handle too, in case the candidate changed.
        store.validate_catalog()?;
        Ok(store)
    }

    fn validate_catalog(&mut self) -> AppResult<()> {
        let version: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != LIBRARY_SCHEMA_VERSION {
            return Err(crate::app_error!("incompatible-schema"));
        }
        migration::verify_schema_version(&self.connection, version)?;
        // Keep the recorded ownership spelling for existing purge/backup operations.
        // A canonical UI root must not implicitly rebase catalogue file paths.
        self.paths = recovery::ownership_paths(&self.connection, &self.paths)?;
        migration::verify_current(&self.connection, &self.paths)?;
        self.list(true)?;
        self.list_trash()?;
        Ok(())
    }

    /// Create a catalogue or explicitly migrate a supported existing schema.
    /// Use `open_read_only` for reads and `open_existing` for non-migrating writes.
    pub fn create_or_migrate(paths: LibraryPaths) -> AppResult<Self> {
        recovery::reject_backup_root(&paths.root)?;
        fs::create_dir_all(&paths.root)?;
        fs::create_dir_all(&paths.items)?;
        fs::create_dir_all(&paths.covers)?;
        let mut connection = Connection::open(&paths.database)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            if has_schema(&connection)? {
                return Err(crate::app_error!("incompatible-schema"));
            }
            create_schema(&connection)?;
        } else if (1..LIBRARY_SCHEMA_VERSION).contains(&version) {
            migration::migrate(&mut connection, &paths, version)?;
        } else if version != LIBRARY_SCHEMA_VERSION {
            return Err(crate::app_error!("incompatible-schema"));
        } else {
            migration::verify_schema_version(&connection, version)?;
        }
        Ok(Self {
            connection,
            paths,
            query_cache: RefCell::default(),
        })
    }

    #[must_use]
    pub fn paths(&self) -> &LibraryPaths {
        &self.paths
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
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?;
                validate_saved_view_definition(&definition)
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?;
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

    /// Imports a new managed copy. `duplicate-source-preserved` means matching
    /// bytes already exist and the source was not moved or deleted.
    pub fn import(
        &mut self,
        source: &Path,
        title: Option<&str>,
        mode: ImportMode,
    ) -> AppResult<LibraryItem> {
        let result = self.import_with_outcome(source, title, mode)?;
        match result.status {
            ImportStatus::Imported => Ok(result.item),
            ImportStatus::Duplicate => Err(crate::app_error!("duplicate-source-preserved")),
        }
    }

    /// Returns duplicate identity explicitly. Duplicate sources are always
    /// preserved, including when move mode was requested.
    pub fn import_with_outcome(
        &mut self,
        source: &Path,
        title: Option<&str>,
        mode: ImportMode,
    ) -> AppResult<ImportResult> {
        // Every import path (CLI, TUI, desktop, folder scans) funnels through here, so the
        // owned-path guard lives here rather than in each caller.
        crate::library::paths::validate_import_sources(&self.paths, &[source.to_path_buf()])?;
        let source = canonical_file(source)?;
        let format =
            detect_format(&source).ok_or_else(|| crate::app_error!("unsupported-format"))?;
        let (filename_title, filename_authors) = metadata_from_filename(&source);
        let (embedded_title, embedded_authors) = match format {
            FormatId::Epub | FormatId::Kepub => crate::metadata::embedded_epub(&source),
            FormatId::Mobi | FormatId::Azw3 => crate::metadata::embedded_mobi(&source),
            FormatId::Pdf => crate::metadata::embedded_pdf(&source),
            _ => (None, Vec::new()),
        };
        let title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or(embedded_title)
            .unwrap_or(filename_title);
        if title.is_empty() {
            return Err(crate::app_error!("invalid-title"));
        }
        let authors = if embedded_authors.is_empty() {
            filename_authors
        } else {
            embedded_authors
        };
        let author = (!authors.is_empty()).then(|| {
            authors
                .iter()
                .map(|author| author.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        });
        let fingerprint = hash_file(&source)?;
        if let Some(id) = self
            .connection
            .query_row(
                "SELECT library_item_id FROM library_item_formats
             WHERE provenance = 'managed' AND content_bytes = ?1 AND content_sha256 = ?2 LIMIT 1",
                params![as_i64(fingerprint.bytes)?, fingerprint.sha256],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(ImportResult {
                item: self
                    .read_item(&id)?
                    .ok_or_else(|| crate::app_error!("invalid-stored-data"))?,
                status: ImportStatus::Duplicate,
                source_preserved: true,
            });
        }

        let id = format!("book_{}", Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        let target = self.managed_path(&id, format);
        publish_copy(&source, &target, &fingerprint)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO library_items (id, title, added_at, author) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, now, author],
        )?;
        for (position, author) in authors.iter().enumerate() {
            transaction.execute("INSERT INTO library_item_authors(library_item_id,name,sort_name,position) VALUES(?1,?2,?3,?4)", params![id,author.name,author.sort_name,as_i64(position as u64)?])?;
        }
        transaction.execute(
            "INSERT INTO library_item_formats
             (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
             VALUES (?1, ?2, ?3, ?4, 'managed', 0, ?5, ?6)",
            params![id, format.as_str(), target.to_string_lossy(), now, as_i64(fingerprint.bytes)?, fingerprint.sha256],
        )?;
        transaction.commit()?;
        if mode == ImportMode::Move && fs::remove_file(&source).is_err() {
            self.connection.execute(
                "INSERT OR REPLACE INTO source_file_cleanup (source_path, content_bytes, content_sha256)
                 VALUES (?1, ?2, ?3)",
                params![source.to_string_lossy(), as_i64(fingerprint.bytes)?, fingerprint.sha256],
            )?;
        }
        Ok(ImportResult {
            item: self
                .read_item(&id)?
                .ok_or_else(|| crate::app_error!("storage-unavailable"))?,
            status: ImportStatus::Imported,
            source_preserved: source.exists(),
        })
    }

    /// Every active (not trashed) book with the recorded size and SHA-256 of each managed
    /// format. Books without a managed format appear once with no fingerprint.
    pub fn active_fingerprints(&self) -> AppResult<Vec<ActiveFingerprint>> {
        let mut statement = self.connection.prepare(
            "SELECT i.id, i.title, f.content_bytes, f.content_sha256
             FROM library_items i LEFT JOIN library_item_formats f
               ON f.library_item_id = i.id AND f.provenance = 'managed'
             WHERE i.trashed_at IS NULL
             ORDER BY i.id, f.position",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (item_id, title, bytes, sha256) = row?;
            let fingerprint = match (bytes, sha256) {
                (Some(bytes), Some(sha256)) => Some(Fingerprint {
                    bytes: u64::try_from(bytes)
                        .map_err(|_| crate::app_error!("invalid-stored-data"))?,
                    sha256,
                }),
                _ => None,
            };
            Ok(ActiveFingerprint {
                item_id,
                title,
                fingerprint,
            })
        })
        .collect()
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
                params![as_i64(fingerprint.bytes)?, fingerprint.sha256],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        duplicate
            .map(|(id, format)| {
                let item = self
                    .read_item(&id)?
                    .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
                let format = format
                    .parse::<FormatId>()
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?;
                Ok((item, format))
            })
            .transpose()
    }

    pub fn import_watch_accounted(
        &self,
        canonical_source_path: &Path,
        fingerprint: &Fingerprint,
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
                    as_i64(fingerprint.bytes)?,
                    fingerprint.sha256
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
                as_i64(observation.fingerprint.bytes)?,
                observation.fingerprint.sha256,
                observation.outcome.as_str(),
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
        provenance: Provenance,
    ) -> AppResult<LibraryItem> {
        let source = canonical_file(source)?;
        let format =
            detect_format(&source).ok_or_else(|| crate::app_error!("unsupported-format"))?;
        if self.read_item(id)?.is_none() {
            return Err(crate::app_error!("not-found"));
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_item_formats WHERE library_item_id = ?1 AND format = ?2)",
            params![id, format.as_str()],
            |row| row.get(0),
        )?;
        if exists {
            return Err(crate::app_error!("format-exists"));
        }
        let now = Utc::now().to_rfc3339();
        let position: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM library_item_formats WHERE library_item_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if provenance == Provenance::Managed {
            let fingerprint = hash_file(&source)?;
            let target = self.managed_path(id, format);
            publish_copy(&source, &target, &fingerprint)?;
            self.connection.execute(
                "INSERT INTO library_item_formats
                 (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
                 VALUES (?1, ?2, ?3, ?4, 'managed', ?5, ?6, ?7)",
                params![id, format.as_str(), target.to_string_lossy(), now, position, as_i64(fingerprint.bytes)?, fingerprint.sha256],
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
            .ok_or_else(|| crate::app_error!("storage-unavailable"))
    }

    pub fn attach_verified_artifact(
        &mut self,
        id: &str,
        source: &Path,
        format: FormatId,
        expected: &Fingerprint,
    ) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        if let Some(existing) = read_stored_format(&self.connection, id, format)? {
            if existing.provenance == Provenance::Managed
                && existing.fingerprint.as_ref() == Some(expected)
                && hash_file(&existing.path).ok().as_ref() == Some(expected)
            {
                return Ok(item);
            }
            return Err(crate::app_error!("format-exists"));
        }
        let source = canonical_file(source)?;
        if detect_format(&source) != Some(format) || hash_file(&source)? != *expected {
            return Err(crate::app_error!("artifact-invalid"));
        }
        let now = Utc::now().to_rfc3339();
        let content_bytes = as_i64(expected.bytes)?;
        let target = self.managed_path(id, format);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = read_stored_format(&transaction, id, format)? {
            if existing.provenance == Provenance::Managed
                && existing.fingerprint.as_ref() == Some(expected)
                && hash_file(&existing.path).ok().as_ref() == Some(expected)
            {
                return Ok(item);
            }
            return Err(crate::app_error!("format-exists"));
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM library_item_formats WHERE library_item_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        publish_copy(&source, &target, expected)?;
        let inserted = transaction.execute(
            "INSERT INTO library_item_formats
             (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256)
             VALUES (?1, ?2, ?3, ?4, 'managed', ?5, ?6, ?7)",
            params![id, format.as_str(), target.to_string_lossy(), now, position, content_bytes, expected.sha256],
        );
        if let Err(error) = inserted {
            let _ = fs::remove_file(&target);
            return Err(error.into());
        }
        transaction.commit()?;
        self.read_item(id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))
    }

    pub(crate) fn restore_portable_item(
        &mut self,
        item: &LibraryItem,
        formats: &[(FormatId, PathBuf)],
        cover: Option<&Path>,
    ) -> AppResult<LibraryItem> {
        if !valid_item_id(&item.id) || formats.is_empty() || formats.len() != item.formats.len() {
            return Err(crate::app_error!("invalid-arguments"));
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
                        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
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
                    return Err(crate::app_error!("invalid-arguments"));
                }
                let fingerprint = hash_file(target)?;
                transaction.execute(
                    "INSERT INTO library_item_formats
                     (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                     VALUES (?1,?2,?3,?4,'managed',?5,?6,?7)",
                    params![item.id,format.as_str(),target.to_string_lossy(),original.added_at,
                        as_i64(position as u64)?,as_i64(fingerprint.bytes)?,fingerprint.sha256],
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
            return Err(crate::app_error!("storage-unavailable"));
        }
        self.read_item(&item.id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))
    }

    pub(crate) fn rebase_portable_paths(&mut self, destination: &LibraryPaths) -> AppResult<()> {
        rebase_owned_paths(&mut self.connection, &self.paths, destination)
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

    fn cleanup_format_after_commit(&self, format: &StoredFormat, result: &mut MutationResult) {
        if format.provenance != Provenance::Managed {
            return;
        }
        match self.path_is_referenced(&format.path.to_string_lossy()) {
            Ok(true) => {}
            Ok(false) => {
                if cleanup_managed(&self.paths.items, &format.path, format.fingerprint.as_ref())
                    .is_err()
                {
                    result.pending(&format.path);
                }
            }
            Err(_) => result.pending(&format.path),
        }
    }

    fn cleanup_cover_after_commit(&self, path: &Path, result: &mut MutationResult) {
        if !path.starts_with(&self.paths.covers) {
            return;
        }
        match self.path_is_referenced(&path.to_string_lossy()) {
            Ok(true) => {}
            Ok(false) => {
                if let Err(error) = fs::remove_file(path)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    result.pending(path);
                }
            }
            Err(_) => result.pending(path),
        }
    }

    /// Returns the committed item and any managed paths that could not be cleaned up.
    pub fn remove_format(&mut self, id: &str, format: FormatId) -> AppResult<MutationResult> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        if item.formats.len() <= 1 {
            return Err(crate::app_error!("last-format"));
        }
        let stored = self
            .stored_format(id, format)?
            .ok_or_else(|| crate::app_error!("format-not-found"))?;
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
        let updated = hydration::read_item_from(&transaction, id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
        transaction.commit()?;
        let mut updated = MutationResult::new(updated);
        self.cleanup_format_after_commit(&stored, &mut updated);
        Ok(updated)
    }

    /// Replace a format only when its recorded identity still matches `expected`.
    ///
    /// # Errors
    /// Returns `not-found` for an absent item and `format-changed` for an absent
    /// or stale format. Post-commit cleanup failures are returned in the outcome.
    pub fn replace_format(
        &mut self,
        id: &str,
        format: FormatId,
        expected: &ExpectedFormatSnapshot,
        source: &Path,
        provenance: Provenance,
    ) -> AppResult<MutationResult> {
        let current = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?
            .formats
            .into_iter()
            .find(|candidate| candidate.format == format)
            .ok_or_else(|| crate::app_error!("format-changed"))?;
        if expected.source_path != current.source_path
            || expected.added_at != current.added_at
            || expected.provenance != current.provenance
        {
            return Err(crate::app_error!("format-changed"));
        }
        let source = canonical_file(source)?;
        if detect_format(&source) != Some(format) {
            return Err(crate::app_error!("invalid-arguments"));
        }
        let old = self
            .stored_format(id, format)?
            .ok_or_else(|| crate::app_error!("format-changed"))?;
        let now = Utc::now().to_rfc3339();
        let (stored_path, fingerprint) = if provenance == Provenance::Managed {
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
        let result = (|| -> AppResult<LibraryItem> {
            let transaction = self.connection.transaction()?;
            transaction.execute(
                "UPDATE library_item_formats SET source_path=?3, added_at=?4, provenance=?5,
             content_bytes=?6, content_sha256=?7 WHERE library_item_id=?1 AND format=?2",
                params![
                    id,
                    format.as_str(),
                    stored_path.to_string_lossy(),
                    now,
                    provenance.as_str(),
                    fingerprint
                        .as_ref()
                        .map(|value| value.bytes)
                        .map(as_i64)
                        .transpose()?,
                    fingerprint.as_ref().map(|value| value.sha256.as_str())
                ],
            )?;
            let updated = hydration::read_item_from(&transaction, id)?
                .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
            transaction.commit()?;
            Ok(updated)
        })();
        let mut updated = match result {
            Ok(updated) => MutationResult::new(updated),
            Err(error) => {
                if provenance == Provenance::Managed {
                    let _ = fs::remove_file(&stored_path);
                }
                return Err(error);
            }
        };
        if old.path != stored_path {
            self.cleanup_format_after_commit(&old, &mut updated);
        }
        Ok(updated)
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
                    &candidate_cover::CoverBinding {
                        item_id: id,
                        candidate_id,
                        source,
                        provenance,
                    },
                    descriptor,
                )
            })
            .transpose()?;
        let old_cover = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?
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

    fn apply_patch_to_item(
        item: &mut LibraryItem,
        patch: LibraryPatch,
        allow_reserved_metadata: bool,
    ) -> AppResult<()> {
        // Patch semantics, uniform across every nullable field the contract
        // allows: `Missing` leaves the stored value untouched, `Null` clears it
        // to the documented empty value, `Set` replaces it.
        if patch.is_empty() {
            return Err(crate::app_error!("invalid-arguments"));
        }
        // `title` is non-nullable: an explicit null is a client error.
        if matches!(patch.title, Patch::Null) {
            return Err(crate::app_error!("invalid-arguments"));
        }
        if let Some(title) = patch.title.into_set() {
            let title = title.trim();
            if title.is_empty() {
                return Err(crate::app_error!("invalid-arguments"));
            }
            item.title = title.to_owned();
        }
        // Structured `authors` are the source of truth. The legacy scalar
        // `author` is a derived display value, so a scalar-only patch is
        // translated into a single structured author instead of diverging.
        let authors_patch = match (patch.authors, patch.author) {
            (Patch::Missing, Patch::Set(value)) => Patch::Set(vec![BookAuthor {
                name: required_text(value)?,
                sort_name: None,
            }]),
            (Patch::Missing, Patch::Null) => Patch::Null,
            (authors, _) => authors,
        };
        let authors_changed = !matches!(authors_patch, Patch::Missing);
        match authors_patch {
            Patch::Missing => {}
            Patch::Null => item.authors = Vec::new(),
            Patch::Set(value) => {
                // The contract requires at least one author when present;
                // clearing is expressed only as an explicit null.
                if value.is_empty() {
                    return Err(crate::app_error!("invalid-arguments"));
                }
                item.authors = normalize_authors(value)?;
            }
        }
        if authors_changed {
            item.author = (!item.authors.is_empty()).then(|| {
                item.authors
                    .iter()
                    .map(|author| author.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            });
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
                    return Err(crate::app_error!("invalid-arguments"));
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
                    return Err(crate::app_error!("invalid-arguments"));
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
                    return Err(crate::app_error!("invalid-arguments"));
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
                    return Err(crate::app_error!("invalid-arguments"));
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
            Patch::Null => return Err(crate::app_error!("invalid-arguments")),
            Patch::Set(value) => item.tags = normalize_texts(value)?,
        }
        Ok(())
    }

    fn update_inner(
        &mut self,
        id: &str,
        patch: LibraryPatch,
        allow_reserved_metadata: bool,
        cover_path: Option<&Path>,
    ) -> AppResult<LibraryItem> {
        let mut item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        Self::apply_patch_to_item(&mut item, patch, allow_reserved_metadata)?;
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

    pub fn set_cover(&mut self, id: &str, source: &Path) -> AppResult<MutationResult> {
        let mut item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
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
        let old = item.cover_path.clone();
        let updated_at = Utc::now().to_rfc3339();
        if let Err(error) = self.connection.execute(
            "UPDATE library_items SET cover_path=?2, updated_at=?3 WHERE id=?1",
            params![id, target.to_string_lossy(), updated_at],
        ) {
            let _ = fs::remove_file(&target);
            return Err(error.into());
        }
        item.cover_path = Some(target);
        item.updated_at = Some(updated_at);
        let mut result = MutationResult::new(item);
        if let Some(old) = old {
            self.cleanup_cover_after_commit(&old, &mut result);
        }
        Ok(result)
    }

    pub fn remove_cover(&mut self, id: &str) -> AppResult<MutationResult> {
        let mut item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        let updated_at = Utc::now().to_rfc3339();
        self.connection.execute(
            "UPDATE library_items SET cover_path=NULL, updated_at=?2 WHERE id=?1",
            params![id, updated_at],
        )?;
        let old = item.cover_path.take();
        item.updated_at = Some(updated_at);
        let mut result = MutationResult::new(item);
        if let Some(old) = old {
            self.cleanup_cover_after_commit(&old, &mut result);
        }
        Ok(result)
    }

    pub fn trash(&mut self, id: &str) -> AppResult<LibraryItem> {
        self.set_trash(id, Some(Utc::now().to_rfc3339()))
    }

    pub fn restore(&mut self, id: &str) -> AppResult<LibraryItem> {
        self.set_trash(id, None)
    }

    /// Permanently deletes a trashed item and reports any preserved orphan paths.
    /// Unknown IDs return `not-found`; active items return `not-trashed`.
    pub fn purge(&mut self, id: &str) -> AppResult<MutationResult> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        let trashed: bool = self.connection.query_row(
            "SELECT trashed_at IS NOT NULL FROM library_items WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        if !trashed {
            return Err(crate::app_error!("not-trashed"));
        }
        let stored = item
            .formats
            .iter()
            .map(|format| self.stored_format(id, format.format))
            .collect::<AppResult<Vec<_>>>()?;
        let changed = self.connection.execute(
            "DELETE FROM library_items WHERE id=?1 AND trashed_at IS NOT NULL",
            [id],
        )?;
        if changed == 0 {
            return Err(crate::app_error!("not-trashed"));
        }
        let mut result = MutationResult::new(item);
        for format in stored.into_iter().flatten() {
            self.cleanup_format_after_commit(&format, &mut result);
        }
        if let Some(path) = result.item.cover_path.clone() {
            self.cleanup_cover_after_commit(&path, &mut result);
        }
        Ok(result)
    }

    pub fn verify(&self) -> AppResult<VerifyReport> {
        let version: i64 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != LIBRARY_SCHEMA_VERSION {
            return Err(crate::app_error!("incompatible-schema"));
        }
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(crate::app_error!("integrity-failed"));
        }
        let foreign_keys: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        if foreign_keys != 0 {
            return Err(crate::app_error!("integrity-failed"));
        }
        let ownership = recovery::ownership_paths(&self.connection, &self.paths)?;
        migration::verify_current(&self.connection, &ownership)?;
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
                hash_file(Path::new(&path)).map_err(|_| crate::app_error!("integrity-failed"))?;
            if actual.bytes
                != u64::try_from(bytes).map_err(|_| crate::app_error!("integrity-failed"))?
                || actual.sha256 != sha256
            {
                return Err(crate::app_error!("integrity-failed"));
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
        recovery::backup(self, destination)
    }

    pub fn restore_backup(source: &Path, paths: LibraryPaths) -> AppResult<RestoreReport> {
        recovery::restore(source, paths, false)
    }

    /// Restore a separate library without replacing or switching the current library.
    pub fn restore_backup_copy(
        &self,
        source: &Path,
        destination: &Path,
    ) -> AppResult<RestoreReport> {
        Self::restore_to_new_root(source, destination, &[&self.paths.root])
    }

    /// Restore only into a new directory disjoint from every protected library.
    pub fn restore_to_new_root(
        source: &Path,
        destination: &Path,
        protected: &[&Path],
    ) -> AppResult<RestoreReport> {
        let mut destination = destination.to_path_buf();
        for root in protected {
            destination = recovery::disjoint_destination(&destination, root)?;
        }
        let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite")))?;
        recovery::restore(source, paths, true)
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
                let definition: SavedViewDefinition = serde_json::from_str(&definition)
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?;
                validate_saved_view_definition(&definition)
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?;
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

    pub fn save_view(&mut self, request: &SaveViewRequest) -> AppResult<SavedView> {
        let id = request.id.trim();
        let name = request.name.trim();
        if id.is_empty() || id.encode_utf16().count() > 256 || name.is_empty() || name.len() > 120 {
            return Err(crate::app_error!("invalid-arguments"));
        }
        let definition = &request.definition;
        validate_saved_view_definition(definition)?;
        let now = Utc::now().to_rfc3339();
        let definition_json = serde_json::to_string(definition)
            .map_err(|_| crate::app_error!("invalid-arguments"))?;
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
                    .map_err(|_| crate::app_error!("invalid-stored-data"))?,
                created_at,
                updated_at,
            })
        })
    }

    /// Unknown IDs return `not-found`, as for other mutators.
    pub fn remove_view(&mut self, id: &str) -> AppResult<SavedView> {
        let view = self
            .saved_view(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        self.connection
            .execute("DELETE FROM saved_library_views WHERE id=?1", [&view.id])?;
        Ok(view)
    }

    fn set_trash(&mut self, id: &str, timestamp: Option<String>) -> AppResult<LibraryItem> {
        let item = self
            .read_item(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        self.connection.execute(
            "UPDATE library_items SET trashed_at=?2 WHERE id=?1",
            params![id, timestamp],
        )?;
        Ok(item)
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
            return Err(crate::app_error!("storage-unavailable"));
        }
        read_item_from(&self.connection, id)
    }
}

struct StoredFormat {
    path: PathBuf,
    provenance: Provenance,
    position: i64,
    fingerprint: Option<Fingerprint>,
}

fn read_stored_format(
    connection: &Connection,
    id: &str,
    format: FormatId,
) -> AppResult<Option<StoredFormat>> {
    let row = connection
        .query_row(
            "SELECT source_path, provenance, position, content_bytes, content_sha256
             FROM library_item_formats WHERE library_item_id=?1 AND format=?2",
            params![id, format.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(path, provenance, position, bytes, sha256)| {
        Ok(StoredFormat {
            path: PathBuf::from(path),
            provenance: provenance.parse()?,
            position,
            fingerprint: match (bytes, sha256) {
                (Some(bytes), Some(sha256)) => Some(Fingerprint {
                    bytes: u64::try_from(bytes)
                        .map_err(|_| crate::app_error!("invalid-stored-data"))?,
                    sha256,
                }),
                _ => None,
            },
        })
    })
    .transpose()
}

fn existing_owned_root(path: &Path, canonical_root: &Path, directory: &str) -> AppResult<PathBuf> {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(crate::app_error!("integrity-failed"));
    }
    for owned in path.ancestors().skip(1) {
        let Some(recorded_root) = owned.parent() else {
            continue;
        };
        if owned.file_name().is_some_and(|name| name == directory)
            && recorded_root
                .canonicalize()
                .is_ok_and(|root| root == canonical_root)
            && path.strip_prefix(owned).is_ok_and(|relative| {
                !relative.as_os_str().is_empty()
                    && relative
                        .components()
                        .all(|part| matches!(part, Component::Normal(_)))
            })
            && match fs::symlink_metadata(owned) {
                Ok(metadata) => metadata.file_type().is_dir(),
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
        {
            return Ok(recorded_root.to_path_buf());
        }
    }
    Err(crate::app_error!("integrity-failed"))
}

fn canonical_file(path: &Path) -> AppResult<PathBuf> {
    let path = path
        .canonicalize()
        .map_err(|error| AppError::from_io(crate::error::ErrorCode::NotFound, error))?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(crate::app_error!("invalid-arguments"))
    }
}

/// Title and authors from a filename. Underscore-only stems become spaced, and the
/// `Title (Author, Author) (z-library.sk, ...)` download convention yields authors.
fn metadata_from_filename(path: &Path) -> (String, Vec<BookAuthor>) {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let stem = if name.to_ascii_lowercase().ends_with(".kepub.epub") {
        &name[..name.len() - 11]
    } else {
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled")
    };
    let spaced = stem
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let title = if stem.contains(' ') || spaced.is_empty() {
        stem.to_owned()
    } else {
        spaced
    };
    static ZLIBRARY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(.+?)\s*\(([^()]+)\)\s*\([^()]*\bz-lib(?:rary)?\b[^()]*\)$")
            .expect("valid filename regex")
    });
    let Some(captures) = ZLIBRARY.captures(&title) else {
        return (title, Vec::new());
    };
    let authors = captures[2]
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| BookAuthor {
            name: name.to_owned(),
            sort_name: None,
        })
        .collect();
    (captures[1].to_owned(), authors)
}

fn hash_file(path: &Path) -> AppResult<Fingerprint> {
    crate::fingerprint::hash_file(path)
        .map_err(|error| AppError::from_io(crate::error::ErrorCode::SourceUnavailable, error))
}

fn publish_copy(source: &Path, target: &Path, expected: &Fingerprint) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
    fs::create_dir_all(parent)?;
    if target.exists() {
        return Err(crate::app_error!("destination-exists"));
    }
    let temporary = parent.join(format!(".takio-{}.tmp", Uuid::new_v4()));
    let mut input = File::open(source).map_err(|_| crate::app_error!("source-unavailable"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    if hash_file(&temporary)? != *expected {
        let _ = fs::remove_file(&temporary);
        return Err(crate::app_error!("source-changed"));
    }
    fs::rename(&temporary, target)?;
    Ok(())
}

fn cleanup_managed(root: &Path, path: &Path, expected: Option<&Fingerprint>) -> AppResult<()> {
    if !path.starts_with(root) {
        return Err(crate::app_error!("invalid-stored-data"));
    }
    if path.exists()
        && expected.is_some_and(|expected| hash_file(path).ok().as_ref() != Some(expected))
    {
        return Err(crate::app_error!("source-changed"));
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn count(connection: &Connection, sql: &str) -> AppResult<u64> {
    let value: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    u64::try_from(value).map_err(|_| crate::app_error!("invalid-stored-data"))
}

fn count_with_param(connection: &Connection, sql: &str, value: &str) -> AppResult<u64> {
    connection
        .query_row(sql, [value], |row| row.get::<_, i64>(0))
        .map_err(Into::into)
        .and_then(|value| {
            u64::try_from(value).map_err(|_| crate::app_error!("invalid-stored-data"))
        })
}
fn as_i64(value: u64) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| crate::app_error!("storage-unavailable"))
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
            .map_err(|_| crate::app_error!("invalid-stored-data"))?;
        let rebased = destination.items.join(relative);
        transaction.execute(
            "UPDATE library_item_formats SET source_path=?3 WHERE library_item_id=?1 AND format=?2 AND provenance='managed'",
            params![id, format, rebased.to_string_lossy()],
        )?;
    }
    for (id, stored) in covers {
        let relative = Path::new(&stored)
            .strip_prefix(&source.covers)
            .map_err(|_| crate::app_error!("invalid-stored-data"))?;
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
    mod safety;

    use super::hydration::read_items_required;
    use super::*;

    #[test]
    fn backup_markers_block_writable_opens_without_changing_the_backup() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        drop(LibraryStore::create_or_migrate(paths.clone()).unwrap());
        let before = fs::read(&paths.database).unwrap();
        fs::write(paths.root.join("manifest.json"), b"invalid backup marker").unwrap();
        assert!(LibraryStore::is_backup_root(&paths.root).unwrap());
        for result in [
            LibraryStore::create_or_migrate(paths.clone()),
            LibraryStore::open_existing(paths.clone()),
        ] {
            assert_eq!(result.err().unwrap().code(), "library-is-backup");
        }
        assert_eq!(
            LibraryStore::requires_verified_migration(paths.clone())
                .unwrap_err()
                .code(),
            "library-is-backup"
        );
        assert!(LibraryStore::open_read_only(paths.clone()).is_ok());
        assert_eq!(fs::read(&paths.database).unwrap(), before);
        #[cfg(unix)]
        {
            fs::remove_file(paths.root.join("manifest.json")).unwrap();
            std::os::unix::fs::symlink("missing-manifest", paths.root.join("manifest.json"))
                .unwrap();
            assert!(LibraryStore::is_backup_root(&paths.root).unwrap());
            assert_eq!(
                LibraryStore::create_or_migrate(paths).err().unwrap().code(),
                "library-is-backup"
            );
        }
    }

    #[test]
    fn empty_ids_have_one_error_contract_for_reads_and_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        for id in ["", " \t"] {
            assert_eq!(store.get(id).unwrap_err().code(), "invalid-arguments");
            assert_eq!(store.trash(id).unwrap_err().code(), "invalid-arguments");
            assert_eq!(store.restore(id).unwrap_err().code(), "invalid-arguments");
            assert_eq!(
                store
                    .update(id, LibraryPatch::default())
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
            assert_eq!(
                store
                    .set_cover(id, &temp.path().join("missing.jpg"))
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
            assert_eq!(store.purge(id).unwrap_err().code(), "invalid-arguments");
        }
    }

    #[test]
    fn direct_queries_validate_before_selecting_or_caching() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let store = LibraryStore::create_or_migrate(paths).unwrap();
        let long = "x".repeat(1025);
        assert_eq!(
            store
                .query_items(&long, &Filters::default())
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        for (query, filters) in [
            (long.as_str(), Filters::default()),
            (
                "",
                Filters {
                    authors: vec![" ".into()],
                    ..Filters::default()
                },
            ),
        ] {
            assert_eq!(
                store.query_items(query, &filters).unwrap_err().code(),
                "invalid-arguments"
            );
            assert_eq!(
                store
                    .query_items_shared(query, &filters)
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
            assert_eq!(
                store
                    .query_items_scoped(&[LibraryQueryScope {
                        query,
                        syntax: LibraryQuerySyntax::StructuredV1,
                        filters: &filters
                    }])
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
        }
        assert!(
            store
                .query_items(&"x".repeat(1024), &Filters::default())
                .unwrap()
                .is_empty()
        );
    }

    pub(super) fn seed_hydration_books(store: &mut LibraryStore, count: usize) {
        let transaction = store.connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO tags VALUES ('signal-one','Signal One'),('signal-two','Signal Two')",
                [],
            )
            .unwrap();
        for index in (0..count).rev() {
            let id = format!("book-{index:05}");
            let title = if index % 2 == 0 { "Signal" } else { "signal" };
            transaction.execute(
                "INSERT INTO library_items(id,title,added_at) VALUES(?1,?2,'2026-10-22T00:00:00Z')",
                params![id, title],
            ).unwrap();
            transaction.execute(
                "INSERT INTO library_item_formats(library_item_id,format,source_path,added_at,provenance,position)
                 VALUES(?1,'epub','/fixture/book.epub','2026-10-22','referenced',0)", [&id],
            ).unwrap();
            if index % 2 == 0 {
                transaction.execute(
                    "UPDATE library_items SET author='Legacy',series='Shelf',series_index=2.5,publisher='Publisher',
                     published_date='2020',rating=7,description='Description',cover_path='/fixture/cover.jpg',updated_at='2026-10-22' WHERE id=?1", [&id],
                ).unwrap();
                transaction.execute(
                    "INSERT INTO library_item_formats(library_item_id,format,source_path,added_at,provenance,position)
                     VALUES(?1,'pdf','/fixture/book.pdf','2026-10-22','referenced',1)", [&id],
                ).unwrap();
                transaction.execute("INSERT INTO library_item_authors VALUES(?1,'Signal Writer','Writer, Signal',0),(?1,'Signal Coauthor',NULL,1)", [&id]).unwrap();
                transaction
                    .execute(
                        "INSERT INTO library_item_languages VALUES(?1,'fr',0),(?1,'en',1)",
                        [&id],
                    )
                    .unwrap();
                transaction.execute("INSERT INTO library_item_tags VALUES(?1,'signal-two',0),(?1,'signal-one',1)", [&id]).unwrap();
                transaction
                    .execute(
                        "INSERT INTO library_item_identifiers VALUES(?1,'fixture',?1)",
                        [&id],
                    )
                    .unwrap();
                transaction
                    .execute(
                        "INSERT INTO library_item_custom_metadata VALUES(?1,'shelf','Favorites')",
                        [&id],
                    )
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn search_and_trash_hydration_preserve_metadata_and_chunk_order() {
        for count in [0, 1, 500, 501, 1001] {
            let temp = tempfile::tempdir().unwrap();
            let paths =
                LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
            let mut store = LibraryStore::create_or_migrate(paths).unwrap();
            seed_hydration_books(&mut store, count);
            let expected: Vec<_> = (0..count)
                .map(|index| store.get(&format!("book-{index:05}")).unwrap().unwrap())
                .collect();
            assert_eq!(
                serde_json::to_value(store.query_items("SIGNAL", &Filters::default()).unwrap())
                    .unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            assert!(store.list_trash().unwrap().is_empty());
            store.connection.execute("UPDATE library_items SET trashed_at=CASE WHEN CAST(substr(id,6) AS INTEGER)%2=0 THEN '2026-10-22' ELSE '2026-10-21' END", []).unwrap();
            let expected_trash: Vec<_> = expected
                .iter()
                .step_by(2)
                .chain(expected.iter().skip(1).step_by(2))
                .collect();
            assert_eq!(
                serde_json::to_value(store.list_trash().unwrap()).unwrap(),
                serde_json::to_value(expected_trash).unwrap()
            );
            assert!(
                store
                    .query_items("Signal", &Filters::default())
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn search_hydration_preserves_literal_escaping_and_deduplication() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        seed_hydration_books(&mut store, 2);
        store
            .connection
            .execute(
                "UPDATE library_items SET title=?1 WHERE id='book-00000'",
                [r"Signal 100%_\ literal"],
            )
            .unwrap();
        for query in ["%", "_", "\\", r"100%_\"] {
            let items = store.query_items(query, &Filters::default()).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].id, "book-00000");
        }
        assert_eq!(
            store
                .query_items("Signal", &Filters::default())
                .unwrap()
                .len(),
            2
        );
        assert!(
            store
                .query_items("missing", &Filters::default())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn search_and_trash_hydration_reject_invalid_formats() {
        for invalid in [
            "UPDATE library_item_formats SET format='invalid' WHERE library_item_id='book-00000' AND position=0",
            "DELETE FROM library_item_formats WHERE library_item_id='book-00000'",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let paths =
                LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
            let mut store = LibraryStore::create_or_migrate(paths).unwrap();
            seed_hydration_books(&mut store, 501);
            store.connection.execute(invalid, []).unwrap();
            assert_eq!(
                store
                    .query_items("Signal", &Filters::default())
                    .unwrap_err()
                    .code(),
                "invalid-stored-data"
            );
            store
                .connection
                .execute("UPDATE library_items SET trashed_at='2026-10-22'", [])
                .unwrap();
            assert_eq!(
                store.list_trash().unwrap_err().code(),
                "invalid-stored-data"
            );
        }
    }

    #[test]
    fn required_hydration_rejects_missing_selected_records() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        seed_hydration_books(&mut store, 501);
        let ids: Vec<_> = (0..501).map(|index| format!("book-{index:05}")).collect();
        store
            .connection
            .execute("DELETE FROM library_items WHERE id='book-00500'", [])
            .unwrap();
        assert_eq!(
            read_items_required(&store.connection, &ids)
                .unwrap_err()
                .code(),
            "invalid-stored-data"
        );
    }

    /// Run with cargo test -p takio --release --lib benchmark_search_and_trash_hydration -- --ignored --nocapture
    #[test]
    #[ignore = "release performance report, not a wall-clock correctness gate"]
    fn benchmark_search_and_trash_hydration() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        seed_hydration_books(&mut store, 10_000);
        for operation in ["search", "trash"] {
            if operation == "trash" {
                store
                    .connection
                    .execute("UPDATE library_items SET trashed_at='2026-10-22'", [])
                    .unwrap();
            }
            let mut samples = Vec::new();
            for iteration in 0..23 {
                let started = std::time::Instant::now();
                let items = if operation == "search" {
                    store.query_items("Signal", &Filters::default())
                } else {
                    store.list_trash()
                }
                .unwrap();
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(items.len(), 10_000);
                assert!(items.windows(2).all(|pair| pair[0].id < pair[1].id));
                if iteration >= 3 {
                    samples.push(elapsed);
                }
            }
            samples.sort_by(f64::total_cmp);
            eprintln!(
                "{operation}: 10000 books, 20 samples, median {:.3} ms, p95 {:.3} ms",
                (samples[9] + samples[10]) / 2.0,
                samples[18]
            );
        }
    }

    #[test]
    fn import_prefers_caller_title_then_epub_metadata_then_filename_conventions() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let mut import = |name: &str, bytes: &[u8], title: Option<&str>| {
            let source = temp.path().join(name);
            fs::write(&source, bytes).unwrap();
            let item = store.import(&source, title, ImportMode::Copy).unwrap();
            let authors = item
                .authors
                .iter()
                .map(|author| author.name.clone())
                .collect::<Vec<_>>();
            (item.title, authors, item.author)
        };
        let epub = crate::metadata::epub_fixture(
            "<dc:title>The Quiet Sea</dc:title><dc:creator>Jane Example</dc:creator>",
        );
        assert_eq!(
            import("download (3).epub", &epub, None),
            (
                "The Quiet Sea".to_owned(),
                vec!["Jane Example".to_owned()],
                Some("Jane Example".to_owned())
            )
        );
        let epub = crate::metadata::epub_fixture(
            "<dc:title>Ignored</dc:title><dc:creator>Ann Author</dc:creator>",
        );
        assert_eq!(
            import("other.epub", &epub, Some("Chosen")).0,
            "Chosen".to_owned()
        );
        assert_eq!(
            import(
                "When Genius Failed (Roger Lowenstein, Ann Other) (z-library.sk, 1lib.sk, z-lib.sk).pdf",
                b"pdf one",
                None
            ),
            (
                "When Genius Failed".to_owned(),
                vec!["Roger Lowenstein".to_owned(), "Ann Other".to_owned()],
                Some("Roger Lowenstein, Ann Other".to_owned())
            )
        );
        for (name, title) in [
            (
                "Real_World_OCaml__Functional.pdf",
                "Real World OCaml Functional",
            ),
            ("Clean Code (2nd Edition).epub", "Clean Code (2nd Edition)"),
            ("keep_this name.txt", "keep_this name"),
            ("_.txt", "_"),
        ] {
            assert_eq!(
                import(name, name.as_bytes(), None),
                (title.to_owned(), Vec::new(), None)
            );
        }

        // MOBI and AZW3 carry their own title and authors, which beat the filename.
        let mobi = crate::metadata::mobi_fixture(
            65001,
            b"Atomic Hab",
            &[(100, b"James Clear"), (503, b"Atomic Habits")],
        );
        assert_eq!(
            import("Atomic Habits - Unknown.mobi", &mobi, None),
            (
                "Atomic Habits".to_owned(),
                vec!["James Clear".to_owned()],
                Some("James Clear".to_owned())
            )
        );
        let azw3 = crate::metadata::mobi_fixture(
            65001,
            b"Kindred",
            &[(100, b"Octavia E. Butler"), (100, b"Unknown")],
        );
        assert_eq!(
            import("Kindred (Someone Else) (z-library.sk).azw3", &azw3, None),
            (
                "Kindred".to_owned(),
                vec!["Octavia E. Butler".to_owned()],
                Some("Octavia E. Butler".to_owned())
            )
        );
        // An unreadable header falls back to the filename and still imports.
        let placeholder = crate::metadata::mobi_fixture(65001, b"Unknown", &[(100, b"Unknown")]);
        assert_eq!(
            import(
                "Dawn (Octavia E. Butler) (z-library.sk).mobi",
                &placeholder,
                None
            ),
            (
                "Dawn".to_owned(),
                vec!["Octavia E. Butler".to_owned()],
                Some("Octavia E. Butler".to_owned())
            )
        );
        assert_eq!(
            import("Not Really - A Mobi.mobi", b"not a palm database", None),
            ("Not Really - A Mobi".to_owned(), Vec::new(), None)
        );
    }

    #[test]
    fn custom_metadata_queries_match_safe_fields_and_literals_without_exposing_audit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let source = temp.path().join("earthsea.txt");
        fs::write(&source, "earthsea").unwrap();
        let item = store
            .import(&source, Some("Earthsea"), ImportMode::Copy)
            .unwrap();
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
        let filters = &Filters::default();

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
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
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
            let item = store
                .import(&source, Some(title), ImportMode::Copy)
                .unwrap();
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
        let items = store
            .query_items_scoped(&[LibraryQueryScope {
                query: "author:\"Ursula K. Le Guin\" tag:Classic not publisher:Tor",
                syntax: LibraryQuerySyntax::StructuredV1,
                filters: &Filters::default(),
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
        let error = match LibraryStore::open_existing(paths) {
            Ok(_) => panic!("opening a missing library must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "storage-unavailable");
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Book"), ImportMode::Copy)
            .unwrap();
        assert_eq!(item.title, "Book");
        assert_eq!(store.list(false).unwrap().len(), 1);
        assert_eq!(store.verify().unwrap().managed_formats, 1);
        let first_cover = temp.path().join("first.jpg");
        let second_cover = temp.path().join("second.jpg");
        fs::write(&first_cover, b"first").unwrap();
        fs::write(&second_cover, b"second").unwrap();
        let first = store.set_cover(&item.id, &first_cover).unwrap();
        let first_path = first.item.cover_path.unwrap();
        let second = store.set_cover(&item.id, &second_cover).unwrap();
        assert!(!first_path.exists());
        assert!(second.item.cover_path.unwrap().exists());
    }

    #[test]
    fn candidate_cover_apply_rolls_back_metadata_and_keeps_stage_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Original title"), ImportMode::Copy)
            .unwrap();
        let descriptor = crate::metadata::candidate_cover::stage(
            &store.paths.root,
            &candidate_cover::CoverBinding {
                item_id: &item.id,
                candidate_id: "embedded:cover",
                source: "embedded",
                provenance: "proof",
            },
            &crate::metadata::candidate_cover::CapturedCover {
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
            crate::metadata::candidate_cover::validate(
                &store.paths.root,
                &candidate_cover::CoverBinding {
                    item_id: &item.id,
                    candidate_id: "embedded:cover",
                    source: "embedded",
                    provenance: "proof"
                },
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
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Original title"), ImportMode::Copy)
            .unwrap();
        let descriptor = crate::metadata::candidate_cover::stage(
            &store.paths.root,
            &candidate_cover::CoverBinding {
                item_id: &item.id,
                candidate_id: "embedded:cover",
                source: "embedded",
                provenance: "proof",
            },
            &crate::metadata::candidate_cover::CapturedCover {
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
            crate::metadata::candidate_cover::validate(
                &store.paths.root,
                &candidate_cover::CoverBinding {
                    item_id: &item.id,
                    candidate_id: "embedded:cover",
                    source: "embedded",
                    provenance: "proof"
                },
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
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Book"), ImportMode::Copy)
            .unwrap();
        let artifact = temp.path().join("converted.pdf");
        fs::write(&artifact, b"verified pdf").unwrap();
        let expected = hash_file(&artifact).unwrap();

        fs::write(&artifact, b"mutated pdf").unwrap();
        let error = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, &expected)
            .unwrap_err();
        assert_eq!(error.code(), "artifact-invalid");

        fs::write(&artifact, b"verified pdf").unwrap();
        let attached = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, &expected)
            .unwrap();
        assert_eq!(attached.formats.len(), 2);

        fs::write(&artifact, b"changed after attachment").unwrap();
        let retried = store
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, &expected)
            .unwrap();
        assert_eq!(retried.formats.len(), 2);
    }

    #[test]
    fn verified_artifact_attachment_cleans_up_after_database_failure() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let source = temp.path().join("source.epub");
        fs::write(&source, b"epub source").unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Book"), ImportMode::Copy)
            .unwrap();
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
            .attach_verified_artifact(&item.id, &artifact, FormatId::Pdf, &expected)
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
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let item = store
            .import(&source, Some("Book"), ImportMode::Copy)
            .unwrap();
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
                let mut store = LibraryStore::open_existing(paths).unwrap();
                barrier.wait();
                store.attach_verified_artifact(&item_id, &artifact, FormatId::Pdf, &expected)
            }));
        }
        barrier.wait();
        for worker in workers {
            assert!(worker.join().unwrap().is_ok());
        }

        let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
        let store = LibraryStore::open_existing(paths).unwrap();
        let attached = store.get(&item.id).unwrap().unwrap();
        assert_eq!(attached.formats.len(), 2);
        let pdf = attached
            .formats
            .iter()
            .find(|format| format.format == FormatId::Pdf)
            .unwrap();
        assert_eq!(hash_file(&pdf.source_path).unwrap(), expected);
    }
    mod existing_open {
        use super::*;

        fn paths(root: &Path) -> LibraryPaths {
            LibraryPaths::resolve(
                None,
                Some(&root.canonicalize().unwrap().join("library.sqlite")),
            )
            .unwrap()
        }

        #[test]
        fn strict_existing_open_never_creates_or_migrates() {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(temp.path());
            assert!(LibraryStore::open_existing(paths.clone()).is_err());
            assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
            for version in [0, 1, LIBRARY_SCHEMA_VERSION + 1] {
                let connection = Connection::open(&paths.database).unwrap();
                if version == 1 {
                    connection
                        .execute_batch(include_str!(
                            "store/migration/reference_schemas/schema-v1.sql"
                        ))
                        .unwrap();
                }
                connection
                    .pragma_update(None, "user_version", version)
                    .unwrap();
                drop(connection);
                let before = fs::read(&paths.database).unwrap();
                assert_eq!(
                    LibraryStore::open_existing(paths.clone())
                        .err()
                        .unwrap()
                        .code(),
                    "incompatible-schema"
                );
                assert_eq!(fs::read(&paths.database).unwrap(), before);
                assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
                fs::remove_file(&paths.database).unwrap();
            }
        }

        #[test]
        fn strict_existing_open_rejects_domain_and_trash_data_without_writes() {
            for corruption in [
                "DELETE FROM library_item_formats",
                "UPDATE library_items SET title=CAST(x'ff' AS TEXT)",
                "UPDATE library_item_formats SET content_sha256='bad'",
                "DROP INDEX library_items_by_title",
            ] {
                let temp = tempfile::tempdir().unwrap();
                let paths = paths(temp.path());
                let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
                let source = temp.path().join("source.epub");
                fs::write(&source, b"book").unwrap();
                let item = store.import(&source, None, ImportMode::Copy).unwrap();
                store.trash(&item.id).unwrap();
                store
                    .connection
                    .pragma_update(None, "ignore_check_constraints", "ON")
                    .unwrap();
                store.connection.execute_batch(corruption).unwrap();
                drop(store);
                let before = fs::read(&paths.database).unwrap();
                assert!(
                    LibraryStore::open_existing(paths.clone()).is_err(),
                    "{corruption}"
                );
                assert_eq!(fs::read(&paths.database).unwrap(), before);
            }
        }

        #[test]
        fn strict_existing_open_keeps_missing_external_files_manageable() {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(temp.path());
            let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
            let source = temp.path().join("source.epub");
            fs::write(&source, b"book").unwrap();
            let item = store.import(&source, None, ImportMode::Copy).unwrap();
            store.connection.execute(
            "UPDATE library_item_formats SET provenance='referenced',source_path=?1,content_bytes=NULL,content_sha256=NULL",
            [source.to_string_lossy()],
        ).unwrap();
            drop(store);
            fs::remove_file(&source).unwrap();
            let mut reopened = LibraryStore::open_existing(paths).unwrap();
            assert_eq!(reopened.list(false).unwrap()[0].id, item.id);
            reopened.trash(&item.id).unwrap();
            reopened.restore(&item.id).unwrap();
        }

        #[test]
        fn strict_existing_open_rejects_copied_roots_and_traversal() {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(temp.path());
            let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
            let source = temp.path().join("source.epub");
            fs::write(&source, b"book").unwrap();
            let item = store.import(&source, None, ImportMode::Copy).unwrap();
            let copied = tempfile::tempdir().unwrap();
            fs::copy(&paths.database, copied.path().join("library.sqlite")).unwrap();
            let copied_paths = LibraryPaths::resolve(
                None,
                Some(&copied.path().canonicalize().unwrap().join("library.sqlite")),
            )
            .unwrap();
            assert!(LibraryStore::open_existing(copied_paths).is_err());
            for invalid in [
                paths.items.join(".. escape").join("..").join("book.epub"),
                paths.items.clone(),
                PathBuf::from("relative/items/book.epub"),
            ] {
                store
                    .connection
                    .execute(
                        "UPDATE library_item_formats SET source_path=?1 WHERE library_item_id=?2",
                        params![invalid.to_string_lossy(), item.id],
                    )
                    .unwrap();
                assert!(
                    LibraryStore::open_existing(paths.clone()).is_err(),
                    "{}",
                    invalid.display()
                );
            }
        }

        #[cfg(unix)]
        #[test]
        fn strict_existing_open_rejects_items_tree_symlink_outside_root() {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(temp.path());
            let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
            let source = temp.path().join("source.epub");
            fs::write(&source, b"book").unwrap();
            store.import(&source, None, ImportMode::Copy).unwrap();
            drop(store);
            let outside = tempfile::tempdir().unwrap();
            let moved = outside.path().join("items");
            fs::rename(&paths.items, &moved).unwrap();
            std::os::unix::fs::symlink(&moved, &paths.items).unwrap();
            assert!(LibraryStore::open_existing(paths).is_err());
        }
    }
}
