//! Catalog projection and atomic JSON, CSV, and HTML catalog publication.
//! CSV and HTML have separate schemas and deliberately do not serialize the JSON record.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use crate::format::FormatId;
use crate::library::model::LibraryItem;
use crate::library::store::user_custom_metadata;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogRecord<'a> {
    id: &'a str,
    title: &'a str,
    authors: Vec<&'a str>,
    tags: &'a [String],
    formats: Vec<FormatId>,
    has_cover: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    series: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    series_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_date: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    languages: &'a [String],
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    identifiers: &'a BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    custom_metadata: BTreeMap<String, String>,
}

pub fn catalog_record(item: &LibraryItem) -> Value {
    // Explicitly allowlist public fields, never serialize LibraryItem or BookFormat:
    // both contain private paths and other library-internal state.
    json!(CatalogRecord {
        id: &item.id,
        title: &item.title,
        authors: item.author_names().collect(),
        tags: &item.tags,
        formats: item.formats.iter().map(|format| format.format).collect(),
        has_cover: item.cover_path.is_some(),
        series: item.series.as_deref(),
        series_index: item.series_index,
        publisher: item.publisher.as_deref(),
        published_date: item.published_date.as_deref(),
        rating: item.rating,
        description: item.description.as_deref(),
        languages: &item.languages,
        identifiers: &item.identifiers,
        custom_metadata: user_custom_metadata(&item.custom_metadata),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogReport {
    pub path: std::path::PathBuf,
    pub books: usize,
    pub bytes: usize,
    pub sha256: String,
    pub format: CatalogFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogFormat {
    Json,
    Csv,
    Html,
}

impl CatalogFormat {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Html => "html",
        }
    }
}

impl std::str::FromStr for CatalogFormat {
    type Err = crate::error::AppError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "json" => Ok(Self::Json),
            "csv" => Ok(Self::Csv),
            "html" => Ok(Self::Html),
            _ => Err(crate::app_error!("invalid-arguments")),
        }
    }
}

