//! Shared eligibility, format choice, naming, and reviewed delivery workflow.
mod batch;
pub mod destinations;
pub mod kindle_ssh;
pub mod koreader;
pub mod reader_shelf;
pub use batch::{
    MAX_SEND_ITEMS, SendEntry, SendPreview, SendPreviewEntry, SendReport, preview_send_many,
    send_reviewed_many,
};

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::delivery::destinations::{DeliveryResult, Destination};
use crate::error::AppResult;
use crate::format::FormatId;
use crate::library::store::LibraryStore;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyFile {
    pub format: FormatId,
    pub source_path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct SendPlan {
    pub item_id: String,
    pub title: String,
    pub destination: Destination,
    pub ready: ReadyFile,
    pub file_name: String,
}

#[derive(Default)]
pub struct DeliveryOptions<'a> {
    pub format: Option<FormatId>,
    pub reviewed: Option<&'a ReadyFile>,
    pub subdir: Option<&'a Path>,
    pub overwrite: destinations::OverwritePolicy,
}

pub fn reauthorize(destination: &Destination) -> AppResult<Destination> {
    let root = destination
        .authorization_root
        .as_deref()
        .ok_or_else(|| crate::app_error!("unknown-destination"))?;
    destinations::authorize(&destination.path, root)
}

/// A plan checks current catalogue eligibility and current mounted-reader capabilities.
/// It never converts, writes to a reader, or promises physical reader compatibility.
pub fn plan_send(
    store: &LibraryStore,
    destination: &Destination,
    item_id: &str,
    requested: Option<FormatId>,
) -> AppResult<SendPlan> {
    let item = store.get_active(item_id)?;
    let destination = reauthorize(destination)?;
    let format = match requested {
        Some(wanted) => {
            let format = item
                .formats
                .iter()
                .find(|format| format.format == wanted)
                .ok_or_else(|| crate::app_error!("format-not-found"))?;
            if !destination.readable_formats().contains(&wanted)
                && (destination.is_reader() || destination.has_koreader())
            {
                return Err(crate::app_error!("no-compatible-format"));
            }
            format
        }
        None => destination
            .preferred_format(&item.formats)
            .ok_or_else(|| crate::app_error!("no-compatible-format"))?,
    };
    let unavailable = || crate::app_error!("source-unavailable");
    if !format.source_path.is_file() {
        return Err(unavailable());
    }
    let mut source =
        std::fs::File::open(&format.source_path).map_err(crate::io_error!("source-unavailable"))?;
    if !source
        .metadata()
        .map_err(crate::io_error!("source-unavailable"))?
        .is_file()
    {
        return Err(unavailable());
    }
    source
        .read(&mut [0u8; 1])
        .map_err(crate::io_error!("source-unavailable"))?;
    let ready = ReadyFile {
        format: format.format,
        source_path: format.source_path.clone(),
    };
    let file_name = crate::file_name::destination_file_name(
        &item.title,
        item.primary_author(),
        format.format.extension(),
    );
    Ok(SendPlan {
        item_id: item.id,
        title: item.title,
        destination,
        ready,
        file_name,
    })
}

pub fn send_library_item(
    store: &LibraryStore,
    destination: &Destination,
    item_id: &str,
    options: DeliveryOptions<'_>,
) -> AppResult<DeliveryResult> {
    let plan = plan_send(store, destination, item_id, options.format)?;
    if options
        .reviewed
        .is_some_and(|reviewed| reviewed != &plan.ready)
    {
        return Err(crate::app_error!("send-review-changed"));
    }
    destinations::send(
        &plan.destination,
        &plan.item_id,
        &plan.ready.source_path,
        &plan.file_name,
        plan.ready.format,
        options.subdir,
        options.overwrite,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        model::{ImportMode, Provenance},
        paths::LibraryPaths,
    };
    use std::fs;

    #[test]
    fn reauthorization_uses_original_root_not_the_destinations_parent() {
        let temp = tempfile::tempdir().unwrap();
        let volumes = temp.path().join("Volumes");
        let mount = volumes.join("Reader");
        fs::create_dir_all(&mount).unwrap();
        let mut destination = destinations::authorize(&mount, &volumes).unwrap();
        assert!(reauthorize(&destination).is_ok());
        let wire = serde_json::to_value(&destination).unwrap();
        assert!(wire.get("authorizationRoot").is_none());
        let decoded: Destination = serde_json::from_value(wire).unwrap();
        assert_eq!(
            reauthorize(&decoded).unwrap_err().code(),
            "unknown-destination"
        );
        let outside = temp.path().join("elsewhere/Reader");
        fs::create_dir_all(&outside).unwrap();
        destination.path = outside;
        assert_eq!(
            reauthorize(&destination).unwrap_err().code(),
            "unknown-destination"
        );
    }

    #[test]
    fn reviewed_send_rejects_changed_preference_and_path_without_writes() {
        for change in ["capabilities", "preferred-attachment", "source-path"] {
            let temp = tempfile::tempdir().unwrap();
            let paths =
                LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
            let mut store = LibraryStore::create_or_migrate(paths).unwrap();
            let volumes = temp.path().join("Volumes");
            let mount = volumes.join("Kindle");
            fs::create_dir_all(mount.join("documents")).unwrap();
            fs::create_dir_all(mount.join("system")).unwrap();
            let destination = destinations::authorize(&mount, &volumes).unwrap();
            let epub = temp.path().join("book.epub");
            fs::write(&epub, b"epub").unwrap();
            let item = store
                .import(&epub, Some("Reviewed"), ImportMode::Copy)
                .unwrap();
            let mobi = temp.path().join("book.mobi");
            fs::write(&mobi, b"mobi").unwrap();
            store
                .attach_format(&item.id, &mobi, Provenance::Referenced)
                .unwrap();
            let reviewed = plan_send(&store, &destination, &item.id, None)
                .unwrap()
                .ready;
            assert_eq!(reviewed.format, FormatId::Mobi);
            match change {
                "capabilities" => fs::create_dir(mount.join("koreader")).unwrap(),
                "preferred-attachment" => {
                    let azw3 = temp.path().join("preferred.azw3");
                    fs::write(&azw3, b"azw3").unwrap();
                    store
                        .attach_format(&item.id, &azw3, Provenance::Managed)
                        .unwrap();
                }
                _ => {
                    store.remove_format(&item.id, FormatId::Mobi).unwrap();
                    let replacement = temp.path().join("replacement.mobi");
                    fs::write(&replacement, b"replacement").unwrap();
                    store
                        .attach_format(&item.id, &replacement, Provenance::Referenced)
                        .unwrap();
                }
            }
            let error = send_library_item(
                &store,
                &destination,
                &item.id,
                DeliveryOptions {
                    reviewed: Some(&reviewed),
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert_eq!(error.code(), "send-review-changed", "{change}");
            assert_eq!(fs::read_dir(mount.join("documents")).unwrap().count(), 0);
        }
    }
}
