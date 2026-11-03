fn automatic_backup_action(f: &Fixture, cx: &mut TestAppContext) {
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::EnableAutomaticBackups), cx)
        })
        .unwrap();
    cx.run_until_parked();
}

fn automatic_backup_due_for_dialog_test(f: &Fixture, cx: &mut TestAppContext) {
    for _ in 0..200 {
        cx.run_until_parked();
        if f.state
            .read_with(cx, |state, _| state.automatic_backup.ready)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    f.state.update(cx, |state, _| {
        assert!(state.automatic_backup.ready);
        state.automatic_backup.config = crate::automatic_backup::Config {
            enabled: true,
            destination: Some(f._temp.path().join("unused")),
            last_success: None,
        };
    });
}

fn automatic_backup_assert_dialog_paused(f: &Fixture, cx: &mut TestAppContext) {
    f.state.update(cx, |state, cx| {
        assert!(!state.automatic_backup.due(1));
        state.check_automatic_backup(1, cx);
        assert!(!state.busy);
        assert!(state.automatic_backup.last_attempt.is_none());
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
                .read_with(cx, |state, _| state.automatic_backup.due(1))
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
                .read_with(cx, |state, _| state.automatic_backup.due(1))
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
                .read_with(cx, |s, _| s.automatic_backup_prompt_open && !s.busy)
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
                .read_with(cx, |s, _| s.automatic_backup.config.enabled
                    || s.automatic_backup_prompt_open)
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
        assert!(s.automatic_backup.config.enabled);
        s.recovery_outcome.as_ref().unwrap().path.clone()
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
            .read_with(cx, |s, _| s.automatic_backup.config.enabled)
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
        f.state.update(cx, |s, _| {
            if switch_epoch {
                s.library_epoch += 1;
            } else {
                s.metadata_editing = true;
            }
        });
        cx.simulate_path_prompt_response(|_| Some(vec![output.path().into()]));
        settle(&f.state, cx);
        assert!(
            !f.state
                .read_with(cx, |s, _| s.automatic_backup.config.enabled)
        );
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
        assert!(
            !f._temp
                .path()
                .join("library/.takio-automatic-backup")
                .exists()
        );
        f.state.update(cx, |s, _| s.metadata_editing = false);
    }
}
