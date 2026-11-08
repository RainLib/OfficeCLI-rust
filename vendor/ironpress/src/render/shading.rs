//! Shared, validated PDF shading primitives for CSS and SVG gradients.

use crate::render::pdf_syntax::format_pdf_number;

/// One DeviceRGB value at the precision used by native PDF shadings.
///
/// Skia's PDF backend serializes gradient channels to four decimal places.
/// Canonicalizing once at this boundary keeps every CSS and SVG shading on the
/// same representation and avoids scattering formatting policy through the
/// emitters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PdfRgb {
    red: f32,
    green: f32,
    blue: f32,
}

impl PdfRgb {
    fn channel(value: f32) -> f32 {
        if value.is_finite() {
            (value * 10_000.0).round() / 10_000.0
        } else {
            value
        }
    }

    fn is_finite(self) -> bool {
        self.red.is_finite() && self.green.is_finite() && self.blue.is_finite()
    }

    fn is_device_rgb(self) -> bool {
        [self.red, self.green, self.blue]
            .into_iter()
            .all(|channel| (0.0..=1.0).contains(&channel))
    }

    pub(crate) fn stroke_operator(self) -> String {
        format!(
            "{} {} {} RG\n",
            format_pdf_number(self.red),
            format_pdf_number(self.green),
            format_pdf_number(self.blue),
        )
    }

    pub(crate) fn fill_operator(self) -> String {
        format!(
            "{} {} {} rg\n",
            format_pdf_number(self.red),
            format_pdf_number(self.green),
            format_pdf_number(self.blue),
        )
    }

    pub(crate) const fn components(self) -> [f32; 3] {
        [self.red, self.green, self.blue]
    }
}

impl From<(f32, f32, f32)> for PdfRgb {
    fn from((red, green, blue): (f32, f32, f32)) -> Self {
        Self {
            red: Self::channel(red),
            green: Self::channel(green),
            blue: Self::channel(blue),
        }
    }
}

impl From<crate::types::Color> for PdfRgb {
    fn from(color: crate::types::Color) -> Self {
        Self::from(color.to_f32_rgb())
    }
}

/// The parameter domain consumed by a PDF axial or radial shading function.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PdfGradientDomain {
    start: f32,
    end: f32,
}

/// A gradient-function coordinate together with its intentional PDF spelling.
/// Generic callers retain every `f32` distinction; the browser-compatible PDF
/// gradient backend writes its scalar coordinates to eight decimal places.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum PdfGradientOffset {
    Exact(f32),
    Backend(f64),
}

impl PdfGradientOffset {
    pub(crate) fn backend(value: f32) -> Self {
        Self::Backend((f64::from(value) * 100_000_000.0).round() / 100_000_000.0)
    }

    fn value(self) -> f64 {
        match self {
            Self::Exact(value) => f64::from(value),
            Self::Backend(value) => value,
        }
    }

    fn is_finite(self) -> bool {
        self.value().is_finite()
    }

    fn pdf_number(self) -> String {
        match self {
            Self::Exact(value) => format_pdf_number(value),
            Self::Backend(0.0) => "0".to_string(),
            Self::Backend(value) => value.to_string(),
        }
    }
}

impl From<f32> for PdfGradientOffset {
    fn from(value: f32) -> Self {
        Self::Exact(value)
    }
}

impl PdfGradientDomain {
    pub(crate) const UNIT: Self = Self {
        start: 0.0,
        end: 1.0,
    };
}

/// Why an authored stop list cannot be represented by one native PDF shading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PdfGradientError {
    TooFewStops,
    NonFiniteOffset { index: usize },
    NonFiniteColor { index: usize },
    ColorOutsideDeviceRgb { index: usize },
    StopOutsideDomain { index: usize },
    DescendingOffsets { index: usize },
}

/// A stop whose offset and color have been validated for PDF emission.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PdfGradientStop {
    offset: PdfGradientOffset,
    color: PdfRgb,
}

/// A native-PDF stop list covering its complete parameter domain.
///
/// Construction adds constant-color plateaus between the domain edges and the
/// first/last authored stops. Equal same-color stops are redundant and collapse;
/// equal differing-color stops remain a PDF stitching boundary.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PdfGradientStops {
    domain: PdfGradientDomain,
    stops: Box<[PdfGradientStop]>,
}

