use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, Transaction, TransactionBehavior, backup::Backup, params};
use sha2::{Digest, Sha256};

use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;

use super::LIBRARY_SCHEMA_VERSION;

#[cfg(test)]
thread_local! {
    static FAIL_AFTER_STEP: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

pub(super) fn migrate(
    connection: &mut Connection,
    paths: &LibraryPaths,
    version: i64,
) -> AppResult<()> {
    verify_sqlite(connection).map_err(|_| AppError::new("integrity-failed"))?;
    let before = database_sha256(&paths.database).map_err(|_| AppError::new("migration-failed"))?;
    create_verified_backup(connection, paths, version)?;

    let result = (|| -> Result<(), rusqlite::Error> {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS source_file_cleanup (
               source_path TEXT PRIMARY KEY,
               content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
             ) STRICT;",
        )?;
        for source in version..LIBRARY_SCHEMA_VERSION {
            migrate_adjacent(&transaction, paths, source)?;
            inject_failure(source + 1)?;
        }
        rebase_historical_paths(&transaction, paths)?;
        verify_v11_domain(&transaction, paths)?;
        transaction.pragma_update(None, "user_version", LIBRARY_SCHEMA_VERSION)?;
        transaction.commit()
    })();

    if result.is_ok() {
        return Ok(());
    }
    let rollback_proved = (|| -> Result<bool, rusqlite::Error> {
        let placeholder = Connection::open_in_memory()?;
        let failed = std::mem::replace(connection, placeholder);
        drop(failed);
        let reopened = Connection::open(&paths.database)?;
        reopened.pragma_update(None, "foreign_keys", "ON")?;
        verify_sqlite(&reopened)?;
        let restored_version: i64 =
            reopened.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if restored_version != version {
            return Ok(false);
        }
        let matches = database_sha256(&paths.database).ok().as_deref() == Some(before.as_str());
        *connection = reopened;
        Ok(matches)
    })()
    .unwrap_or(false);
    Err(AppError::new(if rollback_proved {
        "migration-failed"
    } else {
        "rollback-failed"
    }))
}

fn create_verified_backup(
    source: &Connection,
    paths: &LibraryPaths,
    version: i64,
) -> AppResult<()> {
    let backup_path = PathBuf::from(format!("{}.v{version}.backup", paths.database.display()));
    let reservation = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup_path)
        .map_err(|_| AppError::new("backup-failed"))?;
    drop(reservation);
    let result = (|| -> Result<(), rusqlite::Error> {
        let mut destination = Connection::open(&backup_path)?;
        let backup = Backup::new(source, &mut destination)?;
        backup.run_to_completion(16, Duration::from_millis(10), None)?;
        drop(backup);
        let backup_version: i64 =
            destination.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if backup_version != version {
            return Err(rusqlite::Error::InvalidQuery);
        }
        destination.pragma_update(None, "foreign_keys", "ON")?;
        verify_sqlite(&destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&backup_path);
        return Err(AppError::new("backup-failed"));
    }
    Ok(())
}

