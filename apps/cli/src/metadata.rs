use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use flate2::read::{DeflateDecoder, ZlibDecoder};
use regex::bytes::Regex;
use roxmltree::Document;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tempfile::Builder;

use crate::candidate_cover::CapturedCover;
use crate::model::BookAuthor;
use crate::output::{AppError, AppResult};

const MAX_OPF_BYTES: u64 = 2 * 1024 * 1024;
const MAX_COVER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES: u64 = 4 * 1024 * 1024;
// ponytail: larger PDFs are not counted, so folder imports keep them as books.
const MAX_PDF_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PDF_INFLATED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverSummary {
    pub media_type: String,
    pub extension: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedCover {
    pub path: PathBuf,
    pub media_type: &'static str,
    pub extension: &'static str,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedMetadata {
    pub source_path: PathBuf,
    pub metadata: Value,
    pub cover: Option<CoverSummary>,
    #[serde(skip)]
    pub(crate) cover_data: Option<CapturedCover>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FetchedMetadata {
    pub metadata: Value,
    pub cover: Option<PublishedCover>,
    #[serde(skip)]
    pub(crate) cover_data: Option<CapturedCover>,
}

#[must_use]
pub fn discover_ebook_meta() -> Option<PathBuf> {
    discover_executable(
        "TAKIO_EBOOK_META",
        "ebook-meta",
        "/Applications/calibre.app/Contents/MacOS/ebook-meta",
    )
}

#[must_use]
pub fn discover_fetch_ebook_metadata() -> Option<PathBuf> {
    discover_executable(
        "TAKIO_FETCH_EBOOK_METADATA",
        "fetch-ebook-metadata",
        "/Applications/calibre.app/Contents/MacOS/fetch-ebook-metadata",
    )
}

pub fn extract(source: &Path, timeout: Duration) -> AppResult<ExtractedMetadata> {
    extract_with_cancellation(source, timeout, None)
}

pub fn extract_cancellable(
    source: &Path,
    timeout: Duration,
    canceled: &AtomicBool,
) -> AppResult<ExtractedMetadata> {
    extract_with_cancellation(source, timeout, Some(canceled))
}

fn extract_with_cancellation(
    source: &Path,
    timeout: Duration,
    canceled: Option<&AtomicBool>,
) -> AppResult<ExtractedMetadata> {
    if timeout.is_zero() {
        return Err(AppError::new("invalid-arguments"));
    }
    let backend = discover_ebook_meta().ok_or_else(|| AppError::new("backend-unavailable"))?;
    let source = source
        .canonicalize()
        .map_err(|_| AppError::new("source-unavailable"))?;
    if !source.is_file() || source.metadata().map_or(true, |value| value.len() == 0) {
        return Err(AppError::new("source-unavailable"));
    }
    let workspace = Builder::new()
        .prefix("takio-metadata-")
        .tempdir()
        .map_err(|_| AppError::new("metadata-invalid"))?;
    let opf = workspace.path().join("metadata.opf");
    let cover = workspace.path().join("cover");
    let mut command = Command::new(backend);
    command
        .arg(&source)
        .arg(format!("--to-opf={}", opf.display()))
        .arg(format!("--get-cover={}", cover.display()))
        .arg("--disallow-rendered-cover")
        .current_dir(workspace.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    run_bounded(
        &mut command,
        timeout,
        "metadata-extraction-failed",
        canceled,
    )?;
    let metadata = parse_opf(&read_bounded(&opf, MAX_OPF_BYTES)?)?;
    let cover_data =
        optional_cover_data(&cover)?.map(|(bytes, extension, media_type)| CapturedCover {
            bytes,
            extension: extension.to_owned(),
            media_type: media_type.to_owned(),
        });
    let cover = cover_data.as_ref().map(|cover| CoverSummary {
        media_type: cover.media_type.clone(),
        extension: cover.extension.clone(),
        bytes: cover.bytes.len() as u64,
    });
    Ok(ExtractedMetadata {
        source_path: source,
        metadata,
        cover,
        cover_data,
    })
}

pub fn fetch(
    title: Option<&str>,
    authors: &[String],
    identifiers: &BTreeMap<String, String>,
    cover_output: Option<&Path>,
    timeout: Duration,
) -> AppResult<FetchedMetadata> {
    fetch_with_cancellation(
        title,
        authors,
        identifiers,
        cover_output,
        timeout,
        None,
        false,
    )
}

pub fn fetch_cancellable(
    title: Option<&str>,
    authors: &[String],
    identifiers: &BTreeMap<String, String>,
    cover_output: Option<&Path>,
    timeout: Duration,
    canceled: &AtomicBool,
) -> AppResult<FetchedMetadata> {
    fetch_with_cancellation(
        title,
        authors,
        identifiers,
        cover_output,
        timeout,
        Some(canceled),
        false,
    )
}

pub(crate) fn fetch_candidate_cancellable(
    title: Option<&str>,
    authors: &[String],
    identifiers: &BTreeMap<String, String>,
    timeout: Duration,
    canceled: &AtomicBool,
) -> AppResult<FetchedMetadata> {
    fetch_with_cancellation(
        title,
        authors,
        identifiers,
        None,
        timeout,
        Some(canceled),
        true,
    )
}

fn fetch_with_cancellation(
    title: Option<&str>,
    authors: &[String],
    identifiers: &BTreeMap<String, String>,
    cover_output: Option<&Path>,
    timeout: Duration,
    canceled: Option<&AtomicBool>,
    capture_cover: bool,
) -> AppResult<FetchedMetadata> {
    let title = title.map(str::trim).filter(|value| !value.is_empty());
    if timeout.is_zero()
        || authors.iter().any(|value| value.trim().is_empty())
        || (title.is_none() && authors.is_empty() && !identifiers.contains_key("isbn"))
        || identifiers.iter().any(|(key, value)| {
            key.trim().is_empty() || key.contains(':') || value.trim().is_empty()
        })
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let backend =
        discover_fetch_ebook_metadata().ok_or_else(|| AppError::new("backend-unavailable"))?;
    let workspace = Builder::new()
        .prefix("takio-metadata-fetch-")
        .tempdir()
        .map_err(|_| AppError::new("metadata-fetch-failed"))?;
    let opf = workspace.path().join("metadata.opf");
    let cover = workspace.path().join("cover");
    let stdout = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&opf)
        .map_err(|_| AppError::new("metadata-fetch-failed"))?;
    let mut command = Command::new(backend);
    command.arg("--opf");
    if let Some(title) = title {
        command.arg(format!("--title={title}"));
    }
    if !authors.is_empty() {
        command.arg(format!("--authors={}", authors.join(" & ")));
    }
    if let Some(isbn) = identifiers.get("isbn") {
        command.arg(format!("--isbn={isbn}"));
    }
    for (kind, value) in identifiers {
        if kind != "isbn" {
            command.arg(format!("--identifier={kind}:{value}"));
        }
    }
    if cover_output.is_some() || capture_cover {
        command.arg(format!("--cover={}", cover.display()));
    }
    command
        .arg(format!("--timeout={}", timeout.as_secs().max(1)))
        .current_dir(workspace.path())
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null());
    run_bounded(&mut command, timeout, "metadata-fetch-failed", canceled)?;
    let metadata = parse_opf(&read_bounded(&opf, MAX_OPF_BYTES)?)?;
    let captured =
        optional_cover_data(&cover)?.map(|(bytes, extension, media_type)| CapturedCover {
            bytes,
            extension: extension.to_owned(),
            media_type: media_type.to_owned(),
        });
    let cover = match (&captured, cover_output) {
        (Some(captured), Some(output)) => Some(publish_cover(
            output,
            &captured.bytes,
            Box::leak(captured.extension.clone().into_boxed_str()),
            Box::leak(captured.media_type.clone().into_boxed_str()),
        )?),
        _ => None,
    };
    Ok(FetchedMetadata {
        metadata,
        cover,
        cover_data: captured,
    })
}

pub fn parse_opf(bytes: &[u8]) -> AppResult<Value> {
    let source = std::str::from_utf8(bytes).map_err(|_| AppError::new("metadata-invalid"))?;
    let document = Document::parse(source).map_err(|_| AppError::new("metadata-invalid"))?;
    let metadata = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "metadata")
        .ok_or_else(|| AppError::new("metadata-invalid"))?;
    let mut patch = Map::new();
    let children = metadata.children().filter(roxmltree::Node::is_element);
    let nodes = children.collect::<Vec<_>>();
    if let Some(value) = first_text(&nodes, "title") {
        patch.insert("title".to_owned(), json!(value));
    }
    let authors = nodes
        .iter()
        .filter(|node| node.tag_name().name() == "creator")
        .filter(|node| {
            attribute(node, "role").is_none_or(|value| value.eq_ignore_ascii_case("aut"))
        })
        .filter_map(|node| {
            normalized_text(node.text()).map(|name| {
                let mut author = Map::new();
                author.insert("name".to_owned(), json!(name));
                if let Some(sort_name) = attribute(node, "file-as") {
                    author.insert("sortName".to_owned(), json!(sort_name));
                }
                Value::Object(author)
            })
        })
        .collect::<Vec<_>>();
    if !authors.is_empty() {
        patch.insert("authors".to_owned(), Value::Array(authors));
    }
    for (target, source) in [("publisher", "publisher"), ("description", "description")] {
        if let Some(value) = first_text(&nodes, source) {
            patch.insert(target.to_owned(), json!(value));
        }
    }
    let tags = unique_texts(&nodes, "subject");
    patch.insert("tags".to_owned(), json!(tags));
    let languages = unique_texts(&nodes, "language")
        .into_iter()
        .map(|value| value.replace('_', "-"))
        .collect::<Vec<_>>();
    if !languages.is_empty() {
        patch.insert("languages".to_owned(), json!(languages));
    }
    let mut identifiers = BTreeMap::new();
    for node in nodes
        .iter()
        .filter(|node| node.tag_name().name() == "identifier")
    {
        if let (Some(kind), Some(value)) = (attribute(node, "scheme"), normalized_text(node.text()))
        {
            identifiers
                .entry(kind.to_ascii_lowercase())
                .or_insert(value);
        }
    }
    if !identifiers.is_empty() {
        patch.insert("identifiers".to_owned(), json!(identifiers));
    }
    if let Some(value) = first_text(&nodes, "date").and_then(normalize_date) {
        patch.insert("publishedDate".to_owned(), json!(value));
    }
    for node in nodes.iter().filter(|node| node.tag_name().name() == "meta") {
        let Some(name) = attribute(node, "name") else {
            continue;
        };
        let Some(content) = attribute(node, "content") else {
            continue;
        };
        match name.to_ascii_lowercase().as_str() {
            "calibre:series" => {
                patch.insert("series".to_owned(), json!(content));
            }
            "calibre:series_index" => {
                if let Ok(value) = content.parse::<f64>()
                    && value.is_finite()
                {
                    patch.insert("seriesIndex".to_owned(), json!(value));
                }
            }
            "calibre:rating" => {
                if let Ok(value) = content.parse::<f64>()
                    && value.is_finite()
                    && (0.0..=10.0).contains(&value)
                {
                    patch.insert("rating".to_owned(), json!(value));
                }
            }
            _ => {}
        }
    }
    Ok(Value::Object(patch))
}

