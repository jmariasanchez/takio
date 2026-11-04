//! Keep the public module map aligned with the engine's canonical entry points.
#[test]
fn architecture_documents_engine_module_owners() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let architecture = std::fs::read_to_string(root.join("../../docs/architecture.md")).unwrap();
    for (domain, source) in [
        ("", "lib.rs"),
        ("library", "library.rs"),
        ("import", "import.rs"),
        ("delivery", "delivery.rs"),
        ("metadata", "metadata.rs"),
        ("conversion", "conversion.rs"),
    ] {
        let source = std::fs::read_to_string(root.join("src").join(source)).unwrap();
        for name in source
            .lines()
            .filter_map(|line| line.strip_prefix("pub mod ")?.strip_suffix(';'))
        {
            let name = if domain.is_empty() {
                name.to_owned()
            } else {
                format!("{domain}::{name}")
            };
            assert!(
                architecture.contains(&format!("| `{name}`")),
                "undocumented module: {name}"
            );
        }
    }
}
