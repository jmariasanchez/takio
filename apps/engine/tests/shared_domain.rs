use std::fs;

use takio::library::paths::LibraryPaths;
use takio::library::store::LibraryStore;

#[test]
fn typed_metadata_candidate_applies_only_reviewed_fields() {
    use std::collections::BTreeSet;
    use takio::metadata::candidates::{
        CandidateSelection, apply_prepared_metadata_candidate, filename_candidates,
        prepare_metadata_candidate,
    };
    let temp = tempfile::tempdir().unwrap();
    let paths =
        LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("Writer - Suggested Title.txt");
    fs::write(&source, b"original bytes").unwrap();
    let item = store
        .import(
            &source,
            Some("Original Title"),
            takio::library::model::ImportMode::Copy,
        )
        .unwrap();
    let candidate = filename_candidates(&source, Some(&item.id), &[])
        .unwrap()
        .remove(0);
    assert_eq!(candidate.source, "filename");
    assert!(candidate.provenance.pattern.is_some());
    assert!(candidate.cover.is_none());
    assert_eq!(
        prepare_metadata_candidate(
            candidate.clone(),
            "different-item",
            CandidateSelection::default(),
            "test"
        )
        .err()
        .unwrap()
        .code(),
        "invalid-arguments"
    );
    let fields = BTreeSet::from(["title".to_owned()]);
    let prepared = prepare_metadata_candidate(
        candidate,
        &item.id,
        CandidateSelection {
            fields: Some(&fields),
            include_cover: false,
        },
        "typed-review",
    )
    .unwrap();
    let updated = apply_prepared_metadata_candidate(&mut store, &item.id, &prepared).unwrap();
    assert_eq!(updated.title, "Suggested Title");
    assert_eq!(updated.author, item.author);
    assert_eq!(fs::read(source).unwrap(), b"original bytes");
}
