//! The comparator (V2 — the only verdict path).
//!
//! A diagnostic multi-detector pipeline split into single-responsibility
//! submodules: `color` (ΔE2000), `masks` (structural edge context), `classify`
//! (same-coordinate `PixelClass`), `segment` (connected diff
//! regions), `tally` (per-class diagnostic aggregation), and `verdict`
//! (human-visible parity). Diagnostics never search nearby pixels or register one image
//! against the other.

use image::{ImageBuffer, Rgba, RgbaImage};

use super::report::Status;

// V2 submodules (spec §4). Each is a plain owned-value stage of the pipeline.
pub(crate) mod classify;
pub(crate) mod color;
pub(crate) mod masks;
pub(crate) mod segment;
pub(crate) mod tally;
pub(crate) mod verdict;
pub(crate) mod visibility;

#[cfg(test)]
mod goldens;

use classify::{classify_pixels, classify_visible_colors};
use segment::segment;
use tally::aggregate;
use verdict::verdict;

pub(crate) use classify::{ClassMap, PixelClass};
pub(crate) use segment::{CoverageEvidence, DiffRegion, RegionSet};
pub(crate) use tally::ClassTally;
pub(crate) use verdict::Verdict;

// ===========================================================================
// V2 ORCHESTRATION (spec §1.2)
// ===========================================================================

use super::geom::{content_bbox, content_mask, crop_rect, difference_bbox, union_bbox};

/// Everything the V2 path produces for one fixture. `status` comes from the
/// human-visibility verdict while `diff_pct` remains an exact raw measurement;
/// `tally`/`regions`/`verdict` carry the diagnostic
/// detail (consumed later by `diagnose`/`overlay`/`report`); `overlay` is the
/// classed diff image written to disk. Owned values only — no borrows escape.
pub(crate) struct V2Outcome {
    pub(crate) status: Status,
    pub(crate) diff_pct: f64,
    /// Complete-page mismatch after only the configured per-pixel RGB channel
    /// tolerance is applied. Unlike `diff_pct`, this excludes semantically
    /// correct one-code-value rounding while retaining same-coordinate shape,
    /// paint-order, and substantive colour errors.
    pub(crate) semantic_diff_pct: f64,
    pub(crate) tally: ClassTally,
    /// Complete region aggregates plus bounded worst-first examples. Consumed by
    /// `diagnose` and the report without allocating one object per checker pixel.
    #[allow(dead_code)]
    pub(crate) regions: RegionSet,
    /// Same-coordinate evidence after only the global per-channel tolerance is
    /// applied. Kept beside raw evidence so diagnostics can explain a verdict
    /// without weakening or replacing the exact report data.
    pub(crate) visibility: VisibilityEvidence,
    pub(crate) verdict: Verdict,
    pub(crate) overlay: RgbaImage,
    /// The "why it failed" diagnosis (spec §2): computed here because this is the
    /// only place that holds the class map + aligned cand/ref the colour/alpha
    /// sub-classifiers need. ADDITIVE — it never feeds back into the verdict.
    pub(crate) diagnosis: super::diagnose::Diagnosis,
}

#[derive(Default)]
pub(crate) struct VisibilityEvidence {
    pub(crate) tally: ClassTally,
    pub(crate) regions: RegionSet,
}

impl V2Outcome {
    /// Preserve a complete page-sized diagnostic artifact while terminating the
    /// comparator before the colour, topology, and diagnosis pipelines. Those
    /// stages cannot add evidence when the direct raster buffers are identical.
    fn exact_match(dimensions: (u32, u32)) -> Self {
        let total_px = u64::from(dimensions.0) * u64::from(dimensions.1);
        Self {
            status: Status::Pass,
            diff_pct: 0.0,
            semantic_diff_pct: 0.0,
            tally: ClassTally {
                total_px,
                ..Default::default()
            },
            regions: RegionSet::default(),
            visibility: VisibilityEvidence::default(),
            verdict: Verdict {
                status: Status::Pass,
                diff_pct: 0.0,
                dominant_class: PixelClass::Match,
            },
            overlay: RgbaImage::from_pixel(dimensions.0, dimensions.1, Rgba([255; 4])),
            diagnosis: super::diagnose::Diagnosis {
                headline: "exact pixel match".to_string(),
                confidence: 1.0,
                visual_pass_basis: "exact raster match".to_string(),
                ..Default::default()
            },
        }
    }
}

/// Expand a page into the shared upper-left canvas without moving or cropping
/// painted pixels. A white surplus is therefore visible to the same-coordinate
/// classifier only when one side actually paints it.
fn white_pad(image: &RgbaImage, dimensions: (u32, u32)) -> RgbaImage {
    let mut padded = ImageBuffer::from_pixel(dimensions.0, dimensions.1, Rgba([255; 4]));
    for (x, y, pixel) in image.enumerate_pixels() {
        padded.put_pixel(x, y, *pixel);
    }
    padded
}

