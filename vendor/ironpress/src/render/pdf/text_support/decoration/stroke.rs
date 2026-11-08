use super::*;

pub(in crate::render::pdf) use crate::render::text_decoration::DecorationLine;
pub(in crate::render::pdf) use crate::render::text_decoration::thickness as decoration_thickness;

pub(in crate::render::pdf) fn underline_center_y(
    run: &TextRun,
    decoration: &crate::style::computed::TextDecoration,
    baseline_y: f32,
) -> f32 {
    // `text-underline-offset` is measured from the underline-position zero
    // point. For the supported horizontal `auto` position that point is the
    // alphabetic baseline; the line thickness extends outward from there.
    // Blink's automatic near-edge gap is half the resolved stroke width,
    // rounded outward to its CSS-pixel grid. An authored length (including
    // zero or a negative length) remains exact.
    baseline_y - crate::render::text_decoration::underline_distance_from_baseline(run, decoration)
}

pub(in crate::render::pdf) fn decoration_is_wavy(
    decoration: &crate::style::computed::TextDecoration,
) -> bool {
    decoration.style == crate::style::computed::TextDecorationStyle::Wavy
}

impl DecorationLine {
    fn wavy_axis_offset(self, thickness: f32) -> f32 {
        let offset = thickness + crate::fonts::PT_PER_CSS_PX;
        match self {
            // PDF coordinates increase upward, the inverse of CSS's block
            // direction. Wavy underlines need one decoration gap below their
            // solid-line axis, and overlines need the symmetric adjustment.
            Self::Underline => -offset,
            Self::LineThrough => 0.0,
            Self::Overline => offset,
        }
    }
}

/// Blink-compatible dimensions for a wavy text decoration. Its geometry is
/// based on the resolved decoration thickness, with a two-CSS-pixel minimum,
/// rather than the surrounding font size.
#[derive(Clone, Copy)]
struct WavyDecorationMetrics {
    step: f32,
    control_distance: f32,
}

impl WavyDecorationMetrics {
    fn from_thickness(thickness: f32) -> Self {
        let unit = thickness.max(2.0 * crate::fonts::PT_PER_CSS_PX);
        Self {
            step: unit * 2.5,
            control_distance: unit * 3.5,
        }
    }
}

#[derive(Clone, Copy)]
pub(in crate::render::pdf) struct DecorationStroke {
    pub(in crate::render::pdf) color: PdfRgb,
    pub(in crate::render::pdf) line: DecorationLine,
    pub(in crate::render::pdf) span: crate::render::text_decoration::InlineInterval,
    pub(in crate::render::pdf) axis_y: f32,
    pub(in crate::render::pdf) axis_from_baseline: f32,
}

impl DecorationStroke {
    pub(in crate::render::pdf) fn new(
        color: (f32, f32, f32),
        line: DecorationLine,
        start: f32,
        end: f32,
        axis_y: f32,
        axis_from_baseline: f32,
    ) -> Self {
        Self {
            color: PdfRgb::from(color),
            line,
            span: crate::render::text_decoration::InlineInterval::new(start, end),
            axis_y,
            axis_from_baseline,
        }
    }
}

pub(in crate::render::pdf) fn push_decoration_stroke(
    content: &mut String,
    run: &TextRun,
    decoration: &crate::style::computed::TextDecoration,
    stroke: DecorationStroke,
) {
    let thickness = decoration_thickness(run, decoration);
    if stroke.span.end <= stroke.span.start {
        return;
    }
    if !decoration_is_wavy(decoration) {
        let rect = PdfRect::new(
            stroke.span.start,
            stroke.axis_y - thickness / 2.0,
            stroke.span.end - stroke.span.start,
            thickness,
        );
        content.push_str(&stroke.color.fill_operator());
        content.push_str(&rect.rect_path());
        content.push_str("f\n");
        return;
    }

    let stroke_width = thickness;
    let metrics = WavyDecorationMetrics::from_thickness(stroke_width);
    let axis_y = stroke.axis_y + stroke.line.wavy_axis_offset(stroke_width);
    let clip_y = axis_y - metrics.control_distance - stroke_width * 2.0;
    let clip_h = (metrics.control_distance + stroke_width * 2.0) * 2.0;
    let mut x = stroke.span.start - 2.0 * metrics.step;
    let end_x = stroke.span.end + 4.0 * metrics.step;
    let mut path = format!("{x} {axis_y} m\n");
    while x + 2.0 * metrics.step <= end_x {
        let cx = x + metrics.step;
        x += 2.0 * metrics.step;
        path.push_str(&format!(
            "{cx} {} {cx} {} {x} {axis_y} c\n",
            axis_y - metrics.control_distance,
            axis_y + metrics.control_distance
        ));
    }
    content.push_str(&format!(
        "q\n{} {clip_y} {} {clip_h} re\nW\nn\n",
        stroke.span.start,
        stroke.span.end - stroke.span.start
    ));
    content.push_str(&stroke.color.stroke_operator());
    content.push_str(&format!("{stroke_width} w\n0 J\n1 j\n{path}S\nQ\n"));
}
