//! Library navigation, mounted devices, and collapsible facet filters.
use std::collections::HashSet;

use gpui::{Context, IntoElement, Render, Window, div, prelude::*, px};

use crate::state::{FilterDimension, LibraryEntity, Section, humanize_error};
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
        let destinations = state.destinations().clone();
        let facets = state.facets.clone();
        let filters = state.filters.clone();
        let selected = state.selected.len();
        let available = state.can_mutate();
        let can_send = available && section == Section::Library && selected > 0;
        let refreshing = state.refreshing_devices();
        let device_error = state
            .device_error
            .as_ref()
            .map(|error| crate::state::humanize_error(error.kind()));
        let readers: Vec<_> = destinations
            .into_iter()
            .filter(|device| !matches!(device.kind, takio::destinations::DestinationKind::Generic))
            .collect();
        let mut sidebar = div()
            .id("sidebar")
            .role(gpui::Role::Navigation)
            .aria_label("Library navigation and filters")
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
        let has_stock_kindle = readers.iter().any(|reader| {
            matches!(reader.kind, takio::destinations::DestinationKind::Kindle)
                && !reader.has_koreader()
        });
        for (label, target) in [("Library", Section::Library), ("Trash", Section::Trash)] {
            sidebar = sidebar.child(
                div()
                    .id(label)
                    .map(|el| super::search::accessible_button(el, label, available))
                    .aria_selected(section == target)
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
                        if !available || !this.state.read(cx).can_mutate() {
                            return;
                        }
                        this.state
                            .update(cx, |state, cx| state.set_section(target, cx));
                    })),
            );
        }
        sidebar = sidebar.child(
            div()
                .mt_3()
                .px_2()
                .flex()
                .justify_between()
                .text_color(theme.text_tertiary)
                .child("Readers")
                .child(
                    div()
                        .id("refresh-readers")
                        .map(|el| {
                            super::search::accessible_button(el, "Refresh readers", !refreshing)
                        })
                        .text_xs()
                        .cursor_pointer()
                        .text_color(theme.accent)
                        .child(if refreshing { "Checking..." } else { "Refresh" })
                        .on_click(cx.listener(|this, _, _, cx| {
                            if this.state.read(cx).refreshing_devices() {
                                return;
                            }
                            this.state
                                .update(cx, |state, cx| state.refresh_destinations(cx))
                        })),
                ),
        );
        if readers.is_empty() {
            sidebar = sidebar.child(div().px_2().py_2().text_xs().text_color(theme.text_secondary)
                .child(device_error.unwrap_or_else(|| "Connect your reader with a data-capable USB cable. It appears here a moment after it mounts. Only mounted USB readers appear here. MTP is not supported yet.".into())));
        }
        for (index, destination) in readers.into_iter().enumerate() {
            let send = destination.clone();
            let import = destination.clone();
            let can_import = available && section == Section::Library;
            let unmatched = if state.scanning_readers {
                0
            } else {
                state
                    .reader_shelves
                    .iter()
                    .find(|(reader, _)| reader.id == destination.id)
                    .and_then(|(_, shelf)| shelf.as_ref().ok())
                    .map_or(0, |shelf| shelf.importable)
            };
            let shelf_text = if state.scanning_readers {
                "Checking books...".to_owned()
            } else {
                shelf_summary(
                    state
                        .reader_shelves
                        .iter()
                        .find(|(reader, _)| reader.id == destination.id)
                        .map(|(_, shelf)| shelf),
                )
            };
            sidebar = sidebar.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .px_2()
                    .py_2()
                    .child({
                        let label = destination.label();
                        div()
                            .id(("reader-label", index))
                            .role(gpui::Role::Label)
                            .aria_label(label.clone())
                            .min_w_0()
                            .text_ellipsis()
                            .overflow_hidden()
                            .debug_selector(|| format!("reader-label:{label}"))
                            .child(label)
                    })
                    .child(
                        div()
                            .id(("reader-summary", index))
                            .role(gpui::Role::Status)
                            .aria_label(shelf_text.clone())
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .debug_selector({
                                let text = shelf_text.clone();
                                move || format!("reader-summary:{text}")
                            })
                            .child(shelf_text),
                    )
                    .when(unmatched > 0, |row| {
                        row.child(
                            div()
                                .id(("import-reader", index))
                                .map(|el| {
                                    super::search::accessible_button(
                                        el,
                                        format!("Add {unmatched} books from reader"),
                                        can_import,
                                    )
                                })
                                .debug_selector(|| "import-reader".to_owned())
                                .text_xs()
                                .px_2()
                                .py_1()
                                .rounded(px(metrics::RADIUS))
                                .bg(theme.row_selected_inactive)
                                .text_color(if can_import {
                                    theme.accent
                                } else {
                                    theme.text_tertiary
                                })
                                .when(can_import, |button| button.cursor_pointer())
                                .child(format!("Add {unmatched} to library"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if !can_import {
                                        return;
                                    }
                                    this.state.update(cx, |state, cx| {
                                        state.import_from_reader(import.clone(), cx)
                                    });
                                })),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .id(("send-device", index))
                                    .map(|el| {
                                        super::search::accessible_button(
                                            el,
                                            format!("Review {selected} books to send"),
                                            can_send,
                                        )
                                    })
                                    .debug_selector(|| "send-device".to_owned())
                                    .text_xs()
                                    .px_2()
                                    .py_1()
                                    .rounded(px(metrics::RADIUS))
                                    .bg(theme.row_selected_inactive)
                                    .text_color(if can_send {
                                        theme.accent
                                    } else {
                                        theme.text_tertiary
                                    })
                                    .when(can_send, |button| button.cursor_pointer())
                                    .child(if can_send {
                                        format!("Review {selected} to send")
                                    } else {
                                        "Select books to send".to_owned()
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !can_send {
                                            return;
                                        }
                                        this.state.update(cx, |state, cx| {
                                            state.send_selected_to(send.clone(), cx)
                                        });
                                    })),
                            )
                            .child(
                                div()
                                    .id(("eject", index))
                                    .map(|el| {
                                        super::search::accessible_button(
                                            el,
                                            "Eject reader",
                                            available,
                                        )
                                    })
                                    .text_xs()
                                    .text_color(if available {
                                        theme.text_secondary
                                    } else {
                                        theme.text_tertiary
                                    })
                                    .when(available, |button| button.cursor_pointer())
                                    .child("Eject")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !available {
                                            return;
                                        }
                                        this.state.update(cx, |state, cx| {
                                            state.eject(destination.clone(), cx)
                                        });
                                    })),
                            ),
                    ),
            );
        }
        if has_stock_kindle {
            sidebar = sidebar.child(div().px_2().py_2().flex().flex_col().gap_1()
            .child(div().text_xs().text_color(theme.text_secondary).child("Have an EPUB? Reveal its file in the inspector, then upload it yourself on Amazon."))
            .child(div().id("amazon-send-to-kindle").map(|el| super::search::accessible_button(el, "Open Send to Kindle website", true)).debug_selector(|| "amazon-send-to-kindle".to_owned()).text_xs().text_color(theme.accent).cursor_pointer()
                .child("Open Send to Kindle website")
                .on_click(|_, _, cx| cx.open_url("https://www.amazon.com/sendtokindle")))
            .child(div().text_xs().text_color(theme.text_tertiary).child("Opens your browser. Takio does not upload files or confirm Amazon delivery.")));
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
                    .map(|el| super::search::accessible_button(el, "Clear filters", available))
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .text_color(theme.accent)
                    .child("Clear filters")
                    .on_click(cx.listener(|this, _, _, cx| {
                        if !this.state.read(cx).can_mutate() {
                            return;
                        }
                        this.state.update(cx, |state, cx| state.clear_filters(cx));
                    })),
            );
        }
        for (name, dimension, values, active) in [
            (
                "Authors",
                FilterDimension::Author,
                &facets.authors,
                &filters.authors,
            ),
            ("Tags", FilterDimension::Tag, &facets.tags, &filters.tags),
            (
                "Series",
                FilterDimension::Series,
                &facets.series,
                &filters.series,
            ),
            (
                "Formats",
                FilterDimension::Format,
                &facets.formats,
                &filters.formats,
            ),
            (
                "Languages",
                FilterDimension::Language,
                &facets.languages,
                &filters.languages,
            ),
        ] {
            let collapsed = self.collapsed.contains(name);
            groups = groups.child(
                div()
                    .id(name)
                    .map(|el| super::search::accessible_button(el, name, true))
                    .aria_expanded(!collapsed)
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
            for (value, count) in values.iter().take(50) {
                let value = value.clone();
                let selected = active.contains(&value.to_lowercase());
                groups = groups.child(
                    div()
                        .id(gpui::SharedString::from(format!("facet:{name}:{value}")))
                        .map(|el| {
                            super::search::accessible_button(
                                el,
                                format!("{name}: {value}, {count} books"),
                                available,
                            )
                        })
                        .aria_toggled(if selected {
                            gpui::Toggled::True
                        } else {
                            gpui::Toggled::False
                        })
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
                            if !available || !this.state.read(cx).can_mutate() {
                                return;
                            }
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

/// The text under a reader in the sidebar, from its last scan.
pub(crate) fn shelf_summary(
    shelf: Option<&takio::output::AppResult<takio::reader_shelf::ReaderShelf>>,
) -> String {
    let shelf = match shelf {
        Some(Ok(shelf)) => shelf,
        Some(Err(error)) => {
            return format!("Could not check books. {}", humanize_error(error.kind()));
        }
        None => return "Refresh to check books".to_owned(),
    };
    let mut text = match shelf.in_library {
        0 => "None of your books are on this reader".to_owned(),
        count => format!("{count} of your books on this reader\n● marks them in the list"),
    };
    if shelf.not_in_library > 0 {
        text.push_str(&format!(
            "\n{} other file(s) not in your library",
            shelf.not_in_library
        ));
    }
    if shelf.not_in_library > shelf.importable {
        text.push_str(&format!(
            "\n{} use formats Takio cannot add",
            shelf.not_in_library - shelf.importable
        ));
    }
    if shelf.koreader && shelf.finished + shelf.in_progress > 0 {
        text.push_str(&format!(
            "\n{} finished, {} in progress",
            shelf.finished, shelf.in_progress
        ));
    }
    if shelf.truncated {
        text.push_str("\nScan limit reached. Counts may be incomplete.");
    }
    if shelf.unreadable > 0 {
        text.push_str("\nSome folders could not be read. Counts may be incomplete.");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::shelf_summary;
    use takio::reader_shelf::ReaderShelf;

    fn shelf(koreader: bool, finished: usize, in_progress: usize) -> ReaderShelf {
        ReaderShelf {
            destination_id: "Kindle".into(),
            books: Vec::new(),
            in_library: 3,
            not_in_library: 2,
            importable: 1,
            truncated: false,
            unreadable: 0,
            koreader,
            finished,
            in_progress,
        }
    }

    #[test]
    fn koreader_summary_reports_reading_progress_and_stock_kindle_does_not() {
        let text = shelf_summary(Some(&Ok(shelf(true, 1, 2))));
        assert_eq!(
            text,
            "3 of your books on this reader\n● marks them in the list\n2 other file(s) not in your library\n1 use formats Takio cannot add\n1 finished, 2 in progress"
        );
        assert!(!shelf_summary(Some(&Ok(shelf(true, 0, 0)))).contains("finished"));
        assert!(!shelf_summary(Some(&Ok(shelf(false, 1, 2)))).contains("finished"));
        assert_eq!(
            shelf_summary(Some(&Err(takio::app_error!("storage-unavailable")))),
            "Could not check books. The library could not be read"
        );
        assert_eq!(shelf_summary(None), "Refresh to check books");
    }
}
