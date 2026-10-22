//! The virtualized book table. Only visible rows are built each frame.

use gpui::{
    App, ClickEvent, Context, Div, FocusHandle, Focusable, IntoElement, ParentElement, Render,
    ScrollStrategy, SharedString, Styled, UniformListScrollHandle, Window, div, prelude::*, px,
    uniform_list,
};
use takio::model::LibraryItem;

use crate::state::{LibraryEntity, SortColumn, author_label};
use crate::theme::{Theme, metrics};
use crate::{OpenSelected, SelectAll, SelectNext, SelectPrevious, TrashSelected};

#[derive(Clone, Copy, Debug)]
struct ColumnLayout {
    title: f32,
    author: f32,
    series: Option<f32>,
    formats: f32,
    added: Option<f32>,
}

impl ColumnLayout {
    fn for_viewport(width: f32) -> Self {
        let available = (width - metrics::SIDEBAR_WIDTH - metrics::INSPECTOR_WIDTH).max(0.);
        let expanded = available >= 700.;
        let formats = available.min(80.);
        let series = expanded.then_some((available * 0.18).min(180.));
        let added = expanded.then_some(96.);
        let remaining = available - formats - series.unwrap_or(0.) - added.unwrap_or(0.);
        let title = (remaining * 0.62).floor();
        Self {
            title,
            author: remaining - title,
            series,
            formats,
            added,
        }
    }
}

pub struct LibraryList {
    state: LibraryEntity,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
}

impl LibraryList {
    pub fn new(state: LibraryEntity, cx: &mut Context<Self>) -> Self {
        cx.observe(&state, |this, _, cx| {
            if let Some(anchor) = this.state.read(cx).anchor {
                this.scroll.scroll_to_item(anchor, ScrollStrategy::Nearest);
            }
            cx.notify();
        })
        .detach();
        Self {
            state,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
        }
    }

    fn on_row_click(&mut self, index: usize, event: &ClickEvent, cx: &mut Context<Self>) {
        let modifiers = event.modifiers();
        self.state.update(cx, |state, cx| {
            if modifiers.shift {
                state.select_range_to(index, cx);
            } else if modifiers.platform {
                state.toggle_select(index, cx);
            } else {
                state.select_only(index, cx);
            }
        });
    }

    fn header_cell(
        &self,
        label: &'static str,
        column: SortColumn,
        width: f32,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<Div> {
        let sort = self.state.read(cx).sort;
        let active = sort.column == column;
        let indicator = if active {
            if sort.ascending { " ↑" } else { " ↓" }
        } else {
            ""
        };
        let state = self.state.clone();
        div()
            .id(label)
            .w(px(width))
            .flex_shrink_0()
            .px_2()
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap()
            .cursor_pointer()
            .text_color(if active {
                theme.text
            } else {
                theme.text_secondary
            })
            .child(format!("{label}{indicator}"))
            .on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.set_sort(column, cx));
            })
    }
}

impl Focusable for LibraryList {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for LibraryList {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let state = self.state.clone();
        let count = state.read(cx).items.len();
        let focused = self.focus.contains_focused(window, cx);
        let columns = ColumnLayout::for_viewport(f32::from(window.viewport_size().width));

        let header = div()
            .flex()
            .h(px(metrics::ROW_HEIGHT))
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .text_xs()
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .child(self.header_cell("Title", SortColumn::Title, columns.title, &theme, cx))
            .child(self.header_cell("Author", SortColumn::Author, columns.author, &theme, cx))
            .children(
                columns
                    .series
                    .map(|width| self.header_cell("Series", SortColumn::Series, width, &theme, cx)),
            )
            .child(
                div()
                    .w(px(columns.formats))
                    .flex_shrink_0()
                    .px_2()
                    .text_color(theme.text_secondary)
                    .child("Formats"),
            )
            .children(
                columns
                    .added
                    .map(|width| self.header_cell("Added", SortColumn::Added, width, &theme, cx)),
            );

        let list_state = state.clone();
        let rows = uniform_list(
            "library-rows",
            count,
            cx.processor(move |_this, range: std::ops::Range<usize>, _window, cx| {
                let read = list_state.read(cx);
                let selected = &read.selected;
                let items = &read.items;
                range
                    .filter_map(|index| items.get(index).map(|item| (index, item)))
                    .map(|(index, item)| {
                        row(
                            index,
                            item,
                            selected.contains(&index),
                            focused,
                            &theme,
                            columns,
                        )
                        .on_click(cx.listener(
                            move |this, event, _, cx| {
                                this.on_row_click(index, event, cx);
                            },
                        ))
                    })
                    .collect::<Vec<_>>()
            }),
        )
        .track_scroll(&self.scroll)
        .flex_1()
        .size_full();

