// Included in workspace_tests.rs so recovery checks reuse its real-engine fixture.

#[cfg(debug_assertions)]
#[gpui::test]
fn native_backup_result_pointer_dismiss_preserves_recovery_copy(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    let before = recovery_snapshot(&f);
    recovery_make_backup(&f, &backup, cx);
    let database = std::fs::read(backup.join("library.sqlite")).unwrap();
    let manifest = std::fs::read(backup.join("manifest.json")).unwrap();

    click_control(&f, "dismiss-recovery", cx);

    assert!(
        f.state
            .read_with(cx, |state, _| state.recovery_outcome.is_none())
    );
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(
        std::fs::read(backup.join("library.sqlite")).unwrap(),
        database
    );
    assert_eq!(
        std::fs::read(backup.join("manifest.json")).unwrap(),
        manifest
    );
    recovery_assert_copied_books(&f, &backup, 0);
    recovery_no_dialogs(cx);
}

#[gpui::test]
fn native_recovery_accepted_destination_after_editing_starts_writes_nothing(
    cx: &mut TestAppContext,
) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    recovery_make_backup(&f, &backup, cx);
    let before = recovery_snapshot(&f);
    let view = recovery_view(&f, cx);
    let database = std::fs::read(backup.join("library.sqlite")).unwrap();
    let manifest = std::fs::read(backup.join("manifest.json")).unwrap();

    for restore in [false, true] {
        recovery_begin(&f, restore, cx);
        if restore {
            recovery_source(&backup, cx);
        }
        assert!(cx.did_prompt_for_new_path());
        f.state.update(cx, |state, _| state.metadata_editing = true);
        let destination = output.path().join(if restore {
            "blocked-restore"
        } else {
            "blocked-backup"
        });
        cx.simulate_new_path_selection(|_| Some(destination.clone()));
        settle(&f.state, cx);

        assert!(!destination.exists());
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
        assert_eq!(recovery_snapshot(&f), before);
        assert_eq!(recovery_view(&f, cx), view);
        assert_eq!(
            std::fs::read(backup.join("library.sqlite")).unwrap(),
            database
        );
        assert_eq!(
            std::fs::read(backup.join("manifest.json")).unwrap(),
            manifest
        );
        recovery_no_dialogs(cx);
        f.state.read_with(cx, |state, _| {
            assert!(state.metadata_editing);
            assert!(!state.busy);
            let status = state.status.as_ref().unwrap();
            assert!(status.is_error);
            assert!(status.text.contains("save/cancel your edits"));
            assert!(status.text.contains(if restore {
                "No restore was started."
            } else {
                "No new backup was started."
            }));
            assert_eq!(
                state.recovery_outcome.as_ref().unwrap().path,
                backup.canonicalize().unwrap()
            );
        });
        f.state
            .update(cx, |state, _| state.metadata_editing = false);
    }
    recovery_assert_copied_books(&f, &backup, 0);
}

fn recovery_action(f: &Fixture, restore: bool, cx: &mut TestAppContext) {
    f.window
        .update(cx, |_, window, cx| {
            if restore {
                window.dispatch_action(Box::new(crate::RestoreBackupCopy), cx);
            } else {
                window.dispatch_action(Box::new(crate::BackUpLibrary), cx);
            }
        })
        .unwrap();
    cx.run_until_parked();
}

fn recovery_begin(f: &Fixture, restore: bool, cx: &mut TestAppContext) {
    recovery_action(f, restore, cx);
    let (title, detail) = cx
        .pending_prompt()
        .expect("recovery needs explicit consent");
    assert_eq!(
        title,
        if restore {
            "Restore a backup to a new folder?"
        } else {
            "Back up the whole library?"
        }
    );
    assert!(detail.contains("Conversion jobs") || detail.contains("conversion jobs"));
    if restore {
        assert!(detail.contains("never replaced or merged"));
    } else {
        assert!(detail.contains("Trash"));
        assert!(detail.contains("NOT included"));
        assert!(detail.contains("separate drive"));
    }
    cx.simulate_prompt_answer(if restore {
        "Choose backup"
    } else {
        "Choose location"
    });
    cx.run_until_parked();
}

fn recovery_source(source: &std::path::Path, cx: &mut TestAppContext) {
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(!options.files);
        assert!(options.directories);
        assert!(!options.multiple);
        Some(vec![source.to_path_buf()])
    });
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
}

type RecoverySnapshot = (
    String,
    Vec<String>,
    std::collections::BTreeMap<PathBuf, Vec<u8>>,
);

fn recovery_snapshot(f: &Fixture) -> RecoverySnapshot {
    (
        format!("{:?}", preparation_catalogue(f)),
        trash_ids(&f.engine),
        preparation_files(f),
    )
}

fn recovery_view(f: &Fixture, cx: &mut TestAppContext) -> String {
    f.state.read_with(cx, |state, _| {
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}",
            state.section, state.query, state.items, state.selected, state.anchor
        )
    })
}

