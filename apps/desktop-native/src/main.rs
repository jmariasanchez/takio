//! Takio native desktop. One process, one binary: the GPUI renderer links
//! the library engine directly and talks to it over an in-process channel.

mod activation;
mod automatic_backup;
mod bench;
mod covers;
mod engine;
mod library_location;
mod preferences;
mod preparation;
mod small_file;
#[cfg(feature = "snapshot")]
mod snapshot;
mod startup;
mod startup_window;
mod state;
#[cfg(any(test, feature = "snapshot"))]
mod test_support;
mod theme;
mod views;

use gpui::{
    App, AppContext, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds,
    WindowOptions, actions, point, px, size,
};
use gpui_platform::application;
use std::io::Write;
use std::process::ExitCode;

use crate::startup_window::StartupWindow;
use crate::theme::Theme;

actions!(
    takio,
    [
        Quit,
        Import,
        ImportMove,
        OpenLibrary,
        RevealLibrary,
        BackUpLibrary,
        EnableAutomaticBackups,
        DisableAutomaticBackups,
        RestoreBackupCopy,
        RevealRecovery,
        OpenSelected,
        EditSelected,
        TrashSelected,
        RestoreSelected,
        PurgeSelected,
        SelectAll,
        SelectNext,
        SelectPrevious,
        FocusSearch,
        ClearSearch,
        ShowLibrary,
        ShowTrash,
        TogglePalette,
        RefreshDevices,
        SendSelected,
        ConfirmSend,
        CancelSend,
        PrepareSelected,
        ConfirmPreparation,
        CancelPreparation,
        EjectReader,
    ]
);

fn main() -> ExitCode {
    let started = std::time::Instant::now();
    if std::env::var_os("TAKIO_DESKTOP_BENCH").is_some() {
        bench::run(started);
        return ExitCode::SUCCESS;
    }
    #[cfg(feature = "snapshot")]
    if std::env::var_os("TAKIO_SNAPSHOT_OUTPUT").is_some() {
        snapshot::run();
        return ExitCode::SUCCESS;
    }
    let data_override = std::env::var_os("TAKIO_DATA_DIR").map(std::path::PathBuf::from);
    let paths = match engine::resolve_paths(data_override.as_deref()) {
        Ok(paths) => paths,
        Err(error) => {
            let _ = writeln!(
                std::io::stderr().lock(),
                "takio-desktop: could not resolve library path: {}",
                error.code()
            );
            return ExitCode::FAILURE;
        }
    };
    let profile = std::env::var_os("TAKIO_DESKTOP_PROFILE_DIR").map(std::path::PathBuf::from);
    let preference_path = takio::library::paths::desktop_preference_location(
        &paths.root,
        data_override.is_some(),
        profile.as_deref(),
    );
    application().run(move |cx: &mut App| {
        cx.set_global(Theme::LIGHT);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-shift-i", Import, None),
            KeyBinding::new("cmd-o", OpenSelected, None),
            KeyBinding::new("cmd-shift-o", OpenLibrary, None),
            KeyBinding::new("cmd-e", EditSelected, None),
            KeyBinding::new("cmd-backspace", TrashSelected, None),
            KeyBinding::new("cmd-a", SelectAll, Some("LibraryList")),
            KeyBinding::new("down", SelectNext, Some("LibraryList")),
            KeyBinding::new("up", SelectPrevious, Some("LibraryList")),
            KeyBinding::new("cmd-f", FocusSearch, None),
            KeyBinding::new("escape", ClearSearch, Some("Search")),
            KeyBinding::new("cmd-1", ShowLibrary, None),
            KeyBinding::new("cmd-2", ShowTrash, None),
            KeyBinding::new("cmd-k", TogglePalette, None),
            KeyBinding::new("cmd-r", RefreshDevices, None),
            KeyBinding::new("cmd-shift-s", SendSelected, None),
            KeyBinding::new("cmd-shift-p", PrepareSelected, None),
            KeyBinding::new("cmd-enter", ConfirmSend, None),
            KeyBinding::new("cmd-.", CancelSend, None),
        ]);
        cx.set_menus(menus());

        cx.open_window(main_window_options(cx), |window, cx| {
            cx.set_global(Theme::for_appearance(window.appearance()));
            let view = cx.new(|cx| StartupWindow::new(paths, preference_path, window, cx));
            let close_view = view.clone();
            window.on_window_should_close(cx, move |_, cx| {
                close_view.update(cx, |view, cx| view.request_close(cx))
            });
            let quit_view = view.clone();
            cx.on_action(move |_: &Quit, cx| {
                if quit_view.update(cx, |view, cx| view.request_close(cx)) {
                    cx.quit();
                }
            });
            view
        })
        .expect("open main window");
        cx.activate(true);
    });
    ExitCode::SUCCESS
}

