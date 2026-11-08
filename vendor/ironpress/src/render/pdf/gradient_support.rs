use super::*;
use crate::style::computed::ResolvedGradientSegment;

/// Borrowed gradient geometry paired with the resolved layer painting fields.
/// Keeping the layer context separate avoids cloning the stop ramp whenever a
/// background longhand supplies a fallback size, position, or repeat mode.
#[derive(Clone, Copy)]
pub(super) struct GradientPaint<'a, G> {
    pub(super) source: &'a G,
    pub(super) layer_box: crate::style::computed::GradientLayerBox,
}

pub(super) trait GradientView<G> {
    fn source(&self) -> &G;
    fn layer_box(&self) -> crate::style::computed::GradientLayerBox;
}

/// Solid paint directly below one gradient layer.
///
/// An opaque backdrop lets a premultiplied sRGB alpha gradient be flattened to
/// an equivalent opaque vector gradient. The type keeps that capability
/// distinct from unrelated background colors when multiple image layers or a
/// non-normal blend mode make flattening invalid.
#[derive(Clone, Copy, Default)]
pub(super) struct GradientBackdrop(Option<crate::types::Color>);

impl GradientBackdrop {
    pub(super) fn isolated_linear_layer(
        color: Option<crate::types::Color>,
        has_other_image_layer: bool,
        blend_mode: crate::style::computed::BlendMode,
    ) -> Self {
        if has_other_image_layer || blend_mode != crate::style::computed::BlendMode::Normal {
            Self::default()
        } else {
            Self(color.filter(|color| color.alpha() == 1.0))
        }
    }

    fn opaque_color(self) -> Option<crate::types::Color> {
        self.0.filter(|color| color.alpha() == 1.0)
    }
}

pub(super) fn radial_position_css(
    position: crate::style::computed::RadialPos,
    point_extent: f32,
) -> f32 {
    let css_extent = point_extent / crate::fonts::PT_PER_CSS_PX;
    match position {
        crate::style::computed::RadialPos::Fraction(fraction) => css_extent * fraction,
        crate::style::computed::RadialPos::Points(points) => points / crate::fonts::PT_PER_CSS_PX,
        crate::style::computed::RadialPos::EndOffset(points) => {
            css_extent - points / crate::fonts::PT_PER_CSS_PX
        }
    }
}

macro_rules! impl_authored_gradient_view {
    ($gradient:ty) => {
        impl GradientView<$gradient> for $gradient {
            fn source(&self) -> &$gradient {
                self
            }

            fn layer_box(&self) -> crate::style::computed::GradientLayerBox {
                self.layer_box
            }
        }
    };
}

impl_authored_gradient_view!(LinearGradient);
impl_authored_gradient_view!(RadialGradient);
impl_authored_gradient_view!(ConicGradient);

impl<G> GradientView<G> for GradientPaint<'_, G> {
    fn source(&self) -> &G {
        self.source
    }

    fn layer_box(&self) -> crate::style::computed::GradientLayerBox {
        self.layer_box
    }
}

