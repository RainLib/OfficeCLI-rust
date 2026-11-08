//! Shared rasterization and human-visibility measurement constants.
//!
//! The parity report always records exact, same-coordinate RGBA differences.
//! The verdict below answers a separate question: whether those differences are
//! large enough to be visible at the authored CSS scale. The values are global,
//! documented, and deliberately never vary by fixture, feature, or oracle.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Rasterization DPI for both candidate and reference.
pub(crate) const DPI: u32 = 300;
// ===========================================================================
// V2 COMPARATOR CONSTANTS
// ===========================================================================

/// Device px per CSS px @ 300 DPI (96 CSS px/in -> 300/96 = 3.125).
pub(crate) const CSS_PX: f64 = 3.125;
/// Per-channel 4-neighbour gradient threshold (0..255) for structural edges. A
/// pixel is an edge iff the max per-channel |Δ| to any 4-neighbour exceeds this.
pub(crate) const EDGE_GRAD: i32 = 24;

/// Conventional CIEDE2000 just-noticeable colour difference. A lower mean
/// difference is not treated as a visible colour defect, even though the exact
/// evidence remains in the report. The old 1.0 cutoff was stricter than a
/// human-visibility gate and turned printer-resolution averaging into failures.
pub(crate) const VISUAL_COLOR_JND: f64 = 2.3;
/// An 8-bit sRGB channel difference of up to two code values is below the 1%
/// per-pixel colour threshold; three code values are above it. This affects only
/// the visibility verdict: raw RGBA inequality remains complete report evidence.
pub(crate) const VISUAL_COLOR_CHANNEL_TOLERANCE: u8 = 2;
/// The product-level expression of `VISUAL_COLOR_CHANNEL_TOLERANCE`.
pub(crate) const VISUAL_COLOR_CHANNEL_TOLERANCE_PCT: f64 = 1.0;
/// Maximum complete-page mismatch rate after the per-pixel RGB tolerance is
/// applied. This is a ceiling, not a sufficient PASS condition: authored-scale
/// components below it still fail through the shape and colour visibility
/// rules. Exact RGBA mismatch remains independently reported without this
/// tolerance.
pub(crate) const VISUAL_PASS_MAX_SEMANTIC_DIFF_PCT: f64 = 1.0;
/// Per-channel rounding allowance when proving that an unequal pixel is an
/// antialiasing mixture of two unchanged local endpoint colours. This is not a
/// colour-difference cutoff: the topology check still requires both direct
/// samples to lie on one shared coverage ramp.
pub(crate) const COVERAGE_RAMP_CHANNEL_TOLERANCE: f64 = 3.0;
/// Largest residual signed colour energy, relative to its absolute edge energy,
/// for an edge-only page to qualify as balanced coverage phase. Ten percent
/// covers the directly measured phase difference between independently embedded
/// filter surfaces while the separate zero-interior, shared-anchor, and
/// per-component balance requirements continue to reject authored recolours.
pub(crate) const VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS: f64 = 0.10;
/// A ColorErr component this large must itself exhibit coverage-phase balance;
/// global cancellation alone cannot waive two separately visible recolours.
/// Sixteen CSS px² is the fixed untrained-visibility floor for an isolated
/// colour fragment; a long component is constrained independently below.
pub(crate) const VISUAL_BALANCED_EDGE_COMPONENT_MIN_AREA_CSS_PX2: f64 = 16.0;
/// A directional ColorErr component this long is independently visible even
/// below the area floor, such as a coloured rule or border segment.
pub(crate) const VISUAL_BALANCED_EDGE_COMPONENT_MAX_SPAN_CSS_PX: f64 = 16.0;
/// Largest signed residual colour energy allowed in each independently visible
/// ColorErr component of a balanced coverage-phase observation.
pub(crate) const VISUAL_BALANCED_EDGE_COMPONENT_MAX_BIAS: f64 = 0.25;
/// Minimum directly proven share of a ColorErr component when a few curved
/// corner or narrow-stem samples cannot reach both unchanged ramp endpoints.
/// The remainder is accepted only below the independent component-area floor,
/// so a mostly unproven recolour cannot borrow this allowance.
pub(crate) const VISUAL_COVERAGE_RAMP_MIN_PROVEN_RATIO: f64 = 0.75;
/// Minimum direct shared-ramp coverage across the complete edge-only colour
/// field when signed colour energy is independently balanced. Five eighths is
/// a strict majority while allowing synthetic glyph curves whose raster edge
/// cannot expose both exact endpoints at every device sample. Component-local
/// remainder acceptance retains the stronger three-quarter threshold above.
pub(crate) const VISUAL_BALANCED_AGGREGATE_RAMP_MIN_PROVEN_RATIO: f64 = 0.625;
/// Maximum signed colour-energy imbalance for an otherwise directly proven,
/// zero-interior shared-ramp field. The topology proof is stronger than the
/// generic balanced-edge path, so it tolerates the small directional bias of a
/// filtered raster image without admitting a coherent recolour.
pub(crate) const VISUAL_PREDOMINANT_RAMP_MAX_BIAS: f64 = 0.16;
/// Largest individual endpoint-less colour fragment that may accompany a
/// mostly direct shared-ramp proof. One CSS px squared is smaller than an
/// independently readable mark at the authored scale; it never suffices on
/// its own because the enclosing aggregate must still be at least 75% proven.
pub(crate) const VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_AREA_CSS_PX2: f64 = 1.0;
/// Combined endpoint-less colour area allowed beside direct shared ramps.
/// This uses the same four-CSS-pixel area floor as an independently visible
/// paint-presence component, preventing many tiny defects from accumulating
/// into an authored-scale recolour.
pub(crate) const VISUAL_UNPROVEN_COLOR_FRAGMENT_MAX_TOTAL_CSS_PX2: f64 = 4.0;
/// Maximum direct normal depth for proving a stacked-paint coverage edge. CSS
/// backgrounds paint beneath borders, so the shared substrate can sit behind a
/// thick shared border even though the changed raster sample is one device
/// pixel at its outer edge. This is only a same-coordinate palette proof; it
/// never searches for replacement geometry.
pub(crate) const VISUAL_LAYERED_COVERAGE_MAX_DEPTH_CSS_PX: f64 = 32.0;
/// A pixel this close to paper is not visible as paint. This is the same global
/// CIEDE2000 just-noticeable threshold used for colour verdicts, not a separate
/// fixture-level cutoff. Raw RGBA evidence still retains these pixels exactly.
pub(crate) const PAPER_CONTENT_JND: f64 = VISUAL_COLOR_JND;
/// Maximum union-content coverage for edge-only colour variance. This admits
/// sub-CSS-pixel raster coverage changes without admitting a solid recolour.
/// The fixed 1.5% floor covers a one-device-pixel outline phase at the pinned
/// 300 DPI, including several independently painted borders, glyphs, and image
/// edges on one page. Every accepted pixel must still be confined to the
/// directly observed structural edge band; any interior recolour remains
/// subject to the stricter rule below regardless of this aggregate percentage.
pub(crate) const VISUAL_EDGE_COLOR_PCT: f64 = 1.5;
/// Maximum paired Missing/Extra coverage for a sub-CSS-pixel shared outline
/// phase. An unpaired contour uses the same authored-space topology proof:
/// every residual sample must remain below one CSS pixel on a normal between
/// shared paper and content, so its aggregate length does not weaken that proof.
pub(crate) const VISUAL_EDGE_PRESENCE_PCT: f64 = 1.0;
/// A coherent box-like outline has at most one direct-presence component per
/// side. Such a sub-CSS phase may be long without becoming thick; more
/// fragmented evidence remains subject to the aggregate coverage cap above so
/// repeated glyph displacement cannot masquerade as one coherent contour.
pub(crate) const VISUAL_COHERENT_OUTLINE_MAX_COMPONENTS: u64 = 4;
/// Maximum physical width of an exact-colour frontier that remains below the
/// authored visibility scale. At the pinned 300 DPI this admits a two-sample
/// diagonal junction (0.91 CSS px) but rejects a three-sample axial strip
/// (0.96 CSS px), which is raster quantization of an authored one-CSS-pixel
/// feature. Every accepted normal must still terminate in two distinct
/// byte-identical colours shared by candidate and oracle, and the complete
/// field must satisfy the coherent-component limit above.
pub(crate) const VISUAL_SUB_AUTHORED_COLOR_FRONTIER_MAX_CSS_PX: f64 = 0.95;
/// Minimum fraction of painted union content that must remain byte-identical
/// before a paired sub-CSS outline phase can be treated as a stable large
/// shape. This separates a device-grid phase around an otherwise unchanged
/// image from a displaced thin rule or glyph, whose paint has little or no
/// same-coordinate interior anchor.
pub(crate) const VISUAL_STABLE_OUTLINE_MIN_SHARED_CONTENT_RATIO: f64 = 0.90;
/// A shared contour this long is treated as a physical edge rather than a
/// disconnected glyph fragment only when every normal is exactly one device
/// pixel thick. Shorter stems retain the ordinary component budget.
pub(crate) const VISUAL_STRAIGHT_DEVICE_EDGE_MIN_SPAN_CSS_PX: f64 = 16.0;
/// Maximum union-content coverage for non-edge colour variance before it is a
/// visible recolour. Interior pixels are intentionally stricter than edges.
pub(crate) const VISUAL_INTERIOR_COLOR_PCT: f64 = 0.125;
/// A single Missing/Extra component must cover at least this many CSS square
/// pixels before it is independently visible. This admits sub-glyph and
/// antialiased corner fragments while retaining their raw evidence.
pub(crate) const VISUAL_PRESENCE_COMPONENT_AREA_CSS_PX2: f64 = 4.0;
/// An unpaired thin Missing or Extra component is visible when it extends this
/// far along either CSS axis, even if its area stays below the component-area
/// floor. Paired sub-area fringes are treated by the area policy instead: they
/// are the direct, same-coordinate shape of an imperceptible sub-CSS-pixel
/// edge shift, not a registration search.
pub(crate) const VISUAL_PRESENCE_COMPONENT_SPAN_CSS_PX: f64 = 8.0;
/// Disconnected Missing/Extra components are visible collectively once their
/// total reaches this CSS area. This prevents a dense pattern of individually
/// tiny fragments from being treated as imperceptible.
pub(crate) const VISUAL_PRESENCE_TOTAL_AREA_CSS_PX2: f64 = 16.0;

