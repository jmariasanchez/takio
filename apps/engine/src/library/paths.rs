use std::path::{Component, Path, PathBuf};

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};

pub const TAKIO_DATA_DIR: &str = "TAKIO_DATA_DIR";
pub const TAKIO_DESKTOP_PROFILE_DIR: &str = "TAKIO_DESKTOP_PROFILE_DIR";

#[derive(Clone, Debug)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub jobs: PathBuf,
    pub items: PathBuf,
    pub covers: PathBuf,
}

impl LibraryPaths {
    /// Resolve a named library or an explicit database into its storage paths.
    ///
    /// With neither argument, use the platform's local application-data directory.
    /// Relative database paths are joined to the current working directory, not
    /// canonicalized. This only computes paths; it does not create or open files.
    ///
    /// # Errors
    /// Returns `invalid-arguments` for mutually exclusive selectors, an empty or
    /// parentless database path, or a library name outside 1-64 ASCII letters,
    /// digits, hyphens and underscores. Returns `storage-unavailable` if the
    /// application-data directory or current working directory cannot be resolved.
    pub fn resolve(library: Option<&str>, database: Option<&Path>) -> AppResult<Self> {
        if library.is_some() && database.is_some() {
            return Err(crate::app_error!("invalid-arguments"));
        }

        let database = if let Some(path) = database {
            absolute(path)?
        } else {
            let project = ProjectDirs::from("com", "takio", "Takio")
                .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
            let root = project.data_local_dir();
            match library {
                Some(name) => {
                    validate_library_name(name)?;
                    root.join("libraries").join(name).join("library.sqlite")
                }
                None => root.join("library.sqlite"),
            }
        };
        let root = database
            .parent()
            .ok_or_else(|| crate::app_error!("invalid-arguments"))?
            .to_path_buf();
        Ok(Self {
            jobs: root.join("jobs.sqlite"),
            items: root.join("items"),
            covers: root.join("covers"),
            root,
            database,
        })
    }
}

pub fn absolute(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(crate::app_error!("invalid-arguments"));
    }
    std::path::absolute(path).map_err(AppError::from)
}

/// Reject imports that could consume or recursively scan this library's owned files.
pub fn validate_import_sources(paths: &LibraryPaths, sources: &[PathBuf]) -> AppResult<()> {
    let protected = [&paths.database, &paths.jobs, &paths.items, &paths.covers]
        .into_iter()
        .map(|path| path_for_overlap(path))
        .collect::<AppResult<Vec<_>>>()?;
    for source in sources {
        let source = path_for_overlap(source)?;
        if protected
            .iter()
            .any(|path| import_paths_overlap(&source, path))
        {
            return Err(crate::app_error!("invalid-arguments"));
        }
    }
    Ok(())
}

fn path_for_overlap(path: &Path) -> AppResult<PathBuf> {
    resolve_for_creation(path).map_err(|_| crate::app_error!("invalid-arguments"))
}

/// Resolve existing ancestors without creating a missing suffix. Parent components
/// are applied after resolving symlinks, so `link/../missing` uses the real parent.
/// This is a point-in-time path check, not protection against concurrent replacement.
pub fn resolve_for_creation(path: &Path) -> std::io::Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(std::io::Error::other("empty path"));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => resolved.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => {
                resolved.push(name);
                match std::fs::symlink_metadata(&resolved) {
                    Ok(_) => resolved = resolved.canonicalize()?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(resolved)
}

fn import_paths_overlap(source: &Path, protected: &Path) -> bool {
    if source.starts_with(protected) || protected.starts_with(source) {
        return true;
    }
    source
        .ancestors()
        .any(|ancestor| same_file::is_same_file(ancestor, protected).unwrap_or(false))
        || protected
            .ancestors()
            .any(|ancestor| same_file::is_same_file(ancestor, source).unwrap_or(false))
}

/// Explicit profiles isolate preferences, even when a data override is set.
pub fn desktop_preference_location(
    default_root: &Path,
    data_override: bool,
    profile_override: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(profile) = profile_override {
        Some(profile.join("last-library"))
    } else if data_override {
        None
    } else {
        Some(default_root.join("desktop").join("last-library"))
    }
}

fn validate_library_name(name: &str) -> AppResult<()> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(crate::app_error!("invalid-arguments"))
    }
}

