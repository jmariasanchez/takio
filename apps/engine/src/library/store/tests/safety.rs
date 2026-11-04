use super::*;

#[test]
fn cover_mutations_report_preserved_orphans_after_commit() {
    for replace in [false, true] {
        let (temp, mut store, item) = fixture();
        let cover = temp.path().join("cover.jpg");
        fs::write(&cover, b"cover bytes").unwrap();
        let old = store
            .set_cover(&item.id, &cover)
            .unwrap()
            .item
            .cover_path
            .unwrap();
        fs::remove_file(&old).unwrap();
        fs::create_dir(&old).unwrap();
        let result = if replace {
            store.set_cover(&item.id, &cover)
        } else {
            store.remove_cover(&item.id)
        }
        .unwrap();
        assert!(result.cleanup_pending);
        assert_eq!(result.cleanup_pending_paths, vec![old.clone()]);
        assert!(old.is_dir());
        let committed = store.get(&item.id).unwrap().unwrap();
        assert_eq!(committed.cover_path, result.item.cover_path);
        assert_ne!(committed.cover_path, Some(old));
    }
}

#[test]
fn stored_format_provenance_rejects_unknown_values() {
    let (_temp, store, item) = fixture();
    for provenance in [Provenance::Managed, Provenance::Referenced] {
        assert_eq!(
            provenance.as_str().parse::<Provenance>().unwrap(),
            provenance
        );
    }
    store
        .connection
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    store
        .connection
        .execute("UPDATE library_item_formats SET provenance='unknown'", [])
        .unwrap();
    assert_eq!(
        read_stored_format(&store.connection, &item.id, item.formats[0].format)
            .err()
            .unwrap()
            .code(),
        "invalid-stored-data"
    );
    assert_eq!(
        store.get(&item.id).unwrap_err().code(),
        "invalid-stored-data"
    );
}

