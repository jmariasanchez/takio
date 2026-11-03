use super::*;
use crate::model::{LibraryPatch, Patch};
use crate::paths::LibraryPaths;
use rusqlite::Connection;
use std::path::PathBuf;

fn filters() -> LibraryQueryFilters<'static> {
    LibraryQueryFilters {
        authors: &[],
        tags: &[],
        series: &[],
        languages: &[],
        formats: &[],
    }
}

fn fixture(count: usize) -> (tempfile::TempDir, LibraryStore) {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    crate::store::tests::seed_hydration_books(&mut store, count);
    (temp, store)
}

fn assert_same(
    store: &LibraryStore,
    query: &str,
    filters: LibraryQueryFilters<'_>,
) -> Vec<Arc<LibraryItem>> {
    let expected = store.query_items(query, filters).unwrap();
    let shared = store.query_items_shared(query, filters).unwrap();
    let refs: Vec<_> = shared.iter().map(Arc::as_ref).collect();
    assert_eq!(
        serde_json::to_value(&expected).unwrap(),
        serde_json::to_value(refs).unwrap()
    );
    shared
}

#[test]
fn shared_queries_preserve_full_metadata_literals_filters_and_chunk_order() {
    for count in [0, 1, 501, 1001] {
        let (_temp, store) = fixture(count);
        let initial = assert_same(&store, "", filters());
        for query in [
            "",
            "SIGNAL",
            "%",
            "_",
            "\\",
            "'",
            "title:Signal",
            "José",
            "Signal Author",
        ] {
            assert_same(&store, query, filters());
        }
        if let Some(first) = initial.first() {
            let authors = vec![first.authors[0].name.clone()];
            let tags = first.tags.clone();
            let series = first.series.iter().cloned().collect::<Vec<_>>();
            let languages = first.languages.clone();
            let formats = vec![first.format.as_str().to_owned()];
            for selected in [
                LibraryQueryFilters {
                    authors: &authors,
                    ..filters()
                },
                LibraryQueryFilters {
                    tags: &tags,
                    ..filters()
                },
                LibraryQueryFilters {
                    series: &series,
                    ..filters()
                },
                LibraryQueryFilters {
                    languages: &languages,
                    ..filters()
                },
                LibraryQueryFilters {
                    formats: &formats,
                    ..filters()
                },
                LibraryQueryFilters {
                    authors: &authors,
                    tags: &tags,
                    series: &series,
                    languages: &languages,
                    formats: &formats,
                },
            ] {
                assert_same(&store, "Signal", selected);
            }
            let again = assert_same(&store, "", filters());
            assert!(
                Arc::ptr_eq(first, &again[0]),
                "unchanged records must not be hydrated again"
            );
        }
    }
}

#[test]
fn local_metadata_attachment_trash_restore_and_purge_invalidate_shared_records() {
    let (_temp, mut store) = fixture(2);
    store
        .connection
        .execute("UPDATE library_items SET cover_path=NULL", [])
        .unwrap();
    let before = assert_same(&store, "", filters());
    let id = before[0].id.clone();
    store
        .update(
            &id,
            LibraryPatch {
                title: Patch::Set("Changed title".into()),
                ..LibraryPatch::default()
            },
        )
        .unwrap();
    let changed = assert_same(&store, "Changed title", filters());
    assert_eq!(changed.len(), 1);
    assert!(!Arc::ptr_eq(&before[0], &changed[0]));
    assert_ne!(
        before[0].title, changed[0].title,
        "published snapshots stay immutable"
    );
    store.connection.execute("UPDATE library_item_formats SET source_path='/new/reference.epub' WHERE library_item_id=?1", [&id]).unwrap();
    let attached = assert_same(&store, "Changed title", filters());
    assert_eq!(
        attached[0].source_path,
        PathBuf::from("/new/reference.epub")
    );
    store.trash(&id).unwrap();
    assert!(assert_same(&store, "Changed title", filters()).is_empty());
    store.restore(&id).unwrap();
    assert_eq!(assert_same(&store, "Changed title", filters()).len(), 1);
    store.trash(&id).unwrap();
    store.purge(&id).unwrap();
    assert!(assert_same(&store, "Changed title", filters()).is_empty());
}