fn verify_sqlite(connection: &Connection) -> Result<(), rusqlite::Error> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let foreign_keys: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if integrity == "ok" && foreign_keys == 0 {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

fn migrate_adjacent(
    transaction: &Transaction<'_>,
    paths: &LibraryPaths,
    version: i64,
) -> Result<(), rusqlite::Error> {
    match version {
        1 => migrate_v1_to_v2(transaction),
        2 => migrate_v2_to_v3(transaction),
        3 => migrate_v3_to_v4(transaction),
        4 => migrate_v4_to_v5(transaction),
        5 => migrate_v5_to_v6(transaction),
        6 => migrate_v6_to_v7(transaction, paths),
        7 => transaction.execute_batch(DUPLICATE_PAIR_REVIEWS_DDL),
        8 => transaction.execute_batch(CUSTOM_METADATA_DDL),
        9 => transaction.execute_batch(LIBRARY_ADOPTIONS_DDL),
        10 => migrate_v10_to_v11(transaction),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn migrate_v1_to_v2(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "ALTER TABLE library_items ADD COLUMN author TEXT;
         ALTER TABLE library_items ADD COLUMN description TEXT;
         ALTER TABLE library_items ADD COLUMN cover_path TEXT;
         ALTER TABLE library_items ADD COLUMN updated_at TEXT;
         CREATE TABLE tags (normalized_name TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
         CREATE TABLE library_item_tags (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
           position INTEGER NOT NULL,
           PRIMARY KEY (library_item_id, tag_normalized_name),
           UNIQUE (library_item_id, position)
         ) STRICT;",
    )
}

fn migrate_v2_to_v3(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "CREATE TABLE library_item_formats (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           format TEXT NOT NULL, source_path TEXT NOT NULL, added_at TEXT NOT NULL,
           position INTEGER NOT NULL CHECK (position >= 0),
           PRIMARY KEY (library_item_id, format), UNIQUE (library_item_id, position)
         ) STRICT;
         INSERT INTO library_item_formats (library_item_id,format,source_path,added_at,position)
           SELECT id,format,source_path,added_at,0 FROM library_items;
         ALTER TABLE library_items DROP COLUMN source_path;
         ALTER TABLE library_items DROP COLUMN format;",
    )
}

fn migrate_v3_to_v4(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "ALTER TABLE library_item_formats RENAME TO library_item_formats_v3;
         CREATE TABLE library_item_formats (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           format TEXT NOT NULL, source_path TEXT NOT NULL, added_at TEXT NOT NULL,
           provenance TEXT NOT NULL CHECK (provenance IN ('managed','referenced')),
           position INTEGER NOT NULL CHECK (position >= 0),
           PRIMARY KEY (library_item_id, format), UNIQUE (library_item_id, position)
         ) STRICT;
         INSERT INTO library_item_formats
           (library_item_id,format,source_path,added_at,provenance,position)
           SELECT library_item_id,format,source_path,added_at,'referenced',position
           FROM library_item_formats_v3;
         DROP TABLE library_item_formats_v3;
         CREATE TABLE managed_file_cleanup (
           source_path TEXT PRIMARY KEY,
           kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format','cover'))
         ) STRICT;",
    )
}

fn migrate_v4_to_v5(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "ALTER TABLE library_items ADD COLUMN series TEXT;
         ALTER TABLE library_items ADD COLUMN series_index REAL;
         ALTER TABLE library_items ADD COLUMN publisher TEXT;
         ALTER TABLE library_items ADD COLUMN published_date TEXT;
         ALTER TABLE library_items ADD COLUMN rating REAL CHECK (rating >= 0 AND rating <= 10);
         CREATE TABLE library_item_authors (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           name TEXT NOT NULL, sort_name TEXT, position INTEGER NOT NULL CHECK(position >= 0),
           PRIMARY KEY(library_item_id,position)
         ) STRICT;
         CREATE TABLE library_item_languages (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           language TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
           PRIMARY KEY(library_item_id,position)
         ) STRICT;
         CREATE TABLE library_item_identifiers (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           scheme TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,scheme)
         ) STRICT;
         CREATE TABLE saved_library_views (
           id TEXT PRIMARY KEY, name TEXT NOT NULL,
           definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         ) STRICT;
         CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE,id);
         CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE,id);
         CREATE INDEX library_items_by_series ON library_items(series COLLATE NOCASE,series_index,id);
         CREATE INDEX library_items_by_published_date ON library_items(published_date,id);
         CREATE INDEX library_items_by_rating ON library_items(rating,id);
         CREATE INDEX library_items_by_added_at ON library_items(added_at,id);
         CREATE INDEX library_items_by_updated_at ON library_items(updated_at,id);
         CREATE INDEX library_item_tags_by_tag ON library_item_tags(tag_normalized_name,library_item_id);
         CREATE INDEX library_item_formats_by_format ON library_item_formats(format,library_item_id);
         CREATE INDEX library_item_authors_by_name ON library_item_authors(name COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_languages_by_language ON library_item_languages(language COLLATE NOCASE,library_item_id);
         CREATE INDEX saved_library_views_by_name ON saved_library_views(name COLLATE NOCASE,id);",
    )
}

