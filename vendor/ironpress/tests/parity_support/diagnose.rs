//! Per-fixture diagnosis (spec §2): the "why it failed" layer over the V2
//! comparator. ADDITIVE — it reads the tally/regions/aligned pixels the verdict
//! already produced and never changes a verdict.
//!
//! The output is one `Diagnosis` per scored fixture: a directly observed primary
//! class, a human headline, 0..255 ΔRGB / ΔE magnitudes, and a per-region
//! breakdown. `compute_dependency_context`
//! below) reports failing dependencies separately without rewriting the measured
//! PDF-difference diagnosis or claiming a cause that the harness did not prove.
//! (honors the MEMORY.md failure-mode-attribution rule).
//!
//! Sub-classifier coverage:
//!   - Missing/Extra follow same-coordinate paper/content facts.
//!   - ColorSpace (gamma/sRGB-linear fit) and AlphaCompositing (α solve) —
//!     BEST-EFFORT: sampled from the aligned cand/ref pixels of the dominant
//!     ColorErr region. When the fit is inconclusive we fall back to ColorValue
//!     (never block a diagnosis on the refinement). See `fit_colorspace` /
//!     `recover_alpha`.

use std::collections::BTreeMap;

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use super::compare::{ClassMap, ClassTally, CoverageEvidence, DiffRegion, PixelClass, RegionSet};
use super::config::CSS_PX;
use super::report::{FixtureResult, Status};

// ===========================================================================
// Types (spec §2.1) — all Serialize/Deserialize/Clone/Debug/Default so the
// `diagnosis` field is additive (old baselines without it still parse) and the
// goldens can lock the shape.
// ===========================================================================

/// The kind of directly observed defect a region/fixture exhibits.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum ErrorClass {
    /// Reference paints, candidate is blank (feature absent / clipped).
    Missing,
    /// Candidate paints where the reference is blank.
    Extra,
    /// Flat recolour / wrong colour value (within sRGB).
    #[default]
    ColorValue,
    /// Antialiasing coverage differences on a shared outline.
    AntialiasCoverage,
    /// Gradient/blend drift consistent with an sRGB-vs-linear (gamma) mismatch.
    ColorSpace,
    /// Opacity not composited (an α∈(0,1) explains ref while cand is opaque).
    AlphaCompositing,
}

impl ErrorClass {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ErrorClass::Missing => "Missing",
            ErrorClass::Extra => "Extra",
            ErrorClass::ColorValue => "ColorValue",
            ErrorClass::AntialiasCoverage => "AntialiasCoverage",
            ErrorClass::ColorSpace => "ColorSpace",
            ErrorClass::AlphaCompositing => "AlphaCompositing",
        }
    }
}

/// Direct same-coordinate defect magnitudes for one fixture.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct Magnitude {
    /// % of REF content area that is Missing.
    pub(crate) missing_area_pct: f64,
    /// % of CAND content area that is Extra.
    pub(crate) extra_area_pct: f64,
    /// Modal (median) signed per-channel cand−ref over ColorErr px (0..255).
    pub(crate) modal_drgba: [i16; 4],
    /// Area-weighted mean ΔE2000 over ColorErr regions.
    pub(crate) delta_e: f64,
    /// Recovered compositing α∈(0,1) when AlphaCompositing was diagnosed.
    pub(crate) recovered_alpha: Option<f64>,
    /// A short tag for a detected colour-space fit (e.g. `"sRGB↔linear"`), if any.
    pub(crate) colorspace: Option<String>,
}

/// One diff region's diagnosis (worst-first). Magnitudes mirror `Magnitude` at
/// region scope.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct RegionDiag {
    pub(crate) class: String,
    pub(crate) bbox_css: [f64; 4],
    pub(crate) area_pct: f64,
    pub(crate) modal_drgba: [i16; 4],
    pub(crate) delta_e: f64,
    pub(crate) recovered_alpha: Option<f64>,
    pub(crate) headline: String,
}

/// Complete component census for one dominant raster class. The bounded
/// `region_examples` list is presentation detail; this aggregate is the semantic
/// record and includes every one-pixel component.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct RegionClassSummary {
    pub(crate) class: String,
    pub(crate) region_count: u64,
    pub(crate) total_pixels: u64,
    pub(crate) total_area_pct: f64,
    pub(crate) union_bbox_css: [f64; 4],
    pub(crate) largest_region_pixels: u32,
    pub(crate) largest_region_area_pct: f64,
    pub(crate) max_delta_e: f64,
}

