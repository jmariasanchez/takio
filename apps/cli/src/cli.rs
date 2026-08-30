use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{CommandFactory, Parser, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::conversion::{
    CALIBRE_CAPABILITIES, FormatId, convert, detect_format, discover_ebook_convert,
};
use crate::destinations::{self, DestinationKind};
use crate::jobs::{JobStatus, JobStore};
use crate::model::LibraryPatch;
use crate::output::{AppError, AppResult, print_success};
use crate::paths::LibraryPaths;
use crate::store::{LIBRARY_SCHEMA_VERSION, LibraryStore, VerifyReport};

#[derive(Parser)]
#[command(
    name = "takio",
    version,
    about = "Manage, convert, and deliver a local ebook library",
    disable_help_subcommand = true
)]
struct Cli {
    #[arg(long, global = true)]
    library: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Open the human-first terminal interface")]
    Tui,
    #[command(about = "Report conversion-kernel health")]
    Doctor {
        #[arg(long)]
        human: bool,
    },
    #[command(about = "Return the machine-readable Takio protocol and feature report")]
    Capabilities,
    #[command(about = "List known ebook formats")]
    Formats {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List local conversion targets")]
    Devices {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Validate and plan a conversion")]
    Plan {
        #[arg(long)]
        input: PathBuf,
        #[arg(long = "to")]
        to: FormatId,
        #[arg(long)]
        json: bool,
        #[arg(long, default_value = "default")]
        profile: String,
    },
    #[command(about = "Convert one document synchronously")]
    Convert {
        #[arg(long)]
        input: PathBuf,
        #[arg(long = "to")]
        to: FormatId,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    #[command(subcommand)]
    Library(LibraryCommand),
    #[command(subcommand)]
    Jobs(JobsCommand),
    #[command(subcommand)]
    Destination(DestinationCommand),
    #[command(about = "Send a library format to a mounted destination")]
    Send {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long)]
        format: Option<FormatId>,
        #[arg(long)]
        dest: PathBuf,
        #[arg(long)]
        subdir: Option<PathBuf>,
        #[arg(long)]
        overwrite: bool,
        #[arg(long)]
        convert: bool,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(
        about = "Metadata commands remain available through the desktop while the Rust adapter is completed"
    )]
    Metadata,
    #[command(about = "Calibre polish adapter is not yet available in the Rust binary")]
    Polish,
    #[command(about = "The read-only content server is not yet available in the Rust binary")]
    Serve,
}

#[derive(Subcommand)]
enum LibraryCommand {
    Service {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    Path {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    Verify {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    Backup {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        dest: PathBuf,
    },
    Add {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    Import {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        title: Option<String>,
        #[arg(long, default_value = "copy")]
        mode: String,
    },
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        human: bool,
    },
    Get {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    Search {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        query: String,
    },
    Query {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Update {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "patch-json")]
        patch_json: String,
    },
    UpdateMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "id", required = true)]
        ids: Vec<String>,
        #[arg(long = "patch-json")]
        patch_json: String,
    },
    #[command(subcommand)]
    Format(FormatCommand),
    #[command(subcommand)]
    Cover(CoverCommand),
    Open {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long)]
        format: Option<FormatId>,
        #[arg(long)]
        json: bool,
    },
    #[command(subcommand)]
    Trash(TrashCommand),
    ImportMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path", required = true)]
        source_paths: Vec<PathBuf>,
        #[arg(long, default_value = "copy")]
        mode: String,
    },
    ExportMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    ImportCalibre,
    ImportWatch,
    Catalog,
    ContentSearch,
    Validate,
    PortableExport,
    Rebuild,
    RestoreBackup,
    Duplicates,
    SavedViews,
}

