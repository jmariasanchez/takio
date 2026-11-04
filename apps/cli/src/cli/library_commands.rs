//! Library catalog, format, cover, trash and import commands.
#[allow(clippy::wildcard_imports)]
use super::*;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(super) enum UpdateOutcome {
    Updated {
        #[serde(rename = "itemId")]
        item_id: String,
        item: Box<takio::library::model::LibraryItem>,
    },
    Missing {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    Failed {
        #[serde(rename = "itemId")]
        item_id: String,
        code: ErrorCode,
    },
}

pub(super) fn library(
    command: LibraryCommand,
    library: Option<&str>,
    desktop_environment: &DesktopEnvironment,
) -> AppResult<()> {
    match command {
        LibraryCommand::CustomColumns { command } => custom_columns(command, library),
        LibraryCommand::Service { db } => library_service(library, db.as_deref()),
        LibraryCommand::Path { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"databasePath":paths.database,"rootPath":paths.root}))
        }
        LibraryCommand::Verify { db } => {
            let report = read_store(library, db.as_deref())?.verify()?;
            print_success(json!({"report":integrity_value(&report)}))
        }
        LibraryCommand::Backup { db, dest } => {
            let store = read_store(library, db.as_deref())?;
            let report = store.verify()?;
            let backup = store.backup(&dest)?;
            print_success(json!({"backup": {
                "path": backup.destination_path,
                "report": integrity_value(&report),
            }}))
        }
        LibraryCommand::Diagnostics { db, dest } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let report = takio::library::diagnostics::write_library_diagnostics(&paths, &dest)?;
            print_success(json!({"diagnostics":report}))
        }
        LibraryCommand::Add {
            db,
            source_path,
            title,
        } => {
            let mut store = write_store(library, db.as_deref())?;
            print_success(store.import_with_outcome(
                &source_path,
                title.as_deref(),
                takio::library::model::ImportMode::Copy,
            )?)
        }
        LibraryCommand::Import {
            db,
            source_path,
            title,
            mode,
        } => {
            let mode = mode.into();
            let mut store = write_store(library, db.as_deref())?;
            print_success(store.import_with_outcome(&source_path, title.as_deref(), mode)?)
        }
        LibraryCommand::List {
            db,
            human,
            volumes_root,
        } => {
            let store = read_store(library, db.as_deref())?;
            let items = store.list(false)?;
            if human {
                print_human_list(&store, &items, &volumes_root, desktop_environment)
            } else {
                print_success(json!({"items":items}))
            }
        }
        LibraryCommand::Get { db, id } => {
            print_success(json!({"item":read_store(library, db.as_deref())?.get(&id)?}))
        }
        LibraryCommand::Search { db, query } => {
            let store = read_store(library, db.as_deref())?;
            let items = store.query_items(&query, &Default::default())?;
            print_success(json!({ "items": items }))
        }
        LibraryCommand::Query { db, request_json } => {
            let request = read_json(&request_json)?;
            let store = read_store(library, db.as_deref())?;
            print_success(library_query_value(&store, &request)?)
        }
        LibraryCommand::Update { db, id, patch_json } => print_success(run_cli_operation(
            library,
            db.as_deref(),
            OperationName::Update,
            &json!({"id":id,"patch":read_json(&patch_json)?}),
            CliEnvelope::Direct,
        )?),
        LibraryCommand::UpdateMany {
            db,
            ids,
            patch_json,
        } => {
            if ids.is_empty() || !valid_selection(&ids, MAX_BATCH) {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let patch: LibraryPatch = decode_request(&read_json(&patch_json)?)?;
            let mut store = write_store(library, db.as_deref())?;
            let mut outcomes = Vec::with_capacity(ids.len());
            for id in ids {
                match update_item(
                    &mut store,
                    UpdateRequest {
                        id: id.clone(),
                        patch: patch.clone(),
                    },
                ) {
                    Ok(result) => outcomes.push(UpdateOutcome::Updated {
                        item_id: id,
                        item: Box::new(result.item),
                    }),
                    Err(error) if error.kind() == ErrorCode::NotFound => {
                        outcomes.push(UpdateOutcome::Missing { item_id: id });
                    }
                    Err(error) => {
                        outcomes.push(UpdateOutcome::Failed {
                            item_id: id,
                            code: error.kind(),
                        });
                    }
                }
            }
            let updated = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, UpdateOutcome::Updated { .. }))
                .count();
            let missing = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, UpdateOutcome::Missing { .. }))
                .count();
            let failed = outcomes.len() - updated - missing;
            print_success(json!({
                "outcomes": outcomes,
                "counts": {
                    "total": outcomes.len(),
                    "updated": updated,
                    "missing": missing,
                    "failed": failed,
                },
            }))
        }
        LibraryCommand::Format(command) => library_format(command, library),
        LibraryCommand::Cover(command) => library_cover(command, library),
        LibraryCommand::Open {
            db,
            id,
            format,
            json,
        } => {
            let item = read_store(library, db.as_deref())?
                .get(&id)?
                .ok_or_else(|| takio::app_error!("not-found"))?;
            let selected = format
                .map_or_else(
                    || item.formats.first(),
                    |wanted| {
                        item.formats
                            .iter()
                            .find(|candidate| candidate.format == wanted)
                    },
                )
                .ok_or_else(|| takio::app_error!("format-not-found"))?;
            if json {
                print_success(json!({"id":id,"path":selected.source_path,"format":selected.format}))
            } else {
                open_path(&selected.source_path)?;
                print_success(json!({"id":id,"path":selected.source_path,"format":selected.format}))
            }
        }
        LibraryCommand::Trash(command) => library_trash(command, library),
        LibraryCommand::ImportMany {
            db,
            source_paths,
            mode,
        } => {
            if source_paths.is_empty() || source_paths.len() > MAX_BATCH {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let mode = mode.into();
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            validate_import_sources(&paths, &source_paths)?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(scan_imports(
                &mut store,
                &source_paths,
                mode,
                takio::import::scan::ImportObservation::Untracked,
                || false,
            )?)
        }
        LibraryCommand::ExportMany { db, request_json } => {
            let request = read_json(&request_json)?;
            let store = read_store(library, db.as_deref())?;
            print_success(export_many(&store, &request)?)
        }
        LibraryCommand::Remove { db, id } => print_success(run_cli_operation(
            library,
            db.as_deref(),
            OperationName::Trash,
            &json!({"id":id}),
            CliEnvelope::Direct,
        )?),
        LibraryCommand::ImportCalibre { db, library_root } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(import_calibre_library(paths, &library_root)?)
        }
        LibraryCommand::Catalog { db, format, output } => {
            let items = read_store(library, db.as_deref())?.list(false)?;
            print_success(json!({"catalog":write_catalog(&items, format, &output)?}))
        }
        LibraryCommand::ContentSearch {
            db,
            query,
            ids,
            limit,
            timeout_seconds,
        } => {
            if query.trim().is_empty() || !valid_selection(&ids, limit) || timeout_seconds == 0 {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let store = read_store(library, db.as_deref())?;
            print_success(content_search(
                &store,
                &query,
                &ids,
                limit,
                Duration::from_secs(timeout_seconds),
            )?)
        }
        LibraryCommand::Validate {
            db,
            ids,
            limit,
            timeout_seconds,
        } => {
            if !valid_selection(&ids, limit) || timeout_seconds == 0 {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let store = read_store(library, db.as_deref())?;
            print_success(validate_library_formats(
                &store,
                &ids,
                limit,
                Duration::from_secs(timeout_seconds),
            )?)
        }
        LibraryCommand::PortableExport { db, dest } => {
            let store = read_store(library, db.as_deref())?;
            print_success(portable::export(&store, &dest)?)
        }
        LibraryCommand::Rebuild { db, source } => {
            let paths = LibraryPaths::resolve(library, Some(&db))?;
            print_success(portable::rebuild(&source, paths)?)
        }
        LibraryCommand::RestoreBackup { db, source } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"restore":LibraryStore::restore_backup(&source, paths)?}))
        }
        LibraryCommand::SavedViews(command) | LibraryCommand::VirtualLibraries(command) => {
            library_saved_views(command, library)
        }
        LibraryCommand::Duplicates(command) => library_duplicates(command, library),
        LibraryCommand::ImportWatch {
            db,
            source_paths,
            interval_seconds,
            max_cycles,
            progress,
        } => {
            if source_paths.is_empty() || source_paths.len() > MAX_BATCH {
                return Err(takio::app_error!("invalid-arguments"));
            }
            import_watch(
                library,
                db.as_deref(),
                &source_paths,
                interval_seconds,
                max_cycles,
                progress,
            )
        }
    }
}

