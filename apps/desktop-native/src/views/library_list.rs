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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let state = self.state.clone();
        let count = state.read(cx).items.len();
        let focused = self.focus.contains_focused(_window, cx);

        let header = div()
            .flex()
            .h(px(metrics::ROW_HEIGHT))
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .text_xs()
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .child(self.header_cell("Title", SortColumn::Title, 360., &theme, cx))
            .child(self.header_cell("Author", SortColumn::Author, 220., &theme, cx))
            .child(self.header_cell("Series", SortColumn::Series, 160., &theme, cx))
            .child(
                div()
                    .w(px(120.))
                    .flex_shrink_0()
                    .px_2()
                    .text_color(theme.text_secondary)
                    .child("Formats"),
            )
            .child(self.header_cell("Added", SortColumn::Added, 110., &theme, cx));

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
                        row(index, item, selected.contains(&index), focused, &theme).on_click(
                            cx.listener(move |this, event, _, cx| {
                                this.on_row_click(index, event, cx);
                            }),
                        )
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
                    .child(empty_label(&state, cx))
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
        .child(cell(360., item.title.clone(), theme.text))
        .child(cell(220., author_label(item), theme.text_secondary))
        .child(cell(
            160.,
            item.series.clone().unwrap_or_default(),
            theme.text_secondary,
        ))
        .child(cell(120., formats, theme.text_tertiary))
        .child(cell(
            110.,
            item.added_at.get(..10).unwrap_or("").to_owned(),
            theme.text_tertiary,
        ))
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
