//! One command registry for native menus, keyboard bindings, and the palette.
use gpui::{Action, KeyBinding, Menu, MenuItem};

pub struct Command {
    pub label: &'static str,
    pub binding: Option<&'static str>,
    pub action: fn() -> Box<dyn Action>,
    menu: &'static str,
    keybinding: fn() -> Option<KeyBinding>,
}

impl Command {
    pub fn hint(&self) -> String {
        self.binding
            .unwrap_or("")
            .split('-')
            .map(|word| {
                let mut chars = word.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_uppercase().collect::<String>() + chars.as_str()
                })
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

macro_rules! commands {
    ($(($action:ident, $label:literal, $menu:literal, $binding:expr, $context:expr)),* $(,)?) => {
        pub const COMMANDS: &[Command] = &[$(Command {
            label: $label,
            menu: $menu,
            binding: $binding,
            action: || Box::new(crate::$action),
            keybinding: || { let binding: Option<&str> = $binding; binding.map(|key| KeyBinding::new(key, crate::$action, $context)) },
        }),*];
        pub fn block_modal_actions<E: gpui::InteractiveElement>(element: E) -> E {
            element$(.on_action(|_: &crate::$action, _, cx| cx.stop_propagation()))*
        }
        #[cfg(test)]
        pub fn observe_global_actions(cx: &mut gpui::App, count: std::rc::Rc<std::cell::Cell<usize>>) {
            $({
                let count = count.clone();
                cx.on_action(move |_: &crate::$action, _| count.set(count.get() + 1));
            })*
        }
    };
}

commands![
    (Quit, "Quit Takio", "Takio", Some("cmd-q"), None),
    (
        OpenLibrary,
        "Open Library...",
        "File",
        Some("cmd-shift-o"),
        None
    ),
    (RevealLibrary, "Reveal Current Library", "File", None, None),
    (Import, "Import...", "File", Some("cmd-shift-i"), None),
    (ImportMove, "Import and Move...", "File", None, None),
    (BackUpLibrary, "Back Up Library...", "File", None, None),
    (
        EnableAutomaticBackups,
        "Enable Automatic Recovery Copies...",
        "File",
        None,
        None
    ),
    (
        DisableAutomaticBackups,
        "Disable Automatic Recovery Copies",
        "File",
        None,
        None
    ),
    (
        RestoreBackupCopy,
        "Restore Backup to New Folder...",
        "File",
        None,
        None
    ),
    (
        RevealRecovery,
        "Reveal Last Recovery Copy",
        "File",
        None,
        None
    ),
    (OpenSelected, "Open Selected", "File", Some("cmd-o"), None),
    (
        EditSelected,
        "Edit Book Details...",
        "File",
        Some("cmd-e"),
        None
    ),
    (
        TrashSelected,
        "Move to Trash",
        "File",
        Some("cmd-backspace"),
        None
    ),
    (RestoreSelected, "Restore Selected", "File", None, None),
    (PurgeSelected, "Delete Permanently", "File", None, None),
    (
        SelectAll,
        "Select All",
        "Edit",
        Some("cmd-a"),
        Some("LibraryList")
    ),
    (
        SelectNext,
        "Select Next Book",
        "Edit",
        Some("down"),
        Some("LibraryList")
    ),
    (
        SelectPrevious,
        "Select Previous Book",
        "Edit",
        Some("up"),
        Some("LibraryList")
    ),
    (FocusSearch, "Focus Search", "Edit", Some("cmd-f"), None),
    (
        ClearSearch,
        "Clear Search",
        "Edit",
        Some("escape"),
        Some("Search")
    ),
    (ShowLibrary, "Show Library", "View", Some("cmd-1"), None),
    (ShowTrash, "Show Trash", "View", Some("cmd-2"), None),
    (
        TogglePalette,
        "Command Palette",
        "View",
        Some("cmd-k"),
        None
    ),
    (
        PrepareSelected,
        "Prepare for Kindle...",
        "Reader",
        Some("cmd-shift-p"),
        None
    ),
    (
        ConfirmPreparation,
        "Convert Reviewed EPUB to AZW3",
        "Reader",
        None,
        None
    ),
    (
        CancelPreparation,
        "Cancel Preparation",
        "Reader",
        None,
        None
    ),
    (
        SendSelected,
        "Send Selected Books...",
        "Reader",
        Some("cmd-shift-s"),
        None
    ),
    (
        ConfirmSend,
        "Send Ready Books from Review",
        "Reader",
        Some("cmd-enter"),
        None
    ),
    (
        CancelSend,
        "Cancel Send Review",
        "Reader",
        Some("cmd-."),
        None
    ),
    (EjectReader, "Eject Reader...", "Reader", None, None),
    (
        RefreshReaders,
        "Refresh Readers",
        "Reader",
        Some("cmd-r"),
        None
    ),
];

pub fn keybindings() -> Vec<KeyBinding> {
    COMMANDS
        .iter()
        .filter_map(|command| (command.keybinding)())
        .collect()
}

pub fn menus() -> Vec<Menu> {
    ["Takio", "File", "Edit", "View", "Reader"]
        .into_iter()
        .map(|name| {
            Menu::new(name).items(COMMANDS.iter().filter(|command| command.menu == name).map(
                |command| MenuItem::Action {
                    name: command.label.into(),
                    action: (command.action)(),
                    os_action: None,
                    checked: false,
                    disabled: false,
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_commands_use_reader_terminology_in_menus_and_palette() {
        for command in COMMANDS {
            let label = command.label.to_ascii_lowercase();
            assert!(!label.contains("device") && !label.contains("destination"));
        }
        for action in [
            Box::new(crate::RefreshReaders) as Box<dyn Action>,
            Box::new(crate::EjectReader),
        ] {
            let command = COMMANDS
                .iter()
                .find(|command| (command.action)().name() == action.name())
                .unwrap();
            assert_eq!(command.menu, "Reader");
            assert!(command.label.contains("Reader"));
        }
        for code in [
            takio::error::ErrorCode::DestinationUnavailable,
            takio::error::ErrorCode::UnknownDestination,
            takio::error::ErrorCode::DestinationFileExists,
        ] {
            let status = crate::state::humanize_error(code);
            assert!(status.contains("reader"));
            assert!(!status.contains("device") && !status.contains("destination"));
        }
    }

    #[test]
    fn every_command_has_matching_menu_palette_and_binding_metadata() {
        let menus = menus();
        let bindings = keybindings();
        let mut names = std::collections::HashSet::new();
        for command in COMMANDS {
            let action = (command.action)();
            assert!(names.insert(action.name()));
            assert_eq!(menus.iter().flat_map(|menu| &menu.items).filter(|item| matches!(item, MenuItem::Action { name, action: menu_action, .. } if name.as_ref() == command.label && menu_action.name() == action.name())).count(), 1);
            let matches = bindings
                .iter()
                .filter(|binding| binding.action().name() == action.name())
                .count();
            assert_eq!(matches, usize::from(command.binding.is_some()));
            assert_eq!(command.hint().is_empty(), command.binding.is_none());
        }
        assert_eq!(COMMANDS.len(), 31);
    }
}
