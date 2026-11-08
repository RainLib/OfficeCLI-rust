//! Fixed, same-coordinate human-visibility rules shared by the verdict and
//! diagnosis. Raw differences stay intact; these functions only answer whether
//! a direct Missing/Extra paint difference is perceptible at CSS scale.

use super::super::config::{
    CSS_PX, VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS, VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS,
    VISUAL_COLOR_JND, VISUAL_EDGE_PRESENCE_PCT, VISUAL_INTERIOR_COLOR_PCT,
    VISUAL_MIXED_COVERAGE_MAX_BALANCE_BIAS, VISUAL_MIXED_COVERAGE_MAX_INTERIOR_COLOR_PCT,
    VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT, VISUAL_MIXED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO,
    VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT,
    VISUAL_ONE_SIDED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO,
    VISUAL_ONE_SIDED_COVERAGE_MIN_SHARED_CONTENT_RATIO, VISUAL_PREDOMINANT_RAMP_MAX_BIAS,
    VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2, VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX,
    VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2, VISUAL_STABLE_OUTLINE_MIN_SHARED_CONTENT_RATIO,
};
use super::classify::PixelClass;
use super::segment::RegionSet;
use super::tally::ClassTally;

/// Whether every direct paint-presence residual has the signature of a
/// sub-pixel coverage phase across a shared coloured outline.
///
/// This remains entirely in the original raster coordinates. It neither moves
/// an image nor looks for a nearby replacement pixel: it requires balanced
/// Missing/Extra mass, at least twice as much overlapping ColorErr evidence,
/// sub-CSS shared-outline presence bands, and a shared-endpoint colour ramp.
/// Its signed colour energy must be balanced or preserve its hue across the
/// ramp. That makes a missing word, a binary or chromatic swap, a long shifted
/// rule, and a solid recolour ineligible while accepting only directly observed
/// PDF outline phase.
pub(crate) fn is_mixed_coverage_phase(tally: &ClassTally, regions: &RegionSet) -> bool {
    let presence = tally.missing_px.saturating_add(tally.extra_px);
    if tally.missing_px == 0 || tally.extra_px == 0 || presence == 0 {
        return false;
    }

    let balance_bias = tally.missing_px.abs_diff(tally.extra_px) as f64 / presence as f64;
    let max_component_px = VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2 * CSS_PX * CSS_PX;
    let max_span_px = VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX * CSS_PX;
    let color_dominates = tally.color_px as f64
        >= VISUAL_MIXED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO * presence as f64;
    let shared_presence_bands = regions.only_sub_css_coverage_presence_residues();
    let shared_colour_ramp = regions.shared_coverage_color_with_compact_remainder();
    let balanced_colour_coverage = tally.color_coverage_bias <= VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS
        && tally.color_components_are_balanced;
    // A subdevice text-baseline phase can change the amount of black coverage
    // more on one side than the other. It remains in raw evidence, but a
    // hue-preserving residual can compensate for baseline coverage energy that
    // is not numerically balanced. It never replaces the shared-ramp proof:
    // a neutral or same-hue recolour without that topology remains visible.
    let hue_preserving_coverage_phase = tally.color_errors_preserve_hue;
    balance_bias <= VISUAL_MIXED_COVERAGE_MAX_BALANCE_BIAS
        && tally.missing_pct <= VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT
        && tally.extra_pct <= VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT
        && color_dominates
        && tally.interior_color_pct <= VISUAL_MIXED_COVERAGE_MAX_INTERIOR_COLOR_PCT
        && tally.color_errors_have_css_anchors
        && shared_presence_bands
        && shared_colour_ramp
        && (balanced_colour_coverage || hue_preserving_coverage_phase)
        && f64::from(regions.largest_area(PixelClass::Missing)) < max_component_px
        && f64::from(regions.largest_area(PixelClass::Extra)) < max_component_px
        && f64::from(regions.largest_span(PixelClass::Missing)) <= max_span_px
        && f64::from(regions.largest_span(PixelClass::Extra)) <= max_span_px
}

