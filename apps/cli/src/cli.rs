use std::collections::BTreeMap;
use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use clap::{CommandFactory, Parser, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::calibre_import::import_calibre_library;
use crate::conversion::{
    CALIBRE_CAPABILITIES, FormatId, convert, detect_format, discover_ebook_convert,
};
use crate::destinations::{self, DestinationKind};
use crate::import_scan::{ImportCounts, scan_imports};
use crate::jobs::{JobStatus, JobStore};
use crate::kindle_ssh::{self, KindleSshDestination};
use crate::maintenance::{self, discover_ebook_polish};
use crate::metadata::{self, discover_ebook_meta, discover_fetch_ebook_metadata};
use crate::model::{LibraryPatch, Patch};
use crate::output::{AppError, AppResult, print_success};
use crate::paths::LibraryPaths;
use crate::portable_library;
use crate::store::{
    DuplicatePairReviewRequest, LIBRARY_SCHEMA_VERSION, LibraryStore,
    ListDuplicateCandidatesRequest, MergeDuplicatePairRequest, VerifyReport,
};

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
        subcommand,
        about = "Inspect and review ebook metadata through Calibre"
    )]
    Metadata(MetadataCommand),
    #[command(about = "Polish a new EPUB, KEPUB, or AZW3 artifact with Calibre")]
    Polish {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long = "operation", required = true)]
        operations: Vec<String>,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    #[command(about = "Serve authenticated read-only library access in the foreground")]
    Serve {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        #[arg(long)]
        allow_remote: bool,
        #[arg(long = "tls-cert")]
        tls_cert: Option<PathBuf>,
        #[arg(long = "tls-key")]
        tls_key: Option<PathBuf>,
    },
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
        #[arg(long = "source-path", required = true, num_args = 1..=256)]
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
    ImportCalibre {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "library-root")]
        library_root: PathBuf,
    },
    ImportWatch {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path", required = true, num_args = 1..=256)]
        source_paths: Vec<PathBuf>,
        #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u64).range(1..=86_400))]
        interval_seconds: u64,
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..=10_000))]
        max_cycles: Option<u64>,
    },
    Catalog {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        format: String,
        #[arg(long)]
        output: PathBuf,
    },
    ContentSearch {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        query: String,
        #[arg(long = "id")]
        ids: Vec<String>,
        #[arg(long, default_value_t = 256)]
        limit: usize,
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
    },
    Validate {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "id")]
        ids: Vec<String>,
        #[arg(long, default_value_t = 256)]
        limit: usize,
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
    },
    PortableExport {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        dest: PathBuf,
    },
    Rebuild {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        source: PathBuf,
    },
    RestoreBackup {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        source: PathBuf,
    },
    #[command(subcommand)]
    Duplicates(DuplicateCommand),
    #[command(subcommand)]
    SavedViews(SavedViewsCommand),
}