fn first_text(nodes: &[roxmltree::Node<'_, '_>], name: &str) -> Option<String> {
    nodes
        .iter()
        .find(|node| node.tag_name().name() == name)
        .and_then(|node| normalized_text(node.text()))
}

fn unique_texts(nodes: &[roxmltree::Node<'_, '_>], name: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    nodes
        .iter()
        .filter(|node| node.tag_name().name() == name)
        .filter_map(|node| normalized_text(node.text()))
        .filter(|value| seen.insert(value.to_ascii_lowercase()))
        .collect()
}

fn normalized_text(value: Option<&str>) -> Option<String> {
    let value = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

fn attribute(node: &roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .and_then(|attribute| normalized_text(Some(attribute.value())))
}

fn normalize_date(value: String) -> Option<String> {
    let bytes = value.as_bytes();
    let length = if bytes.get(4) == Some(&b'-') && bytes.get(7) == Some(&b'-') {
        10
    } else if bytes.get(4) == Some(&b'-') {
        7
    } else {
        4
    };
    let candidate = value.get(..length)?;
    candidate
        .chars()
        .enumerate()
        .all(|(index, value)| {
            matches!(index, 4 | 7) && value == '-'
                || !matches!(index, 4 | 7) && value.is_ascii_digit()
        })
        .then(|| candidate.to_owned())
}

/// Title and authors from an EPUB's own OPF, read without an external backend.
/// Missing, malformed, or placeholder metadata yields `(None, [])`.
#[must_use]
pub fn embedded_epub(path: &Path) -> (Option<String>, Vec<BookAuthor>) {
    let Some(metadata) = read_epub_opf(path).and_then(|opf| parse_opf(&opf).ok()) else {
        return (None, Vec::new());
    };
    let placeholder = |value: &str| matches!(value.to_lowercase().as_str(), "unknown" | "untitled");
    let title = metadata["title"]
        .as_str()
        .filter(|value| !placeholder(value))
        .map(str::to_owned);
    let authors = serde_json::from_value::<Vec<BookAuthor>>(metadata["authors"].clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|author| !placeholder(&author.name))
        .collect();
    (title, authors)
}

/// Largest first record read from a MOBI-family file. Real headers with EXTH are a
/// few KiB; on the user's Kindle the furthest EXTH end was under 5 KiB.
const MAX_MOBI_RECORD_BYTES: u64 = 64 * 1024;
const MOBI_EXTH_AUTHOR: u32 = 100;
const MOBI_EXTH_UPDATED_TITLE: u32 = 503;

/// Title and authors from a MOBI, AZW or AZW3 file's own header, read without an
/// external backend. Only the first record is read, at most 64 KiB, and every offset is
/// checked. Anything malformed, encrypted or not a `BOOKMOBI` file yields `(None, [])`.
#[must_use]
pub fn embedded_mobi(path: &Path) -> (Option<String>, Vec<BookAuthor>) {
    read_mobi_header(path).unwrap_or_default()
}

fn read_mobi_header(path: &Path) -> Option<(Option<String>, Vec<BookAuthor>)> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    // PalmDB header (78 bytes), then 8-byte entries whose first 4 bytes are offsets.
    let palm = read_at(&mut file, 0, 78)?;
    let records = be_bytes(&palm, 76, 2)?;
    if palm.get(60..68)? != b"BOOKMOBI" || records == 0 {
        return None;
    }
    let list = read_at(&mut file, 78, 8 * records.min(2))?;
    let start = be_bytes(&list, 0, 4)?;
    let next = if records > 1 {
        be_bytes(&list, 8, 4)?
    } else {
        length
    };
    let end = next
        .min(length)
        .min(start.checked_add(MAX_MOBI_RECORD_BYTES)?);
    if start >= end {
        return None;
    }
    let record = read_at(&mut file, start, end - start)?;
    // PalmDOC header, then the MOBI header. Encrypted books are left to the filename.
    if record.get(16..20)? != b"MOBI" || be_bytes(&record, 12, 2)? != 0 {
        return None;
    }
    let decode = |bytes: &[u8]| -> Option<String> {
        let text = match be_bytes(&record, 28, 4)? {
            65001 => String::from_utf8(bytes.to_vec()).ok()?,
            1252 => bytes.iter().map(|&byte| cp1252(byte)).collect(),
            _ => return None,
        };
        let text = text.trim_matches(char::from(0)).trim();
        (!text.is_empty()).then(|| text.to_owned())
    };
    let placeholder = |value: &str| {
        matches!(
            value.to_lowercase().as_str(),
            "unknown" | "untitled" | "anonymous" | "unknown author"
        )
    };
    let header_length = usize::try_from(be_bytes(&record, 20, 4)?).ok()?;
    let mut title = None;
    let mut authors = Vec::new();
    let has_exth = be_bytes(&record, 128, 4).is_some_and(|flags| flags & 0x40 != 0);
    let exth = 16_usize.checked_add(header_length)?;
    if has_exth && record.get(exth..exth.checked_add(4)?) == Some(b"EXTH") {
        let count = be_bytes(&record, exth + 8, 4)?;
        let mut at = exth + 12;
        for _ in 0..count {
            let (Some(kind), Some(size)) = (be_bytes(&record, at, 4), be_bytes(&record, at + 4, 4))
            else {
                break;
            };
            let size = usize::try_from(size).ok()?;
            let Some(value) = size
                .checked_sub(8)
                .and_then(|data| record.get(at + 8..at.checked_add(8 + data)?))
            else {
                break;
            };
            match u32::try_from(kind).ok()? {
                MOBI_EXTH_AUTHOR => {
                    if let Some(name) = decode(value).filter(|name| !placeholder(name))
                        && !authors.iter().any(|known: &BookAuthor| known.name == name)
                    {
                        authors.push(BookAuthor {
                            name,
                            sort_name: None,
                        });
                    }
                }
                MOBI_EXTH_UPDATED_TITLE if title.is_none() => title = decode(value),
                _ => {}
            }
            at += size;
        }
    }
    if title.is_none() {
        let offset = usize::try_from(be_bytes(&record, 84, 4)?).ok()?;
        let length = usize::try_from(be_bytes(&record, 88, 4)?).ok()?;
        title = record
            .get(offset..offset.checked_add(length)?)
            .and_then(decode);
    }
    Some((title.filter(|title| !placeholder(title)), authors))
}

