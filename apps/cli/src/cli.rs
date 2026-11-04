mod jobs;
use jobs::*;
mod args;
use args::*;
mod destination_commands;
use destination_commands::*;
mod human;
use human::*;
mod library_commands;
use library_commands::*;
mod metadata_commands;
use metadata_commands::*;
mod service;
use service::*;

use std::collections::BTreeMap;
use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{CommandFactory, Parser, Subcommand};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::output::print_success;
use takio::conversion::jobs::{JobAttachmentStatus, JobStatus, JobStore};
use takio::conversion::maintenance::{self, discover_ebook_polish};
use takio::conversion::{CALIBRE_CAPABILITIES, convert, discover_ebook_convert};
use takio::delivery::destinations;
use takio::delivery::kindle_ssh::{self, KindleSshDestination};
use takio::delivery::reader_shelf;
use takio::error::{AppResult, ErrorCode};
use takio::format::{FormatId, detect_format};
use takio::import::calibre::import_calibre_library;
use takio::import::scan::{ImportCounts, ImportOutcome, scan_imports};
use takio::library::catalog::write_catalog;
use takio::library::diagnostics::integrity_value;
use takio::library::metadata_candidates::{
    CandidateSelection, apply_prepared_metadata_candidate, filename_candidates,
    metadata_candidates_for_item_at, metadata_candidates_for_reconcile, prepare_metadata_candidate,
};
use takio::library::metadata_reconcile::{CancellationSignals, ReconcileRequest, reconcile};
use takio::library::model::LibraryPatch;
use takio::library::paths::{LibraryPaths, absolute, validate_import_sources};
use takio::library::portable;
use takio::library::store::{
    DuplicatePairReviewRequest, LIBRARY_SCHEMA_VERSION, LibraryStore,
    ListDuplicateCandidatesRequest, MergeDuplicatePairRequest,
};
use takio::metadata::{self, discover_ebook_meta, discover_fetch_ebook_metadata};

pub fn run() -> AppResult<()> {
    let desktop_environment = DesktopEnvironment {
        data_override: std::env::var_os(takio::library::paths::TAKIO_DATA_DIR).is_some(),
        profile: std::env::var_os(takio::library::paths::TAKIO_DESKTOP_PROFILE_DIR)
            .map(PathBuf::from),
        default_root: LibraryPaths::resolve(None, None)
            .ok()
            .map(|paths| paths.root),
    };
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            use clap::error::ErrorKind;
            match error.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
                    print!("{error}");
                    return Ok(());
                }
                _ => return Err(takio::app_error!("invalid-arguments")),
            }
        }
    };
    let paths = LibraryPaths::resolve(cli.library.as_deref(), None)?;
    let Some(command) = cli.command else {
        if std::io::stdout().is_terminal() && std::io::stdin().is_terminal() {
            return crate::tui::run(paths);
        }
        let mut root = Cli::command();
        root.print_help()
            .map_err(|_| takio::app_error!("terminal-unavailable"))?;
        println!();
        return Ok(());
    };
    match command {
        Command::Tui => crate::tui::run(paths),
        Command::Doctor { human } => doctor(human),
        Command::Capabilities => capabilities(),
        Command::Formats { json } => formats(json),
        Command::Devices { json } => devices(json),
        Command::Plan {
            input,
            to,
            json,
            profile,
        } => plan(&input, to, profile.parse()?, json),
        Command::Convert {
            input,
            to,
            output,
            profile,
            timeout_seconds,
        } => print_success(convert(
            &input,
            &output,
            to,
            profile.parse()?,
            Duration::from_secs(timeout_seconds),
        )?),
        Command::Library(command) => library(command, cli.library.as_deref(), &desktop_environment),
        Command::Jobs(command) => jobs(command, cli.library.as_deref()),
        Command::Destination(command) => destination(command, cli.library.as_deref()),
        Command::Send {
            db,
            id,
            format,
            dest,
            subdir,
            overwrite,
            convert: _,
            volumes_root,
        } => {
            let paths = LibraryPaths::resolve(cli.library.as_deref(), db.as_deref())?;
            send(
                paths,
                &id,
                format,
                &dest,
                subdir.as_deref(),
                overwrite,
                &volumes_root,
            )
        }
        Command::Metadata(command) => metadata_command(command, cli.library.as_deref()),
        Command::Polish {
            input,
            output,
            operations,
            timeout_seconds,
        } => print_success(json!({"job":maintenance::polish(
            &input,
            &output,
            &operations,
            Duration::from_secs(timeout_seconds),
        )?})),
        Command::Serve {
            db,
            host,
            port,
            allow_remote,
            tls_cert,
            tls_key,
        } => {
            if allow_remote || tls_cert.is_some() || tls_key.is_some() {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let store = read_store(cli.library.as_deref(), db.as_deref())?;
            crate::server::serve(&store, &host, port)
        }
    }
}