        div()
            .key_context("LibraryList")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| {
                this.state
                    .update(cx, |state, cx| state.move_selection(1, cx));
            }))
            .on_action(cx.listener(|this, _: &SelectPrevious, _, cx| {
                this.state
                    .update(cx, |state, cx| state.move_selection(-1, cx));
            }))
            .on_action(cx.listener(|this, _: &SelectAll, _, cx| {
                this.state.update(cx, |state, cx| state.select_all(cx));
            }))
            .on_action(cx.listener(|this, _: &TrashSelected, _, cx| {
                this.state.update(cx, |state, cx| state.trash_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &OpenSelected, _, cx| {
                let path = this
                    .state
                    .read(cx)
                    .primary_selected()
                    .and_then(|item| item.formats.first())
                    .map(|format| format.source_path.clone());
                if let Some(path) = path {
                    cx.open_with_system(&path);
                }
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.panel_bg)
            .text_sm()
            .text_color(theme.text)
            .child(header)
            .child(if count == 0 {
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.text_tertiary)
                    .child(
                        div()
                            .w_full()
                            .px_4()
                            .text_center()
                            .child(empty_label(&state, cx)),
                    )
                    .into_any_element()
            } else {
                rows.into_any_element()
            })
    }
}

fn row(
    index: usize,
    item: &LibraryItem,
    selected: bool,
    focused: bool,
    theme: &Theme,
    columns: ColumnLayout,
) -> gpui::Stateful<Div> {
    let background = if selected {
        if focused {
            theme.row_selected
        } else {
            theme.row_selected_inactive
        }
    } else if index % 2 == 1 {
        theme.row_hover
    } else {
        gpui::transparent_black().into()
    };
    let formats: SharedString = item
        .formats
        .iter()
        .map(|format| format.format.as_str().to_uppercase())
        .collect::<Vec<_>>()
        .join(" ")
        .into();
    div()
        .id(index)
        .flex()
        .h(px(metrics::ROW_HEIGHT))
        .items_center()
        .bg(background)
        .hover(|style| style.bg(theme.row_hover))
        .cursor_default()
        .child(cell(columns.title, item.title.clone(), theme.text))
        .child(cell(
            columns.author,
            author_label(item),
            theme.text_secondary,
        ))
        .children(columns.series.map(|width| {
            cell(
                width,
                item.series.clone().unwrap_or_default(),
                theme.text_secondary,
            )
        }))
        .child(cell(columns.formats, formats, theme.text_tertiary))
        .children(columns.added.map(|width| {
            cell(
                width,
                item.added_at.get(..10).unwrap_or("").to_owned(),
                theme.text_tertiary,
            )
        }))
}

fn cell(width: f32, text: impl Into<SharedString>, color: gpui::Rgba) -> Div {
    div()
        .w(px(width))
        .flex_shrink_0()
        .px_2()
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .text_color(color)
        .child(text.into())
}

fn empty_label(state: &LibraryEntity, cx: &App) -> &'static str {
    let read = state.read(cx);
    if read.loading {
        "Loading..."
    } else if !read.query.is_empty() || !read.filters.is_empty() {
        "No books match"
    } else {
        match read.section {
            crate::state::Section::Library => {
                "Add books or drop files here. Your originals stay where they are."
            }
            crate::state::Section::Trash => "Trash is empty",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_fits(viewport: f32, columns: ColumnLayout) {
        let total = columns.title
            + columns.author
            + columns.formats
            + columns.series.unwrap_or(0.)
            + columns.added.unwrap_or(0.);
        let available = viewport - metrics::SIDEBAR_WIDTH - metrics::INSPECTOR_WIDTH;
        assert!(
            (total - available).abs() < 0.01,
            "columns {total} must fit {available}"
        );
        assert!(columns.title >= 180.);
        assert!(columns.author >= 110.);
        assert!(columns.formats >= 80.);
    }

    #[test]
    fn narrow_900_keeps_title_author_formats_visible() {
        let columns = ColumnLayout::for_viewport(900.);
        assert_fits(900., columns);
        assert!(columns.series.is_none());
        assert!(columns.added.is_none());
    }

    #[test]
    fn normal_1280_shows_every_column_without_overflow() {
        let columns = ColumnLayout::for_viewport(1280.);
        assert_fits(1280., columns);
        assert!(columns.series.is_some());
        assert!(columns.added.is_some());
    }

    #[test]
    fn wide_1800_gives_extra_space_to_title_and_author() {
        let normal = ColumnLayout::for_viewport(1280.);
        let columns = ColumnLayout::for_viewport(1800.);
        assert_fits(1800., columns);
        assert!(columns.series.is_some());
        assert!(columns.added.is_some());
        assert!(columns.title > normal.title);
        assert!(columns.author > normal.author);
    }
}
