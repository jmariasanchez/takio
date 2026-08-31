use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

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
                            })))
                        }
                        Err(error) => {
                            entries.push(ScanEntry::Outcome(Box::new(ImportOutcome::Failed {
                                source_path: error
                                    .path()
                                    .map_or_else(|| root.clone(), Path::to_path_buf),
                                code: "unreadable",
                            })))
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
    let mut file = fs::File::open(path).map_err(|error| io_code(&error))?;
    let mut bytes = 0_u64;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| io_code(&error))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        digest.update(&buffer[..read]);
    }
    let after = fs::metadata(path).map_err(|error| io_code(&error))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("source-changed");
    }
    Ok((bytes, hex::encode(digest.finalize())))
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
