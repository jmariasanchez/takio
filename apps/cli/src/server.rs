use std::fs::File;
use std::net::IpAddr;
use std::path::Path;

use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

use crate::output::{failure, print_success, success};
use takio::error::{AppResult, ErrorCode};
use takio::format::{FormatId, detect_format};
use takio::library::catalog::catalog_record;
use takio::library::store::LibraryStore;

const MAX_CATALOG_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub fn serve(store: &LibraryStore, host: &str, port: u16) -> AppResult<()> {
    if !loopback(host) {
        return Err(takio::app_error!("invalid-arguments"));
    }
    let server = Server::http((host, port)).map_err(|_| takio::app_error!("server-unavailable"))?;
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
            failure(ErrorCode::Unauthorized),
            Some(("WWW-Authenticate", "Bearer")),
        );
        return;
    }
    if request.method() != &Method::Get {
        respond_json(
            request,
            StatusCode(405),
            failure(ErrorCode::MethodNotAllowed),
            Some(("Allow", "GET")),
        );
        return;
    }
    let url = request.url().to_owned();
    if url.len() > 2048 {
        respond_error(request, ErrorCode::InvalidRequest, 400);
        return;
    }
    let (path, query) = url
        .split_once('?')
        .map_or((url.as_str(), ""), |value| value);
    if path == "/v1/health" && query.is_empty() {
        respond_json(
            request,
            StatusCode(200),
            success(json!({"service":"takio","protocolVersion":1})),
            None,
        );
        return;
    }
    if matches!(path, "/v1/books" | "/v1/catalog") {
        let Some((limit, offset)) = page(query) else {
            respond_error(request, ErrorCode::InvalidRequest, 400);
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
                    success(json!({"books":books,"offset":offset,"limit":limit,"total":total})),
                );
            }
            Err(error) => respond_store_error(request, error),
        }
        return;
    }
    let segments = path
        .trim_matches('/')
        .split('/')
        .map(percent_decode)
        .collect::<Option<Vec<_>>>();
    let Some(segments) = segments else {
        respond_error(request, ErrorCode::InvalidRequest, 400);
        return;
    };
    match segments.as_slice() {
        [version, books, id] if version == "v1" && books == "books" && query.is_empty() => {
            match store.get_active(id) {
                Ok(item) => {
                    respond_catalog_json(request, success(json!({"book":catalog_record(&item)})))
                }
                Err(error) => respond_store_error(request, error),
            }
        }
        [version, books, id, formats, format]
            if version == "v1" && books == "books" && formats == "formats" && query.is_empty() =>
        {
            let Ok(format) = format.parse::<FormatId>() else {
                respond_error(request, ErrorCode::InvalidRequest, 400);
                return;
            };
            match store.get_active(id) {
                Ok(item) => {
                    let Some(attachment) = item.formats.iter().find(|value| value.format == format)
                    else {
                        respond_error(request, ErrorCode::FormatNotFound, 404);
                        return;
                    };
                    if detect_format(&attachment.source_path) != Some(format) {
                        respond_error(request, ErrorCode::FormatMismatch, 409);
                    } else {
                        respond_file(request, &attachment.source_path, format);
                    }
                }
                Err(error) => respond_store_error(request, error),
            }
        }
        _ => respond_error(request, ErrorCode::NotFound, 404),
    }
}

fn respond_store_error(request: Request, error: takio::error::AppError) {
    let (code, status) = store_error_status(error.kind());
    respond_error(request, code, status);
}

