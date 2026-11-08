//! Page-box separation for post-layout graphical effects.
//!
//! CSS Fragmentation applies transforms and other graphical effects to each
//! box fragment, then separates page boxes last. A fragment's paint can
//! therefore contribute to another page without becoming layout content on
//! that page. This module represents that contribution as a transparent layout
//! node so it continues through the ordinary renderer and stacking machinery.

use crate::layout::elements::{
    LayoutElement, LayoutNode, LayoutVisitor, LayoutVisitorMut, PageContentRole,
};
use crate::layout::engine::Page;
use crate::layout::print_scale::PrintContentScale;
use crate::types::{Margin, PageSize};

/// Paint-only view of a fragment whose graphical output can reach another
/// page. Visitor dispatch deliberately stays transparent: the renderer sees
/// the original concrete element, while page scheduling sees the continuation
/// role.
#[derive(Debug, Clone)]
struct GraphicalOverflowContinuation {
    source: LayoutNode,
}

impl GraphicalOverflowContinuation {
    fn from_source(mut source: LayoutNode) -> Option<Self> {
        if !source.has_page_spanning_graphical_effect() {
            return None;
        }
        source
            .retain_page_spanning_paint()
            .then_some(Self { source })
    }
}

impl LayoutElement for GraphicalOverflowContinuation {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        self.source.accept(visitor);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        self.source.accept_mut(visitor);
    }

    fn visit_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        self.source.visit_children(visitor);
    }

    fn visit_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        self.source.visit_children_mut(visitor);
    }

    fn visit_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        self.source.visit_child_nodes_mut(visitor);
    }

    fn has_page_spanning_graphical_effect(&self) -> bool {
        self.source.has_page_spanning_graphical_effect()
    }

    fn is_page_paint_continuation(&self) -> bool {
        true
    }

    fn page_content_role(&self) -> PageContentRole {
        PageContentRole::OverflowContinuation
    }
}

#[derive(Debug, Clone, Copy)]
struct FragmentainerStackGeometry {
    /// Physical block offset before page boxes are separated.
    block_start: f32,
    /// Layout-to-physical print fitting applied inside this page area.
    content_scale: PrintContentScale,
}

impl FragmentainerStackGeometry {
    fn content_y_on(self, target: Self, source_content_y: f32) -> f32 {
        let source_physical_y = self.block_start + source_content_y * self.content_scale.factor();
        (source_physical_y - target.block_start) / target.content_scale.factor()
    }
}

