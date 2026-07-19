use std::path::Path;

use serde_json::{json, Value};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const ENGINE_NAME: &str = "takio-library-engine";
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

fn failure(code: &str) -> Value {
    json!({ "ok": false, "error": { "code": code } })
}

fn validate_file_source(path: &Path) -> Result<(), ()> {
    match path.metadata() {
        Ok(metadata) if metadata.is_file() => Ok(()),
        _ => Err(()),
    }
}

fn validate_nonempty(value: &str) -> Result<(), ()> {
    if value.trim().is_empty() {
        Err(())
    } else {
        Ok(())
    }
}

fn library_open_arguments(id: String) -> Vec<String> {
    vec![
        "library".into(),
        "open".into(),
        "--id".into(),
        id,
        "--json".into(),
    ]
}

fn destination_list_arguments() -> Vec<String> {
    vec!["destination".into(), "list".into()]
}

fn destination_send_arguments(id: String, destination_path: String) -> Vec<String> {
    vec![
        "send".into(),
        "--id".into(),
        id,
        "--dest".into(),
        destination_path,
    ]
}

fn destination_eject_arguments(destination_path: String) -> Vec<String> {
    vec![
        "destination".into(),
        "eject".into(),
        "--dest".into(),
        destination_path,
    ]
}

fn update_arguments(
    id: String,
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
) -> Vec<String> {
    let mut args = vec!["library".into(), "update".into(), "--id".into(), id];
    for (flag, value) in [
        ("--title", title),
        ("--author", author),
        ("--description", description),
    ] {
        if let Some(value) = value {
            args.push(flag.into());
            args.push(value);
        }
    }
    for tag in tags {
        args.push("--tag".into());
        args.push(tag);
    }
    args
}

fn parse_engine_record(exit_code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> Value {
    if stdout.len() > MAX_OUTPUT_BYTES || stderr.len() > MAX_OUTPUT_BYTES || !stderr.is_empty() {
        return failure("protocol-error");
    }

    let Ok(record) = serde_json::from_slice::<Value>(stdout) else {
        return failure("protocol-error");
    };
    let Some(ok) = record.get("ok").and_then(Value::as_bool) else {
        return failure("protocol-error");
    };
    let has_payload = if ok {
        record.get("value").is_some()
    } else {
        record
            .pointer("/error/code")
            .and_then(Value::as_str)
            .is_some()
    };

    let exit_matches_record = match exit_code {
        Some(0) => ok,
        Some(_) => !ok,
        None => false,
    };

    if has_payload && exit_matches_record {
        record
    } else {
        failure("protocol-error")
    }
}

async fn run_engine(app: &tauri::AppHandle, args: Vec<String>) -> Value {
    let command = match app.shell().sidecar(ENGINE_NAME) {
        Ok(command) => command,
        Err(_) => return failure("engine-unavailable"),
    };
    let (mut events, child) = match command.args(args).spawn() {
        Ok(process) => process,
        Err(_) => return failure("engine-unavailable"),
    };
    let mut child = Some(child);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;

    while let Some(event) = events.recv().await {
        let chunk = match event {
            CommandEvent::Stdout(chunk) => Some((&mut stdout, chunk)),
            CommandEvent::Stderr(chunk) => Some((&mut stderr, chunk)),
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(_) => {
                if let Some(child) = child.take() {
                    let _ = child.kill();
                }
                return failure("protocol-error");
            }
            _ => None,
        };

        if let Some((output, mut bytes)) = chunk {
            if output.len() + bytes.len() > MAX_OUTPUT_BYTES {
                if let Some(child) = child.take() {
                    let _ = child.kill();
                }
                return failure("protocol-error");
            }
            output.append(&mut bytes);
        }
    }

    parse_engine_record(exit_code, &stdout, &stderr)
}

#[tauri::command]
pub async fn library_list(app: tauri::AppHandle) -> Value {
    run_engine(&app, vec!["library".into(), "list".into()]).await
}

#[tauri::command]
pub async fn library_import(app: tauri::AppHandle, source_path: String) -> Value {
    if validate_file_source(Path::new(&source_path)).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(
        &app,
        vec![
            "library".into(),
            "import".into(),
            "--source-path".into(),
            source_path,
        ],
    )
    .await
}

#[tauri::command]
pub async fn library_update(
    app: tauri::AppHandle,
    id: String,
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
) -> Value {
    if validate_nonempty(&id).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, update_arguments(id, title, author, description, tags)).await
}

#[tauri::command]
pub async fn library_search(app: tauri::AppHandle, query: String) -> Value {
    run_engine(
        &app,
        vec!["library".into(), "search".into(), "--query".into(), query],
    )
    .await
}

