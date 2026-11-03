use std::io::Write;

/// Synthetic one-page PDF, with byte-accurate xrefs independent of lopdf's writer.
pub fn classic(info: &[u8], extra: &[&[u8]], trailer_extra: &str) -> Vec<u8> {
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>".to_vec(),
        info.to_vec(),
    ];
    objects.extend(extra.iter().map(|bytes| bytes.to_vec()));
    let mut pdf = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        writeln!(pdf, "{} 0 obj", index + 1).unwrap();
        pdf.extend(object);
        pdf.extend(b"\nendobj\n");
    }
    let xref = pdf.len();
    writeln!(pdf, "xref\n0 {}\n0000000000 65535 f ", offsets.len()).unwrap();
    for offset in &offsets[1..] {
        writeln!(pdf, "{offset:010} 00000 n ").unwrap();
    }
    writeln!(
        pdf,
        "trailer\n<< /Size {} /Root 1 0 R /Info 4 0 R {trailer_extra} >>\nstartxref\n{xref}\n%%EOF",
        offsets.len()
    )
    .unwrap();
    pdf
}

/// The Info dictionary and both of its values are compressed indirect objects.
/// Padding can deliberately expand beyond the metadata reader's stream budget.
pub fn compressed(padding: usize) -> Vec<u8> {
    compressed_streams(padding, 0)
}

pub fn compressed_streams(padding: usize, xref_padding: usize) -> Vec<u8> {
    let values: [&[u8]; 3] = [
        b"<< /Title 6 0 R /Author 5 0 R >>",
        b"(Jane \\(Example\\) \\226)",
        b"<FEFF0054006800650020005100750069006500740020005300650061>",
    ];
    let mut body = Vec::new();
    let mut header = String::new();
    for (index, value) in values.iter().enumerate() {
        header.push_str(&format!("{} {} ", index + 4, body.len()));
        body.extend(*value);
        body.push(b' ');
    }
    let first = header.len();
    let mut raw = header.into_bytes();
    raw.extend(body);
    raw.resize(raw.len() + padding, b' ');
    let encoded = deflate(&raw);
    let mut pdf = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = [0_usize; 9];
    for (id, object) in [
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".as_slice()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".as_slice()),
        (
            3,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>".as_slice(),
        ),
    ] {
        offsets[id] = pdf.len();
        writeln!(pdf, "{id} 0 obj").unwrap();
        pdf.extend(object);
        pdf.extend(b"\nendobj\n");
    }
    offsets[7] = pdf.len();
    writeln!(
        pdf,
        "7 0 obj\n<< /Type /ObjStm /N 3 /First {first} /Filter /FlateDecode /Length {} >>\nstream",
        encoded.len()
    )
    .unwrap();
    pdf.extend(encoded);
    pdf.extend(b"\nendstream\nendobj\n");
    offsets[8] = pdf.len();
    let mut xref = Vec::new();
    for (id, offset) in offsets.iter().enumerate() {
        let (kind, field, generation) = match id {
            0 => (0, 0, 65535_u16),
            4..=6 => (2, 7, (id - 4) as u16),
            _ => (1, *offset as u32, 0),
        };
        xref.push(kind);
        xref.extend(field.to_be_bytes());
        xref.extend(generation.to_be_bytes());
    }
    xref.resize(xref.len() + xref_padding, 0);
    let xref = deflate(&xref);
    writeln!(pdf, "8 0 obj\n<< /Type /XRef /Size 9 /Root 1 0 R /Info 4 0 R /W [1 4 2] /Filter /FlateDecode /Length {} >>\nstream", xref.len()).unwrap();
    pdf.extend(xref);
    writeln!(pdf, "\nendstream\nendobj\nstartxref\n{}\n%%EOF", offsets[8]).unwrap();
    pdf
}

fn deflate(raw: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(raw).unwrap();
    encoder.finish().unwrap()
}