pub(super) fn custom_columns(
    command: CustomColumnsCommand,
    library: Option<&str>,
) -> AppResult<()> {
    let (db, operation, args, envelope) = match command {
        CustomColumnsCommand::List { db } => (
            db,
            OperationName::CustomColumnsList,
            json!({}),
            "definitions",
        ),
        CustomColumnsCommand::Create { db, key, label } => (
            db,
            OperationName::CustomColumnsCreate,
            json!({"key":key,"label":label}),
            "definition",
        ),
        CustomColumnsCommand::Rename { db, key, label } => (
            db,
            OperationName::CustomColumnsRename,
            json!({"key":key,"label":label}),
            "definition",
        ),
        CustomColumnsCommand::Remove { db, key } => (
            db,
            OperationName::CustomColumnsRemove,
            json!({"key":key}),
            "definition",
        ),
    };
    print_success(run_cli_operation(
        library,
        db.as_deref(),
        operation,
        &args,
        CliEnvelope::Wrapped(envelope),
    )?)
}

pub(super) fn library_saved_views(
    command: SavedViewsCommand,
    library: Option<&str>,
) -> AppResult<()> {
    match command {
        SavedViewsCommand::List { db } => {
            print_success(json!({"views":read_store(library, db.as_deref())?.list_saved_views()?}))
        }
        SavedViewsCommand::Save { db, request_json } => {
            let request: takio::library::store::SaveViewRequest =
                decode_request(&read_json(&request_json)?)?;
            print_success(json!({"view":write_store(library, db.as_deref())?.save_view(&request)?}))
        }
        SavedViewsCommand::Remove { db, request_json } => {
            let request = read_json(&request_json)?;
            if request
                .as_object()
                .is_none_or(|object| object.len() != 1 || !object.contains_key("id"))
            {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let id = request
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256)
                .ok_or_else(|| takio::app_error!("invalid-arguments"))?;
            print_success(json!({"view":write_store(library, db.as_deref())?.remove_view(id)?}))
        }
    }
}

