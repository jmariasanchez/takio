use super::preparation::{preparation_channel, preparation_review};
use super::*;

fn automatic_ready(f: &Fixture, cx: &mut TestAppContext) {
    crate::test_support::wait_until("automatic backup settings", || {
        cx.run_until_parked();
        f.state.read_with(cx, |s, _| s.automatic_backup.ready)
    });
}

#[gpui::test]
fn stale_backup_configuration_reply_releases_busy(cx: &mut TestAppContext) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let requests = preparation_channel(&f, cx);
    f.state
        .update(cx, |s, cx| s.configure_automatic_backup(None, cx));
    let Request::AutomaticBackupConfigure { reply, .. } = requests.recv().unwrap() else {
        panic!("expected configuration request");
    };
    f.state.update(cx, |s, _| s.automatic_backup.revision += 1);
    reply
        .send(Ok(crate::settings::automatic_backup::Config::default()))
        .unwrap();
    settle(&f.state, cx);
    assert!(f.state.read_with(cx, |s, _| s.can_mutate()));
}

#[gpui::test]
fn automatic_backup_state_opt_in_roundtrip_disable_and_daily_clock(cx: &mut TestAppContext) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    assert!(
        !f.state
            .read_with(cx, |s, _| s.automatic_backup.config.enabled)
    );
    assert!(!f._temp.path().join(".takio-automatic-backup").exists());
    f.state.update(cx, |s, cx| {
        s.select_only(0, cx);
        s.trash_selected(cx);
    });
    settle(&f.state, cx);
    let output = tempfile::tempdir().unwrap();
    f.state.update(cx, |s, cx| {
        s.configure_automatic_backup(Some(output.path().into()), cx)
    });
    settle(&f.state, cx);
    let (backup, last) = f.state.read_with(cx, |s, _| {
        (
            s.session().recovery_outcome.as_ref().unwrap().path.clone(),
            s.automatic_backup.config.last_success.unwrap(),
        )
    });
    let restored = output.path().join("restored");
    f.state.update(cx, |s, cx| {
        s.restore_backup_copy(backup, restored.clone(), cx)
    });
    settle(&f.state, cx);
    let recovered = takio::library::store::LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&restored.join("library.sqlite"))).unwrap(),
    )
    .unwrap();
    assert_eq!(recovered.verify().unwrap().trashed_items, 1);
    for book in recovered.list(true).unwrap() {
        assert_eq!(
            fs::read(&book.source_path).unwrap(),
            fs::read(f._temp.path().join(format!("{}.epub", book.title))).unwrap()
        );
    }
    f.state.update(cx, |s, cx| {
        s.check_automatic_backup(
            last + crate::settings::automatic_backup::DAILY_SECONDS - 1,
            cx,
        );
        assert!(!s.busy());
        assert!(s.request_close(cx));
        s.check_automatic_backup(last + crate::settings::automatic_backup::DAILY_SECONDS, cx);
        assert!(s.busy());
        assert!(!s.request_close(cx));
    });
    settle(&f.state, cx);
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 3);
    f.state
        .update(cx, |s, cx| s.configure_automatic_backup(None, cx));
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| {
        s.check_automatic_backup(u64::MAX, cx);
        assert!(!s.busy());
    });
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 3);
    assert!(
        !crate::settings::automatic_backup::load(f._temp.path())
            .unwrap()
            .enabled
    );
}

#[gpui::test]
fn automatic_backup_state_defers_for_edits_reviews_busy_loading_and_switch(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let requests = preparation_channel(&f, cx);
    f.state.update(cx, |s, cx| {
        s.automatic_backup.config = crate::settings::automatic_backup::Config {
            enabled: true,
            destination: Some(PathBuf::from("/unused")),
            last_success: None,
        };
        for blocked in 0..8 {
            s.session.activity = match blocked {
                0 => Activity::Running(Operation::Mutation),
                3 => Activity::SwitchingLibrary,
                5 => Activity::Running(Operation::PreviewingPreparation),
                7 => {
                    Activity::ReviewingPreparation(preparation_review(&s.session().items[0], true))
                }
                _ => Activity::Idle,
            };
            s.session.metadata_editing = blocked == 1;
            s.session.loading = blocked == 2;
            s.refreshing_destinations = blocked == 4;
            s.session.automatic_backup_prompt_open = blocked == 6;
            s.check_automatic_backup(10, cx);
            assert!(s.automatic_backup.last_attempt.is_none());
        }
        s.session.activity = Activity::Idle;
        s.check_automatic_backup(10, cx);
        assert!(s.busy());
        assert!(!s.can_mutate());
        assert!(!s.request_close(cx));
    });
    match requests.try_recv().unwrap() {
        Request::AutomaticBackupRun { now: 10, reply, .. } => reply
            .send(Err(takio::app_error!(
                "automatic-backup-destination-unavailable",
            )))
            .unwrap(),
        _ => panic!("only a single automatic backup should run"),
    }
    assert!(requests.try_recv().is_err());
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| {
        assert!(s.session().status.as_ref().unwrap().is_error);
        assert!(
            s.session()
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("one hour")
        );
        s.check_automatic_backup(
            10 + crate::settings::automatic_backup::FAILURE_RETRY_SECONDS - 1,
            cx,
        );
        assert!(!s.busy());
        s.check_automatic_backup(
            10 + crate::settings::automatic_backup::FAILURE_RETRY_SECONDS,
            cx,
        );
        assert!(s.busy());
    });
    match requests.try_recv().unwrap() {
        Request::AutomaticBackupRun { reply, .. } => reply
            .send(Err(takio::app_error!(
                "automatic-backup-destination-unavailable"
            )))
            .unwrap(),
        _ => panic!("expected throttled retry"),
    }
    settle(&f.state, cx);
}

