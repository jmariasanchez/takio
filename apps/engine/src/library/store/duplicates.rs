//! Explicit duplicate review and transactional merge. Discovery and metadata
//! interpretation remain private implementation details of this workflow.
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::LibraryStore;
use super::hydration::read_item_from;
use crate::error::AppResult;
use crate::format::FormatId;
use crate::library::model::{LibraryItem, LibraryPatch};

mod metadata;
mod scan;

use metadata::{apply_duplicate_metadata, write_duplicate_metadata};
use scan::{canonical_pair, scan_duplicate_candidates_in, valid_pair, valid_review_token};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DuplicateSignal {
    SameContent {
        #[serde(rename = "leftFormat")]
        left_format: FormatId,
        #[serde(rename = "rightFormat")]
        right_format: FormatId,
        bytes: u64,
        sha256: String,
    },
    SameIdentifier {
        scheme: String,
        value: String,
    },
    SameTitleAuthor {
        title: String,
        author: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub left: LibraryItem,
    pub right: LibraryItem,
    pub signals: Vec<DuplicateSignal>,
    pub review_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanSummary {
    pub files_hashed: u64,
    pub fingerprints_reused: u64,
    pub unreadable_formats: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidatePage {
    pub candidates: Vec<DuplicateCandidate>,
    pub total: usize,
    pub page: DuplicatePageRequest,
    pub scan: DuplicateScanSummary,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicatePageRequest {
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDuplicateCandidatesRequest {
    pub page: DuplicatePageRequest,
    pub disposition: DuplicateDisposition,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateDisposition {
    Unreviewed,
    KeptBoth,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicatePairReviewRequest {
    pub left_id: String,
    pub right_id: String,
    pub review_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeDuplicatePairRequest {
    pub target_id: String,
    pub source_id: String,
    pub review_token: String,
    pub metadata: LibraryPatch,
    pub add_source_formats: Vec<FormatId>,
    pub cover: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDuplicatePairResult {
    pub target: LibraryItem,
    pub trashed_source: LibraryItem,
    pub cleanup_pending: bool,
}

impl LibraryStore {
    pub fn list_duplicate_candidates(
        &self,
        request: &ListDuplicateCandidatesRequest,
    ) -> AppResult<DuplicateCandidatePage> {
        validate_duplicate_page(request)?;
        let (candidates, scan) = self.scan_duplicate_candidates()?;
        let mut reviews = HashMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT left_id,right_id,review_token FROM duplicate_pair_reviews")?;
        for row in statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (left, right, token) = row?;
            if !valid_pair(&left, &right) || !valid_review_token(&token) {
                return Err(crate::app_error!("invalid-stored-data"));
            }
            reviews.insert((left, right), token);
        }
        let matching = candidates
            .into_iter()
            .filter(|candidate| {
                let reviewed = reviews
                    .get(&(candidate.left.id.clone(), candidate.right.id.clone()))
                    == Some(&candidate.review_token);
                (request.disposition == DuplicateDisposition::KeptBoth) == reviewed
            })
            .collect::<Vec<_>>();
        let total = matching.len();
        let candidates = matching
            .into_iter()
            .skip(request.page.offset)
            .take(request.page.limit)
            .collect();
        Ok(DuplicateCandidatePage {
            candidates,
            total,
            page: request.page,
            scan,
        })
    }

    pub fn keep_duplicate_pair(&mut self, request: &DuplicatePairReviewRequest) -> AppResult<()> {
        validate_pair_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| {
                candidate.left.id == request.left_id && candidate.right.id == request.right_id
            })
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| crate::app_error!("stale-review"))?;
        transaction.execute(
            "INSERT INTO duplicate_pair_reviews (left_id,right_id,review_token,reviewed_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(left_id,right_id) DO UPDATE SET review_token=excluded.review_token,reviewed_at=excluded.reviewed_at",
            params![candidate.left.id, candidate.right.id, candidate.review_token, Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reopen_duplicate_pair(&mut self, request: &DuplicatePairReviewRequest) -> AppResult<()> {
        validate_pair_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| {
                candidate.left.id == request.left_id && candidate.right.id == request.right_id
            })
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| crate::app_error!("stale-review"))?;
        let stored: Option<String> = transaction
            .query_row(
                "SELECT review_token FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
                params![current.left.id, current.right.id],
                |row| row.get(0),
            )
            .optional()?;
        if stored.as_deref() != Some(&request.review_token) {
            return Err(crate::app_error!("stale-review"));
        }
        transaction.execute(
            "DELETE FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
            params![request.left_id, request.right_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn merge_duplicate_pair(
        &mut self,
        request: &MergeDuplicatePairRequest,
    ) -> AppResult<MergeDuplicatePairResult> {
        validate_merge_request(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (left_id, right_id) = canonical_pair(&request.target_id, &request.source_id);
        let candidate = scan_duplicate_candidates_in(&transaction)?
            .0
            .into_iter()
            .find(|candidate| candidate.left.id == left_id && candidate.right.id == right_id)
            .filter(|candidate| candidate.review_token == request.review_token)
            .ok_or_else(|| crate::app_error!("stale-review"))?;
        let mut target = if candidate.left.id == request.target_id {
            candidate.left.clone()
        } else {
            candidate.right.clone()
        };
        apply_duplicate_metadata(&mut target, &request.metadata)?;
        target.updated_at = Some(Utc::now().to_rfc3339());

        let target_formats = target
            .formats
            .iter()
            .map(|format| format.format.as_str())
            .collect::<Vec<_>>();
        let mut source_rows =
            HashMap::<String, (String, String, String, Option<i64>, Option<String>)>::new();
        let mut statement = transaction.prepare(
            "SELECT format,source_path,added_at,provenance,content_bytes,content_sha256
             FROM library_item_formats WHERE library_item_id=?1 ORDER BY position",
        )?;
        for row in statement.query_map([&request.source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })? {
            let row = row?;
            source_rows.insert(row.0.clone(), (row.1, row.2, row.3, row.4, row.5));
        }
        drop(statement);
        let mut selected = Vec::new();
        for format in &request.add_source_formats {
            let key = format.as_str();
            if target_formats.contains(&key)
                || selected.contains(&key)
                || !source_rows.contains_key(key)
            {
                return Err(crate::app_error!("invalid-arguments"));
            }
            selected.push(key);
        }

        let (target_cover, source_cover): (Option<String>, Option<String>) = transaction
            .query_row(
                "SELECT (SELECT cover_path FROM library_items WHERE id=?1),
                    (SELECT cover_path FROM library_items WHERE id=?2)",
                params![request.target_id, request.source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let selected_cover = match request.cover.as_str() {
            "target" => target_cover.clone(),
            "source" => Some(
                source_cover
                    .clone()
                    .ok_or_else(|| crate::app_error!("invalid-arguments"))?,
            ),
            "none" => None,
            _ => return Err(crate::app_error!("invalid-arguments")),
        };
        if let Some(path) = &selected_cover
            && !Path::new(path).starts_with(&self.paths.covers)
        {
            return Err(crate::app_error!("invalid-stored-data"));
        }

        write_duplicate_metadata(&transaction, &target)?;
        let next_position = i64::try_from(target.formats.len())
            .map_err(|_| crate::app_error!("invalid-arguments"))?;
        for (index, format) in request.add_source_formats.iter().enumerate() {
            let (path, added_at, provenance, bytes, sha) = source_rows
                .get(format.as_str())
                .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
            transaction.execute(
                "INSERT INTO library_item_formats
                 (library_item_id,format,source_path,added_at,provenance,position,content_bytes,content_sha256)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![request.target_id, format.as_str(), path, added_at, provenance,
                    next_position + i64::try_from(index).map_err(|_| crate::app_error!("invalid-arguments"))?, bytes, sha],
            )?;
        }
        transaction.execute(
            "UPDATE library_items SET cover_path=?2 WHERE id=?1",
            params![request.target_id, selected_cover],
        )?;
        let changed = transaction.execute(
            "UPDATE library_items SET trashed_at=?2,updated_at=?2 WHERE id=?1 AND trashed_at IS NULL",
            params![request.source_id, target.updated_at],
        )?;
        if changed != 1 {
            return Err(crate::app_error!("stale-review"));
        }
        transaction.execute(
            "DELETE FROM duplicate_pair_reviews WHERE left_id=?1 AND right_id=?2",
            params![left_id, right_id],
        )?;
        let target = read_item_from(&transaction, &request.target_id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
        let trashed_source = read_item_from(&transaction, &request.source_id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))?;
        transaction.commit()?;

        let cleanup_pending = if let Some(old) = target_cover
            && Some(&old) != selected_cover.as_ref()
            && !self.path_is_referenced(&old)?
        {
            fs::remove_file(old).is_err()
        } else {
            false
        };
        Ok(MergeDuplicatePairResult {
            target,
            trashed_source,
            cleanup_pending,
        })
    }

    fn scan_duplicate_candidates(
        &self,
    ) -> AppResult<(Vec<DuplicateCandidate>, DuplicateScanSummary)> {
        scan_duplicate_candidates_in(&self.connection)
    }
}

fn validate_duplicate_page(request: &ListDuplicateCandidatesRequest) -> AppResult<()> {
    if request.page.limit == 0 || request.page.limit > 100 {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(())
}

fn validate_pair_request(request: &DuplicatePairReviewRequest) -> AppResult<()> {
    if !valid_pair(&request.left_id, &request.right_id)
        || !valid_review_token(&request.review_token)
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(())
}

fn validate_merge_request(request: &MergeDuplicatePairRequest) -> AppResult<()> {
    if request.target_id.is_empty()
        || request.source_id.is_empty()
        || request.target_id == request.source_id
        || !valid_review_token(&request.review_token)
        || request.metadata.is_empty()
        || !matches!(request.cover.as_str(), "target" | "source" | "none")
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
