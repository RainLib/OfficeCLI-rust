use std::ops::{Add, AddAssign, Sub, SubAssign};

/// Page size in points (1 pt = 1/72 inch).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSize {
    /// Page width in points.
    pub width: f32,
    /// Page height in points.
    pub height: f32,
}

impl PageSize {
    /// ISO A4: 210 mm x 297 mm (595.28 x 841.89 pt).
    pub const A4: Self = Self {
        width: 595.28,
        height: 841.89,
    };
    /// US Letter: 8.5 x 11 in (612 x 792 pt).
    pub const LETTER: Self = Self {
        width: 612.0,
        height: 792.0,
    };
    /// US Legal: 8.5 x 14 in (612 x 1008 pt).
    pub const LEGAL: Self = Self {
        width: 612.0,
        height: 1008.0,
    };

    /// Create a custom page size from width and height in points.
    pub fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

impl Default for PageSize {
    fn default() -> Self {
        Self::A4
    }
}

/// A width and height measured in the coordinate system of its owner.
///
/// Unlike [`PageSize`], this does not imply a physical page. It keeps paired
/// dimensions together for layout and rendering metadata.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Size {
    /// Horizontal extent.
    pub width: f32,
    /// Vertical extent.
    pub height: f32,
}

impl Size {
    /// Create a size from horizontal and vertical extents.
    pub const fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

/// A position in a two-dimensional coordinate space.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Point {
    /// Horizontal coordinate.
    pub x: f32,
    /// Vertical coordinate.
    pub y: f32,
}

impl Point {
    /// The origin of a local coordinate space.
    pub const ORIGIN: Self = Self::new(0.0, 0.0);

    /// Create a point from horizontal and vertical coordinates.
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// An axis-aligned rectangle represented by its origin and extent.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rect {
    /// Top-left origin in the rectangle owner's coordinate space.
    pub origin: Point,
    /// Horizontal and vertical extents.
    pub size: Size,
}

impl Rect {
    /// Create a rectangle from its semantic components.
    pub const fn new(origin: Point, size: Size) -> Self {
        Self { origin, size }
    }

    /// Create a rectangle from physical x/y/width/height values.
    pub const fn from_xywh(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self::new(Point::new(x, y), Size::new(width, height))
    }

    /// Coordinate of the right edge.
    pub const fn right(self) -> f32 {
        self.origin.x + self.size.width
    }

    /// Coordinate of the bottom edge in the top-down CSS coordinate system.
    pub const fn bottom(self) -> f32 {
        self.origin.y + self.size.height
    }

    /// Inset the rectangle by physical CSS edges. The inset origin is retained
    /// even when the edges consume the available extent; only the resulting
    /// size is clamped to zero.
    pub fn inset(self, edges: EdgeSizes) -> Self {
        Self::from_xywh(
            self.origin.x + edges.left,
            self.origin.y + edges.top,
            (self.size.width - edges.horizontal()).max(0.0),
            (self.size.height - edges.vertical()).max(0.0),
        )
    }

    /// Expand the rectangle by physical edges.
    pub fn outset(self, edges: EdgeSizes) -> Self {
        Self::from_xywh(
            self.origin.x - edges.left,
            self.origin.y - edges.top,
            self.size.width + edges.horizontal(),
            self.size.height + edges.vertical(),
        )
    }

    /// Translate the rectangle without changing its extent.
    pub fn translate(self, displacement: Vector) -> Self {
        Self::new(self.origin + displacement, self.size)
    }

    /// Smallest axis-aligned rectangle enclosing both inputs.
    pub fn union(self, other: Self) -> Self {
        let left = self.origin.x.min(other.origin.x);
        let top = self.origin.y.min(other.origin.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Self::from_xywh(left, top, right - left, bottom - top)
    }

    /// Geometric intersection of two non-empty rectangles.
    pub fn intersection(self, other: Self) -> Option<Self> {
        let left = self.origin.x.max(other.origin.x);
        let top = self.origin.y.max(other.origin.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > left && bottom > top)
            .then(|| Self::from_xywh(left, top, right - left, bottom - top))
    }
}

/// A two-dimensional displacement. Unlike [`Point`], vectors compose by
/// addition and can translate positions without losing their meaning.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Vector {
    /// Horizontal displacement.
    pub x: f32,
    /// Vertical displacement.
    pub y: f32,
}