#[test]
fn cached_literals_match_actual_percent_underscore_backslash_and_unicode() {
    let (_temp, store) = fixture(2);
    assert_same(&store, "", filters());
    store
        .connection
        .execute(
            "UPDATE library_items SET title=?1 WHERE id='book-00000'",
            ["100%_\\ José"],
        )
        .unwrap();
    for query in ["%", "_", "\\", "José", "100%_\\"] {
        let result = assert_same(&store, query, filters());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "book-00000");
    }
}

#[test]
fn external_commits_invalidate_in_rollback_and_wal_modes() {
    for mode in ["DELETE", "WAL"] {
        let (_temp, store) = fixture(2);
        store
            .connection
            .pragma_update(None, "journal_mode", mode)
            .unwrap();
        let initial = assert_same(&store, "", filters());
        let other = Connection::open(&store.paths.database).unwrap();
        other.execute("UPDATE library_items SET title='External title',description='External description' WHERE id=?1", [&initial[0].id]).unwrap();
        other
            .execute(
                "UPDATE library_item_authors SET name='External author' WHERE library_item_id=?1",
                [&initial[0].id],
            )
            .unwrap();
        let changed = assert_same(&store, "External author", filters());
        assert_eq!(changed.len(), 1);
        assert_eq!(
            changed[0].description.as_deref(),
            Some("External description")
        );
        assert!(!Arc::ptr_eq(&initial[0], &changed[0]));
        other
            .execute("DELETE FROM library_items WHERE id=?1", [&initial[0].id])
            .unwrap();
        assert!(assert_same(&store, "External title", filters()).is_empty());
    }
}

#[test]
fn nested_transactions_never_retain_uncommitted_or_newer_wal_snapshots() {
    let (_temp, store) = fixture(1);
    store
        .connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    let initial = assert_same(&store, "", filters());
    store
        .connection
        .execute_batch("BEGIN; UPDATE library_items SET title='Uncommitted';")
        .unwrap();
    assert_eq!(
        store.query_items_shared("", filters()).unwrap()[0].title,
        "Uncommitted"
    );
    store.connection.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        assert_same(&store, "", filters())[0].title,
        initial[0].title
    );

    store
        .connection
        .execute_batch("BEGIN; SELECT id FROM library_items;")
        .unwrap();
    let other = Connection::open(&store.paths.database).unwrap();
    other
        .execute("UPDATE library_items SET title='New WAL snapshot'", [])
        .unwrap();
    assert_eq!(
        store.query_items_shared("", filters()).unwrap()[0].title,
        initial[0].title
    );
    store.connection.execute_batch("COMMIT").unwrap();
    assert_eq!(
        assert_same(&store, "", filters())[0].title,
        "New WAL snapshot"
    );
}

#[test]
fn external_wal_commit_between_selection_and_hydration_cannot_mix_snapshots() {
    let (_temp, store) = fixture(2);
    store
        .connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    let initial = assert_same(&store, "", filters());
    // One cache hit and one forced miss must both describe the pinned snapshot.
    store.query_cache.borrow_mut().items.remove(&initial[1].id);
    let other = Connection::open(&store.paths.database).unwrap();
    AFTER_SELECTION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            other
                .execute(
                    "UPDATE library_items SET title='Committed after selection'",
                    [],
                )
                .unwrap();
        }))
    });
    let during = store.query_items_shared("", filters()).unwrap();
    assert!(Arc::ptr_eq(&initial[0], &during[0]));
    for (before, during) in initial.iter().zip(&during) {
        assert_eq!(
            serde_json::to_value(before.as_ref()).unwrap(),
            serde_json::to_value(during.as_ref()).unwrap()
        );
    }
    let after = assert_same(&store, "", filters());
    assert!(
        after
            .iter()
            .all(|item| item.title == "Committed after selection")
    );
    assert!(!Arc::ptr_eq(&initial[0], &after[0]));
}

