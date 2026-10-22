//! Opt-in startup probe using the real workspace and engine.
use crate::{
    engine::{self, Engine},
    state::LibraryState,
    theme::Theme,
    views::workspace::Workspace,
};
use gpui::{
    App, AppContext, Bounds, Context, Entity, TitlebarOptions, Window, WindowBounds, WindowOptions,
    canvas, div, point, prelude::*, px, size,
};
use std::{cell::RefCell, process::Command, rc::Rc, time::Instant};

#[derive(Default)]
struct Measurements {
    paint: Option<f64>,
    query: Option<f64>,
    items: usize,
    reported: bool,
    presented: bool,
}
impl Measurements {
    fn finish(&mut self, cx: &mut App) {
        let (Some(paint), Some(query)) = (self.paint, self.query) else {
            return;
        };
        if self.reported || !self.presented {
            return;
        }
        self.reported = true;
        let rss = Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        println!(
            "{{\"firstPaintMs\":{paint:.3},\"firstQueryMs\":{query:.3},\"items\":{},\"rssKb\":{rss}}}",
            self.items
        );
        cx.quit();
    }
}

struct BenchWindow {
    workspace: Entity<Workspace>,
    started: Instant,
    measurements: Rc<RefCell<Measurements>>,
}

impl Render for BenchWindow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let measurements = self.measurements.clone();
        let started = self.started;
        div().size_full().child(self.workspace.clone()).child(
            canvas(
                |_, _, _| (),
                move |_, _, _, cx| {
                    if measurements.borrow().paint.is_none() {
                        // open_window paints its initial scene eagerly. Timestamp the
                        // completed paint effect cycle, not a later display refresh.
                        cx.defer(move |cx| {
                            let mut measurement = measurements.borrow_mut();
                            if measurement.paint.is_none() {
                                measurement.paint = Some(started.elapsed().as_secs_f64() * 1000.);
                                measurement.finish(cx);
                            }
                        });
                    }
                },
            )
            .absolute()
            .size(px(0.)),
        )
    }
}

pub fn run(started: Instant) {
    let paths = engine::resolve_paths().unwrap_or_else(|error| crate::fatal(error.code()));
    let engine = Engine::open(paths).unwrap_or_else(|error| crate::fatal(error.code()));
    gpui_platform::application().run(move |cx: &mut App| {
        cx.set_global(Theme::LIGHT);
        cx.set_menus(crate::menus());
        let state = cx.new(|cx| LibraryState::new(engine, cx));
        let measurements = Rc::new(RefCell::new(Measurements::default()));
        let query_measurements = measurements.clone();
        cx.observe(&state, move |state, cx| {
            let state = state.read(cx);
            if state.loading || query_measurements.borrow().query.is_some() {
                return;
            }
            if state.status.as_ref().is_some_and(|status| status.is_error) {
                crate::fatal("startup query failed");
            }
            let mut measurement = query_measurements.borrow_mut();
            measurement.query = Some(started.elapsed().as_secs_f64() * 1000.);
            measurement.items = state.items.len();
            measurement.finish(cx);
        })
        .detach();
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
            move |window, cx| {
                cx.set_global(Theme::for_appearance(window.appearance()));
                let presented = measurements.clone();
                // Callbacks run before presentation. Wait one additional frame to
                // ensure the smoke test actually presents before it may quit.
                window.on_next_frame(move |window, _| {
                    window.on_next_frame(move |_, cx| {
                        let mut measurement = presented.borrow_mut();
                        measurement.presented = true;
                        measurement.finish(cx);
                    });
                });
                let workspace = cx.new(|cx| Workspace::new(state, window, cx));
                cx.new(|_| BenchWindow {
                    workspace,
                    started,
                    measurements,
                })
            },
        )
        .expect("open benchmark window");
        cx.activate(true);
    });
}
