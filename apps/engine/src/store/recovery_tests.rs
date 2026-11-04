use super::*;
use serde_json::Value;

fn fixture() -> (tempfile::TempDir, LibraryStore, String) {
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("original.epub");
    fs::write(&source, b"recovery test ebook").unwrap();
    let item = store.import(&source, Some("Recovery"), false).unwrap();
    (temp, store, item.id)
}

fn backup_fixture() -> (tempfile::TempDir, LibraryStore, PathBuf) {
    let (temp, store, _) = fixture();
    let backup = temp.path().join("backup");
    store.backup(&backup).unwrap();
    (temp, store, backup)
}

#[test]
fn recovery_roundtrip_relocates_managed_and_covers_preserves_trash_and_references() {
    let (temp, mut store, id) = fixture();
    let cover = store.paths.covers.join("cover.jpg");
    fs::write(&cover, b"cover bytes").unwrap();
    store
        .connection
        .execute(
            "UPDATE library_items SET cover_path=?1 WHERE id=?2",
            params![cover.to_string_lossy(), id],
        )
        .unwrap();
    store.trash(&id).unwrap();
    let referenced = temp.path().join("external.pdf");
    fs::write(&referenced, b"reference bytes").unwrap();
    let external = store.import(&referenced, Some("External"), false).unwrap();
    store.connection.execute("UPDATE library_item_formats SET provenance='referenced',source_path=?1,content_bytes=NULL,content_sha256=NULL WHERE library_item_id=?2", params![referenced.to_string_lossy(), external.id]).unwrap();
    fs::write(&store.paths.jobs, b"not part of snapshot").unwrap();
    let backup = temp.path().join("backup");
    store.backup(&backup).unwrap();
    assert!(!backup.join("jobs.sqlite").exists());
    let moved_backup = temp.path().join("moved-backup");
    fs::rename(&backup, &moved_backup).unwrap();
    let restored = temp.path().join("restored");
    let report = store.restore_backup_copy(&moved_backup, &restored).unwrap();
    assert_eq!(report.report.trashed_items, 1);
    assert_eq!(report.report.referenced_formats, 1);
    assert!(!restored.join("jobs.sqlite").exists());
    assert_eq!(store.list_trash().unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(temp.path().join("library")).unwrap();
    fs::remove_dir_all(moved_backup).unwrap();
    fs::remove_file(&referenced).unwrap();
    let restored = LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&report.database_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(restored.verify().unwrap().verified_managed_formats, 1);
    let trashed = restored.list_trash().unwrap();
    assert_eq!(
        fs::read(trashed[0].cover_path.as_ref().unwrap()).unwrap(),
        b"cover bytes"
    );
    let external = restored.read_item(&external.id).unwrap().unwrap();
    assert_eq!(external.formats[0].source_path, referenced);
}

#[test]
fn recovery_new_restore_refuses_existing_root_but_cli_preserves_unrelated_parent() {
    let (temp, store, backup) = backup_fixture();
    let destination = temp.path().join("existing");
    fs::create_dir(&destination).unwrap();
    let marker = destination.join("keep.txt");
    fs::write(&marker, b"keep").unwrap();
    assert_eq!(
        store
            .restore_backup_copy(&backup, &destination)
            .unwrap_err()
            .code(),
        "destination-exists"
    );
    let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite"))).unwrap();
    LibraryStore::restore_backup(&backup, paths.clone()).unwrap();
    assert_eq!(fs::read(&marker).unwrap(), b"keep");
    let database = fs::read(&paths.database).unwrap();
    assert_eq!(
        LibraryStore::restore_backup(&backup, paths.clone())
            .unwrap_err()
            .code(),
        "destination-exists"
    );
    assert_eq!(fs::read(&paths.database).unwrap(), database);
    assert_eq!(
        store.backup(&backup).unwrap_err().code(),
        "destination-exists"
    );
    assert!(backup.join("manifest.json").is_file());
}

#[test]
fn recovery_rejects_nested_paths_and_parent_traversal_without_writes() {
    let (temp, store, backup) = backup_fixture();
    for destination in [
        store.paths.root.join("nested/a/b"),
        store.paths.items.join("nested/a/b"),
        store.paths.root.clone(),
        temp.path().to_path_buf(),
    ] {
        assert!(store.backup(&destination).is_err());
        assert!(store.restore_backup_copy(&backup, &destination).is_err());
    }
    assert!(
        store
            .restore_backup_copy(&backup, &backup.join("nested/a/b"))
            .is_err()
    );
    assert!(store.backup(&temp.path().join("missing/../out")).is_err());
    assert!(!store.paths.root.join("nested").exists());
    assert!(!backup.join("nested").exists());
}

#[test]
fn recovery_rejects_corrupt_manifests_without_creating_destination() {
    let (temp, store, backup) = backup_fixture();
    let manifest_path = backup.join("manifest.json");
    let valid: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for bytes in [
        b"{".to_vec(),
        b"null".to_vec(),
        {
            let mut invalid = valid.clone();
            invalid["sourceRoot"] = Value::String("relative".into());
            serde_json::to_vec(&invalid).unwrap()
        },
        {
            let mut invalid = valid.clone();
            invalid["schemaVersion"] = Value::from(999);
            serde_json::to_vec(&invalid).unwrap()
        },
    ] {
        fs::write(&manifest_path, bytes).unwrap();
        let destination = temp.path().join("restore");
        assert!(store.restore_backup_copy(&backup, &destination).is_err());
        assert!(!destination.exists());
    }
}

#[test]
fn recovery_manifest_read_accepts_limit_and_rejects_one_extra_byte() {
    let (temp, store, backup) = backup_fixture();
    let path = backup.join("manifest.json");
    let mut manifest = fs::read(&path).unwrap();
    manifest.resize(64 * 1024, b' ');
    fs::write(&path, &manifest).unwrap();
    store
        .restore_backup_copy(&backup, &temp.path().join("at-limit"))
        .unwrap();
    manifest.push(b' ');
    fs::write(&path, &manifest).unwrap();
    let destination = temp.path().join("oversized");
    assert_eq!(
        store
            .restore_backup_copy(&backup, &destination)
            .unwrap_err()
            .code(),
        "source-invalid"
    );
    assert!(!destination.exists());
    assert_eq!(fs::read(&path).unwrap(), manifest);
}

#[test]
fn recovery_rejects_traversing_managed_and_cover_paths() {
    for cover in [false, true] {
        let (temp, store, backup) = backup_fixture();
        let connection = Connection::open(backup.join("library.sqlite")).unwrap();
        let escaped = backup.join(if cover {
            "covers/../../original.epub"
        } else {
            "items/../../original.epub"
        });
        if cover {
            connection
                .execute(
                    "UPDATE library_items SET cover_path=?1",
                    [escaped.to_string_lossy()],
                )
                .unwrap();
        } else {
            connection
                .execute(
                    "UPDATE library_item_formats SET source_path=?1",
                    [escaped.to_string_lossy()],
                )
                .unwrap();
        }
        drop(connection);
        let destination = temp.path().join("restore");
        assert!(store.restore_backup_copy(&backup, &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(
            fs::read(temp.path().join("original.epub")).unwrap(),
            b"recovery test ebook"
        );
    }
}

#[test]
fn recovery_checks_copied_schema_before_rebase_callbacks() {
    let (temp, store, backup) = backup_fixture();
    let connection = Connection::open(backup.join("library.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER unexpected_rebase BEFORE UPDATE ON library_item_formats BEGIN SELECT RAISE(ABORT, 'must not run'); END;").unwrap();
    drop(connection);
    let destination = temp.path().join("restore");
    assert_eq!(
        store
            .restore_backup_copy(&backup, &destination)
            .unwrap_err()
            .code(),
        "integrity-failed"
    );
    assert!(!destination.exists());
}

#[test]
fn recovery_corrupt_managed_bytes_clean_only_created_entries() {
    let (temp, store, backup) = backup_fixture();
    let copied = LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&backup.join("library.sqlite"))).unwrap(),
    )
    .unwrap();
    let item = copied.list(false).unwrap().remove(0);
    fs::write(&item.formats[0].source_path, b"corrupted").unwrap();
    drop(copied);
    let destination = temp.path().join("restore");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("keep.txt"), b"keep").unwrap();
    let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite"))).unwrap();
    assert!(LibraryStore::restore_backup(&backup, paths).is_err());
    assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"keep");
    assert_eq!(fs::read_dir(destination).unwrap().count(), 1);
    assert_eq!(store.verify().unwrap().verified_managed_formats, 1);
}

