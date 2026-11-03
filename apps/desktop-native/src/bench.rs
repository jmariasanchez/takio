//! Opt-in startup and interaction probes using the real workspace and engine.
use crate::{
    engine::{self, Engine},
    state::{LibraryState, SortColumn},
    theme::Theme,
    views::workspace::Workspace,
};
use gpui::{
    AnyWindowHandle, App, AppContext, Context, Entity, EntityInputHandler, Window, canvas, div,
    prelude::*, px,
};
use std::{cell::RefCell, process::Command, rc::Rc, time::Instant};

#[derive(Default)]
struct Measurements {
    paint: Option<f64>,
    query: Option<f64>,
    items: usize,
    reported: bool,
    presented: bool,
    interactions: Option<Entity<LibraryState>>,
    workspace: Option<Entity<Workspace>>,
    window: Option<AnyWindowHandle>,
    probe: Option<Rc<RefCell<InteractionProbe>>>,
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
        if let Some(state) = self.interactions.take() {
            let probe = InteractionProbe::start(
                state,
                self.workspace.clone().expect("workspace"),
                self.window.expect("window"),
                cx,
            );
            self.probe = Some(probe);
        } else {
            cx.quit();
        }
    }
}

// Default mode retains the original state-dispatch-to-notification benchmark.
// Render mode injects through the production Search EntityInputHandler, then
// waits for the next frame callback after the settled workspace's paint pass.
// This includes real input handling, query, layout and paint submission, but is
// NOT physical keyboard latency, GPU completion, or display scanout timing.
struct InteractionProbe {
    state: Entity<LibraryState>,
    workspace: Entity<Workspace>,
    window: AnyWindowHandle,
    render: bool,
    step: usize,
    started: Option<Instant>,
    settled_ms: Option<f64>,
    dispatch_ms: f64,
    paint_pending: bool,
}

impl InteractionProbe {
    fn phases(&self) -> usize {
        if self.render { 6 } else { 4 }
    }
    fn phase(&self) -> usize {
        self.step % self.phases()
    }
    fn start(
        state: Entity<LibraryState>,
        workspace: Entity<Workspace>,
        window: AnyWindowHandle,
        cx: &mut App,
    ) -> Rc<RefCell<Self>> {
        let probe = Rc::new(RefCell::new(Self {
            state: state.clone(),
            workspace,
            window,
            render: std::env::var("TAKIO_DESKTOP_BENCH_RENDER").as_deref() == Ok("1"),
            step: 0,
            started: None,
            settled_ms: None,
            dispatch_ms: 0.,
            paint_pending: false,
        }));
        let observed = probe.clone();
        cx.observe(&state, move |state, cx| {
            let mut current_probe = observed.borrow_mut();
            let Some(started) = current_probe.started else {
                return;
            };
            if current_probe.settled_ms.is_some() || state.read(cx).loading {
                return;
            }
            current_probe.validate(cx);
            current_probe.settled_ms = Some(started.elapsed().as_secs_f64() * 1000.);
            let render = current_probe.render;
            drop(current_probe);
            if !render {
                Self::complete(observed.clone(), None, cx);
            }
        })
        .detach();
        let dispatch = probe.clone();
        cx.defer(move |cx| Self::dispatch(dispatch, cx));
        probe
    }

    fn validate(&self, cx: &App) {
        let current = self.state.read(cx);
        if current
            .status
            .as_ref()
            .is_some_and(|status| status.is_error)
        {
            crate::fatal("interaction query failed");
        }
        let phase = self.phase();
        let expected = if phase == 0 { 5000 } else { 10000 };
        if current.items.len() != expected {
            crate::fatal("interaction returned unexpected item count");
        }
        if phase == 0
            && current
                .items
                .iter()
                .any(|item| !item.title.starts_with("Signal "))
        {
            crate::fatal("interaction returned unexpected search results");
        }
        if phase == 2
            && current.items.windows(2).any(|pair| {
                if current.sort.ascending {
                    pair[0].title > pair[1].title
                } else {
                    pair[0].title < pair[1].title
                }
            })
        {
            crate::fatal("interaction returned incorrectly sorted results");
        }
        if phase >= 3 && current.selected.len() != expected {
            crate::fatal("interaction did not retain every selected item");
        }
    }

    fn complete(probe: Rc<RefCell<Self>>, rendered_ms: Option<f64>, cx: &mut App) {
        let mut current = probe.borrow_mut();
        current.validate(cx);
        let phase = current.phase();
        if phase >= 4 {
            let list = current.workspace.read(cx).benchmark_list();
            let top = list.read(cx).benchmark_scroll_top();
            if (phase == 4 && top < 9000) || (phase == 5 && top != 0) {
                crate::fatal("scroll did not render the requested end of the catalogue");
            }
        }
        let operation = [
            "query_signal",
            "query_clear",
            "sort_title",
            "select_all_reload",
            "scroll_bottom",
            "scroll_top",
        ][phase];
        let state = current.state.read(cx);
        let rendered = rendered_ms.map_or_else(|| "null".to_owned(), |ms| format!("{ms:.3}"));
        println!(
            "{{\"kind\":\"interaction\",\"operation\":\"{operation}\",\"sample\":{},\"settledMs\":{:.3},\"dispatchMs\":{:.3},\"renderCompleteMs\":{rendered},\"expectedItems\":{},\"items\":{},\"selectedItems\":{},\"correct\":true}}",
            current.step / current.phases() + 1,
            current.settled_ms.expect("settled"),
            current.dispatch_ms,
            if phase == 0 { 5000 } else { 10000 },
            state.items.len(),
            state.selected.len()
        );
        current.started = None;
        current.settled_ms = None;
        current.paint_pending = false;
        current.step += 1;
        if current.step == 5 * current.phases() {
            println!(
                "{{\"kind\":\"interactions_complete\",\"samples\":{}}}",
                current.step
            );
            cx.quit();
        } else {
            drop(current);
            cx.defer(move |cx| Self::dispatch(probe, cx));
        }
    }

