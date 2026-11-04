use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::Builder;
use walkdir::WalkDir;

use crate::error::AppResult;
use crate::library::paths::LibraryPaths;
use crate::library::store::{LibraryStore, VerifyReport};

pub const MAX_DIAGNOSTIC_BUNDLE_BYTES: usize = 1024 * 1024;
const MAX_SCANNED_ENTRIES: u64 = 1_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub generated_at: String,
    pub verification_status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFileSummary {
    present: bool,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeSummary {
    files: u64,
    bytes: u64,
    scan_complete: bool,
}

/// Publish a bounded, path-free JSON diagnostic bundle outside the library.
///
/// Catalogue verification failures are recorded in the bundle, not returned as
/// publication failures. The existing library is never created or migrated.
/// Existing destinations are preserved, and the parent directory must exist.
///
/// # Errors
/// Returns `invalid-arguments` for unsafe destinations, including traversal,
/// library-owned paths and invalid parents; `destination-exists` for collisions;
/// or `diagnostics-failed` if serialization, writing, publication or syncing fails.
/// Resolving a relative destination can also return `storage-unavailable` if the
/// working directory is unavailable. A parent-sync failure can occur after the
/// completed bundle has been published, so callers must not assume no file exists.
pub fn write_library_diagnostics(
    paths: &LibraryPaths,
    destination: &Path,
) -> AppResult<DiagnosticReport> {
    let destination = safe_destination(destination, &paths.root)?;
    if destination.exists() {
        return Err(crate::app_error!("destination-exists"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
    let parent_metadata =
        fs::symlink_metadata(parent).map_err(crate::io_error!("invalid-arguments"))?;
    if !parent_metadata.file_type().is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(crate::app_error!("invalid-arguments"));
    }

    let generated_at = Utc::now().to_rfc3339();
    let verification =
        match LibraryStore::open_read_only(paths.clone()).and_then(|store| store.verify()) {
            Ok(report) => json!({"status":"ok","report":integrity_value(&report)}),
            Err(error) => json!({"status":"failed","errorCode":error.kind()}),
        };
    let verification_status = if verification["status"] == "ok" {
        "ok"
    } else {
        "failed"
    };
    let bundle = json!({
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "application": {
            "name": "takio",
            "version": env!("CARGO_PKG_VERSION"),
            "implementation": "rust",
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH
        },
        "library": {
            "verification": verification,
            "storage": {
                "database": stored_file_summary(&paths.database),
                "jobsDatabase": stored_file_summary(&paths.jobs),
                "managedItems": tree_summary(&paths.items),
                "covers": tree_summary(&paths.covers)
            }
        },
        "capabilities": {
            "tui": true,
            "contentServerLocal": true,
            "contentServerRemoteTls": false,
            "metadataCandidateCovers": true
        },
        "redaction": {
            "paths": "omitted",
            "ebookContents": "omitted",
            "secrets": "omitted"
        }
    });
    let bytes =
        serde_json::to_vec_pretty(&bundle).map_err(|_| crate::app_error!("diagnostics-failed"))?;
    if bytes.is_empty() || bytes.len() > MAX_DIAGNOSTIC_BUNDLE_BYTES {
        return Err(crate::app_error!("diagnostics-failed"));
    }

    let mut temporary = Builder::new()
        .prefix(".takio-diagnostics-")
        .tempfile_in(parent)
        .map_err(crate::io_error!("diagnostics-failed"))?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(crate::io_error!("diagnostics-failed"))?;
    temporary.persist_noclobber(&destination).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            crate::app_error!("destination-exists")
        } else {
            crate::app_error!("diagnostics-failed")
        }
    })?;
    sync_parent(parent)?;

    Ok(DiagnosticReport {
        path: destination,
        bytes: u64::try_from(bytes.len()).map_err(|_| crate::app_error!("diagnostics-failed"))?,
        sha256: hex::encode(Sha256::digest(&bytes)),
        generated_at,
        verification_status,
    })
}

fn safe_destination(destination: &Path, owned_root: &Path) -> AppResult<PathBuf> {
    if destination.as_os_str().is_empty()
        || destination
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let destination = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()?.join(destination)
    };
    if destination == owned_root || destination.starts_with(owned_root) {
        return Err(crate::app_error!("invalid-arguments"));
    }
    if let Some(parent) = destination.parent()
        && let Ok(parent) = parent.canonicalize()
    {
        let owned_root = owned_root
            .canonicalize()
            .unwrap_or_else(|_| owned_root.to_path_buf());
        if parent == owned_root || parent.starts_with(owned_root) {
            return Err(crate::app_error!("invalid-arguments"));
        }
    }
    Ok(destination)
}

fn stored_file_summary(path: &Path) -> StoredFileSummary {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            StoredFileSummary {
                present: true,
                bytes: metadata.len(),
            }
        }
        _ => StoredFileSummary {
            present: false,
            bytes: 0,
        },
    }
}

fn tree_summary(path: &Path) -> TreeSummary {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => TreeSummary {
            files: 0,
            bytes: 0,
            scan_complete: true,
        },
        Err(_) => incomplete_tree(),
        Ok(metadata) if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() => {
            incomplete_tree()
        }
        Ok(_) => {
            let mut summary = TreeSummary {
                files: 0,
                bytes: 0,
                scan_complete: true,
            };
            for entry in WalkDir::new(path).follow_links(false) {
                let Ok(entry) = entry else {
                    summary.scan_complete = false;
                    continue;
                };
                if entry.file_type().is_symlink() {
                    summary.scan_complete = false;
                    continue;
                }
                if !entry.file_type().is_file() {
                    continue;
                }
                if summary.files >= MAX_SCANNED_ENTRIES {
                    summary.scan_complete = false;
                    break;
                }
                match entry.metadata() {
                    Ok(metadata) => {
                        summary.files += 1;
                        summary.bytes = summary.bytes.saturating_add(metadata.len());
                    }
                    Err(_) => summary.scan_complete = false,
                }
            }
            summary
        }
    }
}

