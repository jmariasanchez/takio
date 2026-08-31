use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::output::{AppError, AppResult};

pub const MAX_COVER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 128;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const TTL_HOURS: i64 = 24;
static STAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug)]
pub struct CapturedCover {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub extension: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateCoverDescriptor {
    pub artifact_id: String,
    pub media_type: String,
    pub extension: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    artifact_id: String,
    item_id: String,
    candidate_id: String,
    source: String,
    provenance: String,
    sha256: String,
    bytes: u64,
    media_type: String,
    extension: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug)]
pub struct ValidatedCover {
    pub descriptor: CandidateCoverDescriptor,
    pub source: PathBuf,
}

pub fn root(library_root: &Path) -> PathBuf {
    library_root.join("candidate-covers")
}

pub fn stage(
    library_root: &Path,
    item_id: &str,
    candidate_id: &str,
    source: &str,
    provenance: &str,
    cover: &CapturedCover,
) -> AppResult<CandidateCoverDescriptor> {
    if cover.bytes.is_empty() || cover.bytes.len() as u64 > MAX_COVER_BYTES {
        return Err(AppError::new("candidate-cover-invalid"));
    }
    validate_cover_type(&cover.media_type, &cover.extension)?;
    let _guard = STAGE_LOCK
        .lock()
        .map_err(|_| AppError::new("storage-unavailable"))?;
    let root = root(library_root);
    fs::create_dir_all(&root).map_err(|_| AppError::new("storage-unavailable"))?;
    reject_symlink(&root)?;
    gc(&root)?;
    let (count, total) = usage(&root)?;
    if count >= MAX_ARTIFACTS || total.saturating_add(cover.bytes.len() as u64) > MAX_TOTAL_BYTES {
        return Err(AppError::new("candidate-cover-unavailable"));
    }
    let artifact_id = Uuid::new_v4().simple().to_string();
    let digest = hex::encode(Sha256::digest(&cover.bytes));
    let descriptor = CandidateCoverDescriptor {
        artifact_id: artifact_id.clone(),
        media_type: cover.media_type.clone(),
        extension: cover.extension.clone(),
        bytes: cover.bytes.len() as u64,
        sha256: digest.clone(),
    };
    let created = Utc::now();
    let manifest = Manifest {
        schema_version: 1,
        artifact_id: artifact_id.clone(),
        item_id: item_id.to_owned(),
        candidate_id: candidate_id.to_owned(),
        source: source.to_owned(),
        provenance: provenance.to_owned(),
        sha256: digest,
        bytes: descriptor.bytes,
        media_type: cover.media_type.clone(),
        extension: cover.extension.clone(),
        created_at: created.to_rfc3339(),
        expires_at: (created + Duration::hours(TTL_HOURS)).to_rfc3339(),
    };
    let data = data_path(&root, &artifact_id);
    let manifest_path = manifest_path(&root, &artifact_id);
    write_new(&data, &cover.bytes)?;
    let encoded =
        serde_json::to_vec(&manifest).map_err(|_| AppError::new("storage-unavailable"))?;
    if let Err(error) = write_new(&manifest_path, &encoded) {
        let _ = fs::remove_file(data);
        return Err(error);
    }
    Ok(descriptor)
}

pub fn validate(
    library_root: &Path,
    item_id: &str,
    candidate_id: &str,
    source: &str,
    provenance: &str,
    descriptor: &CandidateCoverDescriptor,
) -> AppResult<ValidatedCover> {
    validate_descriptor(descriptor)?;
    let root = root(library_root);
    reject_symlink(&root).map_err(|_| AppError::new("candidate-cover-unavailable"))?;
    let manifest_path = manifest_path(&root, &descriptor.artifact_id);
    let data = data_path(&root, &descriptor.artifact_id);
    let manifest_bytes = read_regular(&manifest_path, 64 * 1024)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| AppError::new("candidate-cover-invalid"))?;
    if manifest.schema_version != 1
        || manifest.artifact_id != descriptor.artifact_id
        || manifest.item_id != item_id
        || manifest.candidate_id != candidate_id
        || manifest.source != source
        || manifest.provenance != provenance
        || manifest.sha256 != descriptor.sha256
        || manifest.bytes != descriptor.bytes
        || manifest.media_type != descriptor.media_type
        || manifest.extension != descriptor.extension
    {
        return Err(AppError::new("candidate-cover-invalid"));
    }
    let expires = DateTime::parse_from_rfc3339(&manifest.expires_at)
        .map_err(|_| AppError::new("candidate-cover-invalid"))?;
    if expires <= Utc::now() {
        return Err(AppError::new("candidate-cover-unavailable"));
    }
    let bytes = read_regular(&data, MAX_COVER_BYTES)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if bytes.len() as u64 != descriptor.bytes || digest != descriptor.sha256 {
        return Err(AppError::new("candidate-cover-changed"));
    }
    Ok(ValidatedCover {
        descriptor: descriptor.clone(),
        source: data,
    })
}

