use super::geometry::BoxPaintGeometry;
use super::*;

/// Paint an ordinary box's gradient layers with independent positioning and
/// painting areas.
///
/// `background-origin` selects the positioning area (padding-box by default),
/// while `background-clip` selects the painting area. Keeping those two boxes
/// distinct is observable at every bordered grid, table, and flex item: using
/// the border box for both shortens the visible gradient and shifts its stops.
pub(super) fn paint_box_gradient_backgrounds(
    content: &mut String,
    paint: &crate::layout::elements::BoxPaint,
    geometry: BoxPaintGeometry,
    ctx: &mut PageRenderContext<'_>,
) {
    let layers = &paint.background.layers;
    let geometry = geometry.background(layers.origin, layers.clip, paint.border_radii);
    let positioning_box = geometry.positioning_area.generated_image_box();
    let painted_box = geometry.painting_box;
    if geometry.image_destination_box.is_empty() {
        return;
    }
    let paint_area = LayerPaintArea::new(positioning_box, geometry.image_destination_box);
    let layer_box = background_layer_box(layers.size, layers.position, layers.repeat);
    if let Some(gradient) = &layers.gradient {
        let gradient = linear_with_background_layer(gradient, layer_box);
        let clipped = painted_box.push_rounded_clip(content);
        render_linear_gradient(
            content,
            &gradient,
            GradientBackdrop::isolated_linear_layer(
                paint.background.color,
                layers.radial_gradient.is_some()
                    || layers.conic_gradient.is_some()
                    || layers.svg.is_some()
                    || layers.raster_source.is_some(),
                crate::style::computed::BlendMode::Normal,
            ),
            paint_area,
            ctx.shadings,
            ctx.shading_counter,
            ctx.text.pdf_writer,
            ctx.text.page_images,
        );
        if clipped {
            content.push_str("Q\n");
        }
    }
    if let Some(gradient) = &layers.radial_gradient {
        let gradient = radial_with_background_layer(gradient, layer_box);
        let clipped = painted_box.push_rounded_clip(content);
        render_radial_gradient(
            content,
            &gradient,
            paint_area,
            ctx.shadings,
            ctx.shading_counter,
            ctx.text.pdf_writer,
            ctx.text.page_images,
        );
        if clipped {
            content.push_str("Q\n");
        }
    }
    if let Some(gradient) = &layers.conic_gradient {
        let gradient = conic_with_background_layer(gradient, layer_box);
        let clipped = painted_box.push_rounded_clip(content);
        render_conic_gradient(
            content,
            &gradient,
            paint_area,
            ctx.text.pdf_writer,
            ctx.text.page_images,
        );
        if clipped {
            content.push_str("Q\n");
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_linear_gradient(
    content: &mut String,
    gradient: &impl GradientView<LinearGradient>,
    backdrop: GradientBackdrop,
    area: LayerPaintArea,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    let source = gradient.source();
    let Some(pattern) = gradient_layer_pattern(&gradient.layer_box(), area) else {
        return;
    };
    let Some(first_tile) = pattern.first_tile() else {
        return;
    };
    if pattern.is_single() {
        let content_transform = pdf_writer.page_content_transform;
        render_linear_gradient_layer_tile(
            content,
            source,
            backdrop,
            first_tile,
            content_transform,
            shadings,
            shading_counter,
            pdf_writer,
            page_images,
        );
        return;
    }

    let content_transform = pdf_writer.page_content_transform;
    if pattern.has_distributed_repeat()
        && render_distributed_linear_gradient_raster(
            content,
            source,
            pattern,
            pdf_writer,
            page_images,
        )
    {
        return;
    }
    if paint_distributed_tiles(content, pattern, |content, tile| {
        render_linear_gradient_layer_tile(
            content,
            source,
            backdrop,
            tile,
            content_transform,
            shadings,
            shading_counter,
            pdf_writer,
            page_images,
        );
    }) {
        return;
    }

    let tile_size = pattern.tile_size();
    let mut stream = String::new();
    render_linear_gradient_layer_tile(
        &mut stream,
        source,
        backdrop,
        PdfRect::new(0.0, 0.0, tile_size.x, tile_size.y),
        PageContentTransform::default(),
        shadings,
        shading_counter,
        pdf_writer,
        page_images,
    );
    let Some(form) = pattern
        .pdf_pattern(PdfRect::new(0.0, 0.0, tile_size.x, tile_size.y))
        .and_then(|spec| pdf_writer.add_tiling_pattern(stream, spec))
    else {
        return;
    };
    paint_tiling_pattern(content, &form, pattern.paint_box());
    page_images.push(form);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_linear_gradient_layer_tile(
    content: &mut String,
    gradient: &LinearGradient,
    backdrop: GradientBackdrop,
    tile: PdfRect,
    content_transform: PageContentTransform,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    let basis = linear_gradient_line_length(gradient.angle, tile.width, tile.height);
    let Some(native) = native_pdf_linear_gradient(&gradient.ramp, basis)
        .or_else(|| native_pdf_linear_gradient_over_solid(&gradient.ramp, basis, backdrop))
    else {
        if render_linear_function_gradient(content, gradient, tile, content_transform, pdf_writer) {
            return;
        }
        let page = pdf_writer.page_content_transform.page_bounds();
        if gradient.angle.rem_euclid(360.0) == 90.0
            && page.is_some_and(|page| tile.left == page.left && tile.width == page.width)
            && let Some(color) = premultiplied_solid_gradient_color(&gradient.ramp, basis)
            && let Some(mask) = pdf_writer.try_linear_gradient_alpha_mask(gradient, tile)
            && let Some(pattern) = pdf_writer.add_masked_solid_page_pattern(tile, &mask, color)
            && paint_css_box_pattern(content, content_transform, &pattern, tile).is_some()
        {
            return;
        }
        render_linear_gradient_tile_raster(content, gradient, tile, pdf_writer, page_images);
        return;
    };
    if !content_transform.is_identity() {
        let (width, height) = (
            tile.width / crate::fonts::PT_PER_CSS_PX,
            tile.height / crate::fonts::PT_PER_CSS_PX,
        );
        let (sin, cos) = sin_cos_degrees(gradient.angle);
        let half = (width * sin.abs() + height * cos.abs()) / 2.0;
        let (cx, cy) = (width / 2.0, height / 2.0);
        let (dx, dy) = (sin * half, cos * half);
        let nominal_start = PdfPoint::new(cx - dx, cy + dy);
        let nominal_end = PdfPoint::new(cx + dx, cy - dy);
        let axis = nominal_end - nominal_start;
        let pattern_matrix = pdf_writer.paint_matrix(PdfMatrix::new(
            PdfVector::new(crate::fonts::PT_PER_CSS_PX, 0.0),
            PdfVector::new(0.0, -crate::fonts::PT_PER_CSS_PX),
            PdfPoint::new(tile.left, tile.top()),
        ));
        let name = pdf_writer.add_shading_pattern(PdfShadingPattern::axial(
            nominal_start + axis * native.span.start,
            nominal_start + axis * native.span.end,
            pattern_matrix,
            native.stops,
            PdfPatternGeometryFormat::SixDecimals,
        ));
        paint_shading_pattern(content, &name, tile);
        return;
    }
    render_linear_gradient_tile(
        content,
        gradient.angle,
        tile.left,
        tile.bottom,
        tile.width,
        tile.height,
        native,
        content_transform,
        shadings,
        shading_counter,
    );
}

pub(super) fn linear_gradient_line_length(angle: f32, width: f32, height: f32) -> f32 {
    let (sin_a, cos_a) = sin_cos_degrees(angle);
    width * sin_a.abs() + height * cos_a.abs()
}

/// Paint a single axial-gradient tile clipped to its rectangle.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_linear_gradient_tile(
    content: &mut String,
    angle: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    native: NativePdfGradient,
    content_transform: PageContentTransform,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
) {
    let tile = PdfRect::new(x, y, width, height);
    render_linear_gradient_tile_clipped(
        content,
        LinearGradientTile {
            angle,
            bounds: tile,
            clip: tile,
        },
        native,
        content_transform,
        shadings,
        shading_counter,
    );
}

/// Paint one axial-gradient tile, resolving its stops against `tile` while
/// clipping the result to `clip`. Soft masks use an enclosing device-pixel
/// clip so their surface cannot lose a partially covered physical edge.
#[derive(Clone, Copy)]
pub(super) struct LinearGradientTile {
    pub(super) angle: f32,
    pub(super) bounds: PdfRect,
    pub(super) clip: PdfRect,
}

pub(super) fn render_linear_gradient_tile_clipped(
    content: &mut String,
    tile: LinearGradientTile,
    native: NativePdfGradient,
    content_transform: PageContentTransform,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
) {
    // CSS angle convention: 0° = to top (bottom-to-top), 90° = to right, 180° = to bottom
    // In PDF coordinate space, y-axis is bottom-up, so:
    //   CSS 0° (to top) => PDF line from bottom center to top center
    //   CSS 90° (to right) => PDF line from left center to right center
    //   CSS 180° (to bottom) => PDF line from top center to bottom center
    let (sin_a, cos_a) = sin_cos_degrees(tile.angle);

    // Gradient line: start and end points
    // CSS: 0deg = to top, so direction vector is (sin(angle), -cos(angle)) in CSS coords
    // In PDF coords (y flipped): direction is (sin(angle), cos(angle))
    let cx = tile.bounds.left + tile.bounds.width / 2.0;
    let cy = tile.bounds.bottom + tile.bounds.height / 2.0;
    // Half-length of the gradient line along the direction
    let half_len = (tile.bounds.width * sin_a.abs() + tile.bounds.height * cos_a.abs()) / 2.0;
    let dx = sin_a * half_len;
    let dy = cos_a * half_len;

    let nominal_start = PdfPoint::new(cx - dx, cy - dy);
    let axis = PdfVector::new(dx * 2.0, dy * 2.0);
    let start = nominal_start + axis * native.span.start;
    let end = nominal_start + axis * native.span.end;

    let name = push_axial_shading(
        shadings,
        shading_counter,
        [start.x, start.y, end.x, end.y],
        native.stops,
    );

    // Clip to the gradient area and paint with shading
    content.push_str("q\n");
    content.push_str(&tile.clip.rect_path());
    content.push_str("W n\n");
    content.push_str(&content_transform.inverse_operator());
    content.push_str(&format!("/{name} sh\n"));
    content.push_str("Q\n");
}
