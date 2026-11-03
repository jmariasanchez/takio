//! Native keyboard integration and production AccessKit node metadata checks.
//! GPUI 0.3.9's TestWindow does not activate AccessKit or expose action injection.
//! These checks intentionally do not claim platform-tree or VoiceOver validation.
use super::*;
use crate::{
    engine::{Engine, Filters, ImportMode, Request},
    state::{LibraryState, Section},
    views::{library_list::LibraryList, sidebar::Sidebar, workspace::Workspace},
};
use gpui::Focusable;
use gpui::{AppContext, Element, TestAppContext};
use takio::paths::LibraryPaths;

use crate::test_support::settle;

pub(crate) fn fixture(cx: &mut TestAppContext) -> (tempfile::TempDir, LibraryEntity) {
    cx.executor().allow_parking();
    cx.update(|cx| cx.set_global(Theme::LIGHT));
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let engine = Engine::open(paths).unwrap();
    let roots = ["Alpha", "Beta"].map(|title| {
        let path = temp.path().join(format!("{title}.epub"));
        std::fs::write(&path, format!("isolated keyboard fixture {title}")).unwrap();
        path
    });
    engine
        .request(|reply| Request::Import {
            roots: roots.to_vec(),
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
    let state = cx.new(|cx| LibraryState::new(engine, cx));
    settle(&state, cx);
    (temp, state)
}

#[gpui::test]
fn search_node_reports_actual_role_label_value_and_set_value_capability(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(Theme::LIGHT));
    let window = cx.add_window(|_, cx| {
        let mut input = Search::text_input("a\u{1f642}b".into(), cx);
        input.set_label("Title (required)");
        input
    });
    window
        .update(cx, |input, window, cx| {
            let element = input.render(window, cx).into_element();
            assert_eq!(element.a11y_role(), Some(gpui::Role::TextInput));
            let mut node = gpui::accesskit::Node::new(element.a11y_role().unwrap());
            element.write_a11y_info(&mut node);
            assert_eq!(node.label(), Some("Title (required)"));
            assert_eq!(node.value(), Some("a\u{1f642}b"));
            assert!(node.supports_action(gpui::AccessibleAction::SetValue));
        })
        .unwrap();
    window
        .update(cx, |input, window, cx| {
            input.set_read_only(true, cx);
            let element = input.render(window, cx).into_element();
            let mut node = gpui::accesskit::Node::new(element.a11y_role().unwrap());
            element.write_a11y_info(&mut node);
            assert!(!node.supports_action(gpui::AccessibleAction::SetValue));
        })
        .unwrap();
}

#[gpui::test]
fn library_and_sidebar_expose_named_composite_roles(cx: &mut TestAppContext) {
    let (_temp, state) = fixture(cx);
    let list = cx.add_window(|_, cx| LibraryList::new(state.clone(), cx));
    list.update(cx, |list, window, cx| {
        let element = list.render(window, cx).into_element();
        assert_eq!(element.a11y_role(), Some(gpui::Role::ListBox));
        let mut node = gpui::accesskit::Node::new(element.a11y_role().unwrap());
        element.write_a11y_info(&mut node);
        assert_eq!(node.label(), Some("Books"));
        assert_eq!(node.size_of_set(), Some(2));
    })
    .unwrap();
    let sidebar = cx.add_window(|_, cx| Sidebar::new(state, cx));
    sidebar
        .update(cx, |sidebar, window, cx| {
            let element = sidebar.render(window, cx).into_element();
            assert_eq!(element.a11y_role(), Some(gpui::Role::Navigation));
            let mut node = gpui::accesskit::Node::new(element.a11y_role().unwrap());
            element.write_a11y_info(&mut node);
            assert_eq!(node.label(), Some("Library navigation and filters"));
        })
        .unwrap();
}

#[gpui::test]
fn tab_and_shift_tab_traverse_real_sidebar_and_activate_only_on_release(cx: &mut TestAppContext) {
    let (_temp, state) = fixture(cx);
    let (_workspace, cx) =
        cx.add_window_view(|window, cx| Workspace::new(state.clone(), window, cx));
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Start before the first tab stop rather than depending on visual coordinates.
    cx.update(|window, cx| {
        window.blur(cx);
        window.focus_next(cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("tab");
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    state.read_with(cx, |state, _| assert_eq!(state.section, Section::Library));
    cx.simulate_keystrokes("space");
    state.read_with(cx, |state, _| assert_eq!(state.section, Section::Library));
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("space").unwrap(),
    });
    settle(&state, cx);
    state.read_with(cx, |state, _| assert_eq!(state.section, Section::Trash));
    cx.simulate_keystrokes("shift-tab");
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("enter");
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    settle(&state, cx);
    state.read_with(cx, |state, _| assert_eq!(state.section, Section::Library));
    // Navigation and plain activation never move the source files or trash books.
    assert!(state.read_with(cx, |state, _| state.items.len() == 2));
}

#[gpui::test]
fn disabled_sidebar_and_cross_focus_key_release_never_activate(cx: &mut TestAppContext) {
    let (_temp, state) = fixture(cx);
    let (_workspace, cx) =
        cx.add_window_view(|window, cx| Workspace::new(state.clone(), window, cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        window.blur(cx);
        window.focus_next(cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("enter");
    cx.simulate_keystrokes("tab");
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    state.read_with(cx, |state, _| assert_eq!(state.section, Section::Library));

    state.update(cx, |state, cx| {
        state.busy = true;
        cx.notify();
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("enter");
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    state.read_with(cx, |state, _| {
        assert_eq!(state.section, Section::Library);
        assert_eq!(state.items.len(), 2);
    });
}

#[gpui::test]
fn search_and_palette_consume_library_deletion_actions(cx: &mut TestAppContext) {
    let (_temp, state) = fixture(cx);
    state.update(cx, |state, cx| state.select_only(0, cx));
    let (_workspace, cx) =
        cx.add_window_view(|window, cx| Workspace::new(state.clone(), window, cx));
    cx.run_until_parked();
    cx.dispatch_action(crate::FocusSearch);
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.dispatch_action(crate::TrashSelected);
    settle(&state, cx);
    state.read_with(cx, |state, _| assert_eq!(state.items.len(), 2));
    cx.dispatch_action(crate::TogglePalette);
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.dispatch_action(crate::TrashSelected);
    settle(&state, cx);
    state.read_with(cx, |state, _| assert_eq!(state.items.len(), 2));
    cx.simulate_input("Show Trash");
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("enter");
    settle(&state, cx);
    state.read_with(cx, |state, _| {
        assert_eq!(state.section, Section::Trash);
        assert!(state.items.is_empty());
    });
}

#[gpui::test]
fn focused_sort_header_uses_real_click_handler_without_opening_books(cx: &mut TestAppContext) {
    let (_temp, state) = fixture(cx);
    let (_list, cx) = cx.add_window_view(|window, cx| {
        let list = LibraryList::new(state.clone(), cx);
        window.focus(&list.focus_handle(cx), cx);
        list
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        window.focus_next(cx);
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("enter");
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
    });
    settle(&state, cx);
    let ascending = state.read_with(cx, |state, _| {
        assert_eq!(state.sort.column, crate::state::SortColumn::Title);
        assert_eq!(state.items.len(), 2);
        state.sort.ascending
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_keystrokes("space");
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("space").unwrap(),
    });
    settle(&state, cx);
    state.read_with(cx, |state, _| assert_ne!(state.sort.ascending, ascending));
}
