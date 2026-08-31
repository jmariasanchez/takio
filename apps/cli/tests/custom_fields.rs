use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use rusqlite::Connection;
use serde_json::Value;

fn add_book(database: &std::path::Path, source: &std::path::Path) -> String {
    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(database)
        .args(["--source-path"])
        .arg(source)
        .output()
        .expect("add item");
    assert!(added.status.success());
    success_value(&added.stdout)["item"]["id"]
        .as_str()
        .expect("item id")
        .to_owned()
}

fn success_value(output: &[u8]) -> Value {
    let envelope: Value = serde_json::from_slice(output).expect("valid JSON response");
    assert_eq!(envelope["ok"], true);
    envelope["value"].clone()
}

fn failure_code(output: &[u8]) -> String {
    let envelope: Value = serde_json::from_slice(output).expect("valid JSON response");
    assert_eq!(envelope["ok"], false);
    envelope["error"]["code"]
        .as_str()
        .expect("error code")
        .to_owned()
}

#[test]
fn library_defined_text_columns_crud_preserves_values() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("book.txt");
    fs::write(&source, "book").expect("write source");
    let id = add_book(&database, &source);
    let patch = serde_json::json!({"customMetadata":{"shelf":"north"}});
    let updated = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args(["--id", &id, "--patch-json", &patch.to_string()])
        .output()
        .expect("set value");
    assert!(
        updated.status.success(),
        "{}",
        String::from_utf8_lossy(&updated.stdout)
    );

    let created = cargo_bin_cmd!("takio")
        .args(["library", "custom-columns", "create", "--db"])
        .arg(&database)
        .args(["--key", "shelf", "--label", " Shelf "])
        .output()
        .expect("create definition");
    assert!(created.status.success());
    assert!(created.stderr.is_empty());
    assert_eq!(
        success_value(&created.stdout)["definition"],
        serde_json::json!({"key":"shelf","label":"Shelf","type":"text","position":0})
    );

    let renamed = cargo_bin_cmd!("takio")
        .args(["library", "custom-columns", "rename", "--db"])
        .arg(&database)
        .args(["--key", "shelf", "--label", "Book Shelf"])
        .output()
        .expect("rename definition");
    assert!(renamed.status.success());

    let removed = cargo_bin_cmd!("takio")
        .args(["library", "custom-columns", "remove", "--db"])
        .arg(&database)
        .args(["--key", "shelf"])
        .output()
        .expect("remove definition");
    assert!(removed.status.success());

    let item = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("get item");
    assert_eq!(
        success_value(&item.stdout)["item"]["customMetadata"]["shelf"],
        "north"
    );

    for key in ["Shelf", "takio_metadata_audit", "1shelf"] {
        let invalid = cargo_bin_cmd!("takio")
            .args(["library", "custom-columns", "create", "--db"])
            .arg(&database)
            .args(["--key", key, "--label", "Invalid"])
            .output()
            .expect("reject invalid definition");
        assert!(!invalid.status.success());
        assert_eq!(failure_code(&invalid.stdout), "invalid-arguments");
    }
}

#[test]
fn custom_lookup_fields_and_literals_are_safe_composable_and_read_only() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    for (file, title, shelf) in [
        ("earthsea.txt", "Classic Earthsea", "Favorite Classics"),
        ("kindred.txt", "Classic Kindred", "Archive"),
    ] {
        let source = temp.path().join(file);
        fs::write(&source, file).expect("write source");
        let id = add_book(&database, &source);
        let patch = serde_json::json!({"title":title,"customMetadata":{"shelf":shelf}});
        let updated = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", &id, "--patch-json", &patch.to_string()])
            .output()
            .expect("set custom metadata");
        assert!(updated.status.success());
    }
    let connection = Connection::open(&database).expect("open database");
    let earthsea_id: String = connection
        .query_row(
            "SELECT id FROM library_items WHERE title='Classic Earthsea'",
            [],
            |row| row.get(0),
        )
        .expect("earthsea id");
    connection
        .execute(
            "INSERT INTO library_item_custom_metadata(library_item_id,name,value) VALUES(?1,'takio_metadata_audit','hidden provenance')",
            [&earthsea_id],
        )
        .expect("add reserved audit fixture");
    let before: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_item_custom_metadata",
            [],
            |row| row.get(0),
        )
        .expect("metadata count");
    drop(connection);

    let definition = serde_json::json!({
        "id":"favorites","name":"Favorites","definition":{
            "version":1,"querySyntax":"structured-v1","query":"#shelf:favorite",
            "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"}
        }
    });
    let saved = cargo_bin_cmd!("takio")
        .args(["library", "virtual-libraries", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &definition.to_string()])
        .output()
        .expect("save custom field virtual library");
    assert!(saved.status.success());
    assert!(saved.stderr.is_empty());

    let request = serde_json::json!({
        "virtualLibraryId":"favorites","querySyntax":"structured-v1",
        "query":"not title:Kindred","filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
        "sort":{"field":"title","direction":"ascending"},"page":{"offset":0,"limit":25}
    });
    let queried = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("compose custom field query");
    assert!(queried.status.success());
    assert!(queried.stderr.is_empty());
    let page = success_value(&queried.stdout);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["title"], "Classic Earthsea");

    for (literal, expected) in [("shelf", 2), ("classics", 1), ("provenance", 0)] {
        let request = serde_json::json!({
            "query":literal,"filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"},"page":{"offset":0,"limit":25}
        });
        let output = cargo_bin_cmd!("takio")
            .args(["library", "query", "--db"])
            .arg(&database)
            .args(["--request-json", &request.to_string()])
            .output()
            .expect("query custom metadata literally");
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(success_value(&output.stdout)["total"], expected);
    }

    for invalid in [
        "#Bad:value",
        "#bad-key:value",
        "#takio_metadata_audit:value",
    ] {
        let request = serde_json::json!({
            "querySyntax":"structured-v1","query":invalid,
            "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"},"page":{"offset":0,"limit":25}
        });
        let output = cargo_bin_cmd!("takio")
            .args(["library", "query", "--db"])
            .arg(&database)
            .args(["--request-json", &request.to_string()])
            .output()
            .expect("reject unsafe custom field");
        assert!(!output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(failure_code(&output.stdout), "invalid-query");
    }

    let connection = Connection::open(&database).expect("reopen database");
    let after: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM library_item_custom_metadata",
            [],
            |row| row.get(0),
        )
        .expect("metadata count after queries");
    assert_eq!(after, before);
}
