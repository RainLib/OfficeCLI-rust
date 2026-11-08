use super::PdfWriter;
use super::geometry::{FragmentPaintGeometry, PdfRect, RoundedRect};
use crate::style::computed::BoxShadow;
use crate::types::EdgeSizes;

/// Render every outset shadow in a `box-shadow` list. CSS paints shadows
/// back-to-front: the FIRST listed shadow ends up on top, so the list is
/// iterated in reverse so earlier entries are painted last. Inset shadows in
/// the list are skipped here (drawn by `render_box_shadows_inset` after the
/// background).
pub(super) fn render_box_shadows(
    content: &mut String,
    shadows: &[BoxShadow],
    geometry: FragmentPaintGeometry,
    radii: crate::types::CornerRadii,
    page_ext_gstates: &mut Vec<(String, f32)>,
    gs_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
) {
    let rounded_box = geometry.positioning().rounded_border_box(radii);
    let clip = geometry.decoration_clip(shadow_paint_outsets(shadows));
    if let Some(clip) = clip {
        content.push_str("q\n");
        content.push_str(&clip.rect_path());
        content.push_str("W n\n");
    }
    for shadow in shadows.iter().rev().filter(|shadow| !shadow.inset) {
        render_box_shadow(
            content,
            shadow,
            rounded_box,
            page_ext_gstates,
            gs_counter,
            pdf_writer,
        );
    }
    if clip.is_some() {
        content.push_str("Q\n");
    }
}

/// Render every inset shadow in a `box-shadow` list (reverse paint order, as
/// `render_box_shadows`). Call after the element background.
pub(super) fn render_box_shadows_inset(
    content: &mut String,
    shadows: &[BoxShadow],
    geometry: FragmentPaintGeometry,
    radii: crate::types::CornerRadii,
    page_ext_gstates: &mut Vec<(String, f32)>,
    gs_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
) {
    let positioning = geometry.positioning();
    let rounded_box = positioning.rounded_padding_box(radii);
    let clip = geometry.decoration_clip(EdgeSizes::ZERO);
    if let Some(clip) = clip {
        content.push_str("q\n");
        content.push_str(&clip.rect_path());
        content.push_str("W n\n");
    }
    for shadow in shadows.iter().rev().filter(|shadow| shadow.inset) {
        render_box_shadow_inset(
            content,
            shadow,
            rounded_box,
            page_ext_gstates,
            gs_counter,
            pdf_writer,
        );
    }
    if clip.is_some() {
        content.push_str("Q\n");
    }
}

fn shadow_paint_outsets(shadows: &[BoxShadow]) -> EdgeSizes {
    shadows
        .iter()
        .filter(|shadow| !shadow.inset)
        .fold(EdgeSizes::ZERO, |outsets, shadow| {
            let feather = shadow.spread.max(0.0) + shadow.blur.max(0.0) * 2.0;
            outsets.max_each(EdgeSizes::new(
                (feather - shadow.offset_y).max(0.0),
                (feather + shadow.offset_x).max(0.0),
                (feather + shadow.offset_y).max(0.0),
                (feather - shadow.offset_x).max(0.0),
            ))
        })
}

/// Render a box-shadow with optional Gaussian blur.
///
/// When `blur > 0`, rasterizes the (rounded) shadow rect into a transparent
/// buffer at device scale, applies a true gaussian (σ = blur/2, per
/// css-backgrounds-3 §7.1.1) reusing `render::blur`, and embeds the result as a
/// PDF image XObject positioned so the feather extends beyond the shadow rect —
/// matching Chrome's smooth penumbra. Only an exact zero blur draws a solid
/// shadow rectangle (byte-identical to the previous vector path).
fn render_box_shadow(
    content: &mut String,
    shadow: &BoxShadow,
    rounded_box: RoundedRect,
    page_ext_gstates: &mut Vec<(String, f32)>,
    gs_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
) {
    let spread = shadow.spread;
    // CSS: positive offset_y = shadow below element.
    // PDF: Y increases upward, so negate offset_y.
    // Outset shadow: position = box shifted by offset, expanded uniformly by spread.
    let shadow_box = rounded_box
        .rect
        .translate(shadow.offset_x, -shadow.offset_y)
        .outset_uniform(spread)
        .rounded(rounded_box.radii.outset_shadow(spread));

    if shadow.blur <= 0.0 {
        paint_solid_box_shadow(content, shadow, shadow_box, page_ext_gstates, gs_counter);
        return;
    }

    // True gaussian blur: rasterize the (rounded) shadow rect, gaussian-blur it
    // (σ = blur/2), and embed as an image XObject. The shadow's corner radius
    // tracks the box radius grown by spread (the spread expands the radius too).
    if let Some(blurred) = crate::render::blur::blur_shadow_mask(
        shadow_box.rect.width,
        shadow_box.rect.height,
        shadow_box.radii,
        shadow,
        pdf_writer.opts.raster_quality.filter_dpi,
    ) {
        let ov = blurred.overflow_pt;
        let image_box = shadow_box
            .rect
            .top_left_raster_outset(ov, blurred.raster_size_pt());
        if pdf_writer.paint_blurred_shadow(
            content,
            shadow,
            &blurred,
            image_box,
            page_ext_gstates,
            gs_counter,
        ) {
            return;
        }
    }

    // Fallback (raster unavailable): solid shadow at authored alpha.
    paint_solid_box_shadow(content, shadow, shadow_box, page_ext_gstates, gs_counter);
}

