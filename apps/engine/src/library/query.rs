//! Shared query inputs and result facets for every library frontend.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::library::model::LibraryItem;
pub use crate::library::store::Filters;
pub use crate::library::store::SavedViewSortField as SortField;
use crate::library::store::{
    LibraryQueryScope, LibraryQuerySyntax, LibraryStore, SavedViewSort, SavedViewSortDirection,
};

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueryPage {
    pub offset: usize,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRequest {
    pub query: String,
    #[serde(default = "literal_syntax")]
    pub query_syntax: LibraryQuerySyntax,
    pub filters: Filters,
    pub sort: SavedViewSort,
    pub page: QueryPage,
    #[serde(default, deserialize_with = "present_string")]
    pub virtual_library_id: Option<String>,
}

fn literal_syntax() -> LibraryQuerySyntax {
    LibraryQuerySyntax::Literal
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Serialize)]
pub struct QueryResult {
    pub items: Vec<LibraryItem>,
    pub total: usize,
    pub page: QueryPage,
    pub facets: Facets,
}

pub fn query(store: &LibraryStore, request: QueryRequest) -> AppResult<QueryResult> {
    if !(1..=100).contains(&request.page.limit) {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let virtual_scope = request
        .virtual_library_id
        .as_deref()
        .map(|id| {
            let id = id.trim();
            if id.is_empty() || id.encode_utf16().count() > 256 {
                return Err(crate::app_error!("invalid-arguments"));
            }
            let definition = store
                .saved_view(id)?
                .ok_or_else(|| crate::app_error!("not-found"))?
                .definition;
            let filters = definition.filters;
            Ok((
                definition.query,
                definition
                    .query_syntax
                    .unwrap_or(LibraryQuerySyntax::Literal),
                filters,
            ))
        })
        .transpose()?;
    let mut scopes = Vec::with_capacity(2);
    if let Some((query, syntax, filters)) = &virtual_scope {
        scopes.push(LibraryQueryScope {
            query,
            syntax: *syntax,
            filters,
        });
    }
    scopes.push(LibraryQueryScope {
        query: &request.query,
        syntax: request.query_syntax,
        filters: &request.filters,
    });
    let mut items = store.query_items_scoped(&scopes)?;
    let facets = Facets::from_items(&items);
    let descending = request.sort.direction == SavedViewSortDirection::Descending;
    items.sort_by(|left, right| {
        let ordering = sort_key(left, request.sort.field).cmp(&sort_key(right, request.sort.field));
        if descending {
            ordering.reverse()
        } else {
            ordering
        }
    });
    let total = items.len();
    let items = items
        .into_iter()
        .skip(request.page.offset)
        .take(request.page.limit)
        .collect();
    Ok(QueryResult {
        items,
        total,
        page: request.page,
        facets,
    })
}

pub fn sort_key(item: &LibraryItem, field: SortField) -> String {
    match field {
        SortField::Title => item.title.to_lowercase(),
        SortField::Author => item
            .primary_author()
            .map(str::to_lowercase)
            .unwrap_or_default(),
        SortField::Series => item.series.as_deref().unwrap_or_default().to_lowercase(),
        SortField::PublishedDate => item.published_date.clone().unwrap_or_default(),
        SortField::Rating => format!("{:020.6}", item.rating.unwrap_or(-1.0)),
        SortField::AddedAt => item.added_at.clone(),
        SortField::UpdatedAt => item.updated_at.clone().unwrap_or_default(),
    }
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
    fn facets_ignore_display_only_legacy_authors() {
        let mut legacy = crate::library::catalog::tests::sparse_book();
        legacy.author = Some("Public author".into());
        let mut structured = crate::library::catalog::tests::rich_book();
        structured.tags = vec!["fiction".into(), "fiction".into()];
        let facets = Facets::from_items(&[legacy, structured]);
        assert_eq!(
            facets.authors,
            BTreeMap::from([("Public author".into(), 1)])
        );
        assert_eq!(facets.tags, BTreeMap::from([("fiction".into(), 1)]));
        assert_eq!(
            serde_json::to_value(facets).unwrap()["authors"],
            serde_json::json!([{"value":"Public author","count":1}])
        );
    }
}
