use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::fingerprint::CopyError;
use crate::output::{AppError, AppResult};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DestinationKind {
    Kindle,
    Kobo,
    Generic,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub kind: DestinationKind,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub features: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRecord {
    pub item_id: String,
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
    pub format: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    #[serde(flatten)]
    pub record: DeliveryRecord,
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryResult {
    pub item_id: String,
    pub destination_id: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Manifest {
    version: u8,
    deliveries: Vec<DeliveryRecord>,
}

pub fn list(root: &Path) -> AppResult<Vec<Destination>> {
    let mut destinations = Vec::new();
    let entries = fs::read_dir(root).map_err(|_| AppError::new("destination-unavailable"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(path) = entry.path().canonicalize() else {
            continue;
        };
        if path == Path::new("/") || !path.is_dir() {
            continue;
        }
        let Ok(children) = fs::read_dir(&path) else {
            continue;
        };
        let names = children
            .flatten()
            .map(|child| child.file_name().to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        let kind = if names.iter().any(|value| value == ".kobo") {
            DestinationKind::Kobo
        } else if names.iter().any(|value| value == "documents")
            && names.iter().any(|value| value == "system")
        {
            DestinationKind::Kindle
        } else {
            DestinationKind::Generic
        };
        let features = if names.iter().any(|value| value == "koreader") {
            vec!["koreader".to_owned()]
        } else {
            Vec::new()
        };
        destinations.push(Destination {
            id: name.clone(),
            name,
            path,
            kind,
            features,
        });
    }
    destinations.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(destinations)
}

pub fn authorize(path: &Path, root: &Path) -> AppResult<Destination> {
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::new("unknown-destination"))?;
    list(root)?
        .into_iter()
        .find(|destination| destination.path == canonical)
        .ok_or_else(|| AppError::new("unknown-destination"))
}

pub fn send(
    destination: &Destination,
    item_id: &str,
    source: &Path,
    file_name: &str,
    format: &str,
    subdir: Option<&Path>,
    overwrite: bool,
) -> AppResult<DeliveryResult> {
    let source = source
        .canonicalize()
        .map_err(|_| AppError::new("source-unavailable"))?;
    if !source.is_file() || item_id.trim().is_empty() {
        return Err(AppError::new("invalid-arguments"));
    }
    let relative_dir = subdir.map_or_else(|| default_subdir(destination.kind), Path::to_path_buf);
    validate_relative(&relative_dir)?;
    let directory = destination.path.join(relative_dir);
    fs::create_dir_all(&directory).map_err(|_| AppError::new("copy-failed"))?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| AppError::new("copy-failed"))?;
    if canonical_directory != destination.path {
        ensure_contained(&destination.path, &canonical_directory)?;
    }

    let safe_name =
        sanitize_file_name(file_name).ok_or_else(|| AppError::new("invalid-arguments"))?;
    let target = canonical_directory.join(safe_name);
    if target.exists() && !overwrite {
        return Err(AppError::new("destination-file-exists"));
    }
    let partial = canonical_directory.join(format!(".takio-partial-{}", Uuid::new_v4()));
    let expected = copy_and_hash(&source, &partial)?;
    let actual = hash_file(&partial)?;
    if actual != expected {
        let _ = fs::remove_file(&partial);
        return Err(AppError::new("verification-failed"));
    }
    if overwrite && target.exists() {
        fs::remove_file(&target).map_err(|_| AppError::new("copy-failed"))?;
    }
    let publication = if overwrite {
        fs::rename(&partial, &target).map_err(publication_error)
    } else {
        publish_noclobber(&partial, &target, &expected)
    };
    if let Err(error) = publication {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    let _ = fs::remove_file(&partial);
    if hash_file(&target)? != expected {
        let _ = fs::remove_file(&target);
        return Err(AppError::new("verification-failed"));
    }

    let relative_path = target
        .strip_prefix(&destination.path)
        .map_err(|_| AppError::new("invalid-arguments"))?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let record = DeliveryRecord {
        item_id: item_id.to_owned(),
        relative_path,
        bytes: expected.0,
        sha256: expected.1.clone(),
        format: format.to_owned(),
        timestamp: Utc::now().to_rfc3339(),
    };
    record_delivery(destination, record)?;
    Ok(DeliveryResult {
        item_id: item_id.to_owned(),
        destination_id: destination.id.clone(),
        path: target,
        bytes: expected.0,
        sha256: expected.1,
    })
}

pub fn inventory(destination: &Destination) -> AppResult<Vec<InventoryEntry>> {
    let manifest = read_manifest(destination)?;
    manifest
        .deliveries
        .into_iter()
        .map(|record| {
            let relative = Path::new(&record.relative_path);
            validate_relative(relative)?;
            let path = destination.path.join(relative);
            ensure_contained(&destination.path, &path)?;
            let status = if !path.exists() {
                "missing"
            } else if hash_file(&path)? == (record.bytes, record.sha256.clone()) {
                "present"
            } else {
                "changed"
            };
            Ok(InventoryEntry { record, status })
        })
        .collect()
}

pub fn remove(destination: &Destination, item_id: &str) -> AppResult<DeliveryRecord> {
    let mut manifest = read_manifest(destination)?;
    let index = manifest
        .deliveries
        .iter()
        .position(|record| record.item_id == item_id)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let record = manifest.deliveries.remove(index);
    let relative = Path::new(&record.relative_path);
    validate_relative(relative)?;
    let path = destination.path.join(relative);
    ensure_contained(&destination.path, &path)?;
    if path.exists() {
        if hash_file(&path)? != (record.bytes, record.sha256.clone()) {
            return Err(AppError::new("verification-failed"));
        }
        fs::remove_file(path).map_err(|_| AppError::new("copy-failed"))?;
    }
    write_manifest(destination, &manifest)?;
    Ok(record)
}

pub fn eject(destination: &Destination) -> AppResult<()> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::new("unsupported-platform"));
    }
    let status = Command::new("diskutil")
        .args(["eject"])
        .arg(&destination.path)
        .status()
        .map_err(|_| AppError::new("eject-failed"))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::new("eject-failed"))
    }
}

