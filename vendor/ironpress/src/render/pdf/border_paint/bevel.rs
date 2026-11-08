use super::*;

/// Paint a uniform 3D frame with the canonical ring partition while merging
/// the equal-colour top/left and bottom/right regions into single fill
/// operations. The merged paths have no internal antialias seam and still do
/// not repaint either side of the diagonal frontier.
pub(super) fn paint_uniform_exclusive_bevel(
    content: &mut String,
    side: &crate::layout::engine::LayoutBorderSide,
    ring: BorderRingGeometry,
    outer_half: BorderRingGeometry,
    inner_half: BorderRingGeometry,
    page_ext_gstates: &mut Vec<(String, f32)>,
    bg_alpha_counter: &mut usize,
) {
    let alpha = begin_border_alpha(
        content,
        page_ext_gstates,
        bg_alpha_counter,
        side.color.alpha(),
    );
    let base = side.color.to_f32_rgb();
    if matches!(side.style, BorderStyle::Groove | BorderStyle::Ridge) {
        paint_uniform_bevel_band(content, outer_half, side.style, false, base);
        paint_uniform_bevel_band(content, inner_half, side.style, true, base);
    } else {
        paint_uniform_bevel_band(content, ring, side.style, false, base);
    }
    end_border_alpha(content, alpha);
}

pub(super) fn paint_uniform_square_bevel(
    content: &mut String,
    side: &crate::layout::engine::LayoutBorderSide,
    border_box: PdfRect,
    widths: EdgeSizes,
    content_space: PdfContentSpace,
    page_ext_gstates: &mut Vec<(String, f32)>,
    bg_alpha_counter: &mut usize,
) {
    let alpha = begin_border_alpha(
        content,
        page_ext_gstates,
        bg_alpha_counter,
        side.color.alpha(),
    );
    let base = side.color.to_f32_rgb();
    if matches!(side.style, BorderStyle::Groove | BorderStyle::Ridge) {
        let half_widths = widths * 0.5;
        paint_uniform_square_bevel_band(
            content,
            SquareBorderBandGeometry::between(border_box, EdgeSizes::ZERO, half_widths),
            side.style,
            false,
            base,
            content_space,
        );
        paint_uniform_square_bevel_band(
            content,
            SquareBorderBandGeometry::between(border_box, half_widths, widths),
            side.style,
            true,
            base,
            content_space,
        );
    } else {
        paint_uniform_square_bevel_band(
            content,
            SquareBorderBandGeometry::between(border_box, EdgeSizes::ZERO, widths),
            side.style,
            false,
            base,
            content_space,
        );
    }
    end_border_alpha(content, alpha);
}

fn paint_uniform_square_bevel_band(
    content: &mut String,
    band: SquareBorderBandGeometry,
    style: BorderStyle,
    inner_band: bool,
    base: (f32, f32, f32),
    content_space: PdfContentSpace,
) {
    if let Some(operator) = content_space.begin_operator() {
        content.push_str(&operator);
    }
    for (edge, region) in [
        (PhysicalSide::Top, band.top()),
        (PhysicalSide::Bottom, band.bottom()),
    ] {
        let color = bevel_edge_color(style, edge, inner_band, base);
        content.push_str(&PdfRgb::from(color).fill_operator());
        content.push_str(&content_space.rect(region).rect_path());
        content.push_str("f\n");
    }
    for (edge, region) in [
        (PhysicalSide::Right, band.right()),
        (PhysicalSide::Left, band.left()),
    ] {
        let color = bevel_edge_color(style, edge, inner_band, base);
        content.push_str(&PdfRgb::from(color).fill_operator());
        region.push_path_in(content, content_space);
        content.push_str("f\n");
    }
    if let Some(operator) = content_space.end_operator() {
        content.push_str(operator);
    }
}

fn paint_uniform_bevel_band(
    content: &mut String,
    band: BorderRingGeometry,
    style: BorderStyle,
    inner_band: bool,
    base: (f32, f32, f32),
) {
    content.push_str("q\n");
    band.push_clip(content);
    for (color, edges) in [
        (
            bevel_edge_color(style, PhysicalSide::Top, inner_band, base),
            [PhysicalSide::Top, PhysicalSide::Left],
        ),
        (
            bevel_edge_color(style, PhysicalSide::Bottom, inner_band, base),
            [PhysicalSide::Right, PhysicalSide::Bottom],
        ),
    ] {
        content.push_str(&PdfRgb::from(color).fill_operator());
        for edge in edges {
            band.side_region(edge).push_path(content);
        }
        content.push_str("f\n");
    }
    content.push_str("Q\n");
}
