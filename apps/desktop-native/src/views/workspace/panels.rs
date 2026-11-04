//! Named workspace panels keep layout composition separate from panel content.
use super::*;
use crate::engine::{SendPreviewEntry, SendReport};
use crate::state::RecoveryOutcome;
use crate::views::button::{Variant, accessible_button, style};

impl Workspace {
    pub(super) fn library_header(&self, theme: Theme, cx: &Context<Self>) -> gpui::Div {
        let state = self.state.read(cx);
        let path = state.library_root();
        let name = path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy();
        let can_switch =
            state.can_switch_library() && !self.library_picker_open && !self.recovery_prompt_open;
        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .gap_1()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_xs()
                            .child(format!("Library: {name}")),
                    )
                    .child(
                        toolbar_button("open-library", "Open library...", can_switch, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.prompt_open_library(cx))),
                    ),
            )
            .child(
                div()
                    .id("current-library-path")
                    .overflow_x_scroll()
                    .whitespace_nowrap()
                    .text_xs()
                    .text_color(theme.text_secondary)
                    .child(path.display().to_string()),
            )
    }

    pub(super) fn library_toolbar(&self, theme: Theme, cx: &Context<Self>) -> gpui::Div {
        let state = self.state.read(cx);
        let selected = state.session().selected.len();
        let section = state.session().section;
        let can_mutate = state.can_mutate();
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
                toolbar_button("add-books", "Add books", can_mutate, theme).on_click(cx.listener(
                    |this, _, window, cx| this.prompt_import(ImportMode::Copy, window, cx),
                )),
            )
            .when(section == Section::Library && selected > 0, |toolbar| {
                toolbar.child(
                    toolbar_button("trash-books", "Trash", can_mutate, theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.state.update(cx, |state, cx| state.trash_selected(cx))
                        }),
                    ),
                )
            })
            .when(section == Section::Library && selected == 1, |toolbar| {
                toolbar.child(
                    toolbar_button("prepare-book", "Prepare for Kindle", can_mutate, theme)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.state
                                .update(cx, |state, cx| state.prepare_selected(cx));
                        })),
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
                            this.state
                                .update(cx, |state, cx| state.restore_selected(cx))
                        })),
                    )
                    .child(
                        toolbar_button(
                            "purge-books",
                            "Delete permanently",
                            can_mutate && selected > 0,
                            theme,
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.confirm_purge(window, cx)),
                        ),
                    )
            })
    }

    pub(super) fn recovery_panel(
        &self,
        outcome: RecoveryOutcome,
        theme: Theme,
        cx: &Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        div()
            .id("recovery-result")
            .role(gpui::Role::Group)
            .aria_label(format!(
                "Recovery result: {}. {}. {}",
                outcome.summary,
                outcome.detail,
                outcome.path.display()
            ))
            .flex()
            .flex_col()
            .gap_2()
            .flex_shrink_0()
            .max_h(px(220.))
            .border_t_1()
            .border_color(theme.border)
            .p_3()
            .text_sm()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .flex_shrink_0()
                    .gap_2()
                    .child(
                        toolbar_button("reveal-recovery", "Reveal folder", true, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.reveal_recovery(cx))),
                    )
                    .child(
                        toolbar_button("dismiss-recovery", "Dismiss", true, theme).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.state
                                    .update(cx, |state, cx| state.dismiss_recovery_outcome(cx));
                            }),
                        ),
                    ),
            )
            .child(
                div()
                    .id("recovery-details")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().child(outcome.summary))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .child(outcome.detail),
                    )
                    .child(
                        div()
                            .text_xs()
                            .child(outcome.path.to_string_lossy().into_owned()),
                    ),
            )
    }

    pub(super) fn transfer_panel(
        &self,
        report: SendReport,
        exclusions: Vec<SendPreviewEntry>,
        theme: Theme,
        cx: &Context<Self>,
    ) -> gpui::Div {
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
                        style(
                            accessible_button(
                                div().id("dismiss-transfers"),
                                "Dismiss transfer results",
                                true,
                            ),
                            true,
                            Variant::Text,
                            theme,
                        )
                        .child("Dismiss")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.state
                                .update(cx, |state, cx| state.dismiss_delivery_report(cx))
                        })),
                    ),
            )
            .child(
                div()
                    .id("transfer-results")
                    .role(gpui::Role::Group)
                    .aria_label("Transfer results")
                    .overflow_y_scroll()
                    .children(report.entries.into_iter().map(|entry| {
                        let (message, error) = match entry.result {
                            Ok(delivery) if delivery.record_error.is_some() => (
                                "Delivered and verified, but history was not updated".to_owned(),
                                true,
                            ),
                            Ok(_) => ("Sent and verified".to_owned(), false),
                            Err(error) => (crate::state::humanize_app_error(&error), true),
                        };
                        div()
                            .id(gpui::SharedString::from(entry.item_id))
                            .role(gpui::Role::Label)
                            .aria_label(format!("{}: {message}", entry.title))
                            .py_1()
                            .text_xs()
                            .text_color(if error {
                                theme.danger
                            } else {
                                theme.text_secondary
                            })
                            .child(format!("{}: {message}", entry.title))
                    }))
                    .children(exclusions.into_iter().map(|entry| {
                        div()
                            .py_1()
                            .text_xs()
                            .text_color(theme.text_secondary)
                            .child(format!(
                                "{}: Not sent (blocked in review). {}",
                                entry.title,
                                crate::state::humanize_app_error(
                                    entry.result.as_ref().unwrap_err()
                                )
                            ))
                    })),
            )
    }
}
