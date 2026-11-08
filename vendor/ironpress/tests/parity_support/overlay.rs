//! Classed-diff overlay rendering (spec §3.3 item 2 + §3.3 item 2 edge overlay).
//!
//! `render_classed_overlay` maps every unequal `PixelClass` to its original
//! full-page coordinate on a blank page-sized canvas. The committed `.diff.png`
//! therefore shows only WHAT differed and WHERE, without a crop, reference-page
//! content, or a registration step:
//!   Missing = magenta, Extra = green, ColorErr = blue.
//! Region diagnostics remain in the report tables rather than being painted into
//! the image: every non-white overlay pixel therefore corresponds to an actual
//! above-floor pixel at that exact page coordinate. The legend in the HTML report
//! (`report::render_legend`) maps the exact same colours back to classes.
//!
//! The colour table is the single source of truth: `class_rgb` is consumed both
//! here and by the HTML legend swatches, so the overlay and its legend can never
//! drift apart. No external deps.

use image::{Rgba, RgbaImage};

use super::compare::{ClassMap, PixelClass};

/// The overlay colour for a `PixelClass` (spec §3.3 item 2). The SINGLE source of
/// truth for both the rendered overlay and the HTML legend, so they stay in sync.
pub(crate) fn class_rgb(c: PixelClass) -> [u8; 3] {
    match c {
        // Faint grey for the legend-only Match swatch. Matching pixels are
        // deliberately absent from a diff image.
        PixelClass::Match => [245, 245, 245],
        // Blue: aligned recolour / wrong colour value (incl. colour-space drift).
        PixelClass::ColorErr => [40, 80, 255],
        // Magenta: reference paints, candidate is paper-white.
        PixelClass::Missing => [230, 0, 230],
        // Green: candidate paints where the reference is blank.
        PixelClass::Extra => [0, 200, 60],
    }
}

/// Human label for a `PixelClass`, for the legend (spec §3.3 item 3).
pub(crate) fn class_label(c: PixelClass) -> &'static str {
    c.as_str()
}

/// The legend rows, in the precedence order the classifier assigns them. Shared by
/// the overlay (it is exhaustive over `PixelClass`) and the HTML legend so both
/// describe the same palette.
pub(crate) const LEGEND_ORDER: [PixelClass; 4] = [
    PixelClass::Missing,
    PixelClass::Extra,
    PixelClass::ColorErr,
    PixelClass::Match,
];

/// Render the full-page classed diff overlay (spec §3.3 item 2).
///
/// `page_dimensions` is the original shared page canvas, not a crop.
/// `crop_origin` identifies the same-coordinate origin of `cm`: segmentation can
/// work on a compact union internally, but every visual artifact remains in
/// full-page coordinates. Matching pixels stay blank; unequal pixels use their
/// exact-class colour. No annotations, bounding boxes, or source content are
/// painted into the artifact.
pub(crate) fn render_classed_overlay(
    cm: &ClassMap,
    page_dimensions: (u32, u32),
    crop_origin: (u32, u32),
) -> RgbaImage {
    let (page_width, page_height) = page_dimensions;
    let mut out = RgbaImage::from_pixel(page_width, page_height, Rgba([255; 4]));

    // 1. Paint unequal crop pixels at their original page coordinates. `Match`
    // remains blank so a diff cannot be mistaken for a reference render.
    for y in 0..cm.h {
        for x in 0..cm.w {
            let c = cm.px[(y as usize) * (cm.w as usize) + x as usize];
            if c == PixelClass::Match {
                continue;
            }
            let Some(page_x) = crop_origin.0.checked_add(x) else {
                continue;
            };
            let Some(page_y) = crop_origin.1.checked_add(y) else {
                continue;
            };
            if page_x >= page_width || page_y >= page_height {
                continue;
            }
            let [r, g, b] = class_rgb(c);
            out.put_pixel(page_x, page_y, Rgba([r, g, b, 255]));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use image::{ImageBuffer, Rgba};

    use super::render_classed_overlay;
    use crate::parity_support::compare::{ClassMap, PixelClass};

    #[test]
    fn overlay_keeps_a_blank_full_page_and_places_crop_pixels_at_their_source_coordinates() {
        let mut reference = ImageBuffer::from_pixel(8, 6, Rgba([255, 255, 255, 255]));
        reference.put_pixel(0, 0, Rgba([12, 34, 56, 255]));
        let class_map = ClassMap {
            w: 2,
            h: 2,
            px: vec![
                PixelClass::Match,
                PixelClass::Missing,
                PixelClass::Extra,
                PixelClass::ColorErr,
            ],
        };

        let overlay = render_classed_overlay(&class_map, reference.dimensions(), (3, 2));

        assert_eq!(overlay.dimensions(), reference.dimensions());
        assert_eq!(overlay.get_pixel(0, 0).0, [255; 4]);
        assert_eq!(overlay.get_pixel(3, 2).0, [255; 4]);
        assert_eq!(overlay.get_pixel(4, 2).0, [230, 0, 230, 255]);
        assert_eq!(overlay.get_pixel(3, 3).0, [0, 200, 60, 255]);
        assert_eq!(overlay.get_pixel(4, 3).0, [40, 80, 255, 255]);
    }

    #[test]
    fn matching_pixels_never_gain_diagnostic_annotations() {
        let reference = ImageBuffer::from_pixel(7, 5, Rgba([255, 255, 255, 255]));
        let class_map = ClassMap {
            w: 1,
            h: 1,
            px: vec![PixelClass::Match],
        };
        let overlay = render_classed_overlay(&class_map, reference.dimensions(), (4, 2));

        assert!(overlay.pixels().all(|pixel| *pixel == Rgba([255; 4])));
    }
}
