//! Takio native desktop. One process, one binary: the GPUI renderer links
//! the library engine directly and talks to it over an in-process channel.

mod activation;
mod automatic_backup;
mod bench;
mod commands;
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
    App, AppContext, Bounds, TitlebarOptions, WindowBounds, WindowOptions, actions, point, px, size,
};
use gpui_platform::application;
use std::io::Write;
use std::process::ExitCode;

use crate::startup_window::StartupWindow;

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
        theme::initialize(cx);
        cx.bind_keys(commands::keybindings());
        cx.set_menus(commands::menus());

        cx.open_window(main_window_options(cx), |window, cx| {
            theme::install(window, cx);
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

// Used only by opt-in acceptance probes. GPUI's macOS quit calls Cocoa's
// terminate: rather than returning from the event loop, so returning an error
// after application().run() would lose the probe's nonzero failure status.
fn fatal(message: &str) -> ! {
    let _ = writeln!(std::io::stderr().lock(), "takio-desktop: {message}");
    std::process::exit(1);
}
