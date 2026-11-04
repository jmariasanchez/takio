//! Shared native button semantics and visual treatments.
use crate::theme::{Theme, metrics};
use gpui::{Div, SharedString, Stateful, div, prelude::*, px};

/// Click handlers also receive AccessKit Click and unmodified Enter/Space in GPUI.
pub(crate) fn accessible_button(
    element: Stateful<Div>,
    label: impl Into<SharedString>,
    enabled: bool,
) -> Stateful<Div> {
    element
        .role(gpui::Role::Button)
        .aria_label(label)
        .tab_index(0)
        .tab_stop(enabled)
        .focus_visible(|style| style.border_2().border_color(gpui::rgb(0x007aff)))
        .a11y_synthetic_children(move |builder| {
            if !enabled {
                builder.parent_node().set_disabled();
            }
        })
}

#[derive(Clone, Copy)]
pub(crate) enum Variant {
    Toolbar,
    Compact,
    Primary,
    Secondary,
    Text,
}

pub(crate) fn style(
    element: Stateful<Div>,
    enabled: bool,
    variant: Variant,
    theme: Theme,
) -> Stateful<Div> {
    match variant {
        Variant::Toolbar | Variant::Compact => {
            let compact = matches!(variant, Variant::Compact);
            element
                .px_2()
                .py_1()
                .rounded(px(metrics::RADIUS))
                .bg(theme.row_selected_inactive)
                .text_color(if !enabled {
                    theme.text_tertiary
                } else if compact {
                    theme.accent
                } else {
                    theme.text
                })
                .when(compact, |button| button.text_xs())
                .when(!compact, |button| button.text_sm())
                .when(enabled, |button| button.cursor_pointer())
                .when(enabled && !compact, |button| {
                    button.hover(|style| style.bg(theme.row_hover))
                })
        }
        Variant::Primary | Variant::Secondary => element
            .px_3()
            .py_1()
            .rounded(px(metrics::RADIUS))
            .border_1()
            .when(matches!(variant, Variant::Primary), |button| {
                button.bg(theme.row_selected)
            })
            .when(matches!(variant, Variant::Secondary), |button| {
                button.opacity(if enabled { 1.0 } else { 0.5 })
            })
            .cursor_pointer(),
        Variant::Text => element.cursor_pointer().text_sm().text_color(theme.accent),
    }
}

pub(crate) fn button(
    id: &'static str,
    label: impl Into<SharedString>,
    enabled: bool,
    theme: Theme,
) -> Stateful<Div> {
    let label = label.into();
    style(
        accessible_button(div().id(id), label.clone(), enabled),
        enabled,
        Variant::Toolbar,
        theme,
    )
    .debug_selector(move || id.to_owned())
    .child(label)
}
