pub(super) const BACKUP_BUSY: &str = "Finish the current operation or save/cancel your edits, then choose Back Up Library again. No new backup was started.";
pub(super) const RESTORE_BUSY: &str = "Finish the current operation or save/cancel your edits, then choose Restore Backup again. No restore was started.";
pub(super) const BACKUP_DETAIL: &str = "Includes the catalogue, Trash and managed files. External referenced files and conversion jobs are not included. Keep a copy on a separate drive.";
pub const SWITCH_BUSY: &str = "Finish the current operation, save/cancel edits and close any review before opening another library.";
pub(super) const SEND_CANCELLED: &str = "Send review cancelled. Nothing was sent.";
pub(super) const PREPARATION_CANCELLED: &str = "Preparation cancelled. No copy was prepared.";

pub(super) fn send_review(ready: usize, blocked: usize) -> String {
    format!("Review send: {ready} ready, {blocked} need attention. Nothing sent yet.")
}

pub(super) fn restore_detail(referenced_formats: u64) -> String {
    format!(
        "Your current library is unchanged and still open. {referenced_formats} external reference(s) still need their original files. Conversion jobs are not restored."
    )
}

pub(super) fn preparation_started() -> String {
    format!(
        "Preparing an AZW3 copy locally ({}-second conversion limit). EPUB kept. Nothing sent.",
        takio::conversion::prepare::PREPARATION_TIMEOUT.as_secs()
    )
}

pub fn humanize_app_error(error: &takio::error::AppError) -> String {
    with_io_hint(humanize_error(error.kind()), error)
}

/// Open-library wording plus the same actionable disk-full/permission hint.
pub(super) fn open_library_app_error(error: &takio::error::AppError) -> String {
    with_io_hint(open_library_error(error.kind()), error)
}

/// Recovery wording plus the same actionable disk-full/permission hint.
pub(super) fn humanize_recovery_app_error(error: &takio::error::AppError) -> String {
    with_io_hint(humanize_recovery_error(error.kind()), error)
}

fn with_io_hint(message: String, error: &takio::error::AppError) -> String {
    match error.io_kind() {
        Some(std::io::ErrorKind::StorageFull) => {
            format!("{message} The disk is full. Free space and retry.")
        }
        Some(std::io::ErrorKind::PermissionDenied) => {
            format!("{message} Permission was denied. Check access permissions and retry.")
        }
        _ => message,
    }
}

#[cfg(test)]
mod io_tests {
    #[test]
    fn actionable_io_messages_keep_private_details_redacted() {
        for (kind, expected) in [
            (std::io::ErrorKind::StorageFull, "disk is full"),
            (
                std::io::ErrorKind::PermissionDenied,
                "Permission was denied",
            ),
        ] {
            let error = takio::error::AppError::from_io(
                takio::error::ErrorCode::WriteFailed,
                std::io::Error::new(kind, "private/path"),
            );
            let message = super::humanize_app_error(&error);
            assert!(message.contains(expected));
            assert!(!message.contains("private/path"));
        }
        let error = takio::app_error!("write-failed");
        assert_eq!(
            super::humanize_app_error(&error),
            super::humanize_error(error.kind())
        );
        let full = takio::error::AppError::from_io(
            takio::error::ErrorCode::BackupFailed,
            std::io::Error::new(std::io::ErrorKind::StorageFull, "private/path"),
        );
        let message = super::humanize_recovery_app_error(&full);
        assert!(message.starts_with(&super::humanize_recovery_error(full.kind())));
        assert!(message.contains("disk is full"));
        assert!(!message.contains("private/path"));
    }
}

