use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::conversion::FormatId;
use crate::model::{BookAuthor, CustomColumnDefinition, LibraryItem, Provenance};
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;
use crate::store::{LibraryStore, METADATA_AUDIT_KEY, VerifyReport, normalize_custom_metadata};

const PORTABLE_FORMAT: &str = "takio-portable-library";
const PORTABLE_VERSION: u64 = 2;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PortableManifest {
    format: String,
    version: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    definitions: Vec<CustomColumnDefinition>,
    books: Vec<PortableBook>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PortableBook {
    directory: String,
    artifacts: Vec<PortableArtifact>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PortableArtifact {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug)]
struct ParsedBook {
    item: LibraryItem,
    formats: Vec<(FormatId, PathBuf)>,
    cover: Option<PathBuf>,
}

#[derive(Debug)]
struct ParsedSource {
    definitions: Vec<CustomColumnDefinition>,
    books: Vec<ParsedBook>,
}

impl std::ops::Deref for ParsedSource {
    type Target = [ParsedBook];

    fn deref(&self) -> &Self::Target {
        &self.books
    }
}

pub fn export(store: &LibraryStore, destination: &Path) -> AppResult<serde_json::Value> {
    let destination = absolute_nonempty(destination)?;
    if destination.exists() {
        return Err(AppError::new("destination-exists"));
    }
    let temporary = owned_staging_path(&destination)?;
    let result = export_into(store, &destination, &temporary);
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn export_into(
    store: &LibraryStore,
    destination: &Path,
    temporary: &Path,
) -> AppResult<serde_json::Value> {
    create_private_dir(temporary)?;
    create_private_dir(&temporary.join("books"))?;
    let items = store
        .list(false)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    let mut books = Vec::with_capacity(items.len());
    let mut directories = HashSet::new();
    let mut format_count = 0usize;
    let mut cover_count = 0usize;

    for item in &items {
        if item.formats.is_empty() {
            return Err(AppError::new("storage-unavailable"));
        }
        let directory = safe_book_directory(item);
        if !directories.insert(directory.clone()) {
            return Err(AppError::new("storage-unavailable"));
        }
        let book_root = temporary.join("books").join(&directory);
        create_private_dir(&book_root)?;
        let mut artifacts = Vec::new();
        for format in &item.formats {
            let leaf = format!("book.{}", format.format.as_str());
            artifacts.push(copy_artifact(
                &format.source_path,
                &book_root.join(&leaf),
                &leaf,
            )?);
            format_count += 1;
        }
        let cover_name = item
            .cover_path
            .as_ref()
            .map(|path| {
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
                    Ok(format!("cover.{extension}"))
                } else {
                    Err(AppError::new("storage-unavailable"))
                }
            })
            .transpose()?;
        if let (Some(source), Some(leaf)) = (&item.cover_path, &cover_name) {
            artifacts.push(copy_artifact(source, &book_root.join(leaf), leaf)?);
            cover_count += 1;
        }
        let opf = portable_opf(item, cover_name.as_deref());
        if opf.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(AppError::new("storage-unavailable"));
        }
        let opf_path = book_root.join("metadata.opf");
        write_new_file(&opf_path, opf.as_bytes())?;
        artifacts.push(fingerprint(&opf_path, "metadata.opf")?);
        artifacts.sort_by(|left, right| left.path.cmp(&right.path));
        books.push(PortableBook {
            directory,
            artifacts,
        });
    }

    let manifest = PortableManifest {
        format: PORTABLE_FORMAT.to_owned(),
        version: PORTABLE_VERSION,
        definitions: store.list_custom_column_definitions()?,
        books,
    };
    let mut bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| AppError::new("storage-unavailable"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(AppError::new("storage-unavailable"));
    }
    write_new_file(&temporary.join("manifest.json"), &bytes)?;
    validate_source(temporary).map_err(|_| AppError::new("storage-unavailable"))?;
    if destination.exists() {
        return Err(AppError::new("destination-exists"));
    }
    fs::rename(temporary, destination).map_err(|error| {
        if destination.exists() || error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new("destination-exists")
        } else {
            AppError::new("storage-unavailable")
        }
    })?;
    Ok(
        json!({"export":{"path":destination,"items":items.len(),"formats":format_count,"covers":cover_count}}),
    )
}

