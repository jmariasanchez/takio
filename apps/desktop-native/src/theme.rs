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
    pub text_on_accent: Rgba,
    pub accent: Rgba,
    pub danger: Rgba,
    pub dark: bool,
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
        text_tertiary: rgb_const(0x8f8c85),
        text_on_accent: rgb_const(0xffffff),
        accent: rgb_const(0x2f6fdb),
        danger: rgb_const(0xc8362b),
        dark: false,
    };

    pub const DARK: Self = Self {
        window_bg: rgb_const(0x1d1c1a),
        sidebar_bg: rgb_const(0x242320),
        panel_bg: rgb_const(0x1a1917),
        row_hover: rgba_const(0xffffff0a),
        row_selected: rgb_const(0x2c4473),
        row_selected_inactive: rgb_const(0x33322e),
        border: rgba_const(0xffffff14),
        text: rgb_const(0xeceae4),
        text_secondary: rgb_const(0xa5a29b),
        text_tertiary: rgb_const(0x6f6c66),
        text_on_accent: rgb_const(0xffffff),
        accent: rgb_const(0x5b8def),
        danger: rgb_const(0xe5584d),
        dark: true,
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
