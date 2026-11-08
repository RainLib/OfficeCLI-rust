use super::*;
use crate::render::pdf_syntax::format_pdf_number_fixed;

fn format_function_scalar(value: f32) -> String {
    format_pdf_number_fixed(f64::from(value), 8)
}

#[derive(Debug, Clone, Copy)]
struct PdfFunctionColor {
    exact: [f32; 3],
    serialized: PdfRgb,
}

impl From<(f32, f32, f32)> for PdfFunctionColor {
    fn from(color: (f32, f32, f32)) -> Self {
        Self {
            exact: [color.0, color.1, color.2],
            serialized: color.into(),
        }
    }
}

impl PdfFunctionColor {
    fn exact_channel(self, channel: usize) -> Option<f32> {
        self.exact.get(channel).copied()
    }

    fn serialized_channel(self, channel: usize) -> Option<f32> {
        self.serialized.components().get(channel).copied()
    }
}

#[derive(Debug, Clone, Copy)]
struct PdfFunctionStopGroup {
    position: f32,
    incoming: PdfFunctionColor,
    outgoing: PdfFunctionColor,
}

impl PdfFunctionStopGroup {
    fn segment(self, end: Self, channel: usize) -> Option<String> {
        let from = self.outgoing.exact_channel(channel)?;
        let to = end.incoming.exact_channel(channel)?;
        let base = self.outgoing.serialized_channel(channel)?;
        if from == to {
            return Some(format!("pop {}", format_pdf_number(base)));
        }
        let length = end.position - self.position;
        (length.is_finite() && length > 0.0).then(|| {
            let slope = (to - from) / length;
            format!(
                "{} sub {} mul {} add",
                format_function_scalar(self.position),
                format_function_scalar(slope),
                format_pdf_number(base),
            )
        })
    }
}

#[derive(Debug)]
pub(super) struct PdfFunctionStopSequence {
    groups: Vec<PdfFunctionStopGroup>,
    opacity: f32,
}

impl PdfFunctionStopSequence {
    pub(super) fn from_resolved(resolved: &ResolvedGradientRamp) -> Option<Self> {
        let opacity = resolved.uniform_opacity()?;
        let stops = pdf_backend_gradient_stops(resolved)?;
        let mut groups: Vec<PdfFunctionStopGroup> = Vec::with_capacity(stops.len());
        for stop in stops {
            let color = PdfFunctionColor::from(stop.color);
            if let Some(group) = groups.last_mut()
                && group.position == stop.position
            {
                group.outgoing = color;
                continue;
            }
            groups.push(PdfFunctionStopGroup {
                position: stop.position,
                incoming: color,
                outgoing: color,
            });
        }
        (!groups.is_empty()).then_some(Self { groups, opacity })
    }

    /// Convert a resolved ramp into an opaque grayscale coverage function.
    ///
    /// A CSS gradient used as an alpha mask contributes its interpolated alpha,
    /// not its visible colour. Keeping that coverage in the function's equal
    /// RGB channels lets a PDF luminosity group represent it without a raster
    /// fallback or an intermediate alpha image.
    pub(super) fn from_resolved_alpha(resolved: &ResolvedGradientRamp) -> Option<Self> {
        let mut groups: Vec<PdfFunctionStopGroup> = Vec::with_capacity(resolved.stops().len());
        for stop in resolved.stops() {
            let alpha = stop.color.color.to_f32_rgba().3.clamp(0.0, 1.0);
            let color = PdfFunctionColor::from((alpha, alpha, alpha));
            if let Some(group) = groups.last_mut()
                && group.position == stop.position
            {
                group.outgoing = color;
                continue;
            }
            groups.push(PdfFunctionStopGroup {
                position: stop.position,
                incoming: color,
                outgoing: color,
            });
        }
        (!groups.is_empty()).then_some(Self {
            groups,
            opacity: 1.0,
        })
    }

    pub(super) fn normalized(mut self, span: GradientParameterSpan) -> Option<Self> {
        let length = span.end - span.start;
        if !length.is_finite() || length <= 0.0 {
            return None;
        }
        for group in &mut self.groups {
            group.position = (group.position - span.start) / length;
        }
        Some(self)
    }

    pub(super) const fn opacity(&self) -> f32 {
        self.opacity
    }

    pub(super) fn span(&self) -> Option<GradientParameterSpan> {
        Some(GradientParameterSpan {
            start: self.groups.first()?.position,
            end: self.groups.last()?.position,
        })
    }

