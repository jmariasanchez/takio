//! Local-first ebook library engine shared by the CLI, TUI, and native desktop.
//!
//! [`store::LibraryStore`] owns a catalogue connection and its managed files.
//! Callers choose library paths explicitly, and the native desktop runs blocking
//! store and filesystem operations on its engine worker rather than the UI thread.
//! Imports copy by default. Moving originals, purging books, and sending to a
//! reader are explicit operations, not side effects of querying the catalogue.
//!
//! Fallible engine operations return [`output::AppResult`] with stable error
//! codes. Command-line parsing and presentation live in the separate `takio`
//! executable package, not in this engine.

pub mod conversion;
pub mod delivery;
pub mod error;
pub mod fingerprint;
pub mod format;
pub mod import;
pub mod library;
pub mod metadata;
pub mod output;

pub(crate) use conversion::executable_discovery;
pub use conversion::{jobs, maintenance};
pub use delivery::{destinations, kindle_ssh, koreader, reader_shelf};
pub use import::{calibre_import, import_scan};
pub use library::{
    catalog, diagnostics, export, library_query, model, paths, portable_library, store,
};
pub use metadata::{candidate_cover, metadata_candidates, metadata_reconcile};
