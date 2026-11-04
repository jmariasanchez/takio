use super::*;

mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/pdf.rs"));
}

fn extract(bytes: &[u8]) -> (Option<String>, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("book.pdf");
    std::fs::write(&path, bytes).unwrap();
    let (title, authors) = embedded_pdf(&path);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    (
        title,
        authors.into_iter().map(|author| author.name).collect(),
    )
}

#[test]
fn real_info_indirect_values_and_pdfdocencoding() {
    let pdf = fixture::classic(
        b"<< /Title 6 0 R /Author 5 0 R >>",
        &[b"(Doe, Jane \\(Editor\\) \\226)", b"(The Quiet\\nSea)"],
        "",
    );
    assert_eq!(
        extract(&pdf),
        (
            Some("The Quiet Sea".into()),
            vec!["Doe, Jane (Editor) \u{0152}".into()]
        )
    );
}

#[test]
fn compressed_info_and_indirect_strings() {
    assert_eq!(
        extract(&fixture::compressed(0)),
        (
            Some("The Quiet Sea".into()),
            vec!["Jane (Example) \u{0152}".into()]
        )
    );
}

#[test]
fn utf16_hex_literals_and_pdfdoc_special_characters() {
    for (value, expected) in [
        ("<FEFF004A006F007300E9>", "Jos\u{e9}"),
        ("<FFFE4A006F007300E900>", "Jos\u{e9}"),
        ("(\\376\\377\\000J\\000o\\000s\\000\\351)", "Jos\u{e9}"),
        ("<4A6F7396>", "Jos\u{0152}"),
        ("(A\\\\B\\(C\\)\\\n D)", "A\\B(C) D"),
    ] {
        let pdf = fixture::classic(format!("<< /Author {value} >>").as_bytes(), &[], "");
        assert_eq!(extract(&pdf).1, vec![expected], "{value}");
    }
}

#[test]
fn producer_placeholder_and_garbage_titles_do_not_displace_filename() {
    for title in [
        "Unknown",
        "Untitled",
        "Document1",
        "Microsoft Word - manuscript",
        "book.pdf",
        "C:/temp/book",
        "0123456789",
        "aabbccddeeff001122334455",
        "Acrobat PDFMaker",
        "Scanner Pro",
    ] {
        let pdf = fixture::classic(
            format!("<< /Title ({title}) /Producer (Scanner Pro) /Author (Jane Author) >>")
                .as_bytes(),
            &[],
            "",
        );
        let result = extract(&pdf);
        assert_eq!(result.0, None, "{title}");
        assert_eq!(result.1, ["Jane Author"]);
    }
    for title in [
        "Dune",
        "The Quiet Sea",
        "Documenting Nature",
        "Scandinavian History",
    ] {
        assert_eq!(
            extract(&fixture::classic(
                format!("<< /Title ({title}) >>").as_bytes(),
                &[],
                ""
            ))
            .0
            .as_deref(),
            Some(title)
        );
    }
}

#[test]
fn unknown_authors_bad_types_and_bad_unicode_are_omitted() {
    for author in [
        "(Unknown)",
        "(Anonymous)",
        "(Unknown Author)",
        "(N/A)",
        "( )",
        "123",
        "[ (Jane) ]",
        "<FEFFD800>",
        "<FEFF004142>",
        "(Jane\\000Doe)",
        "(Producer Name)",
    ] {
        let pdf = fixture::classic(
            format!("<< /Title (Meaningful Title) /Author {author} /Producer (Producer Name) >>")
                .as_bytes(),
            &[],
            "",
        );
        assert!(extract(&pdf).1.is_empty(), "{author}");
    }
    let text = "a".repeat(MAX_TEXT_BYTES + 1);
    assert!(
        extract(&fixture::classic(
            format!("<< /Author ({text}) >>").as_bytes(),
            &[],
            ""
        ))
        .1
        .is_empty()
    );
}

#[test]
fn unrelated_dictionary_is_not_metadata_and_cycles_fail_safely() {
    let pdf = fixture::classic(
        b"<< /Author 5 0 R >>",
        &[b"6 0 R", b"5 0 R", b"<< /Author (Decoy Author) >>"],
        "",
    );
    assert_eq!(extract(&pdf), (None, vec![]));
    let pdf = fixture::classic(
        b"<< >>",
        &[b"<< /Author (Decoy Author) /Title (Decoy Title) >>"],
        "",
    );
    assert_eq!(extract(&pdf), (None, vec![]));
}

#[test]
fn encrypted_malformed_and_oversized_inputs_fall_back() {
    for bytes in [
        b"%PDF-1.7\n/Author (Not Real)".to_vec(),
        fixture::classic(
            b"<< /Author (Private Author) >>",
            &[b"<< /Filter /Standard /V 99 >>"],
            "/Encrypt 5 0 R",
        ),
        fixture::compressed(MAX_STREAM_BYTES + 1),
        fixture::compressed_streams(0, MAX_STREAM_BYTES + 1),
    ] {
        assert_eq!(extract(&bytes), (None, vec![]));
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large.pdf");
    let file = File::create(&path).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    for path in [path, temp.path().to_owned(), temp.path().join("absent.pdf")] {
        let (title, authors) = embedded_pdf(&path);
        assert!(title.is_none());
        assert!(authors.is_empty());
    }
}

#[test]
fn latest_incremental_info_wins_over_old_and_decoy_authors() {
    use std::io::Write;

    let mut pdf = fixture::classic(b"<< /Author (Old Author) >>", &[], "");
    let previous =
        std::str::from_utf8(&pdf[pdf.windows(9).rposition(|w| w == b"startxref").unwrap() + 9..])
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<usize>()
            .unwrap();
    let offset = pdf.len();
    pdf.extend(b"4 0 obj\n<< /Title (Revised Title) /Author (New Author) >>\nendobj\n");
    let xref = pdf.len();
    writeln!(pdf, "xref\n4 1\n{offset:010} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R /Prev {previous} >>\nstartxref\n{xref}\n%%EOF").unwrap();
    assert_eq!(
        extract(&pdf),
        (Some("Revised Title".into()), vec!["New Author".into()])
    );
}

#[test]
fn actual_encryption_including_empty_password_is_never_imported() {
    for password in ["", "secret"] {
        let mut document = Document::load_mem(&fixture::classic(
            b"<< /Title (Private Title) /Author (Private Author) >>",
            &[],
            "",
        ))
        .unwrap();
        document.trailer.set(
            "ID",
            Object::Array(vec![
                Object::string_literal("synthetic-id"),
                Object::string_literal("synthetic-id"),
            ]),
        );
        let state = lopdf::EncryptionState::try_from(lopdf::EncryptionVersion::V1 {
            document: &document,
            owner_password: "owner-secret",
            user_password: password,
            permissions: lopdf::Permissions::default(),
        })
        .unwrap();
        document.encrypt(&state).unwrap();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        assert_eq!(extract(&bytes), (None, vec![]));
    }
}