fn doctor(human: bool) -> AppResult<()> {
    let backend = discover_ebook_convert();
    if human {
        println!(
            "Takio {}\n\nConversion backend: {}",
            env!("CARGO_PKG_VERSION"),
            backend
                .path
                .as_ref()
                .map_or("not found".to_owned(), |path| path.display().to_string())
        );
        Ok(())
    } else {
        print_success(
            json!({"status":if backend.available{"ready"}else{"degraded"},"cli":{"name":"takio","version":env!("CARGO_PKG_VERSION")},"platform":std::env::consts::OS,"kernel":{"ebookConvert":backend}}),
        )
    }
}
fn capabilities() -> AppResult<()> {
    let backend = discover_ebook_convert();
    let metadata_backend = discover_ebook_meta();
    let online_metadata_backend = discover_fetch_ebook_metadata();
    let polish_backend = discover_ebook_polish();
    let pairs = if backend.available {
        CALIBRE_CAPABILITIES.to_vec()
    } else {
        Vec::new()
    };
    print_success(
        json!({"protocolVersion":1,"implementation":"rust","tui":true,"limits":{"structuredJsonBytes":16384},"librarySchemaVersion":LIBRARY_SCHEMA_VERSION,"jobsSchemaVersion":4,"formats":FormatId::ALL,"conversionPairs":pairs,"backends":{"ebookConvert":backend,"ebookMeta":{"available":metadata_backend.is_some(),"path":metadata_backend},"fetchEbookMetadata":{"available":online_metadata_backend.is_some(),"path":online_metadata_backend},"ebookPolish":{"available":polish_backend.is_some(),"path":polish_backend}},"features":{"library":true,"jobs":true,"destinations":true,"metadata":true,"polish":true,"rootedKindleSsh":true,"contentServer":true,"contentServerRemoteTls":false,"nativeKepub":false},"unsupportedCommands":[]}),
    )
}
fn formats(as_json: bool) -> AppResult<()> {
    let values = FormatId::ALL
        .into_iter()
        .map(|format| json!({"id":format,"label":format.label(),"extensions":[format.extension()]}))
        .collect::<Vec<_>>();
    if as_json {
        print_success(json!({"formats":values}))
    } else {
        println!("{:<10} {:<22} Extension", "ID", "Format");
        for format in FormatId::ALL {
            println!(
                "{:<10} {:<22} .{}",
                format.as_str(),
                format.label(),
                format.extension()
            );
        }
        Ok(())
    }
}

