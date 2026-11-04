use std::collections::BTreeMap;
use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{CommandFactory, Parser, Subcommand};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::output::print_success;
use takio::conversion::jobs::{JobStatus, JobStore};
use takio::conversion::maintenance::{self, discover_ebook_polish};
use takio::conversion::{CALIBRE_CAPABILITIES, convert, discover_ebook_convert};
use takio::delivery::destinations::{self, DestinationKind};
use takio::delivery::kindle_ssh::{self, KindleSshDestination};
use takio::delivery::reader_shelf;
use takio::error::AppResult;
use takio::format::{FormatId, detect_format};
use takio::import::calibre::import_calibre_library;
use takio::import::scan::{ImportCounts, ImportOutcome, scan_imports, validate_import_sources};
use takio::library::catalog::write_catalog;
use takio::library::model::LibraryPatch;
use takio::library::paths::{LibraryPaths, absolute};
use takio::library::portable;
use takio::library::store::{
    DuplicatePairReviewRequest, LIBRARY_SCHEMA_VERSION, LibraryStore,
    ListDuplicateCandidatesRequest, MergeDuplicatePairRequest, VerifyReport,
};
use takio::metadata::candidates::{
    CandidateSelection, apply_prepared_metadata_candidate, filename_candidates,
    metadata_candidates_for_item_at, metadata_candidates_for_reconcile, prepare_metadata_candidate,
};
use takio::metadata::reconcile::{CancellationSignals, ReconcileRequest, reconcile};
use takio::metadata::{self, discover_ebook_meta, discover_fetch_ebook_metadata};

#[derive(Parser)]
#[command(
    name = "takio",
    version,
    about = "Manage, convert, and deliver a local ebook library",
    disable_help_subcommand = true
)]
struct Cli {
    #[arg(
        long,
        global = true,
        value_name = "NAME",
        help = "Use an independent named library under the Takio data directory"
    )]
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
    #[command(
        subcommand,
        about = "Import, browse, edit, verify, back up, and export the local library"
    )]
    Library(LibraryCommand),
    #[command(subcommand, about = "Manage the durable foreground conversion queue")]
    Jobs(JobsCommand),
    #[command(
        subcommand,
        about = "Discover mounted volumes and manage verified deliveries"
    )]
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
    #[command(about = "Manage bounded library-defined text column labels")]
    CustomColumns {
        #[command(subcommand)]
        command: CustomColumnsCommand,
    },
    #[command(about = "Run the newline-delimited JSON request loop for automation clients")]
    Service {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    #[command(about = "Print the resolved library database path")]
    Path {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    #[command(
        about = "Audit schema, integrity, and managed-file fingerprints without modifying anything"
    )]
    Verify {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    #[command(about = "Create a verified snapshot of the database and every managed file")]
    Backup {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        dest: PathBuf,
    },
    #[command(about = "Write a redacted diagnostics bundle for support")]
    Diagnostics {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        dest: PathBuf,
    },
    #[command(
        about = "Add a book by copying the source into the library (alias of import --mode copy)"
    )]
    Add {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    #[command(about = "Import one book as a managed copy or move it into the library")]
    Import {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        title: Option<String>,
        #[arg(long, default_value = "copy", value_parser = ["copy", "move"])]
        mode: String,
    },
    #[command(about = "List every active book")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(
            long,
            help = "Print a readable table, including which mounted readers hold each book"
        )]
        human: bool,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(about = "Get one book by ID")]
    Get {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Literal substring search across titles, authors, tags, and custom fields")]
    Search {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        query: String,
    },
    #[command(about = "Run a filtered, sorted, paged query with facets")]
    Query {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Apply a metadata patch to one book")]
    Update {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "patch-json")]
        patch_json: String,
    },
    #[command(about = "Apply the same metadata patch to several books")]
    UpdateMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "id", required = true)]
        ids: Vec<String>,
        #[arg(long = "patch-json")]
        patch_json: String,
    },
    #[command(
        subcommand,
        about = "Manage owned copies and caller-owned format references"
    )]
    Format(FormatCommand),
    #[command(subcommand, about = "Manage Takio-owned cover images")]
    Cover(CoverCommand),
    #[command(about = "Open a stored format with the operating system's default application")]
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
    #[command(
        subcommand,
        about = "Recoverably remove, restore, or permanently purge books"
    )]
    Trash(TrashCommand),
    #[command(about = "Recursively import up to 256 files or directories")]
    ImportMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "source-path", required = true, num_args = 1..=256)]
        source_paths: Vec<PathBuf>,
        #[arg(long, default_value = "copy", value_parser = ["copy", "move"])]
        mode: String,
    },
    #[command(about = "Copy and verify selected formats into a destination directory")]
    ExportMany {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Move a book to recoverable trash without deleting its files")]
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Import metadata and formats from a Calibre library read-only")]
    ImportCalibre {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "library-root")]
        library_root: PathBuf,
    },
    #[command(about = "Watch directories and import new books on a bounded interval")]
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
    #[command(about = "Publish a JSON, CSV, or HTML catalogue of the library")]
    Catalog {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, value_parser = ["json", "csv", "html"])]
        format: String,
        #[arg(long)]
        output: PathBuf,
    },
    #[command(about = "Search inside book contents using bounded text extraction")]
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
    #[command(about = "Validate attached formats with Calibre")]
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
    #[command(about = "Export the library as portable OPF plus exact managed bytes")]
    PortableExport {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        dest: PathBuf,
    },
    #[command(about = "Rebuild a new library from a verified portable export")]
    Rebuild {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        source: PathBuf,
    },
    #[command(about = "Restore a verified backup snapshot into a new library path")]
    RestoreBackup {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        source: PathBuf,
    },
    #[command(subcommand, about = "Review conservative duplicate candidates")]
    Duplicates(DuplicateCommand),
    #[command(subcommand, about = "Alias of virtual-libraries", hide = true)]
    SavedViews(SavedViewsCommand),
    #[command(subcommand, about = "Persist named query scopes over one library")]
    VirtualLibraries(SavedViewsCommand),
}

