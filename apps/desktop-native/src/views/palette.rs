//! Keyboard-first command launcher, with native text input and restored action focus.
use super::text_input::TextInput;
use crate::theme::Theme;
use gpui::{Context, Entity, FocusHandle, MouseButton, Subscription, Window, div, prelude::*, px};

use crate::commands::COMMANDS;

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
    input: Entity<TextInput>,
    _input_change: Subscription,
    previous_focus: Option<FocusHandle>,
    action_focus: FocusHandle,
    highlighted: usize,
}
impl Palette {
    pub fn new(action_focus: FocusHandle, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut input = TextInput::new(String::new(), cx);
            input.set_label("Command palette");
            input.set_placeholder("Type a command");
            input
        });
        let input_change =
            cx.subscribe(&input, |this, _, _: &super::text_input::TextChanged, cx| {
                this.highlighted = 0;
                cx.notify();
            });
        Self {
            open: false,
            input,
            _input_change: input_change,
            previous_focus: None,
            action_focus,
            highlighted: 0,
        }
    }
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.close(window, cx);
        } else {
            self.previous_focus = window.focused(cx);
            self.open = true;
            self.input
                .update(cx, |input, cx| input.set_text(String::new(), cx));
            self.highlighted = 0;
            let focus = self.input.read(cx).focus_handle();
            window.focus(&focus, cx);
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
    fn matches(&self, cx: &Context<Self>) -> Vec<usize> {
        matching_commands(self.input.read(cx).text())
    }
    fn run(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
        // Actions capture the dispatch node immediately. Target the list even
        // when the palette was opened from Search, so selection commands work.
        window.focus(&self.action_focus, cx);
        window.dispatch_action((COMMANDS[index].action)().boxed_clone(), cx);
    }
}
impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }
        let theme = *cx.global::<Theme>();
        let matches = self.matches(cx);
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
                    .role(gpui::Role::Group)
                    .aria_label("Command palette")
                    .key_context("Palette")
                    .map(crate::commands::block_modal_actions)
                    .w(px(520.))
                    .bg(theme.panel_bg)
                    .rounded_lg()
                    .shadow_lg()
                    .border_1()
                    .border_color(theme.border)
                    .overflow_hidden()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        let matches = this.matches(cx);
                        match event.keystroke.key.as_str() {
                            "escape" => this.close(window, cx),
                            "tab" => {
                                cx.stop_propagation();
                                return;
                            }
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
                            .child(self.input.clone()),
                    )
                    .child(
                        div()
                            .id("matching-commands")
                            .role(gpui::Role::ListBox)
                            .aria_label("Matching commands")
                            .p_2()
                            .children(matches.iter().enumerate().map(|(row, &index)| {
                                let command = &COMMANDS[index];
                                div()
                                    .id(index)
                                    .role(gpui::Role::ListBoxOption)
                                    .aria_label(command.label)
                                    .aria_keyshortcuts(command.hint())
                                    .aria_selected(row == self.highlighted)
                                    .when(row == self.highlighted, |el| el.aria_active_descendant())
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
                                            .child(command.hint()),
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
    use gpui::{EntityInputHandler, TestAppContext};

    #[gpui::test]
    fn palette_shared_input_composition_refilters_and_resets_highlight(cx: &mut TestAppContext) {
        cx.update(crate::theme::initialize);
        let window = cx.add_window(|window, cx| {
            let focus = cx.focus_handle();
            let mut palette = super::Palette::new(focus, cx);
            palette.toggle(window, cx);
            palette
        });
        window
            .update(cx, |palette, window, cx| {
                palette.highlighted = 2;
                palette.input.update(cx, |input, cx| {
                    input.replace_and_mark_text_in_range(None, "\u{1f4da}", Some(0..2), window, cx);
                    assert_eq!(input.marked_text_range(window, cx), Some(0..2));
                    input.replace_text_in_range(None, "Show", window, cx);
                    assert_eq!(input.text(), "Show");
                    assert_eq!(input.marked_text_range(window, cx), None);
                });
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |palette, window, cx| {
                assert_eq!(palette.highlighted, 0);
                let labels = palette
                    .matches(cx)
                    .into_iter()
                    .map(|i| COMMANDS[i].label)
                    .collect::<Vec<_>>();
                assert_eq!(labels, ["Show Library", "Show Trash"]);
                palette.close(window, cx);
                palette.toggle(window, cx);
                assert!(palette.input.read(cx).text().is_empty());
            })
            .unwrap();
    }

    #[test]
    fn empty_filter_preserves_all_command_order() {
        for label in [
            "Open Library...",
            "Reveal Current Library",
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
