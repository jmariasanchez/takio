//! Three-pane shell: sidebar, list, inspector, plus toolbar and status bar.

#[cfg(test)]
mod tests;

mod recovery;

mod automatic_backup;

mod library;
mod panels;

use gpui::{
    App, Context, Entity, ExternalPaths, FocusHandle, Focusable, IntoElement, ParentElement,
    PathPromptOptions, PromptButton, PromptLevel, Render, Styled, Window, div, prelude::*, px,
};

use super::button::button as toolbar_button;
use crate::state::{LibraryEntity, Section, humanize_error};
use crate::theme::{Theme, metrics};
use crate::views::library_list::LibraryList;
use crate::views::{sidebar::Sidebar, text_input::TextInput};
use crate::{
    Import, ImportMove, OpenSelected, PurgeSelected, RefreshReaders, RestoreSelected, SelectAll,
    ShowLibrary, ShowTrash, TrashSelected,
};
use takio::library::model::ImportMode;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReaderAction {
    Send,
    Eject,
}

pub struct Workspace {
    state: LibraryEntity,
    list: Entity<LibraryList>,
    search: Entity<TextInput>,
    sidebar: Entity<Sidebar>,
    inspector: Entity<crate::views::inspector::Inspector>,
    palette: Entity<crate::views::palette::Palette>,
    focus: FocusHandle,
    recovery_prompt_open: bool,
    library_picker_open: bool,
    library_epoch: u64,
}