#[derive(Subcommand)]
enum SavedViewsCommand {
    List {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    Save {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum DuplicateCommand {
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Keep {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Reopen {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    Merge {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
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
enum MetadataCommand {
    Extract {
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long, default_value_t = 15)]
        timeout_seconds: u64,
    },
    Fetch {
        #[arg(long)]
        title: Option<String>,
        #[arg(long = "author")]
        authors: Vec<String>,
        #[arg(long = "identifier")]
        identifiers: Vec<String>,
        #[arg(long = "cover-output")]
        cover_output: Option<PathBuf>,
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    #[command(subcommand)]
    Candidates(MetadataCandidatesCommand),
}

#[derive(Subcommand)]
enum MetadataCandidatesCommand {
    Filename {
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        id: Option<String>,
        #[arg(long = "pattern")]
        patterns: Vec<String>,
    },
    Item {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long)]
        include_online: bool,
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    Apply {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "candidate-json")]
        candidate_json: Option<String>,
        #[arg(long = "patch-json")]
        patch_json: Option<String>,
        #[arg(long)]
        provenance: String,
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
    RetryAttachment {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
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
    RootedKindleSend {
        #[arg(long)]
        id: String,
        #[arg(long)]
        format: FormatId,
        #[arg(long)]
        host: String,
        #[arg(long)]
        user: String,
        #[arg(long = "remote-root")]
        remote_root: String,
        #[arg(long = "identity-file")]
        identity_file: PathBuf,
        #[arg(long)]
        port: u16,
        #[arg(long = "timeout-ms")]
        timeout_ms: u64,
    },
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
                return Err(AppError::new("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(cli.library.as_deref(), db.as_deref())?;
            let store = LibraryStore::open(paths, false)?;
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

fn metadata_command(command: MetadataCommand, library: Option<&str>) -> AppResult<()> {
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

fn metadata_candidates(command: MetadataCandidatesCommand, library: Option<&str>) -> AppResult<()> {
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
                return Err(AppError::new("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
            let item = store
                .get(&id)?
                .ok_or_else(|| AppError::new("item-not-found"))?;
            let mut candidates = filename_candidates(&item.source_path, Some(&item.id), &[])?;
            if discover_ebook_meta().is_some()
                && let Ok(extracted) =
                    metadata::extract(&item.source_path, Duration::from_secs(timeout_seconds))
                && let Some(candidate) = metadata_candidate(
                    "embedded:1",
                    "embedded",
                    "high",
                    extracted.metadata,
                    json!({"generatedAt":"1970-01-01T00:00:00.000Z","itemId":item.id,"sourcePath":extracted.source_path,"backend":"ebook-meta"}),
                )
            {
                candidates.push(candidate);
            }
            if include_online && discover_fetch_ebook_metadata().is_some() {
                let authors = if item.authors.is_empty() {
                    item.author.clone().into_iter().collect::<Vec<_>>()
                } else {
                    item.authors
                        .iter()
                        .map(|author| author.name.clone())
                        .collect()
                };
                if let Ok(fetched) = metadata::fetch(
                    Some(&item.title),
                    &authors,
                    &item.identifiers,
                    None,
                    Duration::from_secs(timeout_seconds),
                ) && let Some(candidate) = metadata_candidate(
                    "online:1",
                    "online",
                    "medium",
                    fetched.metadata,
                    json!({"generatedAt":"1970-01-01T00:00:00.000Z","itemId":item.id,"backend":"fetch-ebook-metadata"}),
                ) {
                    candidates.push(candidate);
                }
            }
            candidates.truncate(8);
            print_success(json!({"itemId":item.id,"candidates":candidates}))
        }
        MetadataCandidatesCommand::Apply {
            db,
            id,
            candidate_json,
            patch_json,
            provenance,
        } => {
            if id.trim().is_empty()
                || provenance.trim().is_empty()
                || candidate_json.is_some() == patch_json.is_some()
            {
                return Err(AppError::new("invalid-arguments"));
            }
            let id = id.trim().to_owned();
            let provenance = provenance.trim().to_owned();
            let Some(candidate_input) = candidate_json else {
                // Manual patches carry no candidate identity, so they are not
                // recorded as a candidate audit entry and answer a plain
                // envelope rather than the candidate apply response schema.
                let patch_value = read_json(patch_json.as_deref().unwrap_or_default())?;
                let patch: LibraryPatch = serde_json::from_value(patch_value)
                    .map_err(|_| AppError::new("invalid-arguments"))?;
                let paths = LibraryPaths::resolve(library, db.as_deref())?;
                let mut store = LibraryStore::open(paths, true)?;
                let item = store.update(&id, patch)?;
                return print_success(
                    json!({"item":item,"applied":{"itemId":id,"source":"manual","provenance":provenance}}),
                );
            };

            // The engine validates the candidate independently of any client,
            // and fully before opening or mutating a library, so malformed or
            // cross-item input has no side effect at all.
            let candidate: WireCandidate = serde_json::from_value(read_json(&candidate_input)?)
                .map_err(|_| AppError::new("invalid-arguments"))?;
            let selected_fields = candidate.validated_fields(&id)?;
            let patch: LibraryPatch = serde_json::from_value(candidate.patch.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;

            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::open(paths, true)?;
            let current = store
                .get(&id)?
                .ok_or_else(|| AppError::new("item-not-found"))?;
            let audit = json!({
                "schemaVersion": METADATA_AUDIT_SCHEMA_VERSION,
                "candidateId": candidate.id,
                "source": candidate.source,
                "confidence": candidate.confidence,
                "candidateProvenance": candidate.provenance,
                "selectedFields": selected_fields,
                "applicationProvenance": provenance,
            });
            let mut patch = patch;
            patch.custom_metadata = Patch::Set(merge_metadata_audit(
                &current.custom_metadata,
                &patch.custom_metadata,
                &audit,
            )?);
            let item = store.update(&id, patch)?;
            print_success(json!({
                "item": item,
                "applied": {
                    "itemId": id,
                    "candidateId": candidate.id,
                    "source": candidate.source,
                    "provenance": provenance,
                    "fields": selected_fields,
                }
            }))
        }
    }
}

pub(crate) const METADATA_AUDIT_KEY: &str = "takio_metadata_audit";
const METADATA_AUDIT_SCHEMA_VERSION: u64 = 1;
const MAX_CUSTOM_METADATA_ENTRIES: usize = 64;
const MAX_CUSTOM_METADATA_VALUE_BYTES: usize = 16 * 1024;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCandidateProvenance {
    generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCandidate {
    schema_version: u64,
    id: String,
    source: String,
    confidence: String,
    patch: Value,
    provenance: WireCandidateProvenance,
}

impl WireCandidate {
    /// Validates every advertised candidate bound and the exact item identity,
    /// returning the selected patch field names in stable order.
    fn validated_fields(&self, item_id: &str) -> AppResult<Vec<String>> {
        let invalid = || AppError::new("invalid-arguments");
        if self.schema_version != 1
            || self.id.trim().is_empty()
            || self.id.len() > 120
            || !["filename", "embedded", "online"].contains(&self.source.as_str())
            || !["low", "medium", "high"].contains(&self.confidence.as_str())
        {
            return Err(invalid());
        }
        let provenance = &self.provenance;
        if provenance.item_id.as_deref() != Some(item_id)
            || chrono::DateTime::parse_from_rfc3339(&provenance.generated_at).is_err()
            || provenance
                .source_path
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 4096)
            || provenance
                .pattern
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || provenance.backend.as_ref().is_some_and(|value| {
                !["ebook-meta", "fetch-ebook-metadata"].contains(&value.as_str())
            })
        {
            return Err(invalid());
        }
        self.patch
            .as_object()
            .filter(|object| !object.is_empty())
            .map(|object| object.keys().cloned().collect())
            .ok_or_else(invalid)
    }
}

/// Builds the effective custom metadata for a candidate application, honouring
/// the patch's own semantics for the field: `Missing` preserves the stored
/// entries, `Null` clears them, and `Set` replaces them. The durable audit
/// entry is added last, so candidate-selected custom metadata cannot erase it.
fn merge_metadata_audit(
    existing: &BTreeMap<String, String>,
    selected: &Patch<BTreeMap<String, String>>,
    audit: &Value,
) -> AppResult<BTreeMap<String, String>> {
    let mut merged = match selected {
        Patch::Missing => existing.clone(),
        Patch::Null => BTreeMap::new(),
        Patch::Set(value) => value.clone(),
    };
    let encoded = serde_json::to_string(audit).map_err(|_| AppError::new("storage-unavailable"))?;
    if encoded.len() > MAX_CUSTOM_METADATA_VALUE_BYTES {
        return Err(AppError::new("invalid-arguments"));
    }
    if !merged.contains_key(METADATA_AUDIT_KEY) && merged.len() >= MAX_CUSTOM_METADATA_ENTRIES {
        return Err(AppError::new("invalid-arguments"));
    }
    merged.insert(METADATA_AUDIT_KEY.to_owned(), encoded);
    Ok(merged)
}

fn parse_identifiers(inputs: &[String]) -> AppResult<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for input in inputs {
        let (kind, value) = input
            .split_once(':')
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        let kind = kind.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if kind.is_empty() || value.is_empty() || values.insert(kind, value).is_some() {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    Ok(values)
}

fn filename_candidates(
    source: &Path,
    item_id: Option<&str>,
    custom_patterns: &[String],
) -> AppResult<Vec<Value>> {
    const BUILTINS: [&str; 4] = [
        r"^(?<author>.+?) - (?<series>.+?) (?<seriesIndex>\d+(?:\.\d+)?) - (?<title>.+)$",
        r"^(?<author>.+?) - (?<title>.+?) \((?<series>.+?) #(?<seriesIndex>\d+(?:\.\d+)?)\)$",
        r"^(?<author>.+?) - (?<title>.+)$",
        r"^(?<title>.+?) - (?<author>.+)$",
    ];
    if custom_patterns
        .iter()
        .any(|pattern| pattern.is_empty() || pattern.len() > 240)
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let patterns = custom_patterns
        .iter()
        .map(String::as_str)
        .chain(BUILTINS)
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for pattern in patterns {
        let expression =
            regex::Regex::new(pattern).map_err(|_| AppError::new("invalid-arguments"))?;
        let Some(captures) = expression.captures(stem) else {
            continue;
        };
        let clean = |name: &str| {
            captures.name(name).and_then(|value| {
                let value = value
                    .as_str()
                    .replace(['.', '_'], " ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                (!value.is_empty()).then_some(value)
            })
        };
        let Some(title) = clean("title") else {
            continue;
        };
        let author = clean("author");
        let series = clean("series");
        let series_index = clean("seriesIndex").and_then(|value| value.parse::<f64>().ok());
        let mut patch = json!({"title":title});
        if let Some(object) = patch.as_object_mut() {
            if let Some(author) = author {
                object.insert("author".to_owned(), json!(author));
                object.insert("authors".to_owned(), json!([{"name":author}]));
            }
            if let Some(series) = series {
                object.insert("series".to_owned(), json!(series));
            }
            if let Some(series_index) = series_index {
                object.insert("seriesIndex".to_owned(), json!(series_index));
            }
        }
        let id = format!("filename:{}", candidates.len() + 1);
        candidates.push(json!({
            "schemaVersion":1,
            "id":id,
            "source":"filename",
            "confidence":if custom_patterns.first().is_some_and(|value|value==pattern){"high"}else{"medium"},
            "patch":patch,
            "provenance":{"generatedAt":"1970-01-01T00:00:00.000Z","itemId":item_id,"sourcePath":source,"pattern":pattern}
        }));
        if candidates.len() == 8 {
            break;
        }
    }
    Ok(candidates)
}

fn metadata_candidate(
    id: &str,
    source: &str,
    confidence: &str,
    patch: Value,
    provenance: Value,
) -> Option<Value> {
    patch
        .as_object()
        .is_some_and(|object| !object.is_empty())
        .then(|| json!({"schemaVersion":1,"id":id,"source":source,"confidence":confidence,"patch":patch,"provenance":provenance}))
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
            if source_paths.is_empty() || source_paths.len() > 256 {
                return Err(AppError::new("invalid-arguments"));
            }
            let move_source = match mode.as_str() {
                "copy" => false,
                "move" => true,
                _ => return Err(AppError::new("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            validate_import_sources(&paths, &source_paths)?;
            let mut store = LibraryStore::open(paths, true)?;
            print_success(scan_imports(
                &mut store,
                &source_paths,
                move_source,
                false,
                || false,
            )?)
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
        LibraryCommand::ImportCalibre { db, library_root } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(import_calibre_library(paths, &library_root)?)
        }
        LibraryCommand::Catalog { db, format, output } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let items = LibraryStore::open(paths, true)?.list(false)?;
            print_success(json!({"catalog":write_catalog(&items, &format, &output)?}))
        }
        LibraryCommand::ContentSearch {
            db,
            query,
            ids,
            limit,
            timeout_seconds,
        } => {
            if query.trim().is_empty() || !valid_selection(&ids, limit) || timeout_seconds == 0 {
                return Err(AppError::new("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
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
                return Err(AppError::new("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
            print_success(validate_library_formats(
                &store,
                &ids,
                limit,
                Duration::from_secs(timeout_seconds),
            )?)
        }
        LibraryCommand::PortableExport { db, dest } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, false)?;
            print_success(portable_library::export(&store, &dest)?)
        }
        LibraryCommand::Rebuild { db, source } => {
            let paths = LibraryPaths::resolve(library, Some(&db))?;
            print_success(portable_library::rebuild(&source, paths)?)
        }
        LibraryCommand::RestoreBackup { db, source } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"restore":LibraryStore::restore_backup(&source, paths)?}))
        }
        LibraryCommand::SavedViews(command) => library_saved_views(command, library),
        LibraryCommand::Duplicates(command) => library_duplicates(command, library),
        LibraryCommand::ImportWatch {
            db,
            source_paths,
            interval_seconds,
            max_cycles,
        } => {
            if source_paths.is_empty() || source_paths.len() > 256 {
                return Err(AppError::new("invalid-arguments"));
            }
            import_watch(
                library,
                db.as_deref(),
                &source_paths,
                interval_seconds,
                max_cycles,
            )
        }
    }
}

fn library_saved_views(command: SavedViewsCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        SavedViewsCommand::List { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"views":LibraryStore::open(paths, true)?.list_saved_views()?}))
        }
        SavedViewsCommand::Save { db, request_json } => {
            let request = read_json(&request_json)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"view":LibraryStore::open(paths, true)?.save_view(&request)?}))
        }
        SavedViewsCommand::Remove { db, request_json } => {
            let request = read_json(&request_json)?;
            if request
                .as_object()
                .is_none_or(|object| object.len() != 1 || !object.contains_key("id"))
            {
                return Err(AppError::new("invalid-arguments"));
            }
            let id = request
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"view":LibraryStore::open(paths, true)?.remove_view(id)?}))
        }
    }
}

fn library_duplicates(command: DuplicateCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        DuplicateCommand::List { db, request_json } => {
            let request =
                serde_json::from_value::<ListDuplicateCandidatesRequest>(read_json(&request_json)?)
                    .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open(paths, true)?;
            print_success(
                serde_json::to_value(store.list_duplicate_candidates(&request)?)
                    .map_err(|_| AppError::new("storage-unavailable"))?,
            )
        }
        DuplicateCommand::Keep { db, request_json } => {
            let request =
                serde_json::from_value::<DuplicatePairReviewRequest>(read_json(&request_json)?)
                    .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            LibraryStore::open(paths, true)?.keep_duplicate_pair(&request)?;
            print_success(Value::Null)
        }
        DuplicateCommand::Reopen { db, request_json } => {
            let request =
                serde_json::from_value::<DuplicatePairReviewRequest>(read_json(&request_json)?)
                    .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            LibraryStore::open(paths, true)?.reopen_duplicate_pair(&request)?;
            print_success(Value::Null)
        }
        DuplicateCommand::Merge { db, request_json } => {
            let request =
                serde_json::from_value::<MergeDuplicatePairRequest>(read_json(&request_json)?)
                    .map_err(|_| AppError::new("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let result = LibraryStore::open(paths, true)?.merge_duplicate_pair(&request)?;
            print_success(
                serde_json::to_value(result).map_err(|_| AppError::new("storage-unavailable"))?,
            )
        }
    }
}

fn write_catalog(
    items: &[crate::model::LibraryItem],
    format: &str,
    output: &Path,
) -> AppResult<Value> {
    if output.exists()
        || output.parent().is_none_or(|parent| !parent.is_dir())
        || !matches!(format, "json" | "csv" | "html")
        || output
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case(format))
    {
        return Err(AppError::new(if output.exists() {
            "output-file-exists"
        } else {
            "invalid-arguments"
        }));
    }
    let records = items.iter().map(catalog_record).collect::<Vec<_>>();
    let body = match format {
        "json" => format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({"version":1,"books":records}))
                .map_err(|_| AppError::new("write-failed"))?
        ),
        "csv" => render_catalog_csv(items),
        "html" => render_catalog_html(items),
        _ => return Err(AppError::new("invalid-arguments")),
    };
    if body.len() > 64 * 1024 * 1024 {
        return Err(AppError::new("write-failed"));
    }
    let absolute_output = absolute(output)?;
    let parent = output
        .parent()
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let temporary = parent.join(format!(".takio-catalog-{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let publication = (|| -> AppResult<()> {
        let mut file = options
            .open(&temporary)
            .map_err(|_| AppError::new("write-failed"))?;
        file.write_all(body.as_bytes())
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|_| AppError::new("write-failed"))?;
        if !temporary.is_file() {
            return Err(AppError::new("write-failed"));
        }
        std::fs::hard_link(&temporary, output).map_err(|_| AppError::new("write-failed"))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    publication?;
    let mut hash = Sha256::new();
    hash.update(body.as_bytes());
    Ok(
        json!({"path":absolute_output,"books":items.len(),"bytes":body.len(),"sha256":hex::encode(hash.finalize()),"format":format}),
    )
}

