//! Library export planning and collision-safe file publication.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::error::AppResult;
use crate::format::FormatId;
use crate::library::model::LibraryItem;
use crate::library::store::LibraryStore;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileNameTemplate {
    Title,
    #[default]
    AuthorTitle,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryTemplate {
    #[default]
    Flat,
    Author,
    Series,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub ids: Vec<String>,
    pub destination_path: PathBuf,
    #[serde(default)]
    pub file_name_template: FileNameTemplate,
    #[serde(default)]
    pub directory_template: DirectoryTemplate,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<FormatId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<crate::library::model::Provenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_path: Option<PathBuf>,
    #[serde(flatten)]
    pub status: ExportStatus,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ExportStatus {
    Exported {
        bytes: u64,
        sha256: String,
        metadata: &'static str,
    },
    Skipped {
        reason: &'static str,
    },
    Failed {
        code: &'static str,
    },
}

#[derive(Default, Serialize)]
pub struct ExportCounts {
    pub total: usize,
    pub exported: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Serialize)]
pub struct ExportReport {
    pub outcomes: Vec<ExportOutcome>,
    pub counts: ExportCounts,
}

pub fn export_many(store: &LibraryStore, request: ExportRequest) -> AppResult<ExportReport> {
    if request.ids.is_empty()
        || request.ids.len() > 256
        || request.ids.iter().any(|id| id.trim().is_empty())
        || request.ids.iter().collect::<BTreeSet<_>>().len() != request.ids.len()
        || request.destination_path.as_os_str().is_empty()
        || request.destination_path.to_string_lossy().trim().is_empty()
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    std::fs::create_dir_all(&request.destination_path)
        .map_err(|_| crate::app_error!("destination-unavailable"))?;
    let destination = request
        .destination_path
        .canonicalize()
        .map_err(|_| crate::app_error!("destination-unavailable"))?;
    if !destination.is_dir() {
        return Err(crate::app_error!("destination-unavailable"));
    }
    let mut outcomes = Vec::new();
    for id in request.ids {
        let item = store.get(&id)?;
        let missing_code = match &item {
            None => Some("not-found"),
            Some(item) if item.formats.is_empty() => Some("source-unavailable"),
            _ => None,
        };
        if let Some(code) = missing_code {
            outcomes.push(ExportOutcome {
                item_id: id,
                format: None,
                provenance: None,
                destination_path: None,
                status: ExportStatus::Failed { code },
            });
            continue;
        }
        let item = item.expect("missing items handled above");
        let author = match request.file_name_template {
            FileNameTemplate::AuthorTitle => item.primary_author(),
            FileNameTemplate::Title => None,
        };
        let relative = relative_directory(request.directory_template, &item);
        for format in &item.formats {
            let name = file_name(&item.title, author, &item.id, format.format.extension());
            let requested = relative
                .as_ref()
                .map_or_else(|| destination.clone(), |segment| destination.join(segment))
                .join(&name);
            let (target, status) = match prepare_directory(&destination, relative.as_deref()) {
                Ok(directory) => {
                    let target = directory.join(name);
                    let status = copy_file(&format.source_path, &target);
                    (target, status)
                }
                Err(_) => (
                    requested,
                    ExportStatus::Failed {
                        code: "destination-unavailable",
                    },
                ),
            };
            outcomes.push(ExportOutcome {
                item_id: id.clone(),
                format: Some(format.format),
                provenance: Some(format.provenance),
                destination_path: Some(target),
                status,
            });
        }
    }
    let mut counts = ExportCounts {
        total: outcomes.len(),
        ..Default::default()
    };
    for outcome in &outcomes {
        match outcome.status {
            ExportStatus::Exported { .. } => counts.exported += 1,
            ExportStatus::Skipped { .. } => counts.skipped += 1,
            ExportStatus::Failed { .. } => counts.failed += 1,
        }
    }
    Ok(ExportReport { outcomes, counts })
}

fn relative_directory(template: DirectoryTemplate, item: &LibraryItem) -> Option<String> {
    match template {
        DirectoryTemplate::Author => Some(path_segment(
            item.primary_author().unwrap_or("Unknown author"),
            "Unknown author",
        )),
        DirectoryTemplate::Series => Some(path_segment(
            item.series.as_deref().unwrap_or("Unsorted"),
            "Unsorted",
        )),
        DirectoryTemplate::Flat => None,
    }
}

fn path_segment(value: &str, fallback: &str) -> String {
    let clean = value
        .nfc()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect::<String>();
    let clean = clean.trim().trim_end_matches(['.', ' ']);
    let clean = if clean.is_empty() || matches!(clean, "." | "..") {
        fallback
    } else {
        clean
    };
    let clean = truncate_utf8_bytes(clean, 128);
    let clean = clean.trim_end_matches(['.', ' ']);
    if clean.is_empty() {
        fallback.to_owned()
    } else {
        clean.to_owned()
    }
}

fn file_name(title: &str, author: Option<&str>, item_id: &str, extension: &str) -> String {
    let base = crate::delivery::destinations::destination_file_name(title, author, extension);
    let stem = base.strip_suffix(&format!(".{extension}")).unwrap_or(&base);
    let identity = format!("{:x}", Sha256::digest(item_id.as_bytes()));
    let suffix = format!(" [{identity}].{extension}");
    let stem = truncate_utf8_bytes(
        &stem.nfc().collect::<String>(),
        240usize.saturating_sub(suffix.len()),
    );
    format!("{}{}", stem.trim_end_matches(['.', ' ']), suffix)
}

fn truncate_utf8_bytes(value: &str, maximum_bytes: usize) -> String {
    let end = value
        .char_indices()
        .map(|(index, character)| index + character.len_utf8())
        .take_while(|end| *end <= maximum_bytes)
        .last()
        .unwrap_or(0);
    value[..end].to_owned()
}

fn prepare_directory(destination: &Path, segment: Option<&str>) -> AppResult<PathBuf> {
    let Some(segment) = segment else {
        return Ok(destination.to_path_buf());
    };
    let directory = destination.join(segment);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(crate::app_error!("destination-unavailable"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&directory)
                .map_err(|_| crate::app_error!("destination-unavailable"))?
        }
        Err(_) => return Err(crate::app_error!("destination-unavailable")),
    }
    let canonical = directory
        .canonicalize()
        .map_err(|_| crate::app_error!("destination-unavailable"))?;
    if canonical == destination || !canonical.starts_with(destination) {
        return Err(crate::app_error!("destination-unavailable"));
    }
    Ok(canonical)
}

