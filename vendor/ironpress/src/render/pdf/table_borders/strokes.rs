use super::*;

#[allow(clippy::too_many_arguments)]
pub(in crate::render::pdf) fn paint_table_cell_border_line(
    content: &mut String,
    side: &crate::layout::engine::LayoutBorderSide,
    edge: PhysicalSide,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    page_ext_gstates: &mut Vec<(String, f32)>,
    bg_alpha_counter: &mut usize,
) {
    if !side.paints() {
        return;
    }
    if is_bevel_style(side.style) {
        paint_3d_border_line(
            content,
            side,
            edge,
            x1,
            y1,
            x2,
            y2,
            page_ext_gstates,
            bg_alpha_counter,
        );
        return;
    }
    let (r, g, b) = side.color.to_f32_rgb();
    let alpha = begin_border_alpha(
        content,
        page_ext_gstates,
        bg_alpha_counter,
        side.color.alpha(),
    );
    if side.style == BorderStyle::Solid {
        let (x, y, width, height) = match edge {
            PhysicalSide::Top | PhysicalSide::Bottom => (
                x1.min(x2),
                y1 - side.width / 2.0,
                (x2 - x1).abs(),
                side.width,
            ),
            PhysicalSide::Right | PhysicalSide::Left => (
                x1 - side.width / 2.0,
                y1.min(y2),
                side.width,
                (y2 - y1).abs(),
            ),
        };
        if width > 0.0 && height > 0.0 {
            content.push_str(&format!("{r} {g} {b} rg\n{x} {y} {width} {height} re\nf\n"));
        }
        end_border_alpha(content, alpha);
        return;
    }
    content.push_str(&format!("{r} {g} {b} rg\n"));
    match side.style {
        BorderStyle::Double => paint_double_border_areas(content, edge, x1, y1, x2, y2, side.width),
        BorderStyle::Dashed => paint_dashed_border_areas(content, edge, x1, y1, x2, y2, side.width),
        BorderStyle::Dotted => paint_dotted_border_areas(content, edge, x1, y1, x2, y2, side.width),
        _ => {
            content.push_str(&format!("{r} {g} {b} RG\n"));
            content.push_str(&format!("{} w\n{x1} {y1} m {x2} {y2} l S\n", side.width));
        }
    }
    end_border_alpha(content, alpha);
}

fn paint_double_border_areas(
    content: &mut String,
    edge: PhysicalSide,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    width: f32,
) {
    let metrics = DoubleBorderMetrics::new(width);
    let rule = metrics.stripe_width();
    let inner = metrics.inner_inset();
    match edge {
        PhysicalSide::Top | PhysicalSide::Bottom => {
            let left = x1.min(x2);
            let length = (x2 - x1).abs();
            let bottom = y1 - width / 2.0;
            content.push_str(&format!(
                "{left} {bottom} {length} {rule} re\n{left} {} {length} {rule} re\nf\n",
                bottom + inner,
            ));
        }
        PhysicalSide::Right | PhysicalSide::Left => {
            let bottom = y1.min(y2);
            let length = (y2 - y1).abs();
            let left = x1 - width / 2.0;
            content.push_str(&format!(
                "{left} {bottom} {rule} {length} re\n{} {bottom} {rule} {length} re\nf\n",
                left + inner,
            ));
        }
    }
}

fn paint_dashed_border_areas(
    content: &mut String,
    edge: PhysicalSide,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    width: f32,
) {
    let dash = (width * 2.0).max(1.0);
    let gap = (width * (2.0 / 3.0)).max(1.0);
    let horizontal = matches!(edge, PhysicalSide::Top | PhysicalSide::Bottom);
    let length = if horizontal {
        (x2 - x1).abs()
    } else {
        (y2 - y1).abs()
    };
    let mut offset = 0.0;
    while offset < length {
        let segment = dash.min(length - offset);
        if horizontal {
            let start = if x2 >= x1 {
                x1 + offset
            } else {
                x1 - offset - segment
            };
            content.push_str(&format!(
                "{start} {} {segment} {width} re\n",
                y1 - width / 2.0,
            ));
        } else {
            let start = if y2 >= y1 {
                y1 + offset
            } else {
                y1 - offset - segment
            };
            content.push_str(&format!(
                "{} {start} {width} {segment} re\n",
                x1 - width / 2.0,
            ));
        }
        offset += dash + gap;
    }
    content.push_str("f\n");
}