fn be_bytes(bytes: &[u8], at: usize, width: usize) -> Option<u64> {
    let field = bytes.get(at..at.checked_add(width)?)?;
    Some(
        field
            .iter()
            .fold(0_u64, |value, &byte| (value << 8) | u64::from(byte)),
    )
}

/// Windows-1252, the other text encoding MOBI headers declare.
fn cp1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20ac}', '\u{fffd}', '\u{201a}', '\u{0192}', '\u{201e}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02c6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{fffd}',
        '\u{017d}', '\u{fffd}', '\u{fffd}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02dc}', '\u{2122}', '\u{0161}', '\u{203a}',
        '\u{0153}', '\u{fffd}', '\u{017e}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9f => HIGH[usize::from(byte - 0x80)],
        _ => char::from(byte),
    }
}

fn read_epub_opf(path: &Path) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    let directory = zip_directory(&mut file)?;
    let container = zip_entry(&mut file, &directory, "META-INF/container.xml")?;
    let container = Document::parse(std::str::from_utf8(&container).ok()?).ok()?;
    let opf_path = container
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")?
        .attribute("full-path")?
        .to_owned();
    zip_entry(&mut file, &directory, &opf_path)
}

// ponytail: minimal zip reader for two small EPUB entries; no zip64, encryption or CRC checks.
// Swap in the `zip` crate if real EPUBs need more.
fn zip_directory(file: &mut fs::File) -> Option<Vec<u8>> {
    let length = file.metadata().ok()?.len();
    let tail_length = length.min(22 + 65_535);
    let tail = read_at(file, length - tail_length, tail_length)?;
    let end = tail
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")?;
    let size = le_bytes(&tail, end + 12, 4)?;
    if size > MAX_ZIP_DIRECTORY_BYTES {
        return None;
    }
    read_at(file, le_bytes(&tail, end + 16, 4)?, size)
}

