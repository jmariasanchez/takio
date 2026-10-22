//! Three-pane shell: sidebar, list, inspector, plus toolbar and status bar.

use gpui::{
    App, Context, Entity, FocusHandle, Focusable, IntoElement, ParentElement, PathPromptOptions,
    Render, Styled, Window, div, prelude::*, px,
};

use crate::engine::ImportMode;
use crate::state::{LibraryEntity, Section};
use crate::theme::{Theme, metrics};
use crate::views::library_list::LibraryList;
use crate::views::{search::Search, sidebar::Sidebar};
use crate::{
    Import, ImportMove, OpenSelected, PurgeSelected, RefreshDevices, RestoreSelected, SelectAll,
    ShowLibrary, ShowTrash, TrashSelected,
};

pub struct Workspace {
    state: LibraryEntity,
    list: Entity<LibraryList>,
    search: Entity<Search>,
    sidebar: Entity<Sidebar>,
    inspector: Entity<crate::views::inspector::Inspector>,
    palette: Entity<crate::views::palette::Palette>,
    focus: FocusHandle,
}

impl Workspace {
    pub fn new(state: LibraryEntity, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| Search::new(state.clone(), cx));
        let sidebar = cx.new(|cx| Sidebar::new(state.clone(), cx));
        let list = cx.new(|cx| LibraryList::new(state.clone(), cx));
        let inspector = cx.new(|cx| crate::views::inspector::Inspector::new(state.clone(), cx));
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        cx.observe_window_appearance(window, |_, window, cx| {
            cx.set_global(Theme::for_appearance(window.appearance()));
            cx.notify();
        })
        .detach();
        let focus = list.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        let palette = cx.new(|cx| crate::views::palette::Palette::new(focus.clone(), cx));
        Self {
            state,
            list,
            inspector,
            focus,
            palette,
            search,
            sidebar,
        }
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
                state.update(cx, |state, cx| state.import(paths, mode, cx));
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
        let count = read.items.len();
        let selected = read.selected.len();
        let status = read.status.clone();
        let loading = read.loading;

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
            .on_action(cx.listener(|this, _: &crate::FocusSearch, window, cx| {
                this.search
                    .update(cx, |search, cx| search.focus(window, cx));
            }))
            .on_action(cx.listener(|this, _: &crate::TogglePalette, window, cx| {
                this.palette.update(cx, |p, cx| p.toggle(window, cx));
            }))
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
            // Fallbacks for actions the list handles when it has focus. Menu
            // items and the palette can fire these while Search or the
            // inspector owns focus; without these the action would be lost.
            .on_action(cx.listener(|this, _: &SelectAll, _, cx| {
                this.state.update(cx, |state, cx| state.select_all(cx));
            }))
            .on_action(cx.listener(|this, _: &TrashSelected, _, cx| {
                this.state.update(cx, |state, cx| state.trash_selected(cx));
            }))
            .on_action(cx.listener(|this, _: &OpenSelected, _, cx| {
                let path = this
                    .state
                    .read(cx)
                    .primary_selected()
                    .and_then(|item| item.formats.first())
                    .map(|format| format.source_path.clone());
                if let Some(path) = path {
                    cx.open_with_system(&path);
                }
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
                    .child(self.sidebar.clone())
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .child(
                                div()
                                    .h(px(metrics::TOOLBAR_HEIGHT))
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .px_3()
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .child(self.search.clone()),
                            )
                            .child(div().flex_1().min_h_0().child(self.list.clone())),
                    )
                    .child(self.inspector.clone()),
            )
            .child(status_bar)
            .child(gpui::deferred(self.palette.clone()).with_priority(10))
    }
}
