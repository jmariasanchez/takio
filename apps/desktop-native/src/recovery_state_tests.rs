#[gpui::test]
fn recovery_round_trip_keeps_whole_catalogue_trash_and_originals(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    let restored = output.path().join("restored");
    let books = f.state.read_with(cx, |s, _| s.items.clone());
    let bytes: Vec<_> = books.iter().map(|book| fs::read(&book.source_path).unwrap()).collect();
    f.state.update(cx, |s, cx| {
        s.select_only(0, cx);
        s.update_metadata(books[0].id.clone(), LibraryPatch {
            tags: takio::model::Patch::Set(vec!["Keep this tag".into()]),
            ..Default::default()
        }, cx);
    });
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| s.trash_selected(cx));
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| s.set_query("Beta".into(), cx));
    cx.executor().advance_clock(Duration::from_millis(100));
    settle(&f.state, cx);
    assert_eq!(titles(&f.state, cx), ["Beta"]);
    f.state.update(cx, |s, cx| s.back_up_library(backup.clone(), cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert!(!s.status.as_ref().unwrap().is_error);
        let result = s.recovery_outcome.as_ref().unwrap();
        assert!(result.summary.contains("3 managed"));
        assert!(result.detail.contains("External referenced files"));
    });
    let moved = output.path().join("moved-backup");
    fs::rename(&backup, &moved).unwrap();
    f.state.update(cx, |s, cx| s.restore_backup_copy(moved.clone(), restored.clone(), cx));
    settle(&f.state, cx);
    assert_eq!(titles(&f.state, cx), ["Beta"]);
    f.state.read_with(cx, |s, _| {
        assert_eq!(s.query, "Beta");
        let outcome = s.recovery_outcome.as_ref().unwrap();
        assert!(outcome.summary.contains("2 book(s), 1 in Trash, 3 managed"));
        assert!(outcome.detail.contains("unchanged and still open"));
        assert_eq!(outcome.path, restored.canonicalize().unwrap());
    });
    let paths = LibraryPaths::resolve(None, Some(&restored.join("library.sqlite"))).unwrap();
    let store = takio::store::LibraryStore::open_read_only(paths).unwrap();
    let report = store.verify().unwrap();
    assert_eq!((report.active_items, report.trashed_items, report.verified_managed_formats), (2, 1, 3));
    assert_eq!(store.list_trash().unwrap()[0].tags, ["Keep this tag"]);
    for (book, expected) in books.iter().zip(bytes) {
        let recovered = store.get(&book.id).unwrap().unwrap();
        assert!(recovered.source_path.starts_with(restored.canonicalize().unwrap()));
        assert_eq!(fs::read(recovered.source_path).unwrap(), expected);
        assert_eq!(fs::read(&book.source_path).unwrap(), expected);
        assert_eq!(fs::read(f._temp.path().join(format!("{}.epub", book.title))).unwrap(), expected);
    }
}

#[gpui::test]
fn recovery_collision_and_invalid_backup_leave_current_library_unchanged(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let output = tempfile::tempdir().unwrap();
    let existing = output.path().join("existing");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("marker"), b"preserve me").unwrap();
    let before = titles(&f.state, cx);
    f.state.update(cx, |s, cx| s.back_up_library(existing.clone(), cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert!(s.status.as_ref().unwrap().is_error);
        assert!(s.status.as_ref().unwrap().text.contains("already exists"));
        assert!(s.recovery_outcome.is_none());
    });
    let invalid = output.path().join("invalid");
    fs::create_dir(&invalid).unwrap();
    fs::write(invalid.join("manifest.json"), b"not JSON").unwrap();
    let destination = output.path().join("rejected");
    f.state.update(cx, |s, cx| s.restore_backup_copy(invalid.clone(), destination.clone(), cx));
    settle(&f.state, cx);
    assert!(!destination.exists());
    assert_eq!(fs::read(existing.join("marker")).unwrap(), b"preserve me");
    assert_eq!(fs::read(invalid.join("manifest.json")).unwrap(), b"not JSON");
    assert_eq!(titles(&f.state, cx), before);
    f.state.read_with(cx, |s, _| {
        assert!(s.status.as_ref().unwrap().is_error);
        assert!(s.recovery_outcome.is_none());
        assert!(s.can_mutate());
    });
}

#[gpui::test]
fn recovery_blocks_overlap_and_close_until_reply(cx: &mut TestAppContext) {
    for restore in [false, true] {
        let f = fixture(cx);
        let requests = preparation_channel(&f, cx);
        let destination = f._temp.path().join("unused-destination");
        let source = f._temp.path().join("unused-backup");
        let volumes = f._temp.path().join("volumes");
        let reader = volumes.join("Kindle");
        fs::create_dir_all(reader.join("documents")).unwrap();
        fs::create_dir_all(reader.join("system")).unwrap();
        let reader = takio::destinations::authorize(&reader, &volumes).unwrap();
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            if restore {
                s.restore_backup_copy(source.clone(), destination.clone(), cx);
            } else {
                s.back_up_library(destination.clone(), cx);
            }
            assert!(s.busy);
            assert!(!s.can_close(cx));
            s.back_up_library(destination.clone(), cx);
            s.restore_backup_copy(source.clone(), destination.clone(), cx);
            s.import(vec![source], ImportMode::Copy, cx);
            s.trash_selected(cx);
            s.prepare_selected(cx);
            s.send_selected_to(reader.clone(), cx);
            s.eject(reader, cx);
        });
        match requests.try_recv().unwrap() {
            Request::Backup { reply, .. } if !restore => reply.send(Err(AppError::new("backup-failed"))).unwrap(),
            Request::RestoreBackupCopy { reply, .. } if restore => reply.send(Err(AppError::new("restore-failed"))).unwrap(),
            _ => panic!("expected only the original recovery operation"),
        }
        assert!(requests.try_recv().is_err());
        settle(&f.state, cx);
        f.state.update(cx, |s, cx| {
            assert!(s.can_close(cx));
            assert!(s.can_mutate());
            assert!(s.recovery_outcome.is_none());
            assert!(s.status.as_ref().unwrap().is_error);
        });
    }
}

#[gpui::test]
fn recovery_completion_survives_section_changes(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    f.state.update(cx, |s, cx| {
        s.back_up_library(backup.clone(), cx);
        s.set_section(Section::Trash, cx);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert_eq!(s.section, Section::Trash);
        assert!(s.items.is_empty());
        assert!(s.recovery_outcome.is_some());
        assert!(!s.status.as_ref().unwrap().is_error);
    });
    assert!(backup.join("manifest.json").is_file());
}

#[gpui::test]
fn recovery_rejects_corrupt_managed_bytes_without_false_success(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    f.state.update(cx, |s, cx| s.back_up_library(backup.clone(), cx));
    settle(&f.state, cx);
    let paths = LibraryPaths::resolve(None, Some(&backup.join("library.sqlite"))).unwrap();
    let store = takio::store::LibraryStore::open_read_only(paths).unwrap();
    let path = store.list(false).unwrap()[0].source_path.clone();
    drop(store);
    fs::write(&path, b"corrupted").unwrap();
    let destination = output.path().join("restore");
    f.state.update(cx, |s, cx| s.restore_backup_copy(backup, destination.clone(), cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert!(s.recovery_outcome.is_none());
        assert!(s.status.as_ref().unwrap().is_error);
        assert_eq!(s.items.len(), 3);
    });
    assert!(!destination.join("library.sqlite").exists());
    assert_eq!(fs::read(path).unwrap(), b"corrupted");
}
