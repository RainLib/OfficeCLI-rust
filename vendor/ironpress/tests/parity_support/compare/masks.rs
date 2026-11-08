//! Structural-edge masks used to distinguish a localized boundary appearance
//! difference from a solid interior recolour. The mask never suppresses a pixel:
//! every non-identical pixel remains a counted class.

use image::RgbaImage;

use super::super::config::EDGE_GRAD;

/// Two packed bitsets over the union-cropped frame (1 bit/px, row-major):
/// - `edge`: per-image structural edge (kept for diagnosis).
/// - `edge_band`: union of both images' 1px-dilated edge bands — the structural
///   boundary locus (fill-vs-border / box-vs-background).
pub(crate) struct StructuralMasks {
    w: u32,
    h: u32,
    /// Union of both images' raw edges. Informational (drives diagnosis).
    #[allow(dead_code)]
    edge: Vec<u64>,
    /// Union of both images' dilated edge bands. A ColorErr pixel inside this band
    /// is still counted, but is not described as a solid interior recolour.
    edge_band: Vec<u64>,
}

impl StructuralMasks {
    #[inline]
    fn test(bits: &[u64], i: usize) -> bool {
        (bits[i >> 6] >> (i & 63)) & 1 == 1
    }
    /// Whether `(x,y)` lies on a structural edge in either image.
    #[allow(dead_code)]
    #[inline]
    pub(crate) fn is_edge(&self, x: u32, y: u32) -> bool {
        if x >= self.w || y >= self.h {
            return false;
        }
        Self::test(&self.edge, (y as usize) * (self.w as usize) + x as usize)
    }
    /// Whether `(x,y)` is within 1px of a structural edge in either image. This
    /// distinguishes boundary-local appearance from solid interior appearance;
    /// it does not exclude the pixel from the ordinary ColorErr tally.
    #[inline]
    pub(crate) fn in_edge_band(&self, x: u32, y: u32) -> bool {
        if x >= self.w || y >= self.h {
            return false;
        }
        Self::test(
            &self.edge_band,
            (y as usize) * (self.w as usize) + x as usize,
        )
    }
}

#[inline]
fn set(bits: &mut [u64], i: usize) {
    bits[i >> 6] |= 1u64 << (i & 63);
}
#[inline]
fn get(bits: &[u64], i: usize) -> bool {
    (bits[i >> 6] >> (i & 63)) & 1 == 1
}

/// A pixel is an edge iff the max over its 4-neighbours of the max-per-channel
/// |Δ| exceeds `EDGE_GRAD` (0..255). Returns the raw edge bitset for `img`.
fn detect_edges(img: &RgbaImage) -> Vec<u64> {
    let (w, h) = img.dimensions();
    let words = (w as usize * h as usize).div_ceil(64);
    let mut edge = vec![0u64; words.max(1)];
    for y in 0..h {
        for x in 0..w {
            let c = img.get_pixel(x, y).0;
            let mut grad = 0i32;
            // 4-neighbourhood (clamped at the frame border).
            let neighbours = [
                (x.wrapping_sub(1), y, x > 0),
                (x + 1, y, x + 1 < w),
                (x, y.wrapping_sub(1), y > 0),
                (x, y + 1, y + 1 < h),
            ];
            for (nx, ny, ok) in neighbours {
                if !ok {
                    continue;
                }
                let n = img.get_pixel(nx, ny).0;
                let d = (c[0] as i32 - n[0] as i32)
                    .abs()
                    .max((c[1] as i32 - n[1] as i32).abs())
                    .max((c[2] as i32 - n[2] as i32).abs());
                grad = grad.max(d);
            }
            if grad > EDGE_GRAD {
                set(&mut edge, (y as usize) * (w as usize) + x as usize);
            }
        }
    }
    edge
}

/// Square morphological dilation of an edge bitset by `radius` pixels.
fn dilate(edge: &[u64], w: u32, h: u32, radius: u32) -> Vec<u64> {
    let words = (w as usize * h as usize).div_ceil(64);
    let mut out = vec![0u64; words.max(1)];
    for y in 0..h {
        for x in 0..w {
            let i = (y as usize) * (w as usize) + x as usize;
            if !get(edge, i) {
                continue;
            }
            let x0 = x.saturating_sub(radius);
            let y0 = y.saturating_sub(radius);
            let x2 = (x + radius).min(w - 1);
            let y2 = (y + radius).min(h - 1);
            for yy in y0..=y2 {
                for xx in x0..=x2 {
                    set(&mut out, (yy as usize) * (w as usize) + xx as usize);
                }
            }
        }
    }
    out
}

/// Build `StructuralMasks` for an already-aligned cand/ref pair (same dims).
pub(crate) fn structural_masks(cand: &RgbaImage, reference: &RgbaImage) -> StructuralMasks {
    let (w, h) = cand.dimensions();
    let edge_c = detect_edges(cand);
    let edge_r = detect_edges(reference);

    // Edge masks only refine colour diagnostics. They never relabel or forgive
    // unequal pixels.
    let band_c = dilate(&edge_c, w, h, 1);
    let band_r = dilate(&edge_r, w, h, 1);

    let words = band_c.len();
    let mut edge_band = vec![0u64; words];
    for i in 0..words {
        // Union of the dilated bands: the structural-boundary locus (either image).
        edge_band[i] = band_c[i] | band_r[i];
    }

    // `edge` (informational): union of both images' raw edges.
    let mut edge = vec![0u64; edge_c.len()];
    for i in 0..edge.len() {
        edge[i] = edge_c[i] | edge_r[i];
    }

    StructuralMasks {
        w,
        h,
        edge,
        edge_band,
    }
}