/// The full diagnosis for one fixture (§2.1). `primary_class`/`secondary` are
/// `ErrorClass` names; `headline` is the measured human reason (§2.3);
/// `confidence` is the fraction of real-diff px in the primary class.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct Diagnosis {
    pub(crate) primary_class: String,
    pub(crate) secondary: Vec<String>,
    pub(crate) headline: String,
    pub(crate) magnitude: Magnitude,
    /// Total connected components represented by `region_classes`.
    pub(crate) region_count: u64,
    /// Lossless per-raster-class aggregate over every connected component.
    pub(crate) region_classes: Vec<RegionClassSummary>,
    /// Bounded, worst-first examples for visual detail. Never use its length as
    /// the semantic region count; `region_count` is authoritative.
    pub(crate) region_examples: Vec<RegionDiag>,
    pub(crate) confidence: f64,
    /// Exact number of unequal RGBA pixels in the complete compared page.
    /// This is evidence for the report, never a pass threshold.
    #[serde(default)]
    pub(crate) different_pixels: u64,
    /// Why a non-identical comparison passed. This makes the fixed visibility
    /// policy auditable without changing the raw difference evidence.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) visual_pass_basis: String,
}

// ===========================================================================
// diagnose() — the entry point (spec §2.2 sub-classifiers + §2.3 headline)
// ===========================================================================

