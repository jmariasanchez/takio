//! Immutable hydration reuse, scoped to one SQLite connection and read snapshot.
use std::sync::Arc;

use super::*;

const MAX_ITEMS: usize = 10_000;
const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static AFTER_SELECTION: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}

#[derive(Default)]
pub(super) struct QueryCache {
    revision: Option<(i64, u64, i64)>,
    items: HashMap<String, Arc<LibraryItem>>,
    payload_bytes: usize,
}

impl QueryCache {
    fn revision(&mut self, revision: (i64, u64, i64)) {
        if self.revision != Some(revision) {
            self.items.clear();
            self.payload_bytes = 0;
            self.revision = Some(revision);
        }
    }

    fn retain(&mut self, item: &Arc<LibraryItem>) {
        let bytes = payload_bytes(item);
        if self.items.len() < MAX_ITEMS
            && bytes <= MAX_PAYLOAD_BYTES.saturating_sub(self.payload_bytes)
        {
            self.items.insert(item.id.clone(), item.clone());
            self.payload_bytes += bytes;
        }
    }
}

impl LibraryStore {
    /// Query with the same literal SQL and facets as `query_items`, sharing
    /// immutable hydrated records between successive native snapshots.
    ///
    /// Cache validity includes writes through this connection (`total_changes`)
    /// and other connections (`data_version`), plus schema changes. SQL selection
    /// first pins a read transaction, so IDs, the revision and missing-record
    /// hydration all belong to one snapshot, including external WAL writes.
    /// This never caches filesystem existence, content fingerprints or send safety.
    pub fn query_items_shared(
        &self,
        query: &str,
        filters: LibraryQueryFilters<'_>,
    ) -> AppResult<Vec<Arc<LibraryItem>>> {
        // Do not retain uncommitted records if a caller already owns a transaction.
        if !self.connection.is_autocommit() {
            return self
                .query_items(query, filters)
                .map(|items| items.into_iter().map(Arc::new).collect());
        }
        let transaction = self.connection.unchecked_transaction()?;
        let ids = query_item_ids(
            &transaction,
            &[LibraryQueryScope {
                query,
                syntax: LibraryQuerySyntax::Literal,
                filters,
            }],
        )?;
        #[cfg(test)]
        AFTER_SELECTION.with(|hook| {
            if let Some(run) = hook.borrow_mut().take() {
                run();
            }
        });
        let revision = (
            transaction.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))?,
            transaction.total_changes(),
            transaction.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))?,
        );
        let mut cache = self.query_cache.borrow_mut();
        cache.revision(revision);
        let missing: Vec<_> = ids
            .iter()
            .filter(|id| !cache.items.contains_key(*id))
            .cloned()
            .collect();
        let mut fresh: HashMap<_, _> = read_items_bulk(&transaction, &missing)?
            .into_iter()
            .map(|item| (item.id.clone(), Arc::new(item)))
            .collect();
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(item) = cache.items.get(&id) {
                result.push(item.clone());
            } else if let Some(item) = fresh.remove(&id) {
                cache.retain(&item);
                result.push(item);
            }
        }
        // Ending the read transaction permits normal external writer/checkpoint
        // progress. Neither locks nor mutable database references reach the UI.
        transaction.commit()?;
        Ok(result)
    }
}

// Charge string/path capacities, vector storage and conservative map overhead,
// as well as bounding item count. This is an estimated retention budget, not an
// exact allocator/RSS limit. Oversized records still appear in results, uncached.
fn payload_bytes(item: &LibraryItem) -> usize {
    let mut bytes = std::mem::size_of::<LibraryItem>()
        // Include the separately cloned cache key, entry and Arc counters.
        + item.id.len()
        + std::mem::size_of::<(String, Arc<LibraryItem>)>()
        + 2 * std::mem::size_of::<usize>()
        + item.id.capacity()
        + item.title.capacity()
        + item.added_at.capacity()
        + item.source_path.capacity()
        + item.authors.capacity() * std::mem::size_of::<BookAuthor>()
        + item.formats.capacity() * std::mem::size_of::<BookFormat>()
        + (item.languages.capacity() + item.tags.capacity()) * std::mem::size_of::<String>()
        + (item.identifiers.len() + item.custom_metadata.len())
            * (std::mem::size_of::<(String, String)>() + 64);
    for value in [
        &item.author,
        &item.series,
        &item.publisher,
        &item.published_date,
        &item.description,
        &item.updated_at,
    ]
    .into_iter()
    .flatten()
    {
        bytes += value.capacity();
    }
    if let Some(path) = &item.cover_path {
        bytes += path.capacity();
    }
    for author in &item.authors {
        bytes += author.name.capacity() + author.sort_name.as_ref().map_or(0, String::capacity);
    }
    for value in item.languages.iter().chain(&item.tags) {
        bytes += value.capacity();
    }
    for (key, value) in item.identifiers.iter().chain(&item.custom_metadata) {
        bytes += key.capacity() + value.capacity();
    }
    for format in &item.formats {
        bytes += format.source_path.capacity() + format.added_at.capacity();
    }
    bytes
}

#[cfg(test)]
mod tests;
