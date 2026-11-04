//! Metadata discovery, staged-cover lifetime, and reviewed candidate application.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::library::model::{LibraryItem, LibraryPatch, Patch};
use crate::library::store::{LibraryStore, METADATA_AUDIT_KEY, validate_candidate_patch};
pub use crate::metadata::candidate_cover::CandidateCoverDescriptor;
use crate::metadata::{self, discover_ebook_meta, discover_fetch_ebook_metadata};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateProvenance {
    pub generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataCandidate {
    pub schema_version: u64,
    pub id: String,
    pub source: String,
    pub confidence: String,
    pub patch: BTreeMap<String, Value>,
    pub provenance: CandidateProvenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CandidateCoverDescriptor>,
}

impl MetadataCandidate {
    fn validated_fields(&self, item_id: &str) -> AppResult<Vec<String>> {
        let invalid = || crate::app_error!("invalid-arguments");
        if self.schema_version != 1
            || self.id.trim().is_empty()
            || self.id.len() > 120
            || !["filename", "embedded", "online"].contains(&self.source.as_str())
            || !["low", "medium", "high"].contains(&self.confidence.as_str())
        {
            return Err(invalid());
        }
        let provenance = &self.provenance;
        if provenance.item_id.as_deref() != Some(item_id)
            || chrono::DateTime::parse_from_rfc3339(&provenance.generated_at).is_err()
            || provenance
                .source_path
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 4096)
            || provenance
                .pattern
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 240)
            || provenance.backend.as_ref().is_some_and(|value| {
                !["ebook-meta", "fetch-ebook-metadata"].contains(&value.as_str())
            })
        {
            return Err(invalid());
        }
        if let Some(cover) = &self.cover {
            crate::metadata::candidate_cover::validate_descriptor(cover).map_err(|_| invalid())?;
        }
        if self.patch.is_empty() && self.cover.is_none() {
            return Err(invalid());
        }
        Ok(self.patch.keys().cloned().collect())
    }
}

pub struct PreparedMetadataCandidate {
    pub candidate_id: String,
    pub source: String,
    pub fields: Vec<String>,
    pub cover: Option<CandidateCoverDescriptor>,
    patch: LibraryPatch,
    audit: Value,
    candidate_provenance: String,
}

#[derive(Default)]
pub struct CandidateSelection<'a> {
    pub fields: Option<&'a BTreeSet<String>>,
    pub include_cover: bool,
}