#[gpui::test]
fn automatic_backup_state_switch_cancels_old_config_and_restored_library_defaults_off(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let output = tempfile::tempdir().unwrap();
    f.state.update(cx, |s, cx| {
        s.configure_automatic_backup(Some(output.path().into()), cx)
    });
    settle(&f.state, cx);
    let backup = f.state.read_with(cx, |s, _| {
        s.session().recovery_outcome.as_ref().unwrap().path.clone()
    });
    let restored = output.path().join("restored");
    f.state.update(cx, |s, cx| {
        s.restore_backup_copy(backup, restored.clone(), cx)
    });
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| s.open_library(restored, cx));
    settle(&f.state, cx);
    automatic_ready(&f, cx);
    f.state.update(cx, |s, cx| {
        assert_eq!(s.library_epoch, 1);
        assert!(!s.automatic_backup.config.enabled);
        assert!(s.automatic_backup.last_attempt.is_none());
        s.check_automatic_backup(u64::MAX, cx);
        assert!(!s.busy());
    });
    cx.executor().advance_clock(Duration::from_secs(60));
    settle(&f.state, cx);
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 2);
}

#[gpui::test]
fn automatic_backup_state_disable_save_failure_still_stops_session(cx: &mut TestAppContext) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let requests = preparation_channel(&f, cx);
    f.state.update(cx, |s, cx| {
        s.automatic_backup.config.enabled = true;
        s.automatic_backup.config.destination = Some(PathBuf::from("/unused"));
        s.configure_automatic_backup(None, cx);
        assert!(!s.automatic_backup.config.enabled);
    });
    match requests.try_recv().unwrap() {
        Request::AutomaticBackupConfigure {
            destination: None,
            reply,
        } => reply
            .send(Err(takio::app_error!("storage-unavailable")))
            .unwrap(),
        _ => panic!("expected disable settings request"),
    }
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| {
        assert!(
            s.session()
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("previous setting may return")
        );
        s.check_automatic_backup(u64::MAX, cx);
        assert!(!s.busy());
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn automatic_backup_state_keeps_success_and_daily_throttle_when_timestamp_save_fails(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let output = tempfile::tempdir().unwrap();
    let parent = output.path().join("copies");
    fs::create_dir(&parent).unwrap();
    let config =
        crate::settings::automatic_backup::configure(f._temp.path(), Some(parent)).unwrap();
    let settings = f._temp.path().join(".takio-automatic-backup");
    fs::remove_file(&settings).unwrap();
    fs::create_dir(&settings).unwrap();
    f.state.update(cx, |s, cx| {
        s.automatic_backup.config = config;
        s.check_automatic_backup(100, cx);
    });
    settle(&f.state, cx);
    let backup = f.state.update(cx, |s, cx| {
        assert!(s.session().status.as_ref().unwrap().is_error);
        assert!(
            s.session()
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("Copy kept")
        );
        assert_eq!(s.automatic_backup.config.last_success, Some(100));
        s.check_automatic_backup(
            100 + crate::settings::automatic_backup::FAILURE_RETRY_SECONDS,
            cx,
        );
        assert!(!s.busy());
        s.session().recovery_outcome.as_ref().unwrap().path.clone()
    });
    assert!(backup.join("manifest.json").is_file());
    let restored = output.path().join("restored");
    f.state.update(cx, |s, cx| {
        s.restore_backup_copy(backup, restored.clone(), cx)
    });
    settle(&f.state, cx);
    assert!(restored.join("library.sqlite").is_file());
    assert!(settings.is_dir());
}

#[gpui::test]
fn automatic_backup_state_stale_settings_load_cannot_replace_new_library_config(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let requests = preparation_channel(&f, cx);
    f.state
        .update(cx, |s, cx| s.initialize_automatic_backup(cx));
    let reply = match requests.try_recv().unwrap() {
        Request::AutomaticBackupLoad { reply } => reply,
        _ => panic!("expected settings load"),
    };
    f.state.update(cx, |s, _| {
        s.library_epoch += 1;
        s.automatic_backup = crate::settings::automatic_backup::Schedule::default();
    });
    reply
        .send(Ok(crate::settings::automatic_backup::Config {
            enabled: true,
            destination: Some(PathBuf::from("/unused-old-destination")),
            last_success: None,
        }))
        .unwrap();
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert!(!s.automatic_backup.config.enabled);
        assert!(s.automatic_backup_timer.is_none());
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn automatic_backup_state_bad_settings_remain_disabled_and_visible_without_rewrite(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    automatic_ready(&f, cx);
    let settings = f._temp.path().join(".takio-automatic-backup");
    fs::write(&settings, b"invalid settings marker").unwrap();
    f.state
        .update(cx, |s, cx| s.initialize_automatic_backup(cx));
    automatic_ready(&f, cx);
    f.state.update(cx, |s, cx| {
        assert!(!s.automatic_backup.config.enabled);
        assert!(s.session().status.as_ref().unwrap().is_error);
        assert!(
            s.session()
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("settings could not be read")
        );
        s.check_automatic_backup(u64::MAX, cx);
        assert!(!s.busy());
        assert!(s.request_close(cx));
    });
    assert_eq!(fs::read(settings).unwrap(), b"invalid settings marker");
}