pub fn rebuild(source: &Path, paths: LibraryPaths) -> AppResult<serde_json::Value> {
    let source = absolute_nonempty(source)?;
    let destination = paths.root.clone();
    if source == destination || destination.starts_with(&source) {
        return Err(AppError::new("invalid-arguments"));
    }
    if destination.exists() {
        return Err(AppError::new("destination-exists"));
    }
    let parsed = validate_source(&source)?;
    let temporary = owned_staging_path(&destination)?;
    let temporary_database = temporary.join(
        paths
            .database
            .file_name()
            .ok_or_else(|| AppError::new("invalid-arguments"))?,
    );
    let temporary_paths = LibraryPaths::resolve(None, Some(&temporary_database))?;
    let result = rebuild_into(&parsed, &destination, &temporary, temporary_paths);
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn rebuild_into(
    source: &ParsedSource,
    destination: &Path,
    temporary: &Path,
    temporary_paths: LibraryPaths,
) -> AppResult<serde_json::Value> {
    create_private_dir(temporary)?;
    let mut store = LibraryStore::open(temporary_paths.clone(), true)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    store
        .replace_custom_column_definitions(&source.definitions)
        .map_err(|_| AppError::new("source-invalid"))?;
    for book in &source.books {
        store
            .restore_portable_item(&book.item, &book.formats, book.cover.as_deref())
            .map_err(|_| AppError::new("storage-unavailable"))?;
    }
    let report = store
        .verify()
        .map_err(|_| AppError::new("storage-unavailable"))?;
    let final_database = destination.join(
        temporary_paths
            .database
            .file_name()
            .ok_or_else(|| AppError::new("storage-unavailable"))?,
    );
    let final_paths = LibraryPaths::resolve(None, Some(&final_database))?;
    store
        .rebase_portable_paths(&final_paths)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    drop(store);
    if destination.exists() {
        return Err(AppError::new("destination-exists"));
    }
    fs::rename(temporary, destination).map_err(|error| {
        if destination.exists() || error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new("destination-exists")
        } else {
            AppError::new("storage-unavailable")
        }
    })?;
    Ok(json!({"rebuild":{"path":final_database,"report":integrity_value(&report)}}))
}

