//! Aggregation (spec §1.9): roll the per-pixel class map and the diff regions up
//! into diagnostic per-class severities. Exact pixel inequality remains complete
//! evidence; the verdict applies the human-visibility policy to that evidence.
//!
//! Percentages use painted-content denominators, while `different_px` remains the
//! exact count of unequal same-coordinate pixels.

use image::RgbaImage;
use std::collections::HashMap;

use super::super::config::CSS_PX;
use super::super::geom::Mask;
use super::classify::{ClassMap, PixelClass, rgb_delta_exceeds_channel_tolerance};
use super::color::{ColorEnergy, ciede2000, same_colour_family, srgb_to_lab};
use super::masks::StructuralMasks;
use super::segment::RegionSet;

/// Per-class severities for one fixture. All magnitudes are direct pixel counts,
/// ΔE, or percentages of content area.
/// `modal_drgba`/`total_px` are populated now and consumed by diagnosis /
/// C5 report; kept on the struct so the contract is complete.
#[derive(Default)]
#[allow(dead_code)]
pub(crate) struct ClassTally {
    /// Number of pixels that are not byte-identical.
    pub(crate) different_px: u64,
    /// Direct same-coordinate ColorErr pixel count. Kept beside Missing/Extra
    /// counts so the visibility policy can distinguish a coverage phase from a
    /// binary paint swap without reconstructing a count from percentages.
    pub(crate) color_px: u64,
    /// Direct ColorErr pixels whose RGB channels exceed the per-pixel colour
    /// tolerance. `color_px` remains the exact raw evidence count.
    pub(crate) color_above_channel_tolerance_px: u64,
    /// Direct same-coordinate Missing-paint pixel count. This must not be
    /// inferred from a mixed region's dominant class.
    pub(crate) missing_px: u64,
    /// Direct same-coordinate Extra-paint pixel count. This must not be
    /// inferred from a mixed region's dominant class.
    pub(crate) extra_px: u64,
    /// ColorErr px / union content px.
    pub(crate) color_pct: f64,
    /// ColorErr pixels above the per-pixel RGB tolerance / union content px.
    pub(crate) color_above_channel_tolerance_pct: f64,
    /// Missing px / ref content px.
    pub(crate) missing_pct: f64,
    /// Extra px / cand content px.
    pub(crate) extra_pct: f64,
    /// Area-weighted mean ΔE2000 over ColorErr regions.
    pub(crate) color_de: f64,
    /// INTERIOR (non-edge-band) ColorErr px / union content px — the solid-recolour
    /// area fraction. Boundary ColorErr remains counted by `color_pct`.
    pub(crate) interior_color_pct: f64,
    /// Area-weighted (by interior px) mean of the per-region MEDIAN interior ΔE —
    /// the robust solid-recolour Delta-E used by diagnosis.
    pub(crate) interior_color_de: f64,
    /// Modal (median) per-channel ΔRGB over all ColorErr px.
    pub(crate) modal_drgba: [i16; 4],
    /// Largest per-channel residual signed colour energy divided by its total
    /// absolute colour energy. Zero means positive and negative coverage
    /// changes balance exactly; one means a coherent one-direction recolour.
    pub(crate) color_coverage_bias: f64,
    /// Every independently visible ColorErr component has sufficiently balanced
    /// signed colour energy. This prevents global cancellation from hiding two
    /// separate recolours.
    pub(crate) color_components_are_balanced: bool,
    /// Every ColorErr pixel lies within one authored CSS pixel of an already
    /// byte-identical sample in the same raster. This is direct local context,
    /// never a candidate/reference registration search.
    pub(crate) color_errors_have_css_anchors: bool,
    /// Every direct colour residual is neutral or retains its colour family.
    /// This distinguishes an antialiasing-coverage phase from a chromatic swap
    /// without moving either raster or pairing different coordinates.
    pub(crate) color_errors_preserve_hue: bool,
    /// Candidate and reference contain exactly the same multiset of RGBA
    /// samples. This is an aggregate conservation fact, not spatial matching:
    /// no pixel is moved or paired with another coordinate.
    pub(crate) rgba_histograms_match: bool,
    /// Fraction of the painted union whose pixels are byte-identical at the
    /// same coordinates. This is an interior-stability observation, never an
    /// image registration or nearby-pixel search.
    pub(crate) shared_content_ratio: f64,
    /// Missing/Extra samples outside the directly observed structural boundary
    /// band. A stable outline phase must leave this at zero; the count remains
    /// raw same-coordinate evidence and never moves either raster.
    pub(crate) presence_outside_edge_band_px: u64,
    pub(crate) total_px: u64,
}

