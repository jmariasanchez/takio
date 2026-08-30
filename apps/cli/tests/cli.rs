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
    assert_eq!(value["features"]["metadata"], true);
    assert_eq!(value["features"]["contentServer"], true);
    assert!(
        value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library duplicates"))
    );
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
fn reserved_legacy_commands_return_feature_unavailable_with_their_old_syntax() {
    let output = cargo_bin_cmd!("takio")
        .args([
            "library",
            "import-calibre",
            "--library-root",
            "/tmp/calibre-library",
        ])
        .output()
        .expect("run reserved command");

    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("failure envelope");
    assert_eq!(envelope["error"]["code"], "feature-unavailable");
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
fn update_many_accounts_for_updated_and_missing_items() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let first = temp.path().join("first.epub");
    let second = temp.path().join("second.epub");
    fs::write(&first, b"first").expect("write first ebook");
    fs::write(&second, b"second").expect("write second ebook");

    let import = |source: &std::path::Path| {
        let output = cargo_bin_cmd!("takio")
            .args(["library", "import", "--db"])
            .arg(&database)
            .args(["--source-path"])
            .arg(source)
            .output()
            .expect("import ebook");
        success_value(&output.stdout)["item"]["id"]
            .as_str()
            .expect("item id")
            .to_owned()
    };
    let first_id = import(&first);
    let second_id = import(&second);

    let output = cargo_bin_cmd!("takio")
        .args(["library", "update-many", "--db"])
        .arg(&database)
        .args(["--id", &first_id, "--id", "missing", "--id", &second_id])
        .args([
            "--patch-json",
            r#"{"publisher":"Batch Publisher","tags":["Reviewed"]}"#,
        ])
        .output()
        .expect("update library items");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["counts"],
        serde_json::json!({"total":3,"updated":2,"missing":1,"failed":0})
    );
    assert_eq!(value["outcomes"][0]["status"], "updated");
    assert_eq!(
        value["outcomes"][1],
        serde_json::json!({"status":"missing","itemId":"missing"})
    );
    assert_eq!(
        value["outcomes"][2]["item"]["tags"],
        serde_json::json!(["Reviewed"])
    );
}

#[test]
fn remove_is_idempotent_and_deletes_managed_files() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("remove.epub");
    fs::write(&source, b"remove me").expect("write ebook");
    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .output()
        .expect("import ebook");
    let item = success_value(&imported.stdout)["item"].clone();
    let id = item["id"].as_str().expect("item id");
    let managed_path = item["sourcePath"].as_str().expect("managed path");

    let removed = cargo_bin_cmd!("takio")
        .args(["library", "remove", "--db"])
        .arg(&database)
        .args(["--id", id])
        .output()
        .expect("remove ebook");
    assert!(removed.status.success());
    assert_eq!(
        success_value(&removed.stdout),
        serde_json::json!({"item":item,"cleanupPending":false})
    );
    assert!(!std::path::Path::new(managed_path).exists());

    let repeated = cargo_bin_cmd!("takio")
        .args(["library", "remove", "--db"])
        .arg(&database)
        .args(["--id", id])
        .output()
        .expect("repeat removal");
    assert_eq!(
        success_value(&repeated.stdout),
        serde_json::json!({"item":null,"cleanupPending":false})
    );
}

