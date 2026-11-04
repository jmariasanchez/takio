use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppResult, ErrorCode};
use crate::format::{FormatId, detect_format};
use crate::library::model::{ImportMode, LibraryItem};
use crate::library::paths::validate_import_sources;
use crate::library::store::{ImportWatchObservation, ImportWatchOutcome, LibraryStore};
use crate::metadata::pdf_page_count;

// ponytail: one page threshold, so short papers found in folders are skipped too; choosing a
// file directly always imports it. Make this a setting if real libraries need another cut.
const MIN_FOLDER_PDF_PAGES: usize = 50;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateReason {
    ExistingLibrary,
    EarlierInRequest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    UnsupportedFormat,
    LikelyDocument,
    SymbolicLink,
    UnsupportedFileType,
}

impl std::fmt::Display for SkipReason {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedFormat => "unsupported-format",
            Self::LikelyDocument => "likely-document",
            Self::SymbolicLink => "symbolic-link",
            Self::UnsupportedFileType => "unsupported-file-type",
        })
    }
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
        reason: DuplicateReason,
    },
    Skipped {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        reason: SkipReason,
    },
    Failed {
        #[serde(rename = "sourcePath")]
        source_path: PathBuf,
        code: ErrorCode,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingImport {
    pub(crate) item_id: String,
    pub(crate) format: FormatId,
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
    pub fn from_outcomes(outcomes: &[ImportOutcome]) -> Self {
        let mut counts = Self::default();
        for outcome in outcomes {
            counts.total += 1;
            match outcome {
                ImportOutcome::Imported { .. } => counts.imported += 1,
                ImportOutcome::Duplicate { .. } => counts.duplicates += 1,
                ImportOutcome::Skipped { .. } => counts.skipped += 1,
                ImportOutcome::Failed { .. } => counts.failed += 1,
            }
        }
        counts
    }

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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ImportObservation {
    #[default]
    Untracked,
    Watch,
}

pub fn scan_imports<F>(
    store: &mut LibraryStore,
    roots: &[PathBuf],
    mode: ImportMode,
    observation: ImportObservation,
    mut should_stop: F,
) -> AppResult<ImportScan>
where
    F: FnMut() -> bool,
{
    validate_import_sources(store.paths(), roots)?;
    let observe = observation == ImportObservation::Watch;
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
                        reason: SkipReason::UnsupportedFormat,
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
                            DuplicateReason::EarlierInRequest
                        } else {
                            DuplicateReason::ExistingLibrary
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
                                reason: SkipReason::LikelyDocument,
                            },
                            Some(ImportWatchOutcome::Unsupported),
                        )
                    } else {
                        match store.import(&canonical, None, mode) {
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
                                    code: error.kind(),
                                },
                                None,
                            ),
                        }
                    }
                } else {
                    (
                        ImportOutcome::Skipped {
                            source_path: source,
                            reason: SkipReason::UnsupportedFormat,
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

    let counts = ImportCounts::from_outcomes(&outcomes);
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
                                reason: SkipReason::SymbolicLink,
                            })));
                        }
                        Ok(entry) if entry.file_type().is_file() => {
                            entries.push(ScanEntry::File(entry.into_path(), true));
                        }
                        Ok(entry) => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                                source_path: entry.into_path(),
                                reason: SkipReason::UnsupportedFileType,
                            })));
                        }
                        Err(error) => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Failed {
                                source_path: error
                                    .path()
                                    .map_or_else(|| root.clone(), Path::to_path_buf),
                                code: ErrorCode::Unreadable,
                            })));
                        }
                    }
                }
            }
            Ok(metadata) if metadata.file_type().is_symlink() => {
                entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                    source_path: root.clone(),
                    reason: SkipReason::SymbolicLink,
                })));
            }
            Ok(metadata) if metadata.is_file() => {
                entries.push(ScanEntry::File(root.clone(), false));
            }
            Ok(_) => entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Skipped {
                source_path: root.clone(),
                reason: SkipReason::UnsupportedFileType,
            }))),
            Err(error) => entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Failed {
                source_path: root.clone(),
                code: io_code(&error),
            }))),
        }
    }
    (entries, false)
}

fn fingerprint(path: &Path) -> Result<crate::fingerprint::Fingerprint, ErrorCode> {
    let before = fs::metadata(path).map_err(|error| io_code(&error))?;
    let fingerprint = crate::fingerprint::hash_file(path).map_err(|error| io_code(&error))?;
    let after = fs::metadata(path).map_err(|error| io_code(&error))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(ErrorCode::SourceChanged);
    }
    Ok(fingerprint)
}