fn main_window_options(cx: &App) -> WindowOptions {
    let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("Takio".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(14.), px(14.))),
        }),
        window_min_size: Some(size(px(900.), px(560.))),
        ..Default::default()
    }
}

fn recovery_chooser_directory() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

fn menus() -> Vec<Menu> {
    vec![
        Menu::new("Takio").items([MenuItem::action("Quit Takio", Quit)]),
        Menu::new("File").items([
            MenuItem::action("Open Library...", OpenLibrary),
            MenuItem::action("Reveal Current Library", RevealLibrary),
            MenuItem::separator(),
            MenuItem::action("Import...", Import),
            MenuItem::action("Import and Move...", ImportMove),
            MenuItem::separator(),
            MenuItem::action("Back Up Library...", BackUpLibrary),
            MenuItem::action(
                "Enable Automatic Recovery Copies...",
                EnableAutomaticBackups,
            ),
            MenuItem::action("Disable Automatic Recovery Copies", DisableAutomaticBackups),
            MenuItem::action("Restore Backup to New Folder...", RestoreBackupCopy),
            MenuItem::action("Reveal Last Recovery Copy", RevealRecovery),
            MenuItem::separator(),
            MenuItem::action("Open", OpenSelected),
            MenuItem::action("Edit Book Details...", EditSelected),
            MenuItem::separator(),
            MenuItem::action("Move to Trash", TrashSelected),
            MenuItem::action("Restore from Trash", RestoreSelected),
            MenuItem::action("Delete Permanently", PurgeSelected),
        ]),
        Menu::new("Edit").items([
            MenuItem::action("Select All", SelectAll),
            MenuItem::separator(),
            MenuItem::action("Find", FocusSearch),
        ]),
        Menu::new("View").items([
            MenuItem::action("Library", ShowLibrary),
            MenuItem::action("Trash", ShowTrash),
            MenuItem::separator(),
            MenuItem::action("Command Palette", TogglePalette),
            MenuItem::action("Refresh Devices", RefreshDevices),
        ]),
        Menu::new("Reader").items([
            MenuItem::action("Prepare for Kindle...", PrepareSelected),
            MenuItem::action("Convert Reviewed EPUB to AZW3", ConfirmPreparation),
            MenuItem::action("Cancel Preparation", CancelPreparation),
            MenuItem::separator(),
            MenuItem::action("Send Selected Books...", SendSelected),
            MenuItem::action("Send Ready Books from Review", ConfirmSend),
            MenuItem::action("Cancel Send Review", CancelSend),
            MenuItem::action("Eject Reader...", EjectReader),
            MenuItem::action("Refresh Readers", RefreshDevices),
        ]),
    ]
}

// Used only by opt-in acceptance probes. GPUI's macOS quit calls Cocoa's
// terminate: rather than returning from the event loop, so returning an error
// after application().run() would lose the probe's nonzero failure status.
fn fatal(message: &str) -> ! {
    let _ = writeln!(std::io::stderr().lock(), "takio-desktop: {message}");
    std::process::exit(1);
}
