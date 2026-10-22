//! Keyboard-first command launcher, with native text input and restored action focus.
use crate::theme::Theme;
use gpui::{
    Action, Bounds, Context, ElementInputHandler, EntityInputHandler, FocusHandle, MouseButton,
    Pixels, Point, UTF16Selection, Window, canvas, div, prelude::*, px,
};
use std::ops::Range;

struct Command {
    label: &'static str,
    hint: &'static str,
    action: fn() -> Box<dyn Action>,
}
const COMMANDS: &[Command] = &[
    Command {
        label: "Import...",
        hint: "Cmd Shift I",
        action: || Box::new(crate::Import),
    },
    Command {
        label: "Import and Move...",
        hint: "",
        action: || Box::new(crate::ImportMove),
    },
    Command {
        label: "Open Selected",
        hint: "Cmd O",
        action: || Box::new(crate::OpenSelected),
    },
    Command {
        label: "Edit Book Details...",
        hint: "Cmd E",
        action: || Box::new(crate::EditSelected),
    },
    Command {
        label: "Send Selected Books...",
        hint: "Cmd Shift S",
        action: || Box::new(crate::SendSelected),
    },
    Command {
        label: "Send Ready Books from Review",
        hint: "Cmd Enter",
        action: || Box::new(crate::ConfirmSend),
    },
    Command {
        label: "Cancel Send Review",
        hint: "Cmd .",
        action: || Box::new(crate::CancelSend),
    },
    Command {
        label: "Eject Reader...",
        hint: "",
        action: || Box::new(crate::EjectReader),
    },
    Command {
        label: "Move to Trash",
        hint: "Cmd Backspace",
        action: || Box::new(crate::TrashSelected),
    },
    Command {
        label: "Restore Selected",
        hint: "",
        action: || Box::new(crate::RestoreSelected),
    },
    Command {
        label: "Delete Permanently",
        hint: "",
        action: || Box::new(crate::PurgeSelected),
    },
    Command {
        label: "Select All",
        hint: "Cmd A",
        action: || Box::new(crate::SelectAll),
    },
    Command {
        label: "Show Library",
        hint: "Cmd 1",
        action: || Box::new(crate::ShowLibrary),
    },
    Command {
        label: "Show Trash",
        hint: "Cmd 2",
        action: || Box::new(crate::ShowTrash),
    },
    Command {
        label: "Refresh Devices",
        hint: "Cmd R",
        action: || Box::new(crate::RefreshDevices),
    },
    Command {
        label: "Focus Search",
        hint: "Cmd F",
        action: || Box::new(crate::FocusSearch),
    },
    Command {
        label: "Quit Takio",
        hint: "Cmd Q",
        action: || Box::new(crate::Quit),
    },
];

fn matching_commands(query: &str) -> Vec<usize> {
    let query = query.to_lowercase();
    COMMANDS
        .iter()
        .enumerate()
        .filter_map(|(i, command)| command.label.to_lowercase().contains(&query).then_some(i))
        .collect()
}

