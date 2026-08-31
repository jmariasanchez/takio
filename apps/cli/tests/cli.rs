use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

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

#[cfg(unix)]
fn write_executable(path: &std::path::Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;

    fs::write(path, contents).expect("write executable");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).expect("make executable");
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
    assert_eq!(value["librarySchemaVersion"], 12);
    assert_eq!(value["features"]["metadata"], true);
    assert_eq!(value["features"]["contentServer"], true);
    assert!(
        !value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library duplicates"))
    );
    assert!(
        !value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library import-calibre"))
    );
    assert!(
        !value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library portable-export"))
    );
    assert!(
        !value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library rebuild"))
    );
    assert!(
        !value["unsupportedCommands"]
            .as_array()
            .expect("unsupported commands")
            .contains(&serde_json::json!("library import-watch"))
    );
}

#[test]
fn library_diagnostics_writes_one_redacted_bounded_bundle_without_overwrite() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let library_root = temp.path().join("private-library");
    fs::create_dir_all(&library_root).expect("library root");
    let database = library_root.join("library.sqlite");
    let source = temp.path().join("Secret Author - Secret Title.epub");
    fs::write(&source, b"private ebook content bearer-secret").expect("ebook fixture");
    add_book(&database, &source);

    let destination = temp.path().join("takio-diagnostics.json");
    let output = cargo_bin_cmd!("takio")
        .args(["library", "diagnostics", "--db"])
        .arg(&database)
        .arg("--dest")
        .arg(&destination)
        .output()
        .expect("export diagnostics");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    let result = success_value(&output.stdout);
    let bytes = fs::read(&destination).expect("diagnostic bundle");
    let bundle: Value = serde_json::from_slice(&bytes).expect("diagnostic JSON");
    assert_eq!(
        result["diagnostics"]["path"],
        destination.to_string_lossy().as_ref()
    );
    assert_eq!(result["diagnostics"]["bytes"], bytes.len() as u64);
    assert_eq!(
        result["diagnostics"]["sha256"],
        hex::encode(Sha256::digest(&bytes))
    );
    assert_eq!(result["diagnostics"]["verificationStatus"], "ok");
    assert_eq!(bundle["schemaVersion"], 1);
    assert_eq!(bundle["application"]["implementation"], "rust");
    assert_eq!(bundle["library"]["verification"]["status"], "ok");
    assert_eq!(bundle["redaction"]["paths"], "omitted");
    assert!(bytes.len() <= 1024 * 1024);
    let text = String::from_utf8(bytes).expect("UTF-8 bundle");
    for secret in [
        library_root.to_string_lossy().as_ref(),
        source.to_string_lossy().as_ref(),
        "private-library",
        "Secret Author",
        "Secret Title",
        "private ebook content",
        "bearer-secret",
    ] {
        assert!(!text.contains(secret));
    }

    let repeated = cargo_bin_cmd!("takio")
        .args(["library", "diagnostics", "--db"])
        .arg(&database)
        .arg("--dest")
        .arg(&destination)
        .output()
        .expect("repeat diagnostics");
    assert!(!repeated.status.success());
    assert!(repeated.stderr.is_empty());
    assert_eq!(failure_code(&repeated.stdout), "destination-exists");
}

#[test]
fn library_diagnostics_records_missing_library_without_creating_it() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("missing-library").join("library.sqlite");
    let destination = temp.path().join("takio-diagnostics.json");

    let output = cargo_bin_cmd!("takio")
        .args(["library", "diagnostics", "--db"])
        .arg(&database)
        .arg("--dest")
        .arg(&destination)
        .output()
        .expect("export failed-library diagnostics");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        success_value(&output.stdout)["diagnostics"]["verificationStatus"],
        "failed"
    );
    let bundle: Value = serde_json::from_slice(&fs::read(&destination).expect("diagnostic bundle"))
        .expect("diagnostic JSON");
    assert_eq!(bundle["library"]["verification"]["status"], "failed");
    assert!(!database.parent().expect("database parent").exists());
}

#[test]
fn metadata_candidates_reconcile_returns_one_ordered_envelope_without_mutation() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let epub = temp.path().join("The Author - The Title.epub");
    fs::write(&epub, b"not a real epub").expect("epub fixture");

    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&epub)
        .output()
        .expect("add item");
    assert!(added.status.success());
    let item_id = success_value(&added.stdout)["item"]["id"]
        .as_str()
        .expect("item id")
        .to_owned();
    let before = fs::read(&database).expect("database before reconcile");
    let padded_item_id = format!("  {item_id}  ");
    let request = serde_json::json!({
        "schemaVersion": 1,
        "itemIds": [padded_item_id, "missing-item"],
        "includeOnline": false,
        "concurrency": 2
    });

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .env(
            "TAKIO_EBOOK_META",
            temp.path().join("unavailable-ebook-meta"),
        )
        .output()
        .expect("reconcile candidates");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    let value = success_value(&output.stdout);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["outcomes"][0]["status"], "ready");
    assert_eq!(value["outcomes"][0]["itemId"], item_id);
    assert!(
        value["outcomes"][0]["candidates"]
            .as_array()
            .is_some_and(|candidates| !candidates.is_empty())
    );
    assert_eq!(
        value["outcomes"][0]["candidates"][0]["provenance"]["itemId"],
        item_id
    );
    assert_eq!(
        value["outcomes"][1],
        serde_json::json!({"status":"missing","itemId":"missing-item"})
    );
    assert_eq!(
        value["counts"],
        serde_json::json!({
            "total":2,"ready":1,"noCandidates":0,"missing":1,"failed":0,"canceled":0
        })
    );
    assert_eq!(
        fs::read(&database).expect("database after reconcile"),
        before
    );
}

#[test]
fn metadata_candidates_reconcile_keeps_corrupt_hydration_as_an_ordered_failure() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let corrupt_epub = temp.path().join("Corrupt.epub");
    let ready_epub = temp.path().join("Ready.epub");
    fs::write(&corrupt_epub, b"corrupt fixture").expect("corrupt epub fixture");
    fs::write(&ready_epub, b"ready fixture").expect("ready epub fixture");
    let corrupt_id = add_book(&database, &corrupt_epub);
    let ready_id = add_book(&database, &ready_epub);
    let connection = Connection::open(&database).expect("open library");
    connection
        .execute(
            "DELETE FROM library_item_formats WHERE library_item_id=?1",
            [&corrupt_id],
        )
        .expect("corrupt one item");
    drop(connection);
    let before = fs::read(&database).expect("database before reconcile");
    let request = serde_json::json!({
        "schemaVersion":1,
        "itemIds":[corrupt_id, ready_id, "missing-item"],
        "includeOnline":false,
        "concurrency":2
    });

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .env(
            "TAKIO_EBOOK_META",
            temp.path().join("unavailable-ebook-meta"),
        )
        .output()
        .expect("reconcile corrupt item");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["outcomes"][0],
        serde_json::json!({
            "status":"failed","itemId":request["itemIds"][0],"code":"invalid-stored-data"
        })
    );
    assert_eq!(value["outcomes"][1]["status"], "no-candidates");
    assert_eq!(value["outcomes"][1]["itemId"], request["itemIds"][1]);
    assert_eq!(
        value["outcomes"][2],
        serde_json::json!({"status":"missing","itemId":"missing-item"})
    );
    assert_eq!(
        value["counts"],
        serde_json::json!({
            "total":3,"ready":0,"noCandidates":1,"missing":1,"failed":1,"canceled":0
        })
    );
    assert_eq!(
        fs::read(&database).expect("database after reconcile"),
        before
    );
}

#[cfg(unix)]
#[test]
fn metadata_candidates_reconcile_reports_attempted_backend_failures_without_mutation() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let epub = temp.path().join("Backend Failure.epub");
    let embedded_failure = temp.path().join("ebook-meta-failure");
    let embedded_success = temp.path().join("ebook-meta-success");
    let online_failure = temp.path().join("fetch-ebook-metadata-failure");
    fs::write(&epub, b"backend failure fixture").expect("epub fixture");
    write_executable(&embedded_failure, "#!/bin/sh\nexit 7\n");
    write_executable(
        &embedded_success,
        "#!/bin/sh\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    --to-opf=*) opf=${argument#--to-opf=} ;;\n    --get-cover=*) cover=${argument#--get-cover=} ;;\n  esac\ndone\ncat > \"$opf\" <<'EOF'\n<?xml version=\"1.0\"?><package xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><metadata><dc:title>Embedded title</dc:title></metadata></package>\nEOF\nprintf '\\377\\330\\377staged-cover' > \"$cover\"\n",
    );
    write_executable(&online_failure, "#!/bin/sh\nexit 9\n");
    let item_id = add_book(&database, &epub);
    let before = fs::read(&database).expect("database before reconcile");
    let request = serde_json::json!({
        "schemaVersion":1,"itemIds":[item_id],"includeOnline":false,"concurrency":1
    });

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .env("TAKIO_EBOOK_META", &embedded_failure)
        .output()
        .expect("reconcile failing backend");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["outcomes"],
        serde_json::json!([{
            "status":"failed","itemId":request["itemIds"][0],"code":"metadata-extraction-failed"
        }])
    );
    assert_eq!(
        value["counts"],
        serde_json::json!({
            "total":1,"ready":0,"noCandidates":0,"missing":0,"failed":1,"canceled":0
        })
    );
    assert_eq!(
        fs::read(&database).expect("database after reconcile"),
        before
    );

    let online_request = serde_json::json!({
        "schemaVersion":1,
        "itemIds":[request["itemIds"][0]],
        "includeOnline":true,
        "concurrency":1
    });
    let online_output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args(["--request-json", &online_request.to_string()])
        .env("TAKIO_EBOOK_META", &embedded_success)
        .env("TAKIO_FETCH_EBOOK_METADATA", &online_failure)
        .output()
        .expect("reconcile failing online backend");
    assert!(online_output.status.success());
    assert!(online_output.stderr.is_empty());
    let online_value = success_value(&online_output.stdout);
    assert_eq!(
        online_value["outcomes"],
        serde_json::json!([{
            "status":"failed",
            "itemId":online_request["itemIds"][0],
            "code":"metadata-fetch-failed"
        }])
    );
    assert_eq!(
        fs::read(&database).expect("database after online reconcile"),
        before
    );
    assert_eq!(
        fs::read_dir(temp.path().join("candidate-covers"))
            .expect("candidate stage directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != ".stage.lock")
            .count(),
        0,
        "failed reconciliation must not retain inaccessible staged covers"
    );
}

