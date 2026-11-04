use serde_json::json;

#[test]
fn per_item_error_codes_keep_exact_wire_shapes() {
    use takio::error::ErrorCode;
    use takio::import::calibre::{CalibreImportReport, CalibreImportWarning};
    use takio::import::scan::{ImportCounts, ImportOutcome};
    use takio::library::export::ExportStatus;
    use takio::library::metadata_reconcile::ReconcileOutcome;
    for &code in ErrorCode::ALL {
        assert_eq!(
            serde_json::to_value(ExportStatus::Failed { code }).unwrap(),
            json!({"status":"failed", "code":code.as_str()})
        );
        assert_eq!(
            serde_json::to_value(ReconcileOutcome::Failed {
                item_id: "book-1".into(),
                code
            })
            .unwrap(),
            json!({"status":"failed", "itemId":"book-1", "code":code.as_str()})
        );
        let outcomes = vec![ImportOutcome::Failed {
            source_path: "book.epub".into(),
            code,
        }];
        let report = CalibreImportReport {
            counts: ImportCounts::from_outcomes(&outcomes),
            outcomes,
            warnings: vec![CalibreImportWarning::CustomColumn {
                key: "custom".into(),
                code,
            }],
        };
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            json!({
                "outcomes":[{"status":"failed", "sourcePath":"book.epub", "code":code.as_str()}],
                "warnings":[{"kind":"custom-column", "key":"custom", "code":code.as_str()}],
                "counts":{"total":1,"imported":0,"skipped":0,"duplicates":0,"failed":1}
            })
        );
    }
    assert_eq!(
        serde_json::to_value(ExportStatus::Skipped {
            reason: ErrorCode::DestinationExists
        })
        .unwrap(),
        json!({"status":"skipped", "reason":"destination-exists"})
    );
}
use takio::conversion::ConversionProfile;
use takio::delivery::destinations::{DestinationFeature, InventoryStatus, OverwritePolicy};
use takio::delivery::reader_shelf::{ShelfEntry, ShelfMatchSource};
use takio::library::model::ImportMode;

#[test]
fn patch_value_borrows_without_changing_presence_or_wire_value() {
    use takio::library::model::Patch;
    let patch = Patch::Set(String::from("Reviewed title"));
    assert_eq!(patch.value().map(String::as_str), Some("Reviewed title"));
    assert_eq!(
        serde_json::to_value(&patch).unwrap(),
        json!("Reviewed title")
    );
    assert_eq!(patch.into_set(), Some(String::from("Reviewed title")));
    assert!(Patch::<String>::Missing.value().is_none());
    assert!(Patch::<String>::Null.value().is_none());
}

#[test]
fn conversion_profiles_keep_wire_names_and_reject_unknown_values() {
    for (profile, name) in [
        (ConversionProfile::Default, "default"),
        (ConversionProfile::GenericEink, "generic_eink"),
        (ConversionProfile::Kindle, "kindle"),
        (ConversionProfile::Kobo, "kobo"),
    ] {
        assert_eq!(serde_json::to_value(profile).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<ConversionProfile>(json!(name)).unwrap(),
            profile
        );
        assert_eq!(name.parse::<ConversionProfile>().unwrap(), profile);
    }
    assert!(serde_json::from_value::<ConversionProfile>(json!("typo")).is_err());
    assert_eq!(
        "typo".parse::<ConversionProfile>().unwrap_err().code(),
        "invalid-arguments"
    );
}

#[test]
fn destination_inventory_and_features_keep_wire_names() {
    for (status, name) in [
        (InventoryStatus::Missing, "missing"),
        (InventoryStatus::Present, "present"),
        (InventoryStatus::Changed, "changed"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<InventoryStatus>(json!(name)).unwrap(),
            status
        );
    }
    assert_eq!(
        serde_json::to_value(vec![DestinationFeature::Koreader]).unwrap(),
        json!(["koreader"])
    );
    assert_eq!(
        serde_json::from_value::<DestinationFeature>(json!("koreader")).unwrap(),
        DestinationFeature::Koreader
    );
    assert!(serde_json::from_value::<InventoryStatus>(json!("typo")).is_err());
    assert!(serde_json::from_value::<DestinationFeature>(json!("typo")).is_err());
}

#[test]
fn shelf_match_sources_keep_wire_names_and_optional_field() {
    for (source, name) in [
        (ShelfMatchSource::Content, "content"),
        (ShelfMatchSource::DeliveryRecord, "delivery-record"),
    ] {
        let mut entry = ShelfEntry {
            path: "documents/book.epub".into(),
            bytes: 12,
            item_id: Some("book".into()),
            title: Some("Book".into()),
            matched_by: Some(source),
            reading: None,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({
                "path": "documents/book.epub", "bytes": 12,
                "itemId": "book", "title": "Book", "matchedBy": name
            })
        );
        assert_eq!(
            serde_json::from_value::<ShelfMatchSource>(json!(name)).unwrap(),
            source
        );
        entry.matched_by = None;
        assert!(
            serde_json::to_value(entry)
                .unwrap()
                .get("matchedBy")
                .is_none()
        );
    }
}

#[test]
fn safety_policy_defaults_preserve_originals_and_existing_files() {
    assert_eq!(ImportMode::default(), ImportMode::Copy);
    assert_eq!(OverwritePolicy::default(), OverwritePolicy::Refuse);
    assert_eq!(
        serde_json::to_value(ImportMode::Copy).unwrap(),
        json!("copy")
    );
    assert_eq!(
        serde_json::to_value(ImportMode::Move).unwrap(),
        json!("move")
    );
}
