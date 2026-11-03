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
        self.can_mutate() && !self.refreshing_devices
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
            let report = receiver
                .recv()
                .unwrap_or_else(|_| Err(AppError::new("storage-unavailable")))?;
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
                    Err(error) => this.set_status(open_library_error(error.code()), true, cx),
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

fn open_library_error(code: &str) -> String {
    let reason = match code {
        "library-is-backup" => {
            "This folder is a backup snapshot. Use Restore Backup to New Folder, then open the restored copy."
        }
        "incompatible-schema" => {
            "This library uses an unsupported schema. Open a compatible copy or upgrade it with the appropriate Takio version first."
        }
        "integrity-failed" | "invalid-stored-data" => {
            "The selected library failed catalogue validation. Restore a known-good backup to a new folder."
        }
        _ => {
            "Could not open that library. Choose an existing Takio folder containing library.sqlite and check its access permissions."
        }
    };
    format!("{reason} Your current library is still open and unchanged.")
}
