//! Catalog storage, query, publication, and recovery.

pub mod catalog;
pub mod diagnostics;
pub mod export;
pub mod metadata_candidates;
pub mod metadata_reconcile;
/// Domain values live in the top-level [`crate::model`] leaf. This re-export
/// keeps the established `library::model` path for storage-side callers.
pub use crate::model;
pub mod paths;
pub mod portable;
pub mod query;
pub mod store;