fn zip_entry(file: &mut fs::File, directory: &[u8], name: &str) -> Option<Vec<u8>> {
    let mut at = 0;
    while directory.get(at..at + 4)? == b"PK\x01\x02" {
        let name_length = usize::try_from(le_bytes(directory, at + 28, 2)?).ok()?;
        if directory.get(at + 46..at + 46 + name_length)? == name.as_bytes() {
            let compressed = le_bytes(directory, at + 20, 4)?;
            if le_bytes(directory, at + 8, 2)? & 1 != 0 || compressed > MAX_OPF_BYTES {
                return None;
            }
            let local = le_bytes(directory, at + 42, 4)?;
            let header = read_at(file, local, 30)?;
            if header.get(..4)? != b"PK\x03\x04" {
                return None;
            }
            let data = local + 30 + le_bytes(&header, 26, 2)? + le_bytes(&header, 28, 2)?;
            let raw = read_at(file, data, compressed)?;
            return match le_bytes(directory, at + 10, 2)? {
                0 => Some(raw),
                8 => {
                    let mut inflated = Vec::new();
                    DeflateDecoder::new(raw.as_slice())
                        .take(MAX_OPF_BYTES)
                        .read_to_end(&mut inflated)
                        .ok()?;
                    Some(inflated)
                }
                _ => None,
            };
        }
        let extra = le_bytes(directory, at + 30, 2)? + le_bytes(directory, at + 32, 2)?;
        at += 46 + name_length + usize::try_from(extra).ok()?;
    }
    None
}

