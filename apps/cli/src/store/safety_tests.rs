use super::*;

fn fixture() -> (tempfile::TempDir, LibraryStore, LibraryItem) {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let source = temp.path().join("book.epub");
    fs::write(&source, b"original book").unwrap();
    let item = store.import(&source, None, false).unwrap();
    (temp, store, item)
}

#[test]
fn duplicate_import_explicitly_preserves_copy_and_move_sources() {
    let (temp, mut store, item) = fixture();
    let source = temp.path().join("duplicate.epub");
    fs::write(&source, b"original book").unwrap();
    for move_source in [false, true] {
        let outcome = store
            .import_with_outcome(&source, None, move_source)
            .unwrap();
        assert_eq!(outcome.status, ImportStatus::Duplicate);
        assert_eq!(outcome.item.id, item.id);
        assert!(outcome.source_preserved);
        assert_eq!(
            store.import(&source, None, move_source).unwrap_err().code(),
            "duplicate-source-preserved"
        );
        assert_eq!(fs::read(&source).unwrap(), b"original book");
        assert_eq!(store.list(true).unwrap().len(), 1);
        assert!(item.formats[0].source_path.exists());
    }
}

#[test]
fn purge_reports_changed_file_and_continues_other_cleanup() {
    let (temp, mut store, item) = fixture();
    let pdf = temp.path().join("extra.pdf");
    fs::write(&pdf, b"pdf bytes").unwrap();
    let item = store.attach_format(&item.id, &pdf, true).unwrap();
    let changed = item.formats[0].source_path.clone();
    let unchanged = item.formats[1].source_path.clone();
    fs::write(&changed, b"user changed bytes").unwrap();
    store.trash(&item.id).unwrap();
    let result = store.purge(&item.id).unwrap();
    assert!(result.cleanup_pending);
    assert_eq!(result.cleanup_pending_paths, vec![changed.clone()]);
    assert!(store.get(&item.id).unwrap().is_none());
    assert_eq!(fs::read(changed).unwrap(), b"user changed bytes");
    assert!(!unchanged.exists());
    assert_eq!(
        serde_json::to_value(result).unwrap()["cleanupPending"],
        true
    );
}

#[test]
fn remove_format_reports_cleanup_failure_after_committed_change() {
    let (temp, mut store, item) = fixture();
    let pdf = temp.path().join("extra.pdf");
    fs::write(&pdf, b"pdf bytes").unwrap();
    store.attach_format(&item.id, &pdf, true).unwrap();
    let changed = item.formats[0].source_path.clone();
    fs::write(&changed, b"user changed bytes").unwrap();
    let result = store.remove_format(&item.id, FormatId::Epub).unwrap();
    assert!(result.cleanup_pending);
    assert_eq!(result.cleanup_pending_paths, vec![changed.clone()]);
    assert_eq!(result.item.formats.len(), 1);
    assert_eq!(result.item.format, FormatId::Pdf);
    assert_eq!(store.get(&item.id).unwrap().unwrap().format, FormatId::Pdf);
    assert_eq!(fs::read(changed).unwrap(), b"user changed bytes");
}

#[test]
fn replace_format_reports_cleanup_failure_after_committed_change() {
    let (temp, mut store, item) = fixture();
    let replacement = temp.path().join("replacement.epub");
    fs::write(&replacement, b"replacement").unwrap();
    let changed = item.formats[0].source_path.clone();
    fs::write(&changed, b"user changed bytes").unwrap();
    let expected = ExpectedFormatSnapshot::from(&item.formats[0]);
    let result = store
        .replace_format(&item.id, FormatId::Epub, &expected, &replacement, true)
        .unwrap();
    assert!(result.cleanup_pending);
    assert_eq!(result.cleanup_pending_paths, vec![changed.clone()]);
    assert_eq!(fs::read(&result.item.source_path).unwrap(), b"replacement");
    assert_eq!(fs::read(changed).unwrap(), b"user changed bytes");
    assert_eq!(
        store.get(&item.id).unwrap().unwrap().source_path,
        result.item.source_path
    );
}

