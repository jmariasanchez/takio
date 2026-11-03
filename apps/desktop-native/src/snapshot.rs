//! Opt-in (`--features snapshot`) offscreen render of the real workspace to PNG.
//!
//! Uses GPUI's real Metal renderer through `VisualTestAppContext`, so the image is
//! what the packaged app would draw, without Screen Recording permission. The
//! library comes from `TAKIO_DATA_DIR`, readers from `TAKIO_SNAPSHOT_VOLUMES`.
use std::path::PathBuf;
use std::time::Duration;

use gpui::{AppContext, VisualTestAppContext, px, size};

use crate::engine::{self, Engine};
use crate::state::LibraryState;
use crate::theme::Theme;
use crate::views::workspace::Workspace;

pub fn run() {
    let output = PathBuf::from(
        std::env::var_os("TAKIO_SNAPSHOT_OUTPUT")
            .unwrap_or_else(|| crate::fatal("set TAKIO_SNAPSHOT_OUTPUT")),
    );
    let volumes = std::env::var_os("TAKIO_SNAPSHOT_VOLUMES").map(PathBuf::from);
    let select = std::env::var("TAKIO_SNAPSHOT_SELECT").ok();
    let paths = engine::resolve_paths().unwrap_or_else(|error| crate::fatal(error.code()));
    let engine = Engine::open(paths).unwrap_or_else(|error| crate::fatal(error.code()));

    let mut cx = VisualTestAppContext::new(gpui_platform::current_platform(false));
    cx.update(|cx| cx.set_global(Theme::LIGHT));
    let state = cx.new(|cx| match volumes {
        Some(volumes) => LibraryState::new_with_volumes(engine, volumes, cx),
        None => LibraryState::new(engine, cx),
    });
    settle(&mut cx, &state);
    // Wait for a reader to be connected while running, through the real volume poll.
    if let Some(name) = std::env::var_os("TAKIO_SNAPSHOT_WAIT_FOR_READER") {
        let name = name.to_string_lossy().into_owned();
        let ready = std::path::Path::new(&output).with_extension("waiting");
        std::fs::write(&ready, b"").unwrap_or_else(|_| crate::fatal("could not signal waiting"));
        let started = std::time::Instant::now();
        loop {
            cx.run_until_parked();
            cx.advance_clock(Duration::from_millis(100));
            std::thread::sleep(Duration::from_millis(100));
            let found = cx.read(|cx| {
                let state = state.read(cx);
                !state.scanning_readers
                    && !state.refreshing_devices
                    && state
                        .reader_shelves
                        .iter()
                        .any(|(reader, _)| reader.name == name)
            });
            if found {
                println!(
                    "reader {name} noticed {:.1} s after mount wait began, without Refresh",
                    started.elapsed().as_secs_f64()
                );
                break;
            }
            if started.elapsed() > Duration::from_secs(30) {
                crate::fatal("reader was not noticed within 30 s");
            }
        }
        let _ = std::fs::remove_file(&ready);
    }
    // Same state method the sidebar "Add N to library" control calls.
    if std::env::var_os("TAKIO_SNAPSHOT_IMPORT_FROM_READER").is_some() {
        cx.update(|cx| {
            state.update(cx, |state, cx| {
                let reader = state.reader_shelves.iter().find_map(|(reader, shelf)| {
                    shelf
                        .as_ref()
                        .ok()
                        .filter(|shelf| shelf.importable > 0)
                        .map(|_| reader.clone())
                });
                match reader {
                    Some(reader) => {
                        // Real race: the reader disappears after it was listed and
                        // offered, but before the engine runs the import.
                        if let Some(mount) = std::env::var_os("TAKIO_SNAPSHOT_UNPLUG_BEFORE_IMPORT")
                        {
                            let detached = std::process::Command::new("hdiutil")
                                .arg("detach")
                                .arg(&mount)
                                .status()
                                .is_ok_and(|status| status.success());
                            if !detached {
                                crate::fatal("could not detach reader for unplug check");
                            }
                        }
                        state.import_from_reader(reader, cx);
                    }
                    None => crate::fatal("no reader has books to add"),
                }
            });
        });
        settle(&mut cx, &state);
    }
    if let Some(title) = select {
        cx.update(|cx| {
            state.update(cx, |state, cx| {
                // "Title" or "Title|epub" to pick one of several same-titled books.
                let (title, format) = title
                    .split_once('|')
                    .map_or((title.as_str(), None), |(t, f)| (t, Some(f)));
                if let Some(index) = state.items.iter().position(|item| {
                    item.title == title
                        && format.is_none_or(|format| {
                            item.formats
                                .iter()
                                .any(|attached| attached.format.as_str() == format)
                        })
                }) {
                    state.select_only(index, cx);
                }
            });
        });
        settle(&mut cx, &state);
    }
    let window = cx
        .open_offscreen_window(size(px(1280.), px(800.)), |window, cx| {
            cx.new(|cx| Workspace::new(state.clone(), window, cx))
        })
        .unwrap_or_else(|_| crate::fatal("could not open offscreen window"));
    for _ in 0..5 {
        cx.run_until_parked();
        let _ = cx.update_window(window.into(), |_, window, _| window.refresh());
        std::thread::sleep(Duration::from_millis(30));
    }
    let image = cx
        .capture_screenshot(window.into())
        .unwrap_or_else(|_| crate::fatal("could not render workspace"));
    image
        .save(&output)
        .unwrap_or_else(|_| crate::fatal("could not write snapshot"));
    let summary = cx.read(|cx| {
        let state = state.read(cx);
        let shelves: Vec<String> = state
            .reader_shelves
            .iter()
            .map(|(reader, shelf)| match shelf {
                Ok(shelf) => format!(
                    "{}: in_library={} other={} importable={}",
                    reader.name, shelf.in_library, shelf.not_in_library, shelf.importable
                ),
                Err(error) => format!("{}: error {error}", reader.name),
            })
            .collect();
        format!(
            "{{\"items\":{},\"onReader\":{},\"shelves\":{:?},\"status\":{:?}}}",
            state.items.len(),
            state.on_reader.len(),
            shelves,
            state.status.as_ref().map(|status| status.text.clone())
        )
    });
    println!("{summary}");
    println!(
        "wrote {} ({}x{})",
        output.display(),
        image.width(),
        image.height()
    );
}

fn settle(cx: &mut VisualTestAppContext, state: &gpui::Entity<LibraryState>) {
    for _ in 0..400 {
        cx.run_until_parked();
        let busy = cx.read(|cx| {
            let state = state.read(cx);
            state.loading || state.busy || state.refreshing_devices || state.scanning_readers
        });
        if !busy {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    crate::fatal("snapshot state did not settle");
}