fn recovery_no_dialogs(cx: &TestAppContext) {
    assert!(!cx.has_pending_prompt());
    assert!(!cx.did_prompt_for_paths());
    assert!(!cx.did_prompt_for_new_path());
}

fn recovery_make_backup(f: &Fixture, output: &std::path::Path, cx: &mut TestAppContext) {
    recovery_begin(f, false, cx);
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection(|_| Some(output.to_path_buf()));
    settle(&f.state, cx);
    assert!(output.join("manifest.json").is_file());
    f.state.read_with(cx, |state, _| {
        assert!(!state.status.as_ref().unwrap().is_error);
        assert_eq!(
            state.recovery_outcome.as_ref().unwrap().path,
            output.canonicalize().unwrap()
        );
    });
    recovery_no_dialogs(cx);
}

fn recovery_assert_copied_books(f: &Fixture, output: &std::path::Path, trashed: usize) {
    let paths = LibraryPaths::resolve(None, Some(&output.join("library.sqlite"))).unwrap();
    let store = takio::store::LibraryStore::open_read_only(paths).unwrap();
    let copied = store.list(true).unwrap();
    assert_eq!(copied.len(), f.books.len());
    assert_eq!(store.list_trash().unwrap().len(), trashed);
    store.verify().unwrap();
    for original in &f.books {
        let restored = copied.iter().find(|book| book.id == original.id).unwrap();
        assert_eq!(restored.title, original.title);
        assert_eq!(
            format!("{:?}", restored.authors),
            format!("{:?}", original.authors)
        );
        assert_eq!(restored.tags, original.tags);
        assert_eq!(restored.series, original.series);
        assert_eq!(restored.formats.len(), original.formats.len());
        for format in &original.formats {
            let copied_format = restored
                .formats
                .iter()
                .find(|copy| copy.format == format.format)
                .unwrap();
            assert!(
                copied_format
                    .source_path
                    .starts_with(output.canonicalize().unwrap())
            );
            assert_ne!(copied_format.source_path, format.source_path);
            assert_eq!(
                std::fs::read(&copied_format.source_path).unwrap(),
                std::fs::read(&format.source_path).unwrap()
            );
        }
    }
}

#[gpui::test]
fn native_backup_confirmation_cancel_is_read_only(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let before = recovery_snapshot(&f);
    recovery_action(&f, false, cx);
    assert!(cx.has_pending_prompt());
    assert!(!cx.did_prompt_for_new_path());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
    assert!(
        f.state
            .read_with(cx, |state, _| state.recovery_outcome.is_none())
    );
}

#[gpui::test]
fn native_backup_destination_cancel_is_read_only_and_can_retry(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    recovery_begin(&f, false, cx);
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection(|_| None);
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
    recovery_action(&f, false, cx);
    assert!(cx.has_pending_prompt());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
}

#[gpui::test]
fn native_restore_confirmation_cancel_is_read_only(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    recovery_action(&f, true, cx);
    assert!(cx.has_pending_prompt());
    assert!(!cx.did_prompt_for_paths());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
}

#[gpui::test]
fn native_restore_source_picker_cancel_is_read_only(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    recovery_begin(&f, true, cx);
    cx.simulate_path_prompt_response(|options| {
        assert!(!options.files && options.directories && !options.multiple);
        None
    });
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
}

