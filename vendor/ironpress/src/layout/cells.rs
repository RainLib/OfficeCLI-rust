use crate::layout::elements::{
    BoxPaint, BoxPaintOwner, LayoutNode, LayoutSize, LineFragmentation, Positioning,
    PositioningOwner,
};
use crate::layout::engine::{LayoutBorder, TextLine};
use crate::layout::filter::FilterRasterOutput;
use crate::style::computed::{TextAlign, VerticalAlign};
use crate::types::{EdgeSizes, Point, Size};

/// Text and child layout owned by one table or grid cell.
#[derive(Debug, Clone, Default)]
pub struct CellContent {
    pub lines: Vec<TextLine>,
    pub children: Vec<LayoutNode>,
}

/// Canonical box paint plus an optional materialized filter replacement.
///
/// Cells reuse `BoxPaint`; maintaining a smaller parallel set of background,
/// shadow, masking, and opacity fields is how child-only paint paths drifted
/// away from ordinary boxes.
#[derive(Debug, Clone, Default)]
pub(crate) struct CellPaint {
    pub(crate) box_paint: BoxPaint,
    pub(crate) filter_output: Option<FilterRasterOutput>,
}

impl CellPaint {
    pub(crate) fn from_style(
        style: &crate::style::computed::ComputedStyle,
        size: LayoutSize,
    ) -> Self {
        Self {
            box_paint: BoxPaint::from_style(style, size),
            ..Default::default()
        }
    }

    pub(crate) fn has_outset_graphical_effect(&self) -> bool {
        self.box_paint.has_outset_graphical_effect()
            || self
                .filter_output
                .as_ref()
                .is_some_and(|output| !output.raster_overflow.is_zero())
    }
}

impl std::ops::Deref for CellPaint {
    type Target = BoxPaint;

    fn deref(&self) -> &Self::Target {
        &self.box_paint
    }
}

impl std::ops::DerefMut for CellPaint {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.box_paint
    }
}

impl crate::layout::elements::FilterHolder for CellPaint {
    fn filter_slot_mut(&mut self) -> &mut Option<crate::layout::filter::ResolvedFilter> {
        &mut self.box_paint.group.filter
    }
}

/// Resolved box-model geometry shared by table and grid cells.
#[derive(Debug, Clone, Default)]
pub struct CellBoxModel {
    /// Insets from the cell border-box edge to its content. This is the one
    /// canonical sum of authored padding and the cell-owned border share.
    pub content_insets: EdgeSizes,
    /// Cell-owned border share, retained as the semantic component needed by
    /// padding-box containing blocks and collapsed-border conflict resolution.
    pub border_insets: EdgeSizes,
    pub border: LayoutBorder,
    /// Minimum grid-line distance in the block axis.
    pub minimum_block_size: f32,
}

impl CellBoxModel {
    /// Authored padding recovered from the canonical content inset and the
    /// independently resolved border share. Paint geometry needs this component
    /// because [`crate::render::pdf`] supplies the border separately.
    pub(crate) fn padding(&self) -> EdgeSizes {
        self.content_insets - self.border_insets
    }
}

impl crate::layout::elements::BoxReferenceGeometry for CellBoxModel {
    fn border_insets(&self) -> EdgeSizes {
        self.border_insets
    }

    fn content_insets(&self) -> EdgeSizes {
        self.content_insets
    }
}

impl crate::layout::elements::BoxReferenceGeometry for crate::layout::engine::FlexCell {
    fn border_insets(&self) -> EdgeSizes {
        self.border.widths()
    }

    fn content_insets(&self) -> EdgeSizes {
        self.border.widths() + self.padding
    }
}

/// Text alignment within one table or grid cell.
#[derive(Debug, Clone, Copy, Default)]
pub struct CellAlignment {
    pub inline: TextAlign,
    pub block: VerticalAlign,
}

/// Fragmentation policy of the independent formatting context inside a cell.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CellFragmentation {
    pub(crate) lines: LineFragmentation,
}