pub fn prepare_metadata_candidate(
    candidate: MetadataCandidate,
    item_id: &str,
    selection: CandidateSelection<'_>,
    provenance: &str,
) -> AppResult<PreparedMetadataCandidate> {
    if item_id.trim().is_empty() || provenance.trim().is_empty() {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let all_fields = candidate.validated_fields(item_id)?;
    let fields = if let Some(selected) = selection.fields {
        if (selected.is_empty() && !(selection.include_cover && candidate.cover.is_some()))
            || selected.iter().any(|field| !all_fields.contains(field))
        {
            return Err(crate::app_error!("invalid-arguments"));
        }
        all_fields
            .into_iter()
            .filter(|field| selected.contains(field))
            .collect::<Vec<_>>()
    } else {
        all_fields
    };
    let selected_patch: serde_json::Map<_, _> = fields
        .iter()
        .filter_map(|field| {
            candidate
                .patch
                .get(field)
                .cloned()
                .map(|value| (field.clone(), value))
        })
        .collect();
    let patch: LibraryPatch = serde_json::from_value(Value::Object(selected_patch))
        .map_err(|_| crate::app_error!("invalid-arguments"))?;
    if patch.is_empty() && !(selection.include_cover && candidate.cover.is_some()) {
        return Err(crate::app_error!("invalid-arguments"));
    }
    if !patch.is_empty() {
        validate_candidate_patch(&patch)?;
    }
    let audit = json!({
        "schemaVersion":1, "candidateId":candidate.id, "source":candidate.source,
        "confidence":candidate.confidence, "candidateProvenance":candidate.provenance,
        "selectedFields":fields, "applicationProvenance":provenance.trim(),
        "cover":selection.include_cover.then(|| candidate.cover.as_ref().map(|cover| json!({
            "mediaType":cover.media_type, "extension":cover.extension, "bytes":cover.bytes, "sha256":cover.sha256
        }))).flatten()
    });
    let candidate_provenance = serde_json::to_string(&candidate.provenance)
        .map_err(|_| crate::app_error!("invalid-arguments"))?;
    Ok(PreparedMetadataCandidate {
        candidate_id: candidate.id,
        source: candidate.source,
        fields,
        patch,
        audit,
        cover: selection.include_cover.then_some(candidate.cover).flatten(),
        candidate_provenance,
    })
}

pub fn apply_prepared_metadata_candidate(
    store: &mut LibraryStore,
    item_id: &str,
    prepared: &PreparedMetadataCandidate,
) -> AppResult<LibraryItem> {
    let current = store
        .get(item_id)?
        .ok_or_else(|| crate::app_error!("not-found"))?;
    let mut patch = prepared.patch.clone();
    patch.custom_metadata = Patch::Set(merge_metadata_audit(
        &current.custom_metadata,
        &patch.custom_metadata,
        &prepared.audit,
    )?);
    store.apply_metadata_candidate(
        item_id,
        patch,
        prepared.cover.as_ref(),
        &prepared.candidate_id,
        &prepared.source,
        &prepared.candidate_provenance,
    )
}

fn merge_metadata_audit(
    existing: &BTreeMap<String, String>,
    selected: &Patch<BTreeMap<String, String>>,
    audit: &Value,
) -> AppResult<BTreeMap<String, String>> {
    let mut merged = match selected {
        Patch::Missing => existing.clone(),
        Patch::Null => BTreeMap::new(),
        Patch::Set(value) => value.clone(),
    };
    let encoded =
        serde_json::to_string(audit).map_err(|_| crate::app_error!("storage-unavailable"))?;
    if encoded.len() > 16 * 1024
        || merged
            .keys()
            .filter(|key| key.as_str() != METADATA_AUDIT_KEY)
            .count()
            > 64
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    merged.insert(METADATA_AUDIT_KEY.to_owned(), encoded);
    Ok(merged)
}

struct CandidateCoverStages<'a> {
    library_root: &'a Path,
    artifact_ids: Vec<String>,
    retain: bool,
}
impl Drop for CandidateCoverStages<'_> {
    fn drop(&mut self) {
        if !self.retain {
            for id in &self.artifact_ids {
                crate::metadata::candidate_cover::consume(self.library_root, id);
            }
        }
    }
}
impl CandidateCoverStages<'_> {
    fn candidate(
        &mut self,
        item_id: &str,
        origin: (&str, &str, &str),
        data: (
            Value,
            Option<crate::metadata::candidate_cover::CapturedCover>,
        ),
        provenance: CandidateProvenance,
        canceled: &AtomicBool,
    ) -> AppResult<Option<MetadataCandidate>> {
        if canceled.load(Ordering::Acquire) {
            return Err(crate::app_error!("operation-canceled"));
        }
        let (id, source, confidence) = origin;
        let (metadata, cover_data) = data;
        let cover = cover_data
            .as_ref()
            .map(|cover| {
                let encoded = serde_json::to_string(&provenance)
                    .map_err(|_| crate::app_error!("metadata-invalid"))?;
                let descriptor = crate::metadata::candidate_cover::stage(
                    self.library_root,
                    item_id,
                    id,
                    source,
                    &encoded,
                    cover,
                )?;
                self.artifact_ids.push(descriptor.artifact_id.clone());
                Ok::<_, AppError>(descriptor)
            })
            .transpose()?;
        let patch: BTreeMap<String, Value> =
            serde_json::from_value(metadata).map_err(|_| crate::app_error!("metadata-invalid"))?;
        Ok(
            (!patch.is_empty() || cover.is_some()).then(|| MetadataCandidate {
                schema_version: 1,
                id: id.into(),
                source: source.into(),
                confidence: confidence.into(),
                patch,
                provenance,
                cover,
            }),
        )
    }
}