fn validate_source(root: &Path) -> AppResult<ParsedSource> {
    let root_metadata = fs::symlink_metadata(root).map_err(|_| AppError::new("source-invalid"))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(AppError::new("source-invalid"));
    }
    let manifest: PortableManifest = serde_json::from_slice(&read_bounded_regular(
        &root.join("manifest.json"),
        MAX_DOCUMENT_BYTES,
    )?)
    .map_err(|_| AppError::new("source-invalid"))?;
    if manifest.format != PORTABLE_FORMAT || !matches!(manifest.version, 1 | PORTABLE_VERSION) {
        return Err(AppError::new("source-invalid"));
    }
    if manifest.version == 1 && !manifest.definitions.is_empty() {
        return Err(AppError::new("source-invalid"));
    }
    crate::store::validate_custom_column_definitions(&manifest.definitions)
        .map_err(|_| AppError::new("source-invalid"))?;
    require_exact_entries(root, &["books", "manifest.json"])?;
    let books_root = root.join("books");
    let books_metadata =
        fs::symlink_metadata(&books_root).map_err(|_| AppError::new("source-invalid"))?;
    if !books_metadata.is_dir() || books_metadata.file_type().is_symlink() {
        return Err(AppError::new("source-invalid"));
    }

    let mut directories = HashSet::new();
    for book in &manifest.books {
        if !valid_component(&book.directory) || !directories.insert(book.directory.clone()) {
            return Err(AppError::new("source-invalid"));
        }
    }
    let expected_directories = manifest
        .books
        .iter()
        .map(|book| book.directory.as_str())
        .collect::<Vec<_>>();
    require_exact_entries(&books_root, &expected_directories)?;

    let mut parsed = Vec::with_capacity(manifest.books.len());
    let mut ids = HashSet::new();
    for book in &manifest.books {
        let book_root = books_root.join(&book.directory);
        let metadata =
            fs::symlink_metadata(&book_root).map_err(|_| AppError::new("source-invalid"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || book.artifacts.len() < 2 {
            return Err(AppError::new("source-invalid"));
        }
        let mut leaves = HashSet::new();
        for artifact in &book.artifacts {
            if !valid_leaf(&artifact.path)
                || artifact.bytes == 0
                || artifact.bytes > MAX_SAFE_INTEGER
                || !valid_sha256(&artifact.sha256)
                || !leaves.insert(artifact.path.clone())
            {
                return Err(AppError::new("source-invalid"));
            }
            let actual = fingerprint(&book_root.join(&artifact.path), &artifact.path)
                .map_err(|_| AppError::new("source-invalid"))?;
            if actual.bytes != artifact.bytes || actual.sha256 != artifact.sha256 {
                return Err(AppError::new("source-invalid"));
            }
        }
        if !leaves.contains("metadata.opf") || !leaves.iter().any(|leaf| leaf.starts_with("book."))
        {
            return Err(AppError::new("source-invalid"));
        }
        let expected = book
            .artifacts
            .iter()
            .map(|artifact| artifact.path.as_str())
            .collect::<Vec<_>>();
        require_exact_entries(&book_root, &expected)?;
        let parsed_book = parse_book(&book_root, &leaves)?;
        if !ids.insert(parsed_book.item.id.clone()) {
            return Err(AppError::new("source-invalid"));
        }
        parsed.push(parsed_book);
    }
    Ok(ParsedSource {
        definitions: manifest.definitions,
        books: parsed,
    })
}

fn parse_book(book_root: &Path, artifacts: &HashSet<String>) -> AppResult<ParsedBook> {
    let opf_bytes = read_bounded_regular(&book_root.join("metadata.opf"), MAX_DOCUMENT_BYTES)?;
    let opf = std::str::from_utf8(&opf_bytes).map_err(|_| AppError::new("source-invalid"))?;
    let document = Document::parse(opf).map_err(|_| AppError::new("source-invalid"))?;
    let package = document.root_element();
    if package.tag_name().name() != "package" {
        return Err(AppError::new("source-invalid"));
    }
    let metadata = unique_child(package, "metadata")?;
    let manifest = unique_child(package, "manifest")?;
    let manifest_items = manifest
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "item")
        .collect::<Vec<_>>();
    let mut manifest_ids = HashSet::new();
    for item in &manifest_items {
        let id = required_attr(item, "id")?;
        if !manifest_ids.insert(id) {
            return Err(AppError::new("source-invalid"));
        }
    }
    let identifiers = metadata
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "identifier")
        .collect::<Vec<_>>();
    let takio_ids = identifiers
        .iter()
        .filter(|node| attr(node, "scheme").as_deref() == Some("takio"))
        .filter_map(|node| text(node))
        .collect::<Vec<_>>();
    if takio_ids.len() != 1 {
        return Err(AppError::new("source-invalid"));
    }
    let id = takio_ids[0].clone();
    if !valid_item_id(&id) {
        return Err(AppError::new("source-invalid"));
    }
    let metas = metadata
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "meta")
        .collect::<Vec<_>>();
    let added_at = unique_meta(&metas, "takio:added_at")?;
    let updated_at = optional_unique_meta(&metas, "takio:updated_at")?;
    let order = unique_meta(&metas, "takio:format_order")?;
    let format_names = order.split(',').collect::<Vec<_>>();
    if format_names.is_empty()
        || format_names.iter().any(|value| value.is_empty())
        || format_names.iter().collect::<HashSet<_>>().len() != format_names.len()
    {
        return Err(AppError::new("source-invalid"));
    }
    let mut formats = Vec::with_capacity(format_names.len());
    let mut expected_artifacts = HashSet::from(["metadata.opf".to_owned()]);
    for name in format_names {
        let format: FormatId = name.parse().map_err(|_| AppError::new("source-invalid"))?;
        let leaf = format!("book.{name}");
        let expected_id = format!("format-{name}");
        let entries = manifest_items
            .iter()
            .filter(|item| attr(item, "id").as_deref() == Some(expected_id.as_str()))
            .collect::<Vec<_>>();
        if entries.len() != 1
            || attr(entries[0], "href").as_deref() != Some(leaf.as_str())
            || attr(entries[0], "media-type").as_deref() != Some(media_type(format))
            || !artifacts.contains(&leaf)
        {
            return Err(AppError::new("source-invalid"));
        }
        let format_added_at =
            optional_unique_meta(&metas, &format!("takio:format_added_at:{name}"))?
                .unwrap_or_else(|| added_at.clone());
        if !valid_timestamp(&format_added_at) {
            return Err(AppError::new("source-invalid"));
        }
        expected_artifacts.insert(leaf.clone());
        formats.push((format, book_root.join(leaf), format_added_at));
    }

    let cover_items = manifest_items
        .iter()
        .filter(|item| attr(item, "id").as_deref() == Some("cover-image"))
        .collect::<Vec<_>>();
    if cover_items.len() > 1 {
        return Err(AppError::new("source-invalid"));
    }
    let cover = cover_items
        .first()
        .map(|item| {
            let leaf = required_attr(item, "href")?;
            if !matches!(leaf.as_str(), "cover.jpg" | "cover.jpeg" | "cover.png")
                || !artifacts.contains(&leaf)
                || attr(item, "media-type").as_deref()
                    != Some(if leaf.ends_with(".png") {
                        "image/png"
                    } else {
                        "image/jpeg"
                    })
            {
                return Err(AppError::new("source-invalid"));
            }
            expected_artifacts.insert(leaf.clone());
            Ok(book_root.join(leaf))
        })
        .transpose()?;
    if manifest_items.len() != formats.len() + usize::from(cover.is_some()) {
        return Err(AppError::new("source-invalid"));
    }
    if &expected_artifacts != artifacts {
        return Err(AppError::new("source-invalid"));
    }

    let title = unique_text_child(metadata, "title")?;
    let authors = metadata
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "creator")
        .filter(|node| attr(node, "role").is_none_or(|role| role.eq_ignore_ascii_case("aut")))
        .map(|node| {
            Ok(BookAuthor {
                name: text(&node).ok_or_else(|| AppError::new("source-invalid"))?,
                sort_name: attr(&node, "file-as"),
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let author = authors.first().map(|author| author.name.clone());
    let publisher = optional_unique_text_child(metadata, "publisher")?;
    let description = optional_unique_text_child(metadata, "description")?;
    let languages = text_children(metadata, "language");
    let tags = text_children(metadata, "subject");
    let published_date = optional_unique_text_child(metadata, "date")?;
    let mut identifiers_map = BTreeMap::new();
    for node in identifiers {
        let Some(scheme) = attr(&node, "scheme") else {
            continue;
        };
        if scheme == "takio" {
            continue;
        }
        let value = text(&node).ok_or_else(|| AppError::new("source-invalid"))?;
        let key = scheme.to_ascii_lowercase();
        if identifiers_map.insert(key, value).is_some() {
            return Err(AppError::new("source-invalid"));
        }
    }
    let series = optional_unique_meta(&metas, "calibre:series")?;
    let series_index =
        parse_optional_finite(optional_unique_meta(&metas, "calibre:series_index")?)?;
    let rating = parse_optional_finite(optional_unique_meta(&metas, "calibre:rating")?)?;
    if rating.is_some_and(|value| !(0.0..=10.0).contains(&value)) {
        return Err(AppError::new("source-invalid"));
    }
    let mut custom_metadata = BTreeMap::new();
    for node in &metas {
        let Some(name) = attr(node, "name") else {
            continue;
        };
        let Some(key) = name.strip_prefix("takio:custom:") else {
            continue;
        };
        let value = attr(node, "content").ok_or_else(|| AppError::new("source-invalid"))?;
        if key.is_empty()
            || key == METADATA_AUDIT_KEY
            || custom_metadata.insert(key.to_owned(), value).is_some()
        {
            return Err(AppError::new("source-invalid"));
        }
    }
    let custom_metadata =
        normalize_custom_metadata(custom_metadata).map_err(|_| AppError::new("source-invalid"))?;
    if title.trim().is_empty()
        || !valid_timestamp(&added_at)
        || updated_at
            .as_deref()
            .is_some_and(|value| !valid_timestamp(value))
    {
        return Err(AppError::new("source-invalid"));
    }
    let primary = formats
        .first()
        .ok_or_else(|| AppError::new("source-invalid"))?;
    let item = LibraryItem {
        id,
        title,
        source_path: primary.1.clone(),
        format: primary.0,
        added_at: added_at.clone(),
        formats: formats
            .iter()
            .map(|(format, path, format_added_at)| crate::model::BookFormat {
                source_path: path.clone(),
                format: *format,
                added_at: format_added_at.clone(),
                provenance: Provenance::Referenced,
            })
            .collect(),
        author,
        authors,
        series,
        series_index,
        publisher,
        languages,
        identifiers: identifiers_map,
        custom_metadata,
        published_date,
        rating,
        description,
        cover_path: cover.clone(),
        tags,
        updated_at,
    };
    Ok(ParsedBook {
        item,
        formats: formats
            .into_iter()
            .map(|(format, path, _)| (format, path))
            .collect(),
        cover,
    })
}

fn portable_opf(item: &LibraryItem, cover_name: Option<&str>) -> String {
    let authors = if item.authors.is_empty() {
        item.author
            .as_ref()
            .map(|name| {
                vec![BookAuthor {
                    name: name.clone(),
                    sort_name: None,
                }]
            })
            .unwrap_or_default()
    } else {
        item.authors.clone()
    };
    let mut metadata = vec![format!("    <dc:title>{}</dc:title>", xml(&item.title))];
    for author in authors {
        let file_as = author
            .sort_name
            .as_ref()
            .map(|value| format!(" opf:file-as=\"{}\"", xml(value)))
            .unwrap_or_default();
        metadata.push(format!(
            "    <dc:creator opf:role=\"aut\"{file_as}>{}</dc:creator>",
            xml(&author.name)
        ));
    }
    push_text(&mut metadata, "publisher", item.publisher.as_deref());
    push_text(&mut metadata, "description", item.description.as_deref());
    for value in &item.languages {
        metadata.push(format!("    <dc:language>{}</dc:language>", xml(value)));
    }
    for value in &item.tags {
        metadata.push(format!("    <dc:subject>{}</dc:subject>", xml(value)));
    }
    push_text(&mut metadata, "date", item.published_date.as_deref());
    metadata.push(format!(
        "    <dc:identifier id=\"takio-id\" opf:scheme=\"takio\">{}</dc:identifier>",
        xml(&item.id)
    ));
    for (scheme, identifier) in &item.identifiers {
        metadata.push(format!(
            "    <dc:identifier opf:scheme=\"{}\">{}</dc:identifier>",
            xml(scheme),
            xml(identifier)
        ));
    }
    push_meta(&mut metadata, "calibre:series", item.series.as_deref());
    if let Some(value) = item.series_index {
        metadata.push(format!(
            "    <meta name=\"calibre:series_index\" content=\"{value}\"/>"
        ));
    }
    if let Some(value) = item.rating {
        metadata.push(format!(
            "    <meta name=\"calibre:rating\" content=\"{value}\"/>"
        ));
    }
    for (name, value) in item
        .custom_metadata
        .iter()
        .filter(|(name, _)| name.as_str() != METADATA_AUDIT_KEY)
    {
        metadata.push(format!(
            "    <meta name=\"takio:custom:{}\" content=\"{}\"/>",
            xml(name),
            xml(value)
        ));
    }
    metadata.push(format!(
        "    <meta name=\"takio:added_at\" content=\"{}\"/>",
        xml(&item.added_at)
    ));
    push_meta(
        &mut metadata,
        "takio:updated_at",
        item.updated_at.as_deref(),
    );
    metadata.push(format!(
        "    <meta name=\"takio:format_order\" content=\"{}\"/>",
        item.formats
            .iter()
            .map(|format| format.format.as_str())
            .collect::<Vec<_>>()
            .join(",")
    ));
    for format in &item.formats {
        metadata.push(format!(
            "    <meta name=\"takio:format_added_at:{}\" content=\"{}\"/>",
            format.format.as_str(),
            xml(&format.added_at)
        ));
    }
    if cover_name.is_some() {
        metadata.push("    <meta name=\"cover\" content=\"cover-image\"/>".to_owned());
    }
    let mut manifest = item
        .formats
        .iter()
        .map(|entry| {
            format!(
                "    <item id=\"format-{}\" href=\"book.{}\" media-type=\"{}\"/>",
                entry.format.as_str(),
                entry.format.as_str(),
                media_type(entry.format)
            )
        })
        .collect::<Vec<_>>();
    if let Some(name) = cover_name {
        let kind = if name.ends_with(".png") {
            "png"
        } else {
            "jpeg"
        };
        manifest.push(format!(
            "    <item id=\"cover-image\" href=\"{}\" media-type=\"image/{kind}\"/>",
            xml(name)
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"takio-id\" version=\"2.0\">\n  <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:opf=\"http://www.idpf.org/2007/opf\">\n{}\n  </metadata>\n  <manifest>\n{}\n  </manifest>\n</package>\n",
        metadata.join("\n"),
        manifest.join("\n")
    )
}

fn safe_book_directory(item: &LibraryItem) -> String {
    let normalized = item.title.nfkd().collect::<String>();
    let mut title = normalized
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        title = "Book".to_owned();
    }
    title.truncate(title.floor_char_boundary(48));
    let hash = hex::encode(Sha256::digest(item.id.as_bytes()));
    format!("{title} [{hash}]")
}

fn copy_artifact(source: &Path, destination: &Path, relative: &str) -> AppResult<PortableArtifact> {
    let source_metadata =
        fs::symlink_metadata(source).map_err(|_| AppError::new("storage-unavailable"))?;
    if !source_metadata.is_file()
        || source_metadata.file_type().is_symlink()
        || source_metadata.len() == 0
    {
        return Err(AppError::new("storage-unavailable"));
    }
    let mut input = File::open(source).map_err(|_| AppError::new("storage-unavailable"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| AppError::new("storage-unavailable"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| AppError::new("storage-unavailable"))?;
        hash.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| AppError::new("storage-unavailable"))?;
    }
    output
        .sync_all()
        .map_err(|_| AppError::new("storage-unavailable"))?;
    if bytes == 0 {
        return Err(AppError::new("storage-unavailable"));
    }
    Ok(PortableArtifact {
        path: relative.to_owned(),
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}

fn fingerprint(path: &Path, relative: &str) -> AppResult<PortableArtifact> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AppError::new("source-invalid"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_SAFE_INTEGER
    {
        return Err(AppError::new("source-invalid"));
    }
    let mut file = File::open(path).map_err(|_| AppError::new("source-invalid"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AppError::new("source-invalid"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| AppError::new("source-invalid"))?;
    }
    let after = fs::symlink_metadata(path).map_err(|_| AppError::new("source-invalid"))?;
    if !after.is_file() || after.file_type().is_symlink() || after.len() != bytes {
        return Err(AppError::new("source-invalid"));
    }
    Ok(PortableArtifact {
        path: relative.to_owned(),
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}

fn read_bounded_regular(path: &Path, max: u64) -> AppResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AppError::new("source-invalid"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max {
        return Err(AppError::new("source-invalid"));
    }
    let bytes = fs::read(path).map_err(|_| AppError::new("source-invalid"))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(AppError::new("source-invalid"));
    }
    Ok(bytes)
}

fn require_exact_entries(root: &Path, expected: &[&str]) -> AppResult<()> {
    let expected = expected.iter().copied().collect::<HashSet<_>>();
    let mut actual = HashSet::new();
    for entry in fs::read_dir(root).map_err(|_| AppError::new("source-invalid"))? {
        let entry = entry.map_err(|_| AppError::new("source-invalid"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| AppError::new("source-invalid"))?;
        if !actual.insert(name) {
            return Err(AppError::new("source-invalid"));
        }
    }
    if actual.iter().map(String::as_str).collect::<HashSet<_>>() == expected {
        Ok(())
    } else {
        Err(AppError::new("source-invalid"))
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && Path::new(value)
            .components()
            .eq([Component::Normal(value.as_ref())])
        && !value.contains(['/', '\\'])
}
pub(crate) fn valid_item_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
fn valid_timestamp(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn valid_leaf(value: &str) -> bool {
    value == "metadata.opf"
        || matches!(
            value,
            "book.kepub"
                | "book.epub"
                | "book.pdf"
                | "book.mobi"
                | "book.azw3"
                | "book.docx"
                | "book.html"
                | "book.txt"
                | "book.cbz"
                | "cover.jpg"
                | "cover.jpeg"
                | "cover.png"
        )
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn absolute_nonempty(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(AppError::new("invalid-arguments"));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
fn owned_staging_path(destination: &Path) -> AppResult<PathBuf> {
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    Ok(parent.join(format!(".{name}.{}.tmp", Uuid::new_v4())))
}
fn create_private_dir(path: &Path) -> AppResult<()> {
    fs::create_dir(path).map_err(|_| AppError::new("storage-unavailable"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| AppError::new("storage-unavailable"))?;
    }
    Ok(())
}
fn write_new_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    file.write_all(bytes)
        .map_err(|_| AppError::new("storage-unavailable"))?;
    file.sync_all()
        .map_err(|_| AppError::new("storage-unavailable"))
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn media_type(format: FormatId) -> &'static str {
    match format {
        FormatId::Kepub | FormatId::Epub => "application/epub+zip",
        FormatId::Pdf => "application/pdf",
        FormatId::Mobi => "application/x-mobipocket-ebook",
        FormatId::Azw3 => "application/vnd.amazon.mobi8-ebook",
        FormatId::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        FormatId::Html => "text/html",
        FormatId::Txt => "text/plain",
        FormatId::Cbz => "application/vnd.comicbook+zip",
    }
}
fn push_text(lines: &mut Vec<String>, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        lines.push(format!("    <dc:{name}>{}</dc:{name}>", xml(value)));
    }
}
fn push_meta(lines: &mut Vec<String>, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        lines.push(format!(
            "    <meta name=\"{name}\" content=\"{}\"/>",
            xml(value)
        ));
    }
}
fn unique_child<'a>(parent: Node<'a, 'a>, name: &str) -> AppResult<Node<'a, 'a>> {
    let matches = parent
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == name)
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Ok(matches[0])
    } else {
        Err(AppError::new("source-invalid"))
    }
}
fn required_attr(node: &Node<'_, '_>, name: &str) -> AppResult<String> {
    attr(node, name).ok_or_else(|| AppError::new("source-invalid"))
}
fn attr(node: &Node<'_, '_>, name: &str) -> Option<String> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value().trim().to_owned())
}
fn text(node: &Node<'_, '_>) -> Option<String> {
    let value = node.text()?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}
fn unique_text_child(parent: Node<'_, '_>, name: &str) -> AppResult<String> {
    optional_unique_text_child(parent, name)?.ok_or_else(|| AppError::new("source-invalid"))
}
fn optional_unique_text_child(parent: Node<'_, '_>, name: &str) -> AppResult<Option<String>> {
    let values = parent
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == name)
        .filter_map(|node| text(&node))
        .collect::<Vec<_>>();
    if values.len() <= 1 {
        Ok(values.into_iter().next())
    } else {
        Err(AppError::new("source-invalid"))
    }
}
fn text_children(parent: Node<'_, '_>, name: &str) -> Vec<String> {
    parent
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == name)
        .filter_map(|node| text(&node))
        .collect()
}
fn unique_meta(nodes: &[Node<'_, '_>], name: &str) -> AppResult<String> {
    optional_unique_meta(nodes, name)?.ok_or_else(|| AppError::new("source-invalid"))
}
fn optional_unique_meta(nodes: &[Node<'_, '_>], name: &str) -> AppResult<Option<String>> {
    let values = nodes
        .iter()
        .filter(|node| attr(node, "name").as_deref() == Some(name))
        .map(|node| required_attr(node, "content"))
        .collect::<AppResult<Vec<_>>>()?;
    if values.len() <= 1 {
        Ok(values.into_iter().next())
    } else {
        Err(AppError::new("source-invalid"))
    }
}
fn parse_optional_finite(value: Option<String>) -> AppResult<Option<f64>> {
    value
        .map(|value| {
            value
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .ok_or_else(|| AppError::new("source-invalid"))
        })
        .transpose()
}
fn integrity_value(report: &VerifyReport) -> serde_json::Value {
    json!({"schemaVersion":report.schema_version,"sqliteIntegrity":report.sqlite_integrity,"activeItems":report.active_items,"trashedItems":report.trashed_items,"managedFormats":report.managed_formats,"referencedFormats":report.referenced_formats,"verifiedManagedFormats":report.verified_managed_formats})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replace_opf(fixture: &Path, before: &str, after: &str) {
        let opf = fixture.join("books/Book [abc]/metadata.opf");
        let source = fs::read_to_string(&opf).expect("opf");
        fs::write(&opf, source.replace(before, after)).expect("replace opf");
        let manifest_path = fixture.join("manifest.json");
        let mut manifest: PortableManifest =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
        let replacement = fingerprint(&opf, "metadata.opf").expect("fingerprint");
        *manifest.books[0]
            .artifacts
            .iter_mut()
            .find(|artifact| artifact.path == "metadata.opf")
            .expect("opf entry") = replacement;
        fs::write(&manifest_path, serde_json::to_vec(&manifest).expect("json"))
            .expect("write manifest");
    }

    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("temporary directory");
        let book = temp.path().join("books").join("Book [abc]");
        fs::create_dir_all(&book).expect("book directory");
        fs::write(book.join("book.epub"), b"epub bytes").expect("ebook");
        fs::write(
            book.join("metadata.opf"),
            portable_opf(
                &LibraryItem {
                    id: "book-one".to_owned(),
                    title: "Book".to_owned(),
                    source_path: book.join("book.epub"),
                    format: FormatId::Epub,
                    added_at: "2025-01-02T03:04:05Z".to_owned(),
                    formats: vec![crate::model::BookFormat {
                        source_path: book.join("book.epub"),
                        format: FormatId::Epub,
                        added_at: "2025-01-02T03:04:05Z".to_owned(),
                        provenance: Provenance::Referenced,
                    }],
                    author: None,
                    authors: Vec::new(),
                    series: None,
                    series_index: None,
                    publisher: None,
                    languages: Vec::new(),
                    identifiers: BTreeMap::new(),
                    custom_metadata: BTreeMap::from([
                        ("shelf".to_owned(), "Favorites".to_owned()),
                        (
                            METADATA_AUDIT_KEY.to_owned(),
                            "private source path".to_owned(),
                        ),
                    ]),
                    published_date: None,
                    rating: None,
                    description: None,
                    cover_path: None,
                    tags: Vec::new(),
                    updated_at: None,
                },
                None,
            ),
        )
        .expect("opf");
        let artifacts = ["book.epub", "metadata.opf"]
            .into_iter()
            .map(|leaf| fingerprint(&book.join(leaf), leaf).expect("fingerprint"))
            .collect();
        let manifest = PortableManifest {
            format: PORTABLE_FORMAT.to_owned(),
            version: PORTABLE_VERSION,
            definitions: Vec::new(),
            books: vec![PortableBook {
                directory: "Book [abc]".to_owned(),
                artifacts,
            }],
        };
        fs::write(
            temp.path().join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).expect("manifest"),
        )
        .expect("write manifest");
        temp
    }

    #[test]
    fn portable_opf_keeps_user_fields_without_exporting_reserved_audit() {
        let portable = fixture();
        let opf = fs::read_to_string(portable.path().join("books/Book [abc]/metadata.opf"))
            .expect("portable OPF");
        assert!(opf.contains("takio:custom:shelf"));
        assert!(opf.contains("Favorites"));
        assert!(!opf.contains(METADATA_AUDIT_KEY));
        assert!(!opf.contains("private source path"));
        let parsed = validate_source(portable.path()).expect("valid portable library");
        assert_eq!(
            parsed[0].item.custom_metadata.get("shelf"),
            Some(&"Favorites".to_owned())
        );
        assert!(
            !parsed[0]
                .item
                .custom_metadata
                .contains_key(METADATA_AUDIT_KEY)
        );
    }

    #[test]
    fn rejects_changed_traversal_duplicate_and_oversized_sources() {
        let changed = fixture();
        fs::write(
            changed.path().join("books/Book [abc]/book.epub"),
            b"changed",
        )
        .expect("change artifact");
        assert_eq!(
            validate_source(changed.path()).unwrap_err().code(),
            "source-invalid"
        );

        let traversal = fixture();
        let manifest_path = traversal.path().join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
        manifest["books"][0]["directory"] = json!("../escape");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).expect("json")).expect("write");
        assert_eq!(
            validate_source(traversal.path()).unwrap_err().code(),
            "source-invalid"
        );

        let duplicate = fixture();
        let manifest_path = duplicate.path().join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
        let first = manifest["books"][0].clone();
        manifest["books"].as_array_mut().expect("books").push(first);
        fs::write(&manifest_path, serde_json::to_vec(&manifest).expect("json")).expect("write");
        assert_eq!(
            validate_source(duplicate.path()).unwrap_err().code(),
            "source-invalid"
        );

        let oversized = fixture();
        fs::write(
            oversized.path().join("manifest.json"),
            vec![b' '; (MAX_DOCUMENT_BYTES + 1) as usize],
        )
        .expect("oversized manifest");
        assert_eq!(
            validate_source(oversized.path()).unwrap_err().code(),
            "source-invalid"
        );
    }

    #[test]
    fn rejects_unsafe_item_ids_and_inconsistent_media_types() {
        let unsafe_id = fixture();
        replace_opf(
            unsafe_id.path(),
            ">book-one</dc:identifier>",
            ">../../escape</dc:identifier>",
        );
        assert_eq!(
            validate_source(unsafe_id.path()).unwrap_err().code(),
            "source-invalid"
        );

        let wrong_media_type = fixture();
        replace_opf(
            wrong_media_type.path(),
            "media-type=\"application/epub+zip\"",
            "media-type=\"application/pdf\"",
        );
        assert_eq!(
            validate_source(wrong_media_type.path()).unwrap_err().code(),
            "source-invalid"
        );

        let invalid_custom_key = fixture();
        replace_opf(
            invalid_custom_key.path(),
            "<meta name=\"takio:added_at\"",
            "<meta name=\"takio:custom:Bad Key\" content=\"value\"/>\n    <meta name=\"takio:added_at\"",
        );
        assert_eq!(
            validate_source(invalid_custom_key.path())
                .unwrap_err()
                .code(),
            "source-invalid"
        );

        let reserved_custom_key = fixture();
        replace_opf(
            reserved_custom_key.path(),
            "<meta name=\"takio:added_at\"",
            "<meta name=\"takio:custom:takio_metadata_audit\" content=\"forged\"/>\n    <meta name=\"takio:added_at\"",
        );
        assert_eq!(
            validate_source(reserved_custom_key.path())
                .unwrap_err()
                .code(),
            "source-invalid"
        );

        let oversized_custom_value = fixture();
        let replacement = format!(
            "<meta name=\"takio:custom:shelf\" content=\"{}\"/>\n    <meta name=\"takio:added_at\"",
            "x".repeat(16 * 1024 + 1)
        );
        replace_opf(
            oversized_custom_value.path(),
            "<meta name=\"takio:added_at\"",
            &replacement,
        );
        assert_eq!(
            validate_source(oversized_custom_value.path())
                .unwrap_err()
                .code(),
            "source-invalid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_duplicate_opf_ids_and_extra_tree_entries() {
        use std::os::unix::fs::symlink;

        let linked = fixture();
        let artifact = linked.path().join("books/Book [abc]/book.epub");
        fs::rename(&artifact, linked.path().join("real.epub")).expect("move");
        symlink(linked.path().join("real.epub"), &artifact).expect("symlink");
        assert_eq!(
            validate_source(linked.path()).unwrap_err().code(),
            "source-invalid"
        );

        let duplicate_id = fixture();
        let opf = duplicate_id.path().join("books/Book [abc]/metadata.opf");
        let source = fs::read_to_string(&opf).expect("opf");
        fs::write(
            &opf,
            source.replace(
                "  </manifest>",
                "    <item id=\"format-epub\" href=\"book.epub\" media-type=\"application/epub+zip\"/>\n  </manifest>",
            ),
        )
        .expect("duplicate id");
        let manifest_path = duplicate_id.path().join("manifest.json");
        let mut manifest: PortableManifest =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
        let replacement = fingerprint(&opf, "metadata.opf").expect("fingerprint");
        *manifest.books[0]
            .artifacts
            .iter_mut()
            .find(|artifact| artifact.path == "metadata.opf")
            .expect("opf entry") = replacement;
        fs::write(&manifest_path, serde_json::to_vec(&manifest).expect("json")).expect("write");
        assert_eq!(
            validate_source(duplicate_id.path()).unwrap_err().code(),
            "source-invalid"
        );

        let extra = fixture();
        fs::write(extra.path().join("unexpected"), b"nope").expect("extra");
        assert_eq!(
            validate_source(extra.path()).unwrap_err().code(),
            "source-invalid"
        );
    }
}
