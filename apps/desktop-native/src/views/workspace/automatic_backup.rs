//! Explicit consent and an existing external destination precede every enable request.
use super::*;

impl Workspace {
    pub(super) fn prompt_automatic_backup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.recovery_prompt_open
            || self.library_picker_open
            || !self.state.read(cx).can_mutate()
        {
            return;
        }
        self.recovery_prompt_open = true;
        self.state
            .update(cx, |state, cx| state.set_automatic_backup_prompt(true, cx));
        let config = &self.state.read(cx).automatic_backup().config;
        let current = if config.enabled {
            format!(
                "Currently enabled. Destination: {}.\n\n",
                config
                    .destination
                    .as_deref()
                    .map_or_else(|| "unavailable".into(), |path| path.display().to_string())
            )
        } else {
            "Currently disabled.\n\n".into()
        };
        let detail = format!(
            "{current}{}",
            crate::settings::automatic_backup::EXPLANATION
        );
        let answer = window.prompt(
            PromptLevel::Info,
            "Enable automatic recovery copies?",
            Some(&detail),
            &[
                PromptButton::cancel("Cancel"),
                PromptButton::new("Choose existing folder"),
            ],
            cx,
        );
        self.after_dialog(answer, cx, |this, answer, cx| {
                if answer != Some(Ok(1)) {
                    this.finish_automatic_backup_prompt(cx);
                    return;
                }
                let receiver = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Keep all recovery copies here".into()) });
                this.after_dialog(receiver, cx, |this, response, cx| {
                        this.finish_automatic_backup_prompt(cx);
                        match response {
                            Some(Ok(Ok(Some(mut paths)))) if paths.len() == 1 => {
                                this.state.update(cx, |state, cx| state.configure_automatic_backup(paths.pop(), cx));
                            }
                            None | Some(Ok(Ok(_))) => {}
                            _ => this.state.update(cx, |state, cx| state.set_status("Could not open the recovery destination chooser. Settings were not changed.".into(), true, cx)),
                        }
                });
        });
    }

    fn finish_automatic_backup_prompt(&mut self, cx: &mut Context<Self>) {
        self.recovery_prompt_open = false;
        self.state
            .update(cx, |state, cx| state.set_automatic_backup_prompt(false, cx));
    }

    pub(super) fn disable_automatic_backup(&mut self, cx: &mut Context<Self>) {
        if self.recovery_prompt_open || self.library_picker_open {
            return;
        }
        self.state
            .update(cx, |state, cx| state.configure_automatic_backup(None, cx));
    }
}
