//! Three-pane shell: sidebar, list, inspector, plus toolbar and status bar.

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

use gpui::{
    App, Context, Entity, ExternalPaths, FocusHandle, Focusable, IntoElement, ParentElement,
    PathPromptOptions, PromptButton, PromptLevel, Render, Styled, Window, div, prelude::*, px,
};

use crate::engine::ImportMode;
use crate::state::{LibraryEntity, Section, humanize_error};
use crate::theme::{Theme, metrics};
use crate::views::library_list::LibraryList;
use crate::views::{search::Search, sidebar::Sidebar};
use crate::{
    Import, ImportMove, OpenSelected, PurgeSelected, RefreshDevices, RestoreSelected, SelectAll,
    ShowLibrary, ShowTrash, TrashSelected,
};

pub struct Workspace {
    state: LibraryEntity,
    list: Entity<LibraryList>,
    search: Entity<Search>,
    sidebar: Entity<Sidebar>,
    inspector: Entity<crate::views::inspector::Inspector>,
    palette: Entity<crate::views::palette::Palette>,
    focus: FocusHandle,
}

impl Workspace {
    pub fn new(state: LibraryEntity, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| Search::new(state.clone(), cx));
        let sidebar = cx.new(|cx| Sidebar::new(state.clone(), cx));
        let list = cx.new(|cx| LibraryList::new(state.clone(), cx));
        let inspector = cx.new(|cx| crate::views::inspector::Inspector::new(state.clone(), cx));
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        cx.observe_window_appearance(window, |_, window, cx| {
            cx.set_global(Theme::for_appearance(window.appearance()));
            cx.notify();
        })
        .detach();
        let focus = list.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        let palette = cx.new(|cx| crate::views::palette::Palette::new(focus.clone(), cx));
        Self {
            state,
            list,
            inspector,
            focus,
            palette,
            search,
            sidebar,
        }
    }

    fn prompt_import(&mut self, mode: ImportMode, window: &mut Window, cx: &mut Context<Self>) {
        if !self.state.read(cx).can_mutate() {
            return;
        }
        if mode == ImportMode::Copy {
            self.choose_import_paths(mode, cx);
            return;
        }
        let answer = window.prompt(
            PromptLevel::Warning,
            "Move originals into Takio?",
            Some("The selected files will leave their current folders after a verified import. Use Add books instead to keep your originals."),
            &[PromptButton::cancel("Cancel"), PromptButton::new("Choose files to move")],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await == Ok(1) {
                let _ = this.update(cx, |this, cx| this.choose_import_paths(mode, cx));
            }
        })
        .detach();
    }

    fn choose_import_paths(&mut self, mode: ImportMode, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some(
                if mode == ImportMode::Copy {
                    "Add books"
                } else {
                    "Move into Takio"
                }
                .into(),
            ),
        });
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await {
                state.update(cx, |state, cx| state.import(paths, mode, cx));
            }
        })
        .detach();
    }

    fn confirm_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if state.section != Section::Trash || !state.can_mutate() {
            return;
        }
        let ids = state.selected_ids();
        if ids.is_empty() {
            return;
        }
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("Permanently delete {} book(s)?", ids.len()),
            Some("This cannot be undone. Takio-managed copies will be deleted. Original files and referenced files outside Takio will be kept."),
            &[PromptButton::cancel("Cancel"), PromptButton::new("Delete permanently")],
            cx,
        );
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if answer.await == Ok(1) {
                state.update(cx, |state, cx| state.purge_confirmed(ids, cx));
            }
        })
        .detach();
    }

    fn choose_reader(&mut self, send: bool, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if !state.can_mutate() {
            return;
        }
        let ids = state.selected_ids();
        if send && (state.section != Section::Library || ids.is_empty()) {
            self.state.update(cx, |state, cx| {
                state.set_status("Select books in your Library first".into(), false, cx)
            });
            return;
        }
        let readers: Vec<_> = state
            .destinations
            .iter()
            .filter(|device| !matches!(device.kind, takio::destinations::DestinationKind::Generic))
            .cloned()
            .collect();
        if readers.is_empty() {
            self.state.update(cx, |state, cx| {
                state.set_status(
                    "Connect a USB reader, then use Refresh readers".into(),
                    false,
                    cx,
                )
            });
            return;
        }
        let mut buttons = vec![PromptButton::cancel("Cancel")];
        buttons.extend(
            readers
                .iter()
                .map(|device| PromptButton::new(device.name.clone())),
        );
        let message = if send {
            format!("Send {} selected book(s) to which reader?", ids.len())
        } else {
            "Eject which reader?".to_owned()
        };
        let answer = window.prompt(PromptLevel::Info, &message,
            Some(if send { "Takio sends attached compatible formats only. Existing files are never overwritten. Each result is reported." } else { "Wait for a successful eject before unplugging the USB cable." }),
            &buttons, cx);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Ok(index) = answer.await
                && let Some(destination) = index
                    .checked_sub(1)
                    .and_then(|index| readers.get(index))
                    .cloned()
            {
                state.update(cx, |state, cx| {
                    if send {
                        state.send_ids_to(destination, ids, cx);
                    } else {
                        state.eject(destination, cx);
                    }
                });
            }
        })
        .detach();
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let read = self.state.read(cx);
        let count = read.items.len();
        let selected = read.selected.len();
        let status = read.status.clone();
        let loading = read.loading;
        let section = read.section;
        let can_mutate = read.can_mutate();
        let report = read.delivery_report.clone();

        let summary = if selected > 0 {
            format!("{selected} of {count} selected")
        } else if loading {
            "Loading...".to_owned()
        } else {
            format!("{count} book{}", if count == 1 { "" } else { "s" })
        };

        let status_bar = div()
            .min_h(px(24.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .px_3()
            .py_1()
            .gap_3()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.window_bg)
            .text_xs()
            .text_color(theme.text_secondary)
            .child(div().flex_shrink_0().child(summary))
            .children(status.map(|status| {
                div()
                    .flex_1()
                    .min_w_0()
                    .text_color(if status.is_error {
                        theme.danger
                    } else {
                        theme.text_tertiary
                    })
                    .child(status.text)
            }));

        div()
            .key_context("Workspace")
            .on_action(cx.listener(|this, _: &crate::FocusSearch, window, cx| {
                this.search
                    .update(cx, |search, cx| search.focus(window, cx));
            }))
            .on_action(cx.listener(|this, _: &crate::TogglePalette, window, cx| {
                this.palette.update(cx, |p, cx| p.toggle(window, cx));
            }))
            .on_action(cx.listener(|this, _: &Import, window, cx| {
                this.prompt_import(ImportMode::Copy, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ImportMove, window, cx| {
                this.prompt_import(ImportMode::Move, window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::EditSelected, window, cx| {
                this.inspector
                    .update(cx, |inspector, cx| inspector.edit_selected(window, cx));
            }))
            .on_action(cx.listener(|this, _: &ShowLibrary, _, cx| {
                this.state
                    .update(cx, |state, cx| state.set_section(Section::Library, cx));
            }))
            .on_action(cx.listener(|this, _: &ShowTrash, _, cx| {
                this.state
                    .update(cx, |state, cx| state.set_section(Section::Trash, cx));
            }))
            .on_action(cx.listener(|this, _: &RestoreSelected, _, cx| {
                this.state
                    .update(cx, |state, cx| state.restore_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &PurgeSelected, window, cx| {
                this.confirm_purge(window, cx);
            }))
            .on_action(cx.listener(|this, _: &RefreshDevices, _, cx| {
                this.state
                    .update(cx, |state, cx| state.refresh_destinations(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::SendSelected, window, cx| {
                this.choose_reader(true, window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::EjectReader, window, cx| {
                this.choose_reader(false, window, cx)
            }))
            // Fallbacks for actions the list handles when it has focus. Menu
            // items and the palette can fire these while Search or the
            // inspector owns focus; without these the action would be lost.
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
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.state.update(cx, |state, cx| {
                    state.import(paths.0.to_vec(), ImportMode::Copy, cx)
                });
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.window_bg)
            .text_color(theme.text)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.sidebar.clone())
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .child(
                                div()
                                    .min_h(px(metrics::TOOLBAR_HEIGHT))
                                    .flex_shrink_0()
                                    .flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap_2()
                                    .px_3()
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .child(self.search.clone())
                                    .child(div().flex_1())
                                    .child(
                                        toolbar_button("add-books", "Add books", can_mutate, theme)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.prompt_import(ImportMode::Copy, window, cx)
                                            })),
                                    )
                                    .when(section == Section::Library && selected > 0, |toolbar| {
                                        toolbar.child(
                                            toolbar_button(
                                                "trash-books",
                                                "Trash",
                                                can_mutate,
                                                theme,
                                            )
                                            .on_click(
                                                cx.listener(|this, _, _, cx| {
                                                    this.state.update(cx, |state, cx| {
                                                        state.trash_selected(cx)
                                                    })
                                                }),
                                            ),
                                        )
                                    })
                                    .when(section == Section::Trash, |toolbar| {
                                        toolbar
                                            .child(
                                                toolbar_button(
                                                    "restore-books",
                                                    "Restore",
                                                    can_mutate && selected > 0,
                                                    theme,
                                                )
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.state.update(cx, |state, cx| {
                                                        state.restore_selected(cx)
                                                    })
                                                })),
                                            )
                                            .child(
                                                toolbar_button(
                                                    "purge-books",
                                                    "Delete permanently",
                                                    can_mutate && selected > 0,
                                                    theme,
                                                )
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.confirm_purge(window, cx)
                                                })),
                                            )
                                    }),
                            )
                            .child(div().flex_1().min_h_0().child(self.list.clone()))
                            .children(report.map(|report| {
                                div()
                                    .flex()
                                    .flex_col()
                                    .max_h(px(180.))
                                    .border_t_1()
                                    .border_color(theme.border)
                                    .p_3()
                                    .gap_2()
                                    .child(
                                        div()
                                            .flex()
                                            .justify_between()
                                            .child(div().text_sm().child("Transfer results"))
                                            .child(
                                                div()
                                                    .id("dismiss-transfers")
                                                    .cursor_pointer()
                                                    .text_sm()
                                                    .text_color(theme.accent)
                                                    .child("Dismiss")
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.state.update(cx, |state, cx| {
                                                            state.delivery_report = None;
                                                            cx.notify();
                                                        })
                                                    })),
                                            ),
                                    )
                                    .child(
                                        div().id("transfer-results").overflow_y_scroll().children(
                                            report.entries.into_iter().map(|entry| {
                                                let (message, error) = match entry.result {
                                                    Ok(_) => {
                                                        ("Sent and verified".to_owned(), false)
                                                    }
                                                    Err(code) => (humanize_error(&code), true),
                                                };
                                                div()
                                                    .id(gpui::SharedString::from(entry.item_id))
                                                    .py_1()
                                                    .text_xs()
                                                    .text_color(if error {
                                                        theme.danger
                                                    } else {
                                                        theme.text_secondary
                                                    })
                                                    .child(format!("{}: {message}", entry.title))
                                            }),
                                        ),
                                    )
                            })),
                    )
                    .child(self.inspector.clone()),
            )
            .child(status_bar)
            .child(gpui::deferred(self.palette.clone()).with_priority(10))
    }
}

fn toolbar_button(
    id: &'static str,
    label: &'static str,
    enabled: bool,
    theme: Theme,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_2()
        .py_1()
        .text_sm()
        .rounded(px(metrics::RADIUS))
        .bg(theme.row_selected_inactive)
        .text_color(if enabled {
            theme.text
        } else {
            theme.text_tertiary
        })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(|style| style.bg(theme.row_hover))
        })
        .child(label)
}