    pub(super) fn selector(&self, channel: usize) -> Option<String> {
        let first = *self.groups.first()?;
        let last = *self.groups.last()?;
        if self.groups.len() == 1 {
            return Some(format!(
                "dup {} lt {{pop {}}} {{pop {}}} ifelse",
                format_function_scalar(first.position),
                format_pdf_number(first.incoming.serialized_channel(channel)?),
                format_pdf_number(first.outgoing.serialized_channel(channel)?),
            ));
        }

        let mut code = format!(
            "dup {} lt {{pop {}}} {{",
            format_function_scalar(first.position),
            format_pdf_number(first.incoming.serialized_channel(channel)?),
        );
        for pair in self.groups.windows(2) {
            let [start, end] = pair else {
                return None;
            };
            code.push_str(&format!(
                "dup {} le {{{}}} {{",
                format_function_scalar(end.position),
                start.segment(*end, channel)?,
            ));
        }
        code.push_str(&format!(
            "pop {}",
            format_pdf_number(last.outgoing.serialized_channel(channel)?),
        ));
        for _ in self.groups.windows(2) {
            code.push_str("} ifelse");
        }
        code.push_str("} ifelse");
        Some(code)
    }

    pub(super) fn calculator(&self, parameter: &str) -> Option<String> {
        Some(format!(
            "{{{parameter} dup {} exch dup {} exch {}}}",
            self.selector(0)?,
            self.selector(1)?,
            self.selector(2)?,
        ))
    }
}

#[derive(Debug)]
pub(super) struct LinearFunctionGradient {
    stops: PdfFunctionStopSequence,
    span: GradientParameterSpan,
    repeating: bool,
}

#[derive(Debug)]
pub(super) struct RadialFunctionGradient {
    stops: PdfFunctionStopSequence,
    span: GradientParameterSpan,
}

impl RadialFunctionGradient {
    pub(super) fn period(&self) -> f32 {
        self.span.length()
    }

    pub(super) fn calculator(&self) -> Option<String> {
        let period = self.span.end - self.span.start;
        let cycle_start = self.span.start / period;
        let radius = if cycle_start == 0.0 {
            "dup mul exch dup mul add sqrt".to_owned()
        } else {
            format!(
                "dup mul exch dup mul add sqrt {} sub",
                format_function_scalar(cycle_start),
            )
        };
        self.stops
            .calculator(&format!("{radius} dup truncate sub dup 0 le {{1 add}} if"))
    }
}

impl LinearFunctionGradient {
    #[cfg(test)]
    pub(super) fn selector(&self, channel: usize) -> Option<String> {
        self.stops.selector(channel)
    }

    fn calculator(&self) -> Option<String> {
        let parameter = if self.repeating {
            "pop dup truncate sub dup 0 le {1 add} if"
        } else {
            "pop"
        };
        self.stops.calculator(parameter)
    }
}

pub(super) fn linear_function_gradient(
    ramp: &GradientRamp,
    basis: f32,
) -> Option<LinearFunctionGradient> {
    let resolved = ramp.resolve(basis)?;
    if resolved.uniform_opacity()? != 1.0 {
        return None;
    }

    let repeating = resolved.repeat().is_repeating();
    let has_hard_stop = resolved.stops().windows(2).any(|pair| {
        pair[0].position == pair[1].position && pair[0].color.color != pair[1].color.color
    });
    if !repeating && !has_hard_stop {
        return None;
    }

    let first = resolved.stops().first()?.position;
    let last = resolved.stops().last()?.position;
    let span = if repeating {
        GradientParameterSpan {
            start: first,
            end: last,
        }
    } else {
        GradientParameterSpan {
            start: first.min(0.0),
            end: last.max(1.0),
        }
    };
    let length = span.length();
    if !length.is_finite() || length <= 0.0 {
        return None;
    }

    let stops = PdfFunctionStopSequence::from_resolved(&resolved)?.normalized(span)?;
    Some(LinearFunctionGradient {
        stops,
        span,
        repeating,
    })
}

fn radial_function_gradient(ramp: &GradientRamp, basis: f32) -> Option<RadialFunctionGradient> {
    let resolved = ramp.resolve(basis)?;
    if !resolved.repeat().is_repeating() || resolved.uniform_opacity()? != 1.0 {
        return None;
    }
    let span = GradientParameterSpan {
        start: resolved.stops().first()?.position,
        end: resolved.stops().last()?.position,
    };
    let period = span.length();
    if !period.is_finite() || period <= 0.0 {
        return None;
    }
    Some(RadialFunctionGradient {
        stops: PdfFunctionStopSequence::from_resolved(&resolved)?.normalized(span)?,
        span,
    })
}

