use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::Builder;
use uuid::Uuid;

use crate::conversion::{FormatId, detect_format, discover_ebook_convert};
use crate::output::{AppError, AppResult};

pub const POLISH_OPERATIONS: [&str; 8] = [
    "embed-fonts",
    "subset-fonts",
    "smarten-punctuation",
    "remove-unused-css",
    "compress-images",
    "add-soft-hyphens",
    "remove-soft-hyphens",
    "upgrade-book",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolishArtifact {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolishResult {
    pub backend: &'static str,
    pub input_format: FormatId,
    pub operations: Vec<String>,
    pub artifact: PolishArtifact,
}

#[must_use]
pub fn discover_ebook_polish() -> Option<PathBuf> {
    discover_executable(
        "TAKIO_EBOOK_POLISH",
        "ebook-polish",
        "/Applications/calibre.app/Contents/MacOS/ebook-polish",
    )
}

pub fn polish(
    input: &Path,
    output: &Path,
    operations: &[String],
    timeout: Duration,
) -> AppResult<PolishResult> {
    validate_operations(operations)?;
    if timeout.is_zero() {
        return Err(AppError::new("invalid-arguments"));
    }
    let input = input
        .canonicalize()
        .map_err(|_| AppError::new("source-unavailable"))?;
    if !input.is_file() {
        return Err(AppError::new("source-unavailable"));
    }
    let format = detect_format(&input).ok_or_else(|| AppError::new("unsupported-format"))?;
    if !matches!(format, FormatId::Kepub | FormatId::Epub | FormatId::Azw3) {
        return Err(AppError::new("unsupported-format"));
    }
    if detect_format(output) != Some(format) || output.exists() {
        return Err(AppError::new(if output.exists() {
            "output-file-exists"
        } else {
            "invalid-arguments"
        }));
    }
    let parent = output
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let backend = discover_ebook_polish().ok_or_else(|| AppError::new("backend-unavailable"))?;
    let workspace = Builder::new()
        .prefix("takio-polish-")
        .tempdir()
        .map_err(|_| AppError::new("copy-failed"))?;
    let staged_input = workspace
        .path()
        .join(format!("source.{}", format.extension()));
    let staged_output = workspace
        .path()
        .join(format!("polished.{}", format.extension()));
    fs::copy(&input, &staged_input).map_err(|_| AppError::new("copy-failed"))?;

    let mut command = Command::new(backend);
    for operation in operations {
        command.arg(operation_flag(operation)?);
    }
    command
        .arg(&staged_input)
        .arg(&staged_output)
        .current_dir(workspace.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    run_bounded(&mut command, timeout, "polish-failed")?;
    let (bytes, sha256) = fingerprint(&staged_output)?;
    if bytes == 0 {
        return Err(AppError::new("artifact-invalid"));
    }

    let partial = parent.join(format!(".takio-polish-{}", Uuid::new_v4()));
    let publication = (|| -> AppResult<()> {
        let mut source =
            fs::File::open(&staged_output).map_err(|_| AppError::new("artifact-invalid"))?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|_| AppError::new("copy-failed"))?;
        std::io::copy(&mut source, &mut target).map_err(|_| AppError::new("copy-failed"))?;
        target.flush().map_err(|_| AppError::new("copy-failed"))?;
        fs::hard_link(&partial, output).map_err(|error| {
            if output.exists() {
                AppError::new("output-file-exists")
            } else {
                AppError::from(error)
            }
        })?;
        Ok(())
    })();
    let _ = fs::remove_file(&partial);
    publication?;

    Ok(PolishResult {
        backend: "ebook-polish",
        input_format: format,
        operations: operations.to_vec(),
        artifact: PolishArtifact {
            path: output.to_path_buf(),
            bytes,
            sha256,
        },
    })
}

pub fn extract_text(source: &Path, timeout: Duration) -> AppResult<(FormatId, String)> {
    if timeout.is_zero() {
        return Err(AppError::new("invalid-arguments"));
    }
    let source = source
        .canonicalize()
        .map_err(|_| AppError::new("source-unavailable"))?;
    let format = detect_format(&source).ok_or_else(|| AppError::new("unsupported-format"))?;
    if !matches!(
        format,
        FormatId::Kepub
            | FormatId::Epub
            | FormatId::Pdf
            | FormatId::Mobi
            | FormatId::Azw3
            | FormatId::Docx
            | FormatId::Html
            | FormatId::Txt
    ) {
        return Err(AppError::new("unsupported-format"));
    }
    if format == FormatId::Txt {
        let metadata = source
            .metadata()
            .map_err(|_| AppError::new("source-unavailable"))?;
        if metadata.len() > 64 * 1024 * 1024 {
            return Err(AppError::new("artifact-invalid"));
        }
        return fs::read_to_string(source)
            .map(|text| (format, text))
            .map_err(|_| AppError::new("artifact-invalid"));
    }
    let backend = discover_ebook_convert()
        .path
        .ok_or_else(|| AppError::new("backend-unavailable"))?;
    let workspace = Builder::new()
        .prefix("takio-text-")
        .tempdir()
        .map_err(|_| AppError::new("extraction-failed"))?;
    let output = workspace.path().join("content.txt");
    let mut command = Command::new(backend);
    command
        .arg(&source)
        .arg(&output)
        .arg("--txt-output-formatting=plain")
        .current_dir(workspace.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    run_bounded(&mut command, timeout, "extraction-failed")?;
    let metadata = output
        .metadata()
        .map_err(|_| AppError::new("artifact-invalid"))?;
    if metadata.len() > 64 * 1024 * 1024 {
        return Err(AppError::new("artifact-invalid"));
    }
    fs::read_to_string(output)
        .map(|text| (format, text))
        .map_err(|_| AppError::new("artifact-invalid"))
}

#[must_use]
pub fn find_literal_text(text: &str, query: &str, max_snippets: usize) -> (usize, Vec<String>) {
    if query.is_empty() || max_snippets == 0 {
        return (0, Vec::new());
    }
    let haystack = text.to_ascii_lowercase();
    let needle = query.to_ascii_lowercase();
    let mut offset = 0usize;
    let mut matches = 0usize;
    let mut snippets = Vec::new();
    while let Some(relative) = haystack.get(offset..).and_then(|value| value.find(&needle)) {
        let index = offset + relative;
        matches += 1;
        if snippets.len() < max_snippets {
            let start = text[..index.min(text.len())]
                .char_indices()
                .rev()
                .nth(80)
                .map_or(0, |(position, _)| position);
            let wanted_end = index.saturating_add(query.len()).saturating_add(80);
            let end = text
                .char_indices()
                .find(|(position, _)| *position >= wanted_end)
                .map_or(text.len(), |(position, _)| position);
            snippets.push(
                text[start..end]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        offset = index.saturating_add(needle.len());
        if offset >= haystack.len() {
            break;
        }
    }
    (matches, snippets)
}

fn validate_operations(operations: &[String]) -> AppResult<()> {
    let unique = operations.iter().collect::<BTreeSet<_>>();
    if operations.is_empty()
        || unique.len() != operations.len()
        || operations
            .iter()
            .any(|value| !POLISH_OPERATIONS.contains(&value.as_str()))
        || (operations.iter().any(|value| value == "add-soft-hyphens")
            && operations
                .iter()
                .any(|value| value == "remove-soft-hyphens"))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn operation_flag(operation: &str) -> AppResult<&'static str> {
    match operation {
        "embed-fonts" => Ok("--embed-fonts"),
        "subset-fonts" => Ok("--subset-fonts"),
        "smarten-punctuation" => Ok("--smarten-punctuation"),
        "remove-unused-css" => Ok("--remove-unused-css"),
        "compress-images" => Ok("--compress-images"),
        "add-soft-hyphens" => Ok("--add-soft-hyphens"),
        "remove-soft-hyphens" => Ok("--remove-soft-hyphens"),
        "upgrade-book" => Ok("--upgrade-book"),
        _ => Err(AppError::new("invalid-arguments")),
    }
}

fn run_bounded(command: &mut Command, timeout: Duration, failure: &'static str) -> AppResult<()> {
    let mut child = command
        .spawn()
        .map_err(|_| AppError::new("backend-unavailable"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|_| AppError::new(failure))? {
            return if status.success() {
                Ok(())
            } else {
                Err(AppError::new(failure))
            };
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new("maintenance-timeout"));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn fingerprint(path: &Path) -> AppResult<(u64, String)> {
    let mut file = fs::File::open(path).map_err(|_| AppError::new("artifact-invalid"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    let mut hash = Sha256::new();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AppError::new("artifact-invalid"))?;
        if read == 0 {
            break;
        }
        bytes += u64::try_from(read).map_err(|_| AppError::new("artifact-invalid"))?;
        hash.update(&buffer[..read]);
    }
    Ok((bytes, hex::encode(hash.finalize())))
}

fn discover_executable(env_name: &str, name: &str, macos_path: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(env_name).map(PathBuf::from) {
        return executable(&path).then_some(path);
    }
    if let Some(path) = std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| executable(candidate))
    }) {
        return Some(path);
    }
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from(macos_path);
        if executable(&path) {
            return Some(path);
        }
    }
    let _ = macos_path;
    None
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_duplicate_and_conflicting_operations() {
        assert_eq!(
            validate_operations(&["embed-fonts".to_owned(), "embed-fonts".to_owned()])
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        assert_eq!(
            validate_operations(&[
                "add-soft-hyphens".to_owned(),
                "remove-soft-hyphens".to_owned()
            ])
            .unwrap_err()
            .code(),
            "invalid-arguments"
        );
    }

    #[cfg(unix)]
    #[test]
    fn requires_executable_permissions_for_polish_backend() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let candidate = temp.path().join("ebook-polish");
        std::fs::write(&candidate, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable(&candidate));
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(executable(&candidate));
    }
}