#[cfg(unix)]
#[test]
fn metadata_candidates_reconcile_cancels_reaps_and_stops_later_stages() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let first_epub = temp.path().join("First.epub");
    let second_epub = temp.path().join("Second.epub");
    fs::write(&first_epub, b"first fixture").expect("first epub fixture");
    fs::write(&second_epub, b"second fixture").expect("second epub fixture");
    let first_id = add_book(&database, &first_epub);
    let second_id = add_book(&database, &second_epub);
    let embedded_backend = temp.path().join("ebook-meta-blocking");
    let online_backend = temp.path().join("fetch-ebook-metadata-marker");
    let backend_pid = temp.path().join("backend.pid");
    let embedded_log = temp.path().join("embedded.log");
    let online_marker = temp.path().join("online.started");
    write_executable(
        &embedded_backend,
        "#!/bin/sh\nprintf 'started\\n' >> \"$TAKIO_TEST_EMBEDDED_LOG\"\nprintf '%s\\n' \"$$\" > \"$TAKIO_TEST_BACKEND_PID\"\nexec sleep 30\n",
    );
    write_executable(
        &online_backend,
        "#!/bin/sh\nprintf 'started\\n' > \"$TAKIO_TEST_ONLINE_MARKER\"\nexit 7\n",
    );
    let request = serde_json::json!({
        "schemaVersion":1,
        "itemIds":[first_id, second_id],
        "includeOnline":true,
        "concurrency":1
    });
    let binary = assert_cmd::cargo::cargo_bin!("takio");
    let child = Command::new(binary)
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args([
            "--request-json",
            &request.to_string(),
            "--timeout-seconds",
            "30",
        ])
        .env("TAKIO_EBOOK_META", &embedded_backend)
        .env("TAKIO_FETCH_EBOOK_METADATA", &online_backend)
        .env("TAKIO_TEST_BACKEND_PID", &backend_pid)
        .env("TAKIO_TEST_EMBEDDED_LOG", &embedded_log)
        .env("TAKIO_TEST_ONLINE_MARKER", &online_marker)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn reconcile");
    let deadline = Instant::now() + Duration::from_secs(3);
    while !backend_pid.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(backend_pid.exists(), "embedded backend should start");
    let backend_process = fs::read_to_string(&backend_pid)
        .expect("backend pid")
        .trim()
        .to_owned();
    let started = Instant::now();
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .expect("signal reconcile");
    assert!(status.success());
    let output = child.wait_with_output().expect("wait for reconcile");

    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["outcomes"],
        serde_json::json!([
            {"status":"canceled","itemId":request["itemIds"][0]},
            {"status":"canceled","itemId":request["itemIds"][1]}
        ])
    );
    assert_eq!(value["counts"]["canceled"], 2);
    assert_eq!(
        fs::read_to_string(&embedded_log)
            .expect("embedded log")
            .lines()
            .count(),
        1
    );
    assert!(
        !online_marker.exists(),
        "online stage must not start after cancellation"
    );
    let backend_alive = Command::new("kill")
        .args(["-0", &backend_process])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("probe backend process");
    assert!(
        !backend_alive.success(),
        "backend child must be terminated and reaped"
    );
}

#[test]
fn metadata_candidates_reconcile_accepts_the_maximum_transport_safe_request() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let seed = temp.path().join("Seed.epub");
    fs::write(&seed, b"seed fixture").expect("seed epub fixture");
    let _ = add_book(&database, &seed);
    let item_ids = (0..64)
        .map(|index| format!("{index:02}{}", "x".repeat(126)))
        .collect::<Vec<_>>();
    assert!(item_ids.iter().all(|id| id.len() == 128));
    let request = serde_json::json!({
        "schemaVersion":1,"itemIds":item_ids,"includeOnline":true,"concurrency":4
    });
    let encoded = request.to_string();
    assert!(encoded.len() <= 16 * 1024);

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "reconcile", "--db"])
        .arg(&database)
        .args(["--request-json", &encoded])
        .output()
        .expect("reconcile maximum request");

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let value = success_value(&output.stdout);
    assert_eq!(value["counts"]["total"], 64);
    assert_eq!(value["counts"]["missing"], 64);
    assert_eq!(value["outcomes"].as_array().expect("outcomes").len(), 64);
}

#[test]
fn portable_export_and_rebuild_preserve_rich_metadata_order_and_bytes() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("source/library.sqlite");
    let epub = temp.path().join("primary.epub");
    let pdf = temp.path().join("referenced.pdf");
    let cover = temp.path().join("cover.png");
    fs::write(&epub, b"managed epub bytes").expect("epub");
    fs::write(&pdf, b"referenced pdf bytes").expect("pdf");
    fs::write(&cover, b"png cover bytes").expect("cover");

    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&epub)
        .args(["--title", "Rich & <Portable>"])
        .output()
        .expect("add");
    assert!(added.status.success());
    let id = success_value(&added.stdout)["item"]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let patch = serde_json::json!({
        "authors":[{"name":"Ursula & Le Guin","sortName":"Le Guin, Ursula"},{"name":"Second <Author>"}],
        "series":"Earthsea", "seriesIndex":2.5, "publisher":"Publisher & Co",
        "languages":["en","fr"], "identifiers":{"isbn":"978-1","doi":"10/test"},
        "customMetadata":{"shelf":"A&B","note":"<safe>"}, "publishedDate":"1972-01-01",
        "rating":9.5, "description":"A <rich> & exact description", "tags":["classic","sci-fi"]
    });
    let updated = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args(["--id", &id, "--patch-json", &patch.to_string()])
        .output()
        .expect("update");
    assert!(updated.status.success());
    let attached = cargo_bin_cmd!("takio")
        .args(["library", "format", "attach", "--db"])
        .arg(&database)
        .args(["--id", &id, "--source-path"])
        .arg(&pdf)
        .output()
        .expect("attach referenced format");
    assert!(attached.status.success());
    let covered = cargo_bin_cmd!("takio")
        .args(["library", "cover", "set", "--db"])
        .arg(&database)
        .args(["--id", &id, "--source-path"])
        .arg(&cover)
        .output()
        .expect("set cover");
    assert!(covered.status.success());
    let source_listed = cargo_bin_cmd!("takio")
        .args(["library", "list", "--db"])
        .arg(&database)
        .output()
        .expect("list source");
    assert!(source_listed.status.success());
    let source_formats = success_value(&source_listed.stdout)["items"][0]["formats"]
        .as_array()
        .expect("source formats")
        .clone();
    assert_ne!(source_formats[0]["addedAt"], source_formats[1]["addedAt"]);

    let portable = temp.path().join("portable");
    let exported = cargo_bin_cmd!("takio")
        .args(["library", "portable-export", "--db"])
        .arg(&database)
        .args(["--dest"])
        .arg(&portable)
        .output()
        .expect("portable export");
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stdout)
    );
    let export = success_value(&exported.stdout);
    assert_eq!(export["export"]["items"], 1);
    assert_eq!(export["export"]["formats"], 2);
    assert_eq!(export["export"]["covers"], 1);

    let rebuilt_database = temp.path().join("rebuilt/library.sqlite");
    let rebuilt = cargo_bin_cmd!("takio")
        .args(["library", "rebuild", "--db"])
        .arg(&rebuilt_database)
        .args(["--source"])
        .arg(&portable)
        .output()
        .expect("rebuild");
    assert!(
        rebuilt.status.success(),
        "{}",
        String::from_utf8_lossy(&rebuilt.stdout)
    );
    let listed = cargo_bin_cmd!("takio")
        .args(["library", "list", "--db"])
        .arg(&rebuilt_database)
        .output()
        .expect("list rebuilt");
    assert!(listed.status.success());
    let item = success_value(&listed.stdout)["items"][0].clone();
    assert_eq!(item["id"], id);
    assert_eq!(item["title"], "Rich & <Portable>");
    assert_eq!(item["authors"], patch["authors"]);
    assert_eq!(item["identifiers"], patch["identifiers"]);
    assert_eq!(item["customMetadata"], patch["customMetadata"]);
    assert_eq!(item["formats"][0]["format"], "epub");
    assert_eq!(item["formats"][1]["format"], "pdf");
    assert_eq!(item["formats"][0]["addedAt"], source_formats[0]["addedAt"]);
    assert_eq!(item["formats"][1]["addedAt"], source_formats[1]["addedAt"]);
    assert_eq!(
        fs::read(
            item["formats"][0]["sourcePath"]
                .as_str()
                .expect("epub path")
        )
        .expect("epub bytes"),
        b"managed epub bytes"
    );
    assert_eq!(
        fs::read(item["formats"][1]["sourcePath"].as_str().expect("pdf path")).expect("pdf bytes"),
        b"referenced pdf bytes"
    );
    assert_eq!(
        fs::read(item["coverPath"].as_str().expect("cover path")).expect("cover bytes"),
        b"png cover bytes"
    );

    let conflict = cargo_bin_cmd!("takio")
        .args(["library", "rebuild", "--db"])
        .arg(&rebuilt_database)
        .args(["--source"])
        .arg(&portable)
        .output()
        .expect("conflicting rebuild");
    assert!(!conflict.status.success());
    assert_eq!(failure_code(&conflict.stdout), "destination-exists");

    let invalid_destination = temp.path().join("invalid/library.sqlite");
    let manifest: Value =
        serde_json::from_slice(&fs::read(portable.join("manifest.json")).expect("manifest"))
            .expect("json");
    let leaf = manifest["books"][0]["directory"]
        .as_str()
        .expect("directory");
    fs::write(
        portable.join("books").join(leaf).join("book.epub"),
        b"tampered",
    )
    .expect("tamper");
    let invalid = cargo_bin_cmd!("takio")
        .args(["library", "rebuild", "--db"])
        .arg(&invalid_destination)
        .args(["--source"])
        .arg(&portable)
        .output()
        .expect("invalid rebuild");
    assert!(!invalid.status.success());
    assert_eq!(failure_code(&invalid.stdout), "source-invalid");
    assert!(
        !invalid_destination
            .parent()
            .expect("destination root")
            .exists()
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
fn export_many_organizes_every_format_and_uses_stable_collision_safe_names() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let first_epub = temp.path().join("first.epub");
    let first_pdf = temp.path().join("first.pdf");
    let second_epub = temp.path().join("second.epub");
    fs::write(&first_epub, b"first epub").expect("write first epub");
    fs::write(&first_pdf, b"first pdf").expect("write first pdf");
    fs::write(&second_epub, b"second epub").expect("write second epub");

    let first_id = add_book(&database, &first_epub);
    let second_id = add_book(&database, &second_epub);
    for (id, patch) in [
        (
            &first_id,
            serde_json::json!({
                "title":"Shared title",
                "authors":[{"name":"Author/One:*?"}],
                "series":"Series/One:*?"
            }),
        ),
        (
            &second_id,
            serde_json::json!({
                "title":"Shared title",
                "authors":[{"name":"Author/One:*?"}]
            }),
        ),
    ] {
        let updated = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", id, "--patch-json", &patch.to_string()])
            .output()
            .expect("update export metadata");
        assert!(updated.status.success());
    }
    let attached = cargo_bin_cmd!("takio")
        .args(["library", "format", "import", "--db"])
        .arg(&database)
        .args(["--id", &first_id, "--source-path"])
        .arg(&first_pdf)
        .output()
        .expect("attach second format");
    assert!(attached.status.success());

    let author_destination = temp.path().join("by-author");
    let request = serde_json::json!({
        "ids":[first_id,second_id],
        "destinationPath":author_destination,
        "fileNameTemplate":"title",
        "directoryTemplate":"author"
    });
    let exported = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("export organized library items");
    assert!(exported.status.success());
    assert!(exported.stderr.is_empty());
    let value = success_value(&exported.stdout);
    assert_eq!(
        value["counts"],
        serde_json::json!({"total":3,"exported":3,"skipped":0,"failed":0})
    );
    let outcomes = value["outcomes"].as_array().expect("export outcomes");
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome["itemId"] == first_id)
            .count(),
        2
    );
    let paths = outcomes
        .iter()
        .map(|outcome| {
            std::path::PathBuf::from(
                outcome["destinationPath"]
                    .as_str()
                    .expect("export destination path"),
            )
        })
        .collect::<Vec<_>>();
    assert!(paths.iter().all(|path| path.exists()));
    assert!(paths.iter().all(|path| {
        path.parent()
            .and_then(std::path::Path::file_name)
            .and_then(|name| name.to_str())
            == Some("AuthorOne")
    }));
    assert_eq!(
        paths
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    for (id, path) in [
        (&first_id, &paths[0]),
        (&first_id, &paths[1]),
        (&second_id, &paths[2]),
    ] {
        let identity = format!("{:x}", Sha256::digest(id.as_bytes()));
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(&identity)
        );
    }

    let repeated = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("repeat organized export");
    assert_eq!(
        success_value(&repeated.stdout)["counts"],
        serde_json::json!({"total":3,"exported":0,"skipped":3,"failed":0})
    );

    let series_destination = temp.path().join("by-series");
    let series_request = serde_json::json!({
        "ids":[first_id,second_id],
        "destinationPath":series_destination,
        "directoryTemplate":"series"
    });
    let by_series = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &series_request.to_string()])
        .output()
        .expect("export by series");
    let series_value = success_value(&by_series.stdout);
    assert_eq!(series_value["counts"]["exported"], 3);
    let parents = series_value["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|outcome| {
            std::path::Path::new(outcome["destinationPath"].as_str().unwrap())
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        parents,
        std::collections::BTreeSet::from(["SeriesOne".to_owned(), "Unsorted".to_owned()])
    );

    let invalid = serde_json::json!({
        "ids":[first_id],
        "destinationPath":temp.path().join("invalid"),
        "directoryTemplate":"author/title"
    });
    let rejected = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &invalid.to_string()])
        .output()
        .expect("reject arbitrary export template");
    assert!(!rejected.status.success());
    assert_eq!(failure_code(&rejected.stdout), "invalid-arguments");
    assert!(rejected.stderr.is_empty());

    let duplicate_destination = temp.path().join("duplicate-request");
    let duplicate = serde_json::json!({
        "ids":[first_id,first_id],
        "destinationPath":duplicate_destination
    });
    let rejected = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &duplicate.to_string()])
        .output()
        .expect("reject duplicate export ids");
    assert!(!rejected.status.success());
    assert_eq!(failure_code(&rejected.stdout), "invalid-arguments");
    assert!(rejected.stderr.is_empty());
    assert!(!duplicate_destination.exists());
}

