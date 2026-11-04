//! Stable application errors shared by engine modules and presentation adapters.
use thiserror::Error;

#[derive(Clone, Debug, Error)]
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
    use super::*;

    #[test]
    fn output_compatibility_reexport_is_the_same_error_type() {
        let error: crate::output::AppError = AppError::with_exit_code("not-found", 3);
        fn compatibility_result(error: AppError) -> crate::output::AppResult<()> {
            Err(error)
        }
        let error = compatibility_result(error).unwrap_err();
        assert_eq!(error.code(), "not-found");
        assert_eq!(error.exit_code(), 3);
        assert_eq!(error.to_string(), "not-found");
    }
}
