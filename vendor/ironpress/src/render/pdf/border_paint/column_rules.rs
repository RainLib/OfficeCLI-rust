use super::*;

/// Paint a multi-column `column-rule` as one vertical rule honoring the CSS
/// border style. Solid rules are filled; dashed and dotted rules share the box
/// border pattern; double rules retain a hollow middle third.
#[allow(clippy::too_many_arguments)]
pub(in crate::render::pdf) fn paint_column_rule_line(
    content: &mut String,
    x: f32,
    top_y: f32,
    width: f32,
    height: f32,
    side: &crate::layout::engine::LayoutBorderSide,
    page_ext_gstates: &mut Vec<(String, f32)>,
    alpha_counter: &mut usize,
) {
    if width <= 0.0 || height <= 0.0 || !side.style.paints() {
        return;
    }
    let bottom_y = top_y - height;
    if is_bevel_style(side.style) {
        let center_x = x + width / 2.0;
        paint_3d_border_line(
            content,
            side,
            PhysicalSide::Left,
            center_x,
            top_y,
            center_x,
            bottom_y,
            page_ext_gstates,
            alpha_counter,
        );
        return;
    }
    let (r, g, b) = side.color.to_f32_rgb();
    let alpha = begin_border_alpha(content, page_ext_gstates, alpha_counter, side.color.alpha());
    if side.style == BorderStyle::Solid {
        content.push_str(&format!(
            "{r} {g} {b} rg\n{x} {bottom_y} {width} {height} re\nf\n"
        ));
        end_border_alpha(content, alpha);
        return;
    }
    content.push_str(&format!("{r} {g} {b} RG\n"));
    if side.style == BorderStyle::Double {
        let third = width / 3.0;
        let left = x + third / 2.0;
        let right = x + width - third / 2.0;
        content.push_str(&format!("{third} w\n"));
        content.push_str(&format!("{left} {top_y} m {left} {bottom_y} l S\n"));
        content.push_str(&format!("{right} {top_y} m {right} {bottom_y} l S\n"));
    } else {
        paint_patterned_column_rule(content, x, top_y, bottom_y, width, height, side.style);
    }
    end_border_alpha(content, alpha);
}

fn paint_patterned_column_rule(
    content: &mut String,
    x: f32,
    top_y: f32,
    bottom_y: f32,
    width: f32,
    height: f32,
    style: BorderStyle,
) {
    let center_x = x + width / 2.0;
    let dotted = style == BorderStyle::Dotted;
    let (array, phase, cap, segment_top, segment_bottom) = if dotted {
        let half = width / 2.0;
        let (array, phase) = corner_dash_array((height - width).max(0.0), width, true);
        (array, phase, "1 J\n", top_y - half, bottom_y + half)
    } else {
        let (array, phase) = corner_dash_array(height, width, false);
        (array, phase, "0 J\n", top_y, bottom_y)
    };
    content.push_str(cap);
    content.push_str(&format!("{width} w\n[{array}] {phase} d\n"));
    content.push_str(&format!(
        "{center_x} {segment_top} m {center_x} {segment_bottom} l S\n"
    ));
    content.push_str("[] 0 d\n0 J\n");
}
