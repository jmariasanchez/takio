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
        let epoch = self.state.read(cx).library_epoch;
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
        cx.spawn(async move |this, cx| {
            let accepted = answer.await == Ok(1);
            let _ = this.update(cx, |this, cx| {
                if !accepted
                    || this.state.read(cx).library_epoch != epoch
                    || !this.state.read(cx).can_mutate()
                {
                    this.recovery_prompt_open = false;
                } else if restore {
                    this.choose_backup_source(cx);
                } else {
                    this.choose_recovery_destination(None, cx);
                }
            });
        })
        .detach();
    }

    fn choose_backup_source(&mut self, cx: &mut Context<Self>) {
        let epoch = self.state.read(cx).library_epoch;
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose backup".into()),
        });
        cx.spawn(async move |this, cx| {
            let response = receiver.await;
            let _ = this.update(cx, |this, cx| match response {
                Ok(Ok(Some(paths)))
                    if paths.len() == 1
                        && this.state.read(cx).library_epoch == epoch
                        && this.state.read(cx).can_mutate() =>
                {
                    this.choose_recovery_destination(paths.into_iter().next(), cx);
                }
                Ok(Ok(_)) => this.recovery_prompt_open = false,
                _ => this.recovery_picker_failed(cx),
            });
        })
        .detach();
    }

    fn choose_recovery_destination(&mut self, source: Option<PathBuf>, cx: &mut Context<Self>) {
        let epoch = self.state.read(cx).library_epoch;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let receiver = cx.prompt_for_new_path(
            &home,
            Some(if source.is_some() {
                "Takio Restored Library"
            } else {
                "Takio Backup"
            }),
        );
        cx.spawn(async move |this, cx| {
            let response = receiver.await;
            let _ = this.update(cx, |this, cx| {
                this.recovery_prompt_open = false;
                if this.state.read(cx).library_epoch != epoch {
                    return;
                }
                match response {
                    Ok(Ok(Some(destination))) => this.state.update(cx, |state, cx| {
                        if let Some(source) = source {
                            state.restore_backup_copy(source, destination, cx);
                        } else {
                            state.back_up_library(destination, cx);
                        }
                    }),
                    Ok(Ok(None)) => {}
                    _ => this.recovery_picker_failed(cx),
                }
            });
        })
        .detach();
    }

    fn recovery_picker_failed(&mut self, cx: &mut Context<Self>) {
        self.recovery_prompt_open = false;
        self.state.update(cx, |state, cx| {
            state.set_status("The recovery folder chooser could not be opened. Try again. No recovery operation was started.".into(), true, cx);
        });
    }

    pub(super) fn reveal_recovery(&self, cx: &mut Context<Self>) {
        if let Some(outcome) = &self.state.read(cx).recovery_outcome {
            cx.reveal_path(Path::new(&outcome.path));
        }
    }
}