#[derive(Subcommand)]
enum FormatCommand {
    Import {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    Attach {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long)]
        format: FormatId,
    },
    Replace {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum CoverCommand {
    Set {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand)]
enum TrashCommand {
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: Option<String>,
    },
    Move {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Restore {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Purge {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum JobsCommand {
    Enqueue {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long = "from")]
        from: Option<FormatId>,
        #[arg(long = "to")]
        to: FormatId,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        library_item_id: Option<String>,
    },
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        status: Option<JobStatus>,
    },
    Get {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    Cancel {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    Retry {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    RunNext {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    Drain {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value_t = 256)]
        max_jobs: usize,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    RetryAttachment,
}

#[derive(Subcommand)]
enum DestinationCommand {
    List {
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    Eject {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    Inventory {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    Reconcile {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    Remove {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    RootedKindleSend,
}

pub fn run() -> AppResult<()> {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            use clap::error::ErrorKind;
            match error.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
                    print!("{error}");
                    return Ok(());
                }
                _ => return Err(AppError::new("invalid-arguments")),
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
            .map_err(|_| AppError::new("terminal-unavailable"))?;
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
        } => plan(&input, to, &profile, json),
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
            &profile,
            Duration::from_secs(timeout_seconds),
        )?),
        Command::Library(command) => library(command, cli.library.as_deref()),
        Command::Jobs(command) => jobs(command, cli.library.as_deref()),
        Command::Destination(command) => destination(command),
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
        Command::Metadata | Command::Polish | Command::Serve => {
            Err(AppError::new("feature-unavailable"))
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
    let pairs = if backend.available {
        CALIBRE_CAPABILITIES.to_vec()
    } else {
        Vec::new()
    };
    print_success(
        json!({"protocolVersion":1,"implementation":"rust","tui":true,"limits":{"structuredJsonBytes":16384},"librarySchemaVersion":LIBRARY_SCHEMA_VERSION,"jobsSchemaVersion":4,"formats":FormatId::ALL,"conversionPairs":pairs,"backends":{"ebookConvert":backend},"features":{"library":true,"jobs":true,"destinations":true,"metadata":false,"contentServer":false,"nativeKepub":false}}),
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
fn plan(input: &Path, to: FormatId, profile: &str, as_json: bool) -> AppResult<()> {
    let input = input
        .canonicalize()
        .map_err(|_| AppError::new("input-unavailable"))?;
    let from = detect_format(&input).ok_or_else(|| AppError::new("unsupported-format"))?;
    if !["default", "generic_eink", "kindle", "kobo"].contains(&profile) {
        return Err(AppError::new("invalid-arguments"));
    }
    let available = discover_ebook_convert().available
        && CALIBRE_CAPABILITIES
            .iter()
            .any(|pair| pair.from == from && pair.to == to);
    if !available {
        return Err(AppError::new("unsupported-conversion"));
    }
    let value = json!({"id":format!("job_{}",uuid::Uuid::new_v4()),"input":input,"inputFormat":from,"outputFormat":to,"settings":{"version":1,"profileId":profile},"assignedTarget":{"id":"local","name":"This computer"},"status":"planned"});
    if as_json {
        print_success(value)
    } else {
        println!("Plan: {} -> {} on this computer", from, to);
        Ok(())
    }
}

fn library(command: LibraryCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        LibraryCommand::Service { db } => library_service(library, db.as_deref()),
        LibraryCommand::Path { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"databasePath":paths.database,"rootPath":paths.root}))
        }
        LibraryCommand::Verify { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let report = LibraryStore::open(paths, false)?.verify()?;
            print_success(json!({"report":integrity_value(&report)}))
        }
        LibraryCommand::Backup { db, dest } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, false)?;
            let report = store.verify()?;
            let backup = store.backup(&dest)?;
            print_success(
                json!({"backup":{"path":backup.destination_path,"report":integrity_value(&report)}}),
            )
        }
        LibraryCommand::Add {
            db,
            source_path,
            title,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.import(&source_path, title.as_deref(), false)?}))
        }
        LibraryCommand::Import {
            db,
            source_path,
            title,
            mode,
        } => {
            let move_source = match mode.as_str() {
                "copy" => false,
                "move" => true,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(
                json!({"item":store.import(&source_path, title.as_deref(), move_source)?}),
            )
        }
        LibraryCommand::List { db, human } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let items = LibraryStore::open(paths, true)?.list(false)?;
            if human {
                println!("{:<36} {:<34} Formats", "ID", "Title");
                for item in &items {
                    println!(
                        "{:<36} {:<34} {}",
                        item.id,
                        truncate(&item.title, 32),
                        item.formats
                            .iter()
                            .map(|format| format.format.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    );
                }
                Ok(())
            } else {
                print_success(json!({"items":items}))
            }
        }
        LibraryCommand::Get { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"item":LibraryStore::open(paths, true)?.get(&id)?}))
        }
        LibraryCommand::Search { db, query } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"items":LibraryStore::open(paths, true)?.search(&query)?}))
        }
        LibraryCommand::Query { db, request_json } => {
            let request = read_json(&request_json)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
            print_success(library_query_value(&store, &request)?)
        }
        LibraryCommand::Update { db, id, patch_json } => {
            let patch: LibraryPatch = serde_json::from_value(read_json(&patch_json)?)
                .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.update(&id, patch)?}))
        }
        LibraryCommand::UpdateMany {
            db,
            ids,
            patch_json,
        } => {
            if ids.is_empty()
                || ids.len() > 256
                || ids.iter().any(|id| id.trim().is_empty())
                || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
            {
                return Err(AppError::new("invalid-arguments"));
            }
            let patch: LibraryPatch = serde_json::from_value(read_json(&patch_json)?)
                .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            let mut outcomes = Vec::with_capacity(ids.len());
            for id in ids {
                match store.update(&id, patch.clone()) {
                    Ok(item) => outcomes.push(json!({"status":"updated","itemId":id,"item":item})),
                    Err(error) if error.code() == "not-found" => {
                        outcomes.push(json!({"status":"missing","itemId":id}));
                    }
                    Err(error) => {
                        outcomes.push(json!({"status":"failed","itemId":id,"code":error.code()}))
                    }
                }
            }
            let updated = outcomes
                .iter()
                .filter(|outcome| outcome["status"] == "updated")
                .count();
            let missing = outcomes
                .iter()
                .filter(|outcome| outcome["status"] == "missing")
                .count();
            let failed = outcomes.len() - updated - missing;
            print_success(
                json!({"outcomes":outcomes,"counts":{"total":outcomes.len(),"updated":updated,"missing":missing,"failed":failed}}),
            )
        }
        LibraryCommand::Format(command) => library_format(command, library),
        LibraryCommand::Cover(command) => library_cover(command, library),
        LibraryCommand::Open {
            db,
            id,
            format,
            json,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let item = LibraryStore::open(paths, true)?
                .get(&id)?
                .ok_or_else(|| AppError::new("not-found"))?;
            let selected = format
                .map_or_else(
                    || item.formats.first(),
                    |wanted| {
                        item.formats
                            .iter()
                            .find(|candidate| candidate.format == wanted)
                    },
                )
                .ok_or_else(|| AppError::new("format-not-found"))?;
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
            if source_paths.len() > 256 {
                return Err(AppError::new("invalid-arguments"));
            }
            let move_source = match mode.as_str() {
                "copy" => false,
                "move" => true,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(import_many(&mut store, &source_paths, move_source))
        }
        LibraryCommand::ExportMany { db, request_json } => {
            let request = read_json(&request_json)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
            print_success(export_many(&store, &request)?)
        }
        LibraryCommand::Remove { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.remove(&id)?,"cleanupPending":false}))
        }
        _ => Err(AppError::new("feature-unavailable")),
    }
}

