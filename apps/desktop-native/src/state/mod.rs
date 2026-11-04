//! `LibraryState`: the single source of truth every view observes.
//!
//! Holds the current result set, selection, query, filters, sort, and the
//! section (Library or Trash). All engine traffic goes through here so views
//! stay declarative. Every async reply carries the `generation` it was issued
//! under; stale replies are dropped.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::time::Duration;

use gpui::{Context, Entity, Task};
use takio::destinations::Destination;
use takio::import_scan::ImportOutcome;
use takio::model::{LibraryItem, LibraryPatch};
use takio::output::{AppError, AppResult};

use crate::engine::{
    Engine, Facets, Filters, ImportMode, Request, SendPreview, SendPreviewEntry, SendReport,
};
use crate::preparation::PreparationPreview;

mod library;

mod activity;
mod automatic_backup;
use activity::{Activity, Operation};
mod generation;
mod session;
use generation::Generation;
pub use session::LibrarySession;

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

#[derive(Clone, Debug)]
pub struct RecoveryOutcome {
    pub path: PathBuf,
    pub summary: String,
    pub detail: String,
}

struct LibrarySnapshot {
    items: Vec<Arc<LibraryItem>>,
    facets: Arc<Facets>,
}

struct PendingQuery(Arc<AtomicBool>);

impl Drop for PendingQuery {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub struct LibraryState {
    session: LibrarySession,
    automatic_backup: crate::automatic_backup::Schedule,
    automatic_backup_timer: Option<Task<()>>,
    engine: Engine,
    library_root: PathBuf,
    library_epoch: u64,
    preference_path: Option<PathBuf>,
    destinations: Vec<Destination>,
    volumes_root: PathBuf,
    reader_scan_generation: Generation,
    /// Volume names seen at the last refresh, so polling only acts on a change.
    seen_volumes: Option<BTreeSet<String>>,
    volume_watch: Option<Task<()>>,
    refreshing_devices: bool,
    preparation_generation: Generation,
    send_preview_generation: Generation,
    generation: Generation,
}

// Views can read session data directly, but only state methods can mutate it.
// Deliberately no DerefMut implementation.
impl std::ops::Deref for LibraryState {
    type Target = LibrarySession;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl LibraryState {
    pub fn automatic_backup(&self) -> &crate::automatic_backup::Schedule {
        &self.automatic_backup
    }

    pub fn library_root(&self) -> PathBuf {
        self.library_root.clone()
    }

    pub fn library_epoch(&self) -> u64 {
        self.library_epoch
    }

    pub fn destinations(&self) -> &Vec<Destination> {
        &self.destinations
    }

    pub fn refreshing_devices(&self) -> bool {
        self.refreshing_devices
    }

    pub fn set_preference_path(&mut self, path: Option<PathBuf>) {
        self.preference_path = path;
    }

    #[cfg(test)]
    pub(crate) fn set_test_destinations(&mut self, destinations: Vec<Destination>) {
        self.destinations = destinations;
    }

    #[cfg(test)]
    pub(crate) fn set_test_volumes_root(&mut self, root: PathBuf) {
        self.volumes_root = root;
    }

    #[cfg(test)]
    pub(crate) fn set_test_automatic_backup_config(
        &mut self,
        config: crate::automatic_backup::Config,
    ) {
        self.automatic_backup.config = config;
    }

    #[cfg(test)]
    pub(crate) fn invalidate_test_library(&mut self) {
        self.library_epoch = self.library_epoch.wrapping_add(1);
    }

    pub fn new(engine: Engine, cx: &mut Context<Self>) -> Self {
        // Native tests must never discover or scan the user's mounted devices.
        let volumes_root = if cfg!(test) {
            engine.root().join("test-volumes")
        } else {
            PathBuf::from("/Volumes")
        };
        Self::new_with_volumes(engine, volumes_root, cx)
    }

    pub(crate) fn new_with_volumes(
        engine: Engine,
        volumes_root: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            session: LibrarySession::default(),
            automatic_backup: crate::automatic_backup::Schedule::default(),
            automatic_backup_timer: None,
            volumes_root,
            library_root: engine.root().to_path_buf(),
            library_epoch: 0,
            preference_path: None,
            engine,
            destinations: Vec::new(),
            reader_scan_generation: Generation::default(),
            seen_volumes: None,
            volume_watch: None,
            refreshing_devices: false,
            preparation_generation: Generation::default(),
            send_preview_generation: Generation::default(),
            generation: Generation::default(),
        };
        this.activate_library(this.library_root.clone(), cx);
        this.watch_volumes(cx);
        this
    }

    pub fn selected_items(&self) -> Vec<&LibraryItem> {
        self.session
            .selected
            .iter()
            .filter_map(|index| self.session.items.get(*index))
            .map(Arc::as_ref)
            .collect()
    }

    pub fn selected_ids(&self) -> Vec<String> {
        self.selected_items()
            .into_iter()
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn primary_selected(&self) -> Option<&LibraryItem> {
        self.session
            .anchor
            .filter(|index| self.session.selected.contains(index))
            .or_else(|| self.session.selected.iter().next().copied())
            .and_then(|index| self.session.items.get(index))
            .map(Arc::as_ref)
    }

    // ----- queries ---------------------------------------------------------

    /// Issue a fresh query for the current section, query text, and filters.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        self.session.debounce = None;
        self.generation.advance();
        let generation = self.generation;
        let sort = self.session.sort;
        self.session.loading = true;
        self.session.sorting = false;
        let task = match self.session.section {
            Section::Library => {
                let query = self.session.query.clone();
                let filters = self.session.filters.clone();
                let receiver = self.engine.request(|reply| Request::Query {
                    query,
                    filters,
                    reply,
                });
                cx.background_executor().spawn(async move {
                    let items = receiver
                        .recv()
                        .unwrap_or_else(|_| Err(takio::app_error!("storage-unavailable")))?;
                    Ok(build_snapshot(items, sort))
                })
            }
            Section::Trash => {
                let receiver = self.engine.request(|reply| Request::ListTrash { reply });
                cx.background_executor().spawn(async move {
                    let items = receiver
                        .recv()
                        .unwrap_or_else(|_| Err(takio::app_error!("storage-unavailable")))?;
                    Ok(build_snapshot(
                        items.into_iter().map(Arc::new).collect(),
                        sort,
                    ))
                })
            }
        };
        self.await_snapshot(task, generation, cx).detach();
        cx.notify();
    }

    /// Update the query text and coalesce same-frame edits before dispatch.
    /// Eight milliseconds leaves room in the 80ms target for query and rendering,
    /// unlike the former 60ms floor. Generation guards still block stale actions.
    pub fn set_query(&mut self, query: String, cx: &mut Context<Self>) {
        if self.switching_library() || self.session.query == query {
            return;
        }
        self.session.query = query;
        self.generation.advance();
        self.session.loading = true;
        self.session.sorting = false;
        // Queue the read after the input deadline without a foreground round trip.
        // A busy first paint can overlap the query instead of delaying its start.
        let cancelled = Arc::new(AtomicBool::new(false));
        self.session.debounce = Some(PendingQuery(cancelled.clone()));
        let engine = self.engine.clone();
        let section = self.session.section;
        let query = self.session.query.clone();
        let filters = self.session.filters.clone();
        let sort = self.session.sort;
        let generation = self.generation;
        let timer = cx.background_executor().timer(Duration::from_millis(8));
        let task = cx.background_executor().spawn(async move {
            timer.await;
            if cancelled.load(Ordering::Acquire) {
                return Err(takio::app_error!("query-cancelled"));
            }
            let items = match section {
                Section::Library => engine
                    .request(|reply| Request::Query {
                        query,
                        filters,
                        reply,
                    })
                    .recv()
                    .unwrap_or_else(|_| Err(takio::app_error!("storage-unavailable")))?,
                Section::Trash => engine
                    .request(|reply| Request::ListTrash { reply })
                    .recv()
                    .unwrap_or_else(|_| Err(takio::app_error!("storage-unavailable")))?
                    .into_iter()
                    .map(Arc::new)
                    .collect(),
            };
            Ok(build_snapshot(items, sort))
        });
        // Do not cancel a completed snapshot on the UI thread. Obsolete replies
        // retain await_snapshot's generation check and background disposal.
        self.await_snapshot(task, generation, cx).detach();
        cx.notify();
    }

    pub fn set_section(&mut self, section: Section, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        if self.session.metadata_editing {
            self.set_status(
                "Save or cancel your book details before switching sections".into(),
                false,
                cx,
            );
            return;
        }
        if self.session.section == section {
            return;
        }
        self.cancel_send_preview(cx);
        self.cancel_preparation(cx);
        self.session.section = section;
        self.clear_selection();
        self.reload(cx);
    }

