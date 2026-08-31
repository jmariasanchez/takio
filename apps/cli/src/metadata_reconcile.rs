use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::{Handle, Signals};

use crate::model::LibraryItem;
use crate::output::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReconcileRequest {
    schema_version: u8,
    item_ids: Vec<String>,
    include_online: bool,
    concurrency: usize,
}

impl ReconcileRequest {
    pub(crate) fn parse(value: Value) -> AppResult<Self> {
        let mut request: Self =
            serde_json::from_value(value).map_err(|_| AppError::new("invalid-arguments"))?;
        request.item_ids = request
            .item_ids
            .into_iter()
            .map(|id| id.trim().to_owned())
            .collect();
        let mut unique = HashSet::with_capacity(request.item_ids.len());
        if request.schema_version != 1
            || !(1..=64).contains(&request.item_ids.len())
            || !(1..=4).contains(&request.concurrency)
            || request
                .item_ids
                .iter()
                .any(|id| id.is_empty() || id.chars().count() > 256 || !unique.insert(id.clone()))
        {
            return Err(AppError::new("invalid-arguments"));
        }
        Ok(request)
    }

    pub(crate) fn item_ids(&self) -> &[String] {
        &self.item_ids
    }

    pub(crate) const fn include_online(&self) -> bool {
        self.include_online
    }