fn library_format(command: FormatCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        FormatCommand::Import {
            db,
            id,
            source_path,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.attach_format(&id, &source_path, true)?}))
        }
        FormatCommand::Attach {
            db,
            id,
            source_path,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.attach_format(&id, &source_path, false)?}))
        }
        FormatCommand::Remove { db, id, format } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.remove_format(&id, format)?,"cleanupPending":false}))
        }
        FormatCommand::Replace { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let format = serde_json::from_value::<FormatId>(
                request
                    .get("format")
                    .cloned()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
            .map_err(|_| AppError::new("invalid-arguments"))?;
            let expected = request
                .get("expectedCurrent")
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let source = request
                .get("source")
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let managed = match source.get("kind").and_then(Value::as_str) {
                Some("copy") => true,
                Some("reference") => false,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            let item = store.replace_format(id, format, expected, Path::new(path), managed)?;
            print_success(json!({"item":item,"cleanupPending":false}))
        }
    }
}
fn library_cover(command: CoverCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        CoverCommand::Set {
            db,
            id,
            source_path,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.set_cover(&id, &source_path)?}))
        }
        CoverCommand::Remove { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.remove_cover(&id)?}))
        }
    }
}
fn library_trash(command: TrashCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        TrashCommand::List { db, request_json } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let items = LibraryStore::open(paths, true)?.list_trash()?;
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
        TrashCommand::Move { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.trash(id)?}))
        }
        TrashCommand::Restore { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.restore(id)?}))
        }
        TrashCommand::Purge { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(json!({"item":store.purge(id)?,"cleanupPending":false}))
        }
    }
}