fn le_bytes(bytes: &[u8], at: usize, width: usize) -> Option<u64> {
    let field = bytes.get(at..at + width)?;
    Some(
        field
            .iter()
            .rev()
            .fold(0, |value, byte| value << 8 | u64::from(*byte)),
    )
}

fn read_at(file: &mut fs::File, offset: u64, length: u64) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.take(length).read_to_end(&mut bytes).ok()?;
    (u64::try_from(bytes.len()).ok()? == length).then_some(bytes)
}

/// Page count read from raw PDF bytes, or `None` when it cannot be seen.
// ponytail: byte heuristics instead of a PDF parser: the linearization `/N`, then plain
// `/Type /Page` objects plus those inside bounded FlateDecode object streams. Incremental
// updates can overcount; other filters or encryption hide pages. Use a parser if this misleads.
#[must_use]
pub fn pdf_page_count(path: &Path) -> Option<usize> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_PDF_SCAN_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_PDF_SCAN_BYTES).read_to_end(&mut bytes).ok()?;
    let linearized = Regex::new(r"(?s-u)/Linearized\b.{0,300}?/N\s+(\d+)").expect("valid regex");
    if let Some(captures) = linearized.captures(&bytes[..bytes.len().min(2048)]) {
        return std::str::from_utf8(&captures[1]).ok()?.parse().ok();
    }
    let page = Regex::new(r"(?-u)/Type\s*/Page\b").expect("valid regex");
    let object_stream = Regex::new(r"(?s-u)/Type\s*/ObjStm\b.*?stream\r?\n").expect("valid regex");
    let mut pages = page.find_iter(&bytes).count();
    let mut budget = MAX_PDF_INFLATED_BYTES;
    for stream in object_stream.find_iter(&bytes) {
        let rest = &bytes[stream.end()..];
        let Some(end) = rest.windows(9).position(|window| window == b"endstream") else {
            continue;
        };
        let mut inflated = Vec::new();
        // A truncated or non-Flate stream still contributes whatever inflated cleanly.
        let _ = ZlibDecoder::new(&rest[..end])
            .take(budget)
            .read_to_end(&mut inflated);
        pages += page.find_iter(&inflated).count();
        budget -= u64::try_from(inflated.len()).ok()?;
        if budget == 0 {
            break;
        }
    }
    (pages > 0).then_some(pages)
}

fn optional_cover_data(path: &Path) -> AppResult<Option<(Vec<u8>, &'static str, &'static str)>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_bounded(path, MAX_COVER_BYTES)?;
    let kind = detect_cover(&bytes);
    Ok(kind.map(|(extension, media_type)| (bytes, extension, media_type)))
}

