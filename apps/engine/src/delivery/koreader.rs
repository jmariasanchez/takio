//! Read-only KOReader reading state from the sidecars it keeps next to each book.
//!
//! KOReader stores per-book settings as a Lua table in `<book>.sdr/metadata.<ext>.lua`
//! (or a mirror under `koreader/docsettings`). The file is never executed: a small
//! tokenizer reads only the top-level `percent_finished` number and the
//! `summary.status` string, and anything malformed yields no reading state.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Settings with many highlights can grow, and keys are written in sorted order, so
/// `percent_finished` and `summary` come after `bookmarks`. Larger files are skipped.
const MAX_SIDECAR_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingState {
    /// Fraction read, 0.0 to 1.0, as KOReader last recorded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// KOReader's book status: `reading`, `complete` or `abandoned`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

impl ReadingState {
    #[must_use]
    pub fn finished(&self) -> bool {
        self.status.as_deref() == Some("complete")
    }

    #[must_use]
    pub fn in_progress(&self) -> bool {
        !self.finished()
            && self.status.as_deref() != Some("abandoned")
            && self.percent.is_some_and(|percent| percent > 0.0)
    }

    /// Short human label: "finished", "on hold", "42%".
    #[must_use]
    pub fn label(&self) -> Option<String> {
        match self.status.as_deref() {
            Some("complete") => Some("finished".to_owned()),
            Some("abandoned") => Some("on hold".to_owned()),
            _ => self
                .percent
                .map(|percent| format!("{:.0}%", (percent * 100.0).clamp(0.0, 100.0))),
        }
    }
}

/// Reading state for the book at `relative` (path inside the mounted reader).
#[must_use]
pub fn reading_state(mount: &Path, relative: &Path) -> Option<ReadingState> {
    sidecar_candidates(mount, relative)
        .into_iter()
        .find_map(|path| read_bounded(&path))
        .and_then(|text| parse(&text))
}

fn sidecar_candidates(mount: &Path, relative: &Path) -> Vec<PathBuf> {
    let Some(extension) = relative.extension().and_then(|value| value.to_str()) else {
        return Vec::new();
    };
    let extension = extension.to_ascii_lowercase();
    let mut stem = relative.to_path_buf();
    stem.set_extension("sdr");
    let name = format!("metadata.{extension}.lua");
    let mut candidates = vec![mount.join(&stem).join(&name)];
    // "Book folder" is KOReader's default; "KOReader folder" mirrors device paths.
    candidates.push(
        mount
            .join("koreader/docsettings/mnt/us")
            .join(&stem)
            .join(&name),
    );
    candidates
}

fn read_bounded(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SIDECAR_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_SIDECAR_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[derive(Debug, PartialEq)]
enum Token {
    Open,
    Close,
    Equals,
    Separator,
    Key(String),
    Text(String),
    Number(f64),
    Word(String),
}

/// Parse only what Takio shows. Returns `None` unless the file is one Lua table
/// and at least one of the two fields is present and well formed.
fn parse(text: &str) -> Option<ReadingState> {
    let tokens = tokenize(text)?;
    let mut depth = 0usize;
    let mut path: Vec<Option<String>> = Vec::new();
    let mut pending_key: Option<String> = None;
    let mut state = ReadingState {
        percent: None,
        status: None,
    };
    let mut iter = tokens.into_iter().peekable();
    // Optional leading `return`.
    if iter.peek() == Some(&Token::Word("return".to_owned())) {
        iter.next();
    }
    if iter.next()? != Token::Open {
        return None;
    }
    depth += 1;
    path.push(None);
    while let Some(token) = iter.next() {
        match token {
            Token::Key(key) => {
                if iter.next()? != Token::Equals {
                    return None;
                }
                pending_key = Some(key);
                continue;
            }
            Token::Open => {
                depth += 1;
                if depth > 64 {
                    return None;
                }
                path.push(pending_key.take());
                continue;
            }
            Token::Close => {
                depth = depth.checked_sub(1)?;
                path.pop();
                if depth == 0 {
                    break;
                }
            }
            Token::Number(value) => {
                if depth == 1 && pending_key.as_deref() == Some("percent_finished") {
                    state.percent = value.is_finite().then_some(value.clamp(0.0, 1.0));
                }
            }
            Token::Text(value) => {
                let in_summary =
                    depth == 2 && path.last().and_then(Option::as_deref) == Some("summary");
                if in_summary && pending_key.as_deref() == Some("status") {
                    state.status = Some(value);
                }
            }
            Token::Word(_) | Token::Separator | Token::Equals => {}
        }
        pending_key = None;
    }
    if depth != 0 {
        return None;
    }
    (state.percent.is_some() || state.status.is_some()).then_some(state)
}

fn tokenize(text: &str) -> Option<Vec<Token>> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => index += 1,
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'{' => {
                tokens.push(Token::Open);
                index += 1;
            }
            b'}' => {
                tokens.push(Token::Close);
                index += 1;
            }
            b'=' => {
                tokens.push(Token::Equals);
                index += 1;
            }
            b',' | b';' => {
                tokens.push(Token::Separator);
                index += 1;
            }
            b'[' => {
                // `["key"] =` or `[12] =`. Long strings `[[...]]` are not used by KOReader.
                index += 1;
                let (value, next) = if matches!(bytes.get(index), Some(b'"' | b'\'')) {
                    read_string(bytes, index)?
                } else {
                    let start = index;
                    while index < bytes.len() && bytes[index] != b']' {
                        index += 1;
                    }
                    (text.get(start..index)?.trim().to_owned(), index)
                };
                if bytes.get(next) != Some(&b']') {
                    return None;
                }
                tokens.push(Token::Key(value));
                index = next + 1;
            }
            b'"' | b'\'' => {
                let (value, next) = read_string(bytes, index)?;
                tokens.push(Token::Text(value));
                index = next;
            }
            b'0'..=b'9' | b'.' | b'-' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && matches!(bytes[index], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-' | b'x' | b'X' | b'a'..=b'f' | b'A'..=b'F')
                {
                    index += 1;
                }
                tokens.push(Token::Number(text.get(start..index)?.parse().ok()?));
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                let word = text.get(start..index)?.to_owned();
                // `name = value` uses a bare identifier as a key; `==` is never a key.
                let rest = text.get(index..)?.trim_start();
                if rest.starts_with('=') && !rest.starts_with("==") {
                    tokens.push(Token::Key(word));
                } else {
                    tokens.push(Token::Word(word));
                }
            }
            _ => return None,
        }
    }
    Some(tokens)
}