    fn dispatch(probe: Rc<RefCell<Self>>, cx: &mut App) {
        let current = probe.borrow();
        let phase = current.phase();
        let state = current.state.clone();
        let workspace = current.workspace.clone();
        let window = current.window;
        let render = current.render;
        drop(current);
        let started = Instant::now();
        probe.borrow_mut().started = Some(started);
        if render && !(2..4).contains(&phase) {
            window
                .update(cx, |_, window, cx| {
                    if phase < 2 {
                        let search = workspace.read(cx).benchmark_search();
                        search.update(cx, |search, cx| {
                            search.focus(window, cx);
                            let end = search.text().encode_utf16().count();
                            search.replace_text_in_range(
                                Some(0..end),
                                if phase == 0 { "Signal" } else { "" },
                                window,
                                cx,
                            );
                        });
                    } else {
                        let list = workspace.read(cx).benchmark_list();
                        list.update(cx, |list, cx| {
                            list.benchmark_scroll_to(if phase == 4 { 9999 } else { 0 }, cx)
                        });
                    }
                    window.refresh();
                })
                .expect("benchmark window");
        } else {
            state.update(cx, |state, cx| match phase {
                0 => state.set_query("Signal".into(), cx),
                1 => state.set_query(String::new(), cx),
                2 => state.set_sort(SortColumn::Title, cx),
                _ => {
                    state.select_all(cx);
                    state.reload(cx);
                }
            });
        }
        let mut current = probe.borrow_mut();
        current.dispatch_ms = started.elapsed().as_secs_f64() * 1000.;
        if phase >= 4 {
            current.settled_ms = Some(current.dispatch_ms);
        }
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
                move |_, _, window, cx| {
                    if measurements.borrow().paint.is_none() {
                        let measurements = measurements.clone();
                        cx.defer(move |cx| {
                            let mut measurement = measurements.borrow_mut();
                            if measurement.paint.is_none() {
                                measurement.paint = Some(started.elapsed().as_secs_f64() * 1000.);
                                measurement.finish(cx);
                            }
                        });
                    }
                    let probe = measurements.borrow().probe.clone();
                    if let Some(probe) = probe {
                        let mut current = probe.borrow_mut();
                        if current.render && current.settled_ms.is_some() && !current.paint_pending
                        {
                            current.paint_pending = true;
                            let started = current.started.expect("started");
                            drop(current);
                            window.on_next_frame(move |_, cx| {
                                let elapsed = started.elapsed().as_secs_f64() * 1000.;
                                InteractionProbe::complete(probe, Some(elapsed), cx);
                            });
                        }
                    }
                },
            )
            .absolute()
            .size(px(0.)),
        )
    }
}

pub fn run(started: Instant) {
    let data_override = std::env::var_os("TAKIO_DATA_DIR").map(std::path::PathBuf::from);
    let paths = engine::resolve_paths(data_override.as_deref())
        .unwrap_or_else(|error| crate::fatal(error.code()));
    let engine = Engine::open(paths).unwrap_or_else(|error| crate::fatal(error.code()));
    gpui_platform::application().run(move |cx: &mut App| {
        cx.set_global(Theme::LIGHT);
        cx.set_menus(crate::menus());
        let volumes = engine.root().join("benchmark-volumes");
        let state = cx.new(|cx| LibraryState::new_with_volumes(engine, volumes, cx));
        let measurements = Rc::new(RefCell::new(Measurements {
            interactions: (std::env::var("TAKIO_DESKTOP_BENCH_INTERACTIONS").as_deref() == Ok("1"))
                .then(|| state.clone()),
            ..Measurements::default()
        }));
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
        cx.open_window(crate::main_window_options(cx), move |window, cx| {
            cx.set_global(Theme::for_appearance(window.appearance()));
            let presented = measurements.clone();
            window.on_next_frame(move |window, _| {
                window.on_next_frame(move |_, cx| {
                    let mut measurement = presented.borrow_mut();
                    measurement.presented = true;
                    measurement.finish(cx);
                });
            });
            let workspace = cx.new(|cx| Workspace::new(state.clone(), window, cx));
            measurements.borrow_mut().workspace = Some(workspace.clone());
            measurements.borrow_mut().window = Some(window.window_handle());
            cx.new(|cx| {
                cx.observe(&state, |_, _, cx| cx.notify()).detach();
                BenchWindow {
                    workspace,
                    started,
                    measurements,
                }
            })
        })
        .expect("open benchmark window");
        cx.activate(true);
    });
}
