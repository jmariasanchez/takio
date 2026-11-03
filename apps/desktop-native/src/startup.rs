//! Resolve a remembered library without recreating a missing selected database.
use crate::{activation::ActivationReport, engine::Engine, preferences};
use std::path::{Path, PathBuf};
use takio::{
    output::{AppError, AppResult},
    paths::LibraryPaths,
    store::LibraryStore,
};

pub fn open(
    default: LibraryPaths,
    preference: Option<&Path>,
) -> AppResult<(Engine, ActivationReport)> {
    let mut warning = None;
    if let Some(preference) = preference {
        match preferences::load(preference) {
            Ok(Some(root)) => match Engine::open_existing(root.clone()) {
                Ok(engine) => {
                    let report = ActivationReport::startup(engine.root().to_path_buf(), None);
                    return Ok((engine, report));
                }
                Err(error) => {
                    // Falling back to the same location would turn strict open
                    // failure into implicit creation or migration of that library.
                    if resolved_location(&root)? == resolved_location(&default.root)? {
                        return Err(error);
                    }
                    warning = Some(format!(
                        "Could not reopen the saved library at {}. It was not recreated or replaced. Opened the default library at {} instead. Use Open Library to choose another existing library.",
                        root.display(),
                        default.root.display()
                    ));
                }
            },
            Ok(None) => {}
            Err(_) => {
                warning = Some(format!(
                    "Could not read the saved library preference. Opened the default library at {}. Use Open Library to choose an existing library.",
                    default.root.display()
                ))
            }
        }
    }
    // Reject corrupt defaults read-only before creation or migration. Supported
    // legacy defaults still use the engine's verified, backed-up migration.
    let engine = match std::fs::symlink_metadata(&default.database) {
        Ok(_) => match Engine::open_existing(default.root.clone()) {
            Ok(engine) => engine,
            Err(error)
                if error.code() == "incompatible-schema"
                    && LibraryStore::preflight_startup(default.clone())? =>
            {
                Engine::open(default)?
            }
            Err(error) => return Err(error),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Engine::open(default)?,
        Err(error) => return Err(error.into()),
    };
    let report = ActivationReport::startup(engine.root().to_path_buf(), warning);
    Ok((engine, report))
}

pub fn open_recovery(
    root: PathBuf,
    preference: Option<&Path>,
) -> AppResult<(Engine, ActivationReport)> {
    let engine = Engine::open_existing(root)?;
    let report = ActivationReport::remember(engine.root().to_path_buf(), preference);
    Ok((engine, report))
}

pub fn restore_recovery(
    source: &Path,
    destination: &Path,
    default: &Path,
    preference: Option<&Path>,
) -> AppResult<(Engine, ActivationReport)> {
    let destination = resolved_location(destination)?;
    let mut protected = vec![default.to_path_buf(), source.to_path_buf()];
    if let Some(preference) = preference
        && let Ok(Some(saved)) = preferences::load(preference)
    {
        protected.push(saved);
    }
    for root in protected {
        let root = resolved_location(&root)?;
        if destination.starts_with(&root) || root.starts_with(&destination) {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    // Reserve a new root exclusively. CLI restore may use an existing parent,
    // but the recovery UI must never merge into one, including an empty folder.
    std::fs::create_dir(&destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new("destination-exists")
        } else {
            error.into()
        }
    })?;
    let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite")))?;
    if let Err(error) = LibraryStore::restore_backup(source, paths) {
        // Remove only the empty root reserved here, never another writer's files.
        let _ = std::fs::remove_dir(&destination);
        return Err(error);
    }
    open_recovery(destination, preference)
}

fn resolved_location(path: &Path) -> std::io::Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(std::io::Error::other("invalid library location"));
    }
    let mut ancestor = path;
    let mut suffix = Vec::new();
    loop {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut resolved = ancestor.canonicalize()?;
                for name in suffix.iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| std::io::Error::other("unresolvable library location"))?
                        .to_os_string(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| std::io::Error::other("unresolvable library location"))?;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Filters, Request};
    use takio::store::LibraryStore;

    #[test]
    fn failed_saved_default_is_never_recreated_or_migrated() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("default");
        let preference = temp.path().join("profile/last-library");
        preferences::save(&preference, &root).unwrap();
        let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
        assert!(open(paths.clone(), Some(&preference)).is_err());
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        assert!(open(paths.clone(), Some(&preference)).is_err());
        assert!(!paths.database.exists());
        drop(LibraryStore::open(paths.clone(), true).unwrap());
        let mut bytes = std::fs::read(&paths.database).unwrap();
        bytes[60..64].copy_from_slice(&1_u32.to_be_bytes());
        std::fs::write(&paths.database, &bytes).unwrap();
        assert!(open(paths.clone(), Some(&preference)).is_err());
        assert_eq!(std::fs::read(&paths.database).unwrap(), bytes);
        assert!(!root.join("backups").exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_saved_default_alias_is_not_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let real_parent = temp.path().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&real_parent, &alias).unwrap();
        let preference = temp.path().join("last-library");
        preferences::save(
            &preference,
            &real_parent.canonicalize().unwrap().join("missing"),
        )
        .unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&alias.join("missing/library.sqlite"))).unwrap();
        assert!(open(paths, Some(&preference)).is_err());
        assert!(!real_parent.join("missing").exists());
    }

    #[test]
    fn remembered_library_reopens_without_creating_default() {
        let temp = tempfile::tempdir().unwrap();
        let selected = temp.path().join("selected");
        let paths = LibraryPaths::resolve(None, Some(&selected.join("library.sqlite"))).unwrap();
        drop(LibraryStore::open(paths, true).unwrap());
        let preference = temp.path().join("profile/last-library");
        preferences::save(&preference, &selected).unwrap();
        let default =
            LibraryPaths::resolve(None, Some(&temp.path().join("default/library.sqlite"))).unwrap();
        let (engine, warning) = open(default.clone(), Some(&preference)).unwrap();
        assert_eq!(engine.root(), selected.canonicalize().unwrap());
        assert!(warning.warning.is_none());
        assert!(!default.root.exists());
        assert!(
            engine
                .request(|reply| Request::Query {
                    query: String::new(),
                    filters: Filters::default(),
                    reply
                })
                .recv()
                .unwrap()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn missing_or_invalid_remembered_library_falls_back_with_warning_without_recreation() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("profile/last-library");
        let selected = temp.path().join("missing");
        preferences::save(&preference, &selected).unwrap();
        let default =
            LibraryPaths::resolve(None, Some(&temp.path().join("default/library.sqlite"))).unwrap();
        let (engine, warning) = open(default.clone(), Some(&preference)).unwrap();
        assert_eq!(engine.root(), default.root.canonicalize().unwrap());
        assert!(
            warning
                .warning
                .unwrap()
                .contains("not recreated or replaced")
        );
        assert!(!selected.exists());
        std::fs::create_dir(&selected).unwrap();
        let database = selected.join("library.sqlite");
        std::fs::write(&database, b"not sqlite").unwrap();
        let (_, warning) = open(default, Some(&preference)).unwrap();
        assert!(warning.warning.is_some());
        assert_eq!(std::fs::read(database).unwrap(), b"not sqlite");
        assert_eq!(preferences::load(&preference).unwrap(), Some(selected));
    }

    #[test]
    fn malformed_preference_falls_back_but_explicit_no_preference_ignores_it() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        std::fs::write(&preference, b"relative").unwrap();
        let default =
            LibraryPaths::resolve(None, Some(&temp.path().join("default/library.sqlite"))).unwrap();
        let (_, warning) = open(default.clone(), Some(&preference)).unwrap();
        assert!(warning.warning.unwrap().contains("Could not read"));
        let (_, warning) = open(default, None).unwrap();
        assert!(warning.warning.is_none());
        assert_eq!(std::fs::read(preference).unwrap(), b"relative");
    }

    #[cfg(unix)]
    #[test]
    fn restore_recovery_refuses_alias_nesting_and_existing_empty_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&temp.path().join("good/library.sqlite"))).unwrap();
        let store = LibraryStore::open(paths, true).unwrap();
        let backup = temp.path().join("backup");
        store.backup(&backup).unwrap();
        let broken = temp.path().join("broken");
        std::fs::create_dir(&broken).unwrap();
        std::fs::write(broken.join("library.sqlite"), b"keep corrupt bytes").unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&broken, &alias).unwrap();
        let saved = temp.path().join("saved-missing");
        let preference = temp.path().join("preference");
        preferences::save(&preference, &saved).unwrap();
        let empty = temp.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        for destination in [
            alias.join("nested"),
            saved.join("nested"),
            backup.join("nested"),
            empty.clone(),
            temp.path().join("missing/../escape"),
        ] {
            assert!(restore_recovery(&backup, &destination, &broken, Some(&preference)).is_err());
        }
        assert!(!broken.join("nested").exists());
        assert!(!saved.exists());
        assert!(!backup.join("nested").exists());
        assert!(!temp.path().join("escape").exists());
        assert!(std::fs::read_dir(empty).unwrap().next().is_none());
        assert_eq!(
            std::fs::read(broken.join("library.sqlite")).unwrap(),
            b"keep corrupt bytes"
        );
        assert_eq!(preferences::load(&preference).unwrap(), Some(saved));
    }

    #[test]
    fn recovery_preference_failure_is_explicitly_session_only() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&temp.path().join("good/library.sqlite"))).unwrap();
        drop(LibraryStore::open(paths.clone(), true).unwrap());
        let (engine, warning) = open_recovery(paths.root.clone(), Some(&paths.root)).unwrap();
        assert_eq!(engine.root(), paths.root.canonicalize().unwrap());
        assert!(warning.warning.unwrap().contains("for this session"));
        assert!(paths.database.is_file());
    }
}
