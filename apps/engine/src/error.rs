//! Typed application errors with stable wire codes shared by every adapter.
use serde::{Deserialize, Serialize};
use thiserror::Error;

macro_rules! error_codes {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum ErrorCode {
            $($variant),+
        }

        impl ErrorCode {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }

            pub const fn from_wire(value: &str) -> Option<Self> {
                $(if wire_matches(value, $wire) { return Some(Self::$variant); })+
                None
            }
        }
    };
}

const fn wire_matches(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

error_codes! {
    ArtifactInvalid => "artifact-invalid",
    AutomaticBackupDestinationOverlap => "automatic-backup-destination-overlap",
    AutomaticBackupDestinationUnavailable => "automatic-backup-destination-unavailable",
    AutomaticBackupDisabled => "automatic-backup-disabled",
    AutomaticBackupInvalidSettings => "automatic-backup-invalid-settings",
    AutomaticBackupUnsafeSettings => "automatic-backup-unsafe-settings",
    BackendUnavailable => "backend-unavailable",
    BackupFailed => "backup-failed",
    CandidateCoverChanged => "candidate-cover-changed",
    CandidateCoverInvalid => "candidate-cover-invalid",
    CandidateCoverUnavailable => "candidate-cover-unavailable",
    ConversionFailed => "conversion-failed",
    ConversionInterrupted => "conversion-interrupted",
    ConversionTimeout => "conversion-timeout",
    CopyFailed => "copy-failed",
    CoverOutputExists => "cover-output-exists",
    CoverWriteFailed => "cover-write-failed",
    DestinationExists => "destination-exists",
    DestinationFileExists => "destination-file-exists",
    DestinationUnavailable => "destination-unavailable",
    DiagnosticsFailed => "diagnostics-failed",
    DuplicateSourcePreserved => "duplicate-source-preserved",
    EjectFailed => "eject-failed",
    ExtractionFailed => "extraction-failed",
    FormatChanged => "format-changed",
    FormatExists => "format-exists",
    FormatMismatch => "format-mismatch",
    FormatNotFound => "format-not-found",
    IncompatibleSchema => "incompatible-schema",
    InputUnavailable => "input-unavailable",
    IntegrityFailed => "integrity-failed",
    Interrupted => "interrupted",
    InvalidArguments => "invalid-arguments",
    InvalidAttachment => "invalid-attachment",
    InvalidQuery => "invalid-query",
    InvalidRequest => "invalid-request",
    InvalidStoredData => "invalid-stored-data",
    InvalidTitle => "invalid-title",
    InvalidTransition => "invalid-transition",
    ItemTrashed => "item-trashed",
    LastFormat => "last-format",
    LibraryIsBackup => "library-is-backup",
    MaintenanceTimeout => "maintenance-timeout",
    MetadataExtractionFailed => "metadata-extraction-failed",
    MetadataFetchFailed => "metadata-fetch-failed",
    MetadataInvalid => "metadata-invalid",
    MetadataTimeout => "metadata-timeout",
    MetadataUnavailable => "metadata-unavailable",
    MethodNotAllowed => "method-not-allowed",
    MigrationFailed => "migration-failed",
    MissingFile => "missing-file",
    NoCompatibleFormat => "no-compatible-format",
    NoEpubSource => "no-epub-source",
    NotFound => "not-found",
    NotTrashed => "not-trashed",
    OpenFailed => "open-failed",
    OperationCanceled => "operation-canceled",
    OperationInProgress => "operation-in-progress",
    OutputFileExists => "output-file-exists",
    PolishFailed => "polish-failed",
    PreferenceInvalid => "preference-invalid",
    PreferenceUnsafePath => "preference-unsafe-path",
    PrepareBackendChanged => "prepare-backend-changed",
    PrepareSourceChanged => "prepare-source-changed",
    PrepareSourceUnavailable => "prepare-source-unavailable",
    PublicationFailed => "publication-failed",
    ReaderScanInProgress => "reader-scan-in-progress",
    ReaderScanUnavailable => "reader-scan-unavailable",
    RestoreFailed => "restore-failed",
    ResponseTooLarge => "response-too-large",
    RollbackFailed => "rollback-failed",
    SendReviewChanged => "send-review-changed",
    ServerUnavailable => "server-unavailable",
    SourceChanged => "source-changed",
    SourceInvalid => "source-invalid",
    SourceUnavailable => "source-unavailable",
    StaleReview => "stale-review",
    StorageUnavailable => "storage-unavailable",
    TerminalUnavailable => "terminal-unavailable",
    UnknownDestination => "unknown-destination",
    UnknownJob => "unknown-job",
    Unauthorized => "unauthorized",
    Unreadable => "unreadable",
    UnsupportedConversion => "unsupported-conversion",
    UnsupportedFormat => "unsupported-format",
    UnsupportedPlatform => "unsupported-platform",
    VerificationFailed => "verification-failed",
    WriteFailed => "write-failed",
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Construct a typed error from a compile-checked wire literal or an ErrorCode.
/// Unknown literals are compile errors, never runtime fallback values.
///
/// ```compile_fail
/// let error = takio::app_error!("misspelled-error-code");
/// ```
#[macro_export]
macro_rules! app_error {
    ($code:literal $(,)?) => {
        $crate::error::AppError::new(
            const {
                match $crate::error::ErrorCode::from_wire($code) {
                    Some(code) => code,
                    None => panic!("unknown application error code"),
                }
            },
        )
    };
    ($code:expr $(,)?) => {
        $crate::error::AppError::new($code)
    };
}

/// `map_err` adapter for filesystem failures: maps to a compile-checked domain
/// code while preserving the redacted `std::io::ErrorKind` for actionable UI copy.
#[macro_export]
macro_rules! io_error {
    ($code:literal $(,)?) => {
        |error: std::io::Error| {
            $crate::error::AppError::from_io($crate::app_error!($code).kind(), error)
        }
    };
}

#[derive(Clone, Debug, Error)]
#[error("{code}")]
pub struct AppError {
    code: ErrorCode,
    exit_code: i32,
    io_kind: Option<std::io::ErrorKind>,
}

impl AppError {
    #[must_use]
    pub const fn new(code: ErrorCode) -> Self {
        Self {
            code,
            exit_code: 1,
            io_kind: None,
        }
    }

    #[must_use]
    pub const fn with_exit_code(code: ErrorCode, exit_code: i32) -> Self {
        Self {
            code,
            exit_code,
            io_kind: None,
        }
    }

    /// Preserve the OS failure category without retaining paths or private error text.
    /// Call sites choose a domain code when the operation has a more specific contract.
    #[must_use]
    pub fn from_io(code: ErrorCode, error: std::io::Error) -> Self {
        Self {
            code,
            exit_code: 1,
            io_kind: Some(error.kind()),
        }
    }

    /// Redacted filesystem or equivalent SQLite failure category, when known.
    #[must_use]
    pub const fn io_kind(&self) -> Option<std::io::ErrorKind> {
        self.io_kind
    }

    #[must_use]
    pub const fn kind(&self) -> ErrorCode {
        self.code
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code.as_str()
    }

    #[must_use]
    pub const fn exit_code(&self) -> i32 {
        self.exit_code
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode as SqliteCode;
        use std::io::ErrorKind;

        let io_kind = match error.sqlite_error_code() {
            Some(SqliteCode::DiskFull) => Some(ErrorKind::StorageFull),
            Some(SqliteCode::ReadOnly | SqliteCode::PermissionDenied) => {
                Some(ErrorKind::PermissionDenied)
            }
            Some(SqliteCode::DatabaseBusy | SqliteCode::DatabaseLocked) => {
                Some(ErrorKind::WouldBlock)
            }
            _ => None,
        };
        Self {
            io_kind,
            ..Self::new(ErrorCode::StorageUnavailable)
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::from_io(ErrorCode::StorageUnavailable, error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_has_one_wire_code() {
        assert_eq!(
            crate::app_error!("operation-canceled").kind(),
            ErrorCode::OperationCanceled
        );
        assert_eq!(ErrorCode::from_wire("query-cancelled"), None);
    }

    #[test]
    fn io_errors_keep_redacted_kind_and_explicit_codes() {
        use std::io::{Error, ErrorKind};
        for kind in [
            ErrorKind::NotFound,
            ErrorKind::PermissionDenied,
            ErrorKind::AlreadyExists,
            ErrorKind::BrokenPipe,
            ErrorKind::StorageFull,
        ] {
            let error = AppError::from(Error::new(kind, "private file path"));
            assert_eq!(error.kind(), ErrorCode::StorageUnavailable);
            assert_eq!(error.io_kind(), Some(kind));
            assert_eq!(error.to_string(), "storage-unavailable");
            let explicit = AppError::from_io(
                ErrorCode::CopyFailed,
                Error::new(kind, "private device path"),
            );
            assert_eq!(explicit.kind(), ErrorCode::CopyFailed);
            assert_eq!(explicit.clone().io_kind(), Some(kind));
            assert_eq!(explicit.exit_code(), 1);
            assert!(!format!("{explicit:?}").contains("private"));
        }
        assert_eq!(AppError::new(ErrorCode::InvalidArguments).io_kind(), None);
    }

    fn assert_sqlite_category(error: rusqlite::Error, kind: std::io::ErrorKind) {
        let error = AppError::from(error);
        assert_eq!(error.kind(), ErrorCode::StorageUnavailable);
        assert_eq!(error.io_kind(), Some(kind));
        assert_eq!(error.exit_code(), 1);
        assert_eq!(error.to_string(), "storage-unavailable");
        assert!(!format!("{error:?}").contains("private"));
    }

    #[test]
    fn sqlite_full_database_preserves_storage_full_category() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA max_page_count = 2; CREATE TABLE private_books (content BLOB);")
            .unwrap();
        let error = connection
            .execute("INSERT INTO private_books VALUES (zeroblob(65536))", [])
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DiskFull)
        );
        assert_sqlite_category(error, std::io::ErrorKind::StorageFull);
    }

    #[test]
    fn sqlite_readonly_database_preserves_permission_category() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private-library.sqlite");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute("CREATE TABLE private_books (title TEXT)", [])
            .unwrap();
        drop(connection);
        let connection =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let error = connection
            .execute("INSERT INTO private_books VALUES ('private title')", [])
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ReadOnly)
        );
        assert_sqlite_category(error, std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn sqlite_busy_database_preserves_retryable_category() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private-library.sqlite");
        let first = rusqlite::Connection::open(&path).unwrap();
        let second = rusqlite::Connection::open(&path).unwrap();
        second.busy_timeout(std::time::Duration::ZERO).unwrap();
        first.execute_batch("BEGIN IMMEDIATE").unwrap();
        let error = second.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert_sqlite_category(error, std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn sqlite_categories_redact_messages_without_guessing_other_failures() {
        for (code, expected) in [
            (
                rusqlite::ffi::SQLITE_PERM,
                Some(std::io::ErrorKind::PermissionDenied),
            ),
            (
                rusqlite::ffi::SQLITE_LOCKED,
                Some(std::io::ErrorKind::WouldBlock),
            ),
            (rusqlite::ffi::SQLITE_CORRUPT, None),
            (rusqlite::ffi::SQLITE_CANTOPEN, None),
        ] {
            let error = AppError::from(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("private database path".into()),
            ));
            assert_eq!(error.io_kind(), expected);
            assert_eq!(error.kind(), ErrorCode::StorageUnavailable);
            assert!(!format!("{error:?}").contains("private"));
        }
        let error = AppError::from(rusqlite::Error::QueryReturnedNoRows);
        assert_eq!(error.io_kind(), None);
    }

    #[test]
    fn every_error_code_preserves_its_wire_string() {
        let mut seen = std::collections::BTreeSet::new();
        for &code in ErrorCode::ALL {
            let wire = code.as_str();
            assert!(seen.insert(wire), "duplicate wire code: {wire}");
            assert_eq!(serde_json::to_value(code).unwrap(), serde_json::json!(wire));
            assert_eq!(
                serde_json::from_value::<ErrorCode>(serde_json::json!(wire)).unwrap(),
                code
            );
            assert_eq!(ErrorCode::from_wire(wire), Some(code));
        }
        assert_eq!(ErrorCode::from_wire("destination-format-unsupported"), None);
        assert_eq!(ErrorCode::from_wire("item-not-found"), None);
        assert!(serde_json::from_str::<ErrorCode>("\"unknown-code\"").is_err());
    }
}
