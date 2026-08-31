use std::fs::File;
use std::net::IpAddr;
use std::path::Path;

use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

use crate::conversion::{FormatId, detect_format};
use crate::model::LibraryItem;
use crate::output::{AppError, AppResult, print_success};
use crate::store::{LibraryStore, user_custom_metadata};

const MAX_CATALOG_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub fn serve(store: &LibraryStore, host: &str, port: u16) -> AppResult<()> {
    if !loopback(host) {
        return Err(AppError::new("invalid-arguments"));
    }
    let server = Server::http((host, port)).map_err(|_| AppError::new("server-unavailable"))?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let address = server.server_addr();
    let display_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let actual_port = address.to_ip().map_or(port, |value| value.port());
    print_success(
        json!({"server":{"url":format!("http://{display_host}:{actual_port}"),"token":token,"mode":"foreground-read-only"}}),
    )?;
    for request in server.incoming_requests() {
        handle(request, store, &token);
    }
    Ok(())
}

fn handle(request: Request, store: &LibraryStore, token: &str) {
    if !authorized(&request, token) {
        respond_json(
            request,
            StatusCode(401),
            json!({"ok":false,"error":{"code":"unauthorized"}}),
            Some(("WWW-Authenticate", "Bearer")),
        );
        return;
    }
    if request.method() != &Method::Get {
        respond_json(
            request,
            StatusCode(405),
            json!({"ok":false,"error":{"code":"method-not-allowed"}}),
            Some(("Allow", "GET")),
        );
        return;
    }
    let url = request.url().to_owned();
    if url.len() > 2048 {
        respond_error(request, "invalid-request", 400);
        return;
    }
    let (path, query) = url
        .split_once('?')
        .map_or((url.as_str(), ""), |value| value);
    if path == "/v1/health" && query.is_empty() {
        respond_json(
            request,
            StatusCode(200),
            json!({"ok":true,"value":{"service":"takio","protocolVersion":1}}),
            None,
        );
        return;
    }
    if matches!(path, "/v1/books" | "/v1/catalog") {
        let Some((limit, offset)) = page(query) else {
            respond_error(request, "invalid-request", 400);
            return;
        };
        match store.catalog_page(limit, offset) {
            Ok((total, items)) => {
                let books = items
                    .into_iter()
                    .map(|item| catalog_record(&item))
                    .collect::<Vec<_>>();
                respond_catalog_json(
                    request,
                    json!({"ok":true,"value":{"books":books,"offset":offset,"limit":limit,"total":total}}),
                );
            }
            Err(error) => respond_error(request, error.code(), 503),
        }
        return;
    }
    let segments = path
        .trim_matches('/')
        .split('/')
        .map(percent_decode)
        .collect::<Option<Vec<_>>>();
    let Some(segments) = segments else {
        respond_error(request, "invalid-request", 400);
        return;
    };
    match segments.as_slice() {
        [version, books, id] if version == "v1" && books == "books" && query.is_empty() => {
            match store.get(id) {
                Ok(Some(item)) => respond_catalog_json(
                    request,
                    json!({"ok":true,"value":{"book":catalog_record(&item)}}),
                ),
                Ok(None) => respond_error(request, "not-found", 404),
                Err(error) => respond_error(request, error.code(), 503),
            }
        }
        [version, books, id, formats, format]
            if version == "v1" && books == "books" && formats == "formats" && query.is_empty() =>
        {
            let Ok(format) = format.parse::<FormatId>() else {
                respond_error(request, "invalid-request", 400);
                return;
            };
            match store.get(id) {
                Ok(Some(item)) => {
                    let Some(attachment) = item.formats.iter().find(|value| value.format == format)
                    else {
                        respond_error(request, "format-not-found", 404);
                        return;
                    };
                    if detect_format(&attachment.source_path) != Some(format) {
                        respond_error(request, "format-mismatch", 409);
                    } else {
                        respond_file(request, &attachment.source_path, format);
                    }
                }
                Ok(None) => respond_error(request, "not-found", 404),
                Err(error) => respond_error(request, error.code(), 503),
            }
        }
        _ => respond_error(request, "not-found", 404),
    }
}