fn paint_dotted_border_areas(
    content: &mut String,
    edge: PhysicalSide,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    width: f32,
) {
    let horizontal = matches!(edge, PhysicalSide::Top | PhysicalSide::Bottom);
    let length = if horizontal {
        (x2 - x1).abs()
    } else {
        (y2 - y1).abs()
    };
    let direction = if horizontal {
        (x2 - x1).signum()
    } else {
        (y2 - y1).signum()
    };
    let step = width * 2.0;
    let mut offset = 0.0;
    while offset <= length + 0.001 {
        let center = if horizontal {
            PdfPoint::new(x1 + direction * offset, y1)
        } else {
            PdfPoint::new(x1, y1 + direction * offset)
        };
        PdfEllipse::circle(center, width / 2.0).push_path(content);
        offset += step;
    }
    content.push_str("f\n");
}

#[allow(clippy::too_many_arguments)]
pub(in crate::render::pdf) fn paint_3d_border_line(
    content: &mut String,
    side: &crate::layout::engine::LayoutBorderSide,
    edge: PhysicalSide,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    page_ext_gstates: &mut Vec<(String, f32)>,
    bg_alpha_counter: &mut usize,
) {
    let alpha = begin_border_alpha(
        content,
        page_ext_gstates,
        bg_alpha_counter,
        side.color.alpha(),
    );
    let mut stroke = |inner_band: bool, width: f32, offset: f32| {
        let (nx, ny) = match edge {
            PhysicalSide::Top => (0.0, 1.0),
            PhysicalSide::Right => (1.0, 0.0),
            PhysicalSide::Bottom => (0.0, -1.0),
            PhysicalSide::Left => (-1.0, 0.0),
        };
        let (r, g, b) = bevel_edge_color(side.style, edge, inner_band, side.color.to_f32_rgb());
        content.push_str(&format!(
            "{r} {g} {b} RG\n{width} w\n{} {} m {} {} l S\n",
            x1 + nx * offset,
            y1 + ny * offset,
            x2 + nx * offset,
            y2 + ny * offset,
        ));
    };
    if matches!(side.style, BorderStyle::Groove | BorderStyle::Ridge) {
        let half = side.width / 2.0;
        let quarter = side.width / 4.0;
        stroke(false, half, quarter);
        stroke(true, half, -quarter);
    } else {
        stroke(false, side.width, 0.0);
    }
    end_border_alpha(content, alpha);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::LayoutBorderSide;

    #[test]
    fn solid_border_line_uses_a_filled_coverage_band() {
        let side = LayoutBorderSide {
            width: 2.0,
            style: BorderStyle::Solid,
            color: crate::types::Color::BLACK,
            ..Default::default()
        };
        let mut content = String::new();
        let mut states = Vec::new();
        let mut counter = 0;

        paint_table_cell_border_line(
            &mut content,
            &side,
            PhysicalSide::Left,
            10.0,
            30.0,
            10.0,
            5.0,
            &mut states,
            &mut counter,
        );

        assert!(content.contains("0 0 0 rg\n9 5 2 25 re\nf\n"));
        assert!(!content.contains(" S\n"));
    }

    #[test]
    fn double_border_divides_integral_css_widths_in_css_pixels() {
        assert_eq!(DoubleBorderMetrics::new(6.0).stripe_width(), 2.25);
        assert_eq!(DoubleBorderMetrics::new(7.5).inner_inset(), 5.25);
    }

    #[test]
    fn dashed_border_uses_explicit_filled_segments() {
        let mut content = String::new();

        paint_dashed_border_areas(&mut content, PhysicalSide::Left, 10.0, 0.0, 10.0, 60.0, 6.0);

        assert!(content.starts_with("7 0 6 12 re\n"));
        assert!(content.contains("7 16 6 12 re\n"));
        assert!(content.ends_with("f\n"));
        assert!(!content.contains(" S\n"));
    }

    #[test]
    fn dotted_border_uses_explicit_circle_paths() {
        let mut content = String::new();

        paint_dotted_border_areas(&mut content, PhysicalSide::Top, 0.0, 10.0, 24.0, 10.0, 6.0);

        assert_eq!(content.matches("h\n").count(), 3);
        assert!(content.ends_with("f\n"));
        assert!(!content.contains(" S\n"));
    }
}