fn default_subdir(kind: DestinationKind) -> PathBuf {
    match kind {
        DestinationKind::Kindle => PathBuf::from("documents"),
        DestinationKind::Kobo | DestinationKind::Generic => PathBuf::new(),
    }
}

pub fn destination_file_name(title: &str, author: Option<&str>, extension: &str) -> String {
    let title = sanitize_file_name(title).unwrap_or_else(|| "Untitled".to_owned());
    let stem = author
        .and_then(sanitize_file_name)
        .map_or(title.clone(), |author| format!("{author} - {title}"));
    let mut value = format!("{stem}.{extension}");
    if value.chars().count() > 180 {
        let keep = 179usize.saturating_sub(extension.chars().count());
        let prefix = stem.chars().take(keep).collect::<String>();
        value = format!("{}.{extension}", prefix.trim_end());
    }
    value
}

fn sanitize_file_name(value: &str) -> Option<String> {
    let name = Path::new(value).file_name()?.to_string_lossy();
    let clean = name
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect::<String>();
    (!clean.is_empty() && clean != "." && clean != "..").then_some(clean)
}

fn validate_relative(path: &Path) -> AppResult<()> {
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        Err(AppError::new("invalid-arguments"))
    } else {
        Ok(())
    }
}

fn ensure_contained(parent: &Path, child: &Path) -> AppResult<()> {
    if child.starts_with(parent) && child != parent {
        Ok(())
    } else {
        Err(AppError::new("invalid-arguments"))
    }
}

fn copy_and_hash(source: &Path, target: &Path) -> AppResult<(u64, String)> {
    let mut input = File::open(source).map_err(|_| AppError::new("source-unavailable"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(publication_error)?;
    let result = (|| {
        let fingerprint = crate::fingerprint::copy_and_hash(&mut input, &mut output).map_err(
            |error| match error {
                CopyError::Read(_) => AppError::new("source-unavailable"),
                CopyError::Write(_) => AppError::new("copy-failed"),
            },
        )?;
        output
            .sync_all()
            .map_err(|_| AppError::new("copy-failed"))?;
        Ok(fingerprint)
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(target);
    }
    result
}

fn publication_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AppError::new("destination-file-exists")
    } else {
        AppError::new("copy-failed")
    }
}

fn publish_noclobber(partial: &Path, target: &Path, expected: &(u64, String)) -> AppResult<()> {
    match fs::hard_link(partial, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(publication_error(error))
        }
        Err(_) => publish_exclusive_copy(partial, target, expected),
    }
}

