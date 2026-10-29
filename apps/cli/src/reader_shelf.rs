//! Read-only view of the books on a mounted reader, matched to the library.
//!
//! Nothing on the reader or in the library is written. A file counts as one of
//! the library's books only when its exact size and SHA-256 equal a managed
//! format of an active book, or equal the fingerprint Takio recorded when it
//! delivered that file for a book that is still active. Only files whose size
//! equals such a candidate are read.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::destinations::{self, Destination, DestinationKind};
use crate::fingerprint::Fingerprint;
use crate::import_scan::{ImportScan, scan_imports};
use crate::output::AppResult;
use crate::store::{ActiveFingerprint, LibraryStore};

const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 20_000;
const MAX_BOOKS: usize = 5_000;
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
    pub matched_by: Option<&'static str>,
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
    /// The scan stopped at its depth-independent entry or book bound.
    pub truncated: bool,
}

impl ReaderShelf {
    #[must_use]
    pub fn item_ids(&self) -> BTreeSet<&str> {
        self.books
            .iter()
            .filter_map(|entry| entry.item_id.as_deref())
            .collect()
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
        if let Some((bytes, sha256)) = &book.fingerprint {
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
            let Ok(entry) = entry else { continue };
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
                && let Some((_, sha256)) = hash(entry.path()).filter(|(read, _)| *read == bytes)
            {
                matched = candidates
                    .and_then(|candidates| candidates.iter().find(|(known, _)| *known == sha256))
                    .map(|(_, id)| (*id, "content"))
                    .or_else(|| {
                        record
                            .filter(|record| record.sha256 == sha256)
                            .map(|record| (record.item_id.as_str(), "delivery-record"))
                    });
            }
            books.push(ShelfEntry {
                path: relative,
                bytes,
                item_id: matched.map(|(id, _)| id.to_owned()),
                title: matched.and_then(|(id, _)| titles.get(id).map(|&title| title.to_owned())),
                matched_by: matched.map(|(_, how)| how),
            });
        }
    }
    let mut shelf = ReaderShelf {
        destination_id: destination.id.clone(),
        in_library: 0,
        not_in_library: books.iter().filter(|entry| entry.item_id.is_none()).count(),
        books,
        truncated,
    };
    shelf.in_library = shelf.item_ids().len();
    Ok(shelf)
}

/// Copy every book file on the reader that matches no active library book into the
/// library. The reader is only read. Files are explicit sources, so short PDFs are
/// kept and formats the library cannot store are reported as skipped.
pub fn import_unmatched(
    store: &mut LibraryStore,
    destination: &Destination,
) -> AppResult<ImportScan> {
    let shelf = scan_files(destination, &store.active_fingerprints()?)?;
    let sources: Vec<PathBuf> = shelf
        .books
        .iter()
        .filter(|entry| entry.item_id.is_none())
        .map(|entry| destination.path.join(&entry.path))
        .collect();
    scan_imports(store, &sources, false, false, || false)
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
    use crate::paths::LibraryPaths;
    use crate::store::LibraryStore;
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
        let store = LibraryStore::open(paths, true).unwrap();
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
        f.store.import(&source, None, false).unwrap().id
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
        assert_eq!(matched.matched_by, Some("content"));
        assert!(
            shelf.books[0].item_id.is_none(),
            "same size, different bytes"
        );
        assert!(shelf.books[2].item_id.is_none());
        assert_eq!((shelf.in_library, shelf.not_in_library), (1, 2));
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
            "pdf",
            None,
            false,
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
        assert_eq!(sent.matched_by, Some("delivery-record"));

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
        use crate::import_scan::ImportOutcome;
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

        let scan = import_unmatched(&mut f.store, &destination).unwrap();

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
        assert!(after.item_ids().contains(kindred.as_str()));

        let again = import_unmatched(&mut f.store, &destination).unwrap();
        assert_eq!((again.counts.imported, again.counts.skipped), (0, 1));
        assert_eq!(snapshot(&f.kindle), before);
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
