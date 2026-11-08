//! Per-pixel classification from same-coordinate facts only. Every non-identical
//! pixel is `Missing`, `Extra`, or `ColorErr`; no nearby-pixel search can relabel
//! it as a displacement.
//!
//! Both PDFs are rasterized by the same `pdftoppm` pipeline. Raw classification
//! therefore remains byte-exact. A separate visibility map may treat the
//! configured sub-1% per-channel residue as semantically equal; it never
//! changes this raw evidence.

use image::RgbaImage;

use super::super::config::{VISUAL_COLOR_CHANNEL_TOLERANCE, VISUAL_COLOR_JND};
use super::super::geom::Mask;
use super::color::{ciede2000, srgb_to_lab};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PixelClass {
    /// The candidate and reference pixels are byte-identical.
    Match,
    /// Both sides paint here, but their appearance differs.
    ColorErr,
    /// Reference paints, candidate is paper-white.
    Missing,
    /// Candidate paints, reference is paper-white.
    Extra,
}

impl PixelClass {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Match => "Match",
            Self::ColorErr => "ColorErr",
            Self::Missing => "Missing",
            Self::Extra => "Extra",
        }
    }
}

/// A per-pixel class grid over the union-cropped frame (row-major).
pub(crate) struct ClassMap {
    pub(crate) w: u32,
    pub(crate) h: u32,
    pub(crate) px: Vec<PixelClass>,
}

/// Classify every pixel in the aligned candidate/reference frame.
pub(crate) fn classify_pixels(
    cand: &RgbaImage,
    reference: &RgbaImage,
    mask_c: &Mask,
    mask_r: &Mask,
) -> ClassMap {
    let (w, h) = cand.dimensions();
    let mut px = Vec::with_capacity((w as usize) * (h as usize));

    for y in 0..h {
        for x in 0..w {
            let c = cand.get_pixel(x, y);
            let r = reference.get_pixel(x, y);
            let ink_c = mask_c.get(x, y);
            let ink_r = mask_r.get(x, y);

            let class = if c == r {
                PixelClass::Match
            } else if ciede2000(
                srgb_to_lab([c[0], c[1], c[2]]),
                srgb_to_lab([r[0], r[1], r[2]]),
            ) <= VISUAL_COLOR_JND
            {
                // A paper/content-mask boundary does not make a presence
                // defect when the pixels themselves differ below one JND.
                // Keep the exact raw mismatch as ColorErr; the verdict's
                // colour rule will decide its visibility consistently.
                PixelClass::ColorErr
            } else if ink_r && !ink_c {
                PixelClass::Missing
            } else if ink_c && !ink_r {
                PixelClass::Extra
            } else {
                PixelClass::ColorErr
            };
            px.push(class);
        }
    }

    ClassMap { w, h, px }
}

