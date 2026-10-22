//! Takio native desktop. One process, one binary: the GPUI renderer links
//! the library engine directly and talks to it over an in-process channel.

mod bench;
mod covers;
mod engine;
mod state;
mod theme;
mod views;

use gpui::{
    App, AppContext, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds,
    WindowOptions, actions, point, px, size,
};
use gpui_platform::application;

use crate::engine::Engine;
use crate::state::LibraryState;
use crate::theme::Theme;
use crate::views::workspace::Workspace;

actions!(
    takio,
    [
        Quit,
        Import,
        ImportMove,
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
        EjectReader,
    ]
);

fn main() {
    let started = std::time::Instant::now();
    if std::env::var_os("TAKIO_DESKTOP_BENCH").is_some() {
        return bench::run(started);
    }
    let paths = match engine::resolve_paths() {
        Ok(paths) => paths,
        Err(error) => fatal(&format!("could not resolve library path: {}", error.code())),
    };
    let engine = match Engine::open(paths) {
        Ok(engine) => engine,
        Err(error) => fatal(&format!("could not open library: {}", error.code())),
    };

    application().run(move |cx: &mut App| {
        cx.set_global(Theme::LIGHT);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-shift-i", Import, None),
            KeyBinding::new("cmd-o", OpenSelected, None),
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
            KeyBinding::new("cmd-enter", ConfirmSend, None),
            KeyBinding::new("cmd-.", CancelSend, None),
        ]);
        cx.set_menus(menus());

        let state = cx.new(|cx| LibraryState::new(engine.clone(), cx));
        let quit_state = state.clone();
        cx.on_action(move |_: &Quit, cx| {
            if quit_state.update(cx, |state, cx| state.can_close(cx)) {
                cx.quit();
            }
        });
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Takio".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.), px(14.))),
                }),
                window_min_size: Some(size(px(900.), px(560.))),
                ..Default::default()
            },
            |window, cx| {
                cx.set_global(Theme::for_appearance(window.appearance()));
                let close_state = state.clone();
                window.on_window_should_close(cx, move |_, cx| {
                    close_state.update(cx, |state, cx| state.can_close(cx))
                });
                cx.new(|cx| Workspace::new(state.clone(), window, cx))
            },
        )
        .expect("open main window");
        cx.activate(true);
    });
}

fn menus() -> Vec<Menu> {
    vec![
        Menu::new("Takio").items([MenuItem::action("Quit Takio", Quit)]),
        Menu::new("File").items([
            MenuItem::action("Import...", Import),
            MenuItem::action("Import and Move...", ImportMove),
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
            MenuItem::action("Send Selected Books...", SendSelected),
            MenuItem::action("Send Ready Books from Review", ConfirmSend),
            MenuItem::action("Cancel Send Review", CancelSend),
            MenuItem::action("Eject Reader...", EjectReader),
            MenuItem::action("Refresh Readers", RefreshDevices),
        ]),
    ]
}

fn fatal(message: &str) -> ! {
    eprintln!("takio-desktop: {message}");
    std::process::exit(1);
}