    pub fn set_sort(&mut self, column: SortColumn, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        if self.session.sort.column == column {
            self.session.sort.ascending = !self.session.sort.ascending;
        } else {
            self.session.sort = Sort {
                column,
                ascending: true,
            };
        }
        if self.session.loading && !self.session.sorting {
            self.reload(cx);
            return;
        }
        self.generation.advance();
        self.session.loading = true;
        self.session.sorting = true;
        let generation = self.generation;
        let sort = self.session.sort;
        // Share book metadata while retaining the visible rows until sorting finishes.
        let mut items = self.session.items.clone();
        let facets = self.session.facets.clone();
        let task = cx.background_executor().spawn(async move {
            sort_items(&mut items, sort);
            Ok(LibrarySnapshot { items, facets })
        });
        self.await_snapshot(task, generation, cx).detach();
        cx.notify();
    }

    pub fn toggle_filter(
        &mut self,
        dimension: FilterDimension,
        value: &str,
        cx: &mut Context<Self>,
    ) {
        if self.switching_library() {
            return;
        }
        let list = match dimension {
            FilterDimension::Author => &mut self.session.filters.authors,
            FilterDimension::Tag => &mut self.session.filters.tags,
            FilterDimension::Series => &mut self.session.filters.series,
            FilterDimension::Language => &mut self.session.filters.languages,
            FilterDimension::Format => &mut self.session.filters.formats,
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
        if self.switching_library() || self.session.filters.is_empty() {
            return;
        }
        self.session.filters = Filters::default();
        self.reload(cx);
    }

    // ----- selection -------------------------------------------------------

    pub fn clear_selection(&mut self) {
        self.session.selected.clear();
        self.session.anchor = None;
    }

    pub fn select_only(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        self.session.selected.clear();
        self.session.anchor = None;
        if index < self.session.items.len() {
            self.session.selected.insert(index);
            self.session.anchor = Some(index);
        }
        cx.notify();
    }

    pub fn toggle_select(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        if index >= self.session.items.len() {
            return;
        }
        if !self.session.selected.remove(&index) {
            self.session.selected.insert(index);
        }
        self.session.anchor = Some(index);
        cx.notify();
    }

    pub fn select_range_to(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        if index >= self.session.items.len() {
            return;
        }
        let anchor = self.session.anchor.unwrap_or(index);
        let (low, high) = if anchor <= index {
            (anchor, index)
        } else {
            (index, anchor)
        };
        self.session.selected.extend(low..=high);
        cx.notify();
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        self.session.selected = (0..self.session.items.len()).collect();
        cx.notify();
    }

    pub fn primary_source_path(&self) -> Option<PathBuf> {
        self.primary_selected()
            .and_then(|item| item.formats.first())
            .map(|format| format.source_path.clone())
    }

    /// Move the anchor by `delta` rows, clamped, replacing the selection.
    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.switching_library() {
            return;
        }
        if self.session.items.is_empty() {
            return;
        }
        let next = self.session.anchor.map_or_else(
            || {
                if delta < 0 {
                    self.session.items.len() - 1
                } else {
                    0
                }
            },
            |current| {
                (current as isize + delta).clamp(0, self.session.items.len() as isize - 1) as usize
            },
        );
        self.select_only(next, cx);
    }

    fn reconcile_selection(&mut self, new_items: &[Arc<LibraryItem>]) {
        let ids: HashSet<&str> = self
            .selected
            .iter()
            .filter_map(|index| self.session.items.get(*index))
            .map(|item| item.id.as_str())
            .collect();
        let primary_id = self.primary_selected().map(|item| item.id.clone());
        self.session.selected = new_items
            .iter()
            .enumerate()
            .filter(|(_, item)| ids.contains(item.id.as_str()))
            .map(|(index, _)| index)
            .collect();
        self.session.anchor = primary_id
            .and_then(|id| new_items.iter().position(|item| item.id == id))
            .filter(|index| self.session.selected.contains(index))
            .or_else(|| self.session.selected.iter().next().copied());
    }

    // ----- mutations -------------------------------------------------------

    pub fn back_up_library(&mut self, destination: PathBuf, cx: &mut Context<Self>) {
        if !self.can_mutate() {
            self.set_status("Finish the current operation or save/cancel your edits, then choose Back Up Library again. No new backup was started.".into(), true, cx);
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        self.session.recovery_outcome = None;
        self.set_status("Copying and verifying library backup...".into(), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Backup { destination, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(report) => {
                    let summary = format!("Backup verified: {} managed format(s)", report.managed_files);
                    this.session.recovery_outcome = Some(RecoveryOutcome {
                        path: report.destination_path,
                        summary: summary.clone(),
                        detail: "Includes the catalogue, Trash and managed files. External referenced files and conversion jobs are not included. Keep a copy on a separate drive.".into(),
                    });
                    this.set_status(summary, false, cx);
                }
                Err(error) => this.set_status(humanize_recovery_error(error.kind()), true, cx),
            }
        }).detach();
    }

