use super::*;
use gpui::{TestAppContext, WindowHandle};
use std::fs;
use takio::store::LibraryStore;

struct Fixture {
    _temp: tempfile::TempDir,
    paths: LibraryPaths,
    preference: PathBuf,
    view: Entity<StartupWindow>,
    window: WindowHandle<StartupWindow>,
}

fn settle(view: &Entity<StartupWindow>, cx: &mut TestAppContext) {
    crate::test_support::wait_until("startup recovery", || {
        cx.run_until_parked();
        view.read_with(cx, |view, _| !view.busy)
    });
}

fn fixture(cx: &mut TestAppContext) -> Fixture {
    cx.executor().allow_parking();
    cx.update(|cx| cx.set_global(Theme::LIGHT));
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("broken/library.sqlite"))).unwrap();
    fs::create_dir(&paths.root).unwrap();
    fs::write(&paths.database, b"corrupt original catalogue").unwrap();
    let preference = temp.path().join("profile/last-library");
    let window = cx.add_window(|window, cx| {
        StartupWindow::new(paths.clone(), Some(preference.clone()), window, cx)
    });
    let view = window.update(cx, |_, _, cx| cx.entity()).unwrap();
    settle(&view, cx);
    cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    assert!(view.read_with(cx, |view, _| view.workspace.is_none()));
    Fixture {
        _temp: temp,
        paths,
        preference,
        view,
        window,
    }
}

fn original_unchanged(f: &Fixture) {
    assert_eq!(
        fs::read(&f.paths.database).unwrap(),
        b"corrupt original catalogue"
    );
    assert_eq!(fs::read_dir(&f.paths.root).unwrap().count(), 1);
}

fn begin(f: &Fixture, restore: bool, cx: &mut TestAppContext) {
    f.window
        .update(cx, |_, window, cx| {
            if restore {
                window.dispatch_action(Box::new(crate::RestoreBackupCopy), cx);
            } else {
                window.dispatch_action(Box::new(crate::OpenLibrary), cx);
            }
        })
        .unwrap();
    cx.run_until_parked();
}

fn backup(f: &Fixture) -> PathBuf {
    let paths =
        LibraryPaths::resolve(None, Some(&f._temp.path().join("good/library.sqlite"))).unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let source = f._temp.path().join("source.epub");
    fs::write(&source, b"recovery source book").unwrap();
    store
        .import(&source, Some("Recovered title"), false)
        .unwrap();
    let backup = f._temp.path().join("backup");
    store.backup(&backup).unwrap();
    backup
}

#[gpui::test]
fn corrupt_default_has_recovery_choices_and_every_cancel_is_read_only(cx: &mut TestAppContext) {
    let f = fixture(cx);
    f.view.read_with(cx, |view, _| {
        assert!(!view.busy);
        assert!(
            view.message
                .starts_with("Operation failed: Opening your library...")
        );
        assert!(view.message.contains("The library could not be read"));
    });
    assert!(f.view.update(cx, |view, cx| view.can_close(cx)));
    assert!(!f.preference.exists());
    original_unchanged(&f);

    begin(&f, false, cx);
    assert!(cx.did_prompt_for_paths());
    assert!(!f.view.update(cx, |view, cx| view.can_close(cx)));
    // Repeated controls cannot open a second dialog or start an operation.
    begin(&f, true, cx);
    assert!(!cx.has_pending_prompt());
    cx.simulate_path_prompt_response(|_| None);
    settle(&f.view, cx);

    begin(&f, true, cx);
    cx.simulate_prompt_answer("Cancel");
    settle(&f.view, cx);
    assert!(!cx.did_prompt_for_paths());

    begin(&f, true, cx);
    cx.simulate_prompt_answer("Choose backup");
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| None);
    settle(&f.view, cx);
    assert!(!cx.did_prompt_for_new_path());

    let source = backup(&f);
    let before = fs::read(source.join("library.sqlite")).unwrap();
    begin(&f, true, cx);
    cx.simulate_prompt_answer("Choose backup");
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| Some(vec![source.clone()]));
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection(|_| None);
    settle(&f.view, cx);
    original_unchanged(&f);
    assert!(!f.preference.exists());
    assert_eq!(fs::read(source.join("library.sqlite")).unwrap(), before);
    assert!(f.view.read_with(cx, |view, _| view.workspace.is_none()));
}

