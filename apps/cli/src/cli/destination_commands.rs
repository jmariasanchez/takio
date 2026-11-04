//! Reader destination inventory, delivery and eject commands.
#[allow(clippy::wildcard_imports)]
use super::*;

pub(super) fn destination(command: DestinationCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        DestinationCommand::List { volumes_root } => {
            print_success(json!({"destinations":destinations::list(&volumes_root)?}))
        }
        DestinationCommand::Eject { dest, volumes_root } => {
            let device = destinations::resolve(&dest, &volumes_root)?;
            destinations::eject(&device)?;
            print_success(json!({"destinationId":device.id}))
        }
        DestinationCommand::Inventory { dest, volumes_root }
        | DestinationCommand::Reconcile { dest, volumes_root } => {
            let device = destinations::resolve(&dest, &volumes_root)?;
            print_success(
                json!({"destinationId":device.id,"entries":destinations::inventory(&device)?}),
            )
        }
        DestinationCommand::Books {
            db,
            dest,
            volumes_root,
            human,
        } => {
            let device = destinations::resolve(&dest, &volumes_root)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut cache = reader_shelf::HashCache::load(&paths.root);
            let (root, database) = (paths.root.clone(), paths.database.clone());
            let shelf =
                reader_shelf::scan_cached(&device, &catalog_fingerprints(paths)?, &mut cache)?;
            // Never leave a cache in a folder that holds no library.
            if database.is_file() {
                let _ = cache.save(&root);
            }
            if !human {
                return print_success(shelf);
            }
            println!(
                "{}: {} of your books, {} other file(s)",
                device.label(),
                shelf.in_library,
                shelf.not_in_library
            );
            if shelf.koreader && shelf.finished + shelf.in_progress > 0 {
                println!(
                    "KOReader: {} finished, {} in progress",
                    shelf.finished, shelf.in_progress
                );
            }
            for entry in &shelf.books {
                let label = entry.title.as_deref().unwrap_or("(not in library)");
                let state = entry
                    .reading
                    .as_ref()
                    .and_then(takio::delivery::koreader::ReadingState::label)
                    .unwrap_or_default();
                println!("  {:<40} {:<9} {}", truncate(label, 40), state, entry.path);
            }
            if shelf.truncated {
                println!("  Stopped at the scan limit. Some files are not listed.");
            }
            if shelf.unreadable > 0 {
                println!(
                    "  {} folder(s) or file(s) could not be read. Counts may be incomplete.",
                    shelf.unreadable
                );
            }
            if shelf.importable > 0 {
                println!(
                    "{} can be copied into your library with: takio destination import --dest {}",
                    shelf.importable, device.id
                );
            }
            Ok(())
        }
        DestinationCommand::Import {
            db,
            dest,
            volumes_root,
            human,
        } => {
            let device = destinations::resolve(&dest, &volumes_root)?;
            let mut store = write_store(library, db.as_deref())?;
            let mut cache = reader_shelf::HashCache::load(&store.paths().root);
            let scan = reader_shelf::import_unmatched(&mut store, &device, &mut cache)?;
            let _ = cache.save(&store.paths().root);
            if !human {
                return print_success(scan);
            }
            let counts = scan.counts;
            println!(
                "{}: imported {}, already in library {}, skipped {}, failed {}",
                device.name, counts.imported, counts.duplicates, counts.skipped, counts.failed
            );
            for outcome in &scan.outcomes {
                let line = match outcome {
                    ImportOutcome::Imported { item, .. } => format!("  added    {}", item.title),
                    ImportOutcome::Skipped {
                        source_path,
                        reason,
                    } => {
                        format!(
                            "  skipped  {} ({reason})",
                            reader_relative(&device, source_path)
                        )
                    }
                    ImportOutcome::Failed { source_path, code } => {
                        format!(
                            "  failed   {} ({code})",
                            reader_relative(&device, source_path)
                        )
                    }
                    ImportOutcome::Duplicate { .. } => continue,
                };
                println!("{line}");
            }
            println!("The reader was not changed.");
            Ok(())
        }
        DestinationCommand::Remove {
            dest,
            id,
            volumes_root,
        } => {
            let device = destinations::resolve(&dest, &volumes_root)?;
            print_success(
                json!({"destinationId":device.id,"removed":destinations::remove(&device,&id)?}),
            )
        }
        DestinationCommand::RootedKindleSend {
            id,
            format,
            host,
            user,
            remote_root,
            identity_file,
            port,
            timeout_ms,
        } => {
            let item = read_store(library, None)?.get_active(&id)?;
            let source = item
                .formats
                .iter()
                .find(|candidate| candidate.format == format)
                .ok_or_else(|| takio::app_error!("format-not-found"))?;
            if detect_format(&source.source_path) != Some(format) {
                return Err(takio::app_error!("format-mismatch"));
            }
            let destination = KindleSshDestination {
                host,
                user,
                port,
                remote_root,
                identity_file,
                timeout: Duration::from_millis(timeout_ms),
            };
            print_success(kindle_ssh::send(&destination, &id, &source.source_path)?)
        }
    }
}
pub(super) fn send(
    paths: LibraryPaths,
    id: &str,
    format: Option<FormatId>,
    dest: &Path,
    subdir: Option<&Path>,
    overwrite: bool,
    volumes_root: &Path,
) -> AppResult<()> {
    let store = LibraryStore::open_read_only(paths)?;
    let device = destinations::resolve(dest, volumes_root)?;
    print_success(takio::delivery::send_library_item(
        &store,
        &device,
        id,
        takio::delivery::DeliveryOptions {
            format,
            subdir,
            overwrite: if overwrite {
                destinations::OverwritePolicy::Replace
            } else {
                destinations::OverwritePolicy::Refuse
            },
            reviewed: None,
        },
    )?)
}
pub(super) fn read_json(input: &str) -> AppResult<Value> {
    let bytes = if input == "-" {
        let mut data = Vec::new();
        std::io::stdin()
            .take(16 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| takio::app_error!("invalid-arguments"))?;
        data
    } else if let Some(path) = input.strip_prefix('@') {
        std::fs::read(path).map_err(|_| takio::app_error!("invalid-arguments"))?
    } else {
        input.as_bytes().to_vec()
    };
    if bytes.len() > 16 * 1024 {
        return Err(takio::app_error!("invalid-arguments"));
    }
    serde_json::from_slice(&bytes).map_err(|_| takio::app_error!("invalid-arguments"))
}
pub(super) fn reader_relative(device: &destinations::Destination, path: &Path) -> String {
    path.strip_prefix(&device.path)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// Fingerprints from an existing library, opened read-only so a scan never creates one.
/// A library that was never created has no books, so every reader file is listed as
/// not in it rather than failing.
pub(super) fn catalog_fingerprints(
    paths: LibraryPaths,
) -> AppResult<Vec<takio::library::store::ActiveFingerprint>> {
    match std::fs::symlink_metadata(&paths.database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        _ => LibraryStore::open_read_only(paths)?.active_fingerprints(),
    }
}
