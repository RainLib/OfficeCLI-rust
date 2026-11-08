use super::*;

/// Render a conic gradient as a PDF type 1 function-based shading. Its type 4
/// calculator function evaluates the authored angle and stop intervals at each
/// painted point, so angular transitions and hard stops are not tessellated.
/// Variable alpha cannot be expressed by a PDF colour shading and therefore
/// uses the resolution-driven raster path.
#[allow(clippy::too_many_arguments)]
pub(super) fn render_conic_gradient(
    content: &mut String,
    gradient: &impl GradientView<ConicGradient>,
    area: LayerPaintArea,
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
        render_conic_gradient_layer_tile(content, source, first_tile, pdf_writer, page_images);
        return;
    }

    if paint_distributed_tiles(content, pattern, |content, tile| {
        render_conic_gradient_layer_tile(content, source, tile, pdf_writer, page_images);
    }) {
        return;
    }

    let tile_size = pattern.tile_size();
    let mut stream = String::new();
    render_conic_gradient_layer_tile(
        &mut stream,
        source,
        PdfRect::new(0.0, 0.0, tile_size.x, tile_size.y),
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

pub(super) fn render_conic_gradient_layer_tile(
    content: &mut String,
    gradient: &ConicGradient,
    tile: PdfRect,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    if !render_conic_gradient_tile(content, gradient, tile, pdf_writer) {
        render_conic_gradient_tile_raster(content, gradient, tile, pdf_writer, page_images);
    }
}

pub(super) struct ConicShadingFunction {
    pub(super) calculator: String,
    pub(super) opacity: f32,
}

fn build_conic_function(
    gradient: &ConicGradient,
    parameter: String,
) -> Option<ConicShadingFunction> {
    let stops = gradient.ramp.resolve(1.0)?;
    if !gradient.from_angle.is_finite() {
        return None;
    }

    if stops.repeat().is_repeating()
        && stops.stops().last()?.position == stops.stops().first()?.position
    {
        let average = stops.weighted_average();
        let [red, green, blue] = PdfRgb::from((average.0, average.1, average.2)).components();
        return Some(ConicShadingFunction {
            calculator: format!(
                "{{ pop pop {} {} {} }}",
                format_pdf_number(red),
                format_pdf_number(green),
                format_pdf_number(blue),
            ),
            opacity: average.3,
        });
    }
    let function_stops = PdfFunctionStopSequence::from_resolved(&stops)?;
    let repetition = if stops.repeat().is_repeating() {
        let span = function_stops.span()?;
        let period = span.end - span.start;
        if !period.is_finite() || period <= 0.0 {
            return None;
        }
        format!(
            "{} sub {} div dup floor sub {} mul {} add",
            format_pdf_number(span.start),
            format_pdf_number(period),
            format_pdf_number(period),
            format_pdf_number(span.start),
        )
    } else {
        String::new()
    };
    Some(ConicShadingFunction {
        calculator: function_stops.calculator(&format!("{parameter} {repetition}"))?,
        opacity: function_stops.opacity(),
    })
}

pub(super) fn build_conic_shading_function(
    gradient: &ConicGradient,
    center: PdfPoint,
) -> Option<ConicShadingFunction> {
    if !center.x.is_finite() || !center.y.is_finite() || !gradient.from_angle.is_finite() {
        return None;
    }

    // Type 4 `atan` accepts numerator and denominator and returns degrees.
    // `(x - cx) atan (y - cy)` is CSS's clockwise angle from the upward ray.
    // Taking the fractional part after subtracting `from` normalizes any finite
    // authored rotation without a range-dependent conditional.
    build_conic_function(
        gradient,
        format!(
            "exch {} sub exch {} sub 2 copy 0 eq exch 0 eq and {{ pop pop 0 }} {{ atan }} ifelse {} sub 360 div dup floor sub",
            format_pdf_number(center.x),
            format_pdf_number(center.y),
            format_pdf_number(gradient.from_angle.rem_euclid(360.0)),
        ),
    )
}

fn render_conic_gradient_pattern(
    content: &mut String,
    gradient: &ConicGradient,
    tile: PdfRect,
    pdf_writer: &mut PdfWriter,
) -> bool {
    let Some(page) = pdf_writer.page_content_transform.page_bounds() else {
        return false;
    };
    let Some(function) = build_conic_function(gradient, "exch atan 360 div".to_owned()) else {
        return false;
    };
    if function.opacity != 1.0 {
        return false;
    }

    let cx_pos = gradient.center.x;
    let cy_pos = gradient.center.y;
    let scale = crate::fonts::PT_PER_CSS_PX;
    let css_box_origin = PdfPoint::new(
        (tile.left - page.left) / scale,
        (page.top() - tile.top()) / scale,
    );
    let css_center = css_box_origin
        + PdfVector::new(
            radial_position_css(cx_pos, tile.width),
            radial_position_css(cy_pos, tile.height),
        );
    let (sin, cos) = sin_cos_degrees(gradient.from_angle - 90.0);
    let canvas = PdfMatrix::new(
        PdfVector::new(scale, 0.0),
        PdfVector::new(0.0, -scale),
        PdfPoint::new(page.left, page.top()),
    );
    let shader = PdfMatrix::rotate_around(css_center, sin, cos);
    let mapper = PdfMatrix::translate(css_center);
    let transform = pdf_writer.paint_matrix(canvas * shader * mapper);
    let Some(inverse) = transform.inverse() else {
        return false;
    };
    let domain = page.transformed_bounds(inverse);
    let Some(pattern) = PdfFunctionPattern::new(transform, domain, function.calculator) else {
        return false;
    };
    let name = pdf_writer.add_function_pattern(pattern);
    paint_css_page_pattern(content, pdf_writer.page_content_transform, &name, tile).is_some()
}

/// Paint a single conic-gradient tile clipped to its rectangle as an exact
/// function-based shading. Returns `false` when variable alpha or invalid input
/// requires the caller's raster fallback.
pub(super) fn render_conic_gradient_tile(
    content: &mut String,
    gradient: &ConicGradient,
    tile: PdfRect,
    pdf_writer: &mut PdfWriter,
) -> bool {
    if !tile.left.is_finite()
        || !tile.bottom.is_finite()
        || !tile.width.is_finite()
        || !tile.height.is_finite()
        || tile.is_empty()
    {
        return false;
    }
    if render_conic_gradient_pattern(content, gradient, tile, pdf_writer) {
        return true;
    }
    // Center in PDF space (y flips: `y` is the tile bottom edge).
    let cx_pos = gradient.center.x;
    let cy_pos = gradient.center.y;
    let center = PdfPoint::new(
        tile.left + cx_pos.resolve(tile.width),
        tile.bottom + tile.height - cy_pos.resolve(tile.height),
    );
    let Some(function) = build_conic_shading_function(gradient, center) else {
        return false;
    };
    let opacity = function.opacity;
    let name = pdf_writer.add_conic_shading(tile, function);

    content.push_str("q\n");
    content.push_str(&tile.rect_path());
    content.push_str("W n\n");
    if opacity < 1.0 {
        content.push_str(&format!("/GS{name} gs\n"));
    }
    content.push_str(&format!("/{name} sh\n"));
    content.push_str("Q\n");
    true
}
