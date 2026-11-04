//! Print the title and authors Takio reads from MOBI-family files, one JSON line each.
//! Usage: cargo run --offline --release -p takio-engine --example mobi_metadata -- <file>...
fn main() {
    for path in std::env::args().skip(1) {
        let (title, authors) = takio::metadata::embedded_mobi(std::path::Path::new(&path));
        let authors: Vec<_> = authors.into_iter().map(|author| author.name).collect();
        println!(
            "{}",
            serde_json::json!({"path": path, "title": title, "authors": authors})
        );
    }
}
