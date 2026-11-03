use std::io::{self, Write};

use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{code}")]
pub struct AppError {
    code: &'static str,
    exit_code: i32,
}

impl AppError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code, exit_code: 1 }
    }

    #[must_use]
    pub const fn with_exit_code(code: &'static str, exit_code: i32) -> Self {
        Self { code, exit_code }
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub const fn exit_code(&self) -> i32 {
        self.exit_code
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[must_use]
pub fn success_line<T: Serialize>(value: T) -> String {
    json!({ "ok": true, "value": value }).to_string()
}

#[must_use]
pub fn failure_line(code: &str) -> String {
    json!({ "ok": false, "error": { "code": code } }).to_string()
}

/// Write a success envelope as one newline-terminated JSON record.
///
/// # Errors
/// Returns `storage-unavailable` if stdout cannot accept the complete record.
pub fn print_success<T: Serialize>(value: T) -> AppResult<()> {
    let line = success_line(value);
    write_line(&mut io::stdout().lock(), &line)
}

/// Write a JSON value as one newline-terminated record without an envelope.
///
/// # Errors
/// Returns `storage-unavailable` if stdout cannot accept the complete record.
pub fn print_json(value: &Value) -> AppResult<()> {
    write_line(&mut io::stdout().lock(), &value.to_string())
}

fn write_line(writer: &mut impl Write, line: &str) -> AppResult<()> {
    writeln!(writer, "{line}").map_err(AppError::from)
}

impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new("storage-unavailable")
    }
}

impl From<std::io::Error> for AppError {
    fn from(_: std::io::Error) -> Self {
        Self::new("storage-unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::{AppError, failure_line, success_line, write_line};
    use serde_json::{Value, json};
    use std::io::{self, Write};

    #[test]
    fn success_envelope_preserves_values_and_escapes_physical_newlines() -> serde_json::Result<()> {
        for value in [
            Value::Null,
            json!({"title": "First\nSecond\r\n\"quoted\"\\path", "authors": [], "count": 3}),
            json!([true, false, 42, {"nested": "value"}]),
        ] {
            let line = success_line(&value);
            assert!(!line.contains(['\n', '\r']));
            assert_eq!(
                serde_json::from_str::<Value>(&line)?,
                json!({"ok": true, "value": value})
            );
        }
        Ok(())
    }

    #[test]
    fn failure_envelope_contains_only_the_escaped_error_code() -> serde_json::Result<()> {
        let code = "failure\nwith \"quotes\" and \\slashes";
        let line = failure_line(code);
        assert!(!line.contains(['\n', '\r']));
        assert_eq!(
            serde_json::from_str::<Value>(&line)?,
            json!({"ok": false, "error": {"code": code}})
        );
        Ok(())
    }

    #[test]
    fn app_errors_preserve_codes_and_default_or_explicit_status() {
        let default = AppError::new("invalid-arguments");
        assert_eq!(default.code(), "invalid-arguments");
        assert_eq!(default.to_string(), "invalid-arguments");
        assert_eq!(default.exit_code(), 1);
        let explicit = AppError::with_exit_code("interrupted", 130);
        assert_eq!(explicit.code(), "interrupted");
        assert_eq!(explicit.exit_code(), 130);
    }

    #[test]
    fn storage_errors_do_not_leak_internal_details() {
        for error in [
            AppError::from(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private path",
            )),
            AppError::from(rusqlite::Error::InvalidParameterName(
                "private query".into(),
            )),
        ] {
            assert_eq!(error.code(), "storage-unavailable");
            assert_eq!(error.to_string(), "storage-unavailable");
            assert_eq!(error.exit_code(), 1);
        }
    }

    #[test]
    fn record_writer_appends_exactly_one_newline() -> super::AppResult<()> {
        let mut bytes = Vec::new();
        write_line(&mut bytes, &success_line(json!({"title": "two\nlines"})))?;
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(bytes.last(), Some(&b'\n'));
        Ok(())
    }

    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn record_writer_returns_an_error_instead_of_panicking_on_closed_output() {
        let error = write_line(&mut ClosedPipe, &success_line(Value::Null))
            .expect_err("closed output must be reported");
        assert_eq!(error.code(), "storage-unavailable");
    }
}
