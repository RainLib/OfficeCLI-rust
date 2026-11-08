//! The V2 golden contract (spec §5.1, amendment A4): synthetic in-memory image
//! pairs that pin the comparator's class + verdict. They run WITHOUT pdftoppm or
//! Chrome (sub-second) and are the standing honesty guard: every raw difference
//! is retained, while only human-visible differences fail.
//!
//! Each test asserts the verdict STATUS, the dominant `PixelClass`, and the named
//! magnitude band where the spec gives one. Where the spec's stated magnitude or
//! verdict is provably inconsistent with the spec's own constants/construction,
//! the test asserts the HONEST measured result and the discrepancy is documented
//! inline (and reported to the orchestrator) rather than fudged (amendment A6).

use image::{ImageBuffer, Rgba, RgbaImage};

use super::super::config::VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS;
use super::super::report::Status;
use super::{PixelClass, V2Outcome, compare_page_v2, compare_v2, visibility};

// ----------------------------------------------------------------------------
// Synthetic image builders
// ----------------------------------------------------------------------------

const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);
const BLACK: Rgba<u8> = Rgba([0, 0, 0, 255]);

/// A white canvas of the given size.
fn canvas(w: u32, h: u32) -> RgbaImage {
    ImageBuffer::from_pixel(w, h, WHITE)
}

/// Fill the inclusive rect [x0,x1]x[y0,y1] with `c`.
fn fill(img: &mut RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32, c: Rgba<u8>) {
    for y in y0..=y1.min(img.height() - 1) {
        for x in x0..=x1.min(img.width() - 1) {
            img.put_pixel(x, y, c);
        }
    }
}

/// Relocate every pixel onto a white background of the same dimensions.
fn relocate_pixels(img: &RgbaImage, dx: i32, dy: i32) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut out = canvas(w, h);
    for y in 0..h {
        for x in 0..w {
            let nx = x as i32 + dx;
            let ny = y as i32 + dy;
            if nx >= 0 && ny >= 0 && (nx as u32) < w && (ny as u32) < h {
                out.put_pixel(nx as u32, ny as u32, *img.get_pixel(x, y));
            }
        }
    }
    out
}

/// Run the same comparator pipeline as a live fixture.
fn run(cand: &RgbaImage, reference: &RgbaImage) -> V2Outcome {
    compare_v2(cand, reference)
}

/// A 120x120 solid black box centred in a 200x200 frame (the common substrate).
fn box_frame() -> RgbaImage {
    let mut img = canvas(200, 200);
    fill(&mut img, 40, 40, 159, 159, BLACK);
    img
}

fn dump(name: &str, o: &V2Outcome) {
    if std::env::var_os("PARITY_DEBUG_TALLY").is_none() {
        return;
    }
    eprintln!(
        "golden {name:24} status={:7} dom={:?} diff={:.3}% color%={:.3}/{:.3} miss%={:.3} extra%={:.3} ΔE={:.3}/{:.3} anchors={} ramp={}",
        o.status.as_str(),
        o.verdict.dominant_class,
        o.diff_pct,
        o.tally.color_pct,
        o.visibility.tally.color_pct,
        o.tally.missing_pct,
        o.tally.extra_pct,
        o.tally.color_de,
        o.visibility.tally.color_de,
        o.visibility.tally.color_errors_have_css_anchors,
        o.visibility.regions.predominantly_shared_coverage_color(),
    );
}

#[test]
fn golden_authored_scale_boundary_color_component_is_visible() {
    let surface = Rgba([230, 242, 252, 255]);
    let ink = Rgba([20, 48, 78, 255]);
    let mut reference = ImageBuffer::from_pixel(400, 400, surface);
    let mut candidate = reference.clone();
    // Two non-overlapping glyph-like stems occupy only 0.2% of the page. Their
    // interiors are narrow enough to live entirely in the structural edge band,
    // so the authored component floor—not an edge-percentage waiver—must reject
    // the obvious relocation.
    fill(&mut reference, 30, 40, 37, 59, ink);
    fill(&mut candidate, 70, 40, 77, 59, ink);

    let outcome = run(&candidate, &reference);

    assert!(outcome.semantic_diff_pct < 0.5);
    assert!(
        outcome
            .visibility
            .regions
            .largest_area(PixelClass::ColorErr)
            >= 8 * 20
    );
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_complete_page_above_floor_mismatch_has_a_one_percent_ceiling() {
    let surface = Rgba([230, 242, 252, 255]);
    let ink = Rgba([20, 48, 78, 255]);
    let reference = ImageBuffer::from_pixel(100, 100, surface);
    let mut at_ceiling = reference.clone();
    let mut above_ceiling = reference.clone();
    for index in 0..101 {
        let x = 2 + (index % 10) * 9;
        let y = 2 + (index / 10) * 9;
        above_ceiling.put_pixel(x, y, ink);
        if index < 100 {
            at_ceiling.put_pixel(x, y, ink);
        }
    }

    let accepted = compare_page_v2(&at_ceiling, &reference);
    let rejected = compare_page_v2(&above_ceiling, &reference);

    assert_eq!(accepted.semantic_diff_pct, 1.0);
    assert_eq!(accepted.status, Status::Pass);
    assert!(rejected.semantic_diff_pct > 1.0);
    assert_eq!(rejected.status, Status::Fail);
    assert!(rejected.diagnosis.headline.contains("1.0% PASS ceiling"));
}

#[test]
fn golden_per_channel_floor_is_absent_from_diff_and_page_ceiling() {
    let reference = ImageBuffer::from_pixel(100, 100, Rgba([80, 120, 160, 255]));
    let candidate = ImageBuffer::from_pixel(100, 100, Rgba([81, 121, 161, 255]));

    let outcome = compare_page_v2(&candidate, &reference);

    assert_eq!(outcome.diff_pct, 100.0);
    assert_eq!(outcome.semantic_diff_pct, 0.0);
    assert_eq!(outcome.status, Status::Pass);
    assert!(outcome.overlay.pixels().all(|pixel| *pixel == WHITE));
}

// ----------------------------------------------------------------------------
// Golden rows (spec §5.1)
// ----------------------------------------------------------------------------

#[test]
fn golden_identical() {
    let a = box_frame();
    let o = run(&a, &a);
    dump("identical", &o);
    assert_eq!(o.status, Status::Pass, "identical must PASS");
    assert!(
        o.diff_pct < 1e-9,
        "identical diff must be 0, got {}",
        o.diff_pct
    );
    assert!(o.tally.color_pct == 0.0 && o.tally.missing_pct == 0.0 && o.tally.extra_pct == 0.0);
    assert_eq!(o.tally.modal_drgba, [0; 4]);
    assert_eq!(o.tally.color_coverage_bias, 0.0);
    assert!(!o.tally.color_errors_have_css_anchors);
    assert!(!o.tally.color_errors_preserve_hue);
}

#[test]
fn golden_alpha_only_difference_outside_content_bbox_is_raw_evidence_but_passes() {
    let reference = canvas(20, 20);
    let mut candidate = reference.clone();
    candidate.put_pixel(19, 19, Rgba([255, 255, 255, 254]));
    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Pass);
    assert!(o.diff_pct > 0.0);
    assert_eq!(o.tally.different_px, 1);
    assert_eq!(o.verdict.dominant_class, PixelClass::ColorErr);
    assert_eq!(o.tally.modal_drgba, [0, 0, 0, -1]);
    assert!(o.diagnosis.headline.contains("alpha channel differs"));
}

#[test]
fn golden_every_single_rgba_byte_difference_is_reported_but_not_visible() {
    let reference = canvas(7, 5);
    for (x, y) in [(0, 0), (3, 2), (6, 4)] {
        for channel in 0..4 {
            let mut candidate = reference.clone();
            candidate.get_pixel_mut(x, y)[channel] = 254;
            let outcome = run(&candidate, &reference);
            assert_eq!(
                outcome.status,
                Status::Pass,
                "one byte at ({x},{y}) is below the human visibility boundary"
            );
            assert!(outcome.diff_pct > 0.0);
            assert_eq!(
                outcome.diff_pct,
                100.0 / 35.0,
                "one changed pixel must remain exactly measured"
            );
        }
    }
}

