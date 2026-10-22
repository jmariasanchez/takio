//! A local metadata draft. The library is changed only by explicit Save.
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, KeyBinding, Render, Window, actions, div,
    prelude::*, px,
};
use takio::model::{BookAuthor, LibraryItem, LibraryPatch, Patch};

use super::search::Search;
use crate::state::LibraryEntity;
use crate::theme::{Theme, metrics};

actions!(
    metadata_editor,
    [
        SaveDetails,
        CancelDetails,
        NextField,
        PreviousField,
        Activate
    ]
);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Draft {
    title: String,
    authors: String,
    series: String,
    tags: String,
}

impl Draft {
    fn from_item(item: &LibraryItem) -> Self {
        Self {
            title: item.title.clone(),
            authors: if item.authors.is_empty() {
                item.author.clone().unwrap_or_default()
            } else {
                item.authors
                    .iter()
                    .map(|author| author.name.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            },
            series: item.series.clone().unwrap_or_default(),
            tags: item.tags.join("; "),
        }
    }

    fn patch(&self, item: &LibraryItem) -> Result<LibraryPatch, String> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err("Title is required.".into());
        }
        let original = Self::from_item(item);
        let mut patch = LibraryPatch::default();
        if self.title != original.title {
            patch.title = Patch::Set(title.to_owned());
        }
        if self.authors != original.authors {
            patch.authors = Patch::Set(
                split_list(&self.authors)
                    .into_iter()
                    .map(|name| {
                        item.authors
                            .iter()
                            .find(|author| author.name == name)
                            .cloned()
                            .unwrap_or(BookAuthor {
                                name,
                                sort_name: None,
                            })
                    })
                    .collect(),
            );
        }
        if self.series != original.series {
            patch.series = if self.series.trim().is_empty() {
                Patch::Null
            } else {
                Patch::Set(self.series.trim().to_owned())
            };
        }
        if self.tags != original.tags {
            patch.tags = Patch::Set(split_list(&self.tags));
        }
        Ok(patch)
    }
}

fn split_list(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    for value in text
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !values.iter().any(|existing| existing == value) {
            values.push(value.to_owned());
        }
    }
    values
}

pub struct Closed;

pub struct MetadataEditor {
    state: LibraryEntity,
    original: LibraryItem,
    fields: [Entity<Search>; 4],
    save_focus: FocusHandle,
    cancel_focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    submitted: bool,
    error: Option<String>,
}

impl EventEmitter<Closed> for MetadataEditor {}

impl MetadataEditor {
    pub fn new(
        state: LibraryEntity,
        item: LibraryItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.bind_keys([
            KeyBinding::new("cmd-s", SaveDetails, Some("MetadataEditor")),
            KeyBinding::new("escape", CancelDetails, Some("MetadataEditor")),
            KeyBinding::new("tab", NextField, Some("MetadataEditor")),
            KeyBinding::new("shift-tab", PreviousField, Some("MetadataEditor")),
            KeyBinding::new("enter", Activate, Some("MetadataEditor")),
            KeyBinding::new("space", Activate, Some("MetadataButton")),
        ]);
        let draft = Draft::from_item(&item);
        let fields = [draft.title, draft.authors, draft.series, draft.tags]
            .map(|text| cx.new(|cx| Search::text_input(text, cx)));
        let return_focus = window.focused(cx);
        fields[0].update(cx, |field, cx| field.focus(window, cx));
        cx.observe(&state, |this, _, cx| {
            if this.submitted && !this.state.read(cx).saving_metadata {
                match this.state.read(cx).metadata_save_result.clone() {
                    Some(Ok(id)) if id == this.original.id => {
                        this.submitted = false;
                        this.state.update(cx, |state, cx| {
                            state.metadata_editing = false;
                            cx.notify();
                        });
                        cx.emit(Closed);
                    }
                    Some(Err(error)) => {
                        this.submitted = false;
                        this.error = Some(error);
                        for field in &this.fields {
                            field.update(cx, |field, cx| field.set_read_only(false, cx));
                        }
                    }
                    _ => {}
                }
            }
            cx.notify();
        })
        .detach();
        Self {
            state,
            original: item,
            fields,
            save_focus: cx.focus_handle(),
            cancel_focus: cx.focus_handle(),
            return_focus,
            submitted: false,
            error: None,
        }
    }