pub(super) fn native_pdf_gradient_stops(
    ramp: &GradientRamp,
    basis: f32,
) -> Option<PdfGradientStops> {
    let resolved = ramp.resolve(basis)?;
    if resolved.repeat().is_repeating() || !resolved.is_opaque() {
        return None;
    }
    if resolved
        .segments()
        .any(|segment| segment.interpolation != GradientInterpolation::Srgb)
    {
        return None;
    }
    if resolved.segments().all(|segment| segment.hint.is_none()) {
        return pdf_linear_stops(
            resolved
                .fixed_unit_interval_stops()?
                .into_iter()
                .map(|stop| PdfLinearStop::new(stop.position, stop.color.color.to_f32_rgb()))
                .collect(),
        );
    }

    PdfGradientStops::unit(
        pdf_backend_gradient_stops(&resolved)?
            .into_iter()
            .map(|stop| (PdfGradientOffset::backend(stop.position), stop.color)),
    )
    .ok()
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PdfBackendGradientStop {
    pub(super) position: f32,
    pub(super) color: (f32, f32, f32),
}

impl PdfBackendGradientStop {
    fn authored(stop: crate::style::computed::ResolvedGradientStop) -> Self {
        Self {
            position: stop.position,
            color: stop.color.color.to_f32_rgb(),
        }
    }

    fn generated(position: f32, color: (f32, f32, f32)) -> Self {
        Self { position, color }
    }
}

fn legacy_srgb_hint_color(
    segment: ResolvedGradientSegment,
    position: f32,
) -> Option<(f32, f32, f32)> {
    let span = segment.upper.position - segment.lower.position;
    let hint = segment.lower.hint_after?;
    let hint_progress = (hint - segment.lower.position) / span;
    let point_progress = (position - segment.lower.position) / span;
    let weight = point_progress.powf(0.5_f32.ln() / hint_progress.ln());
    if !span.is_finite()
        || span <= 0.0
        || !(0.0..=1.0).contains(&hint_progress)
        || !(0.0..=1.0).contains(&point_progress)
        || !weight.is_finite()
        || segment.lower.color.color.a != segment.upper.color.color.a
    {
        return None;
    }

    let lower = segment.lower.color.color;
    let upper = segment.upper.color.color;
    let blend = |from: f32, to: f32| {
        // Blink's legacy-sRGB interpolation calls its float Blend overload,
        // whose progress parameter is a double. The channel subtraction is
        // therefore f32, while the multiply/add are f64 before the final f32
        // conversion. Preserve that boundary before normalizing for DeviceRGB.
        (f64::from(from) + f64::from(to - from) * f64::from(weight)) as f32 / 255.0
    };
    Some((
        blend(lower.r, upper.r),
        blend(lower.g, upper.g),
        blend(lower.b, upper.b),
    ))
}

/// Expand transition hints into the deterministic ordinary-stop sequence used
/// by the PDF print backend. Both stitched and calculator functions consume
/// this representation so they cross device-channel thresholds identically.
pub(super) fn pdf_backend_gradient_stops(
    resolved: &ResolvedGradientRamp,
) -> Option<Vec<PdfBackendGradientStop>> {
    let mut stops = Vec::with_capacity(resolved.stops().len() + 9);
    stops.push(PdfBackendGradientStop::authored(*resolved.stops().first()?));
    for segment in resolved.segments() {
        if segment.interpolation != GradientInterpolation::Srgb {
            return None;
        }
        if let Some(hint) = segment.hint {
            let ResolvedGradientHint::Exponent(exponent) = hint else {
                return None;
            };
            if exponent != 1.0 {
                let hint = segment.lower.hint_after?;
                let left = hint - segment.lower.position;
                let right = segment.upper.position - hint;
                let positions: [f32; 9] = if left > right {
                    std::array::from_fn(|index| {
                        if index < 7 {
                            segment.lower.position + left * ((7 + index) as f32 / 13.0)
                        } else if index == 7 {
                            hint + right * (1.0 / 3.0)
                        } else {
                            hint + right * (2.0 / 3.0)
                        }
                    })
                } else {
                    std::array::from_fn(|index| {
                        if index == 0 {
                            segment.lower.position + left * (1.0 / 3.0)
                        } else if index == 1 {
                            segment.lower.position + left * (2.0 / 3.0)
                        } else {
                            hint + right * ((index - 2) as f32 / 13.0)
                        }
                    })
                };
                stops.extend(
                    positions
                        .into_iter()
                        .map(|position| {
                            Some(PdfBackendGradientStop::generated(
                                position,
                                legacy_srgb_hint_color(segment, position)?,
                            ))
                        })
                        .collect::<Option<Vec<_>>>()?,
                );
            }
        }
        stops.push(PdfBackendGradientStop::authored(segment.upper));
    }
    Some(stops)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct GradientParameterSpan {
    pub(super) start: f32,
    pub(super) end: f32,
}

impl GradientParameterSpan {
    pub(super) const UNIT: Self = Self {
        start: 0.0,
        end: 1.0,
    };

    pub(super) const fn length(self) -> f32 {
        self.end - self.start
    }
}

#[derive(Debug, Clone)]
pub(super) struct NativePdfGradient {
    pub(super) stops: PdfGradientStops,
    pub(super) span: GradientParameterSpan,
}

#[derive(Debug, Clone, Copy)]
struct PdfLinearStop {
    position: f32,
    color: PdfRgb,
}

impl PdfLinearStop {
    fn new(position: f32, color: (f32, f32, f32)) -> Self {
        Self {
            position,
            color: color.into(),
        }
    }
}

fn pdf_linear_stops(stops: Vec<PdfLinearStop>) -> Option<PdfGradientStops> {
    let mut encoded = Vec::with_capacity(stops.len() * 2);
    let mut index = 0;
    while let Some(first) = stops.get(index).copied() {
        let mut outgoing = first;
        index += 1;
        while let Some(stop) = stops.get(index).copied()
            && stop.position == first.position
        {
            outgoing = stop;
            index += 1;
        }
        encoded.push((PdfGradientOffset::backend(first.position), first.color));
        if outgoing.color == first.color {
            continue;
        }
        encoded.push((PdfGradientOffset::backend(first.position), outgoing.color));
    }
    PdfGradientStops::unit(encoded).ok()
}

impl NativePdfGradient {
    pub(super) const fn unit(stops: PdfGradientStops) -> Self {
        Self {
            stops,
            span: GradientParameterSpan::UNIT,
        }
    }
}

/// Preserve a linear gradient's authored parameter span. Stops outside the
/// painted unit interval move the axial endpoints; clipping their colors into
/// new 0/1 stops is mathematically similar but crosses 8-bit PDF interpolation
/// thresholds at different samples.
pub(super) fn native_pdf_linear_gradient(
    ramp: &GradientRamp,
    basis: f32,
) -> Option<NativePdfGradient> {
    let resolved = ramp.resolve(basis)?;
    if resolved.repeat().is_repeating() || !resolved.is_opaque() {
        return None;
    }
    if resolved.segments().any(|segment| segment.hint.is_some()) {
        return native_pdf_gradient_stops(ramp, basis).map(NativePdfGradient::unit);
    }

    let first = *resolved.stops().first()?;
    let last = *resolved.stops().last()?;
    let span = GradientParameterSpan {
        start: first.position.min(0.0),
        end: last.position.max(1.0),
    };
    let length = span.end - span.start;
    if !length.is_finite() || length <= 0.0 {
        return None;
    }
    let mut stops = Vec::with_capacity(resolved.stops().len() + 2);
    if first.position > span.start {
        let (red, green, blue, _) = resolved.sample(span.start);
        stops.push(PdfLinearStop::new(0.0, (red, green, blue)));
    }
    stops.extend(resolved.stops().iter().map(|stop| {
        PdfLinearStop::new(
            (stop.position - span.start) / length,
            stop.color.color.to_f32_rgb(),
        )
    }));
    if last.position < span.end {
        let (red, green, blue, _) = resolved.sample(span.end);
        stops.push(PdfLinearStop::new(1.0, (red, green, blue)));
    }
    Some(NativePdfGradient {
        stops: pdf_linear_stops(stops)?,
        span,
    })
}

/// Flatten a non-repeating premultiplied-sRGB alpha ramp over one opaque solid
/// backdrop into its mathematically equivalent opaque axial gradient.
///
/// For each segment both premultiplied source colour and alpha are linear in
/// the gradient parameter. Compositing over a constant backdrop therefore
/// remains linear, so the PDF axial interpolation is exact. Hints and modern
/// colour spaces stay on their general paths.
pub(super) fn native_pdf_linear_gradient_over_solid(
    ramp: &GradientRamp,
    basis: f32,
    backdrop: GradientBackdrop,
) -> Option<NativePdfGradient> {
    let backdrop = backdrop.opaque_color()?.to_f32_rgb();
    let resolved = ramp.resolve(basis)?;
    if resolved.is_opaque()
        || resolved.repeat().is_repeating()
        || resolved.segments().any(|segment| {
            segment.interpolation != GradientInterpolation::Srgb || segment.hint.is_some()
        })
    {
        return None;
    }

    let first = *resolved.stops().first()?;
    let last = *resolved.stops().last()?;
    let span = GradientParameterSpan {
        start: first.position.min(0.0),
        end: last.position.max(1.0),
    };
    let length = span.length();
    if !length.is_finite() || length <= 0.0 {
        return None;
    }

    let composite = |color: crate::types::Color| {
        let (red, green, blue, alpha) = color.to_f32_rgba();
        (
            red * alpha + backdrop.0 * (1.0 - alpha),
            green * alpha + backdrop.1 * (1.0 - alpha),
            blue * alpha + backdrop.2 * (1.0 - alpha),
        )
    };
    let mut stops = Vec::with_capacity(resolved.stops().len() + 2);
    if first.position > span.start {
        let (red, green, blue, alpha) = resolved.sample(span.start);
        stops.push(PdfLinearStop::new(
            0.0,
            (
                red * alpha + backdrop.0 * (1.0 - alpha),
                green * alpha + backdrop.1 * (1.0 - alpha),
                blue * alpha + backdrop.2 * (1.0 - alpha),
            ),
        ));
    }
    stops.extend(resolved.stops().iter().map(|stop| {
        PdfLinearStop::new(
            (stop.position - span.start) / length,
            composite(stop.color.color),
        )
    }));
    if last.position < span.end {
        let (red, green, blue, alpha) = resolved.sample(span.end);
        stops.push(PdfLinearStop::new(
            1.0,
            (
                red * alpha + backdrop.0 * (1.0 - alpha),
                green * alpha + backdrop.1 * (1.0 - alpha),
                blue * alpha + backdrop.2 * (1.0 - alpha),
            ),
        ));
    }
    Some(NativePdfGradient {
        stops: pdf_linear_stops(stops)?,
        span,
    })
}

/// A premultiplied gradient whose visible stops all share one straight RGB can
/// be represented exactly as that solid color under a native alpha soft mask.
pub(super) fn premultiplied_solid_gradient_color(
    ramp: &GradientRamp,
    basis: f32,
) -> Option<(f32, f32, f32)> {
    let resolved = ramp.resolve(basis)?;
    if resolved.is_opaque() || resolved.repeat().is_repeating() {
        return None;
    }
    let stops = resolved.fixed_unit_interval_stops()?;
    let [transparent, solid] = stops.as_slice() else {
        return None;
    };
    if transparent.position != 0.0
        || solid.position != 1.0
        || transparent.color.color.to_f32_rgba().3 != 0.0
        || solid.color.color.to_f32_rgba().3 != 1.0
        || resolved.segments().any(|segment| {
            segment.interpolation != GradientInterpolation::Srgb || segment.hint.is_some()
        })
    {
        return None;
    }
    Some(solid.color.color.to_f32_rgb())
}

/// Exact direction components for the four semantic CSS cardinal angles;
/// arbitrary angles retain the platform trigonometric result.
pub(super) fn sin_cos_degrees(angle: f32) -> (f32, f32) {
    crate::render::gradient_sampling::sin_cos_degrees(angle)
}

pub(super) fn background_layer_box(
    size: BackgroundSize,
    position: BackgroundPosition,
    repeat: BackgroundRepeat,
) -> crate::style::computed::GradientLayerBox {
    crate::style::computed::GradientLayerBox {
        size: Some(size),
        position: Some(position),
        repeat: Some(repeat),
        ..Default::default()
    }
}

pub(super) fn linear_with_background_layer(
    gradient: &LinearGradient,
    fallback: crate::style::computed::GradientLayerBox,
) -> GradientPaint<'_, LinearGradient> {
    GradientPaint {
        source: gradient,
        layer_box: gradient.layer_box.with_fallback(fallback),
    }
}

pub(super) fn radial_with_background_layer(
    gradient: &RadialGradient,
    fallback: crate::style::computed::GradientLayerBox,
) -> GradientPaint<'_, RadialGradient> {
    GradientPaint {
        source: gradient,
        layer_box: gradient.layer_box.with_fallback(fallback),
    }
}

