use super::*;
use std::io::{self, Read, Write};
use std::path::Component;

#[cfg(test)]
mod tests;

const BACKUP_MANIFEST: &str = "manifest.json";

pub(super) fn is_backup_root(root: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(root.join(BACKUP_MANIFEST)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn reject_backup_root(root: &Path) -> AppResult<()> {
    if is_backup_root(root)? {
        return Err(crate::app_error!("library-is-backup"));
    }
    Ok(())
}

// Resolve only the recorded library root, never an owned entry. Canonicalizing
// attachment paths would hide symlink escapes and change their ownership meaning.
pub(super) fn ownership_paths(
    connection: &Connection,
    paths: &LibraryPaths,
) -> AppResult<LibraryPaths> {
    let canonical_root = paths.root.canonicalize()?;
    let mut recorded_root = None;
    let mut statement = connection.prepare(
        "SELECT source_path,'items' FROM library_item_formats WHERE provenance='managed'
         UNION ALL SELECT cover_path,'covers' FROM library_items WHERE cover_path IS NOT NULL",
    )?;
    for entry in statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (path, directory) = entry?;
        let root = existing_owned_root(Path::new(&path), &canonical_root, &directory)?;
        if recorded_root
            .as_ref()
            .is_some_and(|existing| *existing != root)
        {
            return Err(crate::app_error!("integrity-failed"));
        }
        recorded_root = Some(root);
    }
    let Some(root) = recorded_root else {
        return Ok(paths.clone());
    };
    let mut resolved = LibraryPaths::resolve(None, Some(&root.join("library.sqlite")))?;
    resolved.database = paths.database.clone();
    Ok(resolved)
}

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
            Ok(_) => Err(crate::app_error!("destination-exists")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.parents(
                    path.parent()
                        .ok_or_else(|| crate::app_error!("invalid-arguments"))?,
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
            return Err(crate::app_error!("source-invalid"));
        }
        let mut output = self.file(target)?;
        io::copy(&mut input, &mut output)?;
        Ok(())
    }

    fn tree(&mut self, source: &Path, target: &Path) -> AppResult<()> {
        match fs::symlink_metadata(source) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Ok(metadata) if metadata.is_dir() => {}
            _ => return Err(crate::app_error!("source-invalid")),
        }
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|_| crate::app_error!("source-invalid"))?;
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(|_| crate::app_error!("source-invalid"))?;
            let target = target.join(relative);
            if entry.file_type().is_dir() {
                self.directory(&target)?;
            } else if entry.file_type().is_file() {
                self.copy(entry.path(), &target)?;
            } else {
                return Err(crate::app_error!("source-invalid"));
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
        AppError::from_io(crate::error::ErrorCode::DestinationExists, error)
    } else {
        error.into()
    }
}

fn regular_file(path: &Path) -> AppResult<()> {
    if !fs::symlink_metadata(path)
        .map_err(crate::io_error!("source-invalid"))?
        .is_file()
    {
        return Err(crate::app_error!("source-invalid"));
    }
    Ok(())
}

fn normalized(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    crate::library::paths::resolve_for_creation(path).map_err(crate::io_error!("source-invalid"))
}

pub(super) fn disjoint_destination(destination: &Path, source: &Path) -> AppResult<PathBuf> {
    let destination = normalized(destination)?;
    let source = normalized(source)?;
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(crate::app_error!("invalid-arguments"));
    }
    Ok(destination)
}

fn relative_owned<'a>(stored: &'a str, root: &Path) -> AppResult<&'a Path> {
    let relative = Path::new(stored)
        .strip_prefix(root)
        .map_err(|_| crate::app_error!("invalid-stored-data"))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(crate::app_error!("invalid-stored-data"));
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
        return Err(crate::app_error!("incompatible-schema"));
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
        if u64::try_from(bytes).ok() != Some(actual.bytes) || hash != actual.sha256 {
            return Err(crate::app_error!("integrity-failed"));
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
            .ok_or_else(|| crate::app_error!("invalid-arguments"))?,
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
        serde_json::to_vec_pretty(&manifest).map_err(|_| crate::app_error!("backup-failed"))?;
    output
        .file(&destination.join(BACKUP_MANIFEST))?
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
        .map_err(crate::io_error!("source-invalid"))?;
    let destination = disjoint_destination(&paths.root, &source)?;
    // Public LibraryPaths fields must not redirect writes outside the selected root.
    if paths.database.parent() != Some(paths.root.as_path())
        || paths.items != paths.root.join("items")
        || paths.covers != paths.root.join("covers")
        || paths.jobs != paths.root.join("jobs.sqlite")
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let name = paths
        .database
        .file_name()
        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
    if ["items", "covers", "jobs.sqlite", BACKUP_MANIFEST]
        .iter()
        .any(|reserved| name == *reserved)
    {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let paths = LibraryPaths::resolve(None, Some(&destination.join(name)))?;
    for path in [&paths.database, &paths.jobs, &paths.items, &paths.covers] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(crate::app_error!("destination-exists"));
        }
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        if fs::symlink_metadata(format!("{}{suffix}", paths.database.display())).is_ok()
            || fs::symlink_metadata(source.join(format!("library.sqlite{suffix}"))).is_ok()
        {
            return Err(crate::app_error!("source-invalid"));
        }
    }
    regular_file(&source.join(BACKUP_MANIFEST))?;
    regular_file(&source.join("library.sqlite"))?;
    const MAX_MANIFEST_BYTES: usize = 64 * 1024;
    let mut manifest_bytes = Vec::new();
    File::open(source.join(BACKUP_MANIFEST))?
        .take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut manifest_bytes)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(crate::app_error!("source-invalid"));
    }
    use serde_json::Value;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|_| crate::app_error!("source-invalid"))?;
    let original_root = manifest
        .get("sourceRoot")
        .and_then(Value::as_str)
        .map(Path::new)
        .ok_or_else(|| crate::app_error!("source-invalid"))?;
    if manifest.get("version").and_then(Value::as_u64) != Some(1)
        || manifest.get("schemaVersion").and_then(Value::as_i64) != Some(LIBRARY_SCHEMA_VERSION)
        || !original_root.is_absolute()
        || original_root
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(crate::app_error!("source-invalid"));
    }
    let original = LibraryPaths::resolve(None, Some(&original_root.join("library.sqlite")))?;
    let mut output = Output::default();
    output.parents(
        destination
            .parent()
            .ok_or_else(|| crate::app_error!("invalid-arguments"))?,
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