#[cfg(test)]
mod tests {
    use super::{LibraryPaths, validate_library_name};
    use std::path::Path;

    #[cfg(unix)]
    #[test]
    fn creation_resolution_handles_missing_suffix_symlinks_and_parent_components() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("real/child")).unwrap();
        std::os::unix::fs::symlink(root.join("real/child"), root.join("link")).unwrap();
        for (input, expected) in [
            ("missing/leaf", "missing/leaf"),
            ("link/missing/leaf", "real/child/missing/leaf"),
            ("link/../missing", "real/missing"),
            ("link/missing/../leaf", "real/child/leaf"),
        ] {
            assert_eq!(
                super::resolve_for_creation(&root.join(input)).unwrap(),
                root.join(expected)
            );
        }
        assert!(!root.join("missing").exists());
        std::os::unix::fs::symlink(root.join("absent"), root.join("dangling")).unwrap();
        assert!(super::resolve_for_creation(&root.join("dangling/leaf")).is_err());
        std::fs::write(root.join("file"), b"kept").unwrap();
        assert!(super::resolve_for_creation(&root.join("file/leaf")).is_err());
    }

    #[test]
    fn explicit_database_derives_siblings_without_creating_anything() -> super::AppResult<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("missing-library");
        let database = root.join("catalog.sqlite");
        let paths = LibraryPaths::resolve(None, Some(&database))?;
        assert_eq!(paths.root, root);
        assert_eq!(paths.database, database);
        assert_eq!(paths.jobs, root.join("jobs.sqlite"));
        assert_eq!(paths.items, root.join("items"));
        assert_eq!(paths.covers, root.join("covers"));
        assert!(!root.exists());
        Ok(())
    }

    #[test]
    fn relative_paths_are_absolute_but_not_canonicalized() -> super::AppResult<()> {
        let relative = Path::new("not-created/../library.sqlite");
        let paths = LibraryPaths::resolve(None, Some(relative))?;
        assert_eq!(paths.database, std::env::current_dir()?.join(relative));
        Ok(())
    }

    #[test]
    fn rejects_conflicting_selectors_and_empty_database() {
        for result in [
            LibraryPaths::resolve(Some("named"), Some(Path::new("library.sqlite"))),
            LibraryPaths::resolve(None, Some(Path::new(""))),
        ] {
            assert_eq!(
                result.expect_err("invalid selector").code(),
                "invalid-arguments"
            );
        }
    }

    #[test]
    fn desktop_preference_respects_data_and_profile_overrides() {
        let root = Path::new("/default");
        let profile = Path::new("/profile");
        assert_eq!(
            super::desktop_preference_location(root, false, None),
            Some(root.join("desktop/last-library"))
        );
        assert_eq!(super::desktop_preference_location(root, true, None), None);
        for data_override in [false, true] {
            assert_eq!(
                super::desktop_preference_location(root, data_override, Some(profile)),
                Some(profile.join("last-library"))
            );
        }
    }

    #[test]
    fn library_names_have_bounded_path_safe_ascii_syntax() {
        for valid in ["A", "library-2_test", &"a".repeat(64)] {
            assert!(validate_library_name(valid).is_ok(), "{valid}");
        }
        for invalid in ["", ".", "..", "a/b", "a\\b", "has space", &"a".repeat(65)] {
            assert_eq!(
                validate_library_name(invalid)
                    .expect_err("invalid name")
                    .code(),
                "invalid-arguments"
            );
        }
    }
}
