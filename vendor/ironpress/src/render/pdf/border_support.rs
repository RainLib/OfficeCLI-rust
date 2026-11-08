use super::*;

/// Compute a corner-symmetric dash array and phase for one straight side.
pub(super) fn corner_dash_array(length: f32, border_width: f32, dotted: bool) -> (String, f32) {
    let length = length.max(0.0);
    if length <= 0.0 || border_width <= 0.0 {
        return (format!("{border_width}"), 0.0);
    }
    let (on, gap) = if dotted {
        (border_width, border_width)
    } else {
        ((border_width * 2.0).max(1.0), border_width.max(1.0))
    };
    let period = on + gap;
    if dotted {
        let count = (length / period).round().max(1.0);
        return (format!("0 {}", length / count), 0.0);
    }
    let count = (((length + gap) / period).round()).max(1.0);
    let adjusted_on = on.min(length);
    let adjusted_gap = if count > 1.0 {
        ((length - count * adjusted_on) / (count - 1.0)).max(0.1)
    } else {
        (length - adjusted_on).max(0.1)
    };
    (format!("{adjusted_on} {adjusted_gap}"), 0.0)
}

/// Chromium-compatible cadence for one closed rounded border centerline.
///
/// Patterned sides all stroke the same closed path and are clipped to their
/// exclusive side regions. The dash effect therefore has one zero-phase
/// cadence around the complete box; trying to recenter it independently at a
/// corner moves every later dash and is observably wrong. Blink quantizes the
/// path length and border thickness to CSS pixels before selecting the closest
/// whole-path gap, so do that once here as part of the paint contract.
pub(super) fn closed_border_pattern_for_style(
    style: BorderStyle,
    width: f32,
    path_length: f32,
) -> String {
    let css_pixel = crate::fonts::PT_PER_CSS_PX;
    let width = ((width / css_pixel).round().max(1.0)) * css_pixel;
    let path_length = ((path_length / css_pixel).trunc().max(0.0)) * css_pixel;
    if path_length <= 0.0 {
        return String::new();
    }

    match style {
        BorderStyle::Dashed => {
            let ratio = if width / css_pixel >= 3.0 { 2.0 } else { 3.0 };
            let gap_ratio = if width / css_pixel >= 3.0 { 1.0 } else { 2.0 };
            let dash = width * ratio;
            let nominal_gap = width * gap_ratio;
            if path_length <= 2.0 * dash {
                return String::new();
            }
            let two_dashes_and_gaps = 2.0 * (dash + nominal_gap);
            let (dash, gap) = if path_length <= two_dashes_and_gaps {
                let scale = path_length / two_dashes_and_gaps;
                (dash * scale, nominal_gap * scale)
            } else {
                (dash, best_closed_path_gap(path_length, dash, nominal_gap))
            };
            format!("[{dash} {gap}] 0 d\n")
        }
        BorderStyle::Dotted => {
            let nominal = width;
            let gap = best_closed_path_gap(path_length, nominal, nominal);
            // Blink subtracts 0.01 CSS px so floating-point traversal cannot
            // drop the closing dot when it lies exactly at the path endpoint.
            let interval = (gap + width - 0.01 * css_pixel).max(0.0);
            format!("1 J\n[0 {interval}] 0 d\n")
        }
        _ => String::new(),
    }
}

fn best_closed_path_gap(path_length: f32, dash: f32, nominal_gap: f32) -> f32 {
    let minimum_count = (path_length / (dash + nominal_gap)).floor().max(1.0);
    let maximum_count = minimum_count + 1.0;
    let minimum_gap = (path_length - minimum_count * dash) / minimum_count;
    let maximum_gap = (path_length - maximum_count * dash) / maximum_count;
    if maximum_gap <= 0.0 || (minimum_gap - nominal_gap).abs() < (maximum_gap - nominal_gap).abs() {
        minimum_gap.max(0.0)
    } else {
        maximum_gap
    }
}

/// Reset the dash pattern (and line cap) back to solid/butt after a
/// dashed/dotted stroke so subsequent strokes are unaffected.
pub(super) fn reset_dash_pattern(style: BorderStyle) -> &'static str {
    match style {
        BorderStyle::Dashed => "[] 0 d\n",
        BorderStyle::Dotted => "[] 0 d\n0 J\n",
        _ => "",
    }
}

/// Apply a stroke-opacity ExtGState before painting a border side whose color is
/// translucent (`alpha < 1.0`). Mirrors the background-color alpha path: pushes a
/// `(name, alpha)` entry onto `page_ext_gstates` and emits `/{name} gs`. Returns
/// `true` when a non-default gstate was applied so the caller can reset it with
/// [`end_border_alpha`]. For opaque sides (`alpha >= 1.0`) nothing is emitted, so
/// existing output stays byte-identical.
pub(super) fn begin_border_alpha(
    content: &mut String,
    page_ext_gstates: &mut Vec<(String, f32)>,
    counter: &mut usize,
    alpha: f32,
) -> bool {
    if alpha < 1.0 {
        let gs_name = format!("GSbd{counter}");
        *counter += 1;
        page_ext_gstates.push((gs_name.clone(), alpha));
        content.push_str(&format!("/{gs_name} gs\n"));
        true
    } else {
        false
    }
}

/// Reset stroke opacity to the default gstate after a translucent border side.
/// No-op when `applied` is false.
pub(super) fn end_border_alpha(content: &mut String, applied: bool) {
    if applied {
        content.push_str("/GSDefault gs\n");
    }
}