impl Vector {
    /// A displacement with no movement on either axis.
    pub const ZERO: Self = Self::new(0.0, 0.0);

    /// Create a vector from horizontal and vertical components.
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    /// Euclidean magnitude of this displacement.
    pub fn length(self) -> f32 {
        self.x.hypot(self.y)
    }
}

impl Add<Vector> for Point {
    type Output = Self;

    fn add(self, rhs: Vector) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl AddAssign<Vector> for Point {
    fn add_assign(&mut self, rhs: Vector) {
        *self = *self + rhs;
    }
}

impl Sub<Point> for Point {
    type Output = Vector;

    fn sub(self, rhs: Point) -> Self::Output {
        Vector::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl Add for Vector {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl AddAssign for Vector {
    fn add_assign(&mut self, rhs: Self) {
        *self = *self + rhs;
    }
}

impl Sub for Vector {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl SubAssign for Vector {
    fn sub_assign(&mut self, rhs: Self) {
        *self = *self - rhs;
    }
}

impl std::ops::Mul<f32> for Vector {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        Self::new(self.x * rhs, self.y * rhs)
    }
}

/// Page margins in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margin {
    /// Top margin in points.
    pub top: f32,
    /// Right margin in points.
    pub right: f32,
    /// Bottom margin in points.
    pub bottom: f32,
    /// Left margin in points.
    pub left: f32,
}

impl Margin {
    /// Create margins with individual values for each side.
    pub const fn new(top: f32, right: f32, bottom: f32, left: f32) -> Self {
        Self {
            top,
            right,
            bottom,
            left,
        }
    }

    /// Create margins with the same value on all sides.
    pub const fn uniform(v: f32) -> Self {
        Self::new(v, v, v, v)
    }

    /// Sum the left and right page margins.
    pub const fn horizontal(self) -> f32 {
        self.left + self.right
    }

    /// Sum the top and bottom page margins.
    pub const fn vertical(self) -> f32 {
        self.top + self.bottom
    }
}

impl std::ops::Add for Margin {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(
            self.top + rhs.top,
            self.right + rhs.right,
            self.bottom + rhs.bottom,
            self.left + rhs.left,
        )
    }
}

impl Default for Margin {
    fn default() -> Self {
        Self::uniform(72.0) // 1 inch
    }
}

/// One physical side of a rectangular box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalSide {
    /// Top side.
    Top,
    /// Right side.
    Right,
    /// Bottom side.
    Bottom,
    /// Left side.
    Left,
}

impl PhysicalSide {
    /// All physical sides in clockwise CSS order.
    pub const ALL: [Self; 4] = [Self::Top, Self::Right, Self::Bottom, Self::Left];

    /// The adjoining side in clockwise order.
    pub const fn clockwise(self) -> Self {
        match self {
            Self::Top => Self::Right,
            Self::Right => Self::Bottom,
            Self::Bottom => Self::Left,
            Self::Left => Self::Top,
        }
    }

    /// The adjoining side in counter-clockwise order.
    pub const fn counter_clockwise(self) -> Self {
        match self {
            Self::Top => Self::Left,
            Self::Right => Self::Top,
            Self::Bottom => Self::Right,
            Self::Left => Self::Bottom,
        }
    }
}

/// One value for every physical side of a rectangular box.
///
/// The field and constructor order follows CSS: top, right, bottom, left.
/// Reuse this type for every four-sided concept instead of creating parallel
/// edge containers or passing four unrelated scalars.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PhysicalEdges<T> {
    /// Top-side value.
    pub top: T,
    /// Right-side value.
    pub right: T,
    /// Bottom-side value.
    pub bottom: T,
    /// Left-side value.
    pub left: T,
}

impl<T> PhysicalEdges<T> {
    /// Construct physical edges in CSS top/right/bottom/left order.
    pub const fn new(top: T, right: T, bottom: T, left: T) -> Self {
        Self {
            top,
            right,
            bottom,
            left,
        }
    }

    /// Construct physical edges from CSS top/right/bottom/left array order.
    pub fn from_array(values: [T; 4]) -> Self {
        let [top, right, bottom, left] = values;
        Self::new(top, right, bottom, left)
    }

    /// Borrow the value on one physical side.
    pub const fn get(&self, side: PhysicalSide) -> &T {
        match side {
            PhysicalSide::Top => &self.top,
            PhysicalSide::Right => &self.right,
            PhysicalSide::Bottom => &self.bottom,
            PhysicalSide::Left => &self.left,
        }
    }