fn detect_cover(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some((".jpg", "image/jpeg"))
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some((".png", "image/png"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some((".gif", "image/gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some((".webp", "image/webp"))
    } else {
        None
    }
}

fn publish_cover(
    output: &Path,
    bytes: &[u8],
    extension: &'static str,
    media_type: &'static str,
) -> AppResult<PublishedCover> {
    let parent = output
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let output = parent.join(
        output
            .file_name()
            .ok_or_else(|| AppError::new("invalid-arguments"))?,
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .map_err(|_| {
            AppError::new(if output.exists() {
                "cover-output-exists"
            } else {
                "cover-write-failed"
            })
        })?;
    if file.write_all(bytes).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(&output);
        return Err(AppError::new("cover-write-failed"));
    }
    let mut hash = Sha256::new();
    hash.update(bytes);
    Ok(PublishedCover {
        path: output,
        media_type,
        extension,
        bytes: u64::try_from(bytes.len()).map_err(|_| AppError::new("cover-write-failed"))?,
        sha256: hex::encode(hash.finalize()),
    })
}

fn read_bounded(path: &Path, maximum: u64) -> AppResult<Vec<u8>> {
    let metadata = path
        .metadata()
        .map_err(|_| AppError::new("metadata-invalid"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > maximum {
        return Err(AppError::new("metadata-invalid"));
    }
    let mut file = fs::File::open(path).map_err(|_| AppError::new("metadata-invalid"))?;
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| AppError::new("metadata-invalid"))?,
    );
    file.read_to_end(&mut bytes)
        .map_err(|_| AppError::new("metadata-invalid"))?;
    if u64::try_from(bytes.len()).ok() != Some(metadata.len()) {
        return Err(AppError::new("metadata-invalid"));
    }
    Ok(bytes)
}

fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    failure: &'static str,
    canceled: Option<&AtomicBool>,
) -> AppResult<()> {
    if canceled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(AppError::new("operation-canceled"));
    }
    let mut child = command
        .spawn()
        .map_err(|_| AppError::new("backend-unavailable"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|_| AppError::new(failure))? {
            return if status.success() {
                Ok(())
            } else {
                Err(AppError::new(failure))
            };
        }
        if canceled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            terminate_and_reap(&mut child);
            return Err(AppError::new("operation-canceled"));
        }
        if started.elapsed() >= timeout {
            terminate_and_reap(&mut child);
            return Err(AppError::new("metadata-timeout"));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn terminate_and_reap(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn discover_executable(env_name: &str, name: &str, macos_path: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(env_name).map(PathBuf::from) {
        return executable(&path).then_some(path);
    }
    if let Some(path) = std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| executable(candidate))
    }) {
        return Some(path);
    }
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from(macos_path);
        if executable(&path) {
            return Some(path);
        }
    }
    let _ = macos_path;
    None
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Builds a zip whose first entry is stored and the rest deflated, like an EPUB.
#[cfg(test)]
pub(crate) fn zip_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::{Compression, write::DeflateEncoder};

    let (mut zip, mut directory) = (Vec::new(), Vec::new());
    for (index, (name, data)) in entries.iter().enumerate() {
        let (method, body) = if index == 0 {
            (0_u16, data.to_vec())
        } else {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data).unwrap();
            (8, encoder.finish().unwrap())
        };
        let mut fields = method.to_le_bytes().to_vec();
        fields.extend([0; 8]);
        fields.extend(u32::try_from(body.len()).unwrap().to_le_bytes());
        fields.extend(u32::try_from(data.len()).unwrap().to_le_bytes());
        fields.extend(u16::try_from(name.len()).unwrap().to_le_bytes());
        fields.extend([0; 2]);
        let offset = u32::try_from(zip.len()).unwrap();
        zip.extend(b"PK\x03\x04\x14\0\0\0");
        zip.extend(&fields);
        zip.extend(name.as_bytes());
        zip.extend(&body);
        directory.extend(b"PK\x01\x02\x14\0\x14\0\0\0");
        directory.extend(&fields);
        directory.extend([0; 10]);
        directory.extend(offset.to_le_bytes());
        directory.extend(name.as_bytes());
    }
    let count = u16::try_from(entries.len()).unwrap().to_le_bytes();
    let offset = u32::try_from(zip.len()).unwrap();
    zip.extend(&directory);
    zip.extend(b"PK\x05\x06\0\0\0\0");
    zip.extend(count);
    zip.extend(count);
    zip.extend(u32::try_from(directory.len()).unwrap().to_le_bytes());
    zip.extend(offset.to_le_bytes());
    zip.extend([0; 2]);
    zip
}

#[cfg(test)]
pub(crate) fn epub_fixture(metadata: &str) -> Vec<u8> {
    let container = br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
    let opf = format!(
        r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{metadata}</metadata></package>"#
    );
    zip_fixture(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", container),
        ("OEBPS/content.opf", opf.as_bytes()),
    ])
}

