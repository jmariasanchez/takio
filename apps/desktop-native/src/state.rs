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
use takio::model::{LibraryItem, LibraryPatch};
use takio::output::{AppError, AppResult};

use crate::engine::{Engine, Facets, Filters, ImportMode, Request, SendReport};

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
    pub refreshing_devices: bool,
    pub device_error: Option<String>,
    pub busy: bool,
    pub metadata_editing: bool,
    pub saving_metadata: bool,
    pub metadata_save_result: Option<Result<String, String>>,
    pub delivery_report: Option<SendReport>,
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
            refreshing_devices: false,
            device_error: None,
            busy: false,
            metadata_editing: false,
            saving_metadata: false,
            metadata_save_result: None,
            delivery_report: None,
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
            .filter(|index| self.selected.contains(index))
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
        if self.metadata_editing {
            self.set_status(
                "Save or cancel your book details before switching sections".into(),
                false,
                cx,
            );
            return;
        }
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
        self.anchor = None;
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
        let primary_id = self.primary_selected().map(|item| item.id.clone());
        self.selected = new_items
            .iter()
            .enumerate()
            .filter(|(_, item)| ids.contains(&item.id))
            .map(|(index, _)| index)
            .collect();
        self.anchor = primary_id
            .and_then(|id| new_items.iter().position(|item| item.id == id))
            .filter(|index| self.selected.contains(index))
            .or_else(|| self.selected.iter().next().copied());
    }

    // ----- mutations -------------------------------------------------------

    pub fn import(&mut self, roots: Vec<PathBuf>, mode: ImportMode, cx: &mut Context<Self>) {
        if roots.is_empty() || !self.can_mutate() {
            return;
        }
        self.busy = true;
        let count = roots.len();
        self.set_status(format!("Importing {count} item(s)..."), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Import { roots, mode, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.busy = false;
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
        })
        .detach();
    }

    pub fn can_mutate(&self) -> bool {
        !self.busy && !self.metadata_editing && !self.loading
    }

    pub fn can_close(&mut self, cx: &mut Context<Self>) -> bool {
        if self.busy {
            self.set_status(
                "Wait for the current operation to finish before closing Takio".into(),
                true,
                cx,
            );
            return false;
        }
        if self.metadata_editing {
            self.set_status(
                "Save or cancel your book details before closing Takio".into(),
                true,
                cx,
            );
            return false;
        }
        true
    }

    pub fn update_metadata(&mut self, id: String, patch: LibraryPatch, cx: &mut Context<Self>) {
        if self.busy || self.section != Section::Library {
            self.metadata_save_result = Some(Err("Finish the current operation first".into()));
            cx.notify();
            return;
        }
        self.busy = true;
        self.saving_metadata = true;
        self.metadata_save_result = None;
        self.set_status("Saving book details...".into(), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Update { id, patch, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.busy = false;
            this.saving_metadata = false;
            match result {
                Ok(item) => {
                    this.metadata_save_result = Some(Ok(item.id));
                    this.set_status("Book details saved".into(), false, cx);
                    this.reload(cx);
                }
                Err(error) => {
                    this.metadata_save_result = Some(Err(humanize_error(error.code())));
                    this.set_error(error.code(), cx);
                }
            }
            cx.notify();
        })
        .detach();
    }

    pub fn trash_selected(&mut self, cx: &mut Context<Self>) {
        if self.section != Section::Library {
            return;
        }
        self.mutate_selected(
            |ids, reply| Request::Trash { ids, reply },
            "Moved to Trash",
            cx,
        );
    }

    pub fn restore_selected(&mut self, cx: &mut Context<Self>) {
        if self.section != Section::Trash {
            return;
        }
        self.mutate_selected(|ids, reply| Request::Restore { ids, reply }, "Restored", cx);
    }

    /// Called only with the IDs captured by the native confirmation dialog.
    pub fn purge_confirmed(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        if self.section != Section::Trash {
            return;
        }
        self.mutate_ids(
            ids,
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
        self.mutate_ids(ids, build, verb, cx);
    }

    fn mutate_ids(
        &mut self,
        ids: Vec<String>,
        build: impl FnOnce(Vec<String>, std::sync::mpsc::Sender<AppResult<Vec<LibraryItem>>>) -> Request,
        verb: &'static str,
        cx: &mut Context<Self>,
    ) {
        if ids.is_empty() || !self.can_mutate() {
            return;
        }
        self.busy = true;
        let count = ids.len();
        self.set_status("Updating library...".into(), false, cx);
        let receiver = self.engine.request(|reply| build(ids, reply));
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(_) => this.set_status(format!("{verb} {count} item(s)"), false, cx),
                Err(error) => this.set_error(error.code(), cx),
            }
            this.reload(cx);
        })
        .detach();
    }

    pub fn refresh_destinations(&mut self, cx: &mut Context<Self>) {
        if self.refreshing_devices || self.busy {
            return;
        }
        self.refreshing_devices = true;
        self.device_error = None;
        let volumes_root = PathBuf::from("/Volumes");
        let receiver = self.engine.request(|reply| Request::ListDestinations {
            volumes_root,
            reply,
        });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.refreshing_devices = false;
            match result {
                Ok(destinations) => this.destinations = destinations,
                Err(error) => {
                    this.destinations.clear();
                    this.device_error = Some(humanize_error(error.code()));
                }
            }
            cx.notify();
        })
        .detach();
        cx.notify();
    }

    pub fn send_selected_to(&mut self, destination: Destination, cx: &mut Context<Self>) {
        self.send_ids_to(destination, self.selected_ids(), cx);
    }

    pub fn send_ids_to(
        &mut self,
        destination: Destination,
        item_ids: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        if self.section != Section::Library || !self.can_mutate() {
            return;
        }
        if item_ids.is_empty() {
            return;
        }
        if item_ids.len() > crate::engine::MAX_SEND_ITEMS {
            self.set_status(
                format!(
                    "Select at most {} books per send",
                    crate::engine::MAX_SEND_ITEMS
                ),
                true,
                cx,
            );
            return;
        }
        self.busy = true;
        self.delivery_report = None;
        let name = destination.name.clone();
        self.set_status(
            format!("Sending {} book(s) to {name}...", item_ids.len()),
            false,
            cx,
        );
        let receiver = self.engine.request(|reply| Request::SendMany {
            destination,
            item_ids,
            reply,
        });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(report) => {
                    let sent = report
                        .entries
                        .iter()
                        .filter(|entry| entry.result.is_ok())
                        .count();
                    let failed = report.entries.len() - sent;
                    this.set_status(
                        format!("Sent {sent} to {name}, {failed} failed"),
                        failed > 0,
                        cx,
                    );
                    this.delivery_report = Some(report);
                }
                Err(error) => this.set_error(error.code(), cx),
            }
            cx.notify();
        })
        .detach();
    }

    pub fn eject(&mut self, destination: Destination, cx: &mut Context<Self>) {
        if !self.can_mutate() {
            return;
        }
        self.busy = true;
        let name = destination.name.clone();
        self.set_status(format!("Ejecting {name}..."), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Eject { destination, reply });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(()) => this.set_status(format!("Ejected {name}"), false, cx),
                Err(error) => this.set_error(error.code(), cx),
            }
            this.refresh_destinations(cx);
        })
        .detach();
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
        receiver: Receiver<AppResult<T>>,
        cx: &mut Context<Self>,
        handle: impl FnOnce(&mut Self, AppResult<T>, &mut Context<Self>) + 'static,
    ) -> Task<()> {
        cx.spawn(async move |this: gpui::WeakEntity<Self>, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    receiver
                        .recv()
                        .unwrap_or_else(|_| Err(AppError::new("storage-unavailable")))
                })
                .await;
            let _ = this.update(cx, |this, cx| handle(this, result, cx));
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

