//! Duplicate-merge metadata contract and persistence within the caller's transaction.
use rusqlite::{Transaction, params};

use crate::error::AppResult;
use crate::model::{LibraryItem, LibraryPatch};
use crate::store::{LibraryStore, metadata::replace_metadata};

pub(super) fn apply_duplicate_metadata(
    item: &mut LibraryItem,
    patch: &LibraryPatch,
) -> AppResult<()> {
    LibraryStore::apply_patch_to_item(item, patch.clone(), false)
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
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let source = temp.path().join("book.epub");
        std::fs::write(&source, b"book").unwrap();
        let mut item = store
            .import(&source, None, crate::model::ImportMode::Copy)
            .unwrap();
        for metadata in [
            serde_json::json!({"unknown":true}),
            serde_json::json!({"title":4}),
        ] {
            assert!(serde_json::from_value::<LibraryPatch>(metadata).is_err());
        }
        for invalid in [
            serde_json::json!({"authors":[]}),
            serde_json::json!({"tags":null}),
        ] {
            let patch = serde_json::from_value(invalid).unwrap();
            assert_eq!(
                apply_duplicate_metadata(&mut item, &patch)
                    .unwrap_err()
                    .code(),
                "invalid-arguments"
            );
        }
        apply_duplicate_metadata(
            &mut item,
            &serde_json::from_value(serde_json::json!({"authors":[{"name":" Alice "}],"tags":[]}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(item.author.as_deref(), Some("Alice"));
        apply_duplicate_metadata(
            &mut item,
            &serde_json::from_value(serde_json::json!({"authors":null})).unwrap(),
        )
        .unwrap();
        assert!(item.author.is_none());
    }
}