pub fn write_catalog(
    items: &[LibraryItem],
    format: CatalogFormat,
    output: &std::path::Path,
) -> crate::error::AppResult<CatalogReport> {
    use crate::error::AppResult;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    if output.exists()
        || output.parent().is_none_or(|parent| !parent.is_dir())
        || output
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case(format.as_str()))
    {
        return Err(crate::app_error!(if output.exists() {
            crate::error::ErrorCode::OutputFileExists
        } else {
            crate::error::ErrorCode::InvalidArguments
        }));
    }
    let body = match format {
        CatalogFormat::Json => format!(
            "{}\n",
            serde_json::to_string_pretty(
                &json!({"version":1,"books":items.iter().map(catalog_record).collect::<Vec<_>>()})
            )
            .map_err(|_| crate::app_error!("write-failed"))?
        ),
        CatalogFormat::Csv => render_catalog_csv(items),
        CatalogFormat::Html => render_catalog_html(items),
    };
    if body.len() > 64 * 1024 * 1024 {
        return Err(crate::app_error!("write-failed"));
    }
    let absolute_output = crate::library::paths::absolute(output)?;
    let parent = output
        .parent()
        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
    let temporary = parent.join(format!(".takio-catalog-{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let publication = (|| -> AppResult<()> {
        let mut file = options
            .open(&temporary)
            .map_err(crate::io_error!("write-failed"))?;
        file.write_all(body.as_bytes())
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(crate::io_error!("write-failed"))?;
        if !temporary.is_file() {
            return Err(crate::app_error!("write-failed"));
        }
        std::fs::hard_link(&temporary, output).map_err(crate::io_error!("write-failed"))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    publication?;
    Ok(CatalogReport {
        path: absolute_output,
        books: items.len(),
        bytes: body.len(),
        sha256: hex::encode(Sha256::digest(body.as_bytes())),
        format,
    })
}

fn render_catalog_csv(items: &[LibraryItem]) -> String {
    let mut output = "id,title,authors,series,seriesIndex,publisher,publishedDate,languages,tags,formats,rating,identifiers,customMetadata,description\n".to_owned();
    for item in items {
        let values = [
            item.id.clone(),
            item.title.clone(),
            item.author_names().collect::<Vec<_>>().join("; "),
            item.series.clone().unwrap_or_default(),
            item.series_index
                .map(|value| value.to_string())
                .unwrap_or_default(),
            item.publisher.clone().unwrap_or_default(),
            item.published_date.clone().unwrap_or_default(),
            item.languages.join("; "),
            item.tags.join("; "),
            item.formats
                .iter()
                .map(|format| format.format.as_str())
                .collect::<Vec<_>>()
                .join("; "),
            item.rating
                .map(|value| value.to_string())
                .unwrap_or_default(),
            serde_json::to_string(&item.identifiers).unwrap_or_else(|_| "{}".to_owned()),
            serde_json::to_string(&user_custom_metadata(&item.custom_metadata))
                .unwrap_or_else(|_| "{}".to_owned()),
            item.description.clone().unwrap_or_default(),
        ];
        output.push_str(
            &values
                .iter()
                .map(|value| csv_cell(value))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push('\n');
    }
    output
}

fn csv_cell(value: &str) -> String {
    let passive = if value
        .trim_start_matches(|value: char| value.is_whitespace() || value.is_control())
        .starts_with(['=', '+', '-', '@'])
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", passive.replace('"', "\"\""))
}

fn render_catalog_html(items: &[LibraryItem]) -> String {
    let rows = items
        .iter()
        .map(|item| {
            format!(
                "      <tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                html_escape(&item.title),
                html_escape(&item.author_names().collect::<Vec<_>>().join(", ")),
                html_escape(item.series.as_deref().unwrap_or_default()),
                html_escape(&item.tags.join(", ")),
                html_escape(
                    &item
                        .formats
                        .iter()
                        .map(|format| format.format.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            )
        })
        .collect::<String>();
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Takio catalog</title><style>body{{font:16px system-ui;margin:2rem}}table{{border-collapse:collapse;width:100%}}th,td{{border-bottom:1px solid #ccc;padding:.5rem;text-align:left}}</style></head><body><h1>Takio catalog</h1><table><thead><tr><th>Title</th><th>Authors</th><th>Series</th><th>Tags</th><th>Formats</th></tr></thead><tbody>\n{rows}\n    </tbody></table></body></html>\n"
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(any(test, feature = "test-support"))]
pub mod tests {
    #[cfg(unix)]
    #[test]
    fn catalog_write_failure_keeps_the_redacted_io_kind() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let locked = temp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let error = super::write_catalog(
            &[sparse_book()],
            super::CatalogFormat::Json,
            &locked.join("catalog.json"),
        )
        .unwrap_err();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(error.kind(), crate::error::ErrorCode::WriteFailed);
        assert_eq!(error.io_kind(), Some(std::io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn catalog_formats_keep_wire_names_and_reject_unknown_values() {
        for format in [
            super::CatalogFormat::Json,
            super::CatalogFormat::Csv,
            super::CatalogFormat::Html,
        ] {
            assert_eq!(
                format.as_str().parse::<super::CatalogFormat>().unwrap(),
                format
            );
            assert_eq!(
                serde_json::to_value(format).unwrap(),
                serde_json::json!(format.as_str())
            );
        }
        assert!("xml".parse::<super::CatalogFormat>().is_err());
    }
    use super::*;

    pub fn sparse_book() -> LibraryItem {
        serde_json::from_value(json!({
            "id":"book-1", "title":"Example", "sourcePath":"/private/book.epub",
            "format":"epub", "addedAt":"2026-01-01", "formats":[],
            "customMetadata":{"takio_metadata_audit":"/private/audit"}
        }))
        .unwrap()
    }

    pub fn rich_book() -> LibraryItem {
        let mut item = sparse_book();
        item.author = Some("Legacy author".into());
        item.authors = vec![crate::library::model::BookAuthor {
            name: "Public author".into(),
            sort_name: Some("Private sort name".into()),
        }];
        item.formats = vec![crate::library::model::BookFormat {
            source_path: "/private/attachment.epub".into(),
            format: FormatId::Epub,
            added_at: "2026-01-02".into(),
            provenance: crate::library::model::Provenance::Managed,
        }];
        item.series = Some("Series".into());
        item.series_index = Some(0.0);
        item.publisher = Some("Publisher".into());
        item.published_date = Some("2026".into());
        item.rating = Some(0.0);
        item.description = Some("Description".into());
        item.languages = vec!["en".into()];
        item.identifiers.insert("isbn".into(), "123".into());
        item.custom_metadata
            .insert("shelf".into(), "favorites".into());
        item.cover_path = Some("/private/cover.jpg".into());
        item.tags = vec!["fiction".into()];
        item.updated_at = Some("2026-01-03".into());
        item
    }

    pub fn sparse_record() -> Value {
        json!({"id":"book-1", "title":"Example", "authors":[], "tags":[],
            "formats":[], "hasCover":false})
    }

    pub fn rich_record() -> Value {
        json!({"id":"book-1", "title":"Example", "authors":["Public author"],
            "tags":["fiction"], "formats":["epub"], "hasCover":true,
            "series":"Series", "seriesIndex":0.0, "publisher":"Publisher",
            "publishedDate":"2026", "rating":0.0, "description":"Description",
            "languages":["en"], "identifiers":{"isbn":"123"},
            "customMetadata":{"shelf":"favorites"}})
    }

    #[test]
    fn catalog_schema_allowlists_public_fields_and_omits_absent_values() {
        assert_eq!(catalog_record(&sparse_book()), sparse_record());
        assert_eq!(catalog_record(&rich_book()), rich_record());
    }

    #[test]
    fn catalog_ignores_display_author_and_preserves_empty_strings_and_nonfinite_nulls() {
        let mut item = sparse_book();
        item.author = Some("Legacy author".into());
        item.series = Some(String::new());
        item.description = Some(String::new());
        item.series_index = Some(f64::NAN);
        item.rating = Some(f64::INFINITY);
        let mut expected = sparse_record();
        expected["authors"] = json!([]);
        expected["series"] = json!("");
        expected["description"] = json!("");
        expected["seriesIndex"] = Value::Null;
        expected["rating"] = Value::Null;
        assert_eq!(catalog_record(&item), expected);
    }

    #[test]
    fn every_catalog_format_ignores_display_only_author() {
        let mut item = sparse_book();
        item.author = Some("Legacy <author>".into());
        assert!(!render_catalog_csv(std::slice::from_ref(&item)).contains("Legacy"));
        assert!(!render_catalog_html(std::slice::from_ref(&item)).contains("Legacy"));
    }
}
