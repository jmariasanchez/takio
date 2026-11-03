//! Duplicate-merge metadata contract and persistence within the caller's transaction.
use rusqlite::{Transaction, params};
use serde_json::Value;

use crate::model::{LibraryItem, LibraryPatch};
use crate::output::{AppError, AppResult};
use crate::store::{LibraryStore, metadata::replace_metadata};

pub(super) fn apply_duplicate_metadata(item: &mut LibraryItem, metadata: &Value) -> AppResult<()> {
    let patch: LibraryPatch =
        serde_json::from_value(metadata.clone()).map_err(|_| AppError::new("invalid-arguments"))?;
    LibraryStore::apply_patch_to_item(item, patch, false)
}

pub(super) fn write_duplicate_metadata(
    transaction: &Transaction<'_>,
    item: &LibraryItem,
) -> AppResult<()> {
    transaction.execute(
        "UPDATE library_items SET title=?2,author=?3,series=?4,series_index=?5,publisher=?6,
         published_date=?7,rating=?8,description=?9,updated_at=?10 WHERE id=?1",
        params![
            item.id,
            item.title,
            item.author,
            item.series,
            item.series_index,
            item.publisher,
            item.published_date,
            item.rating,
            item.description,
            item.updated_at
        ],
    )?;
    replace_metadata(transaction, item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_metadata_uses_typed_patch_contract() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            crate::paths::LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite")))
                .unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        let source = temp.path().join("book.epub");
        std::fs::write(&source, b"book").unwrap();
        let mut item = store.import(&source, None, false).unwrap();
        for metadata in [
            serde_json::json!({"unknown":true}),
            serde_json::json!({"tags":null}),
            serde_json::json!({"authors":[]}),
            serde_json::json!({"title":4}),
        ] {
            assert_eq!(
                apply_duplicate_metadata(&mut item, &metadata)
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
        }
        apply_duplicate_metadata(
            &mut item,
            &serde_json::json!({"authors":[{"name":" Alice "}],"tags":[]}),
        )
        .unwrap();
        assert_eq!(item.author.as_deref(), Some("Alice"));
        apply_duplicate_metadata(&mut item, &serde_json::json!({"authors":null})).unwrap();
        assert!(item.author.is_none());
    }
}