#[test]
fn golden_one_rgb_code_per_pixel_is_raw_but_semantically_correct() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 40, 40, 159, 159, Rgba([1, 1, 1, 255]));

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.color_px, 120 * 120);
    assert_eq!(outcome.tally.color_above_channel_tolerance_px, 0);
    assert_eq!(outcome.tally.different_px, outcome.tally.color_px);
}

#[test]
fn golden_two_rgb_codes_per_pixel_are_raw_but_semantically_correct() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 40, 40, 159, 159, Rgba([2, 2, 2, 255]));

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.tally.color_px, 120 * 120);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.color_above_channel_tolerance_px, 0);
}

#[test]
fn golden_three_rgb_codes_per_pixel_remain_active_color_evidence() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 40, 40, 159, 159, Rgba([3, 3, 3, 255]));

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.tally.color_px, 120 * 120);
    assert_eq!(
        outcome.tally.color_above_channel_tolerance_px,
        outcome.tally.color_px
    );
}

#[test]
fn golden_one_pixel_defect_remains_a_diagnostic_region_when_visually_accepted() {
    let reference = canvas(9, 9);
    let mut candidate = reference.clone();
    candidate.put_pixel(4, 4, BLACK);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.regions.total_count, 1);
    assert_eq!(outcome.regions.examples[0].area_px, 1);
    assert_eq!(outcome.diagnosis.region_count, 1);
    assert_eq!(outcome.diagnosis.region_examples.len(), 1);
    assert_eq!(outcome.diagnosis.region_classes[0].total_pixels, 1);
}

