//! Existing-library activation keeps the old view until a validated catalogue arrives.
use super::*;

impl LibraryState {
    /// Startup, recovery and runtime switching initialize the same session and query path.
    pub(super) fn activate_library(&mut self, root: PathBuf, cx: &mut Context<Self>) {
        self.generation.advance();
        self.send_preview_generation.advance();
        self.preparation_generation.advance();
        self.reader_scan_generation.advance();
        self.library_root = root;
        let old_session = std::mem::take(&mut self.session);
        cx.background_executor()
            .spawn(async move { drop(old_session) })
            .detach();
        self.reload(cx);
        self.refresh_destinations(cx);
        self.initialize_automatic_backup(cx);
    }

    pub fn can_switch_library(&self) -> bool {
        self.can_mutate() && !self.refreshing_destinations
    }

    pub fn open_library(&mut self, directory: PathBuf, cx: &mut Context<Self>) {
        if !self.can_switch_library() {
            self.set_status(
                "Finish the current operation, save/cancel edits and close any review before opening another library.".into(),
                true,
                cx,
            );
            return;
        }
        self.session.activity = Activity::SwitchingLibrary;
        self.session.debounce = None;
        self.generation.advance();
        self.set_status("Opening existing library...".into(), false, cx);
        let remember = self.preference_path.clone();
        let receiver = self
            .engine
            .request(|reply| Request::OpenLibrary { directory, reply });
        let task = cx.background_executor().spawn(async move {
            let report = crate::engine::recv(receiver)?;
            Ok::<_, AppError>(crate::activation::ActivationReport::remember(
                report.root,
                remember.as_deref(),
            ))
        });
        cx.spawn(async move |this, cx| {
            let mut result = Some(task.await);
            let _ = this.update(cx, |this, cx| {
                this.session.activity = Activity::Idle;
                match result.take().expect("library reply handled once") {
                    Ok(report) => {
                        this.library_epoch = this.library_epoch.wrapping_add(1);
                        this.activate_library(report.root.clone(), cx);
                        let (message, error) = report.message();
                        this.set_status(message, error, cx);
                    }
                    Err(error) => this.set_status(open_library_error(error.kind()), true, cx),
                }
                cx.notify();
            });
            if let Some(result) = result {
                cx.background_executor()
                    .spawn(async move { drop(result) })
                    .detach();
            }
        })
        .detach();
    }
}