#[cfg(unix)]
#[test]
fn export_many_rejects_symlinked_organization_directories() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("book.epub");
    fs::write(&source, b"book").expect("write source");
    let id = add_book(&database, &source);
    let updated = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--patch-json",
            r#"{"authors":[{"name":"Escape"}]}"#,
        ])
        .output()
        .expect("set author");
    assert!(updated.status.success());

    let destination = temp.path().join("destination");
    let outside = temp.path().join("outside");
    fs::create_dir(&destination).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, destination.join("Escape")).unwrap();
    let request = serde_json::json!({
        "ids":[id],
        "destinationPath":destination,
        "directoryTemplate":"author"
    });
    let output = cargo_bin_cmd!("takio")
        .args(["library", "export-many", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("reject symlinked author directory");
    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["counts"],
        serde_json::json!({"total":1,"exported":0,"skipped":0,"failed":1})
    );
    assert_eq!(value["outcomes"][0]["code"], "destination-unavailable");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
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
fn import_watch_rejects_historical_bound_violations() {
    for arguments in [
        vec!["--interval-seconds", "0"],
        vec!["--interval-seconds", "86401"],
        vec!["--max-cycles", "0"],
        vec!["--max-cycles", "10001"],
    ] {
        let mut command = cargo_bin_cmd!("takio");
        command.args(["library", "import-watch", "--source-path", "."]);
        command.args(arguments);
        let output = command.output().expect("run invalid import watch");
        assert!(!output.status.success());
        assert_eq!(failure_code(&output.stdout), "invalid-arguments");
        assert!(output.stderr.is_empty());
    }

    let mut command = cargo_bin_cmd!("takio");
    command.args(["library", "import-watch"]);
    for index in 0..257 {
        command.arg("--source-path").arg(format!("root-{index}"));
    }
    let output = command.output().expect("run excessive roots");
    assert!(!output.status.success());
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
}

#[test]
fn scanned_imports_reject_library_source_overlap_before_side_effects() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let source = temp.path().join("watched");
    fs::create_dir(&source).expect("source directory");
    fs::write(source.join("book.epub"), b"ebook").expect("source ebook");
    let nested_database = source.join(".takio/library.sqlite");

    for subcommand in ["import-many", "import-watch"] {
        let mut command = cargo_bin_cmd!("takio");
        command
            .args(["library", subcommand, "--db"])
            .arg(&nested_database)
            .arg("--source-path")
            .arg(&source);
        if subcommand == "import-watch" {
            command.args(["--max-cycles", "1"]);
        }
        let output = command.output().expect("reject nested library");
        assert!(!output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(failure_code(&output.stdout), "invalid-arguments");
        assert!(!nested_database.exists());
        assert!(!source.join(".takio/items").exists());
        assert!(!source.join(".takio/covers").exists());
    }

    let library_root = temp.path().join("library");
    let nested_source = library_root.join("items/inbox");
    fs::create_dir_all(&nested_source).expect("nested source directory");
    fs::write(nested_source.join("book.epub"), b"ebook").expect("nested source ebook");
    let database = library_root.join("library.sqlite");
    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&nested_source)
        .args(["--max-cycles", "1"])
        .output()
        .expect("reject source nested in library");
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(!database.exists());
    assert_eq!(
        fs::read_dir(library_root.join("items"))
            .expect("pre-existing items directory")
            .count(),
        1
    );
    assert!(!library_root.join("covers").exists());
}

#[cfg(unix)]
#[test]
fn scanned_imports_reject_symlinked_library_source_aliases() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temporary directory");
    let library_root = temp.path().join("library");
    fs::create_dir(&library_root).expect("library root");
    let alias = temp.path().join("library-alias");
    symlink(&library_root, &alias).expect("library alias");
    let database = library_root.join("library.sqlite");
    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&alias)
        .args(["--max-cycles", "1"])
        .output()
        .expect("reject symlink alias");
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(!database.exists());
    assert!(!library_root.join("items").exists());
    assert!(!library_root.join("covers").exists());
}

#[test]
fn scanned_imports_reject_case_aliases_on_case_insensitive_filesystems() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let library_root = temp.path().join("library");
    let alias = library_root.join("ITEMS");
    fs::create_dir_all(&alias).expect("case alias directory");
    if !library_root.join("items").exists() {
        return;
    }
    fs::write(alias.join("book.epub"), b"ebook").expect("case alias ebook");
    let database = library_root.join("library.sqlite");
    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&alias)
        .args(["--max-cycles", "1"])
        .output()
        .expect("reject case alias");
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(!database.exists());
    assert!(!library_root.join("covers").exists());
}

#[cfg(unix)]
#[test]
fn import_watch_revalidates_sources_between_cycles() {
    use std::os::unix::fs::symlink;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let temp = tempfile::tempdir().expect("temporary directory");
    let library_root = temp.path().join("library");
    let database = library_root.join("library.sqlite");
    let source = temp.path().join("watch");
    fs::create_dir(&source).expect("watch source");
    fs::write(source.join("book.epub"), b"ebook").expect("watch ebook");
    let binary = assert_cmd::cargo::cargo_bin!("takio");
    let child = Command::new(binary)
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&source)
        .args(["--interval-seconds", "2", "--max-cycles", "3"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn import watch");

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let observed = Connection::open(&database)
            .ok()
            .and_then(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM import_watch_observations",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .ok()
            })
            .unwrap_or(0);
        if observed == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "first watch cycle should finish");
        std::thread::sleep(Duration::from_millis(20));
    }

    fs::remove_dir_all(&source).expect("replace watch source");
    symlink(library_root.join("items"), &source).expect("alias managed items");
    let output = child
        .wait_with_output()
        .expect("wait for overlap rejection");
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    let formats: i64 = Connection::open(&database)
        .expect("open library")
        .query_row("SELECT COUNT(*) FROM library_item_formats", [], |row| {
            row.get(0)
        })
        .expect("count formats");
    assert_eq!(formats, 1);
}

#[test]
fn import_watch_two_cycles_and_restart_do_not_recount_accounted_files() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("watch");
    fs::create_dir(&source).expect("watch directory");
    fs::write(source.join("book.epub"), b"first edition").expect("ebook");
    fs::write(source.join("notes.bin"), b"unsupported").expect("unsupported file");

    let first = run_import_watch(&database, &source, 2);
    assert_eq!(first["cycles"], 2);
    assert_eq!(first["stopped"], false);
    assert_eq!(
        first["counts"],
        serde_json::json!({"total":2,"imported":1,"skipped":1,"duplicates":0,"failed":0})
    );

    let restarted = run_import_watch(&database, &source, 1);
    assert_eq!(restarted["cycles"], 1);
    assert_eq!(
        restarted["counts"],
        serde_json::json!({"total":0,"imported":0,"skipped":0,"duplicates":0,"failed":0})
    );
}

#[test]
fn import_watch_reprocesses_changed_files_and_persists_observations() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("book.epub");
    fs::write(&source, b"version one").expect("first version");
    let first = run_import_watch(&database, &source, 1);
    assert_eq!(first["counts"]["imported"], 1);

    fs::write(&source, b"version two is different").expect("changed version");
    let changed = run_import_watch(&database, &source, 1);
    assert_eq!(changed["counts"]["imported"], 1);
    assert_eq!(changed["counts"]["total"], 1);

    let connection = Connection::open(&database).expect("open watch database");
    let observations: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM import_watch_observations",
            [],
            |row| row.get(0),
        )
        .expect("count observations");
    assert_eq!(observations, 1);
}

#[test]
fn import_watch_suppresses_accounted_duplicates_but_retries_failures() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let managed = temp.path().join("managed.epub");
    let duplicate = temp.path().join("duplicate.epub");
    let missing = temp.path().join("missing.epub");
    fs::write(&managed, b"duplicate bytes").expect("managed source");
    fs::write(&duplicate, b"duplicate bytes").expect("duplicate source");
    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&managed)
        .output()
        .expect("seed library");
    assert!(added.status.success());

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&duplicate)
        .arg("--source-path")
        .arg(&missing)
        .args(["--interval-seconds", "1", "--max-cycles", "2"])
        .output()
        .expect("watch duplicate and failure");
    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(
        value["counts"],
        serde_json::json!({"total":3,"imported":0,"skipped":0,"duplicates":1,"failed":2})
    );
}