pub(super) fn library_duplicates(
    command: DuplicateCommand,
    library: Option<&str>,
) -> AppResult<()> {
    let (db, operation, request_json) = match command {
        DuplicateCommand::List { db, request_json } => {
            (db, OperationName::DuplicatesList, request_json)
        }
        DuplicateCommand::Keep { db, request_json } => {
            (db, OperationName::DuplicatesKeep, request_json)
        }
        DuplicateCommand::Reopen { db, request_json } => {
            (db, OperationName::DuplicatesReopen, request_json)
        }
        DuplicateCommand::Merge { db, request_json } => {
            (db, OperationName::DuplicatesMerge, request_json)
        }
    };
    print_success(run_cli_operation(
        library,
        db.as_deref(),
        operation,
        &read_json(&request_json)?,
        CliEnvelope::Direct,
    )?)
}

pub(super) const MAX_BATCH: usize = 256;

#[derive(Clone, Copy, clap::ValueEnum)]
pub(super) enum CliImportMode {
    Copy,
    Move,
}

impl From<CliImportMode> for takio::library::model::ImportMode {
    fn from(mode: CliImportMode) -> Self {
        match mode {
            CliImportMode::Copy => Self::Copy,
            CliImportMode::Move => Self::Move,
        }
    }
}

pub(super) fn valid_selection(ids: &[String], limit: usize) -> bool {
    limit > 0
        && limit <= MAX_BATCH
        && ids.len() <= limit
        && ids.iter().all(|id| !id.trim().is_empty())
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}

type SelectedLibraryItems = Vec<(String, Option<takio::library::model::LibraryItem>)>;

pub(super) fn selected_items(
    store: &LibraryStore,
    ids: &[String],
    limit: usize,
) -> AppResult<(usize, SelectedLibraryItems)> {
    if ids.is_empty() {
        let items = store.list(false)?;
        let available = items.len();
        Ok((
            available,
            items
                .into_iter()
                .take(limit)
                .map(|item| (item.id.clone(), Some(item)))
                .collect(),
        ))
    } else {
        Ok((
            store.list(false)?.len(),
            ids.iter()
                .map(|id| Ok((id.clone(), store.get(id)?)))
                .collect::<AppResult<Vec<_>>>()?,
        ))
    }
}

