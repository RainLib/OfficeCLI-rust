use super::LayoutNode;
use super::{
    BlockFlow, BlockFlowOwner, BlockFlowParticipant, BlockFragmentationSource,
    BoxFragmentationOwner, BoxModel, BoxPaint, BoxPaintOwner, ContainingBlockConsumer,
    DescendantClip, FragmentBreakQuery, InlineFlowExtent, LayoutElement, LayoutVisitor,
    LayoutVisitorMut, PaintGroupOwner, Positioning, PositioningOwner, TextBlockStyle,
    TextFragmentation, TextSemantics,
};
use crate::layout::engine::TextLine;
use crate::layout::flow_metrics::{BlockMargins, MarginHolder};
use crate::style::computed::ComputedStyle;
use crate::types::Size;

/// A laid-out block of text and the semantic property groups that govern it.
#[derive(Debug, Clone, Default)]
pub(crate) struct TextBlock {
    pub(crate) lines: Vec<TextLine>,
    pub(crate) box_model: BoxModel,
    pub(crate) paint: BoxPaint,
    pub(crate) flow: BlockFlow,
    pub(crate) positioning: Positioning,
    pub(crate) fragmentation: TextFragmentation,
    pub(crate) text: TextBlockStyle,
    pub(crate) clipping: DescendantClip,
    pub(crate) semantics: TextSemantics,
}

impl TextBlock {
    pub(crate) fn empty_spacer() -> Self {
        Self::default()
    }

    pub(crate) fn plain(lines: Vec<TextLine>) -> Self {
        Self {
            lines,
            ..Default::default()
        }
    }

    pub(crate) fn from_style(
        lines: Vec<TextLine>,
        style: &ComputedStyle,
        box_model: super::BoxModel,
    ) -> Self {
        let paint = super::BoxPaint::from_style(style, box_model.size);
        let indent_basis = box_model.size.width.fixed_value().unwrap_or_default();
        Self {
            lines,
            box_model,
            paint,
            flow: super::BlockFlow {
                float: style.float,
                clear: style.clear,
            },
            positioning: super::Positioning::from_style(style),
            fragmentation: super::TextFragmentation {
                box_fragmentation: super::BoxFragmentation::from_style(style),
                lines: super::LineFragmentation::from_style(style),
            },
            text: super::TextBlockStyle {
                alignment: style.text_align,
                writing_mode: style.writing_mode,
                indent: style.text_indent.resolve(indent_basis),
            },
            ..Default::default()
        }
    }

    /// Natural text and padding extent before the used block-size constraint.
    pub(crate) fn natural_padding_box_block_extent(&self) -> f32 {
        self.box_model.padding.vertical() + self.lines.iter().map(|line| line.height).sum::<f32>()
    }

    /// Used border-box extent shared by layout, fragmentation, and paint.
    ///
    /// `TextBlock` stores a padding-box block size. Borders are therefore
    /// added after resolving that size, including for a definite height.
    pub(crate) fn border_box_block_extent(&self) -> f32 {
        self.box_model
            .size
            .height
            .resolve(self.natural_padding_box_block_extent())
            + self.box_model.border.vertical_width()
    }
}

impl MarginHolder for TextBlock {
    fn margins(&self) -> &BlockMargins {
        &self.box_model.margins
    }

    fn margins_mut(&mut self) -> &mut BlockMargins {
        &mut self.box_model.margins
    }
}

impl InlineFlowExtent for TextBlock {
    fn normal_flow_right_edge(&self) -> Option<f32> {
        let width = self.box_model.size.width.fixed_value()?;
        (self.positioning.is_in_normal_flow()
            && self.fragmentation.box_fragmentation.content_role
                != super::PageContentRole::RepeatedDecoration)
            .then_some((self.positioning.insets.left + width).max(0.0))
            .filter(|right| right.is_finite())
    }
}

impl BlockFlowParticipant for TextBlock {
    fn collapses_outer_margins(&self) -> bool {
        true
    }

    fn is_in_flow_block(&self) -> bool {
        !self.positioning.scheme.is_absolute()
            && self.flow.float == crate::style::computed::Float::None
    }
}