pub fn validate_descriptor(descriptor: &CandidateCoverDescriptor) -> AppResult<()> {
    validate_artifact_id(&descriptor.artifact_id)?;
    validate_cover_type(&descriptor.media_type, &descriptor.extension)?;
    if descriptor.bytes == 0
        || descriptor.bytes > MAX_COVER_BYTES
        || descriptor.sha256.len() != 64
        || !descriptor
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(AppError::new("candidate-cover-invalid"));
    }
    Ok(())
}

pub fn consume(library_root: &Path, artifact_id: &str) {
    let root = root(library_root);
    let _ = fs::remove_file(data_path(&root, artifact_id));
    let _ = fs::remove_file(manifest_path(&root, artifact_id));
}

fn gc(root: &Path) -> AppResult<()> {
    if !root.exists() {
        return Ok(());
    }
    reject_symlink(root)?;
    let mut data_files = HashMap::new();
    let mut manifests = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| AppError::new("storage-unavailable"))? {
        let entry = entry.map_err(|_| AppError::new("storage-unavailable"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|_| AppError::new("storage-unavailable"))?;
        if file_type.is_symlink() || !file_type.is_file() {
            let _ = fs::remove_file(path);
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            let _ = fs::remove_file(path);
            continue;
        };
        if validate_artifact_id(id).is_err() {
            let _ = fs::remove_file(path);
            continue;
        }
        match path.extension().and_then(|value| value.to_str()) {
            Some("bin") => {
                let bytes = entry
                    .metadata()
                    .map_err(|_| AppError::new("storage-unavailable"))?
                    .len();
                data_files.insert(id.to_owned(), bytes);
            }
            Some("json") => manifests.push((id.to_owned(), path)),
            _ => {
                let _ = fs::remove_file(path);
            }
        }
    }

    let mut valid_ids = HashSet::new();
    for (id, path) in manifests {
        let manifest = read_regular(&path, 64 * 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok());
        let valid = manifest.is_some_and(|manifest| {
            manifest.schema_version == 1
                && manifest.artifact_id == id
                && validate_cover_type(&manifest.media_type, &manifest.extension).is_ok()
                && manifest.bytes > 0
                && manifest.bytes <= MAX_COVER_BYTES
                && manifest.sha256.len() == 64
                && manifest
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                && DateTime::parse_from_rfc3339(&manifest.expires_at)
                    .is_ok_and(|expiry| expiry > Utc::now())
                && data_files.get(&id) == Some(&manifest.bytes)
        });
        if valid {
            valid_ids.insert(id);
        } else {
            consume(root.parent().unwrap_or(root), &id);
        }
    }
    for id in data_files.keys().filter(|id| !valid_ids.contains(*id)) {
        let _ = fs::remove_file(data_path(root, id));
    }
    Ok(())
}

fn usage(root: &Path) -> AppResult<(usize, u64)> {
    let mut count = 0;
    let mut total = 0u64;
    for entry in fs::read_dir(root).map_err(|_| AppError::new("storage-unavailable"))? {
        let entry = entry.map_err(|_| AppError::new("storage-unavailable"))?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some("bin") {
            let metadata = entry
                .metadata()
                .map_err(|_| AppError::new("storage-unavailable"))?;
            if metadata.is_file() {
                count += 1;
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok((count, total))
}

fn validate_artifact_id(value: &str) -> AppResult<()> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(AppError::new("candidate-cover-invalid"))
    }
}

fn validate_cover_type(media_type: &str, extension: &str) -> AppResult<()> {
    if matches!(
        (media_type, extension),
        ("image/jpeg", ".jpg")
            | ("image/png", ".png")
            | ("image/gif", ".gif")
            | ("image/webp", ".webp")
    ) {
        Ok(())
    } else {
        Err(AppError::new("candidate-cover-invalid"))
    }
}

fn reject_symlink(path: &Path) -> AppResult<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        Err(AppError::new("candidate-cover-invalid"))
    } else {
        Ok(())
    }
}

