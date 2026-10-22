//! `LibraryState`: the single source of truth every view observes.
//!
//! Holds the current result set, selection, query, filters, sort, and the
//! section (Library or Trash). All engine traffic goes through here so views
//! stay declarative. Every async reply carries the `generation` it was issued
//! under; stale replies are dropped.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use gpui::{Context, Entity, Task};
use takio::destinations::Destination;
use takio::model::LibraryItem;
use takio::output::AppResult;

use crate::engine::{Engine, Facets, Filters, ImportMode, Request};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Library,
    Trash,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortColumn {
    Title,
    Author,
    Series,
    Added,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sort {
    pub column: SortColumn,
    pub ascending: bool,
}

impl Default for Sort {
    fn default() -> Self {
        Self {
            column: SortColumn::Title,
            ascending: true,
        }
    }
}

/// A transient message surfaced in the status bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub is_error: bool,
}

pub struct LibraryState {
    engine: Engine,
    pub section: Section,
    pub items: Vec<LibraryItem>,
    pub facets: Facets,
    pub selected: BTreeSet<usize>,
    pub anchor: Option<usize>,
    pub query: String,
    pub filters: Filters,
    pub sort: Sort,
    pub loading: bool,
    pub status: Option<Status>,
    pub destinations: Vec<Destination>,
    generation: u64,
    pending: Option<Task<()>>,
    debounce: Option<Task<()>>,
}

