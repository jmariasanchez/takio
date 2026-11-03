//! Public JSON catalog projection shared by file exports and the read-only server.
//! CSV and HTML have separate schemas and deliberately do not serialize this type.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use crate::format::FormatId;
use crate::model::LibraryItem;
use crate::store::user_custom_metadata;

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

pub(crate) fn catalog_record(item: &LibraryItem) -> Value {
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn sparse_book() -> LibraryItem {
        serde_json::from_value(json!({
            "id":"book-1", "title":"Example", "sourcePath":"/private/book.epub",
            "format":"epub", "addedAt":"2026-01-01", "formats":[],
            "customMetadata":{"takio_metadata_audit":"/private/audit"}
        }))
        .unwrap()
    }

    pub(crate) fn rich_book() -> LibraryItem {
        let mut item = sparse_book();
        item.author = Some("Legacy author".into());
        item.authors = vec![crate::model::BookAuthor {
            name: "Public author".into(),
            sort_name: Some("Private sort name".into()),
        }];
        item.formats = vec![crate::model::BookFormat {
            source_path: "/private/attachment.epub".into(),
            format: FormatId::Epub,
            added_at: "2026-01-02".into(),
            provenance: crate::model::Provenance::Managed,
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

    pub(crate) fn sparse_record() -> Value {
        json!({"id":"book-1", "title":"Example", "authors":[], "tags":[],
            "formats":[], "hasCover":false})
    }

    pub(crate) fn rich_record() -> Value {
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
    fn catalog_preserves_legacy_author_empty_strings_and_nonfinite_nulls() {
        let mut item = sparse_book();
        item.author = Some("Legacy author".into());
        item.series = Some(String::new());
        item.description = Some(String::new());
        item.series_index = Some(f64::NAN);
        item.rating = Some(f64::INFINITY);
        let mut expected = sparse_record();
        expected["authors"] = json!(["Legacy author"]);
        expected["series"] = json!("");
        expected["description"] = json!("");
        expected["seriesIndex"] = Value::Null;
        expected["rating"] = Value::Null;
        assert_eq!(catalog_record(&item), expected);
    }
}
