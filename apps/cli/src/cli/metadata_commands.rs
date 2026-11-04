//! Metadata extraction, fetching and candidate commands.
#[allow(clippy::wildcard_imports)]
use super::*;

pub(super) fn metadata_command(command: MetadataCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        MetadataCommand::Extract {
            source_path,
            timeout_seconds,
        } => print_success(metadata::extract(
            &source_path,
            Duration::from_secs(timeout_seconds),
        )?),
        MetadataCommand::Fetch {
            title,
            authors,
            identifiers,
            cover_output,
            timeout_seconds,
        } => {
            let identifiers = parse_identifiers(&identifiers)?;
            print_success(metadata::fetch(
                title.as_deref(),
                &authors,
                &identifiers,
                cover_output.as_deref(),
                Duration::from_secs(timeout_seconds),
            )?)
        }
        MetadataCommand::Candidates(command) => metadata_candidates(command, library),
    }
}

pub(super) fn metadata_candidates(
    command: MetadataCandidatesCommand,
    library: Option<&str>,
) -> AppResult<()> {
    match command {
        MetadataCandidatesCommand::Filename {
            source_path,
            id,
            patterns,
        } => print_success(json!({
            "candidates": filename_candidates(&source_path, id.as_deref(), &patterns)?
        })),
        MetadataCandidatesCommand::Item {
            db,
            id,
            include_online,
            timeout_seconds,
        } => {
            if id.trim().is_empty() || timeout_seconds == 0 {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let store = read_store(library, db.as_deref())?;
            let item = store
                .get(&id)?
                .ok_or_else(|| takio::app_error!("not-found"))?;
            let candidates = metadata_candidates_for_item_at(
                &item,
                include_online,
                Duration::from_secs(timeout_seconds),
                &store.paths().root,
            )?;
            print_success(json!({"itemId":item.id,"candidates":candidates}))
        }
        MetadataCandidatesCommand::Reconcile {
            db,
            request_json,
            timeout_seconds,
        } => {
            if timeout_seconds == 0 {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let request = ReconcileRequest::parse(read_json(&request_json)?)?;
            let signals = CancellationSignals::install()?;
            let paths = LibraryPaths::resolve(library, Some(&db))?;
            let candidate_root = paths.root.clone();
            let store = LibraryStore::open_read_only(paths)?;
            let snapshots = request
                .item_ids()
                .iter()
                .map(|id| store.get(id))
                .collect::<Vec<_>>();
            drop(store);

            let response = reconcile(
                request.item_ids(),
                snapshots,
                request.include_online(),
                Duration::from_secs(timeout_seconds),
                request.concurrency(),
                signals.flag().as_ref(),
                |item, online, timeout, canceled| {
                    metadata_candidates_for_reconcile(
                        item,
                        online,
                        timeout,
                        &candidate_root,
                        canceled,
                    )
                },
            );
            print_success(response)
        }
        MetadataCandidatesCommand::Apply {
            db,
            id,
            candidate_json,
            patch_json,
            provenance,
            cover,
        } => {
            if id.trim().is_empty()
                || provenance.trim().is_empty()
                || candidate_json.is_some() == patch_json.is_some()
            {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let id = id.trim().to_owned();
            let provenance = provenance.trim().to_owned();
            let Some(candidate_input) = candidate_json else {
                // Manual patches carry no candidate identity, so they are not
                // recorded as a candidate audit entry and answer a plain
                // envelope rather than the candidate apply response schema.
                let patch_value = read_json(patch_json.as_deref().unwrap_or_default())?;
                let patch: LibraryPatch = decode_request(&patch_value)?;
                let mut store = write_store(library, db.as_deref())?;
                if cover {
                    return Err(takio::app_error!("invalid-arguments"));
                }
                let item = store.update(&id, patch)?;
                return print_success(
                    json!({"item":item,"applied":{"itemId":id,"source":"manual","provenance":provenance}}),
                );
            };

            // The engine validates the candidate independently of any client,
            // and fully before opening or mutating a library, so malformed or
            // cross-item input has no side effect at all.
            let prepared = prepare_metadata_candidate(
                decode_request(&read_json(&candidate_input)?)?,
                &id,
                CandidateSelection {
                    fields: None,
                    include_cover: cover,
                },
                &provenance,
            )?;

            let mut store = write_store(library, db.as_deref())?;
            let item = apply_prepared_metadata_candidate(&mut store, &id, &prepared)?;
            let mut applied = json!({
                "itemId": id,
                "candidateId": prepared.candidate_id,
                "source": prepared.source,
                "provenance": provenance,
                "fields": prepared.fields,
                "coverApplied": prepared.cover.is_some(),
            });
            if let Some(cover) = prepared.cover.as_ref() {
                applied["cover"] = json!({
                    "mediaType": cover.media_type,
                    "extension": cover.extension,
                    "bytes": cover.bytes,
                    "sha256": cover.sha256,
                });
            }
            print_success(json!({"item": item, "applied": applied}))
        }
    }
}

pub(super) fn parse_identifiers(inputs: &[String]) -> AppResult<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for input in inputs {
        let (kind, value) = input
            .split_once(':')
            .ok_or_else(|| takio::app_error!("invalid-arguments"))?;
        let kind = kind.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if kind.is_empty() || value.is_empty() || values.insert(kind, value).is_some() {
            return Err(takio::app_error!("invalid-arguments"));
        }
    }
    Ok(values)
}