#[test]
fn cached_rows_do_not_hide_new_invalid_stored_data() {
    let (_temp, store) = fixture(1);
    assert_same(&store, "", filters());
    store
        .connection
        .execute("DELETE FROM library_item_formats", [])
        .unwrap();
    assert_eq!(
        store.query_items_shared("", filters()).unwrap_err().code(),
        "invalid-stored-data"
    );
    assert!(store.query_cache.borrow().items.is_empty());
}

#[test]
fn same_connection_schema_change_invalidates_hydrated_records() {
    let (_temp, store) = fixture(1);
    let first = assert_same(&store, "", filters());
    store
        .connection
        .execute("CREATE TABLE extra_fixture(value TEXT)", [])
        .unwrap();
    let next = assert_same(&store, "", filters());
    assert!(!Arc::ptr_eq(&first[0], &next[0]));
}

#[test]
fn cache_lifetime_is_one_store_and_retention_limits_do_not_change_results() {
    let (_temp, store) = fixture(1);
    let first = assert_same(&store, "", filters());
    let (_other_temp, other) = fixture(1);
    other
        .connection
        .execute(
            "UPDATE library_items SET title='Different library same ID'",
            [],
        )
        .unwrap();
    let other_items = assert_same(&other, "", filters());
    assert_eq!(other_items[0].id, first[0].id);
    assert_eq!(other_items[0].title, "Different library same ID");
    assert!(!Arc::ptr_eq(&first[0], &other_items[0]));

    // Exercise both bounded-retention branches without allocating thousands of
    // distinct copies of the same large fixture. Uncached items still return.
    let mut cache = store.query_cache.borrow_mut();
    cache.items.clear();
    cache.payload_bytes = MAX_PAYLOAD_BYTES;
    drop(cache);
    let uncached = assert_same(&store, "", filters());
    assert!(store.query_cache.borrow().items.is_empty());
    assert_eq!(uncached[0].title, first[0].title);
    let mut cache = store.query_cache.borrow_mut();
    cache.payload_bytes = 0;
    for index in 0..MAX_ITEMS {
        cache
            .items
            .insert(format!("retained-{index}"), first[0].clone());
    }
    drop(cache);
    assert_same(&store, "", filters());
    assert_eq!(store.query_cache.borrow().items.len(), MAX_ITEMS);
}

#[test]
fn oversized_stored_record_is_returned_without_retention() {
    let (_temp, store) = fixture(1);
    store
        .connection
        .execute(
            "UPDATE library_items SET description=?1",
            ["x".repeat(MAX_PAYLOAD_BYTES)],
        )
        .unwrap();
    let first = store.query_items_shared("", filters()).unwrap();
    assert_eq!(first.len(), 1);
    let description = first[0].description.as_ref().unwrap();
    assert_eq!(description.len(), MAX_PAYLOAD_BYTES);
    assert!(description.bytes().all(|byte| byte == b'x'));
    assert!(store.query_cache.borrow().items.is_empty());
    assert_eq!(store.query_cache.borrow().payload_bytes, 0);
    let second = store.query_items_shared("", filters()).unwrap();
    assert_eq!(second[0].description, first[0].description);
    assert!(!Arc::ptr_eq(&first[0], &second[0]));
    assert!(store.query_cache.borrow().items.is_empty());
}

#[test]
fn retention_budget_counts_spare_container_capacity_and_cloned_key() {
    let (_temp, store) = fixture(1);
    let mut item = store.list(false).unwrap().remove(0);
    let base = payload_bytes(&item);
    let id_len = item.id.len();
    let id_capacity = item.id.capacity();
    item.id = String::new();
    assert_eq!(base - payload_bytes(&item), id_len + id_capacity);

    item.tags = Vec::with_capacity(MAX_PAYLOAD_BYTES / std::mem::size_of::<String>() + 1);
    assert!(item.tags.is_empty());
    assert!(payload_bytes(&item) > MAX_PAYLOAD_BYTES);
    let mut cache = QueryCache::default();
    cache.retain(&Arc::new(item));
    assert!(cache.items.is_empty());
    assert_eq!(cache.payload_bytes, 0);
}