pub(super) fn conic_with_background_layer(
    gradient: &ConicGradient,
    fallback: crate::style::computed::GradientLayerBox,
) -> GradientPaint<'_, ConicGradient> {
    GradientPaint {
        source: gradient,
        layer_box: gradient.layer_box.with_fallback(fallback),
    }
}

pub(super) fn gradient_raster_dimensions(
    width: f32,
    height: f32,
    filter_dpi: f32,
) -> Option<RasterDimensions> {
    crate::style::raster_quality::filter_raster_dimensions(width, height, filter_dpi)
}

pub(super) fn draw_gradient_raster_tile(
    content: &mut String,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
    image: &image::RgbaImage,
    rect: PdfRect,
) {
    let Some(obj_id) =
        pdf_writer.add_raw_rgba_image_object(image.as_raw(), image.width(), image.height())
    else {
        return;
    };
    let name = format!("Im{obj_id}");
    content.push_str(&format!(
        "q\n{width} 0 0 {height} {left} {bottom} cm\n/{name} Do\nQ\n",
        width = rect.width,
        height = rect.height,
        left = rect.left,
        bottom = rect.bottom,
    ));
    page_images.push(ImageRef { name, obj_id });
}

pub(super) fn draw_tiled_gradient_raster(
    content: &mut String,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
    dimensions: RasterDimensions,
    rect: PdfRect,
    mut pixel: impl FnMut(u32, u32) -> image::Rgba<u8>,
) {
    let Some(tiles) = dimensions.tiles(MAX_RASTER_TILE_EDGE) else {
        return;
    };
    for tile in tiles {
        let image = image::RgbaImage::from_fn(tile.width, tile.height, |x, y| {
            pixel(tile.x + x, tile.y + y)
        });
        draw_gradient_raster_tile(
            content,
            pdf_writer,
            page_images,
            &image,
            rect.raster_tile(dimensions, tile),
        );
    }
}