#[test]
fn watch_outcome_wire_values_match_persisted_labels() {
    let (_temp, mut store, item) = fixture();
    let source = &item.formats[0].source_path;
    let fingerprint = hash_file(source).unwrap();
    for (outcome, label) in [
        (ImportWatchOutcome::Imported, "imported"),
        (ImportWatchOutcome::Duplicate, "duplicate"),
        (ImportWatchOutcome::Unsupported, "unsupported"),
        (ImportWatchOutcome::Failed, "failed"),
    ] {
        let wire = serde_json::json!(label);
        assert_eq!(serde_json::to_value(outcome).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<ImportWatchOutcome>(wire).unwrap(),
            outcome
        );
        store
            .record_import_watch_observation(ImportWatchObservation {
                canonical_source_path: source.clone(),
                fingerprint: fingerprint.clone(),
                outcome,
            })
            .unwrap();
        let stored: String = store
            .connection
            .query_row(
                "SELECT outcome FROM import_watch_observations WHERE canonical_source_path=?1",
                [source.to_string_lossy()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, label);
    }
    assert!(serde_json::from_value::<ImportWatchOutcome>(serde_json::json!("typo")).is_err());
}

#[test]
fn duplicate_disposition_keeps_wire_values_and_rejects_unknowns() {
    for (disposition, label) in [
        (DuplicateDisposition::Unreviewed, "unreviewed"),
        (DuplicateDisposition::KeptBoth, "kept-both"),
    ] {
        let wire = serde_json::json!(label);
        assert_eq!(serde_json::to_value(disposition).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<DuplicateDisposition>(wire).unwrap(),
            disposition
        );
    }
    assert!(
        serde_json::from_value::<ListDuplicateCandidatesRequest>(
            serde_json::json!({"page":{"limit":10,"offset":0},"disposition":"typo"})
        )
        .is_err()
    );
}

#[test]
fn merge_request_deserializes_typed_metadata_and_rejects_unknown_fields() {
    let base = serde_json::json!({
        "targetId":"target", "sourceId":"source", "reviewToken":"a".repeat(64),
        "metadata":{"title":"Merged"}, "addSourceFormats":[], "cover":"none"
    });
    let parsed: MergeDuplicatePairRequest = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(
        parsed.metadata.title.value().map(String::as_str),
        Some("Merged")
    );
    for metadata in [
        serde_json::json!({"unknown":true}),
        serde_json::json!({"title":3}),
        serde_json::json!(null),
    ] {
        let mut invalid = base.clone();
        invalid["metadata"] = metadata;
        assert!(serde_json::from_value::<MergeDuplicatePairRequest>(invalid).is_err());
    }
}

#[test]
fn active_item_lookup_distinguishes_absent_and_trashed_books() {
    let (_temp, mut store, item) = fixture();
    assert_eq!(store.get_active(&item.id).unwrap().id, item.id);
    assert_eq!(store.get_active("missing").unwrap_err().code(), "not-found");
    assert_eq!(
        store.get_active("").unwrap_err().code(),
        "invalid-arguments"
    );
    store.trash(&item.id).unwrap();
    assert_eq!(
        store.get_active(&item.id).unwrap_err().code(),
        "item-trashed"
    );
    assert!(store.get(&item.id).unwrap().is_some());
    store.restore(&item.id).unwrap();
    assert_eq!(store.get_active(&item.id).unwrap().id, item.id);
}

fn fixture() -> (tempfile::TempDir, LibraryStore, LibraryItem) {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("book.epub");
    fs::write(&source, b"original book").unwrap();
    let item = store.import(&source, None, ImportMode::Copy).unwrap();
    (temp, store, item)
}

#[test]
fn import_refuses_sources_inside_library_owned_paths() {
    let (_temp, mut store, item) = fixture();
    let item_dir = item.formats[0].source_path.parent().unwrap().to_path_buf();
    let stray = item_dir.join("stray.epub");
    fs::write(&stray, b"unrelated bytes inside an owned directory").unwrap();
    for mode in [ImportMode::Copy, ImportMode::Move] {
        assert_eq!(
            store
                .import_with_outcome(&stray, None, mode)
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        assert_eq!(
            fs::read(&stray).unwrap(),
            b"unrelated bytes inside an owned directory"
        );
        assert_eq!(store.list(true).unwrap().len(), 1);
    }
}

#[test]
fn duplicate_import_explicitly_preserves_copy_and_move_sources() {
    let (temp, mut store, item) = fixture();
    let source = temp.path().join("duplicate.epub");
    fs::write(&source, b"original book").unwrap();
    for mode in [ImportMode::Copy, ImportMode::Move] {
        let outcome = store.import_with_outcome(&source, None, mode).unwrap();
        assert_eq!(outcome.status, ImportStatus::Duplicate);
        assert_eq!(outcome.item.id, item.id);
        assert!(outcome.source_preserved);
        assert_eq!(
            store.import(&source, None, mode).unwrap_err().code(),
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
    let item = store
        .attach_format(&item.id, &pdf, Provenance::Managed)
        .unwrap();
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
    store
        .attach_format(&item.id, &pdf, Provenance::Managed)
        .unwrap();
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
        .replace_format(
            &item.id,
            FormatId::Epub,
            &expected,
            &replacement,
            Provenance::Managed,
        )
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
        store
            .attach_format(&item.id, &pdf, Provenance::Managed)
            .unwrap();
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
                    Provenance::Managed,
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
fn trash_preserves_files_and_purge_requires_trash() {
    let (_temp, mut store, item) = fixture();
    assert_eq!(store.purge(&item.id).unwrap_err().code(), "not-trashed");
    assert!(item.formats[0].source_path.exists());
    assert_eq!(store.trash(&item.id).unwrap().id, item.id);
    assert!(item.formats[0].source_path.exists());
    assert_eq!(store.list_trash().unwrap()[0].id, item.id);
    store.trash(&item.id).unwrap();
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
        let item = store.set_cover(&item.id, &cover).unwrap().item;
        let shared = item.cover_path.unwrap();
        let source = temp.path().join("other.epub");
        fs::write(&source, b"other book").unwrap();
        let other = store.import(&source, None, ImportMode::Copy).unwrap();
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
    let (_temp, mut store, _item) = fixture();
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
    assert_eq!(store.remove_view("good").unwrap().id, "good");
    assert!(store.saved_view("good").unwrap().is_none());
}

#[test]
fn scalar_author_is_always_derived_when_structured_authors_are_patched() {
    let (_temp, mut store, item) = fixture();
    let updated = store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({
                "author": "Ignored scalar",
                "authors": [{"name": "Ada"}, {"name": "Grace"}]
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(updated.author.as_deref(), Some("Ada, Grace"));
    let stored = store.get(&item.id).unwrap().unwrap();
    assert_eq!(stored.author.as_deref(), Some("Ada, Grace"));
    assert_eq!(
        stored.author,
        crate::library::model::derived_display_author(&stored.authors)
    );
}

#[test]
fn scalar_author_patch_updates_structured_authors_so_they_cannot_diverge() {
    let (_temp, mut store, item) = fixture();
    store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({"authors":[{"name":"Alice"}]})).unwrap(),
        )
        .unwrap();
    let updated = store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({"author":" Carol "})).unwrap(),
        )
        .unwrap();
    assert_eq!(updated.author.as_deref(), Some("Carol"));
    assert_eq!(
        updated
            .authors
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["Carol"]
    );
    assert_eq!(updated.primary_author(), Some("Carol"));
    let stored = store.get(&item.id).unwrap().unwrap();
    assert_eq!(stored.author, updated.author);
    assert_eq!(stored.authors.len(), 1);
    let cleared = store
        .update(
            &item.id,
            serde_json::from_value(serde_json::json!({"author":null})).unwrap(),
        )
        .unwrap();
    assert!(cleared.author.is_none());
    assert!(cleared.authors.is_empty());
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
                Provenance::Managed,
            )
            .unwrap_err()
            .code(),
        "not-found"
    );
    assert_eq!(store.trash("missing").unwrap_err().code(), "not-found");
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