fn authorized(request: &Request, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .is_some_and(|header| {
            let candidate = header.value.as_str().as_bytes();
            candidate.len() <= 1024 && constant_time_eq(candidate, expected.as_bytes())
        })
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn page(query: &str) -> Option<(usize, usize)> {
    let mut limit = 100usize;
    let mut offset = 0usize;
    if query.is_empty() {
        return Some((limit, offset));
    }
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        match key {
            "limit" => limit = value.parse().ok()?,
            "offset" => offset = value.parse().ok()?,
            _ => return None,
        }
    }
    ((1..=256).contains(&limit) && offset <= 1_000_000).then_some((limit, offset))
}

fn catalog_record(item: &LibraryItem) -> serde_json::Value {
    let authors = if item.authors.is_empty() {
        item.author.clone().into_iter().collect::<Vec<_>>()
    } else {
        item.authors
            .iter()
            .map(|author| author.name.clone())
            .collect::<Vec<_>>()
    };
    let mut record = json!({
        "id":item.id,
        "title":item.title,
        "authors":authors,
        "tags":item.tags,
        "formats":item.formats.iter().map(|value|value.format).collect::<Vec<_>>(),
        "hasCover":item.cover_path.is_some()
    });
    let object = record.as_object_mut().expect("catalog record object");
    for (key, value) in [
        ("series", item.series.as_ref().map(|value| json!(value))),
        ("seriesIndex", item.series_index.map(|value| json!(value))),
        (
            "publisher",
            item.publisher.as_ref().map(|value| json!(value)),
        ),
        (
            "publishedDate",
            item.published_date.as_ref().map(|value| json!(value)),
        ),
        ("rating", item.rating.map(|value| json!(value))),
        (
            "description",
            item.description.as_ref().map(|value| json!(value)),
        ),
    ] {
        if let Some(value) = value {
            object.insert(key.to_owned(), value);
        }
    }
    if !item.languages.is_empty() {
        object.insert("languages".to_owned(), json!(item.languages));
    }
    if !item.identifiers.is_empty() {
        object.insert("identifiers".to_owned(), json!(item.identifiers));
    }
    let custom_metadata = user_custom_metadata(&item.custom_metadata);
    if !custom_metadata.is_empty() {
        object.insert("customMetadata".to_owned(), json!(custom_metadata));
    }
    record
}

fn respond_file(request: Request, path: &Path, format: FormatId) {
    let Ok(path) = path.canonicalize() else {
        respond_error(request, "missing-file", 404);
        return;
    };
    let Ok(file) = File::open(&path) else {
        respond_error(request, "missing-file", 404);
        return;
    };
    let Ok(metadata) = file.metadata() else {
        respond_error(request, "missing-file", 404);
        return;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        respond_error(request, "missing-file", 404);
        return;
    }
    let content_type = match format {
        FormatId::Kepub | FormatId::Epub => "application/epub+zip",
        FormatId::Pdf => "application/pdf",
        FormatId::Mobi => "application/x-mobipocket-ebook",
        FormatId::Azw3 => "application/vnd.amazon.ebook",
        FormatId::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        FormatId::Html => "text/html; charset=utf-8",
        FormatId::Txt => "text/plain; charset=utf-8",
        FormatId::Cbz => "application/vnd.comicbook+zip",
    };
    let response = Response::from_file(file)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Content-Length", &metadata.len().to_string()))
        .with_header(header(
            "Content-Disposition",
            &format!(
                "attachment; filename*=UTF-8''{}",
                percent_encode(
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("book")
                )
            ),
        ))
        .with_header(header("Cache-Control", "private, no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}

fn respond_error(request: Request, code: &str, status: u16) {
    respond_json(
        request,
        StatusCode(status),
        json!({"ok":false,"error":{"code":code}}),
        None,
    );
}

fn respond_json(
    request: Request,
    status: StatusCode,
    value: serde_json::Value,
    extra: Option<(&str, &str)>,
) {
    let mut response = Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    if let Some((name, value)) = extra {
        response.add_header(header(name, value));
    }
    let _ = request.respond(response);
}

fn respond_catalog_json(request: Request, value: serde_json::Value) {
    let body = value.to_string();
    if body.len() > MAX_CATALOG_RESPONSE_BYTES {
        respond_error(request, "response-too-large", 503);
        return;
    }
    let response = Response::from_string(body)
        .with_status_code(StatusCode(200))
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static HTTP header")
}

fn percent_decode(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len());
    let mut bytes = value.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = hex_value(bytes.next()?)?;
            let low = hex_value(bytes.next()?)?;
            output.push(high * 16 + low);
        } else {
            output.push(byte);
        }
    }
    let value = String::from_utf8(output).ok()?;
    (!value.is_empty() && !value.contains(['/', '\\'])).then_some(value)
}

fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(*byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use crate::model::{BookAuthor, BookFormat, Provenance};

    #[test]
    fn parses_bounded_catalog_pages() {
        assert_eq!(page(""), Some((100, 0)));
        assert_eq!(page("limit=20&offset=40"), Some((20, 40)));
        assert_eq!(page("limit=0"), None);
        assert_eq!(page("limit=257"), None);
        assert_eq!(page("offset=1000001"), None);
        assert_eq!(page("other=1"), None);
    }

    #[test]
    fn authorization_compare_is_length_and_value_sensitive() {
        assert!(constant_time_eq(b"Bearer token", b"Bearer token"));
        assert!(!constant_time_eq(b"Bearer token", b"Bearer other"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn encodes_attachment_filenames_for_content_disposition() {
        assert_eq!(percent_encode("A book's.epub"), "A%20book%27s.epub");
    }

    #[test]
    fn catalog_records_are_complete_and_do_not_expose_paths() {
        let item = LibraryItem {
            id: "book-1".to_owned(),
            title: "Kindred".to_owned(),
            source_path: PathBuf::from("/private/library/book.epub"),
            format: FormatId::Epub,
            added_at: "2026-01-01T00:00:00Z".to_owned(),
            formats: vec![BookFormat {
                source_path: PathBuf::from("/private/library/book.epub"),
                format: FormatId::Epub,
                added_at: "2026-01-01T00:00:00Z".to_owned(),
                provenance: Provenance::Managed,
            }],
            author: None,
            authors: vec![BookAuthor {
                name: "Octavia E. Butler".to_owned(),
                sort_name: Some("Butler, Octavia E.".to_owned()),
            }],
            series: Some("Examples".to_owned()),
            series_index: Some(1.0),
            publisher: Some("Beacon Press".to_owned()),
            languages: vec!["en".to_owned()],
            identifiers: BTreeMap::from([("isbn".to_owned(), "9780807083697".to_owned())]),
            custom_metadata: BTreeMap::from([
                ("shelf".to_owned(), "favorites".to_owned()),
                (
                    "takio_metadata_audit".to_owned(),
                    "private source path".to_owned(),
                ),
            ]),
            published_date: Some("1979-06-01".to_owned()),
            rating: Some(5.0),
            description: Some("A landmark novel.".to_owned()),
            cover_path: Some(PathBuf::from("/private/library/cover.jpg")),
            tags: vec!["fiction".to_owned()],
            updated_at: None,
        };

        let record = catalog_record(&item);
        assert_eq!(record["authors"], json!(["Octavia E. Butler"]));
        assert_eq!(record["identifiers"]["isbn"], "9780807083697");
        assert_eq!(record["customMetadata"]["shelf"], "favorites");
        assert!(
            record["customMetadata"]
                .get("takio_metadata_audit")
                .is_none()
        );
        assert!(!record.to_string().contains("private source path"));
        assert_eq!(record["hasCover"], true);
        assert!(record.get("sourcePath").is_none());
        assert!(!record.to_string().contains("/private/library"));
    }
}