#[gpui::test]
fn native_restore_destination_cancel_preserves_backup_and_library(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    recovery_make_backup(&f, &backup, cx);
    let before = recovery_snapshot(&f);
    let database = std::fs::read(backup.join("library.sqlite")).unwrap();
    let manifest = std::fs::read(backup.join("manifest.json")).unwrap();
    recovery_begin(&f, true, cx);
    recovery_source(&backup, cx);
    cx.simulate_new_path_selection(|_| None);
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(
        std::fs::read(backup.join("library.sqlite")).unwrap(),
        database
    );
    assert_eq!(
        std::fs::read(backup.join("manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
    recovery_assert_copied_books(&f, &backup, 0);
}

#[gpui::test]
fn native_backup_ignores_filtered_selection_and_includes_trash(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    f.engine
        .request(|reply| Request::Trash {
            ids: vec![f.books[1].id.clone()],
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    f.state.update(cx, |state, cx| {
        state.set_section(Section::Trash, cx);
    });
    settle(&f.state, cx);
    f.state
        .update(cx, |state, cx| state.set_section(Section::Library, cx));
    settle(&f.state, cx);
    assert_eq!(f.state.read_with(cx, |state, _| state.items.len()), 1);
    f.state.update(cx, |state, cx| {
        state.set_query("no-matching-recovery-book".into(), cx)
    });
    cx.executor().advance_clock(Duration::from_millis(100));
    settle(&f.state, cx);
    assert!(f.state.read_with(cx, |state, _| state.items.is_empty()));
    f.state.update(cx, |state, _| {
        state.selected.clear();
        state.anchor = None;
    });
    let before = recovery_snapshot(&f);
    let view = recovery_view(&f, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("whole-library");
    recovery_make_backup(&f, &backup, cx);
    recovery_assert_copied_books(&f, &backup, 1);
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(recovery_view(&f, cx), view);
}

#[gpui::test]
fn native_restore_copies_verified_bytes_without_switching_current_library(cx: &mut TestAppContext) {
    let f = fixture(true, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    let restored = output.path().join("restored");
    recovery_make_backup(&f, &backup, cx);
    let before = recovery_snapshot(&f);
    let view = recovery_view(&f, cx);
    let backup_database = std::fs::read(backup.join("library.sqlite")).unwrap();
    recovery_begin(&f, true, cx);
    recovery_source(&backup, cx);
    cx.simulate_new_path_selection(|_| Some(restored.clone()));
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    recovery_assert_copied_books(&f, &restored, 2);
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(recovery_view(&f, cx), view);
    assert_eq!(
        std::fs::read(backup.join("library.sqlite")).unwrap(),
        backup_database
    );
    f.state.read_with(cx, |state, _| {
        assert!(!state.status.as_ref().unwrap().is_error);
        let outcome = state.recovery_outcome.as_ref().unwrap();
        assert_eq!(outcome.path, restored.canonicalize().unwrap());
        assert!(outcome.detail.contains("current library is unchanged"));
    });
}

#[gpui::test]
fn native_backup_existing_destination_preserves_marker(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    let output = tempfile::tempdir().unwrap();
    let marker = output.path().join("keep-me");
    std::fs::write(&marker, b"do not overwrite").unwrap();
    recovery_begin(&f, false, cx);
    cx.simulate_new_path_selection(|_| Some(output.path().to_path_buf()));
    settle(&f.state, cx);
    assert_eq!(std::fs::read(marker).unwrap(), b"do not overwrite");
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
    assert_eq!(recovery_snapshot(&f), before);
    f.state.read_with(cx, |state, _| {
        assert!(state.status.as_ref().unwrap().is_error);
        assert!(state.recovery_outcome.is_none());
    });
    recovery_no_dialogs(cx);
}

#[gpui::test]
fn native_restore_existing_destination_preserves_marker(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    recovery_make_backup(&f, &backup, cx);
    let before = recovery_snapshot(&f);
    let restored = output.path().join("existing");
    std::fs::create_dir(&restored).unwrap();
    let marker = restored.join("keep-me");
    std::fs::write(&marker, b"do not overwrite").unwrap();
    recovery_begin(&f, true, cx);
    recovery_source(&backup, cx);
    cx.simulate_new_path_selection(|_| Some(restored.clone()));
    settle(&f.state, cx);
    assert_eq!(std::fs::read(marker).unwrap(), b"do not overwrite");
    assert_eq!(std::fs::read_dir(restored).unwrap().count(), 1);
    assert_eq!(recovery_snapshot(&f), before);
    recovery_assert_copied_books(&f, &backup, 0);
    f.state.read_with(cx, |state, _| {
        assert!(state.status.as_ref().unwrap().is_error);
        assert!(state.recovery_outcome.is_none());
    });
    recovery_no_dialogs(cx);
}

#[gpui::test]
fn native_recovery_actions_are_blocked_while_busy_or_editing(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    for editing in [false, true] {
        f.state.update(cx, |state, _| {
            state.busy = !editing;
            state.metadata_editing = editing;
        });
        for restore in [false, true] {
            recovery_action(&f, restore, cx);
            recovery_no_dialogs(cx);
        }
        assert_eq!(recovery_snapshot(&f), before);
    }
    f.state.update(cx, |state, _| {
        state.busy = false;
        state.metadata_editing = false;
    });
    recovery_action(&f, false, cx);
    assert!(cx.has_pending_prompt());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
}

#[gpui::test]
fn native_repeated_backup_actions_do_not_duplicate_confirmation_or_picker(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    recovery_action(&f, false, cx);
    recovery_action(&f, false, cx);
    recovery_action(&f, true, cx);
    cx.simulate_prompt_answer("Choose location");
    cx.run_until_parked();
    assert!(!cx.has_pending_prompt());
    assert!(cx.did_prompt_for_new_path());
    recovery_action(&f, false, cx);
    recovery_action(&f, true, cx);
    assert!(!cx.has_pending_prompt());
    cx.simulate_new_path_selection(|_| None);
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
}

#[gpui::test]
fn native_repeated_restore_actions_do_not_duplicate_any_dialog(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    let output = tempfile::tempdir().unwrap();
    recovery_action(&f, true, cx);
    recovery_action(&f, true, cx);
    recovery_action(&f, false, cx);
    cx.simulate_prompt_answer("Choose backup");
    cx.run_until_parked();
    assert!(!cx.has_pending_prompt());
    recovery_action(&f, true, cx);
    recovery_action(&f, false, cx);
    assert!(!cx.has_pending_prompt());
    recovery_source(output.path(), cx);
    assert!(!cx.did_prompt_for_paths());
    recovery_action(&f, true, cx);
    recovery_action(&f, false, cx);
    assert!(!cx.has_pending_prompt());
    cx.simulate_new_path_selection(|_| None);
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    assert_eq!(recovery_snapshot(&f), before);
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
}