pub(super) fn io_code(error: &std::io::Error) -> ErrorCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        ErrorCode::NotFound
    } else {
        ErrorCode::Unreadable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::paths::LibraryPaths;

    #[test]
    fn import_outcome_wire_codes_reasons_and_counts_are_stable() {
        use serde_json::json;
        let source = PathBuf::from("book.epub");
        let mut outcomes = Vec::new();
        for (reason, wire) in [
            (SkipReason::UnsupportedFormat, "unsupported-format"),
            (SkipReason::LikelyDocument, "likely-document"),
            (SkipReason::SymbolicLink, "symbolic-link"),
            (SkipReason::UnsupportedFileType, "unsupported-file-type"),
        ] {
            let outcome = ImportOutcome::Skipped {
                source_path: source.clone(),
                reason,
            };
            assert_eq!(
                serde_json::to_value(&outcome).unwrap(),
                json!({
                    "status":"skipped", "sourcePath":"book.epub", "reason":wire
                })
            );
            assert_eq!(reason.to_string(), wire);
            outcomes.push(outcome);
        }
        for (reason, wire) in [
            (DuplicateReason::ExistingLibrary, "existing-library"),
            (DuplicateReason::EarlierInRequest, "earlier-in-request"),
        ] {
            let outcome = ImportOutcome::Duplicate {
                source_path: source.clone(),
                existing: ExistingImport {
                    item_id: "book-1".into(),
                    format: FormatId::Epub,
                },
                reason,
            };
            assert_eq!(
                serde_json::to_value(&outcome).unwrap(),
                json!({
                    "status":"duplicate", "sourcePath":"book.epub",
                    "existing":{"itemId":"book-1","format":"epub"}, "reason":wire
                })
            );
            outcomes.push(outcome);
        }
        for &code in ErrorCode::ALL {
            let outcome = ImportOutcome::Failed {
                source_path: source.clone(),
                code,
            };
            assert_eq!(
                serde_json::to_value(&outcome).unwrap(),
                json!({
                    "status":"failed", "sourcePath":"book.epub", "code":code.as_str()
                })
            );
            outcomes.push(outcome);
        }
        let counts = ImportCounts::from_outcomes(&outcomes);
        assert_eq!(
            serde_json::to_value(counts).unwrap(),
            json!({
                "total":6 + ErrorCode::ALL.len(), "imported":0, "skipped":4,
                "duplicates":2, "failed":ErrorCode::ALL.len()
            })
        );
    }

    #[test]
    fn readable_import_with_empty_title_is_not_reported_as_unreadable() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = open_store(&temp.path().join("library"));
        let source = temp.path().join(".kepub.epub");
        fs::write(&source, b"readable file with empty filename title").unwrap();
        assert_eq!(
            store
                .import(&source, None, ImportMode::Copy)
                .unwrap_err()
                .kind(),
            ErrorCode::InvalidTitle
        );
        let scan = scan_imports(
            &mut store,
            std::slice::from_ref(&source),
            ImportMode::Copy,
            ImportObservation::Untracked,
            || false,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&scan.outcomes).unwrap(),
            serde_json::json!([
                {"status":"failed", "sourcePath":source, "code":"invalid-title"}
            ])
        );
        assert!(source.exists());
        assert_eq!(scan.counts.failed, 1);
    }

    fn open_store(root: &Path) -> LibraryStore {
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        LibraryStore::create_or_migrate(paths).unwrap()
    }

    #[test]
    fn engine_scan_rejects_owned_paths_in_copy_and_move_modes() {
        for mode in [ImportMode::Copy, ImportMode::Move] {
            let temp = tempfile::tempdir().unwrap();
            let mut store = open_store(temp.path());
            let owned = store.paths().items.join("uncatalogued.epub");
            fs::create_dir_all(owned.parent().unwrap()).unwrap();
            fs::write(&owned, b"preserve owned bytes").unwrap();
            for root in [owned.clone(), store.paths().root.clone()] {
                let error = scan_imports(
                    &mut store,
                    &[root],
                    mode,
                    ImportObservation::Untracked,
                    || false,
                )
                .unwrap_err();
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
            scan_imports(
                &mut store,
                &[alias],
                ImportMode::Move,
                ImportObservation::Untracked,
                || false
            )
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
            scan_imports(
                &mut store,
                &[source],
                ImportMode::Move,
                ImportObservation::Untracked,
                || false
            )
            .unwrap_err()
            .code(),
            "invalid-arguments"
        );
        assert_eq!(fs::read(owned).unwrap(), b"keep");
    }

    #[test]
    fn mixed_scan_preserves_unsupported_sources_in_copy_and_move_modes() {
        for mode in [ImportMode::Copy, ImportMode::Move] {
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
                mode,
                ImportObservation::Untracked,
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
                matches!(&scan.outcomes[1], ImportOutcome::Skipped { source_path, reason: SkipReason::UnsupportedFormat } if source_path == &unsupported)
            );
            assert!(
                matches!(&scan.outcomes[2], ImportOutcome::Failed { source_path, code: ErrorCode::NotFound } if source_path == &missing)
            );
            assert_eq!(fs::read(&unsupported).unwrap(), b"keep these bytes");
            assert_eq!(supported.exists(), mode == ImportMode::Copy);
            if mode == ImportMode::Copy {
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

        let scan = scan_imports(
            &mut store,
            &[folder, chosen],
            ImportMode::Copy,
            ImportObservation::Untracked,
            || false,
        )
        .unwrap();
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
        for mode in [ImportMode::Copy, ImportMode::Move] {
            fs::write(&source, b"first").unwrap();
            let mut store = open_store(temp.path());
            let scan = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Watch,
                || false,
            )
            .unwrap();
            assert_eq!(scan.counts.skipped, 1);
            drop(store);
            let mut store = open_store(temp.path());
            let repeated = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Watch,
                || false,
            )
            .unwrap();
            assert_eq!(repeated.counts.total, 0);
            // Same length: suppression must use content, not just byte count.
            fs::write(&source, b"other").unwrap();
            let changed = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Watch,
                || false,
            )
            .unwrap();
            assert_eq!((changed.counts.total, changed.counts.skipped), (1, 1));
            let repeated = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Watch,
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
        for mode in [ImportMode::Copy, ImportMode::Move] {
            let scan = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Untracked,
                || false,
            )
            .unwrap();
            assert_eq!((scan.counts.skipped, scan.counts.failed), (1, 0));
            let watch = scan_imports(
                &mut store,
                std::slice::from_ref(&source),
                mode,
                ImportObservation::Watch,
                || false,
            )
            .unwrap();
            if denied {
                assert!(matches!(
                    &watch.outcomes[..],
                    [ImportOutcome::Failed {
                        code: ErrorCode::Unreadable,
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
            ImportMode::Move,
            ImportObservation::Untracked,
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
                    ImportMode::Copy,
                    ImportObservation::Untracked,
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
