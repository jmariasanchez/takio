//! Local-first ebook library engine shared by the CLI, TUI, and native desktop.
//!
//! [`store::LibraryStore`] owns a catalogue connection and its managed files.
//! Callers choose library paths explicitly, and the native desktop runs blocking
//! store and filesystem operations on its engine worker rather than the UI thread.
//! Imports copy by default. Moving originals, purging books, and sending to a
//! reader are explicit operations, not side effects of querying the catalogue.
//!
//! Fallible engine operations return [`output::AppResult`] with stable error
//! codes. [`run`] is the command-line entry point, including argument parsing
//! and output. Embedders should use the engine modules directly instead.

pub mod calibre_import;
pub(crate) mod candidate_cover;
mod catalog;
pub mod cli;
pub mod conversion;
pub mod destinations;
pub mod diagnostics;
pub mod error;
mod executable_discovery;
pub mod fingerprint;
pub mod format;
pub mod import_scan;
pub mod jobs;
pub mod kindle_ssh;
pub mod koreader;
pub mod library_query;
pub mod maintenance;
pub mod metadata;
mod metadata_reconcile;
pub mod model;
pub mod output;
pub mod paths;
pub mod portable_library;
pub mod reader_shelf;
pub mod server;
pub mod store;
pub mod tui;

pub use cli::run;