    /// Mutably borrow the value on one physical side.
    pub const fn get_mut(&mut self, side: PhysicalSide) -> &mut T {
        match side {
            PhysicalSide::Top => &mut self.top,
            PhysicalSide::Right => &mut self.right,
            PhysicalSide::Bottom => &mut self.bottom,
            PhysicalSide::Left => &mut self.left,
        }
    }

    /// Transform every side while preserving its physical position.
    pub fn map<U>(self, mut map: impl FnMut(T) -> U) -> PhysicalEdges<U> {
        PhysicalEdges::new(
            map(self.top),
            map(self.right),
            map(self.bottom),
            map(self.left),
        )
    }

    /// Whether a predicate holds for every physical edge.
    pub fn all(self, mut predicate: impl FnMut(T) -> bool) -> bool {
        predicate(self.top)
            && predicate(self.right)
            && predicate(self.bottom)
            && predicate(self.left)
    }
}

impl<T: Copy> PhysicalEdges<T> {
    /// Construct physical edges with the same value on every side.
    pub const fn uniform(value: T) -> Self {
        Self::new(value, value, value, value)
    }
}

/// Physical edge sizes used by box-model geometry.
pub type EdgeSizes = PhysicalEdges<f32>;

/// Physical-side membership flags.
pub type PhysicalEdgeFlags = PhysicalEdges<bool>;

impl PhysicalEdges<f32> {
    /// Zero on every edge.
    pub const ZERO: Self = Self::uniform(0.0);

    /// Create symmetric physical edges from horizontal and vertical axes.
    pub const fn axes(horizontal: f32, vertical: f32) -> Self {
        Self::new(vertical, horizontal, vertical, horizontal)
    }

    /// Sum the left and right edges.
    pub const fn horizontal(self) -> f32 {
        self.left + self.right
    }

    /// Sum the top and bottom edges.
    pub const fn vertical(self) -> f32 {
        self.top + self.bottom
    }

    /// Keep only the horizontal edges.
    pub const fn horizontal_only(self) -> Self {
        Self::new(0.0, self.right, 0.0, self.left)
    }

    /// Whether every edge is exactly zero.
    pub fn is_zero(self) -> bool {
        self == Self::ZERO
    }

    /// Keep the larger value independently on every physical edge.
    pub fn max_each(self, other: Self) -> Self {
        Self::new(
            self.top.max(other.top),
            self.right.max(other.right),
            self.bottom.max(other.bottom),
            self.left.max(other.left),
        )
    }

    /// Whether every edge is at least as large as the corresponding edge.
    pub fn contains_each(self, other: Self) -> bool {
        self.top >= other.top
            && self.right >= other.right
            && self.bottom >= other.bottom
            && self.left >= other.left
    }

    /// Clamp each physical edge independently to its corresponding rectangle
    /// dimension, without changing the other edges. This preserves overlapping
    /// inset regions such as CSS `border-image-slice` corners.
    pub fn clamp_to_extents(self, width: f32, height: f32) -> Self {
        Self::new(
            self.top.min(height.max(0.0)),
            self.right.min(width.max(0.0)),
            self.bottom.min(height.max(0.0)),
            self.left.min(width.max(0.0)),
        )
    }

    /// Scale every edge by one factor until neither opposite pair overlaps.
    ///
    /// CSS `border-image-width` uses a single factor across both axes, so a
    /// constraint on one pair proportionally changes all four edge widths.
    pub fn scale_to_fit_within(self, width: f32, height: f32) -> Self {
        let factor_for = |extent: f32, sum: f32| {
            if sum > 0.0 {
                extent.max(0.0) / sum
            } else {
                1.0
            }
        };
        let factor = 1.0_f32
            .min(factor_for(width, self.horizontal()))
            .min(factor_for(height, self.vertical()));
        self * factor
    }
}

impl std::ops::Add for PhysicalEdges<f32> {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(
            self.top + rhs.top,
            self.right + rhs.right,
            self.bottom + rhs.bottom,
            self.left + rhs.left,
        )
    }
}

impl std::ops::Sub for PhysicalEdges<f32> {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self::new(
            self.top - rhs.top,
            self.right - rhs.right,
            self.bottom - rhs.bottom,
            self.left - rhs.left,
        )
    }
}

