use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, Transaction, TransactionBehavior, backup::Backup, params};
use sha2::{Digest, Sha256};

use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;

use super::LIBRARY_SCHEMA_VERSION;

type TableInfoSignature = Vec<(String, String, String, i64, Option<String>, i64)>;
type ForeignKeySignature = Vec<(String, String, String, String, String, String)>;
type SchemaSignature = Vec<(String, String, String, String)>;

const V1_SCHEMA: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v1.sql");
const V2_SCHEMA: &str =
    include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v2.sql");
const V3_SCHEMA: &str =
    include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v3.sql");
const V4_SCHEMA: &str =
    include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v4.sql");
const V5_SCHEMA: &str =
    include_str!("../../../../packages/library-store-bun/test/fixtures/schema-v5.sql");
const V6_SCHEMA: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v6.sql");
const V7_SCHEMA: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v7.sql");
const V8_SCHEMA: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v8.sql");
const V9_SCHEMA: &str = include_str!("../../tests/fixtures/legacy-library-schemas/schema-v9.sql");

const CANONICAL_V11_INDEXES: &str = "
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
    CREATE INDEX library_item_formats_by_fingerprint
      ON library_item_formats(content_bytes,content_sha256,library_item_id,position)
      WHERE provenance='managed';
    CREATE INDEX library_item_authors_by_name
      ON library_item_authors(name COLLATE NOCASE,library_item_id);
    CREATE INDEX library_item_languages_by_language
      ON library_item_languages(language COLLATE NOCASE,library_item_id);
    CREATE INDEX library_item_tags_by_tag
      ON library_item_tags(tag_normalized_name,library_item_id);
    CREATE INDEX saved_library_views_by_name
      ON saved_library_views(name COLLATE NOCASE,id);
    CREATE INDEX library_adoptions_by_state ON library_adoptions(state,updated_at,id);
    CREATE INDEX import_watch_observations_by_accounted_at
      ON import_watch_observations(accounted_at,canonical_source_path);
    CREATE INDEX import_watch_observations_by_fingerprint
      ON import_watch_observations(content_bytes,content_sha256,canonical_source_path);";

#[cfg(test)]
thread_local! {
    static FAIL_AFTER_STEP: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
static HOLD_AFTER_WRITER_LOCK: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(super) fn migrate(
    connection: &mut Connection,
    paths: &LibraryPaths,
    version: i64,
) -> AppResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| AppError::new("migration-failed"))?;
    #[cfg(test)]
    if HOLD_AFTER_WRITER_LOCK.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(150));
    }
    let snapshot =
        Connection::open(&paths.database).map_err(|_| AppError::new("migration-failed"))?;
    snapshot
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| AppError::new("migration-failed"))?;
    verify_sqlite(&snapshot).map_err(|_| AppError::new("integrity-failed"))?;
    if !schema_matches_version(&snapshot, version) {
        return Err(AppError::new("incompatible-schema"));
    }
    let before = snapshot
        .serialize("main")
        .map_err(|_| AppError::new("migration-failed"))?
        .to_vec();
    create_or_verify_backup(&snapshot, paths, version)?;
    drop(snapshot);

    let result = (|| -> Result<(), rusqlite::Error> {
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
        install_canonical_v11_indexes(&transaction)?;
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
        let matches = reopened
            .serialize("main")
            .map(|snapshot| snapshot.to_vec() == before)
            .unwrap_or(false);
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

fn create_or_verify_backup(
    source: &Connection,
    paths: &LibraryPaths,
    version: i64,
) -> AppResult<()> {
    let backup_path = PathBuf::from(format!("{}.v{version}.backup", paths.database.display()));
    let reservation = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup_path);
    let reservation = match reservation {
        Ok(reservation) => reservation,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return verify_existing_backup(source, &backup_path, version);
        }
        Err(_) => return Err(AppError::new("backup-failed")),
    };
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

fn verify_existing_backup(source: &Connection, backup_path: &Path, version: i64) -> AppResult<()> {
    let backup =
        Connection::open_with_flags(backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| AppError::new("backup-failed"))?;
    let backup_version: i64 = backup
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| AppError::new("backup-failed"))?;
    if backup_version != version
        || verify_sqlite(&backup).is_err()
        || !schema_matches_version(&backup, version)
    {
        return Err(AppError::new("backup-failed"));
    }
    let source_digest =
        logical_database_digest(source).map_err(|_| AppError::new("backup-failed"))?;
    let backup_digest =
        logical_database_digest(&backup).map_err(|_| AppError::new("backup-failed"))?;
    if source_digest != backup_digest {
        return Err(AppError::new("backup-failed"));
    }
    Ok(())
}