/// Aggregate same-coordinate pixel classes and complete region summaries.
pub(crate) fn aggregate(
    cm: &ClassMap,
    regions: &RegionSet,
    mask_c: &Mask,
    mask_r: &Mask,
    masks: &StructuralMasks,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> ClassTally {
    let total_px = cm.px.len() as u64;

    // Class counts.
    let mut color = 0u64;
    let mut color_above_channel_tolerance = 0u64;
    let mut missing = 0u64;
    let mut extra = 0u64;
    let mut presence_outside_edge_band = 0u64;
    for (index, c) in cm.px.iter().enumerate() {
        match c {
            PixelClass::ColorErr => {
                color += 1;
                let x = index as u32 % cm.w;
                let y = index as u32 / cm.w;
                if rgb_delta_exceeds_channel_tolerance(
                    cand.get_pixel(x, y).0,
                    reference.get_pixel(x, y).0,
                ) {
                    color_above_channel_tolerance += 1;
                }
            }
            PixelClass::Missing | PixelClass::Extra => {
                if *c == PixelClass::Missing {
                    missing += 1;
                } else {
                    extra += 1;
                }
                let x = index as u32 % cm.w;
                let y = index as u32 / cm.w;
                if !masks.in_edge_band(x, y) {
                    presence_outside_edge_band += 1;
                }
            }
            _ => {}
        }
    }
    let different_px = color + missing + extra;

    // Content-pixel denominators (spec §1.9).
    let (w, h) = cand.dimensions();
    let mut cand_content = 0u64;
    let mut ref_content = 0u64;
    let mut union_content = 0u64;
    let mut shared_content = 0u64;
    for y in 0..h {
        for x in 0..w {
            let ic = mask_c.get(x, y);
            let ir = mask_r.get(x, y);
            if ic {
                cand_content += 1;
            }
            if ir {
                ref_content += 1;
            }
            if ic || ir {
                union_content += 1;
                let index = y as usize * w as usize + x as usize;
                if cm.px[index] == PixelClass::Match {
                    shared_content += 1;
                }
            }
        }
    }
    let pct = |num: u64, den: u64| {
        if den == 0 {
            0.0
        } else {
            100.0 * num as f64 / den as f64
        }
    };

    let color_pct = pct(color, union_content);
    let color_above_channel_tolerance_pct = pct(color_above_channel_tolerance, union_content);
    let missing_pct = pct(missing, ref_content);
    let extra_pct = pct(extra, cand_content);
    let shared_content_ratio = if union_content == 0 {
        1.0
    } else {
        shared_content as f64 / union_content as f64
    };

    // Area-weighted ΔE over every ColorErr region, including components beyond
    // the bounded representative list; modal ΔRGB covers every ColorErr pixel.
    let de_weight: f64 = regions
        .aggregates
        .iter()
        .map(|aggregate| aggregate.color_de_weight)
        .sum();
    let de_area: u64 = regions
        .aggregates
        .iter()
        .map(|aggregate| aggregate.color_de_area)
        .sum();
    let color_de = if de_area > 0 {
        de_weight / de_area as f64
    } else {
        0.0
    };

    // Interior-ColorErr aggregate. Sum the per-region
    // interior ColorErr px (edge-band ColorErr excluded by `segment`) and the
    // interior-px-weighted region median ΔE. This fires hard_color on a SOLID
    // recolour (interior area + Delta-E), while a boundary-only colour ring does
    // not get described as a solid fill.
    let interior_px: u64 = regions
        .aggregates
        .iter()
        .map(|aggregate| aggregate.interior_color_px)
        .sum();
    let interior_de_weight: f64 = regions
        .aggregates
        .iter()
        .map(|aggregate| aggregate.interior_de_weight)
        .sum();
    let interior_color_pct = pct(interior_px, union_content);
    let interior_color_de = if interior_px > 0 {
        interior_de_weight / interior_px as f64
    } else {
        0.0
    };

    // These summaries are consumed only by ColorErr verdict paths. Skip their
    // complete-raster scans (and the anchor map's page-sized allocation) for
    // exact or presence-only comparisons, where they are unreachable.
    let (
        modal_drgba,
        color_coverage_bias,
        color_errors_have_css_anchors,
        color_errors_preserve_hue,
    ) = if color > 0 {
        let (modal_drgba, color_coverage_bias) = summarize_colorerr(cm, cand, reference);
        (
            modal_drgba,
            color_coverage_bias,
            color_errors_have_css_anchors(cm),
            color_errors_preserve_hue(cm, cand, reference),
        )
    } else {
        ([0; 4], 0.0, false, false)
    };
    let color_components_are_balanced = regions.large_color_components_are_balanced();
    let rgba_histograms_match = rgba_histograms_match(cand, reference);
    // If ColorErr pixels exist but no ColorErr-dominant region contributed a
    // Delta-E, still surface a complete pixel-level value for diagnosis.
    let color_de = if color_de == 0.0 && color > 0 {
        sampled_colorerr_de(cm, cand, reference)
    } else {
        color_de
    };

    ClassTally {
        different_px,
        color_px: color,
        color_above_channel_tolerance_px: color_above_channel_tolerance,
        missing_px: missing,
        extra_px: extra,
        color_pct,
        color_above_channel_tolerance_pct,
        missing_pct,
        extra_pct,
        color_de,
        interior_color_pct,
        interior_color_de,
        modal_drgba,
        color_coverage_bias,
        color_components_are_balanced,
        color_errors_have_css_anchors,
        color_errors_preserve_hue,
        rgba_histograms_match,
        shared_content_ratio,
        presence_outside_edge_band_px: presence_outside_edge_band,
        total_px,
    }
}

/// Compare exact RGBA sample counts without registering spatial positions.
/// Recording only unequal coordinate pairs keeps the map small for the common
/// near-parity case while remaining exact for arbitrary raster content.
fn rgba_histograms_match(candidate: &RgbaImage, reference: &RgbaImage) -> bool {
    if candidate.dimensions() != reference.dimensions() {
        return false;
    }
    let mut balance = HashMap::<u32, i64>::new();
    for (candidate, reference) in candidate.pixels().zip(reference.pixels()) {
        if candidate == reference {
            continue;
        }
        *balance.entry(u32::from_be_bytes(candidate.0)).or_default() += 1;
        *balance.entry(u32::from_be_bytes(reference.0)).or_default() -= 1;
    }
    balance.values().all(|count| *count == 0)
}

/// True when each directly changed pair remains neutral or lies in the same
/// colour family. Coverage changes of black text and a coloured shape over
/// paper satisfy this naturally; changing red paint into blue cannot. The
/// calculation stays at the original coordinate and has no spatial search.
fn color_errors_preserve_hue(cm: &ClassMap, cand: &RgbaImage, reference: &RgbaImage) -> bool {
    cm.px.iter().enumerate().all(|(index, class)| {
        *class != PixelClass::ColorErr || {
            let x = index as u32 % cm.w;
            let y = index as u32 / cm.w;
            same_colour_family(cand.get_pixel(x, y).0, reference.get_pixel(x, y).0)
        }
    })
}

/// Compute the chessboard distance to an already exact shared pixel, capped at
/// one CSS pixel plus one. The two raster scans are linear in the page area and
/// avoid allocating or searching a neighborhood per ColorErr pixel.
fn color_errors_have_css_anchors(cm: &ClassMap) -> bool {
    let maximum_distance = CSS_PX.ceil() as u8;
    let cap = maximum_distance.saturating_add(1);
    let width = cm.w as usize;
    let height = cm.h as usize;
    if width == 0 || height == 0 {
        return false;
    }
    let mut distance = vec![cap; cm.px.len()];
    for (index, class) in cm.px.iter().enumerate() {
        if *class == PixelClass::Match {
            distance[index] = 0;
        }
    }

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let mut best = distance[index];
            if x > 0 {
                best = best.min(distance[index - 1].saturating_add(1));
            }
            if y > 0 {
                best = best.min(distance[index - width].saturating_add(1));
                if x > 0 {
                    best = best.min(distance[index - width - 1].saturating_add(1));
                }
                if x + 1 < width {
                    best = best.min(distance[index - width + 1].saturating_add(1));
                }
            }
            distance[index] = best.min(cap);
        }
    }
    for y in (0..height).rev() {
        for x in (0..width).rev() {
            let index = y * width + x;
            let mut best = distance[index];
            if x + 1 < width {
                best = best.min(distance[index + 1].saturating_add(1));
            }
            if y + 1 < height {
                best = best.min(distance[index + width].saturating_add(1));
                if x > 0 {
                    best = best.min(distance[index + width - 1].saturating_add(1));
                }
                if x + 1 < width {
                    best = best.min(distance[index + width + 1].saturating_add(1));
                }
            }
            distance[index] = best.min(cap);
        }
    }
    cm.px
        .iter()
        .enumerate()
        .filter(|(_, class)| **class == PixelClass::ColorErr)
        .all(|(index, _)| distance[index] <= maximum_distance)
}