#[test]
fn import_many_reports_existing_and_earlier_request_duplicates() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let existing = temp.path().join("existing.epub");
    let existing_again = temp.path().join("existing-again.epub");
    let first = temp.path().join("a.epub");
    let second = temp.path().join("b.epub");
    fs::write(&existing, b"already managed").expect("existing");
    fs::write(&existing_again, b"already managed").expect("existing duplicate");
    fs::write(&first, b"same request").expect("first");
    fs::write(&second, b"same request").expect("second");
    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&existing)
        .output()
        .expect("seed existing library");
    assert!(added.status.success());

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-many", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&existing)
        .arg("--source-path")
        .arg(&existing_again)
        .arg("--source-path")
        .arg(&first)
        .arg("--source-path")
        .arg(&second)
        .output()
        .expect("batch import duplicates");
    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["counts"]["imported"], 1);
    assert_eq!(value["counts"]["duplicates"], 3);
    assert_eq!(value["outcomes"][0]["reason"], "existing-library");
    assert_eq!(value["outcomes"][1]["reason"], "earlier-in-request");
    assert_eq!(value["outcomes"][3]["reason"], "earlier-in-request");
    assert_eq!(value["outcomes"][3]["existing"]["format"], "epub");
}

#[test]
fn import_many_reports_the_fingerprint_matched_format() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let epub = temp.path().join("book.epub");
    let pdf = temp.path().join("book.pdf");
    let duplicate_pdf = temp.path().join("duplicate.pdf");
    fs::write(&epub, b"epub bytes").expect("epub");
    fs::write(&pdf, b"pdf bytes").expect("pdf");
    fs::write(&duplicate_pdf, b"pdf bytes").expect("duplicate pdf");

    let added = cargo_bin_cmd!("takio")
        .args(["library", "add", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&epub)
        .output()
        .expect("add epub");
    assert!(added.status.success());
    let id = success_value(&added.stdout)["item"]["id"]
        .as_str()
        .expect("item id")
        .to_owned();
    let attached = cargo_bin_cmd!("takio")
        .args(["library", "format", "import", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .arg("--source-path")
        .arg(&pdf)
        .output()
        .expect("attach managed pdf");
    assert!(attached.status.success());

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-many", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&duplicate_pdf)
        .output()
        .expect("import duplicate pdf");
    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["outcomes"][0]["status"], "duplicate");
    assert_eq!(value["outcomes"][0]["existing"]["itemId"], id);
    assert_eq!(value["outcomes"][0]["existing"]["format"], "pdf");
}

#[cfg(unix)]
#[test]
fn import_many_reports_symlinks_and_unsupported_non_files() {
    use std::os::unix::fs::{FileTypeExt, symlink};

    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("watch");
    fs::create_dir(&source).expect("source directory");
    fs::write(source.join("target.epub"), b"ebook").expect("target");
    symlink(source.join("target.epub"), source.join("linked.epub")).expect("symlink");
    let socket = source.join("socket");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("unix socket");
    assert!(
        fs::metadata(&socket)
            .expect("socket metadata")
            .file_type()
            .is_socket()
    );

    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-many", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&source)
        .output()
        .expect("scan special entries");
    drop(listener);
    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["counts"]["total"], 3);
    assert_eq!(value["outcomes"][0]["reason"], "symbolic-link");
    assert_eq!(value["outcomes"][1]["reason"], "unsupported-file-type");
    assert_eq!(value["outcomes"][2]["status"], "imported");
}

#[cfg(unix)]
#[test]
fn import_watch_signal_wakes_wait_and_returns_one_stopped_envelope() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("watch");
    fs::create_dir(&source).expect("watch directory");
    let entry_count = 2_000_u64;
    for index in 0..entry_count {
        fs::write(source.join(format!("book-{index:04}.epub")), b"signal test").expect("ebook");
    }
    let binary = assert_cmd::cargo::cargo_bin!("takio");
    let child = Command::new(binary)
        .args(["library", "import-watch", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&source)
        .args(["--interval-seconds", "60"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn import watch");
    let ready_deadline = Instant::now() + Duration::from_secs(3);
    while !database.exists() && Instant::now() < ready_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(database.exists(), "watch library should initialize");
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .expect("signal import watch");
    assert!(status.success());
    let output = child.wait_with_output().expect("wait for import watch");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let value = success_value(&output.stdout);
    assert_eq!(value["cycles"], 1);
    assert_eq!(value["stopped"], true);
    assert!(
        value["counts"]["total"].as_u64().expect("total") < entry_count,
        "signal should stop the active scan before all entries are imported"
    );
}

fn run_import_watch(database: &std::path::Path, source: &std::path::Path, cycles: u64) -> Value {
    let output = cargo_bin_cmd!("takio")
        .args(["library", "import-watch", "--db"])
        .arg(database)
        .arg("--source-path")
        .arg(source)
        .args(["--interval-seconds", "1", "--max-cycles"])
        .arg(cycles.to_string())
        .output()
        .expect("run import watch");
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    success_value(&output.stdout)
}

#[test]
fn calibre_import_preserves_metadata_formats_cover_duplicates_and_source_database() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let calibre_root = temp.path().join("Calibre Library #1");
    fs::create_dir(&calibre_root).expect("create Calibre root");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let book_dir = calibre_root.join("Author/Calibre Title (1)");
    fs::create_dir_all(&book_dir).expect("create Calibre book directory");
    fs::write(book_dir.join("Calibre Title - Ada.epub"), b"epub bytes").expect("write epub");
    fs::write(book_dir.join("Calibre Title - Ada.pdf"), b"pdf bytes").expect("write pdf");
    fs::write(book_dir.join("cover.jpg"), [0xff, 0xd8, 0xff, 0xd9]).expect("write cover");
    let before = fs::metadata(&metadata_db).expect("metadata before import");
    let takio_db = temp.path().join("takio/library.sqlite");

    let first = cargo_bin_cmd!("takio")
        .args(["library", "import-calibre", "--db"])
        .arg(&takio_db)
        .args(["--library-root"])
        .arg(&calibre_root)
        .output()
        .expect("import Calibre library");
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(first.stderr.is_empty());
    assert_eq!(String::from_utf8_lossy(&first.stdout).lines().count(), 1);
    let first = success_value(&first.stdout);
    assert_eq!(
        first["counts"],
        serde_json::json!({"total":1,"imported":1,"skipped":0,"duplicates":0,"failed":0})
    );
    let item = &first["outcomes"][0]["item"];
    assert_eq!(item["title"], "Calibre Title");
    assert_eq!(
        item["authors"],
        serde_json::json!([{"name":"Ada Lovelace","sortName":"Lovelace, Ada"}])
    );
    assert_eq!(item["author"], "Ada Lovelace");
    assert_eq!(item["series"], "Analytical Engines");
    assert_eq!(item["seriesIndex"], 2.5);
    assert_eq!(item["publisher"], "First Publisher");
    assert_eq!(item["publishedDate"], "2020-05-02");
    assert_eq!(item["rating"], 8.0);
    assert_eq!(
        item["identifiers"],
        serde_json::json!({"isbn":"9780000000001"})
    );
    assert_eq!(item["languages"], serde_json::json!(["en"]));
    assert_eq!(item["tags"], serde_json::json!(["Math", "Computing"]));
    assert_eq!(item["description"], "Important description");
    assert_eq!(
        item["customMetadata"],
        serde_json::json!({"reading_state":"planned"})
    );
    assert_eq!(item["formats"][0]["format"], "epub");
    assert_eq!(item["formats"][1]["format"], "pdf");
    for format in item["formats"].as_array().expect("managed formats") {
        let managed = format["sourcePath"].as_str().expect("managed path");
        assert!(std::path::Path::new(managed).is_file());
        assert!(!managed.starts_with(calibre_root.to_string_lossy().as_ref()));
        assert_eq!(format["provenance"], "managed");
    }
    assert!(std::path::Path::new(item["coverPath"].as_str().expect("managed cover")).is_file());

    let second = cargo_bin_cmd!("takio")
        .args(["library", "import-calibre", "--db"])
        .arg(&takio_db)
        .args(["--library-root"])
        .arg(&calibre_root)
        .output()
        .expect("import Calibre library again");
    assert!(second.status.success());
    let second = success_value(&second.stdout);
    assert_eq!(
        second["counts"],
        serde_json::json!({"total":1,"imported":0,"skipped":0,"duplicates":1,"failed":0})
    );
    assert_eq!(second["outcomes"][0]["status"], "duplicate");
    assert_eq!(second["outcomes"][0]["reason"], "existing-library");
    assert_eq!(second["outcomes"][0]["existing"]["format"], "epub");

    let after = fs::metadata(&metadata_db).expect("metadata after import");
    assert_eq!(after.len(), before.len());
    assert_eq!(
        after.modified().expect("mtime after"),
        before.modified().expect("mtime before")
    );
}

#[test]
fn calibre_import_uses_stable_top_level_errors_without_writing_the_source() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let missing = run_calibre_import(
        temp.path().join("library.sqlite"),
        temp.path().join("missing"),
    );
    assert_failure_code(&missing, "not-found");

    let unreadable_root = temp.path().join("unreadable");
    fs::create_dir(&unreadable_root).expect("create unreadable fixture");
    fs::write(unreadable_root.join("metadata.db"), b"not sqlite").expect("write invalid database");
    let unreadable = run_calibre_import(temp.path().join("library.sqlite"), unreadable_root);
    assert_failure_code(&unreadable, "unreadable");

    let malformed_root = temp.path().join("malformed");
    fs::create_dir(&malformed_root).expect("create malformed fixture");
    Connection::open(malformed_root.join("metadata.db")).expect("create valid SQLite database");
    let malformed = run_calibre_import(temp.path().join("library.sqlite"), malformed_root);
    assert_failure_code(&malformed, "storage-unavailable");

    let calibre_root = temp.path().join("calibre");
    fs::create_dir(&calibre_root).expect("create Calibre fixture");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let before = fs::metadata(&metadata_db).expect("source metadata");
    let same_database = run_calibre_import(metadata_db.clone(), calibre_root.clone());
    assert_failure_code(&same_database, "invalid-arguments");
    let after = fs::metadata(&metadata_db).expect("source metadata after rejected target");
    assert_eq!(after.len(), before.len());
    assert_eq!(
        after.modified().expect("after mtime"),
        before.modified().expect("before mtime")
    );

    let nested_database = calibre_root.join("takio/library.sqlite");
    let nested = run_calibre_import(nested_database, calibre_root.clone());
    assert_failure_code(&nested, "invalid-arguments");
    assert!(!calibre_root.join("takio").exists());

    let hardlink_root = temp.path().join("hardlink-target");
    fs::create_dir(&hardlink_root).expect("create hardlink destination");
    let hardlink_database = hardlink_root.join("library.sqlite");
    fs::hard_link(&metadata_db, &hardlink_database).expect("hard-link source database");
    let hardlink = run_calibre_import(hardlink_database, calibre_root.clone());
    assert_failure_code(&hardlink, "invalid-arguments");
    assert!(!hardlink_root.join("items").exists());
    assert!(!hardlink_root.join("covers").exists());

    let blocked_root = temp.path().join("blocked");
    fs::write(&blocked_root, b"not a directory").expect("create storage blocker");
    let unavailable = run_calibre_import(blocked_root.join("library.sqlite"), calibre_root);
    assert_failure_code(&unavailable, "storage-unavailable");
}