/// Read a quoted Lua string starting at `start` (the quote). Returns the value and the
/// index just past the closing quote.
fn read_string(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let quote = bytes[start];
    let mut index = start + 1;
    let mut value = Vec::new();
    while index < bytes.len() {
        match bytes[index] {
            byte if byte == quote => {
                return Some((String::from_utf8(value).ok()?, index + 1));
            }
            b'\\' => {
                let escaped = *bytes.get(index + 1)?;
                value.push(match escaped {
                    b'n' => b'\n',
                    b't' => b'\t',
                    b'r' => b'\r',
                    other => other,
                });
                index += 2;
            }
            b'\n' => return None,
            byte => {
                value.push(byte);
                index += 1;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like a real KOReader `metadata.epub.lua`, including keys sorted before
    /// the ones Takio reads and decoys inside nested tables and strings.
    const REAL: &str = r#"-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "Chapter 3",
            ["text"] = "she said \"percent_finished\" = 0.99 and laughed",
            ["percent_finished"] = 0.99,
        },
    },
    ["cre_dom_version"] = 20240114,
    ["doc_pages"] = 312,
    ["doc_path"] = "/mnt/us/documents/Octavia E. Butler - Kindred.epub",
    ["doc_props"] = {
        ["authors"] = "Octavia E. Butler",
        ["title"] = "Kindred",
    },
    ["last_xpointer"] = "/body/DocFragment[12]/body/p[3]/text().0",
    ["percent_finished"] = 0.42307692307692,
    ["stats"] = {
        ["status"] = "not this one",
        ["pages"] = 312,
    },
    ["summary"] = {
        ["modified"] = "2026-10-20",
        ["status"] = "reading",
    },
}
"#;

    #[test]
    fn reads_only_top_level_progress_and_summary_status() {
        let state = parse(REAL).unwrap();
        assert_eq!(state.percent, Some(0.42307692307692));
        assert_eq!(state.status.as_deref(), Some("reading"));
        assert_eq!(state.label().as_deref(), Some("42%"));
        assert!(state.in_progress() && !state.finished());
    }

    #[test]
    fn finished_and_on_hold_labels() {
        let complete = parse(
            r#"return { ["percent_finished"] = 1, ["summary"] = { ["status"] = "complete" } }"#,
        )
        .unwrap();
        assert!(complete.finished() && !complete.in_progress());
        assert_eq!(complete.label().as_deref(), Some("finished"));
        let held =
            parse(r#"return {["summary"]={["status"]="abandoned"},["percent_finished"]=0.3}"#)
                .unwrap();
        assert_eq!(held.label().as_deref(), Some("on hold"));
        assert!(!held.in_progress());
    }

    #[test]
    fn malformed_or_hostile_files_yield_nothing_and_never_run() {
        for text in [
            "",
            "garbage",
            "return {",
            r#"return { ["percent_finished"] = }"#,
            r#"return { ["percent_finished"] = 0.5 "#,
            r#"os.execute("touch /tmp/takio-pwned") return { ["percent_finished"] = 0.5 }"#,
            r#"return { ["summary"] = { ["status"] = "unterminated } }"#,
            r#"return { ["doc_pages"] = 12 }"#,
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }
        assert!(!Path::new("/tmp/takio-pwned").exists());
        // Out-of-range numbers are clamped, never trusted as-is.
        assert_eq!(
            parse(r#"return { ["percent_finished"] = 7.5 }"#)
                .unwrap()
                .percent,
            Some(1.0)
        );
    }

    /// Files written by KOReader's own `frontend/dump.lua` (see
    /// `tests/fixtures/koreader/generate.lua`). The expected values are what LuaJIT
    /// read back from each file with `dofile`.
    #[test]
    fn matches_luajit_on_files_written_by_koreaders_serializer() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/koreader");
        let read = |name: &str| parse(&fs::read_to_string(fixtures.join(name)).unwrap());
        let reading = read("metadata.reading.lua").unwrap();
        assert_eq!(reading.percent, Some(0.67307692307692));
        assert_eq!(reading.status.as_deref(), Some("reading"));
        assert_eq!(reading.label().as_deref(), Some("67%"));
        let complete = read("metadata.complete.lua").unwrap();
        assert_eq!(
            (complete.percent, complete.status.as_deref()),
            (Some(1.0), Some("complete"))
        );
        let abandoned = read("metadata.abandoned.lua").unwrap();
        assert_eq!(
            (abandoned.percent, abandoned.status.as_deref()),
            (Some(0.12), Some("abandoned"))
        );
        let opened = read("metadata.opened.lua").unwrap();
        assert_eq!(
            (opened.percent, opened.status.as_deref()),
            (Some(0.0222222222), None)
        );
        assert_eq!(opened.label().as_deref(), Some("2%"));

        // The same serializer's escaping for a 3,000-highlight book, built in memory.
        let mut large =
            String::from("-- we can read Lua syntax here!\nreturn {\n    [\"annotations\"] = {\n");
        for index in 1..=3000 {
            large.push_str(&format!(
                "        [{index}] = {{\n            [\"chapter\"] = \"Part {index}\",\n            [\"page\"] = {index},\n            [\"text\"] = \"long \\\"quoted\\\" passage\\\nsecond line {index}\",\n        }},\n"
            ));
        }
        large.push_str("    },\n    [\"percent_finished\"] = 0.5,\n    [\"summary\"] = {\n        [\"status\"] = \"reading\",\n    },\n}\n");
        assert!(large.len() > 300_000);
        let started = std::time::Instant::now();
        let state = parse(&large).unwrap();
        assert_eq!(
            (state.percent, state.status.as_deref()),
            (Some(0.5), Some("reading"))
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn finds_book_folder_and_koreader_folder_sidecars_and_ignores_old_files() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path();
        let book = Path::new("documents/Butler/Kindred.epub");
        assert_eq!(reading_state(mount, book), None);

        let sdr = mount.join("documents/Butler/Kindred.sdr");
        fs::create_dir_all(&sdr).unwrap();
        fs::write(sdr.join("metadata.epub.lua.old"), REAL).unwrap();
        assert_eq!(
            reading_state(mount, book),
            None,
            ".old backups are not read"
        );

        let mirror = mount.join("koreader/docsettings/mnt/us/documents/Butler/Kindred.sdr");
        fs::create_dir_all(&mirror).unwrap();
        fs::write(
            mirror.join("metadata.epub.lua"),
            r#"return { ["summary"] = { ["status"] = "complete" } }"#,
        )
        .unwrap();
        assert!(
            reading_state(mount, book).unwrap().finished(),
            "KOReader folder mirror"
        );

        fs::write(sdr.join("metadata.epub.lua"), REAL).unwrap();
        assert_eq!(
            reading_state(mount, book).unwrap().label().as_deref(),
            Some("42%"),
            "book-folder sidecar wins"
        );

        let huge = "x".repeat(usize::try_from(MAX_SIDECAR_BYTES).unwrap() + 1);
        fs::write(sdr.join("metadata.epub.lua"), huge).unwrap();
        fs::remove_dir_all(mount.join("koreader")).unwrap();
        assert_eq!(reading_state(mount, book), None, "oversize sidecar skipped");
    }
}
