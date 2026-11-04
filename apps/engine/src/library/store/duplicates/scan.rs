//! Stable duplicate evidence, ordering and review tokens.
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{DuplicateCandidate, DuplicateScanSummary, DuplicateSignal};
use crate::conversion::FormatId;
use crate::error::AppResult;
use crate::fingerprint::Fingerprint;
use crate::store::hash_file;
use crate::store::hydration::read_item_from;

pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn normalize_duplicate_text(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn compare_duplicate_strings(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub(super) fn canonical_pair(left: &str, right: &str) -> (String, String) {
    if compare_duplicate_strings(left, right).is_lt() {
        (left.to_owned(), right.to_owned())
    } else {
        (right.to_owned(), left.to_owned())
    }
}

pub(super) fn valid_pair(left: &str, right: &str) -> bool {
    !left.is_empty() && compare_duplicate_strings(left, right).is_lt()
}

pub(super) fn valid_review_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn signal_sort_key(signal: &DuplicateSignal) -> String {
    match signal {
        DuplicateSignal::SameContent {
            left_format,
            right_format,
            bytes,
            sha256,
        } => format!(
            "0\0{}\0{}\0{bytes:016}\0{sha256}",
            left_format.as_str(),
            right_format.as_str()
        ),
        DuplicateSignal::SameIdentifier { scheme, value } => {
            format!("1\0{}\0{value}", normalize_duplicate_text(scheme))
        }
        DuplicateSignal::SameTitleAuthor { title, author } => format!(
            "2\0{}\0{}",
            normalize_duplicate_text(title),
            normalize_duplicate_text(author)
        ),
    }
}

fn add_duplicate_signal(
    signals: &mut BTreeMap<(String, String), BTreeMap<String, DuplicateSignal>>,
    left: &str,
    right: &str,
    signal: DuplicateSignal,
) -> AppResult<()> {
    if left == right {
        return Ok(());
    }
    let pair = canonical_pair(left, right);
    let key =
        serde_json::to_string(&signal).map_err(|_| crate::app_error!("invalid-stored-data"))?;
    signals.entry(pair).or_default().insert(key, signal);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateReviewSeed<'a> {
    version: u8,
    left_id: &'a str,
    right_id: &'a str,
    signals: &'a [DuplicateSignal],
}

pub(super) fn scan_duplicate_candidates_in(
    connection: &Connection,
) -> AppResult<(Vec<DuplicateCandidate>, DuplicateScanSummary)> {
    let mut ids = Vec::new();
    let mut statement =
        connection.prepare("SELECT id FROM library_items WHERE trashed_at IS NULL ORDER BY id")?;
    for id in statement.query_map([], |row| row.get::<_, String>(0))? {
        ids.push(id?);
    }
    drop(statement);
    let mut items = HashMap::new();
    for id in ids {
        let item = read_item_from(connection, &id)?
            .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
        items.insert(id, item);
    }

    let mut signals = BTreeMap::<(String, String), BTreeMap<String, DuplicateSignal>>::new();
    let mut fingerprints = HashMap::<Fingerprint, Vec<(String, FormatId)>>::new();
    let mut files_hashed = 0;
    let mut fingerprints_reused = 0;
    let mut unreadable_formats = 0;
    let mut statement = connection.prepare(
        "SELECT f.library_item_id,f.format,f.source_path,f.provenance,f.content_bytes,f.content_sha256
         FROM library_item_formats f JOIN library_items i ON i.id=f.library_item_id
         WHERE i.trashed_at IS NULL ORDER BY f.library_item_id,f.position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    for row in rows {
        let (item_id, format, path, provenance, bytes, sha) = row?;
        let format = FormatId::ALL
            .into_iter()
            .find(|candidate| candidate.as_str() == format)
            .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
        let fingerprint = if provenance == "managed" {
            let bytes = bytes
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
            if bytes > MAX_SAFE_INTEGER {
                return Err(crate::app_error!("invalid-stored-data"));
            }
            let sha = sha
                .filter(|value| valid_review_token(value))
                .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
            fingerprints_reused += 1;
            Some(Fingerprint { bytes, sha256: sha })
        } else if provenance == "referenced" {
            if let Ok(value) = hash_file(Path::new(&path)) {
                files_hashed += 1;
                if value.bytes > MAX_SAFE_INTEGER {
                    return Err(crate::app_error!("invalid-stored-data"));
                }
                Some(value)
            } else {
                unreadable_formats += 1;
                None
            }
        } else {
            return Err(crate::app_error!("invalid-stored-data"));
        };
        if let Some(Fingerprint { bytes, sha256: sha }) = fingerprint
            && bytes > 0
        {
            fingerprints
                .entry(Fingerprint { bytes, sha256: sha })
                .or_default()
                .push((item_id, format));
        }
    }
    drop(statement);
    for (Fingerprint { bytes, sha256 }, entries) in fingerprints {
        for left_index in 0..entries.len() {
            for right_index in (left_index + 1)..entries.len() {
                let (left, right) = (&entries[left_index], &entries[right_index]);
                let ((left_id, left_format), (right_id, right_format)) =
                    if compare_duplicate_strings(&left.0, &right.0).is_lt() {
                        (left, right)
                    } else {
                        (right, left)
                    };
                add_duplicate_signal(
                    &mut signals,
                    left_id,
                    right_id,
                    DuplicateSignal::SameContent {
                        left_format: *left_format,
                        right_format: *right_format,
                        bytes,
                        sha256: sha256.clone(),
                    },
                )?;
            }
        }
    }

    let mut identifiers = HashMap::<(String, String), Vec<(String, String, String)>>::new();
    let mut titles = HashMap::<(String, String), Vec<(String, String, String)>>::new();
    let mut item_ids = items.keys().cloned().collect::<Vec<_>>();
    item_ids.sort_by(|left, right| compare_duplicate_strings(left, right));
    for item_id in item_ids {
        let item = items
            .get(&item_id)
            .ok_or_else(|| crate::app_error!("invalid-stored-data"))?;
        for (scheme, value) in &item.identifiers {
            let normalized_scheme = normalize_duplicate_text(scheme);
            let value = value.trim();
            if !normalized_scheme.is_empty() && !value.is_empty() {
                identifiers
                    .entry((normalized_scheme, value.to_owned()))
                    .or_default()
                    .push((item.id.clone(), scheme.trim().to_owned(), value.to_owned()));
            }
        }
        let title = normalize_duplicate_text(&item.title);
        let mut unique_authors = BTreeMap::new();
        for author in item.author_names() {
            let normalized = normalize_duplicate_text(author);
            if !normalized.is_empty() {
                unique_authors
                    .entry(normalized)
                    .or_insert_with(|| author.trim().to_owned());
            }
        }
        for (author_key, author) in unique_authors {
            if !title.is_empty() {
                titles
                    .entry((title.clone(), author_key))
                    .or_default()
                    .push((item.id.clone(), item.title.trim().to_owned(), author));
            }
        }
    }
    for entries in identifiers.values() {
        for left in 0..entries.len() {
            for right in (left + 1)..entries.len() {
                add_duplicate_signal(
                    &mut signals,
                    &entries[left].0,
                    &entries[right].0,
                    DuplicateSignal::SameIdentifier {
                        scheme: entries[left].1.clone(),
                        value: entries[left].2.clone(),
                    },
                )?;
            }
        }
    }
    for entries in titles.values() {
        for left in 0..entries.len() {
            for right in (left + 1)..entries.len() {
                add_duplicate_signal(
                    &mut signals,
                    &entries[left].0,
                    &entries[right].0,
                    DuplicateSignal::SameTitleAuthor {
                        title: entries[left].1.clone(),
                        author: entries[left].2.clone(),
                    },
                )?;
            }
        }
    }

    let mut candidates = Vec::new();
    for ((left_id, right_id), signal_map) in signals {
        let mut pair_signals = signal_map.into_values().collect::<Vec<_>>();
        pair_signals.sort_by(|left, right| {
            compare_duplicate_strings(&signal_sort_key(left), &signal_sort_key(right))
        });
        let bytes = serde_json::to_vec(&DuplicateReviewSeed {
            version: 1,
            left_id: &left_id,
            right_id: &right_id,
            signals: &pair_signals,
        })
        .map_err(|_| crate::app_error!("invalid-stored-data"))?;
        let review_token = hex::encode(Sha256::digest(bytes));
        candidates.push(DuplicateCandidate {
            left: items
                .get(&left_id)
                .cloned()
                .ok_or_else(|| crate::app_error!("invalid-stored-data"))?,
            right: items
                .get(&right_id)
                .cloned()
                .ok_or_else(|| crate::app_error!("invalid-stored-data"))?,
            signals: pair_signals,
            review_token,
        });
    }
    candidates.sort_by(|left, right| {
        compare_duplicate_strings(
            &signal_sort_key(&left.signals[0]),
            &signal_sort_key(&right.signals[0]),
        )
        .then_with(|| {
            compare_duplicate_strings(
                &normalize_duplicate_text(&left.left.title),
                &normalize_duplicate_text(&right.left.title),
            )
        })
        .then_with(|| {
            compare_duplicate_strings(
                &normalize_duplicate_text(&left.right.title),
                &normalize_duplicate_text(&right.right.title),
            )
        })
        .then_with(|| compare_duplicate_strings(&left.left.id, &right.left.id))
        .then_with(|| compare_duplicate_strings(&left.right.id, &right.right.id))
    });
    Ok((
        candidates,
        DuplicateScanSummary {
            files_hashed,
            fingerprints_reused,
            unreadable_formats,
        },
    ))
}
