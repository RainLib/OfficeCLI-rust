use crate::render::pdf::PdfResourceUsage;
use crate::render::pdf::geometry::{PdfMatrix, PdfPoint, PdfRect, PdfVector};
use crate::render::pdf_syntax::{format_pdf_number, format_pdf_number_fixed};
use crate::render::shading::{PdfGradientStops, PdfShadingKind};

#[derive(Debug, Clone, Copy, Default)]
pub(in crate::render::pdf) struct PdfTilingPattern {
    pub(in crate::render::pdf) bbox: PdfRect,
    pub(in crate::render::pdf) paint_box: PdfRect,
    pub(in crate::render::pdf) step: PdfVector,
    pub(in crate::render::pdf) transform: PdfMatrix,
}

impl PdfTilingPattern {
    pub(in crate::render::pdf) fn matrix_dictionary_entry(self) -> String {
        if self.transform == PdfMatrix::IDENTITY {
            return String::new();
        }
        let components = self
            .transform
            .components()
            .map(|value| format_pdf_number_fixed(f64::from(value), 9));
        format!(" /Matrix [{}]", components.join(" "))
    }
}

#[derive(Debug)]
pub(in crate::render::pdf) struct PdfTilingPatternEntry {
    pub(in crate::render::pdf) pattern_id: usize,
    pub(in crate::render::pdf) target: PdfTilingPatternTarget,
    pub(in crate::render::pdf) resources: PdfResourceUsage,
}

#[derive(Debug)]
pub(in crate::render::pdf) enum PdfTilingPatternTarget {
    Page { name: String },
    Form { object_id: usize },
}

#[derive(Debug)]
pub(in crate::render::pdf) struct PdfPatternEntry {
    pub(in crate::render::pdf) name: String,
    pub(in crate::render::pdf) object_id: usize,
}

#[derive(Debug, Clone, Copy)]
pub(in crate::render::pdf) enum PdfPatternGeometryFormat {
    Shortest,
    SixDecimals,
}

impl PdfPatternGeometryFormat {
    pub(in crate::render::pdf) fn number(self, value: f32) -> String {
        if matches!(self, Self::Shortest) {
            return format_pdf_number(value);
        }
        let mut text = format!("{value:.6}");
        while text.contains('.') && text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
        if text == "-0" {
            return "0".to_string();
        }
        text
    }
}

#[derive(Debug, Clone, Copy)]
struct PdfCircle {
    center: PdfPoint,
    radius: f32,
}

impl PdfCircle {
    const fn new(center: PdfPoint, radius: f32) -> Self {
        Self { center, radius }
    }
}

#[derive(Debug, Clone, Copy)]
enum PdfShadingGeometry {
    Axial { start: PdfPoint, end: PdfPoint },
    Radial { start: PdfCircle, end: PdfCircle },
}

impl PdfShadingGeometry {
    fn pdf(self) -> (PdfShadingKind, [f32; 6], usize) {
        match self {
            Self::Axial { start, end } => (
                PdfShadingKind::Axial,
                [start.x, start.y, end.x, end.y, 0.0, 0.0],
                4,
            ),
            Self::Radial { start, end } => (
                PdfShadingKind::Radial,
                [
                    start.center.x,
                    start.center.y,
                    start.radius,
                    end.center.x,
                    end.center.y,
                    end.radius,
                ],
                6,
            ),
        }
    }
}

pub(in crate::render::pdf) struct PdfShadingPattern {
    geometry: PdfShadingGeometry,
    transform: PdfMatrix,
    stops: PdfGradientStops,
    geometry_format: PdfPatternGeometryFormat,
}

pub(in crate::render::pdf) struct PdfFunctionPattern {
    transform: PdfMatrix,
    domain: PdfRect,
    calculator: String,
}

impl PdfFunctionPattern {
    pub(in crate::render::pdf) fn new(
        transform: PdfMatrix,
        domain: PdfRect,
        calculator: String,
    ) -> Option<Self> {
        (transform.is_invertible() && !domain.is_empty()).then_some(Self {
            transform,
            domain,
            calculator,
        })
    }

    pub(super) fn into_parts(self) -> (PdfMatrix, PdfRect, String) {
        (self.transform, self.domain, self.calculator)
    }
}

impl PdfShadingPattern {
    pub(in crate::render::pdf) const fn axial(
        start: PdfPoint,
        end: PdfPoint,
        transform: PdfMatrix,
        stops: PdfGradientStops,
        geometry_format: PdfPatternGeometryFormat,
    ) -> Self {
        Self {
            geometry: PdfShadingGeometry::Axial { start, end },
            transform,
            stops,
            geometry_format,
        }
    }

    pub(in crate::render::pdf) const fn radial(
        center: PdfPoint,
        end_radius: f32,
        transform: PdfMatrix,
        stops: PdfGradientStops,
        geometry_format: PdfPatternGeometryFormat,
    ) -> Self {
        Self {
            geometry: PdfShadingGeometry::Radial {
                start: PdfCircle::new(center, 0.0),
                end: PdfCircle::new(center, end_radius),
            },
            transform,
            stops,
            geometry_format,
        }
    }

    pub(super) fn into_pdf_parts(
        self,
    ) -> (
        PdfShadingKind,
        [f32; 6],
        usize,
        PdfMatrix,
        PdfGradientStops,
        PdfPatternGeometryFormat,
    ) {
        let (kind, coordinates, coordinate_count) = self.geometry.pdf();
        (
            kind,
            coordinates,
            coordinate_count,
            self.transform,
            self.stops,
            self.geometry_format,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiling_pattern_matrix_preserves_retained_f32_geometry() {
        let pattern = PdfTilingPattern {
            transform: PdfMatrix::new(
                PdfVector::new(1.0, 0.0),
                PdfVector::new(0.0, f32::from_bits((-1.0_f32).to_bits() - 2)),
                PdfPoint::new(0.0, f32::from_bits(72.0_f32.to_bits() - 1)),
            ),
            ..Default::default()
        };

        assert_eq!(
            pattern.matrix_dictionary_entry(),
            " /Matrix [1 0 0 -0.999999881 0 71.999992371]"
        );
    }
}
