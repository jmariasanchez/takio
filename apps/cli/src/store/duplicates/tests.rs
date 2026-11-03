use super::scan::MAX_SAFE_INTEGER;
use super::*;
use crate::model::{BookAuthor, LibraryPatch, Patch};
use crate::paths::LibraryPaths;
use std::collections::BTreeMap;

#[test]
fn duplicate_reviews_are_stable_idempotent_and_reject_stale_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let left_path = temp.path().join("left.epub");
    let right_path = temp.path().join("right.pdf");
    fs::write(&left_path, b"left duplicate bytes").unwrap();
    fs::write(&right_path, b"right duplicate bytes").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let left = store.import(&left_path, Some("Dune"), false).unwrap();
    let right = store.import(&right_path, Some(" dune "), false).unwrap();
    for id in [&left.id, &right.id] {
        store
            .update(
                id,
                LibraryPatch {
                    authors: Patch::Set(vec![BookAuthor {
                        name: "Frank Herbert".to_owned(),
                        sort_name: None,
                    }]),
                    identifiers: Patch::Set(BTreeMap::from([(
                        "ISBN".to_owned(),
                        "9780441172719".to_owned(),
                    )])),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let request = ListDuplicateCandidatesRequest {
        page: DuplicatePageRequest {
            limit: 1,
            offset: 0,
        },
        disposition: "unreviewed".to_owned(),
    };
    let first = store.list_duplicate_candidates(&request).unwrap();
    let second = store.list_duplicate_candidates(&request).unwrap();
    assert_eq!(first.total, 1);
    assert_eq!(first.scan.fingerprints_reused, 2);
    assert_eq!(
        first.candidates[0].review_token,
        second.candidates[0].review_token
    );
    assert_eq!(first.candidates[0].signals.len(), 2);
    let candidate = &first.candidates[0];
    let review = DuplicatePairReviewRequest {
        left_id: candidate.left.id.clone(),
        right_id: candidate.right.id.clone(),
        review_token: candidate.review_token.clone(),
    };
    store.keep_duplicate_pair(&review).unwrap();
    store.keep_duplicate_pair(&review).unwrap();
    assert_eq!(store.list_duplicate_candidates(&request).unwrap().total, 0);
    store.reopen_duplicate_pair(&review).unwrap();
    assert_eq!(store.list_duplicate_candidates(&request).unwrap().total, 1);
    store
        .update(
            &right.id,
            LibraryPatch {
                title: Patch::Set("Dune revised".to_owned()),
                ..LibraryPatch::default()
            },
        )
        .unwrap();
    assert_eq!(
        store.keep_duplicate_pair(&review).unwrap_err().code(),
        "stale-review"
    );
}

#[test]
fn duplicate_merge_rolls_back_and_purge_preserves_transferred_owned_files() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let target_path = temp.path().join("target.epub");
    let source_path = temp.path().join("source.mobi");
    let source_pdf = temp.path().join("source.pdf");
    let target_cover = temp.path().join("target.jpg");
    let source_cover = temp.path().join("source.jpg");
    fs::write(&target_path, b"target").unwrap();
    fs::write(&source_path, b"source").unwrap();
    fs::write(&source_pdf, b"transferred pdf").unwrap();
    fs::write(&target_cover, b"target cover").unwrap();
    fs::write(&source_cover, b"source cover").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let target = store.import(&target_path, Some("Target"), false).unwrap();
    let source = store.import(&source_path, Some("Source"), false).unwrap();
    for id in [&target.id, &source.id] {
        store
            .update(
                id,
                LibraryPatch {
                    identifiers: Patch::Set(BTreeMap::from([(
                        "isbn".to_owned(),
                        "shared".to_owned(),
                    )])),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let source = store.attach_format(&source.id, &source_pdf, true).unwrap();
    store.set_cover(&target.id, &target_cover).unwrap();
    let source = store.set_cover(&source.id, &source_cover).unwrap();
    let transferred_pdf = source
        .formats
        .iter()
        .find(|format| format.format == FormatId::Pdf)
        .unwrap()
        .source_path
        .clone();
    let transferred_cover = source.cover_path.clone().unwrap();
    let page = store
        .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 100,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        })
        .unwrap();
    let token = page.candidates[0].review_token.clone();
    let merge = MergeDuplicatePairRequest {
        target_id: target.id.clone(),
        source_id: source.id.clone(),
        review_token: token.clone(),
        metadata: serde_json::json!({"title":"Merged","tags":["reviewed"]}),
        add_source_formats: vec![FormatId::Pdf],
        cover: "source".to_owned(),
    };
    store
        .connection
        .execute_batch(
            "CREATE TRIGGER reject_duplicate_merge BEFORE UPDATE OF trashed_at ON library_items
             WHEN NEW.id IS NOT NULL BEGIN SELECT RAISE(FAIL, 'rollback'); END;",
        )
        .unwrap();
    assert_eq!(
        store.merge_duplicate_pair(&merge).unwrap_err().code(),
        "storage-unavailable"
    );
    assert_eq!(store.get(&target.id).unwrap().unwrap().formats.len(), 1);
    store
        .connection
        .execute_batch("DROP TRIGGER reject_duplicate_merge")
        .unwrap();
    let merged = store.merge_duplicate_pair(&merge).unwrap();
    assert_eq!(merged.target.title, "Merged");
    assert_eq!(merged.target.formats.len(), 2);
    assert_eq!(merged.trashed_source.id, source.id);
    assert!(!merged.cleanup_pending);
    store.purge(&source.id).unwrap();
    assert_eq!(fs::read(transferred_pdf).unwrap(), b"transferred pdf");
    assert_eq!(fs::read(transferred_cover).unwrap(), b"source cover");
}

#[test]
fn duplicate_merge_rolls_back_when_result_hydration_fails() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let target_path = temp.path().join("target.epub");
    let source_path = temp.path().join("source.pdf");
    fs::write(&target_path, b"target").unwrap();
    fs::write(&source_path, b"source").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let target = store.import(&target_path, Some("Target"), false).unwrap();
    let source = store.import(&source_path, Some("Source"), false).unwrap();
    for id in [&target.id, &source.id] {
        store
            .update(
                id,
                LibraryPatch {
                    identifiers: Patch::Set(BTreeMap::from([(
                        "isbn".to_owned(),
                        "shared".to_owned(),
                    )])),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let candidate = store
        .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 100,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        })
        .unwrap()
        .candidates
        .remove(0);
    store
        .connection
        .execute_batch(&format!(
            "CREATE TRIGGER delete_merged_source AFTER UPDATE OF trashed_at ON library_items
             WHEN NEW.id='{}' BEGIN DELETE FROM library_items WHERE id=NEW.id; END;",
            source.id
        ))
        .unwrap();
    let error = store
        .merge_duplicate_pair(&MergeDuplicatePairRequest {
            target_id: target.id.clone(),
            source_id: source.id.clone(),
            review_token: candidate.review_token,
            metadata: serde_json::json!({"title":"Merged"}),
            add_source_formats: vec![FormatId::Pdf],
            cover: "none".to_owned(),
        })
        .unwrap_err();
    assert_eq!(error.code(), "storage-unavailable");
    let unchanged = store.get(&target.id).unwrap().unwrap();
    assert_eq!(unchanged.title, "Target");
    assert_eq!(unchanged.formats.len(), 1);
    assert!(store.get(&source.id).unwrap().is_some());
}

#[test]
fn shared_merged_formats_survive_target_remove_and_replace() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let target_path = temp.path().join("target.epub");
    let source_path = temp.path().join("source.mobi");
    let source_pdf = temp.path().join("source.pdf");
    fs::write(&target_path, b"target").unwrap();
    fs::write(&source_path, b"source").unwrap();
    fs::write(&source_pdf, b"shared pdf").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let target = store.import(&target_path, Some("Target"), false).unwrap();
    let source = store.import(&source_path, Some("Source"), false).unwrap();
    for id in [&target.id, &source.id] {
        store
            .update(
                id,
                LibraryPatch {
                    identifiers: Patch::Set(BTreeMap::from([(
                        "isbn".to_owned(),
                        "shared".to_owned(),
                    )])),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let source = store.attach_format(&source.id, &source_pdf, true).unwrap();
    let shared_path = source
        .formats
        .iter()
        .find(|format| format.format == FormatId::Pdf)
        .unwrap()
        .source_path
        .clone();
    let request = ListDuplicateCandidatesRequest {
        page: DuplicatePageRequest {
            limit: 100,
            offset: 0,
        },
        disposition: "unreviewed".to_owned(),
    };
    let merge = |store: &mut LibraryStore| {
        let token = store
            .list_duplicate_candidates(&request)
            .unwrap()
            .candidates
            .remove(0)
            .review_token;
        store
            .merge_duplicate_pair(&MergeDuplicatePairRequest {
                target_id: target.id.clone(),
                source_id: source.id.clone(),
                review_token: token,
                metadata: serde_json::json!({"title":"Merged"}),
                add_source_formats: vec![FormatId::Pdf],
                cover: "none".to_owned(),
            })
            .unwrap();
    };
    merge(&mut store);
    store.remove_format(&target.id, FormatId::Pdf).unwrap();
    assert_eq!(fs::read(&shared_path).unwrap(), b"shared pdf");

    store.restore(&source.id).unwrap();
    merge(&mut store);
    let current = store
        .get(&target.id)
        .unwrap()
        .unwrap()
        .formats
        .into_iter()
        .find(|format| format.format == FormatId::Pdf)
        .unwrap();
    let replacement = temp.path().join("replacement.pdf");
    fs::write(&replacement, b"replacement").unwrap();
    store
        .replace_format(
            &target.id,
            FormatId::Pdf,
            &serde_json::json!({
                "sourcePath":current.source_path,
                "addedAt":current.added_at,
                "provenance":current.provenance
            }),
            &replacement,
            true,
        )
        .unwrap();
    assert_eq!(fs::read(shared_path).unwrap(), b"shared pdf");
}

#[test]
fn duplicate_signals_use_javascript_string_order_and_safe_numbers() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let left_path = temp.path().join("left.epub");
    let right_path = temp.path().join("right.pdf");
    fs::write(&left_path, b"left").unwrap();
    fs::write(&right_path, b"right").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let left = store.import(&left_path, Some("Left"), false).unwrap();
    let right = store.import(&right_path, Some("Right"), false).unwrap();
    let identifiers = BTreeMap::from([
        ("\u{1f600}".to_owned(), "shared-emoji".to_owned()),
        ("\u{e000}".to_owned(), "shared-private".to_owned()),
    ]);
    for id in [&left.id, &right.id] {
        store
            .update(
                id,
                LibraryPatch {
                    identifiers: Patch::Set(identifiers.clone()),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let page = store
        .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 100,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        })
        .unwrap();
    assert!(matches!(
        &page.candidates[0].signals[0],
        DuplicateSignal::SameIdentifier { scheme, .. } if scheme == "\u{1f600}"
    ));
    store
        .connection
        .execute(
            "UPDATE library_item_formats SET content_bytes=?2 WHERE library_item_id=?1",
            params![left.id, i64::try_from(MAX_SAFE_INTEGER + 1).unwrap()],
        )
        .unwrap();
    assert_eq!(
        store
            .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
                page: DuplicatePageRequest {
                    limit: 100,
                    offset: 0,
                },
                disposition: "unreviewed".to_owned(),
            })
            .unwrap_err()
            .code(),
        "invalid-stored-data"
    );
}

#[test]
fn duplicate_merge_rejects_empty_contract_arrays() {
    let temp = tempfile::tempdir().unwrap();
    let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
    let left_path = temp.path().join("left.epub");
    let right_path = temp.path().join("right.pdf");
    fs::write(&left_path, b"left").unwrap();
    fs::write(&right_path, b"right").unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    let left = store.import(&left_path, Some("Shared"), false).unwrap();
    let right = store.import(&right_path, Some("Shared"), false).unwrap();
    for id in [&left.id, &right.id] {
        store
            .update(
                id,
                LibraryPatch {
                    authors: Patch::Set(vec![BookAuthor {
                        name: "Author".to_owned(),
                        sort_name: None,
                    }]),
                    ..LibraryPatch::default()
                },
            )
            .unwrap();
    }
    let token = store
        .list_duplicate_candidates(&ListDuplicateCandidatesRequest {
            page: DuplicatePageRequest {
                limit: 100,
                offset: 0,
            },
            disposition: "unreviewed".to_owned(),
        })
        .unwrap()
        .candidates
        .remove(0)
        .review_token;
    for metadata in [
        serde_json::json!({"authors":[]}),
        serde_json::json!({"languages":[]}),
    ] {
        assert_eq!(
            store
                .merge_duplicate_pair(&MergeDuplicatePairRequest {
                    target_id: left.id.clone(),
                    source_id: right.id.clone(),
                    review_token: token.clone(),
                    metadata,
                    add_source_formats: vec![FormatId::Pdf],
                    cover: "none".to_owned(),
                })
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
    }
    assert_eq!(store.get(&left.id).unwrap().unwrap().formats.len(), 1);
    assert!(store.get(&right.id).unwrap().is_some());
}
