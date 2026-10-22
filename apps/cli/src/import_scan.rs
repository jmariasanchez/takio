use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::conversion::{FormatId, detect_format};
use crate::model::LibraryItem;
use crate::output::AppResult;
use crate::store::{ImportWatchObservation, LibraryStore};

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
            ScanEntry::File(source) => {
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

                let (outcome, observed) = if detect_format(&canonical).is_some() {
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
                            Some("duplicate"),
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
                                    Some("imported"),
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
                        Some("unsupported"),
                    )
                };
                if observe && let Some(kind) = observed {
                    store.record_import_watch_observation(ImportWatchObservation {
                        canonical_source_path: canonical,
                        content_bytes: fingerprint.0,
                        content_sha256: fingerprint.1,
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
    File(PathBuf),
    Outcome(Box<ImportOutcome>),
}

impl ScanEntry {
    fn path(&self) -> &Path {
        match self {
            Self::File(path) => path,
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
                            entries.push(ScanEntry::File(entry.into_path()));
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
            Ok(metadata) if metadata.is_file() => entries.push(ScanEntry::File(root.clone())),
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

fn fingerprint(path: &Path) -> Result<(u64, String), &'static str> {
    let before = fs::metadata(path).map_err(|error| io_code(&error))?;
    let (bytes, digest) = crate::fingerprint::hash_file(path).map_err(|error| io_code(&error))?;
    let after = fs::metadata(path).map_err(|error| io_code(&error))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("source-changed");
    }
    Ok((bytes, digest))
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
        LibraryStore::open(paths, true).unwrap()
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
