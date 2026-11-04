//! Parse every sidecar file given on the command line with Takio's KOReader reader
//! and print what it extracted, to compare against LuaJIT's `dofile`.
use std::path::Path;

fn main() {
    for path in std::env::args().skip(1) {
        let path = Path::new(&path);
        let stem = path.file_stem().unwrap().to_string_lossy();
        // reading_state expects <mount>/<book>.sdr/metadata.<ext>.lua; stage that shape.
        let staged = tempfile::tempdir().unwrap();
        let sdr = staged.path().join("book.sdr");
        std::fs::create_dir_all(&sdr).unwrap();
        std::fs::copy(path, sdr.join("metadata.epub.lua")).unwrap();
        let started = std::time::Instant::now();
        let state = takio::delivery::koreader::reading_state(staged.path(), Path::new("book.epub"));
        println!(
            "{stem}\t{:?}\t{:?}\t{:.2} ms",
            state.as_ref().and_then(|s| s.percent),
            state.as_ref().and_then(|s| s.status.clone()),
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
}