impl std::ops::Mul<f32> for PhysicalEdges<f32> {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        Self::new(
            self.top * rhs,
            self.right * rhs,
            self.bottom * rhs,
            self.left * rhs,
        )
    }
}

impl std::ops::AddAssign for PhysicalEdges<f32> {
    fn add_assign(&mut self, rhs: Self) {
        *self = *self + rhs;
    }
}

impl std::ops::SubAssign for PhysicalEdges<f32> {
    fn sub_assign(&mut self, rhs: Self) {
        *self = *self - rhs;
    }
}

impl std::ops::MulAssign<f32> for PhysicalEdges<f32> {
    fn mul_assign(&mut self, rhs: f32) {
        *self = *self * rhs;
    }
}

/// The horizontal and vertical radius of one resolved box corner.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CornerRadius {
    /// Horizontal radius.
    pub x: f32,
    /// Vertical radius.
    pub y: f32,
}

impl CornerRadius {
    /// A square corner.
    pub const ZERO: Self = Self::circular(0.0);

    /// Construct an elliptical corner.
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    /// Construct a circular corner.
    pub const fn circular(radius: f32) -> Self {
        Self::new(radius, radius)
    }

    /// Whether either zero axis makes this a square corner in CSS geometry.
    pub fn is_zero(self) -> bool {
        self.x <= 0.0 || self.y <= 0.0
    }

    /// Whether both axes have the same radius.
    pub fn is_circular(self) -> bool {
        self.x == self.y
    }

    fn map_axes(self, mut f: impl FnMut(f32) -> f32) -> Self {
        Self::new(f(self.x), f(self.y))
    }
}

impl std::ops::Mul<f32> for CornerRadius {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        Self::new(self.x * rhs, self.y * rhs)
    }
}

/// Resolved radii for the four corners of a box, in CSS clockwise order.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CornerRadii {
    /// Top-left corner.
    pub top_left: CornerRadius,
    /// Top-right corner.
    pub top_right: CornerRadius,
    /// Bottom-right corner.
    pub bottom_right: CornerRadius,
    /// Bottom-left corner.
    pub bottom_left: CornerRadius,
}

impl CornerRadii {
    /// Four square corners.
    pub const ZERO: Self = Self::uniform(CornerRadius::ZERO);

    /// Construct four independently resolved corners in CSS clockwise order.
    pub const fn new(
        top_left: CornerRadius,
        top_right: CornerRadius,
        bottom_right: CornerRadius,
        bottom_left: CornerRadius,
    ) -> Self {
        Self {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        }
    }

    /// Use one resolved radius for every corner.
    pub const fn uniform(radius: CornerRadius) -> Self {
        Self::new(radius, radius, radius, radius)
    }

    /// Use one circular radius for every corner.
    pub const fn circular(radius: f32) -> Self {
        Self::uniform(CornerRadius::circular(radius))
    }

    /// Visit the corners in CSS clockwise order.
    pub fn iter(self) -> std::array::IntoIter<CornerRadius, 4> {
        [
            self.top_left,
            self.top_right,
            self.bottom_right,
            self.bottom_left,
        ]
        .into_iter()
    }

    /// Transform each corner without unpacking the structure at call sites.
    pub fn map(self, mut f: impl FnMut(CornerRadius) -> CornerRadius) -> Self {
        Self::new(
            f(self.top_left),
            f(self.top_right),
            f(self.bottom_right),
            f(self.bottom_left),
        )
    }

    /// Whether all four corners are square.
    pub fn is_zero(self) -> bool {
        self.iter().all(CornerRadius::is_zero)
    }

    /// Whether every corner is circular (though their sizes may differ).
    pub fn is_circular(self) -> bool {
        self.iter().all(CornerRadius::is_circular)
    }

    /// Return the common circular radius, if every corner has exactly one.
    pub fn uniform_radius(self) -> Option<f32> {
        let radius = self.top_left.x;
        (self == Self::circular(radius)).then_some(radius)
    }

    /// Largest horizontal radius.
    pub fn max_x(self) -> f32 {
        self.iter().map(|radius| radius.x).fold(0.0, f32::max)
    }

    /// Largest vertical radius.
    pub fn max_y(self) -> f32 {
        self.iter().map(|radius| radius.y).fold(0.0, f32::max)
    }