#[cfg(unix)]
#[test]
fn calibre_import_contains_malicious_paths_symlinks_and_custom_columns() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temporary directory");
    let calibre_root = temp.path().join("calibre");
    fs::create_dir(&calibre_root).expect("create Calibre root");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let safe_dir = calibre_root.join("Author/Calibre Title (1)");
    fs::create_dir_all(&safe_dir).expect("create safe book directory");
    fs::write(safe_dir.join("Calibre Title - Ada.epub"), b"safe epub").expect("write safe epub");
    fs::write(safe_dir.join("Calibre Title - Ada.pdf"), b"safe pdf").expect("write safe pdf");

    let outside = temp.path().join("outside");
    fs::create_dir(&outside).expect("create outside directory");
    fs::write(outside.join("Escape.epub"), b"outside bytes").expect("write outside ebook");
    fs::write(outside.join("Escape.mobi"), b"outside mobi").expect("write outside extra ebook");
    symlink(&outside, calibre_root.join("linked-book")).expect("create source symlink");
    symlink(outside.join("Escape.mobi"), safe_dir.join("External.mobi"))
        .expect("create extra-format symlink");

    let database = Connection::open(&metadata_db).expect("open fixture for malicious rows");
    database
        .execute_batch(&format!(
            "INSERT INTO books VALUES (2,'Traversal','../outside',NULL,NULL);
             INSERT INTO books VALUES (3,'Absolute','{}',NULL,NULL);
             INSERT INTO books VALUES (4,'Symlink','linked-book',NULL,NULL);
             INSERT INTO books VALUES (5,'Filename traversal','Author/Calibre Title (1)',NULL,NULL);
             INSERT INTO data VALUES (3,2,'EPUB','Escape'),(4,3,'EPUB','Escape'),(5,4,'EPUB','Escape'),
                                     (6,5,'EPUB','../../../outside/Escape'),(7,1,'MOBI','External');
             INSERT INTO custom_columns VALUES (2,'custom_column_1; DROP TABLE books','unsafe'),
                                               (3,'custom_column_2','9invalid'),
                                               (4,'custom_column_3','blob_value');
             CREATE TABLE custom_column_2 (book INTEGER,value TEXT);
             CREATE TABLE custom_column_3 (book INTEGER,value BLOB);
             INSERT INTO custom_column_2 VALUES (1,'ignored');
             INSERT INTO custom_column_3 VALUES (1,x'00FF');",
            outside.to_string_lossy().replace('\'', "''")
        ))
        .expect("insert malicious fixture rows");
    drop(database);

    let output = run_calibre_import(temp.path().join("takio/library.sqlite"), calibre_root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value = success_value(&output.stdout);
    assert_eq!(
        value["counts"],
        serde_json::json!({"total":1,"imported":1,"skipped":0,"duplicates":0,"failed":0}),
        "{value}"
    );
    assert_eq!(
        value["outcomes"][0]["item"]["customMetadata"],
        serde_json::json!({"reading_state":"planned"})
    );
    assert_eq!(
        value["outcomes"][0]["item"]["formats"]
            .as_array()
            .expect("managed formats")
            .len(),
        2
    );
    assert!(!value.to_string().contains("outside/Escape.epub"));
    assert!(outside.join("Escape.epub").is_file());
}

#[test]
fn calibre_import_snapshots_live_wal_metadata_without_writing_the_source() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let calibre_root = temp.path().join("calibre");
    fs::create_dir(&calibre_root).expect("create Calibre root");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let book_dir = calibre_root.join("Author/Calibre Title (1)");
    fs::create_dir_all(&book_dir).expect("create book directory");
    fs::write(book_dir.join("Calibre Title - Ada.epub"), b"epub").expect("write epub");
    fs::write(book_dir.join("Calibre Title - Ada.pdf"), b"pdf").expect("write pdf");

    let writer = Connection::open(&metadata_db).expect("open live Calibre database");
    writer
        .pragma_update(None, "journal_mode", "WAL")
        .expect("enable WAL");
    writer
        .pragma_update(None, "wal_autocheckpoint", 0)
        .expect("disable automatic checkpoint");
    writer
        .execute("UPDATE books SET title='Live WAL Title' WHERE id=1", [])
        .expect("write live WAL metadata");
    let wal = metadata_db.with_file_name("metadata.db-wal");
    let database_before = fs::metadata(&metadata_db).expect("database metadata before");
    let wal_before = fs::metadata(&wal).expect("WAL metadata before");

    let output = run_calibre_import(temp.path().join("takio/library.sqlite"), calibre_root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value = success_value(&output.stdout);
    assert_eq!(value["outcomes"][0]["item"]["title"], "Live WAL Title");
    let database_after = fs::metadata(&metadata_db).expect("database metadata after");
    let wal_after = fs::metadata(&wal).expect("WAL metadata after");
    assert_eq!(database_after.len(), database_before.len());
    assert_eq!(wal_after.len(), wal_before.len());
    assert_eq!(
        database_after.modified().ok(),
        database_before.modified().ok()
    );
    assert_eq!(wal_after.modified().ok(), wal_before.modified().ok());
    drop(writer);
}

#[test]
fn calibre_import_uses_physical_ids_machine_labels_display_names_and_normalized_links() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let calibre_root = temp.path().join("calibre");
    fs::create_dir(&calibre_root).expect("create Calibre root");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let book_dir = calibre_root.join("Author/Calibre Title (1)");
    fs::create_dir_all(&book_dir).expect("create book directory");
    fs::write(book_dir.join("Calibre Title - Ada.epub"), b"epub").expect("write ebook");
    fs::write(book_dir.join("Calibre Title - Ada.pdf"), b"pdf").expect("write pdf");

    let database = Connection::open(&metadata_db).expect("open fixture");
    database
        .execute_batch(
            "INSERT INTO custom_columns VALUES (7,'Second Reading State','reading_state');
             CREATE TABLE custom_column_7 (id INTEGER PRIMARY KEY,value TEXT);
             CREATE TABLE books_custom_column_7_link (id INTEGER PRIMARY KEY,book INTEGER,value INTEGER);
             INSERT INTO custom_column_7 VALUES (11,'finished');
             INSERT INTO books_custom_column_7_link VALUES (1,1,11);",
        )
        .expect("add normalized custom column");
    drop(database);

    let output = run_calibre_import(temp.path().join("takio/library.sqlite"), calibre_root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value = success_value(&output.stdout);
    assert_eq!(
        value["outcomes"][0]["item"]["customMetadata"],
        serde_json::json!({"reading_state":"planned","reading_state_2":"finished"})
    );

    let listed = cargo_bin_cmd!("takio")
        .args(["library", "custom-columns", "list", "--db"])
        .arg(temp.path().join("takio/library.sqlite"))
        .output()
        .expect("list definitions");
    assert_eq!(
        success_value(&listed.stdout)["definitions"],
        serde_json::json!([
            {"key":"reading_state","label":"Reading State","type":"text","position":0},
            {"key":"reading_state_2","label":"Second Reading State","type":"text","position":1}
        ])
    );
}

#[test]
fn calibre_import_sanitizes_invalid_fields_and_processes_all_bounded_custom_rows() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let calibre_root = temp.path().join("calibre");
    fs::create_dir(&calibre_root).expect("create Calibre root");
    let metadata_db = calibre_root.join("metadata.db");
    create_calibre_fixture(&metadata_db);
    let book_dir = calibre_root.join("Author/Calibre Title (1)");
    fs::create_dir_all(&book_dir).expect("create book directory");
    fs::write(book_dir.join("Calibre Title - Ada.epub"), b"epub").expect("write epub");
    fs::write(book_dir.join("Calibre Title - Ada.pdf"), b"pdf").expect("write pdf");

    let database = Connection::open(&metadata_db).expect("open Calibre fixture");
    database
        .execute_batch(
            "UPDATE ratings SET rating=99 WHERE id=1;
             INSERT INTO languages VALUES (2,'en_US'),(3,'en-US');
             INSERT INTO books_languages_link VALUES (2,1,2,1),(3,1,3,2);
             DELETE FROM custom_column_1;
             WITH RECURSIVE sequence(value) AS (
               SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10001
             )
             INSERT INTO custom_column_1(id,book,value)
             SELECT value,1,CASE WHEN value=10001 THEN 'after_limit' ELSE 'planned' END FROM sequence;
             CREATE TABLE custom_column_2 (id INTEGER PRIMARY KEY, book INTEGER, value TEXT);
             INSERT INTO custom_columns VALUES (2,'custom_column_2','oversized');",
        )
        .expect("add invalid and high-cardinality metadata");
    database
        .execute(
            "INSERT INTO custom_column_2 VALUES (1,1,?1)",
            ["x".repeat(16 * 1024 + 1)],
        )
        .expect("insert oversized custom value");
    drop(database);

    let output = run_calibre_import(temp.path().join("takio/library.sqlite"), calibre_root);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let item = &success_value(&output.stdout)["outcomes"][0]["item"];
    assert_eq!(item["title"], "Calibre Title");
    assert_eq!(item["authors"][0]["name"], "Ada Lovelace");
    assert!(item.get("rating").is_none());
    assert_eq!(item["languages"], serde_json::json!(["en", "en-US"]));
    assert_eq!(
        item["customMetadata"],
        serde_json::json!({"reading_state":"after_limit"})
    );
}

fn run_calibre_import(
    database: std::path::PathBuf,
    root: std::path::PathBuf,
) -> std::process::Output {
    cargo_bin_cmd!("takio")
        .args(["library", "import-calibre", "--db"])
        .arg(database)
        .args(["--library-root"])
        .arg(root)
        .output()
        .expect("run Calibre import")
}

fn assert_failure_code(output: &std::process::Output, code: &str) {
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("failure envelope");
    assert_eq!(envelope["error"]["code"], code);
}

