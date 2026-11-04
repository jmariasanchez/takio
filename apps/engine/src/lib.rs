//! Local-first ebook library engine shared by the CLI, TUI, and native desktop.
//!
//! [`library::store::LibraryStore`] owns a catalogue connection and its managed files.
//! Callers choose library paths explicitly, and the native desktop runs blocking
//! store and filesystem operations on its engine worker rather than the UI thread.
//! Imports copy by default. Moving originals, purging books, and sending to a
//! reader are explicit operations, not side effects of querying the catalogue.
//!
//! Fallible engine operations return [`error::AppResult`] with stable error
//! codes. Command-line parsing and presentation live in the separate `takio`
//! executable package, not in this engine.

//! [`library::model`] is a shared domain-value leaf, not a storage layer.
//! It depends only on serde, standard collections, and [`format`]. Metadata
//! extractors may use its value types without depending on library storage.

pub mod conversion;
pub mod delivery;
pub mod error;
pub(crate) mod executable_discovery;
pub mod file_name;
pub mod fingerprint;
pub mod format;
pub mod import;
pub mod library;
pub mod metadata;

#[cfg(feature = "test-support")]
pub mod test_support;
