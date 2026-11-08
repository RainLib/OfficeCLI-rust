use super::{
    BlockFlow, BlockFlowOwner, BlockFlowParticipant, BoxFragmentation, BoxFragmentationOwner,
    BoxModel, BoxPaint, BoxPaintOwner, ChildContainer, Container, ContainingBlockConsumer,
    InlineFlowExtent, LayoutElement, LayoutNode, Positioning, PositioningOwner,
};
use crate::layout::engine::ContainingBlock;
use crate::layout::flow_metrics::{BlockMargins, MarginHolder};

/// A semantic formatting-context node backed by one ordinary principal box.
///
/// Multicolumn and table layout both need their own concrete identity for
/// fragmentation, while sharing the ordinary box capabilities used by flow,
/// positioning, filtering, and painting. This trait is the single delegation
/// boundary for those capabilities.
pub(crate) trait PrincipalBox {
    fn principal(&self) -> &Container;
    fn principal_mut(&mut self) -> &mut Container;
}

impl<T: PrincipalBox> MarginHolder for T {
    fn margins(&self) -> &BlockMargins {
        &self.principal().box_model.margins
    }

    fn margins_mut(&mut self) -> &mut BlockMargins {
        &mut self.principal_mut().box_model.margins
    }
}

impl<T: PrincipalBox> InlineFlowExtent for T {
    fn normal_flow_right_edge(&self) -> Option<f32> {
        self.principal().normal_flow_right_edge()
    }
}

impl<T: PrincipalBox> BlockFlowParticipant for T {
    fn collapses_outer_margins(&self) -> bool {
        self.principal().collapses_outer_margins()
    }

    fn is_in_flow_block(&self) -> bool {
        self.principal().is_in_flow_block()
    }
}

impl<T: PrincipalBox> ContainingBlockConsumer for T {
    fn resolve_containing_block(&mut self, containing_block: ContainingBlock) {
        self.principal_mut()
            .resolve_containing_block(containing_block);
    }
}

impl<T: PrincipalBox> PositioningOwner for T {
    fn positioning(&self) -> &Positioning {
        &self.principal().positioning
    }

    fn positioning_mut(&mut self) -> &mut Positioning {
        &mut self.principal_mut().positioning
    }
}

impl<T: PrincipalBox> BlockFlowOwner for T {
    fn block_flow(&self) -> &BlockFlow {
        &self.principal().flow
    }
}

impl<T: PrincipalBox> BoxPaintOwner for T {
    fn box_paint(&self) -> &BoxPaint {
        &self.principal().paint
    }

    fn box_paint_mut(&mut self) -> &mut BoxPaint {
        &mut self.principal_mut().paint
    }
}

impl<T: PrincipalBox> BoxFragmentationOwner for T {
    fn fragmentation_box_model(&self) -> &BoxModel {
        &self.principal().box_model
    }

    fn box_fragmentation(&self) -> &BoxFragmentation {
        &self.principal().fragmentation
    }

    fn box_fragmentation_mut(&mut self) -> &mut BoxFragmentation {
        &mut self.principal_mut().fragmentation
    }
}

impl<T: PrincipalBox> ChildContainer for T {
    fn visit_layout_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        self.principal().visit_layout_children(visitor);
    }

    fn visit_layout_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        self.principal_mut().visit_layout_children_mut(visitor);
    }

    fn visit_layout_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        self.principal_mut().visit_layout_child_nodes_mut(visitor);
    }
}

macro_rules! impl_principal_layout_element {
    ($node:ty, $visit:ident) => {
        impl_principal_layout_element!(@define $node, $visit,);
    };
    ($node:ty, $visit:ident, fragment_placement) => {
        impl_principal_layout_element!(@define $node, $visit,
            fn fragment_placement_owner(
                &self,
            ) -> Option<&dyn super::FragmentPlacementOwner> {
                Some(self)
            }

            fn contributes_to_normal_flow(&self) -> bool {
                false
            }
        );
    };
    (@define $node:ty, $visit:ident, $($extra:item)*) => {
        impl super::LayoutElement for $node {
            fn clone_box(&self) -> super::LayoutNode {
                Box::new(self.clone())
            }

            fn accept(&self, visitor: &mut dyn super::LayoutVisitor) {
                visitor.$visit(self);
            }

            fn accept_mut(&mut self, visitor: &mut dyn super::LayoutVisitorMut) {
                visitor.$visit(self);
            }

            fn visit_children(&self, visitor: &mut dyn FnMut(&dyn super::LayoutElement)) {
                <Self as super::ChildContainer>::visit_layout_children(self, visitor);
            }

            fn visit_children_mut(
                &mut self,
                visitor: &mut dyn FnMut(&mut dyn super::LayoutElement),
            ) {
                <Self as super::ChildContainer>::visit_layout_children_mut(self, visitor);
            }

            fn visit_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut super::LayoutNode)) {
                <Self as super::ChildContainer>::visit_layout_child_nodes_mut(self, visitor);
            }

            fn margin_holder(&self) -> Option<&dyn crate::layout::flow_metrics::MarginHolder> {
                Some(self)
            }

            fn margin_holder_mut(
                &mut self,
            ) -> Option<&mut dyn crate::layout::flow_metrics::MarginHolder> {
                Some(self)
            }

            fn inline_flow_extent(&self) -> Option<&dyn super::InlineFlowExtent> {
                Some(self)
            }

            fn block_flow_participant(&self) -> Option<&dyn super::BlockFlowParticipant> {
                Some(self)
            }

            fn block_flow_participant_mut(
                &mut self,
            ) -> Option<&mut dyn super::BlockFlowParticipant> {
                Some(self)
            }

            fn containing_block_consumer_mut(
                &mut self,
            ) -> Option<&mut dyn super::ContainingBlockConsumer> {
                Some(self)
            }

            fn positioning_owner(&self) -> Option<&dyn super::PositioningOwner> {
                Some(self)
            }

            fn positioning_owner_mut(&mut self) -> Option<&mut dyn super::PositioningOwner> {
                Some(self)
            }

            fn block_flow_owner(&self) -> Option<&dyn super::BlockFlowOwner> {
                Some(self)
            }

            fn paint_group_owner(&self) -> Option<&dyn super::PaintGroupOwner> {
                Some(self)
            }

            fn paint_group_owner_mut(&mut self) -> Option<&mut dyn super::PaintGroupOwner> {
                Some(self)
            }

            fn box_reference_geometry(
                &self,
            ) -> Option<&dyn super::BoxReferenceGeometry> {
                Some(&self.principal().box_model)
            }

            fn box_paint_owner(&self) -> Option<&dyn super::BoxPaintOwner> {
                Some(self)
            }

            fn box_paint_owner_mut(
                &mut self,
            ) -> Option<&mut dyn super::BoxPaintOwner> {
                Some(self)
            }

            fn box_fragmentation_owner(&self) -> Option<&dyn super::BoxFragmentationOwner> {
                Some(self)
            }

            fn box_fragmentation_owner_mut(
                &mut self,
            ) -> Option<&mut dyn super::BoxFragmentationOwner> {
                Some(self)
            }

            fn exact_vector_filter_source(
                &self,
            ) -> Option<&dyn crate::layout::filter::ExactVectorFilterSource> {
                Some(self.principal())
            }

            $($extra)*

            fn page_content_role(&self) -> super::PageContentRole {
                self.principal()
                    .fragmentation
                    .content_role
                    .for_position(self.principal().positioning.scheme)
            }
        }
    };
}

pub(crate) use impl_principal_layout_element;
