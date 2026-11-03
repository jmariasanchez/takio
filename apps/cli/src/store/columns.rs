//! Library-defined column contracts and ordered definition persistence.
use rusqlite::{OptionalExtension, TransactionBehavior, params};

use super::{LibraryStore, METADATA_AUDIT_KEY};
use crate::model::CustomColumnDefinition;
use crate::output::{AppError, AppResult};

const MAX_CUSTOM_COLUMN_DEFINITIONS: usize = 64;

impl LibraryStore {
    pub fn list_custom_column_definitions(&self) -> AppResult<Vec<CustomColumnDefinition>> {
        let mut statement = self.connection.prepare(
            "SELECT key,label,type,position FROM library_custom_column_definitions ORDER BY position",
        )?;
        let definitions = statement
            .query_map([], |row| {
                Ok(CustomColumnDefinition {
                    key: row.get(0)?,
                    label: row.get(1)?,
                    column_type: row.get(2)?,
                    position: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        validate_custom_column_definitions(&definitions)
            .map_err(|_| AppError::new("incompatible-schema"))?;
        Ok(definitions)
    }

    pub fn create_custom_column_definition(
        &mut self,
        key: &str,
        label: &str,
    ) -> AppResult<CustomColumnDefinition> {
        let label = validate_custom_column_definition(key, label)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: usize = transaction.query_row(
            "SELECT COUNT(*) FROM library_custom_column_definitions",
            [],
            |row| row.get(0),
        )?;
        if count >= MAX_CUSTOM_COLUMN_DEFINITIONS {
            return Err(AppError::new("invalid-arguments"));
        }
        transaction.execute(
            "INSERT INTO library_custom_column_definitions(key,label,type,position) VALUES(?1,?2,'text',?3)",
            params![key, label, count],
        ).map_err(|error| if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            AppError::new("invalid-arguments")
        } else { error.into() })?;
        transaction.commit()?;
        Ok(CustomColumnDefinition {
            key: key.to_owned(),
            label,
            column_type: "text".to_owned(),
            position: count as u32,
        })
    }

    pub fn rename_custom_column_definition(
        &mut self,
        key: &str,
        label: &str,
    ) -> AppResult<CustomColumnDefinition> {
        let label = validate_custom_column_definition(key, label)?;
        let changed = self.connection.execute(
            "UPDATE library_custom_column_definitions SET label=?2 WHERE key=?1",
            params![key, label],
        )?;
        if changed == 0 {
            return Err(AppError::new("not-found"));
        }
        self.connection.query_row(
            "SELECT key,label,type,position FROM library_custom_column_definitions WHERE key=?1",
            [key],
            |row| Ok(CustomColumnDefinition { key: row.get(0)?, label: row.get(1)?, column_type: row.get(2)?, position: row.get(3)? }),
        ).map_err(Into::into)
    }

    pub fn remove_custom_column_definition(
        &mut self,
        key: &str,
    ) -> AppResult<CustomColumnDefinition> {
        if !valid_custom_column_key(key) {
            return Err(AppError::new("invalid-arguments"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let definition = transaction.query_row(
            "SELECT key,label,type,position FROM library_custom_column_definitions WHERE key=?1",
            [key],
            |row| Ok(CustomColumnDefinition { key: row.get(0)?, label: row.get(1)?, column_type: row.get(2)?, position: row.get(3)? }),
        ).optional()?.ok_or_else(|| AppError::new("not-found"))?;
        transaction.execute(
            "DELETE FROM library_custom_column_definitions WHERE key=?1",
            [key],
        )?;
        transaction.execute(
            "UPDATE library_custom_column_definitions SET position=position-1 WHERE position>?1",
            [definition.position],
        )?;
        transaction.commit()?;
        Ok(definition)
    }

    pub(crate) fn replace_custom_column_definitions(
        &mut self,
        definitions: &[CustomColumnDefinition],
    ) -> AppResult<()> {
        validate_custom_column_definitions(definitions)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM library_custom_column_definitions", [])?;
        for definition in definitions {
            transaction.execute("INSERT INTO library_custom_column_definitions(key,label,type,position) VALUES(?1,?2,'text',?3)", params![definition.key, definition.label, definition.position])?;
        }
        transaction.commit().map_err(Into::into)
    }
}

pub(crate) fn validate_custom_column_definitions(
    definitions: &[CustomColumnDefinition],
) -> AppResult<()> {
    if definitions.len() > MAX_CUSTOM_COLUMN_DEFINITIONS {
        return Err(AppError::new("invalid-arguments"));
    }
    let mut keys = std::collections::HashSet::new();
    for (position, definition) in definitions.iter().enumerate() {
        if definition.column_type != "text"
            || definition.position as usize != position
            || !keys.insert(&definition.key)
        {
            return Err(AppError::new("invalid-arguments"));
        }
        let label = validate_custom_column_definition(&definition.key, &definition.label)?;
        if label != definition.label {
            return Err(AppError::new("invalid-arguments"));
        }
    }
    Ok(())
}

fn validate_custom_column_definition(key: &str, label: &str) -> AppResult<String> {
    if !valid_custom_column_key(key) {
        return Err(AppError::new("invalid-arguments"));
    }
    let label = label.trim();
    if label.is_empty() || label.encode_utf16().count() > 120 {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(label.to_owned())
}

fn valid_custom_column_key(key: &str) -> bool {
    key != METADATA_AUDIT_KEY
        && key.len() <= 64
        && key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::LibraryStore;
    use crate::paths::LibraryPaths;

    #[test]
    fn column_storage_failures_are_not_invalid_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite"))).unwrap();
        let mut store = LibraryStore::open(paths, true).unwrap();
        store
            .create_custom_column_definition("key", "Label")
            .unwrap();
        assert_eq!(
            store
                .create_custom_column_definition("key", "Duplicate")
                .unwrap_err()
                .code(),
            "invalid-arguments"
        );
        store
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert_eq!(
            store
                .create_custom_column_definition("another", "Label")
                .unwrap_err()
                .code(),
            "storage-unavailable"
        );
    }

    #[test]
    fn custom_column_lists_reject_invalid_untrimmed_reserved_and_noncontiguous_rows() {
        let cases = [
            "INSERT INTO library_custom_column_definitions VALUES ('valid',' padded ','text',0)",
            "INSERT INTO library_custom_column_definitions VALUES ('takio_metadata_audit','Audit','text',0)",
            "INSERT INTO library_custom_column_definitions VALUES ('valid','Valid','text',1)",
        ];
        for sql in cases {
            let temp = tempfile::tempdir().unwrap();
            let database = temp.path().join("library.sqlite");
            let paths = LibraryPaths::resolve(None, Some(&database)).unwrap();
            let store = LibraryStore::open(paths, true).unwrap();
            store.connection.execute(sql, []).unwrap();
            assert_eq!(
                store.list_custom_column_definitions().unwrap_err().code(),
                "incompatible-schema"
            );
        }
    }
}