#[test]
fn golden_all_disconnected_regions_survive_diagnosis() {
    let reference = canvas(21, 21);
    let mut candidate = reference.clone();
    for (x, y) in [(2, 2), (6, 2), (10, 2), (14, 2), (18, 2), (2, 6), (6, 6)] {
        candidate.put_pixel(x, y, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.regions.total_count, 7);
    assert_eq!(outcome.diagnosis.region_count, 7);
    assert_eq!(outcome.diagnosis.region_examples.len(), 7);
    assert!(
        outcome
            .diagnosis
            .region_examples
            .iter()
            .all(|region| region.area_pct > 0.0)
    );
}

#[test]
fn golden_checkerboard_regions_are_complete_but_detail_is_bounded() {
    let reference = canvas(129, 129);
    let mut candidate = reference.clone();
    for y in (0..129).step_by(2) {
        for x in (0..129).step_by(2) {
            candidate.put_pixel(x, y, BLACK);
        }
    }

    let outcome = run(&candidate, &reference);
    let expected = 65 * 65;
    assert_eq!(outcome.status, Status::Fail);
    assert_eq!(outcome.regions.total_count, expected);
    assert_eq!(outcome.diagnosis.region_count, expected);
    assert_eq!(outcome.diagnosis.region_classes.len(), 1);
    assert_eq!(outcome.diagnosis.region_classes[0].region_count, expected);
    assert_eq!(outcome.diagnosis.region_classes[0].total_pixels, expected);
    assert_eq!(
        outcome.diagnosis.region_examples.len(),
        super::segment::REGION_EXAMPLE_LIMIT
    );
}

#[test]
fn golden_mixed_color_region_cannot_hide_visible_extra_paint() {
    let mut reference = canvas(80, 80);
    let mut candidate = canvas(80, 80);
    // A large same-coordinate recolour touches an adjacent extra-paint block.
    // Exact-class segmentation must preserve both components, and the visible
    // Extra component must still fail the verdict.
    fill(&mut reference, 20, 20, 39, 39, BLACK);
    fill(&mut candidate, 20, 20, 39, 39, Rgba([64, 64, 64, 255]));
    fill(&mut candidate, 40, 20, 43, 39, BLACK);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.verdict.dominant_class, PixelClass::ColorErr);
    assert_eq!(outcome.tally.extra_px, 80);
    assert_eq!(outcome.regions.total_count, 2);
    assert_eq!(outcome.regions.largest_area(PixelClass::Extra), 80);
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_tiny_disconnected_corner_fragments_are_raw_but_not_visible() {
    let mut reference = canvas(80, 80);
    let candidate = canvas(80, 80);
    // Four 5×4 physical-pixel corners: each is under the coherent-area and
    // long-span floors, and their 80px aggregate is under the global floor.
    // This models the imperceptible collapsed-border-corner AA residue seen in
    // a real table fixture while retaining every byte difference in the report.
    for (x, y) in [(5, 5), (70, 5), (5, 70), (70, 70)] {
        fill(&mut reference, x, y, x + 4, y + 3, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.missing_px, 80);
    assert_eq!(outcome.regions.total_count, 4);
    assert_eq!(outcome.regions.largest_area(PixelClass::Missing), 20);
    assert_eq!(outcome.regions.largest_span(PixelClass::Missing), 5);
    assert!(outcome.diff_pct > 0.0);
}

#[test]
fn golden_sub_css_pixel_glyph_edge_residue_is_not_visible_by_length_alone() {
    let mut reference = canvas(120, 80);
    let mut candidate = canvas(120, 80);
    // A 37-device-pixel (11.84 CSS px) glyph-edge fragment shifted by one
    // device pixel. Each direct-presence component is only 3.79 CSS px²: its
    // authored-scale area is below the fixed component floor even though its
    // length exceeds the former span-only cutoff.
    fill(&mut reference, 30, 20, 30, 56, BLACK);
    fill(&mut candidate, 31, 20, 31, 56, BLACK);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.missing_px, 37);
    assert_eq!(outcome.tally.extra_px, 37);
    assert_eq!(outcome.regions.largest_span(PixelClass::Missing), 37);
}

#[test]
fn golden_balanced_mixed_glyph_coverage_phase_is_not_visible() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);

    // Thirty separated glyph-like stems. Both rasters retain the same black
    // core; only their rounded coverage ramps differ. The aggregate is larger
    // than the disconnected-fragment floor, so this locks the mixed-coverage
    // rule rather than the ordinary small-component allowance.
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        let x1 = x0 + 5;
        fill(&mut reference, x0, 20, x1, 20, Rgba([220, 220, 220, 255]));
        fill(&mut reference, x0, 21, x1, 21, Rgba([210, 210, 210, 255]));
        fill(&mut reference, x0, 22, x1, 22, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 23, x1, 35, BLACK);
        fill(&mut reference, x0, 36, x1, 36, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 37, x1, 37, Rgba([210, 210, 210, 255]));

        fill(&mut candidate, x0, 21, x1, 21, Rgba([240, 240, 240, 255]));
        fill(&mut candidate, x0, 22, x1, 22, Rgba([190, 190, 190, 255]));
        fill(&mut candidate, x0, 23, x1, 35, BLACK);
        fill(&mut candidate, x0, 36, x1, 36, Rgba([130, 130, 130, 255]));
        fill(&mut candidate, x0, 37, x1, 37, Rgba([180, 180, 180, 255]));
        fill(&mut candidate, x0, 38, x1, 38, Rgba([220, 220, 220, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
    assert!(outcome.tally.color_coverage_bias <= VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS);
    assert!(outcome.tally.missing_px + outcome.tally.extra_px > 150);
    assert!(outcome.tally.color_px >= 2 * (outcome.tally.missing_px + outcome.tally.extra_px));
}

#[test]
fn golden_hue_preserving_mixed_glyph_coverage_phase_is_not_visible() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);

    // The baseline phase retains the same neutral ink family but its coverage
    // energy is intentionally biased. This models two PDFs whose fractional
    // text baselines differ: all raw pixels remain reported, while no
    // untrained reader can see a separate authored recolour.
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        let x1 = x0 + 5;
        fill(&mut reference, x0, 20, x1, 20, Rgba([220, 220, 220, 255]));
        fill(&mut reference, x0, 21, x1, 21, Rgba([210, 210, 210, 255]));
        fill(&mut reference, x0, 22, x1, 22, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 23, x1, 35, BLACK);
        fill(&mut reference, x0, 36, x1, 36, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 37, x1, 37, Rgba([210, 210, 210, 255]));

        fill(&mut candidate, x0, 21, x1, 21, Rgba([240, 240, 240, 255]));
        fill(&mut candidate, x0, 22, x1, 22, Rgba([190, 190, 190, 255]));
        fill(&mut candidate, x0, 23, x1, 35, BLACK);
        fill(&mut candidate, x0, 36, x1, 36, Rgba([150, 150, 150, 255]));
        fill(&mut candidate, x0, 37, x1, 37, Rgba([200, 200, 200, 255]));
        fill(&mut candidate, x0, 38, x1, 38, Rgba([220, 220, 220, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.color_coverage_bias > VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS);
    assert!(outcome.tally.color_errors_preserve_hue);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert!(visibility::is_mixed_coverage_phase(
        &outcome.tally,
        &outcome.regions
    ));
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_conserved_sub_css_glyph_coverage_phase_is_not_visible() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);
    let ramp = [
        Rgba([220, 220, 220, 255]),
        Rgba([160, 160, 160, 255]),
        BLACK,
        BLACK,
        Rgba([160, 160, 160, 255]),
        Rgba([220, 220, 220, 255]),
    ];
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        for (row, color) in ramp.into_iter().enumerate() {
            let y = 20 + row as u32;
            fill(&mut reference, x0, y, x0 + 5, y, color);
            fill(&mut candidate, x0, y + 1, x0 + 5, y + 1, color);
        }
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.rgba_histograms_match);
    assert!(visibility::is_conserved_sub_css_coverage_phase(
        &outcome.tally,
        &outcome.regions
    ));
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_conserved_histogram_cannot_hide_an_interior_colour_swap() {
    let mut reference = canvas(360, 120);
    let mut candidate = canvas(360, 120);
    let ramp = [
        Rgba([220, 220, 220, 255]),
        Rgba([160, 160, 160, 255]),
        BLACK,
        BLACK,
        Rgba([160, 160, 160, 255]),
        Rgba([220, 220, 220, 255]),
    ];
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        for (row, color) in ramp.into_iter().enumerate() {
            let y = 20 + row as u32;
            fill(&mut reference, x0, y, x0 + 5, y, color);
            fill(&mut candidate, x0, y + 1, x0 + 5, y + 1, color);
        }
    }
    let red = Rgba([190, 20, 20, 255]);
    let blue = Rgba([20, 20, 190, 255]);
    fill(&mut reference, 80, 70, 119, 99, red);
    fill(&mut reference, 180, 70, 219, 99, blue);
    fill(&mut candidate, 80, 70, 119, 99, blue);
    fill(&mut candidate, 180, 70, 219, 99, red);

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.rgba_histograms_match);
    assert!(outcome.tally.interior_color_pct > 0.0);
    assert!(!visibility::is_conserved_sub_css_coverage_phase(
        &outcome.tally,
        &outcome.regions
    ));
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_proven_ramps_allow_only_a_compact_boundary_remainder() {
    let mut reference = canvas(360, 120);
    let mut candidate = canvas(360, 120);
    let ramp = [
        Rgba([220, 220, 220, 255]),
        Rgba([160, 160, 160, 255]),
        BLACK,
        BLACK,
        Rgba([160, 160, 160, 255]),
        Rgba([220, 220, 220, 255]),
    ];
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        for (row, color) in ramp.into_iter().enumerate() {
            let y = 20 + row as u32;
            fill(&mut reference, x0, y, x0 + 5, y, color);
            fill(&mut candidate, x0, y + 1, x0 + 5, y + 1, color);
        }
    }

    let red = Rgba([200, 0, 0, 255]);
    let blue = Rgba([0, 0, 200, 255]);
    for image in [&mut reference, &mut candidate] {
        fill(image, 40, 60, 40, 64, red);
        fill(image, 47, 60, 47, 64, blue);
    }
    for y in 61..=64 {
        for (offset, reference_blue) in [28u8, 56, 84, 112, 140, 168].into_iter().enumerate() {
            let candidate_blue = 196 - reference_blue;
            reference.put_pixel(
                41 + offset as u32,
                y,
                Rgba([200 - reference_blue, 0, reference_blue, 255]),
            );
            candidate.put_pixel(
                41 + offset as u32,
                y,
                Rgba([200 - candidate_blue, 0, candidate_blue, 255]),
            );
        }
    }
    reference.put_pixel(41, 60, Rgba([120, 0, 80, 255]));
    reference.put_pixel(42, 60, Rgba([60, 0, 140, 255]));
    candidate.put_pixel(41, 60, Rgba([60, 0, 140, 255]));
    candidate.put_pixel(42, 60, Rgba([120, 0, 80, 255]));
    fill(&mut reference, 43, 60, 47, 60, blue);
    fill(&mut candidate, 43, 60, 47, 60, blue);
    let outcome = run(&candidate, &reference);
    dump("compact_ramp_remainder", &outcome);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert!(
        outcome
            .regions
            .shared_coverage_color_with_compact_remainder()
    );
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_one_endpointless_fragment_can_accompany_direct_ramps() {
    let mut reference = canvas(360, 120);
    fill(&mut reference, 40, 20, 319, 79, BLACK);
    let mut candidate = reference.clone();
    for x in 50..310 {
        reference.put_pixel(x, 20, Rgba([128, 128, 128, 255]));
        candidate.put_pixel(x, 20, Rgba([96, 96, 96, 255]));
    }
    reference.put_pixel(20, 100, Rgba([245, 245, 245, 255]));
    candidate.put_pixel(20, 100, Rgba([243, 243, 243, 255]));

    let outcome = run(&candidate, &reference);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert!(
        outcome
            .regions
            .shared_coverage_color_with_compact_remainder()
    );
    assert_eq!(
        outcome
            .regions
            .aggregates
            .iter()
            .find(|aggregate| aggregate.class == PixelClass::ColorErr)
            .map(|aggregate| aggregate.sub_visibility_unproven_color_fragment_px),
        Some(1)
    );
}