#[gpui::test]
fn startup_open_existing_activates_only_valid_choice_and_remembers_it(cx: &mut TestAppContext) {
    let f = fixture(cx);
    begin(&f, false, cx);
    let missing = f._temp.path().join("missing");
    cx.simulate_path_prompt_response(|_| Some(vec![missing.clone()]));
    settle(&f.view, cx);
    assert!(!missing.exists());
    assert!(!f.preference.exists());
    assert!(f.view.read_with(cx, |view, _| view.workspace.is_none()));
    assert!(f.view.read_with(cx, |view, _| {
        view.message
            .starts_with(&format!("Operation failed: Opening {}", missing.display()))
    }));
    backup(&f);
    let good = f._temp.path().join("good");
    begin(&f, false, cx);
    cx.simulate_path_prompt_response(|_| Some(vec![good.clone()]));
    settle(&f.view, cx);
    assert!(f.view.read_with(cx, |view, _| view.workspace.is_some()));
    assert_eq!(
        crate::preferences::load(&f.preference).unwrap(),
        Some(good.canonicalize().unwrap())
    );
    original_unchanged(&f);
    let (engine, warning) = startup::open(f.paths.clone(), Some(&f.preference)).unwrap();
    assert_eq!(engine.root(), good.canonicalize().unwrap());
    assert!(warning.warning.is_none());
}

#[gpui::test]
fn startup_restore_opens_verified_new_copy_without_changing_original_or_backup(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    let source = backup(&f);
    let before = fs::read(source.join("library.sqlite")).unwrap();
    let destination = f._temp.path().join("restored");
    begin(&f, true, cx);
    cx.simulate_prompt_answer("Choose backup");
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| Some(vec![source.clone()]));
    cx.run_until_parked();
    cx.simulate_new_path_selection(|_| Some(destination.clone()));
    settle(&f.view, cx);
    assert!(f.view.read_with(cx, |view, _| view.workspace.is_some()));
    assert_eq!(
        crate::preferences::load(&f.preference).unwrap(),
        Some(destination.canonicalize().unwrap())
    );
    let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite"))).unwrap();
    let restored = LibraryStore::open_read_only(paths).unwrap();
    assert_eq!(restored.verify().unwrap().verified_managed_formats, 1);
    assert_eq!(restored.list(false).unwrap()[0].title, "Recovered title");
    assert_eq!(fs::read(source.join("library.sqlite")).unwrap(), before);
    original_unchanged(&f);
}

#[gpui::test]
fn startup_restore_collision_and_bad_backup_keep_recovery_screen_usable(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let source = backup(&f);
    let existing = f._temp.path().join("existing");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("marker"), b"keep").unwrap();
    for destination in [existing.clone(), f._temp.path().join("bad-copy")] {
        if destination != existing {
            fs::write(source.join("manifest.json"), b"invalid").unwrap();
        }
        begin(&f, true, cx);
        cx.simulate_prompt_answer("Choose backup");
        cx.run_until_parked();
        cx.simulate_path_prompt_response(|_| Some(vec![source.clone()]));
        cx.run_until_parked();
        cx.simulate_new_path_selection(|_| Some(destination.clone()));
        settle(&f.view, cx);
        assert!(f.view.read_with(cx, |view, _| view.workspace.is_none()));
        assert!(f.view.update(cx, |view, cx| view.can_close(cx)));
        original_unchanged(&f);
        assert!(!f.preference.exists());
    }
    assert_eq!(fs::read(existing.join("marker")).unwrap(), b"keep");
    assert!(!f._temp.path().join("bad-copy").exists());
}

#[gpui::test]
fn startup_recovery_keyboard_shortcut_and_tab_activation_work_without_workspace(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    cx.update(|cx| {
        cx.bind_keys([gpui::KeyBinding::new(
            "cmd-shift-o",
            crate::OpenLibrary,
            None,
        )])
    });
    cx.simulate_keystrokes(f.window.into(), "cmd-shift-o");
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| None);
    settle(&f.view, cx);
    cx.update_window(f.window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.blur(cx);
        window.focus_next(cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    let mut visual = gpui::VisualTestContext::from_window(f.window.into(), cx);
    visual.simulate_keystrokes("enter");
    assert!(!cx.did_prompt_for_paths());
    visual.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| None);
    settle(&f.view, cx);
    original_unchanged(&f);
    assert!(!f.preference.exists());
}