pub fn release_metadata_candidate_covers(library_root: &Path, candidates: &[MetadataCandidate]) {
    for cover in candidates
        .iter()
        .filter_map(|candidate| candidate.cover.as_ref())
    {
        crate::metadata::candidate_cover::consume(library_root, &cover.artifact_id);
    }
}

pub fn metadata_candidates_for_item_at(
    item: &LibraryItem,
    include_online: bool,
    timeout_seconds: u64,
    library_root: &Path,
) -> AppResult<Vec<MetadataCandidate>> {
    metadata_candidates_for_item_at_cancellable(
        item,
        include_online,
        timeout_seconds,
        library_root,
        &AtomicBool::new(false),
    )
}

pub fn metadata_candidates_for_item_at_cancellable(
    item: &LibraryItem,
    include_online: bool,
    timeout_seconds: u64,
    library_root: &Path,
    canceled: &AtomicBool,
) -> AppResult<Vec<MetadataCandidate>> {
    discover_candidates(
        item,
        include_online,
        timeout_seconds,
        canceled,
        false,
        library_root,
    )
}

pub fn metadata_candidates_for_reconcile(
    item: &LibraryItem,
    include_online: bool,
    timeout_seconds: u64,
    canceled: &AtomicBool,
    library_root: &Path,
) -> AppResult<Vec<MetadataCandidate>> {
    discover_candidates(
        item,
        include_online,
        timeout_seconds,
        canceled,
        true,
        library_root,
    )
}

fn discover_candidates(
    item: &LibraryItem,
    include_online: bool,
    timeout_seconds: u64,
    canceled: &AtomicBool,
    require_requested_sources: bool,
    library_root: &Path,
) -> AppResult<Vec<MetadataCandidate>> {
    if timeout_seconds == 0 {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let mut candidates =
        filename_candidates_for_stem(&item.title, &item.source_path, Some(&item.id), &[])?;
    let mut stages = CandidateCoverStages {
        library_root,
        artifact_ids: Vec::new(),
        retain: false,
    };
    if canceled.load(Ordering::Acquire) {
        return Err(crate::app_error!("operation-canceled"));
    }
    if discover_ebook_meta().is_some() {
        match metadata::extract_cancellable(
            &item.source_path,
            Duration::from_secs(timeout_seconds),
            canceled,
        ) {
            Ok(extracted) => {
                let provenance = CandidateProvenance {
                    generated_at: "1970-01-01T00:00:00.000Z".into(),
                    item_id: Some(item.id.clone()),
                    source_path: Some(extracted.source_path.to_string_lossy().into_owned()),
                    pattern: None,
                    backend: Some("ebook-meta".into()),
                };
                if let Some(candidate) = stages.candidate(
                    &item.id,
                    ("embedded:1", "embedded", "high"),
                    (extracted.metadata, extracted.cover_data),
                    provenance,
                    canceled,
                )? {
                    candidates.push(candidate);
                }
            }
            Err(error) if require_requested_sources => return Err(error),
            Err(_) => {}
        }
    }
    if canceled.load(Ordering::Acquire) {
        return Err(crate::app_error!("operation-canceled"));
    }
    if include_online && discover_fetch_ebook_metadata().is_some() {
        let authors = item.author_names().map(str::to_owned).collect::<Vec<_>>();
        match metadata::fetch_candidate_cancellable(
            Some(&item.title),
            &authors,
            &item.identifiers,
            Duration::from_secs(timeout_seconds),
            canceled,
        ) {
            Ok(fetched) => {
                let provenance = CandidateProvenance {
                    generated_at: "1970-01-01T00:00:00.000Z".into(),
                    item_id: Some(item.id.clone()),
                    source_path: None,
                    pattern: None,
                    backend: Some("fetch-ebook-metadata".into()),
                };
                if let Some(candidate) = stages.candidate(
                    &item.id,
                    ("online:1", "online", "medium"),
                    (fetched.metadata, fetched.cover_data),
                    provenance,
                    canceled,
                )? {
                    candidates.push(candidate);
                }
            }
            Err(error) if require_requested_sources => return Err(error),
            Err(_) => {}
        }
    }
    if canceled.load(Ordering::Acquire) {
        return Err(crate::app_error!("operation-canceled"));
    }
    candidates.truncate(8);
    if canceled.load(Ordering::Acquire) {
        return Err(crate::app_error!("operation-canceled"));
    }
    stages.retain = true;
    Ok(candidates)
}

pub fn filename_candidates(
    source: &Path,
    item_id: Option<&str>,
    custom_patterns: &[String],
) -> AppResult<Vec<MetadataCandidate>> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
    filename_candidates_for_stem(stem, source, item_id, custom_patterns)
}

