//! A small native single-line input with UTF-16 platform text handling.
use std::ops::Range;

use crate::{
    ClearSearch,
    state::LibraryEntity,
    theme::{Theme, metrics},
};
use gpui::{
    App, Bounds, Context, ElementInputHandler, EntityInputHandler, FocusHandle, KeyBinding,
    MouseButton, Pixels, Point, ShapedLine, TextRun, UTF16Selection, Window, actions, canvas, div,
    point, prelude::*, px,
};

actions!(
    search,
    [Backspace, Delete, Left, Right, Home, End, SelectAll, Paste]
);

pub struct Search {
    state: LibraryEntity,
    focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    bounds: Option<Bounds<Pixels>>,
    line: Option<ShapedLine>,
    scroll: Pixels,
}

impl Search {
    pub fn new(state: LibraryEntity, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("backspace", Backspace, Some("Search")),
            KeyBinding::new("delete", Delete, Some("Search")),
            KeyBinding::new("left", Left, Some("Search")),
            KeyBinding::new("right", Right, Some("Search")),
            KeyBinding::new("cmd-left", Home, Some("Search")),
            KeyBinding::new("cmd-right", End, Some("Search")),
            KeyBinding::new("cmd-a", SelectAll, Some("Search")),
            KeyBinding::new("cmd-v", Paste, Some("Search")),
        ]);
        let text = state.read(cx).query.clone();
        let end = text.len();
        Self {
            state,
            focus: cx.focus_handle(),
            text,
            selection: end..end,
            marked: None,
            bounds: None,
            line: None,
            scroll: px(0.),
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }

    fn move_to(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selection = index..index;
        self.marked = None;
        cx.notify();
    }

    fn previous(&self) -> usize {
        self.text[..self.selection.start]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.selection.end
            + self.text[self.selection.end..]
                .chars()
                .next()
                .map_or(0, char::len_utf8)
    }

    fn byte_offset(text: &str, offset: usize) -> usize {
        let mut utf16 = 0;
        for (byte, ch) in text.char_indices() {
            if utf16 >= offset {
                return byte;
            }
            utf16 += ch.len_utf16();
        }
        text.len()
    }

    fn range_from_utf16(&self, range: Range<usize>) -> Range<usize> {
        Self::byte_offset(&self.text, range.start)..Self::byte_offset(&self.text, range.end)
    }

    fn to_utf16(&self, range: Range<usize>) -> Range<usize> {
        self.text[..range.start].encode_utf16().count()
            ..self.text[..range.end].encode_utf16().count()
    }

    fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        cx: &mut Context<Self>,
    ) -> Range<usize> {
        let range = range
            .map(|r| self.range_from_utf16(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let text = text.replace(['\n', '\r'], " ");
        self.text.replace_range(range.clone(), &text);
        let inserted = range.start..range.start + text.len();
        self.selection = inserted.end..inserted.end;
        self.marked = None;
        self.state
            .update(cx, |state, cx| state.set_query(self.text.clone(), cx));
        cx.notify();
        inserted
    }
}

impl EntityInputHandler for Search {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(range);
        *actual = Some(self.to_utf16(range.clone()));
        Some(self.text[range].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.to_utf16(self.selection.clone()),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.to_utf16(r))
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(range, text, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let inserted = self.replace(range, text, cx);
        if !inserted.is_empty() {
            if let Some(selected) = selected {
                let text = &self.text[inserted.clone()];
                self.selection = inserted.start + Self::byte_offset(text, selected.start)
                    ..inserted.start + Self::byte_offset(text, selected.end);
            }
            self.marked = Some(inserted);
        }
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(range);
        let line = self.line.as_ref()?;
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(range.start) - self.scroll,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(range.end) - self.scroll,
                bounds.bottom(),
            ),
        ))
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let index = self
            .line
            .as_ref()?
            .closest_index_for_x(point.x - self.bounds?.left() + self.scroll)
            .min(self.text.len());
        Some(self.to_utf16(index..index).start)
    }
}

