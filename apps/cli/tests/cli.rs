use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::Value;

fn success_value(output: &[u8]) -> Value {
    let envelope: Value = serde_json::from_slice(output).expect("valid JSON response");
    assert_eq!(envelope["ok"], true);
    envelope["value"].clone()
}

#[test]
fn capabilities_identify_the_native_tui() {
    let output = cargo_bin_cmd!("takio")
        .arg("capabilities")
        .output()
        .expect("run takio");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value = success_value(&output.stdout);
    assert_eq!(value["implementation"], "rust");
    assert_eq!(value["tui"], true);
    assert_eq!(value["librarySchemaVersion"], 10);
}

#[test]
fn import_list_and_search_round_trip_through_the_binary() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("the-dispossessed.epub");
    fs::write(&source, b"epub").expect("write source ebook");

    let imported = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .args(["--title", "The Dispossessed"])
        .output()
        .expect("import ebook");
    assert!(imported.status.success());
    let imported = success_value(&imported.stdout);
    let id = imported["item"]["id"].as_str().expect("book id");

    let listed = cargo_bin_cmd!("takio")
        .args(["library", "list", "--db"])
        .arg(&database)
        .output()
        .expect("list library");
    assert!(listed.status.success());
    let listed = success_value(&listed.stdout);
    assert_eq!(listed["items"].as_array().expect("library items").len(), 1);
    assert_eq!(listed["items"][0]["id"], id);

    let searched = cargo_bin_cmd!("takio")
        .args(["library", "search", "--db"])
        .arg(&database)
        .args(["--query", "dispossessed"])
        .output()
        .expect("search library");
    assert!(searched.status.success());
    let searched = success_value(&searched.stdout);
    assert_eq!(searched["items"][0]["title"], "The Dispossessed");

    let request = serde_json::json!({
        "query":"Dispossessed",
        "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":["epub"]},
        "sort":{"field":"title","direction":"ascending"},
        "page":{"offset":0,"limit":25}
    });
    let queried = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("query library");
    assert!(queried.status.success());
    let queried = success_value(&queried.stdout);
    assert_eq!(queried["total"], 1);
    assert_eq!(queried["page"]["limit"], 25);
    assert_eq!(queried["facets"]["formats"][0]["value"], "epub");

    let export_dir = temp.path().join("export");
    let request = serde_json::json!({
        "ids":[id],
        "destinationPath":export_dir,
        "fileNameTemplate":"title"
    });
    let exported = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("export library item");
    assert!(exported.status.success());
    let exported = success_value(&exported.stdout);
    assert_eq!(exported["counts"]["exported"], 1);
    let exported_path = exported["outcomes"][0]["destinationPath"]
        .as_str()
        .expect("export path");
    assert!(std::path::Path::new(exported_path).exists());
}

#[test]
fn move_import_consumes_the_source_file() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("left-hand.epub");
    fs::write(&source, b"epub").expect("write source ebook");

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .args(["--mode", "move"])
        .output()
        .expect("move ebook into library");

    assert!(output.status.success());
    assert!(!source.exists());
    let value = success_value(&output.stdout);
    let managed_path = value["item"]["formats"][0]["sourcePath"]
        .as_str()
        .expect("managed ebook path");
    assert!(std::path::Path::new(managed_path).exists());
}

#[test]
fn batch_import_reports_imported_and_skipped_files() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let books = temp.path().join("books");
    fs::create_dir(&books).expect("create books directory");
    fs::write(books.join("parable.epub"), b"epub").expect("write ebook");
    fs::write(books.join("notes.md"), b"notes").expect("write unsupported file");

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-many", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&books)
        .output()
        .expect("batch import");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["counts"]["total"], 2);
    assert_eq!(value["counts"]["imported"], 1);
    assert_eq!(value["counts"]["skipped"], 1);
}

#[test]
fn invalid_arguments_use_the_machine_readable_failure_envelope() {
    let output = cargo_bin_cmd!("takio")
        .args([
            "library",
            "import",
            "--source-path",
            "book.epub",
            "--mode",
            "link",
        ])
        .output()
        .expect("run invalid command");

    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("valid JSON failure");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["code"], "invalid-arguments");
}

#[test]
fn library_service_correlates_mutations_with_request_ids() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("earthsea.epub");
    fs::write(&source, b"epub").expect("write source ebook");

    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .output()
        .expect("import ebook");
    let imported = success_value(&imported.stdout);
    let item_id = imported["item"]["id"].as_str().expect("book id");
    let request = serde_json::json!({
        "id":"request-7",
        "command":"library_update",
        "args":{"id":item_id,"patch":{"title":"A Wizard of Earthsea"}}
    });

    let output = cargo_bin_cmd!("takio")
        .args(["library", "service", "--db"])
        .arg(&database)
        .write_stdin(format!("{request}\n"))
        .output()
        .expect("run library service");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response: Value = serde_json::from_slice(&output.stdout).expect("service JSON response");
    assert_eq!(response["id"], "request-7");
    assert_eq!(response["ok"], true);
    assert_eq!(response["value"]["item"]["title"], "A Wizard of Earthsea");
}

#[test]
fn jobs_commands_return_desktop_compatible_envelopes() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("jobs.sqlite");
    let source = temp.path().join("kindred.epub");
    let destination = temp.path().join("kindred.pdf");
    fs::write(&source, b"epub").expect("write source ebook");

    let enqueued = cargo_bin_cmd!("takio")
        .args(["jobs", "enqueue", "--db"])
        .arg(&database)
        .args(["--input"])
        .arg(&source)
        .args(["--to", "pdf", "--output"])
        .arg(&destination)
        .output()
        .expect("enqueue conversion");
    assert!(enqueued.status.success());
    let enqueued = success_value(&enqueued.stdout);
    assert_eq!(enqueued["job"]["status"], "queued");

    let listed = cargo_bin_cmd!("takio")
        .args(["jobs", "list", "--db"])
        .arg(&database)
        .output()
        .expect("list conversions");
    assert!(listed.status.success());
    let listed = success_value(&listed.stdout);
    assert_eq!(listed["jobs"].as_array().expect("jobs").len(), 1);
}
