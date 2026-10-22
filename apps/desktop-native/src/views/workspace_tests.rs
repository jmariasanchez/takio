//! Native-window safety checks for confirmation and file-picker boundaries.
use super::*;
use crate::engine::{Engine, Filters, Request};
use crate::state::LibraryState;
use gpui::{AppContext, TestAppContext, WindowHandle};
use std::{path::PathBuf, time::Duration};
use takio::{model::LibraryItem, paths::LibraryPaths};

struct Fixture {
    _temp: tempfile::TempDir,
    engine: Engine,
    state: LibraryEntity,
    window: WindowHandle<Workspace>,
    originals: Vec<PathBuf>,
    books: Vec<LibraryItem>,
}

fn settle(state: &LibraryEntity, cx: &mut TestAppContext) {
    for _ in 0..200 {
        cx.run_until_parked();
        if state.read_with(cx, |state, _| {
            !state.loading && !state.busy && !state.refreshing_devices
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("native workspace operation did not settle");
}

fn fixture(trash: bool, cx: &mut TestAppContext) -> Fixture {
    cx.executor().allow_parking();
    cx.update(|cx| cx.set_global(Theme::LIGHT));
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let engine = Engine::open(paths).unwrap();
    let originals = ["Alpha", "Beta"]
        .map(|title| {
            let path = temp.path().join(format!("{title}.epub"));
            std::fs::write(&path, format!("unique fixture contents for {title}")).unwrap();
            path
        })
        .to_vec();
    engine
        .request(|reply| Request::Import {
            roots: originals.clone(),
            mode: ImportMode::Copy,
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    let books = engine
        .request(|reply| Request::Query {
            query: String::new(),
            filters: Filters::default(),
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(books.len(), 2);
    if trash {
        engine
            .request(|reply| Request::Trash {
                ids: books.iter().map(|book| book.id.clone()).collect(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
    }
    let state = cx.new(|cx| LibraryState::new(engine.clone(), cx));
    settle(&state, cx);
    if trash {
        state.update(cx, |state, cx| state.set_section(Section::Trash, cx));
        settle(&state, cx);
    }
    state.update(cx, |state, _| {
        state.selected.insert(0);
        state.anchor = Some(0);
    });
    let window = cx.add_window(|window, cx| Workspace::new(state.clone(), window, cx));
    cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    Fixture {
        _temp: temp,
        engine,
        state,
        window,
        originals,
        books,
    }
}

fn trash_ids(engine: &Engine) -> Vec<String> {
    engine
        .request(|reply| Request::ListTrash { reply })
        .recv()
        .unwrap()
        .unwrap()
        .into_iter()
        .map(|book| book.id)
        .collect()
}

fn assert_files_unchanged(f: &Fixture) {
    assert!(f.originals.iter().all(|path| path.exists()));
    assert!(f.books.iter().all(|book| {
        book.formats
            .iter()
            .all(|format| format.source_path.exists())
    }));
}

#[gpui::test]
fn purge_action_cancel_keeps_managed_files_and_trash(cx: &mut TestAppContext) {
    let f = fixture(true, cx);
    let before = trash_ids(&f.engine);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(PurgeSelected), cx)
        })
        .unwrap();
    cx.run_until_parked();
    let (message, detail) = cx.pending_prompt().expect("purge must ask before deleting");
    assert!(message.contains("Permanently delete 1 book"));
    assert!(detail.contains("cannot be undone"));
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    assert_eq!(trash_ids(&f.engine), before);
    assert_files_unchanged(&f);
    assert!(!cx.has_pending_prompt());
}

#[gpui::test]
fn purge_approval_uses_captured_ids_not_changed_selection(cx: &mut TestAppContext) {
    let f = fixture(true, cx);
    let (chosen, other) = f.state.read_with(cx, |state, _| {
        (state.items[0].clone(), state.items[1].clone())
    });
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(PurgeSelected), cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.has_pending_prompt());
    f.state.update(cx, |state, _| {
        state.selected.clear();
        state.selected.insert(1);
        state.anchor = Some(1);
    });
    cx.simulate_prompt_answer("Delete permanently");
    settle(&f.state, cx);
    assert_eq!(trash_ids(&f.engine), vec![other.id]);
    assert!(
        chosen
            .formats
            .iter()
            .all(|format| !format.source_path.exists())
    );
    assert!(
        other
            .formats
            .iter()
            .all(|format| format.source_path.exists())
    );
    assert!(f.originals.iter().all(|path| path.exists()));
}

#[gpui::test]
fn move_warning_cancel_never_opens_picker_or_imports(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    assert!(!cx.did_prompt_for_paths());
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ImportMove), cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.pending_prompt().unwrap().0.contains("Move originals"));
    assert!(!cx.did_prompt_for_paths());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_paths());
    assert!(!cx.has_pending_prompt());
    assert_eq!(f.state.read_with(cx, |state, _| state.items.len()), 2);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn copy_picker_cancel_keeps_library_and_originals(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(Import), cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert!(!cx.has_pending_prompt());
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(options.files && options.directories && options.multiple);
        None
    });
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_paths());
    assert_eq!(f.state.read_with(cx, |state, _| state.items.len()), 2);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn approved_move_still_allows_picker_cancel(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ImportMove), cx)
        })
        .unwrap();
    cx.run_until_parked();
    cx.simulate_prompt_answer("Choose files to move");
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|_| None);
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_paths());
    assert_eq!(f.state.read_with(cx, |state, _| state.items.len()), 2);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn metadata_editor_saves_through_window_and_blocks_library_delete(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let original = f.state.read_with(cx, |state, _| state.items[0].clone());
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::EditSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(f.state.read_with(cx, |state, _| state.metadata_editing));
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(TrashSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(trash_ids(&f.engine).is_empty());
    cx.simulate_keystrokes(f.window.into(), "cmd-a");
    cx.simulate_input(f.window.into(), "Edited title");
    cx.simulate_keystrokes(f.window.into(), "cmd-s");
    settle(&f.state, cx);
    assert!(!f.state.read_with(cx, |state, _| state.metadata_editing));
    let books = f
        .engine
        .request(|reply| Request::Query {
            query: String::new(),
            filters: Filters::default(),
            reply,
        })
        .recv()
        .unwrap()
        .unwrap();
    let edited = books.iter().find(|book| book.id == original.id).unwrap();
    assert_eq!(edited.title, "Edited title");
    assert_eq!(
        edited.formats[0].source_path,
        original.formats[0].source_path
    );
    assert_files_unchanged(&f);
}

fn reader(f: &Fixture, cx: &mut TestAppContext) -> takio::destinations::Destination {
    let volumes = f._temp.path().join("Volumes");
    let mount = volumes.join("Kindle");
    for directory in ["documents", "system", "koreader"] {
        std::fs::create_dir_all(mount.join(directory)).unwrap();
    }
    let reader = takio::destinations::authorize(&mount, &volumes).unwrap();
    f.state.update(cx, |state, cx| {
        state.destinations = vec![reader.clone()];
        cx.notify();
    });
    reader
}

#[gpui::test]
fn send_chooser_uses_ids_captured_before_selection_changes(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    let chosen = f.state.read_with(cx, |state, _| state.items[0].clone());
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::SendSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(
        cx.pending_prompt()
            .unwrap()
            .0
            .contains("Send 1 selected book")
    );
    f.state.update(cx, |state, _| {
        state.selected.clear();
        state.selected.insert(1);
        state.anchor = Some(1);
    });
    cx.simulate_prompt_answer(&reader.name);
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        let report = state.delivery_report.as_ref().unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].item_id, chosen.id);
        let delivery = report.entries[0].result.as_ref().unwrap();
        assert_eq!(
            std::fs::read(&delivery.path).unwrap(),
            std::fs::read(&chosen.formats[0].source_path).unwrap()
        );
    });
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        1
    );
    assert_files_unchanged(&f);
}

