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

pub fn print_success<T: Serialize>(value: T) -> AppResult<()> {
    let line = success_line(value);
    println!("{line}");
    Ok(())
}

pub fn print_json(value: &Value) -> AppResult<()> {
    println!("{value}");
    Ok(())
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
