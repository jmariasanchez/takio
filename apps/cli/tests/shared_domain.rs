use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};
use takio::library_query::Facets;
use takio::model::{BookAuthor, LibraryPatch, Patch};
use takio::paths::LibraryPaths;
use takio::store::LibraryStore;

#[test]
fn cli_query_and_native_facets_share_mixed_author_counts() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("library/library.sqlite");
    let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
    let mut store = LibraryStore::open(paths, true).unwrap();
    for (index, structured) in [false, true].into_iter().enumerate() {
        let source = temp.path().join(format!("source-{index}.txt"));
        fs::write(&source, format!("book {index}")).unwrap();
        let item = store.import(&source, None, false).unwrap();
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