impl Workspace {
    /// Always completes for cleanup, but only returns a response for a mutable,
    /// unchanged library. The backup pause spans the entire native dialog.
    fn after_dialog<F>(
        &mut self,
        response: F,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Option<F::Output>, &mut Context<Self>) + 'static,
    ) where
        F: std::future::Future + 'static,
    {
        let epoch = self.state.read(cx).library_epoch();
        let pause = self.state.read(cx).automatic_backup().pause();
        cx.spawn(async move |this, cx| {
            let response = response.await;
            drop(pause);
            let _ = this.update(cx, |this, cx| {
                let state = this.state.read(cx);
                let current = state.library_epoch() == epoch && state.can_mutate();
                then(this, current.then_some(response), cx);
            });
        })
        .detach();
    }

    pub(crate) fn benchmark_search(&self) -> Entity<TextInput> {
        self.search.clone()
    }

    pub(crate) fn benchmark_list(&self) -> Entity<LibraryList> {
        self.list.clone()
    }

    pub fn new(state: LibraryEntity, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| super::search::new(state.clone(), cx));
        let sidebar = cx.new(|cx| Sidebar::new(state.clone(), cx));
        let list = cx.new(|cx| LibraryList::new(state.clone(), cx));
        let inspector = cx.new(|cx| crate::views::inspector::Inspector::new(state.clone(), cx));
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let focus = list.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        let palette = cx.new(|cx| crate::views::palette::Palette::new(focus.clone(), cx));
        let library_epoch = state.read(cx).library_epoch();
        Self {
            state,
            list,
            inspector,
            focus,
            palette,
            search,
            sidebar,
            recovery_prompt_open: false,
            library_picker_open: false,
            library_epoch,
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
        self.after_dialog(answer, cx, move |this, answer, cx| {
            if answer == Some(Ok(1)) {
                this.choose_import_paths(mode, cx);
            }
        });
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
        self.after_dialog(receiver, cx, move |this, response, cx| {
            if let Some(Ok(Ok(Some(paths)))) = response {
                this.state.update(cx, |state, cx| {
                    state.import(paths, mode, cx);
                });
            }
        });
    }

    fn confirm_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if state.session().section != Section::Trash || !state.can_mutate() {
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
        self.after_dialog(answer, cx, move |this, answer, cx| {
            if answer == Some(Ok(1)) {
                this.state.update(cx, |state, cx| {
                    state.purge_confirmed(ids, cx);
                });
            }
        });
    }

    fn choose_reader(&mut self, action: ReaderAction, window: &mut Window, cx: &mut Context<Self>) {
        let send = action == ReaderAction::Send;
        let state = self.state.read(cx);
        if !state.can_mutate() {
            return;
        }
        let ids = state.selected_ids();
        if send && (state.session().section != Section::Library || ids.is_empty()) {
            self.state.update(cx, |state, cx| {
                state.set_status("Select books in your Library first".into(), false, cx)
            });
            return;
        }
        let readers: Vec<_> = state
            .destinations()
            .iter()
            .filter(|device| device.is_reader())
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
            format!(
                "Send {} selected book(s): review for which reader?",
                ids.len()
            )
        } else {
            "Eject which reader?".to_owned()
        };
        let answer = window.prompt(PromptLevel::Info, &message,
            Some(if send { "Next, review compatible formats and any blocked books. Nothing is sent until you confirm Send ready." } else { "Wait for a successful eject before unplugging the USB cable." }),
            &buttons, cx);
        self.after_dialog(answer, cx, move |this, response, cx| {
            if let Some(Ok(index)) = response
                && let Some(destination) = index
                    .checked_sub(1)
                    .and_then(|index| readers.get(index))
                    .cloned()
            {
                this.state.update(cx, |state, cx| {
                    if send {
                        state.send_ids_to(destination, ids, cx);
                    } else {
                        state.eject(destination, cx);
                    }
                });
            }
        });
    }

    fn preparation_review(
        &self,
        preview: takio::conversion::prepare::PreparationPreview,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let enabled = preview.backend.available && !self.state.read(cx).session().loading;
        let backend_message = if preview.backend.available {
            "Calibre is available. Conversion runs locally and can take up to two minutes."
        } else {
            "Calibre was not found. Install Calibre in Applications, then cancel and try again. Advanced setup: set TAKIO_EBOOK_CONVERT to its full executable path."
        };
        div()
            .id("preparation-review")
            .role(gpui::Role::Group)
            .aria_label(format!("Prepare {} for Kindle. {backend_message}", preview.title))
            .aria_description("EPUB to AZW3. Your EPUB is kept. Nothing has been converted or sent yet. Conversion does not remove DRM.")
            .flex().flex_col().flex_shrink_0().gap_2().p_3()
            .border_t_1().border_color(theme.border)
            .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD)
                .child("Prepare for Kindle"))
            .child(div().id("preparation-details").max_h(px(160.)).overflow_y_scroll()
                .flex().flex_col().gap_2()
                .child(div().text_sm().child(preview.title))
                .child(div().text_xs().child("EPUB to AZW3. Your EPUB is kept. Nothing has been converted or sent yet."))
                .child(div().text_xs().text_color(theme.text_secondary).child(backend_message))
                .children(preview.backend.path.map(|path| {
                    div().id("preparation-backend-path").overflow_x_scroll().text_xs()
                        .text_color(theme.text_tertiary).child(path.display().to_string())
                }))
                .child(div().text_xs().text_color(theme.text_secondary)
                    .child("Adds an AZW3 copy to this book in your library. Sending requires a separate review. Conversion does not remove DRM.")))
            .child(div().flex().flex_wrap().gap_2()
                .child(toolbar_button("cancel-preparation", "Cancel", true, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.cancel_preparation(cx));
                    })))
                .child(toolbar_button("confirm-preparation", "Convert to AZW3", enabled, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.confirm_preparation(cx));
                    }))))
    }

    fn send_review(
        &self,
        preview: crate::engine::SendPreview,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let ready = preview.ready_count();
        let blocked = preview.entries.len() - ready;
        let enabled = ready > 0 && !self.state.read(cx).session().loading;
        div()
            .id("send-review")
            .role(gpui::Role::Group)
            .aria_label(format!("Review send to {}. {ready} ready, {blocked} need attention. Nothing sent yet.", preview.destination.name))
            .aria_description("Files are checked again when sending. Existing reader files are never overwritten.")
            .flex().flex_col().flex_shrink_0().gap_2().p_3()
            .border_t_1().border_color(theme.border)
            .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD)
                .child(format!("Review send to {}", preview.destination.name)))
            .child(div().text_xs().text_color(theme.text_secondary)
                .child(format!("{ready} ready, {blocked} need attention. Nothing sent yet.")))
            .child(div().id("send-review-books").max_h(px(130.)).overflow_y_scroll()
                .children(preview.entries.into_iter().map(|entry| {
                    let (message, blocked) = match entry.result {
                        Ok(file) => (format!("Ready as {}", file.format.as_str().to_uppercase()), false),
                        Err(error) => (format!("Not ready: {}", humanize_error(error.kind())), true),
                    };
                    div().id(gpui::SharedString::from(entry.item_id)).role(gpui::Role::Label)
                        .aria_label(format!("{}: {message}", entry.title)).py_1().text_xs()
                        .text_color(if blocked { theme.danger } else { theme.text_secondary })
                        .child(format!("{}: {message}", entry.title))
                })))
            .child(div().text_xs().text_color(theme.text_tertiary)
                .child("No conversion. Files are checked again when sending. Existing reader files are never overwritten."))
            .child(div().flex().flex_wrap().gap_2()
                .child(toolbar_button("cancel-send-review", "Cancel", true, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.cancel_send_preview(cx));
                    })))
                .child(toolbar_button("confirm-send-review", format!("Send {ready} ready"), enabled, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.confirm_send_preview(cx));
                    }))))
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.reset_library_views(window, cx);
        let theme = *cx.global::<Theme>();
        let read = self.state.read(cx);
        let count = read.session().items.len();
        let selected = read.session().selected.len();
        let status = read.session().status.clone();
        let loading = read.session().loading;
        let report = read.session().delivery_report.clone();
        let preview = read.send_preview().cloned();
        let preparation = read.preparation_preview().cloned();
        let recovery = read.session().recovery_outcome.clone();
        let exclusions = read.session().delivery_exclusions.clone();

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
                    .id("operation-status")
                    .role(gpui::Role::Status)
                    .aria_label(status.text.clone())
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
            .on_key_down(|event, window, cx| {
                if event.keystroke.key == "tab"
                    && !event.keystroke.modifiers.platform
                    && !event.keystroke.modifiers.control
                    && !event.keystroke.modifiers.alt
                {
                    if event.keystroke.modifiers.shift {
                        window.focus_prev(cx);
                    } else {
                        window.focus_next(cx);
                    }
                    cx.stop_propagation();
                }
            })
            .on_action(cx.listener(|this, _: &crate::OpenLibrary, _, cx| {
                this.prompt_open_library(cx);
            }))
            .on_action(cx.listener(|this, _: &crate::RevealLibrary, _, cx| {
                cx.reveal_path(&this.state.read(cx).library_root());
            }))
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
            .on_action(cx.listener(|this, _: &crate::BackUpLibrary, window, cx| {
                this.prompt_recovery(false, window, cx);
            }))
            .on_action(
                cx.listener(|this, _: &crate::EnableAutomaticBackups, window, cx| {
                    this.prompt_automatic_backup(window, cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::DisableAutomaticBackups, _, cx| {
                    this.disable_automatic_backup(cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::RestoreBackupCopy, window, cx| {
                    this.prompt_recovery(true, window, cx);
                }),
            )
            .on_action(cx.listener(|this, _: &crate::RevealRecovery, _, cx| {
                this.reveal_recovery(cx);
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
            .on_action(cx.listener(|this, _: &RefreshReaders, _, cx| {
                this.state
                    .update(cx, |state, cx| state.refresh_destinations(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::SendSelected, window, cx| {
                this.choose_reader(ReaderAction::Send, window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PrepareSelected, _, cx| {
                this.state
                    .update(cx, |state, cx| state.prepare_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::ConfirmPreparation, _, cx| {
                this.state
                    .update(cx, |state, cx| state.confirm_preparation(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::CancelPreparation, _, cx| {
                this.state
                    .update(cx, |state, cx| state.cancel_preparation(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::ConfirmSend, _, cx| {
                this.state
                    .update(cx, |state, cx| state.confirm_send_preview(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::CancelSend, _, cx| {
                this.state
                    .update(cx, |state, cx| state.cancel_send_preview(cx));
                this.state
                    .update(cx, |state, cx| state.cancel_preparation(cx));
            }))
            .on_action(cx.listener(|this, _: &crate::EjectReader, window, cx| {
                this.choose_reader(ReaderAction::Eject, window, cx)
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
                let path = this.state.read(cx).primary_source_path();
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
                            .child(self.library_header(theme, cx))
                            .child(self.library_toolbar(theme, cx))
                            .child(div().flex_1().min_h_0().child(self.list.clone()))
                            .children(
                                recovery.map(|outcome| self.recovery_panel(outcome, theme, cx)),
                            )
                            .children(preview.map(|preview| self.send_review(preview, theme, cx)))
                            .children(
                                preparation
                                    .map(|preview| self.preparation_review(preview, theme, cx)),
                            )
                            .children(
                                report.map(|report| {
                                    self.transfer_panel(report, exclusions, theme, cx)
                                }),
                            ),
                    )
                    .child(self.inspector.clone()),
            )
            .child(status_bar)
            .child(gpui::deferred(self.palette.clone()).with_priority(10))
    }
}
