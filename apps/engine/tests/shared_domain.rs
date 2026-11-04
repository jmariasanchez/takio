use std::fs;

use takio::library::paths::LibraryPaths;
use takio::library::store::LibraryStore;

#[test]
fn typed_patch_preserves_sparse_wire_shape_and_explicit_nulls() {
    use serde_json::json;
    use takio::library::model::LibraryPatch;
    assert_eq!(
        serde_json::to_value(LibraryPatch::default()).unwrap(),
        json!({})
    );
    let wire = json!({
        "title":"Title", "author":null, "authors":[{"name":"Writer"}],
        "series":"Series", "seriesIndex":1.5, "publisher":"Publisher",
        "languages":["en"], "identifiers":{"isbn":"123"},
        "customMetadata":{"key":"value"}, "publishedDate":"2026-01-01",
        "rating":8.0, "description":"Details", "tags":["fiction"]
    });
    let patch: LibraryPatch = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&patch).unwrap(), wire);
    let mut expected = wire
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(patch.field_names(), expected);
    for field in patch.field_names() {
        let mut selected = patch.clone();
        selected.retain_fields(&[field.clone()].into_iter().collect());
        assert_eq!(selected.field_names(), vec![field.clone()]);
        let actual = serde_json::to_value(selected).unwrap();
        assert_eq!(actual.as_object().unwrap().len(), 1);
        assert_eq!(actual[&field], wire[&field]);
    }
}

#[test]
fn candidate_closed_sets_preserve_wire_spellings() {
    use takio::library::metadata_candidates::{
        CandidateBackend, CandidateConfidence, CandidateSource,
    };
    for value in [
        CandidateSource::Filename,
        CandidateSource::Embedded,
        CandidateSource::Online,
    ] {
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(json, value.as_str());
        assert_eq!(
            serde_json::from_value::<CandidateSource>(json).unwrap(),
            value
        );
    }
    for value in [
        CandidateConfidence::Low,
        CandidateConfidence::Medium,
        CandidateConfidence::High,
    ] {
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(json, value.as_str());
        assert_eq!(
            serde_json::from_value::<CandidateConfidence>(json).unwrap(),
            value
        );
    }
    for value in [
        CandidateBackend::EbookMeta,
        CandidateBackend::FetchEbookMetadata,
    ] {
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(json, value.as_str());
        assert_eq!(
            serde_json::from_value::<CandidateBackend>(json).unwrap(),
            value
        );
    }
    assert!(serde_json::from_str::<CandidateSource>("\"unknown\"").is_err());
    assert!(serde_json::from_str::<CandidateConfidence>("\"unknown\"").is_err());
    assert!(serde_json::from_str::<CandidateBackend>("\"unknown\"").is_err());
}

#[test]
fn typed_metadata_candidate_applies_only_reviewed_fields() {
    use std::collections::BTreeSet;
    use takio::library::metadata_candidates::{
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
    assert_eq!(candidate.source.as_str(), "filename");
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