impl PdfGradientStops {
    pub(crate) fn unit<O, C>(
        stops: impl IntoIterator<Item = (O, C)>,
    ) -> Result<Self, PdfGradientError>
    where
        O: Into<PdfGradientOffset>,
        C: Into<PdfRgb>,
    {
        Self::new(PdfGradientDomain::UNIT, stops)
    }

    fn new<O, C>(
        domain: PdfGradientDomain,
        stops: impl IntoIterator<Item = (O, C)>,
    ) -> Result<Self, PdfGradientError>
    where
        O: Into<PdfGradientOffset>,
        C: Into<PdfRgb>,
    {
        let authored = stops
            .into_iter()
            .map(|(offset, color)| (offset.into(), color.into()))
            .collect::<Vec<_>>();
        if authored.len() < 2 {
            return Err(PdfGradientError::TooFewStops);
        }

        let mut canonical: Vec<PdfGradientStop> = Vec::with_capacity(authored.len() + 2);
        for (index, (offset, color)) in authored.into_iter().enumerate() {
            if !offset.is_finite() {
                return Err(PdfGradientError::NonFiniteOffset { index });
            }
            if !color.is_finite() {
                return Err(PdfGradientError::NonFiniteColor { index });
            }
            if !color.is_device_rgb() {
                return Err(PdfGradientError::ColorOutsideDeviceRgb { index });
            }
            if offset.value() < f64::from(domain.start) || offset.value() > f64::from(domain.end) {
                return Err(PdfGradientError::StopOutsideDomain { index });
            }

            if let Some(previous) = canonical.last_mut() {
                if offset.value() == previous.offset.value() {
                    if color == previous.color {
                        continue;
                    }
                    canonical.push(PdfGradientStop { offset, color });
                    continue;
                }
                if offset.value() < previous.offset.value() {
                    return Err(PdfGradientError::DescendingOffsets { index });
                }
            }
            canonical.push(PdfGradientStop { offset, color });
        }

        let first = canonical
            .first()
            .copied()
            .ok_or(PdfGradientError::TooFewStops)?;
        if first.offset.value() > f64::from(domain.start) {
            canonical.insert(
                0,
                PdfGradientStop {
                    offset: domain.start.into(),
                    color: first.color,
                },
            );
        }

        let last = canonical
            .last()
            .copied()
            .ok_or(PdfGradientError::TooFewStops)?;
        if last.offset.value() < f64::from(domain.end) {
            canonical.push(PdfGradientStop {
                offset: domain.end.into(),
                color: last.color,
            });
        }

        if canonical.len() < 2 {
            return Err(PdfGradientError::TooFewStops);
        }
        Ok(Self {
            domain,
            stops: canonical.into_boxed_slice(),
        })
    }