#[test]
fn golden_endpointless_color_fragments_cannot_accumulate_into_ramp_proof() {
    let mut reference = canvas(360, 120);
    fill(&mut reference, 40, 20, 319, 79, BLACK);
    let mut candidate = reference.clone();
    for x in 50..310 {
        reference.put_pixel(x, 20, Rgba([128, 128, 128, 255]));
        candidate.put_pixel(x, 20, Rgba([96, 96, 96, 255]));
    }
    for fragment in 0..40 {
        let x = 20 + fragment * 8;
        reference.put_pixel(x, 100, Rgba([245, 245, 245, 255]));
        candidate.put_pixel(x, 100, Rgba([243, 243, 243, 255]));
    }

    let outcome = run(&candidate, &reference);
    dump("endpointless_fragments", &outcome);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert!(outcome.tally.color_errors_have_css_anchors);
    assert!(
        !outcome
            .regions
            .shared_coverage_color_with_compact_remainder()
    );
    // The independent page-level colour JND still accepts these deliberately
    // near-white samples; this assertion pins only that they cannot borrow the
    // stronger shared-ramp proof.
    assert!(outcome.tally.color_de < super::super::config::VISUAL_COLOR_JND);
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_neutral_recolour_with_paired_presence_is_not_a_coverage_phase() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);

    // First construct an otherwise valid mixed coverage phase. The small
    // neutral recolour below is deliberately unrelated to its shared outline:
    // same hue must not waive the direct topology proof.
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        let x1 = x0 + 5;
        fill(&mut reference, x0, 20, x1, 20, Rgba([220, 220, 220, 255]));
        fill(&mut reference, x0, 21, x1, 21, Rgba([210, 210, 210, 255]));
        fill(&mut reference, x0, 22, x1, 22, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 23, x1, 35, BLACK);
        fill(&mut reference, x0, 36, x1, 36, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 37, x1, 37, Rgba([210, 210, 210, 255]));

        fill(&mut candidate, x0, 21, x1, 21, Rgba([240, 240, 240, 255]));
        fill(&mut candidate, x0, 22, x1, 22, Rgba([190, 190, 190, 255]));
        fill(&mut candidate, x0, 23, x1, 35, BLACK);
        fill(&mut candidate, x0, 36, x1, 36, Rgba([150, 150, 150, 255]));
        fill(&mut candidate, x0, 37, x1, 37, Rgba([200, 200, 200, 255]));
        fill(&mut candidate, x0, 38, x1, 38, Rgba([220, 220, 220, 255]));
    }
    fill(&mut reference, 150, 60, 209, 60, Rgba([80, 80, 80, 255]));
    fill(&mut candidate, 150, 60, 209, 60, Rgba([180, 180, 180, 255]));

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.color_errors_preserve_hue);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert!(!visibility::is_mixed_coverage_phase(
        &outcome.tally,
        &outcome.regions
    ));
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_non_outline_presence_cannot_hide_behind_a_shared_colour_ramp() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);

    // This is an accepted direct colour-ramp phase.
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        let x1 = x0 + 5;
        fill(&mut reference, x0, 20, x1, 20, Rgba([220, 220, 220, 255]));
        fill(&mut reference, x0, 21, x1, 21, Rgba([210, 210, 210, 255]));
        fill(&mut reference, x0, 22, x1, 22, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 23, x1, 35, BLACK);
        fill(&mut reference, x0, 36, x1, 36, Rgba([160, 160, 160, 255]));
        fill(&mut reference, x0, 37, x1, 37, Rgba([210, 210, 210, 255]));

        fill(&mut candidate, x0, 21, x1, 21, Rgba([240, 240, 240, 255]));
        fill(&mut candidate, x0, 22, x1, 22, Rgba([190, 190, 190, 255]));
        fill(&mut candidate, x0, 23, x1, 35, BLACK);
        fill(&mut candidate, x0, 36, x1, 36, Rgba([130, 130, 130, 255]));
        fill(&mut candidate, x0, 37, x1, 37, Rgba([180, 180, 180, 255]));
        fill(&mut candidate, x0, 38, x1, 38, Rgba([220, 220, 220, 255]));
    }

    // These paired Missing/Extra islands are not shared-outline bands. Their
    // apparent balance cannot inherit the unrelated colour-ramp proof above.
    for island in 0..20 {
        let x = 10 + island * 16;
        fill(&mut reference, x, 60, x + 2, 62, BLACK);
        fill(&mut candidate, x + 6, 60, x + 8, 62, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert!(!outcome.regions.only_sub_css_coverage_presence_residues());
    assert!(!visibility::is_mixed_coverage_phase(
        &outcome.tally,
        &outcome.regions
    ));
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_balanced_binary_speckles_are_not_a_coverage_phase() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);

    // Equal amounts of black paint moving between disconnected tiny islands are
    // still visible. They deliberately lack the overlapping ColorErr coverage
    // that a rounded shared outline provides.
    for island in 0..20 {
        let x = 10 + island * 16;
        fill(&mut reference, x, 20, x + 2, 22, BLACK);
        fill(&mut candidate, x + 6, 20, x + 8, 22, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Fail);
    assert_eq!(outcome.tally.color_px, 0);
}

#[test]
fn golden_balanced_chromatic_mixed_edges_are_not_a_coverage_phase() {
    let mut reference = canvas(360, 100);
    let mut candidate = canvas(360, 100);
    let red = Rgba([180, 30, 30, 255]);
    let dark_red = Rgba([120, 20, 20, 255]);
    let blue = Rgba([30, 30, 180, 255]);
    let dark_blue = Rgba([20, 20, 120, 255]);

    // It has the same presence mass and component sizes as the accepted
    // coverage fixture, but its overlapping samples consistently change red
    // into blue. This is a visible recolour, not an antialiasing phase.
    for glyph in 0..30 {
        let x0 = 10 + glyph * 11;
        let x1 = x0 + 5;
        fill(&mut reference, x0, 20, x1, 20, red);
        fill(&mut reference, x0, 21, x1, 21, red);
        fill(&mut reference, x0, 22, x1, 22, dark_red);
        fill(&mut reference, x0, 23, x1, 35, BLACK);
        fill(&mut reference, x0, 36, x1, 36, dark_red);
        fill(&mut reference, x0, 37, x1, 37, red);

        fill(&mut candidate, x0, 21, x1, 21, blue);
        fill(&mut candidate, x0, 22, x1, 22, dark_blue);
        fill(&mut candidate, x0, 23, x1, 35, BLACK);
        fill(&mut candidate, x0, 36, x1, 36, dark_blue);
        fill(&mut candidate, x0, 37, x1, 37, blue);
        fill(&mut candidate, x0, 38, x1, 38, red);
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Fail);
    assert!(outcome.tally.color_px >= 2 * (outcome.tally.missing_px + outcome.tally.extra_px));
    assert!(outcome.tally.color_coverage_bias > VISUAL_BALANCED_EDGE_COLOR_MAX_BIAS);
    assert!(!outcome.tally.color_errors_preserve_hue);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
}

#[test]
fn golden_dimension_mismatch_fails_even_with_white_surplus() {
    let mut reference = canvas(200, 200);
    fill(&mut reference, 20, 20, 80, 80, BLACK);
    let mut candidate = canvas(204, 203);
    fill(&mut candidate, 20, 20, 80, 80, BLACK);
    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Fail);
    assert_eq!(o.diff_pct, 0.0);
    assert_eq!(o.diagnosis.primary_class, "PageSize");
}

#[test]
fn golden_page_rounding_never_trims_painted_content() {
    let reference = canvas(200, 200);
    let mut candidate = canvas(204, 200);
    fill(&mut candidate, 201, 20, 203, 80, BLACK);
    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Fail);
    assert!(o.diff_pct > 0.0);
}

#[test]
fn golden_large_page_dimension_mismatch_is_failure() {
    let reference = canvas(200, 200);
    let candidate = canvas(209, 200);
    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Fail);
    assert_eq!(
        o.diff_pct, 0.0,
        "raw ink remains identical on blank surplus"
    );
    assert_eq!(o.diagnosis.primary_class, "PageSize");
}

#[test]
fn golden_sub_css_pixel_page_rounding_is_visually_accepted() {
    let reference = canvas(200, 200);
    let candidate = canvas(201, 200);
    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Pass);
    assert_eq!(o.diff_pct, 0.0);
}

#[test]
fn golden_phase_swapped_checkerboard_is_color_error() {
    let mut reference = canvas(120, 120);
    let mut candidate = canvas(120, 120);
    let red = Rgba([198, 40, 40, 255]);
    for y in 10..110 {
        for x in 10..110 {
            let phase = ((x - 10) / 4 + (y - 10) / 4) % 2;
            reference.put_pixel(x, y, if phase == 0 { BLACK } else { red });
            candidate.put_pixel(x, y, if phase == 0 { red } else { BLACK });
        }
    }
    let o = run(&candidate, &reference);
    dump("phase_swapped_colors", &o);
    assert_eq!(o.status, Status::Fail);
    assert_eq!(o.verdict.dominant_class, PixelClass::ColorErr);
    assert_eq!(o.tally.color_pct, 100.0);
    assert_eq!(o.tally.missing_pct, 0.0);
    assert_eq!(o.tally.extra_pct, 0.0);
    assert!(
        o.diagnosis
            .region_classes
            .iter()
            .all(|summary| summary.class == "ColorErr")
    );
}

