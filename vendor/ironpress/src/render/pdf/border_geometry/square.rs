use super::*;

/// One square border band between two edge insets.
///
/// Horizontal bands span the complete outer width. The vertical trapezoids
/// repaint only their corner triangles and therefore own the final diagonal
/// frontier. This is the browser PDF decomposition for opaque square 3D
/// borders; translucent paint must use exclusive side regions instead.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(in crate::render::pdf) struct SquareBorderBandGeometry {
    outer: PdfRect,
    inner: PdfRect,
}

impl SquareBorderBandGeometry {
    pub(in crate::render::pdf) fn between(
        border_box: PdfRect,
        outer_inset: EdgeSizes,
        inner_inset: EdgeSizes,
    ) -> Self {
        Self {
            outer: border_box.inset(outer_inset),
            inner: border_box.inset(inner_inset),
        }
    }

    pub(in crate::render::pdf) fn top(self) -> PdfRect {
        PdfRect::new(
            self.outer.left,
            self.inner.top(),
            self.outer.width,
            self.outer.top() - self.inner.top(),
        )
    }

    pub(in crate::render::pdf) fn bottom(self) -> PdfRect {
        PdfRect::new(
            self.outer.left,
            self.outer.bottom,
            self.outer.width,
            self.inner.bottom - self.outer.bottom,
        )
    }

    pub(in crate::render::pdf) fn right(self) -> BorderSideRegion {
        BorderSideRegion {
            points: [
                PdfPoint::new(self.outer.right(), self.outer.top()),
                PdfPoint::new(self.outer.right(), self.outer.bottom),
                PdfPoint::new(self.inner.right(), self.inner.bottom),
                PdfPoint::new(self.inner.right(), self.inner.top()),
            ],
        }
    }

    pub(in crate::render::pdf) fn left(self) -> BorderSideRegion {
        BorderSideRegion {
            points: [
                PdfPoint::new(self.outer.left, self.outer.bottom),
                PdfPoint::new(self.outer.left, self.outer.top()),
                PdfPoint::new(self.inner.left, self.inner.top()),
                PdfPoint::new(self.inner.left, self.inner.bottom),
            ],
        }
    }

    /// Four full-span rectangles whose union is this square border band.
    ///
    /// A single compound fill paints overlapping corner areas only once.
    /// This is required for an open fragmented border: independently filled
    /// bands expose antialiasing at their mathematically coincident endpoints,
    /// while shortening the vertical sides leaves those endpoints uncovered.
    pub(in crate::render::pdf) fn full_span_sides(self) -> PhysicalEdges<PdfRect> {
        PhysicalEdges::new(
            self.top(),
            PdfRect::new(
                self.inner.right(),
                self.outer.bottom,
                self.outer.right() - self.inner.right(),
                self.outer.height,
            ),
            self.bottom(),
            PdfRect::new(
                self.outer.left,
                self.outer.bottom,
                self.inner.left - self.outer.left,
                self.outer.height,
            ),
        )
    }
}
