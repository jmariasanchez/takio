// Included by workspace_tests.rs to share its native window and real-worker fixture.

fn switch_copy(f: &Fixture) -> (tempfile::TempDir, PathBuf) {
    let output = tempfile::tempdir().unwrap();
    let backup = output.path().join("backup");
    let restored = output.path().join("restored");
    f.engine
        .request(|reply| Request::Backup {
            destination: backup.clone(),
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    f.engine
        .request(|reply| Request::RestoreBackupCopy {
            source: backup,
            destination: restored.clone(),
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    (output, restored)
}

fn switch_to(f: &Fixture, root: &std::path::Path, cx: &mut TestAppContext) {
    let epoch = f.state.read_with(cx, |state, _| state.library_epoch);
    f.state
        .update(cx, |state, cx| state.open_library(root.to_path_buf(), cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_epoch, epoch + 1);
        assert_eq!(state.library_root, root.canonicalize().unwrap());
        assert!(!state.switching_library);
    });
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
}

fn switch_old_catalogue(f: &Fixture) -> Vec<LibraryItem> {
    let paths =
        LibraryPaths::resolve(None, Some(&f._temp.path().join("library/library.sqlite"))).unwrap();
    takio::store::LibraryStore::open_read_only(paths)
        .unwrap()
        .list(true)
        .unwrap()
}

fn switch_prompt(f: &Fixture, cx: &mut TestAppContext) {
    f.window
        .update(cx, |workspace, _, cx| workspace.prompt_open_library(cx))
        .unwrap();
    cx.run_until_parked();
}

#[gpui::test]
fn library_switch_header_pointer_cancel_preserves_current_library(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = f.state.read_with(cx, |state, _| {
        (state.library_root.clone(), state.library_epoch)
    });
    click_control(&f, "open-library", cx);
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(!options.files && options.directories && !options.multiple);
        None
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!((state.library_root.clone(), state.library_epoch), before);
        assert!(!state.switching_library);
    });
    assert_eq!(switch_old_catalogue(&f).len(), 2);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn library_switch_picker_cancel_duplicate_and_late_edit_are_safe(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let (_copy, restored) = switch_copy(&f);
    let before = f.state.read_with(cx, |state, _| {
        (state.library_root.clone(), state.library_epoch)
    });
    switch_prompt(&f, cx);
    assert!(cx.did_prompt_for_paths());
    switch_prompt(&f, cx);
    cx.simulate_path_prompt_response(|options| {
        assert!(!options.files && options.directories && !options.multiple);
        None
    });
    settle(&f.state, cx);
    assert!(
        !cx.did_prompt_for_paths(),
        "duplicate must not queue another chooser"
    );
    switch_prompt(&f, cx);
    f.state.update(cx, |state, _| state.metadata_editing = true);
    cx.simulate_path_prompt_response(|_| Some(vec![restored]));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!((state.library_root.clone(), state.library_epoch), before);
        assert!(state.metadata_editing);
        assert_eq!(state.items.len(), 2);
    });
    assert_eq!(switch_old_catalogue(&f).len(), 2);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn library_switch_restored_same_ids_resets_native_children_and_search(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let (_copy, restored) = switch_copy(&f);
    f.window
        .update(cx, |workspace, window, cx| {
            workspace
                .search
                .update(cx, |search, cx| search.focus(window, cx))
        })
        .unwrap();
    cx.simulate_input(f.window.into(), "Alpha");
    cx.executor().advance_clock(Duration::from_millis(100));
    settle(&f.state, cx);
    let children = f
        .window
        .update(cx, |workspace, _, cx| {
            assert_eq!(workspace.search.read(cx).text(), "Alpha");
            (
                workspace.search.entity_id(),
                workspace.list.entity_id(),
                workspace.inspector.entity_id(),
            )
        })
        .unwrap();
    switch_to(&f, &restored, cx);
    f.window
        .update(cx, |workspace, _, cx| {
            assert_eq!(workspace.search.read(cx).text(), "");
            assert_ne!(workspace.search.entity_id(), children.0);
            assert_ne!(workspace.list.entity_id(), children.1);
            assert_ne!(workspace.inspector.entity_id(), children.2);
        })
        .unwrap();
    f.state.read_with(cx, |state, _| {
        assert!(state.query.is_empty());
        assert!(state.selected.is_empty());
        assert_eq!(state.anchor, None);
        assert_eq!(state.items.len(), 2);
        assert!(
            state
                .items
                .iter()
                .all(|item| f.books.iter().any(|old| old.id == item.id))
        );
    });
}

#[gpui::test]
fn library_switch_old_purge_confirmation_cannot_delete_restored_same_ids(cx: &mut TestAppContext) {
    let f = fixture(true, cx);
    let (_copy, restored) = switch_copy(&f);
    let before = trash_ids(&f.engine);
    f.window
        .update(cx, |workspace, window, cx| {
            workspace.confirm_purge(window, cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.has_pending_prompt());
    switch_to(&f, &restored, cx);
    f.state
        .update(cx, |state, cx| state.set_section(Section::Trash, cx));
    settle(&f.state, cx);
    cx.simulate_prompt_answer("Delete permanently");
    settle(&f.state, cx);
    assert_eq!(trash_ids(&f.engine), before);
    assert_eq!(switch_old_catalogue(&f).len(), 2);
    assert_files_unchanged(&f);
    assert!(
        f.state
            .read_with(cx, |state, _| state.items.iter().all(|item| item
                .formats
                .iter()
                .all(|format| format.source_path.exists())))
    );
}

#[gpui::test]
fn library_switch_old_copy_and_move_pickers_never_import_or_move(cx: &mut TestAppContext) {
    for mode in [ImportMode::Copy, ImportMode::Move] {
        let f = fixture(false, cx);
        let (_copy, restored) = switch_copy(&f);
        let source = f._temp.path().join("Late.epub");
        std::fs::write(&source, b"late import source must survive").unwrap();
        f.window
            .update(cx, |workspace, window, cx| {
                workspace.prompt_import(mode, window, cx)
            })
            .unwrap();
        cx.run_until_parked();
        if mode == ImportMode::Move {
            cx.simulate_prompt_answer("Choose files to move");
            cx.run_until_parked();
        }
        assert!(cx.did_prompt_for_paths());
        switch_to(&f, &restored, cx);
        cx.simulate_path_prompt_response(|_| Some(vec![source.clone()]));
        settle(&f.state, cx);
        assert_eq!(
            std::fs::read(&source).unwrap(),
            b"late import source must survive"
        );
        assert_eq!(preparation_catalogue(&f).len(), 2);
        assert_eq!(switch_old_catalogue(&f).len(), 2);
        assert_files_unchanged(&f);
    }
}

#[gpui::test]
fn library_switch_old_move_warning_cannot_open_followup_picker(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let (_copy, restored) = switch_copy(&f);
    f.window
        .update(cx, |workspace, window, cx| {
            workspace.prompt_import(ImportMode::Move, window, cx)
        })
        .unwrap();
    cx.run_until_parked();
    switch_to(&f, &restored, cx);
    cx.simulate_prompt_answer("Choose files to move");
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_paths());
    assert_files_unchanged(&f);
}

#[gpui::test]
fn library_switch_failed_folder_keeps_current_native_view(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let invalid = tempfile::tempdir().unwrap();
    let before = f.state.read_with(cx, |state, _| {
        (
            state.library_root.clone(),
            state.library_epoch,
            state.selected.clone(),
        )
    });
    let inspector = f
        .window
        .update(cx, |workspace, _, _| workspace.inspector.entity_id())
        .unwrap();
    switch_prompt(&f, cx);
    cx.simulate_path_prompt_response(|_| Some(vec![invalid.path().to_path_buf()]));
    settle(&f.state, cx);
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    assert_eq!(std::fs::read_dir(invalid.path()).unwrap().count(), 0);
    f.state.read_with(cx, |state, _| {
        assert_eq!(
            (
                state.library_root.clone(),
                state.library_epoch,
                state.selected.clone()
            ),
            before
        );
        assert_eq!(state.items.len(), 2);
        assert!(state.status.as_ref().unwrap().is_error);
    });
    assert_eq!(
        f.window
            .update(cx, |workspace, _, _| workspace.inspector.entity_id())
            .unwrap(),
        inspector
    );
    assert_files_unchanged(&f);
}

#[gpui::test]
fn library_switch_recovery_modal_overlap_and_stale_source_are_safe(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let (copy, restored) = switch_copy(&f);
    recovery_action(&f, true, cx);
    switch_prompt(&f, cx);
    assert!(
        !cx.did_prompt_for_paths(),
        "library picker must not overlap recovery consent"
    );
    cx.simulate_prompt_answer("Choose backup");
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    switch_to(&f, &restored, cx);
    cx.simulate_path_prompt_response(|_| Some(vec![copy.path().join("backup")]));
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_new_path());
    assert!(
        !f.window
            .update(cx, |workspace, _, _| workspace.recovery_prompt_open)
            .unwrap()
    );
    assert_eq!(switch_old_catalogue(&f).len(), 2);
}

#[gpui::test]
fn library_switch_stale_recovery_destination_never_writes(cx: &mut TestAppContext) {
    for restore in [false, true] {
        let f = fixture(false, cx);
        let (copy, restored) = switch_copy(&f);
        recovery_begin(&f, restore, cx);
        if restore {
            recovery_source(&copy.path().join("backup"), cx);
        }
        assert!(cx.did_prompt_for_new_path());
        switch_to(&f, &restored, cx);
        let destination = copy.path().join("late-recovery");
        let status = f.state.read_with(cx, |state, _| state.status.clone());
        cx.simulate_new_path_selection(|_| Some(destination.clone()));
        settle(&f.state, cx);
        assert!(!destination.exists());
        f.state.read_with(cx, |state, _| {
            assert_eq!(state.status, status);
            assert!(state.recovery_outcome.is_none());
        });
        assert!(
            !f.window
                .update(cx, |workspace, _, _| workspace.recovery_prompt_open)
                .unwrap()
        );
    }
}

#[gpui::test]
fn library_switch_stale_reader_chooser_never_starts_send_or_eject(cx: &mut TestAppContext) {
    for send in [false, true] {
        let f = fixture(false, cx);
        let (_copy, restored) = switch_copy(&f);
        let device = reader(&f, cx);
        f.window
            .update(cx, |workspace, window, cx| {
                workspace.choose_reader(send, window, cx)
            })
            .unwrap();
        cx.run_until_parked();
        switch_to(&f, &restored, cx);
        let status = f.state.read_with(cx, |state, _| state.status.clone());
        cx.simulate_prompt_answer(&device.name);
        settle(&f.state, cx);
        f.state.read_with(cx, |state, _| {
            assert_eq!(state.status, status);
            assert!(state.send_preview.is_none());
            assert!(state.delivery_report.is_none());
        });
        assert!(f._temp.path().join("Volumes/Kindle").exists());
    }
}

#[gpui::test]
fn library_switch_stale_recovery_consent_never_opens_chooser(cx: &mut TestAppContext) {
    for restore in [false, true] {
        let f = fixture(false, cx);
        let (_copy, restored) = switch_copy(&f);
        recovery_action(&f, restore, cx);
        assert!(cx.has_pending_prompt());
        switch_to(&f, &restored, cx);
        cx.simulate_prompt_answer(if restore {
            "Choose backup"
        } else {
            "Choose location"
        });
        settle(&f.state, cx);
        assert!(!cx.did_prompt_for_paths());
        assert!(!cx.did_prompt_for_new_path());
        assert!(
            !f.window
                .update(cx, |workspace, _, _| workspace.recovery_prompt_open)
                .unwrap()
        );
    }
}

#[gpui::test]
fn library_switch_stale_open_picker_cannot_switch_back(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let (_copy, restored) = switch_copy(&f);
    let old_root = f._temp.path().join("library");
    switch_prompt(&f, cx);
    switch_to(&f, &restored, cx);
    let epoch = f.state.read_with(cx, |state, _| state.library_epoch);
    cx.simulate_path_prompt_response(|_| Some(vec![old_root]));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_epoch, epoch);
        assert_eq!(state.library_root, restored.canonicalize().unwrap());
    });
    assert!(
        !f.window
            .update(cx, |workspace, _, _| workspace.library_picker_open)
            .unwrap()
    );
}