fn library_service(library: Option<&str>, database: Option<&Path>) -> AppResult<()> {
    let paths = LibraryPaths::resolve(library, database)?;
    let mut store = LibraryStore::open(paths, true)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input
            .read_line(&mut line)
            .map_err(|_| AppError::new("storage-unavailable"))?;
        if read == 0 {
            return Ok(());
        }
        let request = serde_json::from_str::<Value>(line.trim_end());
        let (id, result) = match request {
            Ok(request) => {
                let id = request
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let result = service_request(&mut store, &request);
                (id, result)
            }
            Err(_) => (String::new(), Err(AppError::new("invalid-arguments"))),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"ok":true,"value":value}),
            Err(error) => json!({"id":id,"ok":false,"error":{"code":error.code()}}),
        };
        writeln!(output, "{response}").map_err(|_| AppError::new("terminal-unavailable"))?;
        output
            .flush()
            .map_err(|_| AppError::new("terminal-unavailable"))?;
    }
}

fn service_request(store: &mut LibraryStore, request: &Value) -> AppResult<Value> {
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let args = request
        .get("args")
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    match command {
        "library_update" => {
            let id = request_id(args)?;
            let patch = serde_json::from_value::<LibraryPatch>(
                args.get("patch")
                    .cloned()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
            .map_err(|_| AppError::new("invalid-arguments"))?;
            Ok(json!({"item":store.update(id, patch)?}))
        }
        "library_attach_format" => {
            let id = request_id(args)?;
            let source = args
                .get("source")
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let managed = match source.get("kind").and_then(Value::as_str) {
                Some("copy") => true,
                Some("reference") => false,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            Ok(json!({"item":store.attach_format(id, Path::new(path), managed)?}))
        }
        "library_remove_format" => {
            let id = request_id(args)?;
            let format = serde_json::from_value::<FormatId>(
                args.get("format")
                    .cloned()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
            .map_err(|_| AppError::new("invalid-arguments"))?;
            Ok(json!({"item":store.remove_format(id, format)?,"cleanupPending":false}))
        }
        "library_cover_set" => {
            let id = request_id(args)?;
            let path = args
                .get("sourcePath")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            Ok(json!({"item":store.set_cover(id, Path::new(path))?}))
        }
        "library_cover_remove" => {
            let id = request_id(args)?;
            Ok(json!({"item":store.remove_cover(id)?}))
        }
        "library_trash" => {
            let id = request_id(args)?;
            Ok(json!({"item":store.trash(id)?}))
        }
        "library_restore" => {
            let id = request_id(args)?;
            Ok(json!({"item":store.restore(id)?}))
        }
        "library_purge" => {
            let id = request_id(args)?;
            Ok(json!({"item":store.purge(id)?,"cleanupPending":false}))
        }
        "library_replace_format" => {
            let id = request_id(args)?;
            let format = serde_json::from_value::<FormatId>(
                args.get("format")
                    .cloned()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?,
            )
            .map_err(|_| AppError::new("invalid-arguments"))?;
            let expected = args
                .get("expectedCurrent")
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let source = args
                .get("source")
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let managed = match source.get("kind").and_then(Value::as_str) {
                Some("copy") => true,
                Some("reference") => false,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            Ok(
                json!({"item":store.replace_format(id, format, expected, Path::new(path), managed)?,"cleanupPending":false}),
            )
        }
        _ => Err(AppError::new("invalid-arguments")),
    }
}

fn integrity_value(report: &VerifyReport) -> Value {
    json!({
        "schemaVersion":report.schema_version,
        "items":{
            "total":report.active_items + report.trashed_items,
            "active":report.active_items,
            "trashed":report.trashed_items
        },
        "formats":{
            "total":report.managed_formats + report.referenced_formats,
            "managed":report.managed_formats,
            "referenced":report.referenced_formats
        }
    })
}

fn import_many(store: &mut LibraryStore, roots: &[PathBuf], move_source: bool) -> Value {
    let mut sources = Vec::new();
    let mut outcomes = Vec::new();
    for root in roots {
        match std::fs::symlink_metadata(root) {
            Ok(metadata) if metadata.file_type().is_symlink() => outcomes.push(json!({
                "status":"skipped","sourcePath":root,"reason":"symbolic-link"
            })),
            Ok(metadata) if metadata.is_file() => sources.push(root.clone()),
            Ok(metadata) if metadata.is_dir() => {
                for entry in walkdir::WalkDir::new(root).follow_links(false) {
                    match entry {
                        Ok(entry) if entry.file_type().is_symlink() => outcomes.push(json!({
                            "status":"skipped","sourcePath":entry.path(),"reason":"symbolic-link"
                        })),
                        Ok(entry) if entry.file_type().is_file() => {
                            sources.push(entry.into_path());
                        }
                        Ok(_) => {}
                        Err(_) => outcomes.push(json!({
                            "status":"failed","sourcePath":root,"code":"unreadable"
                        })),
                    }
                }
            }
            Ok(_) => outcomes.push(json!({
                "status":"skipped","sourcePath":root,"reason":"unsupported-file-type"
            })),
            Err(error) => outcomes.push(json!({
                "status":"failed",
                "sourcePath":root,
                "code":if error.kind()==std::io::ErrorKind::NotFound{"not-found"}else{"unreadable"}
            })),
        }
    }
    sources.sort();
    sources.dedup();
    for source in sources {
        if detect_format(&source).is_none() {
            outcomes.push(json!({
                "status":"skipped","sourcePath":source,"reason":"unsupported-format"
            }));
            continue;
        }
        match store.import(&source, None, move_source) {
            Ok(item) => outcomes.push(json!({
                "status":"imported","sourcePath":source,"item":item
            })),
            Err(error) => outcomes.push(json!({
                "status":"failed",
                "sourcePath":source,
                "code":match error.code(){
                    "cross-device-move"=>"cross-device-move",
                    "storage-unavailable"=>"storage-unavailable",
                    "source-changed"=>"source-changed",
                    _=>"unreadable"
                }
            })),
        }
    }
    let imported = outcomes
        .iter()
        .filter(|value| value["status"] == "imported")
        .count();
    let skipped = outcomes
        .iter()
        .filter(|value| value["status"] == "skipped")
        .count();
    let duplicates = outcomes
        .iter()
        .filter(|value| value["status"] == "duplicate")
        .count();
    let failed = outcomes
        .iter()
        .filter(|value| value["status"] == "failed")
        .count();
    json!({
        "counts":{"total":outcomes.len(),"imported":imported,"skipped":skipped,"duplicates":duplicates,"failed":failed},
        "outcomes":outcomes
    })
}

fn export_many(store: &LibraryStore, request: &Value) -> AppResult<Value> {
    let ids = request
        .get("ids")
        .and_then(Value::as_array)
        .filter(|ids| !ids.is_empty() && ids.len() <= 256)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let destination = request
        .get("destinationPath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let template = request
        .get("fileNameTemplate")
        .and_then(Value::as_str)
        .unwrap_or("author-title");
    if !matches!(template, "title" | "author-title") {
        return Err(AppError::new("invalid-arguments"));
    }
    std::fs::create_dir_all(&destination).map_err(|_| AppError::new("destination-unavailable"))?;
    let mut outcomes = Vec::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let Some(item) = store.get(id)? else {
            outcomes.push(json!({"status":"failed","itemId":id,"code":"item-not-found"}));
            continue;
        };
        let Some(format) = item.formats.first() else {
            outcomes.push(json!({"status":"failed","itemId":id,"code":"source-unavailable"}));
            continue;
        };
        let author = if template == "author-title" {
            item.authors
                .first()
                .map(|author| author.name.as_str())
                .or(item.author.as_deref())
        } else {
            None
        };
        let file_name =
            destinations::destination_file_name(&item.title, author, format.format.extension());
        let target = destination.join(file_name);
        let target_shape = json!({
            "itemId":id,
            "format":format.format,
            "provenance":format.provenance,
            "destinationPath":target
        });
        if target.exists() {
            outcomes.push(merge_json(
                target_shape,
                json!({"status":"skipped","reason":"destination-exists"}),
            ));
            continue;
        }
        match std::fs::copy(&format.source_path, &target) {
            Ok(bytes) => match sha256_file(&target) {
                Ok(sha256) => outcomes.push(merge_json(
                    target_shape,
                    json!({"status":"exported","bytes":bytes,"sha256":sha256,"metadata":"unsupported"}),
                )),
                Err(_) => {
                    let _ = std::fs::remove_file(&target);
                    outcomes.push(merge_json(
                        target_shape,
                        json!({"status":"failed","code":"source-changed"}),
                    ));
                }
            },
            Err(_) => {
                let _ = std::fs::remove_file(&target);
                outcomes.push(merge_json(
                    target_shape,
                    json!({"status":"failed","code":"source-unavailable"}),
                ));
            }
        }
    }
    let exported = outcomes
        .iter()
        .filter(|value| value["status"] == "exported")
        .count();
    let skipped = outcomes
        .iter()
        .filter(|value| value["status"] == "skipped")
        .count();
    let failed = outcomes
        .iter()
        .filter(|value| value["status"] == "failed")
        .count();
    Ok(json!({
        "outcomes":outcomes,
        "counts":{"total":outcomes.len(),"exported":exported,"skipped":skipped,"failed":failed}
    }))
}

fn merge_json(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.clone());
    }
    base
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn library_query_value(store: &LibraryStore, request: &Value) -> AppResult<Value> {
    let query = request
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let filters = request
        .get("filters")
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let authors = string_filter(filters, "authors")?;
    let tags = string_filter(filters, "tags")?;
    let series = string_filter(filters, "series")?;
    let languages = string_filter(filters, "languages")?;
    let formats = string_filter(filters, "formats")?;
    let mut items = if query.is_empty() {
        store.list(false)?
    } else {
        store.search(query)?
    };
    items.retain(|item| {
        matches_filter(
            &authors,
            item.authors
                .iter()
                .map(|author| author.name.as_str())
                .chain(item.author.iter().map(String::as_str)),
        ) && matches_filter(&tags, item.tags.iter().map(String::as_str))
            && matches_filter(&series, item.series.iter().map(String::as_str))
            && matches_filter(&languages, item.languages.iter().map(String::as_str))
            && matches_filter(
                &formats,
                item.formats.iter().map(|format| format.format.as_str()),
            )
    });
    let facets = facet_value(&items);
    let sort_field = request
        .pointer("/sort/field")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let descending = match request.pointer("/sort/direction").and_then(Value::as_str) {
        Some("ascending") => false,
        Some("descending") => true,
        _ => return Err(AppError::new("invalid-arguments")),
    };
    items.sort_by(|left, right| {
        let ordering = query_sort_value(left, sort_field).cmp(&query_sort_value(right, sort_field));
        if descending {
            ordering.reverse()
        } else {
            ordering
        }
    });
    let offset = request
        .pointer("/page/offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::new("invalid-arguments"))? as usize;
    let limit = request
        .pointer("/page/limit")
        .and_then(Value::as_u64)
        .filter(|limit| (1..=100).contains(limit))
        .ok_or_else(|| AppError::new("invalid-arguments"))? as usize;
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(json!({"items":items,"total":total,"page":{"offset":offset,"limit":limit},"facets":facets}))
}

fn string_filter(filters: &Value, name: &str) -> AppResult<Vec<String>> {
    filters
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("invalid-arguments"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.to_lowercase())
                .ok_or_else(|| AppError::new("invalid-arguments"))
        })
        .collect()
}

fn matches_filter<'a>(wanted: &[String], values: impl Iterator<Item = &'a str>) -> bool {
    wanted.is_empty()
        || values
            .map(str::to_lowercase)
            .any(|value| wanted.iter().any(|wanted| wanted == &value))
}

fn query_sort_value(item: &crate::model::LibraryItem, field: &str) -> String {
    match field {
        "title" => item.title.to_lowercase(),
        "author" => item
            .authors
            .first()
            .map(|author| author.name.to_lowercase())
            .or_else(|| item.author.as_ref().map(|author| author.to_lowercase()))
            .unwrap_or_default(),
        "series" => item.series.as_deref().unwrap_or_default().to_lowercase(),
        "publishedDate" => item.published_date.clone().unwrap_or_default(),
        "rating" => format!("{:020.6}", item.rating.unwrap_or(-1.0)),
        "addedAt" => item.added_at.clone(),
        "updatedAt" => item.updated_at.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn facet_value(items: &[crate::model::LibraryItem]) -> Value {
    let mut authors = std::collections::BTreeMap::<String, u64>::new();
    let mut tags = std::collections::BTreeMap::<String, u64>::new();
    let mut series = std::collections::BTreeMap::<String, u64>::new();
    let mut languages = std::collections::BTreeMap::<String, u64>::new();
    let mut formats = std::collections::BTreeMap::<String, u64>::new();
    for item in items {
        for value in item
            .authors
            .iter()
            .map(|author| author.name.as_str())
            .chain(item.author.iter().map(String::as_str))
        {
            *authors.entry(value.to_owned()).or_default() += 1;
        }
        for value in &item.tags {
            *tags.entry(value.clone()).or_default() += 1;
        }
        if let Some(value) = &item.series {
            *series.entry(value.clone()).or_default() += 1;
        }
        for value in &item.languages {
            *languages.entry(value.clone()).or_default() += 1;
        }
        for value in &item.formats {
            *formats.entry(value.format.as_str().to_owned()).or_default() += 1;
        }
    }
    json!({
        "authors":facet_entries(authors),
        "tags":facet_entries(tags),
        "series":facet_entries(series),
        "languages":facet_entries(languages),
        "formats":facet_entries(formats)
    })
}

fn facet_entries(values: std::collections::BTreeMap<String, u64>) -> Vec<Value> {
    values
        .into_iter()
        .map(|(value, count)| json!({"value":value,"count":count}))
        .collect()
}

fn jobs(command: JobsCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        JobsCommand::Enqueue {
            db,
            input,
            from,
            to,
            output,
            library_item_id,
        } => {
            let input = match (input, library_item_id.as_deref(), from) {
                (Some(input), None, None) => input,
                (None, Some(item_id), Some(format)) => {
                    let paths = LibraryPaths::resolve(library, None)?;
                    let item = LibraryStore::open(paths, true)?
                        .get(item_id)?
                        .ok_or_else(|| AppError::new("not-found"))?;
                    item.formats
                        .into_iter()
                        .find(|candidate| candidate.format == format)
                        .map(|candidate| candidate.source_path)
                        .ok_or_else(|| AppError::new("format-not-found"))?
                }
                _ => return Err(AppError::new("invalid-arguments")),
            };
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.enqueue(
                &input,
                to,
                &absolute(&output)?,
                library_item_id.as_deref(),
            )?}))
        }
        JobsCommand::List { db, status } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"jobs":JobStore::open(&path)?.list(status)?}))
        }
        JobsCommand::Get { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.get(&id)?}))
        }
        JobsCommand::Cancel { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.cancel(&id)?}))
        }
        JobsCommand::Retry { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.retry(&id)?}))
        }
        JobsCommand::RunNext {
            db,
            profile,
            timeout_seconds,
        } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?
                .run_next(&profile, Duration::from_secs(timeout_seconds))?}))
        }
        JobsCommand::Drain {
            db,
            max_jobs,
            profile,
            timeout_seconds,
        } => {
            let path = job_path(library, db.as_deref())?;
            let values = JobStore::open(&path)?.drain(
                max_jobs,
                &profile,
                Duration::from_secs(timeout_seconds),
            )?;
            print_success(json!({"jobs":values,"counts":{"processed":values.len()}}))
        }
        JobsCommand::RetryAttachment => Err(AppError::new("feature-unavailable")),
    }
}