/// Copy each fragment with potentially page-spanning paint onto every other
/// existing page, translated into that page's fragmentainer coordinate system.
///
/// CSS Fragmentation applies graphical effects before physically separating
/// page boxes. The continuous stack therefore concatenates page-area block
/// extents at their fragmentation edges; paper margins are not gaps in that
/// flow. Pages clip the copied operators to their page area, so only the slice
/// that actually crosses a boundary remains visible. Contributions from
/// earlier pages precede local content in document order; contributions from
/// later pages follow it. No comparison or source raster is involved.
pub(crate) fn transfer_page_spanning_graphical_effects(
    pages: &mut [Page],
    default_page_size: PageSize,
    default_margin: Margin,
) {
    if pages.len() < 2 {
        return;
    }

    let mut block_start = 0.0;
    let geometries = pages
        .iter()
        .map(|page| {
            let page_geometry =
                page.geometry
                    .unwrap_or(crate::layout::page_context::PageGeometry::new(
                        default_page_size,
                        default_margin,
                    ));
            let geometry = FragmentainerStackGeometry {
                block_start,
                content_scale: page.print_content_scale,
            };
            block_start += page_geometry.content_height().max(0.0);
            geometry
        })
        .collect::<Vec<_>>();

    let sources = pages
        .iter()
        .map(|page| {
            page.elements
                .iter()
                .filter_map(|(y, element)| {
                    if element.page_content_role() == PageContentRole::RepeatedDecoration {
                        return None;
                    }
                    GraphicalOverflowContinuation::from_source(element.clone())
                        .map(|continuation| (*y, continuation))
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    for target_index in 0..pages.len() {
        let target_geometry = geometries[target_index];
        let mut before = Vec::new();
        let mut after = Vec::new();

        for (source_index, source_elements) in sources.iter().enumerate() {
            if source_index == target_index {
                continue;
            }
            let destination = if source_index < target_index {
                &mut before
            } else {
                &mut after
            };
            let source_geometry = geometries[source_index];
            destination.extend(source_elements.iter().map(|(y, continuation)| {
                (
                    source_geometry.content_y_on(target_geometry, *y),
                    Box::new(continuation.clone()) as LayoutNode,
                )
            }));
        }

        if before.is_empty() && after.is_empty() {
            continue;
        }
        let local = std::mem::take(&mut pages[target_index].elements);
        before.extend(local);
        before.extend(after);
        pages[target_index].elements = before;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::{BoxTransform, Container, IntoLayoutNode, TextBlock};
    use crate::style::computed::Transform;

    fn transformed_text() -> LayoutNode {
        let mut text = TextBlock::default();
        text.paint.group.transform = BoxTransform {
            value: Some(Transform::Rotate(5.0)),
            ..Default::default()
        };
        text.boxed()
    }

    #[test]
    fn recursive_effect_capability_finds_transformed_descendants() {
        let container = Container {
            children: vec![transformed_text()],
            ..Default::default()
        };

        assert!(container.has_page_spanning_graphical_effect());
    }

    #[test]
    fn projection_suppresses_unaffected_ancestor_paint() {
        let mut container = Container {
            children: vec![transformed_text()],
            ..Default::default()
        };

        assert!(container.retain_page_spanning_paint());
        assert!(!container.paint.visible);
        assert!(
            container.children[0]
                .box_paint_owner()
                .is_some_and(|owner| owner.box_paint().visible)
        );
    }

    #[test]
    fn transfers_effect_paint_in_document_order_and_page_coordinates() {
        let mut pages = vec![
            Page {
                elements: vec![(80.0, transformed_text())],
                geometry: Some(crate::layout::page_context::PageGeometry::new(
                    PageSize::new(100.0, 100.0),
                    Margin::uniform(10.0),
                )),
                ..Default::default()
            },
            Page {
                elements: vec![(4.0, TextBlock::default().boxed())],
                geometry: Some(crate::layout::page_context::PageGeometry::new(
                    PageSize::new(100.0, 120.0),
                    Margin::uniform(20.0),
                )),
                ..Default::default()
            },
        ];

        transfer_page_spanning_graphical_effects(&mut pages, PageSize::A4, Margin::default());

        assert_eq!(pages[1].elements.len(), 2);
        assert_eq!(pages[1].elements[0].0, 0.0);
        assert_eq!(
            pages[1].elements[0].1.page_content_role(),
            PageContentRole::OverflowContinuation
        );
        assert_eq!(pages[1].elements[1].0, 4.0);
    }

    #[test]
    fn asymmetric_page_margins_do_not_separate_fragmentainer_edges() {
        let first = FragmentainerStackGeometry {
            block_start: 0.0,
            content_scale: PrintContentScale::default(),
        };
        let second = FragmentainerStackGeometry {
            block_start: 80.0,
            content_scale: PrintContentScale::default(),
        };

        assert_eq!(second.content_y_on(first, 0.0), 80.0);
        assert_eq!(first.content_y_on(second, 80.0), 0.0);
    }

    #[test]
    fn print_fitting_keeps_the_physical_fragmentainer_boundary_fixed() {
        let scale = PrintContentScale::from_flow_width(80.0, 100.0);
        let first = FragmentainerStackGeometry {
            block_start: 0.0,
            content_scale: scale,
        };
        let second = FragmentainerStackGeometry {
            block_start: 80.0,
            content_scale: scale,
        };

        assert_eq!(second.content_y_on(first, 0.0), 100.0);
        assert_eq!(first.content_y_on(second, 100.0), 0.0);
    }
}
