//! Region segmentation: a hand-rolled 4-connectivity flood fill over each
//! directly observed same-coordinate class. A ColorErr pixel never joins an
//! adjacent Missing/Extra component merely because it touches it.

use image::RgbaImage;

use super::super::config::{
    COVERAGE_RAMP_CHANNEL_TOLERANCE, CSS_PX, VISUAL_BALANCED_AGGREGATE_RAMP_MIN_PROVEN_RATIO,
    VISUAL_BALANCED_EDGE_COMPONENT_MAX_BIAS, VISUAL_BALANCED_EDGE_COMPONENT_MAX_SPAN_CSS_PX,
    VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2, VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS,
    VISUAL_COLOR_JND, VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO,
    VISUAL_LAYERED_COVERAGE_MAX_DEPTH_CSS_PX, VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2,
    VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX, VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2,
    VISUAL_STRAIGHT_DEVICE_EDGE_MIN_SPAN_CSS_PX, VISUAL_SUB_AUTHORED_COLOR_FRONTIER_MAX_CSS_PX,
    VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_AREA_CSS_PX2,
    VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_TOTAL_CSS_PX2,
};
use super::super::geom::is_content;
use super::classify::{ClassMap, PixelClass};
use super::color::{ColorEnergy, ciede2000, same_colour_family, srgb_to_lab};
use super::masks::StructuralMasks;

/// Keep enough worst-first examples for useful visual diagnosis without letting
/// a checkerboard page allocate one report object per connected pixel. Complete
/// counts and magnitudes live in [`RegionAggregate`] and are never truncated.
pub(crate) const REGION_EXAMPLE_LIMIT: usize = 64;

/// One connected blob of directly observed non-matching pixels.
#[allow(dead_code)]
pub(crate) struct DiffRegion {
    /// Bounding box in CSS px [x0, y0, x1, y1], relative to the union crop origin.
    pub(crate) bbox_css: [f64; 4],
    pub(crate) class: PixelClass,
    pub(crate) area_px: u32,
    /// Longest inclusive pixel span of this exact-class component.
    pub(crate) longest_span_px: u32,
    pub(crate) area_pct: f64,
    /// Median (cand − ref) over the region's `ColorErr` pixels (0..255 signed).
    pub(crate) modal_drgba: [i16; 4],
    /// Median CIEDE2000 over the region's INTERIOR (non-edge-band) `ColorErr`
    /// pixels — the solid-recolour signal. A robust statistic (median, not mean)
    /// so a low-Delta-E boundary fringe cannot dilute a hard recolour core.
    pub(crate) delta_e: f64,
    /// Count of INTERIOR (non-edge-band) `ColorErr` pixels in this region — the
    /// area a solid recolour actually occupies (edge-band ColorErr excluded).
    pub(crate) interior_color_px: u32,
    /// Direct same-coordinate evidence about this component's coverage phase.
    pub(crate) coverage: CoverageEvidence,
    /// This independently visible ColorErr component has balanced signed colour
    /// energy, rather than a coherent recolour in one direction.
    pub(crate) large_color_component_is_balanced: bool,
    /// Largest direct CIEDE2000 difference in this component. Presence regions
    /// retain this separately from `delta_e`, whose median is intentionally a
    /// ColorErr-only solid-recolour diagnostic.
    pub(crate) max_direct_delta_e: f64,
}

/// Direct evidence that a mismatch is a coverage residual, rather than an
/// inferred registration. Presence and colour proofs deliberately live
/// together: a mixed phase needs both forms of evidence.
#[derive(Default)]
pub(crate) struct CoverageEvidence {
    /// One physical pixel thick at the outer boundary of the union content.
    pub(crate) outer_device_edge_fringe: bool,
    /// A sub-CSS-pixel band on a shared painted outline.
    pub(crate) sub_css_presence_residue: bool,
    /// Exactly one device pixel wide on a shared outline.
    pub(crate) one_device_pixel_presence_residue: bool,
    /// A long, sparse one-device-pixel shared contour.
    pub(crate) long_device_edge_residue: bool,
    /// A whole component is a narrow colour ramp between shared endpoints.
    pub(crate) shared_color_ramp: bool,
    /// Exactly one raster sample wide between two unchanged local colours.
    pub(crate) single_sample_color_frontier: bool,
    /// Below the authored visibility width between two unchanged local colours.
    pub(crate) sub_authored_color_frontier: bool,
    pub(crate) color_ramp_proven_px: u32,
    pub(crate) color_ramp_total_px: u32,
    pub(crate) compact_color_ramp_remainder: bool,
    /// Endpoint-less, same-family fragment below one CSS px squared and one
    /// colour JND. It is usable only beside a mostly direct ramp proof.
    pub(crate) sub_visibility_unproven_color_fragment: bool,
}

/// Lossless aggregate for every connected component with the same exact raster
/// class. These values include even one-pixel components that are not in
/// the bounded representative list.
pub(crate) struct RegionAggregate {
    pub(crate) class: PixelClass,
    pub(crate) region_count: u64,
    pub(crate) total_area_px: u64,
    pub(crate) total_area_pct: f64,
    pub(crate) union_bbox_css: [f64; 4],
    pub(crate) largest_area_px: u32,
    pub(crate) largest_area_pct: f64,
    pub(crate) largest_span_px: u32,
    pub(crate) max_delta_e: f64,
    pub(crate) color_de_weight: f64,
    pub(crate) color_de_area: u64,
    pub(crate) interior_color_px: u64,
    pub(crate) interior_de_weight: f64,
    pub(crate) coverage: CoverageAggregate,
    pub(crate) non_long_edge_presence: PresenceAggregate,
    pub(crate) unproven_presence: PresenceAggregate,
    pub(crate) unproven_color_ramp_px: u64,
    pub(crate) sub_visibility_unproven_color_fragment_px: u64,
    pub(crate) all_unproven_color_ramps_compact: bool,
    /// Direct shared-endpoint coverage samples retained across every ColorErr
    /// component, including partial proofs inside a component whose entire
    /// boundary cannot expose both endpoints.
    pub(crate) color_ramp_proven_px: u64,
    pub(crate) color_ramp_total_px: u64,
    /// Every independently visible ColorErr component has balanced signed colour
    /// energy, so two separate recolours cannot cancel only at page scope.
    pub(crate) all_large_color_components_balanced: bool,
    pub(crate) max_direct_delta_e: f64,
}

/// Lossless all-component aggregation of [`CoverageEvidence`].
pub(crate) struct CoverageAggregate {
    pub(crate) all_outer_device_edge_fringes: bool,
    pub(crate) all_sub_css_presence_residues: bool,
    pub(crate) all_one_device_pixel_presence_residues: bool,
    pub(crate) all_shared_color_ramps: bool,
    pub(crate) all_single_sample_color_frontiers: bool,
    pub(crate) all_sub_authored_color_frontiers: bool,
}

/// Direct-presence census after long one-device shared edges are removed.
/// The remaining curved or two-dimensional evidence retains its own complete
/// component and topology totals for the visibility budget.
#[derive(Clone, Copy, Default)]
pub(crate) struct PresenceAggregate {
    pub(crate) region_count: u64,
    pub(crate) total_area_px: u64,
    pub(crate) largest_area_px: u32,
    pub(crate) largest_span_px: u32,
}

/// Complete semantic region census plus a bounded worst-first detail sample.
#[derive(Default)]
pub(crate) struct RegionSet {
    pub(crate) total_count: u64,
    pub(crate) aggregates: Vec<RegionAggregate>,
    pub(crate) examples: Vec<DiffRegion>,
}

impl RegionSet {
    pub(crate) fn record(&mut self, region: DiffRegion) {
        self.total_count += 1;
        if let Some(aggregate) = self
            .aggregates
            .iter_mut()
            .find(|aggregate| aggregate.class == region.class)
        {
            aggregate.record(&region);
        } else {
            self.aggregates.push(RegionAggregate::from_region(&region));
        }

        if self.examples.len() < REGION_EXAMPLE_LIMIT {
            self.examples.push(region);
            self.examples.sort_by(region_priority);
        } else if self
            .examples
            .last()
            .is_some_and(|last| region_priority(&region, last).is_lt())
        {
            self.examples.pop();
            self.examples.push(region);
            self.examples.sort_by(region_priority);
        }
    }

    /// Largest exact-class component, or zero if that class has no diff region.
    pub(crate) fn largest_area(&self, class: PixelClass) -> u32 {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .map_or(0, |aggregate| aggregate.largest_area_px)
    }

    /// Longest component edge for one exact raster class.
    pub(crate) fn largest_span(&self, class: PixelClass) -> u32 {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .map_or(0, |aggregate| aggregate.largest_span_px)
    }

    /// Complete component count for one exact raster class.
    pub(crate) fn region_count(&self, class: PixelClass) -> u64 {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .map_or(0, |aggregate| aggregate.region_count)
    }

