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
        self.busy = true;
        self.switching_library = true;
        self.debounce = None;
        self.generation = self.generation.wrapping_add(1);
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
                this.busy = false;
                this.switching_library = false;
                match result.take().expect("library reply handled once") {
                    Ok((root, snapshot, remember_failed)) => {
                        this.library_epoch = this.library_epoch.wrapping_add(1);
                        this.generation = this.generation.wrapping_add(1);
                        this.library_root = root;
                        this.section = Section::Library;
                        this.query.clear();
                        this.filters = Filters::default();
                        this.sort = Sort::default();
                        this.clear_selection();
                        this.loading = false;
                        this.sorting = false;
                        this.metadata_save_result = None;
                        this.recovery_outcome = None;
                        this.delivery_report = None;
                        this.delivery_exclusions.clear();
                        this.send_preview = None;
                        this.preparation_preview = None;
                        this.send_preview_generation = this.send_preview_generation.wrapping_add(1);
                        this.preparation_generation = this.preparation_generation.wrapping_add(1);
                        let old_items = std::mem::replace(&mut this.items, snapshot.items);
                        let old_facets = std::mem::replace(&mut this.facets, snapshot.facets);
                        cx.background_executor().spawn(async move { drop((old_items, old_facets)) }).detach();
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