fn migrate_v5_to_v6(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "ALTER TABLE library_items ADD COLUMN trashed_at TEXT;
         CREATE INDEX library_items_by_trashed_at
           ON library_items(trashed_at DESC,id ASC) WHERE trashed_at IS NOT NULL;",
    )
}

fn migrate_v6_to_v7(
    transaction: &Transaction<'_>,
    paths: &LibraryPaths,
) -> Result<(), rusqlite::Error> {
    rebase_historical_paths(transaction, paths)?;
    let rows = {
        let mut statement = transaction.prepare(
            "SELECT library_item_id,format,source_path,added_at,provenance,position
             FROM library_item_formats ORDER BY library_item_id,position",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    transaction.execute_batch(
        "ALTER TABLE library_item_formats RENAME TO library_item_formats_v6;
         CREATE TABLE library_item_formats (
           library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           format TEXT NOT NULL, source_path TEXT NOT NULL, added_at TEXT NOT NULL,
           provenance TEXT NOT NULL CHECK(provenance IN ('managed','referenced')),
           position INTEGER NOT NULL CHECK(position >= 0), content_bytes INTEGER, content_sha256 TEXT,
           CHECK((provenance='managed' AND content_bytes IS NOT NULL AND content_bytes>=0
             AND content_sha256 IS NOT NULL AND length(content_sha256)=64
             AND content_sha256 NOT GLOB '*[^0-9a-f]*') OR
             (provenance='referenced' AND content_bytes IS NULL AND content_sha256 IS NULL)),
           PRIMARY KEY(library_item_id,format), UNIQUE(library_item_id,position)
         ) STRICT;",
    )?;
    for (id, format, path, added_at, provenance, position) in rows {
        let fingerprint = if provenance == "managed" {
            Some(file_fingerprint(Path::new(&path)).map_err(|_| rusqlite::Error::InvalidQuery)?)
        } else {
            None
        };
        transaction.execute(
            "INSERT INTO library_item_formats
             (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                format,
                path,
                added_at,
                provenance,
                position,
                fingerprint.as_ref().map(|value| value.0),
                fingerprint.as_ref().map(|value| value.1.as_str())
            ],
        )?;
    }
    transaction.execute_batch(
        "DROP TABLE library_item_formats_v6;
         CREATE INDEX library_item_formats_by_format ON library_item_formats(format,library_item_id);
         CREATE INDEX library_item_formats_by_fingerprint
           ON library_item_formats(content_bytes,content_sha256,library_item_id,position)
           WHERE provenance='managed';",
    )
}

fn migrate_v10_to_v11(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "ALTER TABLE duplicate_pair_reviews RENAME TO duplicate_pair_reviews_v10;
         CREATE TABLE duplicate_pair_reviews (
           left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           review_token TEXT NOT NULL CHECK(length(review_token)=64 AND review_token NOT GLOB '*[^0-9a-f]*'),
           reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)>0),
           PRIMARY KEY(left_id,right_id), CHECK(left_id < right_id)
         ) STRICT;
         INSERT INTO duplicate_pair_reviews SELECT * FROM duplicate_pair_reviews_v10;
         DROP TABLE duplicate_pair_reviews_v10;
         ALTER TABLE source_file_cleanup RENAME TO source_file_cleanup_v10;
         CREATE TABLE source_file_cleanup (
           source_path TEXT PRIMARY KEY CHECK(length(source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
         ) STRICT;
         INSERT INTO source_file_cleanup SELECT * FROM source_file_cleanup_v10;
         DROP TABLE source_file_cleanup_v10;
         DROP INDEX IF EXISTS library_adoptions_by_state;
         ALTER TABLE library_adoptions RENAME TO library_adoptions_v10;",
    )?;
    transaction.execute_batch(LIBRARY_ADOPTIONS_DDL)?;
    transaction.execute_batch(
        "INSERT INTO library_adoptions SELECT * FROM library_adoptions_v10;
         DROP TABLE library_adoptions_v10;
         CREATE TABLE import_watch_observations (
           canonical_source_path TEXT PRIMARY KEY CHECK(length(canonical_source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
           outcome TEXT NOT NULL CHECK(outcome IN ('imported','duplicate','unsupported','failed')),
           accounted_at TEXT NOT NULL CHECK(length(accounted_at)>0)
         ) STRICT;
         CREATE INDEX import_watch_observations_by_accounted_at
           ON import_watch_observations(accounted_at,canonical_source_path);
         CREATE INDEX import_watch_observations_by_fingerprint
           ON import_watch_observations(content_bytes,content_sha256,canonical_source_path);",
    )
}

const DUPLICATE_PAIR_REVIEWS_DDL: &str =
    "CREATE TABLE duplicate_pair_reviews (
       left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
       right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
       review_token TEXT NOT NULL CHECK(length(review_token)=64 AND review_token NOT GLOB '*[^0-9a-f]*'),
       reviewed_at TEXT NOT NULL, PRIMARY KEY(left_id,right_id)
     ) STRICT;";

const CUSTOM_METADATA_DDL: &str = "CREATE TABLE library_item_custom_metadata (
       library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
       name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,name)
     ) STRICT;";

