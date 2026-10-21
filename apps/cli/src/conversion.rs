use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::output::{AppError, AppResult};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Kepub,
    Epub,
    Pdf,
    Mobi,
    Azw3,
    Docx,
    Html,
    Txt,
    Cbz,
}

impl FormatId {
    pub const ALL: [Self; 9] = [
        Self::Kepub,
        Self::Epub,
        Self::Pdf,
        Self::Mobi,
        Self::Azw3,
        Self::Docx,
        Self::Html,
        Self::Txt,
        Self::Cbz,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Kepub => "kepub",
            Self::Epub => "epub",
            Self::Pdf => "pdf",
            Self::Mobi => "mobi",
            Self::Azw3 => "azw3",
            Self::Docx => "docx",
            Self::Html => "html",
            Self::Txt => "txt",
            Self::Cbz => "cbz",
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Kepub => "Kobo EPUB",
            Self::Epub => "EPUB",
            Self::Pdf => "PDF",
            Self::Mobi => "MOBI",
            Self::Azw3 => "AZW3",
            Self::Docx => "DOCX",
            Self::Html => "HTML",
            Self::Txt => "Plain text",
            Self::Cbz => "Comic book archive",
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Kepub => "kepub.epub",
            Self::Epub => "epub",
            Self::Pdf => "pdf",
            Self::Mobi => "mobi",
            Self::Azw3 => "azw3",
            Self::Docx => "docx",
            Self::Html => "html",
            Self::Txt => "txt",
            Self::Cbz => "cbz",
        }
    }
}

impl std::fmt::Display for FormatId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::str::FromStr for FormatId {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|format| format.as_str() == value.to_ascii_lowercase())
            .ok_or("unsupported-format")
    }
}

#[must_use]
pub fn detect_format(path: &Path) -> Option<FormatId> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if name.ends_with(".kepub.epub") || name.ends_with(".kepub") {
        return Some(FormatId::Kepub);
    }
    FormatId::ALL.into_iter().find(|format| {
        format != &FormatId::Kepub && name.ends_with(&format!(".{}", format.extension()))
    })
}

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
    if let Some(path) = std::env::var_os("TAKIO_EBOOK_CONVERT").map(PathBuf::from)
        && executable(&path)
    {
        return BackendDiscovery {
            available: true,
            path: Some(path),
            source: "env",
        };
    }
    if let Some(path) = find_in_path("ebook-convert") {
        return BackendDiscovery {
            available: true,
            path: Some(path),
            source: "path",
        };
    }
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/calibre.app/Contents/MacOS/ebook-convert");
        if executable(&path) {
            return BackendDiscovery {
                available: true,
                path: Some(path),
                source: "macos-bundle",
            };
        }
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
    let discovery = discover_ebook_convert();
    let backend = discovery
        .path
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
    let (bytes, sha256) = fingerprint(&temporary)?;
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

pub fn fingerprint(path: &Path) -> AppResult<(u64, String)> {
    crate::fingerprint::hash_file(path).map_err(|_| AppError::new("artifact-invalid"))
}

fn executable(path: &Path) -> bool {
    path.is_file()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| executable(candidate))
    })
}