    pub fn restore_backup_copy(
        &mut self,
        source: PathBuf,
        destination: PathBuf,
        cx: &mut Context<Self>,
    ) {
        if !self.can_mutate() {
            self.set_status("Finish the current operation or save/cancel your edits, then choose Restore Backup again. No restore was started.".into(), true, cx);
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        self.session.recovery_outcome = None;
        self.set_status(
            "Restoring and verifying a separate library copy...".into(),
            false,
            cx,
        );
        let receiver = self.engine.request(|reply| Request::RestoreBackupCopy {
            source,
            destination,
            reply,
        });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(report) => {
                    let summary = format!("Restore verified: {} book(s), {} in Trash, {} managed format(s)",
                        report.report.active_items, report.report.trashed_items, report.report.verified_managed_formats);
                    this.session.recovery_outcome = Some(RecoveryOutcome {
                        path: report.database_path.parent().expect("restored database has a parent").to_path_buf(),
                        summary: summary.clone(),
                        detail: format!("Your current library is unchanged and still open. {} external reference(s) still need their original files. Conversion jobs are not restored.", report.report.referenced_formats),
                    });
                    this.set_status(summary, false, cx);
                }
                Err(error) => this.set_status(humanize_recovery_error(error.kind()), true, cx),
            }
        }).detach();
    }

    pub fn import(&mut self, roots: Vec<PathBuf>, mode: ImportMode, cx: &mut Context<Self>) {
        if roots.is_empty() || !self.can_mutate() {
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        let count = roots.len();
        self.set_status(format!("Importing {count} item(s)..."), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Import { roots, mode, reply });
        self.finish_import(receiver, cx);
    }

    pub fn import_from_reader(&mut self, destination: Destination, cx: &mut Context<Self>) {
        if self.session.section != Section::Library || !self.can_mutate() {
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        self.set_status(
            format!("Adding books from {}...", destination.name),
            false,
            cx,
        );
        let receiver = self
            .engine
            .request(|reply| Request::ImportFromReader { destination, reply });
        self.finish_import(receiver, cx);
    }

    fn finish_import(
        &mut self,
        receiver: Receiver<AppResult<takio::import_scan::ImportScan>>,
        cx: &mut Context<Self>,
    ) {
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(scan) => {
                    let counts = scan.counts;
                    let skipped_for = |wanted| scan.outcomes.iter().filter(|outcome| matches!(outcome, ImportOutcome::Skipped { reason, .. } if *reason == wanted)).count();
                    let documents = skipped_for("likely-document");
                    let mut skipped = match documents {
                        0 => counts.skipped.to_string(),
                        1 => format!("{} (1 short PDF looked like a document)", counts.skipped),
                        n => format!("{} ({n} short PDFs looked like documents)", counts.skipped),
                    };
                    let unsupported = skipped_for("unsupported-format");
                    if unsupported > 0 {
                        skipped.push_str(&format!(
                            " ({unsupported} in a format Takio cannot store, such as Kindle store books)"
                        ));
                    }
                    this.set_status(
                        format!(
                            "Imported {}, skipped {skipped}, failed {}",
                            counts.imported, counts.failed
                        ),
                        counts.failed > 0,
                        cx,
                    );
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
            this.reload(cx);
            this.scan_readers(cx);
        })
        .detach();
    }

    pub fn can_mutate(&self) -> bool {
        self.session.activity.is_idle() && !self.metadata_editing() && !self.session.loading
    }

    pub fn busy(&self) -> bool {
        self.session.activity.is_running()
    }

    #[cfg(test)]
    pub(crate) fn install_test_items(&mut self, items: Vec<Arc<LibraryItem>>) {
        self.session.items = items;
        self.clear_selection();
    }

    #[cfg(test)]
    pub(crate) fn simulate_busy(&mut self, busy: bool) {
        self.session.activity = if busy {
            Activity::Running(Operation::Mutation)
        } else {
            Activity::Idle
        };
    }

    pub fn switching_library(&self) -> bool {
        matches!(self.session.activity, Activity::SwitchingLibrary)
    }

    fn preparation_pending(&self) -> bool {
        self.session
            .activity
            .is_operation(Operation::PreviewingPreparation)
    }

    pub fn send_preview(&self) -> Option<&SendPreview> {
        self.session.activity.send_preview()
    }

    pub fn preparation_preview(&self) -> Option<&PreparationPreview> {
        self.session.activity.preparation_preview()
    }

    pub fn can_close(&mut self, cx: &mut Context<Self>) -> bool {
        if self.busy() || self.switching_library() {
            self.set_status(
                "Wait for the current operation to finish before closing Takio".into(),
                true,
                cx,
            );
            return false;
        }
        if self.session.metadata_editing {
            self.set_status(
                "Save or cancel your book details before closing Takio".into(),
                true,
                cx,
            );
            return false;
        }
        true
    }

    pub fn recovery_outcome(&self) -> &Option<RecoveryOutcome> {
        &self.session.recovery_outcome
    }

    pub fn delivery_report(&self) -> &Option<SendReport> {
        &self.session.delivery_report
    }

    pub fn automatic_backup_prompt_open(&self) -> bool {
        self.session.automatic_backup_prompt_open
    }

    pub fn metadata_editing(&self) -> bool {
        self.session.metadata_editing
    }

    pub fn saving_metadata(&self) -> bool {
        self.session
            .activity
            .is_operation(Operation::SavingMetadata)
    }

    pub fn metadata_save_result(&self) -> &Option<AppResult<String>> {
        &self.session.metadata_save_result
    }

    pub fn dismiss_recovery_outcome(&mut self, cx: &mut Context<Self>) {
        self.session.recovery_outcome = None;
        cx.notify();
    }

    pub fn dismiss_delivery_report(&mut self, cx: &mut Context<Self>) {
        self.session.delivery_report = None;
        self.session.delivery_exclusions.clear();
        cx.notify();
    }

    pub fn set_automatic_backup_prompt(&mut self, open: bool, cx: &mut Context<Self>) {
        self.session.automatic_backup_prompt_open = open;
        cx.notify();
    }

    pub fn begin_metadata_editing(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.can_mutate() || self.session.section != Section::Library {
            return false;
        }
        self.session.metadata_save_result = None;
        self.session.metadata_editing = true;
        cx.notify();
        true
    }

    pub fn end_metadata_editing(&mut self, cx: &mut Context<Self>) -> bool {
        if self.saving_metadata() {
            return false;
        }
        self.session.metadata_editing = false;
        cx.notify();
        true
    }

    pub fn update_metadata(&mut self, id: String, patch: LibraryPatch, cx: &mut Context<Self>) {
        if !self.session.activity.is_idle()
            || self.session.loading
            || self.session.section != Section::Library
        {
            self.session.metadata_save_result =
                Some(Err(takio::app_error!("operation-in-progress")));
            cx.notify();
            return;
        }
        self.session.activity = Activity::Running(Operation::SavingMetadata);
        self.session.metadata_save_result = None;
        self.set_status("Saving book details...".into(), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Update { id, patch, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(item) => {
                    this.session.metadata_save_result = Some(Ok(item.id));
                    this.set_status("Book details saved".into(), false, cx);
                    this.reload(cx);
                }
                Err(error) => {
                    this.set_error(error.kind(), cx);
                    this.session.metadata_save_result = Some(Err(error));
                }
            }
            cx.notify();
        })
        .detach();
    }

    pub fn trash_selected(&mut self, cx: &mut Context<Self>) {
        if self.session.section != Section::Library {
            return;
        }
        self.mutate_selected(
            |ids, reply| Request::Trash { ids, reply },
            "Moved to Trash",
            cx,
        );
    }

    pub fn restore_selected(&mut self, cx: &mut Context<Self>) {
        if self.session.section != Section::Trash {
            return;
        }
        self.mutate_selected(|ids, reply| Request::Restore { ids, reply }, "Restored", cx);
    }

    /// Called only with the IDs captured by the native confirmation dialog.
    pub fn purge_confirmed(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        if self.session.section != Section::Trash {
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
        build: impl FnOnce(
            Vec<String>,
            std::sync::mpsc::Sender<AppResult<crate::engine::MutationReport>>,
        ) -> Request,
        verb: &'static str,
        cx: &mut Context<Self>,
    ) {
        let ids = self.selected_ids();
        self.mutate_ids(ids, build, verb, cx);
    }

    fn mutate_ids(
        &mut self,
        ids: Vec<String>,
        build: impl FnOnce(
            Vec<String>,
            std::sync::mpsc::Sender<AppResult<crate::engine::MutationReport>>,
        ) -> Request,
        verb: &'static str,
        cx: &mut Context<Self>,
    ) {
        if ids.is_empty() || !self.can_mutate() {
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        let count = ids.len();
        self.set_status("Updating library...".into(), false, cx);
        let receiver = self.engine.request(|reply| build(ids, reply));
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(report) => {
                    let changed = report.iter().filter(|(_, result)| result.is_ok()).count();
                    let failures = report
                        .iter()
                        .filter_map(|(id, result)| {
                            result
                                .as_ref()
                                .err()
                                .map(|error| format!("{id}: {}", humanize_error(error.kind())))
                        })
                        .collect::<Vec<_>>();
                    let mut detail = if failures.is_empty() {
                        String::new()
                    } else {
                        format!(". Failed: {}", failures.join("; "))
                    };
                    let pending = report
                        .iter()
                        .filter_map(|(id, result)| {
                            result
                                .as_ref()
                                .ok()
                                .filter(|result| result.cleanup_pending)
                                .map(|result| {
                                    format!(
                                        "{id}: {}",
                                        result
                                            .cleanup_pending_paths
                                            .iter()
                                            .map(|path| path.display().to_string())
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    )
                                })
                        })
                        .collect::<Vec<_>>();
                    if !pending.is_empty() {
                        detail.push_str(&format!(
                            ". Catalogue updated, but file cleanup is pending: {}",
                            pending.join("; ")
                        ));
                    }
                    this.set_status(
                        format!("{verb} {changed} of {count} item(s){detail}"),
                        !failures.is_empty() || !pending.is_empty(),
                        cx,
                    );
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
            this.reload(cx);
            this.scan_readers(cx);
        })
        .detach();
    }

    /// Read-only scans never hold the mutation lock. Each new request invalidates
    /// the old marks immediately and only its own reply may repopulate them.
    pub fn scan_readers(&mut self, cx: &mut Context<Self>) {
        self.clear_reader_shelves();
        let destinations: Vec<_> = self
            .destinations
            .iter()
            .filter(|destination| {
                !matches!(
                    destination.kind,
                    takio::destinations::DestinationKind::Generic
                )
            })
            .cloned()
            .collect();
        if destinations.is_empty() {
            cx.notify();
            return;
        }
        self.session.scanning_readers = true;
        let generation = self.reader_scan_generation;
        let failed_destinations = destinations.clone();
        let receiver = self.engine.request(|reply| Request::ScanReaderShelves {
            destinations,
            reply,
        });
        self.await_reader_scan(receiver, generation, failed_destinations, cx);
        cx.notify();
    }

    fn await_reader_scan(
        &self,
        receiver: Receiver<AppResult<crate::engine::ReaderShelves>>,
        generation: Generation,
        failed_destinations: Vec<Destination>,
        cx: &mut Context<Self>,
    ) {
        self.await_reply(receiver, cx, move |this, result, cx| {
            if generation != this.reader_scan_generation {
                return;
            }
            this.session.scanning_readers = false;
            this.session.reader_shelves = match result {
                Ok(shelves) => shelves,
                Err(error) => failed_destinations
                    .into_iter()
                    .map(|destination| (destination, Err(error.clone())))
                    .collect(),
            };
            for (destination, shelf) in &this.session.reader_shelves {
                if let Ok(shelf) = shelf {
                    for id in shelf.item_ids() {
                        this.session
                            .on_reader
                            .entry(id.to_owned())
                            .or_default()
                            .push(destination.label());
                        if let Some(reading) = shelf.reading_for(id) {
                            this.session
                                .reading
                                .entry(id.to_owned())
                                .or_insert_with(|| (destination.label(), reading.clone()));
                        }
                    }
                }
            }
            cx.notify();
        })
        .detach();
        cx.notify();
    }

    fn clear_reader_shelves(&mut self) {
        self.reader_scan_generation.advance();
        self.session.scanning_readers = false;
        self.session.reader_shelves.clear();
        self.session.on_reader.clear();
        self.session.reading.clear();
    }

    pub fn refresh_destinations(&mut self, cx: &mut Context<Self>) {
        if self.refreshing_devices || self.busy() {
            return;
        }
        self.refreshing_devices = true;
        self.clear_reader_shelves();
        self.session.device_error = None;
        let volumes_root = self.volumes_root.clone();
        self.seen_volumes = Some(mounted_volume_names(&volumes_root));
        let receiver = self.engine.request(|reply| Request::ListDestinations {
            volumes_root,
            reply,
        });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.refreshing_devices = false;
            match result {
                Ok(destinations) => {
                    this.destinations = destinations;
                    this.scan_readers(cx);
                }
                Err(error) => {
                    this.destinations.clear();
                    this.session.device_error = Some(error);
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

    /// Notice readers being connected or unplugged while the app is open. Only the
    /// names under the volumes root are listed each tick; a refresh (and reader scan)
    /// runs only when that set changed, and waits while an operation or review is open.
    fn watch_volumes(&mut self, cx: &mut Context<Self>) {
        self.volume_watch = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(VOLUME_POLL).await;
                let Ok(root) = this.read_with(cx, |this, _| this.volumes_root.clone()) else {
                    return;
                };
                let names = cx
                    .background_executor()
                    .spawn(async move { mounted_volume_names(&root) })
                    .await;
                let updated = this.update(cx, |this, cx| {
                    let changed = this.seen_volumes.as_ref() != Some(&names);
                    if changed && this.can_auto_refresh() {
                        this.refresh_destinations(cx);
                    }
                });
                if updated.is_err() {
                    return;
                }
            }
        }));
    }

    /// A detected change is applied only between operations so it never cancels a
    /// review or races a send, import or library switch. The next tick retries.
    fn can_auto_refresh(&self) -> bool {
        !self.refreshing_devices && self.session.activity.is_idle()
    }

    pub fn send_ids_to(
        &mut self,
        destination: Destination,
        item_ids: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        if self.session.section != Section::Library || !self.can_mutate() {
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
        self.session.activity = Activity::Running(Operation::Mutation);
        self.session.delivery_report = None;
        self.session.delivery_exclusions.clear();
        self.send_preview_generation.advance();
        let generation = self.send_preview_generation;
        self.set_status(
            format!(
                "Checking {} book(s) for {}...",
                item_ids.len(),
                destination.name
            ),
            false,
            cx,
        );
        let receiver = self.engine.request(|reply| Request::PreviewSend {
            destination,
            item_ids,
            reply,
        });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            if this.send_preview_generation != generation || this.session.section != Section::Library {
                this.set_status("Send review cancelled. Nothing was sent.".into(), false, cx);
                return;
            }
            match result {
                Ok(preview) => {
                    let ready = preview.ready_count();
                    let blocked = preview.entries.len() - ready;
                    this.session.activity = Activity::ReviewingSend(preview);
                    this.set_status(format!("Review send: {ready} ready, {blocked} need attention. Nothing sent yet."), false, cx);
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
        }).detach();
    }

    pub fn cancel_send_preview(&mut self, cx: &mut Context<Self>) {
        self.send_preview_generation.advance();
        if matches!(self.session.activity, Activity::ReviewingSend(_)) {
            self.session.activity = Activity::Idle;
            self.set_status("Send review cancelled. Nothing was sent.".into(), false, cx);
        }
    }

    pub fn confirm_send_preview(&mut self, cx: &mut Context<Self>) {
        if self.session.loading
            || self.session.metadata_editing
            || self.session.section != Section::Library
        {
            return;
        }
        let Some(preview) = self.send_preview() else {
            return;
        };
        if preview.ready_count() == 0 {
            return;
        }
        let Activity::ReviewingSend(preview) = std::mem::take(&mut self.session.activity) else {
            unreachable!("checked send review")
        };
        let (ready, excluded) = preview
            .entries
            .into_iter()
            .partition(|entry| entry.result.is_ok());
        self.session.delivery_exclusions = excluded;
        self.deliver_reviewed(preview.destination, ready, cx);
    }

    fn deliver_reviewed(
        &mut self,
        destination: Destination,
        entries: Vec<SendPreviewEntry>,
        cx: &mut Context<Self>,
    ) {
        self.session.activity = Activity::Running(Operation::Mutation);
        self.session.delivery_report = None;
        let excluded = self.session.delivery_exclusions.len();
        let name = destination.name.clone();
        self.set_status(
            format!("Sending {} book(s) to {name}...", entries.len()),
            false,
            cx,
        );
        let receiver = self.engine.request(|reply| Request::SendReviewed {
            destination,
            entries,
            reply,
        });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(report) => {
                    let sent = report
                        .entries
                        .iter()
                        .filter(|entry| entry.result.is_ok())
                        .count();
                    let failed = report.entries.len() - sent;
                    let unrecorded = report
                        .entries
                        .iter()
                        .filter(|entry| {
                            entry
                                .result
                                .as_ref()
                                .is_ok_and(|delivery| delivery.record_error.is_some())
                        })
                        .count();
                    let warning = if unrecorded == 0 {
                        String::new()
                    } else {
                        format!(". {unrecorded} delivered, but history was not updated")
                    };
                    this.set_status(
                        format!(
                            "Sent {sent} to {name}, {failed} failed, {excluded} not sent{warning}"
                        ),
                        failed > 0 || unrecorded > 0,
                        cx,
                    );
                    this.session.delivery_report = Some(report);
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
            this.scan_readers(cx);
            cx.notify();
        })
        .detach();
    }

    pub fn eject(&mut self, destination: Destination, cx: &mut Context<Self>) {
        if !self.can_mutate() {
            return;
        }
        self.session.activity = Activity::Running(Operation::Mutation);
        let name = destination.name.clone();
        self.set_status(format!("Ejecting {name}..."), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::Eject { destination, reply });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(()) => this.set_status(format!("Ejected {name}"), false, cx),
                Err(error) => this.set_error(error.kind(), cx),
            }
            this.refresh_destinations(cx);
        })
        .detach();
    }

    // ----- explicit local preparation -------------------------------------

    pub fn prepare_selected(&mut self, cx: &mut Context<Self>) {
        if !self.can_mutate() || self.session.section != Section::Library {
            return;
        }
        let ids = self.selected_ids();
        if ids.len() != 1 {
            self.set_status("Select one book to prepare an AZW3 copy".into(), true, cx);
            return;
        }
        self.prepare_item(ids[0].clone(), cx);
    }

    pub fn prepare_item(&mut self, item_id: String, cx: &mut Context<Self>) {
        if !self.can_mutate() || self.session.section != Section::Library {
            return;
        }
        self.session.activity = Activity::Running(Operation::PreviewingPreparation);
        self.session.delivery_report = None;
        self.session.delivery_exclusions.clear();
        self.preparation_generation.advance();
        let generation = self.preparation_generation;
        self.set_status(
            "Checking EPUB and local conversion backend...".into(),
            false,
            cx,
        );
        let receiver = self
            .engine
            .request(|reply| Request::PreviewPrepare { item_id, reply });
        self.await_reply(receiver, cx, move |this, result, cx| {
            this.session.activity = Activity::Idle;
            if this.preparation_generation != generation || this.session.section != Section::Library
            {
                this.set_status(
                    "Preparation cancelled. No copy was prepared.".into(),
                    false,
                    cx,
                );
                return;
            }
            match result {
                Ok(preview) => {
                    let available = preview.backend.available;
                    this.session.activity = Activity::ReviewingPreparation(preview);
                    if available {
                        this.set_status(
                            "Review AZW3 preparation. The EPUB will be kept. Nothing sent.".into(),
                            false,
                            cx,
                        );
                    } else {
                        this.set_error(takio::error::ErrorCode::BackendUnavailable, cx);
                    }
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
        })
        .detach();
    }

    pub fn cancel_preparation(&mut self, cx: &mut Context<Self>) {
        // A running conversion cannot be cancelled by dismissing its review.
        if self.preparation_pending() || self.preparation_preview().is_some() {
            self.preparation_generation.advance();
            if matches!(self.session.activity, Activity::ReviewingPreparation(_)) {
                self.session.activity = Activity::Idle;
            }
            self.set_status(
                "Preparation cancelled. No copy was prepared.".into(),
                false,
                cx,
            );
        }
    }

    pub fn confirm_preparation(&mut self, cx: &mut Context<Self>) {
        if self.session.loading
            || self.session.metadata_editing
            || self.session.section != Section::Library
        {
            return;
        }
        let Some(preview) = self.preparation_preview() else {
            return;
        };
        if !preview.backend.available {
            self.set_error(takio::error::ErrorCode::BackendUnavailable, cx);
            return;
        }
        let Activity::ReviewingPreparation(preview) = std::mem::take(&mut self.session.activity)
        else {
            unreachable!("checked preparation review")
        };
        self.session.activity = Activity::Running(Operation::Mutation);
        self.set_status("Preparing an AZW3 copy locally (120-second conversion limit). EPUB kept. Nothing sent.".into(), false, cx);
        let receiver = self
            .engine
            .request(|reply| Request::PrepareReviewed { preview, reply });
        self.await_reply(receiver, cx, |this, result, cx| {
            this.session.activity = Activity::Idle;
            match result {
                Ok(_) => {
                    this.set_status(
                        "AZW3 prepared. EPUB kept. Review send when ready.".into(),
                        false,
                        cx,
                    );
                    this.reload(cx);
                }
                Err(error) => this.set_error(error.kind(), cx),
            }
        })
        .detach();
    }

    // ----- status ----------------------------------------------------------

    pub fn set_status(&mut self, text: String, is_error: bool, cx: &mut Context<Self>) {
        self.session.status = Some(Status { text, is_error });
        cx.notify();
    }

    fn set_error(&mut self, code: takio::error::ErrorCode, cx: &mut Context<Self>) {
        self.set_status(humanize_error(code), true, cx);
    }

    // ----- plumbing --------------------------------------------------------

    fn await_snapshot(
        &self,
        task: Task<AppResult<LibrarySnapshot>>,
        generation: Generation,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            // Let obsolete waiters finish so cancellation cannot destroy a completed
            // catalogue on the foreground executor before this cleanup runs.
            let mut result = Some(task.await);
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.session.loading = false;
                this.session.sorting = false;
                match result.take().expect("snapshot handled once") {
                    Ok(snapshot) => {
                        this.reconcile_selection(&snapshot.items);
                        let old_items = std::mem::replace(&mut this.session.items, snapshot.items);
                        let old_facets =
                            std::mem::replace(&mut this.session.facets, snapshot.facets);
                        // Releasing a whole catalogue can also be expensive.
                        cx.background_executor()
                            .spawn(async move { drop((old_items, old_facets)) })
                            .detach();
                    }
                    Err(error) => this.set_error(error.kind(), cx),
                }
                cx.notify();
            });
            if let Some(result) = result {
                cx.background_executor()
                    .spawn(async move { drop(result) })
                    .detach();
            }
        })
    }

    /// Wait for an engine reply off the main thread, then apply `handle`
    /// on the main thread. The receiver is polled on the background
    /// executor so a slow engine never blocks a frame.
    fn await_reply<T: Send + 'static>(
        &self,
        receiver: Receiver<AppResult<T>>,
        cx: &mut Context<Self>,
        handle: impl FnOnce(&mut Self, AppResult<T>, &mut Context<Self>) + 'static,
    ) -> Task<()> {
        let epoch = self.library_epoch;
        cx.spawn(async move |this: gpui::WeakEntity<Self>, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    receiver
                        .recv()
                        .unwrap_or_else(|_| Err(takio::app_error!("storage-unavailable")))
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.library_epoch == epoch {
                    handle(this, result, cx);
                }
            });
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

