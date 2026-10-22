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
    assert_eq!(trash_ids(&f.engine), vec![other.id.clone()]);
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
        let preview = state.send_preview.as_ref().unwrap();
        assert_eq!(preview.ready_ids(), vec![chosen.id.clone()]);
        assert!(state.delivery_report.is_none());
    });
    assert_reader_untouched(&reader);
    confirm_send(&f, cx);
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

fn assert_reader_untouched(reader: &takio::destinations::Destination) {
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        0
    );
    assert!(!reader.path.join(".takio").exists());
}

#[cfg(debug_assertions)]
fn click_control(f: &Fixture, selector: &'static str, cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.update_window(f.window.into(), |_, window, cx| window.draw(cx).clear(cx))
        .unwrap();
    let mut visual = gpui::VisualTestContext::from_window(f.window.into(), cx);
    let bounds = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing rendered control: {selector}"));
    assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
    visual.simulate_click(bounds.center(), gpui::Modifiers::none());
    settle(&f.state, cx);
}

#[cfg(debug_assertions)]
#[gpui::test]
fn sidebar_pointer_review_cancel_writes_nothing(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    let chosen = f.state.read_with(cx, |state, _| state.selected_ids());
    let before: Vec<_> = f
        .originals
        .iter()
        .chain(f.books.iter().map(|book| &book.source_path))
        .map(|path| (path.clone(), std::fs::read(path).unwrap()))
        .collect();

    click_control(&f, "send-device", cx);
    assert!(!cx.has_pending_prompt());
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.send_preview.as_ref().unwrap().ready_ids(), chosen);
        assert!(state.delivery_report.is_none());
    });
    assert_reader_untouched(&reader);

    click_control(&f, "cancel-send-review", cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        assert!(state.delivery_report.is_none());
        assert!(state.delivery_exclusions.is_empty());
        assert!(state.can_mutate());
    });
    assert_reader_untouched(&reader);
    for (path, bytes) in before {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[cfg(debug_assertions)]
#[gpui::test]
fn sidebar_pointer_send_ready_uses_reviewed_selection(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    let chosen = f.state.read_with(cx, |state, _| state.items[0].clone());
    let original_bytes = std::fs::read(&f.originals[0]).unwrap();
    let managed_bytes = std::fs::read(&chosen.source_path).unwrap();

    click_control(&f, "send-device", cx);
    assert!(!cx.has_pending_prompt());
    f.state.read_with(cx, |state, _| {
        assert_eq!(
            state.send_preview.as_ref().unwrap().ready_ids(),
            vec![chosen.id.clone()]
        );
        assert!(state.delivery_report.is_none());
    });
    assert_reader_untouched(&reader);
    f.state.update(cx, |state, cx| state.select_only(1, cx));

    click_control(&f, "confirm-send-review", cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        let report = state.delivery_report.as_ref().unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].item_id, chosen.id);
        let delivered = report.entries[0].result.as_ref().unwrap();
        assert_eq!(std::fs::read(&delivered.path).unwrap(), managed_bytes);
    });
    let inventory = takio::destinations::inventory(&reader).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].record.item_id, chosen.id);
    assert_eq!(inventory[0].status, "present");
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(std::fs::read(&chosen.source_path).unwrap(), managed_bytes);
    assert_eq!(std::fs::read(&f.originals[0]).unwrap(), original_bytes);
    assert_files_unchanged(&f);
}

fn preview_selected(
    f: &Fixture,
    reader: &takio::destinations::Destination,
    cx: &mut TestAppContext,
) {
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::SendSelected), cx);
        })
        .unwrap();
    cx.run_until_parked();
    assert!(cx.has_pending_prompt());
    cx.simulate_prompt_answer(&reader.name);
    settle(&f.state, cx);
    assert!(
        f.state
            .read_with(cx, |state, _| state.send_preview.is_some())
    );
    assert_reader_untouched(reader);
}

fn confirm_send(f: &Fixture, cx: &mut TestAppContext) {
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::ConfirmSend), cx);
        })
        .unwrap();
    settle(&f.state, cx);
}

