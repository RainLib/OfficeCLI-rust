use super::*;

/// Paint a square solid fragment with an omitted physical edge.
///
/// CSS fragmentation leaves the omitted edge open. The remaining full-span
/// rectangles overlap at the corners instead of merely meeting at independently
/// antialiased endpoints. Opaque source paint uses the same full-span rectangle
/// decomposition as browser PDF output. Translucent source paint accumulates
/// the rectangles into one compound fill so their overlap is composited once.
pub(super) fn paint_open_square_solid_border(
    content: &mut String,
    border_box: PdfRect,
    border: &crate::layout::engine::LayoutBorder,
    radii: CornerRadii,
    page_ext_gstates: &mut Vec<(String, f32)>,
    alpha_counter: &mut usize,
) -> bool {
    if !radii.is_zero() || !border.has_open_edge() {
        return false;
    }
    let Some(color) = border.common_solid_color() else {
        return false;
    };
    let widths = border.widths();
    if widths.horizontal() > border_box.width || widths.vertical() > border_box.height {
        return false;
    }

    let bands =
        SquareBorderBandGeometry::between(border_box, EdgeSizes::ZERO, widths).full_span_sides();

    let alpha = begin_border_alpha(content, page_ext_gstates, alpha_counter, color.alpha());
    content.push_str(&PdfRgb::from(color).fill_operator());
    let compound_fill = !color.is_opaque();
    for edge in PhysicalSide::ALL {
        let band = *bands.get(edge);
        if border.get(edge).paints() && !band.is_empty() {
            content.push_str(&band.rect_path());
            if !compound_fill {
                content.push_str("f\n");
            }
        }
    }
    if compound_fill {
        content.push_str("f\n");
    }
    end_border_alpha(content, alpha);
    true
}

/// Paint a truly uniform frame as one visual region.
///
/// The geometry still comes from the canonical CSS border ring. Merging equal
/// sides avoids antialias seams at otherwise artificial side frontiers. Returns
/// `false` only for 3D styles whose light and dark physical edges differ.
pub(super) fn paint_uniform_border(
    content: &mut String,
    border_box: RoundedRect,
    side: crate::layout::engine::LayoutBorderSide,
    content_space: PdfContentSpace,
    page_ext_gstates: &mut Vec<(String, f32)>,
    alpha_counter: &mut usize,
) -> bool {
    if !side.paints() || is_bevel_style(side.style) {
        return false;
    }
    let border_box = RoundedRect::new(
        border_box.rect,
        border_box
            .radii
            .fit_to(border_box.rect.width, border_box.rect.height),
    );
    let alpha = begin_border_alpha(content, page_ext_gstates, alpha_counter, side.color.alpha());
    let color = PdfRgb::from(side.color);
    match side.style {
        BorderStyle::Solid => {
            if border_box.radii.is_circular() {
                paint_uniform_solid_border(content, border_box, side.width, color, content_space);
            } else {
                content.push_str(&color.fill_operator());
                paint_ring(
                    content,
                    BorderRingGeometry::new(
                        border_box.rect,
                        border_box.radii,
                        EdgeSizes::uniform(side.width),
                    ),
                );
            }
        }
        BorderStyle::Double => {
            paint_double_border(content, border_box, side.width, color);
        }
        BorderStyle::Dashed | BorderStyle::Dotted => {
            if border_box.radii.is_zero() {
                content.push_str(&color.fill_operator());
                paint_square_pattern(content, border_box.rect, side);
            } else {
                let widths = EdgeSizes::uniform(side.width);
                paint_closed_rounded_pattern(
                    content,
                    BorderRingGeometry::new(border_box.rect, border_box.radii, widths),
                    BorderStrokeGeometry::new(border_box.rect, border_box.radii, widths),
                    &side,
                );
            }
        }
        BorderStyle::None | BorderStyle::Hidden => {}
        BorderStyle::Groove | BorderStyle::Ridge | BorderStyle::Inset | BorderStyle::Outset => {
            end_border_alpha(content, alpha);
            return false;
        }
    }
    end_border_alpha(content, alpha);
    true
}

fn paint_uniform_solid_border(
    content: &mut String,
    border_box: RoundedRect,
    width: f32,
    color: PdfRgb,
    content_space: PdfContentSpace,
) {
    let centerline =
        BorderStrokeGeometry::new(border_box.rect, border_box.radii, EdgeSizes::uniform(width))
            .centerline;
    let serialization_space = if border_box.radii.is_zero() {
        content_space
    } else {
        PdfContentSpace::Points
    };
    if let Some(operator) = serialization_space.begin_operator() {
        content.push_str(&operator);
    }
    content.push_str(&color.stroke_operator());
    content.push_str("0 J\n0 j\n4 M\n");
    content.push_str(&format!("{} w\n", serialization_space.length(width)));
    if border_box.radii.is_zero() {
        content.push_str(&serialization_space.rect(centerline.rect).rect_path());
    } else {
        content.push_str(&centerline.path_or_rect());
    }
    content.push_str("S\n");
    if let Some(operator) = serialization_space.end_operator() {
        content.push_str(operator);
    }
}