/// Diagnose one fixture from the V2 comparator's owned products. `cm`/`cand`/`ref`
/// are the union-cropped class map and aligned images (the only pixel access the
/// colour-space / alpha sub-classifiers need). Pure: no I/O, no mutation of inputs.
pub(crate) fn diagnose(
    tally: &ClassTally,
    regions: &RegionSet,
    cm: &ClassMap,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> Diagnosis {
    // Non-match pixel census for `confidence` (fraction in the primary class).
    let census = Census::of(cm);

    if census.real == 0 {
        return exact_match_diagnosis(tally);
    }

    // --- Bounded representative diagnosis (worst-first) ------------------
    let mut region_diags: Vec<(ErrorClass, RegionDiag, u32)> = Vec::new();
    for r in &regions.examples {
        let (class, alpha) = classify_region(r, cand, reference);
        let rd = region_diag(r, class, alpha, tally);
        region_diags.push((class, rd, r.area_px));
    }

    // --- Elect the primary class -----------------------------------------
    // A direct visible Missing/Extra component outranks colour drift. The
    // visibility helper reads the same exact-class component census as the
    // verdict, so the report labels the paint-presence defect that actually
    // failed the fixed policy. Below that global floor, the largest region
    // remains the most useful diagnosis.
    let (primary, primary_region) = match visible_presence_primary(tally, regions) {
        Some(primary) => (primary, None),
        None => match region_diags.first() {
            Some((c, rd, _)) => (*c, Some(rd.clone())),
            None => (elect_from_tally(tally, &census), None),
        },
    };

    // Secondary classes: every OTHER region class that is above its PASS bound,
    // de-duplicated, primary excluded.
    let mut secondary: Vec<String> = Vec::new();
    for (c, _, _) in region_diags.iter() {
        if *c != primary {
            let s = c.as_str().to_string();
            if !secondary.contains(&s) {
                secondary.push(s);
            }
        }
    }

    // Confidence: fraction of real-diff px that fall in the primary class.
    let primary_px = census.count_of(primary);
    let confidence = if census.real == 0 {
        0.0
    } else {
        (primary_px as f64 / census.real as f64).clamp(0.0, 1.0)
    };

    // Aggregate same-coordinate ΔRGB / ΔE / α magnitudes.
    let recovered_alpha = primary_region.as_ref().and_then(|r| r.recovered_alpha);
    let colorspace = primary_region.as_ref().and_then(|r| {
        if r.class == ErrorClass::ColorSpace.as_str() {
            Some("sRGB↔linear".to_string())
        } else {
            None
        }
    });
    let magnitude = Magnitude {
        missing_area_pct: tally.missing_pct,
        extra_area_pct: tally.extra_pct,
        modal_drgba: tally.modal_drgba,
        delta_e: tally.color_de,
        recovered_alpha,
        colorspace,
    };

    // Headline (§2.3) for the whole fixture, keyed on the primary class + its
    // magnitude signature. Region headlines are filled per-region above.
    let headline = headline_for(primary, &magnitude, tally);

    let region_examples: Vec<RegionDiag> = region_diags
        .into_iter()
        .map(|(_, region, _)| region)
        .collect();
    let region_classes = regions
        .aggregates
        .iter()
        .map(|aggregate| RegionClassSummary {
            class: aggregate.class.as_str().to_string(),
            region_count: aggregate.region_count,
            total_pixels: aggregate.total_area_px,
            total_area_pct: aggregate.total_area_pct,
            union_bbox_css: aggregate.union_bbox_css,
            largest_region_pixels: aggregate.largest_area_px,
            largest_region_area_pct: aggregate.largest_area_pct,
            max_delta_e: aggregate.max_delta_e,
        })
        .collect();

    Diagnosis {
        primary_class: primary.as_str().to_string(),
        secondary,
        headline,
        magnitude,
        region_count: regions.total_count,
        region_classes,
        region_examples,
        confidence,
        different_pixels: tally.different_px,
        ..Default::default()
    }
}

/// A clean diagnosis exists only when every compared pixel is byte-identical.
fn exact_match_diagnosis(_tally: &ClassTally) -> Diagnosis {
    Diagnosis {
        headline: "exact pixel match".to_string(),
        confidence: 1.0,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Region-level classification (the per-region ErrorClass + its RegionDiag)
// ---------------------------------------------------------------------------

/// Map a region from its directly observed dominant class. Color mismatches may
/// receive an additional same-coordinate color/alpha description.
fn classify_region(
    r: &DiffRegion,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> (ErrorClass, Option<f64>) {
    match r.class {
        PixelClass::Missing => (ErrorClass::Missing, None),
        PixelClass::Extra => (ErrorClass::Extra, None),
        PixelClass::ColorErr if r.coverage.shared_color_ramp => {
            (ErrorClass::AntialiasCoverage, None)
        }
        PixelClass::ColorErr => refine_color(r, cand, reference),
        // Match never dominates a non-match region; keep the mapping total.
        PixelClass::Match => (ErrorClass::ColorValue, None),
    }
}

/// Refine a ColorErr-dominant region into ColorValue / ColorSpace / AlphaCompositing,
/// returning the class and (for AlphaCompositing) the recovered α. BEST-EFFORT for
/// the latter two: an inconclusive fit falls back to ColorValue.
fn refine_color(
    r: &DiffRegion,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> (ErrorClass, Option<f64>) {
    // AlphaCompositing — BEST-EFFORT and DELIBERATELY NON-CLASS-CHANGING here. A
    // uniform α∈(0,1) explaining ref≈α·cand+(1−α)·white is recovered as an
    // INFORMATIONAL magnitude (carried on `recovered_alpha`), but it does NOT
    // override the ColorValue class: a modal colour pair alone does not establish
    // compositing as the cause. The result is ColorValue plus a recovered-alpha
    // hint; spatially coherent evidence could promote the class later.
    let alpha = recover_alpha(r, cand, reference);
    // ColorSpace (gamma/sRGB-linear) fit over the region's ColorErr pixels.
    if fit_colorspace(r, cand, reference) {
        return (ErrorClass::ColorSpace, alpha);
    }
    (ErrorClass::ColorValue, alpha)
}

/// Build the serialisable per-region diagnosis with its own headline.
fn region_diag(
    r: &DiffRegion,
    class: ErrorClass,
    recovered_alpha: Option<f64>,
    tally: &ClassTally,
) -> RegionDiag {
    let mut rd = RegionDiag {
        class: class.as_str().to_string(),
        bbox_css: r.bbox_css,
        area_pct: r.area_pct,
        modal_drgba: r.modal_drgba,
        delta_e: r.delta_e,
        recovered_alpha,
        headline: String::new(),
    };
    // A region-scoped magnitude for its own headline.
    let mag = Magnitude {
        missing_area_pct: if class == ErrorClass::Missing {
            r.area_pct
        } else {
            0.0
        },
        extra_area_pct: if class == ErrorClass::Extra {
            r.area_pct
        } else {
            0.0
        },
        modal_drgba: rd.modal_drgba,
        delta_e: rd.delta_e,
        recovered_alpha: rd.recovered_alpha,
        colorspace: if class == ErrorClass::ColorSpace {
            Some("sRGB↔linear".to_string())
        } else {
            None
        },
    };
    rd.headline = headline_for(class, &mag, tally);
    rd
}

// ---------------------------------------------------------------------------
// ColorSpace / AlphaCompositing sub-classifiers (spec §2.2) — BEST-EFFORT.
// ---------------------------------------------------------------------------

/// Try to recover a uniform compositing α∈(0,1) explaining the region: the
/// candidate paints an OPAQUE colour `top`, the reference shows `top` composited
/// at α over white paper (`ref ≈ α·top + (1−α)·255`). We solve α per channel from
/// the region's modal cand/ref colours and accept only a CONSISTENT α well inside
/// (0,1). Best-effort: returns `None` (=> ColorValue) when the channels disagree
/// or α is degenerate.
fn recover_alpha(r: &DiffRegion, cand: &RgbaImage, reference: &RgbaImage) -> Option<f64> {
    let (top, bot, top_share, bot_share) = region_modal_colors(r, cand, reference)?;
    // Uniformity gate (the key false-positive guard): true uncomposited opacity is
    // a SOLID opaque ink (candidate) versus the SAME ink blended over paper
    // (reference) — BOTH sides are near-uniform. Require both sides to be strongly
    // modal before surfacing this informational fit.
    if top_share < 0.85 || bot_share < 0.85 {
        return None;
    }
    // The candidate ink must be a genuinely SATURATED/dark colour (far from white)
    // on at least two channels — otherwise "ref ≈ α·top + (1−α)·white" is ill-posed
    // and any colour difference fits a spurious α.
    let informative = (0..3)
        .filter(|&ch| (top[ch] as i32 - 255).abs() >= 40)
        .count();
    if informative < 2 {
        return None;
    }
    // Solve α from ref = α·top + (1−α)·white per channel where top != white.
    let mut alphas: Vec<f64> = Vec::new();
    for ch in 0..3 {
        let t = top[ch] as f64;
        let b = bot[ch] as f64;
        let denom = t - 255.0; // (1−α)·white term uses white=255
        if denom.abs() < 40.0 {
            continue; // this channel is ~white in the candidate -> uninformative
        }
        alphas.push((b - 255.0) / denom);
    }
    if alphas.len() < 2 {
        return None;
    }
    let mean = alphas.iter().sum::<f64>() / alphas.len() as f64;
    let spread = alphas.iter().map(|a| (a - mean).abs()).fold(0.0, f64::max);
    if spread > 0.06 || !(0.15..=0.85).contains(&mean) {
        return None; // channels disagree, or α is degenerate -> not a clean blend
    }
    // Reconstruction check: the recovered α must rebuild the reference modal from
    // the candidate modal to within a tight per-channel error. This is what a
    // recolour/layout region FAILS — its modal pair does not lie on a white-blend
    // line — so it falls back to ColorValue (best-effort, honest).
    let max_recon_err = (0..3)
        .map(|ch| {
            let recon = mean * top[ch] as f64 + (1.0 - mean) * 255.0;
            (recon - bot[ch] as f64).abs()
        })
        .fold(0.0, f64::max);
    if max_recon_err > 10.0 {
        return None;
    }
    Some((mean * 100.0).round() / 100.0)
}

/// Whether the region's ColorErr pixels fit an sRGB↔linear (gamma ~2.2/0.45)
/// transform markedly better than identity — the gradient/blend colour-space
/// drift. Best-effort: a coarse residual comparison on the region's sampled
/// pixels; returns false (=> ColorValue) when the gamma fit does not clearly win.
///
/// Hardened (review #6): the old test fired the gamma model on the GREEN channel
/// ALONE and over ANY region, so essentially any "fill rendered too light" neutral
/// recolour was mislabelled ColorSpace ("sRGB vs linear"), misdirecting triage. We
/// now require BOTH:
///   1. the >=3x residual reduction to hold JOINTLY on all of R, G, B (a true gamma
///      drift is a transfer-curve effect on every channel, not just luma), AND
///   2. non-trivial intra-region VARIANCE in the reference (a gamma/colour-space
///      drift is a GRADIENT/blend; a UNIFORM flat fill that merely came out lighter
///      is a ColorValue recolour, not a colour-space mismatch).
fn fit_colorspace(r: &DiffRegion, cand: &RgbaImage, reference: &RgbaImage) -> bool {
    let samples = sample_region_pairs(r, cand, reference, 4096);
    if samples.len() < 16 {
        return false;
    }
    // (1) Gradient gate: the reference must vary across the region. A flat recolour
    // has ~zero variance and is excluded (-> ColorValue). Measured as the per-channel
    // value spread (max−min) of the reference samples; require a meaningful ramp on
    // at least one channel.
    let mut lo = [255i32; 3];
    let mut hi = [0i32; 3];
    for (_, rr) in &samples {
        for ch in 0..3 {
            lo[ch] = lo[ch].min(rr[ch] as i32);
            hi[ch] = hi[ch].max(rr[ch] as i32);
        }
    }
    let ref_spread = (0..3).map(|ch| hi[ch] - lo[ch]).max().unwrap_or(0);
    if ref_spread < 24 {
        return false; // uniform-modal flat fill -> ColorValue, not ColorSpace
    }
    // (2) Per-channel identity vs gamma residual; the gamma model (inverse OETF on
    // the candidate toward linear) must collapse the residual by >=3x on EVERY
    // channel — a one-channel win is a coincidence, not a transfer-curve drift.
    for ch in 0..3 {
        let mut id_res = 0.0_f64;
        let mut gamma_res = 0.0_f64;
        for (c, rr) in &samples {
            let cv = c[ch] as f64 / 255.0;
            let rv = rr[ch] as f64 / 255.0;
            id_res += (cv - rv).powi(2);
            gamma_res += (srgb_eotf(cv) - rv).powi(2);
        }
        if !(gamma_res > 0.0 && id_res >= 3.0 * gamma_res) {
            return false;
        }
    }
    true
}

/// sRGB EOTF (display-encoded -> linear-light), the standard inverse transfer.
#[inline]
fn srgb_eotf(c: f64) -> f64 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// The region's two dominant colours (candidate side `top`, reference side `bot`)
/// and each side's MODAL SHARE (the fraction of sampled pixels the modal bucket
/// holds — a uniformity measure). `None` when there are too few samples.
fn region_modal_colors(
    r: &DiffRegion,
    cand: &RgbaImage,
    reference: &RgbaImage,
) -> Option<([u8; 3], [u8; 3], f64, f64)> {
    type SampleSelector = fn(&([u8; 4], [u8; 4])) -> [u8; 3];

    let samples = sample_region_pairs(r, cand, reference, 4096);
    if samples.len() < 8 {
        return None;
    }
    let n = samples.len() as f64;
    let modal = |sel: SampleSelector| -> ([u8; 3], f64) {
        let mut counts: BTreeMap<[u8; 3], u32> = BTreeMap::new();
        for s in &samples {
            // Quantise to 8-step buckets so small boundary-tone variation does not fragment the mode.
            let q = sel(s).map(|c| (c / 8) * 8 + 4);
            *counts.entry(q).or_insert(0) += 1;
        }
        counts
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .map(|(c, k)| (c, k as f64 / n))
            .unwrap_or(([0, 0, 0], 0.0))
    };
    let (top, top_share) = modal(|(c, _)| [c[0], c[1], c[2]]);
    let (bot, bot_share) = modal(|(_, rr)| [rr[0], rr[1], rr[2]]);
    Some((top, bot, top_share, bot_share))
}

/// Sample up to `cap` (cand,ref) RGBA pairs from the region's differing pixels.
/// The region's `bbox_css` is in CSS px relative to the union crop origin, so we
/// scan the device-px bbox. We do not have the class map here (a region carries
/// only its bbox/magnitude), so we accept any pixel whose cand/ref differ — for a
/// ColorErr-dominant region that is its defining condition (both ink, aligned,
/// colour differs), which keeps the colour sub-classifiers self-contained on the
/// owned region data.
fn sample_region_pairs(
    r: &DiffRegion,
    cand: &RgbaImage,
    reference: &RgbaImage,
    cap: usize,
) -> Vec<([u8; 4], [u8; 4])> {
    let (w, h) = cand.dimensions();
    let x0 = ((r.bbox_css[0] * CSS_PX).floor().max(0.0)) as u32;
    let y0 = ((r.bbox_css[1] * CSS_PX).floor().max(0.0)) as u32;
    let x1 = (((r.bbox_css[2] * CSS_PX).ceil()) as u32).min(w.saturating_sub(1));
    let y1 = (((r.bbox_css[3] * CSS_PX).ceil()) as u32).min(h.saturating_sub(1));
    let mut out = Vec::new();
    for y in y0..=y1 {
        for x in x0..=x1 {
            let c = cand.get_pixel(x, y).0;
            let rr = reference.get_pixel(x, y).0;
            if c != rr {
                out.push((c, rr));
                if out.len() >= cap {
                    return out;
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Primary election & whole-frame helpers
// ---------------------------------------------------------------------------

/// When no component exists, pick the primary class from the strongest aggregate
/// tally signal so a thin-but-real defect still names itself.
fn elect_from_tally(tally: &ClassTally, census: &Census) -> ErrorClass {
    if tally.missing_pct >= tally.extra_pct && tally.missing_pct > 0.0 {
        return ErrorClass::Missing;
    }
    if tally.extra_pct > 0.0 {
        return ErrorClass::Extra;
    }
    if tally.color_pct > 0.0 || census.color > 0 {
        return ErrorClass::ColorValue;
    }
    ErrorClass::ColorValue
}

/// Direct paint-presence class that crosses the same global visual floor used
/// by the verdict. Prefer the larger area; a tie deterministically reports the
/// missing reference paint before extra candidate paint.
fn visible_presence_primary(tally: &ClassTally, regions: &RegionSet) -> Option<ErrorClass> {
    match super::compare::visibility::visible_presence_class(tally, regions) {
        Some(PixelClass::Missing) => Some(ErrorClass::Missing),
        Some(PixelClass::Extra) => Some(ErrorClass::Extra),
        Some(PixelClass::Match | PixelClass::ColorErr) | None => None,
    }
}

// ---------------------------------------------------------------------------
// Pixel-class census for confidence
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Census {
    color: u64,
    missing: u64,
    extra: u64,
    /// ColorErr+Missing+Extra (only exact Match excluded).
    real: u64,
}

impl Census {
    fn of(cm: &ClassMap) -> Census {
        let mut c = Census::default();
        for px in &cm.px {
            match px {
                PixelClass::ColorErr => c.color += 1,
                PixelClass::Missing => c.missing += 1,
                PixelClass::Extra => c.extra += 1,
                PixelClass::Match => {}
            }
        }
        c.real = c.color + c.missing + c.extra;
        c
    }

    /// Real-diff pixel count attributable to an ErrorClass (for `confidence`).
    /// Colour-family classes all draw from same-coordinate ColorErr pixels.
    fn count_of(&self, class: ErrorClass) -> u64 {
        match class {
            ErrorClass::Missing => self.missing,
            ErrorClass::Extra => self.extra,
            ErrorClass::ColorValue
            | ErrorClass::AntialiasCoverage
            | ErrorClass::ColorSpace
            | ErrorClass::AlphaCompositing => self.color,
        }
    }
}

// ===========================================================================
// Headline rule table (spec §2.3) — a PURE function of (class, magnitude).
// ===========================================================================

fn display_measure(value: f64) -> String {
    let magnitude = value.abs();
    if magnitude == 0.0 {
        "0".to_string()
    } else if magnitude < 0.01 {
        format!("{magnitude:.6}")
    } else if magnitude < 0.1 {
        format!("{magnitude:.2}")
    } else {
        format!("{magnitude:.1}")
    }
}

/// Human reason for a (class, magnitude) pair (§2.3). Pure: same inputs => same
/// string. The fixture-level and region-level headlines both go through here.
fn headline_for(primary: ErrorClass, mag: &Magnitude, tally: &ClassTally) -> String {
    match primary {
        ErrorClass::Missing => {
            let pct = if mag.missing_area_pct > 0.0 {
                mag.missing_area_pct
            } else {
                tally.missing_pct
            };
            format!(
                "candidate lacks paint present in reference ({}%)",
                display_measure(pct)
            )
        }
        ErrorClass::Extra => {
            let pct = if mag.extra_area_pct > 0.0 {
                mag.extra_area_pct
            } else {
                tally.extra_pct
            };
            format!(
                "candidate adds paint absent from reference ({}%)",
                display_measure(pct)
            )
        }
        ErrorClass::ColorValue => {
            let [dr, dg, db, da] = mag.modal_drgba;
            if [dr, dg, db] == [0, 0, 0] && da != 0 {
                format!("alpha channel differs (ΔA {})", signed_channel(da))
            } else if mag.modal_drgba == [0, 0, 0, 0] {
                // Per-channel medians can all be zero even though individual
                // pixels differ. Do not print the self-contradictory
                // "recolour ΔRGB(+0,+0,+0)" headline in that case.
                format!("fill colour differs (ΔE {})", display_measure(mag.delta_e))
            } else {
                let channel_delta = drgba_to_note(mag.modal_drgba);
                format!(
                    "fill recolour {channel_delta} (ΔE {})",
                    display_measure(mag.delta_e)
                )
            }
        }
        ErrorClass::AntialiasCoverage => {
            "antialiasing coverage residue on a shared outline".to_string()
        }
        ErrorClass::ColorSpace => {
            "color-space mismatch (sRGB vs linear) — gradient/blend drift".to_string()
        }
        ErrorClass::AlphaCompositing => {
            let a = mag.recovered_alpha.unwrap_or(0.0);
            format!("opacity not composited (got α≈1.0, expected α≈{a:.2})")
        }
    }
}

/// Compact textual note for a modal ΔRGB triple (the per-channel cand−ref delta).
/// Reads as a signed RGB delta so the headline is self-describing without needing
/// the absolute hexes (which the aggregate tally does not retain).
fn signed_channel(value: i16) -> String {
    if value >= 0 {
        format!("+{value}")
    } else {
        value.to_string()
    }
}

fn drgba_to_note(delta: [i16; 4]) -> String {
    let [r, g, b, a] = delta.map(signed_channel);
    if delta[3] == 0 {
        format!("ΔRGB({r},{g},{b})")
    } else {
        format!("ΔRGBA({r},{g},{b},{a})")
    }
}

// ===========================================================================
// Dependency context (diagnostic only; never causal attribution).
// ===========================================================================

/// Record every declared dependency that also fails. This is correlation for
/// prioritization, not proof that the dependency caused this fixture's own diff.
/// The measured diagnosis remains unchanged.
pub(crate) fn compute_dependency_context(results: &mut [FixtureResult]) {
    // id -> (status, feature) snapshot before mutation.
    let mut snap: BTreeMap<String, (Status, String)> = BTreeMap::new();
    for r in results.iter() {
        snap.insert(r.id.clone(), (r.status, r.feature.clone()));
    }
    for r in results.iter_mut() {
        if !r.status.is_failure() {
            r.dependency_context.clear();
            continue;
        }
        let mut failing = Vec::new();
        for d in r.depends_on.iter().chain(r.base_ids.iter()) {
            if let Some((st, feat)) = snap.get(d)
                && st.is_failure()
            {
                failing.push(format!("{feat} (`{d}`)"));
            }
        }
        r.dependency_context = if failing.is_empty() {
            String::new()
        } else {
            format!("DECLARED DEPENDENCIES ALSO FAILING: {}", failing.join(", "))
        };
    }
}

// ===========================================================================
// Unit tests for directly observed color/presence diagnosis.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba, RgbaImage};

    /// A trivial 1x1 class map of a single class — enough for the census-driven
    /// branches (exact-match / confidence) that don't sample region pixels.
    fn class_map(w: u32, h: u32, fill: PixelClass) -> ClassMap {
        ClassMap {
            w,
            h,
            px: vec![fill; (w * h) as usize],
        }
    }

    fn white(w: u32, h: u32) -> RgbaImage {
        ImageBuffer::from_pixel(w, h, Rgba([255, 255, 255, 255]))
    }

    /// A tally with everything quiet (all gates within PASS) except the fields the
    /// caller sets — the common base for the synthetic cases.
    fn quiet_tally() -> ClassTally {
        ClassTally::default()
    }

    /// A region with the given dominant class + magnitude knobs.
    fn region(class: PixelClass, area_pct: f64, de: f64, drgba: [i16; 4]) -> DiffRegion {
        DiffRegion {
            bbox_css: [0.0, 0.0, 1.0, 1.0],
            class,
            area_px: 100,
            longest_span_px: 10,
            area_pct,
            modal_drgba: drgba,
            delta_e: de,
            interior_color_px: if class == PixelClass::ColorErr {
                100
            } else {
                0
            },
            coverage: CoverageEvidence::default(),
            large_color_component_is_balanced: false,
            max_direct_delta_e: 0.0,
        }
    }

    fn region_set(regions: impl IntoIterator<Item = DiffRegion>) -> RegionSet {
        let mut set = RegionSet::default();
        for region in regions {
            set.record(region);
        }
        set
    }

    #[test]
    fn diagnose_identical_pixels_reads_as_exact_match() {
        let cm = class_map(4, 4, PixelClass::Match);
        let tally = quiet_tally();
        let d = diagnose(
            &tally,
            &RegionSet::default(),
            &cm,
            &white(4, 4),
            &white(4, 4),
        );
        assert!(d.primary_class.is_empty());
        assert_eq!(d.headline, "exact pixel match");
        assert_eq!(d.region_count, 0);
        assert!(d.region_examples.is_empty());
    }

    #[test]
    fn diagnose_color_value_reports_drgba_and_delta_e() {
        // A ColorErr-dominant region with a flat modal ΔRGB + ΔE ~3.5 (the
        // #cc0000-vs-#dd0000 band) -> ColorValue with the ΔE in the headline.
        let cm = class_map(6, 6, PixelClass::ColorErr);
        let mut tally = quiet_tally();
        tally.color_pct = 100.0;
        tally.color_de = 3.5;
        tally.modal_drgba = [-17, 0, 0, 0]; // cand darker red than ref
        // White images: the colour sub-classifiers sample no differing pixels, so
        // AlphaCompositing/ColorSpace stay None and we land on ColorValue.
        let r = region(PixelClass::ColorErr, 80.0, 3.5, [-17, 0, 0, 0]);
        let d = diagnose(&tally, &region_set([r]), &cm, &white(6, 6), &white(6, 6));
        assert_eq!(
            d.primary_class, "ColorValue",
            "a flat recolour => ColorValue"
        );
        assert!(
            d.headline.contains("ΔE 3.5"),
            "headline must carry ΔE, got: {}",
            d.headline
        );
        assert!(
            d.headline.contains("ΔRGB(-17"),
            "headline must carry the modal ΔRGB, got: {}",
            d.headline
        );
        assert!(
            (d.confidence - 1.0).abs() < 1e-9,
            "all real-diff px are ColorErr => confidence 1.0"
        );
    }

    #[test]
    fn diagnose_color_value_does_not_claim_a_zero_rgb_recolour() {
        let tally = quiet_tally();
        let magnitude = Magnitude {
            modal_drgba: [0, 0, 0, 0],
            delta_e: 0.4,
            ..Magnitude::default()
        };
        let headline = headline_for(ErrorClass::ColorValue, &magnitude, &tally);
        assert_eq!(headline, "fill colour differs (ΔE 0.4)");
        assert!(!headline.contains("ΔRGB(+0,+0,+0)"));
    }

    #[test]
    fn diagnose_shared_outline_coverage_never_claims_a_color_space_mismatch() {
        let cm = class_map(6, 6, PixelClass::ColorErr);
        let mut tally = quiet_tally();
        tally.color_pct = 2.0;
        tally.color_de = 12.0;
        let mut r = region(PixelClass::ColorErr, 2.0, 12.0, [16, 16, 16, 0]);
        r.coverage.shared_color_ramp = true;

        let diagnosis = diagnose(&tally, &region_set([r]), &cm, &white(6, 6), &white(6, 6));
        assert_eq!(diagnosis.primary_class, "AntialiasCoverage");
        assert!(diagnosis.headline.contains("shared outline"));
        assert!(diagnosis.magnitude.colorspace.is_none());
    }

    #[test]
    fn diagnose_visible_extra_paint_outranks_a_mixed_region_colour_class() {
        // The representative colour component and a separate visible Extra
        // component must make the report lead with Extra rather than colour.
        let mut cm = class_map(20, 20, PixelClass::ColorErr);
        cm.px[..100].fill(PixelClass::Extra);
        let mut tally = quiet_tally();
        tally.extra_px = 100;
        tally.extra_pct = 5.0;
        tally.color_pct = 50.0;
        tally.color_de = 3.0;
        let color_region = region(PixelClass::ColorErr, 90.0, 3.0, [-10, 0, 0, 0]);
        let extra_region = region(PixelClass::Extra, 10.0, 0.0, [0, 0, 0, 0]);

        let d = diagnose(
            &tally,
            &region_set([color_region, extra_region]),
            &cm,
            &white(20, 20),
            &white(20, 20),
        );

        assert_eq!(d.primary_class, "Extra");
        assert_eq!(
            d.headline,
            "candidate adds paint absent from reference (5.0%)"
        );
        assert!(d.secondary.contains(&"ColorValue".to_string()));
    }

    #[test]
    fn diagnose_colorspace_fit_detects_gamma_drift() {
        // A ColorErr-dominant region whose candidate is the sRGB-OETF (display)
        // encoding of a ramp the reference paints LINEARLY — the classic gamma /
        // colour-space drift. fit_colorspace must reduce the residual >=3x under the
        // inverse-OETF model and elect ColorSpace (the cheap full sub-classifier).
        let (w, h) = (64u32, 16u32);
        let mut cand = white(w, h);
        let mut reference = white(w, h);
        for x in 0..w {
            let t = x as f64 / (w as f64 - 1.0); // 0..1 ramp
            let lin = (t * 255.0).round() as u8; // reference: linear value
            // candidate: same intensity re-encoded through the sRGB OETF.
            let enc = if t <= 0.0031308 {
                t * 12.92
            } else {
                1.055 * t.powf(1.0 / 2.4) - 0.055
            };
            let dis = (enc * 255.0).round().clamp(0.0, 255.0) as u8;
            for y in 0..h {
                reference.put_pixel(x, y, Rgba([lin, lin, lin, 255]));
                cand.put_pixel(x, y, Rgba([dis, dis, dis, 255]));
            }
        }
        let cm = class_map(w, h, PixelClass::ColorErr);
        let mut tally = quiet_tally();
        tally.color_pct = 100.0;
        tally.color_de = 8.0;
        // A region spanning the whole ramp (bbox in CSS px; sample_region_pairs maps
        // back to device px via CSS_PX).
        use super::super::config::CSS_PX;
        let r = DiffRegion {
            bbox_css: [0.0, 0.0, (w - 1) as f64 / CSS_PX, (h - 1) as f64 / CSS_PX],
            class: PixelClass::ColorErr,
            area_px: w * h,
            longest_span_px: w.max(h),
            area_pct: 90.0,
            modal_drgba: [0, 0, 0, 0],
            delta_e: 8.0,
            interior_color_px: w * h,
            coverage: CoverageEvidence::default(),
            large_color_component_is_balanced: false,
            max_direct_delta_e: 0.0,
        };
        let d = diagnose(&tally, &region_set([r]), &cm, &cand, &reference);
        assert_eq!(
            d.primary_class, "ColorSpace",
            "a gamma ramp must read ColorSpace"
        );
        assert!(
            d.headline.contains("color-space mismatch"),
            "headline must name the colour-space mismatch, got: {}",
            d.headline
        );
        assert_eq!(
            d.magnitude.colorspace.as_deref(),
            Some("sRGB↔linear"),
            "magnitude must tag the fit"
        );
    }

    #[test]
    fn failing_dependencies_are_context_not_a_rewritten_cause() {
        let mut target = FixtureResult {
            id: "target".into(),
            category: "c".into(),
            feature: "f".into(),
            subfeature: String::new(),
            interaction_of: Vec::new(),
            base_ids: Vec::new(),
            status: Status::Fail,
            diff_pct: 50.0,
            semantic_diff_pct: 50.0,
            description: String::new(),
            note: String::new(),
            kind: "feature".into(),
            depends_on: vec!["probe-x".into()],
            expected_support: "implemented".into(),
            oracle: "chrome".into(),
            reference: Default::default(),
            dependency_context: String::new(),
            html_sha256: String::new(),
            raster: Default::default(),
            diagnosis: Some(Diagnosis {
                primary_class: "Missing".into(),
                headline: "candidate lacks paint present in reference (100.0%)".into(),
                ..Diagnosis::default()
            }),
        };
        let probe = FixtureResult {
            id: "probe-x".into(),
            category: "c".into(),
            feature: "probe".into(),
            subfeature: String::new(),
            interaction_of: Vec::new(),
            base_ids: Vec::new(),
            status: Status::Fail, // the substrate is itself broken
            diff_pct: 90.0,
            semantic_diff_pct: 90.0,
            description: String::new(),
            note: String::new(),
            kind: "probe".into(),
            depends_on: Vec::new(),
            expected_support: "implemented".into(),
            oracle: "chrome".into(),
            reference: Default::default(),
            dependency_context: String::new(),
            html_sha256: String::new(),
            raster: Default::default(),
            diagnosis: None,
        };
        let mut results = vec![target.clone(), probe];
        compute_dependency_context(&mut results);
        let t = &results[0];
        assert_eq!(
            t.dependency_context,
            "DECLARED DEPENDENCIES ALSO FAILING: probe (`probe-x`)"
        );
        let h = &t.diagnosis.as_ref().unwrap().headline;
        assert_eq!(h, "candidate lacks paint present in reference (100.0%)");
        let _ = &mut target;
    }
}
