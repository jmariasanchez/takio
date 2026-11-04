//! Small, bounded last-library preference. Call from a worker, not the UI thread.
//!
//! Paths are exact UTF-8 bytes without a line terminator. Root existence is left
//! to startup validation so a missing library can be reported rather than lost.
//! Entry checks reject symlinks and special files, but do not claim protection
//! against hostile concurrent ancestor or target replacement.

use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::small_file;
use takio::error::{AppError, AppResult, ErrorCode};

const MAX_BYTES: usize = 64 * 1024;

fn validate_root(value: &str) -> AppResult<&Path> {
    let root = Path::new(value);
    if value.is_empty()
        || value.len() > MAX_BYTES
        || value.contains(['\0', '\r', '\n'])
        || !root.is_absolute()
    {
        return Err(takio::app_error!("preference-invalid"));
    }
    Ok(root)
}

pub fn load(path: &Path) -> AppResult<Option<PathBuf>> {
    let Some(bytes) = small_file::read_bounded(
        path,
        MAX_BYTES,
        ErrorCode::PreferenceUnsafePath,
        ErrorCode::PreferenceInvalid,
    )?
    else {
        return Ok(None);
    };
    let value = std::str::from_utf8(&bytes).map_err(|_| takio::app_error!("preference-invalid"))?;
    Ok(Some(validate_root(value)?.to_path_buf()))
}

pub fn save(path: &Path, root: &Path) -> AppResult<()> {
    let value = root
        .to_str()
        .ok_or_else(|| takio::app_error!("preference-invalid"))?;
    validate_root(value)?;
    small_file::regular_or_missing(path, ErrorCode::PreferenceUnsafePath)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|_| AppError::new(ErrorCode::WriteFailed))?;
    small_file::write_atomic(
        path,
        parent,
        value.as_bytes(),
        ErrorCode::PreferenceUnsafePath,
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn captured_data_override_drives_resolution_and_preference_policy() {
        let temp = tempfile::tempdir().unwrap();
        let data_override = Some(temp.path().join("isolated-library"));
        let paths = crate::engine::resolve_paths(data_override.as_deref()).unwrap();
        assert_eq!(paths.root, *data_override.as_ref().unwrap());
        assert_eq!(paths.database, paths.root.join("library.sqlite"));
        assert!(
            takio::library::paths::desktop_preference_location(
                &paths.root,
                data_override.is_some(),
                None
            )
            .is_none()
        );
        let profile = temp.path().join("profile");
        assert!(
            takio::library::paths::desktop_preference_location(
                &paths.root,
                data_override.is_some(),
                Some(&profile)
            )
            .is_some()
        );
        assert!(!paths.root.exists());
    }

    use super::*;

    #[test]
    fn missing_and_exact_roundtrip_with_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        assert_eq!(load(&preference).unwrap(), None);
        for name in ["library with spaces", "another bibliothèque "] {
            let root = temp.path().join(name);
            save(&preference, &root).unwrap();
            assert_eq!(load(&preference).unwrap(), Some(root.clone()));
            assert_eq!(
                fs::read(&preference).unwrap(),
                root.to_str().unwrap().as_bytes()
            );
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn absent_parent_is_created() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("new/profile/last-library");
        save(&preference, temp.path()).unwrap();
        assert_eq!(load(&preference).unwrap(), Some(temp.path().to_path_buf()));
    }

    #[test]
    fn malformed_contents_are_rejected_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        for bytes in [
            b"".as_slice(),
            b"relative/path",
            b"/library\n",
            b"/library\rname",
            b"/library\0name",
            b"/library\xff",
        ] {
            fs::write(&preference, bytes).unwrap();
            assert!(load(&preference).is_err());
            assert_eq!(fs::read(&preference).unwrap(), bytes);
        }
    }

    #[test]
    fn bounded_load_and_save() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        let exact = format!("/{}", "a".repeat(MAX_BYTES - 1));
        save(&preference, Path::new(&exact)).unwrap();
        assert_eq!(load(&preference).unwrap(), Some(PathBuf::from(&exact)));
        let oversized = format!("{exact}a");
        assert!(save(&preference, Path::new(&oversized)).is_err());
        assert_eq!(fs::read_to_string(&preference).unwrap(), exact);
        fs::write(&preference, oversized).unwrap();
        assert!(load(&preference).is_err());
    }

    #[test]
    fn invalid_roots_preserve_existing_preference() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        fs::write(&preference, b"marker").unwrap();
        for root in [
            "",
            "relative",
            "/new\nline",
            "/carriage\rreturn",
            "/nul\0byte",
        ] {
            assert!(save(&preference, Path::new(root)).is_err());
            assert_eq!(fs::read(&preference).unwrap(), b"marker");
        }
    }

    #[test]
    fn existing_directory_and_marker_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        fs::create_dir(&preference).unwrap();
        let marker = preference.join("marker");
        fs::write(&marker, b"keep").unwrap();
        assert!(save(&preference, temp.path()).is_err());
        assert!(load(&preference).is_err());
        assert_eq!(fs::read(marker).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_including_dangling_are_preserved() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        let target = temp.path().join("marker");
        for exists in [true, false] {
            if exists {
                fs::write(&target, b"keep").unwrap();
            }
            symlink(&target, &preference).unwrap();
            assert!(save(&preference, temp.path()).is_err());
            assert!(load(&preference).is_err());
            assert_eq!(fs::read_link(&preference).unwrap(), target);
            fs::remove_file(&preference).unwrap();
            if exists {
                assert_eq!(fs::read(&target).unwrap(), b"keep");
                fs::remove_file(&target).unwrap();
            } else {
                assert!(!target.exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_root_is_rejected_without_lossy_conversion() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        let root = PathBuf::from(OsString::from_vec(b"/library\xff".to_vec()));
        assert!(save(&preference, &root).is_err());
        assert!(!preference.exists());
    }

    #[cfg(unix)]
    #[test]
    fn special_entry_is_preserved() {
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let preference = temp.path().join("last-library");
        let _listener = UnixListener::bind(&preference).unwrap();
        assert!(save(&preference, temp.path()).is_err());
        assert!(load(&preference).is_err());
        assert!(fs::symlink_metadata(preference).is_ok());
    }
}
