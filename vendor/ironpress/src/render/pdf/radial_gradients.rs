use super::*;

/// Render a radial gradient using a native PDF Shading Dictionary reference.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_radial_gradient(
    content: &mut String,
    gradient: &impl GradientView<RadialGradient>,
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
        render_radial_gradient_layer_tile(
            content,
            source,
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
    if paint_distributed_tiles(content, pattern, |content, tile| {
        render_radial_gradient_layer_tile(
            content,
            source,
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
    render_radial_gradient_layer_tile(
        &mut stream,
        source,
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
pub(super) fn render_radial_gradient_layer_tile(
    content: &mut String,
    gradient: &RadialGradient,
    tile: PdfRect,
    content_transform: PageContentTransform,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    if !content_transform.is_identity()
        && let Some(geometry) =
            RadialGradientGeometry::resolve(gradient, PdfVector::new(tile.width, tile.height))
        && (render_radial_function_gradient(
            content,
            gradient,
            geometry,
            tile,
            content_transform,
            pdf_writer,
        ) || render_radial_pattern_tile(content, gradient, geometry, tile, pdf_writer))
    {
        return;
    }
    if !render_radial_gradient_tile(
        content,
        gradient,
        tile.left,
        tile.bottom,
        tile.width,
        tile.height,
        content_transform,
        shadings,
        shading_counter,
    ) {
        render_radial_gradient_tile_raster(content, gradient, tile, pdf_writer, page_images);
    }
}

pub(super) fn render_radial_pattern_tile(
    content: &mut String,
    gradient: &RadialGradient,
    geometry: RadialGradientGeometry,
    tile: PdfRect,
    pdf_writer: &mut PdfWriter,
) -> bool {
    let scale = crate::fonts::PT_PER_CSS_PX;
    let Some(stops) = native_pdf_gradient_stops(&gradient.ramp, geometry.stop_basis()) else {
        return false;
    };
    let center = geometry.center;
    let radii = geometry.radii;
    let y_scale = scale * (radii.y / radii.x);
    let pattern_matrix = pdf_writer.paint_matrix(PdfMatrix::new(
        PdfVector::new(scale, 0.0),
        PdfVector::new(0.0, -y_scale),
        PdfPoint::new(tile.left, tile.top() - (scale - y_scale) * center.y),
    ));
    let name = pdf_writer.add_shading_pattern(PdfShadingPattern::radial(
        center,
        radii.x,
        pattern_matrix,
        stops,
        if gradient.shape == RadialShape::Circle {
            PdfPatternGeometryFormat::SixDecimals
        } else {
            PdfPatternGeometryFormat::Shortest
        },
    ));
    paint_shading_pattern(content, &name, tile);
    true
}

/// Paint a single radial-gradient tile clipped to its rectangle.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_radial_gradient_tile(
    content: &mut String,
    gradient: &RadialGradient,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    content_transform: PageContentTransform,
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
) -> bool {
    let tile = PdfRect::new(x, y, width, height);
    let Some(geometry) = RadialGradientGeometry::resolve(gradient, PdfVector::new(width, height))
    else {
        return false;
    };
    let center = geometry.page_center(tile);
    let Some(stops) = native_pdf_gradient_stops(&gradient.ramp, geometry.stop_basis()) else {
        return false;
    };
    let radii = geometry.point_radii();

    match gradient.shape {
        RadialShape::Circle => {
            let name = push_radial_shading(
                shadings,
                shading_counter,
                [center.x, center.y, 0.0, center.x, center.y, radii.x],
                stops,
            );
            content.push_str("q\n");
            content.push_str(&format!("{x} {y} {width} {height} re W n\n"));
            content.push_str(&content_transform.inverse_operator());
            content.push_str(&format!("/{name} sh\n"));
            content.push_str("Q\n");
            true
        }
        RadialShape::Ellipse => {
            // PDF radial shadings are circular, so paint a unit-radius circular
            // shading at the origin and squash it into the desired ellipse via a
            // `cm` transform applied after clipping to the tile (clip stays in
            // page space; the shading evaluates in the transformed space).
            let name = push_radial_shading(
                shadings,
                shading_counter,
                [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                stops,
            );
            content.push_str("q\n");
            content.push_str(&format!("{x} {y} {width} {height} re W n\n"));
            content.push_str(&content_transform.inverse_operator());
            content.push_str(
                &PdfMatrix::new(
                    PdfVector::new(radii.x, 0.0),
                    PdfVector::new(0.0, radii.y),
                    center,
                )
                .cm_operator(),
            );
            content.push_str(&format!("/{name} sh\n"));
            content.push_str("Q\n");
            true
        }
    }
}