/// A minimal `BOOKMOBI` file: PalmDB header, two records, and a MOBI header with
/// optional EXTH records `(type, bytes)` in the declared text encoding.
#[cfg(test)]
pub(crate) fn mobi_fixture(encoding: u32, full_name: &[u8], exth: &[(u32, &[u8])]) -> Vec<u8> {
    let mut header = vec![0_u8; 16 + 232];
    header[0..2].copy_from_slice(&2_u16.to_be_bytes());
    header[16..20].copy_from_slice(b"MOBI");
    header[20..24].copy_from_slice(&232_u32.to_be_bytes());
    header[28..32].copy_from_slice(&encoding.to_be_bytes());
    header[36..40].copy_from_slice(&6_u32.to_be_bytes());
    let flags: u32 = if exth.is_empty() { 0 } else { 0x40 };
    header[128..132].copy_from_slice(&flags.to_be_bytes());
    let mut body = Vec::new();
    if !exth.is_empty() {
        let mut records = Vec::new();
        for (kind, value) in exth {
            records.extend(kind.to_be_bytes());
            records.extend(u32::try_from(value.len() + 8).unwrap().to_be_bytes());
            records.extend(*value);
        }
        body.extend(b"EXTH");
        body.extend(u32::try_from(records.len() + 12).unwrap().to_be_bytes());
        body.extend(u32::try_from(exth.len()).unwrap().to_be_bytes());
        body.extend(records);
    }
    let name_offset = u32::try_from(header.len() + body.len()).unwrap();
    header[84..88].copy_from_slice(&name_offset.to_be_bytes());
    header[88..92].copy_from_slice(&u32::try_from(full_name.len()).unwrap().to_be_bytes());
    let mut record0 = header;
    record0.extend(body);
    record0.extend(full_name);
    record0.extend([0, 0]);
    let text = b"book text record".to_vec();
    let first = 78 + 2 * 8 + 2;
    let second = first + record0.len();
    let mut file = vec![0_u8; 78];
    file[0..8].copy_from_slice(b"fixture\0");
    file[60..68].copy_from_slice(b"BOOKMOBI");
    file[76..78].copy_from_slice(&2_u16.to_be_bytes());
    for (index, offset) in [first, second].into_iter().enumerate() {
        file.extend(u32::try_from(offset).unwrap().to_be_bytes());
        file.extend(u32::try_from(index * 2).unwrap().to_be_bytes());
    }
    file.extend([0, 0]);
    file.extend(record0);
    file.extend(text);
    file
}

