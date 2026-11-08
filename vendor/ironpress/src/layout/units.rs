//! Browser-compatible fixed-point layout coordinates.
//!
//! Chromium uses 26.6 fixed point for ordinary layout and 16 fractional bits
//! inside text runs. Ironpress stores page geometry in points, so conversion
//! happens explicitly at the boundary and never hides the coordinate domain.

use crate::fonts::PT_PER_CSS_PX;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct CssFixedPoint<const FRACTIONAL_BITS: u32, const RAW_MIN: i64, const RAW_MAX: i64>(
    i64,
);

pub(crate) type LayoutUnit = CssFixedPoint<6, { i32::MIN as i64 }, { i32::MAX as i64 }>;
pub(crate) type TextRunLayoutUnit = CssFixedPoint<16, { i32::MIN as i64 }, { i32::MAX as i64 }>;
pub(crate) type InlineLayoutUnit = CssFixedPoint<16, { i64::MIN }, { i64::MAX }>;

impl<const FRACTIONAL_BITS: u32, const RAW_MIN: i64, const RAW_MAX: i64>
    CssFixedPoint<FRACTIONAL_BITS, RAW_MIN, RAW_MAX>
{
    const DENOMINATOR: f64 = (1_u64 << FRACTIONAL_BITS) as f64;

    pub(crate) const fn from_raw(raw: i64) -> Self {
        Self(if raw < RAW_MIN {
            RAW_MIN
        } else if raw > RAW_MAX {
            RAW_MAX
        } else {
            raw
        })
    }

    /// Chromium's ordinary float constructor truncates toward zero.
    pub(crate) fn from_css_pixels(css_pixels: f32) -> Self {
        Self::from_scaled(f64::from(css_pixels), f64::trunc)
    }

    pub(crate) fn from_css_pixels_floor(css_pixels: f32) -> Self {
        Self::from_scaled(f64::from(css_pixels), f64::floor)
    }

    #[cfg(test)]
    pub(crate) fn from_css_pixels_ceil(css_pixels: f32) -> Self {
        Self::from_scaled(f64::from(css_pixels), f64::ceil)
    }

    #[cfg(test)]
    pub(crate) fn from_css_pixels_round(css_pixels: f32) -> Self {
        Self::from_scaled(f64::from(css_pixels), f64::round)
    }

    pub(crate) fn from_points(points: f32) -> Self {
        Self::from_css_pixels(points / PT_PER_CSS_PX)
    }

    pub(crate) fn from_points_floor(points: f32) -> Self {
        Self::from_css_pixels_floor(points / PT_PER_CSS_PX)
    }

    #[cfg(test)]
    pub(crate) fn from_points_ceil(points: f32) -> Self {
        Self::from_css_pixels_ceil(points / PT_PER_CSS_PX)
    }

    #[cfg(test)]
    pub(crate) fn from_points_round(points: f32) -> Self {
        Self::from_css_pixels_round(points / PT_PER_CSS_PX)
    }

    pub(crate) const fn raw(self) -> i64 {
        self.0
    }

    pub(crate) fn to_css_pixels(self) -> f32 {
        (self.0 as f64 / Self::DENOMINATOR) as f32
    }

    pub(crate) fn to_points(self) -> f32 {
        self.to_css_pixels() * PT_PER_CSS_PX
    }

    fn from_scaled(value: f64, quantize: impl FnOnce(f64) -> f64) -> Self {
        let raw = quantize(value * Self::DENOMINATOR);
        if raw.is_nan() {
            Self::default()
        } else if raw <= RAW_MIN as f64 {
            Self(RAW_MIN)
        } else if raw >= RAW_MAX as f64 {
            Self(RAW_MAX)
        } else {
            Self(raw as i64)
        }
    }
}

impl<const FRACTIONAL_BITS: u32, const RAW_MIN: i64, const RAW_MAX: i64> std::ops::Add
    for CssFixedPoint<FRACTIONAL_BITS, RAW_MIN, RAW_MAX>
{
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self::from_raw(self.0.saturating_add(rhs.0))
    }
}