const LIBRARY_ADOPTIONS_DDL: &str =
    "CREATE TABLE library_adoptions (
       id TEXT PRIMARY KEY CHECK(length(id)>0),
       library_item_id TEXT NOT NULL UNIQUE CHECK(length(library_item_id)>0),
       title TEXT NOT NULL CHECK(length(title)>0),
       source_path TEXT NOT NULL CHECK(length(source_path)>0),
       target_path TEXT NOT NULL UNIQUE CHECK(length(target_path)>0),
       format TEXT NOT NULL CHECK(format IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')),
       content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
       content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
       state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
       created_at TEXT NOT NULL CHECK(length(created_at)>0),
       updated_at TEXT NOT NULL CHECK(length(updated_at)>0),
       CHECK(source_path<>target_path)
     ) STRICT;
     CREATE INDEX library_adoptions_by_state ON library_adoptions(state,updated_at,id);";

fn rebase_historical_paths(
    transaction: &Transaction<'_>,
    paths: &LibraryPaths,
) -> Result<(), rusqlite::Error> {
    if table_exists(transaction, "library_item_formats")?
        && column_exists(transaction, "library_item_formats", "provenance")?
    {
        let rows = query_paths(
            transaction,
            "SELECT rowid,source_path FROM library_item_formats WHERE provenance='managed'",
        )?;
        for (rowid, stored) in rows {
            let rebased = rebase_path(&stored, &paths.items);
            transaction.execute(
                "UPDATE library_item_formats SET source_path=?2 WHERE rowid=?1",
                params![rowid, rebased.to_string_lossy()],
            )?;
        }
    }
    if table_exists(transaction, "library_items")?
        && column_exists(transaction, "library_items", "cover_path")?
    {
        let rows = query_paths(
            transaction,
            "SELECT rowid,cover_path FROM library_items WHERE cover_path IS NOT NULL",
        )?;
        for (rowid, stored) in rows {
            if Path::new(&stored).is_absolute() {
                continue;
            }
            let rebased = rebase_path(&stored, &paths.covers);
            transaction.execute(
                "UPDATE library_items SET cover_path=?2 WHERE rowid=?1",
                params![rowid, rebased.to_string_lossy()],
            )?;
        }
    }
    if table_exists(transaction, "managed_file_cleanup")? {
        let rows = query_paths(
            transaction,
            "SELECT rowid,source_path FROM managed_file_cleanup",
        )?;
        for (rowid, stored) in rows {
            let root = if stored.to_ascii_lowercase().ends_with(".jpg")
                || stored.to_ascii_lowercase().ends_with(".jpeg")
                || stored.to_ascii_lowercase().ends_with(".png")
            {
                &paths.covers
            } else {
                &paths.items
            };
            let rebased = rebase_path(&stored, root);
            transaction.execute(
                "UPDATE managed_file_cleanup SET source_path=?2 WHERE rowid=?1",
                params![rowid, rebased.to_string_lossy()],
            )?;
        }
    }
    Ok(())
}