#[test]
fn recovery_output_reservations_never_clobber_or_recursively_clean_unowned_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("output");
    {
        let mut output = Output::default();
        output.directory(&root).unwrap();
        fs::write(root.join("other-writer"), b"keep").unwrap();
        assert!(output.file(&root.join("other-writer")).is_err());
        output
            .file(&root.join("ours"))
            .unwrap()
            .write_all(b"ours")
            .unwrap();
    }
    assert_eq!(fs::read(root.join("other-writer")).unwrap(), b"keep");
    assert!(!root.join("ours").exists());
    let mut output = Output::default();
    assert!(output.directory(&root).is_err());
    drop(output);
    assert_eq!(fs::read(root.join("other-writer")).unwrap(), b"keep");
}

#[test]
fn recovery_refuses_live_backup_sidecars_and_redirected_library_paths() {
    let (temp, store, backup) = backup_fixture();
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = backup.join(format!("library.sqlite{suffix}"));
        fs::write(&sidecar, b"live").unwrap();
        assert!(
            store
                .restore_backup_copy(&backup, &temp.path().join("restore"))
                .is_err()
        );
        fs::remove_file(sidecar).unwrap();
    }
    let mut paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("restore/library.sqlite"))).unwrap();
    paths.items = temp.path().join("elsewhere");
    assert!(LibraryStore::restore_backup(&backup, paths).is_err());
    assert!(!temp.path().join("restore").exists());
    assert!(!temp.path().join("elsewhere").exists());
}

