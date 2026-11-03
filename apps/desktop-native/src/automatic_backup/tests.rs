use super::*;
use takio::paths::LibraryPaths;

fn fixture() -> (tempfile::TempDir, LibraryStore, PathBuf, String) {
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let source = temp.path().join("original.txt");
    fs::write(&source, b"automatic recovery bytes").unwrap();
    let book = store
        .import(&source, Some("Preserved book"), false)
        .unwrap();
    let parent = temp.path().join("external-drive");
    fs::create_dir(&parent).unwrap();
    (temp, store, parent, book.id)
}

#[test]
fn disabled_load_is_read_only_and_schedule_clock_is_deterministic() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("absent");
    assert_eq!(load(&root).unwrap(), Config::default());
    assert!(!root.exists());
    let mut schedule = Schedule::default();
    assert!(!schedule.due(u64::MAX));
    schedule.ready = true;
    schedule.config = Config {
        enabled: true,
        destination: Some(temp.path().into()),
        last_success: None,
    };
    assert!(schedule.due(10));
    schedule.last_attempt = Some(10);
    assert!(!schedule.due(9));
    assert!(!schedule.due(10 + FAILURE_RETRY_SECONDS - 1));
    assert!(schedule.due(10 + FAILURE_RETRY_SECONDS));
    schedule.config.last_success = Some(10);
    assert!(!schedule.due(10 + DAILY_SECONDS - 1));
    assert!(schedule.due(10 + DAILY_SECONDS));
    schedule.config.enabled = false;
    assert!(!schedule.due(u64::MAX));
}

#[test]
fn automatic_backup_dialog_pauses_are_nested_and_library_scoped() {
    let mut schedule = Schedule {
        ready: true,
        config: Config {
            enabled: true,
            destination: Some(PathBuf::from("/unused")),
            last_success: None,
        },
        ..Schedule::default()
    };
    let first = schedule.pause();
    let second = schedule.pause();
    assert!(!schedule.due(1));
    drop(first);
    assert!(!schedule.due(1));
    drop(second);
    assert!(schedule.due(1));
    let stale = schedule.pause();
    let config = schedule.config.clone();
    schedule = Schedule {
        ready: true,
        config,
        ..Schedule::default()
    };
    let current = schedule.pause();
    drop(stale);
    assert!(!schedule.due(1));
    drop(current);
    assert!(schedule.due(1));
}

#[test]
fn automatic_copies_restore_bytes_trash_covers_and_keep_every_copy() {
    let (temp, mut store, parent, id) = fixture();
    store.trash(&id).unwrap();
    fs::write(store.paths().covers.join("test-cover.jpg"), b"cover bytes").unwrap();
    fs::write(&store.paths().jobs, b"jobs must not be copied").unwrap();
    let root = store.paths().root.clone();
    let config = configure(&root, Some(parent.clone())).unwrap();
    assert_eq!(load(&root).unwrap(), config);
    let first = run(&store, config.clone(), 100).unwrap();
    let second = run(&store, config, 100).unwrap();
    assert_ne!(
        first.backup.destination_path,
        second.backup.destination_path
    );
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 2);
    assert!(first.settings_error.is_none());
    assert_eq!(load(&root).unwrap().last_success, Some(100));
    assert!(!first.backup.destination_path.join(SETTINGS_NAME).exists());
    assert!(!first.backup.destination_path.join("jobs.sqlite").exists());
    let restored = temp.path().join("restored");
    let report = store
        .restore_backup_copy(&first.backup.destination_path, &restored)
        .unwrap();
    let recovered = LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&report.database_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(recovered.verify().unwrap().trashed_items, 1);
    let book = recovered.get(&id).unwrap().unwrap();
    assert_eq!(
        fs::read(book.source_path).unwrap(),
        b"automatic recovery bytes"
    );
    assert_eq!(
        fs::read(recovered.paths().covers.join("test-cover.jpg")).unwrap(),
        b"cover bytes"
    );
    assert_eq!(
        load(recovered.paths().root.as_path()).unwrap(),
        Config::default()
    );
    assert_eq!(
        fs::read(temp.path().join("original.txt")).unwrap(),
        b"automatic recovery bytes"
    );
    assert!(!configure(&root, None).unwrap().enabled);
    assert!(run(&store, load(&root).unwrap(), 200).is_err());
    assert_eq!(fs::read_dir(parent).unwrap().count(), 2);
    assert!(first.backup.database_path.is_file());
    assert!(second.backup.database_path.is_file());
}