#[gpui::test]
fn cancel_send_review_and_later_confirm_write_nothing(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    preview_selected(&f, &reader, cx);
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::CancelSend), cx);
        })
        .unwrap();
    settle(&f.state, cx);
    confirm_send(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        assert!(state.delivery_report.is_none());
        assert!(state.delivery_exclusions.is_empty());
    });
    assert_reader_untouched(&reader);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn cancel_send_while_preview_is_pending_discards_reply(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    f.state
        .update(cx, |state, cx| state.send_selected_to(reader.clone(), cx));
    assert!(f.state.read_with(cx, |state, _| state.busy));
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::CancelSend), cx);
        })
        .unwrap();
    settle(&f.state, cx);
    confirm_send(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        assert!(state.delivery_report.is_none());
    });
    assert_reader_untouched(&reader);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn mixed_send_review_confirms_only_ready_ids_and_retains_exclusions(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    let (ready, blocked) = f.state.read_with(cx, |state, _| {
        (state.items[0].clone(), state.items[1].clone())
    });
    std::fs::remove_file(&blocked.formats[0].source_path).unwrap();
    f.state.update(cx, |state, _| {
        state.selected.insert(1);
    });
    preview_selected(&f, &reader, cx);
    f.state.read_with(cx, |state, _| {
        let preview = state.send_preview.as_ref().unwrap();
        assert_eq!(preview.entries.len(), 2);
        assert_eq!(preview.ready_ids(), vec![ready.id.clone()]);
        assert_eq!(
            preview.entries[1].result.as_ref().unwrap_err(),
            "source-unavailable"
        );
    });
    confirm_send(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        let report = state.delivery_report.as_ref().unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].item_id, ready.id);
        assert!(report.entries[0].result.is_ok());
        assert_eq!(state.delivery_exclusions.len(), 1);
        assert_eq!(state.delivery_exclusions[0].item_id, blocked.id);
        assert_eq!(
            state.delivery_exclusions[0].result.as_ref().unwrap_err(),
            "source-unavailable"
        );
    });
    let inventory = takio::destinations::inventory(&reader).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].record.item_id, ready.id);
    assert!(f.originals.iter().all(|path| path.exists()));
}

#[gpui::test]
fn all_blocked_send_review_cannot_confirm(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    std::fs::remove_dir(reader.path.join("koreader")).unwrap();
    f.state.update(cx, |state, _| {
        state.selected.insert(1);
    });
    preview_selected(&f, &reader, cx);
    confirm_send(&f, cx);
    f.state.read_with(cx, |state, _| {
        let preview = state.send_preview.as_ref().unwrap();
        assert_eq!(preview.ready_count(), 0);
        assert_eq!(preview.entries.len(), 2);
        assert!(
            preview
                .entries
                .iter()
                .all(|entry| entry.result.as_ref().unwrap_err() == "no-compatible-format")
        );
        assert!(state.delivery_report.is_none());
    });
    assert_reader_untouched(&reader);
    assert_files_unchanged(&f);
}

#[gpui::test]
fn send_confirmation_uses_preview_ids_and_ignores_repeated_confirmation(cx: &mut TestAppContext) {
    let f = fixture(false, cx);
    let reader = reader(&f, cx);
    let chosen = f.state.read_with(cx, |state, _| state.items[0].clone());
    preview_selected(&f, &reader, cx);
    f.state.update(cx, |state, _| {
        state.selected.clear();
        state.selected.insert(1);
        state.anchor = Some(1);
    });
    f.window
        .update(cx, |_, window, cx| {
            window.dispatch_action(Box::new(crate::ConfirmSend), cx);
            window.dispatch_action(Box::new(crate::ConfirmSend), cx);
        })
        .unwrap();
    settle(&f.state, cx);
    confirm_send(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview.is_none());
        let report = state.delivery_report.as_ref().unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].item_id, chosen.id);
        assert!(report.entries[0].result.is_ok());
    });
    let inventory = takio::destinations::inventory(&reader).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].record.item_id, chosen.id);
    assert_eq!(
        std::fs::read_dir(reader.path.join("documents"))
            .unwrap()
            .count(),
        1
    );
    assert_files_unchanged(&f);
}

#[gpui::test]
fn confirm_send_rechecks_source_reader_capabilities_disconnect_and_collision(
    cx: &mut TestAppContext,
) {
    for change in ["source", "capabilities", "disconnect", "collision"] {
        let f = fixture(false, cx);
        let reader = reader(&f, cx);
        let chosen = f.state.read_with(cx, |state, _| state.items[0].clone());
        preview_selected(&f, &reader, cx);
        let target =
            reader
                .path
                .join("documents")
                .join(takio::destinations::destination_file_name(
                    &chosen.title,
                    chosen.author.as_deref(),
                    "epub",
                ));
        let expected = match change {
            "source" => {
                std::fs::remove_file(&chosen.formats[0].source_path).unwrap();
                "source-unavailable"
            }
            "capabilities" => {
                std::fs::remove_dir(reader.path.join("koreader")).unwrap();
                "no-compatible-format"
            }
            "disconnect" => {
                std::fs::remove_dir_all(&reader.path).unwrap();
                "unknown-destination"
            }
            "collision" => {
                std::fs::write(&target, b"other writer's bytes").unwrap();
                "destination-file-exists"
            }
            _ => unreachable!(),
        };
        confirm_send(&f, cx);
        f.state.read_with(cx, |state, _| {
            let report = state.delivery_report.as_ref().unwrap();
            assert_eq!(report.entries.len(), 1);
            assert_eq!(report.entries[0].item_id, chosen.id);
            assert_eq!(report.entries[0].result.as_ref().unwrap_err(), expected);
        });
        assert!(!reader.path.join(".takio").exists());
        if change == "disconnect" {
            assert!(!reader.path.exists());
        } else if change == "collision" {
            assert_eq!(std::fs::read(&target).unwrap(), b"other writer's bytes");
            assert_eq!(
                std::fs::read_dir(reader.path.join("documents"))
                    .unwrap()
                    .count(),
                1
            );
        } else {
            assert_reader_untouched(&reader);
        }
        assert!(f.originals.iter().all(|path| path.exists()));
    }
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
