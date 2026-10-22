use super::*;
use std::io::{self, Read, Write};
use std::path::Component;

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;

// Only entries created by this operation are removed on failure. In particular,
// never recursively remove a tree another writer may have added files to.
#[derive(Default)]
struct Output {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    committed: bool,
}

impl Output {
    fn directory(&mut self, path: &Path) -> AppResult<()> {
        fs::create_dir(path).map_err(destination_error)?;
        self.directories.push(path.to_path_buf());
        Ok(())
    }

    fn parents(&mut self, path: &Path) -> AppResult<()> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err(AppError::new("destination-exists")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.parents(
                    path.parent()
                        .ok_or_else(|| AppError::new("invalid-arguments"))?,
                )?;
                self.directory(path)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn file(&mut self, path: &Path) -> AppResult<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(destination_error)?;
        self.files.push(path.to_path_buf());
        Ok(file)
    }

    fn copy(&mut self, source: &Path, target: &Path) -> AppResult<()> {
        regular_file(source)?;
        let mut input = File::open(source)?;
        if !input.metadata()?.is_file() {
            return Err(AppError::new("source-invalid"));
        }
        let mut output = self.file(target)?;
        io::copy(&mut input, &mut output)?;
        Ok(())
    }

    fn tree(&mut self, source: &Path, target: &Path) -> AppResult<()> {
        match fs::symlink_metadata(source) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Ok(metadata) if metadata.is_dir() => {}
            _ => return Err(AppError::new("source-invalid")),
        }
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|_| AppError::new("source-invalid"))?;
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(|_| AppError::new("source-invalid"))?;
            let target = target.join(relative);
            if entry.file_type().is_dir() {
                self.directory(&target)?;
            } else if entry.file_type().is_file() {
                self.copy(entry.path(), &target)?;
            } else {
                return Err(AppError::new("source-invalid"));
            }
        }
        Ok(())
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        if !self.committed {
            for path in self.files.iter().rev() {
                let _ = fs::remove_file(path);
            }
            for path in self.directories.iter().rev() {
                let _ = fs::remove_dir(path);
            }
        }
    }
}

fn destination_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        AppError::new("destination-exists")
    } else {
        error.into()
    }
}

fn regular_file(path: &Path) -> AppResult<()> {
    if !fs::symlink_metadata(path)
        .map_err(|_| AppError::new("source-invalid"))?
        .is_file()
    {
        return Err(AppError::new("source-invalid"));
    }
    Ok(())
}

fn normalized(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut resolved = ancestor
                    .canonicalize()
                    .map_err(|_| AppError::new("source-invalid"))?;
                for component in suffix.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                suffix.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| AppError::new("invalid-arguments"))?
                        .to_os_string(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| AppError::new("invalid-arguments"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(super) fn disjoint_destination(destination: &Path, source: &Path) -> AppResult<PathBuf> {
    let destination = normalized(destination)?;
    let source = normalized(source)?;
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(destination)
}

fn relative_owned<'a>(stored: &'a str, root: &Path) -> AppResult<&'a Path> {
    let relative = Path::new(stored)
        .strip_prefix(root)
        .map_err(|_| AppError::new("invalid-stored-data"))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::new("invalid-stored-data"));
    }
    Ok(relative)
}

// Verify the copied database without executing its schema's write callbacks.
// Fingerprints are checked against the copied tree, never against manifest paths.
fn verify_copy(
    connection: &Connection,
    original: &LibraryPaths,
    copied: &LibraryPaths,
) -> AppResult<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != LIBRARY_SCHEMA_VERSION {
        return Err(AppError::new("incompatible-schema"));
    }
    migration::verify_current(connection, original)?;
    let mut statement = connection.prepare("SELECT source_path,content_bytes,content_sha256 FROM library_item_formats WHERE provenance='managed'")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (stored, bytes, hash) = row?;
        let path = copied.items.join(relative_owned(&stored, &original.items)?);
        regular_file(&path)?;
        let actual = hash_file(&path)?;
        if u64::try_from(bytes).ok() != Some(actual.0) || hash != actual.1 {
            return Err(AppError::new("integrity-failed"));
        }
    }
    let mut statement =
        connection.prepare("SELECT cover_path FROM library_items WHERE cover_path IS NOT NULL")?;
    for stored in statement.query_map([], |row| row.get::<_, String>(0))? {
        regular_file(
            &copied
                .covers
                .join(relative_owned(&stored?, &original.covers)?),
        )?;
    }
    Ok(())
}