#[test]
fn format_mutations_roll_back_if_result_hydration_fails() {
    for replace in [false, true] {
        let (temp, mut store, item) = fixture();
        let pdf = temp.path().join("extra.pdf");
        fs::write(&pdf, b"pdf bytes").unwrap();
        store.attach_format(&item.id, &pdf, true).unwrap();
        let before = store.get(&item.id).unwrap().unwrap();
        store
            .connection
            .pragma_update(None, "ignore_check_constraints", true)
            .unwrap();
        let event = if replace {
            "UPDATE OF source_path"
        } else {
            "DELETE"
        };
        store.connection.execute_batch(&format!("CREATE TRIGGER corrupt_result AFTER {event} ON library_item_formats BEGIN UPDATE library_item_formats SET provenance='broken' WHERE library_item_id=OLD.library_item_id; END;")).unwrap();
        let error = if replace {
            let replacement = temp.path().join("replacement.epub");
            fs::write(&replacement, b"replacement").unwrap();
            store
                .replace_format(
                    &item.id,
                    FormatId::Epub,
                    &ExpectedFormatSnapshot::from(&item.formats[0]),
                    &replacement,
                    true,
                )
                .unwrap_err()
        } else {
            store.remove_format(&item.id, FormatId::Epub).unwrap_err()
        };
        assert_eq!(error.code(), "invalid-stored-data");
        assert_eq!(
            serde_json::to_value(store.get(&item.id).unwrap().unwrap()).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(
            before
                .formats
                .iter()
                .all(|format| format.source_path.exists())
        );
    }
}

#[test]
fn remove_trashes_without_deleting_and_purge_requires_trash() {
    let (_temp, mut store, item) = fixture();
    assert_eq!(store.purge(&item.id).unwrap_err().code(), "not-trashed");
    assert!(item.formats[0].source_path.exists());
    assert_eq!(store.remove(&item.id).unwrap().item.id, item.id);
    assert!(item.formats[0].source_path.exists());
    assert_eq!(store.list_trash().unwrap()[0].id, item.id);
    store.remove(&item.id).unwrap();
    store.restore(&item.id).unwrap();
    assert_eq!(store.purge(&item.id).unwrap_err().code(), "not-trashed");
    store.trash(&item.id).unwrap();
    store.purge(&item.id).unwrap();
    assert!(!item.formats[0].source_path.exists());
}

#[test]
fn replacing_and_removing_shared_cover_preserves_other_item_reference() {
    for replace in [false, true] {
        let (temp, mut store, item) = fixture();
        let cover = temp.path().join("cover.jpg");
        fs::write(&cover, b"cover bytes").unwrap();
        let item = store.set_cover(&item.id, &cover).unwrap();
        let shared = item.cover_path.unwrap();
        let source = temp.path().join("other.epub");
        fs::write(&source, b"other book").unwrap();
        let other = store.import(&source, None, false).unwrap();
        store
            .connection
            .execute(
                "UPDATE library_items SET cover_path=?2 WHERE id=?1",
                params![other.id, shared.to_string_lossy()],
            )
            .unwrap();
        if replace {
            store.set_cover(&item.id, &cover).unwrap();
        } else {
            store.remove_cover(&item.id).unwrap();
        }
        assert_eq!(fs::read(&shared).unwrap(), b"cover bytes");
        assert_eq!(
            store.get(&other.id).unwrap().unwrap().cover_path,
            Some(shared)
        );
    }
}

#[test]
fn remove_view_ignores_unrelated_corrupt_definition() {
    let (_temp, store, _item) = fixture();
    store
        .save_view(&serde_json::from_value(serde_json::json!({"id":"good","name":"Good","definition":{"version":1,"query":"hello","filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},"sort":{"field":"title","direction":"ascending"}}})).unwrap())
        .unwrap();
    store
        .connection
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    store
        .connection
        .execute(
            "INSERT INTO saved_library_views VALUES('bad','Bad','invalid json','now','now')",
            [],
        )
        .unwrap();
    assert!(store.list_saved_views().is_err());
    assert_eq!(store.remove_view("good").unwrap().unwrap().id, "good");
    assert!(store.saved_view("good").unwrap().is_none());
}

#[test]
fn update_resynchronizes_legacy_author_and_clear() {
    let (_temp, mut store, item) = fixture();
    let updated = store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({
                "author":"stale", "authors":[{"name":" Alice "},{"name":"Bob"}]
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(updated.author.as_deref(), Some("Alice, Bob"));
    assert_eq!(store.get(&item.id).unwrap().unwrap().author, updated.author);
    let cleared = store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({"authors":null})).unwrap(),
        )
        .unwrap();
    assert!(cleared.author.is_none());
}

#[test]
fn typed_patch_rejections_leave_stored_metadata_unchanged() {
    let (_temp, mut store, item) = fixture();
    for patch in [
        serde_json::json!({}),
        serde_json::json!({"title":null}),
        serde_json::json!({"title":" "}),
        serde_json::json!({"authors":[]}),
        serde_json::json!({"languages":[]}),
        serde_json::json!({"rating":11}),
        serde_json::json!({"tags":null}),
        serde_json::json!({"customMetadata":{"takio_metadata_audit":"reserved"}}),
    ] {
        assert_eq!(
            store
                .update(&item.id, serde_json::from_value(patch).unwrap())
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        assert_eq!(
            serde_json::to_value(store.get(&item.id).unwrap().unwrap()).unwrap(),
            serde_json::to_value(&item).unwrap()
        );
    }
}

#[test]
fn sibling_mutators_report_not_found() {
    let (_temp, mut store, item) = fixture();
    assert!(store.get("missing").unwrap().is_none());
    assert!(store.saved_view("missing").unwrap().is_none());
    assert_eq!(
        store
            .replace_format(
                "missing",
                FormatId::Epub,
                &ExpectedFormatSnapshot::from(&item.formats[0]),
                &item.formats[0].source_path,
                true,
            )
            .unwrap_err()
            .code(),
        "not-found"
    );
    assert_eq!(store.remove("missing").unwrap_err().code(), "not-found");
    assert_eq!(
        store.remove_view("missing").unwrap_err().code(),
        "not-found"
    );
    assert_eq!(store.trash("missing").unwrap_err().code(), "not-found");
    assert_eq!(store.restore("missing").unwrap_err().code(), "not-found");
    assert_eq!(store.purge("missing").unwrap_err().code(), "not-found");
    assert_eq!(
        store.remove_cover("missing").unwrap_err().code(),
        "not-found"
    );
    assert_eq!(
        store
            .remove_format("missing", FormatId::Epub)
            .unwrap_err()
            .code(),
        "not-found"
    );
}
