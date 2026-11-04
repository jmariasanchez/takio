//! Native recovery dialogs. Filesystem work starts only after every chooser accepts.
use super::*;
use std::path::{Path, PathBuf};

impl Workspace {
    pub(super) fn prompt_recovery(
        &mut self,
        restore: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.recovery_prompt_open
            || self.library_picker_open
            || !self.state.read(cx).can_mutate()
        {
            return;
        }
        self.recovery_prompt_open = true;
        let (title, detail, proceed) = if restore {
            (
                "Restore a backup to a new folder?",
                "Choose a complete Takio backup, then a new folder name. The restored copy will be verified. Your current library stays open and is never replaced or merged. External references still need their original files. Conversion jobs are not restored.",
                "Choose backup",
            )
        } else {
            (
                "Back up the whole library?",
                "Copies the catalogue, including Trash, and Takio-managed books and covers. External referenced files and conversion jobs are NOT included. Choose a new folder outside your library, preferably on a separate drive. Existing folders are never replaced.",
                "Choose location",
            )
        };
        let answer = window.prompt(
            PromptLevel::Info,
            title,
            Some(detail),
            &[PromptButton::cancel("Cancel"), PromptButton::new(proceed)],
            cx,
        );
        self.after_dialog(answer, cx, move |this, answer, cx| {
            if answer != Some(Ok(1)) {
                this.recovery_prompt_open = false;
            } else if restore {
                this.choose_backup_source(cx);
            } else {
                this.choose_recovery_destination(None, cx);
            }
        });
    }

    fn choose_backup_source(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose backup".into()),
        });
        self.after_dialog(receiver, cx, |this, response, cx| match response {
            Some(Ok(Ok(Some(paths)))) if paths.len() == 1 => {
                this.choose_recovery_destination(paths.into_iter().next(), cx);
            }
            None | Some(Ok(Ok(_))) => this.recovery_prompt_open = false,
            _ => this.recovery_picker_failed(cx),
        });
    }

    fn choose_recovery_destination(&mut self, source: Option<PathBuf>, cx: &mut Context<Self>) {
        let epoch = self.state.read(cx).library_epoch();
        let home = crate::recovery_chooser_directory();
        let receiver = cx.prompt_for_new_path(
            &home,
            Some(if source.is_some() {
                "Takio Restored Library"
            } else {
                "Takio Backup"
            }),
        );
        self.after_dialog(receiver, cx, move |this, response, cx| {
            this.recovery_prompt_open = false;
            if response.is_none() && this.state.read(cx).library_epoch() == epoch {
                let detail = if source.is_some() {
                    "No restore was started."
                } else {
                    "No new backup was started."
                };
                this.state.update(cx, |state, cx| {
                    state.set_status(
                        format!("Finish the current operation or save/cancel your edits. {detail}"),
                        true,
                        cx,
                    );
                });
            }
            match response {
                Some(Ok(Ok(Some(destination)))) => this.state.update(cx, |state, cx| {
                    if let Some(source) = source {
                        state.restore_backup_copy(source, destination, cx);
                    } else {
                        state.back_up_library(destination, cx);
                    }
                }),
                None | Some(Ok(Ok(None))) => {}
                _ => this.recovery_picker_failed(cx),
            }
        });
    }

    fn recovery_picker_failed(&mut self, cx: &mut Context<Self>) {
        self.recovery_prompt_open = false;
        self.state.update(cx, |state, cx| {
            state.set_status("The recovery folder chooser could not be opened. Try again. No recovery operation was started.".into(), true, cx);
        });
    }

    pub(super) fn reveal_recovery(&self, cx: &mut Context<Self>) {
        if let Some(outcome) = &self.state.read(cx).session().recovery_outcome {
            cx.reveal_path(Path::new(&outcome.path));
        }
    }
}
