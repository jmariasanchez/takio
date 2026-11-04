//! Ebook format identity, independent of conversion backends.
use serde::{Deserialize, Serialize};
use std::path::Path;

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
    #[must_use]
    pub const fn is_text_extractable(self) -> bool {
        match self {
            Self::Kepub
            | Self::Epub
            | Self::Pdf
            | Self::Mobi
            | Self::Azw3
            | Self::Docx
            | Self::Html
            | Self::Txt => true,
            Self::Cbz => false,
        }
    }

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
            _ => self.as_str(),
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
            .find(|format| format.as_str().eq_ignore_ascii_case(value))
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_format_roundtrips_and_kepub_takes_precedence() {
        for format in FormatId::ALL {
            assert_eq!(format.as_str().parse::<FormatId>(), Ok(format));
            assert_eq!(
                detect_format(Path::new(&format!(
                    "BOOK.{}",
                    format.extension().to_uppercase()
                ))),
                Some(format)
            );
        }
        assert_eq!(
            detect_format(Path::new("book.kepub")),
            Some(FormatId::Kepub)
        );
        assert_eq!(detect_format(Path::new("book.unknown")), None);
    }
}
