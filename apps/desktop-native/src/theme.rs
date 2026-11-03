//! Design tokens. One source of truth for color, spacing, and type so every
//! view reads the same way. Appearance follows the window (system light or
//! dark); nothing is hard-coded in views.

use gpui::{Rgba, WindowAppearance};

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub window_bg: Rgba,
    pub sidebar_bg: Rgba,
    pub panel_bg: Rgba,
    pub row_hover: Rgba,
    pub row_selected: Rgba,
    pub row_selected_inactive: Rgba,
    pub border: Rgba,
    pub text: Rgba,
    pub text_secondary: Rgba,
    pub text_tertiary: Rgba,
    pub accent: Rgba,
    pub danger: Rgba,
}

impl Theme {
    pub const LIGHT: Self = Self {
        window_bg: rgb_const(0xf5f4f0),
        sidebar_bg: rgb_const(0xece9e2),
        panel_bg: rgb_const(0xffffff),
        row_hover: rgba_const(0x00000008),
        row_selected: rgb_const(0xd9e3f7),
        row_selected_inactive: rgb_const(0xe6e4df),
        border: rgba_const(0x00000018),
        text: rgb_const(0x1c1b19),
        text_secondary: rgb_const(0x5c5a55),
        text_tertiary: rgb_const(0x63605a),
        accent: rgb_const(0x235cb8),
        danger: rgb_const(0xb32b22),
    };

    pub const DARK: Self = Self {
        window_bg: rgb_const(0x1d1c1a),
        sidebar_bg: rgb_const(0x242320),
        panel_bg: rgb_const(0x1a1917),
        row_hover: rgba_const(0xffffff0a),
        row_selected: rgb_const(0x243553),
        row_selected_inactive: rgb_const(0x33322e),
        border: rgba_const(0xffffff14),
        text: rgb_const(0xeceae4),
        text_secondary: rgb_const(0xa5a29b),
        text_tertiary: rgb_const(0xa09d96),
        accent: rgb_const(0x8fa9df),
        danger: rgb_const(0xe98278),
    };

    pub fn for_appearance(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::DARK,
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::LIGHT,
        }
    }
}

impl gpui::Global for Theme {}

const fn rgb_const(hex: u32) -> Rgba {
    Rgba {
        r: ((hex >> 16) & 0xff) as f32 / 255.0,
        g: ((hex >> 8) & 0xff) as f32 / 255.0,
        b: (hex & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

const fn rgba_const(hex: u32) -> Rgba {
    Rgba {
        r: ((hex >> 24) & 0xff) as f32 / 255.0,
        g: ((hex >> 16) & 0xff) as f32 / 255.0,
        b: ((hex >> 8) & 0xff) as f32 / 255.0,
        a: (hex & 0xff) as f32 / 255.0,
    }
}

/// Layout constants in logical pixels.
pub mod metrics {
    pub const SIDEBAR_WIDTH: f32 = 220.0;
    pub const INSPECTOR_WIDTH: f32 = 300.0;
    pub const ROW_HEIGHT: f32 = 28.0;
    pub const TOOLBAR_HEIGHT: f32 = 44.0;
    pub const RADIUS: f32 = 6.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn luminance(color: Rgba) -> f64 {
        let linear = |value: f32| {
            let value = f64::from(value);
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
    }

    fn contrast(foreground: Rgba, background: Rgba) -> f64 {
        let foreground = luminance(foreground);
        let background = luminance(background);
        (foreground.max(background) + 0.05) / (foreground.min(background) + 0.05)
    }

    fn composite(overlay: Rgba, background: Rgba) -> Rgba {
        Rgba {
            r: overlay.r * overlay.a + background.r * (1.0 - overlay.a),
            g: overlay.g * overlay.a + background.g * (1.0 - overlay.a),
            b: overlay.b * overlay.a + background.b * (1.0 - overlay.a),
            a: 1.0,
        }
    }

    #[test]
    fn small_text_keeps_contrast_in_both_appearances_and_selection_states() {
        // WCAG 2.2's sRGB contrast formula, applied to our native small-text tokens.
        // This checks these combinations, not complete application accessibility.
        for (appearance, theme) in [("light", Theme::LIGHT), ("dark", Theme::DARK)] {
            let backgrounds = [
                ("window", theme.window_bg),
                ("sidebar", theme.sidebar_bg),
                ("panel", theme.panel_bg),
                ("selected", theme.row_selected),
                ("inactive selection", theme.row_selected_inactive),
                ("striped row", composite(theme.row_hover, theme.panel_bg)),
                (
                    "hovered sidebar",
                    composite(theme.row_hover, theme.sidebar_bg),
                ),
            ];
            for (text, foreground) in [
                ("primary", theme.text),
                ("secondary", theme.text_secondary),
                ("tertiary", theme.text_tertiary),
                ("action", theme.accent),
                ("error", theme.danger),
            ] {
                for (surface, background) in backgrounds {
                    let ratio = contrast(foreground, background);
                    assert!(
                        ratio >= 4.5,
                        "{appearance} {text} text on {surface}: {ratio:.2}:1 is below 4.5:1"
                    );
                }
            }
        }
    }

    #[test]
    fn luminance_formula_matches_black_white_reference() {
        assert!((contrast(rgb_const(0x000000), rgb_const(0xffffff)) - 21.0).abs() < 0.001);
        assert_eq!(contrast(Theme::LIGHT.text, Theme::LIGHT.text), 1.0);
    }
}
