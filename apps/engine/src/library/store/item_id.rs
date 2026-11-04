//! Filesystem-safe item identifiers shared by store and interchange readers.

pub(crate) fn valid_item_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::valid_item_id;

    #[test]
    fn item_ids_accept_legacy_ascii_names_and_length_boundary() {
        for value in ["book_123", "legacy-book.1", "A", ".hidden", "..."] {
            assert!(valid_item_id(value), "{value:?}");
        }
        assert!(valid_item_id(&"a".repeat(128)));
        assert!(!valid_item_id(&"a".repeat(129)));
    }

    #[test]
    fn item_ids_reject_traversal_separators_and_non_ascii_bytes() {
        for value in [
            "",
            ".",
            "..",
            "../book",
            "book/child",
            "book\\child",
            "/book",
            "C:book",
            "two words",
            "book\n",
            "book\0",
            "caf\u{e9}",
        ] {
            assert!(!valid_item_id(value), "{value:?}");
        }
    }
}