#[gpui::test]
fn send_chooser_cancel_writes_nothing(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::SendSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.has_pending_prompt());
    cx.simulate_prompt_answer("Cancel");
    settle(&f.state, cx);
    assert!(
        f.state
            .read_with(cx, |state, _| state.delivery_report.is_none())
    );
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        0
    );
    assert_files_unchanged(&f);
}

#[gpui::test]
fn send_without_devices_explains_how_to_connect(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    f.state.update(cx, |state, _| state.destinations.clear());
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::SendSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(!cx.has_pending_prompt());
    f.state.read_with(cx, |state, _| {
        let status = &state.status.as_ref().unwrap().text;
        assert!(status.contains("Connect a USB reader"));
        assert!(status.contains("Refresh readers"));
        assert!(state.delivery_report.is_none());
    });
}

#[gpui::test]
fn send_action_while_metadata_editing_never_prompts(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::EditSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(f.state.read_with(cx, |state, _| state.metadata_editing));
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::SendSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(!cx.has_pending_prompt());
    assert!(
        f.state
            .read_with(cx, |state, _| state.delivery_report.is_none())
    );
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        0
    );
}

#[gpui::test]
fn copy_picker_import_preserves_original_and_supports_search_edit(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let original = f._temp.path().join("PickerImported.epub");
    std::fs::write(
        &original,
        b"unique bytes selected through the native import picker",
    )
    .unwrap();
    let fingerprint = takio::fingerprint::hash_file(&original).unwrap();
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(Import), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(options.files && options.multiple);
        Some(vec![original.clone()])
    });
    settle(&f.state, cx);
    assert!(!cx.did_prompt_for_paths());
    let imported = f.state.read_with(cx, |state, _| {
        assert_eq!(state.items.len(), 3);
        state
            .items
            .iter()
            .find(|item| item.title == "PickerImported")
            .unwrap()
            .clone()
    });
    let managed = &imported.formats[0];
    assert_eq!(managed.provenance, takio::model::Provenance::Managed);
    assert_ne!(managed.source_path, original);
    assert!(
        managed
            .source_path
            .canonicalize()
            .unwrap()
            .starts_with(f._temp.path().join("library/items").canonicalize().unwrap())
    );
    assert_eq!(
        takio::fingerprint::hash_file(&managed.source_path).unwrap(),
        fingerprint
    );
    assert_eq!(
        takio::fingerprint::hash_file(&original).unwrap(),
        fingerprint
    );

    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::FocusSearch), cx);
        })
        .unwrap();
    cx.run_until_parked();
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    cx.simulate_input(f.window.into(), "PickerImported");
    cx.executor().advance_clock(Duration::from_millis(100));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.query, "PickerImported");
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.items[0].id, imported.id);
    });
    f.window
        .update(cx, |workspace, window, cx| {
            window.focus(&workspace.focus, cx);
            window.dispatch_action(Box::new(crate::SelectNext), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert_eq!(
        f.state.read_with(cx, |state, _| state.selected_ids()),
        vec![imported.id.clone()]
    );
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::EditSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    cx.simulate_keystrokes(f.window.into(), "cmd-a");
    cx.simulate_input(f.window.into(), "PickerImported edited");
    cx.simulate_keystrokes(f.window.into(), "cmd-s");
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert!(!state.metadata_editing);
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.items[0].id, imported.id);
        assert_eq!(state.items[0].title, "PickerImported edited");
    });
    assert_eq!(
        takio::fingerprint::hash_file(&original).unwrap(),
        fingerprint
    );
    assert_eq!(
        takio::fingerprint::hash_file(&managed.source_path).unwrap(),
        fingerprint
    );
    assert_files_unchanged(&f);
}