/// How often the app checks whether a reader was connected or unplugged.
const VOLUME_POLL: Duration = Duration::from_secs(2);

/// Names directly under the volumes root. Unreadable roots yield an empty set.
fn mounted_volume_names(root: &std::path::Path) -> BTreeSet<String> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

pub fn author_label(item: &LibraryItem) -> String {
    item.author_names().collect::<Vec<_>>().join(", ")
}

fn build_snapshot(mut items: Vec<Arc<LibraryItem>>, sort: Sort) -> LibrarySnapshot {
    let facets = Arc::new(Facets::from_item_refs(items.iter().map(Arc::as_ref)));
    sort_items(&mut items, sort);
    LibrarySnapshot { items, facets }
}

fn sort_items(items: &mut [Arc<LibraryItem>], sort: Sort) {
    use takio::library_query::{SortField, sort_key};
    let field = match sort.column {
        SortColumn::Title => SortField::Title,
        SortColumn::Author => SortField::Author,
        SortColumn::Series => SortField::Series,
        SortColumn::Added => SortField::AddedAt,
    };
    items.sort_by_cached_key(|item| sort_key(item, field));
    if !sort.ascending {
        items.reverse();
    }
}

mod errors;
pub use errors::humanize_error;
use errors::{humanize_recovery_error, open_library_error};

