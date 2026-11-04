use super::library::{switch_prompt, switch_to};
use super::recovery::*;
use super::*;

fn automatic_backup_action(f: &Fixture, cx: &mut TestAppContext) {
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::EnableAutomaticBackups), cx)
        })
        .unwrap();
    cx.run_until_parked();
}

fn automatic_backup_settings_ready(state: &LibraryEntity, cx: &mut TestAppContext) {
    crate::test_support::wait_until("automatic backup settings", || {
        cx.run_until_parked();
        state.read_with(cx, |state, _| state.automatic_backup().ready)
    });
    settle(state, cx);
}

#[gpui::test]
fn native_automatic_backup_enable_reload_mutate_restore_and_disable(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    let restored_output = tempfile::tempdir().unwrap();
    let restored = restored_output.path().join("restored");
    let original_root = f.state.read_with(cx, |state, _| state.library_root());
    automatic_backup_settings_ready(&f.state, cx);
    assert_eq!(
        f.state
            .read_with(cx, |state, _| state.automatic_backup().config.clone()),
        crate::settings::automatic_backup::Config::default()
    );

    // Only the native consent/picker boundary is simulated. Actions, state,
    // worker, settings, SQLite, copying and verification use real implementations.
    automatic_backup_action(&f, cx);
    assert_eq!(
        cx.pending_prompt().unwrap().0,
        "Enable automatic recovery copies?"
    );
    cx.simulate_prompt_answer("Choose existing folder");
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(!options.files && options.directories && !options.multiple);
        Some(vec![output.path().into()])
    });
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    let (backup, config) = f.state.read_with(cx, |state, _| {
        assert!(!state.session().status.as_ref().unwrap().is_error);
        assert!(state.automatic_backup().config.enabled);
        let outcome = state.session().recovery_outcome.as_ref().unwrap();
        assert!(outcome.summary.contains("verified"));
        (
            outcome.path.clone(),
            state.automatic_backup().config.clone(),
        )
    });
    assert_eq!(
        config.destination,
        Some(output.path().canonicalize().unwrap())
    );
    let last_success = config.last_success.unwrap();
    recovery_assert_copied_books(&f, &backup, 0);
    let backup_database = std::fs::read(backup.join("library.sqlite")).unwrap();
    let backup_manifest = std::fs::read(backup.join("manifest.json")).unwrap();

    // A fresh native state must load persisted settings, not inherit the old
    // state's in-memory last_attempt throttle or create another immediate copy.
    let reopened = cx.new(|cx| LibraryState::new(f.engine.clone(), cx));
    automatic_backup_settings_ready(&reopened, cx);
    reopened.update(cx, |state, cx| {
        assert_eq!(state.automatic_backup().config, config);
        assert!(state.automatic_backup().last_attempt.is_none());
        assert!(
            !state
                .automatic_backup()
                .due(last_success + crate::settings::automatic_backup::DAILY_SECONDS - 1)
        );
        state.run_automatic_backup_if_due(
            last_success + crate::settings::automatic_backup::DAILY_SECONDS - 1,
            cx,
        );
        assert!(!state.busy());
        assert!(state.automatic_backup().last_attempt.is_none());
    });
    settle(&reopened, cx);
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
    drop(reopened);

    let updated = f
        .engine
        .request(|reply| Request::Update {
            id: f.books[0].id.clone(),
            patch: takio::library::model::LibraryPatch {
                title: takio::library::model::Patch::Set("Changed after automatic backup".into()),
                ..Default::default()
            },
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(updated.title, "Changed after automatic backup");
    f.state.update(cx, |state, cx| {
        state.select_only(1, cx);
        state.trash_selected(cx);
    });
    settle(&f.state, cx);
    assert_eq!(trash_ids(&f.engine), vec![f.books[1].id.clone()]);
    let mutated = recovery_snapshot(&f);

    recovery_begin(&f, true, cx);
    recovery_source(&backup, cx);
    cx.simulate_new_path_selection(|_| Some(restored.clone()));
    settle(&f.state, cx);
    recovery_no_dialogs(cx);
    f.state.read_with(cx, |state, _| {
        assert!(!state.session().status.as_ref().unwrap().is_error);
        assert_eq!(state.library_root(), original_root);
        assert_eq!(
            state.session().recovery_outcome.as_ref().unwrap().path,
            restored.canonicalize().unwrap()
        );
    });
    assert_eq!(recovery_snapshot(&f), mutated);
    recovery_assert_copied_books(&f, &restored, 0);

    switch_prompt(&f, cx);
    cx.simulate_path_prompt_response(|_| Some(vec![restored.clone()]));
    settle(&f.state, cx);
    automatic_backup_settings_ready(&f.state, cx);
    f.state.update(cx, |state, cx| {
        assert_eq!(state.library_root(), restored.canonicalize().unwrap());
        assert_eq!(state.session().items.len(), f.books.len());
        for original in &f.books {
            let book = state
                .session()
                .items
                .iter()
                .find(|book| book.id == original.id)
                .unwrap();
            assert_eq!(book.title, original.title);
        }
        assert_eq!(
            state.automatic_backup().config,
            crate::settings::automatic_backup::Config::default()
        );
        state.run_automatic_backup_if_due(u64::MAX, cx);
        assert!(!state.busy());
        assert!(state.automatic_backup().last_attempt.is_none());
    });
    assert!(trash_ids(&f.engine).is_empty());
    assert!(!restored.join(".takio-automatic-backup").exists());

    switch_to(&f, &original_root, cx);
    automatic_backup_settings_ready(&f.state, cx);
    assert_eq!(recovery_snapshot(&f), mutated);
    assert_eq!(
        f.state
            .read_with(cx, |state, _| state.automatic_backup().config.clone()),
        config
    );
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::DisableAutomaticBackups), cx)
        })
        .unwrap();
    settle(&f.state, cx);
    f.state.update(cx, |state, cx| {
        assert!(!state.session().status.as_ref().unwrap().is_error);
        assert!(!state.automatic_backup().config.enabled);
        state.run_automatic_backup_if_due(u64::MAX, cx);
        assert!(!state.busy());
    });
    assert!(
        !crate::settings::automatic_backup::load(&original_root)
            .unwrap()
            .enabled
    );
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
    assert_eq!(
        std::fs::read(backup.join("library.sqlite")).unwrap(),
        backup_database
    );
    assert_eq!(
        std::fs::read(backup.join("manifest.json")).unwrap(),
        backup_manifest
    );
    recovery_assert_copied_books(&f, &backup, 0);
    recovery_assert_copied_books(&f, &restored, 0);
    assert_files_unchanged(&f);
    recovery_no_dialogs(cx);
}