#[test]
fn recovery_online_backup_captures_wal_and_restores_without_sidecars() {
    let (temp, store, id) = fixture();
    store
        .connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE library_items SET title='WAL title' WHERE id=?1",
            [&id],
        )
        .unwrap();
    let backup = temp.path().join("backup");
    store.backup(&backup).unwrap();
    for suffix in ["-journal", "-wal", "-shm"] {
        assert!(!backup.join(format!("library.sqlite{suffix}")).exists());
    }
    let report = store
        .restore_backup_copy(&backup, &temp.path().join("restored"))
        .unwrap();
    let restored = LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&report.database_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(restored.read_item(&id).unwrap().unwrap().title, "WAL title");
}

#[test]
fn recovery_missing_cover_and_managed_file_fail_without_leaving_outputs() {
    for cover in [false, true] {
        let (temp, store, backup) = backup_fixture();
        let connection = Connection::open(backup.join("library.sqlite")).unwrap();
        let missing = backup.join(if cover {
            "covers/missing.jpg"
        } else {
            "items/missing.epub"
        });
        connection
            .execute(
                if cover {
                    "UPDATE library_items SET cover_path=?1"
                } else {
                    "UPDATE library_item_formats SET source_path=?1"
                },
                [missing.to_string_lossy()],
            )
            .unwrap();
        drop(connection);
        let destination = temp.path().join("restored");
        assert!(store.restore_backup_copy(&backup, &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(store.verify().unwrap().verified_managed_formats, 1);
    }
}

#[cfg(unix)]
#[test]
fn recovery_rejects_alias_nesting_dangling_targets_and_symlink_snapshot_entries() {
    use std::os::unix::fs::symlink;
    let (temp, store, backup) = backup_fixture();
    let alias = temp.path().join("alias");
    symlink(&store.paths.items, &alias).unwrap();
    assert!(store.backup(&alias.join("missing/parent/backup")).is_err());
    assert!(!store.paths.items.join("missing").exists());
    fs::remove_file(&alias).unwrap();
    symlink(&backup, &alias).unwrap();
    assert!(
        store
            .restore_backup_copy(&backup, &alias.join("missing/restore"))
            .is_err()
    );
    let target = temp.path().join("restore");
    fs::create_dir(&target).unwrap();
    let outside = temp.path().join("outside.sqlite");
    symlink(&outside, target.join("library.sqlite")).unwrap();
    let paths = LibraryPaths::resolve(None, Some(&target.join("library.sqlite"))).unwrap();
    assert!(LibraryStore::restore_backup(&backup, paths).is_err());
    assert!(!outside.exists());
    assert!(
        fs::symlink_metadata(target.join("library.sqlite"))
            .unwrap()
            .is_symlink()
    );
    symlink(
        temp.path().join("original.epub"),
        backup.join("covers/linked.jpg"),
    )
    .unwrap();
    assert!(
        store
            .restore_backup_copy(&backup, &temp.path().join("new-restore"))
            .is_err()
    );
    assert!(!temp.path().join("new-restore").exists());
    symlink(
        temp.path().join("original.epub"),
        store.paths.covers.join("linked.jpg"),
    )
    .unwrap();
    assert!(store.backup(&temp.path().join("new-backup")).is_err());
    assert!(!temp.path().join("new-backup").exists());
}

#[cfg(unix)]
#[test]
fn recovery_rejects_special_files_without_opening_them() {
    use std::os::unix::net::UnixListener;
    let (temp, store, backup) = backup_fixture();
    let _socket = UnixListener::bind(backup.join("covers/socket")).unwrap();
    assert!(
        store
            .restore_backup_copy(&backup, &temp.path().join("restore"))
            .is_err()
    );
    assert!(!temp.path().join("restore").exists());
}

#[cfg(unix)]
#[test]
fn recovery_rejects_symlinked_snapshot_metadata_and_destination_sidecars() {
    use std::os::unix::fs::symlink;
    for name in ["manifest.json", "library.sqlite"] {
        let (temp, store, backup) = backup_fixture();
        let external = temp.path().join("external");
        fs::rename(backup.join(name), &external).unwrap();
        let bytes = fs::read(&external).unwrap();
        symlink(&external, backup.join(name)).unwrap();
        assert!(
            store
                .restore_backup_copy(&backup, &temp.path().join("restore"))
                .is_err()
        );
        assert!(!temp.path().join("restore").exists());
        assert_eq!(fs::read(&external).unwrap(), bytes);
    }
    let (temp, _, backup) = backup_fixture();
    let root = temp.path().join("restore");
    fs::create_dir(&root).unwrap();
    let external = temp.path().join("outside");
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = root.join(format!("library.sqlite{suffix}"));
        symlink(&external, &sidecar).unwrap();
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        assert!(LibraryStore::restore_backup(&backup, paths).is_err());
        assert!(!external.exists());
        assert!(fs::symlink_metadata(&sidecar).unwrap().is_symlink());
        fs::remove_file(sidecar).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn recovery_read_only_verification_accepts_root_aliases_without_rebasing() {
    let (temp, store, _) = fixture();
    let real = temp.path().join("copies");
    fs::create_dir(&real).unwrap();
    let alias = temp.path().join("copies-alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let backup = alias.join("backup");
    store.backup(&backup).unwrap();
    let restored = alias.join("restored");
    store.restore_backup_copy(&backup, &restored).unwrap();
    for root in [&backup, &restored] {
        let database = root.join("library.sqlite");
        let before = fs::read(&database).unwrap();
        let opened =
            LibraryStore::open_read_only(LibraryPaths::resolve(None, Some(&database)).unwrap())
                .unwrap();
        assert_eq!(opened.verify().unwrap().verified_managed_formats, 1);
        assert_eq!(fs::read(&database).unwrap(), before);
    }
    assert!(
        store
            .restore_backup_copy(&backup, &alias.join("backup/inside"))
            .is_err()
    );
    assert!(!backup.join("inside").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn recovery_verifies_through_macos_var_alias_with_any_tmpdir() {
    // Exercise the actual system alias even when the test runner overrides TMPDIR.
    let temp = tempfile::tempdir_in("/var/tmp").unwrap();
    assert_ne!(temp.path(), temp.path().canonicalize().unwrap());
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("source.epub");
    fs::write(&source, b"macOS alias regression").unwrap();
    store.import(&source, None, false).unwrap();
    let backup = temp.path().join("backup");
    store.backup(&backup).unwrap();
    let restored = temp.path().join("restored");
    store.restore_backup_copy(&backup, &restored).unwrap();
    for root in [backup, restored] {
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        assert_eq!(
            LibraryStore::open_read_only(paths)
                .unwrap()
                .verify()
                .unwrap()
                .verified_managed_formats,
            1
        );
    }
}

#[cfg(unix)]
#[test]
fn recovery_alias_verification_rejects_unrelated_and_symlinked_owned_roots() {
    let (temp, store, backup) = backup_fixture();
    let unrelated = temp.path().join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::copy(
        backup.join("library.sqlite"),
        unrelated.join("library.sqlite"),
    )
    .unwrap();
    let paths = LibraryPaths::resolve(None, Some(&unrelated.join("library.sqlite"))).unwrap();
    assert!(
        LibraryStore::open_read_only(paths)
            .unwrap()
            .verify()
            .is_err()
    );
    let items = backup.join("items");
    let external = temp.path().join("external-items");
    fs::rename(&items, &external).unwrap();
    std::os::unix::fs::symlink(&external, &items).unwrap();
    let paths = LibraryPaths::resolve(None, Some(&backup.join("library.sqlite"))).unwrap();
    assert!(
        LibraryStore::open_read_only(paths)
            .unwrap()
            .verify()
            .is_err()
    );
    assert!(
        store
            .restore_backup_copy(&backup, &temp.path().join("rejected"))
            .is_err()
    );
    assert!(!temp.path().join("rejected").exists());
}

#[test]
fn startup_preflight_preserves_supported_legacy_migration_and_rejects_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let connection = Connection::open(&paths.database).unwrap();
    connection
        .execute_batch(include_str!(
            "../../tests/fixtures/legacy-library-schemas/schema-v1.sql"
        ))
        .unwrap();
    connection.execute("DELETE FROM library_items", []).unwrap();
    drop(connection);
    let before = fs::read(&paths.database).unwrap();
    assert!(LibraryStore::preflight_startup(paths.clone()).unwrap());
    assert_eq!(fs::read(&paths.database).unwrap(), before);
    assert!(!paths.root.join("library.sqlite.v1.backup").exists());
    assert!(!paths.items.exists());
    let migrated = LibraryStore::create_or_migrate(paths.clone()).unwrap();
    assert_eq!(
        migrated.verify().unwrap().schema_version,
        LIBRARY_SCHEMA_VERSION
    );
    assert!(!LibraryStore::preflight_startup(paths.clone()).unwrap());
    assert!(paths.root.join("library.sqlite.v1.backup").is_file());
    drop(migrated);
    let mut malformed = fs::read(&paths.database).unwrap();
    malformed[60..64].copy_from_slice(&1_u32.to_be_bytes());
    fs::write(&paths.database, &malformed).unwrap();
    assert!(LibraryStore::preflight_startup(paths.clone()).is_err());
    assert_eq!(fs::read(&paths.database).unwrap(), malformed);
}

#[cfg(unix)]
#[test]
fn startup_preflight_accepts_parent_alias_but_not_database_symlink() {
    let (temp, store, _) = fixture();
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&store.paths.root, &alias).unwrap();
    let aliased = LibraryPaths::resolve(None, Some(&alias.join("library.sqlite"))).unwrap();
    assert!(!LibraryStore::preflight_startup(aliased).unwrap());
    let redirected = temp.path().join("redirected");
    fs::create_dir(&redirected).unwrap();
    std::os::unix::fs::symlink(&store.paths.database, redirected.join("library.sqlite")).unwrap();
    let paths = LibraryPaths::resolve(None, Some(&redirected.join("library.sqlite"))).unwrap();
    assert!(LibraryStore::preflight_startup(paths).is_err());
    assert_eq!(store.verify().unwrap().verified_managed_formats, 1);
}

#[cfg(unix)]
#[test]
fn recovery_reference_only_managed_cover_survives_root_alias_and_rejects_cover_symlink() {
    let (temp, store, id) = fixture();
    let cover = store.paths.covers.join("cover.jpg");
    fs::write(&cover, b"managed cover").unwrap();
    store
        .connection
        .execute(
            "UPDATE library_items SET cover_path=?1 WHERE id=?2",
            params![cover.to_string_lossy(), id],
        )
        .unwrap();
    store.connection.execute("UPDATE library_item_formats SET provenance='referenced',source_path=?1,content_bytes=NULL,content_sha256=NULL", [temp.path().join("original.epub").to_string_lossy()]).unwrap();
    let alias = temp.path().join("library-alias");
    std::os::unix::fs::symlink(&store.paths.root, &alias).unwrap();
    let paths = LibraryPaths::resolve(
        None,
        Some(&alias.canonicalize().unwrap().join("library.sqlite")),
    )
    .unwrap();
    // Canonical selection differs from the stored /var spelling on macOS; use
    // an explicit alias as the recorded root on all Unix test runners too.
    let alias_cover = alias.join("covers/cover.jpg");
    store
        .connection
        .execute(
            "UPDATE library_items SET cover_path=?1",
            [alias_cover.to_string_lossy()],
        )
        .unwrap();
    let before = fs::read(&store.paths.database).unwrap();
    let reopened = LibraryStore::open_existing(paths.clone()).unwrap();
    let backup = temp.path().join("cover-backup");
    reopened.backup(&backup).unwrap();
    let restored = temp.path().join("cover-restored");
    let report = reopened.restore_backup_copy(&backup, &restored).unwrap();
    assert_eq!(report.report.referenced_formats, 1);
    let restored = LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&report.database_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fs::read(restored.get(&id).unwrap().unwrap().cover_path.unwrap()).unwrap(),
        b"managed cover"
    );
    assert_eq!(fs::read(&store.paths.database).unwrap(), before);
    drop(reopened);
    let outside = temp.path().join("outside-covers");
    fs::rename(&store.paths.covers, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &store.paths.covers).unwrap();
    assert!(LibraryStore::open_existing(paths).is_err());
}
