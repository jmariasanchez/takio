#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[test]
fn fetched_cover_publication_keeps_json_bytes_and_existing_outputs() {
    let temp = tempfile::tempdir().unwrap();
    let backend = temp.path().join("fetch-ebook-metadata");
    fs::write(
        &backend,
        r#"#!/bin/sh
for arg in "$@"; do
    case "$arg" in
        --cover=*) printf '\377\330\377\001\002\003' > "${arg#--cover=}" ;;
    esac
done
printf '<package><metadata><title>Fixture</title></metadata></package>'
"#,
    )
    .unwrap();
    fs::set_permissions(&backend, fs::Permissions::from_mode(0o700)).unwrap();
    let output = temp.path().join("published.jpg");
    let run = || {
        cargo_bin_cmd!("takio")
            .env("TAKIO_FETCH_EBOOK_METADATA", &backend)
            .env("TAKIO_DATA_DIR", temp.path().join("isolated-library"))
            .args(["metadata", "fetch", "--title", "Fixture", "--cover-output"])
            .arg(&output)
            .output()
            .unwrap()
    };
    let result = run();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    let envelope: Value = serde_json::from_slice(&result.stdout).unwrap();
    let bytes = [0xff, 0xd8, 0xff, 1, 2, 3];
    assert_eq!(
        envelope["value"]["cover"],
        json!({
            "path": output,
            "mediaType": "image/jpeg",
            "extension": ".jpg",
            "bytes": bytes.len(),
            "sha256": hex::encode(Sha256::digest(bytes)),
        })
    );
    assert_eq!(envelope["value"]["metadata"]["title"], "Fixture");
    assert!(envelope["value"].get("cover_data").is_none());
    assert_eq!(fs::read(&output).unwrap(), bytes);

    let repeated = run();
    assert!(!repeated.status.success());
    let envelope: Value = serde_json::from_slice(&repeated.stdout).unwrap();
    assert_eq!(envelope["error"]["code"], "cover-output-exists");
    assert_eq!(fs::read(&output).unwrap(), bytes);
}