/// Whether the rasters conserve every exact RGBA sample and differ only along
/// shared sub-CSS contours.
///
/// This proves a device-grid phase without translating or registering either
/// image. Requiring overlapping ColorErr evidence rejects a binary shape move;
/// requiring no interior colour error rejects an equal-area colour swap.
pub(crate) fn is_conserved_sub_css_coverage_phase(tally: &ClassTally, regions: &RegionSet) -> bool {
    tally.color_px > 0
        && tally.missing_px > 0
        && tally.extra_px > 0
        && tally.rgba_histograms_match
        && tally.interior_color_pct == 0.0
        && tally.color_errors_have_css_anchors
        && regions.only_sub_css_coverage_presence_residues()
}

/// Whether one renderer assigns a fractional shared outline wholly to one
/// side of the paper/content threshold.
///
/// A same-coordinate antialias ramp need not produce paired Missing and Extra
/// pixels: a slightly darker coverage phase can leave only Extra plus ColorErr.
/// It remains imperceptible when the solid interior is byte-identical, every
/// presence sample is a directly proven sub-CSS contour, and a strict majority
/// of the colour field lies on unchanged local endpoint ramps. A one-CSS-pixel
/// expansion, an absent thin rule, or a recoloured interior cannot satisfy
/// these constraints.
pub(crate) fn is_one_sided_sub_css_coverage_phase(tally: &ClassTally, regions: &RegionSet) -> bool {
    let presence = tally.missing_px.saturating_add(tally.extra_px);
    let one_sided_presence = (tally.missing_px == 0) != (tally.extra_px == 0);
    tally.color_px > 0
        && one_sided_presence
        && tally.shared_content_ratio >= VISUAL_ONE_SIDED_COVERAGE_MIN_SHARED_CONTENT_RATIO
        && tally.missing_pct <= VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT
        && tally.extra_pct <= VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT
        && tally.color_px as f64
            >= VISUAL_ONE_SIDED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO * presence as f64
        && tally.presence_outside_edge_band_px == 0
        && tally.interior_color_pct == 0.0
        && tally.color_errors_have_css_anchors
        && regions.only_sub_css_coverage_presence_residues()
        && regions.predominantly_shared_coverage_color()
}

/// Whether all solid interiors agree and direct shared-endpoint samples prove
/// that the remaining colour mismatch is predominantly boundary coverage.
/// Presence errors are evaluated independently, so a missing or relocated
/// stroke cannot borrow this colour-only acceptance.
pub(crate) fn is_predominantly_shared_coverage_phase(
    tally: &ClassTally,
    regions: &RegionSet,
) -> bool {
    tally.color_px > 0
        && !has_visible_interior_recolor(tally)
        && tally.color_coverage_bias <= VISUAL_PREDOMINANT_RAMP_MAX_BIAS
        && regions.predominantly_shared_coverage_color()
}

/// Whether a solid, interior colour change is visible at authored CSS scale.
///
/// Raw `ColorErr` classification is deliberately byte-exact, so PDF encoding
/// can leave an interior residue even when its contrast or area is below the
/// visibility floor. That residue remains in the report but does not invalidate
/// an otherwise direct shared-coverage proof.
pub(crate) fn has_visible_interior_recolor(tally: &ClassTally) -> bool {
    tally.interior_color_de > VISUAL_COLOR_JND
        && tally.interior_color_pct > VISUAL_INTERIOR_COLOR_PCT
}

/// Whether endpoint-less colour evidence forms a readable authored-scale mark.
///
/// A boundary mask is not proof of antialias coverage: glyphs, borders, and
/// overlap frontiers are themselves boundaries. Once the explicit shared-ramp
/// paths have declined a colour field, its component area and span decide
/// whether it forms an authored-scale mark. The complete-page post-floor
/// percentage is enforced separately, so disconnected sub-CSS samples must not
/// be summed into a fictitious visible component. This rejects mangled text,
/// chromatic glyph swaps, and wrong paint order without turning isolated
/// device-pixel noise into failures.
pub(crate) fn has_visible_unproven_color_change(tally: &ClassTally, regions: &RegionSet) -> bool {
    if tally.color_de <= VISUAL_COLOR_JND {
        return false;
    }

    let component_pixels = VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2 * CSS_PX * CSS_PX;
    let component_span_pixels = VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX * CSS_PX;

    f64::from(regions.largest_area(PixelClass::ColorErr)) >= component_pixels
        || f64::from(regions.largest_span(PixelClass::ColorErr)) >= component_span_pixels
}

