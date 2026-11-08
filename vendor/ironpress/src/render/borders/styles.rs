use crate::style::computed::BorderStyle;
use crate::types::PhysicalSide;

/// Used stripe and gap allocation for a CSS `double` border.
///
/// CSS leaves the allocation implementation-defined. Blink rounds the outer
/// third in integer CSS pixels; the inner stripe has the same width and the
/// middle gap owns the remainder. Fractional authored widths retain exact
/// thirds rather than being silently enlarged to a device-dependent integer.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct DoubleBorderMetrics {
    width: f32,
    stripe: f32,
}

impl DoubleBorderMetrics {
    pub(crate) fn new(width: f32) -> Self {
        let width = width.max(0.0);
        let css_width = width / crate::fonts::PT_PER_CSS_PX;
        let snapped_css_width = css_width.round();
        let stripe = if snapped_css_width >= 3.0 && (css_width - snapped_css_width).abs() < 0.001 {
            ((snapped_css_width + 1.0) / 3.0).floor() * crate::fonts::PT_PER_CSS_PX
        } else {
            width / 3.0
        }
        .min(width / 2.0);
        Self { width, stripe }
    }

    pub(crate) const fn stripe_width(self) -> f32 {
        self.stripe
    }

    pub(crate) fn inner_inset(self) -> f32 {
        self.width - self.stripe
    }

    pub(crate) fn outer_centerline_inset(self) -> f32 {
        self.stripe * 0.5
    }

    pub(crate) fn inner_centerline_inset(self) -> f32 {
        self.inner_inset() + self.stripe * 0.5
    }

    pub(crate) fn centerline_insets(self) -> [f32; 2] {
        [self.outer_centerline_inset(), self.inner_centerline_inset()]
    }

    pub(crate) fn paints(self, offset: f32) -> bool {
        offset < self.stripe || offset >= self.inner_inset()
    }
}

const LIGHTENED_BLACK: f32 = 84.0 / 255.0;
const VALUE_STEP: f32 = 0.33;

fn to_legacy_3d_component(component: f32) -> f32 {
    (component.clamp(0.0, 1.0) * 255.999_98).floor() / 255.0
}

pub(crate) fn bevel_light_color((r, g, b): (f32, f32, f32)) -> (f32, f32, f32) {
    let value = r.max(g).max(b);
    if value == 0.0 {
        return (LIGHTENED_BLACK, LIGHTENED_BLACK, LIGHTENED_BLACK);
    }
    if r >= 150.0 / 255.0 || g >= 92.0 / 255.0 {
        return (r, g, b);
    }
    let multiplier = (value + VALUE_STEP).min(1.0) / value;
    (
        to_legacy_3d_component(r * multiplier),
        to_legacy_3d_component(g * multiplier),
        to_legacy_3d_component(b * multiplier),
    )
}

pub(crate) fn bevel_dark_color((r, g, b): (f32, f32, f32)) -> (f32, f32, f32) {
    let value = r.max(g).max(b);
    if value == 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let multiplier = (value - VALUE_STEP).max(0.0) / value;
    (
        to_legacy_3d_component(r * multiplier),
        to_legacy_3d_component(g * multiplier),
        to_legacy_3d_component(b * multiplier),
    )
}

pub(crate) fn is_bevel_style(style: BorderStyle) -> bool {
    matches!(
        style,
        BorderStyle::Groove | BorderStyle::Ridge | BorderStyle::Inset | BorderStyle::Outset
    )
}

pub(crate) fn bevel_edge_color(
    style: BorderStyle,
    side: PhysicalSide,
    inner_band: bool,
    base: (f32, f32, f32),
) -> (f32, f32, f32) {
    let high_edge = matches!(side, PhysicalSide::Top | PhysicalSide::Left);
    let light_on_high_edge = match style {
        BorderStyle::Outset => true,
        BorderStyle::Inset => false,
        BorderStyle::Ridge => !inner_band,
        BorderStyle::Groove => inner_band,
        _ => return base,
    };
    if high_edge == light_on_high_edge {
        bevel_light_color(base)
    } else {
        bevel_dark_color(base)
    }
}
