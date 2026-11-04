use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::format::{FormatId, detect_format};
use crate::metadata::pdf_page_count;
use crate::model::LibraryItem;
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;
use crate::store::{ImportWatchObservation, ImportWatchOutcome, LibraryStore};

// ponytail: one page threshold, so short papers found in folders are skipped too; choosing a
// file directly always imports it. Make this a setting if real libraries need another cut.
const MIN_FOLDER_PDF_PAGES: usize = 50;

/// Reject imports that could consume or recursively scan this library's owned files.
pub fn validate_import_sources(paths: &LibraryPaths, sources: &[PathBuf]) -> AppResult<()> {
    let protected = [&paths.database, &paths.jobs, &paths.items, &paths.covers]
        .into_iter()
        .map(|path| path_for_overlap(path))
        .collect::<AppResult<Vec<_>>>()?;
    for source in sources {
        let source = path_for_overlap(source)?;
        if protected
            .iter()
            .any(|path| import_paths_overlap(&source, path))
        {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    Ok(())
}

fn path_for_overlap(path: &Path) -> AppResult<PathBuf> {
    // `link/..` follows the link's real parent, not its lexical parent.
    if let Ok(resolved) = path.canonicalize() {
        return Ok(resolved);
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::new("invalid-arguments"));
                }
            }
        }
    }
    let mut ancestor = normalized.as_path();
    let mut missing = Vec::new();
    while std::fs::symlink_metadata(ancestor).is_err() {
        let leaf = ancestor
            .file_name()
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        missing.push(leaf.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|_| AppError::new("invalid-arguments"))?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn import_paths_overlap(source: &Path, protected: &Path) -> bool {
    if source.starts_with(protected) || protected.starts_with(source) {
        return true;
    }
    source
        .ancestors()
        .any(|ancestor| same_file::is_same_file(ancestor, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, source).unwrap_or(false))
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ImportOutcome {
    Imported {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        item: Box<LibraryItem>,
    },
    Duplicate {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        existing: ExistingImport,
        reason: &'static str,
    },
    Skipped {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        reason: &'static str,
    },
    Failed {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        code: &'static str,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingImport {
    item_id: String,
    format: FormatId,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct ImportCounts {
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub duplicates: usize,
    pub failed: usize,
}

impl ImportCounts {
    pub fn add(&mut self, other: Self) {
        self.total += other.total;
        self.imported += other.imported;
        self.skipped += other.skipped;
        self.duplicates += other.duplicates;
        self.failed += other.failed;
    }
}

#[derive(Debug, Serialize)]
pub struct ImportScan {
    pub outcomes: Vec<ImportOutcome>,
    pub counts: ImportCounts,
    #[serde(skip)]
    pub stopped: bool,
}

pub fn scan_imports<F>(
    store: &mut LibraryStore,
    roots: &[PathBuf],
    move_source: bool,
    observe: bool,
    mut should_stop: F,
) -> AppResult<ImportScan>
where
    F: FnMut() -> bool,
{
    validate_import_sources(store.paths(), roots)?;
    let mut encountered = HashSet::new();
    let (mut entries, mut stopped) = collect_entries(roots, &mut should_stop);
    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(entry.path().to_path_buf()));

    let mut outcomes = Vec::new();
    for entry in entries {
        if should_stop() {
            stopped = true;
            break;
        }
        match entry {
            ScanEntry::Outcome(outcome) => outcomes.push(*outcome),
            ScanEntry::File(source, in_folder) => {
                let canonical = match source.canonicalize() {
                    Ok(path) => path,
                    Err(error) => {
                        outcomes.push(ImportOutcome::Failed {
                            source_path: source,
                            code: io_code(&error),
                        });
                        continue;
                    }
                };
                if !observe && detect_format(&canonical).is_none() {
                    outcomes.push(ImportOutcome::Skipped {
                        source_path: source,
                        reason: "unsupported-format",
                    });
                    continue;
                }
                let fingerprint = match fingerprint(&canonical) {
                    Ok(value) => value,
                    Err(code) => {
                        outcomes.push(ImportOutcome::Failed {
                            source_path: source,
                            code,
                        });
                        continue;
                    }
                };
                if observe && store.import_watch_accounted(&canonical, &fingerprint)? {
                    continue;
                }

                let format = detect_format(&canonical);
                let (outcome, observed) = if format.is_some() {
                    if let Some((existing, existing_format)) =
                        store.find_managed_duplicate(&canonical)?
                    {
                        let reason = if encountered.contains(&fingerprint) {
                            "earlier-in-request"
                        } else {
                            "existing-library"
                        };
                        encountered.insert(fingerprint.clone());
                        (
                            ImportOutcome::Duplicate {
                                source_path: source,
                                existing: ExistingImport {
                                    item_id: existing.id,
                                    format: existing_format,
                                },
                                reason,
                            },
                            Some(ImportWatchOutcome::Duplicate),
                        )
                    } else if in_folder
                        && format == Some(FormatId::Pdf)
                        && pdf_page_count(&canonical)
                            .is_some_and(|pages| pages < MIN_FOLDER_PDF_PAGES)
                    {
                        (
                            ImportOutcome::Skipped {
                                source_path: source,
                                reason: "likely-document",
                            },
                            Some(ImportWatchOutcome::Unsupported),
                        )
                    } else {
                        match store.import(&canonical, None, move_source) {
                            Ok(item) => {
                                encountered.insert(fingerprint.clone());
                                (
                                    ImportOutcome::Imported {
                                        source_path: source,
                                        item: Box::new(item),
                                    },
                                    Some(ImportWatchOutcome::Imported),
                                )
                            }
                            Err(error) => (
                                ImportOutcome::Failed {
                                    source_path: source,
                                    code: import_failure_code(error.code()),
                                },
                                None,
                            ),
                        }
                    }
                } else {
                    (
                        ImportOutcome::Skipped {
                            source_path: source,
                            reason: "unsupported-format",
                        },
                        Some(ImportWatchOutcome::Unsupported),
                    )
                };
                if observe && let Some(kind) = observed {
                    store.record_import_watch_observation(ImportWatchObservation {
                        canonical_source_path: canonical,
                        fingerprint,
                        outcome: kind,
                    })?;
                }
                outcomes.push(outcome);
            }
        }
    }

    let mut counts = ImportCounts::default();
    for outcome in &outcomes {
        counts.total += 1;
        match outcome {
            ImportOutcome::Imported { .. } => counts.imported += 1,
            ImportOutcome::Duplicate { .. } => counts.duplicates += 1,
            ImportOutcome::Skipped { .. } => counts.skipped += 1,
            ImportOutcome::Failed { .. } => counts.failed += 1,
        }
    }
    Ok(ImportScan {
        outcomes,
        counts,
        stopped,
    })
}

#[derive(Debug)]
enum ScanEntry {
    /// A candidate file, and whether it was found by walking a chosen folder.
    File(PathBuf, bool),
    Outcome(Box<ImportOutcome>),
}

impl ScanEntry {
    fn path(&self) -> &Path {
        match self {
            Self::File(path, _) => path,
            Self::Outcome(outcome) => match outcome.as_ref() {
                ImportOutcome::Imported { source_path, .. }
                | ImportOutcome::Duplicate { source_path, .. }
                | ImportOutcome::Skipped { source_path, .. }
                | ImportOutcome::Failed { source_path, .. } => source_path,
            },
        }
    }
}

fn collect_entries<F>(roots: &[PathBuf], should_stop: &mut F) -> (Vec<ScanEntry>, bool)
where
    F: FnMut() -> bool,
{
    let mut entries = Vec::new();
    for root in roots {
        if should_stop() {
            return (entries, true);
        }
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.is_dir() => {
                for entry in walkdir::WalkDir::new(root)
                    .follow_links(false)
                    .sort_by_file_name()
                {
                    if should_stop() {
                        return (entries, true);
                    }
                    match entry {
                        Ok(entry) if entry.file_type().is_dir() => {}
                        Ok(entry) if entry.file_type().is_symlink() => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                                source_path: entry.into_path(),
                                reason: "symbolic-link",
                            })));
                        }
                        Ok(entry) if entry.file_type().is_file() => {
                            entries.push(ScanEntry::File(entry.into_path(), true));
                        }
                        Ok(entry) => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                                source_path: entry.into_path(),
                                reason: "unsupported-file-type",
                            })));
                        }
                        Err(error) => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Failed {
                                source_path: error
                                    .path()
                                    .map_or_else(|| root.clone(), Path::to_path_buf),
                                code: "unreadable",
                            })));
                        }
                    }
                }
            }
            Ok(metadata) if metadata.file_type().is_symlink() => {
                entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                    source_path: root.clone(),
                    reason: "symbolic-link",
                })));
            }
            Ok(metadata) if metadata.is_file() => {
                entries.push(ScanEntry::File(root.clone(), false));
            }
            Ok(_) => entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                source_path: root.clone(),
                reason: "unsupported-file-type",
            }))),
            Err(error) => entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Failed {
                source_path: root.clone(),
                code: io_code(&error),
            }))),
        }
    }
    (entries, false)
}