/// Apply the fixed authored-space policy to direct 300-DPI evidence.
pub(crate) fn visible_presence_class(
    tally: &ClassTally,
    regions: &RegionSet,
) -> Option<PixelClass> {
    if is_mixed_coverage_phase(tally, regions)
        || is_conserved_sub_css_coverage_phase(tally, regions)
        || is_one_sided_sub_css_coverage_phase(tally, regions)
        || is_stable_shared_outline_phase(tally, regions)
    {
        return None;
    }
    let missing = visible_class(
        PixelClass::Missing,
        tally.missing_px,
        tally.missing_pct,
        regions.largest_area(PixelClass::Missing),
        regions.largest_span(PixelClass::Missing),
        tally.extra_px,
        regions,
    );
    let extra = visible_class(
        PixelClass::Extra,
        tally.extra_px,
        tally.extra_pct,
        regions.largest_area(PixelClass::Extra),
        regions.largest_span(PixelClass::Extra),
        tally.missing_px,
        regions,
    );
    match (missing, extra) {
        (true, true) if tally.missing_px >= tally.extra_px => Some(PixelClass::Missing),
        (true, true) => Some(PixelClass::Extra),
        (true, false) => Some(PixelClass::Missing),
        (false, true) => Some(PixelClass::Extra),
        (false, false) => None,
    }
}

/// Whether paired paint-presence evidence is only a narrow device-grid phase
/// around a substantially unchanged painted shape.
///
/// Unlike registration, this uses only exact same-coordinate shared pixels and
/// the already-proven local outline topology. A relocated thin rule or glyph
/// has no sufficiently large unchanged interior and remains a failure.
pub(crate) fn is_stable_shared_outline_phase(tally: &ClassTally, regions: &RegionSet) -> bool {
    let presence = tally.missing_px.saturating_add(tally.extra_px);
    let complete_sub_css_outline = regions.only_sub_css_coverage_presence_residues();
    let low_contrast_fragmented_outline =
        tally.color_px >= presence.saturating_mul(2) && tally.color_de <= VISUAL_COLOR_JND;
    // A curved PDF path can fragment the threshold-crossing presence class at
    // a dash endpoint even though the overlapping samples still directly prove
    // one shared-endpoint coverage ramp. Keep that case topology-bound: the
    // proven ramp must dominate both presence signs, preserve the paint colour,
    // and leave no visible interior recolour. Missing paint, an interior cut,
    // and a one-CSS-pixel displacement cannot borrow this branch.
    let shared_ramp_dominated_outline = tally.color_px >= presence.saturating_mul(2)
        && is_predominantly_shared_coverage_phase(tally, regions);

    tally.missing_px > 0
        && tally.extra_px > 0
        && tally.shared_content_ratio >= VISUAL_STABLE_OUTLINE_MIN_SHARED_CONTENT_RATIO
        && tally.presence_outside_edge_band_px == 0
        && tally.interior_color_pct <= VISUAL_INTERIOR_COLOR_PCT
        && (tally.color_px == 0 || tally.color_errors_have_css_anchors)
        && (complete_sub_css_outline
            || low_contrast_fragmented_outline
            || shared_ramp_dominated_outline)
}

