use std::path::Path;

use serde_json::{json, Value};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const ENGINE_NAME: &str = "takio-library-engine";
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_JSON_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_LIBRARY_IMPORT_ROOTS: usize = 256;

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

fn validate_library_open(id: &str, format: &str) -> Result<(), ()> {
    validate_nonempty(id)?;
    validate_nonempty(format)
}

fn library_get_arguments(id: String) -> Result<Vec<String>, ()> {
    validate_nonempty(&id)?;
    Ok(vec!["library".into(), "get".into(), "--id".into(), id])
}

fn library_import_many_arguments(source_paths: Vec<String>) -> Result<Vec<String>, ()> {
    if source_paths.is_empty()
        || source_paths.len() > MAX_LIBRARY_IMPORT_ROOTS
        || source_paths
            .iter()
            .any(|source_path| validate_nonempty(source_path).is_err())
    {
        return Err(());
    }

    let mut args = Vec::with_capacity(2 + source_paths.len() * 2);
    args.extend(["library".into(), "import-many".into()]);
    for source_path in source_paths {
        args.extend(["--source-path".into(), source_path]);
    }
    Ok(args)
}

fn library_open_arguments(id: String, format: String) -> Vec<String> {
    vec![
        "library".into(),
        "open".into(),
        "--id".into(),
        id,
        "--format".into(),
        format,
        "--json".into(),
    ]
}

fn library_attach_format_arguments(
    id: String,
    source_path: String,
    mode: &str,
) -> Result<Vec<String>, ()> {
    let action = match mode {
        "copy" => "import",
        "reference" => "attach",
        _ => return Err(()),
    };

    Ok(vec![
        "library".into(),
        "format".into(),
        action.into(),
        "--id".into(),
        id,
        "--source-path".into(),
        source_path,
    ])
}

fn library_remove_format_arguments(id: String, format: String) -> Vec<String> {
    vec![
        "library".into(),
        "format".into(),
        "remove".into(),
        "--id".into(),
        id,
        "--format".into(),
        format,
    ]
}

fn library_replace_format_arguments(request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "format".into(),
        "replace".into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
}

fn destination_list_arguments() -> Vec<String> {
    vec!["destination".into(), "list".into()]
}

fn validate_destination_send(id: &str, format: &str, destination_path: &str) -> Result<(), ()> {
    validate_nonempty(id)?;
    validate_nonempty(format)?;
    validate_nonempty(destination_path)
}

fn destination_send_arguments(id: String, format: String, destination_path: String) -> Vec<String> {
    vec![
        "send".into(),
        "--id".into(),
        id,
        "--format".into(),
        format,
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

fn jobs_list_arguments() -> Vec<String> {
    vec!["jobs".into(), "list".into()]
}

fn jobs_enqueue_arguments(
    input: Option<String>,
    library_item_id: Option<String>,
    from: Option<String>,
    to: String,
    output: String,
) -> Result<Vec<String>, ()> {
    if validate_nonempty(&to).is_err() || validate_nonempty(&output).is_err() {
        return Err(());
    }

    let mut args = vec!["jobs".into(), "enqueue".into()];
    match (input, library_item_id, from) {
        (Some(input), None, None) if validate_nonempty(&input).is_ok() => {
            args.extend(["--input".into(), input]);
        }
        (None, Some(library_item_id), Some(from))
            if validate_nonempty(&library_item_id).is_ok() && validate_nonempty(&from).is_ok() =>
        {
            args.extend([
                "--library-item-id".into(),
                library_item_id,
                "--from".into(),
                from,
            ]);
        }
        _ => return Err(()),
    }
    args.extend(["--to".into(), to, "--output".into(), output]);
    Ok(args)
}

fn jobs_run_next_arguments() -> Vec<String> {
    vec!["jobs".into(), "run-next".into()]
}

fn jobs_cancel_arguments(id: String) -> Vec<String> {
    vec!["jobs".into(), "cancel".into(), "--id".into(), id]
}

fn serialize_nonempty_object(value: Value) -> Result<String, ()> {
    let Value::Object(fields) = &value else {
        return Err(());
    };
    if fields.is_empty() {
        return Err(());
    }

    let value_json = serde_json::to_string(&value).map_err(|_| ())?;
    if value_json.len() > MAX_JSON_ARGUMENT_BYTES {
        return Err(());
    }

    Ok(value_json)
}

fn update_arguments(id: String, patch: Value) -> Result<Vec<String>, ()> {
    validate_nonempty(&id)?;
    let patch_json = serialize_nonempty_object(patch)?;

    Ok(vec![
        "library".into(),
        "update".into(),
        "--id".into(),
        id,
        "--patch-json".into(),
        patch_json,
    ])
}

fn library_query_arguments(request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "query".into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
}

fn library_duplicates_arguments(action: &str, request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "duplicates".into(),
        action.into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
}

fn library_duplicates_list_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_duplicates_arguments("list", request)
}

fn library_duplicates_keep_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_duplicates_arguments("keep", request)
}

