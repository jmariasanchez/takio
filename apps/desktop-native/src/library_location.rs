//! Strict activation of an existing library, never creation or recovery rebasing.

use std::path::{Path, PathBuf};

use takio::model::LibraryItem;
use takio::output::{AppError, AppResult};
use takio::paths::LibraryPaths;
use takio::store::LibraryStore;

#[derive(Clone, Debug)]
pub struct OpenedLibrary {
    pub root: PathBuf,
    pub items: Vec<LibraryItem>,
    pub remember_failed: bool,
}

pub fn open(directory: &Path) -> AppResult<(LibraryStore, OpenedLibrary)> {
    let root = directory.canonicalize()?;
    if !root.is_dir() {
        return Err(AppError::new("storage-unavailable"));
    }
    // Even a malformed or dangling manifest identifies a backup, not a live root.
    match std::fs::symlink_metadata(root.join("manifest.json")) {
        Ok(_) => return Err(AppError::new("library-is-backup")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite")))?;
    let store = LibraryStore::open_existing(paths)?;
    let items = store.list(false)?;
    Ok((
        store,
        OpenedLibrary {
            root,
            items,
            remember_failed: false,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, Filters, Request};
    use std::fs;

    fn fixture() -> (tempfile::TempDir, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let source = root.join("source.epub");
        fs::write(&source, b"fixture book").unwrap();
        let item = store.import(&source, Some("Original"), false).unwrap();
        (temp, root, item.id)
    }

    fn switch(engine: &Engine, directory: &Path) -> AppResult<OpenedLibrary> {
        engine
            .request(|reply| Request::OpenLibrary {
                directory: directory.to_path_buf(),
                remember: None,
                reply,
            })
            .recv()
            .unwrap()
    }

    fn query(engine: &Engine) -> Vec<LibraryItem> {
        engine
            .request(|reply| Request::Query {
                query: String::new(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap()
    }

    #[test]
    fn switching_a_b_a_targets_mutations_and_returns_canonical_snapshot() {
        let (_a, a, a_id) = fixture();
        let (_b, b, b_id) = fixture();
        let engine = Engine::open_existing(a.clone()).unwrap();
        assert_eq!(engine.root(), a);
        assert_eq!(query(&engine)[0].id, a_id);
        let opened = switch(&engine, &b).unwrap();
        assert_eq!(opened.root, b);
        assert_eq!(opened.items[0].id, b_id);
        assert!(!opened.remember_failed);
        engine
            .request(|reply| Request::Trash {
                ids: vec![b_id.clone()],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert!(query(&engine).is_empty());
        let opened = switch(&engine, &a).unwrap();
        assert_eq!(opened.items[0].id, a_id);
        engine
            .request(|reply| Request::Trash {
                ids: vec![a_id.clone()],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let b_store = open(&b).unwrap().0;
        assert_eq!(b_store.list_trash().unwrap()[0].id, b_id);
        assert!(b_store.get(&a_id).unwrap().is_none());
        let a_store = open(&a).unwrap().0;
        assert_eq!(a_store.list_trash().unwrap()[0].id, a_id);
        assert!(a_store.get(&b_id).unwrap().is_none());
        assert_eq!(engine.root(), a);
    }

    #[test]
    fn invalid_missing_legacy_future_and_malformed_candidates_preserve_active_store() {
        let (_a, a, id) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let empty = tempfile::tempdir().unwrap();
        assert!(switch(&engine, empty.path()).is_err());
        assert!(switch(&engine, &empty.path().join("missing")).is_err());
        assert!(fs::read_dir(empty.path()).unwrap().next().is_none());
        for version in [0_u32, 1, 999] {
            let (_candidate, root, _) = fixture();
            let database = root.join("library.sqlite");
            let mut bytes = fs::read(&database).unwrap();
            bytes[60..64].copy_from_slice(&version.to_be_bytes());
            fs::write(&database, &bytes).unwrap();
            assert_eq!(
                switch(&engine, &root).unwrap_err().code(),
                "incompatible-schema"
            );
            assert_eq!(fs::read(&database).unwrap(), bytes);
            assert!(!root.join("backups").exists());
            assert_eq!(query(&engine)[0].id, id);
        }
        let database = empty.path().join("library.sqlite");
        fs::write(&database, b"not a database").unwrap();
        assert!(switch(&engine, empty.path()).is_err());
        assert_eq!(fs::read(database).unwrap(), b"not a database");
        engine
            .request(|reply| Request::Trash {
                ids: vec![id.clone()],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(
            engine
                .request(|reply| Request::ListTrash { reply })
                .recv()
                .unwrap()
                .unwrap()[0]
                .id,
            id
        );
    }

    #[test]
    fn pristine_backup_is_refused_but_restored_library_is_accepted() {
        let (_a, a, _) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("backup");
        engine
            .request(|reply| Request::Backup {
                destination: backup.clone(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let before = fs::read(backup.join("library.sqlite")).unwrap();
        assert_eq!(
            switch(&engine, &backup).unwrap_err().code(),
            "library-is-backup"
        );
        assert_eq!(fs::read(backup.join("library.sqlite")).unwrap(), before);
        let restored = temp.path().canonicalize().unwrap().join("restored");
        engine
            .request(|reply| Request::RestoreBackupCopy {
                source: backup,
                destination: restored.clone(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(switch(&engine, &restored).unwrap().items.len(), 1);
    }

    #[test]
    fn malformed_trash_is_rejected_before_replacing_active_store() {
        let (_a, a, id) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let (_b, b, b_id) = fixture();
        let (mut store, _) = open(&b).unwrap();
        store.trash(&b_id).unwrap();
        drop(store);
        let database = b.join("library.sqlite");
        let mut bytes = fs::read(&database).unwrap();
        let marker = b"Original";
        let offset = bytes
            .windows(marker.len())
            .position(|entry| entry == marker)
            .unwrap();
        bytes[offset] = 0xff;
        fs::write(&database, &bytes).unwrap();
        assert!(switch(&engine, &b).is_err());
        assert_eq!(query(&engine)[0].id, id);
        assert_eq!(fs::read(database).unwrap(), bytes);
    }

    #[test]
    fn missing_managed_bytes_do_not_prevent_catalogue_management() {
        let (_temp, root, id) = fixture();
        let (store, snapshot) = open(&root).unwrap();
        fs::remove_file(&snapshot.items[0].source_path).unwrap();
        drop(store);
        let engine = Engine::open_existing(root).unwrap();
        engine
            .request(|reply| Request::Trash {
                ids: vec![id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert!(query(&engine).is_empty());
    }

    #[test]
    fn failed_remember_still_activates_for_this_session() {
        let (_a, a, _) = fixture();
        let (_b, b, id) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let result = engine
            .request(|reply| Request::OpenLibrary {
                directory: b.clone(),
                remember: Some(b.clone()),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert!(result.remember_failed);
        assert_eq!(query(&engine)[0].id, id);
    }

    #[test]
    fn invalid_candidate_does_not_change_remembered_location() {
        let (_a, a, id) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("preference");
        fs::write(&preference, b"existing preference").unwrap();
        let result = engine
            .request(|reply| Request::OpenLibrary {
                directory: temp.path().join("missing"),
                remember: Some(preference.clone()),
                reply,
            })
            .recv()
            .unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read(preference).unwrap(), b"existing preference");
        assert_eq!(query(&engine)[0].id, id);
    }

    #[cfg(unix)]
    #[test]
    fn original_alias_root_switches_back_without_rebasing_or_attachment_reads() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().canonicalize().unwrap().join("real");
        fs::create_dir(&real).unwrap();
        let alias = temp.path().join("alias");
        symlink(&real, &alias).unwrap();
        let paths = LibraryPaths::resolve(None, Some(&alias.join("library.sqlite"))).unwrap();
        let engine = Engine::open(paths).unwrap();
        assert_eq!(engine.root(), real);
        let source = temp.path().join("source.epub");
        fs::write(&source, b"alias-origin book").unwrap();
        engine
            .request(|reply| Request::Import {
                roots: vec![source],
                mode: crate::engine::ImportMode::Copy,
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let item = query(&engine).remove(0);
        assert!(item.source_path.starts_with(alias.join("items")));
        fs::remove_file(&item.source_path).unwrap();
        let before = fs::read(real.join("library.sqlite")).unwrap();
        let (_b, b, _) = fixture();
        switch(&engine, &b).unwrap();
        let reopened = switch(&engine, &real).unwrap();
        assert_eq!(reopened.items[0].id, item.id);
        assert_eq!(reopened.items[0].source_path, item.source_path);
        assert_eq!(fs::read(real.join("library.sqlite")).unwrap(), before);
        assert_eq!(switch(&engine, &alias).unwrap().root, real);
        fs::write(&item.source_path, b"alias-origin book").unwrap();
        engine
            .request(|reply| Request::Backup {
                destination: temp.path().join("backup"),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        engine
            .request(|reply| Request::Trash {
                ids: vec![item.id.clone()],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        engine
            .request(|reply| Request::Purge {
                ids: vec![item.id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert!(!item.source_path.exists());
        assert!(query(&engine).is_empty());
        assert_eq!(open(&b).unwrap().1.items.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn mixed_recorded_ownership_roots_are_rejected_without_replacing_a() {
        use std::os::unix::fs::symlink;
        let (_a, a, a_id) = fixture();
        let engine = Engine::open_existing(a).unwrap();
        let (_b, b, _) = fixture();
        let temp = tempfile::tempdir().unwrap();
        let alias = temp.path().join("alias");
        symlink(&b, &alias).unwrap();
        let paths = LibraryPaths::resolve(None, Some(&alias.join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, false).unwrap();
        let source = temp.path().join("second.epub");
        fs::write(&source, b"different book").unwrap();
        store.import(&source, None, false).unwrap();
        drop(store);
        let before = fs::read(b.join("library.sqlite")).unwrap();
        assert_eq!(switch(&engine, &b).unwrap_err().code(), "integrity-failed");
        assert_eq!(query(&engine)[0].id, a_id);
        assert_eq!(fs::read(b.join("library.sqlite")).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn directory_alias_is_accepted_but_database_alias_and_special_entry_are_not() {
        use std::os::unix::fs::symlink;
        let (_temp, root, id) = fixture();
        let aliases = tempfile::tempdir().unwrap();
        let alias = aliases.path().join("alias");
        symlink(&root, &alias).unwrap();
        let engine = Engine::open_existing(alias.clone()).unwrap();
        assert_eq!(engine.root(), root);
        let opened = switch(&engine, &alias).unwrap();
        assert_eq!(opened.root, root);
        assert_eq!(opened.items[0].id, id);
        let database = aliases.path().join("library.sqlite");
        symlink(root.join("library.sqlite"), &database).unwrap();
        assert!(switch(&engine, aliases.path()).is_err());
        fs::remove_file(&database).unwrap();
        fs::create_dir(&database).unwrap();
        assert!(switch(&engine, aliases.path()).is_err());
        fs::remove_dir(&database).unwrap();
        let socket = std::os::unix::net::UnixListener::bind(&database).unwrap();
        assert!(switch(&engine, aliases.path()).is_err());
        drop(socket);
        assert_eq!(query(&engine)[0].id, id);
        symlink(root.join("absent"), root.join("manifest.json")).unwrap();
        assert_eq!(
            switch(&engine, &root).unwrap_err().code(),
            "library-is-backup"
        );
    }
}