    /// Resolve the radii of an inset box.
    pub fn inset(self, edges: EdgeSizes) -> Self {
        Self::new(
            CornerRadius::new(
                (self.top_left.x - edges.left).max(0.0),
                (self.top_left.y - edges.top).max(0.0),
            ),
            CornerRadius::new(
                (self.top_right.x - edges.right).max(0.0),
                (self.top_right.y - edges.top).max(0.0),
            ),
            CornerRadius::new(
                (self.bottom_right.x - edges.right).max(0.0),
                (self.bottom_right.y - edges.bottom).max(0.0),
            ),
            CornerRadius::new(
                (self.bottom_left.x - edges.left).max(0.0),
                (self.bottom_left.y - edges.bottom).max(0.0),
            ),
        )
    }

    /// Grow (or shrink) both axes by the same spread, clamping at zero.
    ///
    /// A square corner remains square when its box is outset: adding a spread to
    /// a zero radius would incorrectly turn a rectangular outline or box shadow
    /// into a rounded one.
    pub fn grow(self, spread: f32) -> Self {
        self.map(|radius| {
            if radius.is_zero() {
                CornerRadius::ZERO
            } else {
                radius.map_axes(|axis| (axis + spread).max(0.0))
            }
        })
    }

    /// Resolve an outset `box-shadow` radius for positive spread.
    ///
    /// CSS Backgrounds 3 §6.1.1 adjusts each radius axis independently. The
    /// result depends only on that axis and the spread; the containing box
    /// dimensions do not participate in the shadow-radius formula.
    pub fn outset_shadow(self, spread: f32) -> Self {
        if spread <= 0.0 || !spread.is_finite() {
            return self.grow(spread);
        }

        self.map(|radius| radius.map_axes(|axis| outset_shadow_axis(axis, spread)))
    }

    /// Apply the CSS radius-overlap scale for a box of this size.
    pub fn fit_to(self, width: f32, height: f32) -> Self {
        let radii = self.map(|radius| {
            if radius.is_zero() {
                CornerRadius::ZERO
            } else {
                radius
            }
        });
        let mut scale = 1.0f32;
        for (available, sum) in [
            (width, radii.top_left.x + radii.top_right.x),
            (width, radii.bottom_left.x + radii.bottom_right.x),
            (height, radii.top_left.y + radii.bottom_left.y),
            (height, radii.top_right.y + radii.bottom_right.y),
        ] {
            if sum > 0.0 {
                scale = scale.min((available.max(0.0) / sum).min(1.0));
            }
        }
        radii.map(|radius| radius.map_axes(|axis| axis.max(0.0) * scale))
    }

    /// Remove rounding from the two top corners of a continuation fragment.
    pub fn clear_top(mut self) -> Self {
        self.top_left = CornerRadius::ZERO;
        self.top_right = CornerRadius::ZERO;
        self
    }

    /// Remove rounding from the two bottom corners of a continuation fragment.
    pub fn clear_bottom(mut self) -> Self {
        self.bottom_right = CornerRadius::ZERO;
        self.bottom_left = CornerRadius::ZERO;
        self
    }

    /// Remove rounding from the two left corners of an inline continuation.
    pub fn clear_left(mut self) -> Self {
        self.top_left = CornerRadius::ZERO;
        self.bottom_left = CornerRadius::ZERO;
        self
    }

    /// Remove rounding from the two right corners of an inline continuation.
    pub fn clear_right(mut self) -> Self {
        self.top_right = CornerRadius::ZERO;
        self.bottom_right = CornerRadius::ZERO;
        self
    }
}

fn outset_shadow_axis(radius: f32, spread: f32) -> f32 {
    if radius <= 0.0 {
        return 0.0;
    }
    if radius >= spread {
        return radius + spread;
    }

    let ratio = radius / spread;
    radius + spread * (1.0 + (ratio - 1.0).powi(3))
}

impl std::ops::Mul<f32> for CornerRadii {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        self.map(|radius| radius * rhs)
    }
}

#[cfg(test)]
mod box_geometry_tests {
    use super::{CornerRadii, CornerRadius, EdgeSizes};

    #[test]
    fn edge_sizes_arithmetic_is_component_wise() {
        let edges = EdgeSizes::new(1.0, 2.0, 3.0, 4.0);
        assert_eq!(
            edges + EdgeSizes::uniform(2.0),
            EdgeSizes::new(3.0, 4.0, 5.0, 6.0)
        );
        assert_eq!(edges * 0.5, EdgeSizes::new(0.5, 1.0, 1.5, 2.0));
        assert_eq!(
            edges - EdgeSizes::uniform(1.0),
            EdgeSizes::new(0.0, 1.0, 2.0, 3.0)
        );
    }