fn paint_ring(content: &mut String, ring: BorderRingGeometry) {
    ring.push_path(content);
    content.push_str("f*\n");
}

fn paint_double_border(content: &mut String, border_box: RoundedRect, width: f32, color: PdfRgb) {
    let metrics = DoubleBorderMetrics::new(width);
    let rule = metrics.stripe_width();
    if border_box.radii.is_circular() {
        content.push_str(&color.stroke_operator());
        content.push_str("0 J\n0 j\n");
        content.push_str(&format!("{rule} w\n"));
        for inset in metrics.centerline_insets() {
            content.push_str(&border_box.inset(EdgeSizes::uniform(inset)).path_or_rect());
            content.push_str("S\n");
        }
        return;
    }

    let rule_edges = EdgeSizes::uniform(rule);
    let width_edges = EdgeSizes::uniform(width);
    content.push_str(&color.fill_operator());
    for ring in [
        BorderRingGeometry::between(
            border_box.rect,
            border_box.radii,
            EdgeSizes::ZERO,
            rule_edges,
        ),
        BorderRingGeometry::between(
            border_box.rect,
            border_box.radii,
            EdgeSizes::uniform(metrics.inner_inset()),
            width_edges,
        ),
    ] {
        paint_ring(content, ring);
    }
}

fn paint_square_pattern(
    content: &mut String,
    rect: PdfRect,
    side: crate::layout::engine::LayoutBorderSide,
) {
    if side.style == BorderStyle::Dashed {
        paint_square_dashes(content, rect, side.width);
    } else {
        paint_square_dots(content, rect, side.width);
    }
}

fn paint_square_dashes(content: &mut String, rect: PdfRect, width: f32) {
    let dash = (width * 2.0).max(1.0);
    let nominal_gap = width.max(1.0);
    let add_rect = |content: &mut String, rect: PdfRect| {
        if !rect.is_empty() {
            content.push_str(&rect.rect_path());
        }
    };
    let horizontal = |content: &mut String, y: f32| {
        let count = (((rect.width + nominal_gap) / (dash + nominal_gap)).round()).max(1.0) as usize;
        let gap = if count > 1 {
            ((rect.width - count as f32 * dash) / (count - 1) as f32).max(0.0)
        } else {
            0.0
        };
        for index in 0..count {
            let offset = index as f32 * (dash + gap);
            add_rect(
                content,
                PdfRect::new(rect.left + offset, y, dash.min(rect.width - offset), width),
            );
        }
    };
    let vertical = |content: &mut String, x: f32| {
        let count =
            (((rect.height + nominal_gap) / (dash + nominal_gap)).round()).max(1.0) as usize;
        let gap = if count > 1 {
            ((rect.height - count as f32 * dash) / (count - 1) as f32).max(0.0)
        } else {
            0.0
        };
        for index in 0..count {
            let offset = index as f32 * (dash + gap);
            add_rect(
                content,
                PdfRect::new(
                    x,
                    rect.top() - offset - dash,
                    width,
                    dash.min(rect.height - offset),
                ),
            );
        }
    };
    horizontal(content, rect.bottom);
    horizontal(content, rect.top() - width);
    vertical(content, rect.right() - width);
    vertical(content, rect.left);
    content.push_str("f\n");
}

fn paint_square_dots(content: &mut String, rect: PdfRect, width: f32) {
    let radius = width * 0.5;
    if radius <= 0.0 {
        return;
    }
    let horizontal_span = (rect.width - width).max(0.0);
    let vertical_span = (rect.height - width).max(0.0);
    let horizontal_intervals = (horizontal_span / (width * 2.0)).round().max(1.0) as usize;
    let vertical_intervals = (vertical_span / (width * 2.0)).round().max(1.0) as usize;
    for index in 0..=horizontal_intervals {
        let x = rect.left + radius + index as f32 * horizontal_span / horizontal_intervals as f32;
        for y in [rect.bottom + radius, rect.top() - radius] {
            PdfEllipse::circle(PdfPoint::new(x, y), radius).push_path(content);
        }
    }
    for index in 0..=vertical_intervals {
        let y = rect.top() - radius - index as f32 * vertical_span / vertical_intervals as f32;
        for x in [rect.left + radius, rect.right() - radius] {
            PdfEllipse::circle(PdfPoint::new(x, y), radius).push_path(content);
        }
    }
    content.push_str("f\n");
}

#[cfg(test)]
mod tests;
