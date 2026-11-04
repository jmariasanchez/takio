//! Bounded settings reads and atomic replacement without following reserved symlinks.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};
use takio::error::{AppError, AppResult, ErrorCode};

pub fn regular_or_missing(path: &Path, unsafe_code: ErrorCode) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AppError::new(unsafe_code)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub fn read_bounded(
    path: &Path,
    max: usize,
    unsafe_code: ErrorCode,
    invalid_code: ErrorCode,
) -> AppResult<Option<Vec<u8>>> {
    if !regular_or_missing(path, unsafe_code)? {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(AppError::new(invalid_code));
    }
    Ok(Some(bytes))
}

/// The caller decides whether creating the parent is permitted.
pub fn write_atomic(
    path: &Path,
    parent: &Path,
    bytes: &[u8],
    unsafe_code: ErrorCode,
) -> AppResult<()> {
    regular_or_missing(path, unsafe_code)?;
    let write_error = |_| AppError::new(ErrorCode::WriteFailed);
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(write_error)?;
    staged.write_all(bytes).map_err(write_error)?;
    staged.as_file().sync_all().map_err(write_error)?;
    regular_or_missing(path, unsafe_code)?;
    staged
        .persist(path)
        .map_err(|_| AppError::new(ErrorCode::WriteFailed))?;
    Ok(())
}
