//! Explicit existing-folder selection and per-library native view lifetime.
use super::*;

impl Workspace {
    pub(super) fn prompt_open_library(&mut self, cx: &mut Context<Self>) {
        if self.library_picker_open || self.recovery_prompt_open {
            return;
        }
        if !self.state.read(cx).can_switch_library() {
            self.state.update(cx, |state, cx| {
                state.set_status("Finish the current operation, save/cancel edits and close any review before opening another library.".into(), true, cx);
            });
            return;
        }
        self.library_picker_open = true;
        let epoch = self.state.read(cx).library_epoch;
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open library".into()),
        });
        cx.notify();
        cx.spawn(async move |this, cx| {
            let response = receiver.await;
            let _ = this.update(cx, |this, cx| {
                this.library_picker_open = false;
                if this.state.read(cx).library_epoch != epoch {
                    cx.notify();
                    return;
                }
                match response {
                    Ok(Ok(Some(mut paths))) if paths.len() == 1 => {
                        this.state.update(cx, |state, cx| state.open_library(paths.remove(0), cx));
                    }
                    Ok(Ok(_)) => {},
                    _ => this.state.update(cx, |state, cx| {
                        state.set_status("The library chooser could not be opened. Try again. Your current library is unchanged.".into(), true, cx);
                    }),
                }
                cx.notify();
            });
        }).detach();
    }

    pub(super) fn reset_library_views(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let epoch = self.state.read(cx).library_epoch;
        if epoch == self.library_epoch {
            return;
        }
        self.library_epoch = epoch;
        self.search = cx.new(|cx| Search::new(self.state.clone(), cx));
        self.sidebar = cx.new(|cx| Sidebar::new(self.state.clone(), cx));
        self.list = cx.new(|cx| LibraryList::new(self.state.clone(), cx));
        self.inspector =
            cx.new(|cx| crate::views::inspector::Inspector::new(self.state.clone(), cx));
        self.focus = self.list.read(cx).focus_handle(cx);
        self.palette = cx.new(|cx| crate::views::palette::Palette::new(self.focus.clone(), cx));
        window.focus(&self.focus, cx);
    }
}