pub struct Palette {
    open: bool,
    focus: FocusHandle,
    previous_focus: Option<FocusHandle>,
    action_focus: FocusHandle,
    query: String,
    selected: Range<usize>,
    marked: Option<Range<usize>>,
    highlighted: usize,
}
impl Palette {
    pub fn new(action_focus: FocusHandle, cx: &mut Context<Self>) -> Self {
        Self {
            open: false,
            focus: cx.focus_handle(),
            previous_focus: None,
            action_focus,
            query: String::new(),
            selected: 0..0,
            marked: None,
            highlighted: 0,
        }
    }
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.close(window, cx);
        } else {
            self.previous_focus = window.focused(cx);
            self.open = true;
            self.query.clear();
            self.selected = 0..0;
            self.marked = None;
            self.highlighted = 0;
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }
    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        if let Some(focus) = self.previous_focus.take() {
            window.focus(&focus, cx);
        }
        cx.notify();
    }
    fn matches(&self) -> Vec<usize> {
        matching_commands(&self.query)
    }
    fn run(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
        // Actions capture the dispatch node immediately. Target the list even
        // when the palette was opened from Search, so selection commands work.
        window.focus(&self.action_focus, cx);
        window.dispatch_action((COMMANDS[index].action)().boxed_clone(), cx);
    }
    fn byte_offset(&self, offset: usize) -> usize {
        let mut units = 0;
        for (byte, ch) in self.query.char_indices() {
            if units >= offset {
                return byte;
            }
            units += ch.len_utf16();
        }
        self.query.len()
    }
    fn bytes(&self, range: Range<usize>) -> Range<usize> {
        self.byte_offset(range.start)..self.byte_offset(range.end)
    }
    fn units(&self, range: Range<usize>) -> Range<usize> {
        self.query[..range.start].encode_utf16().count()
            ..self.query[..range.end].encode_utf16().count()
    }
}
impl EntityInputHandler for Palette {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.bytes(range);
        *actual = Some(self.units(range.clone()));
        Some(self.query[range].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.units(self.selected.clone()),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.units(r))
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.bytes(r))
            .or(self.marked.take())
            .unwrap_or(self.selected.clone());
        self.query.replace_range(range.clone(), text);
        let end = range.start + text.len();
        self.selected = end..end;
        self.highlighted = 0;
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.bytes(r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        self.replace_text_in_range(Some(self.units(range.clone())), text, window, cx);
        self.marked = (!text.is_empty()).then_some(range.start..range.start + text.len());
        if let Some(selected) = selected {
            let start = self.query[..range.start].encode_utf16().count();
            self.selected = self.bytes(start + selected.start..start + selected.end);
        }
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(bounds)
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.query.encode_utf16().count())
    }
}
impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }
        let theme = *cx.global::<Theme>();
        let entity = cx.entity();
        let focus = self.focus.clone();
        let matches = self.matches();
        div()
            .absolute()
            .inset_0()
            .size_full()
            .flex()
            .justify_center()
            .items_start()
            .pt(px(100.))
            .bg(gpui::rgba(0x00000030))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.close(window, cx);
                    cx.stop_propagation();
                }),
            )
            .child(
                div()
                    .id("command-palette")
                    .track_focus(&self.focus)
                    .key_context("Palette")
                    .w(px(520.))
                    .bg(theme.panel_bg)
                    .rounded_lg()
                    .shadow_lg()
                    .border_1()
                    .border_color(theme.border)
                    .overflow_hidden()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        let matches = this.matches();
                        match event.keystroke.key.as_str() {
                            "escape" => this.close(window, cx),
                            "up" => {
                                this.highlighted = this.highlighted.saturating_sub(1);
                                cx.notify();
                            }
                            "down" => {
                                this.highlighted =
                                    (this.highlighted + 1).min(matches.len().saturating_sub(1));
                                cx.notify();
                            }
                            "enter" => {
                                if let Some(index) = matches.get(this.highlighted) {
                                    this.run(*index, window, cx);
                                }
                            }
                            "backspace" => {
                                if this.selected.is_empty() {
                                    let start = this.query[..this.selected.start]
                                        .char_indices()
                                        .last()
                                        .map_or(0, |(i, _)| i);
                                    this.selected.start = start;
                                }
                                this.replace_text_in_range(None, "", window, cx);
                            }
                            "a" if event.keystroke.modifiers.platform => {
                                this.selected = 0..this.query.len();
                                cx.notify();
                            }
                            _ => return,
                        }
                        cx.stop_propagation();
                    }))
                    .child(
                        div()
                            .relative()
                            .h(px(52.))
                            .px_4()
                            .flex()
                            .items_center()
                            .border_b_1()
                            .border_color(theme.border)
                            .text_color(if self.query.is_empty() {
                                theme.text_tertiary
                            } else {
                                theme.text
                            })
                            .child(if self.query.is_empty() {
                                "Type a command...".to_owned()
                            } else {
                                format!("{}|", self.query)
                            })
                            .child(
                                canvas(
                                    |_, _, _| (),
                                    move |bounds, _, window, cx| {
                                        window.handle_input(
                                            &focus,
                                            ElementInputHandler::new(bounds, entity),
                                            cx,
                                        )
                                    },
                                )
                                .absolute()
                                .inset_0(),
                            ),
                    )
                    .child(
                        div()
                            .p_2()
                            .children(matches.iter().enumerate().map(|(row, &index)| {
                                let command = &COMMANDS[index];
                                div()
                                    .id(index)
                                    .h(px(32.))
                                    .px_3()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .rounded_md()
                                    .cursor_pointer()
                                    .text_sm()
                                    .text_color(theme.text)
                                    .when(row == self.highlighted, |el| el.bg(theme.row_selected))
                                    .hover(|style| style.bg(theme.row_hover))
                                    .child(command.label)
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.text_tertiary)
                                            .child(command.hint),
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.run(index, window, cx)
                                    }))
                            }))
                            .when(matches.is_empty(), |el| {
                                el.child(
                                    div()
                                        .p_3()
                                        .text_color(theme.text_secondary)
                                        .child("No matching commands"),
                                )
                            }),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{COMMANDS, matching_commands};

    #[test]
    fn empty_filter_preserves_all_command_order() {
        for label in [
            "Edit Book Details...",
            "Send Selected Books...",
            "Eject Reader...",
        ] {
            assert!(COMMANDS.iter().any(|command| command.label == label));
        }
        assert_eq!(
            matching_commands(""),
            (0..COMMANDS.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn filter_is_case_insensitive_substring() {
        let labels: Vec<_> = matching_commands("sHoW")
            .into_iter()
            .map(|index| COMMANDS[index].label)
            .collect();
        assert_eq!(labels, ["Show Library", "Show Trash"]);
        let permanent = matching_commands("permanent");
        assert_eq!(permanent.len(), 1);
        assert_eq!(COMMANDS[permanent[0]].label, "Delete Permanently");
    }

    #[test]
    fn unmatched_filter_has_no_action() {
        assert!(matching_commands("missing command").is_empty());
        assert!(matching_commands("\u{1f4da}").is_empty());
    }
}
