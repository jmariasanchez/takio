use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(crate) fn discover_executable(env_name: &str, name: &str, macos_path: &str) -> Option<PathBuf> {
    discover_from(
        std::env::var_os(env_name).as_deref(),
        std::env::var_os("PATH").as_deref(),
        name,
        Path::new(macos_path),
    )
}

// Keep environment reads at the boundary so tests never mutate process-wide PATH.
fn discover_from(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    name: &str,
    macos_path: &Path,
) -> Option<PathBuf> {
    if let Some(path) = explicit.map(PathBuf::from) {
        return canonical_executable(&path);
    }
    if let Some(path) = search_path.and_then(|value| {
        std::env::split_paths(value)
            .map(|directory| directory.join(name))
            .find_map(|candidate| canonical_executable(&candidate))
    }) {
        return Some(path);
    }
    if cfg!(target_os = "macos") {
        return canonical_executable(macos_path);
    }
    None
}

fn canonical_executable(path: &Path) -> Option<PathBuf> {
    // Resolve against the caller's cwd, not the backend's later private workspace.
    let path = path.canonicalize().ok()?;
    executable(&path).then_some(path)
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn requires_executable_permissions_for_external_backends() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        for name in ["ebook-meta", "ebook-polish", "fetch-ebook-metadata"] {
            let candidate = temp.path().join(name);
            fs::write(&candidate, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&candidate, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(!executable(&candidate));
            fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(executable(&candidate));
        }
    }

    fn backend(path: &Path) {
        fs::write(path, b"fixture, never executed").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn selected_backend_is_canonical_for_override_path_and_macos_fallback() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        let alias = temp.path().join("backend");
        backend(&real);
        symlink(&real, &alias).unwrap();
        let canonical = real.canonicalize().unwrap();
        assert_eq!(
            discover_from(Some(alias.as_os_str()), None, "backend", &alias),
            Some(canonical.clone())
        );
        assert_eq!(
            discover_from(None, Some(temp.path().as_os_str()), "backend", &alias),
            Some(canonical.clone())
        );
        assert_eq!(
            discover_from(None, None, "backend", &alias),
            cfg!(target_os = "macos").then_some(canonical)
        );
    }

    #[test]
    fn explicit_override_wins_and_invalid_override_never_falls_back() {
        let temp = tempfile::tempdir().unwrap();
        let explicit = temp.path().join("explicit");
        let fallback = temp.path().join("backend");
        backend(&explicit);
        backend(&fallback);
        let search = std::env::join_paths([temp.path()]).unwrap();
        assert_eq!(
            discover_from(
                Some(explicit.as_os_str()),
                Some(&search),
                "backend",
                &fallback
            ),
            Some(explicit.canonicalize().unwrap())
        );
        for invalid in [
            temp.path().join("missing"),
            temp.path().to_path_buf(),
            PathBuf::new(),
        ] {
            assert_eq!(
                discover_from(
                    Some(invalid.as_os_str()),
                    Some(&search),
                    "backend",
                    &fallback
                ),
                None
            );
        }
    }

    #[test]
    fn path_order_precedes_platform_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let directories =
            ["missing", "directory", "first", "second"].map(|name| temp.path().join(name));
        for directory in &directories {
            fs::create_dir(directory).unwrap();
        }
        fs::create_dir(directories[1].join("backend")).unwrap();
        let first = directories[2].join("backend");
        let second = directories[3].join("backend");
        backend(&first);
        backend(&second);
        let search = std::env::join_paths(&directories).unwrap();
        assert_eq!(
            discover_from(None, Some(&search), "backend", &second),
            Some(first.canonicalize().unwrap())
        );
        let fallback = cfg!(target_os = "macos").then(|| second.canonicalize().unwrap());
        assert_eq!(discover_from(None, None, "backend", &second), fallback);
        assert_eq!(
            discover_from(None, None, "backend", &temp.path().join("absent")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn nonexecutable_files_are_skipped_but_explicit_override_is_authoritative() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let blocked = first.join("backend");
        fs::write(&blocked, b"not executable").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
        let valid = second.join("backend");
        backend(&valid);
        let search = std::env::join_paths([first, second]).unwrap();
        assert_eq!(
            discover_from(None, Some(&search), "backend", &valid),
            Some(valid.canonicalize().unwrap())
        );
        assert_eq!(
            discover_from(Some(blocked.as_os_str()), Some(&search), "backend", &valid),
            None
        );
    }
}
