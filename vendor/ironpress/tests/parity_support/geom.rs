//! Raster geometry: content detection, bounding boxes, union/crop, and masks.
//!
//! Extracted verbatim from the former monolithic `mod.rs` (C1 mechanical split).
//! No stage translates, registers, crops-to-fit, or resizes one render to match
//! the other.

use image::{ImageBuffer, Rgba, RgbaImage};

use super::compare::color::{ciede2000, srgb_to_lab};
use super::config::PAPER_CONTENT_JND;

const PAPER_LAB: super::compare::color::Lab = super::compare::color::Lab {
    l: 100.0,
    a: 0.0,
    b: 0.0,
};

pub(crate) fn is_content(px: &Rgba<u8>) -> bool {
    let [r, g, b, _] = px.0;
    ciede2000(srgb_to_lab([r, g, b]), PAPER_LAB) > PAPER_CONTENT_JND
}

/// Inclusive content bounding box `(min_x, min_y, max_x, max_y)` in the image's
/// own (== shared page) pixel coordinates, or `None` if the image is entirely
/// white (no content pixels). Coordinates are NOT re-anchored, so a box at the
/// same page position in two images yields the same numbers -> positional
/// offsets survive into the union/diff.
pub(crate) type BBox = (u32, u32, u32, u32);

fn bbox_where(w: u32, h: u32, mut included: impl FnMut(u32, u32) -> bool) -> Option<BBox> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut found = false;
    for y in 0..h {
        for x in 0..w {
            if included(x, y) {
                found = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if found {
        Some((min_x, min_y, max_x, max_y))
    } else {
        None
    }
}

pub(crate) fn content_bbox(img: &RgbaImage) -> Option<BBox> {
    let (w, h) = img.dimensions();
    bbox_where(w, h, |x, y| is_content(img.get_pixel(x, y)))
}

/// Inclusive bounds of every unequal same-coordinate RGBA pixel.
pub(crate) fn difference_bbox(left: &RgbaImage, right: &RgbaImage) -> Option<BBox> {
    debug_assert_eq!(left.dimensions(), right.dimensions());
    let (w, h) = left.dimensions();
    bbox_where(w, h, |x, y| left.get_pixel(x, y) != right.get_pixel(x, y))
}

/// Union of two inclusive bboxes (min of mins, max of maxes).
pub(crate) fn union_bbox(a: BBox, b: BBox) -> BBox {
    (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
}

// ---------------------------------------------------------------------------
// Content mask (V2; spec §1.4)
// ---------------------------------------------------------------------------

/// A 1-bit-per-pixel content mask in row-major order: bit set iff the pixel is
/// ink (`is_content`). Packed into `u64` words so the per-pixel classifier and
/// the structural-edge dilation can test membership in O(1) without re-running
/// `is_content`. Used only by the V2 comparator path.
pub(crate) struct Mask {
    pub(crate) w: u32,
    pub(crate) h: u32,
    bits: Vec<u64>,
}

impl Mask {
    #[inline]
    fn idx(&self, x: u32, y: u32) -> usize {
        (y as usize) * (self.w as usize) + (x as usize)
    }
    /// Whether the pixel at `(x, y)` is ink. Out-of-bounds reads as `false`.
    #[inline]
    pub(crate) fn get(&self, x: u32, y: u32) -> bool {
        if x >= self.w || y >= self.h {
            return false;
        }
        let i = self.idx(x, y);
        (self.bits[i >> 6] >> (i & 63)) & 1 == 1
    }
    #[inline]
    fn set(&mut self, x: u32, y: u32) {
        let i = self.idx(x, y);
        self.bits[i >> 6] |= 1u64 << (i & 63);
    }
}

/// Build the content mask of `img`: one set bit per ink pixel (`is_content`).
pub(crate) fn content_mask(img: &RgbaImage) -> Mask {
    let (w, h) = img.dimensions();
    let words = (w as usize * h as usize).div_ceil(64);
    let mut m = Mask {
        w,
        h,
        bits: vec![0u64; words.max(1)],
    };
    for y in 0..h {
        for x in 0..w {
            if is_content(img.get_pixel(x, y)) {
                m.set(x, y);
            }
        }
    }
    m
}

/// Crop `img` to the inclusive rectangle `bb` in `img`'s OWN coordinate space,
/// padding with white where the rectangle extends past the image bounds. Both
/// ref and candidate are cropped to the SAME rectangle, so output dims match and
/// every pixel compares like-for-like at the same page position.
pub(crate) fn crop_rect(img: &RgbaImage, bb: BBox) -> RgbaImage {
    let (min_x, min_y, max_x, max_y) = bb;
    let w = max_x - min_x + 1;
    let h = max_y - min_y + 1;
    let mut out: RgbaImage = ImageBuffer::from_pixel(w, h, Rgba([255, 255, 255, 255]));
    for oy in 0..h {
        for ox in 0..w {
            let sx = min_x + ox;
            let sy = min_y + oy;
            if sx < img.width() && sy < img.height() {
                out.put_pixel(ox, oy, *img.get_pixel(sx, sy));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use image::{ImageBuffer, Rgba};

    use super::{difference_bbox, is_content};

    #[test]
    fn imperceptible_near_white_is_paper() {
        assert!(!is_content(&Rgba([255, 255, 255, 255])));
        assert!(!is_content(&Rgba([254, 255, 255, 255])));
        assert!(is_content(&Rgba([240, 240, 240, 255])));
    }

    #[test]
    fn difference_bounds_include_alpha_only_pixels_on_paper() {
        let reference = ImageBuffer::from_pixel(20, 20, Rgba([255, 255, 255, 255]));
        let mut candidate = reference.clone();
        candidate.put_pixel(19, 18, Rgba([255, 255, 255, 254]));

        assert_eq!(
            difference_bbox(&candidate, &reference),
            Some((19, 18, 19, 18))
        );
    }
}