fn catalog_record(item: &crate::model::LibraryItem) -> Value {
    let authors = if item.authors.is_empty() {
        item.author.clone().into_iter().collect::<Vec<_>>()
    } else {
        item.authors
            .iter()
            .map(|author| author.name.clone())
            .collect::<Vec<_>>()
    };
    let mut record = json!({
        "id":item.id,
        "title":item.title,
        "authors":authors,
        "tags":item.tags,
        "formats":item.formats.iter().map(|format|format.format).collect::<Vec<_>>(),
        "hasCover":item.cover_path.is_some()
    });
    let object = record.as_object_mut().expect("catalog record object");
    for (key, value) in [
        ("series", item.series.as_ref().map(|value| json!(value))),
        ("seriesIndex", item.series_index.map(|value| json!(value))),
        (
            "publisher",
            item.publisher.as_ref().map(|value| json!(value)),
        ),
        (
            "publishedDate",
            item.published_date.as_ref().map(|value| json!(value)),
        ),
        ("rating", item.rating.map(|value| json!(value))),
        (
            "description",
            item.description.as_ref().map(|value| json!(value)),
        ),
    ] {
        if let Some(value) = value {
            object.insert(key.to_owned(), value);
        }
    }
    if !item.languages.is_empty() {
        object.insert("languages".to_owned(), json!(item.languages));
    }
    if !item.identifiers.is_empty() {
        object.insert("identifiers".to_owned(), json!(item.identifiers));
    }
    if !item.custom_metadata.is_empty() {
        object.insert("customMetadata".to_owned(), json!(item.custom_metadata));
    }
    record
}

