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
        let epoch = self.state.read(cx).library_epoch();
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
        let detail = format!("{current}{}", crate::automatic_backup::EXPLANATION);
        let pause = self.state.read(cx).automatic_backup().pause();
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
        cx.spawn(async move |this, cx| {
            let accepted = answer.await == Ok(1);
            drop(pause);
            let _ = this.update(cx, |this, cx| {
                if !accepted || this.state.read(cx).library_epoch() != epoch || !this.state.read(cx).can_mutate() {
                    this.finish_automatic_backup_prompt(cx);
                    return;
                }
                let pause = this.state.read(cx).automatic_backup().pause();
                let receiver = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Keep all recovery copies here".into()) });
                cx.spawn(async move |this, cx| {
                    let response = receiver.await;
                    drop(pause);
                    let _ = this.update(cx, |this, cx| {
                        this.finish_automatic_backup_prompt(cx);
                        if this.state.read(cx).library_epoch() != epoch { return; }
                        match response {
                            Ok(Ok(Some(mut paths))) if paths.len() == 1 => {
                                this.state.update(cx, |state, cx| state.configure_automatic_backup(paths.pop(), cx));
                            }
                            Ok(Ok(_)) => {}
                            _ => this.state.update(cx, |state, cx| state.set_status("Could not open the recovery destination chooser. Settings were not changed.".into(), true, cx)),
                        }
                    });
                }).detach();
            });
        }).detach();
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
