use super::LayoutNode;
use super::{
    BlockFlowParticipant, ChildContainer, FragmentStartSpacing, InlineFlowExtent, LayoutElement,
    LayoutVisitor, LayoutVisitorMut,
};
use crate::layout::cells::GridCell;
use crate::layout::flow_metrics::{BlockMargins, MarginHolder};

/// Grid cells and the tracks against which they were laid out.
#[derive(Debug, Clone, Default)]
pub(crate) struct GridContent {
    pub(crate) cells: Vec<GridCell>,
    pub(crate) column_widths: Vec<f32>,
    pub(crate) gap: f32,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct GridRow {
    pub(crate) content: GridContent,
    pub(crate) box_model: super::BoxModel,
    pub(crate) start_space: GridRowStartSpace,
}

/// Provenance of a grid row's leading track-space contribution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum GridRowStartSpace {
    #[default]
    Alignment,
    Gutter,
}

impl FragmentStartSpacing for GridRow {
    fn suppress_at_fragment_start(&mut self) {
        if self.start_space == GridRowStartSpace::Gutter {
            self.box_model.margins.start = 0.0;
        }
    }
}

impl MarginHolder for GridRow {
    fn margins(&self) -> &BlockMargins {
        &self.box_model.margins
    }

    fn margins_mut(&mut self) -> &mut BlockMargins {
        &mut self.box_model.margins
    }
}

impl InlineFlowExtent for GridRow {
    fn normal_flow_right_edge(&self) -> Option<f32> {
        let columns = &self.content.column_widths;
        let right = columns.iter().sum::<f32>()
            + self.content.gap * columns.len().saturating_sub(1) as f32
            + self.box_model.padding.horizontal()
            + self.box_model.border.horizontal_width();
        right.is_finite().then_some(right.max(0.0))
    }
}

impl BlockFlowParticipant for GridRow {
    fn collapses_outer_margins(&self) -> bool {
        false
    }

    fn is_in_flow_block(&self) -> bool {
        true
    }
}

impl ChildContainer for GridRow {
    fn visit_layout_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        for child in self
            .content
            .cells
            .iter()
            .flat_map(|cell| &cell.layout.content.children)
        {
            visitor(child.as_ref());
        }
    }

    fn visit_layout_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        for child in self
            .content
            .cells
            .iter_mut()
            .flat_map(|cell| &mut cell.layout.content.children)
        {
            visitor(child.as_mut());
        }
    }

    fn visit_layout_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        for child in self
            .content
            .cells
            .iter_mut()
            .flat_map(|cell| &mut cell.layout.content.children)
        {
            visitor(child);
        }
    }
}

impl LayoutElement for GridRow {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_grid_row(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_grid_row(self);
    }

    fn margin_holder(&self) -> Option<&dyn MarginHolder> {
        Some(self)
    }

    fn margin_holder_mut(&mut self) -> Option<&mut dyn MarginHolder> {
        Some(self)
    }

    fn inline_flow_extent(&self) -> Option<&dyn InlineFlowExtent> {
        Some(self)
    }

    fn block_flow_participant(&self) -> Option<&dyn BlockFlowParticipant> {
        Some(self)
    }

    fn block_flow_participant_mut(&mut self) -> Option<&mut dyn BlockFlowParticipant> {
        Some(self)
    }

    fn fragment_start_spacing_mut(&mut self) -> Option<&mut dyn FragmentStartSpacing> {
        Some(self)
    }

    fn has_own_page_spanning_graphical_effect(&self) -> bool {
        self.content
            .cells
            .iter()
            .any(|cell| cell.layout.has_outset_graphical_effect())
    }
    fn visit_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        self.visit_layout_children(visitor);
    }

    fn visit_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        self.visit_layout_children_mut(visitor);
    }

    fn visit_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        self.visit_layout_child_nodes_mut(visitor);
    }
}
