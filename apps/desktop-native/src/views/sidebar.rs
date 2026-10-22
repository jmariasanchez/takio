//! Library navigation, mounted devices, and collapsible facet filters.
use std::collections::HashSet;

use gpui::{Context, IntoElement, Render, Window, div, prelude::*, px};

use crate::state::{FilterDimension, LibraryEntity, Section};
use crate::theme::{Theme, metrics};

pub struct Sidebar {
    state: LibraryEntity,
    collapsed: HashSet<&'static str>,
}

impl Sidebar {
    pub fn new(state: LibraryEntity, cx: &mut Context<Self>) -> Self {
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        Self {
            state,
            collapsed: ["Tags", "Series", "Formats", "Languages"]
                .into_iter()
                .collect(),
        }
    }
}

impl Render for Sidebar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let state = self.state.read(cx);
        let section = state.section;
        let destinations = state.destinations.clone();
        let facets = state.facets.clone();
        let filters = state.filters.clone();
        let mut sidebar = div()
            .w(px(metrics::SIDEBAR_WIDTH))
            .flex_shrink_0()
            .h_full()
            .bg(theme.sidebar_bg)
            .border_r_1()
            .border_color(theme.border)
            .pt(px(44.))
            .px_2()
            .flex()
            .flex_col()
            .gap_1()
            .text_sm()
            .text_color(theme.text);
        for (label, target) in [("Library", Section::Library), ("Trash", Section::Trash)] {
            sidebar = sidebar.child(
                div()
                    .id(label)
                    .h(px(26.))
                    .px_2()
                    .flex()
                    .items_center()
                    .rounded(px(metrics::RADIUS))
                    .cursor_pointer()
                    .when(section == target, |row| row.bg(theme.row_selected_inactive))
                    .hover(|row| row.bg(theme.row_hover))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.state
                            .update(cx, |state, cx| state.set_section(target, cx));
                    })),
            );
        }
        sidebar = sidebar.child(
            div()
                .mt_3()
                .px_2()
                .text_color(theme.text_tertiary)
                .child("Devices"),
        );
        for (index, destination) in destinations.into_iter().enumerate() {
            let send = destination.clone();
            sidebar = sidebar.child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .h(px(26.))
                    .child(
                        div()
                            .id(("device", index))
                            .flex_1()
                            .min_w_0()
                            .text_ellipsis()
                            .overflow_hidden()
                            .cursor_pointer()
                            .child(destination.name.clone())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.state.update(cx, |state, cx| {
                                    if state.primary_selected().is_some() {
                                        state.send_selected_to(send.clone(), cx);
                                    }
                                });
                            })),
                    )
                    .child(
                        div()
                            .id(("eject", index))
                            .text_xs()
                            .text_color(theme.text_tertiary)
                            .cursor_pointer()
                            .child("Eject")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.state
                                    .update(cx, |state, cx| state.eject(destination.clone(), cx));
                            })),
                    ),
            );
        }
        let mut groups = div()
            .id("facets")
            .mt_3()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        if !filters.is_empty() {
            groups = groups.child(
                div()
                    .id("clear-filters")
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .text_color(theme.accent)
                    .child("Clear filters")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.clear_filters(cx));
                    })),
            );
        }
        for (name, dimension, values, active) in [
            (
                "Authors",
                FilterDimension::Author,
                facets.authors,
                filters.authors,
            ),
            ("Tags", FilterDimension::Tag, facets.tags, filters.tags),
            (
                "Series",
                FilterDimension::Series,
                facets.series,
                filters.series,
            ),
            (
                "Formats",
                FilterDimension::Format,
                facets.formats,
                filters.formats,
            ),
            (
                "Languages",
                FilterDimension::Language,
                facets.languages,
                filters.languages,
            ),
        ] {
            let collapsed = self.collapsed.contains(name);
            groups = groups.child(
                div()
                    .id(name)
                    .px_2()
                    .py_1()
                    .mt_2()
                    .cursor_pointer()
                    .text_color(theme.text_secondary)
                    .child(format!("{} {name}", if collapsed { "▸" } else { "▾" }))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.collapsed.remove(name) {
                            this.collapsed.insert(name);
                        }
                        cx.notify();
                    })),
            );
            if collapsed {
                continue;
            }
            let remaining = values.len().saturating_sub(50);
            for (index, (value, count)) in values.into_iter().take(50).enumerate() {
                let selected = active.contains(&value.to_lowercase());
                groups = groups.child(
                    div()
                        .id((name, index))
                        .h(px(26.))
                        .px_2()
                        .ml_2()
                        .flex()
                        .items_center()
                        .gap_2()
                        .rounded(px(metrics::RADIUS))
                        .cursor_pointer()
                        .when(selected, |row| row.bg(theme.row_selected_inactive))
                        .hover(|row| row.bg(theme.row_hover))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .child(value.clone()),
                        )
                        .child(
                            div()
                                .text_color(theme.text_tertiary)
                                .child(count.to_string()),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.state
                                .update(cx, |state, cx| state.toggle_filter(dimension, &value, cx));
                        })),
                );
            }
            if remaining > 0 {
                groups = groups.child(
                    div()
                        .px_2()
                        .ml_2()
                        .py_1()
                        .text_color(theme.text_tertiary)
                        .child(format!("+{remaining} more")),
                );
            }
        }
        sidebar.child(groups)
    }
}