fn destination(command: DestinationCommand) -> AppResult<()> {
    match command {
        DestinationCommand::List { volumes_root } => {
            print_success(json!({"destinations":destinations::list(&volumes_root)?}))
        }
        DestinationCommand::Eject { dest, volumes_root } => {
            let device = destinations::authorize(&dest, &volumes_root)?;
            destinations::eject(&device)?;
            print_success(json!({"destinationId":device.id}))
        }
        DestinationCommand::Inventory { dest, volumes_root }
        | DestinationCommand::Reconcile { dest, volumes_root } => {
            let device = destinations::authorize(&dest, &volumes_root)?;
            print_success(
                json!({"destinationId":device.id,"entries":destinations::inventory(&device)?}),
            )
        }
        DestinationCommand::Remove {
            dest,
            id,
            volumes_root,
        } => {
            let device = destinations::authorize(&dest, &volumes_root)?;
            print_success(
                json!({"destinationId":device.id,"removed":destinations::remove(&device,&id)?}),
            )
        }
        DestinationCommand::RootedKindleSend => Err(AppError::new("feature-unavailable")),
    }
}
fn send(
    paths: LibraryPaths,
    id: &str,
    format: Option<FormatId>,
    dest: &Path,
    subdir: Option<&Path>,
    overwrite: bool,
    volumes_root: &Path,
) -> AppResult<()> {
    let item = LibraryStore::open(paths, true)?
        .get(id)?
        .ok_or_else(|| AppError::new("unknown-item"))?;
    let device = destinations::authorize(dest, volumes_root)?;
    let selected = format
        .map_or_else(
            || preferred(&item.formats, device.kind),
            |wanted| {
                item.formats
                    .iter()
                    .find(|candidate| candidate.format == wanted)
            },
        )
        .ok_or_else(|| AppError::new("format-not-found"))?;
    let author = item
        .authors
        .first()
        .map(|value| value.name.as_str())
        .or(item.author.as_deref());
    let extension =
        if selected.format == FormatId::Kepub && matches!(device.kind, DestinationKind::Kobo) {
            "kepub.epub"
        } else {
            selected.format.extension()
        };
    let name = destinations::destination_file_name(&item.title, author, extension);
    print_success(destinations::send(
        &device,
        id,
        &selected.source_path,
        &name,
        selected.format.as_str(),
        subdir,
        overwrite,
    )?)
}
fn preferred(
    formats: &[crate::model::BookFormat],
    kind: DestinationKind,
) -> Option<&crate::model::BookFormat> {
    let preference: &[FormatId] = match kind {
        DestinationKind::Kobo => &[
            FormatId::Kepub,
            FormatId::Epub,
            FormatId::Pdf,
            FormatId::Cbz,
        ],
        DestinationKind::Kindle => &[FormatId::Azw3, FormatId::Mobi, FormatId::Pdf, FormatId::Txt],
        DestinationKind::Generic => &[],
    };
    preference
        .iter()
        .find_map(|wanted| formats.iter().find(|format| format.format == *wanted))
        .or_else(|| formats.first())
}

