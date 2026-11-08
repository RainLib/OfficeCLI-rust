use super::*;

#[derive(Debug, Clone, Copy)]
enum ScrollbarAxis {
    Horizontal,
    Vertical,
}

impl ScrollbarAxis {
    fn thumb_insets(self, inset: f32) -> EdgeSizes {
        match self {
            Self::Horizontal => EdgeSizes::axes(0.0, inset),
            Self::Vertical => EdgeSizes::axes(inset, 0.0),
        }
    }
}

/// Default UA scrollbar thickness, in PDF points (Chrome's classic scrollbar is
/// 15 CSS px wide; 1 px = 0.75 pt).
pub(in crate::render::pdf) const SCROLLBAR_THICKNESS_PT: f32 = 15.0 * 0.75;

/// Paint a non-interactive UA scrollbar matching Chrome's print rendering for a
/// scroll container (`overflow: scroll`, or `auto` with overflow). The padding
/// box is `(px, py)` bottom-left, size `pw`x`ph` (PDF bottom-up coordinates).
/// The overflow ratios size each thumb while keeping the initial scroll
/// position at the leading edge.
#[allow(clippy::too_many_arguments)]
pub(in crate::render::pdf) fn paint_scrollbars(
    content: &mut String,
    px: f32,
    py: f32,
    pw: f32,
    ph: f32,
    has_v: bool,
    has_h: bool,
    over_v: f32,
    over_h: f32,
) {
    let thickness = SCROLLBAR_THICKNESS_PT;
    if (!has_v && !has_h) || pw <= thickness || ph <= thickness {
        return;
    }
    let track = "0.9882 0.9882 0.9882";
    let thumb = "0.5451 0.5451 0.5451";
    let vertical_gutter = if has_v { thickness } else { 0.0 };
    let horizontal_gutter = if has_h { thickness } else { 0.0 };

    if has_v && has_h {
        content.push_str(&format!(
            "{track} rg\n{} {} {thickness} {thickness} re\nf\n",
            px + pw - thickness,
            py,
        ));
    }

    if has_v {
        paint_vertical_scrollbar(
            content,
            PdfRect::new(
                px + pw - thickness,
                py + horizontal_gutter,
                thickness,
                ph - horizontal_gutter,
            ),
            over_v,
            track,
            thumb,
        );
    }
    if has_h {
        paint_horizontal_scrollbar(
            content,
            PdfRect::new(px, py, pw - vertical_gutter, thickness),
            over_h,
            track,
            thumb,
        );
    }
}

fn paint_vertical_scrollbar(
    content: &mut String,
    bounds: PdfRect,
    overflow_ratio: f32,
    track: &str,
    thumb: &str,
) {
    let thickness = bounds.width;
    content.push_str(&format!(
        "{track} rg\n{} {} {} {} re\nf\n",
        bounds.left, bounds.bottom, bounds.width, bounds.height
    ));
    let button = thickness.min(bounds.height / 2.0);
    let center_x = bounds.left + thickness / 2.0;
    let arrow = button * 0.28;
    let top_center = bounds.top() - button / 2.0;
    let bottom_center = bounds.bottom + button / 2.0;
    content.push_str(&format!("{thumb} rg\n"));
    content.push_str(&format!(
        "{center_x} {} m {} {} l {} {} l f\n",
        top_center + arrow,
        center_x - arrow,
        top_center - arrow,
        center_x + arrow,
        top_center - arrow
    ));
    content.push_str(&format!(
        "{center_x} {} m {} {} l {} {} l f\n",
        bottom_center - arrow,
        center_x - arrow,
        bottom_center + arrow,
        center_x + arrow,
        bottom_center + arrow
    ));

    let gap = thickness * 0.22;
    let track_extent = (bounds.height - 2.0 * button - 2.0 * gap).max(0.0);
    if track_extent <= 0.0 {
        return;
    }
    let thumb_extent = (track_extent * thumb_fraction(overflow_ratio)).max(thickness * 0.5);
    let thumb_top = bounds.top() - button - gap;
    let thumb_bottom = (thumb_top - thumb_extent).max(bounds.bottom + button + gap);
    paint_scrollbar_thumb(
        content,
        PdfRect::new(
            bounds.left,
            thumb_bottom,
            thickness,
            thumb_top - thumb_bottom,
        ),
        ScrollbarAxis::Vertical,
        thickness,
    );
}

fn paint_horizontal_scrollbar(
    content: &mut String,
    bounds: PdfRect,
    overflow_ratio: f32,
    track: &str,
    thumb: &str,
) {
    let thickness = bounds.height;
    content.push_str(&format!(
        "{track} rg\n{} {} {} {} re\nf\n",
        bounds.left, bounds.bottom, bounds.width, bounds.height
    ));
    let button = thickness.min(bounds.width / 2.0);
    let center_y = bounds.bottom + thickness / 2.0;
    let arrow = button * 0.18;
    let left_center = bounds.left + button / 2.0;
    let right_center = bounds.right() - button * 0.55;
    content.push_str(&format!("{thumb} rg\n"));
    content.push_str(&format!(
        "{} {center_y} m {} {} l {} {} l f\n",
        left_center - arrow,
        left_center + arrow,
        center_y + arrow,
        left_center + arrow,
        center_y - arrow
    ));
    content.push_str(&format!(
        "{} {center_y} m {} {} l {} {} l f\n",
        right_center + arrow,
        right_center - arrow,
        center_y + arrow,
        right_center - arrow,
        center_y - arrow
    ));

    let gap = thickness * 0.22;
    let track_extent = (bounds.width - 2.0 * button - 2.0 * gap).max(0.0);
    if track_extent <= 0.0 {
        return;
    }
    let thumb_extent = (track_extent * thumb_fraction(overflow_ratio)).max(thickness * 0.5);
    let thumb_left = bounds.left + button + gap;
    let thumb_right = (thumb_left + thumb_extent).min(bounds.right() - button);
    paint_scrollbar_thumb(
        content,
        PdfRect::new(
            thumb_left,
            bounds.bottom,
            thumb_right - thumb_left,
            thickness,
        ),
        ScrollbarAxis::Horizontal,
        thickness,
    );
}

fn thumb_fraction(overflow_ratio: f32) -> f32 {
    (1.0 / overflow_ratio.max(1.0)).clamp(0.12, 1.0)
}

fn paint_scrollbar_thumb(
    content: &mut String,
    bounds: PdfRect,
    axis: ScrollbarAxis,
    thickness: f32,
) {
    let inset = thickness * 0.18;
    let radii = CornerRadii::circular((thickness / 2.0 - inset).max(0.0));
    content.push_str(
        &bounds
            .inset(axis.thumb_insets(inset))
            .rounded(radii)
            .path_or_rect(),
    );
    content.push_str("f\n");
}
