//! Fixtures for adapter and engine integration tests.
//!
//! Available only with the `test-support` feature. These helpers intentionally
//! bypass catalogue invariants and must only be used with disposable libraries.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

/// Synthetic PDFs shared by engine and adapter metadata tests.
#[path = "../tests/support/pdf.rs"]
pub mod pdf;

fn existing_database(database: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

/// Remove all format rows to simulate an item that cannot be hydrated.
pub fn remove_item_formats(database: &Path, item_id: &str) -> rusqlite::Result<()> {
    existing_database(database)?.execute(
        "DELETE FROM library_item_formats WHERE library_item_id=?1",
        [item_id],
    )?;
    Ok(())
}

/// Seed private provenance to test that public projections never disclose it.
pub fn insert_metadata_audit(database: &Path, item_id: &str, value: &str) -> rusqlite::Result<()> {
    existing_database(database)?.execute(
        "INSERT INTO library_item_custom_metadata(library_item_id,name,value) VALUES(?1,'takio_metadata_audit',?2)",
        [item_id, value],
    )?;
    Ok(())
}

/// Create an empty historical catalogue for non-migration/read-only tests.
pub fn legacy_schema_v1(database: &Path) -> rusqlite::Result<()> {
    Connection::open(database)?.execute_batch(include_str!(
        "../tests/fixtures/legacy-library-schemas/schema-v1.sql"
    ))
}