#[test]
fn golden_adjacent_swapped_colors_are_two_exact_mismatches() {
    let red = Rgba([198, 40, 40, 255]);
    let blue = Rgba([25, 118, 210, 255]);
    let reference = ImageBuffer::from_fn(2, 1, |x, _| if x == 0 { red } else { blue });
    let candidate = ImageBuffer::from_fn(2, 1, |x, _| if x == 0 { blue } else { red });

    let outcome = run(&candidate, &reference);

    assert_eq!(outcome.status, Status::Fail);
    assert_eq!(outcome.tally.different_px, 2);
    assert_eq!(outcome.tally.color_pct, 100.0);
    assert_eq!(outcome.tally.missing_pct, 0.0);
    assert_eq!(outcome.tally.extra_pct, 0.0);
    assert_eq!(outcome.verdict.dominant_class, PixelClass::ColorErr);
}

#[test]
fn golden_balanced_chromatic_edge_swap_remains_visible() {
    let red = Rgba([198, 40, 40, 255]);
    let cyan = Rgba([25, 118, 210, 255]);
    let mut reference = canvas(80, 80);
    let mut candidate = canvas(80, 80);
    // The two changed strips have precisely cancelling RGB energy and sit next
    // to unchanged paper. They are nonetheless an obvious red/cyan swap, so
    // neutral coverage phase must not waive them.
    fill(&mut reference, 10, 20, 69, 21, red);
    fill(&mut reference, 10, 30, 69, 31, cyan);
    fill(&mut candidate, 10, 20, 69, 21, cyan);
    fill(&mut candidate, 10, 30, 69, 31, red);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.tally.color_coverage_bias, 0.0);
    assert!(outcome.tally.color_errors_have_css_anchors);
    assert!(!outcome.regions.large_color_components_are_balanced());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_missing_near_duplicate_remains_missing() {
    let mut reference = canvas(120, 80);
    let mut candidate = canvas(120, 80);
    fill(&mut reference, 10, 10, 20, 20, BLACK);
    fill(&mut candidate, 10, 10, 20, 20, BLACK);
    fill(&mut reference, 50, 30, 50, 60, BLACK);
    fill(&mut reference, 52, 30, 52, 60, BLACK);
    fill(&mut candidate, 52, 30, 52, 60, BLACK);

    let o = run(&candidate, &reference);
    assert_ne!(o.status, Status::Pass);
    assert!(
        o.tally.missing_pct > 0.5,
        "an entirely absent nearby duplicate must remain Missing"
    );
}

#[test]
fn golden_relocated_box_5px_is_missing_and_extra() {
    let reference = box_frame();
    let cand = relocate_pixels(&reference, 5, 5);
    let o = run(&cand, &reference);
    dump("relocated_box_5px", &o);
    assert_eq!(o.status, Status::Fail);
    assert!(o.tally.missing_pct > 0.0);
    assert!(o.tally.extra_pct > 0.0);
    assert_eq!(o.tally.color_pct, 0.0);
}

#[test]
fn golden_relocated_box_12px_is_missing_and_extra() {
    let reference = box_frame();
    let cand = relocate_pixels(&reference, 12, 12);
    let o = run(&cand, &reference);
    dump("relocated_box_12px", &o);
    assert_eq!(o.status, Status::Fail);
    assert!(o.tally.missing_pct > 0.0);
    assert!(o.tally.extra_pct > 0.0);
    assert_eq!(o.tally.color_pct, 0.0);
}

#[test]
fn golden_box_too_tall_13px() {
    // Candidate box is 13px taller at the bottom only (box-sizing not applied).
    let reference = box_frame(); // box [40..159] in y
    let mut cand = canvas(200, 200);
    fill(&mut cand, 40, 40, 159, 172, BLACK); // +13px on the bottom
    let o = run(&cand, &reference);
    dump("box_too_tall_13px", &o);
    assert_eq!(o.status, Status::Fail, "a +13px box must FAIL");
    assert!(o.tally.extra_pct > 0.0);
    assert_eq!(o.tally.missing_pct, 0.0);
    assert_eq!(o.tally.color_pct, 0.0);
}

#[test]
fn golden_box_offby1() {
    // A one-device-pixel edge extension is real raw PDF evidence, but is only
    // 0.32 CSS px at the pinned 300 DPI and is not human-visible in isolation.
    let mut reference = canvas(520, 520);
    fill(&mut reference, 5, 5, 504, 504, BLACK); // 500x500
    let mut cand = canvas(520, 520);
    fill(&mut cand, 5, 5, 505, 505, BLACK); // 501x501 (+1 device px R & B)
    let o = run(&cand, &reference);
    dump("box_offby1", &o);
    assert_eq!(
        o.status,
        Status::Pass,
        "a one-device-pixel edge phase is below one authored CSS pixel"
    );
    assert!(
        o.tally.extra_pct > 0.0,
        "a real size extension remains measured as extra content"
    );
}

#[test]
fn golden_sub_css_tone_ramp_phase_is_not_visible() {
    let mut reference = canvas(80, 80);
    let mut candidate = canvas(80, 80);
    fill(&mut reference, 20, 10, 57, 69, BLACK);
    fill(&mut candidate, 20, 10, 57, 69, BLACK);

    let dark = Rgba([110, 110, 110, 255]);
    let light = Rgba([140, 140, 140, 255]);
    fill(&mut reference, 58, 10, 58, 69, dark);
    fill(&mut reference, 59, 10, 59, 69, light);
    fill(&mut candidate, 58, 10, 58, 69, light);
    fill(&mut candidate, 59, 10, 59, 69, dark);

    let o = run(&candidate, &reference);
    dump("tone_ramp_change", &o);
    assert_eq!(o.status, Status::Pass);
    assert!(o.tally.color_pct > 0.0);
    assert_eq!(o.tally.missing_pct, 0.0);
    assert_eq!(o.tally.extra_pct, 0.0);
}

#[test]
fn golden_one_pixel_relocated_edge_is_missing_and_extra() {
    let mut reference = canvas(80, 80);
    let mut candidate = canvas(80, 80);
    fill(&mut reference, 30, 10, 30, 69, BLACK);
    fill(&mut candidate, 31, 10, 31, 69, BLACK);

    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Fail);
    assert!(o.tally.missing_pct > 0.0 && o.tally.extra_pct > 0.0);
}

#[test]
fn golden_large_shape_with_one_device_pixel_outline_phase_is_not_visible() {
    let mut reference = canvas(180, 180);
    let mut candidate = canvas(180, 180);
    let center = 90_i32;
    let radius = 55_i32;
    for y in 0..180_i32 {
        for x in 0..180_i32 {
            if (x - center).abs() + (y - center).abs() <= radius {
                reference.put_pixel(x as u32, y as u32, BLACK);
                candidate.put_pixel((x + 1) as u32, y as u32, BLACK);
            }
        }
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert!(outcome.tally.missing_px > 0 && outcome.tally.extra_px > 0);
    assert!(outcome.tally.shared_content_ratio > 0.9);
    assert_eq!(outcome.tally.presence_outside_edge_band_px, 0);
    assert!(visibility::is_stable_shared_outline_phase(
        &outcome.visibility.tally,
        &outcome.visibility.regions,
    ));
}

#[test]
fn golden_one_sided_sub_css_coverage_ramp_is_not_visible() {
    let mut reference = canvas(500, 500);
    let mut candidate = canvas(500, 500);
    let reference_edge = Rgba([140, 140, 140, 255]);
    // Deliberately high-contrast samples prove that direct unchanged-endpoint
    // topology, not an arbitrary Delta-E cap, identifies the coverage phase.
    let candidate_outer_edge = Rgba([200, 200, 200, 255]);
    let candidate_middle_edge = Rgba([145, 145, 145, 255]);
    let candidate_inner_edge = Rgba([40, 40, 40, 255]);

    // Both rasters share the complete solid interior. The candidate merely
    // distributes the same authored outline over one additional device sample
    // (0.32 CSS px at 300 DPI), leaving one-sided Extra plus ColorErr evidence.
    fill(&mut reference, 30, 30, 469, 469, reference_edge);
    fill(&mut reference, 33, 33, 466, 466, BLACK);
    fill(&mut candidate, 29, 29, 470, 470, candidate_outer_edge);
    fill(&mut candidate, 30, 30, 469, 469, candidate_middle_edge);
    fill(&mut candidate, 32, 32, 467, 467, candidate_inner_edge);
    fill(&mut candidate, 33, 33, 466, 466, BLACK);

    let outcome = run(&candidate, &reference);
    dump("one_sided_sub_css", &outcome);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.missing_px, 0);
    assert!(outcome.tally.extra_px > 0 && outcome.tally.color_px > 0);
    assert!(outcome.tally.color_de > 7.0);
    assert!(outcome.tally.shared_content_ratio > 0.9);
    assert!(visibility::is_one_sided_sub_css_coverage_phase(
        &outcome.visibility.tally,
        &outcome.visibility.regions,
    ));
}