fn logical_database_digest(connection: &Connection) -> Result<[u8; 32], rusqlite::Error> {
    let mut digest = Sha256::new();
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    digest.update(version.to_le_bytes());
    for (kind, name, table, sql) in schema_signature(connection)? {
        digest_field(&mut digest, kind.as_bytes());
        digest_field(&mut digest, name.as_bytes());
        digest_field(&mut digest, table.as_bytes());
        digest_field(&mut digest, sql.as_bytes());
    }

    for (kind, table) in object_names(connection)? {
        if kind != "table" {
            continue;
        }
        digest_field(&mut digest, table.as_bytes());
        let escaped_table = table.replace('"', "\"\"");
        let mut columns_statement =
            connection.prepare(&format!("PRAGMA table_info(\"{escaped_table}\")"))?;
        let columns = columns_statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let selection = columns
            .iter()
            .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = connection.prepare(&format!(
            "SELECT {selection} FROM \"{escaped_table}\" ORDER BY {selection}"
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            digest.update([0xff]);
            for index in 0..columns.len() {
                use rusqlite::types::ValueRef;
                match row.get_ref(index)? {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(value) => {
                        digest.update([1]);
                        digest.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        digest.update([2]);
                        digest.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        digest.update([3]);
                        digest_field(&mut digest, value);
                    }
                    ValueRef::Blob(value) => {
                        digest.update([4]);
                        digest_field(&mut digest, value);
                    }
                }
            }
        }
    }
    Ok(digest.finalize().into())
}

fn digest_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_le_bytes());
    digest.update(value);
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

pub(super) fn verify_schema_version(connection: &Connection, version: i64) -> AppResult<()> {
    if schema_matches_version(connection, version) {
        Ok(())
    } else {
        Err(AppError::new("incompatible-schema"))
    }
}

fn schema_matches_version(connection: &Connection, version: i64) -> bool {
    if version == LIBRARY_SCHEMA_VERSION {
        return v11_schema_contract(connection).unwrap_or(false);
    }
    let reference = match reference_schema(version) {
        Ok(reference) => reference,
        Err(_) => return false,
    };
    schema_signature(connection).is_ok_and(|actual| actual == reference)
}

fn v11_schema_contract(connection: &Connection) -> Result<bool, rusqlite::Error> {
    let reference = Connection::open_in_memory()?;
    super::create_schema(&reference).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if object_names(connection)? != object_names(&reference)?
        || table_info_signature(connection)? != table_info_signature(&reference)?
        || foreign_key_signature(connection)? != foreign_key_signature(&reference)?
        || index_signature(connection)? != index_signature(&reference)?
        || table_index_contract(connection)? != table_index_contract(&reference)?
        || check_signature(connection)? != check_signature(&reference)?
    {
        return Ok(false);
    }
    let mut statement = connection.prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )?;
    let tables = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                normalize_sql(&row.get::<_, String>(1)?),
            ))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if tables.values().any(|sql| !sql.ends_with("strict")) {
        return Ok(false);
    }
    Ok(true)
}

fn check_signature(connection: &Connection) -> Result<Vec<(String, Vec<String>)>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )?;
    statement
        .query_map([], |row| {
            let mut checks = extract_checks(&normalize_sql(&row.get::<_, String>(1)?));
            checks.sort();
            Ok((row.get(0)?, checks))
        })?
        .collect()
}

