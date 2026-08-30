use std::path::{Path, PathBuf};

use directories::ProjectDirs;

use crate::output::{AppError, AppResult};

#[derive(Clone, Debug)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub jobs: PathBuf,
    pub items: PathBuf,
    pub covers: PathBuf,
}

impl LibraryPaths {
    pub fn resolve(library: Option<&str>, database: Option<&Path>) -> AppResult<Self> {
        if library.is_some() && database.is_some() {
            return Err(AppError::new("invalid-arguments"));
        }

        let database = if let Some(path) = database {
            absolute(path)?
        } else {
            let project = ProjectDirs::from("com", "takio", "Takio")
                .ok_or_else(|| AppError::new("storage-unavailable"))?;
            let root = project.data_local_dir();
            match library {
                Some(name) => {
                    validate_library_name(name)?;
                    root.join("libraries").join(name).join("library.sqlite")
                }
                None => root.join("library.sqlite"),
            }
        };
        let root = database
            .parent()
            .ok_or_else(|| AppError::new("invalid-arguments"))?
            .to_path_buf();
        Ok(Self {
            jobs: root.join("jobs.sqlite"),
            items: root.join("items"),
            covers: root.join("covers"),
            root,
            database,
        })
    }
}

fn absolute(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(AppError::new("invalid-arguments"));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn validate_library_name(name: &str) -> AppResult<()> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(AppError::new("invalid-arguments"))
    }
}
