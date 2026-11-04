//! A local metadata draft. The library is changed only by explicit Save.
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, KeyBinding, Render, Window, actions, div,
    prelude::*,
};
use takio::library::model::{BookAuthor, LibraryItem, LibraryPatch, Patch};

use super::text_input::TextInput;
use crate::state::LibraryEntity;
use crate::theme::Theme;

struct EditorFields {
    title: Entity<TextInput>,
    authors: Entity<TextInput>,
    series: Entity<TextInput>,
    tags: Entity<TextInput>,
}

impl EditorFields {
    fn labeled(&self) -> [(&'static str, &Entity<TextInput>); 4] {
        [
            ("Title (required)", &self.title),
            ("Authors (separate with semicolons)", &self.authors),
            ("Series", &self.series),
            ("Tags (separate with semicolons)", &self.tags),
        ]
    }

    fn iter(&self) -> impl Iterator<Item = &Entity<TextInput>> {
        self.labeled().into_iter().map(|(_, field)| field)
    }
}

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
            authors: item.author_names().collect::<Vec<_>>().join("; "),
            series: item.series.clone().unwrap_or_default(),
            tags: item.tags.join("; "),
        }
    }

    fn patch(&self, item: &LibraryItem) -> takio::error::AppResult<LibraryPatch> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(takio::app_error!("invalid-title"));
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
    fields: EditorFields,
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
        let fields = EditorFields {
            title: cx.new(|cx| TextInput::new(draft.title, cx)),
            authors: cx.new(|cx| TextInput::new(draft.authors, cx)),
            series: cx.new(|cx| TextInput::new(draft.series, cx)),
            tags: cx.new(|cx| TextInput::new(draft.tags, cx)),
        };
        for (label, field) in fields.labeled() {
            field.update(cx, |field, _| field.set_label(label));
        }
        let return_focus = window.focused(cx);
        fields.title.update(cx, |field, cx| field.focus(window, cx));
        cx.observe(&state, |this, _, cx| {
            if this.submitted && !this.state.read(cx).saving_metadata() {
                match this.state.read(cx).session().metadata_save_result.clone() {
                    Some(Ok(id)) if id == this.original.id => {
                        this.submitted = false;
                        this.state.update(cx, |state, cx| {
                            state.end_metadata_editing(cx);
                        });
                        cx.emit(Closed);
                    }
                    Some(Err(error)) => {
                        this.submitted = false;
                        this.error = Some(crate::state::humanize_app_error(&error));
                        for field in this.fields.iter() {
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
            title: self.fields.title.read(cx).text().to_owned(),
            authors: self.fields.authors.read(cx).text().to_owned(),
            series: self.fields.series.read(cx).text().to_owned(),
            tags: self.fields.tags.read(cx).text().to_owned(),
        }
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitted || self.state.read(cx).saving_metadata() {
            return;
        }
        let patch = match self.draft(cx).patch(&self.original) {
            Ok(patch) => patch,
            Err(error) => {
                self.error = Some(crate::state::humanize_app_error(&error));
                self.fields
                    .title
                    .update(cx, |field, cx| field.focus(window, cx));
                cx.notify();
                return;
            }
        };
        self.error = None;
        self.submitted = true;
        for field in self.fields.iter() {
            field.update(cx, |field, cx| field.set_read_only(true, cx));
        }
        self.state.update(cx, |state, cx| {
            state.update_metadata(self.original.id.clone(), patch, cx);
        });
        cx.notify();
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitted {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.end_metadata_editing(cx);
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
            .id("metadata-editor")
            .role(gpui::Role::Group)
            .aria_label("Edit book details")
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
            .map(crate::commands::block_modal_actions)
            .child(div().text_lg().child("Edit details"))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_secondary)
                    .child("Changes apply to this book only."),
            )
            .children(self.fields.labeled().into_iter().map(|(label, field)| {
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
            }))
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
                            .map(|el| {
                                super::button::accessible_button(
                                    el,
                                    if busy {
                                        "Saving details"
                                    } else {
                                        "Save details"
                                    },
                                    !busy,
                                )
                            })
                            .key_context("MetadataButton")
                            .track_focus(&self.save_focus)
                            .map(|el| {
                                super::button::style(
                                    el,
                                    !busy,
                                    super::button::Variant::Primary,
                                    theme,
                                )
                            })
                            .border_color(if self.save_focus.is_focused(window) {
                                theme.accent
                            } else {
                                theme.border
                            })
                            .child(if busy { "Saving..." } else { "Save" })
                            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                    )
                    .child(
                        div()
                            .id("cancel-details")
                            .map(|el| {
                                super::button::accessible_button(
                                    el,
                                    "Cancel editing details",
                                    !busy,
                                )
                            })
                            .key_context("MetadataButton")
                            .track_focus(&self.cancel_focus)
                            .map(|el| {
                                super::button::style(
                                    el,
                                    !busy,
                                    super::button::Variant::Secondary,
                                    theme,
                                )
                            })
                            .border_color(if self.cancel_focus.is_focused(window) {
                                theme.accent
                            } else {
                                theme.border
                            })
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
    use takio::{format::FormatId, library::paths::LibraryPaths};

    fn item() -> LibraryItem {
        let mut item = LibraryItem::for_test(
            "book-id",
            "Original title",
            "book.epub",
            FormatId::Epub,
            "2026-01-01",
        );
        item.set_legacy_display_author_for_test(Some("Legacy author"));
        item.authors = vec![BookAuthor {
            name: "Author, First".into(),
            sort_name: Some("First, Author".into()),
        }];
        item.series = Some("A series".into());
        item.series_index = Some(2.5);
        item.publisher = Some("Publisher".into());
        item.languages = vec!["en".into()];
        item.identifiers = [("isbn".into(), "123".into())].into();
        item.custom_metadata = [("private".into(), "keep me".into())].into();
        item.published_date = Some("2020".into());
        item.rating = Some(4.0);
        item.description = Some("Description".into());
        item.cover_path = Some("cover.jpg".into());
        item.tags = vec!["fiction".into()];
        item
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
        let error = draft.patch(&item).unwrap_err();
        assert_eq!(error.kind(), takio::error::ErrorCode::InvalidTitle);
        assert_eq!(
            crate::state::humanize_error(error.kind()),
            "Title is required."
        );
    }

    fn setup(cx: &mut TestAppContext) -> (tempfile::TempDir, LibraryEntity) {
        cx.executor().allow_parking();
        cx.update(crate::install_app_globals);
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let engine = Engine::create_or_migrate(paths).unwrap();
        let state = cx.new(|cx| LibraryState::new(engine, cx));
        crate::test_support::settle(&state, cx);
        state.update(cx, |state, cx| {
            state.install_test_items(vec![std::sync::Arc::new(item())]);
            state.select_only(0, cx);
            assert!(state.begin_metadata_editing(cx));
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
                editor.fields.title.update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..14), "Draft title", window, cx);
                });
                assert_eq!(editor.draft(cx).title, "Draft title");
                assert_eq!(
                    editor.state.read(cx).session().items[0].title,
                    "Original title"
                );
                editor.traverse(false, window, cx);
                assert!(
                    editor
                        .fields
                        .authors
                        .read(cx)
                        .focus_handle()
                        .is_focused(window)
                );
                editor.traverse(true, window, cx);
                assert!(
                    editor
                        .fields
                        .title
                        .read(cx)
                        .focus_handle()
                        .is_focused(window)
                );
                editor.traverse(true, window, cx);
                assert!(editor.cancel_focus.is_focused(window));
                editor.cancel(window, cx);
            })
            .unwrap();
        state.read_with(cx, |state, _| {
            assert!(!state.session().metadata_editing);
            assert!(!state.saving_metadata());
            assert!(state.session().metadata_save_result.is_none());
            assert_eq!(state.session().items[0].title, "Original title");
            assert!(state.session().query.is_empty());
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
                assert!(
                    editor
                        .fields
                        .authors
                        .read(cx)
                        .focus_handle()
                        .is_focused(window)
                );
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
            assert!(!state.session().metadata_editing);
            assert_eq!(state.session().items[0].title, "Original title");
        });
    }

    #[gpui::test]
    fn save_failure_keeps_draft_and_validation_never_submits(cx: &mut TestAppContext) {
        let (_temp, state) = setup(cx);
        let window =
            cx.add_window(|window, cx| MetadataEditor::new(state.clone(), item(), window, cx));
        window
            .update(cx, |editor, window, cx| {
                editor.fields.title.update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..14), " ", window, cx)
                });
                editor.save(window, cx);
                assert_eq!(editor.error.as_deref(), Some("Title is required."));
                assert!(!editor.submitted);
                editor.fields.title.update(cx, |field, cx| {
                    field.replace_text_in_range(Some(0..1), "Keep this draft", window, cx)
                });
                editor.save(window, cx);
            })
            .unwrap();
        crate::test_support::wait_until("metadata save", || {
            cx.run_until_parked();
            !state.read_with(cx, |state, _| state.saving_metadata())
        });
        cx.run_until_parked();
        window
            .update(cx, |editor, window, cx| {
                assert!(!editor.submitted);
                assert_eq!(
                    editor.error.as_deref(),
                    Some("That book is no longer in the library")
                );
                assert_eq!(
                    editor
                        .state
                        .read(cx)
                        .session()
                        .metadata_save_result
                        .as_ref()
                        .unwrap()
                        .as_ref()
                        .unwrap_err()
                        .code(),
                    "not-found"
                );
                assert!(editor.state.read(cx).session().metadata_editing);
                assert_eq!(editor.draft(cx).title, "Keep this draft");
                editor.fields.title.update(cx, |field, cx| {
                    field.replace_text_in_range(None, "!", window, cx)
                });
                assert_eq!(editor.draft(cx).title, "Keep this draft!");
            })
            .unwrap();
    }
}