#[cfg(test)]
pub(crate) fn pdf_fixture(pages: usize) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n2 0 obj<</Type /Pages/Count 0>>endobj\n".to_vec();
    for _ in 0..pages {
        pdf.extend(b"3 0 obj<</Type /Page/Parent 2 0 R>>endobj\n");
    }
    pdf.extend(b"%%EOF\n");
    pdf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mobi_exth_authors_and_title_without_a_backend() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("Some Download - Mangled Name.mobi");
        let read = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            embedded_mobi(&path)
        };
        let names = |authors: &[BookAuthor]| {
            authors
                .iter()
                .map(|author| author.name.clone())
                .collect::<Vec<_>>()
        };

        // UTF-8: several authors in order, duplicates and placeholders dropped, and the
        // EXTH 503 title preferred over the truncated full name.
        let (title, authors) = read(&mobi_fixture(
            65001,
            b"The Quiet S",
            &[
                (100, "Jane Ex\u{e1}mple".as_bytes()),
                (101, b"A Publisher"),
                (100, b"Unknown"),
                (100, b"Ann Other"),
                (100, "Jane Ex\u{e1}mple".as_bytes()),
                (503, "The Quiet Sea \u{2014} Notes".as_bytes()),
                (503, b"Second Title Ignored"),
            ],
        ));
        assert_eq!(title.as_deref(), Some("The Quiet Sea \u{2014} Notes"));
        assert_eq!(names(&authors), ["Jane Ex\u{e1}mple", "Ann Other"]);

        // CP1252: 0xE9 is e-acute and 0x92 a right quote, not invalid UTF-8.
        let (title, authors) = read(&mobi_fixture(
            1252,
            b"Caf\xe9 Book",
            &[(100, b"O\x92Brien")],
        ));
        assert_eq!(
            title.as_deref(),
            Some("Caf\u{e9} Book"),
            "full name used without 503"
        );
        assert_eq!(names(&authors), ["O\u{2019}Brien"]);

        // No EXTH: the full name is the title and there are no authors.
        let (title, authors) = read(&mobi_fixture(65001, b"Plain Title", &[]));
        assert_eq!((title.as_deref(), authors.len()), (Some("Plain Title"), 0));

        // Placeholder only.
        let (title, authors) = read(&mobi_fixture(65001, b"Unknown", &[(100, b"anonymous")]));
        assert_eq!((title, authors.len()), (None, 0));
    }

    #[test]
    fn malformed_mobi_headers_yield_nothing_and_never_read_out_of_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("broken.mobi");
        let good = mobi_fixture(65001, b"Fine", &[(100, b"Jane Example")]);
        let empty = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            let (title, authors) = embedded_mobi(&path);
            title.is_none() && authors.is_empty()
        };
        let mut not_mobi = good.clone();
        not_mobi[60..68].copy_from_slice(b"TEXtREAd");
        let mut encrypted = good.clone();
        encrypted[96 + 12..96 + 14].copy_from_slice(&2_u16.to_be_bytes());
        let mut unknown_encoding = good.clone();
        unknown_encoding[96 + 28..96 + 32].copy_from_slice(&932_u32.to_be_bytes());
        let mut past_end = good.clone();
        past_end[78..82].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut no_records = good.clone();
        no_records[76..78].copy_from_slice(&0_u16.to_be_bytes());
        for broken in [
            &b""[..],
            b"ebook fixture",
            &good[..60],
            &good[..90],
            &not_mobi,
            &encrypted,
            &unknown_encoding,
            &past_end,
            &no_records,
        ] {
            assert!(empty(broken), "{} bytes", broken.len());
        }

        // A huge EXTH count or a record running past the header stops at what is
        // present instead of failing, and a zero-size record cannot loop forever.
        let mut huge_count = good.clone();
        let exth = 96 + 16 + 232;
        huge_count[exth + 8..exth + 12].copy_from_slice(&u32::MAX.to_be_bytes());
        fs::write(&path, &huge_count).unwrap();
        assert_eq!(embedded_mobi(&path).1.len(), 1);
        let mut overlong = good.clone();
        overlong[exth + 16..exth + 20].copy_from_slice(&0x00ff_ffff_u32.to_be_bytes());
        fs::write(&path, &overlong).unwrap();
        let (title, authors) = embedded_mobi(&path);
        assert_eq!((title.as_deref(), authors.len()), (Some("Fine"), 0));
        let mut zero = good.clone();
        zero[exth + 16..exth + 20].copy_from_slice(&0_u32.to_be_bytes());
        fs::write(&path, &zero).unwrap();
        assert_eq!(embedded_mobi(&path).1.len(), 0);

        // The first record is read up to 64 KiB, never the whole book.
        let mut padded = good;
        padded.truncate(padded.len() - b"book text record".len());
        let second = u32::try_from(padded.len() + 1024 * 1024).unwrap();
        padded[86..90].copy_from_slice(&second.to_be_bytes());
        padded.resize(padded.len() + 1024 * 1024 + 16, 0);
        fs::write(&path, &padded).unwrap();
        assert_eq!(embedded_mobi(&path).1.len(), 1);
    }

    #[test]
    fn reads_epub_title_and_authors_without_a_backend() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("download (3).epub");
        fs::write(
            &path,
            epub_fixture(
                r#"<dc:title>The Quiet Sea</dc:title><dc:creator file-as="Example, Jane">Jane Example</dc:creator><dc:creator>Unknown</dc:creator>"#,
            ),
        )
        .unwrap();
        let (title, authors) = embedded_epub(&path);
        assert_eq!(title.as_deref(), Some("The Quiet Sea"));
        assert_eq!(authors.len(), 1);
        assert_eq!(authors[0].name, "Jane Example");
        assert_eq!(authors[0].sort_name.as_deref(), Some("Example, Jane"));

        let empty = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            let (title, authors) = embedded_epub(&path);
            title.is_none() && authors.is_empty()
        };
        assert!(empty(&epub_fixture("<dc:title>Untitled</dc:title>")));
        for broken in [&b"ebook fixture"[..], b"", b"PK\x05\x06"] {
            assert!(empty(broken));
        }
    }

    #[test]
    fn counts_pdf_pages_from_raw_bytes() {
        use flate2::{Compression, write::ZlibEncoder};

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("book.pdf");
        let count = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            pdf_page_count(&path)
        };
        assert_eq!(count(&pdf_fixture(3)), Some(3));
        assert_eq!(count(b"%PDF-1.7\n<</Type /Pages/Count 9>>\n"), None);
        assert_eq!(count(b"not a pdf"), None);

        let mut linearized =
            b"%PDF-1.5\n1 0 obj<</Linearized 1/L 9/H [1 2]/O 3/E 4/N 417/T 5>>endobj\n".to_vec();
        linearized.extend(&pdf_fixture(1));
        assert_eq!(count(&linearized), Some(417));

        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(&b"<</Type/Page/Parent 2 0 R>> ".repeat(60))
            .unwrap();
        let mut compressed =
            b"%PDF-1.5\n5 0 obj<</Type /ObjStm/N 60/First 0/Filter /FlateDecode>>stream\r\n"
                .to_vec();
        compressed.extend(encoder.finish().unwrap());
        compressed.extend(b"\r\nendstream endobj\n");
        compressed.extend(&pdf_fixture(2));
        assert_eq!(count(&compressed), Some(62));
    }

    #[test]
    fn parses_normalized_opf_metadata() {
        let value = parse_opf(
            br#"<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title> Example  Book </dc:title><dc:creator role="aut" file-as="Writer, Ada">Ada Writer</dc:creator><dc:subject>Rust</dc:subject><dc:language>en_US</dc:language><dc:identifier scheme="ISBN">123</dc:identifier><meta name="calibre:series" content="Examples"/></metadata></package>"#,
        )
        .unwrap();
        assert_eq!(value["title"], "Example Book");
        assert_eq!(value["authors"][0]["sortName"], "Writer, Ada");
        assert_eq!(value["languages"][0], "en-US");
        assert_eq!(value["identifiers"]["isbn"], "123");
        assert_eq!(value["series"], "Examples");
    }

    #[test]
    fn recognizes_supported_cover_types() {
        assert_eq!(
            detect_cover(&[0xff, 0xd8, 0xff]),
            Some((".jpg", "image/jpeg"))
        );
        assert_eq!(detect_cover(b"not an image"), None);
    }

    #[cfg(unix)]
    #[test]
    fn requires_executable_permissions_for_external_backends() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let candidate = temp.path().join("ebook-meta");
        std::fs::write(&candidate, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable(&candidate));
        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(executable(&candidate));
    }
}
