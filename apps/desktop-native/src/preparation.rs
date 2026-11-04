//! Native preparation bindings. Filesystem and attachment policy live in the engine.
pub use takio::conversion::prepare::{
    PreparationPreview, prepare_with_backend, preview_with_backend,
};

#[cfg(all(test, unix))]
mod tests {
    use crate::engine::{Engine, Request};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use takio::conversion::BackendDiscovery;
    use takio::library::model::ImportMode;
    use takio::library::paths::LibraryPaths;
    use takio::library::store::LibraryStore;

    #[test]
    fn native_worker_previews_then_prepares_only_after_explicit_request() {
        let root = tempfile::tempdir().unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&root.path().join("library/library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
        let source = root.path().join("original.epub");
        fs::write(&source, b"original EPUB fixture").unwrap();
        let item = store.import(&source, None, ImportMode::Copy).unwrap();
        let backend = root.path().join("ebook-convert");
        fs::write(&backend, "#!/bin/sh\nset -eu\nprintf converted > \"$2\"\n").unwrap();
        fs::set_permissions(&backend, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = Engine::open_with_preparation_backend(
            paths.clone(),
            BackendDiscovery {
                available: true,
                path: Some(backend),
                source: "test",
            },
        )
        .unwrap();
        let preview = engine
            .request(|reply| Request::PreviewPrepare {
                item_id: item.id.clone(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(store.get(&item.id).unwrap().unwrap().formats.len(), 1);
        let no_stage = || {
            assert!(fs::read_dir(&paths.root).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".takio-prepare-")
            }))
        };
        no_stage();
        let result = engine
            .request(|reply| Request::PrepareReviewed { preview, reply })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(result.formats.len(), 2);
        assert_eq!(fs::read(&source).unwrap(), b"original EPUB fixture");
        assert_eq!(
            fs::read(&item.formats[0].source_path).unwrap(),
            b"original EPUB fixture"
        );
        no_stage();
    }
}
