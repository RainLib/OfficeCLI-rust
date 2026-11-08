//! Paint-space state carried by the generic layout-node traversal.

use crate::layout::elements::LayoutElement;
use crate::layout::filter::paint_space::{
    FilterBoxPaintSpace, InheritedFilterPaintSpace, PageBoxAnchor,
};

/// Page placement and inherited graphical state supplied to one layout node.
#[derive(Clone, Copy)]
pub(super) struct TraversalFrame {
    pub(super) anchor: PageBoxAnchor,
    pub(super) inherited_space: InheritedFilterPaintSpace,
}

impl TraversalFrame {
    pub(super) fn enter(self, element: &dyn LayoutElement) -> ElementTraversalSpace {
        let box_space = crate::layout::filter::surface::source_geometry(element).map(|geometry| {
            self.inherited_space.enter(
                self.anchor,
                geometry.size,
                element.paint_group_owner().map(|owner| owner.paint_group()),
                element.box_reference_geometry(),
            )
        });
        ElementTraversalSpace {
            frame: self,
            box_space,
            descendant_space: box_space
                .map(FilterBoxPaintSpace::descendants)
                .unwrap_or(self.inherited_space),
        }
    }
}

/// Transform state resolved once for the node currently being traversed.
#[derive(Clone, Copy)]
pub(super) struct ElementTraversalSpace {
    pub(super) frame: TraversalFrame,
    pub(super) box_space: Option<FilterBoxPaintSpace>,
    pub(super) descendant_space: InheritedFilterPaintSpace,
}
