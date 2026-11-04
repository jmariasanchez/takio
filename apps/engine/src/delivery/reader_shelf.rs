//! Read-only view of the books on a mounted reader, matched to the library.
//!
//! Nothing on the reader or in the catalogue is written. A small cache next to the
//! catalogue remembers the fingerprints of unchanged reader files, so a reader on a
//! slow USB connection is read in full only once. A file counts as one of
//! the library's books only when its exact size and SHA-256 equal a managed
//! format of an active book, or equal the fingerprint Takio recorded when it
//! delivered that file for a book that is still active. Only files whose size
//! equals such a candidate are read.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::delivery::destinations::{self, Destination, DestinationKind};
use crate::delivery::koreader::ReadingState;
use crate::error::AppResult;
use crate::fingerprint::Fingerprint;
use crate::format::detect_format;
use crate::import::scan::{ImportScan, scan_imports};
use crate::library::store::{ActiveFingerprint, LibraryStore};

const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 20_000;
const MAX_BOOKS: usize = 5_000;
/// Name of the reader fingerprint cache inside a library folder.
pub const HASH_CACHE_FILE: &str = "reader-hashes.json";
const HASH_CACHE_VERSION: u32 = 1;
const MAX_CACHE_ENTRIES: usize = 4 * MAX_BOOKS;
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024;
const BOOK_EXTENSIONS: &[&str] = &[
    "azw", "azw3", "cbr", "cbz", "djvu", "epub", "fb2", "kfx", "mobi", "pdf", "prc", "txt",
];
/// Reader software, dictionaries and volume housekeeping, not the owner's books.
const SKIPPED_DIRECTORIES: &[&str] = &[
    "system",
    "koreader",
    "dictionaries",
    "system volume information",
    "$recycle.bin",
    "lost.dir",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShelfMatchSource {
    Content,
    DeliveryRecord,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfEntry {
    /// Path relative to the reader's mount point, with `/` separators.
    pub path: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// The library title of a matched book.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `content` or `delivery-record` for a matched book.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<ShelfMatchSource>,
    /// What KOReader recorded for this file, when its sidecar is readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading: Option<ReadingState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderShelf {
    pub destination_id: String,
    pub books: Vec<ShelfEntry>,
    /// Distinct library books with at least one file on the reader.
    pub in_library: usize,
    /// Book files that match no active library book.
    pub not_in_library: usize,
    /// Unmatched files in a format the library can store, so `import_unmatched` would add them.
    pub importable: usize,
    /// The scan stopped at its depth-independent entry or book bound.
    pub truncated: bool,
    /// Folders or files that could not be read, so the counts may be incomplete.
    pub unreadable: usize,
    /// KOReader was detected, so reading state comes from its sidecars.
    pub koreader: bool,
    /// Files KOReader marks as finished, and books started but not finished.
    pub finished: usize,
    pub in_progress: usize,
}

impl ReaderShelf {
    #[must_use]
    pub fn item_ids(&self) -> BTreeSet<&str> {
        self.books
            .iter()
            .filter_map(|entry| entry.item_id.as_deref())
            .collect()
    }

    /// KOReader's state for a library book on this reader, preferring the most read copy.
    #[must_use]
    pub fn reading_for(&self, item_id: &str) -> Option<&ReadingState> {
        self.books
            .iter()
            .filter(|entry| entry.item_id.as_deref() == Some(item_id))
            .filter_map(|entry| entry.reading.as_ref())
            .max_by(|left, right| {
                (left.finished(), left.percent.unwrap_or(0.0))
                    .partial_cmp(&(right.finished(), right.percent.unwrap_or(0.0)))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    }
}

/// Scan with a fresh SHA-256 of every candidate file.
pub fn scan_files(
    destination: &Destination,
    library: &[ActiveFingerprint],
) -> AppResult<ReaderShelf> {
    scan(destination, library, &mut |path| {
        crate::fingerprint::hash_file(path).ok()
    })
}

/// Fingerprints of reader files keyed by path, reused while size and modification
/// time are unchanged. Readers are only re-read when a file really changed.
///
/// The cache only decides which marks are shown. Importing and sending always read
/// the bytes they act on.
#[derive(Debug, Default)]
pub struct HashCache {
    entries: HashMap<PathBuf, (u64, Option<SystemTime>, Fingerprint)>,
    /// Bytes read to hash files, for measurement.
    pub hashed_bytes: u64,
    /// Entries changed since the cache was loaded or saved.
    dirty: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCache {
    version: u32,
    entries: Vec<StoredEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    path: String,
    bytes: u64,
    modified_secs: u64,
    modified_nanos: u32,
    sha256: String,
}

impl HashCache {
    /// The cache saved in `library_root`. A missing, oversized or malformed cache is
    /// empty, so the worst case is reading the reader again.
    #[must_use]
    pub fn load(library_root: &Path) -> Self {
        let path = library_root.join(HASH_CACHE_FILE);
        let stored = fs::symlink_metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() <= MAX_CACHE_BYTES)
            .and_then(|_| fs::read(&path).ok())
            .and_then(|bytes| serde_json::from_slice::<StoredCache>(&bytes).ok())
            .filter(|stored| {
                stored.version == HASH_CACHE_VERSION && stored.entries.len() <= MAX_CACHE_ENTRIES
            });
        let mut cache = Self::default();
        for entry in stored.map(|stored| stored.entries).unwrap_or_default() {
            let valid = entry.modified_nanos < 1_000_000_000
                && entry.sha256.len() == 64
                && entry
                    .sha256
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
            let modified =
                UNIX_EPOCH.checked_add(Duration::new(entry.modified_secs, entry.modified_nanos));
            if valid && let Some(modified) = modified {
                cache.entries.insert(
                    PathBuf::from(entry.path),
                    (
                        entry.bytes,
                        Some(modified),
                        Fingerprint {
                            bytes: entry.bytes,
                            sha256: entry.sha256,
                        },
                    ),
                );
            }
        }
        cache
    }

    /// Save changed entries into `library_root`, replacing the file atomically. Does
    /// nothing when unchanged or when the library folder does not exist, so reading
    /// a reader never creates a library.
    ///
    /// # Errors
    ///
    /// Returns the I/O error when the cache could not be written. Callers may ignore
    /// it: the cache is only an optimization.
    pub fn save(&mut self, library_root: &Path) -> std::io::Result<()> {
        if !self.dirty || !fs::symlink_metadata(library_root).is_ok_and(|meta| meta.is_dir()) {
            return Ok(());
        }
        let mut entries: Vec<StoredEntry> = self
            .entries
            .iter()
            .filter_map(|(path, (bytes, modified, Fingerprint { sha256, .. }))| {
                let since = modified.as_ref()?.duration_since(UNIX_EPOCH).ok()?;
                Some(StoredEntry {
                    path: path.to_str()?.to_owned(),
                    bytes: *bytes,
                    modified_secs: since.as_secs(),
                    modified_nanos: since.subsec_nanos(),
                    sha256: sha256.clone(),
                })
            })
            .collect();
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let body = serde_json::to_vec(&StoredCache {
            version: HASH_CACHE_VERSION,
            entries,
        })
        .map_err(std::io::Error::other)?;
        let mut staged = tempfile::Builder::new()
            .prefix(".reader-hashes-")
            .suffix(".tmp")
            .tempfile_in(library_root)?;
        // Not synced: after a crash a torn file is malformed and ignored, never trusted.
        std::io::Write::write_all(&mut staged, &body)?;
        staged
            .persist(library_root.join(HASH_CACHE_FILE))
            .map_err(|error| error.error)?;
        self.dirty = false;
        Ok(())
    }

    fn fingerprint(&mut self, path: &Path, seen: &mut BTreeSet<PathBuf>) -> Option<Fingerprint> {
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata.modified().ok();
        seen.insert(path.to_path_buf());
        if let Some((len, time, fingerprint)) = self.entries.get(path)
            && *len == metadata.len()
            && *time == modified
            && modified.is_some()
        {
            return Some(fingerprint.clone());
        }
        self.read(path, metadata.len(), modified)
    }

    /// Hash `path` now, ignoring any cached entry, and remember the result.
    fn refresh(&mut self, path: &Path) -> Option<Fingerprint> {
        let metadata = fs::metadata(path).ok()?;
        self.read(path, metadata.len(), metadata.modified().ok())
    }

    fn read(&mut self, path: &Path, len: u64, modified: Option<SystemTime>) -> Option<Fingerprint> {
        let fingerprint = crate::fingerprint::hash_file(path).ok()?;
        self.hashed_bytes += fingerprint.bytes;
        self.remember(path, len, modified, fingerprint.clone());
        Some(fingerprint)
    }

    fn remember(
        &mut self,
        path: &Path,
        len: u64,
        modified: Option<SystemTime>,
        fingerprint: Fingerprint,
    ) {
        self.entries
            .insert(path.to_path_buf(), (len, modified, fingerprint));
        self.dirty = true;
    }
}

fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

/// Scan, reusing `cache` for files whose size and modification time are unchanged.
/// Entries for files no longer hashed are dropped so the cache stays bounded.
pub fn scan_cached(
    destination: &Destination,
    library: &[ActiveFingerprint],
    cache: &mut HashCache,
) -> AppResult<ReaderShelf> {
    let mut seen = BTreeSet::new();
    let shelf = scan(destination, library, &mut |path| {
        cache.fingerprint(path, &mut seen)
    })?;
    let prefix = &destination.path;
    let before = cache.entries.len();
    cache
        .entries
        .retain(|path, _| !path.starts_with(prefix) || seen.contains(path));
    // Readers that are never connected again must not grow the cache without bound.
    if cache.entries.len() > MAX_CACHE_ENTRIES {
        cache.entries.retain(|path, _| path.starts_with(prefix));
    }
    cache.dirty |= cache.entries.len() != before;
    Ok(shelf)
}

/// Scan, obtaining fingerprints through `hash` so callers can cache unchanged files.
pub fn scan(
    destination: &Destination,
    library: &[ActiveFingerprint],
    hash: &mut dyn FnMut(&Path) -> Option<Fingerprint>,
) -> AppResult<ReaderShelf> {
    let root = match destination.kind {
        DestinationKind::Kindle => destination.path.join("documents"),
        DestinationKind::Kobo | DestinationKind::Generic => destination.path.clone(),
    };
    let titles: HashMap<&str, &str> = library
        .iter()
        .map(|book| (book.item_id.as_str(), book.title.as_str()))
        .collect();
    let mut by_size: HashMap<u64, Vec<(&str, &str)>> = HashMap::new();
    for book in library {
        if let Some(Fingerprint { bytes, sha256 }) = &book.fingerprint {
            by_size
                .entry(*bytes)
                .or_default()
                .push((sha256.as_str(), book.item_id.as_str()));
        }
    }
    // A malformed manifest only removes the fallback; content matching still works.
    let records = destinations::delivery_records(destination).unwrap_or_default();
    let records: HashMap<&str, _> = records
        .iter()
        .filter(|record| titles.contains_key(record.item_id.as_str()))
        .map(|record| (record.relative_path.as_str(), record))
        .collect();

    let mut books = Vec::new();
    let mut truncated = false;
    let mut unreadable = 0;
    let koreader = destination.has_koreader();
    let is_directory = fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.is_dir());
    if is_directory {
        let walker = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .max_depth(MAX_DEPTH)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !skipped(entry));
        for (visited, entry) in walker.enumerate() {
            if visited >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let Ok(entry) = entry else {
                unreadable += 1;
                continue;
            };
            if !entry.file_type().is_file() || !is_book(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(relative) = entry.path().strip_prefix(&destination.path) else {
                continue;
            };
            if books.len() >= MAX_BOOKS {
                truncated = true;
                break;
            }
            let bytes = metadata.len();
            let relative = relative
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let candidates = by_size.get(&bytes);
            let record = records
                .get(relative.as_str())
                .filter(|record| record.bytes == bytes);
            let mut matched = None;
            if (candidates.is_some() || record.is_some())
                && let Some(Fingerprint { sha256, .. }) =
                    hash(entry.path()).filter(|read| read.bytes == bytes)
            {
                matched = candidates
                    .and_then(|candidates| candidates.iter().find(|(known, _)| *known == sha256))
                    .map(|(_, id)| (*id, ShelfMatchSource::Content))
                    .or_else(|| {
                        record
                            .filter(|record| record.sha256 == sha256)
                            .map(|record| {
                                (record.item_id.as_str(), ShelfMatchSource::DeliveryRecord)
                            })
                    });
            }
            books.push(ShelfEntry {
                reading: koreader
                    .then(|| {
                        crate::delivery::koreader::reading_state(
                            &destination.path,
                            Path::new(&relative),
                        )
                    })
                    .flatten(),
                path: relative,
                bytes,
                item_id: matched.map(|(id, _)| id.to_owned()),
                title: matched.and_then(|(id, _)| titles.get(id).map(|&title| title.to_owned())),
                matched_by: matched.map(|(_, how)| how),
            });
        }
    }
    let in_library = books
        .iter()
        .filter_map(|entry| entry.item_id.as_deref())
        .collect::<BTreeSet<_>>()
        .len();
    let finished = books
        .iter()
        .filter(|entry| entry.reading.as_ref().is_some_and(ReadingState::finished))
        .count();
    let in_progress = books
        .iter()
        .filter(|entry| {
            entry
                .reading
                .as_ref()
                .is_some_and(ReadingState::in_progress)
        })
        .count();
    Ok(ReaderShelf {
        destination_id: destination.id.clone(),
        in_library,
        not_in_library: books.iter().filter(|entry| entry.item_id.is_none()).count(),
        importable: books
            .iter()
            .filter(|entry| {
                entry.item_id.is_none() && detect_format(Path::new(&entry.path)).is_some()
            })
            .count(),
        books,
        truncated,
        unreadable,
        koreader,
        finished,
        in_progress,
    })
}

/// Copy every book file on the reader that matches no active library book into the
/// library. The reader is only read. Files are explicit sources, so short PDFs are
/// kept and formats the library cannot store are reported as skipped.
///
/// Every file is read fresh, never trusted from `cache`. The fingerprints read here
/// are then remembered, so the next scan shows the new marks without reading the
/// reader again.
pub fn import_unmatched(
    store: &mut LibraryStore,
    destination: &Destination,
    cache: &mut HashCache,
) -> AppResult<ImportScan> {
    let shelf = scan(destination, &store.active_fingerprints()?, &mut |path| {
        cache.refresh(path)
    })?;
    let sources: Vec<PathBuf> = shelf
        .books
        .iter()
        .filter(|entry| entry.item_id.is_none())
        .map(|entry| destination.path.join(&entry.path))
        .collect();
    let stamps: HashMap<&Path, (u64, SystemTime)> = sources
        .iter()
        .filter_map(|source| Some((source.as_path(), stamp(source)?)))
        .collect();
    let scan = scan_imports(
        store,
        &sources,
        crate::library::model::ImportMode::Copy,
        crate::import::scan::ImportObservation::Untracked,
        || false,
    )?;
    let mut managed: HashMap<String, Vec<Fingerprint>> = HashMap::new();
    for book in store.active_fingerprints()? {
        if let Some(fingerprint) = book.fingerprint {
            managed.entry(book.item_id).or_default().push(fingerprint);
        }
    }
    for outcome in &scan.outcomes {
        let crate::import::scan::ImportOutcome::Imported { source_path, item } = outcome else {
            continue;
        };
        // The verified copy's fingerprint is the source's, provided the source was not
        // changed during the import and exactly one of the book's copies has its size.
        let Some(&(bytes, modified)) = stamps.get(source_path.as_path()) else {
            continue;
        };
        let mut same_size = managed
            .get(&item.id)
            .into_iter()
            .flatten()
            .filter(|fingerprint| fingerprint.bytes == bytes);
        if let (Some(fingerprint), None) = (same_size.next(), same_size.next())
            && stamp(source_path) == Some((bytes, modified))
        {
            cache.remember(source_path, bytes, Some(modified), fingerprint.clone());
        }
    }
    Ok(scan)
}

fn skipped(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    name.starts_with('.')
        || (entry.file_type().is_dir()
            && (name.ends_with(".sdr") || SKIPPED_DIRECTORIES.contains(&name.as_str())))
}

fn is_book(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name != "my clippings.txt"
        && name.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty() && BOOK_EXTENSIONS.contains(&extension)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::paths::LibraryPaths;
    use crate::library::store::LibraryStore;
    use std::path::PathBuf;

    struct Fixture {
        _temp: tempfile::TempDir,
        store: LibraryStore,
        volumes: PathBuf,
        kindle: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let paths =
            LibraryPaths::resolve(None, Some(&root.join("library/library.sqlite"))).unwrap();
        let store = LibraryStore::create_or_migrate(paths).unwrap();
        let volumes = root.join("Volumes");
        let kindle = volumes.join("Kindle");
        for directory in ["documents", "system"] {
            fs::create_dir_all(kindle.join(directory)).unwrap();
        }
        Fixture {
            _temp: temp,
            store,
            volumes,
            kindle,
        }
    }

    fn import(f: &mut Fixture, name: &str, bytes: &[u8]) -> String {
        let source = f.kindle.parent().unwrap().parent().unwrap().join(name);
        fs::write(&source, bytes).unwrap();
        f.store
            .import(&source, None, crate::library::model::ImportMode::Copy)
            .unwrap()
            .id
    }

    fn scan_fixture(f: &Fixture) -> ReaderShelf {
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        scan_files(&destination, &f.store.active_fingerprints().unwrap()).unwrap()
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut entries = walkdir::WalkDir::new(root)
            .sort_by_file_name()
            .into_iter()
            .map(|entry| entry.unwrap().into_path())
            .map(|path| {
                let bytes = if path.is_file() {
                    fs::read(&path).unwrap()
                } else {
                    Vec::new()
                };
                (path, bytes)
            })
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[test]
    fn matches_library_books_by_content_and_lists_other_files_read_only() {
        let mut f = fixture();
        let kindred = import(&mut f, "Kindred.epub", b"kindred bytes");
        let _absent = import(&mut f, "Absent.pdf", b"never copied to the reader");
        let documents = f.kindle.join("documents");
        fs::write(
            documents.join("Octavia Butler - Kindred.epub"),
            b"kindred bytes",
        )
        .unwrap();
        fs::write(documents.join("Store Book.azw"), b"bought on the device").unwrap();
        fs::write(documents.join("Changed.epub"), b"kindred bytez").unwrap();
        fs::write(documents.join("My Clippings.txt"), b"highlights").unwrap();
        fs::write(
            documents.join("._Octavia Butler - Kindred.epub"),
            b"kindred bytes",
        )
        .unwrap();
        fs::create_dir_all(documents.join("Kindred.sdr")).unwrap();
        fs::write(documents.join("Kindred.sdr/Kindred.epub"), b"kindred bytes").unwrap();
        fs::create_dir_all(documents.join("dictionaries")).unwrap();
        fs::write(documents.join("dictionaries/Oxford.azw"), b"dictionary").unwrap();
        fs::write(documents.join("cover.jpg"), b"kindred bytes").unwrap();
        fs::write(f.kindle.join("system/Kindred.epub"), b"kindred bytes").unwrap();
        let before = snapshot(&f.kindle);

        let shelf = scan_fixture(&f);

        let paths: Vec<_> = shelf
            .books
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                "documents/Changed.epub",
                "documents/Octavia Butler - Kindred.epub",
                "documents/Store Book.azw"
            ]
        );
        let matched = &shelf.books[1];
        assert_eq!(matched.item_id.as_deref(), Some(kindred.as_str()));
        assert_eq!(matched.title.as_deref(), Some("Kindred"));
        assert_eq!(matched.matched_by, Some(ShelfMatchSource::Content));
        assert!(
            shelf.books[0].item_id.is_none(),
            "same size, different bytes"
        );
        assert!(shelf.books[2].item_id.is_none());
        assert_eq!((shelf.in_library, shelf.not_in_library), (1, 2));
        assert_eq!(shelf.importable, 1, "the .azw store book cannot be stored");
        assert!(!shelf.truncated);
        assert_eq!(snapshot(&f.kindle), before, "the reader is not modified");
    }

    #[test]
    fn trashed_books_do_not_count_as_in_the_library() {
        let mut f = fixture();
        let id = import(&mut f, "Kindred.epub", b"kindred bytes");
        fs::write(f.kindle.join("documents/Kindred.epub"), b"kindred bytes").unwrap();
        f.store.trash(&id).unwrap();
        let shelf = scan_fixture(&f);
        assert_eq!((shelf.in_library, shelf.not_in_library), (0, 1));
        f.store.restore(&id).unwrap();
        assert_eq!(scan_fixture(&f).in_library, 1);
    }

    #[test]
    fn delivery_record_identifies_a_sent_copy_of_a_referenced_format() {
        let mut f = fixture();
        let id = import(&mut f, "Kindred.epub", b"managed epub");
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        // A referenced attachment has no catalogue fingerprint, so only the record can match.
        let referenced = f
            .kindle
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("Kindred.pdf");
        fs::write(&referenced, b"referenced pdf bytes").unwrap();
        destinations::send(
            &destination,
            &id,
            &referenced,
            "Kindred.pdf",
            crate::format::FormatId::Pdf,
            None,
            destinations::OverwritePolicy::Refuse,
        )
        .unwrap();
        fs::write(
            f.kindle.join("documents/Stale.pdf"),
            b"referenced pdf bytez",
        )
        .unwrap();

        let shelf = scan_fixture(&f);
        let sent = shelf
            .books
            .iter()
            .find(|entry| entry.path == "documents/Kindred.pdf")
            .unwrap();
        assert_eq!(sent.item_id.as_deref(), Some(id.as_str()));
        assert_eq!(sent.matched_by, Some(ShelfMatchSource::DeliveryRecord));

        fs::write(
            f.kindle.join("documents/Kindred.pdf"),
            b"referenced pdf bytez",
        )
        .unwrap();
        let changed = scan_fixture(&f);
        assert_eq!(changed.in_library, 0, "a changed file no longer matches");
    }

    #[test]
    fn missing_documents_folder_and_bounds_are_reported_not_failed() {
        let f = fixture();
        fs::remove_dir(f.kindle.join("documents")).unwrap();
        let empty = scan_fixture(&f);
        assert!(empty.books.is_empty() && !empty.truncated);

        fs::create_dir(f.kindle.join("documents")).unwrap();
        for index in 0..=MAX_BOOKS {
            fs::write(f.kindle.join(format!("documents/{index:05}.txt")), b"").unwrap();
        }
        let bounded = scan_fixture(&f);
        assert_eq!(bounded.books.len(), MAX_BOOKS);
        assert!(bounded.truncated);
    }

    #[test]
    fn kobo_scans_the_whole_volume_but_skips_hidden_reader_folders() {
        let f = fixture();
        let kobo = f.volumes.join("KOBOeReader");
        fs::create_dir_all(kobo.join(".kobo")).unwrap();
        fs::write(kobo.join(".kobo/KoboReader.epub"), b"internal").unwrap();
        fs::create_dir_all(kobo.join("Books")).unwrap();
        fs::write(kobo.join("Books/Kindred.kepub.epub"), b"kobo copy").unwrap();
        let destination = destinations::authorize(&kobo, &f.volumes).unwrap();
        let shelf = scan_files(&destination, &[]).unwrap();
        let paths: Vec<_> = shelf
            .books
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(paths, ["Books/Kindred.kepub.epub"]);
    }

    #[test]
    fn only_size_candidates_are_hashed() {
        let mut f = fixture();
        import(&mut f, "Kindred.epub", b"kindred bytes");
        fs::write(f.kindle.join("documents/Same Size.epub"), b"kindred bytez").unwrap();
        fs::write(f.kindle.join("documents/Other.pdf"), b"a different length").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let mut hashed = Vec::new();
        scan(
            &destination,
            &f.store.active_fingerprints().unwrap(),
            &mut |path| {
                hashed.push(path.file_name().unwrap().to_owned());
                crate::fingerprint::hash_file(path).ok()
            },
        )
        .unwrap();
        assert_eq!(hashed, ["Same Size.epub"]);
    }

    #[test]
    fn import_unmatched_copies_reader_only_books_and_leaves_the_reader_untouched() {
        use crate::import::scan::ImportOutcome;
        use crate::metadata::pdf_fixture;

        let mut f = fixture();
        let kindred = import(&mut f, "Kindred.epub", b"kindred bytes");
        let documents = f.kindle.join("documents");
        fs::write(documents.join("Kindred copy.epub"), b"kindred bytes").unwrap();
        fs::create_dir_all(documents.join("Essays")).unwrap();
        fs::write(documents.join("Essays/Short Paper.pdf"), pdf_fixture(3)).unwrap();
        fs::write(
            documents.join("Dawn (Octavia E. Butler) (z-library.sk).txt"),
            b"dawn bytes",
        )
        .unwrap();
        fs::write(documents.join("Store Book.azw"), b"bought on the device").unwrap();
        fs::create_dir_all(documents.join("Dawn.sdr")).unwrap();
        fs::write(documents.join("Dawn.sdr/Dawn.txt"), b"reading position").unwrap();
        let before = snapshot(&f.kindle);
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let mut cache = HashCache::default();

        let scan = import_unmatched(&mut f.store, &destination, &mut cache).unwrap();

        assert_eq!(snapshot(&f.kindle), before, "the reader is not modified");
        assert_eq!(
            (
                scan.counts.imported,
                scan.counts.skipped,
                scan.counts.failed
            ),
            (2, 1, 0)
        );
        assert!(scan.outcomes.iter().any(|outcome| matches!(
            outcome,
            ImportOutcome::Skipped { source_path, reason: "unsupported-format" }
                if source_path.ends_with("Store Book.azw")
        )));
        let titles: Vec<_> = f
            .store
            .list(false)
            .unwrap()
            .into_iter()
            .map(|item| (item.title, item.authors.first().map(|a| a.name.clone())))
            .collect();
        assert!(titles.contains(&("Dawn".to_owned(), Some("Octavia E. Butler".to_owned()))));
        assert!(
            titles.contains(&("Short Paper".to_owned(), None)),
            "{titles:?}"
        );
        assert_eq!(
            titles.len(),
            3,
            "the matching Kindred copy was not re-imported"
        );
        let after = scan_fixture(&f);
        assert_eq!((after.in_library, after.not_in_library), (3, 1));
        assert_eq!(after.importable, 0, "nothing left that an import could add");
        assert!(after.item_ids().contains(kindred.as_str()));

        let again = import_unmatched(&mut f.store, &destination, &mut cache).unwrap();
        assert_eq!((again.counts.imported, again.counts.skipped), (0, 1));
        assert_eq!(snapshot(&f.kindle), before);
    }

    #[cfg(unix)]
    #[test]
    fn saved_cache_lets_a_new_process_rescan_without_reading_the_reader() {
        let mut f = fixture();
        let id = import(&mut f, "Kindred.epub", b"kindred bytes");
        let copy = f.kindle.join("documents/Kindred.epub");
        fs::write(&copy, b"kindred bytes").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let library = f.store.active_fingerprints().unwrap();
        let root = f.store.paths().root.clone();

        let mut first = HashCache::load(&root);
        assert_eq!(
            scan_cached(&destination, &library, &mut first)
                .unwrap()
                .in_library,
            1
        );
        assert_eq!(first.hashed_bytes, 13);
        first.save(&root).unwrap();

        let mut second = HashCache::load(&root);
        let shelf = scan_cached(&destination, &library, &mut second).unwrap();
        assert!(shelf.item_ids().contains(id.as_str()));
        assert_eq!(
            second.hashed_bytes, 0,
            "the saved cache is reused by a new process"
        );
        let saved = fs::read(root.join(HASH_CACHE_FILE)).unwrap();
        // A rewrite would replace the file, so its identity shows whether it was rewritten.
        let identity = || {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(root.join(HASH_CACHE_FILE)).unwrap();
            (metadata.ino(), metadata.mtime_nsec(), metadata.mtime())
        };
        let before = identity();
        std::thread::sleep(std::time::Duration::from_millis(20));
        second.save(&root).unwrap();
        assert_eq!(identity(), before, "unchanged, not rewritten");
        assert_eq!(
            fs::read(root.join(HASH_CACHE_FILE)).unwrap(),
            saved,
            "unchanged, not rewritten"
        );

        // A file edited on the reader after the cache was saved is read again.
        fs::write(&copy, b"kindred bytez").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
        fs::File::options()
            .write(true)
            .open(&copy)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let mut third = HashCache::load(&root);
        let changed = scan_cached(&destination, &library, &mut third).unwrap();
        assert_eq!(third.hashed_bytes, 13);
        assert!(!changed.item_ids().contains(id.as_str()));
        let staged: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(staged.is_empty(), "{staged:?}");
    }

    #[test]
    fn malformed_cache_is_ignored_and_a_missing_library_is_never_created() {
        let mut f = fixture();
        import(&mut f, "Kindred.epub", b"kindred bytes");
        fs::write(f.kindle.join("documents/Kindred.epub"), b"kindred bytes").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let library = f.store.active_fingerprints().unwrap();
        let root = f.store.paths().root.clone();
        let path = f
            .kindle
            .join("documents/Kindred.epub")
            .canonicalize()
            .unwrap();
        let since = fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap();
        let forged = |sha256: &str| {
            serde_json::json!({"version": 1, "entries": [{
                "path": path, "bytes": 13, "modifiedSecs": since.as_secs(),
                "modifiedNanos": since.subsec_nanos(), "sha256": sha256}]})
            .to_string()
        };
        for body in [
            "not json".to_owned(),
            forged("NOT-HEX"),
            forged(&"A".repeat(64)),
            forged(&"g".repeat(64)),
            forged(&"a".repeat(63)),
            forged(&"a".repeat(64)).replace("\"version\":1", "\"version\":2"),
        ] {
            fs::write(root.join(HASH_CACHE_FILE), &body).unwrap();
            let mut cache = HashCache::load(&root);
            let shelf = scan_cached(&destination, &library, &mut cache).unwrap();
            assert_eq!((shelf.in_library, cache.hashed_bytes), (1, 13), "{body}");
        }
        // A well-formed entry is believed while size and time match: it only affects marks.
        fs::write(root.join(HASH_CACHE_FILE), forged(&"a".repeat(64))).unwrap();
        let mut cache = HashCache::load(&root);
        let shelf = scan_cached(&destination, &library, &mut cache).unwrap();
        assert_eq!((shelf.in_library, cache.hashed_bytes), (0, 0));

        let missing = root.join("never-created");
        cache.remember(
            &path,
            13,
            Some(std::time::SystemTime::now()),
            Fingerprint {
                bytes: 13,
                sha256: "b".repeat(64),
            },
        );
        cache.save(&missing).unwrap();
        assert!(!missing.exists());
    }

    #[test]
    fn import_reads_the_reader_fresh_and_leaves_marks_ready_for_the_next_scan() {
        let mut f = fixture();
        let documents = f.kindle.join("documents");
        fs::write(documents.join("Dawn.epub"), b"dawn bytes").unwrap();
        fs::write(documents.join("Wild Seed.mobi"), b"wild seed bytes").unwrap();
        let kindred = import(&mut f, "Kindred.epub", b"kindred bytes");
        let reader_copy = documents.join("Kindred.epub");
        fs::write(&reader_copy, b"kindred bytes").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();

        // A stale entry says the reader copy is the library's Kindred. Import must not
        // trust it: the file now differs, so it is a different book and is imported.
        let mut cache = HashCache::default();
        let library = f.store.active_fingerprints().unwrap();
        assert_eq!(
            scan_cached(&destination, &library, &mut cache)
                .unwrap()
                .in_library,
            1
        );
        let modified = fs::metadata(&reader_copy).unwrap().modified().unwrap();
        fs::write(&reader_copy, b"kindred bytez").unwrap();
        fs::File::options()
            .write(true)
            .open(&reader_copy)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            scan_cached(&destination, &library, &mut cache)
                .unwrap()
                .in_library,
            1,
            "the shelf cache is fooled by an edit that keeps size and time"
        );
        let before = snapshot(&f.kindle);
        let read_before = cache.hashed_bytes;

        let imported = import_unmatched(&mut f.store, &destination, &mut cache).unwrap();

        assert_eq!(snapshot(&f.kindle), before, "the reader is not modified");
        assert_eq!(
            imported.counts.imported, 3,
            "Dawn, Wild Seed and the edited copy"
        );
        assert_eq!(
            cache.hashed_bytes - read_before,
            13,
            "the size candidate is read fresh despite its cached entry"
        );
        let library = f.store.active_fingerprints().unwrap();
        let read_before = cache.hashed_bytes;
        let shelf = scan_cached(&destination, &library, &mut cache).unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (3, 0));
        assert!(
            !shelf.item_ids().contains(kindred.as_str()),
            "the edited copy is its own book"
        );
        assert_eq!(
            cache.hashed_bytes, read_before,
            "marks are ready without reading again"
        );
    }

    #[test]
    fn cache_forgets_readers_that_are_gone_once_it_is_full() {
        let mut f = fixture();
        import(&mut f, "Kindred.epub", b"kindred bytes");
        fs::write(f.kindle.join("documents/Kindred.epub"), b"kindred bytes").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let library = f.store.active_fingerprints().unwrap();
        let mut cache = HashCache::default();
        let now = Some(std::time::SystemTime::now());
        for index in 0..MAX_CACHE_ENTRIES {
            let other = PathBuf::from(format!("/Volumes/Old Reader/{index}.epub"));
            cache.remember(
                &other,
                1,
                now,
                Fingerprint {
                    bytes: 1,
                    sha256: "c".repeat(64),
                },
            );
        }
        scan_cached(&destination, &library, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 1, "only the connected reader is kept");
        assert!(
            cache
                .entries
                .keys()
                .all(|path| path.starts_with(&destination.path))
        );
    }

    #[test]
    fn cached_rescans_read_nothing_until_a_file_changes() {
        let mut f = fixture();
        let id = import(&mut f, "Kindred.epub", b"kindred bytes");
        let copy = f.kindle.join("documents/Kindred.epub");
        fs::write(&copy, b"kindred bytes").unwrap();
        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let library = f.store.active_fingerprints().unwrap();
        let mut cache = HashCache::default();

        assert_eq!(
            scan_cached(&destination, &library, &mut cache)
                .unwrap()
                .in_library,
            1
        );
        assert_eq!(cache.hashed_bytes, 13);
        assert_eq!(
            scan_cached(&destination, &library, &mut cache)
                .unwrap()
                .in_library,
            1
        );
        assert_eq!(
            cache.hashed_bytes, 13,
            "an unchanged file is not read again"
        );

        // Same size, new bytes, later modification time: re-read and no longer matched.
        fs::write(&copy, b"kindred bytez").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
        fs::File::options()
            .write(true)
            .open(&copy)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let changed = scan_cached(&destination, &library, &mut cache).unwrap();
        assert_eq!(cache.hashed_bytes, 26);
        assert!(!changed.item_ids().contains(id.as_str()));

        fs::remove_file(&copy).unwrap();
        scan_cached(&destination, &library, &mut cache).unwrap();
        assert!(
            cache.entries.is_empty(),
            "entries for removed files are dropped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_reader_folders_are_counted_not_hidden() {
        use std::os::unix::fs::PermissionsExt;

        let f = fixture();
        let locked = f.kindle.join("documents/Locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("Hidden.epub"), b"cannot be listed").unwrap();
        fs::write(f.kindle.join("documents/Open.epub"), b"listed").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let shelf = scan_fixture(&f);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let paths: Vec<_> = shelf
            .books
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(paths, ["documents/Open.epub"]);
        assert_eq!(shelf.unreadable, 1, "the locked folder is reported");

        let clean = scan_fixture(&f);
        assert_eq!(clean.unreadable, 0);
        assert_eq!(clean.books.len(), 2);
    }

    #[test]
    fn koreader_shelf_reports_reading_state_and_stock_kindle_does_not() {
        let mut f = fixture();
        let kindred = import(&mut f, "Kindred.epub", b"kindred bytes");
        let dawn = import(&mut f, "Dawn.pdf", b"dawn pdf bytes");
        let documents = f.kindle.join("documents");
        fs::create_dir_all(documents.join("Butler")).unwrap();
        fs::write(documents.join("Butler/Kindred.epub"), b"kindred bytes").unwrap();
        fs::write(documents.join("Dawn.pdf"), b"dawn pdf bytes").unwrap();
        fs::write(documents.join("Unread.mobi"), b"never opened").unwrap();
        fs::create_dir_all(documents.join("Butler/Kindred.sdr")).unwrap();
        fs::write(
            documents.join("Butler/Kindred.sdr/metadata.epub.lua"),
            r#"return { ["percent_finished"] = 0.5, ["summary"] = { ["status"] = "reading" } }"#,
        )
        .unwrap();
        fs::create_dir_all(documents.join("Dawn.sdr")).unwrap();
        fs::write(
            documents.join("Dawn.sdr/metadata.pdf.lua"),
            r#"return { ["percent_finished"] = 1, ["summary"] = { ["status"] = "complete" } }"#,
        )
        .unwrap();

        let stock = scan_fixture(&f);
        assert!(!stock.koreader);
        assert!(stock.books.iter().all(|entry| entry.reading.is_none()));
        assert_eq!((stock.finished, stock.in_progress), (0, 0));

        fs::create_dir(f.kindle.join("koreader")).unwrap();
        let before = snapshot(&f.kindle);
        let shelf = scan_fixture(&f);
        assert!(shelf.koreader);
        assert_eq!((shelf.finished, shelf.in_progress), (1, 1));
        assert_eq!(
            shelf
                .reading_for(&kindred)
                .and_then(ReadingState::label)
                .as_deref(),
            Some("50%")
        );
        assert!(shelf.reading_for(&dawn).unwrap().finished());
        let unread = shelf
            .books
            .iter()
            .find(|entry| entry.path.ends_with("Unread.mobi"))
            .unwrap();
        assert!(unread.reading.is_none());
        assert_eq!(snapshot(&f.kindle), before, "reading state is read-only");

        let destination = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        assert_eq!(destination.label(), "Kindle (KOReader)");
    }

    #[test]
    fn koreader_prefers_epub_and_stock_kindle_never_gets_it() {
        use crate::format::FormatId;
        use crate::library::model::{BookFormat, Provenance};

        let f = fixture();
        let attached = |formats: &[FormatId]| -> Vec<BookFormat> {
            formats
                .iter()
                .map(|format| BookFormat {
                    source_path: PathBuf::from(format!("/library/book.{}", format.extension())),
                    format: *format,
                    added_at: String::new(),
                    provenance: Provenance::Managed,
                })
                .collect()
        };
        let stock = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        let epub_and_azw3 = attached(&[FormatId::Epub, FormatId::Azw3]);
        let epub_only = attached(&[FormatId::Epub]);
        assert_eq!(
            stock.preferred_format(&epub_and_azw3).unwrap().format,
            FormatId::Azw3
        );
        assert!(stock.preferred_format(&epub_only).is_none());

        fs::create_dir(f.kindle.join("koreader")).unwrap();
        let koreader = destinations::authorize(&f.kindle, &f.volumes).unwrap();
        assert_eq!(
            koreader.preferred_format(&epub_and_azw3).unwrap().format,
            FormatId::Epub
        );
        assert_eq!(
            koreader
                .preferred_format(&attached(&[FormatId::Mobi, FormatId::Pdf]))
                .unwrap()
                .format,
            FormatId::Pdf
        );
        assert!(
            koreader
                .preferred_format(&attached(&[FormatId::Docx, FormatId::Html]))
                .is_none(),
            "never an unreadable fallback"
        );
    }

    #[test]
    fn resolve_accepts_listed_ids_and_paths_only() {
        let f = fixture();
        let by_id = destinations::resolve(Path::new("Kindle"), &f.volumes).unwrap();
        assert_eq!(by_id.path, f.kindle);
        let folded = destinations::resolve(Path::new("kindle"), &f.volumes).unwrap();
        assert_eq!(folded.path, f.kindle);
        let by_path = destinations::resolve(&f.kindle, &f.volumes).unwrap();
        assert_eq!(by_path.id, "Kindle");
        for unknown in [
            Path::new("Kobo"),
            Path::new("../Kindle"),
            f.volumes.as_path(),
        ] {
            assert_eq!(
                destinations::resolve(unknown, &f.volumes)
                    .unwrap_err()
                    .code(),
                "unknown-destination"
            );
        }
    }
}