    /// Whether every component of this direct-presence class is one physical
    /// pixel thick at the outer edge of the union content.
    pub(crate) fn only_outer_device_edge_fringes(&self, class: PixelClass) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .is_some_and(|aggregate| aggregate.coverage.all_outer_device_edge_fringes)
    }

    /// Whether every direct-presence component for `class` is a sub-CSS-pixel
    /// shared-outline coverage band.
    pub(crate) fn only_sub_css_coverage_residues(&self, class: PixelClass) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .is_some_and(|aggregate| aggregate.coverage.all_sub_css_presence_residues)
    }

    /// Whether every direct-presence component for `class` is exactly one
    /// device pixel wide on a shared outline.
    pub(crate) fn only_one_device_pixel_shared_coverage_residues(&self, class: PixelClass) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .is_some_and(|aggregate| aggregate.coverage.all_one_device_pixel_presence_residues)
    }

    /// Whether every authored-scale presence component is a directly proven
    /// sub-CSS shared contour. Endpoint-less fragments may accompany that
    /// proof only while each fragment and their complete aggregate remain
    /// below the ordinary visibility floors.
    pub(crate) fn only_sub_css_presence_with_compact_remainder(&self, class: PixelClass) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .is_some_and(|aggregate| {
                aggregate.coverage.all_sub_css_presence_residues
                    || aggregate.unproven_presence.is_compact()
            })
    }

    pub(crate) fn presence_without_long_device_edges(
        &self,
        class: PixelClass,
    ) -> PresenceAggregate {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == class)
            .map_or_else(PresenceAggregate::default, |aggregate| {
                aggregate.non_long_edge_presence
            })
    }

    /// Whether every direct-presence component is a sub-CSS-pixel shared
    /// outline residue. This is useful when explaining an accepted verdict;
    /// colour-only residuals intentionally do not participate.
    pub(crate) fn only_sub_css_coverage_presence_residues(&self) -> bool {
        let mut saw_presence = false;
        for aggregate in &self.aggregates {
            if matches!(aggregate.class, PixelClass::Missing | PixelClass::Extra) {
                saw_presence = true;
                if !aggregate.coverage.all_sub_css_presence_residues {
                    return false;
                }
            }
        }
        saw_presence
    }

    /// Whether all directly observed colour errors are sub-CSS-pixel coverage
    /// ramps between unchanged local endpoint colours.
    pub(crate) fn only_shared_coverage_color_residues(&self) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .is_some_and(|aggregate| aggregate.coverage.all_shared_color_ramps)
    }

    /// Whether the complete colour-error field consists of frontiers below the
    /// fixed authored visibility width. A single raster sample is direct device
    /// quantization and remains below the limit independently per component.
    /// Wider bands receive the coherent-component guard so repeated authored
    /// glyph-like strokes cannot accumulate behind the same exception.
    pub(crate) fn only_coherent_sub_authored_color_frontiers(&self) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .is_some_and(|aggregate| {
                aggregate.coverage.all_single_sample_color_frontiers
                    || (aggregate.coverage.all_sub_authored_color_frontiers
                        && aggregate.region_count <= VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS)
            })
    }

    /// Whether shared-endpoint ramps cover the complete colour residual except
    /// for bounded components that contain some direct ramp evidence, have no
    /// interior pixels, and remain below the independent visibility floor.
    pub(crate) fn shared_coverage_color_with_compact_remainder(&self) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .is_some_and(|aggregate| {
                if aggregate.coverage.all_shared_color_ramps {
                    return true;
                }
                let proven = aggregate
                    .total_area_px
                    .saturating_sub(aggregate.unproven_color_ramp_px);
                aggregate.all_unproven_color_ramps_compact
                    && aggregate.total_area_px > 0
                    && (aggregate.sub_visibility_unproven_color_fragment_px as f64)
                        < VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_TOTAL_CSS_PX2 * CSS_PX * CSS_PX
                    && proven as f64 / aggregate.total_area_px as f64
                        >= VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO
            })
    }

    /// Whether each ColorErr component large enough for separate perception has
    /// complementary coverage energy on its own.
    pub(crate) fn large_color_components_are_balanced(&self) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .is_some_and(|aggregate| aggregate.all_large_color_components_balanced)
    }

    /// Whether direct shared-endpoint samples prove the configured majority of
    /// all colour-boundary evidence, including partial component proofs.
    pub(crate) fn predominantly_shared_coverage_color(&self) -> bool {
        self.aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .is_some_and(|aggregate| {
                is_predominantly_shared_coverage(
                    aggregate.color_ramp_proven_px,
                    aggregate.color_ramp_total_px,
                )
            })
    }
}

fn is_predominantly_shared_coverage(proven: u64, total: u64) -> bool {
    total > 0 && proven as f64 / total as f64 >= VISUAL_BALANCED_AGGREGATE_RAMP_MIN_PROVEN_RATIO
}

impl RegionAggregate {
    fn from_region(region: &DiffRegion) -> Self {
        let (color_de_weight, color_de_area) =
            if region.class == PixelClass::ColorErr && region.delta_e > 0.0 {
                (
                    region.delta_e * f64::from(region.area_px),
                    u64::from(region.area_px),
                )
            } else {
                (0.0, 0)
            };
        Self {
            class: region.class,
            region_count: 1,
            total_area_px: u64::from(region.area_px),
            total_area_pct: region.area_pct,
            union_bbox_css: region.bbox_css,
            largest_area_px: region.area_px,
            largest_area_pct: region.area_pct,
            largest_span_px: region.longest_span_px,
            max_delta_e: region.delta_e,
            color_de_weight,
            color_de_area,
            interior_color_px: u64::from(region.interior_color_px),
            interior_de_weight: region.delta_e * f64::from(region.interior_color_px),
            coverage: CoverageAggregate::from(&region.coverage),
            non_long_edge_presence: PresenceAggregate::from_region(region),
            unproven_presence: PresenceAggregate::from_unproven_region(region),
            unproven_color_ramp_px: if region.class == PixelClass::ColorErr
                && !region.coverage.shared_color_ramp
            {
                u64::from(region.area_px)
            } else {
                0
            },
            sub_visibility_unproven_color_fragment_px: if region
                .coverage
                .sub_visibility_unproven_color_fragment
            {
                u64::from(region.area_px)
            } else {
                0
            },
            all_unproven_color_ramps_compact: region.class != PixelClass::ColorErr
                || region.coverage.shared_color_ramp
                || region.coverage.compact_color_ramp_remainder,
            color_ramp_proven_px: u64::from(region.coverage.color_ramp_proven_px),
            color_ramp_total_px: u64::from(region.coverage.color_ramp_total_px),
            all_large_color_components_balanced: region.large_color_component_is_balanced,
            max_direct_delta_e: region.max_direct_delta_e,
        }
    }

    fn record(&mut self, region: &DiffRegion) {
        self.region_count += 1;
        self.total_area_px += u64::from(region.area_px);
        self.total_area_pct += region.area_pct;
        self.union_bbox_css[0] = self.union_bbox_css[0].min(region.bbox_css[0]);
        self.union_bbox_css[1] = self.union_bbox_css[1].min(region.bbox_css[1]);
        self.union_bbox_css[2] = self.union_bbox_css[2].max(region.bbox_css[2]);
        self.union_bbox_css[3] = self.union_bbox_css[3].max(region.bbox_css[3]);
        if region.area_px > self.largest_area_px {
            self.largest_area_px = region.area_px;
            self.largest_area_pct = region.area_pct;
        }
        self.largest_span_px = self.largest_span_px.max(region.longest_span_px);
        self.max_delta_e = self.max_delta_e.max(region.delta_e);
        if region.class == PixelClass::ColorErr && region.delta_e > 0.0 {
            self.color_de_weight += region.delta_e * f64::from(region.area_px);
            self.color_de_area += u64::from(region.area_px);
        }
        self.interior_color_px += u64::from(region.interior_color_px);
        self.interior_de_weight += region.delta_e * f64::from(region.interior_color_px);
        self.coverage.record(&region.coverage);
        self.non_long_edge_presence.record(region);
        self.unproven_presence.record_unproven(region);
        if region.class == PixelClass::ColorErr && !region.coverage.shared_color_ramp {
            self.unproven_color_ramp_px += u64::from(region.area_px);
            self.all_unproven_color_ramps_compact &= region.coverage.compact_color_ramp_remainder;
        }
        if region.coverage.sub_visibility_unproven_color_fragment {
            self.sub_visibility_unproven_color_fragment_px += u64::from(region.area_px);
        }
        self.color_ramp_proven_px += u64::from(region.coverage.color_ramp_proven_px);
        self.color_ramp_total_px += u64::from(region.coverage.color_ramp_total_px);
        self.all_large_color_components_balanced &= region.large_color_component_is_balanced;
        self.max_direct_delta_e = self.max_direct_delta_e.max(region.max_direct_delta_e);
    }
}