/// Convenience alias so views can declare their dependency plainly.
pub type LibraryEntity = Entity<LibraryState>;

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{AppContext, TestAppContext};
    use std::fs;
    use std::path::Path;
    use takio::paths::LibraryPaths;

    mod automatic_backup;
    mod library;
    mod preparation;
    mod reader_shelf;
    mod recovery;

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

    use crate::test_support::settle;

    fn titles(state: &Entity<LibraryState>, cx: &mut TestAppContext) -> Vec<String> {
        state.read_with(cx, |state, _| {
            state
                .session
                .items
                .iter()
                .map(|item| item.title.clone())
                .collect()
        })
    }

    #[gpui::test]
    fn initial_load_sorts_by_title(cx: &mut TestAppContext) {
        let f = fixture(cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        assert!(f.state.read_with(cx, |s, _| s.session.selected.is_empty()));
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.session.facets.formats.get("epub").copied()),
            Some(3)
        );
    }

    #[gpui::test]
    fn metadata_editing_lifecycle_guards_entry_and_pending_save(cx: &mut TestAppContext) {
        let f = fixture(cx);
        settle(&f.state, cx);
        f.state.update(cx, |state, cx| {
            state.session.metadata_save_result =
                Some(Err(takio::app_error!("metadata-unavailable")));
            assert!(state.begin_metadata_editing(cx));
            assert!(state.session.metadata_save_result.is_none());
            assert!(!state.can_mutate());
            assert!(!state.begin_metadata_editing(cx));
            state.session.activity = Activity::Running(Operation::SavingMetadata);
            assert!(!state.end_metadata_editing(cx));
            assert!(state.session.metadata_editing);
            state.session.activity = Activity::Idle;
            assert!(state.end_metadata_editing(cx));
            assert!(state.can_mutate());
            state.session.loading = true;
            assert!(!state.begin_metadata_editing(cx));
            state.session.loading = false;
            state.session.section = Section::Trash;
            assert!(!state.begin_metadata_editing(cx));
        });
    }

    #[gpui::test]
    fn exclusive_activity_guards_metadata_and_review_dispatch(cx: &mut TestAppContext) {
        let f = fixture(cx);
        settle(&f.state, cx);
        let requests = preparation::preparation_channel(&f, cx);
        f.state.update(cx, |state, cx| {
            let item = state.session.items[0].clone();
            let destination = Destination {
                id: "unused".into(),
                name: "unused".into(),
                path: "/unused".into(),
                kind: takio::destinations::DestinationKind::Generic,
                features: Vec::new(),
            };
            let activities = [
                Activity::Running(Operation::Mutation),
                Activity::Running(Operation::SavingMetadata),
                Activity::Running(Operation::PreviewingPreparation),
                Activity::SwitchingLibrary,
                Activity::ReviewingSend(SendPreview {
                    destination,
                    entries: Vec::new(),
                }),
                Activity::ReviewingPreparation(preparation::preparation_review(&item, false)),
            ];
            for activity in activities {
                let running = activity.is_running();
                state.session.activity = activity;
                assert!(!state.can_mutate());
                assert_eq!(state.can_close(cx), !running);
                state.update_metadata(item.id.clone(), LibraryPatch::default(), cx);
                assert_eq!(
                    state
                        .metadata_save_result
                        .as_ref()
                        .unwrap()
                        .as_ref()
                        .unwrap_err()
                        .code(),
                    "operation-in-progress"
                );
                state.confirm_send_preview(cx);
                state.confirm_preparation(cx);
                assert!(requests.try_recv().is_err());
            }
            state.session.activity = Activity::Idle;
            state.session.loading = true;
            state.update_metadata(item.id.clone(), LibraryPatch::default(), cx);
            assert!(requests.try_recv().is_err());
            state.session.loading = false;
            assert!(state.can_mutate());
        });
    }

    #[gpui::test]
    fn navigation_without_anchor_selects_boundary_row(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.move_selection(1, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.session.anchor), Some(0));
        f.state.update(cx, |s, cx| {
            s.clear_selection();
            s.move_selection(-1, cx);
        });
        assert_eq!(f.state.read_with(cx, |s, _| s.session.anchor), Some(2));
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
        assert_eq!(f.state.read_with(cx, |s, _| s.session.selected.len()), 2);
        f.state.update(cx, |s, cx| s.toggle_select(2, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.session.selected.len()), 1);

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.select_range_to(2, cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.session.selected.len()), 3);

        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state.update(cx, |s, cx| s.move_selection(5, cx));
        assert_eq!(
            f.state.read_with(cx, |s, _| s.session.anchor),
            Some(2),
            "clamped at end"
        );
        f.state.update(cx, |s, cx| s.move_selection(-10, cx));
        assert_eq!(
            f.state.read_with(cx, |s, _| s.session.anchor),
            Some(0),
            "clamped at start"
        );

        f.state.update(cx, |s, cx| s.select_all(cx));
        assert_eq!(f.state.read_with(cx, |s, _| s.session.selected.len()), 3);
        f.state.update(cx, |s, _| s.clear_selection());
        assert!(f.state.read_with(cx, |s, _| s.session.selected.is_empty()));
    }

    #[gpui::test]
    fn sort_toggles_direction_and_keeps_selection(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(0, cx));
        f.state
            .update(cx, |s, cx| s.set_sort(SortColumn::Title, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Gamma", "Beta", "Alpha"]);
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.primary_selected().unwrap().title.clone()),
            "Alpha",
            "selection follows the item, not the row index"
        );
        f.state
            .update(cx, |s, cx| s.set_sort(SortColumn::Author, cx));
        settle(&f.state, cx);
        assert!(
            f.state.read_with(cx, |s, _| s.session.sort.ascending),
            "new column starts ascending"
        );
    }

    #[gpui::test]
    fn query_is_debounced_and_filters(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.set_query("a".into(), cx));
        f.state.update(cx, |s, cx| s.set_query("al".into(), cx));
        f.state.update(cx, |s, cx| s.set_query("alp".into(), cx));
        // Same-frame edits are coalesced. No request is dispatched before 8ms.
        let generation = f.state.read_with(cx, |s, _| s.generation);
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(7));
        cx.run_until_parked();
        assert_eq!(f.state.read_with(cx, |s, _| s.generation), generation);
        assert!(
            f.state
                .read_with(cx, |s, _| s.session.loading && !s.can_mutate())
        );
        assert_eq!(titles(&f.state, cx).len(), 3);
        cx.executor().advance_clock(Duration::from_millis(1));
        settle(&f.state, cx);
        assert_eq!(f.state.read_with(cx, |s, _| s.generation), generation);
        assert_eq!(titles(&f.state, cx), ["Alpha"]);

        f.state.update(cx, |s, cx| s.set_query(String::new(), cx));
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx).len(), 3);
    }

    #[gpui::test]
    fn background_debounce_sends_only_latest_query_after_deadline(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let item = f.state.read_with(cx, |s, _| s.session.items[0].clone());
        let (engine, requests) = Engine::test_channel();
        f.state.update(cx, |s, _| s.engine = engine);
        let received = Arc::new(AtomicBool::new(false));
        let observed = received.clone();
        let responder = std::thread::spawn(move || {
            match requests.recv_timeout(Duration::from_secs(2)).unwrap() {
                Request::Query { query, reply, .. } => {
                    assert_eq!(query, "Alpha");
                    observed.store(true, Ordering::Release);
                    reply.send(Ok(vec![item])).unwrap();
                }
                _ => panic!("expected the latest debounced query"),
            }
            assert!(matches!(
                requests.recv_timeout(Duration::from_millis(20)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
        });
        f.state.update(cx, |s, cx| {
            s.set_query("A".into(), cx);
            s.set_query("Al".into(), cx);
            s.set_query("Alpha".into(), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(7));
        cx.run_until_parked();
        assert!(!received.load(Ordering::Acquire));
        assert!(
            f.state
                .read_with(cx, |s, _| s.session.loading && !s.can_mutate())
        );
        cx.executor().advance_clock(Duration::from_millis(1));
        settle(&f.state, cx);
        responder.join().unwrap();
        assert_eq!(titles(&f.state, cx), ["Alpha"]);
        assert!(!f.state.read_with(cx, |s, _| {
            s.session
                .status
                .as_ref()
                .is_some_and(|status| status.is_error)
        }));
    }

    #[gpui::test]
    fn debounce_deadline_starts_before_foreground_task_is_polled(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.set_query("Alpha".into(), cx));
        let generation = f.state.read_with(cx, |s, _| s.generation);
        // Deliberately do not poll the foreground task until the input deadline.
        cx.executor().advance_clock(Duration::from_millis(8));
        cx.run_until_parked();
        assert_eq!(f.state.read_with(cx, |s, _| s.generation), generation);
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha"]);
    }

    #[gpui::test]
    fn searches_share_unchanged_records_but_refresh_after_mutation(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let initial = f.state.read_with(cx, |s, _| s.session.items[0].clone());
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.set_query("Alpha".into(), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.session.items.len(), 1);
            assert!(Arc::ptr_eq(&initial, &s.session.items[0]));
            assert_eq!(s.selected_ids(), vec![initial.id.clone()]);
        });
        let engine = f.state.read_with(cx, |s, _| s.engine.clone());
        engine
            .request(|reply| Request::Update {
                id: initial.id.clone(),
                patch: LibraryPatch {
                    title: takio::model::Patch::Set("Alpha revised".into()),
                    ..LibraryPatch::default()
                },
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        f.state.update(cx, |s, cx| s.reload(cx));
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.session.items[0].title, "Alpha revised");
            assert!(!Arc::ptr_eq(&initial, &s.session.items[0]));
            assert_eq!(initial.title, "Alpha");
            assert_eq!(s.selected_ids(), vec![initial.id.clone()]);
        });
    }

    #[gpui::test]
    fn author_display_and_sort_use_shared_structured_author_policy(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let mut first = f.state.read_with(cx, |s, _| (*s.items[0]).clone());
        first.author = Some("Legacy".into());
        first.authors = vec![
            takio::model::BookAuthor {
                name: "Same".into(),
                sort_name: None,
            },
            takio::model::BookAuthor {
                name: "Zulu".into(),
                sort_name: None,
            },
        ];
        assert_eq!(author_label(&first), "Same, Zulu");
        let mut second = first.clone();
        second.authors[1].name = "Alpha".into();
        let mut items = vec![Arc::new(first.clone()), Arc::new(second)];
        sort_items(
            &mut items,
            Sort {
                column: SortColumn::Author,
                ascending: true,
            },
        );
        assert_eq!(
            author_label(&items[0]),
            "Same, Zulu",
            "secondary names must not override the shared primary-author key"
        );
        first.authors.clear();
        assert_eq!(author_label(&first), "Legacy");
        first.author = None;
        assert_eq!(author_label(&first), "");
    }

    #[gpui::test]
    fn sorting_retains_visible_rows_and_uses_latest_selection(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let original = f.state.read_with(cx, |s, _| s.session.items[0].clone());
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.set_sort(SortColumn::Title, cx);
            assert!(s.session.loading);
            assert!(!s.can_mutate());
            assert!(Arc::ptr_eq(&s.session.items[0], &original));
            assert_eq!(s.session.items[0].title, "Alpha");
            s.select_only(2, cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.primary_selected().unwrap().title, "Gamma");
            assert_eq!(s.session.anchor, Some(0));
            assert!(Arc::ptr_eq(&s.session.items[2], &original));
            assert!(s.can_mutate());
        });
    }

    #[gpui::test]
    fn rapid_sort_search_and_section_changes_only_land_latest_snapshot(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.set_sort(SortColumn::Title, cx);
            s.set_query("Alpha".into(), cx);
            s.set_sort(SortColumn::Author, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha"]);
        let generation = f.state.read_with(cx, |s, _| s.generation);
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(f.state.read_with(cx, |s, _| s.generation), generation);
        f.state.update(cx, |s, cx| {
            s.set_sort(SortColumn::Title, cx);
            s.set_section(Section::Trash, cx);
        });
        settle(&f.state, cx);
        assert!(titles(&f.state, cx).is_empty());
        f.state.update(cx, |s, cx| {
            s.set_query(String::new(), cx);
            s.set_section(Section::Library, cx);
            s.set_sort(SortColumn::Title, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Gamma", "Beta", "Alpha"]);
    }

    #[gpui::test]
    fn rapid_sorts_do_not_requery_the_loaded_catalogue(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let (engine, id) = f
            .state
            .read_with(cx, |s, _| (s.engine.clone(), s.session.items[1].id.clone()));
        engine
            .request(|reply| Request::Trash {
                ids: vec![id],
                reply,
            })
            .recv()
            .unwrap()
            .unwrap();
        f.state.update(cx, |s, cx| {
            s.set_sort(SortColumn::Title, cx);
            s.set_sort(SortColumn::Title, cx);
            s.set_sort(SortColumn::Title, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Gamma", "Beta", "Alpha"]);
        f.state.update(cx, |s, cx| s.reload(cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Gamma", "Alpha"]);
    }

    #[gpui::test]
    fn completed_snapshot_superseded_before_application_does_not_end_loading(
        cx: &mut TestAppContext,
    ) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            let ready = Task::ready(Ok(LibrarySnapshot {
                items: vec![s.session.items[0].clone()],
                facets: s.session.facets.clone(),
            }));
            s.await_snapshot(ready, s.generation, cx).detach();
            s.set_query("Beta".into(), cx);
        });
        cx.run_until_parked();
        assert!(f.state.read_with(cx, |s, _| s.session.loading));
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta"]);
    }

    #[gpui::test]
    fn ten_thousand_selected_rows_keep_primary_book_when_sorted(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            let template = s.session.items[0].as_ref();
            s.session.items = (0..10_000)
                .map(|index| {
                    let mut item = template.clone();
                    item.id = format!("book-{index:05}");
                    item.title = item.id.clone();
                    Arc::new(item)
                })
                .collect();
            s.select_all(cx);
            s.session.anchor = Some(7_000);
            s.set_sort(SortColumn::Title, cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.session.selected.len(), 10_000);
            assert_eq!(s.primary_selected().unwrap().id, "book-07000");
            assert_eq!(s.session.anchor, Some(2_999));
            assert_eq!(s.session.items[0].id, "book-09999");
        });
    }

    #[gpui::test]
    fn filtered_selection_keeps_survivors_then_clears_missing_primary(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.session.anchor = Some(2);
            s.set_query("Alpha".into(), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert_eq!(s.session.selected.len(), 1);
            assert_eq!(s.primary_selected().unwrap().title, "Alpha");
        });
        f.state
            .update(cx, |s, cx| s.set_query("missing-book".into(), cx));
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert!(s.session.selected.is_empty());
            assert_eq!(s.session.anchor, None);
            assert!(s.primary_selected().is_none());
        });
    }

    #[gpui::test]
    fn debounce_immediately_blocks_actions_on_stale_results(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            let generation = s.generation;
            s.set_query("Alpha".into(), cx);
            assert_ne!(s.generation, generation);
            assert!(s.session.loading);
            assert!(!s.can_mutate());
            s.trash_selected(cx);
            assert!(!s.busy());
        });
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha"]);
        f.state.update(cx, |s, cx| s.set_query(String::new(), cx));
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
    }

    #[gpui::test]
    fn facet_filter_round_trip(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.toggle_filter(FilterDimension::Format, "EPUB", cx)
        });
        settle(&f.state, cx);
        assert_eq!(
            f.state
                .read_with(cx, |s, _| s.session.filters.formats.clone()),
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
        assert!(f.state.read_with(cx, |s, _| s.session.filters.is_empty()));
        assert_eq!(titles(&f.state, cx).len(), 3);
    }

    #[gpui::test]
    fn trash_restore_purge_through_sections(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| s.select_only(1, cx));
        f.state.update(cx, |s, cx| s.trash_selected(cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Gamma"]);
        assert!(f.state.read_with(cx, |s, _| {
            s.session.status.as_ref().unwrap().text.contains("Trash")
        }));

        f.state
            .update(cx, |s, cx| s.set_section(Section::Trash, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Beta"]);
        assert!(
            f.state.read_with(cx, |s, _| s.session.selected.is_empty()),
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
            s.session.query = "zzz-no-match".into();
            s.reload(cx);
            s.session.query = String::new();
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
        let status = f
            .state
            .read_with(cx, |s, _| s.session.status.clone().unwrap());
        assert!(status.text.starts_with("Imported 1"), "{}", status.text);
        assert!(!status.is_error);
    }

    #[gpui::test]
    fn folder_import_names_skipped_documents(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let folder = f._temp.path().join("Downloads");
        std::fs::create_dir(&folder).unwrap();
        epub(&folder, "Delta");
        let bill = b"%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%%EOF\n";
        std::fs::write(folder.join("bill.pdf"), bill).unwrap();
        f.state.update(cx, |s, cx| {
            s.import(vec![folder.clone()], ImportMode::Copy, cx)
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Delta", "Gamma"]);
        let status = f
            .state
            .read_with(cx, |s, _| s.session.status.clone().unwrap());
        assert_eq!(
            status.text,
            "Imported 1, skipped 1 (1 short PDF looked like a document), failed 0"
        );
        assert_eq!(std::fs::read(folder.join("bill.pdf")).unwrap(), bill);
    }

    #[gpui::test]
    fn error_codes_are_humanized(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |s, cx| {
            s.set_error(takio::error::ErrorCode::UnsupportedFormat, cx)
        });
        let status = f
            .state
            .read_with(cx, |s, _| s.session.status.clone().unwrap());
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
            assert!(s.busy());
            s.import(vec![extra], ImportMode::Copy, cx);
            s.reload(cx);
            s.set_section(Section::Trash, cx);
        });
        settle(&f.state, cx);
        assert!(f.state.read_with(cx, |s, _| {
            s.session
                .status
                .as_ref()
                .unwrap()
                .text
                .starts_with("Imported 1")
        }));
        f.state
            .update(cx, |s, cx| s.set_section(Section::Library, cx));
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Delta", "Gamma"]);
    }

    #[gpui::test]
    fn purge_reports_committed_catalogue_change_and_pending_cleanup(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let item = f.state.read_with(cx, |s, _| s.session.items[0].clone());
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.trash_selected(cx);
        });
        settle(&f.state, cx);
        f.state
            .update(cx, |s, cx| s.set_section(Section::Trash, cx));
        settle(&f.state, cx);
        fs::write(&item.source_path, b"externally changed bytes").unwrap();
        f.state
            .update(cx, |s, cx| s.purge_confirmed(vec![item.id.clone()], cx));
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert!(s.session.items.is_empty());
            let status = s.session.status.as_ref().unwrap();
            assert!(status.is_error);
            assert!(status.text.contains("1 of 1 item(s)"));
            assert!(status.text.contains("file cleanup is pending"));
            assert!(
                status
                    .text
                    .contains(&item.source_path.display().to_string())
            );
        });
        assert_eq!(
            fs::read(&item.source_path).unwrap(),
            b"externally changed bytes"
        );
    }

    #[gpui::test]
    fn partial_mutation_failures_warn_and_reload_committed_changes(cx: &mut TestAppContext) {
        for operation in ["trash", "restore", "purge"] {
            let f = fixture(cx);
            let (first, last) = f.state.read_with(cx, |s, _| {
                (s.session.items[0].clone(), s.session.items[2].clone())
            });
            if operation != "trash" {
                f.state.update(cx, |s, cx| {
                    s.select_all(cx);
                    s.trash_selected(cx);
                });
                settle(&f.state, cx);
                f.state
                    .update(cx, |s, cx| s.set_section(Section::Trash, cx));
                settle(&f.state, cx);
            }
            f.state.update(cx, |s, cx| {
                s.mutate_ids(
                    vec![first.id.clone(), "absent-item".into(), last.id.clone()],
                    |ids, reply| match operation {
                        "trash" => Request::Trash { ids, reply },
                        "restore" => Request::Restore { ids, reply },
                        _ => Request::Purge { ids, reply },
                    },
                    "Updated",
                    cx,
                );
            });
            settle(&f.state, cx);
            assert_eq!(titles(&f.state, cx), ["Beta"], "{operation}");
            f.state.read_with(cx, |s, _| {
                let status = s.session.status.as_ref().unwrap();
                assert!(status.is_error);
                assert!(status.text.contains("Updated 2 of 3 item(s)"));
                assert!(status.text.contains("absent-item"));
                assert!(!s.busy());
            });
            assert!(f._temp.path().join("Alpha.epub").exists());
            assert_eq!(last.source_path.exists(), operation != "purge");
            if operation == "purge" {
                assert!(!first.source_path.exists());
            } else {
                assert!(first.source_path.exists());
                f.state.update(cx, |s, cx| {
                    s.set_section(
                        if operation == "trash" {
                            Section::Trash
                        } else {
                            Section::Library
                        },
                        cx,
                    );
                });
                settle(&f.state, cx);
                assert_eq!(titles(&f.state, cx), ["Alpha", "Gamma"], "{operation}");
            }
        }
    }

    #[gpui::test]
    fn disconnected_send_reports_reconnect_guidance_without_recreating_reader(
        cx: &mut TestAppContext,
    ) {
        let f = fixture(cx);
        let volumes = f._temp.path().join("volumes");
        let mount = volumes.join("Kindle");
        fs::create_dir_all(mount.join("documents")).unwrap();
        fs::create_dir_all(mount.join("system")).unwrap();
        let destination = takio::destinations::authorize(&mount, &volumes).unwrap();
        fs::remove_dir_all(&mount).unwrap();
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.send_selected_to(destination, cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            assert!(s.session.delivery_report.is_none());
            assert!(s.send_preview().is_none());
            let message = &s.session.status.as_ref().unwrap().text;
            assert!(message.contains("Reconnect"));
            assert!(message.contains("Refresh readers"));
            assert!(s.session.status.as_ref().unwrap().is_error);
        });
        assert!(!mount.exists());
    }

    #[test]
    fn no_compatible_format_names_what_koreader_and_stock_kindle_read() {
        let message = humanize_error(takio::error::ErrorCode::NoCompatibleFormat);
        assert!(
            message.contains("KOReader reads EPUB, PDF, MOBI, AZW3, TXT and CBZ"),
            "{message}"
        );
        assert!(
            message.contains("stock Kindle needs AZW3, MOBI, PDF or TXT"),
            "{message}"
        );
        assert!(
            !message.contains("Amazon"),
            "no Amazon advice for KOReader users: {message}"
        );
    }

    #[test]
    fn transfer_errors_include_actionable_recovery_without_raw_codes() {
        for (code, guidance) in [
            (
                takio::error::ErrorCode::UnknownDestination,
                "Refresh readers",
            ),
            (
                takio::error::ErrorCode::SourceUnavailable,
                "file still exists",
            ),
            (takio::error::ErrorCode::CopyFailed, "available space"),
            (
                takio::error::ErrorCode::VerificationFailed,
                "Do not rely on this transfer",
            ),
        ] {
            let message = humanize_error(code);
            assert!(message.contains(guidance), "{message}");
            assert!(!message.contains(code.as_str()), "{message}");
        }
    }

    #[gpui::test]
    fn blocked_metadata_save_retains_reason_and_writes_nothing(cx: &mut TestAppContext) {
        let f = fixture(cx);
        f.state.update(cx, |state, cx| {
            state.session.activity = Activity::Running(Operation::Mutation);
            state.update_metadata(
                state.session.items[0].id.clone(),
                LibraryPatch {
                    title: takio::model::Patch::Set("Never saved".into()),
                    ..LibraryPatch::default()
                },
                cx,
            );
            let error = state
                .metadata_save_result
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap_err();
            assert_eq!(error.kind(), takio::error::ErrorCode::OperationInProgress);
            assert_eq!(error.exit_code(), 1);
            assert_eq!(
                humanize_error(error.kind()),
                "Finish the current operation first"
            );
            assert!(!state.saving_metadata());
            state.session.activity = Activity::Idle;
        });
        let matches = f
            .state
            .read_with(cx, |state, _| {
                state.engine.request(|reply| Request::Query {
                    query: "Never saved".into(),
                    filters: Filters::default(),
                    reply,
                })
            })
            .recv()
            .unwrap()
            .unwrap();
        assert!(matches.is_empty());
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
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
            assert_eq!(
                s.session
                    .metadata_save_result
                    .as_ref()
                    .unwrap()
                    .as_ref()
                    .unwrap(),
                &id
            );
            assert_eq!(s.session.facets.tags.get("To read"), Some(&1));
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
            s.session.metadata_editing = true;
            assert!(!s.can_close(cx));
            s.set_section(Section::Trash, cx);
            assert_eq!(s.session.section, Section::Library);
            s.trash_selected(cx);
            s.import(vec![extra], ImportMode::Copy, cx);
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        assert!(!f.state.read_with(cx, |s, _| s.busy()));
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
    fn cancelled_preflight_cannot_reappear_after_section_round_trip(cx: &mut TestAppContext) {
        for change_section in [false, true] {
            let f = fixture(cx);
            let volumes = f._temp.path().join("volumes");
            let mount = volumes.join("Kindle");
            for directory in ["documents", "system", "koreader"] {
                fs::create_dir_all(mount.join(directory)).unwrap();
            }
            let destination = takio::destinations::authorize(&mount, &volumes).unwrap();
            f.state.update(cx, |s, cx| {
                s.select_all(cx);
                s.send_selected_to(destination, cx);
                if change_section {
                    s.set_section(Section::Trash, cx);
                    s.set_section(Section::Library, cx);
                } else {
                    s.cancel_send_preview(cx);
                }
            });
            settle(&f.state, cx);
            f.state.update(cx, |s, cx| {
                assert!(s.send_preview().is_none());
                assert!(s.session.delivery_report.is_none());
                assert!(s.can_mutate());
                s.confirm_send_preview(cx);
                assert!(!s.busy());
                assert!(
                    s.session
                        .status
                        .as_ref()
                        .unwrap()
                        .text
                        .contains("Nothing was sent")
                );
            });
            assert_eq!(fs::read_dir(mount.join("documents")).unwrap().count(), 0);
            assert!(!mount.join(".takio").exists());
        }
    }

    #[gpui::test]
    fn pending_review_blocks_mutations_and_cancel_restores_actions(cx: &mut TestAppContext) {
        let f = fixture(cx);
        let volumes = f._temp.path().join("volumes");
        let mount = volumes.join("Kindle");
        for directory in ["documents", "system", "koreader"] {
            fs::create_dir_all(mount.join(directory)).unwrap();
        }
        let destination = takio::destinations::authorize(&mount, &volumes).unwrap();
        f.state.update(cx, |s, cx| {
            s.select_all(cx);
            s.send_selected_to(destination.clone(), cx);
        });
        settle(&f.state, cx);
        f.state.update(cx, |s, cx| {
            assert!(!s.can_mutate());
            s.trash_selected(cx);
            s.eject(destination.clone(), cx);
            s.send_selected_to(destination, cx);
            s.update_metadata(s.session.items[0].id.clone(), LibraryPatch::default(), cx);
            assert!(!s.busy());
            assert_eq!(s.send_preview().unwrap().entries.len(), 3);
            s.cancel_send_preview(cx);
            assert!(s.can_mutate());
        });
        settle(&f.state, cx);
        assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
        assert_eq!(fs::read_dir(mount.join("documents")).unwrap().count(), 0);
        assert!(!mount.join(".takio").exists());
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
        f.state.update(cx, |s, cx| {
            let preview = s.send_preview().unwrap();
            assert_eq!(preview.entries.len(), 4);
            assert_eq!(preview.ready_count(), 1);
            assert!(s.session.delivery_report.is_none());
            assert!(!s.can_mutate());
            assert_eq!(fs::read_dir(device.join("documents")).unwrap().count(), 0);
            s.select_only(0, cx);
            s.confirm_send_preview(cx);
            s.confirm_send_preview(cx);
            s.eject(destination.clone(), cx);
            s.reload(cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            let report = s.session.delivery_report.as_ref().unwrap();
            assert_eq!(report.entries.len(), 1);
            assert_eq!(s.session.delivery_exclusions.len(), 3);
            assert_eq!(
                report
                    .entries
                    .iter()
                    .filter(|entry| entry.result.is_ok())
                    .count(),
                1
            );
            assert!(
                s.session
                    .status
                    .as_ref()
                    .unwrap()
                    .text
                    .contains("1 to Kindle, 0 failed, 3 not sent")
            );
        });
        let inventory = takio::destinations::inventory(&destination).unwrap();
        assert_eq!(inventory.len(), 1);
        assert_eq!(
            inventory[0].status,
            takio::destinations::InventoryStatus::Present
        );
        assert!(pdf.exists());
    }
}
