//! Selection details and file actions, backed by lazy background thumbnails.
use std::sync::{Arc, Mutex};

use gpui::{Context, Entity, IntoElement, ObjectFit, Render, Window, div, img, prelude::*, px};
use takio::model::{LibraryItem, Provenance};

use super::metadata_editor::{Closed, MetadataEditor};
use crate::covers::CoverCache;
use crate::state::{LibraryEntity, author_label};
use crate::theme::{Theme, metrics};

pub struct Inspector {
    state: LibraryEntity,
    covers: Arc<Mutex<CoverCache>>,
    editor: Option<Entity<MetadataEditor>>,
    closed_editor: Option<Entity<MetadataEditor>>,
}

impl Inspector {
    pub fn new(state: LibraryEntity, cx: &mut Context<Self>) -> Self {
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        Self {
            state,
            covers: Arc::new(Mutex::new(CoverCache::default())),
            editor: None,
            closed_editor: None,
        }
    }

    pub fn edit_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if self.editor.is_some()
            || state.busy
            || state.selected.len() != 1
            || state.section != crate::state::Section::Library
        {
            return;
        }
        let Some(item) = state.primary_selected().cloned() else {
            return;
        };
        self.state.update(cx, |state, cx| {
            state.metadata_save_result = None;
            state.metadata_editing = true;
            cx.notify();
        });
        let editor = cx.new(|cx| MetadataEditor::new(self.state.clone(), item, window, cx));
        cx.subscribe(&editor, |this, editor, _: &Closed, cx| {
            this.editor = None;
            this.closed_editor = Some(editor);
            cx.notify();
        })
        .detach();
        self.editor = Some(editor);
        cx.notify();
    }

    fn book(
        &mut self,
        item: &LibraryItem,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let cover = item.cover_path.as_ref().and_then(|path| {
            self.covers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get_or_load(path, self.covers.clone(), cx)
        });
        let mut details = div().flex().flex_col().gap_3().child(
            div().flex().justify_center().child(
                div()
                    .w(px(200.))
                    .h(px(300.))
                    .flex_shrink_0()
                    .rounded(px(metrics::RADIUS))
                    .overflow_hidden()
                    .bg(theme.row_hover)
                    .children(
                        cover.map(|cover| img(cover).size_full().object_fit(ObjectFit::Contain)),
                    ),
            ),
        );
        details = details
            .child(
                div()
                    .text_lg()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(item.title.clone()),
            )
            .children(nonempty(author_label(item)).map(|authors| {
                div()
                    .text_sm()
                    .text_color(theme.text_secondary)
                    .child(authors)
            }))
            .when(
                self.state.read(cx).section == crate::state::Section::Library,
                |details| {
                    details.child(
                        div()
                            .id("edit-details")
                            .px_3()
                            .py_2()
                            .rounded(px(metrics::RADIUS))
                            .bg(theme.row_selected_inactive)
                            .opacity(if self.state.read(cx).busy { 0.5 } else { 1.0 })
                            .cursor_pointer()
                            .hover(|style| style.bg(theme.row_hover))
                            .child("Edit details")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.edit_selected(window, cx)),
                            ),
                    )
                },
            );
        let series = item
            .series
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(|series| {
                item.series_index
                    .map_or_else(|| series.clone(), |index| format!("{series} · {index}"))
            });
        for (label, value) in [
            ("Series", series),
            ("Publisher", item.publisher.clone()),
            ("Published", item.published_date.clone()),
            ("Languages", Some(item.languages.join(", "))),
            ("Rating", item.rating.map(|rating| rating.to_string())),
            ("Added", item.added_at.get(..10).map(str::to_owned)),
        ] {
            if let Some(value) = value.and_then(nonempty) {
                details = details.child(metadata_row(label, div().child(value), theme));
            }
        }
        let tags = item
            .tags
            .iter()
            .filter(|tag| !tag.trim().is_empty())
            .collect::<Vec<_>>();
        if !tags.is_empty() {
            details = details.child(metadata_row(
                "Tags",
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(tags.into_iter().map(|tag| {
                        div()
                            .px_2()
                            .py_1()
                            .rounded(px(metrics::RADIUS))
                            .bg(theme.row_selected_inactive)
                            .text_xs()
                            .child(tag.clone())
                    })),
                theme,
            ));
        }
        let identifiers = item
            .identifiers
            .iter()
            .filter(|(_, value)| !value.trim().is_empty())
            .collect::<Vec<_>>();
        if !identifiers.is_empty() {
            details = details.child(metadata_row(
                "Identifiers",
                div().flex().flex_col().gap_1().children(
                    identifiers
                        .into_iter()
                        .map(|(key, value)| div().child(format!("{key}: {value}"))),
                ),
                theme,
            ));
        }
        if let Some(description) = item.description.clone().and_then(nonempty) {
            details = details.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_secondary)
                            .child("Description"),
                    )
                    .child(div().text_sm().line_clamp(8).child(description)),
            );
        }
        details
            .child(
                div()
                    .mt_2()
                    .text_sm()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child("Formats"),
            )
            .children(item.formats.iter().enumerate().map(|(index, format)| {
                let open_path = format.source_path.clone();
                let reveal_path = open_path.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .py_2()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child(format.format.as_str().to_uppercase()),
                            )
                            .child(div().text_xs().text_color(theme.text_tertiary).child(
                                match format.provenance {
                                    Provenance::Managed => "Managed",
                                    Provenance::Referenced => "Referenced",
                                },
                            )),
                    )
                    .child(
                        div()
                            .w_full()
                            .text_xs()
                            .text_color(theme.text_tertiary)
                            .text_ellipsis()
                            .child(format.source_path.display().to_string()),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                div()
                                    .id(("open-format", index))
                                    .px_2()
                                    .py_1()
                                    .text_xs()
                                    .rounded(px(metrics::RADIUS))
                                    .bg(theme.row_selected_inactive)
                                    .cursor_pointer()
                                    .hover(|style| style.bg(theme.row_hover))
                                    .child("Open")
                                    .on_click(move |_, _, cx| cx.open_with_system(&open_path)),
                            )
                            .child(
                                div()
                                    .id(("reveal-format", index))
                                    .px_2()
                                    .py_1()
                                    .text_xs()
                                    .rounded(px(metrics::RADIUS))
                                    .bg(theme.row_selected_inactive)
                                    .cursor_pointer()
                                    .hover(|style| style.bg(theme.row_hover))
                                    .child("Reveal")
                                    .on_click(move |_, _, cx| cx.reveal_path(&reveal_path)),
                            ),
                    )
            }))
    }
}

