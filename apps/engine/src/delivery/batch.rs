//! Reviewed multi-book delivery policy, independent of desktop presentation.
use super::destinations::{DeliveryResult, Destination};
use super::{DeliveryOptions, ReadyFile, plan_send, reauthorize, send_library_item};
use crate::error::AppResult;
use crate::library::{model::LibraryItem, store::LibraryStore};

/// Larger batches are rejected before any destination is modified.
pub const MAX_SEND_ITEMS: usize = 256;

/// Format/source readiness only, not a promise of delivery or collision avoidance.
#[derive(Clone, Debug)]
pub struct SendPreview {
    pub destination: Destination,
    pub entries: Vec<SendPreviewEntry>,
}

#[derive(Clone, Debug)]
pub struct SendPreviewEntry {
    pub item_id: String,
    /// Stored title, or the requested ID when the item could not be loaded.
    pub title: String,
    pub result: AppResult<ReadyFile>,
}

impl SendPreview {
    pub fn ready_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.result.is_ok())
            .map(|entry| entry.item_id.clone())
            .collect()
    }

    pub fn ready_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.result.is_ok())
            .count()
    }
}

/// One outcome per requested ID, in request order, including failures.
#[derive(Clone, Debug, Default)]
pub struct SendReport {
    pub entries: Vec<SendEntry>,
}

#[derive(Clone, Debug)]
pub struct SendEntry {
    pub item_id: String,
    pub title: String,
    pub result: AppResult<DeliveryResult>,
}

pub fn preview_send_many(
    store: &LibraryStore,
    destination: &Destination,
    item_ids: &[String],
) -> AppResult<SendPreview> {
    if item_ids.len() > MAX_SEND_ITEMS {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let destination = reauthorize(destination)?;
    let entries = item_ids
        .iter()
        .map(|id| {
            let item = store.get(id);
            let title = stored_title(&item, id);
            let result =
                item.and_then(|_| plan_send(store, &destination, id, None).map(|plan| plan.ready));
            SendPreviewEntry {
                item_id: id.clone(),
                title,
                result,
            }
        })
        .collect();
    Ok(SendPreview {
        destination,
        entries,
    })
}

pub fn send_reviewed_many(
    store: &LibraryStore,
    destination: &Destination,
    entries: &[SendPreviewEntry],
) -> AppResult<SendReport> {
    if entries.len() > MAX_SEND_ITEMS {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(SendReport {
        entries: entries
            .iter()
            .map(|entry| match &entry.result {
                Ok(ready) => {
                    let item = store.get(&entry.item_id);
                    let title = stored_title(&item, &entry.item_id);
                    let result = item.and_then(|_| {
                        send_library_item(
                            store,
                            destination,
                            &entry.item_id,
                            DeliveryOptions {
                                reviewed: Some(ready),
                                ..Default::default()
                            },
                        )
                    });
                    SendEntry {
                        item_id: entry.item_id.clone(),
                        title,
                        result,
                    }
                }
                Err(error) => SendEntry {
                    item_id: entry.item_id.clone(),
                    title: entry.title.clone(),
                    result: Err(error.clone()),
                },
            })
            .collect(),
    })
}

fn stored_title(item: &AppResult<Option<LibraryItem>>, id: &str) -> String {
    item.as_ref()
        .ok()
        .and_then(Option::as_ref)
        .map_or(id, |item| item.title.as_str())
        .to_owned()
}