fn extract_checks(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut checks = Vec::new();
    let mut cursor = 0;
    while cursor + 6 <= bytes.len() {
        if &bytes[cursor..cursor + 6] != b"check(" {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 6;
        let mut depth = 1usize;
        let mut quoted = false;
        while cursor < bytes.len() && depth > 0 {
            match bytes[cursor] {
                b'\'' => quoted = !quoted,
                b'(' if !quoted => depth += 1,
                b')' if !quoted => depth -= 1,
                _ => {}
            }
            cursor += 1;
        }
        if depth == 0 {
            checks.push(sql[start..cursor].to_owned());
        }
    }
    checks
}

fn table_index_contract(connection: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let tables = object_names(connection)?
        .into_iter()
        .filter_map(|(kind, name)| (kind == "table").then_some(name));
    let mut contracts = Vec::new();
    for table in tables {
        let mut indexes = connection.prepare(&format!(
            "PRAGMA index_list(\"{}\")",
            table.replace('"', "\"\"")
        ))?;
        let rows = indexes
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (name, unique, origin, partial) in rows {
            let mut columns = connection.prepare(&format!(
                "PRAGMA index_xinfo(\"{}\")",
                name.replace('"', "\"\"")
            ))?;
            let details = columns
                .query_map([], |row| {
                    Ok(format!(
                        "{}:{:?}:{}:{:?}:{}",
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            contracts.push(format!(
                "{table}:{unique}:{origin}:{partial}:{}",
                details.join("|")
            ));
        }
    }
    contracts.sort();
    Ok(contracts)
}

fn object_names(connection: &Connection) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type,name",
    )?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

fn table_info_signature(connection: &Connection) -> Result<TableInfoSignature, rusqlite::Error> {
    let tables = object_names(connection)?
        .into_iter()
        .filter_map(|(kind, name)| (kind == "table").then_some(name));
    let mut signature = Vec::new();
    for table in tables {
        let mut statement = connection.prepare(&format!(
            "PRAGMA table_info(\"{}\")",
            table.replace('"', "\"\"")
        ))?;
        for column in statement.query_map([], |row| {
            Ok((
                table.clone(),
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })? {
            signature.push(column?);
        }
    }
    signature.sort();
    Ok(signature)
}

fn foreign_key_signature(connection: &Connection) -> Result<ForeignKeySignature, rusqlite::Error> {
    let tables = object_names(connection)?
        .into_iter()
        .filter_map(|(kind, name)| (kind == "table").then_some(name));
    let mut signature = Vec::new();
    for table in tables {
        let mut statement = connection.prepare(&format!(
            "PRAGMA foreign_key_list(\"{}\")",
            table.replace('"', "\"\"")
        ))?;
        for foreign_key in statement.query_map([], |row| {
            Ok((
                table.clone(),
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })? {
            signature.push(foreign_key?);
        }
    }
    signature.sort();
    Ok(signature)
}

fn index_signature(connection: &Connection) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    )?;
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, normalize_sql(&row.get::<_, String>(1)?)))
        })?
        .collect()
}

fn reference_schema(version: i64) -> Result<SchemaSignature, rusqlite::Error> {
    let reference = Connection::open_in_memory()?;
    match version {
        1 => reference.execute_batch(V1_SCHEMA)?,
        2 => reference.execute_batch(V2_SCHEMA)?,
        3 => reference.execute_batch(V3_SCHEMA)?,
        4 => reference.execute_batch(V4_SCHEMA)?,
        5 => reference.execute_batch(V5_SCHEMA)?,
        6 => reference.execute_batch(V6_SCHEMA)?,
        7 => reference.execute_batch(V7_SCHEMA)?,
        8 => reference.execute_batch(V8_SCHEMA)?,
        9 => reference.execute_batch(V9_SCHEMA)?,
        10 => install_v10_reference_schema(&reference)?,
        11 => install_v11_reference_schema(&reference)?,
        12 => super::create_schema(&reference).map_err(|_| rusqlite::Error::InvalidQuery)?,
        _ => return Err(rusqlite::Error::InvalidQuery),
    }
    schema_signature(&reference)
}

fn schema_signature(connection: &Connection) -> Result<SchemaSignature, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL
         ORDER BY type,name",
    )?;
    statement
        .query_map([], |row| {
            let sql: String = row.get(3)?;
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, normalize_sql(&sql)))
        })?
        .collect()
}