impl Render for Search {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.global::<Theme>();
        let focused = self.focus.is_focused(window);
        let style = window.text_style();
        let line = window.text_system().shape_line(
            self.text.clone().into(),
            px(14.),
            &[TextRun {
                len: self.text.len(),
                font: style.font(),
                color: theme.text.into(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        );
        let cursor = line.x_for_index(self.selection.end);
        self.scroll = (cursor - px(240.)).max(px(0.));
        let start = line.x_for_index(self.selection.start) - self.scroll;
        let end = cursor - self.scroll;
        self.line = Some(line);
        let entity = cx.entity();
        div()
            .key_context("Search")
            .track_focus(&self.focus)
            .w(px(260.))
            .h(px(28.))
            .flex_shrink_0()
            .px_2()
            .flex()
            .items_center()
            .rounded(px(metrics::RADIUS))
            .bg(theme.panel_bg)
            .border_1()
            .border_color(theme.border)
            .text_sm()
            .text_color(theme.text)
            .cursor_text()
            .on_action(cx.listener(|this, _: &Backspace, _, cx| {
                if this.selection.is_empty() {
                    this.selection.start = this.previous();
                }
                this.replace(None, "", cx);
            }))
            .on_action(cx.listener(|this, _: &Delete, _, cx| {
                if this.selection.is_empty() {
                    this.selection.end = this.next();
                }
                this.replace(None, "", cx);
            }))
            .on_action(cx.listener(|this, _: &Left, _, cx| {
                let i = if this.selection.is_empty() {
                    this.previous()
                } else {
                    this.selection.start
                };
                this.move_to(i, cx);
            }))
            .on_action(cx.listener(|this, _: &Right, _, cx| {
                let i = if this.selection.is_empty() {
                    this.next()
                } else {
                    this.selection.end
                };
                this.move_to(i, cx);
            }))
            .on_action(cx.listener(|this, _: &Home, _, cx| this.move_to(0, cx)))
            .on_action(cx.listener(|this, _: &End, _, cx| this.move_to(this.text.len(), cx)))
            .on_action(cx.listener(|this, _: &SelectAll, _, cx| {
                this.selection = 0..this.text.len();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Paste, _, cx| {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    this.replace(None, &text, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &ClearSearch, window, cx| {
                this.marked = None;
                this.selection = 0..this.text.len();
                this.replace(None, "", cx);
                this.focus(window, cx);
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                    this.focus(window, cx);
                    let index = this.bounds.zip(this.line.as_ref()).map_or(
                        this.text.len(),
                        |(bounds, line)| {
                            line.closest_index_for_x(event.position.x - bounds.left() + this.scroll)
                                .min(this.text.len())
                        },
                    );
                    this.move_to(index, cx);
                }),
            )
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(20.))
                    .overflow_hidden()
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, cx| {
                                entity.update(cx, |this, _| this.bounds = Some(bounds));
                                let focus = entity.read(cx).focus.clone();
                                window.handle_input(
                                    &focus,
                                    ElementInputHandler::new(bounds, entity.clone()),
                                    cx,
                                );
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
                    .when(focused && !self.selection.is_empty(), |el| {
                        el.child(
                            div()
                                .absolute()
                                .left(start)
                                .top_0()
                                .w(end - start)
                                .h_full()
                                .bg(theme.row_selected),
                        )
                    })
                    .child(
                        div()
                            .absolute()
                            .left(-self.scroll)
                            .top_0()
                            .whitespace_nowrap()
                            .text_color(if self.text.is_empty() {
                                theme.text_tertiary
                            } else {
                                theme.text
                            })
                            .child(if self.text.is_empty() {
                                "Search".to_owned()
                            } else {
                                self.text.clone()
                            }),
                    )
                    .when(focused && self.selection.is_empty(), |el| {
                        el.child(
                            div()
                                .absolute()
                                .left(end)
                                .top(px(2.))
                                .w(px(1.))
                                .h(px(16.))
                                .bg(theme.accent),
                        )
                    }),
            )
    }
}
