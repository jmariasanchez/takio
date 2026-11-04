//! A usable recovery window even when no catalogue can be opened.
use std::path::PathBuf;

use gpui::{
    AppContext, Context, Entity, FocusHandle, IntoElement, ParentElement, PathPromptOptions,
    PromptButton, PromptLevel, Render, Styled, Window, div, prelude::*, px,
};
use takio::{error::AppResult, library::paths::LibraryPaths};

use crate::{
    engine::Engine,
    startup,
    state::{LibraryState, humanize_error},
    theme::Theme,
    views::workspace::Workspace,
};

pub struct StartupWindow {
    default: LibraryPaths,
    preference: Option<PathBuf>,
    state: Option<Entity<LibraryState>>,
    workspace: Option<Entity<Workspace>>,
    busy: bool,
    message: String,
    operation: String,
    focus: FocusHandle,
}

impl StartupWindow {
    pub fn new(
        default: LibraryPaths,
        preference: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self {
            default,
            preference,
            state: None,
            workspace: None,
            busy: false,
            message: "Opening your library...".into(),
            operation: "Opening your library...".into(),
            focus: cx.focus_handle(),
        };
        window.focus(&view.focus, cx);
        let paths = view.default.clone();
        let preference = view.preference.clone();
        view.run(
            move || startup::open(paths, preference.as_deref()),
            window,
            cx,
        );
        view
    }

    pub fn can_close(&mut self, cx: &mut Context<Self>) -> bool {
        if let Some(state) = &self.state {
            return state.update(cx, |state, cx| state.can_close(cx));
        }
        !self.busy
    }

    fn run(
        &mut self,
        job: impl FnOnce() -> AppResult<(Engine, crate::activation::ActivationReport)> + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        self.message = self.operation.clone();
        let task = cx.background_executor().spawn(async move { job() });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok((engine, report)) => {
                        let state = cx.new(|cx| {
                            let mut state = LibraryState::new(engine, cx);
                            state.set_preference_path(this.preference.clone());
                            if let Some(warning) = report.warning {
                                state.set_status(warning, true, cx);
                            }
                            state
                        });
                        this.workspace = Some(cx.new(|cx| Workspace::new(state.clone(), window, cx)));
                        this.state = Some(state);
                    }
                    Err(error) => {
                        this.message = format!(
                            "Operation failed: {}\n{}\nChoose another existing library, or restore a backup into a separate new folder. No original library is replaced.",
                            this.operation,
                            humanize_error(error.kind()),
                        );
                        window.focus(&this.focus, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn choose_existing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.workspace.is_some() {
            return;
        }
        self.busy = true;
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open existing library".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let response = receiver.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match response {
                    Ok(Ok(Some(mut paths))) if paths.len() == 1 => {
                        let root = paths.remove(0);
                        this.operation = format!("Opening {}", root.display());
                        let preference = this.preference.clone();
                        this.run(
                            move || startup::open_recovery(root, preference.as_deref()),
                            window,
                            cx,
                        );
                    }
                    Ok(Ok(_)) => {}
                    _ => this.message =
                        "The folder chooser could not be opened. Try again. Nothing was changed."
                            .into(),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn confirm_restore(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.workspace.is_some() {
            return;
        }
        self.busy = true;
        let answer = window.prompt(
            PromptLevel::Info,
            "Restore and open a separate library copy?",
            Some("Choose a Takio backup and a new folder outside the original library. The copy is verified before opening. Existing folders and the original library are never replaced. External referenced books and conversion jobs are not included. Cancel either chooser to make no changes."),
            &[PromptButton::cancel("Cancel"), PromptButton::new("Choose backup")],
            cx,
        );
        cx.spawn_in(window, async move |this, cx| {
            let accepted = answer.await == Ok(1);
            let _ = this.update_in(cx, |this, window, cx| {
                if accepted {
                    this.choose_backup(window, cx);
                } else {
                    this.busy = false;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn choose_backup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose backup".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let response = receiver.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match response {
                    Ok(Ok(Some(mut paths))) if paths.len() == 1 => {
                        this.choose_destination(paths.remove(0), window, cx);
                    }
                    Ok(Ok(_)) => this.busy = false,
                    _ => {
                        this.busy = false;
                        this.message =
                            "The backup chooser could not be opened. Nothing was changed.".into();
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_destination(&mut self, source: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let home = crate::recovery_chooser_directory();
        let receiver = cx.prompt_for_new_path(&home, Some("Takio Recovered Library"));
        cx.spawn_in(window, async move |this, cx| {
            let response = receiver.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match response {
                    Ok(Ok(Some(destination))) => {
                        this.operation =
                            format!("Restoring a separate copy at {}", destination.display());
                        let default = this.default.root.clone();
                        let preference = this.preference.clone();
                        this.run(
                            move || {
                                startup::restore_recovery(
                                    &source,
                                    &destination,
                                    &default,
                                    preference.as_deref(),
                                )
                            },
                            window,
                            cx,
                        );
                    }
                    Ok(Ok(None)) => {}
                    _ => {
                        this.message =
                            "The destination chooser could not be opened. Nothing was changed."
                                .into()
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for StartupWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(workspace) = &self.workspace {
            return div().size_full().child(workspace.clone());
        }
        let theme = *cx.global::<Theme>();
        let enabled = !self.busy;
        div()
            .size_full()
            .track_focus(&self.focus)
            .bg(theme.window_bg)
            .text_color(theme.text)
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .p_8()
            .gap_4()
            .on_action(cx.listener(|this, _: &crate::OpenLibrary, window, cx| this.choose_existing(window, cx)))
            .on_action(cx.listener(|this, _: &crate::RestoreBackupCopy, window, cx| this.confirm_restore(window, cx)))
            .child(div().text_xl().child(if self.busy { "Opening or recovering library" } else { "Your library needs attention" }))
            .child(div().max_w(px(720.)).child(format!("Default library: {}", self.default.root.display())))
            .child(div().id("startup-status").role(gpui::Role::Status).aria_label(self.message.clone()).max_w(px(720.)).child(self.message.clone()))
            .child(div().flex().gap_3()
                .child(div().id("startup-open-library").px_4().py_2().rounded_md().bg(theme.accent).text_color(theme.panel_bg)
                    .map(|el| crate::views::search::accessible_button(el, "Open Existing Library", enabled))
                    .cursor_pointer().on_click(cx.listener(|this, _, window, cx| this.choose_existing(window, cx)))
                    .child("Open Existing Library..."))
                .child(div().id("startup-restore-copy").px_4().py_2().rounded_md().bg(theme.panel_bg)
                    .map(|el| crate::views::search::accessible_button(el, "Restore Backup to New Folder", enabled))
                    .cursor_pointer().on_click(cx.listener(|this, _, window, cx| this.confirm_restore(window, cx)))
                    .child("Restore Backup to New Folder..."))
                .child(div().id("startup-quit").px_4().py_2().rounded_md().bg(theme.panel_bg)
                    .map(|el| crate::views::search::accessible_button(el, "Quit", enabled))
                    .cursor_pointer().on_click(cx.listener(|this, _, _, cx| { if this.can_close(cx) { cx.quit(); } }))
                    .child("Quit")))
            .child(div().text_sm().text_color(theme.text_secondary).child(if self.busy {
                "Please wait, or cancel the open chooser. Closing is blocked until the operation finishes."
            } else {
                "The original remains in place. Recovery does not repair or overwrite it."
            }))
    }
}

#[cfg(test)]
mod tests;