#[derive(Subcommand)]
enum CustomColumnsCommand {
    #[command(about = "List defined text columns")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    #[command(about = "Define a new labeled text column")]
    Create {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        key: String,
        #[arg(long)]
        label: String,
    },
    #[command(about = "Change the label of an existing column")]
    Rename {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        key: String,
        #[arg(long)]
        label: String,
    },
    #[command(about = "Remove a column definition while keeping per-book values")]
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        key: String,
    },
}

#[derive(Subcommand)]
enum SavedViewsCommand {
    #[command(about = "List persisted virtual libraries")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    #[command(about = "Create or update a virtual library")]
    Save {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Remove a virtual library")]
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum DuplicateCommand {
    #[command(about = "List duplicate candidate pairs")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Record that both books should be kept separate")]
    Keep {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Reopen a previously reviewed pair")]
    Reopen {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Merge one book into another atomically")]
    Merge {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum FormatCommand {
    #[command(about = "Attach a managed copy of a file to a book")]
    Import {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    #[command(about = "Attach a caller-owned file by reference without copying")]
    Attach {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    #[command(about = "Detach a format and delete it only if Takio owns it")]
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long)]
        format: FormatId,
    },
    #[command(about = "Atomically replace a stored format with a verified new file")]
    Replace {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum CoverCommand {
    #[command(about = "Set a Takio-owned cover image from a file")]
    Set {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
        #[arg(long = "source-path")]
        source_path: PathBuf,
    },
    #[command(about = "Remove the Takio-owned cover")]
    Remove {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand)]
enum TrashCommand {
    #[command(about = "List trashed books")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: Option<String>,
    },
    #[command(about = "Move books to the trash")]
    Move {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Restore trashed books")]
    Restore {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
    #[command(about = "Permanently purge trashed books and their managed files")]
    Purge {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long = "request-json")]
        request_json: String,
    },
}

#[derive(Subcommand)]
enum MetadataCommand {
    #[command(about = "Extract embedded metadata from a file with ebook-meta")]
    Extract {
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long, default_value_t = 15)]
        timeout_seconds: u64,
    },
    #[command(about = "Fetch online metadata with fetch-ebook-metadata")]
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
    #[command(subcommand, about = "Discover, review, and apply metadata candidates")]
    Candidates(MetadataCandidatesCommand),
}

#[derive(Subcommand)]
enum MetadataCandidatesCommand {
    #[command(about = "Derive candidates from a filename pattern")]
    Filename {
        #[arg(long = "source-path")]
        source_path: PathBuf,
        #[arg(long)]
        id: Option<String>,
        #[arg(long = "pattern")]
        patterns: Vec<String>,
    },
    #[command(about = "List local and optionally online candidates for one book")]
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
    #[command(about = "Discover candidates for up to 64 books with bounded workers")]
    Reconcile {
        #[arg(long)]
        db: PathBuf,
        #[arg(long = "request-json")]
        request_json: String,
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    #[command(about = "Apply selected candidate fields and optionally its cover")]
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
        #[arg(long)]
        cover: bool,
    },
}

#[derive(Subcommand)]
enum JobsCommand {
    #[command(about = "Queue a conversion job")]
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
    #[command(about = "List jobs, optionally filtered by status")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        status: Option<JobStatus>,
    },
    #[command(about = "Get one job")]
    Get {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Cancel a queued job")]
    Cancel {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Requeue a failed or canceled job")]
    Retry {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Claim and run the oldest queued job in the foreground")]
    RunNext {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    #[command(about = "Run queued jobs in the foreground up to a bounded count")]
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
    #[command(about = "Retry attaching a completed job's output to its library item")]
    RetryAttachment {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
}

#[derive(Subcommand)]
enum DestinationCommand {
    #[command(about = "List mounted volumes that can receive books")]
    List {
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(about = "Eject a mounted destination after verifying it is idle")]
    Eject {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(about = "List verified deliveries recorded on a destination")]
    Inventory {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(
        about = "List the book files on a mounted reader and which library books they are, read-only"
    )]
    Books {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(
            long,
            help = "Reader id from `destination list` (for example Kindle) or its mount path"
        )]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
        #[arg(long, help = "Print a readable table instead of the JSON envelope")]
        human: bool,
    },
    #[command(about = "Re-verify recorded deliveries against the files on the destination")]
    Reconcile {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(
        about = "Copy the reader's books that are not yet in the library into it, without changing the reader"
    )]
    Import {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(
            long,
            help = "Reader id from `destination list` (for example Kindle) or its mount path"
        )]
        dest: PathBuf,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
        #[arg(long, help = "Print a readable summary instead of the JSON envelope")]
        human: bool,
    },
    #[command(about = "Remove a delivered file after verifying it is unchanged")]
    Remove {
        #[arg(long)]
        dest: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "/Volumes")]
        volumes_root: PathBuf,
    },
    #[command(about = "Explicitly opt into hardened SSH/SCP delivery to a rooted Kindle")]
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
                return Err(takio::app_error!("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(cli.library.as_deref(), db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
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
                return Err(takio::app_error!("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            let item = store
                .get(&id)?
                .ok_or_else(|| takio::app_error!("not-found"))?;
            let candidates = metadata_candidates_for_item_at(
                &item,
                include_online,
                timeout_seconds,
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
                timeout_seconds,
                request.concurrency(),
                signals.flag(),
                |item, online, timeout, canceled| {
                    metadata_candidates_for_reconcile(
                        item,
                        online,
                        timeout,
                        canceled,
                        &candidate_root,
                    )?
                    .into_iter()
                    .map(|candidate| {
                        serde_json::to_value(candidate)
                            .map_err(|_| takio::app_error!("metadata-invalid"))
                    })
                    .collect()
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
                let patch: LibraryPatch = serde_json::from_value(patch_value)
                    .map_err(|_| takio::app_error!("invalid-arguments"))?;
                let paths = LibraryPaths::resolve(library, db.as_deref())?;
                let mut store = LibraryStore::create_or_migrate(paths)?;
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

            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
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

fn parse_identifiers(inputs: &[String]) -> AppResult<BTreeMap<String, String>> {
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

fn library(command: LibraryCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        LibraryCommand::CustomColumns { command } => custom_columns(command, library),
        LibraryCommand::Service { db } => library_service(library, db.as_deref()),
        LibraryCommand::Path { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"databasePath":paths.database,"rootPath":paths.root}))
        }
        LibraryCommand::Verify { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let report = LibraryStore::open_read_only(paths)?.verify()?;
            print_success(json!({"report":integrity_value(&report)}))
        }
        LibraryCommand::Backup { db, dest } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            let report = store.verify()?;
            let backup = store.backup(&dest)?;
            print_success(
                json!({"backup":{"path":backup.destination_path,"report":integrity_value(&report)}}),
            )
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
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
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
            let mode = match mode.as_str() {
                "copy" => takio::library::model::ImportMode::Copy,
                "move" => takio::library::model::ImportMode::Move,
                _ => return Err(takio::app_error!("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(store.import_with_outcome(&source_path, title.as_deref(), mode)?)
        }
        LibraryCommand::List {
            db,
            human,
            volumes_root,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            let items = store.list(false)?;
            if human {
                print_human_list(&store, &items, &volumes_root)
            } else {
                print_success(json!({"items":items}))
            }
        }
        LibraryCommand::Get { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"item":LibraryStore::open_read_only(paths)?.get(&id)?}))
        }
        LibraryCommand::Search { db, query } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"items":LibraryStore::open_read_only(paths)?.search(&query)?}))
        }
        LibraryCommand::Query { db, request_json } => {
            let request = read_json(&request_json)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            print_success(library_query_value(&store, &request)?)
        }
        LibraryCommand::Update { db, id, patch_json } => {
            let patch: LibraryPatch = serde_json::from_value(read_json(&patch_json)?)
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
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
                return Err(takio::app_error!("invalid-arguments"));
            }
            let patch: LibraryPatch = serde_json::from_value(read_json(&patch_json)?)
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            let mut outcomes = Vec::with_capacity(ids.len());
            for id in ids {
                match store.update(&id, patch.clone()) {
                    Ok(item) => outcomes.push(json!({"status":"updated","itemId":id,"item":item})),
                    Err(error) if error.code() == "not-found" => {
                        outcomes.push(json!({"status":"missing","itemId":id}));
                    }
                    Err(error) => {
                        outcomes.push(json!({"status":"failed","itemId":id,"code":error.code()}));
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
            let item = LibraryStore::open_read_only(paths)?
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
            if source_paths.is_empty() || source_paths.len() > 256 {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let mode = match mode.as_str() {
                "copy" => takio::library::model::ImportMode::Copy,
                "move" => takio::library::model::ImportMode::Move,
                _ => return Err(takio::app_error!("invalid-arguments")),
            };
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            validate_import_sources(&paths, &source_paths)?;
            let mut store = LibraryStore::create_or_migrate(paths.clone())?;
            validate_import_sources(&paths, &source_paths)?;
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
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            print_success(export_many(&store, &request)?)
        }
        LibraryCommand::Remove { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(store.remove(&id)?)
        }
        LibraryCommand::ImportCalibre { db, library_root } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(import_calibre_library(paths, &library_root)?)
        }
        LibraryCommand::Catalog { db, format, output } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let items = LibraryStore::open_read_only(paths)?.list(false)?;
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
                return Err(takio::app_error!("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
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
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            print_success(validate_library_formats(
                &store,
                &ids,
                limit,
                Duration::from_secs(timeout_seconds),
            )?)
        }
        LibraryCommand::PortableExport { db, dest } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
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
        } => {
            if source_paths.is_empty() || source_paths.len() > 256 {
                return Err(takio::app_error!("invalid-arguments"));
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

fn custom_columns(command: CustomColumnsCommand, library: Option<&str>) -> AppResult<()> {
    let database = match &command {
        CustomColumnsCommand::List { db }
        | CustomColumnsCommand::Create { db, .. }
        | CustomColumnsCommand::Rename { db, .. }
        | CustomColumnsCommand::Remove { db, .. } => db.as_deref(),
    };
    let paths = LibraryPaths::resolve(library, database)?;
    let mut store = if matches!(command, CustomColumnsCommand::List { .. }) {
        LibraryStore::open_read_only(paths)?
    } else {
        LibraryStore::create_or_migrate(paths)?
    };
    match command {
        CustomColumnsCommand::List { .. } => {
            print_success(json!({"definitions":store.list_custom_column_definitions()?}))
        }
        CustomColumnsCommand::Create { key, label, .. } => print_success(
            json!({"definition":store.create_custom_column_definition(&key, &label)?}),
        ),
        CustomColumnsCommand::Rename { key, label, .. } => print_success(
            json!({"definition":store.rename_custom_column_definition(&key, &label)?}),
        ),
        CustomColumnsCommand::Remove { key, .. } => {
            print_success(json!({"definition":store.remove_custom_column_definition(&key)?}))
        }
    }
}

fn library_saved_views(command: SavedViewsCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        SavedViewsCommand::List { db } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"views":LibraryStore::open_read_only(paths)?.list_saved_views()?}))
        }
        SavedViewsCommand::Save { db, request_json } => {
            let request: takio::library::store::SaveViewRequest =
                decode_request(&read_json(&request_json)?)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(
                json!({"view":LibraryStore::create_or_migrate(paths)?.save_view(&request)?}),
            )
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
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            print_success(json!({"view":LibraryStore::create_or_migrate(paths)?.remove_view(id)?}))
        }
    }
}

fn library_duplicates(command: DuplicateCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        DuplicateCommand::List { db, request_json } => {
            let request =
                serde_json::from_value::<ListDuplicateCandidatesRequest>(read_json(&request_json)?)
                    .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let store = LibraryStore::open_read_only(paths)?;
            print_success(
                serde_json::to_value(store.list_duplicate_candidates(&request)?)
                    .map_err(|_| takio::app_error!("storage-unavailable"))?,
            )
        }
        DuplicateCommand::Keep { db, request_json } => {
            let request =
                serde_json::from_value::<DuplicatePairReviewRequest>(read_json(&request_json)?)
                    .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            LibraryStore::create_or_migrate(paths)?.keep_duplicate_pair(&request)?;
            print_success(Value::Null)
        }
        DuplicateCommand::Reopen { db, request_json } => {
            let request =
                serde_json::from_value::<DuplicatePairReviewRequest>(read_json(&request_json)?)
                    .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            LibraryStore::create_or_migrate(paths)?.reopen_duplicate_pair(&request)?;
            print_success(Value::Null)
        }
        DuplicateCommand::Merge { db, request_json } => {
            let request =
                serde_json::from_value::<MergeDuplicatePairRequest>(read_json(&request_json)?)
                    .map_err(|_| takio::app_error!("invalid-arguments"))?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let result = LibraryStore::create_or_migrate(paths)?.merge_duplicate_pair(&request)?;
            print_success(
                serde_json::to_value(result)
                    .map_err(|_| takio::app_error!("storage-unavailable"))?,
            )
        }
    }
}

fn valid_selection(ids: &[String], limit: usize) -> bool {
    limit > 0
        && limit <= 256
        && ids.len() <= limit
        && ids.iter().all(|id| !id.trim().is_empty())
        && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
}

type SelectedLibraryItems = Vec<(String, Option<takio::library::model::LibraryItem>)>;

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnLabelRequest {
    key: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnKeyRequest {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SourceKind {
    Copy,
    Reference,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatSource {
    path: PathBuf,
    kind: SourceKind,
}

impl FormatSource {
    fn provenance(&self) -> takio::library::model::Provenance {
        match self.kind {
            SourceKind::Copy => takio::library::model::Provenance::Managed,
            SourceKind::Reference => takio::library::model::Provenance::Referenced,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachFormatRequest {
    id: String,
    source: FormatSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaceFormatRequest {
    id: String,
    format: FormatId,
    expected_current: takio::library::store::ExpectedFormatSnapshot,
    source: FormatSource,
}

fn decode_request<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    serde_json::from_value(value.clone()).map_err(|_| takio::app_error!("invalid-arguments"))
}

fn replace_format_request(
    store: &mut LibraryStore,
    request: ReplaceFormatRequest,
) -> AppResult<Value> {
    if request.id.is_empty() {
        return Err(takio::app_error!("invalid-arguments"));
    }
    let result = store.replace_format(
        &request.id,
        request.format,
        &request.expected_current,
        &request.source.path,
        request.source.provenance(),
    )?;
    serde_json::to_value(result).map_err(|_| takio::app_error!("storage-unavailable"))
}

fn library_format(command: FormatCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        FormatCommand::Import {
            db,
            id,
            source_path,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(
                json!({"item":store.attach_format(&id, &source_path, takio::library::model::Provenance::Managed)?}),
            )
        }
        FormatCommand::Attach {
            db,
            id,
            source_path,
        } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(
                json!({"item":store.attach_format(&id, &source_path, takio::library::model::Provenance::Referenced)?}),
            )
        }
        FormatCommand::Remove { db, id, format } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(store.remove_format(&id, format)?)
        }
        FormatCommand::Replace { db, request_json } => {
            let request: ReplaceFormatRequest = decode_request(&read_json(&request_json)?)?;
            if request.id.is_empty() {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(replace_format_request(&mut store, request)?)
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
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(json!({"item":store.set_cover(&id, &source_path)?}))
        }
        CoverCommand::Remove { db, id } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(json!({"item":store.remove_cover(&id)?}))
        }
    }
}
fn library_trash(command: TrashCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        TrashCommand::List { db, request_json } => {
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let items = LibraryStore::open_read_only(paths)?.list_trash()?;
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
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(json!({"item":store.trash(id)?}))
        }
        TrashCommand::Restore { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(json!({"item":store.restore(id)?}))
        }
        TrashCommand::Purge { db, request_json } => {
            let request = read_json(&request_json)?;
            let id = request_id(&request)?;
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
            print_success(store.purge(id)?)
        }
    }
}

fn library_service(library: Option<&str>, database: Option<&Path>) -> AppResult<()> {
    let paths = LibraryPaths::resolve(library, database)?;
    let mut store = LibraryStore::create_or_migrate(paths)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input
            .read_line(&mut line)
            .map_err(|_| takio::app_error!("storage-unavailable"))?;
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
            Err(_) => (String::new(), Err(takio::app_error!("invalid-arguments"))),
        };
        let mut response = match result {
            Ok(value) => crate::output::success(value),
            Err(error) => crate::output::failure(error.kind()),
        };
        response["id"] = json!(id);
        writeln!(output, "{response}").map_err(|_| takio::app_error!("terminal-unavailable"))?;
        output
            .flush()
            .map_err(|_| takio::app_error!("terminal-unavailable"))?;
    }
}

fn service_request(store: &mut LibraryStore, request: &Value) -> AppResult<Value> {
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| takio::app_error!("invalid-arguments"))?;
    let args = request
        .get("args")
        .ok_or_else(|| takio::app_error!("invalid-arguments"))?;
    match command {
        "library_custom_columns_list" => {
            if args.as_object().is_none_or(|args| !args.is_empty()) {
                return Err(takio::app_error!("invalid-arguments"));
            }
            serde_json::to_value(store.list_custom_column_definitions()?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_custom_columns_create" => {
            let request: ColumnLabelRequest = decode_request(args)?;
            serde_json::to_value(
                store.create_custom_column_definition(&request.key, &request.label)?,
            )
            .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_custom_columns_rename" => {
            let request: ColumnLabelRequest = decode_request(args)?;
            serde_json::to_value(
                store.rename_custom_column_definition(&request.key, &request.label)?,
            )
            .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_custom_columns_remove" => {
            let request: ColumnKeyRequest = decode_request(args)?;
            serde_json::to_value(store.remove_custom_column_definition(&request.key)?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_duplicates_list" => {
            let request = serde_json::from_value::<ListDuplicateCandidatesRequest>(args.clone())
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            serde_json::to_value(store.list_duplicate_candidates(&request)?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_duplicates_keep" => {
            let request = serde_json::from_value::<DuplicatePairReviewRequest>(args.clone())
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            store.keep_duplicate_pair(&request)?;
            Ok(Value::Null)
        }
        "library_duplicates_reopen" => {
            let request = serde_json::from_value::<DuplicatePairReviewRequest>(args.clone())
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            store.reopen_duplicate_pair(&request)?;
            Ok(Value::Null)
        }
        "library_duplicates_merge" => {
            let request = serde_json::from_value::<MergeDuplicatePairRequest>(args.clone())
                .map_err(|_| takio::app_error!("invalid-arguments"))?;
            serde_json::to_value(store.merge_duplicate_pair(&request)?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_update" => {
            let id = request_id(args)?;
            let patch = serde_json::from_value::<LibraryPatch>(
                args.get("patch")
                    .cloned()
                    .ok_or_else(|| takio::app_error!("invalid-arguments"))?,
            )
            .map_err(|_| takio::app_error!("invalid-arguments"))?;
            Ok(json!({"item":store.update(id, patch)?}))
        }
        "library_attach_format" => {
            let request: AttachFormatRequest = decode_request(args)?;
            if request.id.is_empty() {
                return Err(takio::app_error!("invalid-arguments"));
            }
            Ok(
                json!({"item":store.attach_format(&request.id, &request.source.path, request.source.provenance())?}),
            )
        }
        "library_remove_format" => {
            let id = request_id(args)?;
            let format = serde_json::from_value::<FormatId>(
                args.get("format")
                    .cloned()
                    .ok_or_else(|| takio::app_error!("invalid-arguments"))?,
            )
            .map_err(|_| takio::app_error!("invalid-arguments"))?;
            serde_json::to_value(store.remove_format(id, format)?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_cover_set" => {
            let id = request_id(args)?;
            let path = args
                .get("sourcePath")
                .and_then(Value::as_str)
                .ok_or_else(|| takio::app_error!("invalid-arguments"))?;
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
            serde_json::to_value(store.purge(id)?)
                .map_err(|_| takio::app_error!("storage-unavailable"))
        }
        "library_replace_format" => replace_format_request(store, decode_request(args)?),
        _ => Err(takio::app_error!("invalid-arguments")),
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
    let mut store = LibraryStore::create_or_migrate(paths.clone())?;
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
        validate_import_sources(&paths, source_paths)?;
        let scan = scan_imports(
            &mut store,
            source_paths,
            takio::library::model::ImportMode::Copy,
            takio::import::scan::ImportObservation::Watch,
            || receiver.try_recv().is_ok(),
        )?;
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
        .map_err(|_| takio::app_error!("storage-unavailable"))?;
    print_success(json!({"cycles":cycles,"stopped":stopped,"counts":counts}))
}

fn export_many(
    store: &LibraryStore,
    request: &Value,
) -> AppResult<takio::library::export::ExportReport> {
    takio::library::export::export_many(store, decode_request(request)?)
}

fn library_query_value(store: &LibraryStore, request: &Value) -> AppResult<Value> {
    let result = takio::library::query::query(store, decode_request(request)?)?;
    serde_json::to_value(result).map_err(|_| takio::app_error!("storage-unavailable"))
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
                    let item = LibraryStore::open_read_only(paths)?
                        .get(item_id)?
                        .ok_or_else(|| takio::app_error!("not-found"))?;
                    item.formats
                        .into_iter()
                        .find(|candidate| candidate.format == format)
                        .map(|candidate| candidate.source_path)
                        .ok_or_else(|| takio::app_error!("format-not-found"))?
                }
                _ => return Err(takio::app_error!("invalid-arguments")),
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
            let job = store.run_next(profile.parse()?, Duration::from_secs(timeout_seconds))?;
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
            let values = store.drain(
                max_jobs,
                profile.parse()?,
                Duration::from_secs(timeout_seconds),
            )?;
            let values = values
                .into_iter()
                .map(|job| reconcile_job_attachment(&store, library, job))
                .collect::<AppResult<Vec<_>>>()?;
            print_success(json!({"jobs":values,"counts":{"processed":values.len()}}))
        }
        JobsCommand::RetryAttachment { db, id } => {
            if db.is_some() || id.trim().is_empty() {
                return Err(takio::app_error!("invalid-arguments"));
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
    job: takio::conversion::jobs::ConversionJob,
) -> AppResult<takio::conversion::jobs::ConversionJob> {
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
    let result = LibraryStore::create_or_migrate(paths).and_then(|mut store| {
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
                reader_shelf::scan_cached(&device, &catalogue_fingerprints(paths)?, &mut cache)?;
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
            let paths = LibraryPaths::resolve(library, db.as_deref())?;
            let mut store = LibraryStore::create_or_migrate(paths)?;
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
            let paths = LibraryPaths::resolve(library, None)?;
            let item = LibraryStore::open_read_only(paths)?.get_active(&id)?;
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
fn read_json(input: &str) -> AppResult<Value> {
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
fn request_id(value: &Value) -> AppResult<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| takio::app_error!("invalid-arguments"))
}
fn job_path(library: Option<&str>, db: Option<&Path>) -> AppResult<PathBuf> {
    if db.is_some() && library.is_some() {
        return Err(takio::app_error!("invalid-arguments"));
    }
    Ok(db
        .map(Path::to_path_buf)
        .unwrap_or(LibraryPaths::resolve(library, None)?.jobs))
}
fn reader_relative(device: &destinations::Destination, path: &Path) -> String {
    path.strip_prefix(&device.path)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// Fingerprints from an existing library, opened read-only so a scan never creates one.
/// A library that was never created has no books, so every reader file is listed as
/// not in it rather than failing.
fn catalogue_fingerprints(
    paths: LibraryPaths,
) -> AppResult<Vec<takio::library::store::ActiveFingerprint>> {
    match std::fs::symlink_metadata(&paths.database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        _ => LibraryStore::open_read_only(paths)?.active_fingerprints(),
    }
}

fn print_human_list(
    store: &LibraryStore,
    items: &[takio::library::model::LibraryItem],
    volumes_root: &Path,
) -> AppResult<()> {
    // Only recognizable readers are scanned; a generic USB drive is never walked implicitly.
    let readers: Vec<_> = destinations::list(volumes_root)
        .unwrap_or_default()
        .into_iter()
        .filter(|device| !matches!(device.kind, DestinationKind::Generic))
        .collect();
    let library = if readers.is_empty() {
        Vec::new()
    } else {
        store.active_fingerprints()?
    };
    let mut on_reader: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut summaries = Vec::new();
    let mut cache = reader_shelf::HashCache::load(&store.paths().root);
    for reader in &readers {
        match reader_shelf::scan_cached(reader, &library, &mut cache) {
            Ok(shelf) => {
                for id in shelf.item_ids() {
                    let state = shelf
                        .reading_for(id)
                        .and_then(takio::delivery::koreader::ReadingState::label);
                    on_reader
                        .entry(id.to_owned())
                        .or_default()
                        .push(match state {
                            Some(state) => format!("{} {state}", reader.name),
                            None => reader.name.clone(),
                        });
                }
                let progress = if shelf.koreader && shelf.finished + shelf.in_progress > 0 {
                    format!(
                        ", {} finished, {} in progress",
                        shelf.finished, shelf.in_progress
                    )
                } else {
                    String::new()
                };
                summaries.push(format!(
                    "{}: {} of these books, {} other file(s){progress}{}{}",
                    reader.label(),
                    shelf.in_library,
                    shelf.not_in_library,
                    if shelf.truncated {
                        " (scan limit reached)"
                    } else {
                        ""
                    },
                    if shelf.unreadable > 0 {
                        " (some folders could not be read)"
                    } else {
                        ""
                    }
                ));
            }
            Err(error) => summaries.push(format!(
                "{}: could not be read ({})",
                reader.label(),
                error.code()
            )),
        }
    }
    // Only an optimization: a read-only or full disk just means reading the reader again.
    let _ = cache.save(&store.paths().root);
    let reader_column = !readers.is_empty();
    let mut header = format!("{:<40} {:<26} {:<10}", "Title", "Author", "Formats");
    if reader_column {
        header.push_str(&format!(" {:<18}", "On reader"));
    }
    println!("{header} ID");
    for item in items {
        let author = item.author_names().collect::<Vec<_>>().join(", ");
        let formats = item
            .formats
            .iter()
            .map(|format| format.format.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let mut line = format!(
            "{:<40} {:<26} {:<10}",
            truncate(&item.title, 40),
            truncate(&author, 26),
            truncate(&formats, 10)
        );
        if reader_column {
            let names = on_reader
                .get(&item.id)
                .map(|names| names.join(","))
                .unwrap_or_default();
            line.push_str(&format!(" {:<18}", truncate(&names, 18)));
        }
        println!("{line} {}", item.id);
    }
    println!();
    println!("{} book(s) in the library", items.len());
    if let Some(note) = desktop_library_note(store.paths()) {
        println!("{note}");
    }
    if readers.is_empty() {
        println!("No Kindle or Kobo reader is mounted.");
    }
    for summary in summaries {
        println!("{summary}");
    }
    Ok(())
}

/// When the desktop app was switched to another library, say so: otherwise the CLI
/// and the app would silently list different books.
fn desktop_library_note(paths: &LibraryPaths) -> Option<String> {
    let profile = std::env::var_os("TAKIO_DESKTOP_PROFILE_DIR");
    let preference = takio::library::paths::desktop_preference_location(
        &LibraryPaths::resolve(None, None).ok()?.root,
        std::env::var_os("TAKIO_DATA_DIR").is_some(),
        profile.as_deref().map(Path::new),
    )?;
    let remembered = std::fs::read_to_string(preference).ok()?;
    let remembered = Path::new(remembered.trim());
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    (!remembered.as_os_str().is_empty() && !same(remembered, &paths.root)).then(|| {
        format!(
            "The desktop app is using a different library: {}. Add --db {}/library.sqlite to list it.",
            remembered.display(),
            remembered.display()
        )
    })
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
    .map_err(|_| takio::app_error!("open-failed"))?;
    if status.success() {
        Ok(())
    } else {
        Err(takio::app_error!("open-failed"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mixed_legacy_and_structured_authors_count_once() {
        let mut legacy = takio::library::catalog::tests::sparse_book();
        legacy.author = Some("Public author".into());
        let structured = takio::library::catalog::tests::rich_book();
        assert_eq!(structured.primary_author(), Some("Public author"));
        assert_eq!(legacy.primary_author(), Some("Public author"));
        assert_eq!(
            json!(takio::library::query::Facets::from_items(&[
                legacy, structured
            ]))["authors"],
            serde_json::json!([{"value":"Public author","count":2}])
        );
    }
    use super::*;

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
    fn empty_catalog_output_is_rejected_without_writing() {
        assert_eq!(
            write_catalog(&[], "json", Path::new(""))
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
        write_catalog(&items, "json", &output).unwrap();
        let actual: Value = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(
            actual,
            json!({"version":1,"books":[rich_record(), sparse_record()]})
        );

        let output = temp.path().join("catalog.csv");
        write_catalog(&items, "csv", &output).unwrap();
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
