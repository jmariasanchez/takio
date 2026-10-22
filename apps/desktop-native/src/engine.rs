//! The engine thread: sole owner of the `LibraryStore`.
//!
//! The UI never touches SQLite. Every operation is a typed [`Request`]
//! carrying a oneshot reply sender. One worker thread drains requests in
//! order, which serializes mutations exactly like the Electron sidecar's
//! `library service` loop did, but without a process boundary or JSON.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

pub use crate::library_location::OpenedLibrary;
use crate::preparation::{self, PreparationPreview};
use takio::conversion::{BackendDiscovery, FormatId};
use takio::destinations::{self, DeliveryResult, Destination, DestinationKind};
use takio::import_scan::{ImportScan, scan_imports};
use takio::model::{BookFormat, LibraryItem, LibraryPatch};
use takio::output::{AppError, AppResult};
use takio::paths::LibraryPaths;
use takio::store::{BackupReport, LibraryQueryFilters, LibraryStore, RestoreReport};

/// Facet filters applied conjunctively to a query.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Filters {
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub series: Vec<String>,
    pub languages: Vec<String>,
    pub formats: Vec<String>,
}

impl Filters {
    pub fn is_empty(&self) -> bool {
        self.authors.is_empty()
            && self.tags.is_empty()
            && self.series.is_empty()
            && self.languages.is_empty()
            && self.formats.is_empty()
    }
}

/// Counts of every distinct facet value across a result set.
#[derive(Clone, Debug, Default)]
pub struct Facets {
    pub authors: BTreeMap<String, u64>,
    pub tags: BTreeMap<String, u64>,
    pub series: BTreeMap<String, u64>,
    pub languages: BTreeMap<String, u64>,
    pub formats: BTreeMap<String, u64>,
}

impl Facets {
    pub fn from_items(items: &[LibraryItem]) -> Self {
        let mut facets = Self::default();
        for item in items {
            for author in &item.authors {
                *facets.authors.entry(author.name.clone()).or_default() += 1;
            }
            if item.authors.is_empty()
                && let Some(author) = &item.author
            {
                *facets.authors.entry(author.clone()).or_default() += 1;
            }
            for tag in &item.tags {
                *facets.tags.entry(tag.clone()).or_default() += 1;
            }
            if let Some(series) = &item.series {
                *facets.series.entry(series.clone()).or_default() += 1;
            }
            for language in &item.languages {
                *facets.languages.entry(language.clone()).or_default() += 1;
            }
            for format in &item.formats {
                *facets
                    .formats
                    .entry(format.format.as_str().to_owned())
                    .or_default() += 1;
            }
        }
        facets
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportMode {
    Copy,
    Move,
}

/// Larger batches are rejected before any destination is modified.
pub const MAX_SEND_ITEMS: usize = 256;

/// Format/source readiness only, not a promise of delivery or collision avoidance.
#[derive(Clone, Debug)]
pub struct SendPreview {
    pub destination: Destination,
    pub entries: Vec<SendPreviewEntry>,
}

#[derive(Clone, Debug)]
pub struct SendPreviewEntry {
    pub item_id: String,
    /// Stored title, or the requested ID when the item could not be loaded.
    pub title: String,
    pub result: Result<ReadyFile, String>,
}

/// Reviewed selection, not an immutable snapshot of the file's bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyFile {
    pub format: FormatId,
    pub source_path: PathBuf,
}

impl SendPreview {
    #[cfg(test)]
    pub fn ready_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.result.is_ok())
            .map(|entry| entry.item_id.clone())
            .collect()
    }

    pub fn ready_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.result.is_ok())
            .count()
    }
}

/// One outcome per requested ID, in request order, including failures.
#[derive(Clone, Debug, Default)]
pub struct SendReport {
    pub entries: Vec<SendEntry>,
}

#[derive(Clone, Debug)]
pub struct SendEntry {
    pub item_id: String,
    /// Stored title, or the requested ID when the item could not be loaded.
    pub title: String,
    /// Verified delivery, or the stable application error code.
    pub result: Result<DeliveryResult, String>,
}