fn paint_solid_box_shadow(
    content: &mut String,
    shadow: &BoxShadow,
    rounded_box: RoundedRect,
    page_ext_gstates: &mut Vec<(String, f32)>,
    gs_counter: &mut usize,
) {
    let (r, g, b, alpha) = shadow.color.to_f32_rgba();
    if alpha < 1.0 {
        let gs_name = format!("GSbs{}", *gs_counter);
        *gs_counter += 1;
        page_ext_gstates.push((gs_name.clone(), alpha));
        content.push_str(&format!("/{gs_name} gs\n"));
    }
    content.push_str(&format!("{r} {g} {b} rg\n"));
    content.push_str(&rounded_box.path_or_rect());
    content.push_str("f\n");
    if alpha < 1.0 {
        content.push_str("/GSDefault gs\n");
    }
}

/// Render an inset box-shadow: shadow appears inside the box edges, fading
/// toward the center. Uses PDF clipping to constrain shadow to the box,
/// then draws rings of the shadow color via even-odd fill, with alpha
/// graded so edges accumulate maximum darkness.
///
/// Call this AFTER the element's background so the shadow isn't painted
/// over. The outset variant (render_box_shadow) is called before the
/// background.
fn render_box_shadow_inset(
    content: &mut String,
    shadow: &BoxShadow,
    rounded_box: RoundedRect,
    page_ext_gstates: &mut Vec<(String, f32)>,
    gs_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
) {
    let spread = shadow.spread;
    if shadow.blur > 0.0 {
        if let Some(blurred) = crate::render::blur::blur_inset_shadow_mask(
            rounded_box.rect.width,
            rounded_box.rect.height,
            rounded_box.radii,
            shadow,
            pdf_writer.opts.raster_quality.filter_dpi,
        ) {
            let ov = blurred.overflow_pt;
            let image_box = rounded_box
                .rect
                .top_left_raster_outset(ov, blurred.raster_size_pt());
            content.push_str("q\n");
            content.push_str(&rounded_box.path_or_rect());
            content.push_str("W n\n");
            pdf_writer.paint_blurred_shadow(
                content,
                shadow,
                &blurred,
                image_box,
                page_ext_gstates,
                gs_counter,
            );
            content.push_str("Q\n");
        }
        // A blurred inset shadow requires raster compositing. If allocation or
        // encoding fails, do not substitute a differently-shaped ring model.
        return;
    }

    // Save gfx state, clip to box path.
    content.push_str("q\n");
    content.push_str(&rounded_box.path_or_rect());
    content.push_str("W n\n");

    let (sr, sg, sb, base_alpha) = shadow.color.to_f32_rgba();
    content.push_str(&format!("{sr} {sg} {sb} rg\n"));

    // Outer bounds for even-odd fill — large enough to guarantee full
    // coverage of the clipped region.
    let outer = rounded_box.rect.outset_uniform(spread.abs() + 2.0);

    // No blur: a single authored-alpha fill of the inset ring.
    if base_alpha < 1.0 {
        let gs_name = format!("GSbs{}", *gs_counter);
        *gs_counter += 1;
        page_ext_gstates.push((gs_name.clone(), base_alpha));
        content.push_str(&format!("/{gs_name} gs\n"));
    }
    let hole_rect = rounded_box
        .rect
        .translate(shadow.offset_x, -shadow.offset_y)
        .inset(EdgeSizes::uniform(spread));
    content.push_str(&outer.rect_path());
    if !hole_rect.is_empty() {
        let hole = hole_rect.rounded(rounded_box.radii.grow(-spread));
        content.push_str(&hole.path_or_rect());
    }
    content.push_str("f*\n");
    content.push_str("Q\n");
    if base_alpha < 1.0 {
        content.push_str("/GSDefault gs\n");
    }
}

impl PdfWriter {
    fn paint_blurred_shadow(
        &mut self,
        content: &mut String,
        shadow: &BoxShadow,
        mask: &crate::render::blur::BlurredCoverageMask,
        bounds: PdfRect,
        page_ext_gstates: &mut Vec<(String, f32)>,
        gs_counter: &mut usize,
    ) -> bool {
        let Some(mask_state) = self.add_coverage_soft_mask(mask, bounds) else {
            return false;
        };
        let (red, green, blue, alpha) = shadow.color.to_f32_rgba();
        content.push_str("q\n");
        if alpha < 1.0 {
            let opacity_state = format!("GSbs{}", *gs_counter);
            *gs_counter += 1;
            page_ext_gstates.push((opacity_state.clone(), alpha));
            content.push_str(&format!("/{opacity_state} gs\n"));
        }
        mask_state.apply(content);
        content.push_str(&format!("{red} {green} {blue} rg\n"));
        content.push_str(&mask_state.paint_bounds().rect_path());
        content.push_str("f\nQ\n");
        true
    }
}