pub fn humanize_error(code: takio::error::ErrorCode) -> String {
    use takio::error::ErrorCode::*;
    match code {
        ConversionInterrupted => "The conversion was interrupted. The original file was kept. Retry the job when ready.".into(),
        InvalidAttachment => "The converted copy could not be attached to that book. Review the job and library selection.".into(),
        InvalidRequest | MethodNotAllowed | MissingFile | ResponseTooLarge | Unauthorized => "The content server could not complete that request. Check access and request details.".into(),
        OperationInProgress => "Finish the current operation first".into(),
        ReaderScanUnavailable => "Reader scanning could not start. Restart Takio to retry. Your library is still available.".into(),
        StorageUnavailable => "The library could not be read".into(),
        UnsupportedFormat => "That file format is not supported".into(),
        NotFound => "That book is no longer in the library".into(),
        DestinationUnavailable | UnknownDestination => "The reader is no longer available. Reconnect it with a data-capable USB cable. It reappears in a moment, or choose Refresh readers, then try again.".into(),
        SourceUnavailable => "The book's file is unavailable. Check that its drive is connected and the file still exists, then try again.".into(),
        CopyFailed => "The copy could not be completed. Check the reader connection, available space, and write permissions before retrying.".into(),
        VerificationFailed => "The copied book could not be verified. Do not rely on this transfer. Check the reader connection and try again.".into(),
        DestinationFileExists => "A file with that name already exists on the reader".into(),
        SendReviewChanged => "The compatible attachment changed after review. Review the send again before copying.".into(),
        PrepareSourceUnavailable => "The EPUB source cannot be read. Reconnect its drive and check file permissions, then review preparation again.".into(),
        PrepareSourceChanged => "The EPUB changed after review. Review preparation again before creating a copy.".into(),
        PrepareBackendChanged => "The conversion backend changed after review. Review preparation again before creating a copy.".into(),
        NoEpubSource => "No EPUB is attached to this book. Add an EPUB source before preparing an AZW3 copy.".into(),
        FormatExists => "An AZW3 copy is already attached. Review send to use it. Existing files were not replaced.".into(),
        DestinationExists => "A file already exists at the managed destination. It was not overwritten, and its existing bytes were kept. Review the library files before retrying.".into(),
        ItemTrashed => "This book is in Trash. Restore it to the library, then review the operation again.".into(),
        BackendUnavailable => "Local preparation needs Calibre's ebook-convert. Install Calibre, then cancel and review preparation again. Nothing was converted or sent.".into(),
        ConversionFailed => "AZW3 preparation failed. The EPUB was kept. Check that the EPUB opens and the local converter works, then retry.".into(),
        ConversionTimeout => format!("AZW3 preparation exceeded the {}-second conversion limit. The EPUB was kept. Check the source and local converter before retrying.", takio::conversion::prepare::PREPARATION_TIMEOUT.as_secs()),
        ArtifactInvalid => "The converted file could not be verified. The EPUB was kept. Check the source and local converter before retrying.".into(),
        FormatNotFound => "That book has no file to send".into(),
        NoCompatibleFormat => "No file this reader can open. KOReader reads EPUB, PDF, MOBI, AZW3, TXT and CBZ. A stock Kindle needs AZW3, MOBI, PDF or TXT.".into(),
        InvalidArguments => "Check the book details and selection, then try again".into(),
        InvalidTitle => "Title is required.".into(),
        ReaderScanInProgress => "Reader scan is still finishing. Wait for it to stop, then try Eject again.".into(),
        EjectFailed => "The reader could not be ejected".into(),
        AutomaticBackupDestinationOverlap | AutomaticBackupDestinationUnavailable
        | AutomaticBackupDisabled | AutomaticBackupInvalidSettings | AutomaticBackupUnsafeSettings
        | BackupFailed | CandidateCoverChanged | CandidateCoverInvalid | CandidateCoverUnavailable
        | CoverOutputExists | CoverWriteFailed | DiagnosticsFailed | DuplicateSourcePreserved
        | ExtractionFailed | FormatChanged | FormatMismatch | IncompatibleSchema | InputUnavailable
        | IntegrityFailed | Interrupted | InvalidQuery | InvalidStoredData
        | InvalidTransition | LastFormat | LibraryIsBackup | MaintenanceTimeout
        | MetadataExtractionFailed | MetadataFetchFailed | MetadataInvalid | MetadataTimeout
        | MetadataUnavailable | MigrationFailed | NotTrashed | OpenFailed | OperationCanceled
        | OutputFileExists | PolishFailed | PreferenceInvalid | PreferenceUnsafePath
        | PublicationFailed | RestoreFailed | RollbackFailed | ServerUnavailable
        | SourceChanged | SourceInvalid | StaleReview | TerminalUnavailable | UnknownJob
        | Unreadable | UnsupportedConversion | UnsupportedPlatform | WriteFailed => {
            format!("Something went wrong ({code})")
        }
    }
}

pub(super) fn humanize_recovery_error(code: takio::error::ErrorCode) -> String {
    use takio::error::ErrorCode::*;
    match code {
        ConversionInterrupted | InvalidAttachment => "The conversion attachment failed. Your current library was not replaced.".into(),
        InvalidRequest | MethodNotAllowed | MissingFile | ResponseTooLarge | Unauthorized => "The server request failed. Your current library was not replaced.".into(),
        DestinationExists => "That location already exists. Choose a new folder name. Existing files were not replaced.".into(),
        InvalidArguments => "Choose a new folder outside the current library and backup. Do not place recovery copies inside either library.".into(),
        SourceInvalid | IncompatibleSchema | InvalidStoredData => "This is not a supported, safe Takio backup. Choose the complete backup folder created by a compatible Takio version. Your current library was not replaced.".into(),
        IntegrityFailed => "The recovery copy could not be verified. A managed file or catalogue may be missing or changed. Keep the original library and try a different backup or destination.".into(),
        ArtifactInvalid | AutomaticBackupDestinationOverlap | AutomaticBackupDestinationUnavailable
        | AutomaticBackupDisabled | AutomaticBackupInvalidSettings | AutomaticBackupUnsafeSettings
        | BackendUnavailable | BackupFailed | CandidateCoverChanged | CandidateCoverInvalid
        | CandidateCoverUnavailable | ConversionFailed | ConversionTimeout | CopyFailed
        | CoverOutputExists | CoverWriteFailed | DestinationFileExists | DestinationUnavailable
        | DiagnosticsFailed | DuplicateSourcePreserved | EjectFailed | ExtractionFailed | FormatChanged
        | FormatExists | FormatMismatch | FormatNotFound | InputUnavailable | Interrupted | InvalidQuery
        | InvalidTitle | InvalidTransition | ItemTrashed | LastFormat | LibraryIsBackup
        | MaintenanceTimeout | MetadataExtractionFailed | MetadataFetchFailed | MetadataInvalid
        | MetadataTimeout | MetadataUnavailable | MigrationFailed | NoCompatibleFormat | NoEpubSource
        | NotFound | NotTrashed | OpenFailed | OperationCanceled | OperationInProgress | OutputFileExists
        | PolishFailed | PreferenceInvalid | PreferenceUnsafePath | PrepareBackendChanged
        | PrepareSourceChanged | PrepareSourceUnavailable | PublicationFailed
        | ReaderScanInProgress | ReaderScanUnavailable | RestoreFailed | RollbackFailed
        | SendReviewChanged | ServerUnavailable | SourceChanged | SourceUnavailable | StaleReview
        | StorageUnavailable | TerminalUnavailable | UnknownDestination | UnknownJob | Unreadable
        | UnsupportedConversion | UnsupportedFormat | UnsupportedPlatform | VerificationFailed
        | WriteFailed => "The recovery copy could not be completed. Check free space, drive connections and permissions. Your current library was not replaced. Inspect the destination before retrying with a new folder name.".into(),
    }
}

