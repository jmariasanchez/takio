//! Opt-in whole-library recovery copies. All filesystem calls belong on the engine worker.
//! No retention deletion, daemon, or hostile concurrent path-swap guarantee is provided.

use std::cell::Cell;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use takio::error::{AppError, AppResult};
use takio::library::store::{BackupReport, LibraryStore};

const SETTINGS_NAME: &str = ".takio-automatic-backup";
const MAX_BYTES: usize = 16 * 1024;
pub const DAILY_SECONDS: u64 = 24 * 60 * 60;
pub const FAILURE_RETRY_SECONDS: u64 = 60 * 60;

pub const EXPLANATION: &str = "Explicitly enable a verified whole-library recovery copy now and once every 24 hours while Takio is open. No background service runs when the app is closed. Choose an existing folder outside this library, preferably on a separate drive. Includes the catalogue, Trash, Takio-managed book formats and covers. External referenced file bytes and conversion jobs are NOT included. Retention: keep ALL copies. Takio never automatically deletes old copies. Disabling stops future copies without deleting existing ones. A missing backup drive is reported, never recreated.";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Config {
    pub enabled: bool,
    pub destination: Option<PathBuf>,
    pub last_success: Option<u64>,
}

#[derive(Debug)]
pub struct RunReport {
    pub backup: BackupReport,
    pub config: Config,
    pub settings_error: Option<AppError>,
}

#[derive(Default)]
pub struct Schedule {
    pub config: Config,
    pub ready: bool,
    pub revision: u64,
    pub last_attempt: Option<u64>,
    pauses: Rc<Cell<usize>>,
}

/// Scoped to this schedule instance, so stale dialogs cannot unpause another library.
pub struct Pause(Rc<Cell<usize>>);

impl Drop for Pause {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

impl Schedule {
    pub fn pause(&self) -> Pause {
        self.pauses.set(self.pauses.get().saturating_add(1));
        Pause(self.pauses.clone())
    }

    pub fn due(&self, now: u64) -> bool {
        self.ready
            && self.pauses.get() == 0
            && self.config.enabled
            && self.config.destination.is_some()
            && self
                .config
                .last_success
                .is_none_or(|last| now.saturating_sub(last) >= DAILY_SECONDS)
            && self
                .last_attempt
                .is_none_or(|last| now.saturating_sub(last) >= FAILURE_RETRY_SECONDS)
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn regular_or_missing(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(takio::app_error!("automatic-backup-unsafe-settings")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn path_text(path: &Path) -> AppResult<&str> {
    path.to_str()
        .filter(|value| {
            !value.is_empty() && path.is_absolute() && !value.contains(['\0', '\r', '\n'])
        })
        .ok_or_else(|| takio::app_error!("automatic-backup-invalid-settings"))
}

/// Read-only and bounded. Missing settings mean disabled and create no files.
pub fn load(root: &Path) -> AppResult<Config> {
    let path = root.join(SETTINGS_NAME);
    if !regular_or_missing(&path)? {
        return Ok(Config::default());
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(takio::app_error!("automatic-backup-invalid-settings"));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| takio::app_error!("automatic-backup-invalid-settings"))?;
    let fields: Vec<_> = text.split('\n').collect();
    if fields.len() != 4
        || fields[0] != "takio-automatic-backup-v1"
        || !matches!(fields[1], "enabled" | "disabled")
    {
        return Err(takio::app_error!("automatic-backup-invalid-settings"));
    }
    let last_success = if fields[2] == "never" {
        None
    } else {
        Some(
            fields[2]
                .parse()
                .map_err(|_| takio::app_error!("automatic-backup-invalid-settings"))?,
        )
    };
    let destination = if fields[3].is_empty() {
        None
    } else {
        Some(path_text(Path::new(fields[3]))?.into())
    };
    let enabled = fields[1] == "enabled";
    if enabled && destination.is_none() {
        return Err(takio::app_error!("automatic-backup-invalid-settings"));
    }
    Ok(Config {
        enabled,
        destination,
        last_success,
    })
}

fn save(root: &Path, config: &Config) -> AppResult<()> {
    let root = root.canonicalize()?;
    let path = root.join(SETTINGS_NAME);
    regular_or_missing(&path)?;
    let destination = config
        .destination
        .as_deref()
        .map(path_text)
        .transpose()?
        .unwrap_or("");
    let text = format!(
        "takio-automatic-backup-v1\n{}\n{}\n{}",
        if config.enabled {
            "enabled"
        } else {
            "disabled"
        },
        config
            .last_success
            .map_or_else(|| "never".into(), |last| last.to_string()),
        destination
    );
    if text.len() > MAX_BYTES || (config.enabled && destination.is_empty()) {
        return Err(takio::app_error!("automatic-backup-invalid-settings"));
    }
    // The existing library is the parent. Never manufacture a missing library or drive.
    let mut staged = tempfile::NamedTempFile::new_in(&root)?;
    staged.write_all(text.as_bytes())?;
    staged.as_file().sync_all()?;
    regular_or_missing(&path)?;
    staged
        .persist(&path)
        .map_err(|error| AppError::from(error.error))?;
    Ok(())
}

fn validate_destination(root: &Path, destination: &Path) -> AppResult<PathBuf> {
    path_text(destination)?;
    let metadata = fs::symlink_metadata(destination)
        .map_err(|_| takio::app_error!("automatic-backup-destination-unavailable"))?;
    if !metadata.is_dir() {
        return Err(takio::app_error!(
            "automatic-backup-destination-unavailable"
        ));
    }
    let root = root.canonicalize()?;
    let destination = destination.canonicalize()?;
    if destination.starts_with(&root) || root.starts_with(&destination) {
        return Err(takio::app_error!("automatic-backup-destination-overlap"));
    }
    Ok(destination)
}

/// Enable only after explicit consent and destination selection. None disables without deletion.
pub fn configure(root: &Path, destination: Option<PathBuf>) -> AppResult<Config> {
    let config = match destination {
        Some(destination) => Config {
            enabled: true,
            destination: Some(validate_destination(root, &destination)?),
            last_success: None,
        },
        None => Config {
            enabled: false,
            ..load(root).unwrap_or_default()
        },
    };
    save(root, &config)?;
    Ok(config)
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
    // Reserve a timestamp/random container exclusively. The engine itself reserves every
    // entry in its new child directory, and never overwrites an existing recovery copy.
    let container = tempfile::Builder::new()
        .prefix(&format!("Takio-{now}-"))
        .tempdir_in(&parent)?
        .keep();
    let destination = container.join("library");
    let backup = match store.backup(&destination) {
        Ok(backup) => backup,
        Err(error) => {
            // Only remove an empty container we created, never another writer's contents.
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

#[cfg(test)]
mod tests;