fn automatic_backup_due_for_dialog_test(f: &Fixture, cx: &mut TestAppContext) {
    automatic_backup_settings_ready(&f.state, cx);
    f.state.update(cx, |state, _| {
        assert!(state.automatic_backup().ready);
        state.set_test_automatic_backup_config(crate::settings::automatic_backup::Config {
            enabled: true,
            destination: Some(f._temp.path().join("unused")),
            last_success: None,
        });
    });
}

fn automatic_backup_assert_dialog_paused(f: &Fixture, cx: &mut TestAppContext) {
    f.state.update(cx, |state, cx| {
        assert!(!state.automatic_backup().due(1));
        state.run_automatic_backup_if_due(1, cx);
        assert!(!state.busy());
        assert!(state.automatic_backup().last_attempt.is_none());
    });
}

#[gpui::test]
fn native_automatic_backup_defers_through_manual_recovery_dialog_chain(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    automatic_backup_due_for_dialog_test(&f, cx);
    let output = tempfile::tempdir().unwrap();
    for restore in [false, true] {
        recovery_action(&f, restore, cx);
        automatic_backup_assert_dialog_paused(&f, cx);
        cx.simulate_prompt_answer(if restore {
            "Choose backup"
        } else {
            "Choose location"
        });
        cx.run_until_parked();
        automatic_backup_assert_dialog_paused(&f, cx);
        if restore {
            cx.simulate_path_prompt_response(|_| Some(vec![output.path().into()]));
            cx.run_until_parked();
            automatic_backup_assert_dialog_paused(&f, cx);
        }
        cx.simulate_new_path_selection(|_| None);
        settle(&f.state, cx);
        assert!(
            f.state
                .read_with(cx, |state, _| state.automatic_backup().due(1))
        );
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
    }
}

