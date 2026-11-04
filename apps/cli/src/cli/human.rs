//! Human-readable list output and desktop library notes.
#[allow(clippy::wildcard_imports)]
use super::*;

pub(super) fn print_human_list(
    store: &LibraryStore,
    items: &[takio::library::model::LibraryItem],
    volumes_root: &Path,
    desktop_environment: &DesktopEnvironment,
) -> AppResult<()> {
    // Only recognizable readers are scanned; a generic USB drive is never walked implicitly.
    let readers: Vec<_> = destinations::list(volumes_root)
        .unwrap_or_default()
        .into_iter()
        .filter(|device| device.is_reader())
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
    if let Some(note) = desktop_library_note(store.paths(), desktop_environment) {
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
pub(super) struct DesktopEnvironment {
    pub(super) data_override: bool,
    pub(super) profile: Option<PathBuf>,
    pub(super) default_root: Option<PathBuf>,
}

pub(super) fn desktop_library_note(
    paths: &LibraryPaths,
    environment: &DesktopEnvironment,
) -> Option<String> {
    let preference = takio::library::paths::desktop_preference_location(
        environment.default_root.as_deref()?,
        environment.data_override,
        environment.profile.as_deref(),
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

pub(super) fn truncate(value: &str, max: usize) -> String {
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
pub(super) fn open_path(path: &Path) -> AppResult<()> {
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