fn incomplete_tree() -> TreeSummary {
    TreeSummary {
        files: 0,
        bytes: 0,
        scan_complete: false,
    }
}

/// Stable integrity summary shared by diagnostics and adapter responses.
pub fn integrity_value(report: &VerifyReport) -> Value {
    json!({
        "schemaVersion": report.schema_version,
        "items": {
            "total": report.active_items + report.trashed_items,
            "active": report.active_items,
            "trashed": report.trashed_items
        },
        "formats": {
            "total": report.managed_formats + report.referenced_formats,
            "managed": report.managed_formats,
            "referenced": report.referenced_formats
        }
    })
}

fn sync_parent(parent: &Path) -> AppResult<()> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(crate::io_error!("diagnostics-failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::FormatId;
    use tempfile::tempdir;

    fn paths(root: &Path) -> LibraryPaths {
        LibraryPaths {
            root: root.to_path_buf(),
            database: root.join("library.sqlite"),
            jobs: root.join("jobs.sqlite"),
            items: root.join("items"),
            covers: root.join("covers"),
        }
    }

    #[test]
    fn writes_path_free_bundle_with_exact_public_fingerprint() {
        let workspace = tempdir().unwrap();
        let library_root = workspace.path().join("private-library-name");
        let source = workspace.path().join("secret-title.epub");
        fs::write(&source, b"private ebook bytes bearer-token").unwrap();
        let mut store = LibraryStore::create_or_migrate(paths(&library_root)).unwrap();
        let item = store
            .import(
                &source,
                Some("Secret title"),
                crate::library::model::ImportMode::Copy,
            )
            .unwrap();
        assert_eq!(item.format, FormatId::Epub);
        drop(store);

        let destination = workspace.path().join("support.json");
        let report = write_library_diagnostics(&paths(&library_root), &destination).unwrap();
        let bytes = fs::read(&destination).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(report.bytes, bytes.len() as u64);
        assert_eq!(report.sha256, hex::encode(Sha256::digest(&bytes)));
        assert_eq!(report.verification_status, "ok");
        assert_eq!(value["redaction"]["paths"], "omitted");
        for secret in [
            library_root.to_string_lossy().as_ref(),
            "private-library-name",
            "secret-title.epub",
            "Secret title",
            "private ebook bytes",
            "bearer-token",
        ] {
            assert!(!text.contains(secret));
        }
    }

    #[test]
    fn records_verification_failure_without_creating_or_mutating_library() {
        let workspace = tempdir().unwrap();
        let library_root = workspace.path().join("missing-library");
        let destination = workspace.path().join("support.json");
        let report = write_library_diagnostics(&paths(&library_root), &destination).unwrap();
        let value: Value = serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();

        assert_eq!(report.verification_status, "failed");
        assert_eq!(value["library"]["verification"]["status"], "failed");
        assert!(!library_root.exists());
    }

    #[test]
    fn diagnostics_preserve_current_legacy_and_corrupt_database_bytes() -> AppResult<()> {
        let workspace = tempdir()?;
        for (name, expected_status) in [
            ("current", "ok"),
            ("legacy", "failed"),
            ("corrupt", "failed"),
        ] {
            let root = workspace.path().join(name);
            fs::create_dir(&root)?;
            let library = paths(&root);
            match name {
                "current" => drop(LibraryStore::create_or_migrate(library.clone())?),
                "legacy" => {
                    let connection = rusqlite::Connection::open(&library.database)?;
                    connection.execute_batch(include_str!(
                        "store/migration/reference_schemas/schema-v1.sql"
                    ))?;
                }
                _ => fs::write(&library.database, b"not a SQLite database")?,
            }
            let before = fs::read(&library.database)?;
            let entries = || -> std::io::Result<Vec<PathBuf>> {
                let mut entries = fs::read_dir(&root)?
                    .map(|entry| entry.map(|entry| entry.path()))
                    .collect::<std::io::Result<Vec<_>>>()?;
                entries.sort();
                Ok(entries)
            };
            let before_entries = entries()?;
            let destination = workspace.path().join(format!("{name}.json"));
            let report = write_library_diagnostics(&library, &destination)?;
            assert_eq!(report.verification_status, expected_status, "{name}");
            assert_eq!(fs::read(&library.database)?, before, "{name}");
            assert_eq!(entries()?, before_entries, "{name}");
        }
        Ok(())
    }

    #[test]
    fn rejects_owned_traversal_existing_and_symlinked_destinations() {
        let workspace = tempdir().unwrap();
        let library_root = workspace.path().join("library");
        fs::create_dir_all(&library_root).unwrap();
        let library_paths = paths(&library_root);

        assert_eq!(
            write_library_diagnostics(&library_paths, Path::new("../support.json"))
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        assert_eq!(
            write_library_diagnostics(&library_paths, &library_root.join("support.json"))
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        let destination = workspace.path().join("support.json");
        fs::write(&destination, b"keep").unwrap();
        assert_eq!(
            write_library_diagnostics(&library_paths, &destination)
                .unwrap_err()
                .code(),
            "destination-exists"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"keep");
    }
}