impl Render for Inspector {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(editor) = self.closed_editor.take() {
            editor.update(cx, |editor, cx| editor.restore_focus(window, cx));
        }
        let theme = *cx.global::<Theme>();
        let state = self.state.read(cx);
        let selected = state.selected.len();
        let item = state.primary_selected().cloned();
        let content = if let Some(editor) = &self.editor {
            editor.clone().into_any_element()
        } else if selected > 1 {
            div()
                .text_lg()
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .child(format!("{selected} books selected"))
                .into_any_element()
        } else if selected > 0
            && let Some(item) = item
        {
            self.book(&item, theme, cx).into_any_element()
        } else {
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_sm()
                .text_color(theme.text_tertiary)
                .child("Select a book")
                .into_any_element()
        };
        div()
            .id("inspector")
            .w(px(metrics::INSPECTOR_WIDTH))
            .flex_shrink_0()
            .h_full()
            .bg(theme.panel_bg)
            .text_color(theme.text)
            .border_l_1()
            .border_color(theme.border)
            .pt(px(44.))
            .px_4()
            .pb_4()
            .overflow_y_scroll()
            .child(content)
    }
}

fn nonempty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn metadata_row(label: &'static str, value: impl IntoElement, theme: Theme) -> impl IntoElement {
    div()
        .flex()
        .gap_2()
        .text_sm()
        .child(
            div()
                .w(px(78.))
                .flex_shrink_0()
                .text_color(theme.text_secondary)
                .child(label),
        )
        .child(div().flex_1().min_w_0().child(value))
}
