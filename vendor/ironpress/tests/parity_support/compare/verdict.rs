//! Same-coordinate human-visibility verdict.
//!
//! Raw RGBA inequality is never discarded: it is measured and reported in full.
//! The verdict asks the narrower product question: would the remaining error be
//! visible at the authored CSS scale? It never translates, registers, crops, or
//! fixture-tunes either image.

use super::super::config::{
    VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS, VISUAL_COLOR_JND, VISUAL_EDGE_COLOR_PCT,
};
use super::super::report::Status;
use super::classify::PixelClass;
use super::segment::RegionSet;
use super::tally::ClassTally;

pub(crate) struct Verdict {
    pub(crate) status: Status,
    pub(crate) diff_pct: f64,
    pub(crate) dominant_class: PixelClass,
}

/// Apply the fixed visibility policy to the direct 300-DPI evidence.
pub(crate) fn verdict(
    raw: (&ClassTally, &RegionSet),
    visibility: (&ClassTally, &RegionSet),
    exact_page_match: bool,
    visible_page_canvas_difference: bool,
) -> Verdict {
    let (raw_tally, raw_regions) = raw;
    let (visibility_tally, visibility_regions) = visibility;
    let dominant_class = elect_dominant(raw_regions);
    let status = if !visible_page_canvas_difference
        && (exact_page_match
            || !visible_difference(raw_tally, visibility_tally, visibility_regions))
    {
        Status::Pass
    } else {
        Status::Fail
    };

    // `diff_pct` placeholder (overwritten by compare_v2 with the exact value).
    let diff_pct = (raw_tally.color_pct + raw_tally.missing_pct + raw_tally.extra_pct).min(100.0);

    Verdict {
        status,
        diff_pct,
        dominant_class,
    }
}

fn visible_difference(
    raw_tally: &ClassTally,
    visibility_tally: &ClassTally,
    visibility_regions: &RegionSet,
) -> bool {
    if super::visibility::is_mixed_coverage_phase(visibility_tally, visibility_regions)
        || super::visibility::is_conserved_sub_css_coverage_phase(
            visibility_tally,
            visibility_regions,
        )
        || super::visibility::is_one_sided_sub_css_coverage_phase(
            visibility_tally,
            visibility_regions,
        )
        || super::visibility::is_stable_shared_outline_phase(visibility_tally, visibility_regions)
    {
        return false;
    }
    visible_presence_difference(visibility_tally, visibility_regions)
        || visible_color_difference(raw_tally, visibility_tally, visibility_regions)
}

fn visible_presence_difference(tally: &ClassTally, regions: &RegionSet) -> bool {
    super::visibility::visible_presence_class(tally, regions).is_some()
}

fn visible_color_difference(
    raw_tally: &ClassTally,
    visibility_tally: &ClassTally,
    visibility_regions: &RegionSet,
) -> bool {
    if visibility_tally.color_px == 0 {
        return false;
    }

    if visibility_regions.shared_coverage_color_with_compact_remainder() {
        return false;
    }
    if visibility_regions.only_coherent_sub_authored_color_frontiers() {
        return false;
    }

    // A solid semantic recolour remains visible regardless of any larger field
    // of tolerated rounding. A direct shared-endpoint ramp is checked first
    // because its topology is stronger than the structural edge mask: a
    // one-device-pixel rectangular edge can otherwise be mislabeled interior.
    if super::visibility::has_visible_interior_recolor(visibility_tally) {
        return true;
    }
    // Boundary-only residuals use the mean ΔE of the complete raw ColorErr
    // field. Deleting correct one-code-value samples from that mean would
    // artificially magnify sparse raster-edge extrema.
    if raw_tally.color_de <= VISUAL_COLOR_JND {
        return false;
    }

    if super::visibility::is_predominantly_shared_coverage_phase(
        visibility_tally,
        visibility_regions,
    ) {
        return false;
    }

    if is_balanced_edge_coverage(visibility_tally) {
        return false;
    }

    visibility_tally.color_pct > VISUAL_EDGE_COLOR_PCT
        || super::visibility::has_visible_unproven_color_change(
            visibility_tally,
            visibility_regions,
        )
}

/// A page-wide colour error can be an imperceptible outline phase only if it
/// contains no solid interior recolour and its positive and negative coverage
/// energy nearly cancels. This evaluates the original, same-coordinate pixels;
/// it neither shifts nor filters either raster.
pub(crate) fn is_balanced_edge_coverage(tally: &ClassTally) -> bool {
    !super::visibility::has_visible_interior_recolor(tally)
        && tally.color_coverage_bias <= VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS
        && tally.color_components_are_balanced
        && tally.color_errors_have_css_anchors
}