/// Run the §1.2 V2 pipeline over a candidate and reference in shared page space.
///
/// Both images are direct outputs of the same `pdftoppm` invocation and are
/// assumed alpha-flattened over white.
///
/// The displayed difference rate comes directly from the complete raw RGBA
/// buffers. When page canvases differ they are white-padded to their shared
/// upper-left union without resampling or translation. The remaining steps
/// determine human-visible PASS/FAIL from that direct evidence: content
/// masks -> union crop -> same-coordinate classes -> regions -> aggregate
/// severities -> classed overlay.
pub(crate) fn compare_v2(cand: &RgbaImage, reference: &RgbaImage) -> V2Outcome {
    let candidate_dimensions = cand.dimensions();
    let oracle_dimensions = reference.dimensions();
    if candidate_dimensions == oracle_dimensions && cand.as_raw() == reference.as_raw() {
        return V2Outcome::exact_match(candidate_dimensions);
    }
    let shared_dimensions = (
        cand.width().max(reference.width()),
        cand.height().max(reference.height()),
    );
    let padded_candidate;
    let padded_reference;
    let (cand, reference) = if cand.dimensions() == reference.dimensions() {
        (cand, reference)
    } else {
        padded_candidate = white_pad(cand, shared_dimensions);
        padded_reference = white_pad(reference, shared_dimensions);
        (&padded_candidate, &padded_reference)
    };

    // Every raw RGBA byte in the complete shared canvas participates in the
    // evidence. The visibility verdict below may classify a small residual as
    // imperceptible, but never changes this measurement.
    let different_pixels = cand
        .pixels()
        .zip(reference.pixels())
        .filter(|(candidate, oracle)| candidate != oracle)
        .count();
    let page_delta_px = candidate_dimensions
        .0
        .abs_diff(oracle_dimensions.0)
        .max(candidate_dimensions.1.abs_diff(oracle_dimensions.1));
    // One raster pixel at 300 DPI is below one CSS pixel; a larger canvas
    // difference is a visible page-geometry change even when both surplus areas
    // are blank. No content is cropped or shifted to reach this conclusion.
    let visible_page_canvas_difference = f64::from(page_delta_px) > super::config::CSS_PX;
    let page_pixels = u64::from(cand.width()) * u64::from(cand.height());
    let diff_pct = if page_pixels == 0 {
        0.0
    } else {
        100.0 * different_pixels as f64 / page_pixels as f64
    };

    let cand_bb = content_bbox(cand);
    let ref_bb = content_bbox(reference);
    let diff_bb = difference_bbox(cand, reference);

    // Crop only presentation/diagnostic work, never raw measurement work.
    // Including direct difference bounds preserves unequal alpha or near-white
    // pixels even when neither side qualifies as painted content.
    let union = [cand_bb, ref_bb, diff_bb]
        .into_iter()
        .flatten()
        .reduce(union_bbox)
        .unwrap_or((0, 0, 0, 0));

    let cand_u = crop_rect(cand, union);
    let ref_u = crop_rect(reference, union);
    let mask_c = content_mask(&cand_u);
    let mask_r = content_mask(&ref_u);

    let masks = masks::structural_masks(&cand_u, &ref_u);
    let class_map = classify_pixels(&cand_u, &ref_u, &mask_c, &mask_r);
    let regions = segment(&class_map, &cand_u, &ref_u, &masks);
    let tally = aggregate(
        &class_map, &regions, &mask_c, &mask_r, &masks, &cand_u, &ref_u,
    );

    // Visibility is evaluated over a second, same-coordinate class map where
    // only globally tolerated RGB rounding becomes semantic Match. Keeping the
    // raw map and its aggregates separate preserves every exact mismatch in the
    // report while preventing a one-code-value fill residue from disconnecting
    // the visible outline topology around it.
    let visibility_class_map = classify_visible_colors(&class_map, &cand_u, &ref_u);
    let visibility_regions = segment(&visibility_class_map, &cand_u, &ref_u, &masks);
    let visibility_tally = aggregate(
        &visibility_class_map,
        &visibility_regions,
        &mask_c,
        &mask_r,
        &masks,
        &cand_u,
        &ref_u,
    );
    let semantic_diff_pct = if page_pixels == 0 {
        0.0
    } else {
        100.0 * visibility_tally.different_px as f64 / page_pixels as f64
    };
    let mut verdict = verdict(
        (&tally, &regions),
        (&visibility_tally, &visibility_regions),
        false,
        visible_page_canvas_difference,
    );
    // Exact full-page scalar: percentage of pixels with any unequal RGBA byte.
    verdict.diff_pct = diff_pct;
    // The classed-diff overlay (spec §3.3 item 2): a blank full-page canvas
    // with same-coordinate semantic class paint. Only above-floor pixels appear:
    // region frames and the global per-pixel RGB tolerance are absent from this
    // visual artifact; exact RGBA inequality remains in `diff_pct` and region
    // diagnostics remain tabular. Classification works on the compact union, but
    // the artifact is deliberately never cropped.
    let overlay = super::overlay::render_classed_overlay(
        &visibility_class_map,
        shared_dimensions,
        (union.0, union.1),
    );

    // Diagnosis (spec §2). Computed here (the only stage with the class map +
    // aligned cand/ref) but PURELY additive: it reads the same owned products the
    // verdict already produced and can never change `status`/`diff_pct`.
    let mut diagnosis = super::diagnose::diagnose(&tally, &regions, &class_map, &cand_u, &ref_u);
    if verdict.status == Status::Pass {
        let (basis, accepted_coverage) = if visibility::is_conserved_sub_css_coverage_phase(
            &visibility_tally,
            &visibility_regions,
        ) {
            ("CSS-scale observation: conserved sub-CSS coverage", true)
        } else if visibility::is_one_sided_sub_css_coverage_phase(
            &visibility_tally,
            &visibility_regions,
        ) {
            (
                "CSS-scale observation: one-sided sub-CSS outline coverage",
                true,
            )
        } else if visibility::is_stable_shared_outline_phase(&visibility_tally, &visibility_regions)
        {
            (
                "CSS-scale observation: stable same-coordinate outline phase",
                true,
            )
        } else if visibility_regions.only_sub_css_coverage_presence_residues() {
            (
                "CSS-scale observation: sub-CSS shared-outline coverage",
                true,
            )
        } else if visibility_regions.shared_coverage_color_with_compact_remainder() {
            (
                "CSS-scale observation: sub-CSS shared-colour coverage",
                true,
            )
        } else if visibility_regions.only_coherent_sub_authored_color_frontiers() {
            (
                "CSS-scale observation: coherent sub-authored colour frontier",
                true,
            )
        } else if visibility::is_predominantly_shared_coverage_phase(
            &visibility_tally,
            &visibility_regions,
        ) {
            (
                "CSS-scale observation: predominant shared-outline coverage",
                true,
            )
        } else if visibility::is_mixed_coverage_phase(&visibility_tally, &visibility_regions) {
            ("CSS-scale observation: mixed outline coverage", true)
        } else if verdict::is_balanced_edge_coverage(&visibility_tally) {
            ("CSS-scale observation: balanced edge coverage", true)
        } else {
            ("raw same-coordinate visibility policy", false)
        };
        diagnosis.visual_pass_basis = basis.to_string();
        if accepted_coverage {
            diagnosis.headline = format!(
                "visually accepted coverage phase; raw {}",
                diagnosis.headline
            );
        }
    }
    if visible_page_canvas_difference {
        diagnosis.primary_class = "PageSize".to_string();
        diagnosis.headline = format!(
            "visible PDF page-size mismatch: ironpress {:?} != oracle {:?}",
            candidate_dimensions, oracle_dimensions
        );
    }

    V2Outcome {
        status: verdict.status,
        diff_pct,
        semantic_diff_pct,
        tally,
        regions,
        visibility: VisibilityEvidence {
            tally: visibility_tally,
            regions: visibility_regions,
        },
        verdict,
        overlay,
        diagnosis,
    }
}

