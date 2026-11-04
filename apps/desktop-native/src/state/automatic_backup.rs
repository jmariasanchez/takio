//! Daily checks use a cancellable UI timer. Only actual copy work holds the busy guard.
use super::*;
use crate::settings::automatic_backup::{Schedule, now_seconds};

impl LibraryState {
    pub fn initialize_automatic_backup(&mut self, cx: &mut Context<Self>) {
        self.automatic_backup_timer = None;
        let revision = self.automatic_backup.revision.wrapping_add(1);
        self.automatic_backup = Schedule::default();
        self.automatic_backup.revision = revision;
        let receiver = self
            .engine
            .request(|reply| Request::AutomaticBackupLoad { reply });
        self.await_reply(receiver, cx, move |this, result, cx| {
            if this.automatic_backup.revision != revision {
                return;
            }
            this.automatic_backup.ready = true;
            match result {
                Ok(config) => this.automatic_backup.config = config,
                Err(error) => this.set_status(copy::load_failed(&error), true, cx),
            }
            this.start_automatic_backup_timer(cx);
            this.run_automatic_backup_if_due(now_seconds(), cx);
            cx.notify();
        })
        .detach();
    }

    fn start_automatic_backup_timer(&mut self, cx: &mut Context<Self>) {
        let epoch = self.library_epoch;
        self.automatic_backup_timer = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(60))
                    .await;
                let Ok(current) = this.update(cx, |this, cx| {
                    if this.library_epoch != epoch {
                        return false;
                    }
                    this.run_automatic_backup_if_due(now_seconds(), cx);
                    true
                }) else {
                    return;
                };
                if !current {
                    return;
                }
            }
        }));
    }

    pub fn configure_automatic_backup(
        &mut self,
        destination: Option<PathBuf>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_mutate() {
            self.set_status(copy::BUSY.into(), true, cx);
            return;
        }
        let disabling = destination.is_none();
        self.automatic_backup.revision = self.automatic_backup.revision.wrapping_add(1);
        let revision = self.automatic_backup.revision;
        // Disable immediately for this session even if the preference cannot be saved.
        if disabling {
            self.automatic_backup.config.enabled = false;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        self.set_status(
            "Saving automatic recovery-copy settings...".into(),
            false,
            cx,
        );
        let receiver = self
            .engine
            .request(|reply| Request::AutomaticBackupConfigure { destination, reply });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            if this.automatic_backup.revision != revision {
                cx.notify();
                return;
            }
            match result {
                Ok(config) => {
                    this.automatic_backup.config = config;
                    this.automatic_backup.ready = true;
                    this.automatic_backup.last_attempt = None;
                    let message = if disabling {
                        copy::DISABLED
                    } else {
                        copy::ENABLED
                    };
                    this.set_status(message.into(), false, cx);
                    this.start_automatic_backup_timer(cx);
                    this.run_automatic_backup_if_due(now_seconds(), cx);
                }
                Err(error) => {
                    let message = if disabling {
                        copy::disable_not_saved(&error)
                    } else {
                        copy::configure_failed(&error)
                    };
                    this.set_status(message, true, cx);
                }
            }
        })
        .detach();
    }

    pub fn run_automatic_backup_if_due(&mut self, now: u64, cx: &mut Context<Self>) {
        if !self.automatic_backup.due(now)
            || !self.can_mutate()
            || self.refreshing_destinations
            || self.preparation_pending()
            || self.session.automatic_backup_prompt_open
        {
            return;
        }
        self.automatic_backup.last_attempt = Some(now);
        self.session.activity = Activity::Running(Operation::Mutation);
        self.set_status(
            "Creating and verifying automatic recovery copy...".into(),
            false,
            cx,
        );
        let config = self.automatic_backup.config.clone();
        let receiver =
            self.engine
                .request(|reply| Request::AutomaticBackupRun { config, now, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(report) => {
                    this.automatic_backup.config = report.config;
                    let warning = report.settings_error.is_some();
                    let summary = copy::verified(report.backup.managed_files);
                    let status = if warning {
                        copy::verified_unsaved(&summary)
                    } else {
                        summary.clone()
                    };
                    this.set_status(status, warning, cx);
                    this.session.recovery_outcome = Some(RecoveryOutcome {
                        path: report.backup.destination_path,
                        summary,
                        detail: copy::detail(warning),
                    });
                    cx.notify();
                }
                Err(error) => this.set_status(copy::run_failed(&error), true, cx),
            }
        })
        .detach();
    }
}

/// User-facing automatic recovery-copy messages, kept out of closures so the
/// handlers stay rustfmt-formatted. Error codes are stable and path-free.
mod copy {
    use takio::error::AppError;

    pub(super) const BUSY: &str =
        "Finish the current operation, edits or review before changing automatic recovery copies.";
    pub(super) const DISABLED: &str =
        "Automatic recovery copies disabled. All existing copies are kept.";
    pub(super) const ENABLED: &str = "Automatic recovery copies enabled: daily while Takio is open. All copies are kept, with no automatic deletion.";

    pub(super) fn load_failed(error: &AppError) -> String {
        format!(
            "Automatic recovery copies remain disabled: settings could not be read ({}). Enable again from File to choose a destination.",
            error.code()
        )
    }

    pub(super) fn disable_not_saved(error: &AppError) -> String {
        format!(
            "Automatic recovery copies are disabled for this session, but settings could not be saved ({}). The previous setting may return after reopening this library. Existing copies are kept.",
            error.code()
        )
    }

    pub(super) fn configure_failed(error: &AppError) -> String {
        format!(
            "Automatic recovery settings were not changed ({}). Choose an existing writable folder outside the library and check library permissions.",
            error.code()
        )
    }

    pub(super) fn verified(managed_files: u64) -> String {
        format!("Automatic recovery copy verified: {managed_files} managed format(s)")
    }

    pub(super) fn verified_unsaved(summary: &str) -> String {
        format!("{summary}. Copy kept, but settings could not be saved. Check library permissions.")
    }

    pub(super) fn detail(settings_unsaved: bool) -> String {
        let suffix = if settings_unsaved {
            " The successful copy is preserved, but its timestamp could not be saved. This session will wait 24 hours. Reopening may create another copy. Check library permissions."
        } else {
            ""
        };
        format!(
            "Includes catalogue, Trash, managed formats and covers. External referenced bytes and conversion jobs are excluded. All copies are kept, with no automatic deletion.{suffix}"
        )
    }

    pub(super) fn run_failed(error: &AppError) -> String {
        format!(
            "Automatic recovery copy failed ({}). Check that the selected backup drive/folder exists and is writable. Existing copies are kept. Retrying no sooner than one hour while Takio is open.",
            error.code()
        )
    }
}