#[test]
fn format_replace_honors_the_expected_snapshot() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let original = temp.path().join("original.epub");
    let replacement = temp.path().join("replacement.epub");
    fs::write(&original, b"original").expect("write original ebook");
    fs::write(&replacement, b"replacement").expect("write replacement ebook");
    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&original)
        .output()
        .expect("import ebook");
    let item = success_value(&imported.stdout)["item"].clone();
    let current = &item["formats"][0];
    let request = serde_json::json!({
        "id":item["id"],
        "format":"epub",
        "expectedCurrent":{
            "sourcePath":current["sourcePath"],
            "addedAt":current["addedAt"],
            "provenance":current["provenance"]
        },
        "source":{"kind":"copy","path":replacement}
    });

    let replaced = cargo_bin_cmd!("takio")
        .args(["library", "format", "replace", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("replace format");
    assert!(replaced.status.success());
    let value = success_value(&replaced.stdout);
    let new_path = value["item"]["formats"][0]["sourcePath"]
        .as_str()
        .expect("replacement path");
    assert_eq!(
        fs::read(new_path).expect("read replacement"),
        b"replacement"
    );
    assert_eq!(value["cleanupPending"], false);

    let stale = cargo_bin_cmd!("takio")
        .args(["library", "format", "replace", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("reject stale replacement");
    assert!(!stale.status.success());
    let envelope: Value = serde_json::from_slice(&stale.stdout).expect("failure envelope");
    assert_eq!(envelope["error"]["code"], "format-changed");
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

#[test]
fn backup_restore_rebases_managed_files_into_a_new_library() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let original = temp.path().join("original").join("library.sqlite");
    let source = temp.path().join("parable.epub");
    fs::write(&source, b"restorable ebook").expect("write source ebook");

    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&original)
        .args(["--source-path"])
        .arg(&source)
        .output()
        .expect("import ebook");
    assert!(imported.status.success());

    let backup = temp.path().join("backup");
    let backed_up = cargo_bin_cmd!("takio")
        .args(["library", "backup", "--db"])
        .arg(&original)
        .args(["--dest"])
        .arg(&backup)
        .output()
        .expect("back up library");
    assert!(backed_up.status.success());
    assert!(backup.join("manifest.json").is_file());

    let restored_parent = temp.path().join("restored");
    fs::create_dir(&restored_parent).expect("create existing restore parent");
    let marker = restored_parent.join("keep.txt");
    fs::write(&marker, b"unrelated").expect("write unrelated parent file");
    let restored = restored_parent.join("library.sqlite");
    let restored_output = cargo_bin_cmd!("takio")
        .args(["library", "restore-backup", "--db"])
        .arg(&restored)
        .args(["--source"])
        .arg(&backup)
        .output()
        .expect("restore library");
    assert!(restored_output.status.success());
    assert_eq!(
        success_value(&restored_output.stdout)["restore"]["report"]["verifiedManagedFormats"],
        1
    );

    let listed = cargo_bin_cmd!("takio")
        .args(["library", "list", "--db"])
        .arg(&restored)
        .output()
        .expect("list restored library");
    let value = success_value(&listed.stdout);
    let restored_path = value["items"][0]["formats"][0]["sourcePath"]
        .as_str()
        .expect("restored managed path");
    assert!(restored_path.contains("/restored/items/"));
    assert_eq!(
        fs::read(restored_path).expect("read restored ebook"),
        b"restorable ebook"
    );
    assert_eq!(
        fs::read(marker).expect("read unrelated parent file"),
        b"unrelated"
    );
}

#[test]
fn catalog_saved_views_and_content_search_work_without_calibre() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("Octavia Butler - Kindred.txt");
    fs::write(&source, b"A journey through time and memory.").expect("write text ebook");
    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .output()
        .expect("import text ebook");
    let item = success_value(&imported.stdout)["item"].clone();
    let id = item["id"].as_str().expect("item id");

    let request = serde_json::json!({
        "id":"favorite-fiction",
        "name":"Favorite fiction",
        "definition":{
            "version":1,
            "query":"Kindred",
            "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"}
        }
    });
    let saved = cargo_bin_cmd!("takio")
        .args(["library", "saved-views", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("save library view");
    assert!(saved.status.success());

    let views = cargo_bin_cmd!("takio")
        .args(["library", "saved-views", "list", "--db"])
        .arg(&database)
        .output()
        .expect("list saved views");
    assert_eq!(
        success_value(&views.stdout)["views"][0]["id"],
        "favorite-fiction"
    );

    let invalid = serde_json::json!({
        "id":"invalid-view",
        "name":"Invalid view",
        "definition":{"unexpected":true}
    });
    let rejected = cargo_bin_cmd!("takio")
        .args(["library", "saved-views", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &invalid.to_string()])
        .output()
        .expect("reject invalid library view");
    assert!(!rejected.status.success());
    let envelope: Value = serde_json::from_slice(&rejected.stdout).expect("failure envelope");
    assert_eq!(envelope["error"]["code"], "invalid-arguments");

    let patch = serde_json::json!({
        "authors":[{"name":"Octavia E. Butler","sortName":"Butler, Octavia E."}],
        "series":"Patternist adjacent",
        "seriesIndex":1.0,
        "publisher":"Beacon Press",
        "languages":["en"],
        "identifiers":{"isbn":"9780807083697"},
        "customMetadata":{"shelf":"favorites"},
        "publishedDate":"1979-06-01",
        "rating":5.0,
        "description":"A landmark time-travel novel.",
        "tags":["fiction","time travel"]
    });
    let updated = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args(["--id", id, "--patch-json", &patch.to_string()])
        .output()
        .expect("enrich catalog metadata");
    assert!(updated.status.success());

    let catalog_json = temp.path().join("catalog.json");
    let exported_json = cargo_bin_cmd!("takio")
        .args(["library", "catalog", "--db"])
        .arg(&database)
        .args(["--format", "json", "--output"])
        .arg(&catalog_json)
        .output()
        .expect("write JSON catalog");
    assert!(exported_json.status.success());
    let document: Value =
        serde_json::from_slice(&fs::read(&catalog_json).expect("read JSON catalog"))
            .expect("parse JSON catalog");
    let book = &document["books"][0];
    assert_eq!(book["authors"], serde_json::json!(["Octavia E. Butler"]));
    assert_eq!(book["identifiers"]["isbn"], "9780807083697");
    assert_eq!(book["customMetadata"]["shelf"], "favorites");
    assert_eq!(book["tags"], serde_json::json!(["fiction", "time travel"]));
    assert_eq!(book["hasCover"], false);
    assert!(book.get("sourcePath").is_none());

    let catalog = temp.path().join("catalog.csv");
    let exported = cargo_bin_cmd!("takio")
        .args(["library", "catalog", "--db"])
        .arg(&database)
        .args(["--format", "csv", "--output"])
        .arg(&catalog)
        .output()
        .expect("write catalog");
    assert!(exported.status.success());
    assert!(
        fs::read_to_string(&catalog)
            .expect("read catalog")
            .contains("Kindred")
    );

    let searched = cargo_bin_cmd!("takio")
        .args(["library", "content-search", "--db"])
        .arg(&database)
        .args(["--query", "through time", "--id", id])
        .output()
        .expect("search ebook content");
    let result = success_value(&searched.stdout);
    assert_eq!(result["counts"]["matched"], 1);
    assert_eq!(result["outcomes"][0]["status"], "matched");
}

#[test]
fn filename_metadata_candidates_are_available_without_external_backends() {
    let output = cargo_bin_cmd!("takio")
        .args([
            "metadata",
            "candidates",
            "filename",
            "--source-path",
            "Ursula K. Le Guin - Earthsea 2 - The Tombs of Atuan.epub",
            "--id",
            "book-7",
        ])
        .output()
        .expect("derive filename metadata");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["candidates"][0]["patch"]["title"],
        "The Tombs of Atuan"
    );
    assert_eq!(value["candidates"][0]["patch"]["series"], "Earthsea");
    assert_eq!(value["candidates"][0]["patch"]["seriesIndex"], 2.0);
}