pub(super) fn content_search(
    store: &LibraryStore,
    query: &str,
    ids: &[String],
    limit: usize,
    timeout: Duration,
) -> AppResult<Value> {
    let (available, entries) = selected_items(store, ids, limit)?;
    let mut outcomes = Vec::new();
    for (item_id, item) in entries {
        let Some(item) = item else {
            outcomes.push(json!({"status":"missing","itemId":item_id}));
            continue;
        };
        let Some(format) = item
            .formats
            .iter()
            .find(|format| format.format.is_text_extractable())
        else {
            outcomes.push(
                json!({"status":"skipped","itemId":item_id,"code":ErrorCode::UnsupportedFormat}),
            );
            continue;
        };
        match maintenance::extract_text(&format.source_path, timeout) {
            Ok((_, text)) => {
                let (matches, snippets) = maintenance::find_literal_text(&text, query, 3);
                if matches == 0 {
                    outcomes.push(json!({
                        "status": "no-match",
                        "itemId": item_id,
                        "format": format.format,
                    }));
                } else {
                    outcomes.push(json!({
                        "status": "matched",
                        "itemId": item_id,
                        "title": item.title,
                        "format": format.format,
                        "matches": matches,
                        "snippets": snippets,
                    }));
                }
            }
            Err(error) => outcomes.push(failed_outcome(&item_id, format.format, &error)),
        }
    }
    let count = |status: &str| status_count(&outcomes, status);
    Ok(json!({
        "query": query,
        "available": available,
        "selected": outcomes.len(),
        "canceled": false,
        "counts": {
            "total": outcomes.len(),
            "matched": count("matched"),
            "noMatch": count("no-match"),
            "missing": count("missing"),
            "skipped": count("skipped"),
            "failed": count("failed"),
        },
        "outcomes": outcomes,
    }))
}

pub(super) fn validate_library_formats(
    store: &LibraryStore,
    ids: &[String],
    limit: usize,
    timeout: Duration,
) -> AppResult<Value> {
    if discover_ebook_meta().is_none() {
        return Err(takio::app_error!("backend-unavailable"));
    }
    let (available, entries) = selected_items(store, ids, limit)?;
    let selected = entries.len();
    let mut outcomes = Vec::new();
    for (item_id, item) in entries {
        let Some(item) = item else {
            outcomes.push(json!({"status":"missing","itemId":item_id}));
            continue;
        };
        for format in item.formats {
            let result = metadata::extract(&format.source_path, timeout).and_then(|_| {
                if format.format.is_text_extractable() {
                    maintenance::extract_text(&format.source_path, timeout).map(|_| "checked")
                } else {
                    Ok("not-applicable")
                }
            });
            match result {
                Ok(content) => outcomes.push(json!({
                    "status": "valid",
                    "itemId": item_id,
                    "format": format.format,
                    "content": content,
                })),
                Err(error) => outcomes.push(failed_outcome(&item_id, format.format, &error)),
            }
        }
    }
    let count = |status: &str| status_count(&outcomes, status);
    Ok(json!({
        "available": available,
        "selected": selected,
        "outcomes": outcomes,
        "counts": {
            "total": outcomes.len(),
            "valid": count("valid"),
            "missing": count("missing"),
            "failed": count("failed"),
        },
    }))
}

fn failed_outcome(item_id: &str, format: FormatId, error: &takio::error::AppError) -> Value {
    json!({"status": "failed", "itemId": item_id, "format": format, "code": error.kind()})
}

fn status_count(outcomes: &[Value], status: &str) -> usize {
    outcomes
        .iter()
        .filter(|value| value["status"] == status)
        .count()
}

