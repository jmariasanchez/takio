//! One launch-time capture, shared by normal, benchmark, and snapshot entry points.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use takio::error::AppResult;
use takio::library::paths::{LibraryPaths, TAKIO_DATA_DIR, TAKIO_DESKTOP_PROFILE_DIR};

pub struct LaunchEnvironment {
    data_dir: Option<PathBuf>,
    profile_dir: Option<PathBuf>,
}

impl LaunchEnvironment {
    pub fn capture() -> Self {
        Self::capture_with(|name| std::env::var_os(name))
    }

    fn capture_with(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
        Self {
            data_dir: lookup(TAKIO_DATA_DIR).map(PathBuf::from),
            profile_dir: lookup(TAKIO_DESKTOP_PROFILE_DIR).map(PathBuf::from),
        }
    }

    pub fn paths(&self) -> AppResult<LibraryPaths> {
        crate::engine::resolve_paths(self.data_dir.as_deref())
    }

    pub fn preference_path(&self, default_root: &Path) -> Option<PathBuf> {
        takio::library::paths::desktop_preference_location(
            default_root,
            self.data_dir.is_some(),
            self.profile_dir.as_deref(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_each_name_once_and_reuses_values_without_creating_paths() {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("library");
        let profile = temp.path().join("profile");
        let mut names = Vec::new();
        let launch = LaunchEnvironment::capture_with(|name| {
            names.push(name.to_owned());
            Some(
                if name == TAKIO_DATA_DIR {
                    &library
                } else {
                    &profile
                }
                .as_os_str()
                .to_owned(),
            )
        });
        assert_eq!(names, [TAKIO_DATA_DIR, TAKIO_DESKTOP_PROFILE_DIR]);
        for _ in 0..2 {
            let paths = launch.paths().unwrap();
            assert_eq!(paths.root, library);
            assert_eq!(
                launch.preference_path(&paths.root),
                Some(profile.join("last-library"))
            );
        }
        assert!(!library.exists());
        assert!(!profile.exists());
    }

    #[test]
    fn explicit_library_without_profile_never_reads_saved_library() {
        let temp = tempfile::tempdir().unwrap();
        let launch = LaunchEnvironment::capture_with(|name| {
            (name == TAKIO_DATA_DIR).then(|| temp.path().as_os_str().to_owned())
        });
        assert!(
            launch
                .preference_path(&launch.paths().unwrap().root)
                .is_none()
        );
        let default = LaunchEnvironment::capture_with(|_| None);
        assert_eq!(
            default.preference_path(temp.path()),
            Some(temp.path().join("desktop/last-library"))
        );
    }
}
