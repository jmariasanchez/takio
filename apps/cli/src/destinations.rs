use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

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
    let relative_dir = subdir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_subdir(destination.kind));
    validate_relative(&relative_dir)?;
    let directory = destination.path.join(relative_dir);
    fs::create_dir_all(&directory).map_err(|_| AppError::new("copy-failed"))?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| AppError::new("copy-failed"))?;
    ensure_contained(&destination.path, &canonical_directory)?;

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
    if let Err(error) = fs::rename(&partial, &target) {
        let _ = fs::remove_file(&partial);
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new("destination-file-exists")
        } else {
            AppError::new("copy-failed")
        });
    }
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
        .map_err(|_| AppError::new("copy-failed"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| AppError::new("source-unavailable"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| AppError::new("copy-failed"))?;
        hash.update(&buffer[..read]);
        bytes += u64::try_from(read).map_err(|_| AppError::new("copy-failed"))?;
    }
    output
        .sync_all()
        .map_err(|_| AppError::new("copy-failed"))?;
    Ok((bytes, hex::encode(hash.finalize())))
}

fn hash_file(path: &Path) -> AppResult<(u64, String)> {
    let mut input = File::open(path).map_err(|_| AppError::new("source-unavailable"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| AppError::new("source-unavailable"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += u64::try_from(read).map_err(|_| AppError::new("verification-failed"))?;
    }
    Ok((bytes, hex::encode(hash.finalize())))
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
}