/// Build the repeating function used by an alpha-interpreted radial CSS mask.
///
/// `mask-mode: alpha` and `match-source` both use a CSS gradient's alpha
/// channel. Luminance mode stays on the general path because its coverage is
/// derived from interpolated colour instead.
pub(super) fn radial_alpha_function_gradient(
    ramp: &GradientRamp,
    basis: f32,
) -> Option<RadialFunctionGradient> {
    let resolved = ramp.resolve(basis)?;
    if !resolved.repeat().is_repeating() {
        return None;
    }
    let span = GradientParameterSpan {
        start: resolved.stops().first()?.position,
        end: resolved.stops().last()?.position,
    };
    if !span.length().is_finite() || span.length() <= 0.0 {
        return None;
    }
    Some(RadialFunctionGradient {
        stops: PdfFunctionStopSequence::from_resolved_alpha(&resolved)?.normalized(span)?,
        span,
    })
}

pub(super) fn render_linear_function_gradient(
    content: &mut String,
    gradient: &LinearGradient,
    tile: PdfRect,
    content_transform: PageContentTransform,
    pdf_writer: &mut PdfWriter,
) -> bool {
    if content_transform.is_identity() && !pdf_writer.page_content_transform.is_identity() {
        return false;
    }
    let basis = linear_gradient_line_length(gradient.angle, tile.width, tile.height);
    let Some(function) = linear_function_gradient(&gradient.ramp, basis) else {
        return false;
    };
    let span_length = basis * (function.span.end - function.span.start);
    if !span_length.is_finite() || span_length <= 0.0 {
        return false;
    }

    let (sin, cos) = sin_cos_degrees(gradient.angle);
    let direction = PdfVector::new(sin, cos);
    let perpendicular = PdfVector::new(cos, -sin);
    let center = PdfPoint::new(
        tile.left + tile.width / 2.0,
        tile.bottom + tile.height / 2.0,
    );
    let nominal_start = center - direction * (basis / 2.0);
    let span_start = nominal_start + direction * (basis * function.span.start);
    let page = pdf_writer
        .page_content_transform
        .page_bounds()
        .unwrap_or(tile);
    let page_anchor = PdfPoint::new(page.left, page.top());
    let perpendicular_offset = (page_anchor - span_start).dot(perpendicular);
    let transform = pdf_writer.paint_matrix(PdfMatrix::new(
        direction * span_length,
        perpendicular * span_length,
        span_start + perpendicular * perpendicular_offset,
    ));
    let Some(inverse) = transform.inverse() else {
        return false;
    };
    let domain = page.transformed_bounds(inverse);
    let Some(calculator) = function.calculator() else {
        return false;
    };
    let Some(pattern) = PdfFunctionPattern::new(transform, domain, calculator) else {
        return false;
    };
    let name = pdf_writer.add_function_pattern(pattern);
    if content_transform.is_identity() {
        paint_shading_pattern(content, &name, tile);
    } else if paint_css_page_pattern(content, content_transform, &name, tile).is_none() {
        return false;
    }
    true
}

pub(super) fn render_radial_function_gradient(
    content: &mut String,
    gradient: &RadialGradient,
    geometry: RadialGradientGeometry,
    tile: PdfRect,
    content_transform: PageContentTransform,
    pdf_writer: &mut PdfWriter,
) -> bool {
    if content_transform.is_identity() && !pdf_writer.page_content_transform.is_identity() {
        return false;
    }
    let Some(function) = radial_function_gradient(&gradient.ramp, geometry.stop_basis()) else {
        return false;
    };
    let period = function.period();
    let period_radii = geometry.point_radii() * period;
    if !period_radii.is_positive() {
        return false;
    }
    let transform = pdf_writer.paint_matrix(PdfMatrix::new(
        PdfVector::new(period_radii.x, 0.0),
        PdfVector::new(0.0, -period_radii.y),
        geometry.page_center(tile),
    ));
    let page = pdf_writer
        .page_content_transform
        .page_bounds()
        .unwrap_or(tile);
    let Some(inverse) = transform.inverse() else {
        return false;
    };
    let domain = page.transformed_bounds(inverse);
    let Some(calculator) = function.calculator() else {
        return false;
    };
    let Some(pattern) = PdfFunctionPattern::new(transform, domain, calculator) else {
        return false;
    };
    let name = pdf_writer.add_function_pattern(pattern);
    if content_transform.is_identity() {
        paint_shading_pattern(content, &name, tile);
    } else if paint_css_page_pattern(content, content_transform, &name, tile).is_none() {
        return false;
    }
    true
}
