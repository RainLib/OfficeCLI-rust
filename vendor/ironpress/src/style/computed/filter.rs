//! Semantic computed values for CSS and SVG filter effects.

use crate::types::{Color, Rect};

use super::BlendMode;

/// A valid SVG filter region in normalized object-bounding-box coordinates.
///
/// The private rectangle prevents downstream code from confusing normalized
/// fractions with authored point geometry. Parsing rejects non-finite or empty
/// regions once; every later consumer can rely on a positive extent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct NormalizedFilterRegion(Rect);

impl NormalizedFilterRegion {
    pub(crate) fn new(x: f32, y: f32, width: f32, height: f32) -> Option<Self> {
        (x.is_finite()
            && y.is_finite()
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0)
            .then_some(Self(Rect::from_xywh(x, y, width, height)))
    }

    pub(crate) const fn as_rect(self) -> Rect {
        self.0
    }
}

impl Default for NormalizedFilterRegion {
    fn default() -> Self {
        Self(Rect::from_xywh(-0.1, -0.1, 1.2, 1.2))
    }
}

/// CSS `filter: drop-shadow(<offset-x> <offset-y> <blur>? <color>?)`.
///
/// Offsets and blur radius are in points; `color` is straight-alpha sRGB.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DropShadow {
    pub dx: f32,
    pub dy: f32,
    pub blur: f32,
    pub color: Color,
}

/// One operation in a CSS or resolved SVG filter pipeline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilterOperation {
    Grayscale(f32),
    Sepia(f32),
    Invert(f32),
    Brightness(f32),
    Contrast(f32),
    Saturate(f32),
    HueRotate(f32),
    Opacity(f32),
    Matrix([f32; 20]),
    /// SVG `feBlend` with an `feFlood` input.
    BlendWithFlood {
        color: Color,
        mode: BlendMode,
        region: NormalizedFilterRegion,
    },
    Blur(f32),
    Offset {
        dx: f32,
        dy: f32,
        keep_source: bool,
        region: NormalizedFilterRegion,
    },
    DropShadow(DropShadow),
    MorphologyDilate(f32),
}

impl FilterOperation {
    /// Whether this operation leaves every input pixel unchanged.
    ///
    /// This deliberately says nothing about CSS stacking semantics: a
    /// non-`none` filter still establishes a stacking context.
    pub(crate) fn is_visual_identity(&self) -> bool {
        const EPSILON: f32 = 1e-6;
        match self {
            Self::Grayscale(amount)
            | Self::Sepia(amount)
            | Self::Invert(amount)
            | Self::Blur(amount)
            | Self::MorphologyDilate(amount) => amount.abs() <= EPSILON,
            Self::Brightness(amount)
            | Self::Contrast(amount)
            | Self::Saturate(amount)
            | Self::Opacity(amount) => (*amount - 1.0).abs() <= EPSILON,
            Self::HueRotate(degrees) => degrees.rem_euclid(360.0).abs() <= EPSILON,
            Self::Matrix(values) => {
                const IDENTITY: [f32; 20] = [
                    1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                ];
                values
                    .iter()
                    .zip(IDENTITY)
                    .all(|(value, identity)| (*value - identity).abs() <= EPSILON)
            }
            Self::BlendWithFlood { .. } | Self::Offset { .. } | Self::DropShadow(_) => false,
        }
    }

    /// Whether an SVG filter raster must retain the complete hard filter
    /// region rather than only the finite support around painted input.
    ///
    /// Gaussian kernels have unbounded mathematical support. Flood blending
    /// and matrices with a positive alpha offset can also paint transparent
    /// filter-region samples.
    pub(crate) fn requires_complete_svg_region(&self) -> bool {
        match self {
            Self::Blur(radius) => *radius > 0.0,
            Self::DropShadow(shadow) => shadow.blur > 0.0,
            Self::BlendWithFlood { .. } => true,
            Self::Matrix(values) => values[19] > 0.0,
            _ => false,
        }
    }
}

/// The computed effect of the CSS `filter` property.
#[derive(Debug, Clone, Default)]
pub struct FilterEffects {
    /// True exactly when the computed `filter` value is not `none`.
    pub establishes_stacking_context: bool,
    /// Filter operations in CSS source order.
    pub operations: Vec<FilterOperation>,
    /// Fragment identifier from `url(#filter)` pending SVG filter resolution.
    pub url_id: Option<String>,
}