impl ContainingBlockConsumer for TextBlock {
    fn resolve_containing_block(
        &mut self,
        containing_block: crate::layout::engine::ContainingBlock,
    ) {
        let width = self.box_model.size.width.fixed_value().unwrap_or_else(|| {
            self.lines
                .iter()
                .map(|line| {
                    line.runs
                        .iter()
                        .map(|run| {
                            crate::fonts::str_width(
                                &run.text,
                                run.font_size,
                                &run.font_family,
                                run.bold,
                            )
                        })
                        .sum::<f32>()
                })
                .fold(0.0, f32::max)
        });

        self.positioning.resolve_final_containing_block(
            containing_block,
            Size::new(width, self.border_box_block_extent()),
        );
    }
}

impl PositioningOwner for TextBlock {
    fn positioning(&self) -> &Positioning {
        &self.positioning
    }

    fn positioning_mut(&mut self) -> &mut Positioning {
        &mut self.positioning
    }
}

impl BlockFlowOwner for TextBlock {
    fn block_flow(&self) -> &BlockFlow {
        &self.flow
    }
}

impl BoxPaintOwner for TextBlock {
    fn box_paint(&self) -> &BoxPaint {
        &self.paint
    }

    fn box_paint_mut(&mut self) -> &mut BoxPaint {
        &mut self.paint
    }
}

impl BlockFragmentationSource for TextBlock {
    fn block_extent(&self) -> f32 {
        self.border_box_block_extent()
    }

    fn find_block_break(&self, query: FragmentBreakQuery) -> Option<f32> {
        let content_start = self.box_model.border.top.width + self.box_model.padding.top;
        self.fragmentation
            .lines
            .find_break(&self.lines, content_start, query)
    }
}

impl BoxFragmentationOwner for TextBlock {
    fn fragmentation_box_model(&self) -> &BoxModel {
        &self.box_model
    }

    fn box_fragmentation(&self) -> &super::BoxFragmentation {
        &self.fragmentation.box_fragmentation
    }

    fn box_fragmentation_mut(&mut self) -> &mut super::BoxFragmentation {
        &mut self.fragmentation.box_fragmentation
    }
}

impl LayoutElement for TextBlock {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_text_block(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_text_block(self);
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

    fn containing_block_consumer_mut(&mut self) -> Option<&mut dyn ContainingBlockConsumer> {
        Some(self)
    }

    fn positioning_owner(&self) -> Option<&dyn PositioningOwner> {
        Some(self)
    }

    fn positioning_owner_mut(&mut self) -> Option<&mut dyn PositioningOwner> {
        Some(self)
    }

    fn block_flow_owner(&self) -> Option<&dyn BlockFlowOwner> {
        Some(self)
    }

    fn paint_group_owner(&self) -> Option<&dyn PaintGroupOwner> {
        Some(self)
    }

    fn paint_group_owner_mut(&mut self) -> Option<&mut dyn PaintGroupOwner> {
        Some(self)
    }

    fn box_reference_geometry(&self) -> Option<&dyn super::BoxReferenceGeometry> {
        Some(&self.box_model)
    }

    fn box_paint_owner(&self) -> Option<&dyn BoxPaintOwner> {
        Some(self)
    }

    fn box_paint_owner_mut(&mut self) -> Option<&mut dyn BoxPaintOwner> {
        Some(self)
    }

    fn in_flow_paint_phase_owner(&self) -> Option<&dyn BoxPaintOwner> {
        Some(self)
    }

    fn has_own_page_spanning_graphical_effect(&self) -> bool {
        self.paint.has_outset_graphical_effect()
            || super::text_lines_have_outset_shadows(&self.lines)
    }

    fn block_fragmentation_source(&self) -> Option<&dyn BlockFragmentationSource> {
        Some(self)
    }

    fn box_fragmentation_owner(&self) -> Option<&dyn BoxFragmentationOwner> {
        Some(self)
    }

    fn box_fragmentation_owner_mut(&mut self) -> Option<&mut dyn BoxFragmentationOwner> {
        Some(self)
    }

    fn page_content_role(&self) -> super::PageContentRole {
        self.fragmentation
            .box_fragmentation
            .content_role
            .for_position(self.positioning.scheme)
    }
}
