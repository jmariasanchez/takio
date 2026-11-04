#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn check_relative_backend(explicit: Option<&str>, path_entry: Option<&str>) {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("caller");
    let adversary = temp.path().join("adversary");
    fs::create_dir_all(cwd.join("bin")).unwrap();
    fs::create_dir(&adversary).unwrap();
    let marker = temp.path().join("wrong-backend-ran");
    let name = "fetch-ebook-metadata";
    let approved = cwd.join(
        if explicit.is_some_and(|path| path.contains('/')) || path_entry == Some("bin") {
            "bin/fetch-ebook-metadata"
        } else {
            name
        },
    );
    fs::write(
        &approved,
        "#!/bin/sh\nprintf '<package><metadata><title>Approved</title></metadata></package>'\n",
    )
    .unwrap();
    let wrong = adversary.join(name);
    fs::write(&wrong, format!("#!/bin/sh\nprintf wrong > '{}'\nprintf '<package><metadata><title>Wrong</title></metadata></package>'\n", marker.display())).unwrap();
    for path in [&approved, &wrong] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let search = std::env::join_paths(
        path_entry
            .map(std::path::Path::new)
            .into_iter()
            .chain([adversary.as_path()]),
    )
    .unwrap();
    let command = || {
        let mut command = cargo_bin_cmd!("takio");
        command
            .current_dir(&cwd)
            .env(
                takio::library::paths::TAKIO_DATA_DIR,
                temp.path().join("isolated-library"),
            )
            .env("PATH", &search)
            .env_remove("TAKIO_FETCH_EBOOK_METADATA");
        if let Some(explicit) = explicit {
            command.env("TAKIO_FETCH_EBOOK_METADATA", explicit);
        }
        command
    };
    let result = command()
        .args(["metadata", "fetch", "--title", "Fixture"])
        .output()
        .unwrap();
    let envelope: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(result.status.success(), "{envelope}");
    assert_eq!(envelope["value"]["metadata"]["title"], "Approved");
    assert!(
        !marker.exists(),
        "must not execute same-name backend on PATH"
    );
    let capabilities = command().arg("capabilities").output().unwrap();
    assert!(capabilities.status.success());
    let envelope: Value = serde_json::from_slice(&capabilities.stdout).unwrap();
    assert_eq!(
        envelope["value"]["backends"]["fetchEbookMetadata"],
        json!({
            "available": true,
            "path": approved.canonicalize().unwrap(),
        })
    );
}

#[test]
fn relative_bare_override_cannot_execute_path_impostor() {
    check_relative_backend(Some("fetch-ebook-metadata"), None);
}

#[test]
fn relative_nested_override_survives_backend_workspace_change() {
    check_relative_backend(Some("bin/fetch-ebook-metadata"), None);
}

#[test]
fn relative_path_entry_survives_backend_workspace_change() {
    check_relative_backend(None, Some("bin"));
}

#[test]
fn empty_path_entry_cannot_execute_path_impostor() {
    check_relative_backend(None, Some(""));
}

#[test]
fn invalid_explicit_override_refuses_valid_path_backend() {
    let temp = tempfile::tempdir().unwrap();
    let backend = temp.path().join("fetch-ebook-metadata");
    let marker = temp.path().join("must-not-run");
    fs::write(
        &backend,
        format!("#!/bin/sh\nprintf wrong > '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&backend, fs::Permissions::from_mode(0o700)).unwrap();
    for invalid in ["missing", "blocked", ""] {
        fs::write(temp.path().join("blocked"), b"not executable").unwrap();
        fs::set_permissions(
            temp.path().join("blocked"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let result = cargo_bin_cmd!("takio")
            .current_dir(temp.path())
            .env(
                takio::library::paths::TAKIO_DATA_DIR,
                temp.path().join("isolated-library"),
            )
            .env("PATH", temp.path())
            .env("TAKIO_FETCH_EBOOK_METADATA", invalid)
            .args(["metadata", "fetch", "--title", "Fixture"])
            .output()
            .unwrap();
        assert!(!result.status.success());
        let envelope: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "backend-unavailable");
        assert!(!marker.exists());
    }
}

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
            .env(
                takio::library::paths::TAKIO_DATA_DIR,
                temp.path().join("isolated-library"),
            )
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
