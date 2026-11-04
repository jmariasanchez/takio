//! Bounded, best-effort PDF Info metadata. No page-content or XMP extraction.
use std::fs::File;
use std::io::Read;
use std::path::Path;

use lopdf::{Document, LoadOptions, Object};

use crate::library::model::BookAuthor;

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;
const STREAM_BUDGET: usize = 32 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 4096;

/// Read only meaningful title/author strings from the PDF's actual Info dictionary.
/// Encrypted, oversized and unreadable files retain filename metadata. Limits apply
/// to input and each decoded structural stream, not total parser heap or wall time.
/// XMP-only metadata is deliberately excluded. This never modifies the source.
#[must_use]
pub fn embedded_pdf(path: &Path) -> (Option<String>, Vec<BookAuthor>) {
    read_info(path).unwrap_or_default()
}

fn read_info(path: &Path) -> Option<(Option<String>, Vec<BookAuthor>)> {
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES || !bytes.starts_with(b"%PDF-") {
        return None;
    }
    // Count both stream/endstream, including false positives in payloads. Reducing
    // the per-stream cap for stream-heavy files avoids giving every stream 2 MiB.
    // This is a conservative allocation budget, not a process-memory guarantee.
    let streams = bytes
        .windows(6)
        .filter(|word| *word == b"stream")
        .count()
        .max(1);
    let limit = MAX_STREAM_BYTES.min(STREAM_BUDGET / streams);
    if limit == 0 {
        return None;
    }
    let document = Document::load_mem_with_options(
        &bytes,
        LoadOptions {
            strict: true,
            max_decompressed_size: Some(limit),
            ..LoadOptions::default()
        },
    )
    .ok()?;
    if document.is_encrypted() || document.was_encrypted() || document.trailer.has(b"Encrypt") {
        return None;
    }
    let (_, info) = document
        .dereference(document.trailer.get(b"Info").ok()?)
        .ok()?;
    let info = info.as_dict().ok()?;
    let field = |key: &[u8]| -> Option<String> {
        let (_, object) = document.dereference(info.get(key).ok()?).ok()?;
        text(object)
    };
    let producer = field(b"Producer");
    let creator = field(b"Creator");
    let useful = |value: &str| {
        !placeholder(value)
            && !producer
                .as_ref()
                .is_some_and(|other| other.eq_ignore_ascii_case(value))
            && !creator
                .as_ref()
                .is_some_and(|other| other.eq_ignore_ascii_case(value))
    };
    let title = field(b"Title").filter(|value| useful(value) && meaningful_title(value));
    // An Info Author is free text, not a structured name list. Preserve commas
    // (including surname-first names) instead of inventing multiple authors.
    let authors = field(b"Author")
        .filter(|value| useful(value) && value.chars().any(char::is_alphabetic))
        .map(|name| {
            vec![BookAuthor {
                name,
                sort_name: None,
            }]
        })
        .unwrap_or_default();
    Some((title, authors))
}

fn text(object: &Object) -> Option<String> {
    let raw = object.as_str().ok()?;
    if raw.len() > MAX_TEXT_BYTES {
        return None;
    }
    // Reject truncated UTF-16 instead of silently dropping its final byte. Accept
    // little-endian BOMs too, a common nonstandard producer variant.
    let decoded = if raw.starts_with(b"\xff\xfe") || raw.starts_with(b"\xfe\xff") {
        if raw.len() % 2 != 0 {
            return None;
        }
        let little = raw.starts_with(b"\xff\xfe");
        let units = raw[2..]
            .chunks_exact(2)
            .map(|pair| {
                let pair = [pair[0], pair[1]];
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&units).ok()?
    } else {
        // Undefined PDFDocEncoding slots are silently omitted by some decoders.
        // Do not turn damaged strings into apparently valid author names.
        if !raw.starts_with(b"\xef\xbb\xbf")
            && raw
                .iter()
                .any(|byte| matches!(byte, 0..=8 | 11..=12 | 14..=23 | 127 | 159 | 173))
        {
            return None;
        }
        lopdf::decode_text_string(object).ok()?
    };
    if decoded
        .chars()
        .any(|ch| (ch.is_control() && !ch.is_whitespace()) || ch == '\u{fffd}')
    {
        return None;
    }
    let value = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

fn placeholder(value: &str) -> bool {
    matches!(
        value.to_lowercase().as_str(),
        "unknown"
            | "unknown author"
            | "anonymous"
            | "untitled"
            | "none"
            | "null"
            | "n/a"
            | "na"
            | "author"
            | "title"
            | "user"
            | "admin"
            | "administrator"
            | "document"
            | "pdf"
            | "microsoft word"
            | "acrobat"
            | "adobe acrobat"
    )
}

fn meaningful_title(value: &str) -> bool {
    let lower = value.to_lowercase();
    if value.chars().filter(|ch| ch.is_alphabetic()).count() < 3
        || value.contains(['/', '\\'])
        || lower.contains("://")
        || [".pdf", ".doc", ".docx", ".indd", ".ps", ".tex"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
        || [
            "microsoft word",
            "microsoft powerpoint",
            "microsoft excel",
            "adobe acrobat",
            "acrobat",
            "untitled",
            "document",
            "scan",
            "img_",
            "dsc_",
        ]
        .iter()
        .any(|prefix| {
            lower.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty()
                    || rest.starts_with([' ', '-', '_'])
                    || rest.chars().all(|ch| ch.is_ascii_digit())
            })
        })
        || (value.len() >= 16 && value.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-'))
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests;