impl PresenceAggregate {
    fn from_region(region: &DiffRegion) -> Self {
        let mut aggregate = Self::default();
        aggregate.record(region);
        aggregate
    }

    fn record(&mut self, region: &DiffRegion) {
        if region.coverage.long_device_edge_residue
            || !matches!(region.class, PixelClass::Missing | PixelClass::Extra)
        {
            return;
        }
        self.region_count += 1;
        self.total_area_px += u64::from(region.area_px);
        self.largest_area_px = self.largest_area_px.max(region.area_px);
        self.largest_span_px = self.largest_span_px.max(region.longest_span_px);
    }

    fn from_unproven_region(region: &DiffRegion) -> Self {
        let mut aggregate = Self::default();
        aggregate.record_unproven(region);
        aggregate
    }

    fn record_unproven(&mut self, region: &DiffRegion) {
        if !matches!(region.class, PixelClass::Missing | PixelClass::Extra)
            || region.coverage.sub_css_presence_residue
        {
            return;
        }
        self.region_count += 1;
        self.total_area_px += u64::from(region.area_px);
        self.largest_area_px = self.largest_area_px.max(region.area_px);
        self.largest_span_px = self.largest_span_px.max(region.longest_span_px);
    }

    fn is_compact(self) -> bool {
        self.region_count > 0
            && (self.largest_area_px as f64)
                < VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2 * CSS_PX * CSS_PX
            && (self.largest_span_px as f64) < VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX * CSS_PX
            && (self.total_area_px as f64) < VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2 * CSS_PX * CSS_PX
    }
}

impl CoverageAggregate {
    fn from(coverage: &CoverageEvidence) -> Self {
        Self {
            all_outer_device_edge_fringes: coverage.outer_device_edge_fringe,
            all_sub_css_presence_residues: coverage.sub_css_presence_residue,
            all_one_device_pixel_presence_residues: coverage.one_device_pixel_presence_residue,
            all_shared_color_ramps: coverage.shared_color_ramp,
            all_single_sample_color_frontiers: coverage.single_sample_color_frontier,
            all_sub_authored_color_frontiers: coverage.sub_authored_color_frontier,
        }
    }

    fn record(&mut self, coverage: &CoverageEvidence) {
        self.all_outer_device_edge_fringes &= coverage.outer_device_edge_fringe;
        self.all_sub_css_presence_residues &= coverage.sub_css_presence_residue;
        self.all_one_device_pixel_presence_residues &= coverage.one_device_pixel_presence_residue;
        self.all_shared_color_ramps &= coverage.shared_color_ramp;
        self.all_single_sample_color_frontiers &= coverage.single_sample_color_frontier;
        self.all_sub_authored_color_frontiers &= coverage.sub_authored_color_frontier;
    }
}

