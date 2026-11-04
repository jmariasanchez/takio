use std::fs;
use std::path::Path;

use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::Value;

#[path = "../../engine/tests/support/pdf.rs"]
mod fixture;

fn add(database: &Path, source: &Path, title: Option<&str>) -> Value {
    let mut command = cargo_bin_cmd!("takio");
    command
        .args(["library", "add", "--db"])
        .arg(database)
        .arg("--source-path")
        .arg(source);
    if let Some(title) = title {
        command.args(["--title", title]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["ok"], true);
    envelope["value"]["item"].clone()
}

#[test]
fn cli_pdf_import_resolves_info_preserves_sources_and_explicit_title() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("library.sqlite");
    for (index, (bytes, explicit, expected)) in [
        (fixture::compressed(0), None, "The Quiet Sea"),
        (
            fixture::classic(
                b"<< /Title (Embedded Title) /Author (Doe, Jane) >>",
                &[],
                "",
            ),
            Some("Chosen Title"),
            "Chosen Title",
        ),
        (
            fixture::classic(
                b"<< /Title (Microsoft Word - draft.docx) /Author (Jane Author) >>",
                &[],
                "",
            ),
            None,
            "Useful Filename 2",
        ),
        (
            fixture::classic(b"<< /Title (Unknown) /Author (Unknown Author) >>", &[], ""),
            None,
            "Useful Filename 3",
        ),
        (
            b"%PDF-1.7\n/Author (Unrelated Fake)".to_vec(),
            None,
            "Useful Filename 4",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let source = temp.path().join(format!("Useful_Filename_{index}.pdf"));
        fs::write(&source, &bytes).unwrap();
        let item = add(&db, &source, explicit);
        assert_eq!(item["title"], expected);
        if index >= 3 {
            assert!(
                item.get("authors")
                    .is_none_or(|value| value.as_array().unwrap().is_empty())
            );
            assert!(item["author"].is_null());
        } else {
            let authors = item["authors"].as_array().unwrap();
            let expected_author = ["Jane (Example) \u{0152}", "Doe, Jane", "Jane Author"][index];
            assert_eq!(authors[0]["name"], expected_author);
            assert_eq!(item["author"], expected_author);
        }
        assert_eq!(fs::read(&source).unwrap(), bytes);
        let managed = Path::new(item["formats"][0]["sourcePath"].as_str().unwrap());
        assert_ne!(managed, source);
        assert_eq!(fs::read(managed).unwrap(), bytes);
        // Reopening via the public CLI preserves all metadata and source bytes.
        let again = add(&db, &source, None);
        assert_eq!(again["id"], item["id"]);
        assert_eq!(again["title"], expected);
        assert_eq!(again["authors"], item["authors"]);
        assert_eq!(fs::read(&source).unwrap(), bytes);
    }
}

#[test]
fn cli_pdf_unknown_embedded_author_retains_filename_author() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp
        .path()
        .join("Useful Book (Jane Example) (z-library.sk).pdf");
    let bytes = fixture::classic(b"<< /Title (Document1) /Author (Unknown) >>", &[], "");
    fs::write(&source, &bytes).unwrap();
    let item = add(&temp.path().join("library.sqlite"), &source, None);
    assert_eq!(item["title"], "Useful Book");
    assert_eq!(item["authors"][0]["name"], "Jane Example");
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
#[ignore = "requires independent local Poppler pdfinfo oracle"]
fn synthetic_pdf_metadata_matches_poppler_oracle() {
    let temp = tempfile::tempdir().unwrap();
    for (index, bytes, title, author) in [
        (
            0,
            fixture::compressed(0),
            "The Quiet Sea",
            "Jane (Example) \u{0152}",
        ),
        (
            1,
            fixture::classic(
                b"<< /Title 6 0 R /Author 5 0 R >>",
                &[b"<FEFF004A006F007300E9>", b"(A Meaningful Title)"],
                "",
            ),
            "A Meaningful Title",
            "Jos\u{e9}",
        ),
    ] {
        let source = temp.path().join(format!("oracle-{index}.pdf"));
        fs::write(&source, &bytes).unwrap();
        let output = std::process::Command::new("pdfinfo")
            .args(["-enc", "UTF-8"])
            .arg(&source)
            .output()
            .expect("install Poppler pdfinfo to run this explicit oracle test");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let info = String::from_utf8(output.stdout).unwrap();
        for (key, expected) in [("Title:", title), ("Author:", author)] {
            let value = info
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap()
                .trim();
            assert_eq!(value, expected);
        }
        let item = add(&temp.path().join("library.sqlite"), &source, None);
        assert_eq!(item["title"], title);
        assert_eq!(item["authors"][0]["name"], author);
        assert_eq!(fs::read(source).unwrap(), bytes);
    }
}
