use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};
use takio::library::model::{BookAuthor, LibraryPatch, Patch};
use takio::library::paths::LibraryPaths;
use takio::library::query::Facets;
use takio::library::store::LibraryStore;

#[test]
fn cli_send_rejects_trash_and_matches_shared_preview_choice() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("library/library.sqlite");
    let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("book.azw3");
    fs::write(&source, b"compatible fixture").unwrap();
    let item = store
        .import(
            &source,
            Some("Title"),
            takio::library::model::ImportMode::Copy,
        )
        .unwrap();
    let volumes = temp.path().join("Volumes");
    let reader = volumes.join("Kindle");
    fs::create_dir_all(reader.join("documents")).unwrap();
    fs::create_dir_all(reader.join("system")).unwrap();
    let destination = takio::delivery::destinations::resolve(&reader, &volumes).unwrap();
    let plan = takio::delivery::plan_send(&store, &destination, &item.id, None).unwrap();
    let send = || {
        cargo_bin_cmd!("takio")
            .args(["send", "--db"])
            .arg(&database)
            .args(["--id", &item.id, "--dest"])
            .arg(&reader)
            .arg("--volumes-root")
            .arg(&volumes)
            .output()
            .unwrap()
    };
    store.trash(&item.id).unwrap();
    let refused = send();
    assert!(!refused.status.success());
    let error: Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert_eq!(error["error"]["code"], "item-trashed");
    assert_eq!(fs::read_dir(reader.join("documents")).unwrap().count(), 0);
    store.restore(&item.id).unwrap();
    let sent = send();
    assert!(
        sent.status.success(),
        "{}",
        String::from_utf8_lossy(&sent.stdout)
    );
    let result: Value = serde_json::from_slice(&sent.stdout).unwrap();
    let path = std::path::Path::new(result["value"]["path"].as_str().unwrap());
    assert_eq!(path.file_name().unwrap().to_str().unwrap(), plan.file_name);
    assert_eq!(
        fs::read(path).unwrap(),
        fs::read(plan.ready.source_path).unwrap()
    );
}

#[test]
fn cli_and_shared_plan_reject_automatic_unknown_reader_format() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("library/library.sqlite");
    let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("book.epub");
    fs::write(&source, b"epub fixture").unwrap();
    let item = store
        .import(&source, None, takio::library::model::ImportMode::Copy)
        .unwrap();
    let volumes = temp.path().join("Volumes");
    let reader = volumes.join("Unknown");
    fs::create_dir_all(&reader).unwrap();
    let destination = takio::delivery::destinations::resolve(&reader, &volumes).unwrap();
    assert_eq!(
        takio::delivery::plan_send(&store, &destination, &item.id, None)
            .unwrap_err()
            .code(),
        "no-compatible-format"
    );
    let output = cargo_bin_cmd!("takio")
        .args(["send", "--db"])
        .arg(database)
        .args(["--id", &item.id, "--dest"])
        .arg(&reader)
        .arg("--volumes-root")
        .arg(volumes)
        .output()
        .unwrap();
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "no-compatible-format");
    assert_eq!(fs::read_dir(reader).unwrap().count(), 0);
}

#[test]
fn cli_query_and_native_facets_share_mixed_author_counts() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("library/library.sqlite");
    let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    for (index, structured) in [false, true].into_iter().enumerate() {
        let source = temp.path().join(format!("source-{index}.txt"));
        fs::write(&source, format!("book {index}")).unwrap();
        let item = store
            .import(&source, None, takio::library::model::ImportMode::Copy)
            .unwrap();
        let patch = if structured {
            LibraryPatch {
                authors: Patch::Set(vec![BookAuthor {
                    name: "Shared author".into(),
                    sort_name: None,
                }]),
                ..Default::default()
            }
        } else {
            LibraryPatch {
                author: Patch::Set("Shared author".into()),
                ..Default::default()
            }
        };
        store.update(&item.id, patch).unwrap();
    }
    let items = store.list(false).unwrap();
    let native_facets = Facets::from_items(&items);
    assert_eq!(native_facets.authors.get("Shared author"), Some(&2));
    let request = json!({"query":"", "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]}, "sort":{"field":"title","direction":"ascending"}, "page":{"offset":0,"limit":25}});
    let output = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        envelope["value"]["facets"],
        serde_json::to_value(native_facets).unwrap()
    );
    assert_eq!(envelope["value"]["total"], 2);
}

#[test]
fn cli_query_does_not_rewrite_unicode_filter_values() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("library/library.sqlite");
    let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
    let mut store = LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("book.txt");
    fs::write(&source, b"book").unwrap();
    let item = store
        .import(&source, None, takio::library::model::ImportMode::Copy)
        .unwrap();
    let author = "\u{00c5}uthor";
    store
        .update(
            &item.id,
            LibraryPatch {
                author: Patch::Set(author.into()),
                ..Default::default()
            },
        )
        .unwrap();
    let filters = takio::library::query::Filters {
        authors: vec![author.into()],
        ..Default::default()
    };
    let native = store.query_items_shared("", &filters).unwrap();
    assert_eq!(native.len(), 1);
    let request = json!({"query":"", "filters":filters, "sort":{"field":"title","direction":"ascending"}, "page":{"offset":0,"limit":25}});
    let output = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["value"]["items"][0]["id"], native[0].id);
}