fn create_calibre_fixture(path: &std::path::Path) {
    let database = Connection::open(path).expect("create Calibre metadata database");
    database
        .execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, series_index REAL, pubdate TEXT);
             CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, sort TEXT);
             CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
             CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
             CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
             CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT);
             CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER, lang_code INTEGER, item_order INTEGER);
             CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
             CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
             CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
             CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER);
             CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER, rating INTEGER);
             CREATE TABLE custom_columns (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
             CREATE TABLE custom_column_1 (id INTEGER PRIMARY KEY, book INTEGER, value TEXT);
             INSERT INTO books VALUES (1, 'Calibre Title', 'Author/Calibre Title (1)', 2.5, '2020-05-02 00:00:00+00:00');
             INSERT INTO authors VALUES (1, 'Ada Lovelace', 'Lovelace, Ada');
             INSERT INTO books_authors_link VALUES (1, 1, 1);
             INSERT INTO series VALUES (1, 'Analytical Engines');
             INSERT INTO books_series_link VALUES (1, 1, 1);
             INSERT INTO publishers VALUES (1, 'First Publisher');
             INSERT INTO books_publishers_link VALUES (1, 1, 1);
             INSERT INTO tags VALUES (1, 'Math'), (2, 'Computing');
             INSERT INTO books_tags_link VALUES (1, 1, 1), (2, 1, 2);
             INSERT INTO languages VALUES (1, 'en');
             INSERT INTO books_languages_link VALUES (1, 1, 1, 0);
             INSERT INTO identifiers VALUES (1, 1, 'isbn', '9780000000001');
             INSERT INTO comments VALUES (1, 1, 'Important description');
             INSERT INTO data VALUES (1, 1, 'EPUB', 'Calibre Title - Ada'), (2, 1, 'PDF', 'Calibre Title - Ada');
             INSERT INTO ratings VALUES (1, 4);
             INSERT INTO books_ratings_link VALUES (1, 1, 1);
             INSERT INTO custom_columns VALUES (1, 'Reading State', 'reading_state');
             INSERT INTO custom_column_1 VALUES (1, 1, 'planned');",
        )
        .expect("populate Calibre metadata database");
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
fn duplicate_review_commands_match_desktop_envelopes_through_cli_and_service() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let left = temp.path().join("left.epub");
    let right = temp.path().join("right.pdf");
    fs::write(&left, b"left").expect("write left ebook");
    fs::write(&right, b"right").expect("write right ebook");
    let import = |path: &std::path::Path| {
        let output = cargo_bin_cmd!("takio")
            .args(["library", "import", "--db"])
            .arg(&database)
            .args(["--source-path"])
            .arg(path)
            .output()
            .expect("import duplicate candidate");
        success_value(&output.stdout)["item"]["id"]
            .as_str()
            .expect("item id")
            .to_owned()
    };
    let left_id = import(&left);
    let right_id = import(&right);
    for id in [&left_id, &right_id] {
        let output = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args([
                "--id",
                id,
                "--patch-json",
                r#"{"identifiers":{"isbn":"desktop-shared"}}"#,
            ])
            .output()
            .expect("add duplicate identifier");
        assert!(output.status.success());
    }
    let list_request = serde_json::json!({
        "page":{"limit":20,"offset":0},
        "disposition":"unreviewed"
    });
    let listed = cargo_bin_cmd!("takio")
        .args(["library", "duplicates", "list", "--db"])
        .arg(&database)
        .args(["--request-json", &list_request.to_string()])
        .output()
        .expect("list duplicate candidates");
    assert!(listed.status.success());
    let page = success_value(&listed.stdout);
    assert_eq!(page["total"], 1);
    assert_eq!(page["page"], list_request["page"]);
    assert_eq!(page["scan"]["fingerprintsReused"], 2);
    let candidate = &page["candidates"][0];
    let review = serde_json::json!({
        "leftId":candidate["left"]["id"],
        "rightId":candidate["right"]["id"],
        "reviewToken":candidate["reviewToken"]
    });
    let requests = [
        serde_json::json!({"id":"keep-1","command":"library_duplicates_keep","args":review}),
        serde_json::json!({"id":"kept-page","command":"library_duplicates_list","args":{"page":{"limit":20,"offset":0},"disposition":"kept-both"}}),
        serde_json::json!({"id":"reopen-1","command":"library_duplicates_reopen","args":review}),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let service = cargo_bin_cmd!("takio")
        .args(["library", "service", "--db"])
        .arg(&database)
        .write_stdin(format!("{input}\n"))
        .output()
        .expect("run duplicate service requests");
    assert!(service.status.success());
    let responses = String::from_utf8(service.stdout)
        .expect("UTF-8 responses")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("service response"))
        .collect::<Vec<_>>();
    assert_eq!(
        responses[0],
        serde_json::json!({"id":"keep-1","ok":true,"value":null})
    );
    assert_eq!(responses[1]["value"]["total"], 1);
    assert_eq!(
        responses[2],
        serde_json::json!({"id":"reopen-1","ok":true,"value":null})
    );
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
    Connection::open(&database)
        .expect("open catalog database")
        .execute(
            "INSERT INTO library_item_custom_metadata(library_item_id,name,value) VALUES(?1,'takio_metadata_audit','private source path')",
            [id],
        )
        .expect("insert reserved audit fixture");

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
    assert!(book["customMetadata"].get("takio_metadata_audit").is_none());
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
    let csv = fs::read_to_string(&catalog).expect("read catalog");
    assert!(csv.contains("Kindred"));
    assert!(!csv.contains("private source path"));

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
fn virtual_libraries_constrain_session_queries_and_keep_saved_view_compatibility() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let books = [
        ("Classic Earthsea.txt", "Ursula K. Le Guin", "Classic"),
        ("Modern Earthsea.txt", "Ursula K. Le Guin", "Modern"),
        ("Classic Kindred.txt", "Octavia E. Butler", "Classic"),
    ];
    for (name, author, tag) in books {
        let source = temp.path().join(name);
        fs::write(&source, name.as_bytes()).expect("write source");
        let id = add_book(&database, &source);
        let patch = serde_json::json!({
            "authors":[{"name":author}],
            "tags":[tag]
        });
        let updated = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", &id, "--patch-json", &patch.to_string()])
            .output()
            .expect("update item");
        assert!(updated.status.success());
    }

    let definition = serde_json::json!({
        "id":"classics",
        "name":"Classics",
        "definition":{
            "version":1,
            "query":"",
            "filters":{"authors":[],"tags":["Classic"],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"}
        }
    });
    let saved = cargo_bin_cmd!("takio")
        .args(["library", "virtual-libraries", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &definition.to_string()])
        .output()
        .expect("save virtual library");
    assert!(saved.status.success());

    let legacy_list = cargo_bin_cmd!("takio")
        .args(["library", "saved-views", "list", "--db"])
        .arg(&database)
        .output()
        .expect("list legacy saved views");
    assert_eq!(
        success_value(&legacy_list.stdout)["views"][0]["id"],
        "classics"
    );

    let request = serde_json::json!({
        "virtualLibraryId":"classics",
        "query":"Earthsea",
        "filters":{"authors":["Ursula K. Le Guin"],"tags":[],"series":[],"languages":[],"formats":[]},
        "sort":{"field":"title","direction":"ascending"},
        "page":{"offset":0,"limit":25}
    });
    let queried = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &request.to_string()])
        .output()
        .expect("query virtual library");
    assert!(queried.status.success());
    let page = success_value(&queried.stdout);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["title"], "Classic Earthsea");
    assert_eq!(page["facets"]["tags"][0]["value"], "Classic");

    let mut incompatible = request.clone();
    incompatible["query"] = serde_json::json!("");
    incompatible["filters"]["authors"] = serde_json::json!([]);
    incompatible["filters"]["tags"] = serde_json::json!(["Modern"]);
    let empty = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &incompatible.to_string()])
        .output()
        .expect("combine virtual and session tag filters");
    assert_eq!(success_value(&empty.stdout)["total"], 0);

    let mut missing = request.clone();
    missing["virtualLibraryId"] = serde_json::json!("missing");
    let rejected = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &missing.to_string()])
        .output()
        .expect("reject missing virtual library");
    assert!(!rejected.status.success());
    assert_eq!(failure_code(&rejected.stdout), "not-found");
    assert!(rejected.stderr.is_empty());
}

#[test]
fn virtual_libraries_persist_independently_across_named_library_switches() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let data_home = temp.path().join("data");
    let run = |library: &str, arguments: &[&str]| {
        cargo_bin_cmd!("takio")
            .env("HOME", temp.path())
            .env("XDG_DATA_HOME", &data_home)
            .env("LOCALAPPDATA", &data_home)
            .env("APPDATA", &data_home)
            .args(["--library", library, "library"])
            .args(arguments)
            .output()
            .expect("run named library command")
    };
    for (library, name, query) in [
        ("alpha", "Alpha shelf", "Alpha"),
        ("beta", "Beta shelf", "Beta"),
    ] {
        let request = serde_json::json!({
            "id":"shelf",
            "name":name,
            "definition":{
                "version":1,
                "query":query,
                "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
                "sort":{"field":"title","direction":"ascending"}
            }
        });
        let saved = run(
            library,
            &[
                "virtual-libraries",
                "save",
                "--request-json",
                &request.to_string(),
            ],
        );
        assert!(saved.status.success());
        assert!(saved.stderr.is_empty());
    }

    let alpha = run("alpha", &["virtual-libraries", "list"]);
    let beta = run("beta", &["virtual-libraries", "list"]);
    assert_eq!(
        success_value(&alpha.stdout)["views"][0]["name"],
        "Alpha shelf"
    );
    assert_eq!(
        success_value(&alpha.stdout)["views"][0]["definition"]["query"],
        "Alpha"
    );
    assert_eq!(
        success_value(&beta.stdout)["views"][0]["name"],
        "Beta shelf"
    );
    assert_eq!(
        success_value(&beta.stdout)["views"][0]["definition"]["query"],
        "Beta"
    );
}

#[test]
fn structured_queries_are_explicit_bounded_and_compose_with_virtual_libraries() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    for (file, title, author, tag, publisher) in [
        (
            "earthsea.txt",
            "Classic Earthsea",
            "Ursula K. Le Guin",
            "Classic",
            "Parnassus",
        ),
        (
            "modern.txt",
            "Modern Earthsea",
            "Ursula K. Le Guin",
            "Modern",
            "Tor",
        ),
        (
            "kindred.txt",
            "Classic Kindred",
            "Octavia E. Butler",
            "Classic",
            "Beacon",
        ),
    ] {
        let source = temp.path().join(file);
        fs::write(&source, file).expect("write source");
        let id = add_book(&database, &source);
        let patch = serde_json::json!({
            "title":title,
            "authors":[{"name":author}],
            "tags":[tag],
            "publisher":publisher
        });
        let updated = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", &id, "--patch-json", &patch.to_string()])
            .output()
            .expect("update item");
        assert!(updated.status.success());
    }

    let definition = serde_json::json!({
        "id":"classics",
        "name":"Classics",
        "definition":{
            "version":1,
            "querySyntax":"structured-v1",
            "query":"tag:Classic",
            "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"}
        }
    });
    let saved = cargo_bin_cmd!("takio")
        .args(["library", "virtual-libraries", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &definition.to_string()])
        .output()
        .expect("save structured virtual library");
    assert!(saved.status.success());

    let mut invalid_definition = definition.clone();
    invalid_definition["id"] = serde_json::json!("invalid");
    invalid_definition["definition"]["query"] = serde_json::json!("author:\"unfinished");
    let rejected_definition = cargo_bin_cmd!("takio")
        .args(["library", "virtual-libraries", "save", "--db"])
        .arg(&database)
        .args(["--request-json", &invalid_definition.to_string()])
        .output()
        .expect("reject malformed structured virtual library");
    assert!(!rejected_definition.status.success());
    assert_eq!(failure_code(&rejected_definition.stdout), "invalid-query");
    assert!(rejected_definition.stderr.is_empty());

    let structured = serde_json::json!({
        "virtualLibraryId":"classics",
        "querySyntax":"structured-v1",
        "query":"author:\"Ursula K. Le Guin\" not publisher:Tor",
        "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
        "sort":{"field":"title","direction":"ascending"},
        "page":{"offset":0,"limit":25}
    });
    let queried = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &structured.to_string()])
        .output()
        .expect("run structured query");
    assert!(queried.status.success());
    assert!(queried.stderr.is_empty());
    let page = success_value(&queried.stdout);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["title"], "Classic Earthsea");

    let mut literal = structured.clone();
    literal.as_object_mut().unwrap().remove("virtualLibraryId");
    literal.as_object_mut().unwrap().remove("querySyntax");
    literal["query"] = serde_json::json!("author:\"Ursula K. Le Guin\"");
    let literal_result = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &literal.to_string()])
        .output()
        .expect("preserve literal query behavior");
    assert_eq!(success_value(&literal_result.stdout)["total"], 0);

    for malformed in [
        "author:\"unfinished",
        "unknown:value",
        "author:LeGuin or author:Butler",
        "not",
    ] {
        let mut request = structured.clone();
        request.as_object_mut().unwrap().remove("virtualLibraryId");
        request["query"] = serde_json::json!(malformed);
        let rejected = cargo_bin_cmd!("takio")
            .args(["library", "query", "--db"])
            .arg(&database)
            .args(["--request-json", &request.to_string()])
            .output()
            .expect("reject malformed structured query");
        assert!(!rejected.status.success());
        assert_eq!(failure_code(&rejected.stdout), "invalid-query");
        assert!(rejected.stderr.is_empty());
    }

    let mut null_syntax = structured;
    null_syntax
        .as_object_mut()
        .unwrap()
        .remove("virtualLibraryId");
    null_syntax["querySyntax"] = Value::Null;
    null_syntax["query"] = serde_json::json!("");
    let rejected = cargo_bin_cmd!("takio")
        .args(["library", "query", "--db"])
        .arg(&database)
        .args(["--request-json", &null_syntax.to_string()])
        .output()
        .expect("reject null query syntax");
    assert!(!rejected.status.success());
    assert_eq!(failure_code(&rejected.stdout), "invalid-arguments");
    assert!(rejected.stderr.is_empty());
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