/// A paired presence residual can cover more than the disconnected-fragment
/// floor when PDF text outlines share their geometry but quantize coverage
/// differently. This is deliberately a per-sign cap: an actually absent shape
/// has no balancing paint on the other side and therefore cannot use it.
pub(crate) const VISUAL_MIXED_COVERAGE_MAX_PRESENCE_PCT: f64 = 6.0;
/// The two direct-presence signs must nearly cancel. This is a raw
/// same-coordinate mass check, not a translation or registration search.
pub(crate) const VISUAL_MIXED_COVERAGE_MAX_BALANCE_BIAS: f64 = 0.05;
/// In a true sub-pixel coverage phase, the overlapping outline samples carry
/// more evidence than the near-paper samples that classify as Missing/Extra.
/// A missing word, a changed weight, or a binary shape swap cannot meet this.
pub(crate) const VISUAL_MIXED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO: f64 = 2.0;
/// Minimum byte-identical painted area required before a one-sided contour can
/// be treated as fractional coverage rather than changed geometry.
pub(crate) const VISUAL_ONE_SIDED_COVERAGE_MIN_SHARED_CONTENT_RATIO: f64 = 0.95;
/// At most one percent of either painted shape may cross the paper threshold.
pub(crate) const VISUAL_ONE_SIDED_COVERAGE_MAX_PRESENCE_PCT: f64 = 1.0;
/// Overlapping same-coordinate ramp evidence must dominate direct presence.
pub(crate) const VISUAL_ONE_SIDED_COVERAGE_MIN_COLOR_TO_PRESENCE_RATIO: f64 = 2.0;
/// Structural edge detection can conservatively leave a small portion of a
/// curved glyph contour outside its one-pixel edge band. Keep that allowance
/// below a quarter CSS pixel of the shared painted area.
pub(crate) const VISUAL_MIXED_COVERAGE_MAX_INTERIOR_COLOR_PCT: f64 = 0.25;