pub(super) fn library_format(command: FormatCommand, library: Option<&str>) -> AppResult<()> {
    let (db, operation, args) = match command {
        FormatCommand::Import {
            db,
            id,
            source_path,
        } => (
            db,
            OperationName::AttachFormat,
            json!({"id":id,"source":{"path":source_path,"kind":"copy"}}),
        ),
        FormatCommand::Attach {
            db,
            id,
            source_path,
        } => (
            db,
            OperationName::AttachFormat,
            json!({"id":id,"source":{"path":source_path,"kind":"reference"}}),
        ),
        FormatCommand::Remove { db, id, format } => (
            db,
            OperationName::RemoveFormat,
            json!({"id":id,"format":format}),
        ),
        FormatCommand::Replace { db, request_json } => {
            (db, OperationName::ReplaceFormat, read_json(&request_json)?)
        }
    };
    print_success(run_cli_operation(
        library,
        db.as_deref(),
        operation,
        &args,
        CliEnvelope::Direct,
    )?)
}
pub(super) fn library_cover(command: CoverCommand, library: Option<&str>) -> AppResult<()> {
    let (db, operation, args) = match command {
        CoverCommand::Set {
            db,
            id,
            source_path,
        } => (
            db,
            OperationName::CoverSet,
            json!({"id":id,"sourcePath":source_path}),
        ),
        CoverCommand::Remove { db, id } => (db, OperationName::CoverRemove, json!({"id":id})),
    };
    print_success(run_cli_operation(
        library,
        db.as_deref(),
        operation,
        &args,
        CliEnvelope::Direct,
    )?)
}
pub(super) fn library_trash(command: TrashCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        TrashCommand::List { db, request_json } => {
            let items = read_store(library, db.as_deref())?.list_trash()?;
            let request = request_json.as_deref().map(read_json).transpose()?;
            let offset = request
                .as_ref()
                .and_then(|value| value.pointer("/page/offset"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let limit = request
                .as_ref()
                .and_then(|value| value.pointer("/page/limit"))
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100) as usize;
            let total = items.len();
            let items = items
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect::<Vec<_>>();
            print_success(
                json!({"items":items,"total":total,"page":{"offset":offset,"limit":limit}}),
            )
        }
        TrashCommand::Move { db, request_json } => print_success(run_cli_operation(
            library,
            db.as_deref(),
            OperationName::Trash,
            &read_json(&request_json)?,
            CliEnvelope::Direct,
        )?),
        TrashCommand::Restore { db, request_json } => print_success(run_cli_operation(
            library,
            db.as_deref(),
            OperationName::Restore,
            &read_json(&request_json)?,
            CliEnvelope::Direct,
        )?),
        TrashCommand::Purge { db, request_json } => print_success(run_cli_operation(
            library,
            db.as_deref(),
            OperationName::Purge,
            &read_json(&request_json)?,
            CliEnvelope::Direct,
        )?),
    }
}

pub(super) fn import_watch(
    library: Option<&str>,
    db: Option<&Path>,
    source_paths: &[PathBuf],
    interval_seconds: u64,
    max_cycles: Option<u64>,
    progress: bool,
) -> AppResult<()> {
    let paths = LibraryPaths::resolve(library, db)?;
    validate_import_sources(&paths, source_paths)?;
    let mut store = LibraryStore::create_or_migrate(paths)?;
    let signals = takio::library::metadata_reconcile::CancellationSignals::install()?;
    let canceled = signals.flag();
    let result = watch_cycles(
        &mut store,
        source_paths,
        max_cycles,
        &canceled,
        |cycles, counts| {
            if progress {
                let mut output = std::io::stderr().lock();
                writeln!(
                    output,
                    "{}",
                    json!({"event":"watch-cycle-complete","cycles":cycles,"counts":counts})
                )?;
                output.flush()?;
            }
            if max_cycles.is_some_and(|maximum| cycles >= maximum) {
                return Ok(());
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(interval_seconds);
            while !canceled.load(std::sync::atomic::Ordering::Acquire) {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                std::thread::sleep(remaining.min(Duration::from_millis(20)));
            }
            Ok(())
        },
    )?;
    print_success(result)
}

pub(super) fn watch_cycles(
    store: &mut LibraryStore,
    source_paths: &[PathBuf],
    max_cycles: Option<u64>,
    canceled: &std::sync::atomic::AtomicBool,
    mut between_cycles: impl FnMut(u64, &ImportCounts) -> AppResult<()>,
) -> AppResult<Value> {
    let is_canceled = || canceled.load(std::sync::atomic::Ordering::Acquire);
    let mut cycles = 0_u64;
    let mut counts = ImportCounts::default();
    let mut stopped = false;
    loop {
        let scan = scan_imports(
            store,
            source_paths,
            takio::library::model::ImportMode::Copy,
            takio::import::scan::ImportObservation::Watch,
            is_canceled,
        )?;
        cycles += 1;
        counts.add(scan.counts);
        if scan.stopped || is_canceled() {
            stopped = true;
            break;
        }
        between_cycles(cycles, &counts)?;
        if is_canceled() {
            stopped = true;
            break;
        }
        if max_cycles.is_some_and(|maximum| cycles >= maximum) {
            break;
        }
    }
    Ok(json!({"cycles":cycles,"stopped":stopped,"counts":counts}))
}

pub(super) fn export_many(
    store: &LibraryStore,
    request: &Value,
) -> AppResult<takio::library::export::ExportReport> {
    takio::library::export::export_many(store, decode_request(request)?)
}

pub(super) fn library_query_value(store: &LibraryStore, request: &Value) -> AppResult<Value> {
    let result = takio::library::query::query(store, decode_request(request)?)?;
    encode_response(result)
}