    #[cfg(test)]
    pub(super) fn stops(&self) -> &[PdfGradientStop] {
        &self.stops
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PdfShadingKind {
    Axial,
    Radial,
}

impl PdfShadingKind {
    pub(crate) const fn pdf_type(self) -> u8 {
        match self {
            Self::Axial => 2,
            Self::Radial => 3,
        }
    }
}

/// A PDF shading dictionary entry with a function-safe stop domain.
#[derive(Debug, Clone)]
pub(crate) struct ShadingEntry {
    pub name: String,
    pub kind: PdfShadingKind,
    pub coords: [f32; 6],
    pub stops: PdfGradientStops,
}

/// Reserve a shading name and store an axial shading entry for the current page.
pub(crate) fn push_axial_shading(
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
    coords: [f32; 4],
    stops: PdfGradientStops,
) -> String {
    let name = format!("SH{}", *shading_counter);
    *shading_counter += 1;
    shadings.push(ShadingEntry {
        name: name.clone(),
        kind: PdfShadingKind::Axial,
        coords: [coords[0], coords[1], coords[2], coords[3], 0.0, 0.0],
        stops,
    });
    name
}

/// Reserve a shading name and store a radial shading entry for the current page.
pub(crate) fn push_radial_shading(
    shadings: &mut Vec<ShadingEntry>,
    shading_counter: &mut usize,
    coords: [f32; 6],
    stops: PdfGradientStops,
) -> String {
    let name = format!("SH{}", *shading_counter);
    *shading_counter += 1;
    shadings.push(ShadingEntry {
        name: name.clone(),
        kind: PdfShadingKind::Radial,
        coords,
        stops,
    });
    name
}

fn type2_function(start: PdfRgb, end: PdfRgb) -> String {
    format!(
        "<< /FunctionType 2 /Domain [0 1] /C0 [{} {} {}] /C1 [{} {} {}] /N 1 >>",
        format_pdf_number(start.red),
        format_pdf_number(start.green),
        format_pdf_number(start.blue),
        format_pdf_number(end.red),
        format_pdf_number(end.green),
        format_pdf_number(end.blue),
    )
}

/// Build the PDF function for a validated gradient stop domain.
pub(crate) fn build_shading_function(stops: &PdfGradientStops) -> String {
    let [first, second] = stops.stops.as_ref() else {
        let functions = stops
            .stops
            .windows(2)
            .map(|pair| type2_function(pair[0].color, pair[1].color))
            .collect::<Vec<_>>()
            .join(" ");
        let bounds = stops.stops[1..stops.stops.len() - 1]
            .iter()
            .map(|stop| stop.offset.pdf_number())
            .collect::<Vec<_>>()
            .join(" ");
        let encode = std::iter::repeat_n("0 1", stops.stops.len() - 1)
            .collect::<Vec<_>>()
            .join(" ");
        return format!(
            "<< /FunctionType 3 /Domain [{} {}] /Functions [{functions}] /Bounds [{bounds}] /Encode [{encode}] >>",
            format_pdf_number(stops.domain.start),
            format_pdf_number(stops.domain.end),
        );
    };

    debug_assert_eq!(first.offset.value(), f64::from(stops.domain.start));
    debug_assert_eq!(second.offset.value(), f64::from(stops.domain.end));
    type2_function(first.color, second.color)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(value: f32) -> PdfRgb {
        (value, value, value).into()
    }

    #[test]
    fn endpoint_positions_become_constant_color_plateaus() {
        let stops = PdfGradientStops::unit([(0.2, rgb(0.0)), (0.8, rgb(1.0))]).unwrap();
        assert_eq!(
            stops.stops(),
            [
                PdfGradientStop {
                    offset: 0.0.into(),
                    color: rgb(0.0),
                },
                PdfGradientStop {
                    offset: 0.2.into(),
                    color: rgb(0.0),
                },
                PdfGradientStop {
                    offset: 0.8.into(),
                    color: rgb(1.0),
                },
                PdfGradientStop {
                    offset: 1.0.into(),
                    color: rgb(1.0),
                },
            ]
        );
        let function = build_shading_function(&stops);
        assert!(function.contains("/Bounds [0.2 0.8]"));
        assert_eq!(function.matches("/FunctionType 2").count(), 3);
    }

    #[test]
    fn exact_differing_color_hard_stop_is_native_stitch_boundary() {
        let stops = PdfGradientStops::unit([
            (0.0, rgb(0.0)),
            (0.5, rgb(0.0)),
            (0.5, rgb(1.0)),
            (1.0, rgb(1.0)),
        ])
        .unwrap();
        assert!(build_shading_function(&stops).contains("/Bounds [0.5 0.5]"));
    }

    #[test]
    fn exact_same_color_duplicate_is_removed() {
        let stops = PdfGradientStops::unit([
            (0.0, rgb(0.0)),
            (0.5, rgb(0.5)),
            (0.5, rgb(0.5)),
            (1.0, rgb(1.0)),
        ])
        .unwrap();
        assert_eq!(stops.stops().len(), 3);
        assert!(
            stops
                .stops()
                .windows(2)
                .all(|pair| pair[0].offset.value() < pair[1].offset.value())
        );
    }

    #[test]
    fn device_rgb_channels_have_one_canonical_pdf_precision() {
        let stops = PdfGradientStops::unit([
            (0.0, (30.0 / 255.0, 136.0 / 255.0, 229.0 / 255.0)),
            (1.0, (229.0 / 255.0, 57.0 / 255.0, 53.0 / 255.0)),
        ])
        .unwrap();
        let function = build_shading_function(&stops);
        assert!(function.contains("/C0 [0.1176 0.5333 0.898]"));
        assert!(function.contains("/C1 [0.898 0.2235 0.2078]"));
    }

    #[test]
    fn adjacent_distinct_floats_remain_distinct_bounds() {
        let left = 0.5_f32;
        let right = f32::from_bits(left.to_bits() + 1);
        let stops = PdfGradientStops::unit([
            (0.0, rgb(0.0)),
            (left, rgb(0.25)),
            (right, rgb(0.75)),
            (1.0, rgb(1.0)),
        ])
        .unwrap();
        assert_eq!(stops.stops()[1].offset, left.into());
        assert_eq!(stops.stops()[2].offset, right.into());
        let function = build_shading_function(&stops);
        assert!(function.contains(&format!("/Bounds [{left} {right}]")));
    }

    #[test]
    fn subnormal_adjacent_bounds_use_pdf_number_grammar() {
        let left = f32::from_bits(1);
        let right = f32::from_bits(2);
        let stops = PdfGradientStops::unit([(left, rgb(0.0)), (right, rgb(1.0))]).unwrap();
        let left_text = format_pdf_number(left);
        let right_text = format_pdf_number(right);
        assert_ne!(left_text, right_text);
        assert!(
            left_text
                .bytes()
                .chain(right_text.bytes())
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
        );
        let function = build_shading_function(&stops);
        assert!(function.contains(&format!("/Bounds [{left_text} {right_text}]")));
    }

    #[test]
    fn non_finite_and_descending_stops_are_rejected() {
        assert_eq!(
            PdfGradientStops::unit([(0.0, rgb(0.0)), (f32::NAN, rgb(1.0))]),
            Err(PdfGradientError::NonFiniteOffset { index: 1 })
        );
        assert_eq!(
            PdfGradientStops::unit([(0.8, rgb(0.0)), (0.2, rgb(1.0))]),
            Err(PdfGradientError::DescendingOffsets { index: 1 })
        );
        assert_eq!(
            PdfGradientStops::unit([(0.0, rgb(0.0)), (1.0, (f32::INFINITY, 0.0, 0.0).into()),]),
            Err(PdfGradientError::NonFiniteColor { index: 1 })
        );
        assert_eq!(
            PdfGradientStops::unit([(0.0, (f32::INFINITY, 0.0, 0.0)), (1.0, (1.0, 1.0, 1.0))]),
            Err(PdfGradientError::NonFiniteColor { index: 0 })
        );
    }

    #[test]
    fn native_stop_count_has_no_selector_cliff() {
        for count in [16, 17] {
            let stops = PdfGradientStops::unit((0..count).map(|index| {
                let offset = index as f32 / (count - 1) as f32;
                (offset, rgb(offset))
            }))
            .unwrap();
            assert_eq!(stops.stops().len(), count);
            assert!(
                stops
                    .stops()
                    .windows(2)
                    .all(|pair| pair[0].offset.value() < pair[1].offset.value())
            );
        }
    }

    #[test]
    fn push_helpers_store_typed_kind_and_coordinates() {
        let stops = PdfGradientStops::unit([(0.0, rgb(0.0)), (1.0, rgb(1.0))]).unwrap();
        let mut shadings = Vec::new();
        let mut counter = 0;
        assert_eq!(
            push_axial_shading(
                &mut shadings,
                &mut counter,
                [1.0, 2.0, 3.0, 4.0],
                stops.clone(),
            ),
            "SH0"
        );
        assert_eq!(
            push_radial_shading(
                &mut shadings,
                &mut counter,
                [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                stops,
            ),
            "SH1"
        );
        assert_eq!(shadings[0].kind, PdfShadingKind::Axial);
        assert_eq!(shadings[0].coords, [1.0, 2.0, 3.0, 4.0, 0.0, 0.0]);
        assert_eq!(shadings[1].kind, PdfShadingKind::Radial);
        assert_eq!(shadings[1].coords, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(counter, 2);
    }
}