/// Derive the colour-only visibility map from the byte-exact classification.
///
/// Presence evidence is unchanged. Only a `ColorErr` whose every RGB channel
/// is within the global 1% tolerance becomes a semantic `Match`, so tolerated
/// fill rounding cannot break the topology of a nearby visible edge. The raw
/// map remains authoritative for exact counts, overlays, and reports.
pub(crate) fn classify_visible_colors(
    raw: &ClassMap,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> ClassMap {
    let px = raw
        .px
        .iter()
        .enumerate()
        .map(|(index, class)| {
            if *class != PixelClass::ColorErr {
                return *class;
            }
            let x = index as u32 % raw.w;
            let y = index as u32 / raw.w;
            if rgb_delta_exceeds_channel_tolerance(
                cand.get_pixel(x, y).0,
                reference.get_pixel(x, y).0,
            ) {
                PixelClass::ColorErr
            } else {
                PixelClass::Match
            }
        })
        .collect();
    ClassMap {
        w: raw.w,
        h: raw.h,
        px,
    }
}

/// Whether an unequal direct sample exceeds the per-pixel RGB tolerance.
/// Alpha is intentionally not treated as colour; it remains in the exact raw
/// `ColorErr` report evidence. The pinned `pdftoppm` comparison pages are opaque.
pub(crate) fn rgb_delta_exceeds_channel_tolerance(candidate: [u8; 4], reference: [u8; 4]) -> bool {
    candidate[..3]
        .iter()
        .zip(reference[..3].iter())
        .any(|(&candidate, &reference)| {
            candidate.abs_diff(reference) > VISUAL_COLOR_CHANNEL_TOLERANCE
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn only_byte_identical_pixels_match() {
        let reference = ImageBuffer::from_pixel(1, 1, Rgba([100, 100, 100, 255]));
        let candidate = ImageBuffer::from_pixel(1, 1, Rgba([101, 100, 100, 255]));
        let mask_c = super::super::super::geom::content_mask(&candidate);
        let mask_r = super::super::super::geom::content_mask(&reference);
        let classes = classify_pixels(&candidate, &reference, &mask_c, &mask_r);
        assert_eq!(classes.px, vec![PixelClass::ColorErr]);
    }

    #[test]
    fn visibility_map_applies_channel_tolerance_without_changing_raw_classes() {
        let reference = ImageBuffer::from_pixel(3, 1, Rgba([100, 100, 100, 255]));
        let candidate = ImageBuffer::from_fn(3, 1, |x, _| {
            if x == 0 {
                Rgba([101, 100, 100, 255])
            } else if x == 1 {
                Rgba([102, 100, 100, 255])
            } else {
                Rgba([103, 100, 100, 255])
            }
        });
        let mask_c = super::super::super::geom::content_mask(&candidate);
        let mask_r = super::super::super::geom::content_mask(&reference);
        let raw = classify_pixels(&candidate, &reference, &mask_c, &mask_r);
        let visible = classify_visible_colors(&raw, &candidate, &reference);

        assert_eq!(raw.px, vec![PixelClass::ColorErr; 3]);
        assert_eq!(
            visible.px,
            vec![PixelClass::Match, PixelClass::Match, PixelClass::ColorErr]
        );
    }

    #[test]
    fn adjacent_swapped_colors_remain_same_coordinate_color_errors() {
        let red = Rgba([255, 0, 0, 255]);
        let blue = Rgba([0, 0, 255, 255]);
        let reference = ImageBuffer::from_fn(2, 1, |x, _| if x == 0 { red } else { blue });
        let candidate = ImageBuffer::from_fn(2, 1, |x, _| if x == 0 { blue } else { red });
        let mask_c = super::super::super::geom::content_mask(&candidate);
        let mask_r = super::super::super::geom::content_mask(&reference);

        let classes = classify_pixels(&candidate, &reference, &mask_c, &mask_r);
        assert_eq!(classes.px, vec![PixelClass::ColorErr, PixelClass::ColorErr]);
    }

    #[test]
    fn sub_jnd_paper_boundary_stays_a_color_error() {
        let pair = (0u8..=255)
            .flat_map(|candidate| (0u8..=255).map(move |reference| (candidate, reference)))
            .find(|(candidate, reference)| {
                let candidate = Rgba([*candidate; 4]);
                let reference = Rgba([*reference; 4]);
                super::super::super::geom::is_content(&candidate)
                    != super::super::super::geom::is_content(&reference)
                    && ciede2000(
                        srgb_to_lab([candidate[0], candidate[1], candidate[2]]),
                        srgb_to_lab([reference[0], reference[1], reference[2]]),
                    ) <= VISUAL_COLOR_JND
            })
            .expect("a JND boundary must have adjacent sub-JND grayscale samples");
        let candidate = ImageBuffer::from_pixel(1, 1, Rgba([pair.0; 4]));
        let reference = ImageBuffer::from_pixel(1, 1, Rgba([pair.1; 4]));
        let classes = classify_pixels(
            &candidate,
            &reference,
            &super::super::super::geom::content_mask(&candidate),
            &super::super::super::geom::content_mask(&reference),
        );

        assert_eq!(classes.px, vec![PixelClass::ColorErr]);
    }
}
