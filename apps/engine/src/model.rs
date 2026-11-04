use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};

use crate::format::FormatId;

/// Whether importing preserves the original file or removes it after a verified copy.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    #[default]
    Copy,
    Move,
}

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
    pub const fn value(&self) -> Option<&T> {
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

impl std::str::FromStr for Provenance {
    type Err = crate::error::AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "managed" => Ok(Self::Managed),
            "referenced" => Ok(Self::Referenced),
            _ => Err(crate::app_error!("invalid-stored-data")),
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
    pub column_type: CustomColumnType,
    pub position: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CustomColumnType {
    Text,
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
    /// Derived display value retained for wire compatibility, never a matching
    /// source. Crate-private so only the store sets it, always through
    /// [`derived_display_author`]. Read it with [`LibraryItem::display_author`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) author: Option<String>,
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

impl LibraryItem {
    /// Structured names are authoritative for matching and facets.
    pub fn author_names(&self) -> impl Iterator<Item = &str> {
        self.authors.iter().map(|author| author.name.as_str())
    }

    pub fn primary_author(&self) -> Option<&str> {
        self.author_names().next()
    }

    /// The legacy scalar display value as stored on the wire.
    #[must_use]
    pub fn display_author(&self) -> Option<&str> {
        self.author.as_deref()
    }

    /// Simulate a legacy scalar-only record in adapter tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_legacy_display_author_for_test(&mut self, author: Option<&str>) {
        self.author = author.map(str::to_owned);
    }

    /// Minimal item for adapter tests; set further public fields directly.
    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn for_test(
        id: &str,
        title: &str,
        source_path: &str,
        format: FormatId,
        added_at: &str,
    ) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            source_path: PathBuf::from(source_path),
            format,
            added_at: added_at.to_owned(),
            formats: Vec::new(),
            author: None,
            authors: Vec::new(),
            series: None,
            series_index: None,
            publisher: None,
            languages: Vec::new(),
            identifiers: BTreeMap::new(),
            custom_metadata: BTreeMap::new(),
            published_date: None,
            rating: None,
            description: None,
            cover_path: None,
            tags: Vec::new(),
            updated_at: None,
        }
    }
}

/// The legacy scalar `author` wire field, always derived from structured
/// authors. It is never an independent source of truth.
#[must_use]
pub fn derived_display_author(authors: &[BookAuthor]) -> Option<String> {
    (!authors.is_empty()).then(|| {
        authors
            .iter()
            .map(|author| author.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    })
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPatch {
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub title: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub author: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub authors: Patch<Vec<BookAuthor>>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub series: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub series_index: Patch<f64>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub publisher: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub languages: Patch<Vec<String>>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub identifiers: Patch<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub custom_metadata: Patch<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub published_date: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub rating: Patch<f64>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub description: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub tags: Patch<Vec<String>>,
}

impl LibraryPatch {
    /// Present wire field names, including explicit nulls, in stable review order.
    pub fn field_names(&self) -> Vec<String> {
        [
            ("author", self.author.is_missing()),
            ("authors", self.authors.is_missing()),
            ("customMetadata", self.custom_metadata.is_missing()),
            ("description", self.description.is_missing()),
            ("identifiers", self.identifiers.is_missing()),
            ("languages", self.languages.is_missing()),
            ("publishedDate", self.published_date.is_missing()),
            ("publisher", self.publisher.is_missing()),
            ("rating", self.rating.is_missing()),
            ("series", self.series.is_missing()),
            ("seriesIndex", self.series_index.is_missing()),
            ("tags", self.tags.is_missing()),
            ("title", self.title.is_missing()),
        ]
        .into_iter()
        .filter(|(_, missing)| !missing)
        .map(|(name, _)| name.to_owned())
        .collect()
    }

    /// Remove fields the user did not approve without changing retained nulls.
    pub fn retain_fields(&mut self, fields: &std::collections::BTreeSet<String>) {
        macro_rules! retain {
            ($($field:ident => $name:literal),+ $(,)?) => {
                $(if !fields.contains($name) { self.$field = Patch::Missing; })+
            };
        }
        retain! {
            title => "title", author => "author", authors => "authors",
            series => "series", series_index => "seriesIndex", publisher => "publisher",
            languages => "languages", identifiers => "identifiers",
            custom_metadata => "customMetadata", published_date => "publishedDate",
            rating => "rating", description => "description", tags => "tags",
        }
    }

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