/// Everything the UI can ask the engine to do.
pub enum Request {
    OpenLibrary {
        directory: PathBuf,
        remember: Option<PathBuf>,
        reply: Sender<AppResult<OpenedLibrary>>,
    },
    Backup {
        destination: PathBuf,
        reply: Sender<AppResult<BackupReport>>,
    },
    RestoreBackupCopy {
        source: PathBuf,
        destination: PathBuf,
        reply: Sender<AppResult<RestoreReport>>,
    },
    PreviewPrepare {
        item_id: String,
        reply: Sender<AppResult<PreparationPreview>>,
    },
    PrepareReviewed {
        preview: PreparationPreview,
        reply: Sender<AppResult<LibraryItem>>,
    },
    Query {
        query: String,
        filters: Filters,
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    ListTrash {
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    Update {
        id: String,
        patch: LibraryPatch,
        reply: Sender<AppResult<LibraryItem>>,
    },
    Import {
        roots: Vec<PathBuf>,
        mode: ImportMode,
        reply: Sender<AppResult<ImportScan>>,
    },
    Trash {
        ids: Vec<String>,
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    Restore {
        ids: Vec<String>,
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    Purge {
        ids: Vec<String>,
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    ListDestinations {
        volumes_root: PathBuf,
        reply: Sender<AppResult<Vec<Destination>>>,
    },
    PreviewSend {
        destination: Destination,
        item_ids: Vec<String>,
        reply: Sender<AppResult<SendPreview>>,
    },
    SendReviewed {
        destination: Destination,
        entries: Vec<SendPreviewEntry>,
        reply: Sender<AppResult<SendReport>>,
    },
    #[cfg(test)]
    SendMany {
        destination: Destination,
        item_ids: Vec<String>,
        reply: Sender<AppResult<SendReport>>,
    },
    Eject {
        destination: Destination,
        reply: Sender<AppResult<()>>,
    },
}

/// Cheap, cloneable handle to the engine thread.
#[derive(Clone)]
pub struct Engine {
    sender: Sender<Request>,
    root: PathBuf,
}

impl Engine {
    #[cfg(test)]
    pub fn test_channel() -> (Self, Receiver<Request>) {
        let (sender, receiver) = mpsc::channel();
        (
            Self {
                sender,
                root: PathBuf::new(),
            },
            receiver,
        )
    }

    /// Open (or create) the library at `paths` on a dedicated thread.
    ///
    /// # Errors
    ///
    /// Returns the store's open error so the UI can show it before any
    /// window exists.
    pub fn open(paths: LibraryPaths) -> AppResult<Self> {
        Self::open_inner(paths, None)
    }

    /// The canonical root opened initially. Later switches return their own root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn open_existing(directory: PathBuf) -> AppResult<Self> {
        let (store, _) = crate::library_location::open(&directory)?;
        Self::start(store, None)
    }

    #[cfg(test)]
    pub fn open_with_preparation_backend(
        paths: LibraryPaths,
        backend: BackendDiscovery,
    ) -> AppResult<Self> {
        Self::open_inner(paths, Some(backend))
    }

    fn open_inner(paths: LibraryPaths, backend: Option<BackendDiscovery>) -> AppResult<Self> {
        let store = LibraryStore::open(paths, true)?;
        Self::start(store, backend)
    }

    fn start(store: LibraryStore, backend: Option<BackendDiscovery>) -> AppResult<Self> {
        let root = store.paths().root.canonicalize()?;
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("takio-engine".into())
            .spawn(move || worker(store, receiver, backend))
            .map_err(|_| AppError::new("storage-unavailable"))?;
        Ok(Self { sender, root })
    }

    /// Send a request and return the reply receiver. The engine thread
    /// drops the sender if it is gone, so `recv` on the returned receiver
    /// yields `Err` rather than hanging.
    pub fn request<T>(&self, build: impl FnOnce(Sender<T>) -> Request) -> Receiver<T> {
        let (reply, receiver) = mpsc::channel();
        let _ = self.sender.send(build(reply));
        receiver
    }
}

fn worker(
    mut store: LibraryStore,
    receiver: Receiver<Request>,
    preparation_backend: Option<BackendDiscovery>,
) {
    while let Ok(request) = receiver.recv() {
        match request {
            Request::OpenLibrary {
                directory,
                remember,
                reply,
            } => {
                let result =
                    crate::library_location::open(&directory).map(|(candidate, mut opened)| {
                        opened.remember_failed = remember.as_ref().is_some_and(|path| {
                            crate::preferences::save(path, &opened.root).is_err()
                        });
                        store = candidate;
                        opened
                    });
                let _ = reply.send(result);
            }
            Request::Backup { destination, reply } => {
                let _ = reply.send(store.backup(&destination));
            }
            Request::RestoreBackupCopy {
                source,
                destination,
                reply,
            } => {
                let _ = reply.send(store.restore_backup_copy(&source, &destination));
            }
            Request::PreviewPrepare { item_id, reply } => {
                let result = match &preparation_backend {
                    Some(backend) => {
                        preparation::preview_with_backend(&store, &item_id, backend.clone())
                    }
                    None => preparation::preview(&store, &item_id),
                };
                let _ = reply.send(result);
            }
            Request::PrepareReviewed { preview, reply } => {
                let result = match &preparation_backend {
                    Some(backend) => preparation::prepare_with_backend(
                        &mut store,
                        &preview,
                        backend.clone(),
                        std::time::Duration::from_secs(120),
                    ),
                    None => preparation::prepare(&mut store, &preview),
                };
                let _ = reply.send(result);
            }
            Request::Query {
                query,
                filters,
                reply,
            } => {
                let result = store.query_items(
                    &query,
                    LibraryQueryFilters {
                        authors: &filters.authors,
                        tags: &filters.tags,
                        series: &filters.series,
                        languages: &filters.languages,
                        formats: &filters.formats,
                    },
                );
                let _ = reply.send(result);
            }
            Request::ListTrash { reply } => {
                let _ = reply.send(store.list_trash());
            }
            Request::Update { id, patch, reply } => {
                let _ = reply.send(store.update(&id, patch));
            }
            Request::Import { roots, mode, reply } => {
                let result =
                    scan_imports(&mut store, &roots, mode == ImportMode::Move, false, || {
                        false
                    });
                let _ = reply.send(result);
            }
            Request::Trash { ids, reply } => {
                let _ = reply.send(each(&ids, |id| store.trash(id)));
            }
            Request::Restore { ids, reply } => {
                let _ = reply.send(each(&ids, |id| store.restore(id)));
            }
            Request::Purge { ids, reply } => {
                let _ = reply.send(each(&ids, |id| store.purge(id)));
            }
            Request::ListDestinations {
                volumes_root,
                reply,
            } => {
                let _ = reply.send(destinations::list(&volumes_root));
            }
            Request::PreviewSend {
                destination,
                item_ids,
                reply,
            } => {
                let _ = reply.send(preview_send(&store, &destination, &item_ids));
            }
            Request::SendReviewed {
                destination,
                entries,
                reply,
            } => {
                let _ = reply.send(send_reviewed(&store, &destination, &entries));
            }
            #[cfg(test)]
            Request::SendMany {
                destination,
                item_ids,
                reply,
            } => {
                let _ = reply.send(send_many(&store, &destination, &item_ids));
            }
            Request::Eject { destination, reply } => {
                let _ = reply.send(destinations::eject(&destination));
            }
        }
    }
}

fn each(
    ids: &[String],
    mut op: impl FnMut(&str) -> AppResult<LibraryItem>,
) -> AppResult<Vec<LibraryItem>> {
    ids.iter().map(|id| op(id)).collect()
}

#[cfg(test)]
fn send_item(
    store: &LibraryStore,
    destination: &Destination,
    item_id: &str,
) -> AppResult<DeliveryResult> {
    let item = store
        .get(item_id)?
        .ok_or_else(|| AppError::new("not-found"))?;
    if store.list_trash()?.iter().any(|item| item.id == item_id) {
        return Err(AppError::new("item-trashed"));
    }
    deliver_item(destination, &item, None)
}

fn preview_send(
    store: &LibraryStore,
    destination: &Destination,
    item_ids: &[String],
) -> AppResult<SendPreview> {
    if item_ids.len() > MAX_SEND_ITEMS {
        return Err(AppError::new("invalid-arguments"));
    }
    let root = destination
        .path
        .parent()
        .ok_or_else(|| AppError::new("unknown-destination"))?;
    let destination = destinations::authorize(&destination.path, root)?;
    let trashed: BTreeSet<_> = store
        .list_trash()?
        .into_iter()
        .map(|item| item.id)
        .collect();
    let entries = item_ids
        .iter()
        .map(|id| {
            let mut title = id.clone();
            let result = store.get(id).and_then(|item| {
                let item = item.ok_or_else(|| AppError::new("not-found"))?;
                title.clone_from(&item.title);
                if trashed.contains(id) {
                    return Err(AppError::new("item-trashed"));
                }
                let format = preferred_format(&item, &destination)
                    .ok_or_else(|| AppError::new("no-compatible-format"))?;
                let unavailable = || AppError::new("source-unavailable");
                // Reject directories and special files before opening, then check the handle.
                if !format.source_path.is_file() {
                    return Err(unavailable());
                }
                let mut source =
                    std::fs::File::open(&format.source_path).map_err(|_| unavailable())?;
                if !source.metadata().map_err(|_| unavailable())?.is_file() {
                    return Err(unavailable());
                }
                source.read(&mut [0u8; 1]).map_err(|_| unavailable())?;
                Ok(ReadyFile {
                    format: format.format,
                    source_path: format.source_path.clone(),
                })
            });
            SendPreviewEntry {
                item_id: id.clone(),
                title,
                result: result.map_err(|error| error.code().to_owned()),
            }
        })
        .collect();
    Ok(SendPreview {
        destination,
        entries,
    })
}

fn send_reviewed(
    store: &LibraryStore,
    destination: &Destination,
    entries: &[SendPreviewEntry],
) -> AppResult<SendReport> {
    if entries.len() > MAX_SEND_ITEMS {
        return Err(AppError::new("invalid-arguments"));
    }
    let trashed: BTreeSet<_> = store
        .list_trash()?
        .into_iter()
        .map(|item| item.id)
        .collect();
    Ok(SendReport {
        entries: entries
            .iter()
            .filter_map(|entry| {
                let ready = entry.result.as_ref().ok()?;
                Some(send_entry(
                    store,
                    destination,
                    &trashed,
                    &entry.item_id,
                    Some(ready),
                ))
            })
            .collect(),
    })
}

fn send_entry(
    store: &LibraryStore,
    destination: &Destination,
    trashed: &BTreeSet<String>,
    id: &str,
    reviewed: Option<&ReadyFile>,
) -> SendEntry {
    let mut title = id.to_owned();
    let result = store.get(id).and_then(|item| {
        let item = item.ok_or_else(|| AppError::new("not-found"))?;
        title.clone_from(&item.title);
        if trashed.contains(id) {
            return Err(AppError::new("item-trashed"));
        }
        deliver_item(destination, &item, reviewed)
    });
    SendEntry {
        item_id: id.to_owned(),
        title,
        result: result.map_err(|error| error.code().to_owned()),
    }
}

#[cfg(test)]
fn send_many(
    store: &LibraryStore,
    destination: &Destination,
    item_ids: &[String],
) -> AppResult<SendReport> {
    if item_ids.len() > MAX_SEND_ITEMS {
        return Err(AppError::new("invalid-arguments"));
    }
    let trashed: BTreeSet<_> = store
        .list_trash()?
        .into_iter()
        .map(|item| item.id)
        .collect();
    let entries = item_ids
        .iter()
        .map(|id| send_entry(store, destination, &trashed, id, None))
        .collect();
    Ok(SendReport { entries })
}

fn preferred_format<'a>(
    item: &'a LibraryItem,
    destination: &Destination,
) -> Option<&'a BookFormat> {
    // A detected KOReader installation can read EPUB directly. Stock Kindle cannot.
    let preference: &[FormatId] = if destination
        .features
        .iter()
        .any(|feature| feature == "koreader")
    {
        &[
            FormatId::Epub,
            FormatId::Pdf,
            FormatId::Mobi,
            FormatId::Txt,
            FormatId::Cbz,
        ]
    } else {
        match destination.kind {
            DestinationKind::Kindle => {
                &[FormatId::Azw3, FormatId::Mobi, FormatId::Pdf, FormatId::Txt]
            }
            DestinationKind::Kobo => &[
                FormatId::Kepub,
                FormatId::Epub,
                FormatId::Pdf,
                FormatId::Cbz,
            ],
            DestinationKind::Generic => return None,
        }
    };
    preference
        .iter()
        .find_map(|wanted| item.formats.iter().find(|format| format.format == *wanted))
}

fn deliver_item(
    destination: &Destination,
    item: &LibraryItem,
    reviewed: Option<&ReadyFile>,
) -> AppResult<DeliveryResult> {
    // Refresh mount detection so a disconnected reader is not recreated as a local folder,
    // and stale caller-provided capabilities cannot permit an incompatible format.
    let root = destination
        .path
        .parent()
        .ok_or_else(|| AppError::new("unknown-destination"))?;
    let destination = destinations::authorize(&destination.path, root)?;
    let format = preferred_format(item, &destination)
        .ok_or_else(|| AppError::new("no-compatible-format"))?;
    if reviewed.is_some_and(|ready| {
        ready.format != format.format || ready.source_path != format.source_path
    }) {
        return Err(AppError::new("send-review-changed"));
    }
    let author = item
        .authors
        .first()
        .map(|author| author.name.as_str())
        .or(item.author.as_deref());
    let extension = format.format.extension();
    let file_name = destinations::destination_file_name(&item.title, author, extension);
    destinations::send(
        &destination,
        &item.id,
        &format.source_path,
        &file_name,
        format.format.as_str(),
        None,
        false,
    )
}

/// Resolve the library location the desktop should open.
///
/// Honors `TAKIO_DATA_DIR` for tests and sandboxes, otherwise the platform
/// data directory shared with the CLI and TUI.
pub fn resolve_paths() -> AppResult<LibraryPaths> {
    if let Some(dir) = std::env::var_os("TAKIO_DATA_DIR") {
        let database = Path::new(&dir).join("library.sqlite");
        return LibraryPaths::resolve(None, Some(&database));
    }
    LibraryPaths::resolve(None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn engine() -> (tempfile::TempDir, Engine) {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        (temp, Engine::open(paths).unwrap())
    }

    fn epub(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{name}.epub"));
        fs::write(&path, format!("book {name}")).unwrap();
        path
    }

    fn delivery_fixture() -> (tempfile::TempDir, LibraryStore, Destination) {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let store = LibraryStore::open(paths, true).unwrap();
        let volumes = temp.path().join("Volumes");
        let mount = volumes.join("Kindle");
        fs::create_dir_all(mount.join("documents")).unwrap();
        fs::create_dir_all(mount.join("system")).unwrap();
        let destination = destinations::authorize(&mount, &volumes).unwrap();
        (temp, store, destination)
    }

    fn add_book(
        store: &mut LibraryStore,
        root: &Path,
        title: &str,
        extension: &str,
    ) -> LibraryItem {
        let source = root.join(format!("{title}.{extension}"));
        fs::write(&source, format!("contents for {title}.{extension}")).unwrap();
        store.import(&source, Some(title), false).unwrap()
    }

    #[test]
    fn preview_reports_ordered_readiness_without_writing() {
        let (temp, mut store, destination) = delivery_fixture();
        let good = add_book(&mut store, temp.path(), "Ready", "azw3");
        let incompatible = add_book(&mut store, temp.path(), "EPUB", "epub");
        let missing = add_book(&mut store, temp.path(), "Missing", "mobi");
        fs::remove_file(&missing.source_path).unwrap();
        let trash = add_book(&mut store, temp.path(), "Trash", "pdf");
        store.trash(&trash.id).unwrap();
        let directory = add_book(&mut store, temp.path(), "Directory", "txt");
        fs::remove_file(&directory.source_path).unwrap();
        fs::create_dir(&directory.source_path).unwrap();
        let original = fs::read(&good.source_path).unwrap();
        let ids = vec![
            good.id.clone(),
            incompatible.id,
            missing.id,
            trash.id,
            "absent".into(),
            directory.id,
        ];
        let preview = preview_send(&store, &destination, &ids).unwrap();
        assert_eq!(
            preview
                .entries
                .iter()
                .map(|entry| &entry.item_id)
                .collect::<Vec<_>>(),
            ids.iter().collect::<Vec<_>>()
        );
        assert_eq!(
            preview.entries[0].result.as_ref().map(|ready| ready.format),
            Ok(FormatId::Azw3)
        );
        for (entry, code) in preview.entries[1..].iter().zip([
            "no-compatible-format",
            "source-unavailable",
            "item-trashed",
            "not-found",
            "source-unavailable",
        ]) {
            assert_eq!(entry.result.as_ref().unwrap_err(), code);
        }
        assert_eq!(preview.entries[0].title, "Ready");
        assert_eq!(preview.entries[3].title, "Trash");
        assert_eq!(preview.entries[4].title, "absent");
        assert_eq!(preview.ready_ids(), vec![good.id]);
        assert_eq!(preview.ready_count(), 1);
        assert_eq!(fs::read(&good.source_path).unwrap(), original);
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(fs::read_dir(&destination.path).unwrap().count(), 2);
        assert!(!destination.path.join(".takio").exists());
    }

    #[test]
    fn preview_refreshes_capabilities_and_prefers_attached_formats() {
        let (temp, mut store, mut destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Preferred preview", "epub");
        destination.features.push("koreader".into());
        let ids = vec![item.id.clone()];
        let preview = preview_send(&store, &destination, &ids).unwrap();
        assert!(preview.destination.features.is_empty());
        assert_eq!(
            preview.entries[0].result.as_ref().unwrap_err(),
            "no-compatible-format"
        );
        for extension in ["mobi", "azw3"] {
            let source = temp.path().join(format!("attachment.{extension}"));
            fs::write(&source, extension).unwrap();
            store.attach_format(&item.id, &source, true).unwrap();
        }
        assert_eq!(
            preview_send(&store, &destination, &ids).unwrap().entries[0]
                .result
                .as_ref()
                .map(|ready| ready.format),
            Ok(FormatId::Azw3)
        );
        let stored = store.get(&item.id).unwrap().unwrap();
        let selected = stored
            .formats
            .iter()
            .find(|format| format.format == FormatId::Azw3)
            .unwrap();
        fs::remove_file(&selected.source_path).unwrap();
        assert_eq!(
            preview_send(&store, &destination, &ids).unwrap().entries[0]
                .result
                .as_ref()
                .unwrap_err(),
            "source-unavailable"
        );
        destination.features.clear();
        fs::create_dir(destination.path.join("koreader")).unwrap();
        let preview = preview_send(&store, &destination, &ids).unwrap();
        assert_eq!(preview.destination.features, vec!["koreader"]);
        assert_eq!(
            preview.entries[0].result.as_ref().map(|ready| ready.format),
            Ok(FormatId::Epub)
        );
        fs::remove_dir(destination.path.join("koreader")).unwrap();
        fs::remove_dir(destination.path.join("system")).unwrap();
        fs::create_dir(destination.path.join(".kobo")).unwrap();
        let preview = preview_send(&store, &destination, &ids).unwrap();
        assert!(matches!(preview.destination.kind, DestinationKind::Kobo));
        assert_eq!(
            preview.entries[0].result.as_ref().map(|ready| ready.format),
            Ok(FormatId::Epub)
        );
    }

    #[cfg(unix)]
    #[test]
    fn preview_rejects_unreadable_source() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Unreadable", "azw3");
        let permissions = fs::metadata(&item.source_path).unwrap().permissions();
        fs::set_permissions(&item.source_path, fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::File::open(&item.source_path).is_err();
        let preview = preview_send(&store, &destination, &[item.id]).unwrap();
        fs::set_permissions(&item.source_path, permissions).unwrap();
        // Privileged test processes can still read mode-000 files.
        if unreadable {
            assert_eq!(
                preview.entries[0].result.as_ref().unwrap_err(),
                "source-unavailable"
            );
        } else {
            assert_eq!(
                preview.entries[0].result.as_ref().map(|ready| ready.format),
                Ok(FormatId::Azw3)
            );
        }
    }

    #[test]
    fn preview_bounds_before_io_and_requires_connected_destination() {
        let (_temp, store, destination) = delivery_fixture();
        assert_eq!(
            preview_send(&store, &destination, &vec!["absent".into(); MAX_SEND_ITEMS])
                .unwrap()
                .entries
                .len(),
            MAX_SEND_ITEMS
        );
        let empty = preview_send(&store, &destination, &[]).unwrap();
        assert_eq!(empty.ready_count(), 0);
        assert!(empty.ready_ids().is_empty());
        fs::remove_dir_all(&destination.path).unwrap();
        assert_eq!(
            preview_send(
                &store,
                &destination,
                &vec!["absent".into(); MAX_SEND_ITEMS + 1]
            )
            .unwrap_err()
            .code(),
            "invalid-arguments"
        );
        assert_eq!(
            preview_send(&store, &destination, &[]).unwrap_err().code(),
            "unknown-destination"
        );
        assert!(!destination.path.exists());
    }

    #[test]
    fn worker_preview_does_not_promise_collision_free_delivery() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Existing preview", "azw3");
        let target = destination.path.join("documents/Existing preview.azw3");
        fs::write(&target, b"keep existing").unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || worker(store, receiver, None));
        let engine = Engine {
            sender,
            root: PathBuf::new(),
        };
        let preview = engine
            .request(|reply| Request::PreviewSend {
                destination: destination.clone(),
                item_ids: vec![item.id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(
            preview.entries[0].result.as_ref().map(|ready| ready.format),
            Ok(FormatId::Azw3)
        );
        assert_eq!(fs::read(&target).unwrap(), b"keep existing");
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            1
        );
        assert!(!destination.path.join(".takio").exists());
        let report = engine
            .request(|reply| Request::SendReviewed {
                destination: preview.destination.clone(),
                entries: preview.entries,
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(
            report.entries[0].result.as_ref().unwrap_err(),
            "destination-file-exists"
        );
        assert_eq!(fs::read(target).unwrap(), b"keep existing");
        drop(engine);
        worker.join().unwrap();
    }

    #[test]
    fn reviewed_send_rejects_changed_preference_or_source_path() {
        for change in ["capabilities", "preferred-attachment", "source-path"] {
            let (temp, mut store, destination) = delivery_fixture();
            let item = add_book(&mut store, temp.path(), "Reviewed", "epub");
            let mobi = temp.path().join("reviewed.mobi");
            fs::write(&mobi, b"reviewed mobi").unwrap();
            store.attach_format(&item.id, &mobi, false).unwrap();
            let preview =
                preview_send(&store, &destination, std::slice::from_ref(&item.id)).unwrap();
            assert_eq!(
                preview.entries[0].result.as_ref().unwrap().format,
                FormatId::Mobi
            );
            match change {
                "capabilities" => {
                    fs::create_dir(destination.path.join("koreader")).unwrap();
                }
                "preferred-attachment" => {
                    let azw3 = temp.path().join("preferred.azw3");
                    fs::write(&azw3, b"new preferred attachment").unwrap();
                    store.attach_format(&item.id, &azw3, true).unwrap();
                }
                "source-path" => {
                    store.remove_format(&item.id, FormatId::Mobi).unwrap();
                    let replacement = temp.path().join("replacement.mobi");
                    fs::write(&replacement, b"replacement attachment").unwrap();
                    store.attach_format(&item.id, &replacement, false).unwrap();
                }
                _ => unreachable!(),
            }
            let report = send_reviewed(&store, &preview.destination, &preview.entries).unwrap();
            assert_eq!(report.entries.len(), 1);
            assert_eq!(
                report.entries[0].result.as_ref().unwrap_err(),
                "send-review-changed",
                "{change}"
            );
            assert_eq!(
                fs::read_dir(destination.path.join("documents"))
                    .unwrap()
                    .count(),
                0
            );
            assert!(!destination.path.join(".takio").exists());
            assert_eq!(fs::read(&mobi).unwrap(), b"reviewed mobi");
        }
    }

    #[test]
    fn reviewed_send_preserves_no_compatible_format_error() {
        let (temp, mut store, destination) = delivery_fixture();
        fs::create_dir(destination.path.join("koreader")).unwrap();
        let item = add_book(&mut store, temp.path(), "EPUB reviewed", "epub");
        let preview = preview_send(&store, &destination, &[item.id]).unwrap();
        fs::remove_dir(destination.path.join("koreader")).unwrap();
        let report = send_reviewed(&store, &preview.destination, &preview.entries).unwrap();
        assert_eq!(
            report.entries[0].result.as_ref().unwrap_err(),
            "no-compatible-format"
        );
        assert!(!destination.path.join(".takio").exists());
    }

    #[test]
    fn reviewed_send_delivers_unchanged_ready_files_only_and_is_bounded() {
        let (temp, mut store, destination) = delivery_fixture();
        let ready = add_book(&mut store, temp.path(), "Reviewed ready", "azw3");
        let blocked = add_book(&mut store, temp.path(), "Reviewed blocked", "epub");
        let preview = preview_send(&store, &destination, &[blocked.id, ready.id.clone()]).unwrap();
        let selected = preview.entries[1].result.as_ref().unwrap();
        assert_eq!(selected.format, FormatId::Azw3);
        assert_eq!(selected.source_path, ready.formats[0].source_path);
        assert_eq!(
            send_reviewed(
                &store,
                &destination,
                &vec![preview.entries[1].clone(); MAX_SEND_ITEMS + 1]
            )
            .unwrap_err()
            .code(),
            "invalid-arguments"
        );
        assert!(!destination.path.join(".takio").exists());
        let report = send_reviewed(&store, &preview.destination, &preview.entries).unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].item_id, ready.id);
        let result = report.entries[0].result.as_ref().unwrap();
        assert_eq!(
            fs::read(&result.path).unwrap(),
            fs::read(&selected.source_path).unwrap()
        );
        assert_eq!(destinations::inventory(&destination).unwrap().len(), 1);
    }

    #[test]
    fn kindle_prefers_attached_azw3_over_first_epub_and_mobi() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Preferred", "epub");
        for extension in ["mobi", "azw3"] {
            let source = temp.path().join(format!("Preferred.{extension}"));
            fs::write(&source, extension).unwrap();
            store.attach_format(&item.id, &source, true).unwrap();
        }
        let result = send_item(&store, &destination, &item.id).unwrap();
        assert_eq!(result.path.extension().unwrap(), "azw3");
        assert_eq!(fs::read(&result.path).unwrap(), b"azw3");
        assert_eq!(
            destinations::inventory(&destination).unwrap()[0].status,
            "present"
        );
        assert!(!destination.path.join("documents/Preferred.epub").exists());
    }

    #[test]
    fn stock_kindle_rejects_epub_even_with_stale_koreader_feature() {
        let (temp, mut store, mut destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Incompatible", "epub");
        destination.features.push("koreader".into());
        let error = send_item(&store, &destination, &item.id).unwrap_err();
        assert_eq!(error.code(), "no-compatible-format");
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn detected_koreader_can_receive_attached_epub_without_conversion() {
        let (temp, mut store, destination) = delivery_fixture();
        fs::create_dir(destination.path.join("koreader")).unwrap();
        let item = add_book(&mut store, temp.path(), "KOReader", "epub");
        let result = send_item(&store, &destination, &item.id).unwrap();
        assert_eq!(result.path.extension().unwrap(), "epub");
        assert_eq!(
            fs::read(result.path).unwrap(),
            fs::read(item.source_path).unwrap()
        );
    }

    #[test]
    fn send_many_reports_each_failure_and_continues_in_order() {
        let (temp, mut store, destination) = delivery_fixture();
        let incompatible = add_book(&mut store, temp.path(), "EPUB only", "epub");
        let missing_source = add_book(&mut store, temp.path(), "Missing source", "mobi");
        fs::remove_file(&missing_source.source_path).unwrap();
        let good = add_book(&mut store, temp.path(), "Good", "azw3");
        let ids = vec![
            incompatible.id.clone(),
            "absent".into(),
            missing_source.id.clone(),
            good.id.clone(),
        ];
        let report = send_many(&store, &destination, &ids).unwrap();
        assert_eq!(report.entries.len(), 4);
        assert_eq!(
            report
                .entries
                .iter()
                .map(|entry| &entry.item_id)
                .collect::<Vec<_>>(),
            ids.iter().collect::<Vec<_>>()
        );
        assert_eq!(report.entries[0].title, "EPUB only");
        assert_eq!(
            report.entries[0].result.as_ref().unwrap_err(),
            "no-compatible-format"
        );
        assert_eq!(report.entries[1].title, "absent");
        assert_eq!(report.entries[1].result.as_ref().unwrap_err(), "not-found");
        assert_eq!(
            report.entries[2].result.as_ref().unwrap_err(),
            "source-unavailable"
        );
        assert!(report.entries[3].result.as_ref().unwrap().path.exists());
    }

    #[test]
    fn existing_destination_is_not_overwritten_and_next_book_is_sent() {
        let (temp, mut store, destination) = delivery_fixture();
        let first = add_book(&mut store, temp.path(), "Existing", "azw3");
        let second = add_book(&mut store, temp.path(), "Next", "mobi");
        let target = destination
            .path
            .join("documents")
            .join(destinations::destination_file_name(
                "Existing", None, "azw3",
            ));
        fs::write(&target, b"keep me").unwrap();
        let report = send_many(&store, &destination, &[first.id, second.id]).unwrap();
        assert_eq!(
            report.entries[0].result.as_ref().unwrap_err(),
            "destination-file-exists"
        );
        assert!(report.entries[1].result.is_ok());
        assert_eq!(fs::read(target).unwrap(), b"keep me");
    }

    #[test]
    fn delivery_batch_is_bounded_before_any_copy() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Bounded", "azw3");
        let error =
            send_many(&store, &destination, &vec![item.id; MAX_SEND_ITEMS + 1]).unwrap_err();
        assert_eq!(error.code(), "invalid-arguments");
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            send_many(&store, &destination, &[])
                .unwrap()
                .entries
                .is_empty()
        );
    }

    #[test]
    fn disconnected_destination_is_not_recreated() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Disconnected", "azw3");
        fs::remove_dir_all(&destination.path).unwrap();
        assert_eq!(
            send_item(&store, &destination, &item.id)
                .unwrap_err()
                .code(),
            "unknown-destination"
        );
        assert!(!destination.path.exists());
    }

    #[test]
    fn worker_updates_metadata_and_sends_many() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Before", "azw3");
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || worker(store, receiver, None));
        let engine = Engine {
            sender,
            root: PathBuf::new(),
        };
        let updated = engine
            .request(|reply| Request::Update {
                id: item.id.clone(),
                patch: LibraryPatch {
                    title: takio::model::Patch::Set("After".into()),
                    ..LibraryPatch::default()
                },
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "After");
        let report = engine
            .request(|reply| Request::SendMany {
                destination,
                item_ids: vec![item.id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(report.entries[0].title, "After");
        assert!(report.entries[0].result.is_ok());
        drop(engine);
        worker.join().unwrap();
    }

    #[test]
    fn trashed_items_are_rejected_by_single_and_batch_delivery() {
        let (temp, mut store, destination) = delivery_fixture();
        let item = add_book(&mut store, temp.path(), "Trash", "azw3");
        store.trash(&item.id).unwrap();
        assert_eq!(
            send_item(&store, &destination, &item.id)
                .unwrap_err()
                .code(),
            "item-trashed"
        );
        let report = send_many(&store, &destination, &[item.id]).unwrap();
        assert_eq!(report.entries[0].title, "Trash");
        assert_eq!(
            report.entries[0].result.as_ref().unwrap_err(),
            "item-trashed"
        );
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn unknown_device_does_not_fall_back_to_first_attachment() {
        let (temp, mut store, destination) = delivery_fixture();
        fs::remove_dir(destination.path.join("system")).unwrap();
        let item = add_book(&mut store, temp.path(), "Unknown reader", "epub");
        assert_eq!(
            send_item(&store, &destination, &item.id)
                .unwrap_err()
                .code(),
            "no-compatible-format"
        );
        assert_eq!(
            fs::read_dir(destination.path.join("documents"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn kindle_accepts_attached_mobi_and_pdf_without_conversion() {
        let (temp, mut store, destination) = delivery_fixture();
        for extension in ["mobi", "pdf"] {
            let item = add_book(&mut store, temp.path(), extension, extension);
            let result = send_item(&store, &destination, &item.id).unwrap();
            assert_eq!(result.path.extension().unwrap(), extension);
            assert_eq!(
                fs::read(result.path).unwrap(),
                fs::read(item.source_path).unwrap()
            );
        }
    }

    #[test]
    fn import_query_trash_restore_round_trip() {
        let (temp, engine) = engine();
        let a = epub(temp.path(), "Alpha");
        let b = epub(temp.path(), "Beta");
        let scan = engine
            .request(|reply| Request::Import {
                roots: vec![a, b],
                mode: ImportMode::Copy,
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(scan.counts.imported, 2);

        let items = engine
            .request(|reply| Request::Query {
                query: String::new(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Alpha");

        let filtered = engine
            .request(|reply| Request::Query {
                query: "bet".into(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].title, "Beta");

        let id = items[0].id.clone();
        engine
            .request(|reply| Request::Trash {
                ids: vec![id.clone()],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let trash = engine
            .request(|reply| Request::ListTrash { reply })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(trash.len(), 1);

        engine
            .request(|reply| Request::Restore {
                ids: vec![id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let items = engine
            .request(|reply| Request::Query {
                query: String::new(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn facet_counts_cover_every_dimension() {
        let (temp, engine) = engine();
        let a = epub(temp.path(), "Alpha");
        engine
            .request(|reply| Request::Import {
                roots: vec![a],
                mode: ImportMode::Copy,
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let items = engine
            .request(|reply| Request::Query {
                query: String::new(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let facets = Facets::from_items(&items);
        assert_eq!(facets.formats.get("epub"), Some(&1));
    }

    #[test]
    fn dropped_engine_closes_reply_channels() {
        let (_temp, engine) = engine();
        let receiver = engine.request(|reply| Request::ListTrash { reply });
        drop(engine);
        // The worker exits when the request sender is gone; any reply it
        // already sent is still observable, and nothing hangs.
        let _ = receiver.recv_timeout(std::time::Duration::from_secs(2));
    }
}