impl<const FRACTIONAL_BITS: u32, const RAW_MIN: i64, const RAW_MAX: i64> std::ops::Sub
    for CssFixedPoint<FRACTIONAL_BITS, RAW_MIN, RAW_MAX>
{
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Self::from_raw(self.0.saturating_sub(rhs.0))
    }
}

/// Bresenham-style distribution of an exact non-negative layout size across
/// buckets. The yielded units sum to the original size, including its fixed-
/// point remainder, so the final edge remains flush.
#[derive(Debug, Clone)]
pub(crate) struct LayoutUnitDiffuser {
    base: LayoutUnit,
    dx: u64,
    dy: u64,
    x: u64,
    y: u64,
    remaining: usize,
}

impl LayoutUnitDiffuser {
    pub(crate) fn new(size: LayoutUnit, buckets: usize) -> Option<Self> {
        let raw = u64::try_from(size.raw()).ok()?;
        let buckets_u64 = u64::try_from(buckets).ok()?;
        if buckets_u64 == 0 {
            return None;
        }
        let base = LayoutUnit::from_raw(i64::try_from(raw / buckets_u64).ok()?);
        let remainder = raw % buckets_u64;
        Some(Self {
            base,
            dx: remainder.saturating_mul(2),
            dy: buckets_u64.saturating_mul(2),
            x: 0,
            y: buckets_u64,
            remaining: buckets,
        })
    }
}

impl Iterator for LayoutUnitDiffuser {
    type Item = LayoutUnit;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        self.x = self.x.saturating_add(self.dx);
        if self.x >= self.y {
            self.y = self.y.saturating_add(self.dy);
            Some(self.base + LayoutUnit::from_raw(1))
        } else {
            Some(self.base)
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.remaining, Some(self.remaining))
    }
}

impl ExactSizeIterator for LayoutUnitDiffuser {}

#[cfg(test)]
mod tests {
    use super::{InlineLayoutUnit, LayoutUnit, LayoutUnitDiffuser, TextRunLayoutUnit};

    #[test]
    fn layout_unit_matches_chromium_construction_directions() {
        assert_eq!(LayoutUnit::from_css_pixels(1.999).raw(), 127);
        assert_eq!(LayoutUnit::from_css_pixels(-1.999).raw(), -127);
        assert_eq!(LayoutUnit::from_css_pixels_floor(-1.999).raw(), -128);
        assert_eq!(LayoutUnit::from_css_pixels_ceil(1.001).raw(), 65);
        assert_eq!(LayoutUnit::from_css_pixels_round(-1.5).raw(), -96);
    }

    #[test]
    fn point_conversion_keeps_the_coordinate_domain_explicit() {
        assert_eq!(
            LayoutUnit::from_points_round(8.208_984).to_points(),
            8.214_844
        );
        assert_eq!(
            LayoutUnit::from_points_floor(52.564_453).to_points(),
            52.558_594
        );
        assert_eq!(
            LayoutUnit::from_points_ceil(59.800_78).to_points(),
            59.800_78
        );
    }

    #[test]
    fn text_units_retain_sixteen_fractional_css_pixel_bits() {
        let points = 10.123_456;
        let text = TextRunLayoutUnit::from_points(points);
        let inline = InlineLayoutUnit::from_points(points);
        assert_eq!(text.raw(), inline.raw());
        assert!((text.to_points() - points).abs() < LayoutUnit::from_raw(1).to_points());
    }

    #[test]
    fn diffuser_preserves_total_and_spreads_the_remainder() {
        let size = LayoutUnit::from_raw(13);
        let mut diffuser = LayoutUnitDiffuser::new(size, 7).expect("non-empty distribution");
        let buckets = diffuser.by_ref().collect::<Vec<_>>();
        assert_eq!(buckets.len(), 7);
        assert_eq!(
            buckets
                .into_iter()
                .fold(LayoutUnit::default(), std::ops::Add::add),
            size
        );
        assert!(diffuser.next().is_none());
    }

    #[test]
    fn diffuser_rejects_invalid_domains_without_panicking() {
        assert!(LayoutUnitDiffuser::new(LayoutUnit::from_raw(-1), 4).is_none());
        assert!(LayoutUnitDiffuser::new(LayoutUnit::from_raw(4), 0).is_none());
    }
}
