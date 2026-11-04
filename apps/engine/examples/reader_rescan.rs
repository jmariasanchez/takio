//! Measure repeated reader shelf scans, uncached and with the desktop's hash cache.
//! Usage: cargo run --offline --release -p takio-engine --example reader_rescan -- <library.sqlite> <reader mount>
use std::path::Path;
use std::time::Instant;

use takio::delivery::destinations;
use takio::delivery::reader_shelf::{HashCache, scan_cached, scan_files};
use takio::library::paths::LibraryPaths;
use takio::library::store::LibraryStore;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(db), Some(mount)) = (args.next(), args.next()) else {
        eprintln!("usage: reader_rescan <library.sqlite> <reader mount>");
        std::process::exit(2);
    };
    let paths = LibraryPaths::resolve(None, Some(Path::new(&db))).expect("library path");
    let library = LibraryStore::open_read_only(paths)
        .and_then(|store| store.active_fingerprints())
        .expect("library");
    let mount = Path::new(&mount);
    let reader =
        destinations::authorize(mount, mount.parent().expect("parent")).expect("mounted reader");
    for run in 1..=3 {
        let started = Instant::now();
        let shelf = scan_files(&reader, &library).expect("scan");
        println!(
            "uncached {run}: in_library={} {:.1} ms",
            shelf.in_library,
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    let mut cache = HashCache::default();
    for run in 1..=3 {
        let started = Instant::now();
        let before = cache.hashed_bytes;
        let shelf = scan_cached(&reader, &library, &mut cache).expect("scan");
        println!(
            "cached {run}: in_library={} read={} KiB {:.1} ms",
            shelf.in_library,
            (cache.hashed_bytes - before) / 1024,
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
}
