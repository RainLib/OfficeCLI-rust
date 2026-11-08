use super::*;

mod scrollbars;
mod square;
mod stroke;

pub(super) use scrollbars::*;
pub(super) use square::*;
pub(super) use stroke::*;

/// The CSS border ring and its four non-overlapping side transition regions.
///
/// Each side owns the area between one outer border-box edge and the
/// corresponding inner padding-box edge. Adjacent regions meet on the line
/// from the outer corner to the inner corner. Intersecting those regions with
/// the rounded ring gives sharp and rounded borders the same diagonal corner
/// ownership without painting one side over another.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct BorderRingGeometry {
    outer: RoundedRect,
    inner: RoundedRect,
    partition: BorderRing,
    border_box: PdfRect,
}

impl BorderRingGeometry {
    pub(super) fn new(border_box: PdfRect, radii: CornerRadii, widths: EdgeSizes) -> Self {
        Self::between(border_box, radii, EdgeSizes::ZERO, widths)
    }

    pub(super) fn between(
        border_box: PdfRect,
        radii: CornerRadii,
        outer_inset: EdgeSizes,
        inner_inset: EdgeSizes,
    ) -> Self {
        // CSS normalizes the outer radii once, then derives every inset curve
        // from that used outer shape. Fitting outer and inner paths
        // independently changes their shared centers and can distort thick
        // elliptical borders.
        let border_shape = border_box.rounded(radii.fit_to(border_box.width, border_box.height));
        Self {
            outer: border_shape.inset(outer_inset),
            inner: border_shape.inset(inner_inset),
            partition: BorderRing::between(
                Rect::from_xywh(0.0, 0.0, border_box.width, border_box.height),
                radii,
                outer_inset,
                inner_inset,
            ),
            border_box,
        }
    }

    pub(super) fn push_path(self, content: &mut String) {
        content.push_str(&self.outer.path_or_rect());
        content.push_str(&self.inner.path_or_rect());
    }

    pub(super) fn push_clip(self, content: &mut String) {
        self.push_path(content);
        content.push_str("W* n\n");
    }

    pub(super) fn needs_curved_clip(self) -> bool {
        !self.outer.radii.is_zero()
    }

    pub(super) fn side_region(self, edge: PhysicalSide) -> BorderSideRegion {
        BorderSideRegion {
            points: self.partition.side_region(edge).points.map(|point| {
                PdfPoint::new(
                    self.border_box.left + point.x,
                    self.border_box.top() - point.y,
                )
            }),
        }
    }
}

/// One side's exclusive clip within a [`BorderRingGeometry`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct BorderSideRegion {
    points: [PdfPoint; 4],
}

impl BorderSideRegion {
    pub(super) fn push_path(self, content: &mut String) {
        self.push_path_in(content, PdfContentSpace::Points);
    }

    pub(super) fn push_path_in(self, content: &mut String, space: PdfContentSpace) {
        let [start, second, third, fourth] = self.points.map(|point| space.point(point));
        content.push_str(&format!("{} {} m\n", start.x, start.y));
        for point in [second, third, fourth] {
            content.push_str(&format!("{} {} l\n", point.x, point.y));
        }
        content.push_str("h\n");
    }

    pub(super) fn push_clip(self, content: &mut String) {
        self.push_path(content);
        content.push_str("W n\n");
    }
}