/// Summarize ColorErr pixels without discarding their signed coverage balance.
fn summarize_colorerr(cm: &ClassMap, cand: &RgbaImage, reference: &RgbaImage) -> ([i16; 4], f64) {
    let mut dr = Vec::new();
    let mut dg = Vec::new();
    let mut db = Vec::new();
    let mut da = Vec::new();
    let mut energy = ColorEnergy::default();
    let w = cm.w;
    for (i, cls) in cm.px.iter().enumerate() {
        if *cls != PixelClass::ColorErr {
            continue;
        }
        let x = (i as u32) % w;
        let y = (i as u32) / w;
        let c = cand.get_pixel(x, y).0;
        let r = reference.get_pixel(x, y).0;
        let delta = [
            c[0] as i16 - r[0] as i16,
            c[1] as i16 - r[1] as i16,
            c[2] as i16 - r[2] as i16,
        ];
        dr.push(delta[0]);
        dg.push(delta[1]);
        db.push(delta[2]);
        da.push(c[3] as i16 - r[3] as i16);
        energy.add(delta);
    }
    (
        [
            median(&mut dr),
            median(&mut dg),
            median(&mut db),
            median(&mut da),
        ],
        energy.bias(),
    )
}

/// Mean ΔE2000 over all ColorErr pixels (fallback when no region cleared the
/// speck filter but ColorErr pixels exist).
fn sampled_colorerr_de(cm: &ClassMap, cand: &RgbaImage, reference: &RgbaImage) -> f64 {
    let w = cm.w;
    let mut sum = 0.0;
    let mut n = 0u32;
    for (i, cls) in cm.px.iter().enumerate() {
        if *cls != PixelClass::ColorErr {
            continue;
        }
        let x = (i as u32) % w;
        let y = (i as u32) / w;
        let c = cand.get_pixel(x, y).0;
        let r = reference.get_pixel(x, y).0;
        sum += ciede2000(
            srgb_to_lab([r[0], r[1], r[2]]),
            srgb_to_lab([c[0], c[1], c[2]]),
        );
        n += 1;
    }
    if n > 0 { sum / n as f64 } else { 0.0 }
}

fn median(v: &mut [i16]) -> i16 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[v.len() / 2]
}