#[test]
fn standalone_filename_candidates_remain_valid_without_an_item_id() {
    let output = cargo_bin_cmd!("takio")
        .args([
            "metadata",
            "candidates",
            "filename",
            "--source-path",
            "Ursula K. Le Guin - The Tombs of Atuan.epub",
        ])
        .output()
        .expect("derive filename metadata without an item");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["candidates"][0]["provenance"]["itemId"], Value::Null);
    assert_eq!(
        value["candidates"][0]["patch"]["title"],
        "The Tombs of Atuan"
    );
}

#[test]
fn item_filename_candidates_use_the_import_title_after_managed_publication() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    let fetched = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("read managed item");
    let source_path = success_value(&fetched.stdout)["item"]["sourcePath"].clone();

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "item", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("derive item filename metadata");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    let candidate = &value["candidates"][0];
    assert_eq!(candidate["patch"]["title"], "Real Title");
    assert_eq!(candidate["patch"]["author"], "Ada Writer");
    assert_eq!(candidate["provenance"]["itemId"], id);
    assert_eq!(candidate["provenance"]["sourcePath"], source_path);
}

fn seed_candidate_library(temp: &std::path::Path) -> (std::path::PathBuf, String) {
    let database = temp.join("library.sqlite");
    let book = temp.join("Ada Writer - Real Title.epub");
    fs::write(&book, b"book").expect("write ebook");
    let output = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .arg("--source-path")
        .arg(&book)
        .output()
        .expect("import ebook");
    let id = success_value(&output.stdout)["item"]["id"]
        .as_str()
        .expect("item id")
        .to_owned();
    (database, id)
}

fn candidate_for(item_id: &str) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "id": "filename:1",
        "source": "filename",
        "confidence": "medium",
        "patch": {"title": "Applied Title"},
        "provenance": {
            "generatedAt": "1970-01-01T00:00:00.000Z",
            "itemId": item_id,
            "sourcePath": "/Books/book.epub",
            "pattern": "(?<title>.+)"
        }
    })
}

#[cfg(unix)]
#[test]
fn embedded_candidate_cover_is_path_free_and_applies_with_bounded_audit() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    let backend = temp.path().join("ebook-meta-with-cover");
    write_executable(
        &backend,
        "#!/bin/sh\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    --to-opf=*) opf=${argument#--to-opf=} ;;\n    --get-cover=*) cover=${argument#--get-cover=} ;;\n  esac\ndone\ncat > \"$opf\" <<'EOF'\n<?xml version=\"1.0\"?><package xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><metadata><dc:title>Embedded cover title</dc:title></metadata></package>\nEOF\nprintf '\\377\\330\\377cover-bytes' > \"$cover\"\n",
    );

    let discovered = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "item", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .env("TAKIO_EBOOK_META", &backend)
        .output()
        .expect("discover embedded candidate cover");
    assert!(discovered.status.success());
    assert!(discovered.stderr.is_empty());
    let discovery = success_value(&discovered.stdout);
    let candidate = discovery["candidates"]
        .as_array()
        .and_then(|candidates| {
            candidates
                .iter()
                .find(|candidate| candidate["source"] == "embedded")
        })
        .cloned()
        .expect("embedded candidate");
    let descriptor = candidate["cover"].clone();
    assert!(descriptor["artifactId"].as_str().is_some());
    assert!(
        candidate.to_string().find("candidate-covers").is_none(),
        "candidate contracts must not expose staging paths"
    );

    let applied = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--candidate-json",
            &candidate.to_string(),
            "--cover",
            "--provenance",
            "cli-candidate-review:embedded",
        ])
        .output()
        .expect("apply embedded candidate cover");
    assert!(
        applied.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&applied.stdout)
    );
    assert!(applied.stderr.is_empty());
    let value = success_value(&applied.stdout);
    assert_eq!(value["applied"]["coverApplied"], true);
    assert_eq!(
        value["applied"]["cover"],
        serde_json::json!({
            "mediaType": descriptor["mediaType"],
            "extension": descriptor["extension"],
            "bytes": descriptor["bytes"],
            "sha256": descriptor["sha256"]
        })
    );
    assert_eq!(value["item"]["title"], "Embedded cover title");
    let cover_path = value["item"]["coverPath"]
        .as_str()
        .map(std::path::PathBuf::from)
        .expect("durable cover path");
    assert_eq!(
        fs::read(&cover_path).expect("durable cover bytes"),
        b"\xff\xd8\xffcover-bytes"
    );

    let audit = value["item"]["customMetadata"]["takio_metadata_audit"]
        .as_str()
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok())
        .expect("candidate audit");
    assert_eq!(audit["cover"]["sha256"], descriptor["sha256"]);
    assert!(audit.get("artifactId").is_none());
    assert!(audit.to_string().find("candidate-covers").is_none());
    let staged = database.parent().unwrap().join("candidate-covers");
    assert_eq!(
        fs::read_dir(staged)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != ".stage.lock")
            .count(),
        0
    );
}

#[test]
fn candidate_apply_rejects_a_candidate_bound_to_another_item_before_mutating() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--candidate-json",
            &candidate_for("some-other-item").to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("apply cross-item candidate");

    assert_eq!(failure_code(&output.stdout), "invalid-arguments");

    let fetched = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("read item back");
    let item = success_value(&fetched.stdout)["item"].clone();
    assert_ne!(item["title"], "Applied Title");
    assert_eq!(item["customMetadata"], Value::Null);
}

#[test]
fn candidate_apply_durably_records_bounded_provenance_in_custom_metadata() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());

    let seeded = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--patch-json",
            r#"{"customMetadata":{"shelf":"office"}}"#,
        ])
        .output()
        .expect("seed custom metadata");
    assert!(seeded.status.success());

    let mut candidate = candidate_for(&id);
    candidate["patch"]["customMetadata"] = serde_json::json!({"shelf": "study"});
    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--candidate-json",
            &candidate.to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("apply candidate");

    assert!(output.status.success());
    let value = success_value(&output.stdout);
    assert_eq!(value["applied"]["itemId"], id.as_str());
    assert_eq!(value["applied"]["candidateId"], "filename:1");
    assert_eq!(value["item"]["title"], "Applied Title");

    // Candidate-selected custom metadata must not erase the audit entry.
    let recorded = value["item"]["customMetadata"]["takio_metadata_audit"]
        .as_str()
        .expect("durable audit entry");
    assert_eq!(value["item"]["customMetadata"]["shelf"], "study");
    let audit: Value = serde_json::from_str(recorded).expect("audit is JSON");
    assert_eq!(audit["schemaVersion"], 1);
    assert_eq!(audit["candidateId"], "filename:1");
    assert_eq!(audit["source"], "filename");
    assert_eq!(audit["confidence"], "medium");
    assert_eq!(audit["candidateProvenance"]["itemId"], id.as_str());
    assert_eq!(
        audit["applicationProvenance"],
        "desktop-candidate-review:filename"
    );
    let fields = audit["selectedFields"]
        .as_array()
        .expect("selected fields")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert!(fields.contains(&"title"));
    assert!(fields.contains(&"customMetadata"));

    // The audit survives a later read of the persisted row.
    let fetched = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("read item back");
    assert_eq!(
        success_value(&fetched.stdout)["item"]["customMetadata"]["takio_metadata_audit"],
        recorded
    );
}