/// Emit a PDF clip path for CSS `overflow: hidden`/`clip`/`scroll`/`auto`.
///
/// CSS clips overflow at the PADDING box: the border box `(x, y, w, h)`
/// (bottom-left origin, PDF coordinates) inset by the per-side border widths
/// `(bl, br, bt, bb)`. When `radius > 0` the clip follows the rounded corners,
/// using the INNER radius (`radius - border`) at the padding box, matching the
/// way borders paint inside the box. Returns the path operators WITHOUT the
/// terminating `W n`, so callers append `"W n\n"` (or `"\nW n\n"`).
#[allow(clippy::too_many_arguments)]
pub(super) fn overflow_clip_path(
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    border: EdgeSizes,
    radii: CornerRadii,
) -> String {
    let border_box = PdfRect::new(x, y, w, h);
    let padding_box = RoundedRect::new(border_box, radii.fit_to(w, h)).inset(border);
    if let Some(path) = padding_box.path() {
        return path;
    }
    // Trailing space (no newline) so the caller's `W n\n` yields `... re W n\n`
    // on a single line (matching the established clip-path output convention).
    format!(
        "{} {} {} {} re ",
        padding_box.rect.left,
        padding_box.rect.bottom,
        padding_box.rect.width,
        padding_box.rect.height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CornerRadius;

    #[test]
    fn side_regions_share_diagonal_corner_frontiers() {
        let ring = BorderRingGeometry::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::ZERO,
            EdgeSizes::new(10.0, 20.0, 15.0, 5.0),
        );

        let top = ring.side_region(PhysicalSide::Top);
        let right = ring.side_region(PhysicalSide::Right);
        let bottom = ring.side_region(PhysicalSide::Bottom);
        let left = ring.side_region(PhysicalSide::Left);

        assert_eq!(
            top.points,
            [
                PdfPoint::new(0.0, 50.0),
                PdfPoint::new(100.0, 50.0),
                PdfPoint::new(80.0, 40.0),
                PdfPoint::new(5.0, 40.0),
            ]
        );
        assert_eq!(top.points[1], right.points[0]);
        assert_eq!(top.points[2], right.points[3]);
        assert_eq!(right.points[1], bottom.points[0]);
        assert_eq!(right.points[2], bottom.points[3]);
        assert_eq!(bottom.points[1], left.points[0]);
        assert_eq!(bottom.points[2], left.points[3]);
        assert_eq!(left.points[1], top.points[0]);
        assert_eq!(left.points[2], top.points[3]);
    }

    #[test]
    fn inset_ring_uses_css_inner_corner_radii() {
        let radii = CornerRadii::new(
            CornerRadius::new(20.0, 16.0),
            CornerRadius::new(18.0, 14.0),
            CornerRadius::new(12.0, 10.0),
            CornerRadius::new(8.0, 6.0),
        );
        let widths = EdgeSizes::new(3.0, 5.0, 7.0, 11.0);

        let ring = BorderRingGeometry::new(PdfRect::new(2.0, 4.0, 100.0, 60.0), radii, widths);

        assert_eq!(ring.outer.radii, radii);
        assert_eq!(ring.inner.rect, PdfRect::new(13.0, 11.0, 84.0, 50.0));
        assert_eq!(ring.inner.radii, radii.inset(widths));
    }

    #[test]
    fn ring_bands_share_the_same_intermediate_curve() {
        let border_box = PdfRect::new(0.0, 0.0, 100.0, 50.0);
        let radii = CornerRadii::circular(18.0);
        let widths = EdgeSizes::new(4.0, 8.0, 12.0, 16.0);
        let middle = widths * 0.5;

        let outer_half = BorderRingGeometry::between(border_box, radii, EdgeSizes::ZERO, middle);
        let inner_half = BorderRingGeometry::between(border_box, radii, middle, widths);

        assert_eq!(outer_half.inner, inner_half.outer);
    }

    #[test]
    fn rounded_side_frontiers_follow_width_ratio_to_inner_radius_chords() {
        let ring = BorderRingGeometry::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::circular(20.0),
            EdgeSizes::uniform(6.0),
        );

        let top = ring.side_region(PhysicalSide::Top);
        let right = ring.side_region(PhysicalSide::Right);
        let bottom = ring.side_region(PhysicalSide::Bottom);
        let left = ring.side_region(PhysicalSide::Left);

        assert_eq!(top.points[3], PdfPoint::new(13.0, 37.0));
        assert_eq!(top.points[2], PdfPoint::new(87.0, 37.0));
        assert_eq!(right.points[2], PdfPoint::new(87.0, 13.0));
        assert_eq!(bottom.points[2], PdfPoint::new(13.0, 13.0));
        assert_eq!(left.points[2], top.points[3]);
    }

    #[test]
    fn rounded_stroke_spans_partition_one_closed_centerline() {
        let stroke = BorderStrokeGeometry::new(
            PdfRect::new(0.0, 0.0, 100.0, 100.0),
            CornerRadii::circular(20.0),
            EdgeSizes::uniform(10.0),
        );
        let spans = stroke.spans;
        let total = spans.top.length + spans.right.length + spans.bottom.length + spans.left.length;
        let expected = stroke.path_length();

        assert!((total - expected).abs() < 0.001);
        assert!((expected - (240.0 + 30.0 * std::f32::consts::PI)).abs() < 0.001);
        for length in [
            spans.top.length,
            spans.right.length,
            spans.bottom.length,
            spans.left.length,
        ] {
            assert!((length - expected / 4.0).abs() < 0.001);
        }
    }

    #[test]
    fn collapsed_inner_curve_frontier_uses_inner_corner() {
        let ring = BorderRingGeometry::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::circular(5.0),
            EdgeSizes::uniform(8.0),
        );

        assert_eq!(
            ring.side_region(PhysicalSide::Bottom).points[2],
            PdfPoint::new(8.0, 8.0)
        );
    }
}