    #[test]
    fn corner_radii_inset_uses_each_adjacent_edge() {
        let radii = CornerRadii::uniform(CornerRadius::new(10.0, 12.0));
        assert_eq!(
            radii.inset(EdgeSizes::new(1.0, 2.0, 3.0, 4.0)),
            CornerRadii::new(
                CornerRadius::new(6.0, 11.0),
                CornerRadius::new(8.0, 11.0),
                CornerRadius::new(8.0, 9.0),
                CornerRadius::new(6.0, 9.0),
            )
        );
    }

    #[test]
    fn corner_radii_grow_keeps_square_corners_square() {
        let radii = CornerRadii::new(
            CornerRadius::ZERO,
            CornerRadius::circular(4.0),
            CornerRadius::new(3.0, 0.0),
            CornerRadius::circular(2.0),
        );

        assert_eq!(
            radii.grow(3.0),
            CornerRadii::new(
                CornerRadius::ZERO,
                CornerRadius::circular(7.0),
                CornerRadius::ZERO,
                CornerRadius::circular(5.0),
            )
        );
    }

    #[test]
    fn outset_shadow_preserves_small_corner_sharpness() {
        let radii = CornerRadii::new(
            CornerRadius::circular(31.5),
            CornerRadius::circular(4.5),
            CornerRadius::circular(22.5),
            CornerRadius::circular(9.0),
        );
        let shadow = radii.outset_shadow(13.5);

        assert_eq!(shadow.top_left, CornerRadius::circular(45.0));
        assert!((shadow.top_right.x - 14.0).abs() < 1e-5);
        assert!((shadow.top_right.y - 14.0).abs() < 1e-5);
        assert_eq!(shadow.bottom_right, CornerRadius::circular(36.0));
        assert!((shadow.bottom_left.x - 22.0).abs() < 1e-5);
        assert!((shadow.bottom_left.y - 22.0).abs() < 1e-5);
    }

    #[test]
    fn outset_shadow_adjusts_elliptical_axes_independently() {
        let radii = CornerRadii::uniform(CornerRadius::new(4.5, 18.0));

        let shadow = radii.outset_shadow(13.5);
        assert!(
            shadow
                .iter()
                .all(|radius| (radius.x - 14.0).abs() < 1e-5 && radius.y == 31.5)
        );
    }

    #[test]
    fn corner_radii_fit_to_scales_all_axes_together() {
        let radii = CornerRadii::new(
            CornerRadius::new(80.0, 20.0),
            CornerRadius::new(40.0, 10.0),
            CornerRadius::new(20.0, 30.0),
            CornerRadius::new(10.0, 50.0),
        );
        let fitted = radii.fit_to(60.0, 40.0);
        assert_eq!(fitted.top_left, CornerRadius::new(40.0, 10.0));
        assert_eq!(fitted.bottom_left, CornerRadius::new(5.0, 25.0));
        assert_eq!(
            CornerRadii::uniform(CornerRadius::new(8.0, 0.0)).fit_to(20.0, 20.0),
            CornerRadii::ZERO
        );
    }

    #[test]
    fn corner_radii_fragment_helpers_only_clear_open_edge() {
        let radii = CornerRadii::circular(7.0);
        assert_eq!(radii.clear_top().bottom_left.x, 7.0);
        assert_eq!(radii.clear_bottom().top_right.y, 7.0);
        assert!(radii.clear_top().clear_bottom().is_zero());
        assert_eq!(radii.clear_left().top_right.x, 7.0);
        assert_eq!(radii.clear_right().bottom_left.y, 7.0);
        assert!(radii.clear_left().clear_right().is_zero());
    }
}

/// High-precision sRGB color.
///
/// Channels use the CSS 0..=255 number scale but remain floating-point until a
/// backend explicitly needs an 8-bit pixel.  Keeping the familiar CSS scale
/// makes byte-authored colors exact while preserving percentage and modern
/// color-function values such as `10%` (25.5 rather than an early 26).
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub struct Color {
    /// Red channel on the CSS 0..=255 number scale.
    pub r: f32,
    /// Green channel on the CSS 0..=255 number scale.
    pub g: f32,
    /// Blue channel on the CSS 0..=255 number scale.
    pub b: f32,
    /// Alpha channel on the CSS 0..=255 number scale.
    pub a: f32,
}

