//! Local-first ebook library engine shared by the CLI, TUI, and native desktop.
//!
//! [`library::store::LibraryStore`] owns a catalog connection and its managed files.
//! Callers choose library paths explicitly, and the native desktop runs blocking
//! store and filesystem operations on its engine worker rather than the UI thread.
//! Imports copy by default. Moving originals, purging books, and sending to a
//! reader are explicit operations, not side effects of querying the catalog.
//!
//! Fallible engine operations return [`error::AppResult`] with stable error
//! codes. Command-line parsing and presentation live in the separate `takio`
//! executable package, not in this engine.

//! [`model`] is a shared domain-value leaf, not a storage layer. It depends
//! only on serde, standard collections, [`mod@format`] and the [`error`] codes.
//! [`metadata`] extractors use its value types without depending on
//! [`library`] storage. `library::model` re-exports it for storage callers.

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
pub mod model;

#[cfg(feature = "test-support")]
pub mod test_support;
