//! Shared query inputs and result facets for every library frontend.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::LibraryItem;
use crate::output::{AppError, AppResult};
use crate::store::LibraryQueryFilters;

/// Facet groups are conjunctive, values within one group are alternatives.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub series: Vec<String>,
    pub languages: Vec<String>,
    pub formats: Vec<String>,
}

impl Filters {
    pub fn is_empty(&self) -> bool {
        self.authors.is_empty()
            && self.tags.is_empty()
            && self.series.is_empty()
            && self.languages.is_empty()
            && self.formats.is_empty()
    }

    pub fn normalize(&mut self) -> AppResult<()> {
        for values in [
            &mut self.authors,
            &mut self.tags,
            &mut self.series,
            &mut self.languages,
            &mut self.formats,
        ] {
            for value in values {
                if value.trim().is_empty() {
                    return Err(AppError::new("invalid-arguments"));
                }
                *value = value.to_lowercase();
            }
        }
        Ok(())
    }

    pub fn engine(&self) -> LibraryQueryFilters<'_> {
        LibraryQueryFilters {
            authors: &self.authors,
            tags: &self.tags,
            series: &self.series,
            languages: &self.languages,
            formats: &self.formats,
        }
    }
}

/// Each book contributes at most one count to a distinct value in each facet.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facets {
    pub authors: BTreeMap<String, u64>,
    pub tags: BTreeMap<String, u64>,
    pub series: BTreeMap<String, u64>,
    pub languages: BTreeMap<String, u64>,
    pub formats: BTreeMap<String, u64>,
}

impl Facets {
    pub fn from_items(items: &[LibraryItem]) -> Self {
        Self::from_item_refs(items.iter())
    }

    pub fn from_item_refs<'a>(items: impl IntoIterator<Item = &'a LibraryItem>) -> Self {
        let mut facets = Self::default();
        for item in items {
            count_values(&mut facets.authors, item.author_names());
            count_values(&mut facets.tags, item.tags.iter().map(String::as_str));
            count_values(&mut facets.series, item.series.as_deref());
            count_values(
                &mut facets.languages,
                item.languages.iter().map(String::as_str),
            );
            count_values(
                &mut facets.formats,
                item.formats.iter().map(|format| format.format.as_str()),
            );
        }
        facets
    }
}

fn count_values<'a>(counts: &mut BTreeMap<String, u64>, values: impl IntoIterator<Item = &'a str>) {
    for value in values
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
    {
        *counts.entry(value.to_owned()).or_default() += 1;
    }
}

#[derive(Serialize)]
struct FacetEntry<'a> {
    value: &'a str,
    count: u64,
}

impl Serialize for Facets {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Facets", 5)?;
        for (name, counts) in [
            ("authors", &self.authors),
            ("tags", &self.tags),
            ("series", &self.series),
            ("languages", &self.languages),
            ("formats", &self.formats),
        ] {
            let entries: Vec<_> = counts
                .iter()
                .map(|(value, count)| FacetEntry {
                    value,
                    count: *count,
                })
                .collect();
            state.serialize_field(name, &entries)?;
        }
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn facets_use_legacy_authors_only_without_structured_names() {
        let mut legacy = crate::catalog::tests::sparse_book();
        legacy.author = Some("Public author".into());
        let mut structured = crate::catalog::tests::rich_book();
        structured.tags = vec!["fiction".into(), "fiction".into()];
        let facets = Facets::from_items(&[legacy, structured]);
        assert_eq!(
            facets.authors,
            BTreeMap::from([("Public author".into(), 2)])
        );
        assert_eq!(facets.tags, BTreeMap::from([("fiction".into(), 1)]));
        assert_eq!(
            serde_json::to_value(facets).unwrap()["authors"],
            serde_json::json!([{"value":"Public author","count":2}])
        );
    }
}