fn read_regular(path: &Path, max: u64) -> AppResult<Vec<u8>> {
    let metadata = path
        .symlink_metadata()
        .map_err(|_| AppError::new("candidate-cover-unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max {
        return Err(AppError::new("candidate-cover-unavailable"));
    }
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| AppError::new("candidate-cover-unavailable"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::new("candidate-cover-unavailable"))?;
    if bytes.len() as u64 > max {
        return Err(AppError::new("candidate-cover-unavailable"));
    }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    file.write_all(bytes)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    file.sync_all()
        .map_err(|_| AppError::new("storage-unavailable"))
}

fn data_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.bin"))
}
fn manifest_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg() -> CapturedCover {
        CapturedCover {
            bytes: vec![0xff, 0xd8, 0xff, 1, 2, 3],
            media_type: "image/jpeg".to_owned(),
            extension: ".jpg".to_owned(),
        }
    }

    #[test]
    fn staged_cover_is_bound_and_consumable() {
        let temp = tempfile::tempdir().unwrap();
        let descriptor = stage(
            temp.path(),
            "item-a",
            "embedded:1",
            "embedded",
            "proof",
            &jpeg(),
        )
        .unwrap();
        assert!(
            validate(
                temp.path(),
                "item-a",
                "embedded:1",
                "embedded",
                "proof",
                &descriptor
            )
            .is_ok()
        );
        assert_eq!(
            validate(
                temp.path(),
                "item-b",
                "embedded:1",
                "embedded",
                "proof",
                &descriptor
            )
            .unwrap_err()
            .code(),
            "candidate-cover-invalid"
        );
        consume(temp.path(), &descriptor.artifact_id);
        assert_eq!(
            validate(
                temp.path(),
                "item-a",
                "embedded:1",
                "embedded",
                "proof",
                &descriptor
            )
            .unwrap_err()
            .code(),
            "candidate-cover-unavailable"
        );
    }

    #[test]
    fn changed_and_expired_stages_are_rejected_and_gc_removed() {
        let temp = tempfile::tempdir().unwrap();
        let descriptor = stage(
            temp.path(),
            "item-a",
            "online:1",
            "online",
            "proof",
            &jpeg(),
        )
        .unwrap();
        fs::write(
            data_path(&root(temp.path()), &descriptor.artifact_id),
            b"changed",
        )
        .unwrap();
        assert_eq!(
            validate(
                temp.path(),
                "item-a",
                "online:1",
                "online",
                "proof",
                &descriptor
            )
            .unwrap_err()
            .code(),
            "candidate-cover-changed"
        );

        let descriptor = stage(
            temp.path(),
            "item-a",
            "online:2",
            "online",
            "proof",
            &jpeg(),
        )
        .unwrap();
        let path = manifest_path(&root(temp.path()), &descriptor.artifact_id);
        let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest.expires_at = "1970-01-01T00:00:00Z".to_owned();
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            validate(
                temp.path(),
                "item-a",
                "online:2",
                "online",
                "proof",
                &descriptor
            )
            .unwrap_err()
            .code(),
            "candidate-cover-unavailable"
        );
        gc(&root(temp.path())).unwrap();
        assert!(!path.exists());
        assert!(!data_path(&root(temp.path()), &descriptor.artifact_id).exists());
    }

    #[test]
    fn invalid_type_and_oversized_cover_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let mut invalid = jpeg();
        invalid.extension = ".png".to_owned();
        assert_eq!(
            stage(temp.path(), "i", "c", "s", "p", &invalid)
                .unwrap_err()
                .code(),
            "candidate-cover-invalid"
        );
        let oversized = CapturedCover {
            bytes: vec![0; MAX_COVER_BYTES as usize + 1],
            media_type: "image/jpeg".to_owned(),
            extension: ".jpg".to_owned(),
        };
        assert_eq!(
            stage(temp.path(), "i", "c", "s", "p", &oversized)
                .unwrap_err()
                .code(),
            "candidate-cover-invalid"
        );
    }

    #[test]
    fn descriptor_wire_validation_and_gc_reject_forgery_and_orphans() {
        let temp = tempfile::tempdir().unwrap();
        let descriptor = stage(temp.path(), "i", "c", "s", "p", &jpeg()).unwrap();
        assert!(validate_descriptor(&descriptor).is_ok());
        for invalid in [
            CandidateCoverDescriptor {
                artifact_id: "A".repeat(32),
                ..descriptor.clone()
            },
            CandidateCoverDescriptor {
                extension: ".png".to_owned(),
                ..descriptor.clone()
            },
            CandidateCoverDescriptor {
                sha256: "A".repeat(64),
                ..descriptor.clone()
            },
        ] {
            assert_eq!(
                validate_descriptor(&invalid).unwrap_err().code(),
                "candidate-cover-invalid"
            );
        }

        let orphan = "11111111111111111111111111111111";
        fs::write(data_path(&root(temp.path()), orphan), b"orphan").unwrap();
        fs::write(root(temp.path()).join("unexpected.txt"), b"unknown").unwrap();
        let corrupted = stage(temp.path(), "i", "c2", "s", "p", &jpeg()).unwrap();
        fs::write(
            data_path(&root(temp.path()), &corrupted.artifact_id),
            b"wrong length",
        )
        .unwrap();
        gc(&root(temp.path())).unwrap();
        assert!(!data_path(&root(temp.path()), orphan).exists());
        assert!(!root(temp.path()).join("unexpected.txt").exists());
        assert!(!data_path(&root(temp.path()), &corrupted.artifact_id).exists());
        assert!(!manifest_path(&root(temp.path()), &corrupted.artifact_id).exists());
        assert!(data_path(&root(temp.path()), &descriptor.artifact_id).exists());
    }
}
