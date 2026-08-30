use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::conversion::FormatId;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookAuthor {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provenance {
    Managed,
    Referenced,
}

impl Provenance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Referenced => "referenced",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookFormat {
    pub source_path: PathBuf,
    pub format: FormatId,
    pub added_at: String,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub title: String,
    pub source_path: PathBuf,
    pub format: FormatId,
    pub added_at: String,
    pub formats: Vec<BookFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub authors: Vec<BookAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub identifiers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub custom_metadata: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<PathBuf>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPatch {
    pub title: Option<String>,
    pub author: Option<Option<String>>,
    pub authors: Option<Vec<BookAuthor>>,
    pub series: Option<Option<String>>,
    pub series_index: Option<Option<f64>>,
    pub publisher: Option<Option<String>>,
    pub languages: Option<Vec<String>>,
    pub identifiers: Option<BTreeMap<String, String>>,
    pub custom_metadata: Option<BTreeMap<String, String>>,
    pub published_date: Option<Option<String>>,
    pub rating: Option<Option<f64>>,
    pub description: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
}