pub(super) fn rgba_to_pixel((r, g, b, a): (f32, f32, f32, f32)) -> image::Rgba<u8> {
    image::Rgba([
        (r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (b.clamp(0.0, 1.0) * 255.0).round() as u8,
        (a.clamp(0.0, 1.0) * 255.0).round() as u8,
    ])
}

#[derive(Debug, Clone, Copy)]
pub(super) struct RadialEdgeDistances {
    pub(super) near: PdfVector,
    pub(super) far: PdfVector,
}

impl RadialEdgeDistances {
    pub(super) fn resolve(center: PdfPoint, size: PdfVector) -> Self {
        let x = [center.x.abs(), (size.x - center.x).abs()];
        let y = [center.y.abs(), (size.y - center.y).abs()];
        Self {
            near: PdfVector::new(x[0].min(x[1]), y[0].min(y[1])),
            far: PdfVector::new(x[0].max(x[1]), y[0].max(y[1])),
        }
    }
}

/// One radial gradient resolved against a concrete tile in authored CSS pixels.
/// Keeping the nonlinear corner-radius calculation on this side of the print
/// scale preserves the browser's floating-point operation order.
#[derive(Debug, Clone, Copy)]
pub(super) struct RadialGradientGeometry {
    pub(super) center: PdfPoint,
    pub(super) radii: PdfVector,
}

impl RadialGradientGeometry {
    const POINTS_PER_CSS_PX: f32 = crate::fonts::PT_PER_CSS_PX;

    pub(super) fn resolve(gradient: &RadialGradient, point_size: PdfVector) -> Option<Self> {
        if !point_size.is_positive() {
            return None;
        }
        let size = point_size * (1.0 / Self::POINTS_PER_CSS_PX);
        let resolve = |position: crate::style::computed::RadialPos, extent: f32| match position {
            crate::style::computed::RadialPos::Fraction(fraction) => extent * fraction,
            crate::style::computed::RadialPos::Points(points) => points / Self::POINTS_PER_CSS_PX,
            crate::style::computed::RadialPos::EndOffset(points) => {
                extent - points / Self::POINTS_PER_CSS_PX
            }
        };
        let center = PdfPoint::new(
            resolve(gradient.center.x, size.x),
            resolve(gradient.center.y, size.y),
        );
        let distances = RadialEdgeDistances::resolve(center, size);
        let radii = match gradient.shape {
            RadialShape::Circle => {
                let radius = gradient
                    .radius
                    .map(|radius| radius / Self::POINTS_PER_CSS_PX)
                    .unwrap_or_else(|| match gradient.extent {
                        RadialExtent::ClosestSide => distances.near.x.min(distances.near.y),
                        RadialExtent::FarthestSide => distances.far.x.max(distances.far.y),
                        RadialExtent::ClosestCorner => distances.near.dot(distances.near).sqrt(),
                        RadialExtent::FarthestCorner => distances.far.dot(distances.far).sqrt(),
                    });
                PdfVector::new(radius, radius)
            }
            RadialShape::Ellipse => {
                if let Some(radii) = gradient.radii {
                    PdfVector::new(resolve(radii.x, size.x), resolve(radii.y, size.y))
                } else {
                    match gradient.extent {
                        RadialExtent::ClosestSide => distances.near,
                        RadialExtent::FarthestSide => distances.far,
                        RadialExtent::ClosestCorner => {
                            corner_ellipse_radii(distances.near, distances.near)
                        }
                        RadialExtent::FarthestCorner => {
                            corner_ellipse_radii(distances.far, distances.far)
                        }
                    }
                }
            }
        };
        radii
            .is_positive()
            .then_some(Self { center, radii })
            .filter(|geometry| geometry.center.is_finite())
    }

    pub(super) fn page_center(self, tile: PdfRect) -> PdfPoint {
        let center = self.point_center();
        PdfPoint::new(tile.left + center.x, tile.top() - center.y)
    }

    pub(super) fn point_center(self) -> PdfPoint {
        PdfPoint::new(
            self.center.x * Self::POINTS_PER_CSS_PX,
            self.center.y * Self::POINTS_PER_CSS_PX,
        )
    }

    pub(super) fn point_radii(self) -> PdfVector {
        self.radii * Self::POINTS_PER_CSS_PX
    }

    /// CSS radial stop lengths use the horizontal gradient-line radius before
    /// an ellipse's aspect-ratio transform is applied.
    pub(super) fn stop_basis(self) -> f32 {
        self.radii.x * Self::POINTS_PER_CSS_PX
    }
}

/// Scale a side-fitting ellipse so its boundary passes through `corner` while
/// retaining the side ellipse's aspect ratio.
pub(super) fn corner_ellipse_radii(side: PdfVector, corner: PdfVector) -> PdfVector {
    if !side.is_positive() {
        return side;
    }
    let aspect_ratio = side.x / side.y;
    let radius_x = (corner.x * corner.x + corner.y * corner.y * aspect_ratio * aspect_ratio).sqrt();
    PdfVector::new(radius_x, radius_x / aspect_ratio)
}