/// The dominant directly observed class: largest component, then
/// Missing > Extra > ColorErr for deterministic ties.
fn elect_dominant(regions: &RegionSet) -> PixelClass {
    let mut best = None;
    for aggregate in &regions.aggregates {
        best = match best {
            None => Some(aggregate),
            Some(current) => {
                if aggregate.largest_area_px > current.largest_area_px
                    || (aggregate.largest_area_px == current.largest_area_px
                        && severity(aggregate.class) > severity(current.class))
                {
                    Some(aggregate)
                } else {
                    Some(current)
                }
            }
        };
    }
    best.map(|aggregate| aggregate.class)
        .unwrap_or(PixelClass::Match)
}

#[inline]
fn severity(c: PixelClass) -> u8 {
    match c {
        PixelClass::Missing => 5,
        PixelClass::Extra => 4,
        PixelClass::ColorErr => 3,
        PixelClass::Match => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::config::VISUAL_INTERIOR_COLOR_PCT;
    use super::super::visibility::has_visible_interior_recolor;
    use super::*;

    #[test]
    fn sub_jnd_interior_residue_is_not_a_visible_recolor() {
        let tally = ClassTally {
            interior_color_de: VISUAL_COLOR_JND - 0.01,
            interior_color_pct: 1.0,
            ..Default::default()
        };

        assert!(!has_visible_interior_recolor(&tally));
    }

    #[test]
    fn per_pixel_sub_one_percent_color_residue_is_not_visible() {
        let within_tolerance = ClassTally {
            color_px: 10,
            color_pct: 10.0,
            color_de: VISUAL_COLOR_JND + 20.0,
            interior_color_pct: 10.0,
            interior_color_de: VISUAL_COLOR_JND + 20.0,
            ..Default::default()
        };
        let above_tolerance = ClassTally {
            color_above_channel_tolerance_px: 1,
            color_above_channel_tolerance_pct: VISUAL_EDGE_COLOR_PCT + 0.001,
            ..within_tolerance
        };

        assert!(!visible_color_difference(
            &within_tolerance,
            &ClassTally::default(),
            &RegionSet::default(),
        ));
        assert!(visible_color_difference(
            &above_tolerance,
            &above_tolerance,
            &RegionSet::default(),
        ));
    }

    #[test]
    fn visible_interior_recolor_needs_both_contrast_and_coverage() {
        let visible = ClassTally {
            interior_color_de: VISUAL_COLOR_JND + 0.01,
            interior_color_pct: VISUAL_INTERIOR_COLOR_PCT + 0.001,
            ..Default::default()
        };
        let sparse = ClassTally {
            interior_color_pct: VISUAL_INTERIOR_COLOR_PCT - 0.001,
            ..visible
        };

        assert!(has_visible_interior_recolor(&visible));
        assert!(!has_visible_interior_recolor(&sparse));
    }

    #[test]
    fn balanced_edge_coverage_is_not_a_solid_recolor() {
        let balanced = ClassTally {
            color_pct: 3.0,
            color_de: VISUAL_COLOR_JND + 1.0,
            interior_color_de: VISUAL_COLOR_JND + 1.0,
            interior_color_pct: VISUAL_INTERIOR_COLOR_PCT,
            color_coverage_bias: VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS,
            color_components_are_balanced: true,
            color_errors_have_css_anchors: true,
            ..Default::default()
        };
        let biased = ClassTally {
            color_coverage_bias: VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS + 0.001,
            ..balanced
        };

        assert!(is_balanced_edge_coverage(&balanced));
        assert!(!is_balanced_edge_coverage(&biased));

        let unbalanced_component = ClassTally {
            color_components_are_balanced: false,
            ..balanced
        };
        assert!(!is_balanced_edge_coverage(&unbalanced_component));

        let visible_interior = ClassTally {
            interior_color_pct: VISUAL_INTERIOR_COLOR_PCT + 0.001,
            ..balanced
        };
        assert!(!is_balanced_edge_coverage(&visible_interior));
    }

    #[test]
    fn sparse_edge_only_colour_residue_uses_the_fixed_coverage_floor() {
        let at_limit = ClassTally {
            color_px: 1,
            color_pct: VISUAL_EDGE_COLOR_PCT,
            color_above_channel_tolerance_px: 1,
            color_above_channel_tolerance_pct: VISUAL_EDGE_COLOR_PCT,
            color_de: VISUAL_COLOR_JND + 1.0,
            ..Default::default()
        };
        let over_limit = ClassTally {
            color_pct: VISUAL_EDGE_COLOR_PCT + 0.001,
            color_above_channel_tolerance_pct: VISUAL_EDGE_COLOR_PCT + 0.001,
            ..at_limit
        };

        assert!(!visible_color_difference(
            &at_limit,
            &at_limit,
            &RegionSet::default()
        ));
        assert!(visible_color_difference(
            &over_limit,
            &over_limit,
            &RegionSet::default()
        ));
    }
}
