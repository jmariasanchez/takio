//! Safe, bounded publication names shared by library exports and delivery.
use std::path::Path;

pub fn destination_file_name(title: &str, author: Option<&str>, extension: &str) -> String {
    let title = sanitize_file_name(title).unwrap_or_else(|| "Untitled".to_owned());
    let stem = author
        .and_then(sanitize_file_name)
        .map_or(title.clone(), |author| format!("{author} - {title}"));
    let mut value = format!("{stem}.{extension}");
    if value.chars().count() > 180 {
        let keep = 179usize.saturating_sub(extension.chars().count());
        let prefix = stem.chars().take(keep).collect::<String>();
        value = format!("{}.{extension}", prefix.trim_end());
    }
    value
}

pub(crate) fn sanitize_file_name(value: &str) -> Option<String> {
    let name = Path::new(value).file_name()?.to_string_lossy();
    let clean = name
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect::<String>();
    (!clean.is_empty() && clean != "." && clean != "..").then_some(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_names_are_safe_and_bounded() {
        let name = destination_file_name(&"A".repeat(300), Some("Author/Name"), "epub");
        assert!(name.chars().count() <= 180);
        assert!(!name.contains('/'));
        assert!(name.ends_with(".epub"));
    }
}