fn read_json(input: &str) -> AppResult<Value> {
    let bytes = if input == "-" {
        let mut data = Vec::new();
        std::io::stdin()
            .take(16 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| AppError::new("invalid-arguments"))?;
        data
    } else if let Some(path) = input.strip_prefix('@') {
        std::fs::read(path).map_err(|_| AppError::new("invalid-arguments"))?
    } else {
        input.as_bytes().to_vec()
    };
    if bytes.len() > 16 * 1024 {
        return Err(AppError::new("invalid-arguments"));
    }
    serde_json::from_slice(&bytes).map_err(|_| AppError::new("invalid-arguments"))
}
fn request_id(value: &Value) -> AppResult<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AppError::new("invalid-arguments"))
}
fn absolute(path: &Path) -> AppResult<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
fn job_path(library: Option<&str>, db: Option<&Path>) -> AppResult<PathBuf> {
    if db.is_some() && library.is_some() {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(db
        .map(Path::to_path_buf)
        .unwrap_or(LibraryPaths::resolve(library, None)?.jobs))
}
fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        format!(
            "{}...",
            value
                .chars()
                .take(max.saturating_sub(3))
                .collect::<String>()
        )
    }
}
fn open_path(path: &Path) -> AppResult<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    }
    .map_err(|_| AppError::new("open-failed"))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::new("open-failed"))
    }
}