fn render_catalog_csv(items: &[crate::model::LibraryItem]) -> String {
    let mut output = "id,title,authors,series,seriesIndex,publisher,publishedDate,languages,tags,formats,rating,identifiers,customMetadata,description\n".to_owned();
    for item in items {
        let record = catalog_record(item);
        let values = [
            item.id.clone(),
            item.title.clone(),
            record["authors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; "),
            item.series.clone().unwrap_or_default(),
            item.series_index
                .map(|value| value.to_string())
                .unwrap_or_default(),
            item.publisher.clone().unwrap_or_default(),
            item.published_date.clone().unwrap_or_default(),
            item.languages.join("; "),
            item.tags.join("; "),
            item.formats
                .iter()
                .map(|format| format.format.as_str())
                .collect::<Vec<_>>()
                .join("; "),
            item.rating
                .map(|value| value.to_string())
                .unwrap_or_default(),
            serde_json::to_string(&item.identifiers).unwrap_or_else(|_| "{}".to_owned()),
            serde_json::to_string(&item.custom_metadata).unwrap_or_else(|_| "{}".to_owned()),
            item.description.clone().unwrap_or_default(),
        ];
        output.push_str(
            &values
                .iter()
                .map(|value| csv_cell(value))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push('\n');
    }
    output
}

fn csv_cell(value: &str) -> String {
    let passive = if value
        .trim_start_matches(|value: char| value.is_whitespace() || value.is_control())
        .starts_with(['=', '+', '-', '@'])
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    format!("\"{}\"", passive.replace('"', "\"\""))
}

fn render_catalog_html(items: &[crate::model::LibraryItem]) -> String {
    let rows = items
        .iter()
        .map(|item| {
            format!(
                "      <tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                html_escape(&item.title),
                html_escape(
                    &item
                        .authors
                        .iter()
                        .map(|author| author.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                html_escape(item.series.as_deref().unwrap_or_default()),
                html_escape(&item.tags.join(", ")),
                html_escape(
                    &item
                        .formats
                        .iter()
                        .map(|format| format.format.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            )
        })
        .collect::<String>();
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Takio catalog</title><style>body{{font:16px system-ui;margin:2rem}}table{{border-collapse:collapse;width:100%}}th,td{{border-bottom:1px solid #ccc;padding:.5rem;text-align:left}}</style></head><body><h1>Takio catalog</h1><table><thead><tr><th>Title</th><th>Authors</th><th>Series</th><th>Tags</th><th>Formats</th></tr></thead><tbody>\n{rows}\n    </tbody></table></body></html>\n"
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn valid_selection(ids: &[String], limit: usize) -> bool {
    limit > 0
        && limit <= 256
        && ids.len() <= limit
        && ids.iter().all(|id| !id.trim().is_empty())
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}

type SelectedLibraryItems = Vec<(String, Option<crate::model::LibraryItem>)>;

fn selected_items(
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

fn content_search(
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
        let Some(format) = item.formats.iter().find(|format| {
            matches!(
                format.format,
                FormatId::Kepub
                    | FormatId::Epub
                    | FormatId::Pdf
                    | FormatId::Mobi
                    | FormatId::Azw3
                    | FormatId::Docx
                    | FormatId::Html
                    | FormatId::Txt
            )
        }) else {
            outcomes.push(json!({"status":"skipped","itemId":item_id,"code":"unsupported-format"}));
            continue;
        };
        match maintenance::extract_text(&format.source_path, timeout) {
            Ok((_, text)) => {
                let (matches, snippets) = maintenance::find_literal_text(&text, query, 3);
                if matches == 0 {
                    outcomes.push(json!({"status":"no-match","itemId":item_id,"format":format.format}));
                } else {
                    outcomes.push(json!({"status":"matched","itemId":item_id,"title":item.title,"format":format.format,"matches":matches,"snippets":snippets}));
                }
            }
            Err(error) => outcomes.push(json!({"status":"failed","itemId":item_id,"format":format.format,"code":error.code()})),
        }
    }
    let count = |status: &str| {
        outcomes
            .iter()
            .filter(|value| value["status"] == status)
            .count()
    };
    Ok(
        json!({"query":query,"available":available,"selected":outcomes.len(),"canceled":false,"counts":{"total":outcomes.len(),"matched":count("matched"),"noMatch":count("no-match"),"missing":count("missing"),"skipped":count("skipped"),"failed":count("failed")},"outcomes":outcomes}),
    )
}

fn validate_library_formats(
    store: &LibraryStore,
    ids: &[String],
    limit: usize,
    timeout: Duration,
) -> AppResult<Value> {
    if discover_ebook_meta().is_none() {
        return Err(AppError::new("backend-unavailable"));
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
                if matches!(
                    format.format,
                    FormatId::Kepub
                        | FormatId::Epub
                        | FormatId::Pdf
                        | FormatId::Mobi
                        | FormatId::Azw3
                        | FormatId::Docx
                        | FormatId::Html
                        | FormatId::Txt
                ) {
                    maintenance::extract_text(&format.source_path, timeout).map(|_| "checked")
                } else {
                    Ok("not-applicable")
                }
            });
            match result {
                Ok(content) => outcomes.push(json!({"status":"valid","itemId":item_id,"format":format.format,"content":content})),
                Err(error) => outcomes.push(json!({"status":"failed","itemId":item_id,"format":format.format,"code":error.code()})),
            }
        }
    }
    let count = |status: &str| {
        outcomes
            .iter()
            .filter(|value| value["status"] == status)
            .count()
    };
    Ok(
        json!({"available":available,"selected":selected,"outcomes":outcomes,"counts":{"total":outcomes.len(),"valid":count("valid"),"missing":count("missing"),"failed":count("failed")}}),
    )
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
        "library_duplicates_list" => {
            let request = serde_json::from_value::<ListDuplicateCandidatesRequest>(args.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            serde_json::to_value(store.list_duplicate_candidates(&request)?)
                .map_err(|_| AppError::new("storage-unavailable"))
        }
        "library_duplicates_keep" => {
            let request = serde_json::from_value::<DuplicatePairReviewRequest>(args.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            store.keep_duplicate_pair(&request)?;
            Ok(Value::Null)
        }
        "library_duplicates_reopen" => {
            let request = serde_json::from_value::<DuplicatePairReviewRequest>(args.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            store.reopen_duplicate_pair(&request)?;
            Ok(Value::Null)
        }
        "library_duplicates_merge" => {
            let request = serde_json::from_value::<MergeDuplicatePairRequest>(args.clone())
                .map_err(|_| AppError::new("invalid-arguments"))?;
            serde_json::to_value(store.merge_duplicate_pair(&request)?)
                .map_err(|_| AppError::new("storage-unavailable"))
        }
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

fn import_watch(
    library: Option<&str>,
    db: Option<&Path>,
    source_paths: &[PathBuf],
    interval_seconds: u64,
    max_cycles: Option<u64>,
) -> AppResult<()> {
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    use std::sync::mpsc;

    let paths = LibraryPaths::resolve(library, db)?;
    validate_import_sources(&paths, source_paths)?;
    let mut store = LibraryStore::open(paths, true)?;
    let mut signals = Signals::new([SIGINT, SIGTERM])?;
    let handle = signals.handle();
    let (sender, receiver) = mpsc::sync_channel(1);
    let signal_thread = std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            let _ = sender.try_send(());
        }
    });

    let mut cycles = 0_u64;
    let mut counts = ImportCounts::default();
    let mut stopped = false;
    loop {
        let scan = scan_imports(&mut store, source_paths, false, true, || {
            receiver.try_recv().is_ok()
        })?;
        cycles += 1;
        counts.add(scan.counts);
        if scan.stopped || receiver.try_recv().is_ok() {
            stopped = true;
            break;
        }
        if max_cycles.is_some_and(|maximum| cycles >= maximum) {
            break;
        }
        match receiver.recv_timeout(Duration::from_secs(interval_seconds)) {
            Ok(()) => {
                stopped = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    handle.close();
    signal_thread
        .join()
        .map_err(|_| AppError::new("storage-unavailable"))?;
    print_success(json!({"cycles":cycles,"stopped":stopped,"counts":counts}))
}

fn validate_import_sources(paths: &LibraryPaths, sources: &[PathBuf]) -> AppResult<()> {
    let protected = [&paths.database, &paths.jobs, &paths.items, &paths.covers]
        .into_iter()
        .map(|path| path_for_overlap(path))
        .collect::<AppResult<Vec<_>>>()?;
    for source in sources {
        let source = path_for_overlap(source)?;
        if protected
            .iter()
            .any(|path| source.starts_with(path) || path.starts_with(&source))
        {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    Ok(())
}

fn path_for_overlap(path: &Path) -> AppResult<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::new("invalid-arguments"));
                }
            }
        }
    }

    let mut ancestor = normalized.as_path();
    let mut missing = Vec::new();
    while std::fs::symlink_metadata(ancestor).is_err() {
        let leaf = ancestor
            .file_name()
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
        missing.push(leaf.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?;
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|_| AppError::new("invalid-arguments"))?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
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
            let mut store = JobStore::open(&path)?;
            let job = store.run_next(&profile, Duration::from_secs(timeout_seconds))?;
            let job = job
                .map(|job| reconcile_job_attachment(&store, library, job))
                .transpose()?;
            print_success(json!({"job":job}))
        }
        JobsCommand::Drain {
            db,
            max_jobs,
            profile,
            timeout_seconds,
        } => {
            let path = job_path(library, db.as_deref())?;
            let mut store = JobStore::open(&path)?;
            let values = store.drain(max_jobs, &profile, Duration::from_secs(timeout_seconds))?;
            let values = values
                .into_iter()
                .map(|job| reconcile_job_attachment(&store, library, job))
                .collect::<AppResult<Vec<_>>>()?;
            print_success(json!({"jobs":values,"counts":{"processed":values.len()}}))
        }
        JobsCommand::RetryAttachment { db, id } => {
            if db.is_some() || id.trim().is_empty() {
                return Err(AppError::new("invalid-arguments"));
            }
            let path = job_path(library, None)?;
            let store = JobStore::open(&path)?;
            let job = store.retry_attachment(&id)?;
            print_success(json!({"job":reconcile_job_attachment(&store, library, job)?}))
        }
    }
}

fn reconcile_job_attachment(
    jobs: &JobStore,
    library: Option<&str>,
    job: crate::jobs::ConversionJob,
) -> AppResult<crate::jobs::ConversionJob> {
    if job.attachment.as_ref().map(|value| value.status.as_str()) != Some("pending") {
        return Ok(job);
    }
    let Some(item_id) = job.library_item_id.as_deref() else {
        return jobs.finish_attachment(&job.id, Some("invalid-attachment"));
    };
    let Some(artifact) = job.artifact.as_ref() else {
        return jobs.finish_attachment(&job.id, Some("artifact-invalid"));
    };
    let paths = LibraryPaths::resolve(library, None)?;
    let result = LibraryStore::open(paths, true).and_then(|mut store| {
        store.attach_verified_artifact(
            item_id,
            &artifact.path,
            job.output_format,
            artifact.bytes,
            &artifact.sha256,
        )
    });
    match result {
        Ok(_) => jobs.finish_attachment(&job.id, None),
        Err(error) => jobs.finish_attachment(&job.id, Some(error.code())),
    }
}

fn destination(command: DestinationCommand, library: Option<&str>) -> AppResult<()> {
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
            let paths = LibraryPaths::resolve(library, None)?;
            let item = LibraryStore::open(paths, true)?
                .get(&id)?
                .ok_or_else(|| AppError::new("not-found"))?;
            let source = item
                .formats
                .iter()
                .find(|candidate| candidate.format == format)
                .ok_or_else(|| AppError::new("format-not-found"))?;
            if detect_format(&source.source_path) != Some(format) {
                return Err(AppError::new("format-mismatch"));
            }
            let destination = KindleSshDestination {
                host,
                user,
                port,
                remote_root,
                identity_file,
                timeout: Duration::from_millis(timeout_ms),
            };
            print_success(kindle_ssh::send(&id, &source.source_path, &destination)?)
        }
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