#[test]
fn golden_glyph_like_displacement_is_a_defect() {
    let mut reference = canvas(120, 60);
    let mut candidate = canvas(120, 60);
    for x in (10..100).step_by(9) {
        fill(&mut reference, x, 15, x + 2, 44, BLACK);
        fill(&mut candidate, x + 1, 15, x + 3, 44, BLACK);
    }

    let o = run(&candidate, &reference);
    assert_eq!(o.status, Status::Fail);
    assert!(o.tally.different_px > 0);
}

#[test]
fn golden_box_offby1_css() {
    // Companion to box_offby1: a real one-CSS-pixel size error.
    let mut reference = canvas(520, 520);
    fill(&mut reference, 5, 5, 504, 504, BLACK);
    let mut cand = canvas(520, 520);
    fill(&mut cand, 5, 5, 508, 508, BLACK); // +4 device px R & B ~= 1.28 CSS px
    let o = run(&cand, &reference);
    dump("box_offby1_css", &o);
    assert_eq!(o.status, Status::Fail);
    assert!(o.tally.extra_pct > 0.0);
    assert_eq!(o.tally.missing_pct, 0.0);
    assert!(!visibility::is_one_sided_sub_css_coverage_phase(
        &o.visibility.tally,
        &o.visibility.regions,
    ));
}

#[test]
fn golden_recolor_c00_d00() {
    // Fill #cc0000 vs #dd0000. The whole box is recoloured and exact comparison
    // fails; the measured Delta-E remains useful diagnosis.
    let reference = box_frame_colored(Rgba([0xdd, 0, 0, 255]));
    let cand = box_frame_colored(Rgba([0xcc, 0, 0, 255]));
    let o = run(&cand, &reference);
    dump("recolor_c00_d00", &o);
    assert_eq!(o.status, Status::Fail, "a full-area recolour must FAIL");
    assert_eq!(
        o.verdict.dominant_class,
        PixelClass::ColorErr,
        "dominant must be ColorErr"
    );
    assert!(
        o.tally.color_de > 2.5 && o.tally.color_de < 5.0,
        "ΔE for #cc0000 vs #dd0000 is ~3.56, got {:.3}",
        o.tally.color_de
    );
}

#[test]
fn golden_colorspace_gamma() {
    // sRGB-encoded vs linear-light grey gradient. The mid-tones diverge enough to
    // exceed the JND -> ColorErr over a large area -> NOT PASS. (The ColorSpace
    // sub-classification itself is C4; at C3 we assert status != PASS + ColorErr.)
    let w = 200u32;
    let h = 120u32;
    let mut srgb = canvas(w, h);
    let mut lin = canvas(w, h);
    for x in 0..w {
        let t = x as f64 / (w as f64 - 1.0); // 0..1 ramp
        // sRGB reference: value == t (already display-encoded).
        let s = (t * 255.0).round().clamp(0.0, 255.0) as u8;
        // linear candidate: same light intensity but display-encoded differently
        // (apply the sRGB OETF to the linear value) -> the classic gamma drift.
        let enc = if t <= 0.0031308 {
            t * 12.92
        } else {
            1.055 * t.powf(1.0 / 2.4) - 0.055
        };
        let l = (enc * 255.0).round().clamp(0.0, 255.0) as u8;
        for y in 10..h - 10 {
            srgb.put_pixel(x, y, Rgba([s, s, s, 255]));
            lin.put_pixel(x, y, Rgba([l, l, l, 255]));
        }
    }
    let o = run(&lin, &srgb);
    dump("colorspace_gamma", &o);
    assert_ne!(
        o.status,
        Status::Pass,
        "a gamma/colour-space drift must NOT pass"
    );
    assert_eq!(
        o.verdict.dominant_class,
        PixelClass::ColorErr,
        "dominant must be ColorErr"
    );
}

#[test]
fn golden_opacity_half() {
    // Candidate paints an OPAQUE red box; reference paints the SAME red at 50%
    // over white (= pink #ff8080). Both ink, aligned, large ΔE -> ColorErr over
    // the whole box -> FAIL. (Recovering α≈0.5 is the C4 AlphaCompositing
    // sub-classifier; at C3 we assert FAIL + ColorErr, the honest C3 signal.)
    let cand = box_frame_colored(Rgba([255, 0, 0, 255])); // opaque red
    let reference = box_frame_colored(Rgba([255, 128, 128, 255])); // red @ 0.5 over white
    let o = run(&cand, &reference);
    dump("opacity_half", &o);
    assert_eq!(o.status, Status::Fail, "uncomposited opacity must FAIL");
    assert_eq!(
        o.verdict.dominant_class,
        PixelClass::ColorErr,
        "dominant must be ColorErr"
    );
    assert!(
        o.tally.color_de >= 6.0,
        "0.5-blend ΔE must be large, got {:.3}",
        o.tally.color_de
    );
}

#[test]
fn golden_missing_box() {
    // Reference paints a box; candidate is blank -> 100% Missing -> FAIL.
    let reference = box_frame();
    let cand = canvas(200, 200);
    let o = run(&cand, &reference);
    dump("missing_box", &o);
    assert_eq!(o.tally.color_px, 0);
    assert_eq!(o.tally.modal_drgba, [0; 4]);
    assert_eq!(o.tally.color_coverage_bias, 0.0);
    assert!(!o.tally.color_errors_have_css_anchors);
    assert!(!o.tally.color_errors_preserve_hue);
    assert_eq!(o.status, Status::Fail, "a blank candidate must FAIL");
    assert_eq!(
        o.verdict.dominant_class,
        PixelClass::Missing,
        "dominant must be Missing"
    );
    assert!(
        o.tally.missing_pct >= 50.0,
        "missing_pct must be ~100, got {:.2}",
        o.tally.missing_pct
    );
}

#[test]
fn golden_extra_box() {
    // Candidate paints a box; reference is blank -> Extra -> FAIL (well over the
    // exact comparison fails.
    let cand = box_frame();
    let reference = canvas(200, 200);
    let o = run(&cand, &reference);
    dump("extra_box", &o);
    assert_eq!(o.status, Status::Fail, "extra paint must fail");
    assert_eq!(
        o.verdict.dominant_class,
        PixelClass::Extra,
        "dominant must be Extra"
    );
    assert!(
        o.tally.extra_pct > 6.0,
        "extra_pct must describe the extra paint, got {:.2}",
        o.tally.extra_pct
    );
}

