//! Three-pane shell: sidebar, list, inspector, plus toolbar and status bar.

use gpui::{
    App, Context, Entity, FocusHandle, Focusable, IntoElement, ParentElement, PathPromptOptions,
    Render, Styled, Window, div, prelude::*, px,
};

use crate::engine::ImportMode;
use crate::state::{LibraryEntity, Section};
use crate::theme::{Theme, metrics};
use crate::views::library_list::LibraryList;
use crate::{
    Import, ImportMove, PurgeSelected, RefreshDevices, RestoreSelected, ShowLibrary, ShowTrash,
};

pub struct Workspace {
    state: LibraryEntity,
    list: Entity<LibraryList>,
    focus: FocusHandle,
}

impl Workspace {
    pub fn new(state: LibraryEntity, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let list = cx.new(|cx| LibraryList::new(state.clone(), cx));
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        cx.observe_window_appearance(window, |_, window, cx| {
            cx.set_global(Theme::for_appearance(window.appearance()));
            cx.notify();
        })
        .detach();
        let focus = list.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        Self { state, list, focus }
    }

    fn prompt_import(&mut self, mode: ImportMode, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Import".into()),
        });
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await {
                let _ = state.update(cx, |state, cx| state.import(paths, mode, cx));
            }
        })
        .detach();
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let read = self.state.read(cx);
        let section = read.section;
        let count = read.items.len();
        let selected = read.selected.len();
        let status = read.status.clone();
        let loading = read.loading;

        let sidebar = div()
            .w(px(metrics::SIDEBAR_WIDTH))
            .flex_shrink_0()
            .h_full()
            .bg(theme.sidebar_bg)
            .border_r_1()
            .border_color(theme.border)
            .pt(px(44.))
            .px_2()
            .flex()
            .flex_col()
            .gap_1()
            .child(sidebar_item(
                "Library",
                section == Section::Library,
                &theme,
                {
                    let state = self.state.clone();
                    move |cx| state.update(cx, |state, cx| state.set_section(Section::Library, cx))
                },
            ))
            .child(sidebar_item("Trash", section == Section::Trash, &theme, {
                let state = self.state.clone();
                move |cx| state.update(cx, |state, cx| state.set_section(Section::Trash, cx))
            }));

        let summary = if selected > 0 {
            format!("{selected} of {count} selected")
        } else if loading {
            "Loading...".to_owned()
        } else {
            format!("{count} book{}", if count == 1 { "" } else { "s" })
        };

        let status_bar = div()
            .h(px(24.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .px_3()
            .gap_3()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.window_bg)
            .text_xs()
            .text_color(theme.text_secondary)
            .child(summary)
            .children(status.map(|status| {
                div()
                    .text_color(if status.is_error {
                        theme.danger
                    } else {
                        theme.text_tertiary
                    })
                    .child(status.text)
            }));

        div()
            .key_context("Workspace")
            .on_action(
                cx.listener(|this, _: &Import, _, cx| this.prompt_import(ImportMode::Copy, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ImportMove, _, cx| this.prompt_import(ImportMode::Move, cx)),
            )
            .on_action(cx.listener(|this, _: &ShowLibrary, _, cx| {
                this.state
                    .update(cx, |state, cx| state.set_section(Section::Library, cx));
            }))
            .on_action(cx.listener(|this, _: &ShowTrash, _, cx| {
                this.state
                    .update(cx, |state, cx| state.set_section(Section::Trash, cx));
            }))
            .on_action(cx.listener(|this, _: &RestoreSelected, _, cx| {
                this.state
                    .update(cx, |state, cx| state.restore_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &PurgeSelected, _, cx| {
                this.state.update(cx, |state, cx| state.purge_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &RefreshDevices, _, cx| {
                this.state
                    .update(cx, |state, cx| state.refresh_destinations(cx));
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.window_bg)
            .text_color(theme.text)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(sidebar)
                    .child(div().flex_1().min_w_0().h_full().child(self.list.clone())),
            )
            .child(status_bar)
    }
}

fn sidebar_item(
    label: &'static str,
    active: bool,
    theme: &Theme,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(label)
        .h(px(26.))
        .px_2()
        .flex()
        .items_center()
        .rounded(px(metrics::RADIUS))
        .cursor_pointer()
        .text_sm()
        .when(active, |this| this.bg(theme.row_selected_inactive))
        .hover(|style| style.bg(theme.row_hover))
        .text_color(theme.text)
        .child(label)
        .on_click(move |_, _, cx| on_click(cx))
}