fn rebase_path(stored: &str, root: &Path) -> PathBuf {
    let path = Path::new(stored);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path.file_name().unwrap_or_default())
    }
}

fn query_paths(
    transaction: &Transaction<'_>,
    sql: &str,
) -> Result<Vec<(i64, String)>, rusqlite::Error> {
    let mut statement = transaction.prepare(sql)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

fn table_exists(transaction: &Transaction<'_>, name: &str) -> Result<bool, rusqlite::Error> {
    transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
}

fn column_exists(
    transaction: &Transaction<'_>,
    table: &str,
    column: &str,
) -> Result<bool, rusqlite::Error> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == column))
}

fn verify_v11_domain(
    transaction: &Transaction<'_>,
    paths: &LibraryPaths,
) -> Result<(), rusqlite::Error> {
    verify_sqlite(transaction)?;
    for table in [
        "library_items",
        "tags",
        "library_item_tags",
        "library_item_formats",
        "library_item_authors",
        "library_item_languages",
        "library_item_identifiers",
        "library_item_custom_metadata",
        "saved_library_views",
        "duplicate_pair_reviews",
        "library_adoptions",
        "managed_file_cleanup",
        "source_file_cleanup",
        "import_watch_observations",
    ] {
        if !table_exists(transaction, table)? {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    for index in [
        "library_item_formats_by_fingerprint",
        "library_adoptions_by_state",
        "import_watch_observations_by_accounted_at",
        "import_watch_observations_by_fingerprint",
    ] {
        let present: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?1)",
            [index],
            |row| row.get(0),
        )?;
        if !present {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let invalid: i64 = transaction.query_row(
        "SELECT
          EXISTS(SELECT 1 FROM library_items li WHERE NOT EXISTS(
            SELECT 1 FROM library_item_formats f WHERE f.library_item_id=li.id AND f.position=0))
          OR EXISTS(SELECT 1 FROM library_item_formats WHERE
            format NOT IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')
            OR position<0 OR length(source_path)=0
            OR (provenance='managed' AND (content_bytes<0 OR length(content_sha256)<>64 OR content_sha256 GLOB '*[^0-9a-f]*'))
            OR (provenance='referenced' AND (content_bytes IS NOT NULL OR content_sha256 IS NOT NULL)))
          OR EXISTS(SELECT 1 FROM duplicate_pair_reviews WHERE left_id>=right_id
            OR length(review_token)<>64 OR review_token GLOB '*[^0-9a-f]*' OR length(reviewed_at)=0)
          OR EXISTS(SELECT 1 FROM library_adoptions WHERE length(id)=0 OR length(library_item_id)=0
            OR length(title)=0 OR length(source_path)=0 OR length(target_path)=0 OR source_path=target_path
            OR format NOT IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')
            OR content_bytes<0 OR length(content_sha256)<>64 OR content_sha256 GLOB '*[^0-9a-f]*'
            OR state NOT IN ('pending-rename','renamed','finalizing') OR length(created_at)=0 OR length(updated_at)=0)
          OR EXISTS(SELECT 1 FROM source_file_cleanup WHERE length(source_path)=0 OR content_bytes<0
            OR length(content_sha256)<>64 OR content_sha256 GLOB '*[^0-9a-f]*')",
        [],
        |row| row.get(0),
    )?;
    if invalid != 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut statement = transaction
        .prepare("SELECT source_path FROM library_item_formats WHERE provenance='managed'")?;
    for path in statement.query_map([], |row| row.get::<_, String>(0))? {
        if !Path::new(&path?).starts_with(&paths.items) {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let mut statement =
        transaction.prepare("SELECT canonical_source_path FROM import_watch_observations")?;
    for path in statement.query_map([], |row| row.get::<_, String>(0))? {
        if !Path::new(&path?).is_absolute() {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

pub(super) fn verify_current(connection: &Connection, paths: &LibraryPaths) -> AppResult<()> {
    let transaction = connection.unchecked_transaction()?;
    let result = verify_v11_domain(&transaction, paths);
    transaction.rollback()?;
    result.map_err(|_| AppError::new("integrity-failed"))
}

fn file_fingerprint(path: &Path) -> std::io::Result<(i64, String)> {
    let bytes = fs::read(path)?;
    let size = i64::try_from(bytes.len()).map_err(|_| std::io::Error::other("file too large"))?;
    Ok((size, hex::encode(Sha256::digest(bytes))))
}

fn database_sha256(path: &Path) -> std::io::Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

fn inject_failure(next_version: i64) -> Result<(), rusqlite::Error> {
    #[cfg(test)]
    if FAIL_AFTER_STEP.with(|target| target.get() == Some(next_version)) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let _ = next_version;
    Ok(())
}

#[cfg(test)]
pub(super) fn fail_after_step(version: Option<i64>) {
    FAIL_AFTER_STEP.with(|target| target.set(version));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{LIBRARY_SCHEMA_VERSION, LibraryStore, create_schema};

    const V1: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v1.sql");
    const V2: &str =
        include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v2.sql");
    const V3: &str =
        include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v3.sql");
    const V4: &str =
        include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v4.sql");
    const V5: &str =
        include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v5.sql");
    const V6: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v6.sql");
    const V7: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v7.sql");
    const V8: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v8.sql");
    const V9: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v9.sql");

    fn paths(temp: &tempfile::TempDir) -> LibraryPaths {
        LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap()
    }

    fn install_fixture(paths: &LibraryPaths, version: i64) {
        fs::create_dir_all(&paths.items).unwrap();
        fs::create_dir_all(&paths.covers).unwrap();
        let sql = match version {
            1 => V1.to_owned(),
            2 => V2.to_owned(),
            3 => V3
                .replace(
                    "__LIBRARY_ROOT__/items/book-v3-singleton.epub",
                    "/external/book-v3-singleton.epub",
                )
                .replace(
                    "__LIBRARY_ROOT__/items/book-v3-multi.pdf",
                    "/external/book-v3-multi.pdf",
                )
                .replace(
                    "__EXTERNAL_ROOT__/the-fifth-season.epub",
                    "/external/the-fifth-season.epub",
                ),
            4 => V4.to_owned(),
            5 => V5.to_owned(),
            6 => V6.to_owned(),
            7 => V7.to_owned(),
            8 => V8.to_owned(),
            9 => V9.to_owned(),
            10 => {
                let connection = Connection::open(&paths.database).unwrap();
                create_schema(&connection).unwrap();
                connection
                    .execute_batch(
                        "DROP TABLE import_watch_observations;
                         DROP INDEX library_adoptions_by_state;
                         DROP TABLE duplicate_pair_reviews;
                         CREATE TABLE duplicate_pair_reviews (
                           left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
                           right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
                           review_token TEXT NOT NULL, reviewed_at TEXT NOT NULL,
                           PRIMARY KEY(left_id,right_id)
                         ) STRICT;
                         DROP TABLE library_adoptions;
                         CREATE TABLE library_adoptions (
                           id TEXT PRIMARY KEY, library_item_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
                           source_path TEXT NOT NULL, target_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL,
                           content_bytes INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
                           state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
                           created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                         ) STRICT;
                         DROP TABLE source_file_cleanup;
                         CREATE TABLE source_file_cleanup (
                           source_path TEXT PRIMARY KEY,
                           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
                           content_sha256 TEXT NOT NULL
                         ) STRICT;
                         INSERT INTO library_items (id,title,added_at,updated_at)
                           VALUES ('fixture-v10','Current v10 fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                         INSERT INTO library_item_formats
                           (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                           VALUES ('fixture-v10','epub','/fixtures/current-v10.epub','2026-01-01T00:00:00Z','referenced',0,NULL,NULL);
                         PRAGMA user_version=10;",
                    )
                    .unwrap();
                return;
            }
            _ => unreachable!(),
        };
        Connection::open(&paths.database)
            .unwrap()
            .execute_batch(&sql)
            .unwrap();
        if version == 6 {
            fs::write(paths.items.join("fixture-book.epub"), b"managed one").unwrap();
            fs::write(
                paths.items.join("fixture-book-duplicate.epub"),
                b"managed two",
            )
            .unwrap();
        }
    }

    #[test]
    fn migrates_every_supported_source_version_and_retains_verified_backup() {
        for version in 1..=10 {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(&temp);
            install_fixture(&paths, version);
            let store = LibraryStore::open(paths.clone(), true)
                .unwrap_or_else(|error| panic!("v{version} migration failed: {}", error.code()));
            let migrated_version: i64 = store
                .connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(migrated_version, LIBRARY_SCHEMA_VERSION);
            verify_current(&store.connection, &paths).unwrap();
            assert!(
                PathBuf::from(format!("{}.v{version}.backup", paths.database.display())).is_file()
            );
            let backup =
                Connection::open(format!("{}.v{version}.backup", paths.database.display()))
                    .unwrap();
            assert_eq!(
                backup
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .unwrap(),
                version
            );
            assert_eq!(
                backup
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
    }

    #[test]
    fn refuses_to_overwrite_migration_backup() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 9);
        let backup = PathBuf::from(format!("{}.v9.backup", paths.database.display()));
        fs::write(&backup, b"keep me").unwrap();
        let error = LibraryStore::open(paths, true).err().unwrap();
        assert_eq!(error.code(), "backup-failed");
        assert_eq!(fs::read(backup).unwrap(), b"keep me");
    }

    #[test]
    fn rebases_historical_owned_paths_to_current_library_paths() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 7);
        let store = LibraryStore::open(paths.clone(), true).unwrap();
        let managed: String = store.connection.query_row(
            "SELECT source_path FROM library_item_formats WHERE provenance='managed' ORDER BY library_item_id LIMIT 1",
            [], |row| row.get(0)).unwrap();
        let cover: String = store
            .connection
            .query_row(
                "SELECT cover_path FROM library_items WHERE cover_path IS NOT NULL LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cleanup: String = store
            .connection
            .query_row(
                "SELECT source_path FROM managed_file_cleanup LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(Path::new(&managed).starts_with(&paths.items));
        assert!(Path::new(&cover).starts_with(&paths.covers));
        assert!(Path::new(&cleanup).starts_with(&paths.items));
    }

    #[test]
    fn rejects_future_and_foreign_zero_version_schemas_without_backup() {
        for version in [0, 12] {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(&temp);
            let connection = Connection::open(&paths.database).unwrap();
            connection
                .execute_batch("CREATE TABLE foreign_data(value TEXT) STRICT;")
                .unwrap();
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            drop(connection);
            let error = LibraryStore::open(paths.clone(), true).err().unwrap();
            assert_eq!(error.code(), "incompatible-schema");
            assert!(
                !PathBuf::from(format!("{}.v{version}.backup", paths.database.display())).exists()
            );
        }
    }

    #[test]
    fn injected_mid_migration_failure_rolls_back_with_identical_hash_and_readable_source() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 4);
        let before = database_sha256(&paths.database).unwrap();
        fail_after_step(Some(7));
        let error = LibraryStore::open(paths.clone(), true).err().unwrap();
        fail_after_step(None);
        assert_eq!(error.code(), "migration-failed");
        assert_eq!(database_sha256(&paths.database).unwrap(), before);
        let source = Connection::open(&paths.database).unwrap();
        assert_eq!(
            source
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            4
        );
        verify_sqlite(&source).unwrap();
        let rows: i64 = source
            .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
            .unwrap();
        assert!(rows > 0);
    }

    #[test]
    fn current_verification_rejects_invalid_domain_even_when_sqlite_is_integral() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        let store = LibraryStore::open(paths.clone(), true).unwrap();
        store
            .connection
            .execute_batch(
                "PRAGMA ignore_check_constraints=ON;
             INSERT INTO import_watch_observations VALUES ('',-1,'bad','unknown','');
             PRAGMA ignore_check_constraints=OFF;",
            )
            .unwrap();
        let error = store.verify().unwrap_err();
        assert_eq!(error.code(), "integrity-failed");
    }
}
