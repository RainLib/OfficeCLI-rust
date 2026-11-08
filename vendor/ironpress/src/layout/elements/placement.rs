use super::{
    AtomicInlineBaseline, BlockFlowOwner, BlockFlowParticipant, BlockFragmentationSource,
    BoxFragmentationOwner, BoxPaintOwner, ContainingBlockConsumer, FilterHolder,
    FragmentStartSpacing, InlineFlowExtent, LayoutElement, LayoutNode, LayoutVisitor,
    LayoutVisitorMut, PaintGroupOwner, PositioningOwner, ReplacedElement, TableBoxDecorationOwner,
    TableGridOwner,
};
use crate::types::{Point, Size, Vector};

/// Box edge from which a retained fragment's physical offset is measured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum FragmentAnchor {
    #[default]
    ContentBox,
    PaddingBox,
}

/// Physical placement of one retained fragment inside its fragmentainer.
///
/// This is implementation geometry, not authored CSS positioning. Keeping it
/// separate prevents column fragmentation from turning static boxes into
/// `position: absolute` boxes and thereby changing containing blocks, stacking,
/// break behavior, or property propagation.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct FragmentPlacement {
    anchor: FragmentAnchor,
    offset: Vector,
    pub(crate) size: Size,
}

impl FragmentPlacement {
    pub(crate) const fn in_content_box(offset: Vector, size: Size) -> Self {
        Self {
            anchor: FragmentAnchor::ContentBox,
            offset,
            size,
        }
    }

    pub(crate) const fn in_padding_box(offset: Vector, size: Size) -> Self {
        Self {
            anchor: FragmentAnchor::PaddingBox,
            offset,
            size,
        }
    }

    pub(crate) const fn offset(self) -> Vector {
        self.offset
    }

    pub(crate) const fn block_offset(self) -> f32 {
        self.offset.y
    }

    /// Resolve the top-down CSS origin from the owning box's coordinate spaces.
    pub(crate) fn resolve(self, content_origin: Point, padding_origin: Point) -> Point {
        let anchor = match self.anchor {
            FragmentAnchor::ContentBox => content_origin,
            FragmentAnchor::PaddingBox => padding_origin,
        };
        anchor + self.offset
    }

    pub(crate) const fn uses_padding_box(self) -> bool {
        matches!(self.anchor, FragmentAnchor::PaddingBox)
    }
}

/// A layout node retained at a fragmentainer-local physical placement.
pub(crate) trait FragmentPlacementOwner {
    fn fragment_placement(&self) -> FragmentPlacement;
    fn fragment_source(&self) -> &dyn LayoutElement;
}

/// Transparent ownership wrapper for one physically placed box fragment.
///
/// The wrapped box retains every authored capability. Only its participation
/// in its fragmentainer's normal flow changes: the fragmentainer already chose
/// the physical placement.
#[derive(Debug, Clone)]
pub(crate) struct FragmentBox {
    source: LayoutNode,
    placement: FragmentPlacement,
}

impl FragmentBox {
    pub(crate) const fn new(source: LayoutNode, placement: FragmentPlacement) -> Self {
        Self { source, placement }
    }
}

impl FragmentPlacementOwner for FragmentBox {
    fn fragment_placement(&self) -> FragmentPlacement {
        self.placement
    }

    fn fragment_source(&self) -> &dyn LayoutElement {
        self.source.as_ref()
    }
}