fn normalize_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_ascii_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn install_v10_reference_schema(connection: &Connection) -> Result<(), rusqlite::Error> {
    super::create_schema(connection).map_err(|_| rusqlite::Error::InvalidQuery)?;
    connection.execute_batch(
        "DROP TABLE library_custom_column_definitions;
         DROP TABLE import_watch_observations;
         DROP INDEX library_adoptions_by_state;
         DROP INDEX library_items_by_published_date;
         DROP INDEX library_items_by_rating;
         DROP INDEX library_items_by_trashed_at;
         CREATE INDEX library_items_by_trash ON library_items(trashed_at,id);
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
           source_path TEXT PRIMARY KEY, content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL
         ) STRICT;
         PRAGMA user_version=10;",
    )
}

fn install_v11_reference_schema(connection: &Connection) -> Result<(), rusqlite::Error> {
    super::create_schema(connection).map_err(|_| rusqlite::Error::InvalidQuery)?;
    connection.execute_batch(
        "DROP TABLE library_custom_column_definitions;
         PRAGMA user_version=11;",
    )
}

fn install_canonical_v11_indexes(transaction: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    let indexes = {
        let mut statement = transaction.prepare(
            "SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for index in indexes {
        transaction.execute_batch(&format!("DROP INDEX \"{}\"", index.replace('"', "\"\"")))?;
    }
    transaction.execute_batch(CANONICAL_V11_INDEXES)
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
        11 => transaction.execute_batch("CREATE TABLE library_custom_column_definitions (key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64), label TEXT NOT NULL CHECK(length(label)>0), type TEXT NOT NULL CHECK(type='text'), position INTEGER NOT NULL UNIQUE CHECK(position>=0)) STRICT;"),
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
        let rebased = rebase_paths(rows, &paths.items)?;
        for (rowid, rebased) in rebased {
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
        let rebased = rebase_paths(rows, &paths.covers)?;
        for (rowid, rebased) in rebased {
            transaction.execute(
                "UPDATE library_items SET cover_path=?2 WHERE rowid=?1",
                params![rowid, rebased.to_string_lossy()],
            )?;
        }
    }
    if table_exists(transaction, "managed_file_cleanup")? {
        let rows = {
            let mut statement =
                transaction.prepare("SELECT rowid,source_path,kind FROM managed_file_cleanup")?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut targets = BTreeMap::new();
        for (rowid, stored, kind) in rows {
            let root = if kind == "cover" {
                &paths.covers
            } else {
                &paths.items
            };
            let rebased = rebase_path(&stored, root)?;
            reject_collision(&mut targets, &stored, &rebased)?;
            transaction.execute(
                "UPDATE managed_file_cleanup SET source_path=?2 WHERE rowid=?1",
                params![rowid, rebased.to_string_lossy()],
            )?;
        }
    }
    Ok(())
}

fn rebase_paths(
    rows: Vec<(i64, String)>,
    root: &Path,
) -> Result<Vec<(i64, PathBuf)>, rusqlite::Error> {
    let mut targets = BTreeMap::new();
    rows.into_iter()
        .map(|(rowid, stored)| {
            let rebased = rebase_path(&stored, root)?;
            reject_collision(&mut targets, &stored, &rebased)?;
            Ok((rowid, rebased))
        })
        .collect()
}

fn rebase_path(stored: &str, root: &Path) -> Result<PathBuf, rusqlite::Error> {
    let path = Path::new(stored);
    if path.is_absolute() {
        return path
            .starts_with(root)
            .then(|| path.to_path_buf())
            .ok_or(rusqlite::Error::InvalidQuery);
    }
    let mut components = path.components();
    let first = components.next().ok_or(rusqlite::Error::InvalidQuery)?;
    let relative = if first == Component::Normal("library".as_ref()) {
        components.collect::<PathBuf>()
    } else {
        path.to_path_buf()
    };
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
                    | Component::CurDir
            )
        })
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let rebased = root.join(relative);
    if !rebased.starts_with(root) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(rebased)
}

