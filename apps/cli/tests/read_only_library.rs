use std::fs;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::Value;

fn read_commands() -> Vec<Vec<&'static str>> {
    vec![
        vec!["list"],
        vec!["get", "--id", "missing"],
        vec!["search", "--query", "book"],
        vec!["query", "--request-json", "{}"],
        vec!["trash", "list"],
        vec!["verify"],
        vec!["saved-views", "list"],
        vec!["custom-columns", "list"],
    ]
}

#[test]
fn read_only_cli_commands_do_not_create_missing_library() {
    for args in read_commands() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("missing/library.sqlite");
        let output = cargo_bin_cmd!("takio")
            .arg("library")
            .args(&args)
            .arg("--db")
            .arg(&database)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "storage-unavailable", "{args:?}");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0, "{args:?}");
    }
}

#[test]
fn read_only_cli_commands_do_not_migrate_legacy_library() {
    for args in read_commands() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("library.sqlite");
        takio::test_support::legacy_schema_v1(&database).unwrap();
        let before = fs::read(&database).unwrap();
        let output = cargo_bin_cmd!("takio")
            .arg("library")
            .args(&args)
            .arg("--db")
            .arg(&database)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "incompatible-schema", "{args:?}");
        assert_eq!(fs::read(&database).unwrap(), before, "{args:?}");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1, "{args:?}");
    }
}