/// Compare complete PDF page rasters and enforce the report-wide mismatch-area
/// ceiling after the ordinary authored-scale verdict. Comparator golden tests
/// intentionally exercise small diagnostic crops through `compare_v2`; the
/// production parity path always uses this full-page entry point.
pub(crate) fn compare_page_v2(cand: &RgbaImage, reference: &RgbaImage) -> V2Outcome {
    let mut outcome = compare_v2(cand, reference);
    if outcome.status == Status::Pass
        && outcome.semantic_diff_pct > super::config::VISUAL_PASS_MAX_SEMANTIC_DIFF_PCT
    {
        outcome.status = Status::Fail;
        outcome.verdict.status = Status::Fail;
        outcome.diagnosis.visual_pass_basis.clear();
        outcome.diagnosis.headline = format!(
            "above-floor complete-page mismatch {:.6}% exceeds {:.1}% PASS ceiling; {}",
            outcome.semantic_diff_pct,
            super::config::VISUAL_PASS_MAX_SEMANTIC_DIFF_PCT,
            outcome.diagnosis.headline
        );
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_keeps_full_canvas_without_running_semantic_detectors() {
        let page = RgbaImage::from_pixel(19, 23, Rgba([12, 34, 56, 255]));

        let outcome = compare_v2(&page, &page);

        assert_eq!(outcome.status, Status::Pass);
        assert_eq!(outcome.diff_pct, 0.0);
        assert_eq!(outcome.tally.different_px, 0);
        assert_eq!(outcome.tally.total_px, 19 * 23);
        assert_eq!(outcome.regions.total_count, 0);
        assert_eq!(outcome.overlay.dimensions(), page.dimensions());
        assert!(
            outcome
                .overlay
                .pixels()
                .all(|pixel| *pixel == Rgba([255; 4]))
        );
        assert_eq!(outcome.diagnosis.headline, "exact pixel match");
        assert_eq!(outcome.diagnosis.visual_pass_basis, "exact raster match");
    }
}