fn reject_collision(
    targets: &mut BTreeMap<PathBuf, String>,
    source: &str,
    target: &Path,
) -> Result<(), rusqlite::Error> {
    if targets
        .insert(target.to_path_buf(), source.to_owned())
        .is_some_and(|existing| existing != source)
    {
        Err(rusqlite::Error::InvalidQuery)
    } else {
        Ok(())
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
    if !schema_matches_version(transaction, LIBRARY_SCHEMA_VERSION) {
        return Err(rusqlite::Error::InvalidQuery);
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

#[cfg(test)]
fn logical_snapshot(path: &Path) -> Result<Vec<u8>, rusqlite::Error> {
    Ok(Connection::open(path)?.serialize("main")?.to_vec())
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
    use crate::store::{LIBRARY_SCHEMA_VERSION, LibraryStore};

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
                install_v10_reference_schema(&connection).unwrap();
                connection
                    .execute_batch(
                        "INSERT INTO library_items (id,title,added_at,updated_at)
                           VALUES ('fixture-v10','Current v10 fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                         INSERT INTO library_item_formats
                           (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                           VALUES ('fixture-v10','epub','/fixtures/current-v10.epub','2026-01-01T00:00:00Z','referenced',0,NULL,NULL);",
                    )
                    .unwrap();
                return;
            }
            11 => {
                let connection = Connection::open(&paths.database).unwrap();
                install_v11_reference_schema(&connection).unwrap();
                connection
                    .execute_batch(
                        "INSERT INTO library_items (id,title,added_at,updated_at)
                           VALUES ('fixture-v11','Current v11 fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                         INSERT INTO library_item_formats
                           (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                           VALUES ('fixture-v11','epub','/fixtures/current-v11.epub','2026-01-01T00:00:00Z','referenced',0,NULL,NULL);
                         INSERT INTO library_item_custom_metadata(library_item_id,name,value)
                           VALUES ('fixture-v11','shelf','north'),('fixture-v11','takio_metadata_audit','audit bytes');",
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
            let first = paths.items.join("fixture-book/fixture-book.epub");
            let second = paths
                .items
                .join("fixture-book-duplicate/fixture-book-duplicate.epub");
            fs::create_dir_all(first.parent().unwrap()).unwrap();
            fs::create_dir_all(second.parent().unwrap()).unwrap();
            fs::write(first, b"managed one").unwrap();
            fs::write(second, b"managed two").unwrap();
        }
    }

    #[test]
    fn migrates_every_supported_source_version_and_retains_verified_backup() {
        for version in 1..=11 {
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
        let before = logical_snapshot(&paths.database).unwrap();
        fail_after_step(Some(7));
        let error = LibraryStore::open(paths.clone(), true).err().unwrap();
        fail_after_step(None);
        assert_eq!(error.code(), "migration-failed");
        assert_eq!(logical_snapshot(&paths.database).unwrap(), before);
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
    fn failed_migration_reuses_only_a_matching_verified_backup() {
        let temp = tempfile::tempdir().unwrap();
        let library_paths = paths(&temp);
        install_fixture(&library_paths, 9);
        fail_after_step(Some(10));
        let error = LibraryStore::open(library_paths.clone(), true)
            .err()
            .unwrap();
        fail_after_step(None);
        assert_eq!(error.code(), "migration-failed");

        let backup = PathBuf::from(format!("{}.v9.backup", library_paths.database.display()));
        assert!(backup.is_file());
        let store = LibraryStore::open(library_paths.clone(), true).unwrap();
        verify_current(&store.connection, &library_paths).unwrap();
        drop(store);

        let changed = tempfile::tempdir().unwrap();
        let changed_paths = paths(&changed);
        install_fixture(&changed_paths, 9);
        fail_after_step(Some(10));
        let error = LibraryStore::open(changed_paths.clone(), true)
            .err()
            .unwrap();
        fail_after_step(None);
        assert_eq!(error.code(), "migration-failed");
        Connection::open(&changed_paths.database)
            .unwrap()
            .execute("UPDATE library_items SET title=title || ' changed'", [])
            .unwrap();
        let error = LibraryStore::open(changed_paths, true).err().unwrap();
        assert_eq!(error.code(), "backup-failed");
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

    #[test]
    fn wal_failure_uses_logical_snapshot_and_preserves_committed_source() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 7);
        let keeper = Connection::open(&paths.database).unwrap();
        keeper.pragma_update(None, "journal_mode", "WAL").unwrap();
        keeper
            .execute(
                "UPDATE library_items SET title='Committed in WAL' WHERE id='fixture-book-managed'",
                [],
            )
            .unwrap();
        let before = keeper.serialize("main").unwrap().to_vec();
        fail_after_step(Some(9));
        let error = LibraryStore::open(paths.clone(), true).err().unwrap();
        fail_after_step(None);
        assert_eq!(error.code(), "migration-failed");
        let reopened = Connection::open(&paths.database).unwrap();
        assert_eq!(
            reopened.serialize("main").unwrap().as_ref(),
            before.as_slice()
        );
        assert_eq!(
            reopened
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            reopened
                .query_row(
                    "SELECT title FROM library_items WHERE id='fixture-book-managed'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Committed in WAL"
        );
        verify_sqlite(&reopened).unwrap();
    }

    #[test]
    fn concurrent_writer_cannot_change_the_backup_migration_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 7);
        HOLD_AFTER_WRITER_LOCK.store(true, std::sync::atomic::Ordering::SeqCst);
        let migration_paths = paths.clone();
        let migration = std::thread::spawn(move || LibraryStore::open(migration_paths, true));
        std::thread::sleep(Duration::from_millis(30));
        let writer_path = paths.database.clone();
        let writer = std::thread::spawn(move || {
            let writer = Connection::open(writer_path).unwrap();
            writer.busy_timeout(Duration::from_secs(2)).unwrap();
            writer.execute("UPDATE library_items SET title='Concurrent writer' WHERE id='fixture-book-managed'", []).unwrap();
        });
        let store = migration.join().unwrap().unwrap();
        HOLD_AFTER_WRITER_LOCK.store(false, std::sync::atomic::Ordering::SeqCst);
        writer.join().unwrap();
        drop(store);
        let backup = Connection::open(format!("{}.v7.backup", paths.database.display())).unwrap();
        assert_eq!(
            backup
                .query_row(
                    "SELECT title FROM library_items WHERE id='fixture-book-managed'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Fixture Book"
        );
        let current = Connection::open(&paths.database).unwrap();
        assert_eq!(
            current
                .query_row(
                    "SELECT title FROM library_items WHERE id='fixture-book-managed'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Concurrent writer"
        );
    }

    #[test]
    fn rejects_user_version_spoofed_v7_and_v11_without_backup() {
        for version in [7, 11] {
            let temp = tempfile::tempdir().unwrap();
            let paths = paths(&temp);
            if version == 7 {
                install_fixture(&paths, version);
            } else {
                drop(LibraryStore::open(paths.clone(), true).unwrap());
            }
            let connection = Connection::open(&paths.database).unwrap();
            connection
                .execute_batch("CREATE TABLE foreign_extension(value TEXT) STRICT;")
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
    fn rejects_weakened_v11_ddl() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        drop(LibraryStore::open(paths.clone(), true).unwrap());
        let connection = Connection::open(&paths.database).unwrap();
        connection
            .execute_batch(
                "DROP INDEX import_watch_observations_by_accounted_at;
             DROP INDEX import_watch_observations_by_fingerprint;
             DROP TABLE import_watch_observations;
             CREATE TABLE import_watch_observations (
               canonical_source_path TEXT PRIMARY KEY, content_bytes INTEGER NOT NULL,
               content_sha256 TEXT NOT NULL, outcome TEXT NOT NULL, accounted_at TEXT NOT NULL
             ) STRICT;
             CREATE INDEX import_watch_observations_by_accounted_at
               ON import_watch_observations(accounted_at,canonical_source_path);
             CREATE INDEX import_watch_observations_by_fingerprint
               ON import_watch_observations(content_bytes,content_sha256,canonical_source_path);",
            )
            .unwrap();
        drop(connection);
        let error = LibraryStore::open(paths, false).err().unwrap();
        assert_eq!(error.code(), "incompatible-schema");
    }

    #[test]
    fn rejects_v11_missing_one_check_or_unique_constraint() {
        let check_temp = tempfile::tempdir().unwrap();
        let check_paths = paths(&check_temp);
        drop(LibraryStore::open(check_paths.clone(), true).unwrap());
        let connection = Connection::open(&check_paths.database).unwrap();
        connection
            .execute_batch(
                "DROP TABLE source_file_cleanup;
                 CREATE TABLE source_file_cleanup (
                   source_path TEXT PRIMARY KEY CHECK(length(source_path)>0),
                   content_bytes INTEGER NOT NULL,
                   content_sha256 TEXT NOT NULL CHECK(
                     length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
                   )
                 ) STRICT;",
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            LibraryStore::open(check_paths, false).err().unwrap().code(),
            "incompatible-schema"
        );

        let unique_temp = tempfile::tempdir().unwrap();
        let unique_paths = paths(&unique_temp);
        drop(LibraryStore::open(unique_paths.clone(), true).unwrap());
        let connection = Connection::open(&unique_paths.database).unwrap();
        connection
            .execute_batch(
                "DROP INDEX library_adoptions_by_state;
                 DROP TABLE library_adoptions;
                 CREATE TABLE library_adoptions (
                   id TEXT PRIMARY KEY CHECK(length(id)>0),
                   library_item_id TEXT NOT NULL UNIQUE CHECK(length(library_item_id)>0),
                   title TEXT NOT NULL CHECK(length(title)>0),
                   source_path TEXT NOT NULL CHECK(length(source_path)>0),
                   target_path TEXT NOT NULL CHECK(length(target_path)>0),
                   format TEXT NOT NULL CHECK(format IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')),
                   content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
                   content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
                   state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
                   created_at TEXT NOT NULL CHECK(length(created_at)>0),
                   updated_at TEXT NOT NULL CHECK(length(updated_at)>0),
                   CHECK(source_path<>target_path)
                 ) STRICT;
                 CREATE INDEX library_adoptions_by_state
                   ON library_adoptions(state,updated_at,id);",
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            LibraryStore::open(unique_paths, false)
                .err()
                .unwrap()
                .code(),
            "incompatible-schema"
        );
    }

    #[test]
    fn duplicate_basenames_preserve_distinct_relative_components() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp);
        install_fixture(&paths, 7);
        let connection = Connection::open(&paths.database).unwrap();
        connection
            .execute_batch(
                "UPDATE library_item_formats SET source_path='library/first/same.epub'
               WHERE library_item_id='fixture-book-managed' AND format='epub';
             UPDATE library_item_formats SET source_path='library/second/same.epub'
               WHERE library_item_id='fixture-book-trashed' AND format='epub';",
            )
            .unwrap();
        drop(connection);
        let store = LibraryStore::open(paths.clone(), true).unwrap();
        let mut statement = store.connection.prepare(
            "SELECT source_path FROM library_item_formats WHERE provenance='managed' ORDER BY library_item_id",
        ).unwrap();
        let stored = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            stored,
            vec![
                paths.items.join("first/same.epub").to_string_lossy(),
                paths.items.join("second/same.epub").to_string_lossy(),
            ]
        );
    }

    #[test]
    fn fresh_and_migrated_v11_have_identical_canonical_indexes() {
        let fresh_temp = tempfile::tempdir().unwrap();
        let fresh_paths = paths(&fresh_temp);
        let fresh = LibraryStore::open(fresh_paths, true).unwrap();
        let migrated_temp = tempfile::tempdir().unwrap();
        let migrated_paths = paths(&migrated_temp);
        install_fixture(&migrated_paths, 7);
        let migrated = LibraryStore::open(migrated_paths, true).unwrap();
        assert_eq!(
            index_signature(&fresh.connection).unwrap(),
            index_signature(&migrated.connection).unwrap()
        );
        assert_eq!(index_signature(&fresh.connection).unwrap().len(), 17);
    }
}