/// FAT readers may not support hard links. Exclusive creation still prevents clobbering,
/// but a crash during this non-atomic fallback can leave an untracked partial target.
/// Only a fully synced and verified copy is reported as a successful delivery.
fn publish_exclusive_copy(
    partial: &Path,
    target: &Path,
    expected: &(u64, String),
) -> AppResult<()> {
    let copied = copy_and_hash(partial, target)?;
    let verification = hash_file(target).and_then(|actual| {
        if copied == *expected && actual == *expected {
            Ok(())
        } else {
            Err(AppError::new("verification-failed"))
        }
    });
    if verification.is_err() {
        let _ = fs::remove_file(target);
    }
    verification
}

fn hash_file(path: &Path) -> AppResult<(u64, String)> {
    crate::fingerprint::hash_file(path).map_err(|_| AppError::new("source-unavailable"))
}

fn manifest_path(destination: &Destination) -> PathBuf {
    destination.path.join(".takio").join("deliveries.json")
}

fn read_manifest(destination: &Destination) -> AppResult<Manifest> {
    let path = manifest_path(destination);
    if !path.exists() {
        return Ok(Manifest {
            version: 1,
            deliveries: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(|_| AppError::new("copy-failed"))?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| AppError::new("copy-failed"))?;
    if manifest.version == 1 {
        Ok(manifest)
    } else {
        Err(AppError::new("copy-failed"))
    }
}

fn record_delivery(destination: &Destination, record: DeliveryRecord) -> AppResult<()> {
    let mut manifest = read_manifest(destination)?;
    manifest
        .deliveries
        .retain(|candidate| candidate.item_id != record.item_id);
    manifest.deliveries.push(record);
    manifest
        .deliveries
        .sort_by(|left, right| left.item_id.cmp(&right.item_id));
    write_manifest(destination, &manifest)
}

fn write_manifest(destination: &Destination, manifest: &Manifest) -> AppResult<()> {
    let path = manifest_path(destination);
    let directory = path.parent().ok_or_else(|| AppError::new("copy-failed"))?;
    fs::create_dir_all(directory).map_err(|_| AppError::new("copy-failed"))?;
    let temporary = directory.join(format!(".deliveries-{}.tmp", Uuid::new_v4()));
    let body = serde_json::to_vec_pretty(manifest).map_err(|_| AppError::new("copy-failed"))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| AppError::new("copy-failed"))?;
    file.write_all(&body)
        .map_err(|_| AppError::new("copy-failed"))?;
    file.sync_all().map_err(|_| AppError::new("copy-failed"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|_| AppError::new("copy-failed"))?;
    }
    fs::rename(&temporary, path).map_err(|_| AppError::new("copy-failed"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_preserves_a_target_created_after_preflight() {
        let temporary = tempfile::tempdir().unwrap();
        let partial = temporary.path().join("verified.partial");
        let target = temporary.path().join("book.azw3");
        fs::write(&partial, b"new book").unwrap();
        let expected = hash_file(&partial).unwrap();
        assert!(!target.exists());
        fs::write(&target, b"other writer's book").unwrap();
        for publish in [publish_noclobber, publish_exclusive_copy] {
            assert_eq!(
                publish(&partial, &target, &expected).unwrap_err().code(),
                "destination-file-exists"
            );
            assert_eq!(fs::read(&target).unwrap(), b"other writer's book");
            assert_eq!(fs::read(&partial).unwrap(), b"new book");
        }
    }

    #[cfg(unix)]
    #[test]
    fn publication_preserves_dangling_and_live_symlinks() {
        let temporary = tempfile::tempdir().unwrap();
        let partial = temporary.path().join("verified.partial");
        let target = temporary.path().join("book.azw3");
        let referent = temporary.path().join("external-book");
        fs::write(&partial, b"new book").unwrap();
        let expected = hash_file(&partial).unwrap();
        std::os::unix::fs::symlink(&referent, &target).unwrap();
        assert!(!target.exists());
        for publish in [publish_noclobber, publish_exclusive_copy] {
            assert_eq!(
                publish(&partial, &target, &expected).unwrap_err().code(),
                "destination-file-exists"
            );
            assert_eq!(fs::read_link(&target).unwrap(), referent);
            assert!(!referent.exists());
        }
        fs::write(&referent, b"external bytes").unwrap();
        for publish in [publish_noclobber, publish_exclusive_copy] {
            assert_eq!(
                publish(&partial, &target, &expected).unwrap_err().code(),
                "destination-file-exists"
            );
            assert_eq!(fs::read_link(&target).unwrap(), referent);
            assert_eq!(fs::read(&referent).unwrap(), b"external bytes");
        }
    }

    #[test]
    fn exclusive_copy_fallback_verifies_bytes_and_cleans_failed_new_output() {
        let temporary = tempfile::tempdir().unwrap();
        let partial = temporary.path().join("verified.partial");
        let target = temporary.path().join("book.azw3");
        fs::write(&partial, b"verified book").unwrap();
        let expected = hash_file(&partial).unwrap();
        publish_exclusive_copy(&partial, &target, &expected).unwrap();
        assert_eq!(hash_file(&target).unwrap(), expected);
        assert_eq!(fs::read(&partial).unwrap(), b"verified book");

        let failed_target = temporary.path().join("failed.azw3");
        let incorrect = (expected.0 + 1, expected.1.clone());
        assert_eq!(
            publish_exclusive_copy(&partial, &failed_target, &incorrect)
                .unwrap_err()
                .code(),
            "verification-failed"
        );
        assert!(!failed_target.exists());
        assert_eq!(hash_file(&target).unwrap(), expected);
        assert!(partial.exists());
    }

    #[test]
    fn destination_names_are_safe_and_bounded() {
        let name = destination_file_name(&"A".repeat(300), Some("Author/Name"), "epub");
        assert!(name.chars().count() <= 180);
        assert!(!name.contains('/'));
        assert!(name.ends_with(".epub"));
    }

    #[test]
    fn parent_paths_are_rejected() {
        assert_eq!(
            validate_relative(Path::new("../outside"))
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
    }

    #[test]
    fn kobo_delivery_can_publish_directly_to_the_authorized_mount_root() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let mount = temporary.path().join("Kobo Reader");
        fs::create_dir(&mount).expect("create mount");
        let mount = mount.canonicalize().expect("canonical mount");
        let source = temporary.path().join("book.epub");
        fs::write(&source, b"epub bytes").expect("write source");
        let destination = Destination {
            id: "Kobo Reader".to_owned(),
            name: "Kobo Reader".to_owned(),
            path: mount.clone(),
            kind: DestinationKind::Kobo,
            features: Vec::new(),
        };

        let result = send(
            &destination,
            "book-1",
            &source,
            "Book.epub",
            "epub",
            None,
            false,
        )
        .expect("deliver to mount root");

        assert_eq!(result.path, mount.join("Book.epub"));
        assert_eq!(
            fs::read(&result.path).expect("read delivered book"),
            b"epub bytes"
        );
        assert_eq!(
            inventory(&destination).expect("inventory")[0].status,
            "present"
        );

        fs::write(&source, b"replacement bytes").unwrap();
        assert_eq!(
            send(
                &destination,
                "book-1",
                &source,
                "Book.epub",
                "epub",
                None,
                false
            )
            .unwrap_err()
            .code(),
            "destination-file-exists"
        );
        assert_eq!(fs::read(&result.path).unwrap(), b"epub bytes");
        send(
            &destination,
            "book-1",
            &source,
            "Book.epub",
            "epub",
            None,
            true,
        )
        .unwrap();
        assert_eq!(fs::read(&result.path).unwrap(), b"replacement bytes");
        assert_eq!(inventory(&destination).unwrap()[0].status, "present");
    }
}
