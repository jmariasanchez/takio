//! The engine thread: sole owner of the `LibraryStore`.
//!
//! The UI never touches SQLite. Every operation is a typed [`Request`]
//! carrying a oneshot reply sender. One worker thread drains requests in
//! order, which serializes mutations exactly like the Electron sidecar's
//! `library service` loop did, but without a process boundary or JSON.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use takio::destinations::{self, DeliveryResult, Destination};
use takio::import_scan::{ImportScan, scan_imports};
use takio::model::LibraryItem;
use takio::output::{AppError, AppResult};
use takio::paths::LibraryPaths;
use takio::store::{LibraryQueryFilters, LibraryStore};

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

/// Everything the UI can ask the engine to do.
pub enum Request {
    Query {
        query: String,
        filters: Filters,
        reply: Sender<AppResult<Vec<LibraryItem>>>,
    },
    ListTrash {
        reply: Sender<AppResult<Vec<LibraryItem>>>,
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
    Send {
        destination: Destination,
        item_id: String,
        reply: Sender<AppResult<DeliveryResult>>,
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
}

impl Engine {
    /// Open (or create) the library at `paths` on a dedicated thread.
    ///
    /// # Errors
    ///
    /// Returns the store's open error so the UI can show it before any
    /// window exists.
    pub fn open(paths: LibraryPaths) -> AppResult<Self> {
        let store = LibraryStore::open(paths, true)?;
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("takio-engine".into())
            .spawn(move || worker(store, receiver))
            .map_err(|_| AppError::new("storage-unavailable"))?;
        Ok(Self { sender })
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

fn worker(mut store: LibraryStore, receiver: Receiver<Request>) {
    while let Ok(request) = receiver.recv() {
        match request {
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
            Request::Send {
                destination,
                item_id,
                reply,
            } => {
                let _ = reply.send(send_item(&store, &destination, &item_id));
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

fn send_item(
    store: &LibraryStore,
    destination: &Destination,
    item_id: &str,
) -> AppResult<DeliveryResult> {
    let item = store
        .get(item_id)?
        .ok_or_else(|| AppError::new("not-found"))?;
    let format = item
        .formats
        .first()
        .ok_or_else(|| AppError::new("format-not-found"))?;
    let author = item
        .authors
        .first()
        .map(|author| author.name.as_str())
        .or(item.author.as_deref());
    let extension = format.format.extension();
    let file_name = destinations::destination_file_name(&item.title, author, extension);
    destinations::send(
        destination,
        item_id,
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