    pub(crate) const fn concurrency(&self) -> usize {
        self.concurrency
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum ReconcileOutcome {
    Ready {
        #[serde(rename = "itemId")]
        item_id: String,
        candidates: Vec<Value>,
    },
    NoCandidates {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    Missing {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    Failed {
        #[serde(rename = "itemId")]
        item_id: String,
        code: &'static str,
    },
    Canceled {
        #[serde(rename = "itemId")]
        item_id: String,
    },
}

impl ReconcileOutcome {
    fn canceled(item_id: String) -> Self {
        Self::Canceled { item_id }
    }
}

#[derive(Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReconcileCounts {
    total: usize,
    ready: usize,
    no_candidates: usize,
    missing: usize,
    failed: usize,
    canceled: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReconcileResponse {
    schema_version: u8,
    outcomes: Vec<ReconcileOutcome>,
    counts: ReconcileCounts,
}

pub(crate) struct CancellationSignals {
    canceled: Arc<AtomicBool>,
    handle: Handle,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl CancellationSignals {
    pub(crate) fn install() -> AppResult<Self> {
        let mut signals = Signals::new([SIGINT, SIGTERM])?;
        let handle = signals.handle();
        let canceled = Arc::new(AtomicBool::new(false));
        let signal_canceled = Arc::clone(&canceled);
        let thread = std::thread::spawn(move || {
            if signals.forever().next().is_some() {
                signal_canceled.store(true, Ordering::Release);
            }
        });
        Ok(Self {
            canceled,
            handle,
            thread: Some(thread),
        })
    }

    pub(crate) fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.canceled)
    }
}

impl Drop for CancellationSignals {
    fn drop(&mut self) {
        self.handle.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) fn reconcile<F>(
    item_ids: &[String],
    snapshots: Vec<Option<LibraryItem>>,
    include_online: bool,
    timeout_seconds: u64,
    concurrency: usize,
    canceled: Arc<AtomicBool>,
    discover: F,
) -> ReconcileResponse
where
    F: Fn(&LibraryItem, bool, u64) -> AppResult<Vec<Value>> + Sync,
{
    debug_assert_eq!(item_ids.len(), snapshots.len());
    let total = item_ids.len();
    let mut outcomes = (0..total).map(|_| None).collect::<Vec<_>>();
    let jobs = snapshots
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            Some(item) => Some((index, item)),
            None => {
                outcomes[index] = Some(ReconcileOutcome::Missing {
                    item_id: item_ids[index].clone(),
                });
                None
            }
        })
        .collect::<Vec<_>>();

    let worker_count = concurrency.min(jobs.len());
    if worker_count > 0 && !canceled.load(Ordering::Acquire) {
        std::thread::scope(|scope| {
            let (job_sender, job_receiver) = mpsc::channel::<(usize, LibraryItem)>();
            let job_receiver = Arc::new(Mutex::new(job_receiver));
            let (result_sender, result_receiver) = mpsc::channel();
            for _ in 0..worker_count {
                let receiver = Arc::clone(&job_receiver);
                let sender = result_sender.clone();
                let discover = &discover;
                scope.spawn(move || {
                    loop {
                        let job = receiver.lock().expect("job receiver poisoned").recv();
                        let Ok((index, item)) = job else {
                            break;
                        };
                        let result = discover(&item, include_online, timeout_seconds);
                        if sender.send((index, result)).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(result_sender);

            let mut next_job = 0;
            let mut in_flight = 0;
            while next_job < jobs.len()
                && in_flight < worker_count
                && !canceled.load(Ordering::Acquire)
            {
                let (index, item) = &jobs[next_job];
                if job_sender.send((*index, item.clone())).is_err() {
                    break;
                }
                next_job += 1;
                in_flight += 1;
            }

            while in_flight > 0 {
                let Ok((index, result)) = result_receiver.recv() else {
                    break;
                };
                in_flight -= 1;
                outcomes[index] = Some(if canceled.load(Ordering::Acquire) {
                    ReconcileOutcome::canceled(item_ids[index].clone())
                } else {
                    match result {
                        Ok(candidates) if candidates.is_empty() => ReconcileOutcome::NoCandidates {
                            item_id: item_ids[index].clone(),
                        },
                        Ok(candidates) => ReconcileOutcome::Ready {
                            item_id: item_ids[index].clone(),
                            candidates,
                        },
                        Err(error) => ReconcileOutcome::Failed {
                            item_id: item_ids[index].clone(),
                            code: error.code(),
                        },
                    }
                });

                if next_job < jobs.len() && !canceled.load(Ordering::Acquire) {
                    let (next_index, item) = &jobs[next_job];
                    if job_sender.send((*next_index, item.clone())).is_ok() {
                        next_job += 1;
                        in_flight += 1;
                    }
                }
            }
            drop(job_sender);
        });
    }

    for (index, outcome) in outcomes.iter_mut().enumerate() {
        if outcome.is_none() {
            *outcome = Some(ReconcileOutcome::canceled(item_ids[index].clone()));
        }
    }
    let outcomes = outcomes.into_iter().flatten().collect::<Vec<_>>();
    let mut counts = ReconcileCounts {
        total,
        ..ReconcileCounts::default()
    };
    for outcome in &outcomes {
        match outcome {
            ReconcileOutcome::Ready { .. } => counts.ready += 1,
            ReconcileOutcome::NoCandidates { .. } => counts.no_candidates += 1,
            ReconcileOutcome::Missing { .. } => counts.missing += 1,
            ReconcileOutcome::Failed { .. } => counts.failed += 1,
            ReconcileOutcome::Canceled { .. } => counts.canceled += 1,
        }
    }
    ReconcileResponse {
        schema_version: 1,
        outcomes,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::conversion::FormatId;

    fn item(id: &str) -> LibraryItem {
        LibraryItem {
            id: id.to_owned(),
            title: id.to_owned(),
            source_path: PathBuf::from(format!("{id}.epub")),
            format: FormatId::Epub,
            added_at: "2026-01-01T00:00:00Z".to_owned(),
            formats: Vec::new(),
            author: None,
            authors: Vec::new(),
            series: None,
            series_index: None,
            publisher: None,
            languages: Vec::new(),
            identifiers: Default::default(),
            custom_metadata: Default::default(),
            published_date: None,
            rating: None,
            description: None,
            cover_path: None,
            tags: Vec::new(),
            updated_at: None,
        }
    }

    fn valid_request() -> Value {
        json!({"schemaVersion":1,"itemIds":["a"],"includeOnline":false,"concurrency":1})
    }

    #[test]
    fn request_rejects_unknown_fields_bounds_and_duplicates() {
        assert!(ReconcileRequest::parse(valid_request()).is_ok());
        for invalid in [
            json!({"schemaVersion":2,"itemIds":["a"],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":[],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":["a","a"],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":[" a ","a"],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":["  "],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":["x".repeat(257)],"includeOnline":false,"concurrency":1}),
            json!({"schemaVersion":1,"itemIds":["a"],"includeOnline":false,"concurrency":0}),
            json!({"schemaVersion":1,"itemIds":["a"],"includeOnline":false,"concurrency":5}),
            json!({"schemaVersion":1,"itemIds":["a"],"includeOnline":false,"concurrency":1,"extra":true}),
        ] {
            assert_eq!(
                ReconcileRequest::parse(invalid)
                    .expect_err("invalid request")
                    .code(),
                "invalid-arguments"
            );
        }
        let too_many = (0..65)
            .map(|index| format!("item-{index}"))
            .collect::<Vec<_>>();
        assert!(
            ReconcileRequest::parse(json!({
                "schemaVersion":1,"itemIds":too_many,"includeOnline":false,"concurrency":1
            }))
            .is_err()
        );
    }

    #[test]
    fn request_trims_item_ids_before_use() {
        let request = ReconcileRequest::parse(json!({
            "schemaVersion":1,"itemIds":["  first  ","second\n"],"includeOnline":false,"concurrency":1
        }))
        .expect("valid request");
        assert_eq!(request.item_ids(), ["first", "second"]);
    }

    #[test]
    fn reconciliation_preserves_order_and_exact_counts() {
        let ids = ["ready", "missing", "none", "failed"]
            .map(str::to_owned)
            .to_vec();
        let response = reconcile(
            &ids,
            vec![
                Some(item("ready")),
                None,
                Some(item("none")),
                Some(item("failed")),
            ],
            false,
            30,
            3,
            Arc::new(AtomicBool::new(false)),
            |item, _, _| match item.id.as_str() {
                "ready" => Ok(vec![json!({"provenance":{"itemId":"ready"}})]),
                "none" => Ok(Vec::new()),
                _ => Err(AppError::new("metadata-unavailable")),
            },
        );
        let value = serde_json::to_value(response).expect("response JSON");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(
            value["outcomes"],
            json!([
                {"status":"ready","itemId":"ready","candidates":[{"provenance":{"itemId":"ready"}}]},
                {"status":"missing","itemId":"missing"},
                {"status":"no-candidates","itemId":"none"},
                {"status":"failed","itemId":"failed","code":"metadata-unavailable"}
            ])
        );
        assert_eq!(
            value["counts"],
            json!({
                "total":4,"ready":1,"noCandidates":1,"missing":1,"failed":1,"canceled":0
            })
        );
    }

    #[test]
    fn worker_pool_never_exceeds_four_concurrent_calls() {
        let ids = (0..16)
            .map(|index| format!("item-{index}"))
            .collect::<Vec<_>>();
        let snapshots = ids.iter().map(|id| Some(item(id))).collect();
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let response = reconcile(
            &ids,
            snapshots,
            false,
            30,
            4,
            Arc::new(AtomicBool::new(false)),
            |_, _, _| {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(vec![json!({"candidate":true})])
            },
        );
        assert_eq!(response.counts.ready, 16);
        assert!(maximum.load(Ordering::SeqCst) <= 4);
    }

    #[test]
    fn cancellation_stops_dispatch_and_accounts_for_every_item() {
        let ids = (0..10)
            .map(|index| format!("item-{index}"))
            .collect::<Vec<_>>();
        let snapshots = ids.iter().map(|id| Some(item(id))).collect();
        let canceled = Arc::new(AtomicBool::new(false));
        let calls = AtomicUsize::new(0);
        let response = reconcile(
            &ids,
            snapshots,
            false,
            30,
            2,
            Arc::clone(&canceled),
            |_, _, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                canceled.store(true, Ordering::Release);
                Ok(vec![json!({"candidate":true})])
            },
        );
        assert!(calls.load(Ordering::SeqCst) <= 2);
        assert_eq!(response.counts.total, 10);
        assert_eq!(response.counts.canceled, 10);
        assert_eq!(response.counts.ready, 0);
    }

    #[test]
    fn installed_signal_handler_sets_the_cancellation_flag() {
        let signals = CancellationSignals::install().expect("install signals");
        let canceled = signals.flag();
        signal_hook::low_level::raise(SIGTERM).expect("raise SIGTERM");
        for _ in 0..100 {
            if canceled.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("signal did not set cancellation flag");
    }
}
