//! Catalogue reads and scoped SQL compilation.
//!
//! Selection preserves each API's ordering and missing-record policy. Record
//! reconstruction belongs to hydration, while snapshot reuse belongs to query_cache.
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use super::hydration::{read_items_bulk, read_items_required};
use super::metadata::valid_custom_metadata_key;
use super::{
    LibraryQueryFilters, LibraryQueryScope, LibraryQuerySyntax, LibraryStore, METADATA_AUDIT_KEY,
    as_i64, count,
};
use crate::error::AppResult;
use crate::library::model::LibraryItem;

impl LibraryStore {
    pub fn list(&self, include_trashed: bool) -> AppResult<Vec<LibraryItem>> {
        let filter = if include_trashed {
            ""
        } else {
            "WHERE trashed_at IS NULL"
        };
        let mut statement = self.connection.prepare(&format!(
            "SELECT id FROM library_items {filter} ORDER BY title COLLATE NOCASE, id"
        ))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        read_items_bulk(&self.connection, &ids)
    }

    pub fn list_trash(&self) -> AppResult<Vec<LibraryItem>> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM library_items WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC, id",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        read_items_required(&self.connection, &ids)
    }

    pub fn get(&self, id: &str) -> AppResult<Option<LibraryItem>> {
        if id.trim().is_empty() {
            return Err(crate::app_error!("invalid-arguments"));
        }
        self.read_item(id)
    }

    /// Resolve an existing, non-trashed item for delivery or preparation.
    ///
    /// # Errors
    /// Returns `not-found` for a missing identifier and `item-trashed` when the
    /// item must first be explicitly restored. Empty identifiers are invalid.
    pub fn get_active(&self, id: &str) -> AppResult<LibraryItem> {
        let item = self
            .get(id)?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        let trashed: bool = self
            .connection
            .query_row(
                "SELECT trashed_at IS NOT NULL FROM library_items WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| crate::app_error!("not-found"))?;
        if trashed {
            return Err(crate::app_error!("item-trashed"));
        }
        Ok(item)
    }

    pub fn search(&self, query: &str) -> AppResult<Vec<LibraryItem>> {
        let needle = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT li.id FROM library_items li
             LEFT JOIN library_item_authors a ON a.library_item_id = li.id
             LEFT JOIN library_item_tags it ON it.library_item_id = li.id
             LEFT JOIN tags t ON t.normalized_name = it.tag_normalized_name
             WHERE li.trashed_at IS NULL AND (
               li.title LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               li.author LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               a.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               li.series LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR
               t.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE)
             ORDER BY li.title COLLATE NOCASE, li.id",
        )?;
        let ids = statement
            .query_map([needle], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        read_items_required(&self.connection, &ids)
    }

    pub fn query_items(
        &self,
        query: &str,
        filters: LibraryQueryFilters<'_>,
    ) -> AppResult<Vec<LibraryItem>> {
        self.query_items_scoped(&[LibraryQueryScope {
            query,
            syntax: LibraryQuerySyntax::Literal,
            filters,
        }])
    }

    pub fn query_items_scoped(
        &self,
        scopes: &[LibraryQueryScope<'_>],
    ) -> AppResult<Vec<LibraryItem>> {
        let ids = query_item_ids(&self.connection, scopes)?;
        read_items_bulk(&self.connection, &ids)
    }

    pub fn catalog_page(&self, limit: usize, offset: usize) -> AppResult<(u64, Vec<LibraryItem>)> {
        let total = count(
            &self.connection,
            "SELECT COUNT(*) FROM library_items WHERE trashed_at IS NULL",
        )?;
        let mut statement = self.connection.prepare(
            "SELECT id FROM library_items WHERE trashed_at IS NULL ORDER BY title COLLATE NOCASE,id LIMIT ?1 OFFSET ?2",
        )?;
        let limit = u64::try_from(limit).map_err(|_| crate::app_error!("invalid-arguments"))?;
        let offset = u64::try_from(offset).map_err(|_| crate::app_error!("invalid-arguments"))?;
        let ids = statement
            .query_map(params![as_i64(limit)?, as_i64(offset)?], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let items = read_items_bulk(&self.connection, &ids)?;
        Ok((total, items))
    }
}

pub(super) fn query_item_ids(
    connection: &Connection,
    scopes: &[LibraryQueryScope<'_>],
) -> AppResult<Vec<String>> {
    let mut sql = String::from("SELECT li.id FROM library_items li WHERE li.trashed_at IS NULL");
    let mut values = Vec::<SqlValue>::new();
    for scope in scopes {
        append_query_scope(&mut sql, &mut values, *scope)?;
    }
    sql.push_str(" ORDER BY li.title COLLATE NOCASE, li.id");
    let mut statement = connection.prepare(&sql)?;
    Ok(statement
        .query_map(params_from_iter(values.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn append_query_scope(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    scope: LibraryQueryScope<'_>,
) -> AppResult<()> {
    match scope.syntax {
        LibraryQuerySyntax::Literal => {
            if !scope.query.is_empty() {
                append_structured_term(sql, values, None, scope.query, false);
            }
        }
        LibraryQuerySyntax::StructuredV1 => {
            for term in parse_structured_query(scope.query)? {
                append_structured_term(
                    sql,
                    values,
                    term.field.as_deref(),
                    &term.value,
                    term.negated,
                );
            }
        }
    }
    if !scope.filters.authors.is_empty() {
        let legacy = query_placeholders(scope.filters.authors, values);
        let ordered = query_placeholders(scope.filters.authors, values);
        sql.push_str(&format!(
            " AND (li.author COLLATE NOCASE IN ({legacy})
               OR EXISTS(SELECT 1 FROM library_item_authors fa
                         WHERE fa.library_item_id=li.id
                           AND fa.name COLLATE NOCASE IN ({ordered})))"
        ));
    }
    if !scope.filters.tags.is_empty() {
        let placeholders = query_placeholders(scope.filters.tags, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_tags fit
                         JOIN tags ft ON ft.normalized_name=fit.tag_normalized_name
                         WHERE fit.library_item_id=li.id
                           AND ft.name COLLATE NOCASE IN ({placeholders}))"
        ));
    }
    if !scope.filters.series.is_empty() {
        let placeholders = query_placeholders(scope.filters.series, values);
        sql.push_str(&format!(
            " AND li.series COLLATE NOCASE IN ({placeholders})"
        ));
    }
    if !scope.filters.languages.is_empty() {
        let placeholders = query_placeholders(scope.filters.languages, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_languages fl
                         WHERE fl.library_item_id=li.id
                           AND fl.language COLLATE NOCASE IN ({placeholders}))"
        ));
    }
    if !scope.filters.formats.is_empty() {
        let placeholders = query_placeholders(scope.filters.formats, values);
        sql.push_str(&format!(
            " AND EXISTS(SELECT 1 FROM library_item_formats ff
                         WHERE ff.library_item_id=li.id
                           AND ff.format IN ({placeholders}))"
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct StructuredQueryTerm {
    field: Option<String>,
    value: String,
    negated: bool,
}

pub(super) fn parse_structured_query(query: &str) -> AppResult<Vec<StructuredQueryTerm>> {
    if query.encode_utf16().count() > 1024 {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let mut tokens = Vec::<(String, Option<usize>, bool)>::new();
    let mut token = String::new();
    let mut field_separator = None;
    let mut token_was_quoted = false;
    let mut quoted = false;
    let mut escaped = false;
    for character in query.chars() {
        if escaped {
            if !matches!(character, '"' | '\\') {
                return Err(crate::app_error!("invalid-query"));
            }
            token.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
            token_was_quoted = true;
        } else if character.is_ascii_whitespace() && !quoted {
            if !token.is_empty() {
                tokens.push((
                    std::mem::take(&mut token),
                    field_separator.take(),
                    std::mem::take(&mut token_was_quoted),
                ));
            }
        } else if character == ':' && !quoted && field_separator.is_none() {
            field_separator = Some(token.len());
            token.push(character);
        } else if matches!(character, '(' | ')') && !quoted {
            return Err(crate::app_error!("invalid-query"));
        } else {
            token.push(character);
        }
    }
    if escaped || quoted {
        return Err(crate::app_error!("invalid-query"));
    }
    if !token.is_empty() {
        tokens.push((token, field_separator, token_was_quoted));
    }
    if tokens.len() > 64 {
        return Err(crate::app_error!("invalid-query"));
    }

    let mut terms = Vec::new();
    let mut negated = false;
    let mut explicit_and_pending = false;
    for (token, field_separator, token_was_quoted) in tokens {
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("and") {
            if terms.is_empty() || explicit_and_pending || negated {
                return Err(crate::app_error!("invalid-query"));
            }
            explicit_and_pending = true;
            continue;
        }
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("or") {
            return Err(crate::app_error!("invalid-query"));
        }
        if !token_was_quoted && field_separator.is_none() && token.eq_ignore_ascii_case("not") {
            if negated {
                return Err(crate::app_error!("invalid-query"));
            }
            negated = true;
            continue;
        }
        let (field, value) = field_separator.map_or((None, token.as_str()), |separator| {
            let field = &token[..separator];
            (
                Some(if field.starts_with('#') {
                    field.to_owned()
                } else {
                    field.to_ascii_lowercase()
                }),
                &token[separator + 1..],
            )
        });
        if value.is_empty() || value.encode_utf16().count() > 256 {
            return Err(crate::app_error!("invalid-query"));
        }
        if let Some(field) = field.as_deref() {
            let valid = matches!(
                field,
                "title"
                    | "author"
                    | "authors"
                    | "tag"
                    | "tags"
                    | "series"
                    | "publisher"
                    | "language"
                    | "languages"
                    | "format"
                    | "formats"
                    | "identifier"
                    | "identifiers"
                    | "comments"
                    | "description"
            ) || field
                .strip_prefix('#')
                .is_some_and(|key| valid_custom_metadata_key(key) && key != METADATA_AUDIT_KEY);
            if !valid {
                return Err(crate::app_error!("invalid-query"));
            }
        }
        terms.push(StructuredQueryTerm {
            field,
            value: value.to_owned(),
            negated,
        });
        negated = false;
        explicit_and_pending = false;
        if terms.len() > 32 {
            return Err(crate::app_error!("invalid-query"));
        }
    }
    if negated || explicit_and_pending {
        return Err(crate::app_error!("invalid-query"));
    }
    Ok(terms)
}

fn append_structured_term(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    field: Option<&str>,
    value: &str,
    negated: bool,
) {
    let needle = format!(
        "%{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    sql.push_str(if negated { " AND NOT (" } else { " AND (" });
    match field {
        None => {
            sql.push_str(
                "li.title LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR COALESCE(li.author,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_authors qa
                           WHERE qa.library_item_id=li.id
                             AND qa.name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                 OR COALESCE(li.series,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_tags qit
                           JOIN tags qt ON qt.normalized_name=qit.tag_normalized_name
                           WHERE qit.library_item_id=li.id
                             AND qt.name LIKE ? ESCAPE '\\' COLLATE NOCASE)
                 OR EXISTS(SELECT 1 FROM library_item_custom_metadata qm
                           WHERE qm.library_item_id=li.id
                             AND qm.name<>?
                             AND (qm.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                                  OR qm.value LIKE ? ESCAPE '\\' COLLATE NOCASE))",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle.clone()), 5));
            values.push(SqlValue::Text(METADATA_AUDIT_KEY.to_owned()));
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("title") => append_like(sql, values, "li.title", needle),
        Some("author" | "authors") => {
            sql.push_str(
                "COALESCE(li.author,'') LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR EXISTS(SELECT 1 FROM library_item_authors qa
                           WHERE qa.library_item_id=li.id
                             AND qa.name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("tag" | "tags") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_tags qit
                        JOIN tags qt ON qt.normalized_name=qit.tag_normalized_name
                        WHERE qit.library_item_id=li.id
                          AND qt.name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("series") => append_like(sql, values, "li.series", needle),
        Some("publisher") => append_like(sql, values, "li.publisher", needle),
        Some("language" | "languages") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_languages ql
                        WHERE ql.library_item_id=li.id
                          AND ql.language LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("format" | "formats") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_formats qf
                        WHERE qf.library_item_id=li.id
                          AND qf.format LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(needle));
        }
        Some("identifier" | "identifiers") => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_identifiers qi
                        WHERE qi.library_item_id=li.id
                          AND (qi.scheme LIKE ? ESCAPE '\\' COLLATE NOCASE
                               OR qi.value LIKE ? ESCAPE '\\' COLLATE NOCASE))",
            );
            values.extend(std::iter::repeat_n(SqlValue::Text(needle), 2));
        }
        Some("comments" | "description") => append_like(sql, values, "li.description", needle),
        Some(field) if field.starts_with('#') => {
            sql.push_str(
                "EXISTS(SELECT 1 FROM library_item_custom_metadata qm
                        WHERE qm.library_item_id=li.id
                          AND qm.name=?
                          AND qm.value LIKE ? ESCAPE '\\' COLLATE NOCASE)",
            );
            values.push(SqlValue::Text(field[1..].to_owned()));
            values.push(SqlValue::Text(needle));
        }
        Some(_) => unreachable!("structured query fields are validated"),
    }
    sql.push(')');
}

fn append_like(sql: &mut String, values: &mut Vec<SqlValue>, column: &str, needle: String) {
    sql.push_str("COALESCE(");
    sql.push_str(column);
    sql.push_str(",'') LIKE ? ESCAPE '\\' COLLATE NOCASE");
    values.push(SqlValue::Text(needle));
}

fn query_placeholders(values: &[String], parameters: &mut Vec<SqlValue>) -> String {
    parameters.extend(values.iter().cloned().map(SqlValue::Text));
    std::iter::repeat_n("?", values.len())
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::parse_structured_query;

    #[test]
    fn structured_queries_parse_fields_quotes_negation_and_literal_colons() {
        let terms = parse_structured_query(
            r#"author:"Ursula K. Le Guin" and tag:Classic not publisher:Tor #shelf:favorites "https://example.test" "or""#,
        )
        .unwrap();
        assert_eq!(terms.len(), 6);
        assert_eq!(terms[0].field.as_deref(), Some("author"));
        assert_eq!(terms[0].value, "Ursula K. Le Guin");
        assert_eq!(terms[1].field.as_deref(), Some("tag"));
        assert!(terms[2].negated);
        assert_eq!(terms[3].field.as_deref(), Some("#shelf"));
        assert_eq!(terms[4].field, None);
        assert_eq!(terms[4].value, "https://example.test");
        assert_eq!(terms[5].value, "or");

        for invalid in [
            "author:\"unfinished",
            "unknown:value",
            "author:Asimov or author:Butler",
            "and author:Asimov",
            "author:Asimov and",
            "not",
            "(author:Asimov)",
            "#Bad:value",
            "#bad-key:value",
            "#takio_metadata_audit:value",
        ] {
            assert_eq!(
                parse_structured_query(invalid).unwrap_err().code(),
                "invalid-query"
            );
        }
    }
}
