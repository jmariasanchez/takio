//! Shared eligibility, format choice, naming, and reviewed delivery workflow.
pub mod destinations;
pub mod kindle_ssh;
pub mod koreader;
pub mod reader_shelf;

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::destinations::{DeliveryResult, Destination, DestinationKind};
use crate::format::FormatId;
use crate::output::AppResult;
use crate::store::LibraryStore;

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
        .path
        .parent()
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
                && !(matches!(destination.kind, DestinationKind::Generic)
                    && !destination.has_koreader())
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
    let mut source = std::fs::File::open(&format.source_path).map_err(|_| unavailable())?;
    if !source.metadata().map_err(|_| unavailable())?.is_file() {
        return Err(unavailable());
    }
    source.read(&mut [0u8; 1]).map_err(|_| unavailable())?;
    let ready = ReadyFile {
        format: format.format,
        source_path: format.source_path.clone(),
    };
    let file_name = destinations::destination_file_name(
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