#[test]
fn golden_sub_css_pixel_aligned_edge_recolor_is_raw_evidence_but_passes() {
    // Both images retain the same thin boundary; only the renderer's
    // antialiasing coverage tone changes at that coordinate.
    let mut a = canvas(200, 200);
    fill(&mut a, 40, 40, 159, 159, BLACK);
    let mut b = a.clone();
    // Different authored boundary tones at the same coordinate.
    for y in 41..=158 {
        a.put_pixel(40, y, Rgba([96, 96, 96, 255]));
        b.put_pixel(40, y, Rgba([128, 128, 128, 255]));
    }
    let o = run(&b, &a);
    dump("aligned_edge_recolor", &o);
    assert_eq!(
        o.status,
        Status::Pass,
        "a sub-CSS-pixel edge residual is not a visible defect"
    );
    assert!(
        o.tally.color_pct > 0.0,
        "recolored rule must produce ColorErr, got {:.3}",
        o.tally.color_pct
    );
    assert!(o.regions.only_shared_coverage_color_residues());
}

#[test]
fn golden_repeated_one_device_pixel_outline_coverage_is_still_not_visible() {
    // The aggregate is deliberately above the old 1% colour-coverage cutoff.
    // Every direct mismatch is nevertheless a one-device-pixel-wide shared
    // paper/ink transition, so it remains an antialiasing sample rather than a
    // visible flat recolour.
    let mut reference = canvas(100, 100);
    fill(&mut reference, 20, 20, 79, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 21..=78 {
        reference.put_pixel(20, y, Rgba([96, 96, 96, 255]));
        candidate.put_pixel(20, y, Rgba([128, 128, 128, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.color_pct > 1.0);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_sub_css_outline_recolor_is_not_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 20, 20, 79, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 21..=78 {
        for x in 20..=21 {
            reference.put_pixel(x, y, Rgba([96, 96, 96, 255]));
            candidate.put_pixel(x, y, Rgba([128, 128, 128, 255]));
        }
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.color_pct > 1.0);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_css_plus_one_outline_recolor_remains_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 20, 20, 79, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 21..=78 {
        for x in 20..=23 {
            reference.put_pixel(x, y, Rgba([96, 96, 96, 255]));
            candidate.put_pixel(x, y, Rgba([128, 128, 128, 255]));
        }
    }

    let outcome = run(&candidate, &reference);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_thin_authored_recolor_is_not_coverage() {
    let mut reference = canvas(100, 100);
    let mut candidate = reference.clone();
    let background = Rgba([231, 239, 240, 255]);
    fill(&mut reference, 23, 20, 79, 79, background);
    fill(&mut candidate, 23, 20, 79, 79, background);
    fill(&mut reference, 20, 20, 22, 79, Rgba([198, 40, 40, 255]));
    fill(&mut candidate, 20, 20, 22, 79, Rgba([25, 118, 210, 255]));

    let outcome = run(&candidate, &reference);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_inner_one_device_pixel_recolor_remains_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 20, 20, 79, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 21..=78 {
        reference.put_pixel(50, y, Rgba([96, 96, 96, 255]));
        candidate.put_pixel(50, y, Rgba([128, 128, 128, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.color_pct > 1.0);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_canvas_edge_coverage_uses_direct_ramp_proof() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 20, 20, 99, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 20..=79 {
        reference.put_pixel(99, y, Rgba([128, 128, 128, 255]));
        candidate.put_pixel(99, y, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_one_device_pixel_canvas_edge_chromatic_frontier_is_sub_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 80, 20, 99, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 20..=79 {
        reference.put_pixel(99, y, Rgba([198, 40, 40, 255]));
        candidate.put_pixel(99, y, Rgba([25, 118, 210, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert!(outcome.regions.only_coherent_sub_authored_color_frontiers());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_two_device_pixel_canvas_edge_chromatic_frontier_is_sub_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 80, 20, 99, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 20..=79 {
        for x in 98..=99 {
            reference.put_pixel(x, y, Rgba([198, 40, 40, 255]));
            candidate.put_pixel(x, y, Rgba([25, 118, 210, 255]));
        }
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.regions.only_coherent_sub_authored_color_frontiers());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_three_device_pixel_canvas_edge_chromatic_frontier_remains_visible() {
    let mut reference = canvas(100, 100);
    fill(&mut reference, 80, 20, 99, 79, BLACK);
    let mut candidate = reference.clone();
    for y in 20..=79 {
        for x in 97..=99 {
            reference.put_pixel(x, y, Rgba([198, 40, 40, 255]));
            candidate.put_pixel(x, y, Rgba([25, 118, 210, 255]));
        }
    }

    let outcome = run(&candidate, &reference);
    assert!(!outcome.regions.only_coherent_sub_authored_color_frontiers());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_repeated_sub_authored_chromatic_frontiers_remain_visible() {
    let mut reference = canvas(180, 140);
    let mut candidate = reference.clone();
    for frontier in 0..5 {
        let x0 = 20 + frontier * 30;
        fill(&mut reference, x0, 20, x0 + 19, 119, BLACK);
        fill(&mut candidate, x0, 20, x0 + 19, 119, BLACK);
        fill(
            &mut reference,
            x0 + 18,
            20,
            x0 + 19,
            119,
            Rgba([198, 40, 40, 255]),
        );
        fill(
            &mut candidate,
            x0 + 18,
            20,
            x0 + 19,
            119,
            Rgba([25, 118, 210, 255]),
        );
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.regions.region_count(PixelClass::ColorErr), 5);
    assert!(!outcome.regions.only_coherent_sub_authored_color_frontiers());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_repeated_single_sample_chromatic_frontiers_are_device_quantization() {
    let mut reference = canvas(180, 140);
    let mut candidate = reference.clone();
    for frontier in 0..5 {
        let x0 = 20 + frontier * 30;
        fill(&mut reference, x0, 20, x0 + 19, 119, BLACK);
        fill(&mut candidate, x0, 20, x0 + 19, 119, BLACK);
        fill(
            &mut reference,
            x0 + 19,
            20,
            x0 + 19,
            119,
            Rgba([198, 40, 40, 255]),
        );
        fill(
            &mut candidate,
            x0 + 19,
            20,
            x0 + 19,
            119,
            Rgba([25, 118, 210, 255]),
        );
    }

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.regions.region_count(PixelClass::ColorErr), 5);
    assert!(outcome.regions.only_coherent_sub_authored_color_frontiers());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_stacked_border_edge_uses_one_shared_foreground() {
    let yellow = Rgba([253, 216, 53, 255]);
    let mut reference = canvas(180, 100);
    fill(&mut reference, 40, 20, 139, 79, yellow);
    fill(&mut reference, 40, 20, 50, 79, Rgba([17, 17, 17, 255]));
    let mut candidate = reference.clone();

    for y in 21..=78 {
        candidate.put_pixel(40, y, Rgba([171, 171, 171, 255]));
        reference.put_pixel(40, y, Rgba([99, 86, 29, 255]));
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_long_layered_inset_shadow_frontier_is_sub_visible() {
    let stage = Rgba([247, 250, 252, 255]);
    let background = Rgba([231, 245, 255, 255]);
    let border = Rgba([87, 117, 144, 255]);
    let shadow = Rgba([255, 209, 102, 255]);
    let blended_shadow = Rgba([246, 221, 155, 255]);
    let mut reference = ImageBuffer::from_pixel(520, 200, stage);
    let mut candidate = reference.clone();
    fill(&mut reference, 60, 60, 459, 65, border);
    fill(&mut candidate, 60, 60, 459, 65, border);
    fill(&mut reference, 60, 66, 459, 66, blended_shadow);
    fill(&mut candidate, 60, 66, 459, 66, shadow);
    fill(&mut reference, 60, 67, 459, 72, shadow);
    fill(&mut candidate, 60, 67, 459, 72, shadow);
    fill(&mut reference, 60, 73, 459, 160, background);
    fill(&mut candidate, 60, 73, 459, 160, background);

    let outcome = run(&candidate, &reference);

    assert!(outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_one_css_pixel_layered_frontier_error_remains_visible() {
    let stage = Rgba([247, 250, 252, 255]);
    let background = Rgba([231, 245, 255, 255]);
    let border = Rgba([87, 117, 144, 255]);
    let shadow = Rgba([255, 209, 102, 255]);
    let mut reference = ImageBuffer::from_pixel(520, 200, stage);
    let mut candidate = reference.clone();
    fill(&mut reference, 60, 60, 459, 65, border);
    fill(&mut candidate, 60, 60, 459, 65, border);
    fill(&mut reference, 60, 66, 459, 160, background);
    fill(&mut candidate, 60, 66, 459, 69, shadow);
    fill(&mut candidate, 60, 70, 459, 160, background);

    let outcome = run(&candidate, &reference);

    assert!(!outcome.regions.only_shared_coverage_color_residues());
    assert_eq!(outcome.status, Status::Fail);
}

#[test]
fn golden_one_device_pixel_outer_presence_fringe_is_raw_evidence_but_passes() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    // One device-pixel-wide outer edge is 0.32 CSS px at 300 DPI. It remains
    // raw Missing evidence, but direct topology proves it is only a coverage
    // phase; a two-pixel strip or inner cut stays visible below.
    fill(&mut candidate, 40, 40, 40, 159, WHITE);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.missing_px, 120);
    assert!(
        outcome
            .regions
            .only_outer_device_edge_fringes(PixelClass::Missing)
    );
}

#[test]
fn golden_long_one_device_pixel_shared_contour_is_raw_but_not_visible() {
    let mut reference = canvas(800, 200);
    let mut candidate = canvas(800, 200);
    // The bottom edge differs by exactly one physical pixel (0.32 CSS px at
    // 300 DPI) across a long shared rectangle. The raw component exceeds 1%
    // of painted pixels, proving that aggregate area cannot stand in for the
    // directly observed physical edge thickness.
    fill(&mut reference, 80, 70, 719, 129, BLACK);
    fill(&mut candidate, 80, 70, 719, 128, BLACK);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert_eq!(outcome.tally.missing_px, 640);
    assert!(outcome.tally.missing_pct > 1.0);
    assert!(
        outcome
            .regions
            .only_one_device_pixel_shared_coverage_residues(PixelClass::Missing)
    );
}

#[test]
fn golden_repeated_long_device_edges_remain_sub_visible() {
    let mut reference = canvas(800, 300);
    let mut candidate = canvas(800, 300);
    for top in [20, 70, 120, 170, 220] {
        fill(&mut reference, 80, top, 719, top + 19, BLACK);
        fill(&mut candidate, 80, top + 1, 719, top + 20, BLACK);
    }

    let outcome = run(&candidate, &reference);
    assert!(outcome.tally.missing_pct > 1.0);
    assert!(outcome.tally.extra_pct > 1.0);
    assert_eq!(outcome.regions.region_count(PixelClass::Missing), 5);
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_two_device_pixel_outer_presence_fringe_is_sub_css() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 40, 40, 41, 159, WHITE);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Pass);
    assert!(
        !outcome
            .regions
            .only_outer_device_edge_fringes(PixelClass::Missing)
    );
    assert!(
        outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Missing)
    );
}

#[test]
fn golden_one_css_pixel_outer_presence_fringe_fails() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 40, 40, 43, 159, WHITE);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Fail);
    assert!(
        !outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Missing)
    );
}

#[test]
fn golden_paired_sub_css_pixel_shared_outline_phase_passes() {
    let mut reference = canvas(240, 600);
    let mut candidate = canvas(240, 600);
    // Both renderers paint the same large block, but its outline phase differs
    // by two device pixels (0.64 CSS px at the pinned 300 DPI). The shared
    // interior proves this is a shared outline, not absent content.
    fill(&mut reference, 40, 40, 199, 539, BLACK);
    fill(&mut candidate, 40, 42, 199, 541, BLACK);

    let outcome = run(&candidate, &reference);

    assert_eq!(outcome.status, Status::Pass);
    assert!(
        outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Missing)
    );
    assert!(
        outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Extra)
    );
}

#[test]
fn golden_coherent_box_outline_is_not_made_visible_by_its_length() {
    let mut reference = canvas(220, 160);
    let mut candidate = canvas(220, 160);
    // Same authored ring, with half-device boundary rounding distributed to
    // opposite sides. The three direct-presence components each remain one
    // device pixel on a shared outline, but their percentage of the narrow
    // painted ring exceeds the fragmented-edge cap.
    fill(&mut reference, 0, 0, 199, 139, BLACK);
    fill(&mut reference, 37, 37, 161, 102, WHITE);
    fill(&mut candidate, 0, 0, 199, 140, BLACK);
    fill(&mut candidate, 38, 38, 162, 103, WHITE);

    let outcome = run(&candidate, &reference);

    assert!(outcome.tally.extra_pct > 1.0);
    assert_eq!(outcome.regions.region_count(PixelClass::Missing), 1);
    assert_eq!(outcome.regions.region_count(PixelClass::Extra), 2);
    assert!(
        outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Missing)
    );
    assert!(
        outcome
            .regions
            .only_sub_css_coverage_residues(PixelClass::Extra)
    );
    assert_eq!(outcome.status, Status::Pass);
}

#[test]
fn golden_inner_one_device_pixel_cut_remains_visible() {
    let reference = box_frame();
    let mut candidate = reference.clone();
    fill(&mut candidate, 99, 40, 99, 159, WHITE);

    let outcome = run(&candidate, &reference);
    assert_eq!(outcome.status, Status::Fail);
    assert!(
        !outcome
            .regions
            .only_outer_device_edge_fringes(PixelClass::Missing)
    );
}

#[test]
fn golden_wrong_font() {
    // Wrong font/weight proxy: a THICK black stroke (reference, "bold") vs a THIN
    // black stroke (candidate, "regular") at the same baseline. The extra stroke
    // thickness is Missing ink and fails exact comparison.
    let mut reference = canvas(200, 80);
    fill(&mut reference, 20, 30, 179, 49, BLACK); // 20px-thick bar
    let mut cand = canvas(200, 80);
    fill(&mut cand, 20, 36, 179, 43, BLACK); // 8px-thick bar (same centre)
    let o = run(&cand, &reference);
    dump("wrong_font", &o);
    assert_ne!(o.status, Status::Pass, "wrong stroke weight must NOT pass");
    assert!(
        matches!(
            o.verdict.dominant_class,
            PixelClass::Missing | PixelClass::ColorErr
        ),
        "wrong weight surfaces as Missing/ColorErr, got {:?}",
        o.verdict.dominant_class
    );
    assert!(
        o.tally.missing_pct > 6.0,
        "stroke-thickness Missing must describe the absent paint, got {:.2}",
        o.tally.missing_pct
    );
}

#[test]
fn golden_miter_vs_square_corner() {
    // A border corner: reference is a MITERED (filled triangle) join; candidate is
    // a BUTT join (the triangle absent). The corner triangle is Missing ink.
    let mut reference = canvas(120, 120);
    // Two thick arms forming an L.
    fill(&mut reference, 10, 10, 30, 109, BLACK); // vertical arm
    fill(&mut reference, 10, 10, 109, 30, BLACK); // horizontal arm
    // Mitered fill of the outer corner triangle.
    for y in 31..=60 {
        for x in 31..=60 {
            if (x - 31) + (y - 31) <= 29 {
                reference.put_pixel(x, y, BLACK);
            }
        }
    }
    let mut cand = canvas(120, 120);
    fill(&mut cand, 10, 10, 30, 109, BLACK);
    fill(&mut cand, 10, 10, 109, 30, BLACK); // no miter triangle (butt join)
    let o = run(&cand, &reference);
    dump("miter_vs_square_corner", &o);
    assert_ne!(
        o.status,
        Status::Pass,
        "a mitered-vs-butt corner must NOT pass"
    );
}

/// A 120x120 box of colour `c` centred in a 200x200 frame.
fn box_frame_colored(c: Rgba<u8>) -> RgbaImage {
    let mut img = canvas(200, 200);
    fill(&mut img, 40, 40, 159, 159, c);
    img
}