pub(super) fn backup(store: &LibraryStore, destination: &Path) -> AppResult<BackupReport> {
    let destination = disjoint_destination(destination, &store.paths.root)?;
    let paths = LibraryPaths::resolve(None, Some(&destination.join("library.sqlite")))?;
    let mut output = Output::default();
    output.parents(
        destination
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?,
    )?;
    output.directory(&destination)?;
    drop(output.file(&paths.database)?);
    let mut connection = Connection::open(&paths.database)?;
    {
        let snapshot = rusqlite::backup::Backup::new(&store.connection, &mut connection)?;
        snapshot.run_to_completion(16, std::time::Duration::from_millis(10), None)?;
    }
    // The snapshot must remain a standalone database, not depend on WAL sidecars.
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    output.tree(&store.paths.items, &paths.items)?;
    output.tree(&store.paths.covers, &paths.covers)?;
    verify_copy(&connection, &store.paths, &paths)?;
    rebase_owned_paths(&mut connection, &store.paths, &paths)?;
    drop(connection);
    let report = LibraryStore::open_read_only(paths.clone())?.verify()?;
    let manifest = serde_json::json!({
        "version": 1, "schemaVersion": LIBRARY_SCHEMA_VERSION,
        "createdAt": Utc::now().to_rfc3339(), "sourceRoot": paths.root,
        "managedFiles": report.managed_formats,
    });
    let manifest =
        serde_json::to_vec_pretty(&manifest).map_err(|_| AppError::new("backup-failed"))?;
    output
        .file(&destination.join("manifest.json"))?
        .write_all(&manifest)?;
    output.committed = true;
    Ok(BackupReport {
        destination_path: paths.root,
        database_path: paths.database,
        managed_files: report.managed_formats,
    })
}

pub(super) fn restore(
    source: &Path,
    paths: LibraryPaths,
    new_root: bool,
) -> AppResult<RestoreReport> {
    let source = source
        .canonicalize()
        .map_err(|_| AppError::new("source-invalid"))?;
    let destination = disjoint_destination(&paths.root, &source)?;
    // Public LibraryPaths fields must not redirect writes outside the selected root.
    if paths.database.parent() != Some(paths.root.as_path())
        || paths.items != paths.root.join("items")
        || paths.covers != paths.root.join("covers")
        || paths.jobs != paths.root.join("jobs.sqlite")
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let name = paths
        .database
        .file_name()
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    if ["items", "covers", "jobs.sqlite", "manifest.json"]
        .iter()
        .any(|reserved| name == *reserved)
    {
        return Err(AppError::new("invalid-arguments"));
    }
    let paths = LibraryPaths::resolve(None, Some(&destination.join(name)))?;
    for path in [&paths.database, &paths.jobs, &paths.items, &paths.covers] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(AppError::new("destination-exists"));
        }
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        if fs::symlink_metadata(format!("{}{suffix}", paths.database.display())).is_ok()
            || fs::symlink_metadata(source.join(format!("library.sqlite{suffix}"))).is_ok()
        {
            return Err(AppError::new("source-invalid"));
        }
    }
    regular_file(&source.join("manifest.json"))?;
    regular_file(&source.join("library.sqlite"))?;
    const MAX_MANIFEST_BYTES: usize = 64 * 1024;
    let mut manifest_bytes = Vec::new();
    File::open(source.join("manifest.json"))?
        .take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut manifest_bytes)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(AppError::new("source-invalid"));
    }
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|_| AppError::new("source-invalid"))?;
    let original_root = manifest
        .get("sourceRoot")
        .and_then(Value::as_str)
        .map(Path::new)
        .ok_or_else(|| AppError::new("source-invalid"))?;
    if manifest.get("version").and_then(Value::as_u64) != Some(1)
        || manifest.get("schemaVersion").and_then(Value::as_i64) != Some(LIBRARY_SCHEMA_VERSION)
        || !original_root.is_absolute()
        || original_root
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(AppError::new("source-invalid"));
    }
    let original = LibraryPaths::resolve(None, Some(&original_root.join("library.sqlite")))?;
    let mut output = Output::default();
    output.parents(
        destination
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?,
    )?;
    if new_root || !destination.try_exists()? {
        output.directory(&destination)?;
    }
    output.copy(&source.join("library.sqlite"), &paths.database)?;
    output.tree(&source.join("items"), &paths.items)?;
    output.tree(&source.join("covers"), &paths.covers)?;
    {
        let connection =
            Connection::open_with_flags(&paths.database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        verify_copy(&connection, &original, &paths)?;
    }
    let mut connection = Connection::open(&paths.database)?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    rebase_owned_paths(&mut connection, &original, &paths)?;
    drop(connection);
    let report = LibraryStore::open_read_only(paths.clone())?.verify()?;
    output.committed = true;
    Ok(RestoreReport {
        source_path: source,
        database_path: paths.database,
        report,
    })
}