    pub fn restore_focus(&self, window: &mut Window, cx: &mut App) {
        if let Some(focus) = &self.return_focus {
            window.focus(focus, cx);
        }
    }

    fn draft(&self, cx: &App) -> Draft {
        Draft {
            title: self.fields[0].read(cx).text().to_owned(),
            authors: self.fields[1].read(cx).text().to_owned(),
            series: self.fields[2].read(cx).text().to_owned(),
            tags: self.fields[3].read(cx).text().to_owned(),
        }
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitted || self.state.read(cx).saving_metadata {
            return;
        }
        let patch = match self.draft(cx).patch(&self.original) {
            Ok(patch) => patch,
            Err(error) => {
                self.error = Some(error);
                self.fields[0].update(cx, |field, cx| field.focus(window, cx));
                cx.notify();
                return;
            }
        };
        self.error = None;
        self.submitted = true;
        for field in &self.fields {
            field.update(cx, |field, cx| field.set_read_only(true, cx));
        }
        self.state.update(cx, |state, cx| {
            state.metadata_save_result = None;
            state.update_metadata(self.original.id.clone(), patch, cx);
        });
        cx.notify();
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitted {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.metadata_editing = false;
            cx.notify();
        });
        self.restore_focus(window, cx);
        cx.emit(Closed);
    }

    fn traverse(&self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        let mut handles = self
            .fields
            .iter()
            .map(|field| field.read(cx).focus_handle())
            .collect::<Vec<_>>();
        handles.extend([self.save_focus.clone(), self.cancel_focus.clone()]);
        let current = handles
            .iter()
            .position(|focus| focus.is_focused(window))
            .unwrap_or(0);
        let next = if backwards {
            (current + handles.len() - 1) % handles.len()
        } else {
            (current + 1) % handles.len()
        };
        window.focus(&handles[next], cx);
        cx.notify();
    }
}

