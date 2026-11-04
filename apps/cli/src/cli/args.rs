//! Clap argument model for the one-shot command line.
#[allow(clippy::wildcard_imports)]
use super::*;

#[derive(Parser)]
#[command(
    name = "takio",
    version,
    about = "Manage, convert, and deliver a local ebook library",
    disable_help_subcommand = true
)]
pub(super) struct Cli {
    #[arg(
        long,
        global = true,
        value_name = "NAME",
        help = "Use an independent named library under the Takio data directory"
    )]
    pub(super) library: Option<String>,
    #[command(subcommand)]
    pub(super) command: Option<Command>,
}

#[derive(Subcommand)]
pub(super) enum Command {
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
pub(super) enum LibraryCommand {
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
        #[arg(long, default_value = "copy", value_enum)]
        mode: CliImportMode,
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
        #[arg(long = "source-path", required = true, num_args = 1..=MAX_BATCH)]
        source_paths: Vec<PathBuf>,
        #[arg(long, default_value = "copy", value_enum)]
        mode: CliImportMode,
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
        #[arg(long = "source-path", required = true, num_args = 1..=MAX_BATCH)]
        source_paths: Vec<PathBuf>,
        #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u64).range(1..=86_400))]
        interval_seconds: u64,
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..=10_000))]
        max_cycles: Option<u64>,
        #[arg(long, help = "Write completed watch cycles as NDJSON to stderr")]
        progress: bool,
    },
    #[command(about = "Publish a JSON, CSV, or HTML catalogue of the library")]
    Catalog {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        format: takio::library::catalog::CatalogFormat,
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
        #[arg(long, default_value_t = MAX_BATCH)]
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
        #[arg(long, default_value_t = MAX_BATCH)]
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
pub(super) enum CustomColumnsCommand {
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
pub(super) enum SavedViewsCommand {
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
pub(super) enum DuplicateCommand {
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
pub(super) enum FormatCommand {
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
pub(super) enum CoverCommand {
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
pub(super) enum TrashCommand {
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
pub(super) enum MetadataCommand {
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
pub(super) enum MetadataCandidatesCommand {
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
pub(super) enum DestinationCommand {
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
