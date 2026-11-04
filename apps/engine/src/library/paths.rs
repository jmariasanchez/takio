use std::path::{Path, PathBuf};

use directories::ProjectDirs;

use crate::output::{AppError, AppResult};

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
