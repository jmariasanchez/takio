pub(crate) mod executable_discovery;
pub mod jobs;
pub mod maintenance;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::output::{AppError, AppResult};

// Compatibility for embedders. New engine code imports the format module directly.
pub use crate::format::{FormatId, detect_format};

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ConversionCapability {
    pub from: FormatId,
    pub to: FormatId,
}

pub const CALIBRE_CAPABILITIES: [ConversionCapability; 5] = [
    ConversionCapability {
        from: FormatId::Epub,
        to: FormatId::Pdf,
    },
    ConversionCapability {
        from: FormatId::Epub,
        to: FormatId::Azw3,
    },
    ConversionCapability {
        from: FormatId::Docx,
        to: FormatId::Epub,
    },
    ConversionCapability {
        from: FormatId::Html,
        to: FormatId::Epub,
    },
    ConversionCapability {
        from: FormatId::Txt,
        to: FormatId::Epub,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendDiscovery {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    pub source: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub created_at: String,
}

#[must_use]
pub fn discover_ebook_convert() -> BackendDiscovery {
    backend_discovery(
        crate::executable_discovery::discover_executable_with_source(
            "TAKIO_EBOOK_CONVERT",
            "ebook-convert",
            "/Applications/calibre.app/Contents/MacOS/ebook-convert",
        ),
    )
}

#[cfg(test)]
fn discover_with_paths(
    override_path: Option<&Path>,
    search_path: Option<&std::ffi::OsStr>,
    bundle: Option<&Path>,
    cwd: Option<&Path>,
) -> BackendDiscovery {
    backend_discovery(crate::executable_discovery::discover_with_paths(
        override_path,
        search_path,
        "ebook-convert",
        bundle,
        cwd,
    ))
}

fn backend_discovery(found: Option<(PathBuf, &'static str)>) -> BackendDiscovery {
    if let Some((path, source)) = found {
        return BackendDiscovery {
            available: true,
            path: Some(path),
            source,
        };
    }
    BackendDiscovery {
        available: false,
        path: None,
        source: "missing",
    }
}

pub fn convert(
    input: &Path,
    output: &Path,
    output_format: FormatId,
    profile: &str,
    timeout: Duration,
) -> AppResult<Artifact> {
    convert_inner(input, output, output_format, profile, timeout, None)
}

/// Run the backend selected in an explicit review, without rediscovering another executable.
pub fn convert_with_backend(
    input: &Path,
    output: &Path,
    output_format: FormatId,
    profile: &str,
    timeout: Duration,
    backend: &Path,
) -> AppResult<Artifact> {
    convert_inner(
        input,
        output,
        output_format,
        profile,
        timeout,
        Some(backend),
    )
}

fn convert_inner(
    input: &Path,
    output: &Path,
    output_format: FormatId,
    profile: &str,
    timeout: Duration,
    backend: Option<&Path>,
) -> AppResult<Artifact> {
    let input = input
        .canonicalize()
        .map_err(|_| AppError::new("input-unavailable"))?;
    if !input.is_file() || output.exists() {
        return Err(AppError::new(if output.exists() {
            "output-file-exists"
        } else {
            "invalid-arguments"
        }));
    }
    let input_format = detect_format(&input).ok_or_else(|| AppError::new("unsupported-format"))?;
    if input_format == output_format {
        return Err(AppError::new("invalid-arguments"));
    }
    if !CALIBRE_CAPABILITIES
        .iter()
        .any(|pair| pair.from == input_format && pair.to == output_format)
    {
        return Err(AppError::new("unsupported-conversion"));
    }
    let backend = backend
        .map(Path::to_path_buf)
        .or_else(|| discover_ebook_convert().path)
        .ok_or_else(|| AppError::new("backend-unavailable"))?;
    let parent = output
        .parent()
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    if !parent.is_dir() {
        return Err(AppError::new("invalid-arguments"));
    }
    let temporary = parent.join(format!(
        ".takio-convert-{}.{}",
        Uuid::new_v4(),
        output_format.extension()
    ));
    let mut command = Command::new(backend);
    command
        .arg(&input)
        .arg(&temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match profile {
        "default" => {}
        "generic_eink" => {
            command.args(["--output-profile", "generic_eink"]);
        }
        "kindle" => {
            command.args(["--output-profile", "kindle"]);
        }
        "kobo" => {
            command.args(["--output-profile", "tablet"]);
        }
        _ => return Err(AppError::new("invalid-arguments")),
    }
    let mut child = command
        .spawn()
        .map_err(|_| AppError::new("backend-unavailable"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| AppError::new("conversion-failed"))?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&temporary);
            return Err(AppError::new("conversion-timeout"));
        }
        thread::sleep(Duration::from_millis(25));
    };
    if !status.success() || !temporary.is_file() {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::new("conversion-failed"));
    }
    let crate::fingerprint::Fingerprint { bytes, sha256 } =
        crate::fingerprint::hash_file(&temporary).map_err(|_| AppError::new("artifact-invalid"))?;
    if output.exists() {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::new("output-file-exists"));
    }
    fs::rename(&temporary, output).map_err(|_| AppError::new("publication-failed"))?;
    Ok(Artifact {
        path: output.to_path_buf(),
        bytes,
        sha256,
        created_at: Utc::now().to_rfc3339(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(directory: &Path, marker: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join("ebook-convert");
        fs::write(&path, format!("#!/bin/sh\nprintf '{marker}'\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn relative_override_executes_reviewed_cwd_candidate_not_path_candidate() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("cwd");
        let elsewhere = directory.path().join("elsewhere");
        let approved = script(&cwd, "approved");
        script(&elsewhere, "wrong-path-backend");
        let discovered = discover_with_paths(
            Some(Path::new("ebook-convert")),
            Some(elsewhere.as_os_str()),
            None,
            Some(&cwd),
        );
        assert_eq!(discovered.source, "env");
        assert_eq!(
            discovered.path.as_ref(),
            Some(&approved.canonicalize().unwrap())
        );
        let output = Command::new(discovered.path.unwrap())
            .env("PATH", &elsewhere)
            .current_dir(&elsewhere)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"approved");
    }

    #[test]
    fn empty_path_component_is_pinned_to_reviewed_absolute_executable() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("cwd");
        let elsewhere = directory.path().join("elsewhere");
        let approved = script(&cwd, "approved");
        script(&elsewhere, "wrong-path-backend");
        let search_path = std::env::join_paths([Path::new(""), elsewhere.as_path()]).unwrap();
        let discovered = discover_with_paths(None, Some(&search_path), None, Some(&cwd));
        assert_eq!(discovered.source, "path");
        assert_eq!(
            discovered.path.as_ref(),
            Some(&approved.canonicalize().unwrap())
        );
        let output = Command::new(discovered.path.unwrap())
            .env("PATH", &elsewhere)
            .current_dir(&elsewhere)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"approved");
    }

    #[test]
    fn canonical_discovery_preserves_override_path_bundle_precedence() {
        let directory = tempfile::tempdir().unwrap();
        let override_path = script(&directory.path().join("override"), "override");
        let path_candidate = script(&directory.path().join("bin"), "path");
        let bundle = script(&directory.path().join("bundle"), "bundle");
        let search_path = path_candidate.parent().unwrap().as_os_str();
        let discover =
            || discover_with_paths(Some(&override_path), Some(search_path), Some(&bundle), None);
        assert_eq!(discover().source, "env");
        fs::set_permissions(&override_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!discover().available);
        let discover = || discover_with_paths(None, Some(search_path), Some(&bundle), None);
        let found = discover();
        assert_eq!(found.source, "path");
        assert_eq!(found.path, Some(path_candidate.canonicalize().unwrap()));
        fs::remove_file(&path_candidate).unwrap();
        let found = discover();
        assert_eq!(found.source, "macos-bundle");
        assert_eq!(found.path, Some(bundle.canonicalize().unwrap()));
        fs::remove_file(&bundle).unwrap();
        assert!(!discover().available);
    }
}
