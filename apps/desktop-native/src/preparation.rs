//! Explicit local preparation. Review never creates files or starts a converter.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use takio::conversion::{self, BackendDiscovery, FormatId};
use takio::model::LibraryItem;
use takio::output::{AppError, AppResult};
use takio::store::LibraryStore;

const PREPARATION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
pub struct PreparationPreview {
    pub item_id: String,
    pub title: String,
    pub source_path: PathBuf,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub backend: BackendDiscovery,
}

pub fn preview(store: &LibraryStore, item_id: &str) -> AppResult<PreparationPreview> {
    preview_with_backend(store, item_id, conversion::discover_ebook_convert())
}

pub(crate) fn preview_with_backend(
    store: &LibraryStore,
    item_id: &str,
    backend: BackendDiscovery,
) -> AppResult<PreparationPreview> {
    let item = eligible_item(store, item_id)?;
    let source_path = epub_path(&item)?;
    let (source_bytes, source_sha256) = source_fingerprint(&source_path)?;
    Ok(PreparationPreview {
        item_id: item.id,
        title: item.title,
        source_path,
        source_bytes,
        source_sha256,
        backend,
    })
}

pub fn prepare(store: &mut LibraryStore, reviewed: &PreparationPreview) -> AppResult<LibraryItem> {
    prepare_with_backend(
        store,
        reviewed,
        conversion::discover_ebook_convert(),
        PREPARATION_TIMEOUT,
    )
}

