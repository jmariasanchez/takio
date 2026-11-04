//! Automatic backup execution on the engine worker, separate from settings persistence.
use crate::settings::automatic_backup::{Config, save, validate_destination};
use std::fs;
use takio::error::{AppError, AppResult};
use takio::library::store::{BackupReport, LibraryStore};

#[derive(Debug)]
pub struct RunReport {
    pub backup: BackupReport,
    pub config: Config,
    pub settings_error: Option<AppError>,
}

pub fn run(store: &LibraryStore, mut config: Config, now: u64) -> AppResult<RunReport> {
    if !config.enabled {
        return Err(takio::app_error!("automatic-backup-disabled"));
    }
    let root = &store.paths().root;
    let parent = validate_destination(
        root,
        config
            .destination
            .as_deref()
            .ok_or_else(|| takio::app_error!("automatic-backup-invalid-settings"))?,
    )?;
    let container = tempfile::Builder::new()
        .prefix(&format!("Takio-{now}-"))
        .tempdir_in(&parent)?
        .keep();
    let destination = container.join("library");
    let backup = match store.backup(&destination) {
        Ok(backup) => backup,
        Err(error) => {
            // Remove only our empty container, never another writer's files.
            let _ = fs::remove_dir(&container);
            return Err(error);
        }
    };
    config.last_success = Some(now);
    let settings_error = save(root, &config).err();
    // A verified copy is success even when recording its timestamp fails.
    Ok(RunReport {
        backup,
        config,
        settings_error,
    })
}