impl LayoutElement for FragmentBox {
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
        visitor(self.source.as_ref());
    }

    fn visit_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        visitor(self.source.as_mut());
    }

    fn visit_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        visitor(&mut self.source);
    }

    fn margin_holder(&self) -> Option<&dyn crate::layout::flow_metrics::MarginHolder> {
        self.source.margin_holder()
    }

    fn margin_holder_mut(&mut self) -> Option<&mut dyn crate::layout::flow_metrics::MarginHolder> {
        self.source.margin_holder_mut()
    }

    fn replaced_element(&self) -> Option<&dyn ReplacedElement> {
        self.source.replaced_element()
    }

    fn replaced_element_mut(&mut self) -> Option<&mut dyn ReplacedElement> {
        self.source.replaced_element_mut()
    }

    fn inline_flow_extent(&self) -> Option<&dyn InlineFlowExtent> {
        self.source.inline_flow_extent()
    }

    fn atomic_inline_baseline(&self) -> Option<&dyn AtomicInlineBaseline> {
        self.source.atomic_inline_baseline()
    }

    fn block_flow_participant(&self) -> Option<&dyn BlockFlowParticipant> {
        self.source.block_flow_participant()
    }

    fn block_flow_participant_mut(&mut self) -> Option<&mut dyn BlockFlowParticipant> {
        self.source.block_flow_participant_mut()
    }

    fn containing_block_consumer_mut(&mut self) -> Option<&mut dyn ContainingBlockConsumer> {
        self.source.containing_block_consumer_mut()
    }

    fn positioning_owner(&self) -> Option<&dyn PositioningOwner> {
        self.source.positioning_owner()
    }

    fn positioning_owner_mut(&mut self) -> Option<&mut dyn PositioningOwner> {
        self.source.positioning_owner_mut()
    }

    fn block_flow_owner(&self) -> Option<&dyn BlockFlowOwner> {
        self.source.block_flow_owner()
    }

    fn paint_group_owner(&self) -> Option<&dyn PaintGroupOwner> {
        self.source.paint_group_owner()
    }

    fn paint_group_owner_mut(&mut self) -> Option<&mut dyn PaintGroupOwner> {
        self.source.paint_group_owner_mut()
    }

    fn box_reference_geometry(&self) -> Option<&dyn super::BoxReferenceGeometry> {
        self.source.box_reference_geometry()
    }

    fn box_paint_owner(&self) -> Option<&dyn BoxPaintOwner> {
        self.source.box_paint_owner()
    }

    fn box_paint_owner_mut(&mut self) -> Option<&mut dyn BoxPaintOwner> {
        self.source.box_paint_owner_mut()
    }

    fn in_flow_paint_phase_owner(&self) -> Option<&dyn BoxPaintOwner> {
        self.source.in_flow_paint_phase_owner()
    }

    fn block_fragmentation_source(&self) -> Option<&dyn BlockFragmentationSource> {
        self.source.block_fragmentation_source()
    }

    fn fragment_start_spacing_mut(&mut self) -> Option<&mut dyn FragmentStartSpacing> {
        self.source.fragment_start_spacing_mut()
    }

    fn box_fragmentation_owner(&self) -> Option<&dyn BoxFragmentationOwner> {
        self.source.box_fragmentation_owner()
    }

    fn box_fragmentation_owner_mut(&mut self) -> Option<&mut dyn BoxFragmentationOwner> {
        self.source.box_fragmentation_owner_mut()
    }

    fn page_area_background_mut(&mut self) -> Option<&mut dyn super::PageAreaBackground> {
        self.source.page_area_background_mut()
    }

    fn page_area_background(&self) -> Option<&dyn super::PageAreaBackground> {
        self.source.page_area_background()
    }

    fn filter_holder_mut(&mut self) -> Option<&mut dyn FilterHolder> {
        self.source.filter_holder_mut()
    }

    fn table_box_decoration_owner(&self) -> Option<&dyn TableBoxDecorationOwner> {
        self.source.table_box_decoration_owner()
    }

    fn table_grid_owner(&self) -> Option<&dyn TableGridOwner> {
        self.source.table_grid_owner()
    }

    fn exact_vector_filter_source(
        &self,
    ) -> Option<&dyn crate::layout::filter::ExactVectorFilterSource> {
        self.source.exact_vector_filter_source()
    }

    fn fragment_placement_owner(&self) -> Option<&dyn FragmentPlacementOwner> {
        Some(self)
    }

    fn contributes_to_normal_flow(&self) -> bool {
        false
    }

    fn page_content_role(&self) -> super::PageContentRole {
        self.source.page_content_role()
    }

    fn has_own_page_spanning_graphical_effect(&self) -> bool {
        self.source.has_own_page_spanning_graphical_effect()
    }

    fn has_page_spanning_graphical_effect(&self) -> bool {
        self.source.has_page_spanning_graphical_effect()
    }

    fn retain_page_spanning_paint(&mut self) -> bool {
        self.source.retain_page_spanning_paint()
    }
}