#[gpui::test]
fn native_automatic_backup_defers_for_library_import_move_and_purge_dialogs(
    cx: &mut TestAppContext,
) {
    let f = fixture(true, cx);
    automatic_backup_due_for_dialog_test(&f, cx);
    f.state.update(cx, |state, cx| state.select_only(0, cx));
    for action in 0..4 {
        f.window
            .update(cx, |_, window, cx| match action {
                0 => window.dispatch_action(Box::new(crate::OpenLibrary), cx),
                1 => window.dispatch_action(Box::new(crate::Import), cx),
                2 => window.dispatch_action(Box::new(crate::ImportMove), cx),
                _ => window.dispatch_action(Box::new(crate::PurgeSelected), cx),
            })
            .unwrap();
        cx.run_until_parked();
        automatic_backup_assert_dialog_paused(&f, cx);
        if action == 2 {
            cx.simulate_prompt_answer("Choose files to move");
            cx.run_until_parked();
            automatic_backup_assert_dialog_paused(&f, cx);
        }
        if action == 3 {
            cx.simulate_prompt_answer("Cancel");
        } else {
            cx.simulate_path_prompt_response(|_| None);
        }
        settle(&f.state, cx);
        assert!(
            f.state
                .read_with(cx, |state, _| state.automatic_backup().due(1))
        );
    }
}

#[gpui::test]
fn native_automatic_backup_consent_and_destination_cancel_write_nothing(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let before = recovery_snapshot(&f);
    for accept_explanation in [false, true] {
        automatic_backup_action(&f, cx);
        let (_, detail) = cx.pending_prompt().unwrap();
        for required in [
            "24 hours",
            "while Takio is open",
            "Trash",
            "covers",
            "conversion jobs",
            "NOT included",
            "keep ALL copies",
            "never automatically deletes",
        ] {
            assert!(detail.contains(required), "missing explanation: {required}");
        }
        assert!(
            f.state
                .read_with(cx, |s, _| s.session().automatic_backup_prompt_open
                    && !s.busy())
        );
        cx.simulate_prompt_answer(if accept_explanation {
            "Choose existing folder"
        } else {
            "Cancel"
        });
        cx.run_until_parked();
        if accept_explanation {
            assert!(cx.did_prompt_for_paths());
            cx.simulate_path_prompt_response(|options| {
                assert!(!options.files && options.directories && !options.multiple);
                None
            });
        }
        settle(&f.state, cx);
        assert!(
            !f.state
                .read_with(cx, |s, _| s.automatic_backup().config.enabled
                    || s.session().automatic_backup_prompt_open)
        );
        assert_eq!(recovery_snapshot(&f), before);
        assert!(
            !f._temp
                .path()
                .join("library/.takio-automatic-backup")
                .exists()
        );
    }
}

#[gpui::test]
fn native_automatic_backup_enable_and_disable_keep_verified_copy(cx: &mut TestAppContext) {
    let f = fixture(true, cx);
    let output = tempfile::tempdir().unwrap();
    automatic_backup_action(&f, cx);
    cx.simulate_prompt_answer("Choose existing folder");
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| Some(vec![output.path().into()]));
    settle(&f.state, cx);
    let copy = f.state.read_with(cx, |s, _| {
        assert!(s.automatic_backup().config.enabled);
        s.session().recovery_outcome.as_ref().unwrap().path.clone()
    });
    recovery_assert_copied_books(&f, &copy, 2);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::DisableAutomaticBackups), cx)
        })
        .unwrap();
    settle(&f.state, cx);
    assert!(
        !f.state
            .read_with(cx, |s, _| s.automatic_backup().config.enabled)
    );
    assert!(copy.join("manifest.json").is_file());
    assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 1);
}

#[gpui::test]
fn native_automatic_backup_stale_picker_and_late_edit_do_not_enable(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let output = tempfile::tempdir().unwrap();
    for switch_epoch in [false, true] {
        automatic_backup_action(&f, cx);
        cx.simulate_prompt_answer("Choose existing folder");
        cx.run_until_parked();
        f.state.update(cx, |s, cx| {
            if switch_epoch {
                s.invalidate_test_library();
            } else {
                assert!(s.begin_metadata_editing(cx));
            }
        });
        cx.simulate_path_prompt_response(|_| Some(vec![output.path().into()]));
        settle(&f.state, cx);
        assert!(
            !f.state
                .read_with(cx, |s, _| s.automatic_backup().config.enabled)
        );
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
        assert!(
            !f._temp
                .path()
                .join("library/.takio-automatic-backup")
                .exists()
        );
        f.state.update(cx, |s, cx| s.end_metadata_editing(cx));
    }
}