fn region_priority(left: &DiffRegion, right: &DiffRegion) -> std::cmp::Ordering {
    right
        .area_px
        .cmp(&left.area_px)
        .then_with(|| class_priority(right.class).cmp(&class_priority(left.class)))
        .then_with(|| {
            left.bbox_css[1]
                .partial_cmp(&right.bbox_css[1])
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            left.bbox_css[0]
                .partial_cmp(&right.bbox_css[0])
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn class_priority(class: PixelClass) -> u8 {
    match class {
        PixelClass::Missing => 4,
        PixelClass::Extra => 3,
        PixelClass::ColorErr => 2,
        PixelClass::Match => 0,
    }
}

/// Bounds and population count for one cross-section of a narrow outline band.
type CrossSection = (usize, usize, usize);

#[derive(Clone, Copy, Default)]
struct ColorRampProof {
    strict_proven: usize,
    layered_proven: usize,
    continuation_proven: usize,
    total: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct CoverageRamp {
    start: image::Rgba<u8>,
    end: image::Rgba<u8>,
}

impl Default for CoverageRamp {
    fn default() -> Self {
        Self {
            start: image::Rgba([0; 4]),
            end: image::Rgba([0; 4]),
        }
    }
}

/// Bounded endpoint pairs directly observed on one connected colour contour.
/// A component may reuse those exact ramps at a corner where no single device
/// normal reaches both endpoints. This is component-local evidence, never a
/// page-wide palette search.
struct CoverageRampSet {
    ramps: [CoverageRamp; 8],
    len: usize,
}

impl Default for CoverageRampSet {
    fn default() -> Self {
        Self {
            ramps: [CoverageRamp::default(); 8],
            len: 0,
        }
    }
}

impl CoverageRampSet {
    fn insert(&mut self, ramp: CoverageRamp) -> bool {
        if self.iter().any(|existing| existing.same_endpoints(ramp)) {
            return true;
        }
        let Some(slot) = self.ramps.get_mut(self.len) else {
            return false;
        };
        *slot = ramp;
        self.len += 1;
        true
    }

    fn covers(&self, sample: &image::Rgba<u8>) -> bool {
        self.iter().any(|ramp| ramp.encloses(sample))
    }

    fn iter(&self) -> impl Iterator<Item = CoverageRamp> + '_ {
        self.ramps[..self.len].iter().copied()
    }
}

impl CoverageRamp {
    fn same_endpoints(self, other: Self) -> bool {
        (self.start == other.start && self.end == other.end)
            || (self.start == other.end && self.end == other.start)
    }

    /// Filter primitives can composite coverage in linear light, so their
    /// encoded sRGB continuation is not necessarily a straight segment. Once
    /// a supermajority has directly proved this endpoint pair, continuation
    /// samples may use only its per-channel envelope. No new hue extremum can
    /// enter through this component-local fallback.
    fn encloses(self, sample: &image::Rgba<u8>) -> bool {
        (0..3).all(|channel| {
            let start = i16::from(self.start[channel]);
            let end = i16::from(self.end[channel]);
            let sample = i16::from(sample[channel]);
            let tolerance = COVERAGE_RAMP_CHANNEL_TOLERANCE as i16;
            sample >= start.min(end) - tolerance && sample <= start.max(end) + tolerance
        })
    }
}

/// Bounded exact shared colours observed on one local edge normal. Solid
/// stacked paint needs only paper, foreground, and one or two substrates; a
/// larger palette is conservatively ineligible for this fallback proof.
struct SharedColorSet {
    colors: [image::Rgba<u8>; 8],
    len: usize,
}

impl Default for SharedColorSet {
    fn default() -> Self {
        Self {
            colors: [image::Rgba([0; 4]); 8],
            len: 0,
        }
    }
}

impl SharedColorSet {
    fn insert(&mut self, color: image::Rgba<u8>) -> bool {
        if self.iter().any(|existing| existing == color) {
            return true;
        }
        let Some(slot) = self.colors.get_mut(self.len) else {
            return false;
        };
        *slot = color;
        self.len += 1;
        true
    }

    fn contains(&self, color: image::Rgba<u8>) -> bool {
        self.iter().any(|existing| existing == color)
    }

    fn encloses(&self, sample: image::Rgba<u8>) -> bool {
        self.len != 0
            && (0..3).all(|channel| {
                let minimum = self
                    .iter()
                    .map(|color| color[channel])
                    .min()
                    .unwrap_or_default();
                let maximum = self
                    .iter()
                    .map(|color| color[channel])
                    .max()
                    .unwrap_or_default();
                sample[channel] >= minimum && sample[channel] <= maximum
            })
    }

    fn iter(&self) -> impl Iterator<Item = image::Rgba<u8>> + '_ {
        self.colors[..self.len].iter().copied()
    }

    /// Collect authored solid layers on one exact shared-raster ray.
    ///
    /// A rasterized boundary can contain several one-device-pixel antialias
    /// colours between two real paints. Treating every such transient sample as
    /// a layer both loses the bounded palette and mistakes coverage values for
    /// authored colours. A solid layer must persist for at least one authored
    /// CSS pixel before it can become an endpoint in the layered-coverage proof.
    fn collect_solid_ray(
        &mut self,
        cand: &RgbaImage,
        reference: &RgbaImage,
        (x, y, dx, dy): (usize, usize, isize, isize),
        maximum_distance: usize,
    ) -> bool {
        let minimum_run = CSS_PX.floor().max(1.0) as usize;
        let mut run_color = None;
        let mut run_length = 0;
        for distance in 1..=maximum_distance {
            let next_x = x as isize + dx * distance as isize;
            let next_y = y as isize + dy * distance as isize;
            if next_x < 0
                || next_y < 0
                || next_x >= cand.width() as isize
                || next_y >= cand.height() as isize
            {
                return self.insert(image::Rgba([255; 4]));
            }
            let candidate = *cand.get_pixel(next_x as u32, next_y as u32);
            let oracle = *reference.get_pixel(next_x as u32, next_y as u32);
            if candidate != oracle {
                run_color = None;
                run_length = 0;
                continue;
            }
            if run_color == Some(candidate) {
                run_length += 1;
            } else {
                run_color = Some(candidate);
                run_length = 1;
            }
            if run_length == minimum_run && !self.insert(candidate) {
                return false;
            }
        }
        true
    }
}

impl ColorRampProof {
    fn has_direct_sample(&self) -> bool {
        self.strict_proven > 0
    }

    fn proven(&self) -> usize {
        (self.strict_proven + self.layered_proven).max(self.continuation_proven)
    }

    fn directly_proven(&self) -> usize {
        self.strict_proven + self.layered_proven
    }

    fn covers_component(&self) -> bool {
        if self.total == 0 {
            return false;
        }
        let proven = self.proven();
        let unproven = self.total - proven;
        let maximum_unproven =
            (VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2 * CSS_PX * CSS_PX) as usize;
        proven == self.total
            || (proven as f64 / self.total as f64 >= VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO
                && unproven < maximum_unproven)
    }
}

/// Per-page scratch storage for one region's colour statistics and local
/// topology. Reusing it keeps adversarially fragmented pages linear in their
/// pixels instead of allocating one or more vectors for every component.
#[derive(Default)]
struct RegionDiagnostics {
    dr: Vec<i16>,
    dg: Vec<i16>,
    db: Vec<i16>,
    da: Vec<i16>,
    interior_de: Vec<f64>,
    cross_sections: Vec<CrossSection>,
    component_pixels: ComponentPixels,
}

impl RegionDiagnostics {
    fn clear_color_samples(&mut self) {
        self.dr.clear();
        self.dg.clear();
        self.db.clear();
        self.da.clear();
        self.interior_de.clear();
    }

    fn reset_cross_sections(&mut self, length: usize) -> bool {
        if length > self.cross_sections.capacity()
            && self
                .cross_sections
                .try_reserve_exact(length.saturating_sub(self.cross_sections.len()))
                .is_err()
        {
            return false;
        }
        self.cross_sections.clear();
        self.cross_sections.resize(length, (usize::MAX, 0, 0));
        true
    }
}

/// Flood-fill each real-diff class into 4-connected regions. Even a one-pixel
/// defect is semantic report data and must remain searchable downstream.
pub(crate) fn segment(
    cm: &ClassMap,
    cand: &RgbaImage,
    reference: &RgbaImage,
    masks: &StructuralMasks,
) -> RegionSet {
    let w = cm.w as usize;
    let h = cm.h as usize;
    let total = w * h;
    if total == 0 {
        return RegionSet::default();
    }
    let total_px = total as f64;

    let mut visited = vec![false; total];
    let mut regions = RegionSet::default();
    let mut stack: Vec<usize> = Vec::new();
    let mut members: Vec<usize> = Vec::new();
    // Coverage topology needs a local component-membership map for curved
    // outlines. Reuse one fallible workspace across every component so a
    // checkerboard residual cannot allocate one bitmap per pixel.
    let mut diagnostics = RegionDiagnostics::default();

    for start in 0..total {
        let class = cm.px[start];
        if visited[start] || class == PixelClass::Match {
            continue;
        }
        // BFS/DFS flood fill collecting one exact-class component. Reuse the
        // owned member buffer across components so checkerboard diagnostics do
        // not allocate one Vec per pixel.
        stack.clear();
        members.clear();
        stack.push(start);
        visited[start] = true;
        while let Some(i) = stack.pop() {
            members.push(i);
            let x = i % w;
            let y = i / w;
            let push = |nx: usize, ny: usize, stack: &mut Vec<usize>, visited: &mut [bool]| {
                let ni = ny * w + nx;
                if !visited[ni] && cm.px[ni] == class {
                    visited[ni] = true;
                    stack.push(ni);
                }
            };
            if x > 0 {
                push(x - 1, y, &mut stack, &mut visited);
            }
            if x + 1 < w {
                push(x + 1, y, &mut stack, &mut visited);
            }
            if y > 0 {
                push(x, y - 1, &mut stack, &mut visited);
            }
            if y + 1 < h {
                push(x, y + 1, &mut stack, &mut visited);
            }
        }

        regions.record(diagnose_region(
            &members,
            class,
            cm,
            cand,
            reference,
            masks,
            w,
            total_px,
            CSS_PX,
            &mut diagnostics,
        ));
    }
    regions
}

fn diagnose_region(
    members: &[usize],
    class: PixelClass,
    cm: &ClassMap,
    cand: &RgbaImage,
    reference: &RgbaImage,
    masks: &StructuralMasks,
    w: usize,
    total_px: f64,
    pixels_per_css_px: f64,
    diagnostics: &mut RegionDiagnostics,
) -> DiffRegion {
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
    // Per-channel deltas over ALL the region's ColorErr px (modal hue, for the
    // diagnosis headline) + per-pixel ΔE over INTERIOR (non-edge-band) ColorErr px
    // only (the robust solid-recolour diagnostic, via median).
    diagnostics.clear_color_samples();
    let mut color_energy = ColorEnergy::default();
    let mut max_direct_delta_e = 0.0_f64;
    for &i in members {
        let x = i % w;
        let y = i / w;
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
        let c = cand.get_pixel(x as u32, y as u32).0;
        let r = reference.get_pixel(x as u32, y as u32).0;
        max_direct_delta_e = max_direct_delta_e.max(ciede2000(
            srgb_to_lab([r[0], r[1], r[2]]),
            srgb_to_lab([c[0], c[1], c[2]]),
        ));

        if class == PixelClass::ColorErr {
            let delta = [
                c[0] as i16 - r[0] as i16,
                c[1] as i16 - r[1] as i16,
                c[2] as i16 - r[2] as i16,
            ];
            diagnostics.dr.push(delta[0]);
            diagnostics.dg.push(delta[1]);
            diagnostics.db.push(delta[2]);
            diagnostics.da.push(c[3] as i16 - r[3] as i16);
            color_energy.add(delta);
            // Interior ColorErr only: boundary pixels remain exact mismatches but
            // do not dominate the solid-fill colour summary.
            if !masks.in_edge_band(x as u32, y as u32) {
                diagnostics.interior_de.push(ciede2000(
                    srgb_to_lab([r[0], r[1], r[2]]),
                    srgb_to_lab([c[0], c[1], c[2]]),
                ));
            }
        }
    }

    let area_px = members.len() as u32;
    let longest_span_px = (x1 - x0 + 1).max(y1 - y0 + 1) as u32;
    let modal_drgba = [
        median(&mut diagnostics.dr),
        median(&mut diagnostics.dg),
        median(&mut diagnostics.db),
        median(&mut diagnostics.da),
    ];
    let interior_color_px = diagnostics.interior_de.len() as u32;
    // MEDIAN ΔE over interior ColorErr (review #17): a low-ΔE fringe cannot drag a
    // hard recolour core. Zero interior ColorErr => 0 (a region
    // whose only ColorErr is on the structural boundary is NOT a solid recolour).
    let delta_e = median_f64(&mut diagnostics.interior_de);
    let outer_device_edge_fringe = matches!(class, PixelClass::Missing | PixelClass::Extra)
        && is_one_device_pixel_thick(members, class, cm)
        && members
            .iter()
            .all(|&index| is_union_content_boundary(index, cand, reference, w));
    let sub_css_presence_residue = is_sub_css_coverage_residue(
        members,
        class,
        cand,
        reference,
        w,
        x0,
        y0,
        x1,
        y1,
        diagnostics,
    );
    let one_device_pixel_presence_residue = is_one_device_pixel_shared_coverage_residue(
        members,
        class,
        cand,
        reference,
        w,
        x0,
        y0,
        x1,
        y1,
        &mut diagnostics.component_pixels,
    );
    let long_device_edge_residue = one_device_pixel_presence_residue
        && f64::from(longest_span_px) >= VISUAL_STRAIGHT_DEVICE_EDGE_MIN_SPAN_CSS_PX * CSS_PX;
    let color_ramp_proof = (class == PixelClass::ColorErr).then(|| {
        sub_css_shared_coverage_color_proof(
            members,
            cand,
            reference,
            w,
            x0,
            y0,
            x1,
            y1,
            &mut diagnostics.component_pixels,
        )
    });
    let shared_color_ramp = color_ramp_proof.is_some_and(|proof| {
        proof.covers_component()
            || (interior_color_px == 0
                && proof.has_direct_sample()
                && is_sub_visibility_same_family_edge(members, cand, reference, w))
    });
    let single_sample_color_frontier = class == PixelClass::ColorErr
        && is_single_sample_color_frontier(
            members,
            cand,
            reference,
            w,
            x0,
            y0,
            x1,
            y1,
            &mut diagnostics.component_pixels,
        );
    let sub_authored_color_frontier = class == PixelClass::ColorErr
        && is_sub_authored_color_frontier(
            members,
            cand,
            reference,
            w,
            x0,
            y0,
            x1,
            y1,
            &mut diagnostics.component_pixels,
        );
    let compact_color_ramp_remainder = class == PixelClass::ColorErr
        && !shared_color_ramp
        && interior_color_px == 0
        && color_ramp_proof.is_some_and(|proof| proof.has_direct_sample())
        && (area_px as f64) < VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2 * CSS_PX * CSS_PX;
    let sub_visibility_unproven_color_fragment = class == PixelClass::ColorErr
        && !shared_color_ramp
        && (area_px as f64) < VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_AREA_CSS_PX2 * CSS_PX * CSS_PX
        && delta_e <= VISUAL_COLOR_JND
        && is_sub_visibility_same_family_edge(members, cand, reference, w);
    let compact_color_ramp_remainder =
        compact_color_ramp_remainder || sub_visibility_unproven_color_fragment;
    let independently_visible_color_component = (area_px as f64)
        >= VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2 * CSS_PX * CSS_PX
        || (longest_span_px as f64) >= VISUAL_BALANCED_EDGE_COMPONENT_MAX_SPAN_CSS_PX * CSS_PX;
    let large_color_component_is_balanced = class != PixelClass::ColorErr
        || !independently_visible_color_component
        || color_energy.bias() <= VISUAL_BALANCED_EDGE_COMPONENT_MAX_BIAS;
    DiffRegion {
        bbox_css: [
            x0 as f64 / pixels_per_css_px,
            y0 as f64 / pixels_per_css_px,
            x1 as f64 / pixels_per_css_px,
            y1 as f64 / pixels_per_css_px,
        ],
        class,
        area_px,
        longest_span_px,
        area_pct: 100.0 * area_px as f64 / total_px,
        modal_drgba,
        delta_e,
        interior_color_px,
        coverage: CoverageEvidence {
            outer_device_edge_fringe,
            sub_css_presence_residue,
            one_device_pixel_presence_residue,
            long_device_edge_residue,
            shared_color_ramp,
            single_sample_color_frontier,
            sub_authored_color_frontier,
            color_ramp_proven_px: color_ramp_proof.map_or(0, |proof| proof.proven() as u32),
            color_ramp_total_px: color_ramp_proof.map_or(0, |proof| proof.total as u32),
            compact_color_ramp_remainder,
            sub_visibility_unproven_color_fragment,
        },
        large_color_component_is_balanced,
        max_direct_delta_e,
    }
}

/// A compact boundary-only component can be too small to expose both exact
/// endpoints along every glyph normal. It is still a coverage residual when
/// every same-coordinate pair retains one ink direction from paper and the
/// complete component stays below the independent visibility area floor.
fn is_sub_visibility_same_family_edge(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
) -> bool {
    (members.len() as f64) < VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2 * CSS_PX * CSS_PX
        && members.iter().all(|index| {
            let x = (*index % width) as u32;
            let y = (*index / width) as u32;
            same_colour_family(cand.get_pixel(x, y).0, reference.get_pixel(x, y).0)
        })
}

/// A direct-presence component may reach fixed CSS-scale observation only as a
/// sub-CSS-pixel shared-outline band. Every cross-section must be an exact-class
/// contiguous strip and must directly separate shared paper from shared painted
/// content. The test never searches for an offset, shifts, crops, or
/// substitutes pixels; raw class evidence remains intact.
fn is_sub_css_coverage_residue(
    members: &[usize],
    class: PixelClass,
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    diagnostics: &mut RegionDiagnostics,
) -> bool {
    matches!(class, PixelClass::Missing | PixelClass::Extra)
        && (is_narrow_shared_outline_band(
            members,
            cand,
            reference,
            width,
            x0,
            y0,
            x1,
            y1,
            diagnostics,
        ) || is_narrow_shared_contour_band(
            members,
            cand,
            reference,
            width,
            x0,
            y0,
            x1,
            y1,
            &mut diagnostics.component_pixels,
        ))
}

/// One-sided coverage residue is intentionally stricter than paired sampling
/// phase: each component pixel must have a one-device-pixel normal cross
/// section between shared paper and shared content. This accepts a connected
/// L at a fractional rectangle corner, but rejects a two-device-pixel strip.
fn is_one_device_pixel_shared_coverage_residue(
    members: &[usize],
    class: PixelClass,
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> bool {
    matches!(class, PixelClass::Missing | PixelClass::Extra)
        && is_one_device_pixel_shared_contour_band(
            members, cand, reference, width, x0, y0, x1, y1, component,
        )
}

fn is_sub_authored_color_frontier(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> bool {
    if !component.reset(members, width, x0, y0, x1, y1) {
        return false;
    }
    members.iter().all(|&index| {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        CONTOUR_NORMALS.into_iter().any(|(dx, dy)| {
            component.run_is_narrower_than(
                x,
                y,
                dx,
                dy,
                VISUAL_SUB_AUTHORED_COLOR_FRONTIER_MAX_CSS_PX,
            ) && shared_color_frontier(cand, reference, x, y, dx, dy)
        })
    })
}

fn is_single_sample_color_frontier(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> bool {
    if !component.reset(members, width, x0, y0, x1, y1) {
        return false;
    }
    members.iter().all(|&index| {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        CONTOUR_NORMALS.into_iter().any(|(dx, dy)| {
            component.is_single_sample_run(x, y, dx, dy)
                && shared_color_frontier(cand, reference, x, y, dx, dy)
        })
    })
}

fn shared_color_frontier(
    cand: &RgbaImage,
    reference: &RgbaImage,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> bool {
    let origin = (x as usize, y as usize);
    let before = (origin.0, origin.1, -dx, -dy);
    let after = (origin.0, origin.1, dx, dy);
    matches!(
        (
            nearest_exact_color(cand, reference, before),
            nearest_exact_color(cand, reference, after),
        ),
        (Some(before), Some(after)) if before != after
    )
}

/// A direct-presence band may be up to one authored CSS pixel wide, but every
/// cross-section must separate shared paper from shared painted content. That
/// excludes an interior cut whose endpoints happen to reach paper elsewhere.
fn is_narrow_shared_outline_band(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    diagnostics: &mut RegionDiagnostics,
) -> bool {
    if !is_sub_css_pixel_thick(x0, y0, x1, y1) {
        return false;
    }
    let component_width = x1 - x0 + 1;
    let component_height = y1 - y0 + 1;
    if component_width == component_height {
        return false;
    }

    let (long_start, long_end, cross_section_len, vertical) = if component_width < component_height
    {
        (y0, y1, component_height, true)
    } else {
        (x0, x1, component_width, false)
    };
    if !diagnostics.reset_cross_sections(cross_section_len) {
        return false;
    }
    let cross_sections = &mut diagnostics.cross_sections;
    for &index in members {
        let x = index % width;
        let y = index / width;
        let (long, narrow) = if vertical { (y, x) } else { (x, y) };
        let bounds = &mut cross_sections[long - long_start];
        bounds.0 = bounds.0.min(narrow);
        bounds.1 = bounds.1.max(narrow);
        bounds.2 += 1;
    }

    (long_start..=long_end).all(|long| {
        let (narrow_start, narrow_end, member_count) = cross_sections[long - long_start];
        narrow_start != usize::MAX
            && member_count == narrow_end - narrow_start + 1
            && shared_outline_transition(
                cand,
                reference,
                if vertical {
                    (narrow_start, long, -1, 0)
                } else {
                    (long, narrow_start, 0, -1)
                },
                if vertical {
                    (narrow_end, long, 1, 0)
                } else {
                    (long, narrow_end, 0, 1)
                },
            )
    })
}

/// A direct-presence component can represent a subdevice PDF coverage residual
/// only when its narrow axis stays below one authored CSS pixel. Long edges are
/// permitted; their visibility is decided exclusively by the fixed CSS-scale
/// observation, never by offset registration.
fn is_sub_css_pixel_thick(x0: usize, y0: usize, x1: usize, y1: usize) -> bool {
    let width = x1 - x0 + 1;
    let height = y1 - y0 + 1;
    (width.min(height) as f64) < CSS_PX
}

/// A reusable compact membership map for one exact-class component. It lets
/// the curved contour test inspect a local normal without ever treating a
/// nearby component as part of this residual. Its allocation grows only when a
/// page contains a larger component bounding box than any prior component.
#[derive(Default)]
struct ComponentPixels {
    x0: usize,
    y0: usize,
    width: usize,
    height: usize,
    members: Vec<bool>,
}

impl ComponentPixels {
    /// Rebuild the local membership map without allocating once the workspace
    /// has reached this component's bounding-box capacity. Capacity and index
    /// arithmetic are fallible, so an unusably large diagnostic component is
    /// conservatively treated as ineligible for coverage forgiveness.
    fn reset(
        &mut self,
        indices: &[usize],
        image_width: usize,
        x0: usize,
        y0: usize,
        x1: usize,
        y1: usize,
    ) -> bool {
        let Some(width) = x1.checked_sub(x0).and_then(|value| value.checked_add(1)) else {
            return false;
        };
        let Some(height) = y1.checked_sub(y0).and_then(|value| value.checked_add(1)) else {
            return false;
        };
        let Some(size) = width.checked_mul(height) else {
            return false;
        };
        if size > self.members.capacity()
            && self
                .members
                .try_reserve_exact(size.saturating_sub(self.members.len()))
                .is_err()
        {
            return false;
        }
        self.members.clear();
        self.members.resize(size, false);
        for &index in indices {
            let x = index % image_width;
            let y = index / image_width;
            let Some(local_x) = x.checked_sub(x0) else {
                return false;
            };
            let Some(local_y) = y.checked_sub(y0) else {
                return false;
            };
            let Some(slot) = local_y
                .checked_mul(width)
                .and_then(|row| row.checked_add(local_x))
            else {
                return false;
            };
            let Some(member) = self.members.get_mut(slot) else {
                return false;
            };
            *member = true;
        }
        self.x0 = x0;
        self.y0 = y0;
        self.width = width;
        self.height = height;
        true
    }

    fn contains(&self, x: isize, y: isize) -> bool {
        let local_x = x - self.x0 as isize;
        let local_y = y - self.y0 as isize;
        if local_x < 0
            || local_y < 0
            || local_x >= self.width as isize
            || local_y >= self.height as isize
        {
            return false;
        }
        local_y
            .checked_mul(self.width as isize)
            .and_then(|row| row.checked_add(local_x))
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| self.members.get(index))
            .copied()
            .unwrap_or(false)
    }

    /// Count the contiguous exact-class pixels from a point along one normal.
    /// `None` means the component exceeds the fixed sub-CSS aperture.
    fn run_length(
        &self,
        x: isize,
        y: isize,
        dx: isize,
        dy: isize,
        maximum: usize,
    ) -> Option<usize> {
        for distance in 1..=maximum + 1 {
            let sample_x = x + dx * distance as isize;
            let sample_y = y + dy * distance as isize;
            if !self.contains(sample_x, sample_y) {
                return Some(distance - 1);
            }
        }
        None
    }

    fn is_single_sample_run(&self, x: isize, y: isize, dx: isize, dy: isize) -> bool {
        matches!(
            (
                self.run_length(x, y, -dx, -dy, 1),
                self.run_length(x, y, dx, dy, 1),
            ),
            (Some(before), Some(after)) if before + after + 1 == 1
        )
    }

    /// Whether this exact-class normal run is physically narrower than a
    /// configured authored-space width. The calculation is resolution-aware:
    /// diagonal device steps carry their Euclidean length rather than being
    /// counted as axis-aligned samples.
    fn run_is_narrower_than(
        &self,
        x: isize,
        y: isize,
        dx: isize,
        dy: isize,
        maximum_css_px: f64,
    ) -> bool {
        let maximum_device_px = maximum_css_px * CSS_PX;
        let device_step = ((dx * dx + dy * dy) as f64).sqrt();
        let maximum_samples = (maximum_device_px / device_step).floor() as usize;
        if maximum_samples == 0 {
            return false;
        }
        matches!(
            (
                self.run_length(x, y, -dx, -dy, maximum_samples),
                self.run_length(x, y, dx, dy, maximum_samples),
            ),
            (Some(before), Some(after))
                if (before + after + 1) as f64 * device_step < maximum_device_px
        )
    }
}

/// Test the four undirected device-grid normals. A diagonal normal is needed
/// for the stair-step coverage residue at an elliptical corner.
const CONTOUR_NORMALS: [(isize, isize); 4] = [(1, 0), (0, 1), (1, 1), (1, -1)];

/// A curved direct-presence residual may reach authored-scale observation when
/// every one of its pixels is in a sub-CSS normal band between shared paper and
/// shared painted content. This is a same-coordinate topology check: it does
/// not search for a shifted shape, borrow a different component, or turn an
/// interior cut into an edge merely because paper exists elsewhere on the page.
fn is_narrow_shared_contour_band(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> bool {
    if !component.reset(members, width, x0, y0, x1, y1) {
        return false;
    }
    members.iter().all(|&index| {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        CONTOUR_NORMALS
            .into_iter()
            .any(|(dx, dy)| shared_contour_normal(&component, cand, reference, x, y, dx, dy))
    })
}

/// The one-device-pixel counterpart to [`is_narrow_shared_contour_band`].
/// A diagonal normal is retained so a one-pixel L corner remains a coverage
/// band rather than being misclassified as a two-dimensional loss.
fn is_one_device_pixel_shared_contour_band(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> bool {
    if !component.reset(members, width, x0, y0, x1, y1) {
        return false;
    }
    members.iter().all(|&index| {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        CONTOUR_NORMALS.into_iter().any(|(dx, dy)| {
            one_device_pixel_shared_contour_normal(&component, cand, reference, x, y, dx, dy)
        })
    })
}

/// A direct colour-error component is imperceptible only when it is a narrow
/// antialiasing ramp between two exact, unchanged local colours. This is a
/// same-coordinate proof: it does not shift, crop, or substitute either image.
/// It only examines directly shared endpoint samples on the same local normal.
/// Curved corners and narrow stems may leave a bounded unproven remainder, but
/// only when at least three quarters of the component proves the ramp and the
/// remainder stays below the fixed independent-visibility area floor.
fn sub_css_shared_coverage_color_proof(
    members: &[usize],
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    component: &mut ComponentPixels,
) -> ColorRampProof {
    if !component.reset(members, width, x0, y0, x1, y1) {
        return ColorRampProof::default();
    }
    let mut proof = ColorRampProof {
        total: members.len(),
        ..Default::default()
    };
    let mut ramps = CoverageRampSet::default();
    let mut complete_ramp_set = true;
    for &index in members {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        if let Some(ramp) = CONTOUR_NORMALS.into_iter().find_map(|(dx, dy)| {
            shared_coverage_color_normal(&component, cand, reference, x, y, dx, dy)
        }) {
            proof.strict_proven += 1;
            complete_ramp_set &= ramps.insert(ramp);
        } else if CONTOUR_NORMALS.into_iter().any(|(dx, dy)| {
            shared_layered_coverage_color_normal(&component, cand, reference, x, y, dx, dy)
        }) {
            proof.layered_proven += 1;
        }
    }

    // A rectangular or curved contour can directly expose both unchanged
    // endpoint colours along its straight sections but not at every corner.
    // Extend only when a supermajority is already proven, the complete
    // connected component remains sub-CSS on a local normal, and both unequal
    // samples stay on one of the endpoint pairs observed in that component.
    let narrow_contour = is_sub_css_color_contour(members, width, &component);
    if complete_ramp_set
        && reaches_discrete_ratio(
            proof.directly_proven(),
            proof.total,
            VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO,
        )
        && narrow_contour
    {
        proof.continuation_proven = members
            .iter()
            .filter(|&&index| {
                let x = (index % width) as u32;
                let y = (index / width) as u32;
                ramps.covers(cand.get_pixel(x, y)) && ramps.covers(reference.get_pixel(x, y))
            })
            .count();
    }
    proof
}

/// A raster proportion has an integral number of device samples. Rounding the
/// required count down keeps one semantically tolerated pixel from making the
/// same contour alternate across a nominal percentage boundary.
fn reaches_discrete_ratio(proven: usize, total: usize, minimum: f64) -> bool {
    total > 0 && proven >= (total as f64 * minimum).floor() as usize
}

fn is_sub_css_color_contour(members: &[usize], width: usize, component: &ComponentPixels) -> bool {
    members.iter().all(|&index| {
        let x = (index % width) as isize;
        let y = (index / width) as isize;
        CONTOUR_NORMALS
            .into_iter()
            .any(|(dx, dy)| sub_css_normal_boundaries(component, x, y, dx, dy).is_some())
    })
}

/// One local normal cross-section through a curved coverage component.
fn shared_contour_normal(
    component: &ComponentPixels,
    cand: &RgbaImage,
    reference: &RgbaImage,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> bool {
    let Some(((before_x, before_y), (after_x, after_y))) =
        sub_css_normal_boundaries(component, x, y, dx, dy)
    else {
        return false;
    };
    shared_outline_transition(
        cand,
        reference,
        (before_x, before_y, -dx, -dy),
        (after_x, after_y, dx, dy),
    )
}

/// Check one local normal through a colour-error component. The entire direct
/// class run must remain narrower than one authored CSS pixel; its two nearby
/// endpoint pixels must be byte-identical across candidate and reference, and
/// each changed value must be a rounded mixture on that same endpoint segment.
fn shared_coverage_color_normal(
    component: &ComponentPixels,
    cand: &RgbaImage,
    reference: &RgbaImage,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> Option<CoverageRamp> {
    let Some(((before_x, before_y), (after_x, after_y))) =
        sub_css_normal_boundaries(component, x, y, dx, dy)
    else {
        return None;
    };
    let pixel = (x as usize, y as usize);
    let before = (before_x, before_y, -dx, -dy);
    let after = (after_x, after_y, dx, dy);
    shared_coverage_color_transition(cand, reference, pixel, before, after)
}

fn shared_layered_coverage_color_normal(
    component: &ComponentPixels,
    cand: &RgbaImage,
    reference: &RgbaImage,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> bool {
    let Some(((before_x, before_y), (after_x, after_y))) =
        sub_css_normal_boundaries(component, x, y, dx, dy)
    else {
        return false;
    };
    shared_layered_coverage_color_transition(
        cand,
        reference,
        (x as usize, y as usize),
        (before_x, before_y, -dx, -dy),
        (after_x, after_y, dx, dy),
        component.is_single_sample_run(x, y, dx, dy),
    )
}

/// Boundary points immediately outside a component's sub-CSS normal run.
fn sub_css_normal_boundaries(
    component: &ComponentPixels,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> Option<((usize, usize), (usize, usize))> {
    let device_distance = ((dx * dx + dy * dy) as f64).sqrt();
    let maximum = (CSS_PX / device_distance).floor() as usize;
    if maximum == 0 {
        return None;
    }
    let before = component.run_length(x, y, -dx, -dy, maximum)?;
    let after = component.run_length(x, y, dx, dy, maximum)?;
    if (before + after + 1) as f64 * device_distance >= CSS_PX {
        return None;
    }
    Some((
        offset_grid_point(x, y, -dx, -dy, before)?,
        offset_grid_point(x, y, dx, dy, after)?,
    ))
}

/// A local shared-outline transition whose exact-class run is one device
/// pixel. `run_length(..., 1)` returns `None` for a two-pixel run, which makes
/// the width rule explicit rather than inferring it from authored CSS scale.
fn one_device_pixel_shared_contour_normal(
    component: &ComponentPixels,
    cand: &RgbaImage,
    reference: &RgbaImage,
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
) -> bool {
    let (Some(before), Some(after)) = (
        component.run_length(x, y, -dx, -dy, 1),
        component.run_length(x, y, dx, dy, 1),
    ) else {
        return false;
    };
    if before + after + 1 != 1 {
        return false;
    }
    shared_outline_transition(
        cand,
        reference,
        (x as usize, y as usize, -dx, -dy),
        (x as usize, y as usize, dx, dy),
    )
}

/// Prove that the changed pixel is an antialiased mixture of two distinct,
/// directly shared colours. A colour error cannot use merely similar samples:
/// both endpoints must be byte-identical in the original shared raster.
fn shared_coverage_color_transition(
    cand: &RgbaImage,
    reference: &RgbaImage,
    pixel: (usize, usize),
    before: (usize, usize, isize, isize),
    after: (usize, usize, isize, isize),
) -> Option<CoverageRamp> {
    let (Some(before_color), Some(after_color)) = (
        nearest_exact_color(cand, reference, before),
        nearest_exact_color(cand, reference, after),
    ) else {
        return None;
    };
    (before_color != after_color
        && is_coverage_ramp_color(
            cand.get_pixel(pixel.0 as u32, pixel.1 as u32),
            before_color,
            after_color,
        )
        && is_coverage_ramp_color(
            reference.get_pixel(pixel.0 as u32, pixel.1 as u32),
            before_color,
            after_color,
        ))
    .then_some(CoverageRamp {
        start: before_color,
        end: after_color,
    })
}

/// Prove coverage at an edge where the same foreground is composited over two
/// different shared substrates. This occurs when a background paints beneath
/// a border: one PDF edge sample can mix foreground with paper while the other
/// mixes that foreground with the shared background. Both direct samples must
/// lie on a segment from the same nearby shared content colour; an authored
/// red/blue edge swap has no such common paint and remains visible.
fn shared_layered_coverage_color_transition(
    cand: &RgbaImage,
    reference: &RgbaImage,
    pixel: (usize, usize),
    before: (usize, usize, isize, isize),
    after: (usize, usize, isize, isize),
    one_device_component: bool,
) -> bool {
    let mut nearby = SharedColorSet::default();
    let near_distance = CSS_PX.ceil() as usize;
    if !nearby.collect_solid_ray(cand, reference, before, near_distance)
        || !nearby.collect_solid_ray(cand, reference, after, near_distance)
    {
        return false;
    }

    let mut palette = SharedColorSet::default();
    let maximum_distance = (VISUAL_LAYERED_COVERAGE_MAX_DEPTH_CSS_PX * CSS_PX).ceil() as usize;
    if !palette.collect_solid_ray(cand, reference, before, maximum_distance)
        || !palette.collect_solid_ray(cand, reference, after, maximum_distance)
    {
        return false;
    }

    let candidate = *cand.get_pixel(pixel.0 as u32, pixel.1 as u32);
    let oracle = *reference.get_pixel(pixel.0 as u32, pixel.1 as u32);
    if candidate != oracle && palette.contains(candidate) && palette.contains(oracle) {
        return false;
    }

    let shared_foreground = nearby.iter().filter(is_content).any(|paint| {
        if !nearby.iter().any(|substrate| substrate != paint) {
            return false;
        }
        let candidate_is_coverage = palette.iter().any(|substrate| {
            substrate != paint && is_coverage_ramp_color(&candidate, paint, substrate)
        });
        let oracle_is_coverage = palette.iter().any(|substrate| {
            substrate != paint && is_coverage_ramp_color(&oracle, paint, substrate)
        });
        candidate_is_coverage && oracle_is_coverage
    });
    shared_foreground
        || (one_device_component
            && nearby.iter().count() >= 2
            && same_colour_family(candidate.0, oracle.0)
            && palette.encloses(candidate)
            && palette.encloses(oracle))
}

/// Find the first byte-identical colour on a direct ray no longer than one CSS
/// pixel. This observes the immediate coverage transition; it is not a
/// neighbourhood search for a better match.
fn nearest_exact_color(
    cand: &RgbaImage,
    reference: &RgbaImage,
    (x, y, dx, dy): (usize, usize, isize, isize),
) -> Option<image::Rgba<u8>> {
    let maximum_distance = CSS_PX.ceil() as isize;
    for distance in 1..=maximum_distance {
        let next_x = x as isize + dx * distance;
        let next_y = y as isize + dy * distance;
        if next_x < 0
            || next_y < 0
            || next_x >= cand.width() as isize
            || next_y >= cand.height() as isize
        {
            return Some(image::Rgba([255; 4]));
        }
        let candidate = cand.get_pixel(next_x as u32, next_y as u32);
        let oracle = reference.get_pixel(next_x as u32, next_y as u32);
        if candidate == oracle {
            return Some(*candidate);
        }
    }
    None
}

/// Whether a raster colour is on the straight coverage segment between two
/// shared endpoints, within channel rounding. Projection avoids treating a
/// chromatic authored recolour as grayscale antialiasing merely because every
/// channel falls between the endpoint minima and maxima.
fn is_coverage_ramp_color(
    sample: &image::Rgba<u8>,
    start: image::Rgba<u8>,
    end: image::Rgba<u8>,
) -> bool {
    let direction = [
        f64::from(end[0]) - f64::from(start[0]),
        f64::from(end[1]) - f64::from(start[1]),
        f64::from(end[2]) - f64::from(start[2]),
    ];
    let denominator = direction.iter().map(|value| value * value).sum::<f64>();
    if denominator == 0.0 {
        return false;
    }
    let displacement = [
        f64::from(sample[0]) - f64::from(start[0]),
        f64::from(sample[1]) - f64::from(start[1]),
        f64::from(sample[2]) - f64::from(start[2]),
    ];
    let position = displacement
        .iter()
        .zip(direction)
        .map(|(delta, direction)| delta * direction)
        .sum::<f64>()
        / denominator;
    if !(-0.01..=1.01).contains(&position) {
        return false;
    }
    displacement
        .iter()
        .zip(direction)
        .all(|(delta, direction)| {
            (delta - position * direction).abs() <= COVERAGE_RAMP_CHANNEL_TOLERANCE
        })
}

/// Move an in-bounds component point along a device-grid normal without
/// relying on a wrapping signed-to-unsigned conversion.
fn offset_grid_point(
    x: isize,
    y: isize,
    dx: isize,
    dy: isize,
    distance: usize,
) -> Option<(usize, usize)> {
    let distance = isize::try_from(distance).ok()?;
    let x = x.checked_add(dx.checked_mul(distance)?)?;
    let y = y.checked_add(dy.checked_mul(distance)?)?;
    Some((usize::try_from(x).ok()?, usize::try_from(y).ok()?))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SharedSurface {
    Paper,
    Content,
}

/// Whether the two rays on opposite sides of a residual cross-section encounter
/// shared paper and shared painted content, in either order. At most two device
/// pixels are examined to cross a fractional coverage ramp; this is local
/// classification evidence, never a search for a shifted match.
fn shared_outline_transition(
    cand: &RgbaImage,
    reference: &RgbaImage,
    before: (usize, usize, isize, isize),
    after: (usize, usize, isize, isize),
) -> bool {
    matches!(
        (
            nearest_shared_surface(cand, reference, before),
            nearest_shared_surface(cand, reference, after),
        ),
        (Some(SharedSurface::Paper), Some(SharedSurface::Content))
            | (Some(SharedSurface::Content), Some(SharedSurface::Paper))
    )
}

/// Whether the two normal rays reach two distinct appearances that are already
/// identical between candidate and reference at their current coordinates.
/// This extends the paper/content outline check to an inner border edge (for
/// example gray border against red padding-box background) without accepting a
/// cut through a uniformly painted shape.
/// First shared surface along one normal ray, within the fractional-coverage
/// aperture. A paper or content sample on the near side takes precedence over
/// a farther sample, so an interior cut surrounded by shared content cannot
/// borrow paper from the far side of the same stem.
fn nearest_shared_surface(
    cand: &RgbaImage,
    reference: &RgbaImage,
    (x, y, dx, dy): (usize, usize, isize, isize),
) -> Option<SharedSurface> {
    for distance in 1..=2 {
        let next_x = x as isize + dx * distance;
        let next_y = y as isize + dy * distance;
        if next_x < 0
            || next_y < 0
            || next_x >= cand.width() as isize
            || next_y >= cand.height() as isize
        {
            return Some(SharedSurface::Paper);
        }
        let neighbor = (next_x as usize, next_y as usize, true);
        if shared_paper(cand, reference, neighbor) {
            return Some(SharedSurface::Paper);
        }
        if shared_content(cand, reference, neighbor) {
            return Some(SharedSurface::Content);
        }
    }
    None
}

fn shared_paper(
    cand: &RgbaImage,
    reference: &RgbaImage,
    (x, y, in_bounds): (usize, usize, bool),
) -> bool {
    !in_bounds
        || (!is_content(cand.get_pixel(x as u32, y as u32))
            && !is_content(reference.get_pixel(x as u32, y as u32)))
}

fn shared_content(
    cand: &RgbaImage,
    reference: &RgbaImage,
    (x, y, in_bounds): (usize, usize, bool),
) -> bool {
    in_bounds
        && is_content(cand.get_pixel(x as u32, y as u32))
        && is_content(reference.get_pixel(x as u32, y as u32))
}

/// A connected residual is one device pixel thick only if every cross-section
/// perpendicular to its long axis contains one exact-class pixel. Square and
/// diagonal/stair-step components are rejected: their width has no unambiguous
/// single-pixel normal direction.
fn is_one_device_pixel_thick(members: &[usize], class: PixelClass, cm: &ClassMap) -> bool {
    let width = cm.w as usize;
    let height = cm.h as usize;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
    for &index in members {
        x0 = x0.min(index % width);
        y0 = y0.min(index / width);
        x1 = x1.max(index % width);
        y1 = y1.max(index / width);
    }
    let component_width = x1 - x0 + 1;
    let component_height = y1 - y0 + 1;
    if component_width == component_height {
        return false;
    }
    if component_width < component_height {
        !members
            .iter()
            .any(|&index| index % width + 1 < width && cm.px[index + 1] == class)
    } else {
        !members
            .iter()
            .any(|&index| index / width + 1 < height && cm.px[index + width] == class)
    }
}

/// Whether a pixel is attached to content in both pages while touching paper
/// outside the union of candidate and oracle content. Both conditions matter:
/// an isolated paint speck or a displaced one-pixel glyph stem touches paper,
/// but is not an outer coverage fringe of a shared painted shape. The shared
/// content need not be byte-identical: a rasterized gradient's adjacent
/// interior pixels may differ slightly while still describing the same edge.
fn is_union_content_boundary(
    index: usize,
    cand: &RgbaImage,
    reference: &RgbaImage,
    width: usize,
) -> bool {
    let x = index % width;
    let y = index / width;
    let height = cand.height() as usize;
    let mut touches_paper = false;
    let mut touches_matching_content = false;
    for (neighbor_x, neighbor_y, in_bounds) in [
        (x.wrapping_sub(1), y, x > 0),
        (x + 1, y, x + 1 < width),
        (x, y.wrapping_sub(1), y > 0),
        (x, y + 1, y + 1 < height),
    ] {
        if !in_bounds {
            touches_paper = true;
            continue;
        }
        let candidate_neighbor = cand.get_pixel(neighbor_x as u32, neighbor_y as u32);
        let reference_neighbor = reference.get_pixel(neighbor_x as u32, neighbor_y as u32);
        touches_paper |= !is_content(candidate_neighbor) && !is_content(reference_neighbor);
        touches_matching_content |=
            is_content(candidate_neighbor) && is_content(reference_neighbor);
    }
    touches_paper && touches_matching_content
}

/// Median of a signed-channel sample, clamped to i16. Empty -> 0.
fn median(v: &mut [i16]) -> i16 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[v.len() / 2]
}

/// Median of an f64 sample (used for the robust interior-ColorErr ΔE). Empty -> 0.
fn median_f64(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::{
        ColorRampProof, ComponentPixels, CoverageRamp, is_coverage_ramp_color,
        is_predominantly_shared_coverage, reaches_discrete_ratio,
        shared_layered_coverage_color_transition,
    };
    use image::{ImageBuffer, Rgba};

    #[test]
    fn aggregate_shared_coverage_keeps_partial_component_evidence() {
        assert!(is_predominantly_shared_coverage(625, 1000));
        assert!(!is_predominantly_shared_coverage(624, 1000));
        assert!(!is_predominantly_shared_coverage(0, 0));
    }

    #[test]
    fn discrete_ramp_ratio_is_stable_when_one_tolerated_sample_disappears() {
        assert!(reaches_discrete_ratio(1_385, 1_847, 0.75));
        assert!(!reaches_discrete_ratio(1_384, 1_847, 0.75));
    }

    #[test]
    fn linear_light_filter_coverage_stays_inside_observed_endpoint_bounds() {
        let ramp = CoverageRamp {
            start: image::Rgba([22, 101, 192, 255]),
            end: image::Rgba([13, 0, 0, 255]),
        };
        let encoded_linear_light_sample = image::Rgba([14, 57, 114, 255]);

        assert!(!is_coverage_ramp_color(
            &encoded_linear_light_sample,
            ramp.start,
            ramp.end
        ));
        assert!(ramp.encloses(&encoded_linear_light_sample));
        assert!(!ramp.encloses(&image::Rgba([198, 40, 40, 255])));
    }

    #[test]
    fn layered_inset_shadow_edge_accepts_shared_foreground_over_shared_background() {
        let background = Rgba([231, 245, 255, 255]);
        let border = Rgba([87, 117, 144, 255]);
        let shadow = Rgba([255, 209, 102, 255]);
        let blended_shadow = Rgba([246, 221, 155, 255]);
        let mut candidate = ImageBuffer::from_pixel(21, 21, background);
        let mut reference = candidate.clone();
        for y in 0..=9 {
            for x in 0..=20 {
                candidate.put_pixel(x, y, border);
                reference.put_pixel(x, y, border);
            }
        }
        for y in 11..=15 {
            for x in 0..=20 {
                candidate.put_pixel(x, y, shadow);
                reference.put_pixel(x, y, shadow);
            }
        }
        for x in 0..=20 {
            candidate.put_pixel(x, 10, shadow);
            reference.put_pixel(x, 10, blended_shadow);
        }

        assert!(shared_layered_coverage_color_transition(
            &candidate,
            &reference,
            (10, 10),
            (10, 10, 0, -1),
            (10, 10, 0, 1),
            true,
        ));
    }

    #[test]
    fn color_ramp_proof_requires_a_supermajority_and_bounded_remainder() {
        assert!(
            ColorRampProof {
                strict_proven: 75,
                total: 100,
                ..Default::default()
            }
            .covers_component()
        );
        assert!(
            !ColorRampProof {
                strict_proven: 74,
                total: 100,
                ..Default::default()
            }
            .covers_component()
        );
        assert!(
            !ColorRampProof {
                strict_proven: 300,
                total: 500,
                ..Default::default()
            }
            .covers_component()
        );
        assert!(!ColorRampProof::default().has_direct_sample());
    }

    #[test]
    fn diagnostic_workspace_reuses_component_and_cross_section_capacity() {
        let mut workspace = ComponentPixels::default();
        assert!(workspace.reset(&[0, 1, 4, 5], 4, 0, 0, 1, 1));
        let component_capacity = workspace.members.capacity();

        assert!(workspace.reset(&[2, 6], 4, 2, 0, 2, 1));
        assert_eq!(workspace.members.capacity(), component_capacity);
        assert!(workspace.contains(2, 0));
        assert!(workspace.contains(2, 1));

        let mut diagnostics = super::RegionDiagnostics::default();
        assert!(diagnostics.reset_cross_sections(4));
        let cross_section_capacity = diagnostics.cross_sections.capacity();
        assert!(diagnostics.reset_cross_sections(2));
        assert_eq!(
            diagnostics.cross_sections.capacity(),
            cross_section_capacity
        );
    }
}