fn filename_candidates_for_stem(
    stem: &str,
    provenance_path: &Path,
    item_id: Option<&str>,
    custom_patterns: &[String],
) -> AppResult<Vec<MetadataCandidate>> {
    const BUILTINS: [&str; 4] = [
        r"^(?<author>.+?) - (?<series>.+?) (?<seriesIndex>\d+(?:\.\d+)?) - (?<title>.+)$",
        r"^(?<author>.+?) - (?<title>.+?) \((?<series>.+?) #(?<seriesIndex>\d+(?:\.\d+)?)\)$",
        r"^(?<author>.+?) - (?<title>.+)$",
        r"^(?<title>.+?) - (?<author>.+)$",
    ];
    if custom_patterns
        .iter()
        .any(|pattern| pattern.is_empty() || pattern.len() > 240)
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let mut candidates = Vec::new();
    for pattern in custom_patterns.iter().map(String::as_str).chain(BUILTINS) {
        let expression =
            regex::Regex::new(pattern).map_err(|_| crate::app_error!("invalid-arguments"))?;
        let Some(captures) = expression.captures(stem) else {
            continue;
        };
        let clean = |name: &str| {
            captures.name(name).and_then(|value| {
                let value = value
                    .as_str()
                    .replace(['.', '_'], " ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                (!value.is_empty()).then_some(value)
            })
        };
        let Some(title) = clean("title") else {
            continue;
        };
        let mut patch = BTreeMap::from([("title".into(), json!(title))]);
        if let Some(author) = clean("author") {
            patch.insert("author".into(), json!(author));
            patch.insert("authors".into(), json!([{"name":author}]));
        }
        if let Some(series) = clean("series") {
            patch.insert("series".into(), json!(series));
        }
        if let Some(index) = clean("seriesIndex").and_then(|value| value.parse::<f64>().ok()) {
            patch.insert("seriesIndex".into(), json!(index));
        }
        candidates.push(MetadataCandidate {
            schema_version: 1,
            id: format!("filename:{}", candidates.len() + 1),
            source: "filename".into(),
            confidence: if custom_patterns
                .first()
                .is_some_and(|value| value == pattern)
            {
                "high"
            } else {
                "medium"
            }
            .into(),
            patch,
            cover: None,
            provenance: CandidateProvenance {
                generated_at: "1970-01-01T00:00:00.000Z".into(),
                item_id: item_id.map(str::to_owned),
                source_path: Some(provenance_path.to_string_lossy().into_owned()),
                pattern: Some(pattern.into()),
                backend: None,
            },
        });
        if candidates.len() == 8 {
            break;
        }
    }
    Ok(candidates)
}