fn store_error_status(code: ErrorCode) -> (ErrorCode, u16) {
    match code {
        ErrorCode::NotFound | ErrorCode::ItemTrashed => (ErrorCode::NotFound, 404),
        _ => (code, 503),
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

fn respond_file(request: Request, path: &Path, format: FormatId) {
    let Ok(path) = path.canonicalize() else {
        respond_error(request, ErrorCode::MissingFile, 404);
        return;
    };
    let Ok(file) = File::open(&path) else {
        respond_error(request, ErrorCode::MissingFile, 404);
        return;
    };
    let Ok(metadata) = file.metadata() else {
        respond_error(request, ErrorCode::MissingFile, 404);
        return;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        respond_error(request, ErrorCode::MissingFile, 404);
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

fn respond_error(request: Request, code: ErrorCode, status: u16) {
    respond_json(request, StatusCode(status), failure(code), None);
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
        respond_error(request, ErrorCode::ResponseTooLarge, 503);
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
    #[test]
    fn store_errors_share_one_http_status_contract() {
        for &code in super::ErrorCode::ALL {
            let expected = match code {
                super::ErrorCode::NotFound | super::ErrorCode::ItemTrashed => {
                    (super::ErrorCode::NotFound, 404)
                }
                _ => (code, 503),
            };
            assert_eq!(super::store_error_status(code), expected);
        }
    }

    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use takio::library::model::{BookAuthor, BookFormat, LibraryItem, Provenance};

    #[test]
    fn trashed_books_are_not_returned_or_streamed_over_http() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;
        use takio::library::{model::ImportMode, paths::LibraryPaths};

        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths).unwrap();
        let source = temp.path().join("private.txt");
        std::fs::write(&source, "private book contents").unwrap();
        let item = store.import(&source, None, ImportMode::Copy).unwrap();
        store.trash(&item.id).unwrap();
        let server = Server::http(("127.0.0.1", 0)).unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let timeout = Duration::from_secs(10);
        std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                for _ in 0..2 {
                    handle(
                        server.recv_timeout(timeout).unwrap().unwrap(),
                        &store,
                        "token",
                    );
                }
            });
            for path in [
                format!("/v1/books/{}", item.id),
                format!("/v1/books/{}/formats/txt", item.id),
            ] {
                let mut stream = TcpStream::connect_timeout(&address, timeout).unwrap();
                stream.set_read_timeout(Some(timeout)).unwrap();
                write!(stream, "GET {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer token\r\nConnection: close\r\n\r\n").unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                assert!(response.starts_with("HTTP/1.1 404 "), "{response}");
                assert!(!response.contains("private book contents"));
            }
            worker.join().unwrap();
        });
    }

    #[test]
    fn catalog_http_boundary_authenticates_and_projects_rich_and_sparse_books() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        use takio::library::catalog::tests::{rich_record, sparse_record};
        use takio::library::paths::LibraryPaths;

        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::create_or_migrate(paths.clone()).unwrap();
        let source = temp.path().join("sparse.txt");
        std::fs::write(&source, "sparse book").unwrap();
        let sparse = store
            .import(
                &source,
                Some("Example"),
                takio::library::model::ImportMode::Copy,
            )
            .unwrap();
        let source = temp.path().join("rich.txt");
        std::fs::write(&source, "rich book").unwrap();
        let rich = store
            .import(
                &source,
                Some("Example"),
                takio::library::model::ImportMode::Copy,
            )
            .unwrap();
        store
            .update(
                &rich.id,
                serde_json::from_value(json!({
                    "authors":[{"name":"Public author","sortName":"Private sort name"}],
                    "series":"Series", "seriesIndex":0.0, "publisher":"Publisher",
                    "publishedDate":"2026", "rating":0.0, "description":"Description",
                    "languages":["en"], "identifiers":{"isbn":"123"},
                    "customMetadata":{"shelf":"favorites"}, "tags":["fiction"]
                }))
                .unwrap(),
            )
            .unwrap();
        for id in [&sparse.id, &rich.id] {
            takio::test_support::insert_metadata_audit(
                &paths.database,
                id,
                temp.path().join("private-audit").to_str().unwrap(),
            )
            .unwrap();
        }

        let server = Server::http(("127.0.0.1", 0)).unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let timeout = Duration::from_secs(5);
        std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                for _ in 0..2 {
                    let request = server
                        .recv_timeout(timeout)
                        .unwrap()
                        .expect("bounded request wait");
                    handle(request, &store, "test-token");
                }
            });
            let request = |authorization: &str| {
                let mut stream = TcpStream::connect_timeout(&address, timeout).unwrap();
                stream.set_read_timeout(Some(timeout)).unwrap();
                stream.set_write_timeout(Some(timeout)).unwrap();
                write!(stream, "GET /v1/catalog?limit=2&offset=0 HTTP/1.1\r\nHost: {address}\r\n{authorization}Connection: close\r\n\r\n").unwrap();
                let mut response = String::new();
                stream
                    .take(64 * 1024)
                    .read_to_string(&mut response)
                    .unwrap();
                let (headers, body) = response.split_once("\r\n\r\n").unwrap();
                (
                    headers.to_owned(),
                    serde_json::from_str::<serde_json::Value>(body).unwrap(),
                )
            };
            let (headers, body) = request("");
            assert!(headers.starts_with("HTTP/1.1 401 "), "{headers}");
            assert_eq!(body, json!({"ok":false,"error":{"code":"unauthorized"}}));

            let (headers, body) = request("Authorization: Bearer test-token\r\n");
            assert!(headers.starts_with("HTTP/1.1 200 "), "{headers}");
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("content-type: application/json")
            );
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("cache-control: no-store")
            );
            let mut sparse_expected = sparse_record();
            sparse_expected["id"] = json!(sparse.id);
            sparse_expected["formats"] = json!(["txt"]);
            let mut rich_expected = rich_record();
            rich_expected["id"] = json!(rich.id);
            rich_expected["formats"] = json!(["txt"]);
            rich_expected["hasCover"] = json!(false);
            let books = body["value"]["books"].as_array().unwrap();
            assert_eq!(books.len(), 2);
            assert!(books.contains(&sparse_expected));
            assert!(books.contains(&rich_expected));
            assert_eq!(
                body,
                json!({"ok":true,"value":{
                    "books":books,"limit":2,"offset":0,"total":2
                }})
            );
            let serialized = body.to_string();
            assert!(!serialized.contains(temp.path().to_str().unwrap()));
            assert!(!serialized.contains("takio_metadata_audit"));
            assert!(!serialized.contains("Private sort name"));
            worker.join().unwrap();
        });
    }

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
        let mut item = LibraryItem::for_test(
            "book-1",
            "Kindred",
            "/private/library/book.epub",
            FormatId::Epub,
            "2026-01-01T00:00:00Z",
        );
        item.formats = vec![BookFormat {
            source_path: PathBuf::from("/private/library/book.epub"),
            format: FormatId::Epub,
            added_at: "2026-01-01T00:00:00Z".to_owned(),
            provenance: Provenance::Managed,
        }];
        item.authors = vec![BookAuthor {
            name: "Octavia E. Butler".to_owned(),
            sort_name: Some("Butler, Octavia E.".to_owned()),
        }];
        item.series = Some("Examples".to_owned());
        item.series_index = Some(1.0);
        item.publisher = Some("Beacon Press".to_owned());
        item.languages = vec!["en".to_owned()];
        item.identifiers = BTreeMap::from([("isbn".to_owned(), "9780807083697".to_owned())]);
        item.custom_metadata = BTreeMap::from([
            ("shelf".to_owned(), "favorites".to_owned()),
            (
                "takio_metadata_audit".to_owned(),
                "private source path".to_owned(),
            ),
        ]);
        item.published_date = Some("1979-06-01".to_owned());
        item.rating = Some(5.0);
        item.description = Some("A landmark novel.".to_owned());
        item.cover_path = Some(PathBuf::from("/private/library/cover.jpg"));
        item.tags = vec!["fiction".to_owned()];

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