#[allow(dead_code)]
impl Color {
    /// Opaque black.
    pub const BLACK: Self = Self {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 255.0,
    };
    /// Opaque white.
    pub const WHITE: Self = Self {
        r: 255.0,
        g: 255.0,
        b: 255.0,
        a: 255.0,
    };

    /// Construct an opaque color from 8-bit sRGB channels.
    pub fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self::rgba8(r, g, b, 255)
    }

    /// Construct a color from 8-bit sRGB and alpha channels.
    pub fn rgba8(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self {
            r: f32::from(r),
            g: f32::from(g),
            b: f32::from(b),
            a: f32::from(a),
        }
    }

    /// Construct from CSS-number-scale channels (0..=255).
    pub fn from_css_rgb(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self {
            r: r.clamp(0.0, 255.0),
            g: g.clamp(0.0, 255.0),
            b: b.clamp(0.0, 255.0),
            a: a.clamp(0.0, 255.0),
        }
    }

    /// Construct from normalized sRGB channels (0..=1).
    pub fn from_srgb(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self::from_css_rgb(r * 255.0, g * 255.0, b * 255.0, a * 255.0)
    }

    /// Convert to normalized sRGB channels.
    pub fn to_f32_rgb(self) -> (f32, f32, f32) {
        (self.r / 255.0, self.g / 255.0, self.b / 255.0)
    }

    /// Convert to normalized sRGB and alpha channels.
    pub fn to_f32_rgba(self) -> (f32, f32, f32, f32) {
        (
            self.r / 255.0,
            self.g / 255.0,
            self.b / 255.0,
            self.a / 255.0,
        )
    }

    /// Alpha normalized to the PDF/raster 0..=1 scale.
    pub fn alpha(self) -> f32 {
        self.a / 255.0
    }

    /// Whether the color fully covers its backdrop.
    pub fn is_opaque(self) -> bool {
        self.a >= 255.0
    }

    /// Quantize only at an explicitly 8-bit raster boundary.
    pub fn to_rgba8(self) -> [u8; 4] {
        let byte = |channel: f32| channel.round().clamp(0.0, 255.0) as u8;
        [byte(self.r), byte(self.g), byte(self.b), byte(self.a)]
    }
}

impl Default for Color {
    fn default() -> Self {
        Self::BLACK
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_default_is_black() {
        let c = Color::default();
        assert_eq!(c.r, 0.0);
        assert_eq!(c.g, 0.0);
        assert_eq!(c.b, 0.0);
        assert_eq!(c.a, 255.0);
    }

    #[test]
    fn color_to_f32_rgb() {
        let c = Color::rgb(255, 128, 0);
        let (r, g, b) = c.to_f32_rgb();
        assert!((r - 1.0).abs() < 0.01);
        assert!((g - 0.502).abs() < 0.01);
        assert!((b - 0.0).abs() < 0.01);
    }

    #[test]
    fn page_size_default_is_a4() {
        let ps = PageSize::default();
        assert!((ps.width - 595.28).abs() < 0.01);
    }

    #[test]
    fn margin_uniform() {
        let m = Margin::uniform(36.0);
        assert_eq!(m.top, 36.0);
        assert_eq!(m.right, 36.0);
        assert_eq!(m.bottom, 36.0);
        assert_eq!(m.left, 36.0);
        assert_eq!(m.horizontal(), 72.0);
        assert_eq!(m.vertical(), 72.0);
    }

    #[test]
    fn edge_sizes_keep_box_model_values_together() {
        let edges = EdgeSizes::new(1.0, 2.0, 3.0, 4.0);
        assert_eq!(edges.horizontal(), 6.0);
        assert_eq!(edges.vertical(), 4.0);
        assert_eq!(edges.horizontal_only(), EdgeSizes::new(0.0, 2.0, 0.0, 4.0));
        assert_eq!(EdgeSizes::uniform(5.0), EdgeSizes::new(5.0, 5.0, 5.0, 5.0));
        assert_eq!(
            EdgeSizes::axes(6.0, 7.0),
            EdgeSizes::new(7.0, 6.0, 7.0, 6.0)
        );
        assert_eq!(EdgeSizes::ZERO, EdgeSizes::default());
        assert!(EdgeSizes::ZERO.is_zero());
        assert!(!edges.is_zero());
    }
}
