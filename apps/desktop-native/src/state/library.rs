//! Existing-library activation keeps the old view until a validated catalogue arrives.
use super::*;

impl LibraryState {
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
        let receiver = self.engine.request(|reply| Request::OpenLibrary {
            directory,
            remember,
            reply,
        });
        let task = cx.background_executor().spawn(async move {
            let report = receiver
                .recv()
                .unwrap_or_else(|_| Err(AppError::new("storage-unavailable")))?;
            let facets = Arc::new(Facets::from_items(&report.items));
            let mut items: Vec<_> = report.items.into_iter().map(Arc::new).collect();
            sort_items(&mut items, Sort::default());
            Ok::<_, AppError>((
                report.root,
                LibrarySnapshot { items, facets },
                report.remember_failed,
            ))
        });
        cx.spawn(async move |this, cx| {
            let mut result = Some(task.await);
            let _ = this.update(cx, |this, cx| {
                this.session.activity = Activity::Idle;
                match result.take().expect("library reply handled once") {
                    Ok((root, snapshot, remember_failed)) => {
                        this.library_epoch = this.library_epoch.wrapping_add(1);
                        this.generation.advance();
                        this.library_root = root;
                        this.send_preview_generation.advance();
                        this.preparation_generation.advance();
                        let session = LibrarySession {
                            items: snapshot.items,
                            facets: snapshot.facets,
                            ..LibrarySession::default()
                        };
                        let old_session = std::mem::replace(&mut this.session, session);
                        cx.background_executor().spawn(async move { drop(old_session) }).detach();
                        this.initialize_automatic_backup(cx);
                        this.scan_readers(cx);
                        let suffix = if remember_failed {
                            " This switch is for this session only: the startup preference could not be saved. Check the profile folder permissions."
                        } else if this.preference_path.is_none() {
                            " Session only: the explicit data-directory override is unchanged."
                        } else {
                            " This library will reopen next time."
                        };
                        this.set_status(format!("Opened {}.{suffix}", this.library_root.display()), remember_failed, cx);
                    }
                    Err(error) => this.set_status(open_library_error(error.code()), true, cx),
                }
                cx.notify();
            });
            if let Some(result) = result {
                cx.background_executor().spawn(async move { drop(result) }).detach();
            }
        }).detach();
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