impl CellFragmentation {
    pub(crate) const fn from_style(style: &crate::style::computed::ComputedStyle) -> Self {
        Self {
            lines: LineFragmentation::from_style(style),
        }
    }
}

/// Layout and paint state common to table and grid cells.
#[derive(Debug, Clone, Default)]
pub struct CellBox {
    pub content: CellContent,
    pub box_model: CellBoxModel,
    pub(crate) paint: CellPaint,
    pub(crate) positioning: Positioning,
    pub alignment: CellAlignment,
    pub(crate) fragmentation: CellFragmentation,
}

impl CellBox {
    /// Actual block extent occupied by text, nested flow, padding, and the
    /// cell-owned border share.
    ///
    /// This deliberately excludes the track minimum. Alignment needs the
    /// intrinsic content extent even when layout has stretched the row.
    pub(crate) fn intrinsic_block_extent(&self) -> f32 {
        let text = self
            .content
            .lines
            .iter()
            .map(|line| line.height)
            .sum::<f32>();
        let nested = crate::layout::paginate::simulate_block_flow(&self.content.children).height;
        text + nested + self.box_model.content_insets.vertical()
    }

    /// Block-start offset of intrinsic content inside a stretched cell.
    pub(crate) fn content_block_offset(&self, row_extent: f32) -> f32 {
        let free = (row_extent - self.intrinsic_block_extent()).max(0.0);
        match self.alignment.block {
            VerticalAlign::Middle => crate::fonts::ceil_to_css_pixel(free / 2.0),
            VerticalAlign::Bottom | VerticalAlign::TextBottom => free,
            VerticalAlign::Top
            | VerticalAlign::TextTop
            | VerticalAlign::Baseline
            | VerticalAlign::Super
            | VerticalAlign::Sub
            | VerticalAlign::Length(_)
            | VerticalAlign::Percent(_) => 0.0,
        }
    }

    pub(crate) fn has_outset_graphical_effect(&self) -> bool {
        self.paint.has_outset_graphical_effect()
            || crate::layout::elements::text_lines_have_outset_shadows(&self.content.lines)
    }

    /// Depth at which this cell's padding box becomes the containing block for
    /// positioned descendants.
    ///
    /// Cells are formatting-context principals rather than `LayoutNode`s, so
    /// recursive renderers cannot discover this capability through the normal
    /// container visitor. Exposing the same semantic query here prevents table
    /// and grid child paths from silently dropping positioned ancestry.
    pub(crate) fn established_containing_block_depth(&self) -> Option<usize> {
        let establishes = self.positioning.scheme.is_positioned()
            || self.paint.group.transform.value.is_some()
            || self.paint.group.effects.stacking_context
                == crate::layout::engine::StackingContext::Filter;
        (establishes && self.positioning.containing_block_depth > 0)
            .then_some(self.positioning.containing_block_depth)
    }
}

/// Access to the common cell box without erasing the concrete cell role.
pub trait CellBoxHolder {
    fn cell_box(&self) -> &CellBox;
}

/// Access to paint effects shared by every concrete cell representation.
pub(crate) trait CellPaintHolder {
    fn cell_paint(&self) -> &CellPaint;
    fn cell_paint_mut(&mut self) -> &mut CellPaint;
}

impl CellPaintHolder for CellBox {
    fn cell_paint(&self) -> &CellPaint {
        &self.paint
    }

    fn cell_paint_mut(&mut self) -> &mut CellPaint {
        &mut self.paint
    }
}

impl PositioningOwner for CellBox {
    fn positioning(&self) -> &Positioning {
        &self.positioning
    }

    fn positioning_mut(&mut self) -> &mut Positioning {
        &mut self.positioning
    }
}

impl BoxPaintOwner for CellBox {
    fn box_paint(&self) -> &BoxPaint {
        &self.paint.box_paint
    }

    fn box_paint_mut(&mut self) -> &mut BoxPaint {
        &mut self.paint.box_paint
    }
}

