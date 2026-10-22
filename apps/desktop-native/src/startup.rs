//! Resolve a remembered library without recreating a missing selected database.
use crate::{engine::Engine, preferences};
use std::path::{Path, PathBuf};
use takio::{output::AppResult, paths::LibraryPaths};

pub fn open(
    default: LibraryPaths,
    preference: Option<&Path>,
) -> AppResult<(Engine, Option<String>)> {
    let mut warning = None;
    if let Some(preference) = preference {
        match preferences::load(preference) {
            Ok(Some(root)) => match Engine::open_existing(root.clone()) {
                Ok(engine) => return Ok((engine, None)),
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
    Ok((Engine::open(default)?, warning))
}

fn resolved_location(path: &Path) -> std::io::Result<PathBuf> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut resolved) => {
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
        assert!(warning.is_none());
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
        assert!(warning.unwrap().contains("not recreated or replaced"));
        assert!(!selected.exists());
        std::fs::create_dir(&selected).unwrap();
        let database = selected.join("library.sqlite");
        std::fs::write(&database, b"not sqlite").unwrap();
        let (_, warning) = open(default, Some(&preference)).unwrap();
        assert!(warning.is_some());
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
        assert!(warning.unwrap().contains("Could not read"));
        let (_, warning) = open(default, None).unwrap();
        assert!(warning.is_none());
        assert_eq!(std::fs::read(preference).unwrap(), b"relative");
    }
}
