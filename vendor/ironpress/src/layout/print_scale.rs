//! Browser print-to-page scaling for normal-flow layout overflow.
//!
//! Chromium reduces an overflowing document's normal-flow width to the page's
//! printable width before emitting its PDF content stream. This is distinct
//! from CSS overflow: positioned visual overflow remains clipped by the page
//! and must not change the scale of unrelated flow content.

use super::engine::{LayoutElement, Page};
use crate::types::{Margin, PageSize, Point, Size};

/// A uniform scale applied to page content around the physical page's top-left
/// corner by the PDF renderer. It owns the print-fit decision so render paths
/// never infer a scale from individual paint operations.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PrintContentScale(f32);

impl PrintContentScale {
    /// Keep normal-flow content within the physical page width without enlarging
    /// content that already fits. Invalid or empty geometry leaves it alone.
    pub(crate) fn from_flow_width(printable_width: f32, flow_right_edge: f32) -> Self {
        if !printable_width.is_finite()
            || !flow_right_edge.is_finite()
            || printable_width <= 0.0
            || flow_right_edge <= printable_width
        {
            return Self::default();
        }
        Self(printable_width / flow_right_edge)
    }

    pub(crate) const fn factor(self) -> f32 {
        self.0
    }

    pub(crate) const fn is_identity(self) -> bool {
        self.0 == 1.0
    }

    /// Layout-space size whose fitted physical result has `physical` extent.
    pub(crate) fn layout_size_for_physical(self, physical: Size) -> Size {
        Size::new(
            physical.width / self.factor(),
            physical.height / self.factor(),
        )
    }

    /// Layout-space offset whose fitted physical result has `physical` offset.
    pub(crate) fn layout_point_for_physical(self, physical: Point) -> Point {
        Point::new(physical.x / self.factor(), physical.y / self.factor())
    }
}

impl Default for PrintContentScale {
    fn default() -> Self {
        Self(1.0)
    }
}

/// Compute Chromium's document-wide print-fit scale after pagination.
///
/// Each physical page contributes its selected page-area width and normal-flow
/// scrollable overflow. The narrowest resulting factor applies to every page,
/// while rendering anchors it at each page area's own origin.
pub(crate) fn assign_page_print_scales(
    pages: &mut [Page],
    default_page_size: PageSize,
    default_margin: Margin,
) {
    let document_scale = pages
        .iter()
        .map(|page| {
            let geometry = page
                .geometry
                .unwrap_or(super::page_context::PageGeometry::new(
                    default_page_size,
                    default_margin,
                ));
            let flow_right_edge = page
                .elements
                .iter()
                .filter_map(|(_, element)| element.print_fit_right_edge())
                .fold(0.0_f32, f32::max);
            PrintContentScale::from_flow_width(
                geometry.page_area_size().width,
                geometry.flow_right_in_page_area(flow_right_edge),
            )
        })
        .map(PrintContentScale::factor)
        .fold(1.0_f32, f32::min);
    for page in pages {
        page.print_content_scale = PrintContentScale(document_scale);
        for (_, element) in &mut page.elements {
            if let Some(background) = element.page_area_background_mut() {
                background.apply_print_content_scale(page.print_content_scale);
            }
        }
    }
}

#[cfg(test)]
mod tests;