impl LibraryState {
    pub fn new(engine: Engine, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            engine,
            section: Section::Library,
            items: Vec::new(),
            facets: Facets::default(),
            selected: BTreeSet::new(),
            anchor: None,
            query: String::new(),
            filters: Filters::default(),
            sort: Sort::default(),
            loading: false,
            status: None,
            destinations: Vec::new(),
            generation: 0,
            pending: None,
            debounce: None,
        };
        this.reload(cx);
        this.refresh_destinations(cx);
        this
    }

    pub fn selected_items(&self) -> Vec<&LibraryItem> {
        self.selected
            .iter()
            .filter_map(|index| self.items.get(*index))
            .collect()
    }

    pub fn selected_ids(&self) -> Vec<String> {
        self.selected_items()
            .into_iter()
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn primary_selected(&self) -> Option<&LibraryItem> {
        self.anchor
            .or_else(|| self.selected.iter().next().copied())
            .and_then(|index| self.items.get(index))
    }

    // ----- queries ---------------------------------------------------------

    /// Issue a fresh query for the current section, query text, and filters.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        self.loading = true;
        let receiver = match self.section {
            Section::Library => {
                let query = self.query.clone();
                let filters = self.filters.clone();
                self.engine.request(|reply| Request::Query {
                    query,
                    filters,
                    reply,
                })
            }
            Section::Trash => self.engine.request(|reply| Request::ListTrash { reply }),
        };
        self.pending = Some(self.await_reply(receiver, cx, move |this, result, cx| {
            if this.generation != generation {
                return;
            }
            this.loading = false;
            match result {
                Ok(mut items) => {
                    sort_items(&mut items, this.sort);
                    this.facets = Facets::from_items(&items);
                    this.reconcile_selection(&items);
                    this.items = items;
                }
                Err(error) => this.set_error(error.code(), cx),
            }
            cx.notify();
        }));
        cx.notify();
    }

    /// Update the query text and reload after a short debounce so fast
    /// typing issues one engine request, not one per keystroke.
    pub fn set_query(&mut self, query: String, cx: &mut Context<Self>) {
        if self.query == query {
            return;
        }
        self.query = query;
        self.debounce = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(60))
                .await;
            let _ = this.update(cx, |this, cx| this.reload(cx));
        }));
        cx.notify();
    }

    pub fn set_section(&mut self, section: Section, cx: &mut Context<Self>) {
        if self.section == section {
            return;
        }
        self.section = section;
        self.clear_selection();
        self.reload(cx);
    }

    pub fn set_sort(&mut self, column: SortColumn, cx: &mut Context<Self>) {
        if self.sort.column == column {
            self.sort.ascending = !self.sort.ascending;
        } else {
            self.sort = Sort {
                column,
                ascending: true,
            };
        }
        let selected_ids = self.selected_ids();
        sort_items(&mut self.items, self.sort);
        self.select_ids(&selected_ids);
        cx.notify();
    }

    pub fn toggle_filter(
        &mut self,
        dimension: FilterDimension,
        value: &str,
        cx: &mut Context<Self>,
    ) {
        let list = match dimension {
            FilterDimension::Author => &mut self.filters.authors,
            FilterDimension::Tag => &mut self.filters.tags,
            FilterDimension::Series => &mut self.filters.series,
            FilterDimension::Language => &mut self.filters.languages,
            FilterDimension::Format => &mut self.filters.formats,
        };
        let lower = value.to_lowercase();
        if let Some(position) = list.iter().position(|existing| *existing == lower) {
            list.remove(position);
        } else {
            list.push(lower);
        }
        self.reload(cx);
    }

    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        if self.filters.is_empty() {
            return;
        }
        self.filters = Filters::default();
        self.reload(cx);
    }

    // ----- selection -------------------------------------------------------

    pub fn clear_selection(&mut self) {
        self.selected.clear();
        self.anchor = None;
    }

    pub fn select_only(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selected.clear();
        if index < self.items.len() {
            self.selected.insert(index);
            self.anchor = Some(index);
        }
        cx.notify();
    }

    pub fn toggle_select(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.items.len() {
            return;
        }
        if !self.selected.remove(&index) {
            self.selected.insert(index);
        }
        self.anchor = Some(index);
        cx.notify();
    }

    pub fn select_range_to(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.items.len() {
            return;
        }
        let anchor = self.anchor.unwrap_or(index);
        let (low, high) = if anchor <= index {
            (anchor, index)
        } else {
            (index, anchor)
        };
        self.selected.extend(low..=high);
        cx.notify();
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selected = (0..self.items.len()).collect();
        cx.notify();
    }

    /// Move the anchor by `delta` rows, clamped, replacing the selection.
    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.items.is_empty() {
            return;
        }
        let current = self.anchor.unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, self.items.len() as isize - 1) as usize;
        self.select_only(next, cx);
    }

    fn select_ids(&mut self, ids: &[String]) {
        self.selected = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| ids.contains(&item.id))
            .map(|(index, _)| index)
            .collect();
        self.anchor = self.selected.iter().next().copied();
    }

    fn reconcile_selection(&mut self, new_items: &[LibraryItem]) {
        let ids = self.selected_ids();
        self.selected = new_items
            .iter()
            .enumerate()
            .filter(|(_, item)| ids.contains(&item.id))
            .map(|(index, _)| index)
            .collect();
        self.anchor = self
            .anchor
            .filter(|index| self.selected.contains(index))
            .or_else(|| self.selected.iter().next().copied());
    }

    // ----- mutations -------------------------------------------------------

    pub fn import(&mut self, roots: Vec<PathBuf>, mode: ImportMode, cx: &mut Context<Self>) {
        if roots.is_empty() {
            return;
        }
        let count = roots.len();
        self.set_status(format!("Importing {count} item(s)..."), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Import { roots, mode, reply });
        self.pending = Some(self.await_reply(receiver, cx, |this, result, cx| {
            match result {
                Ok(scan) => {
                    let counts = scan.counts;
                    this.set_status(
                        format!(
                            "Imported {}, skipped {}, failed {}",
                            counts.imported, counts.skipped, counts.failed
                        ),
                        counts.failed > 0,
                        cx,
                    );
                }
                Err(error) => this.set_error(error.code(), cx),
            }
            this.reload(cx);
        }));
    }

    pub fn trash_selected(&mut self, cx: &mut Context<Self>) {
        self.mutate_selected(
            |ids, reply| Request::Trash { ids, reply },
            "Moved to Trash",
            cx,
        );
    }

    pub fn restore_selected(&mut self, cx: &mut Context<Self>) {
        self.mutate_selected(|ids, reply| Request::Restore { ids, reply }, "Restored", cx);
    }

    pub fn purge_selected(&mut self, cx: &mut Context<Self>) {
        self.mutate_selected(
            |ids, reply| Request::Purge { ids, reply },
            "Deleted permanently",
            cx,
        );
    }

    fn mutate_selected(
        &mut self,
        build: impl FnOnce(Vec<String>, std::sync::mpsc::Sender<AppResult<Vec<LibraryItem>>>) -> Request,
        verb: &'static str,
        cx: &mut Context<Self>,
    ) {
        let ids = self.selected_ids();
        if ids.is_empty() {
            return;
        }
        let count = ids.len();
        let receiver = self.engine.request(|reply| build(ids, reply));
        self.pending = Some(self.await_reply(receiver, cx, move |this, result, cx| {
            match result {
                Ok(_) => this.set_status(format!("{verb} {count} item(s)"), false, cx),
                Err(error) => this.set_error(error.code(), cx),
            }
            this.reload(cx);
        }));
    }

    pub fn refresh_destinations(&mut self, cx: &mut Context<Self>) {
        let volumes_root = PathBuf::from("/Volumes");
        let receiver = self.engine.request(|reply| Request::ListDestinations {
            volumes_root,
            reply,
        });
        self.await_reply(receiver, cx, |this, result, cx| {
            if let Ok(destinations) = result {
                this.destinations = destinations;
                cx.notify();
            }
        })
        .detach();
    }

    pub fn send_selected_to(&mut self, destination: Destination, cx: &mut Context<Self>) {
        let Some(item) = self.primary_selected() else {
            return;
        };
        let item_id = item.id.clone();
        let name = destination.name.clone();
        let receiver = self.engine.request(|reply| Request::Send {
            destination,
            item_id,
            reply,
        });
        self.pending = Some(
            self.await_reply(receiver, cx, move |this, result, cx| match result {
                Ok(_) => this.set_status(format!("Sent to {name}"), false, cx),
                Err(error) => this.set_error(error.code(), cx),
            }),
        );
    }

    pub fn eject(&mut self, destination: Destination, cx: &mut Context<Self>) {
        let name = destination.name.clone();
        let receiver = self
            .engine
            .request(|reply| Request::Eject { destination, reply });
        self.pending = Some(self.await_reply(receiver, cx, move |this, result, cx| {
            match result {
                Ok(()) => this.set_status(format!("Ejected {name}"), false, cx),
                Err(error) => this.set_error(error.code(), cx),
            }
            this.refresh_destinations(cx);
        }));
    }

    // ----- status ----------------------------------------------------------

    pub fn set_status(&mut self, text: String, is_error: bool, cx: &mut Context<Self>) {
        self.status = Some(Status { text, is_error });
        cx.notify();
    }

    fn set_error(&mut self, code: &str, cx: &mut Context<Self>) {
        self.set_status(humanize_error(code), true, cx);
    }

    // ----- plumbing --------------------------------------------------------

    /// Wait for an engine reply off the main thread, then apply `handle`
    /// on the main thread. The receiver is polled on the background
    /// executor so a slow engine never blocks a frame.
    fn await_reply<T: Send + 'static>(
        &self,
        receiver: Receiver<T>,
        cx: &mut Context<Self>,
        handle: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) -> Task<()> {
        cx.spawn(async move |this: gpui::WeakEntity<Self>, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { receiver.recv().ok() })
                .await;
            if let Some(value) = result {
                let _ = this.update(cx, |this, cx| handle(this, value, cx));
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterDimension {
    Author,
    Tag,
    Series,
    Language,
    Format,
}

pub fn author_label(item: &LibraryItem) -> String {
    if !item.authors.is_empty() {
        return item
            .authors
            .iter()
            .map(|author| author.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
    }
    item.author.clone().unwrap_or_default()
}

fn sort_items(items: &mut [LibraryItem], sort: Sort) {
    let key = |item: &LibraryItem| -> String {
        match sort.column {
            SortColumn::Title => item.title.to_lowercase(),
            SortColumn::Author => author_label(item).to_lowercase(),
            SortColumn::Series => item
                .series
                .as_deref()
                .map(str::to_lowercase)
                .unwrap_or_default(),
            SortColumn::Added => item.added_at.clone(),
        }
    };
    items.sort_by_cached_key(key);
    if !sort.ascending {
        items.reverse();
    }
}

fn humanize_error(code: &str) -> String {
    match code {
        "storage-unavailable" => "The library could not be read".into(),
        "unsupported-format" => "That file format is not supported".into(),
        "not-found" | "item-not-found" => "That book is no longer in the library".into(),
        "destination-unavailable" => "The device is not available".into(),
        "destination-file-exists" => "A file with that name already exists on the device".into(),
        "format-not-found" => "That book has no file to send".into(),
        "eject-failed" => "The device could not be ejected".into(),
        other => format!("Something went wrong ({other})"),
    }
}

/// Convenience alias so views can declare their dependency plainly.
pub type LibraryEntity = Entity<LibraryState>;