pub(super) fn open_library_error(code: takio::error::ErrorCode) -> String {
    use takio::error::ErrorCode::*;
    let reason = match code {
        ConversionInterrupted | InvalidAttachment => "The conversion job could not be completed.",
        InvalidRequest | MethodNotAllowed | MissingFile | ResponseTooLarge | Unauthorized => {
            "The content server request could not be completed."
        }
        LibraryIsBackup => {
            "This folder is a backup snapshot. Use Restore Backup to New Folder, then open the restored copy."
        }
        IncompatibleSchema => {
            "This library uses an unsupported schema. Open a compatible copy or upgrade it with the appropriate Takio version first."
        }
        IntegrityFailed | InvalidStoredData => {
            "The selected library failed catalogue validation. Restore a known-good backup to a new folder."
        }
        ArtifactInvalid
        | AutomaticBackupDestinationOverlap
        | AutomaticBackupDestinationUnavailable
        | AutomaticBackupDisabled
        | AutomaticBackupInvalidSettings
        | AutomaticBackupUnsafeSettings
        | BackendUnavailable
        | BackupFailed
        | CandidateCoverChanged
        | CandidateCoverInvalid
        | CandidateCoverUnavailable
        | ConversionFailed
        | ConversionTimeout
        | CopyFailed
        | CoverOutputExists
        | CoverWriteFailed
        | DestinationExists
        | DestinationFileExists
        | DestinationUnavailable
        | DiagnosticsFailed
        | DuplicateSourcePreserved
        | EjectFailed
        | ExtractionFailed
        | FormatChanged
        | FormatExists
        | FormatMismatch
        | FormatNotFound
        | InputUnavailable
        | Interrupted
        | InvalidArguments
        | InvalidQuery
        | InvalidTitle
        | InvalidTransition
        | ItemTrashed
        | LastFormat
        | MaintenanceTimeout
        | MetadataExtractionFailed
        | MetadataFetchFailed
        | MetadataInvalid
        | MetadataTimeout
        | MetadataUnavailable
        | MigrationFailed
        | NoCompatibleFormat
        | NoEpubSource
        | NotFound
        | NotTrashed
        | OpenFailed
        | OperationCanceled
        | OperationInProgress
        | OutputFileExists
        | PolishFailed
        | PreferenceInvalid
        | PreferenceUnsafePath
        | PrepareBackendChanged
        | PrepareSourceChanged
        | PrepareSourceUnavailable
        | PublicationFailed
        | ReaderScanInProgress
        | ReaderScanUnavailable
        | RestoreFailed
        | RollbackFailed
        | SendReviewChanged
        | ServerUnavailable
        | SourceChanged
        | SourceInvalid
        | SourceUnavailable
        | StaleReview
        | StorageUnavailable
        | TerminalUnavailable
        | UnknownDestination
        | UnknownJob
        | Unreadable
        | UnsupportedConversion
        | UnsupportedFormat
        | UnsupportedPlatform
        | VerificationFailed
        | WriteFailed => {
            "Could not open that library. Choose an existing Takio folder containing library.sqlite and check its access permissions."
        }
    };
    format!("{reason} Your current library is still open and unchanged.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_code_has_explicit_native_messages() {
        for &code in takio::error::ErrorCode::ALL {
            assert!(!humanize_error(code).is_empty(), "{code}");
            assert!(!humanize_recovery_error(code).is_empty(), "{code}");
            assert!(
                open_library_error(code)
                    .ends_with("Your current library is still open and unchanged."),
                "{code}"
            );
        }
    }
}