impl Render for MetadataEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let busy = self.submitted;
        div()
            .key_context("MetadataEditor")
            .flex()
            .flex_col()
            .gap_3()
            .on_action(cx.listener(|this, _: &SaveDetails, window, cx| this.save(window, cx)))
            .on_action(cx.listener(|this, _: &CancelDetails, window, cx| this.cancel(window, cx)))
            .on_action(
                cx.listener(|this, _: &NextField, window, cx| this.traverse(false, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &PreviousField, window, cx| this.traverse(true, window, cx)),
            )
            .on_action(cx.listener(|this, _: &Activate, window, cx| {
                if this.cancel_focus.is_focused(window) {
                    this.cancel(window, cx);
                } else if this.save_focus.is_focused(window) {
                    this.save(window, cx);
                }
            }))
            .on_action(|_: &crate::TrashSelected, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::PurgeSelected, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::RestoreSelected, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::OpenSelected, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::SelectAll, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::ShowLibrary, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::ShowTrash, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::TogglePalette, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::FocusSearch, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::SendSelected, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::EjectReader, _, cx| cx.stop_propagation())
            .on_action(|_: &crate::EditSelected, _, cx| cx.stop_propagation())
            .child(div().text_lg().child("Edit details"))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_secondary)
                    .child("Changes apply to this book only."),
            )
            .children(
                [
                    "Title (required)",
                    "Authors (separate with ;)",
                    "Series",
                    "Tags (separate with ;)",
                ]
                .into_iter()
                .zip(self.fields.iter())
                .map(|(label, field)| {
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.text_secondary)
                                .child(label),
                        )
                        .child(field.clone())
                }),
            )
            .children(
                self.error
                    .clone()
                    .map(|error| div().text_sm().text_color(theme.danger).child(error)),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        div()
                            .id("save-details")
                            .key_context("MetadataButton")
                            .track_focus(&self.save_focus)
                            .px_3()
                            .py_1()
                            .rounded(px(metrics::RADIUS))
                            .border_1()
                            .border_color(if self.save_focus.is_focused(window) {
                                theme.accent
                            } else {
                                theme.border
                            })
                            .bg(theme.row_selected)
                            .cursor_pointer()
                            .child(if busy { "Saving..." } else { "Save" })
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    )
                    .child(
                        div()
                            .id("cancel-details")
                            .key_context("MetadataButton")
                            .track_focus(&self.cancel_focus)
                            .px_3()
                            .py_1()
                            .rounded(px(metrics::RADIUS))
                            .border_1()
                            .border_color(if self.cancel_focus.is_focused(window) {
                                theme.accent
                            } else {
                                theme.border
                            })
                            .opacity(if busy { 0.5 } else { 1.0 })
                            .cursor_pointer()
                            .child("Cancel")
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx))),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_tertiary)
                    .child("Tab to move, Cmd-S to save, Esc to cancel."),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Engine, state::LibraryState};
    use gpui::{AppContext, EntityInputHandler, TestAppContext};
    use takio::{conversion::FormatId, paths::LibraryPaths};

    fn item() -> LibraryItem {
        LibraryItem {
            id: "book-id".into(),
            title: "Original title".into(),
            source_path: "book.epub".into(),
            format: FormatId::Epub,
            added_at: "2026-01-01".into(),
            formats: Vec::new(),
            author: Some("Legacy author".into()),
            authors: vec![BookAuthor {
                name: "Author, First".into(),
                sort_name: Some("First, Author".into()),
            }],
            series: Some("A series".into()),
            series_index: Some(2.5),
            publisher: Some("Publisher".into()),
            languages: vec!["en".into()],
            identifiers: [("isbn".into(), "123".into())].into(),
            custom_metadata: [("private".into(), "keep me".into())].into(),
            published_date: Some("2020".into()),
            rating: Some(4.0),
            description: Some("Description".into()),
            cover_path: Some("cover.jpg".into()),
            tags: vec!["fiction".into()],
            updated_at: None,
        }
    }

    #[test]
    fn unchanged_draft_is_empty_and_preserves_hidden_metadata() {
        let item = item();
        assert!(Draft::from_item(&item).patch(&item).unwrap().is_empty());
        let mut draft = Draft::from_item(&item);
        draft.title = "  New title  ".into();
        let patch = draft.patch(&item).unwrap();
        assert_eq!(patch.title, Patch::Set("New title".into()));
        assert!(patch.authors.is_missing());
        assert!(patch.author.is_missing());
        assert!(patch.series_index.is_missing());
        assert!(patch.publisher.is_missing());
        assert!(patch.languages.is_missing());
        assert!(patch.identifiers.is_missing());
        assert!(patch.custom_metadata.is_missing());
        assert!(patch.description.is_missing());
        assert!(patch.rating.is_missing());
        assert!(patch.published_date.is_missing());
    }

    #[test]
    fn lists_use_semicolons_preserve_sort_names_and_allow_clearing() {
        let item = item();
        let mut draft = Draft::from_item(&item);
        draft.authors = "Author, First; Other; ; Other".into();
        draft.tags = " fiction ; new tag; fiction ;".into();
        draft.series = " ".into();
        let patch = draft.patch(&item).unwrap();
        let authors = patch.authors.into_set().unwrap();
        assert_eq!(authors.len(), 2);
        assert_eq!(authors[0].sort_name.as_deref(), Some("First, Author"));
        assert_eq!(authors[1].name, "Other");
        assert_eq!(
            patch.tags,
            Patch::Set(vec!["fiction".into(), "new tag".into()])
        );
        assert_eq!(patch.series, Patch::Null);
        assert!(patch.series_index.is_missing());
        draft.authors.clear();
        draft.tags.clear();
        let patch = draft.patch(&item).unwrap();
        assert!(patch.authors.into_set().unwrap().is_empty());
        assert_eq!(patch.tags, Patch::Set(Vec::new()));
    }

    #[test]
    fn blank_title_cannot_produce_a_patch() {
        let item = item();
        let mut draft = Draft::from_item(&item);
        draft.title = " \t\n ".into();
        assert_eq!(draft.patch(&item).unwrap_err(), "Title is required.");
    }

    fn setup(cx: &mut TestAppContext) -> (tempfile::TempDir, LibraryEntity) {
        cx.executor().allow_parking();
        cx.update(|cx| cx.set_global(Theme::LIGHT));
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let engine = Engine::open(paths).unwrap();
        let state = cx.new(|cx| LibraryState::new(engine, cx));
        for _ in 0..200 {
            cx.run_until_parked();
            if !state.read_with(cx, |state, _| state.loading) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        state.update(cx, |state, _| {
            state.items = vec![std::sync::Arc::new(item())];
            state.selected.insert(0);
            state.metadata_editing = true;
        });
        (temp, state)
    }

    #[gpui::test]
    fn native_input_traversal_and_cancel_leave_library_unchanged(cx: &mut TestAppContext) {
        let (_temp, state) = setup(cx);
        let window =
            cx.add_window(|window, cx| MetadataEditor::new(state.clone(), item(), window, cx));
        window
            .update(cx, |editor, window, cx| {
                editor.fields[0].update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..14), "Draft title", window, cx);
                });
                assert_eq!(editor.draft(cx).title, "Draft title");
                assert_eq!(editor.state.read(cx).items[0].title, "Original title");
                editor.traverse(false, window, cx);
                assert!(editor.fields[1].read(cx).focus_handle().is_focused(window));
                editor.traverse(true, window, cx);
                assert!(editor.fields[0].read(cx).focus_handle().is_focused(window));
                editor.traverse(true, window, cx);
                assert!(editor.cancel_focus.is_focused(window));
                editor.cancel(window, cx);
            })
            .unwrap();
        state.read_with(cx, |state, _| {
            assert!(!state.metadata_editing);
            assert!(!state.saving_metadata);
            assert!(state.metadata_save_result.is_none());
            assert_eq!(state.items[0].title, "Original title");
            assert!(state.query.is_empty());
        });
    }

    #[gpui::test]
    fn rendered_editor_routes_tab_escape_and_text_shortcuts(cx: &mut TestAppContext) {
        let (_temp, state) = setup(cx);
        let window =
            cx.add_window(|window, cx| MetadataEditor::new(state.clone(), item(), window, cx));
        cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        cx.simulate_keystrokes(window.into(), "cmd-a backspace");
        window
            .update(cx, |editor, _, cx| {
                assert!(editor.draft(cx).title.is_empty())
            })
            .unwrap();
        cx.simulate_keystrokes(window.into(), "tab");
        window
            .update(cx, |editor, window, cx| {
                assert!(editor.fields[1].read(cx).focus_handle().is_focused(window));
            })
            .unwrap();
        cx.simulate_keystrokes(window.into(), "shift-tab shift-tab");
        window
            .update(cx, |editor, window, _| {
                assert!(editor.cancel_focus.is_focused(window));
            })
            .unwrap();
        cx.simulate_keystrokes(window.into(), "escape");
        state.read_with(cx, |state, _| {
            assert!(!state.metadata_editing);
            assert_eq!(state.items[0].title, "Original title");
        });
    }

    #[gpui::test]
    fn save_failure_keeps_draft_and_validation_never_submits(cx: &mut TestAppContext) {
        let (_temp, state) = setup(cx);
        let window =
            cx.add_window(|window, cx| MetadataEditor::new(state.clone(), item(), window, cx));
        window
            .update(cx, |editor, window, cx| {
                editor.fields[0].update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..14), " ", window, cx)
                });
                editor.save(window, cx);
                assert_eq!(editor.error.as_deref(), Some("Title is required."));
                assert!(!editor.submitted);
                editor.fields[0].update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..1), "Keep this draft", window, cx)
                });
                editor.save(window, cx);
            })
            .unwrap();
        for _ in 0..200 {
            cx.run_until_parked();
            if !state.read_with(cx, |state, _| state.saving_metadata) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        cx.run_until_parked();
        window
            .update(cx, |editor, window, cx| {
                assert!(!editor.submitted);
                assert!(editor.error.is_some());
                assert!(editor.state.read(cx).metadata_editing);
                assert_eq!(editor.draft(cx).title, "Keep this draft");
                editor.fields[0].update(cx, |field, cx| {
                    field.replace_text_in_range(None, "!", window, cx)
                });
                assert_eq!(editor.draft(cx).title, "Keep this draft!");
            })
            .unwrap();
    }
}
