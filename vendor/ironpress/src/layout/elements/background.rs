use super::{
    BoxFragmentation, BoxFragmentationOwner, BoxModel, BoxPaint, BoxPaintOwner, LayoutElement,
    LayoutNode, LayoutSize, LayoutVisitor, LayoutVisitorMut, PageAreaBackground,
    PageAreaPaintSpace, PageContentRole, PaintGroup, PaintGroupOwner, Positioning,
    PositioningOwner, Stacking, StackingRole, TextBlock, TextFragmentation,
};
use crate::layout::print_scale::PrintContentScale;
use crate::style::computed::{ComputedStyle, ZIndex};
use crate::types::{Point, Size};

/// The selected physical page area expressed in document-flow coordinates.
///
/// Root/body gutters move the flow origin without moving the page area.
/// Carrying both values prevents propagated canvas backgrounds from being
/// resized to the narrower body content box.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct PageAreaInFlowSpace {
    pub(crate) origin: Point,
    pub(crate) size: Size,
}

impl PageAreaInFlowSpace {
    pub(crate) const fn new(origin: Point, size: Size) -> Self {
        Self { origin, size }
    }
}

/// Geometry and repetition policy for a synthetic page background.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BackgroundBoxGeometry {
    size: Size,
    origin: Point,
    z_index: i32,
    layer: BackgroundBoxLayer,
}

impl BackgroundBoxGeometry {
    pub(crate) const fn page_backdrop(size: Size, origin: Point, z_index: i32) -> Self {
        Self {
            size,
            origin,
            z_index,
            layer: BackgroundBoxLayer::PageBackdrop,
        }
    }

    pub(crate) const fn repeated_canvas(size: Size, origin: Point, z_index: i32) -> Self {
        Self {
            size,
            origin,
            z_index,
            layer: BackgroundBoxLayer::RepeatedCanvas,
        }
    }

    pub(crate) fn repeated_page_area(page_area: PageAreaInFlowSpace, z_index: i32) -> Self {
        let repeated = RepeatedPageAreaGeometry { page_area };
        let layout_box = repeated.layout_box(PrintContentScale::default());
        Self {
            size: layout_box.size,
            origin: layout_box.origin,
            z_index,
            layer: BackgroundBoxLayer::RepeatedPageArea(repeated),
        }
    }
}

/// Physical target covered by the propagated root canvas on every page.
#[derive(Debug, Clone, Copy)]
struct RepeatedPageAreaGeometry {
    page_area: PageAreaInFlowSpace,
}

impl RepeatedPageAreaGeometry {
    fn layout_box(self, scale: PrintContentScale) -> crate::types::Rect {
        crate::types::Rect::new(
            scale.layout_point_for_physical(self.page_area.origin),
            scale.layout_size_for_physical(self.page_area.size),
        )
    }
}

/// Relationship between a background and physical fragmentainers.
#[derive(Debug, Clone, Copy)]
enum BackgroundBoxLayer {
    /// An `@page` backdrop already assigned to one physical page.
    PageBackdrop,
    /// A fixed-size document-canvas decoration repeated on every page.
    RepeatedCanvas,
    /// The propagated root canvas fitted to each selected page area.
    RepeatedPageArea(RepeatedPageAreaGeometry),
}

/// Paint-only layout node for page and propagated-canvas backgrounds.
///
/// Rendering deliberately reuses the ordinary text-box paint path, while the
/// concrete wrapper retains the page-area sizing behavior that a `TextBlock`
/// cannot express.
#[derive(Debug, Clone)]
pub(crate) struct BackgroundBox {
    paint_box: TextBlock,
    layer: BackgroundBoxLayer,
}