/// Number of table tracks occupied by a table cell.
#[derive(Debug, Clone, Copy)]
pub struct TableCellSpan {
    pub columns: usize,
    pub rows: usize,
}

impl Default for TableCellSpan {
    fn default() -> Self {
        Self {
            columns: 1,
            rows: 1,
        }
    }
}

/// Definite table-cell height contribution to the row tracks it spans.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TableCellHeightConstraint {
    pub(crate) specified: f32,
    pub(crate) rowspan: usize,
}

impl TableCellHeightConstraint {
    /// CSS Tables defines a row's minimum from the cell's computed height.
    /// Collapsed borders can extend beyond the row grid, but do not reduce this
    /// track contribution.
    pub(crate) fn minimum_row_height(self) -> f32 {
        self.specified / self.rowspan.max(1) as f32
    }
}

/// Table-only border and visibility state.
#[derive(Debug, Clone, Default)]
pub struct TableCellState {
    pub hide_if_empty: bool,
    pub clips: bool,
}

/// A concrete table cell.
#[derive(Debug, Clone, Default)]
pub struct TableCell {
    pub layout: CellBox,
    pub span: TableCellSpan,
    pub table: TableCellState,
}

impl CellBoxHolder for TableCell {
    fn cell_box(&self) -> &CellBox {
        &self.layout
    }
}

impl TableCell {
    /// Minimum block extent contributed by this cell to its originating row.
    pub(crate) fn row_block_extent(&self) -> f32 {
        self.layout
            .intrinsic_block_extent()
            .max(self.layout.box_model.minimum_block_size)
    }
}

/// Canonical row-track measurement over any retained table-cell slice.
pub(crate) trait TableRowCells {
    fn row_block_extent(&self) -> f32;
}

impl TableRowCells for [TableCell] {
    fn row_block_extent(&self) -> f32 {
        self.iter()
            .map(TableCell::row_block_extent)
            .fold(0.0_f32, f32::max)
    }
}

impl CellPaintHolder for TableCell {
    fn cell_paint(&self) -> &CellPaint {
        self.layout.cell_paint()
    }

    fn cell_paint_mut(&mut self) -> &mut CellPaint {
        self.layout.cell_paint_mut()
    }
}

/// Placement of a grid item's painted box within its track cell.
#[derive(Debug, Clone, Copy)]
pub struct GridInset {
    pub offset: Point,
    pub size: Size,
}

/// Grid-only placement and fragmentation state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct GridPaintOrder {
    order: i32,
    source_index: usize,
}

impl GridPaintOrder {
    pub(crate) const fn new(order: i32, source_index: usize) -> Self {
        Self {
            order,
            source_index,
        }
    }
}

/// Grid-only placement, paint-order, and fragmentation state.
#[derive(Debug, Clone)]
pub struct GridCellPlacement {
    pub inset: Option<GridInset>,
    pub clips: bool,
    /// Zero-based start track retained independently of storage and paint order.
    pub column_start: usize,
    pub column_span: usize,
    pub row_span: usize,
    /// CSS Grid's order-modified document order. Geometry remains track-based,
    /// so paint can be reordered without moving or reindexing the cell.
    pub(crate) paint_order: GridPaintOrder,
}

impl Default for GridCellPlacement {
    fn default() -> Self {
        Self {
            inset: None,
            clips: false,
            column_start: 0,
            column_span: 1,
            row_span: 1,
            paint_order: GridPaintOrder::default(),
        }
    }
}

/// A concrete grid cell.
#[derive(Debug, Clone, Default)]
pub struct GridCell {
    pub layout: CellBox,
    pub placement: GridCellPlacement,
}

impl CellBoxHolder for GridCell {
    fn cell_box(&self) -> &CellBox {
        &self.layout
    }
}

impl CellPaintHolder for GridCell {
    fn cell_paint(&self) -> &CellPaint {
        self.layout.cell_paint()
    }

    fn cell_paint_mut(&mut self) -> &mut CellPaint {
        self.layout.cell_paint_mut()
    }
}