fn library_duplicates_reopen_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_duplicates_arguments("reopen", request)
}

fn library_duplicates_merge_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_duplicates_arguments("merge", request)
}

fn library_trash_arguments(action: &str, request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "trash".into(),
        action.into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
}

fn library_trash_list_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_trash_arguments("list", request)
}

fn library_trash_move_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_trash_arguments("move", request)
}

fn library_trash_restore_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_trash_arguments("restore", request)
}

fn library_trash_purge_arguments(request: Value) -> Result<Vec<String>, ()> {
    library_trash_arguments("purge", request)
}

fn library_saved_views_list_arguments() -> Vec<String> {
    vec!["library".into(), "saved-views".into(), "list".into()]
}

fn library_saved_view_save_arguments(request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "saved-views".into(),
        "save".into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
}

fn library_saved_view_remove_arguments(request: Value) -> Result<Vec<String>, ()> {
    Ok(vec![
        "library".into(),
        "saved-views".into(),
        "remove".into(),
        "--request-json".into(),
        serialize_nonempty_object(request)?,
    ])
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
pub async fn library_get(app: tauri::AppHandle, id: String) -> Value {
    let Ok(args) = library_get_arguments(id) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
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
pub async fn library_import_many(app: tauri::AppHandle, source_paths: Vec<String>) -> Value {
    let Ok(args) = library_import_many_arguments(source_paths) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_attach_format(
    app: tauri::AppHandle,
    id: String,
    source_path: String,
    mode: String,
) -> Value {
    if validate_nonempty(&id).is_err() || validate_file_source(Path::new(&source_path)).is_err() {
        return failure("invalid-arguments");
    }
    let Ok(args) = library_attach_format_arguments(id, source_path, &mode) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_remove_format(app: tauri::AppHandle, id: String, format: String) -> Value {
    if validate_nonempty(&id).is_err() || validate_nonempty(&format).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, library_remove_format_arguments(id, format)).await
}

#[tauri::command]
pub async fn library_replace_format(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_replace_format_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_update(app: tauri::AppHandle, id: String, patch: Value) -> Value {
    let Ok(args) = update_arguments(id, patch) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_query(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_query_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_duplicates_list(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_duplicates_list_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_duplicates_keep(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_duplicates_keep_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_duplicates_reopen(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_duplicates_reopen_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_duplicates_merge(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_duplicates_merge_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_trash_list(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_trash_list_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_trash(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_trash_move_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_restore(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_trash_restore_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_purge(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_trash_purge_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_saved_views_list(app: tauri::AppHandle) -> Value {
    run_engine(&app, library_saved_views_list_arguments()).await
}

#[tauri::command]
pub async fn library_saved_view_save(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_saved_view_save_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn library_saved_view_remove(app: tauri::AppHandle, request: Value) -> Value {
    let Ok(args) = library_saved_view_remove_arguments(request) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
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
pub async fn library_open(app: tauri::AppHandle, id: String, format: String) -> Value {
    if validate_library_open(&id, &format).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, library_open_arguments(id, format)).await
}

#[tauri::command]
pub async fn destination_list(app: tauri::AppHandle) -> Value {
    run_engine(&app, destination_list_arguments()).await
}

#[tauri::command]
pub async fn destination_send(
    app: tauri::AppHandle,
    id: String,
    format: String,
    destination_path: String,
) -> Value {
    if validate_destination_send(&id, &format, &destination_path).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(
        &app,
        destination_send_arguments(id, format, destination_path),
    )
    .await
}

#[tauri::command]
pub async fn destination_eject(app: tauri::AppHandle, destination_path: String) -> Value {
    if validate_nonempty(&destination_path).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, destination_eject_arguments(destination_path)).await
}

#[tauri::command]
pub async fn jobs_list(app: tauri::AppHandle) -> Value {
    run_engine(&app, jobs_list_arguments()).await
}

#[tauri::command]
pub async fn jobs_enqueue(
    app: tauri::AppHandle,
    input: Option<String>,
    library_item_id: Option<String>,
    from: Option<String>,
    to: String,
    output: String,
) -> Value {
    let Ok(args) = jobs_enqueue_arguments(input, library_item_id, from, to, output) else {
        return failure("invalid-arguments");
    };

    run_engine(&app, args).await
}

#[tauri::command]
pub async fn jobs_run_next(app: tauri::AppHandle) -> Value {
    run_engine(&app, jobs_run_next_arguments()).await
}

#[tauri::command]
pub async fn jobs_cancel(app: tauri::AppHandle, id: String) -> Value {
    if validate_nonempty(&id).is_err() {
        return failure("invalid-arguments");
    }

    run_engine(&app, jobs_cancel_arguments(id)).await
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
            library_open_arguments("book-1".into(), "pdf".into()),
            vec!["library", "open", "--id", "book-1", "--format", "pdf", "--json"]
        );
        assert_eq!(destination_list_arguments(), vec!["destination", "list"]);
        assert_eq!(
            destination_send_arguments("book-1".into(), "epub".into(), "/Volumes/Reader".into(),),
            vec![
                "send",
                "--id",
                "book-1",
                "--format",
                "epub",
                "--dest",
                "/Volumes/Reader",
            ]
        );
        assert_eq!(
            destination_eject_arguments("/Volumes/Reader".into()),
            vec!["destination", "eject", "--dest", "/Volumes/Reader"]
        );
    }

    #[test]
    fn builds_fixed_library_get_arguments_and_rejects_blank_ids() {
        assert_eq!(
            library_get_arguments("book --id 'two'\n📚".into()).unwrap(),
            vec!["library", "get", "--id", "book --id 'two'\n📚"]
        );
        assert!(library_get_arguments(" \n".into()).is_err());
    }

    #[test]
    fn builds_fixed_import_many_arguments_and_enforces_root_boundaries() {
        assert_eq!(
            library_import_many_arguments(vec![
                "/Books/A title.epub".into(),
                "/Books/$(touch /tmp/nope)\n📚".into(),
            ])
            .unwrap(),
            vec![
                "library",
                "import-many",
                "--source-path",
                "/Books/A title.epub",
                "--source-path",
                "/Books/$(touch /tmp/nope)\n📚",
            ]
        );

        assert!(library_import_many_arguments(Vec::new()).is_err());
        assert!(library_import_many_arguments(vec![" \n".into()]).is_err());
        assert!(library_import_many_arguments(vec!["/Books".into(); 256]).is_ok());
        assert!(library_import_many_arguments(vec!["/Books".into(); 257]).is_err());
    }

    #[test]
    fn validates_open_id_and_format() {
        assert!(validate_library_open("book-1", "pdf").is_ok());
        assert!(validate_library_open(" ", "pdf").is_err());
        assert!(validate_library_open("book-1", " ").is_err());
    }

    #[test]
    fn validates_send_id_format_and_destination() {
        assert!(validate_destination_send("book-1", "epub", "/Volumes/Reader").is_ok());
        assert!(validate_destination_send(" ", "epub", "/Volumes/Reader").is_err());
        assert!(validate_destination_send("book-1", " ", "/Volumes/Reader").is_err());
        assert!(validate_destination_send("book-1", "epub", " ").is_err());
    }

    #[test]
    fn builds_fixed_format_lifecycle_arguments() {
        assert_eq!(
            library_attach_format_arguments(
                "book-1".into(),
                "/Books/A real title.pdf".into(),
                "copy",
            )
            .unwrap(),
            vec![
                "library",
                "format",
                "import",
                "--id",
                "book-1",
                "--source-path",
                "/Books/A real title.pdf",
            ]
        );
        assert_eq!(
            library_attach_format_arguments(
                "book-1".into(),
                "/Books/A real title.pdf".into(),
                "reference",
            )
            .unwrap(),
            vec![
                "library",
                "format",
                "attach",
                "--id",
                "book-1",
                "--source-path",
                "/Books/A real title.pdf",
            ]
        );
        assert!(library_attach_format_arguments(
            "book-1".into(),
            "/Books/A real title.pdf".into(),
            "managed",
        )
        .is_err());
        assert_eq!(
            library_remove_format_arguments("book-1".into(), "pdf".into()),
            vec!["library", "format", "remove", "--id", "book-1", "--format", "pdf",]
        );
    }

    #[test]
    fn builds_atomic_format_replacement_as_one_literal_json_argument() {
        let request = json!({
            "id": "book --id 'two'",
            "format": "epub",
            "expectedCurrent": {
                "sourcePath": "/Books/current --request-json.epub",
                "addedAt": "2026-07-20T10:00:00.000Z",
                "provenance": "managed",
            },
            "source": {
                "kind": "copy",
                "path": "/Incoming/$(touch nope)\n📚.epub",
                "expectedArtifact": {
                    "bytes": 42,
                    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                },
            },
        });
        let request_json = serde_json::to_string(&request).unwrap();
        let arguments = library_replace_format_arguments(request.clone()).unwrap();

        assert_eq!(
            arguments,
            vec![
                "library",
                "format",
                "replace",
                "--request-json",
                request_json.as_str(),
            ]
        );
        assert_eq!(
            serde_json::from_str::<Value>(&arguments[4]).unwrap(),
            request
        );
    }

    #[test]
    fn preserves_nested_rich_metadata_as_one_patch_json_argument() {
        let patch = json!({
            "title": "New title",
            "authors": [
                { "name": "Ursula K. Le Guin", "role": "author" },
                { "name": "Virginia Kidd", "role": "editor" },
            ],
            "identifiers": { "isbn": "978-0-123-45678-9" },
            "publishedDate": { "year": 1969, "month": 3 },
        });
        let patch_json = serde_json::to_string(&patch).unwrap();
        let arguments = update_arguments("book-1".into(), patch.clone()).unwrap();

        assert_eq!(
            arguments,
            vec![
                "library",
                "update",
                "--id",
                "book-1",
                "--patch-json",
                patch_json.as_str(),
            ]
        );
        assert_eq!(serde_json::from_str::<Value>(&arguments[5]).unwrap(), patch);
    }

    #[test]
    fn rejects_blank_ids_and_empty_or_nonobject_patches() {
        assert!(update_arguments(" ".into(), json!({ "title": "Title" })).is_err());
        assert!(update_arguments("book-1".into(), json!({})).is_err());
        assert!(update_arguments("book-1".into(), json!([])).is_err());
        assert!(update_arguments("book-1".into(), json!(["title"])).is_err());
        assert!(update_arguments("book-1".into(), json!("")).is_err());
        assert!(update_arguments("book-1".into(), json!("title")).is_err());
        assert!(update_arguments("book-1".into(), Value::Null).is_err());
    }

    #[test]
    fn keeps_special_characters_inside_exact_literal_argv_boundaries() {
        let id = "book --id 'two'\n$HOME";
        let patch = json!({
            "title": "--title=$(touch /tmp/nope) \"quoted\"\nnext line",
            "tags": ["a,b", "--patch-json", "emoji: 📚"],
        });
        let patch_json = serde_json::to_string(&patch).unwrap();

        assert_eq!(
            update_arguments(id.into(), patch).unwrap(),
            vec![
                "library",
                "update",
                "--id",
                id,
                "--patch-json",
                patch_json.as_str(),
            ]
        );
    }

    #[test]
    fn enforces_the_serialized_patch_utf8_byte_limit() {
        let envelope_bytes = br#"{"value":""}"#.len();
        let at_limit = json!({
            "value": "x".repeat(MAX_JSON_ARGUMENT_BYTES - envelope_bytes),
        });
        let over_limit = json!({
            "value": format!(
                "{}📚",
                "x".repeat(MAX_JSON_ARGUMENT_BYTES - envelope_bytes - 3),
            ),
        });

        assert_eq!(
            serde_json::to_string(&at_limit).unwrap().len(),
            MAX_JSON_ARGUMENT_BYTES
        );
        assert_eq!(
            serde_json::to_string(&over_limit).unwrap().len(),
            MAX_JSON_ARGUMENT_BYTES + 1
        );
        assert!(update_arguments("book-1".into(), at_limit).is_ok());
        assert!(update_arguments("book-1".into(), over_limit).is_err());
    }

    #[test]
    fn builds_catalogue_query_and_saved_view_arguments_with_one_literal_json_value() {
        let query = json!({
            "filter": {
                "all": [
                    { "field": "authors.name", "operator": "contains", "value": "O'Brian" },
                    { "field": "tags", "operator": "equals", "value": "--request-json\n📚" },
                ],
            },
            "sort": [{ "field": "title", "direction": "ascending" }],
        });
        let query_json = serde_json::to_string(&query).unwrap();
        let query_arguments = library_query_arguments(query.clone()).unwrap();

        assert_eq!(
            query_arguments,
            vec!["library", "query", "--request-json", query_json.as_str()]
        );
        assert_eq!(
            serde_json::from_str::<Value>(&query_arguments[3]).unwrap(),
            query
        );
        assert_eq!(
            library_saved_views_list_arguments(),
            vec!["library", "saved-views", "list"]
        );

        let save = json!({ "name": "Sci-Fi, \'quoted\'", "request": query });
        let save_json = serde_json::to_string(&save).unwrap();
        assert_eq!(
            library_saved_view_save_arguments(save).unwrap(),
            vec![
                "library",
                "saved-views",
                "save",
                "--request-json",
                save_json.as_str(),
            ]
        );

        let remove = json!({ "id": "view --all $(touch /tmp/nope)" });
        let remove_json = serde_json::to_string(&remove).unwrap();
        assert_eq!(
            library_saved_view_remove_arguments(remove).unwrap(),
            vec![
                "library",
                "saved-views",
                "remove",
                "--request-json",
                remove_json.as_str(),
            ]
        );
    }

    #[test]
    fn builds_fixed_duplicate_review_arguments_with_one_literal_json_value() {
        let request = json!({
            "leftId": "book --request-json 'one'",
            "rightId": "book $(touch /tmp/nope)\n📚",
            "reviewToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        let request_json = serde_json::to_string(&request).unwrap();

        for (build, action) in [
            (
                library_duplicates_list_arguments as fn(Value) -> Result<Vec<String>, ()>,
                "list",
            ),
            (library_duplicates_keep_arguments, "keep"),
            (library_duplicates_reopen_arguments, "reopen"),
            (library_duplicates_merge_arguments, "merge"),
        ] {
            let arguments = build(request.clone()).unwrap();
            assert_eq!(
                arguments,
                vec![
                    "library",
                    "duplicates",
                    action,
                    "--request-json",
                    request_json.as_str(),
                ]
            );
            assert_eq!(arguments.len(), 5);
            assert_eq!(
                serde_json::from_str::<Value>(&arguments[4]).unwrap(),
                request
            );
        }
    }

    #[test]
    fn builds_fixed_trash_lifecycle_arguments_with_one_literal_json_value() {
        let list_request = json!({ "page": { "offset": 0, "limit": 25 } });
        let list_json = serde_json::to_string(&list_request).unwrap();
        assert_eq!(
            library_trash_list_arguments(list_request.clone()).unwrap(),
            vec![
                "library",
                "trash",
                "list",
                "--request-json",
                list_json.as_str(),
            ]
        );

        let lifecycle_request = json!({ "id": "book --request-json 'two'\n📚" });
        let lifecycle_json = serde_json::to_string(&lifecycle_request).unwrap();
        for (build, action) in [
            (
                library_trash_move_arguments as fn(Value) -> Result<Vec<String>, ()>,
                "move",
            ),
            (library_trash_restore_arguments, "restore"),
            (library_trash_purge_arguments, "purge"),
        ] {
            let arguments = build(lifecycle_request.clone()).unwrap();
            assert_eq!(
                arguments,
                vec![
                    "library",
                    "trash",
                    action,
                    "--request-json",
                    lifecycle_json.as_str(),
                ]
            );
            assert_eq!(
                serde_json::from_str::<Value>(&arguments[4]).unwrap(),
                lifecycle_request
            );
        }
    }

    #[test]
    fn rejects_empty_nonobject_and_oversized_json_requests() {
        let builders: [fn(Value) -> Result<Vec<String>, ()>; 12] = [
            library_query_arguments,
            library_saved_view_save_arguments,
            library_saved_view_remove_arguments,
            library_replace_format_arguments,
            library_duplicates_list_arguments,
            library_duplicates_keep_arguments,
            library_duplicates_reopen_arguments,
            library_duplicates_merge_arguments,
            library_trash_list_arguments,
            library_trash_move_arguments,
            library_trash_restore_arguments,
            library_trash_purge_arguments,
        ];
        let envelope_bytes = br#"{"value":""}"#.len();
        let at_limit = json!({
            "value": "x".repeat(MAX_JSON_ARGUMENT_BYTES - envelope_bytes),
        });
        let over_limit = json!({
            "value": "x".repeat(MAX_JSON_ARGUMENT_BYTES - envelope_bytes + 1),
        });

        assert_eq!(
            serde_json::to_string(&at_limit).unwrap().len(),
            MAX_JSON_ARGUMENT_BYTES
        );
        assert_eq!(
            serde_json::to_string(&over_limit).unwrap().len(),
            MAX_JSON_ARGUMENT_BYTES + 1
        );

        for build in builders {
            assert!(build(json!({})).is_err());
            assert!(build(json!([])).is_err());
            assert!(build(json!("request")).is_err());
            assert!(build(Value::Null).is_err());
            assert!(build(at_limit.clone()).is_ok());
            assert!(build(over_limit.clone()).is_err());
        }
    }

    #[test]
    fn builds_fixed_job_arguments() {
        assert_eq!(jobs_list_arguments(), vec!["jobs", "list"]);
        assert_eq!(
            jobs_enqueue_arguments(
                Some("/Books/A real - title.epub".into()),
                None,
                None,
                "pdf".into(),
                "/Exports/A real - title.pdf".into(),
            )
            .unwrap(),
            vec![
                "jobs",
                "enqueue",
                "--input",
                "/Books/A real - title.epub",
                "--to",
                "pdf",
                "--output",
                "/Exports/A real - title.pdf",
            ]
        );
        assert_eq!(
            jobs_enqueue_arguments(
                None,
                Some("book-1".into()),
                Some("epub".into()),
                "pdf".into(),
                "/Exports/A real - title.pdf".into(),
            )
            .unwrap(),
            vec![
                "jobs",
                "enqueue",
                "--library-item-id",
                "book-1",
                "--from",
                "epub",
                "--to",
                "pdf",
                "--output",
                "/Exports/A real - title.pdf",
            ]
        );
        assert_eq!(jobs_run_next_arguments(), vec!["jobs", "run-next"]);
        assert_eq!(
            jobs_cancel_arguments("job-1".into()),
            vec!["jobs", "cancel", "--id", "job-1"]
        );
    }

    #[test]
    fn validates_job_enqueue_source_shape_without_owning_conversion_semantics() {
        let arguments = |input: Option<&str>,
                         library_item_id: Option<&str>,
                         from: Option<&str>,
                         to: &str,
                         output: &str| {
            jobs_enqueue_arguments(
                input.map(str::to_owned),
                library_item_id.map(str::to_owned),
                from.map(str::to_owned),
                to.into(),
                output.into(),
            )
        };

        assert!(arguments(Some("book.epub"), None, None, "epub", "book.epub").is_ok());
        assert!(arguments(None, Some("book-1"), Some("pdf"), "epub", "book.epub").is_ok());
        assert!(arguments(None, None, None, "pdf", "book.pdf").is_err());
        assert!(arguments(
            Some("book.epub"),
            Some("book-1"),
            Some("epub"),
            "pdf",
            "book.pdf"
        )
        .is_err());
        assert!(arguments(None, Some("book-1"), None, "pdf", "book.pdf").is_err());
        assert!(arguments(None, None, Some("epub"), "pdf", "book.pdf").is_err());
        assert!(arguments(Some(" "), None, None, "pdf", "book.pdf").is_err());
        assert!(arguments(None, Some(" "), Some("epub"), "pdf", "book.pdf").is_err());
        assert!(arguments(None, Some("book-1"), Some(" "), "pdf", "book.pdf").is_err());
        assert!(arguments(Some("book.epub"), None, None, " ", "book.pdf").is_err());
        assert!(arguments(Some("book.epub"), None, None, "pdf", " ").is_err());
    }

    #[test]
    fn parses_success_and_domain_failure_records() {
        let success = br#"{"ok":true,"value":{"items":[]}}"#;
        let cleanup_pending = br#"{"ok":true,"value":{"item":null,"cleanupPending":true}}"#;
        let failure_record = br#"{"ok":false,"error":{"code":"storage-unavailable"}}"#;

        assert_eq!(
            parse_engine_record(Some(0), success, b""),
            json!({
              "ok": true,
              "value": { "items": [] },
            })
        );
        assert_eq!(
            parse_engine_record(Some(0), cleanup_pending, b""),
            json!({
              "ok": true,
              "value": { "item": null, "cleanupPending": true },
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