#[tauri::command]
pub async fn library_cover_set(app: tauri::AppHandle, id: String, source_path: String) -> Value {
    if validate_nonempty(&id).is_err() || validate_file_source(Path::new(&source_path)).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(
        &app,
        vec![
            "library".into(),
            "cover".into(),
            "set".into(),
            "--id".into(),
            id,
            "--source-path".into(),
            source_path,
        ],
    )
    .await
}

#[tauri::command]
pub async fn library_cover_remove(app: tauri::AppHandle, id: String) -> Value {
    if validate_nonempty(&id).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(
        &app,
        vec![
            "library".into(),
            "cover".into(),
            "remove".into(),
            "--id".into(),
            id,
        ],
    )
    .await
}

#[tauri::command]
pub async fn library_remove(app: tauri::AppHandle, id: String) -> Value {
    if validate_nonempty(&id).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(
        &app,
        vec!["library".into(), "remove".into(), "--id".into(), id],
    )
    .await
}

#[tauri::command]
pub async fn library_open(app: tauri::AppHandle, id: String) -> Value {
    if validate_nonempty(&id).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, library_open_arguments(id)).await
}

#[tauri::command]
pub async fn destination_list(app: tauri::AppHandle) -> Value {
    run_engine(&app, destination_list_arguments()).await
}

#[tauri::command]
pub async fn destination_send(
    app: tauri::AppHandle,
    id: String,
    destination_path: String,
) -> Value {
    if validate_nonempty(&id).is_err() || validate_nonempty(&destination_path).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, destination_send_arguments(id, destination_path)).await
}

#[tauri::command]
pub async fn destination_eject(app: tauri::AppHandle, destination_path: String) -> Value {
    if validate_nonempty(&destination_path).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, destination_eject_arguments(destination_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_boundary_arguments() {
        assert!(validate_nonempty("book-1").is_ok());
        assert!(validate_nonempty("/Volumes/Reader").is_ok());
        assert!(validate_nonempty("  ").is_err());
        assert!(validate_file_source(Path::new("definitely-missing.epub")).is_err());
    }

    #[test]
    fn builds_fixed_open_and_destination_arguments() {
        assert_eq!(
            library_open_arguments("book-1".into()),
            vec!["library", "open", "--id", "book-1", "--json"]
        );
        assert_eq!(destination_list_arguments(), vec!["destination", "list"]);
        assert_eq!(
            destination_send_arguments("book-1".into(), "/Volumes/Reader".into()),
            vec!["send", "--id", "book-1", "--dest", "/Volumes/Reader"]
        );
        assert_eq!(
            destination_eject_arguments("/Volumes/Reader".into()),
            vec!["destination", "eject", "--dest", "/Volumes/Reader"]
        );
    }

    #[test]
    fn builds_complete_metadata_replacement_arguments() {
        assert_eq!(
            update_arguments(
                "book-1".into(),
                Some("New title".into()),
                Some(String::new()),
                None,
                vec!["Classic".into(), "Science Fiction".into()],
            ),
            vec![
                "library",
                "update",
                "--id",
                "book-1",
                "--title",
                "New title",
                "--author",
                "",
                "--tag",
                "Classic",
                "--tag",
                "Science Fiction",
            ]
        );
    }

    #[test]
    fn parses_success_and_domain_failure_records() {
        let success = br#"{"ok":true,"value":{"items":[]}}"#;
        let failure_record = br#"{"ok":false,"error":{"code":"storage-unavailable"}}"#;

        assert_eq!(
            parse_engine_record(Some(0), success, b""),
            json!({
              "ok": true,
              "value": { "items": [] },
            })
        );
        assert_eq!(
            parse_engine_record(Some(1), failure_record, b""),
            json!({
              "ok": false,
              "error": { "code": "storage-unavailable" },
            })
        );
    }

    #[test]
    fn rejects_malformed_or_inconsistent_protocol_output() {
        let protocol_failure = failure("protocol-error");

        assert_eq!(parse_engine_record(Some(0), b"", b""), protocol_failure);
        assert_eq!(
            parse_engine_record(Some(0), b"not-json", b""),
            protocol_failure
        );
        assert_eq!(
            parse_engine_record(Some(1), br#"{"ok":true,"value":null}"#, b""),
            protocol_failure,
        );
        assert_eq!(
            parse_engine_record(Some(0), br#"{"ok":true}"#, b""),
            protocol_failure,
        );
        assert_eq!(
            parse_engine_record(Some(1), br#"{"ok":false}"#, b""),
            protocol_failure,
        );
        assert_eq!(
            parse_engine_record(Some(0), br#"{"ok":true,"value":null}"#, b"diagnostic"),
            protocol_failure,
        );
    }
}