fn devices(as_json: bool) -> AppResult<()> {
    let backend = discover_ebook_convert();
    let capabilities = if backend.available {
        CALIBRE_CAPABILITIES.to_vec()
    } else {
        Vec::new()
    };
    let value = json!({"devices":[{"id":"local","name":"This computer","status":"online","capabilities":capabilities}]});
    if as_json {
        print_success(value)
    } else {
        println!(
            "Local execution target: {}",
            if backend.available {
                "ready"
            } else {
                "conversion backend unavailable"
            }
        );
        Ok(())
    }
}
fn plan(
    input: &Path,
    to: FormatId,
    profile: takio::conversion::ConversionProfile,
    as_json: bool,
) -> AppResult<()> {
    let input = input
        .canonicalize()
        .map_err(|_| takio::app_error!("input-unavailable"))?;
    let from = detect_format(&input).ok_or_else(|| takio::app_error!("unsupported-format"))?;
    let available = discover_ebook_convert().available
        && CALIBRE_CAPABILITIES
            .iter()
            .any(|pair| pair.from == from && pair.to == to);
    if !available {
        return Err(takio::app_error!("unsupported-conversion"));
    }
    let value = json!({"id":format!("job_{}",uuid::Uuid::new_v4()),"input":input,"inputFormat":from,"outputFormat":to,"settings":{"version":1,"profileId":profile},"assignedTarget":{"id":"local","name":"This computer"},"status":"planned"});
    if as_json {
        print_success(value)
    } else {
        println!("Plan: {from} -> {to} on this computer");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn item_id_request_types_reject_blank_ids_at_decode() {
        fn rejects<T: DeserializeOwned>(mut value: Value) {
            for id in ["", " ", "\t\n"] {
                value["id"] = json!(id);
                assert!(decode_request::<T>(&value).is_err());
            }
            value["id"] = json!("book-1");
            assert!(decode_request::<T>(&value).is_ok());
        }
        rejects::<ItemIdRequest>(json!({"id":""}));
        rejects::<AttachFormatRequest>(
            json!({"id":"","source":{"path":"book.epub","kind":"copy"}}),
        );
        rejects::<UpdateRequest>(json!({"id":"","patch":{"title":"Title"}}));
        rejects::<RemoveFormatRequest>(json!({"id":"","format":"epub"}));
        rejects::<CoverSetRequest>(json!({"id":"","sourcePath":"cover.jpg"}));
    }

    #[test]
    fn desktop_note_uses_captured_profile_without_process_environment() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let profile = temp.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        let environment = DesktopEnvironment {
            data_override: true,
            profile: Some(profile),
            default_root: Some(temp.path().to_owned()),
        };
        let preference = takio::library::paths::desktop_preference_location(
            temp.path(),
            true,
            environment.profile.as_deref(),
        )
        .unwrap();
        let other = temp.path().join("other-library");
        std::fs::write(&preference, other.to_str().unwrap()).unwrap();
        assert!(
            desktop_library_note(&paths, &environment)
                .unwrap()
                .contains("other-library")
        );
        std::fs::write(preference, paths.root.to_str().unwrap()).unwrap();
        assert!(desktop_library_note(&paths, &environment).is_none());
    }

    #[test]
    fn typed_update_outcomes_keep_wire_shape() {
        for &code in ErrorCode::ALL {
            assert_eq!(
                serde_json::to_value(UpdateOutcome::Failed {
                    item_id: "book-1".into(),
                    code
                })
                .unwrap(),
                json!({"status":"failed","itemId":"book-1","code":code.as_str()})
            );
        }
        assert_eq!(
            serde_json::to_value(UpdateOutcome::Missing {
                item_id: "book-1".into()
            })
            .unwrap(),
            json!({"status":"missing","itemId":"book-1"})
        );
        let item = takio::library::catalog::tests::sparse_book();
        let expected = json!({"status":"updated","itemId":"book-1","item":item});
        assert_eq!(
            serde_json::to_value(UpdateOutcome::Updated {
                item_id: "book-1".into(),
                item: Box::new(item)
            })
            .unwrap(),
            expected
        );
    }

    #[test]
    fn display_only_legacy_authors_do_not_count_as_structured_authors() {
        let mut legacy = takio::library::catalog::tests::sparse_book();
        legacy.set_legacy_display_author_for_test(Some("Public author"));
        let structured = takio::library::catalog::tests::rich_book();
        assert_eq!(structured.primary_author(), Some("Public author"));
        assert_eq!(legacy.primary_author(), None);
        assert_eq!(
            json!(takio::library::query::Facets::from_items(&[
                legacy, structured
            ]))["authors"],
            serde_json::json!([{"value":"Public author","count":1}])
        );
    }
    use super::*;

    #[test]
    fn batch_selection_and_import_modes_have_one_validation_contract() {
        let ids = (0..MAX_BATCH)
            .map(|index| format!("book-{index}"))
            .collect::<Vec<_>>();
        assert!(valid_selection(&ids, MAX_BATCH));
        assert!(!valid_selection(&ids, MAX_BATCH - 1));
        assert!(!valid_selection(&ids, MAX_BATCH + 1));
        assert!(!valid_selection(&["book".into(), "book".into()], MAX_BATCH));
        assert!(!valid_selection(&[" ".into()], MAX_BATCH));
        assert!(!valid_selection(&[], 0));
        for command in ["import", "import-many"] {
            for mode in ["copy", "move"] {
                assert!(
                    Cli::try_parse_from([
                        "takio",
                        "library",
                        command,
                        "--source-path",
                        "book.txt",
                        "--mode",
                        mode
                    ])
                    .is_ok()
                );
            }
            assert!(
                Cli::try_parse_from([
                    "takio",
                    "library",
                    command,
                    "--source-path",
                    "book.txt",
                    "--mode",
                    "reference"
                ])
                .is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn import_watch_revalidates_sources_between_cycles() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&temp.path().join("library/library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
        let source = temp.path().join("watch");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("book.txt"), "book").unwrap();
        let canceled = std::sync::atomic::AtomicBool::new(false);
        let error = watch_cycles(
            &mut store,
            std::slice::from_ref(&source),
            Some(3),
            &canceled,
            |cycle, counts| {
                assert_eq!(cycle, 1);
                assert_eq!(counts.imported, 1);
                std::fs::remove_dir_all(&source).unwrap();
                std::os::unix::fs::symlink(&paths.items, &source).unwrap();
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorCode::InvalidArguments);
        let items = store.list(false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].formats.len(), 1);
        assert_eq!(
            std::fs::read_to_string(&items[0].formats[0].source_path).unwrap(),
            "book"
        );
    }

    #[test]
    fn typed_query_rejects_unknown_missing_null_and_out_of_range_fields() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let store = LibraryStore::create_or_migrate(paths).unwrap();
        let valid = json!({
            "query":"", "filters":{"authors":[],"tags":[],"series":[],"languages":[],"formats":[]},
            "sort":{"field":"title","direction":"ascending"}, "page":{"offset":0,"limit":100}
        });
        assert_eq!(library_query_value(&store, &valid).unwrap()["total"], 0);
        for (pointer, value) in [
            ("/querySyntax", Value::Null),
            ("/virtualLibraryId", Value::Null),
            ("/extra", json!(true)),
            ("/filters/extra", json!([])),
            ("/filters/authors", json!([" "])),
            ("/filters/tags", json!([3])),
            ("/sort/extra", json!(true)),
            ("/sort/direction", json!("backward")),
            ("/page/limit", json!(0)),
            ("/page/limit", json!(101)),
            ("/page/offset", json!(-1)),
            ("/page/extra", json!(true)),
        ] {
            let mut invalid = valid.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            invalid.pointer_mut(parent).unwrap()[key] = value;
            assert_eq!(
                library_query_value(&store, &invalid).unwrap_err().code(),
                "invalid-arguments",
                "{pointer}"
            );
        }
        for field in ["query", "filters", "sort", "page"] {
            let mut invalid = valid.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert_eq!(
                library_query_value(&store, &invalid).unwrap_err().code(),
                "invalid-arguments"
            );
        }
    }

    #[test]
    fn typed_service_arguments_reject_unknown_fields_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        for (command, args) in [
            (
                "library_custom_columns_create",
                json!({"key":"shelf","label":"Shelf","extra":true}),
            ),
            (
                "library_custom_columns_rename",
                json!({"key":"shelf","label":null}),
            ),
            (
                "library_custom_columns_remove",
                json!({"key":"shelf","extra":true}),
            ),
            (
                "library_attach_format",
                json!({"id":"book","source":{"path":"book.epub","kind":"move"}}),
            ),
            (
                "library_attach_format",
                json!({"id":"book","source":{"path":"book.epub","kind":"copy","extra":true}}),
            ),
            (
                "library_replace_format",
                json!({"id":"book","format":"epub","expectedCurrent":{},"source":{"path":"book.epub","kind":"copy"},"extra":true}),
            ),
        ] {
            assert_eq!(
                service_request(&mut store, &json!({"command":command,"args":args}))
                    .unwrap_err()
                    .code(),
                "invalid-arguments",
                "{command}"
            );
        }
        assert!(store.list_custom_column_definitions().unwrap().is_empty());
    }

    #[test]
    fn destructive_requests_reject_typos_without_mutating_books_or_files() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("library/library.sqlite");
        let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let source = temp.path().join("book.txt");
        std::fs::write(&source, "preserve me").unwrap();
        let item = store
            .import(&source, None, takio::library::model::ImportMode::Copy)
            .unwrap();
        for trashed in [false, true] {
            if trashed {
                store.trash(&item.id).unwrap();
            }
            let before = serde_json::to_value(store.get(&item.id).unwrap()).unwrap();
            for (command, args) in [
                ("library_trash", json!({"id":item.id,"dryRnu":true})),
                ("library_restore", json!({"id":item.id,"dryRnu":true})),
                ("library_purge", json!({"id":item.id,"confrim":false})),
                ("library_cover_remove", json!({"id":item.id,"dryRnu":true})),
                (
                    "library_cover_set",
                    json!({"id":item.id,"sourcePath":source,"dryRnu":true}),
                ),
                (
                    "library_remove_format",
                    json!({"id":item.id,"format":"txt","dryRnu":true}),
                ),
                (
                    "library_update",
                    json!({"id":item.id,"patch":{"title":"changed"},"dryRnu":true}),
                ),
            ] {
                assert_eq!(
                    service_request(&mut store, &json!({"command":command,"args":args}))
                        .unwrap_err()
                        .kind(),
                    ErrorCode::InvalidArguments,
                    "{command}"
                );
                assert_eq!(
                    serde_json::to_value(store.get(&item.id).unwrap()).unwrap(),
                    before
                );
            }
            for command in [
                TrashCommand::Move {
                    db: Some(database.clone()),
                    request_json: json!({"id":item.id,"dryRnu":true}).to_string(),
                },
                TrashCommand::Restore {
                    db: Some(database.clone()),
                    request_json: json!({"id":item.id,"dryRnu":true}).to_string(),
                },
                TrashCommand::Purge {
                    db: Some(database.clone()),
                    request_json: json!({"id":item.id,"confrim":false}).to_string(),
                },
            ] {
                assert_eq!(
                    library_trash(command, None).unwrap_err().kind(),
                    ErrorCode::InvalidArguments
                );
                assert_eq!(
                    serde_json::to_value(store.get(&item.id).unwrap()).unwrap(),
                    before
                );
            }
            let current = store.get(&item.id).unwrap().unwrap();
            assert_eq!(
                std::fs::read_to_string(&current.formats[0].source_path).unwrap(),
                "preserve me"
            );
        }
    }

    #[test]
    fn invalid_trash_requests_do_not_create_a_library() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("missing/library.sqlite");
        for request in [json!({"id":""}), json!({"id":"book","dryRnu":true})] {
            for command in [
                TrashCommand::Move {
                    db: Some(database.clone()),
                    request_json: request.to_string(),
                },
                TrashCommand::Restore {
                    db: Some(database.clone()),
                    request_json: request.to_string(),
                },
                TrashCommand::Purge {
                    db: Some(database.clone()),
                    request_json: request.to_string(),
                },
            ] {
                assert_eq!(
                    library_trash(command, None).unwrap_err().kind(),
                    ErrorCode::InvalidArguments
                );
                assert!(!database.parent().unwrap().exists());
            }
        }
    }

    #[test]
    fn empty_catalog_output_is_rejected_without_writing() {
        assert_eq!(
            write_catalog(
                &[],
                takio::library::catalog::CatalogFormat::Json,
                Path::new("")
            )
            .unwrap_err()
            .code(),
            "invalid-arguments"
        );
    }

    #[test]
    fn service_help_describes_automation_not_desktop() {
        let root = Cli::command();
        let service = root
            .find_subcommand("library")
            .unwrap()
            .find_subcommand("service")
            .unwrap();
        let about = service.get_about().unwrap().to_string();
        assert!(about.contains("automation clients"));
        assert!(!about.contains("desktop"));
    }

    #[test]
    fn catalog_exports_preserve_json_and_csv_schemas() {
        use takio::library::catalog::tests::{rich_book, rich_record, sparse_book, sparse_record};

        let temp = tempfile::tempdir().unwrap();
        let items = vec![rich_book(), sparse_book()];
        let output = temp.path().join("catalog.json");
        write_catalog(
            &items,
            takio::library::catalog::CatalogFormat::Json,
            &output,
        )
        .unwrap();
        let actual: Value = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(
            actual,
            json!({"version":1,"books":[rich_record(), sparse_record()]})
        );

        let output = temp.path().join("catalog.csv");
        write_catalog(&items, takio::library::catalog::CatalogFormat::Csv, &output).unwrap();
        let csv = std::fs::read_to_string(output).unwrap();
        assert_eq!(
            csv,
            concat!(
                "id,title,authors,series,seriesIndex,publisher,publishedDate,languages,tags,formats,rating,identifiers,customMetadata,description\n",
                "\"book-1\",\"Example\",\"Public author\",\"Series\",\"0\",\"Publisher\",\"2026\",\"en\",\"fiction\",\"epub\",\"0\",\"{\"\"isbn\"\":\"\"123\"\"}\",\"{\"\"shelf\"\":\"\"favorites\"\"}\",\"Description\"\n",
                "\"book-1\",\"Example\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"{}\",\"{}\",\"\"\n"
            )
        );
        assert!(!csv.contains("/private/"));
        assert!(!csv.contains("takio_metadata_audit"));
    }

    fn walk(command: &clap::Command, path: &str, missing: &mut Vec<String>) {
        for subcommand in command.get_subcommands() {
            let name = format!("{path} {}", subcommand.get_name());
            if subcommand.get_about().is_none() {
                missing.push(name.clone());
            }
            walk(subcommand, &name, missing);
        }
    }

    #[test]
    fn every_command_has_help_text() {
        let root = Cli::command();
        let mut missing = Vec::new();
        walk(&root, "takio", &mut missing);
        assert!(
            missing.is_empty(),
            "commands without `about` text: {missing:?}"
        );
    }

    #[test]
    fn command_tree_is_internally_consistent() {
        Cli::command().debug_assert();
    }
}
