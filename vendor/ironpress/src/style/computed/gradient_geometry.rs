//! Authored radial/conic gradient geometry.
//!
//! These values stay in CSS space until a renderer resolves them against a
//! concrete painting box. Keeping the point/vector pair types together avoids
//! tuple indexing at every consumer and makes the two-dimensional contract
//! explicit.

use super::{GradientLayerBox, GradientRamp};

/// A position component of a radial gradient's center, resolvable against the
/// painted box at render time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RadialPos {
    /// Fraction of the box extent (0..1), e.g. from a keyword or percentage.
    Fraction(f32),
    /// Absolute offset in points from the box's start edge (left/top).
    Points(f32),
    /// Absolute offset in points from the box's end edge (right/bottom).
    EndOffset(f32),
}

impl RadialPos {
    /// Resolve to an offset in points given the box extent along this axis.
    pub fn resolve(self, extent: f32) -> f32 {
        match self {
            Self::Fraction(f) => extent * f,
            Self::Points(p) => p,
            Self::EndOffset(p) => extent - p,
        }
    }
}

/// A two-dimensional authored radial-gradient position (`at x y`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RadialPoint {
    pub x: RadialPos,
    pub y: RadialPos,
}

impl RadialPoint {
    pub const fn new(x: RadialPos, y: RadialPos) -> Self {
        Self { x, y }
    }
}

impl Default for RadialPoint {
    fn default() -> Self {
        Self::new(RadialPos::Fraction(0.5), RadialPos::Fraction(0.5))
    }
}

/// A two-dimensional authored radial-gradient extent (`rx ry`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RadialVector {
    pub x: RadialPos,
    pub y: RadialPos,
}

impl RadialVector {
    pub const fn new(x: RadialPos, y: RadialPos) -> Self {
        Self { x, y }
    }
}

/// The ending shape of a CSS radial gradient.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RadialShape {
    Circle,
    #[default]
    Ellipse,
}

/// The size/extent of a CSS radial gradient's ending shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RadialExtent {
    ClosestSide,
    ClosestCorner,
    FarthestSide,
    #[default]
    FarthestCorner,
}

/// A CSS radial gradient.
#[derive(Debug, Clone)]
pub struct RadialGradient {
    pub ramp: GradientRamp,
    pub center: RadialPoint,
    pub shape: RadialShape,
    pub extent: RadialExtent,
    pub radius: Option<f32>,
    pub radii: Option<RadialVector>,
    pub layer_box: GradientLayerBox,
}

/// A CSS conic gradient.
#[derive(Debug, Clone)]
pub struct ConicGradient {
    pub from_angle: f32,
    pub center: RadialPoint,
    pub ramp: GradientRamp,
    pub layer_box: GradientLayerBox,
}