fn visible_class(
    class: PixelClass,
    total_px: u64,
    total_content_pct: f64,
    largest_component_px: u32,
    largest_span_px: u32,
    opposing_total_px: u64,
    regions: &RegionSet,
) -> bool {
    let mut total_px = total_px;
    let mut total_content_pct = total_content_pct;
    let mut largest_component_px = largest_component_px;
    let mut largest_span_px = largest_span_px;
    let mut region_count = regions.region_count(class);
    let sub_css_with_compact_remainder =
        regions.only_sub_css_presence_with_compact_remainder(class);

    // Long outlines can carry much raw area while every local normal remains
    // exactly one physical pixel thick. Remove those independently proven
    // shared edges before budgeting the remaining contours. Short glyph stems
    // never enter this remainder path.
    if opposing_total_px > 0 {
        let remainder = regions.presence_without_long_device_edges(class);
        if total_px > 0 {
            total_content_pct *= remainder.total_area_px as f64 / total_px as f64;
        }
        total_px = remainder.total_area_px;
        largest_component_px = remainder.largest_area_px;
        largest_span_px = remainder.largest_span_px;
        region_count = remainder.region_count;
        if total_px == 0 {
            return false;
        }
    }

    let component_pixels = VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2 * CSS_PX * CSS_PX;
    let component_span_pixels = VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX * CSS_PX;
    let total_pixels = VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2 * CSS_PX * CSS_PX;
    let crosses_presence_floor = f64::from(largest_component_px) >= component_pixels
        || (opposing_total_px == 0 && f64::from(largest_span_px) >= component_span_pixels)
        || total_px as f64 >= total_pixels;
    // A same-coordinate proof of a sub-CSS contour between shared paper and
    // shared content is a fractional edge phase at the pinned resolution, even
    // when that contour is long. Its percentage of a narrow painted shape says
    // nothing about its physical thickness. An absent rule, an interior cut,
    // or a relocated one-device-pixel glyph cannot meet this topology proof.
    // Unpaired evidence remains topology-bound: a sub-CSS band must directly
    // separate shared paper from shared paint. Unlike a device-pixel cutoff,
    // this authored-space proof remains stable when the diagnostic DPI changes.
    let shared_coverage_residue = if opposing_total_px == 0 {
        sub_css_with_compact_remainder
    } else {
        sub_css_with_compact_remainder
            && (total_content_pct <= VISUAL_EDGE_PRESENCE_PCT
                || region_count <= VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS)
    };

    // The topology proof is same-coordinate only: it never shifts, crops, or
    // substitutes either raster. An absent stroke, a one-CSS-pixel strip, or an
    // interior cut cannot satisfy it.
    crosses_presence_floor && !shared_coverage_residue
}

#[cfg(test)]
mod tests {
    use super::super::segment::{CoverageEvidence, DiffRegion};
    use super::*;

    fn unproven_color_fragment(index: u32) -> DiffRegion {
        let x = f64::from(index * 2) / CSS_PX;
        DiffRegion {
            bbox_css: [x, 0.0, x + 3.0 / CSS_PX, 0.0],
            class: PixelClass::ColorErr,
            area_px: 4,
            longest_span_px: 4,
            area_pct: 0.0,
            modal_drgba: [48, 48, 48, 0],
            delta_e: VISUAL_COLOR_JND + 1.0,
            interior_color_px: 0,
            coverage: CoverageEvidence::default(),
            large_color_component_is_balanced: false,
            max_direct_delta_e: VISUAL_COLOR_JND + 1.0,
        }
    }

    #[test]
    fn disconnected_sub_css_color_fragments_do_not_form_a_visible_component() {
        let mut regions = RegionSet::default();
        for index in 0..147 {
            regions.record(unproven_color_fragment(index));
        }
        let tally = ClassTally {
            color_px: 147 * 4,
            color_de: VISUAL_COLOR_JND + 1.0,
            ..Default::default()
        };

        assert!(
            !has_visible_unproven_color_change(&tally, &regions),
            "post-floor samples below every component and span floor are not an authored-scale defect"
        );
    }

    #[test]
    fn one_authored_scale_color_component_remains_visible() {
        let mut regions = RegionSet::default();
        let component_side = (VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2.sqrt() * CSS_PX).ceil() as u32;
        let mut component = unproven_color_fragment(0);
        component.area_px = component_side * component_side;
        component.longest_span_px = component_side;
        regions.record(component);
        let tally = ClassTally {
            color_px: u64::from(component_side * component_side),
            color_de: VISUAL_COLOR_JND + 1.0,
            ..Default::default()
        };

        assert!(has_visible_unproven_color_change(&tally, &regions));
    }
}