#[test]
fn unavailable_drive_is_never_recreated_and_overlapping_roots_are_rejected() {
    let (temp, store, parent, _) = fixture();
    let root = &store.paths().root;
    let config = configure(root, Some(parent.clone())).unwrap();
    fs::remove_dir(&parent).unwrap();
    assert_eq!(
        run(&store, config, 100).unwrap_err().code(),
        "automatic-backup-destination-unavailable"
    );
    assert!(!parent.exists());
    assert!(configure(root, Some(parent.clone())).is_err());
    assert!(!parent.exists());
    for path in [
        root.clone(),
        store.paths().items.clone(),
        temp.path().to_path_buf(),
    ] {
        assert_eq!(
            configure(root, Some(path)).unwrap_err().code(),
            "automatic-backup-destination-overlap"
        );
    }
    assert!(load(root).unwrap().enabled);
}

#[test]
fn malformed_and_oversized_settings_are_bounded_and_preserved() {
    let (temp, store, parent, _) = fixture();
    let root = &store.paths().root;
    let settings = root.join(SETTINGS_NAME);
    for contents in [
        b"wrong".to_vec(),
        vec![b'x'; MAX_BYTES + 1],
        b"takio-automatic-backup-v1\nenabled\nnever\nrelative".to_vec(),
    ] {
        fs::write(&settings, &contents).unwrap();
        assert!(load(root).is_err());
        assert_eq!(fs::read(&settings).unwrap(), contents);
    }
    let invalid = PathBuf::from(format!("{}/bad\npath", temp.path().display()));
    assert!(configure(root, Some(invalid)).is_err());
    assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
    fs::remove_file(&settings).unwrap();
    let too_long = Config {
        enabled: true,
        destination: Some(PathBuf::from(format!("/{}", "x".repeat(MAX_BYTES)))),
        last_success: None,
    };
    assert!(save(root, &too_long).is_err());
    assert!(!settings.exists());
}

#[cfg(unix)]
#[test]
fn symlink_settings_are_not_overwritten_and_success_survives_save_failure() {
    use std::os::unix::fs::symlink;
    let (temp, store, parent, _) = fixture();
    let root = &store.paths().root;
    let config = configure(root, Some(parent)).unwrap();
    let settings = root.join(SETTINGS_NAME);
    let marker = temp.path().join("untouched");
    fs::write(&marker, b"keep me").unwrap();
    fs::remove_file(&settings).unwrap();
    symlink(&marker, &settings).unwrap();
    assert!(load(root).is_err());
    assert!(configure(root, None).is_err());
    let report = run(&store, config, 42).unwrap();
    assert!(report.settings_error.is_some());
    assert_eq!(report.config.last_success, Some(42));
    assert!(report.backup.database_path.is_file());
    assert_eq!(fs::read(&marker).unwrap(), b"keep me");
    assert_eq!(fs::read_link(&settings).unwrap(), marker);
    store
        .restore_backup_copy(
            &report.backup.destination_path,
            &temp.path().join("restored"),
        )
        .unwrap();
    fs::remove_file(&settings).unwrap();
    let missing = temp.path().join("missing");
    symlink(&missing, &settings).unwrap();
    assert!(configure(root, None).is_err());
    assert!(!missing.exists());
}

#[cfg(unix)]
#[test]
fn destination_symlinks_and_aliased_library_descendants_are_rejected() {
    use std::os::unix::fs::symlink;
    let (temp, store, parent, _) = fixture();
    let alias = temp.path().join("alias");
    symlink(&parent, &alias).unwrap();
    assert!(configure(&store.paths().root, Some(alias)).is_err());
    let library_alias = temp.path().join("library-alias");
    symlink(&store.paths().root, &library_alias).unwrap();
    let child = library_alias.join("items");
    assert!(configure(&store.paths().root, Some(child)).is_err());
    assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
}