#[test]
fn metadata_patch_distinguishes_missing_from_explicit_null() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());

    let update = |patch: &str| {
        cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", &id, "--patch-json", patch])
            .output()
            .expect("update item")
    };

    assert!(
        update(
            r#"{"series":"Earthsea","seriesIndex":2,"publisher":"Press","rating":7,
                "description":"Text","publishedDate":"2001","languages":["en"],
                "identifiers":{"isbn":"123"},"customMetadata":{"shelf":"office"},
                "authors":[{"name":"Ada Writer"}],"tags":["fiction"]}"#
        )
        .status
        .success()
    );

    // Missing fields leave stored values untouched.
    let untouched = success_value(&update(r#"{"title":"Kept"}"#).stdout)["item"].clone();
    assert_eq!(untouched["series"], "Earthsea");
    assert_eq!(untouched["languages"][0], "en");
    assert_eq!(untouched["identifiers"]["isbn"], "123");

    // Explicit nulls clear every nullable field the contract allows.
    let cleared = success_value(
        &update(
            r#"{"author":null,"authors":null,"series":null,"seriesIndex":null,"publisher":null,
                "languages":null,"identifiers":null,"customMetadata":null,"publishedDate":null,
                "rating":null,"description":null}"#,
        )
        .stdout,
    )["item"]
        .clone();
    for field in [
        "author",
        "authors",
        "series",
        "seriesIndex",
        "publisher",
        "languages",
        "identifiers",
        "customMetadata",
        "publishedDate",
        "rating",
        "description",
    ] {
        assert_eq!(cleared[field], Value::Null, "{field} should be cleared");
    }
    assert_eq!(cleared["tags"][0], "fiction");
    assert_eq!(cleared["title"], "Kept");

    // Non-nullable and empty-array-invalid fields are client errors.
    assert_eq!(
        failure_code(&update(r#"{"tags":null}"#).stdout),
        "invalid-arguments"
    );
    assert_eq!(
        failure_code(&update(r#"{"title":null}"#).stdout),
        "invalid-arguments"
    );
    assert_eq!(
        failure_code(&update(r#"{"authors":[]}"#).stdout),
        "invalid-arguments"
    );
    assert_eq!(
        failure_code(&update(r#"{"languages":[]}"#).stdout),
        "invalid-arguments"
    );
    assert_eq!(failure_code(&update("{}").stdout), "invalid-arguments");

    // `tags` clears through an empty array, as the contract allows.
    let untagged = success_value(&update(r#"{"tags":[]}"#).stdout)["item"].clone();
    assert_eq!(untagged["tags"].as_array().expect("tags").len(), 0);
}

#[test]
fn candidate_apply_honors_custom_metadata_patch_semantics_and_always_records_the_audit() {
    let apply = |database: &std::path::Path, id: &str, candidate: &Value| {
        let output = cargo_bin_cmd!("takio")
            .args(["metadata", "candidates", "apply", "--db"])
            .arg(database)
            .args([
                "--id",
                id,
                "--candidate-json",
                &candidate.to_string(),
                "--provenance",
                "desktop-candidate-review:filename",
            ])
            .output()
            .expect("apply candidate");
        assert!(output.status.success());
        success_value(&output.stdout)["item"]["customMetadata"].clone()
    };
    let seed = |database: &std::path::Path, id: &str| {
        let output = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(database)
            .args([
                "--id",
                id,
                "--patch-json",
                r#"{"customMetadata":{"shelf":"office"}}"#,
            ])
            .output()
            .expect("seed custom metadata");
        assert!(output.status.success());
    };

    // Missing preserves existing entries.
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    seed(&database, &id);
    let preserved = apply(&database, &id, &candidate_for(&id));
    assert_eq!(preserved["shelf"], "office");
    assert!(preserved["takio_metadata_audit"].is_string());

    // Null clears existing entries but keeps the audit.
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    seed(&database, &id);
    let mut cleared_candidate = candidate_for(&id);
    cleared_candidate["patch"]["customMetadata"] = Value::Null;
    let cleared = apply(&database, &id, &cleared_candidate);
    assert_eq!(cleared["shelf"], Value::Null);
    assert!(cleared["takio_metadata_audit"].is_string());

    // Set replaces existing entries and still keeps the audit.
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    seed(&database, &id);
    let mut replaced_candidate = candidate_for(&id);
    replaced_candidate["patch"]["customMetadata"] = serde_json::json!({"room": "study"});
    let replaced = apply(&database, &id, &replaced_candidate);
    assert_eq!(replaced["shelf"], Value::Null);
    assert_eq!(replaced["room"], "study");
    assert!(replaced["takio_metadata_audit"].is_string());
}

#[test]
fn candidate_audit_does_not_consume_user_custom_metadata_capacity() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    let metadata = (0..64)
        .map(|index| {
            (
                format!("field_{index}"),
                serde_json::json!(format!("value-{index}")),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let seeded = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--patch-json",
            &serde_json::json!({"customMetadata": metadata}).to_string(),
        ])
        .output()
        .expect("seed full custom metadata");
    assert!(seeded.status.success());

    let candidate = candidate_for(&id);
    let applied = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--candidate-json",
            &candidate.to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("apply candidate at user capacity");
    assert!(applied.status.success());
    let value = success_value(&applied.stdout);
    let custom = value["item"]["customMetadata"]
        .as_object()
        .expect("custom metadata");
    assert_eq!(custom.len(), 65);
    assert!(custom.contains_key("takio_metadata_audit"));
}

#[test]
fn candidate_apply_rejects_malformed_candidate_records() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    let reject = |candidate: Value| {
        let output = cargo_bin_cmd!("takio")
            .args(["metadata", "candidates", "apply", "--db"])
            .arg(&database)
            .args([
                "--id",
                &id,
                "--candidate-json",
                &candidate.to_string(),
                "--provenance",
                "desktop-candidate-review:filename",
            ])
            .output()
            .expect("apply malformed candidate");
        assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    };

    let mut without_id = candidate_for(&id);
    without_id["id"] = Value::Null;
    reject(without_id);

    let mut bad_source = candidate_for(&id);
    bad_source["source"] = serde_json::json!("manual");
    reject(bad_source);

    let mut bad_confidence = candidate_for(&id);
    bad_confidence["confidence"] = serde_json::json!("certain");
    reject(bad_confidence);

    let mut null_item = candidate_for(&id);
    null_item["provenance"]["itemId"] = Value::Null;
    reject(null_item);

    let mut string_provenance = candidate_for(&id);
    string_provenance["provenance"] = serde_json::json!("filename");
    reject(string_provenance);

    let mut empty_patch = candidate_for(&id);
    empty_patch["patch"] = serde_json::json!({});
    reject(empty_patch);

    let mut wrong_version = candidate_for(&id);
    wrong_version["schemaVersion"] = serde_json::json!(2);
    reject(wrong_version);

    let mut unknown_key = candidate_for(&id);
    unknown_key["coverPath"] = serde_json::json!("/tmp/cover.jpg");
    reject(unknown_key);

    let mut unknown_provenance_key = candidate_for(&id);
    unknown_provenance_key["provenance"]["executable"] = serde_json::json!("sh");
    reject(unknown_provenance_key);

    let mut bad_generated_at = candidate_for(&id);
    bad_generated_at["provenance"]["generatedAt"] = serde_json::json!("yesterday");
    reject(bad_generated_at);

    let mut bad_backend = candidate_for(&id);
    bad_backend["provenance"]["backend"] = serde_json::json!("sh");
    reject(bad_backend);

    let mut bad_published_date = candidate_for(&id);
    bad_published_date["patch"]["publishedDate"] = serde_json::json!("yesterday");
    reject(bad_published_date);

    let mut bad_custom_key = candidate_for(&id);
    bad_custom_key["patch"]["customMetadata"] = serde_json::json!({"Bad Key": "poison"});
    reject(bad_custom_key);

    let mut bad_language = candidate_for(&id);
    bad_language["patch"]["languages"] = serde_json::json!(["not_a_language"]);
    reject(bad_language);

    let fetched = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("read item after rejected candidates");
    let item = success_value(&fetched.stdout)["item"].clone();
    assert_eq!(item["title"], "Ada Writer - Real Title");
    assert_eq!(item["publishedDate"], Value::Null);
    assert_eq!(item["customMetadata"], Value::Null);
}

#[test]
fn ordinary_updates_cannot_forge_or_erase_candidate_audit_metadata() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let (database, id) = seed_candidate_library(temp.path());
    let candidate = candidate_for(&id);
    let applied = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--candidate-json",
            &candidate.to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("apply candidate");
    assert!(applied.status.success());
    let audit =
        success_value(&applied.stdout)["item"]["customMetadata"]["takio_metadata_audit"].clone();

    let cleared = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args(["--id", &id, "--patch-json", r#"{"customMetadata":null}"#])
        .output()
        .expect("clear user custom metadata");
    assert!(cleared.status.success());
    assert_eq!(
        success_value(&cleared.stdout)["item"]["customMetadata"]["takio_metadata_audit"],
        audit
    );

    let forged = cargo_bin_cmd!("takio")
        .args(["library", "update", "--db"])
        .arg(&database)
        .args([
            "--id",
            &id,
            "--patch-json",
            r#"{"customMetadata":{"takio_metadata_audit":"forged"}}"#,
        ])
        .output()
        .expect("attempt to forge audit metadata");
    assert_eq!(failure_code(&forged.stdout), "invalid-arguments");

    for patch in [
        r#"{"publishedDate":"yesterday"}"#,
        r#"{"customMetadata":{"Bad Key":"poison"}}"#,
        r#"{"languages":["not_a_language"]}"#,
    ] {
        let rejected = cargo_bin_cmd!("takio")
            .args(["library", "update", "--db"])
            .arg(&database)
            .args(["--id", &id, "--patch-json", patch])
            .output()
            .expect("reject invalid metadata update");
        assert_eq!(failure_code(&rejected.stdout), "invalid-arguments");
    }

    let fetched = cargo_bin_cmd!("takio")
        .args(["library", "get", "--db"])
        .arg(&database)
        .args(["--id", &id])
        .output()
        .expect("read protected audit metadata");
    let item = success_value(&fetched.stdout)["item"].clone();
    assert_eq!(item["customMetadata"]["takio_metadata_audit"], audit);
    assert_eq!(item["publishedDate"], Value::Null);
}

#[test]
fn malformed_candidate_apply_never_creates_a_library_as_a_side_effect() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let candidate = candidate_for("book-1");

    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            "book-2",
            "--candidate-json",
            &candidate.to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("apply cross-item candidate against a missing library");

    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(
        !database.exists(),
        "no library may be created by rejected input"
    );

    let mut invalid_value = candidate_for("book-1");
    invalid_value["patch"]["publishedDate"] = serde_json::json!("yesterday");
    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            "book-1",
            "--candidate-json",
            &invalid_value.to_string(),
            "--provenance",
            "desktop-candidate-review:filename",
        ])
        .output()
        .expect("reject invalid candidate value against a missing library");
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(
        !database.exists(),
        "invalid candidate values must be rejected before library creation"
    );

    let mut invalid_cover = candidate_for("book-1");
    invalid_cover["cover"] = serde_json::json!({
        "artifactId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "mediaType": "image/jpeg",
        "extension": ".jpg",
        "bytes": 4,
        "sha256": "0".repeat(64)
    });
    let output = cargo_bin_cmd!("takio")
        .args(["metadata", "candidates", "apply", "--db"])
        .arg(&database)
        .args([
            "--id",
            "book-1",
            "--candidate-json",
            &invalid_cover.to_string(),
            "--cover",
            "--provenance",
            "desktop-candidate-review:embedded",
        ])
        .output()
        .expect("reject malformed cover descriptor against a missing library");
    assert_eq!(failure_code(&output.stdout), "invalid-arguments");
    assert!(output.stderr.is_empty());
    assert!(
        !database.exists(),
        "malformed cover descriptors must be rejected before library creation"
    );
}

#[test]
fn send_delivers_to_the_default_kobo_mount_root() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let database = temp.path().join("library.sqlite");
    let source = temp.path().join("Kindred.epub");
    fs::write(&source, b"device delivery bytes").expect("write source ebook");
    let imported = cargo_bin_cmd!("takio")
        .args(["library", "import", "--db"])
        .arg(&database)
        .args(["--source-path"])
        .arg(&source)
        .args(["--title", "Kindred"])
        .output()
        .expect("import ebook");
    let item_id = success_value(&imported.stdout)["item"]["id"]
        .as_str()
        .expect("item id")
        .to_owned();

    let volumes = temp.path().join("Volumes");
    let kobo = volumes.join("Kobo Reader");
    fs::create_dir_all(kobo.join(".kobo")).expect("create Kobo mount marker");
    let sent = cargo_bin_cmd!("takio")
        .args(["send", "--db"])
        .arg(&database)
        .args(["--id", &item_id, "--format", "epub", "--dest"])
        .arg(&kobo)
        .args(["--volumes-root"])
        .arg(&volumes)
        .output()
        .expect("send ebook");

    assert!(
        sent.status.success(),
        "{}",
        String::from_utf8_lossy(&sent.stdout)
    );
    assert!(sent.stderr.is_empty());
    let delivery = success_value(&sent.stdout);
    assert_eq!(delivery["itemId"], item_id);
    let delivered_path = delivery["path"].as_str().expect("delivery path");
    assert_eq!(
        fs::read(delivered_path).expect("read delivered ebook"),
        b"device delivery bytes"
    );

    let inventory = cargo_bin_cmd!("takio")
        .args(["destination", "inventory", "--dest"])
        .arg(&kobo)
        .args(["--volumes-root"])
        .arg(&volumes)
        .output()
        .expect("inventory Kobo");
    assert!(inventory.status.success());
    assert_eq!(
        success_value(&inventory.stdout)["entries"][0]["status"],
        "present"
    );
}