pub fn humanize_error(code: &str) -> String {
    match code {
        "storage-unavailable" => "The library could not be read".into(),
        "unsupported-format" => "That file format is not supported".into(),
        "not-found" | "item-not-found" => "That book is no longer in the library".into(),
        "destination-unavailable" => "The device is not available".into(),
        "destination-file-exists" => "A file with that name already exists on the device".into(),
        "format-not-found" => "That book has no file to send".into(),
        "no-compatible-format" | "destination-format-unsupported" => "No compatible file attached. Add an AZW3/PDF for a stock Kindle, or use Amazon's Send to Kindle for EPUB.".into(),
        "invalid-arguments" => "Check the book details and selection, then try again".into(),
        "eject-failed" => "The device could not be ejected".into(),
        other => format!("Something went wrong ({other})"),
    }
}

/// Convenience alias so views can declare their dependency plainly.
pub type LibraryEntity = Entity<LibraryState>;

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{AppContext, TestAppContext};
    use std::fs;
    use std::path::Path;
    use takio::paths::LibraryPaths;

    struct Fixture {
        _temp: tempfile::TempDir,
        state: Entity<LibraryState>,
    }

    fn epub(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{name}.epub"));
        fs::write(&path, format!("book {name}")).unwrap();
        path
    }

    /// Open a scratch library with three books and wait for the first load.
    fn fixture(cx: &mut TestAppContext) -> Fixture {
        // Engine replies arrive from a real OS thread, so the deterministic
        // executor must be allowed to park while it waits.
        cx.executor().allow_parking();
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let engine = Engine::open(paths).unwrap();
        let roots = vec![
            epub(temp.path(), "Beta"),
            epub(temp.path(), "Alpha"),
            epub(temp.path(), "Gamma"),
        ];
        engine
            .request(|reply| Request::Import {
                roots,
                mode: ImportMode::Copy,
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        let state = cx.new(|cx| LibraryState::new(engine, cx));
        settle(&state, cx);
        Fixture { _temp: temp, state }
    }

    /// Drive the executor until the state is no longer loading.
    fn settle(state: &Entity<LibraryState>, cx: &mut TestAppContext) {
        for _ in 0..200 {
            cx.run_until_parked();
            if !state.read_with(cx, |state, _| state.loading || state.busy) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("state never finished loading");
    }

    fn titles(state: &Entity<LibraryState>, cx: &mut TestAppContext) -> Vec<String> {
        state.read_with(cx, |state, _| {
            state.items.iter().map(|item| item.title.clone()).collect()
        })
    }

    #[gpui::test]
    fn initial_load_sorts_by_title(cx: &mut TestAppContext) {
        let f = fixture(cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        assert!(f.state.read_with(cx, |s, _| s.selected.is_empty()));
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.facets.formats.get("epub").copied()),
            Some(3)
        );
    }

    #[gpui::test]
    fn selection_modes(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(1, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.selected_ids().len()), 1);
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.primary_selected().unwrap().title.clone()),
            "Beta"
        );

        f.state.update(cx, |s, cx| s.toggle_select(2, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.selected.len()), 2);
        f.state.update(cx, |s, cx| s.toggle_select(2, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.selected.len()), 1);

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.select_range_to(2, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.selected.len()), 3);

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.move_selection(5, cx));
        assert_eq!(
            f.state.read_with(cx, |s, _| s.anchor),
            Some(2),
            "clamped at end"
        );
        f.state.update(cx, |s, cx| s.move_selection(-10, cx));
        assert_eq!(
            f.state.read_with(cx, |s, _| s.anchor),
            Some(0),
            "clamped at start"
        );

        f.state.update(cx, |s, cx| s.select_all(cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.selected.len()), 3);
        f.state.update(cx, |s, _| s.clear_selection());
        assert!(f.state.read_with(cx, |s, _| s.selected.is_empty()));
    }

    #[gpui::test]
    fn sort_toggles_direction_and_keeps_selection(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state
            .update(cx, |s, cx| s.set_sort(SortColumn::Title, cx));
        assert_eq!(titles(&f.state, cx), ["Gamma", "Beta", "Alpha"]);
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.primary_selected().unwrap().title.clone()),
            "Alpha",
            "selection follows the item, not the row index"
        );
        f.state
            .update(cx, |s, cx| s.set_sort(SortColumn::Author, cx));
        assert!(
            f.state.read_with(cx, |s, _| s.sort.ascending),
            "new column starts ascending"
        );
    }

    #[gpui::test]
    fn query_is_debounced_and_filters(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.set_query("a".into(), cx));
        f.state.update(cx, |s, cx| s.set_query("al".into(), cx));
        f.state.update(cx, |s, cx| s.set_query("alp".into(), cx));
        // Before the debounce timer fires nothing has been requested.
        assert_eq!(titles(&f.state, cx).len(), 3);
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha"]);

        f.state.update(cx, |s, cx| s.set_query(String::new(), cx));
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx).len(), 3);
    }

    #[gpui::test]
    fn facet_filter_round_trip(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.toggle_filter(FilterDimension::Format, "EPUB", cx)
        });
        settle(&f.state, cx);
        assert_eq!(
            f.state.read_with(cx, |s, _| s.filters.formats.clone()),
            ["epub"],
            "lowercased"
        );
        assert_eq!(titles(&f.state, cx).len(), 3);

        // Values within one dimension are ORed (epub OR pdf), matching the
        // CLI and the facet semantics users expect; dimensions AND together.
        f.state.update(cx, |s, cx| {
            s.toggle_filter(FilterDimension::Format, "pdf", cx)
        });
        settle(&f.state, cx);
        assert_eq!(
            titles(&f.state, cx).len(),
            3,
            "epub OR pdf still matches every book"
        );
        f.state.update(cx, |s, cx| {
            s.toggle_filter(FilterDimension::Author, "nobody", cx)
        });
        settle(&f.state, cx);
        assert_eq!(
            titles(&f.state, cx).len(),
            0,
            "format AND author narrows to nothing"
        );

        f.state.update(cx, |s, cx| s.clear_filters(cx));
        settle(&f.state, cx);
        assert!(f.state.read_with(cx, |s, _| s.filters.is_empty()));
        assert_eq!(titles(&f.state, cx).len(), 3);
    }

    #[gpui::test]
    fn trash_restore_purge_through_sections(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(1, cx));
        f.state.update(cx, |s, cx| s.trash_selected(cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Gamma"]);
        assert!(
            f.state
                .read_with(cx, |s, _| s.status.as_ref().unwrap().text.contains("Trash"))
        );

        f.state
            .update(cx, |s, cx| s.set_section(Section::Trash, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta"]);
        assert!(
            f.state.read_with(cx, |s, _| s.selected.is_empty()),
            "section change clears selection"
        );

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.restore_selected(cx));
        settle(&f.state, cx);
        assert!(titles(&f.state, cx).is_empty());

        f.state
            .update(cx, |s, cx| s.set_section(Section::Library, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.trash_selected(cx));
        settle(&f.state, cx);
        f.state
            .update(cx, |s, cx| s.set_section(Section::Trash, cx));
        settle(&f.state, cx);
        f.state.update(cx, |s, cx| s.select_all(cx));
        f.state
            .update(cx, |s, cx| s.purge_confirmed(s.selected_ids(), cx));
        settle(&f.state, cx);
        assert!(titles(&f.state, cx).is_empty());
        f.state
            .update(cx, |s, cx| s.set_section(Section::Library, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta", "Gamma"]);
    }

    #[gpui::test]
    fn stale_replies_are_dropped(cx: &mut TestAppContext) {
        let f = fixture(cx);
        // Issue two reloads back to back. Only the newest generation may
        // land; the state must never flip to a result from the first.
        f.state.update(cx, |s, cx| {
            s.query = "zzz-no-match".into();
            s.reload(cx);
            s.query = String::new();
            s.reload(cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx).len(), 3);
    }

    #[gpui::test]
    fn import_reports_counts_and_reloads(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let extra = epub(f._temp.path(), "Delta");
        f.state
            .update(cx, |s, cx| s.import(vec![extra], ImportMode::Copy, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Delta", "Gamma"]);
        let status = f.state.read_with(cx, |s, _| s.status.clone().unwrap());
        assert!(status.text.starts_with("Imported 1"), "{}", status.text);
        assert!(!status.is_error);
    }

    #[gpui::test]
    fn error_codes_are_humanized(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state
            .update(cx, |s, cx| s.set_error("unsupported-format", cx));
        let status = f.state.read_with(cx, |s, _| s.status.clone().unwrap());
        assert!(status.is_error);
        assert!(
            !status.text.contains("unsupported-format"),
            "code must not leak verbatim"
        );
    }

    #[gpui::test]
    fn mutation_completion_survives_browsing_and_rejects_double_submit(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let extra = epub(f._temp.path(), "Delta");
        f.state.update(cx, |s, cx| {
            s.import(vec![extra.clone()], ImportMode::Copy, cx);
            assert!(s.busy);
            s.import(vec![extra], ImportMode::Copy, cx);
            s.reload(cx);
            s.set_section(Section::Trash, cx);
        });
        settle(&f.state, cx);
        assert!(f.state.read_with(cx, |s, _| {
            s.status.as_ref().unwrap().text.starts_with("Imported 1")
        }));
        f.state
            .update(cx, |s, cx| s.set_section(Section::Library, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Delta", "Gamma"]);
    }

    #[gpui::test]
    fn metadata_persists_and_reconciles_selection_after_sort(cx: &mut TestAppContext) {
        use takio::model::Patch;
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(0, cx));
        let id = f.state.read_with(cx, |s, _| s.selected_ids()[0].clone());
        f.state.update(cx, |s, cx| {
            s.update_metadata(
                id.clone(),
                LibraryPatch {
                    title: Patch::Set("Zulu".into()),
                    tags: Patch::Set(vec!["To read".into()]),
                    ..LibraryPatch::default()
                },
                cx,
            )
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta", "Gamma", "Zulu"]);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.primary_selected().unwrap().id, id);
            assert_eq!(s.metadata_save_result, Some(Ok(id.clone())));
            assert_eq!(s.facets.tags.get("To read"), Some(&1));
        });
        let paths =
            LibraryPaths::resolve(None, Some(&f._temp.path().join("library.sqlite"))).unwrap();
        let reopened = Engine::open(paths)
            .unwrap()
            .request(|reply| Request::Query {
                query: "Zulu".into(),
                filters: Filters::default(),
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].tags, ["To read"]);
        assert!(f._temp.path().join("Alpha.epub").exists());
    }

    #[gpui::test]
    fn editor_blocks_destructive_and_import_actions(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let extra = epub(f._temp.path(), "Delta");
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.metadata_editing = true;
            assert!(!s.can_close(cx));
            s.set_section(Section::Trash, cx);
            assert_eq!(s.section, Section::Library);
            s.trash_selected(cx);
            s.import(vec![extra], ImportMode::Copy, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        assert!(!f.state.read_with(cx, |s, _| s.busy));
    }

    #[gpui::test]
    fn deselected_anchor_is_never_an_action_target(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.toggle_select(0, cx);
        });
        assert!(f.state.read_with(cx, |s, _| s.primary_selected().is_none()));
    }

    #[gpui::test]
    fn purge_uses_confirmed_ids_not_changed_selection(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.trash_selected(cx);
        });
        settle(&f.state, cx);
        f.state
            .update(cx, |s, cx| s.set_section(Section::Trash, cx));
        settle(&f.state, cx);
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            let confirmed = s.selected_ids();
            s.select_only(1, cx);
            s.purge_confirmed(confirmed, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta", "Gamma"]);
        assert!(f._temp.path().join("Alpha.epub").exists());
    }

    #[gpui::test]
    fn multi_send_reports_each_book_and_survives_reload(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let pdf = f._temp.path().join("Readable.pdf");
        fs::write(&pdf, b"%PDF-1.4 native send test").unwrap();
        f.state.update(cx, |s, cx| {
            s.import(vec![pdf.clone()], ImportMode::Copy, cx)
        });
        settle(&f.state, cx);
        let volumes = f._temp.path().join("volumes");
        let device = volumes.join("Kindle");
        fs::create_dir_all(device.join("documents")).unwrap();
        fs::create_dir_all(device.join("system")).unwrap();
        let destination = takio::destinations::authorize(&device, &volumes).unwrap();
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.send_selected_to(destination.clone(), cx);
            assert!(!s.can_close(cx));
            s.send_selected_to(destination.clone(), cx);
            s.eject(destination.clone(), cx);
            s.reload(cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            let report = s.delivery_report.as_ref().unwrap();
            assert_eq!(report.entries.len(), 4);
            assert_eq!(
                report
                    .entries
                    .iter()
                    .filter(|entry| entry.result.is_ok())
                    .count(),
                1
            );
            assert!(
                s.status
                    .as_ref()
                    .unwrap()
                    .text
                    .contains("1 to Kindle, 3 failed")
            );
        });
        let inventory = takio::destinations::inventory(&destination).unwrap();
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].status, "present");
        assert!(pdf.exists());
    }
}
