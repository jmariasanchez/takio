use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};

use crate::conversion::FormatId;

/// A patch field that distinguishes "absent" from "explicitly null".
///
/// `Missing` leaves the stored value untouched, `Null` clears it to the
/// documented empty value for that field, and `Set` replaces it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum Patch<T> {
    #[default]
    Missing,
    Null,
    Set(T),
}

impl<T> Patch<T> {
    #[must_use]
    pub const fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    /// Returns the explicit value when the field is present and non-null.
    #[must_use]
    pub const fn set(&self) -> Option<&T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn into_set(self) -> Option<T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Null,
        })
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Set(value) => value.serialize(serializer),
            _ => serializer.serialize_none(),
        }
    }
}

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomColumnDefinition {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub position: u32,
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPatch {
    #[serde(default)]
    pub title: Patch<String>,
    #[serde(default)]
    pub author: Patch<String>,
    #[serde(default)]
    pub authors: Patch<Vec<BookAuthor>>,
    #[serde(default)]
    pub series: Patch<String>,
    #[serde(default)]
    pub series_index: Patch<f64>,
    #[serde(default)]
    pub publisher: Patch<String>,
    #[serde(default)]
    pub languages: Patch<Vec<String>>,
    #[serde(default)]
    pub identifiers: Patch<BTreeMap<String, String>>,
    #[serde(default)]
    pub custom_metadata: Patch<BTreeMap<String, String>>,
    #[serde(default)]
    pub published_date: Patch<String>,
    #[serde(default)]
    pub rating: Patch<f64>,
    #[serde(default)]
    pub description: Patch<String>,
    #[serde(default)]
    pub tags: Patch<Vec<String>>,
}

impl LibraryPatch {
    /// True when no field was supplied at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.title.is_missing()
            && self.author.is_missing()
            && self.authors.is_missing()
            && self.series.is_missing()
            && self.series_index.is_missing()
            && self.publisher.is_missing()
            && self.languages.is_missing()
            && self.identifiers.is_missing()
            && self.custom_metadata.is_missing()
            && self.published_date.is_missing()
            && self.rating.is_missing()
            && self.description.is_missing()
            && self.tags.is_missing()
    }
}
