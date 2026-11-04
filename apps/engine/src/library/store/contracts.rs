//! Typed mutation inputs and persisted saved-view contracts.
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{LibraryQuerySyntax, parse_structured_query};
use crate::error::AppResult;
use crate::format::FormatId;
use crate::library::model::Provenance;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveViewRequest {
    pub id: String,
    pub name: String,
    pub definition: SavedViewDefinition,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedViewDefinition {
    pub version: u64,
    pub query: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_query_syntax"
    )]
    pub query_syntax: Option<LibraryQuerySyntax>,
    pub filters: SavedViewFilters,
    pub sort: SavedViewSort,
}

fn present_query_syntax<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<LibraryQuerySyntax>, D::Error> {
    LibraryQuerySyntax::deserialize(deserializer).map(Some)
}

pub type SavedViewFilters = super::Filters;

#[cfg(test)]
mod filter_wire_tests {
    #[test]
    fn live_and_saved_filters_share_typed_case_insensitive_wire_contract() {
        let mut wire = serde_json::json!({"authors":[],"tags":[],"series":[],"languages":[],"formats":["EPUB"]});
        let filters: super::SavedViewFilters = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(filters.formats, [crate::format::FormatId::Epub]);
        wire["formats"] = serde_json::json!(["epub"]);
        assert_eq!(serde_json::to_value(filters).unwrap(), wire);
        wire["formats"] = serde_json::json!(["unknown"]);
        assert!(serde_json::from_value::<super::super::Filters>(wire).is_err());
    }
}

pub(super) fn saved_view_formats<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<FormatId>, D::Error> {
    Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .map(|value| value.parse().map_err(serde::de::Error::custom))
        .collect()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SavedViewSort {
    pub field: SavedViewSortField,
    pub direction: SavedViewSortDirection,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SavedViewSortField {
    Title,
    Author,
    Series,
    PublishedDate,
    Rating,
    AddedAt,
    UpdatedAt,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SavedViewSortDirection {
    Ascending,
    Descending,
}

/// The optimistic-concurrency fields from a previously returned book format.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedFormatSnapshot {
    pub source_path: PathBuf,
    pub added_at: String,
    pub provenance: Provenance,
}

impl From<&crate::library::model::BookFormat> for ExpectedFormatSnapshot {
    fn from(format: &crate::library::model::BookFormat) -> Self {
        Self {
            source_path: format.source_path.clone(),
            added_at: format.added_at.clone(),
            provenance: format.provenance,
        }
    }
}

pub(super) fn validate_saved_view_definition(definition: &SavedViewDefinition) -> AppResult<()> {
    if definition.version != 1 || definition.query.encode_utf16().count() > 1024 {
        return Err(crate::app_error!("invalid-arguments"));
    }
    if matches!(
        definition.query_syntax,
        Some(LibraryQuerySyntax::StructuredV1)
    ) {
        parse_structured_query(&definition.query)?;
    }
    definition.filters.validate_values(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition() -> serde_json::Value {
        json!({"version":1,"query":"author:Alice","filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":["epub"]},"sort":{"field":"addedAt","direction":"descending"}})
    }

    #[test]
    fn saved_view_wire_shape_is_preserved_and_unknown_fields_are_rejected() {
        let wire = definition();
        let parsed: SavedViewDefinition = serde_json::from_value(wire.clone()).unwrap();
        validate_saved_view_definition(&parsed).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        for (field, value) in [
            ("extra", json!(true)),
            ("querySyntax", json!(null)),
            ("querySyntax", json!("unknown")),
            ("sort", json!({"field":"title","direction":"random"})),
        ] {
            let mut bad = wire.clone();
            bad[field] = value;
            assert!(serde_json::from_value::<SavedViewDefinition>(bad).is_err());
        }
    }

    #[test]
    fn saved_view_typed_validation_rejects_duplicates_and_invalid_versions() {
        let mut parsed: SavedViewDefinition = serde_json::from_value(definition()).unwrap();
        parsed.filters.tags = vec!["Read".into(), " read ".into()];
        assert!(validate_saved_view_definition(&parsed).is_err());
        parsed.filters.tags.clear();
        parsed.version = 2;
        assert!(validate_saved_view_definition(&parsed).is_err());
    }

    #[test]
    fn legacy_saved_view_formats_remain_case_insensitive() {
        let mut wire = definition();
        wire["filters"]["formats"] = json!(["EPUB"]);
        let mut parsed: SavedViewDefinition = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed.filters.formats, vec![FormatId::Epub]);
        validate_saved_view_definition(&parsed).unwrap();
        parsed.filters.formats.push(FormatId::Epub);
        assert!(validate_saved_view_definition(&parsed).is_err());
    }

    #[test]
    fn expected_snapshot_requires_typed_identity_but_accepts_full_format() {
        let wire = json!({"sourcePath":"/book.epub","addedAt":"now","provenance":"managed","format":"epub"});
        let snapshot: ExpectedFormatSnapshot = serde_json::from_value(wire).unwrap();
        assert_eq!(snapshot.source_path, PathBuf::from("/book.epub"));
        assert_eq!(snapshot.provenance, Provenance::Managed);
        assert!(
            serde_json::from_value::<ExpectedFormatSnapshot>(
                json!({"sourcePath":3,"addedAt":"now","provenance":"managed"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ExpectedFormatSnapshot>(
                json!({"sourcePath":"/book.epub","addedAt":"now","provenance":"invalid"})
            )
            .is_err()
        );
    }
}
