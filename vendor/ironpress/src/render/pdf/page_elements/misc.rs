use super::*;
use crate::layout::elements::{MathBlock, ProgressBar};

/// Paint the fixed UA representation of an `<hr>` at its block-start edge.
pub(in crate::render::pdf) fn paint_horizontal_rule(
    content: &mut String,
    origin: PdfPoint,
    width: f32,
) {
    content.push_str(&format!(
        "0.5 w\n0 0 0 RG\n{x1} {y} m {x2} {y} l\nS\n",
        x1 = origin.x,
        y = origin.y,
        x2 = origin.x + width,
    ));
}

/// Paint a progress/meter box at an already-resolved border-box rectangle.
pub(in crate::render::pdf) fn paint_progress_bar(
    content: &mut String,
    element: &ProgressBar,
    rect: PdfRect,
) {
    let (track_r, track_g, track_b) = element.colors.track.to_f32_rgb();
    content.push_str(&format!(
        "{track_r} {track_g} {track_b} rg\n{}f\n",
        rect.rect_path(),
    ));
    if element.fraction > 0.0 {
        let (fill_r, fill_g, fill_b) = element.colors.fill.to_f32_rgb();
        let fill = PdfRect::new(
            rect.left,
            rect.bottom,
            rect.width * element.fraction,
            rect.height,
        );
        content.push_str(&format!(
            "{fill_r} {fill_g} {fill_b} rg\n{}f\n",
            fill.rect_path(),
        ));
    }
    content.push_str(&format!("0.5 w\n0.6 0.6 0.6 RG\n{}S\n", rect.rect_path(),));
}

/// Paint a math block from a block-start origin shared by page and child flow.
pub(in crate::render::pdf) fn paint_math_block(
    content: &mut String,
    element: &MathBlock,
    origin: PdfPoint,
    available_width: f32,
) {
    let x = if element.display {
        origin.x + (available_width - element.layout.width) / 2.0
    } else {
        origin.x
    };
    render_math_glyphs(
        &element.layout.glyphs,
        x,
        origin.y - element.layout.ascent,
        content,
    );
}