fn fingerprint(path: &Path) -> Result<crate::fingerprint::Fingerprint, &'static str> {
    let before = fs::metadata(path).map_err(|error| io_code(&error))?;
    let fingerprint = crate::fingerprint::hash_file(path).map_err(|error| io_code(&error))?;
    let after = fs::metadata(path).map_err(|error| io_code(&error))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("source-changed");
    }
    Ok(fingerprint)
}

fn io_code(error: &std::io::Error) -> &'static str {
    if error.kind() == std::io::ErrorKind::NotFound {
        "not-found"
    } else {
        "unreadable"
    }
}

fn import_failure_code(code: &str) -> &'static str {
    match code {
        "storage-unavailable" => "storage-unavailable",
        "source-changed" => "source-changed",
        _ => "unreadable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::LibraryPaths;

    fn open_store(root: &Path) -> LibraryStore {
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        LibraryStore::create_or_migrate(paths).unwrap()
    }

    #[test]
    fn engine_scan_rejects_owned_paths_in_copy_and_move_modes() {
        for move_source in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let mut store = open_store(temp.path());
            let owned = store.paths().items.join("uncatalogued.epub");
            fs::create_dir_all(owned.parent().unwrap()).unwrap();
            fs::write(&owned, b"preserve owned bytes").unwrap();
            for root in [owned.clone(), store.paths().root.clone()] {
                let error =
                    scan_imports(&mut store, &[root], move_source, false, || false).unwrap_err();
                assert_eq!(error.code(), "invalid-arguments");
                assert_eq!(fs::read(&owned).unwrap(), b"preserve owned bytes");
                assert!(store.list(false).unwrap().is_empty());
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn engine_scan_rejects_symlink_to_owned_path() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(temp.path());
        fs::create_dir_all(&store.paths().items).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&store.paths().items, &alias).unwrap();
        assert_eq!(
            scan_imports(&mut store, &[alias], true, false, || false)
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
    }

    #[test]
    #[cfg(unix)]
    fn engine_scan_rejects_symlink_parent_traversal_into_owned_path() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(&temp.path().join("library"));
        let nested = store.paths().root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&store.paths().items).unwrap();
        let owned = store.paths().items.join("keep.txt");
        fs::write(&owned, b"keep").unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(nested, &alias).unwrap();
        let source = alias
            .join("..")
            .join(store.paths().items.file_name().unwrap())
            .join("keep.txt");
        assert_eq!(
            scan_imports(&mut store, &[source], true, false, || false)
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        assert_eq!(fs::read(owned).unwrap(), b"keep");
    }

    #[test]
    fn mixed_scan_preserves_unsupported_sources_in_copy_and_move_modes() {
        for move_source in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let mut store = open_store(temp.path());
            let supported = temp.path().join("book.epub");
            let unsupported = temp.path().join("notes.bin");
            let missing = temp.path().join("missing.bin");
            fs::write(&supported, b"ebook fixture").unwrap();
            fs::write(&unsupported, b"keep these bytes").unwrap();
            let scan = scan_imports(
                &mut store,
                &[supported.clone(), unsupported.clone(), missing.clone()],
                move_source,
                false,
                || false,
            )
            .unwrap();
            assert!(!scan.stopped);
            assert_eq!(
                (
                    scan.counts.total,
                    scan.counts.imported,
                    scan.counts.skipped,
                    scan.counts.failed,
                    scan.counts.duplicates
                ),
                (3, 1, 1, 1, 0)
            );
            let ImportOutcome::Imported { item, .. } = &scan.outcomes[0] else {
                panic!("expected imported book");
            };
            assert!(store.get(&item.id).unwrap().is_some());
            assert_eq!(
                fs::read(&item.formats[0].source_path).unwrap(),
                b"ebook fixture"
            );
            assert!(
                matches!(&scan.outcomes[1], ImportOutcome::Skipped { source_path, reason: "unsupported-format" } if source_path == &unsupported)
            );
            assert!(
                matches!(&scan.outcomes[2], ImportOutcome::Failed { source_path, code: "not-found" } if source_path == &missing)
            );
            assert_eq!(fs::read(&unsupported).unwrap(), b"keep these bytes");
            assert_eq!(supported.exists(), !move_source);
            if !move_source {
                assert_eq!(fs::read(&supported).unwrap(), b"ebook fixture");
            }
        }
    }

    #[test]
    fn folder_scans_skip_short_pdfs_but_explicit_files_import() {
        use crate::metadata::pdf_fixture;

        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(temp.path());
        let folder = temp.path().join("Downloads");
        fs::create_dir(&folder).unwrap();
        let bill = folder.join("bill.pdf");
        fs::write(&bill, pdf_fixture(2)).unwrap();
        fs::write(folder.join("book.pdf"), pdf_fixture(MIN_FOLDER_PDF_PAGES)).unwrap();
        fs::write(folder.join("unknown.pdf"), b"%PDF-1.7 unreadable").unwrap();
        let chosen = temp.path().join("paper.pdf");
        fs::write(&chosen, pdf_fixture(3)).unwrap();

        let scan = scan_imports(&mut store, &[folder, chosen], false, false, || false).unwrap();
        let outcomes = scan
            .outcomes
            .iter()
            .map(|outcome| match outcome {
                ImportOutcome::Imported { item, .. } => format!("imported {}", item.title),
                ImportOutcome::Skipped { reason, .. } => format!("skipped {reason}"),
                other => format!("{other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes,
            [
                "skipped likely-document",
                "imported book",
                "imported unknown",
                "imported paper"
            ]
        );
        assert_eq!(fs::read(&bill).unwrap(), pdf_fixture(2));
    }

    #[test]
    fn watch_suppresses_unsupported_repeats_but_observes_changed_content() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("notes.bin");
        fs::write(&source, b"first").unwrap();
        for move_source in [false, true] {
            fs::write(&source, b"first").unwrap();
            let mut store = open_store(temp.path());
            let scan = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                true,
                || false,
            )
            .unwrap();
            assert_eq!(scan.counts.skipped, 1);
            drop(store);
            let mut store = open_store(temp.path());
            let repeated = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                true,
                || false,
            )
            .unwrap();
            assert_eq!(repeated.counts.total, 0);
            // Same length: suppression must use content, not just byte count.
            fs::write(&source, b"other").unwrap();
            let changed = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                true,
                || false,
            )
            .unwrap();
            assert_eq!((changed.counts.total, changed.counts.skipped), (1, 1));
            let repeated = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                true,
                || false,
            )
            .unwrap();
            assert_eq!(repeated.counts.total, 0);
            assert_eq!(fs::read(&source).unwrap(), b"other");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_scan_does_not_require_read_permission() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(temp.path());
        let source = temp.path().join("unreadable.bin");
        fs::write(&source, b"preserved").unwrap();
        let permissions = fs::metadata(&source).unwrap().permissions();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o000)).unwrap();
        // Privileged processes may bypass Unix mode bits. Do not assume denial.
        let denied = match fs::File::open(&source) {
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                true
            }
            Ok(_) => false,
        };
        for move_source in [false, true] {
            let scan = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                false,
                || false,
            )
            .unwrap();
            assert_eq!((scan.counts.skipped, scan.counts.failed), (1, 0));
            let watch = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                move_source,
                true,
                || false,
            )
            .unwrap();
            if denied {
                assert!(matches!(
                    &watch.outcomes[..],
                    [ImportOutcome::Failed {
                        code: "unreadable",
                        ..
                    }]
                ));
            }
        }
        fs::set_permissions(&source, permissions).unwrap();
        assert_eq!(fs::read(source).unwrap(), b"preserved");
        eprintln!("Unix read denial exercised: {denied}");
    }

    #[test]
    fn cancellation_before_processing_preserves_unsupported_source() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(temp.path());
        let source = temp.path().join("notes.bin");
        fs::write(&source, b"preserved").unwrap();
        let mut calls = 0;
        let scan = scan_imports(
            &mut store,
            std::slice::from_ref(&source),
            true,
            false,
            || {
                calls += 1;
                calls > 1
            },
        )
        .unwrap();
        assert!(scan.stopped);
        assert_eq!(scan.counts.total, 0);
        assert_eq!(fs::read(source).unwrap(), b"preserved");
    }

    #[test]
    #[ignore = "release microbenchmark using generated temporary files"]
    fn benchmark_unsupported_scan() {
        use std::time::Instant;

        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(temp.path());
        for bytes in [1024, 64 * 1024 * 1024] {
            let source = temp.path().join(format!("unsupported-{bytes}.bin"));
            fs::write(&source, vec![0x5a; bytes]).unwrap();
            let mut timings = Vec::new();
            for _ in 0..21 {
                let start = Instant::now();
                let scan = scan_imports(
                    &mut store,
                    std::slice::from_ref(&source),
                    false,
                    false,
                    || false,
                )
                .unwrap();
                timings.push(start.elapsed());
                assert_eq!((scan.counts.total, scan.counts.skipped), (1, 1));
            }
            timings.remove(0);
            timings.sort();
            eprintln!(
                "unsupported bytes={bytes} samples={} median_us={} min_us={} max_us={}",
                timings.len(),
                timings[timings.len() / 2].as_micros(),
                timings[0].as_micros(),
                timings.last().unwrap().as_micros()
            );
            assert_eq!(fs::metadata(source).unwrap().len(), bytes as u64);
        }
    }
}