impl BackgroundBox {
    pub(crate) fn new(style: &ComputedStyle, geometry: BackgroundBoxGeometry) -> Self {
        let size = LayoutSize::fixed(geometry.size.width, Some(geometry.size.height));
        let paint_box = TextBlock {
            box_model: BoxModel {
                size,
                ..Default::default()
            },
            paint: BoxPaint {
                background: super::BackgroundPaint::from_style(style),
                group: PaintGroup {
                    stacking: Stacking {
                        z_index: ZIndex::integer(geometry.z_index),
                        role: StackingRole::PageBackdrop,
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            positioning: Positioning::absolute_at(geometry.origin),
            fragmentation: TextFragmentation {
                box_fragmentation: BoxFragmentation {
                    content_role: PageContentRole::RepeatedDecoration,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        Self {
            paint_box,
            layer: geometry.layer,
        }
    }

    fn apply_repeated_page_area_geometry(&mut self, scale: PrintContentScale) {
        let BackgroundBoxLayer::RepeatedPageArea(geometry) = self.layer else {
            return;
        };
        let layout_box = geometry.layout_box(scale);
        self.paint_box.box_model.size =
            LayoutSize::fixed(layout_box.size.width, Some(layout_box.size.height));
        self.paint_box.positioning = Positioning::absolute_at(layout_box.origin);
    }
}

impl PageAreaBackground for BackgroundBox {
    fn fit_page_area(&mut self, page_area: PageAreaInFlowSpace) {
        let BackgroundBoxLayer::RepeatedPageArea(mut geometry) = self.layer else {
            return;
        };
        geometry.page_area = page_area;
        self.layer = BackgroundBoxLayer::RepeatedPageArea(geometry);
        self.apply_repeated_page_area_geometry(PrintContentScale::default());
    }

    fn apply_print_content_scale(&mut self, scale: PrintContentScale) {
        self.apply_repeated_page_area_geometry(scale);
    }

    fn paint_space(&self) -> PageAreaPaintSpace {
        match self.layer {
            BackgroundBoxLayer::PageBackdrop => PageAreaPaintSpace::PhysicalPage,
            BackgroundBoxLayer::RepeatedPageArea(_) => PageAreaPaintSpace::FittedDocumentCanvas,
            BackgroundBoxLayer::RepeatedCanvas => PageAreaPaintSpace::FittedDocumentCanvas,
        }
    }
}

impl LayoutElement for BackgroundBox {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_text_block(&self.paint_box);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_text_block(&mut self.paint_box);
    }

    fn positioning_owner(&self) -> Option<&dyn PositioningOwner> {
        Some(&self.paint_box)
    }

    fn positioning_owner_mut(&mut self) -> Option<&mut dyn PositioningOwner> {
        Some(&mut self.paint_box)
    }

    fn paint_group_owner(&self) -> Option<&dyn PaintGroupOwner> {
        Some(&self.paint_box)
    }

    fn paint_group_owner_mut(&mut self) -> Option<&mut dyn PaintGroupOwner> {
        Some(&mut self.paint_box)
    }

    fn box_reference_geometry(&self) -> Option<&dyn super::BoxReferenceGeometry> {
        Some(&self.paint_box.box_model)
    }

    fn box_paint_owner(&self) -> Option<&dyn BoxPaintOwner> {
        Some(&self.paint_box)
    }

    fn box_paint_owner_mut(&mut self) -> Option<&mut dyn BoxPaintOwner> {
        Some(&mut self.paint_box)
    }

    fn in_flow_paint_phase_owner(&self) -> Option<&dyn BoxPaintOwner> {
        Some(&self.paint_box)
    }

    fn box_fragmentation_owner(&self) -> Option<&dyn BoxFragmentationOwner> {
        Some(&self.paint_box)
    }

    fn box_fragmentation_owner_mut(&mut self) -> Option<&mut dyn BoxFragmentationOwner> {
        Some(&mut self.paint_box)
    }

    fn page_area_background_mut(&mut self) -> Option<&mut dyn PageAreaBackground> {
        matches!(
            self.layer,
            BackgroundBoxLayer::PageBackdrop | BackgroundBoxLayer::RepeatedPageArea(_)
        )
        .then_some(self as &mut dyn PageAreaBackground)
    }

    fn page_area_background(&self) -> Option<&dyn PageAreaBackground> {
        matches!(
            self.layer,
            BackgroundBoxLayer::PageBackdrop | BackgroundBoxLayer::RepeatedPageArea(_)
        )
        .then_some(self as &dyn PageAreaBackground)
    }

    fn has_own_page_spanning_graphical_effect(&self) -> bool {
        self.paint_box.has_own_page_spanning_graphical_effect()
    }

    fn contributes_to_normal_flow(&self) -> bool {
        false
    }

    fn page_content_role(&self) -> PageContentRole {
        PageContentRole::RepeatedDecoration
    }
}