fn copy_file(source: &Path, target: &Path) -> ExportStatus {
    let skipped = || ExportStatus::Skipped {
        reason: "destination-exists",
    };
    let failed = |code| ExportStatus::Failed { code };
    if std::fs::symlink_metadata(target).is_ok() {
        return skipped();
    }
    let source = match source.canonicalize() {
        Ok(source) => source,
        Err(_) => return failed("source-unavailable"),
    };
    let mut input = match std::fs::File::open(&source) {
        Ok(input) => input,
        Err(_) => return failed("source-unavailable"),
    };
    let before = match input.metadata() {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => metadata,
        _ => return failed("source-unavailable"),
    };
    let partial = target.with_file_name(format!(".takio-export-{}.partial", uuid::Uuid::new_v4()));
    let mut output = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
    {
        Ok(output) => output,
        Err(_) => return failed("destination-unavailable"),
    };
    let result = (|| -> Result<crate::fingerprint::Fingerprint, &'static str> {
        let fingerprint = crate::fingerprint::copy_and_hash(&mut input, &mut output).map_err(
            |error| match error {
                crate::fingerprint::CopyError::Read(_) => "source-unavailable",
                crate::fingerprint::CopyError::Write(_) => "destination-unavailable",
            },
        )?;
        let after = input.metadata().map_err(|_| "source-changed")?;
        if fingerprint.bytes != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err("source-changed");
        }
        output.sync_all().map_err(|_| "destination-unavailable")?;
        drop(output);
        if crate::fingerprint::hash_file(&partial).map_err(|_| "destination-unavailable")?
            != fingerprint
        {
            return Err("destination-unavailable");
        }
        match std::fs::hard_link(&partial, target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("destination-exists");
            }
            Err(_) => return Err("destination-unavailable"),
        }
        if crate::fingerprint::hash_file(target).map_err(|_| "destination-unavailable")?
            != fingerprint
        {
            let _ = std::fs::remove_file(target);
            return Err("destination-unavailable");
        }
        Ok(fingerprint)
    })();
    let _ = std::fs::remove_file(&partial);
    match result {
        Ok(fingerprint) => ExportStatus::Exported {
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
            metadata: "unsupported",
        },
        Err("destination-exists") => skipped(),
        Err(code) => failed(code),
    }
}