pub(crate) fn prepare_with_backend(
    store: &mut LibraryStore,
    reviewed: &PreparationPreview,
    backend: BackendDiscovery,
    timeout: Duration,
) -> AppResult<LibraryItem> {
    if !reviewed.backend.available || !backend.available {
        return Err(AppError::new("backend-unavailable"));
    }
    let backend_path = backend
        .path
        .as_ref()
        .ok_or_else(|| AppError::new("backend-unavailable"))?;
    if reviewed.backend.path.as_ref() != Some(backend_path)
        || reviewed.backend.source != backend.source
    {
        return Err(AppError::new("prepare-backend-changed"));
    }
    validate_review(store, reviewed)?;

    // Only this operation's private directory is removed, never an imported source.
    let stage = tempfile::Builder::new()
        .prefix(".takio-prepare-")
        .tempdir_in(&store.paths().root)?;
    let input = stage.path().join("source.epub");
    fs::copy(&reviewed.source_path, &input)
        .map_err(|_| AppError::new("prepare-source-unavailable"))?;
    if source_fingerprint(&input)? != (reviewed.source_bytes, reviewed.source_sha256.clone()) {
        return Err(AppError::new("prepare-source-changed"));
    }
    let output = stage.path().join("prepared.azw3");
    let artifact = conversion::convert_with_backend(
        &input,
        &output,
        FormatId::Azw3,
        "kindle",
        timeout,
        backend_path,
    )?;
    let metadata = fs::symlink_metadata(&output).map_err(|_| AppError::new("artifact-invalid"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(AppError::new("artifact-invalid"));
    }
    validate_review(store, reviewed)?;
    store.attach_verified_artifact(
        &reviewed.item_id,
        &output,
        FormatId::Azw3,
        artifact.bytes,
        &artifact.sha256,
    )
}

fn validate_review(store: &LibraryStore, reviewed: &PreparationPreview) -> AppResult<()> {
    let item = eligible_item(store, &reviewed.item_id)?;
    let path = epub_path(&item)?;
    if path != reviewed.source_path
        || source_fingerprint(&path)? != (reviewed.source_bytes, reviewed.source_sha256.clone())
    {
        return Err(AppError::new("prepare-source-changed"));
    }
    Ok(())
}

fn eligible_item(store: &LibraryStore, id: &str) -> AppResult<LibraryItem> {
    let item = store.get(id)?.ok_or_else(|| AppError::new("not-found"))?;
    if store.list_trash()?.iter().any(|item| item.id == id) {
        return Err(AppError::new("item-trashed"));
    }
    if item
        .formats
        .iter()
        .any(|format| format.format == FormatId::Azw3)
    {
        return Err(AppError::new("format-exists"));
    }
    Ok(item)
}

fn epub_path(item: &LibraryItem) -> AppResult<PathBuf> {
    item.formats
        .iter()
        .find(|format| format.format == FormatId::Epub)
        .map(|format| format.source_path.clone())
        .ok_or_else(|| AppError::new("no-epub-source"))
}

fn source_fingerprint(path: &Path) -> AppResult<(u64, String)> {
    if !path.is_file() {
        return Err(AppError::new("prepare-source-unavailable"));
    }
    conversion::fingerprint(path).map_err(|_| AppError::new("prepare-source-unavailable"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::engine::{Engine, Request};
    use std::os::unix::fs::PermissionsExt;
    use takio::paths::LibraryPaths;

    struct Fixture {
        root: tempfile::TempDir,
        store: LibraryStore,
        item: LibraryItem,
        source: PathBuf,
        backend: BackendDiscovery,
    }

    impl Fixture {
        fn new(script: &str) -> Self {
            let root = tempfile::tempdir().unwrap();
            let paths =
                LibraryPaths::resolve(None, Some(&root.path().join("library/library.sqlite")))
                    .unwrap();
            let mut store = LibraryStore::open(paths, true).unwrap();
            let source = root.path().join("original.epub");
            fs::write(&source, b"original EPUB fixture").unwrap();
            let item = store
                .import(&source, Some("Preparation fixture"), false)
                .unwrap();
            let path = root.path().join("ebook-convert");
            fs::write(&path, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let backend = BackendDiscovery {
                available: true,
                path: Some(path),
                source: "test",
            };
            Self {
                root,
                store,
                item,
                source,
                backend,
            }
        }

        fn preview(&self) -> PreparationPreview {
            preview_with_backend(&self.store, &self.item.id, self.backend.clone()).unwrap()
        }

        fn prepare(&mut self, preview: &PreparationPreview) -> AppResult<LibraryItem> {
            prepare_with_backend(
                &mut self.store,
                preview,
                self.backend.clone(),
                Duration::from_secs(2),
            )
        }

        fn assert_originals(&self) {
            assert_eq!(fs::read(&self.source).unwrap(), b"original EPUB fixture");
            assert_eq!(
                fs::read(epub_path(&self.item).unwrap()).unwrap(),
                b"original EPUB fixture"
            );
        }

        fn assert_no_stage(&self) {
            assert!(
                fs::read_dir(&self.store.paths().root)
                    .unwrap()
                    .all(|entry| {
                        !entry
                            .unwrap()
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".takio-prepare-")
                    })
            );
        }
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut result = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                result.extend(snapshot(&path));
            } else {
                result.push((path.clone(), fs::read(path).unwrap()));
            }
        }
        result.sort_by(|a, b| a.0.cmp(&b.0));
        result
    }

    #[test]
    fn preview_and_cancel_leave_all_files_unchanged_and_do_not_run_backend() {
        let f = Fixture::new("exit 99");
        let before = snapshot(f.root.path());
        let review = f.preview();
        assert!(review.backend.available);
        assert_eq!(review.item_id, f.item.id);
        drop(review);
        assert_eq!(snapshot(f.root.path()), before);
        f.assert_no_stage();
    }

    #[test]
    fn missing_backend_is_visible_in_review_and_confirmation_writes_nothing() {
        let mut f = Fixture::new("exit 99");
        f.backend = BackendDiscovery {
            available: false,
            path: None,
            source: "missing",
        };
        let review = f.preview();
        let before = snapshot(f.root.path());
        assert!(!review.backend.available);
        assert_eq!(
            f.prepare(&review).unwrap_err().code(),
            "backend-unavailable"
        );
        assert_eq!(snapshot(f.root.path()), before);
    }

    #[test]
    fn unreadable_missing_and_trashed_sources_cannot_be_reviewed() {
        let mut f = Fixture::new("exit 99");
        let source = epub_path(&f.item).unwrap();
        fs::remove_file(&source).unwrap();
        assert_eq!(
            preview_with_backend(&f.store, &f.item.id, f.backend.clone())
                .unwrap_err()
                .code(),
            "prepare-source-unavailable"
        );
        fs::create_dir(&source).unwrap();
        assert_eq!(
            preview_with_backend(&f.store, &f.item.id, f.backend.clone())
                .unwrap_err()
                .code(),
            "prepare-source-unavailable"
        );
        f.store.trash(&f.item.id).unwrap();
        assert_eq!(
            preview_with_backend(&f.store, &f.item.id, f.backend.clone())
                .unwrap_err()
                .code(),
            "item-trashed"
        );
        assert_eq!(
            preview_with_backend(&f.store, "missing", f.backend.clone())
                .unwrap_err()
                .code(),
            "not-found"
        );
    }

    #[test]
    fn changed_source_backend_and_trashed_item_reject_confirmation_without_stage() {
        let mut f = Fixture::new("exit 99");
        let review = f.preview();
        let mut changed = f.backend.clone();
        changed.path = Some(f.root.path().join("other-backend"));
        assert_eq!(
            prepare_with_backend(&mut f.store, &review, changed, Duration::from_secs(1))
                .unwrap_err()
                .code(),
            "prepare-backend-changed"
        );
        fs::write(&review.source_path, b"changed source").unwrap();
        assert_eq!(
            f.prepare(&review).unwrap_err().code(),
            "prepare-source-changed"
        );
        f.store.trash(&f.item.id).unwrap();
        assert_eq!(f.prepare(&review).unwrap_err().code(), "item-trashed");
        f.assert_no_stage();
    }

    #[test]
    fn books_without_epub_have_no_preparation_route() {
        let mut f = Fixture::new("exit 99");
        let source = f.root.path().join("text-only.txt");
        fs::write(&source, b"plain text").unwrap();
        let item = f.store.import(&source, None, false).unwrap();
        assert_eq!(
            preview_with_backend(&f.store, &item.id, f.backend.clone())
                .unwrap_err()
                .code(),
            "no-epub-source"
        );
        f.assert_no_stage();
    }

    #[test]
    fn disappeared_pinned_backend_fails_without_falling_back_to_another_converter() {
        let mut f = Fixture::new("printf converted > \"$2\"");
        let review = f.preview();
        fs::remove_file(f.backend.path.as_ref().unwrap()).unwrap();
        assert_eq!(
            f.prepare(&review).unwrap_err().code(),
            "backend-unavailable"
        );
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
        f.assert_originals();
        f.assert_no_stage();
    }

    #[test]
    fn successful_preparation_attaches_managed_copy_preserving_originals_and_never_sends() {
        let mut f = Fixture::new(
            "printf 'converted AZW3 fixture' > \"$2\"\nprintf 'backend touched staged input' > \"$1\"",
        );
        let review = f.preview();
        let attached = f.prepare(&review).unwrap();
        assert_eq!(attached.formats.len(), 2);
        let azw3 = attached
            .formats
            .iter()
            .find(|format| format.format == FormatId::Azw3)
            .unwrap();
        assert!(azw3.source_path.starts_with(&f.store.paths().items));
        assert_eq!(
            fs::read(&azw3.source_path).unwrap(),
            b"converted AZW3 fixture"
        );
        f.assert_originals();
        f.assert_no_stage();
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 2);
        assert_eq!(f.prepare(&review).unwrap_err().code(), "format-exists");
        assert!(!f.store.paths().jobs.exists());
        assert!(!f.root.path().join("documents").exists());
        assert!(f.store.verify().is_ok());
    }

    #[test]
    fn existing_azw3_is_never_replaced() {
        let mut f = Fixture::new("exit 99");
        let review = f.preview();
        let existing = f.root.path().join("existing.azw3");
        fs::write(&existing, b"keep existing AZW3").unwrap();
        f.store.attach_format(&f.item.id, &existing, true).unwrap();
        let before = snapshot(f.root.path());
        assert_eq!(f.prepare(&review).unwrap_err().code(), "format-exists");
        assert_eq!(
            preview_with_backend(&f.store, &f.item.id, f.backend.clone())
                .unwrap_err()
                .code(),
            "format-exists"
        );
        assert_eq!(snapshot(f.root.path()), before);
    }

    #[test]
    fn failed_empty_and_symlink_outputs_do_not_attach_and_clean_private_stage() {
        for (script, expected) in [
            ("printf partial > \"$2\"; exit 7", "conversion-failed"),
            (": > \"$2\"", "artifact-invalid"),
            ("ln -s \"$1\" \"$2\"", "artifact-invalid"),
        ] {
            let mut f = Fixture::new(script);
            let review = f.preview();
            assert_eq!(f.prepare(&review).unwrap_err().code(), expected);
            assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
            f.assert_originals();
            f.assert_no_stage();
        }
    }

    #[test]
    fn timeout_kills_converter_and_leaves_originals_without_attachment() {
        let mut f = Fixture::new("while :; do :; done");
        let review = f.preview();
        assert_eq!(
            prepare_with_backend(
                &mut f.store,
                &review,
                f.backend.clone(),
                Duration::from_millis(30)
            )
            .unwrap_err()
            .code(),
            "conversion-timeout"
        );
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
        f.assert_originals();
        f.assert_no_stage();
    }

    #[test]
    fn source_changed_during_conversion_is_rechecked_before_attachment() {
        let mut f = Fixture::new("exit 99");
        let review = f.preview();
        let script = format!(
            "#!/bin/sh\nprintf converted > \"$2\"\nprintf changed > '{}'\n",
            review.source_path.display()
        );
        fs::write(f.backend.path.as_ref().unwrap(), script).unwrap();
        assert_eq!(
            f.prepare(&review).unwrap_err().code(),
            "prepare-source-changed"
        );
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
        assert_eq!(fs::read(&f.source).unwrap(), b"original EPUB fixture");
        f.assert_no_stage();
    }

    #[test]
    fn attachment_collision_keeps_existing_untracked_file_and_originals() {
        let mut f = Fixture::new("printf converted > \"$2\"");
        let review = f.preview();
        let collision = f.store.paths().items.join(&f.item.id).join("book.azw3");
        fs::write(&collision, b"existing unrelated bytes").unwrap();
        assert_eq!(f.prepare(&review).unwrap_err().code(), "destination-exists");
        assert_eq!(fs::read(collision).unwrap(), b"existing unrelated bytes");
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
        f.assert_originals();
        f.assert_no_stage();
    }

    #[test]
    fn native_worker_previews_then_prepares_only_after_explicit_request() {
        let f = Fixture::new("printf converted > \"$2\"");
        let engine =
            Engine::open_with_preparation_backend(f.store.paths().clone(), f.backend.clone())
                .unwrap();
        let preview = engine
            .request(|reply| Request::PreviewPrepare {
                item_id: f.item.id.clone(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(f.store.get(&f.item.id).unwrap().unwrap().formats.len(), 1);
        f.assert_no_stage();
        let result = engine
            .request(|reply| Request::PrepareReviewed { preview, reply })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(result.formats.len(), 2);
        f.assert_originals();
        f.assert_no_stage();
    }
}
