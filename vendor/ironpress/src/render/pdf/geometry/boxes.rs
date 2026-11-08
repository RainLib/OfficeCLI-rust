use super::super::transforms::PageContentTransform;
use super::{PdfPoint, PdfRect, PdfVector, RoundedRect};
use crate::layout::elements::{BoxFragmentation, BoxTransform};
use crate::render::background::BackgroundBleed;
use crate::style::computed::{
    BackgroundClip, BackgroundOrigin, ShapeBox, TransformBox, TransformOrigin,
};
use crate::types::{CornerRadii, EdgeSizes};

/// One laid-out CSS box before the absolute print-paint grid is applied.
///
/// Descendant placement is allowed to use this geometry. Paint consumers are
/// not: conversion to [`PaintBoxGeometry`] is the proof that every absolute
/// edge has crossed the page paint boundary exactly once.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct LayoutBoxGeometry {
    pub(in crate::render::pdf) border_box: PdfRect,
    pub(in crate::render::pdf) border: EdgeSizes,
    pub(in crate::render::pdf) padding: EdgeSizes,
    background_bleed: BackgroundBleed,
}

/// One CSS box resolved onto the absolute print-paint grid.
///
/// Every derived paint rectangle comes from the same snapped border-box
/// contract. Layout code cannot construct this from a [`LayoutBorder`]
/// directly; it must cross [`LayoutBoxGeometry::for_paint`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct PaintBoxGeometry {
    pub(in crate::render::pdf) border_box: PdfRect,
    pub(in crate::render::pdf) border: EdgeSizes,
    pub(in crate::render::pdf) padding: EdgeSizes,
    background_bleed: BackgroundBleed,
}

/// CSS-pixel grid used when layout geometry crosses into vector paint.
///
/// Normal flow uses the page grid. An outer atomic inline box roots a local
/// grid at its authored position so its descendants move as one coherent paint
/// unit while retaining the same CSS-pixel quantization.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) enum BoxPaintGrid {
    #[default]
    Page,
    AtomicInline(PdfPoint),
}

impl BoxPaintGrid {
    fn resolve(self, page_content: PageContentTransform, border_box: PdfRect) -> PdfRect {
        match self {
            Self::Page => page_content.snap_layout_box(border_box),
            Self::AtomicInline(origin) => page_content.snap_layout_box_from(border_box, origin),
        }
    }
}

/// The paired layout and paint views of one CSS box at a page boundary.
///
/// Chromium keeps both: authored subpixel geometry remains authoritative for
/// descendant layout and background phase, while destination edges and clips
/// use the pixel-snapped paint rectangle.
#[derive(Debug, Clone, Copy)]
pub(in crate::render::pdf) struct BoxPaintGeometry {
    layout: LayoutBoxGeometry,
    painting: PaintBoxGeometry,
    page_content: PageContentTransform,
    grid: BoxPaintGrid,
}

impl BoxPaintGeometry {
    pub(in crate::render::pdf) const fn layout(self) -> LayoutBoxGeometry {
        self.layout
    }

    pub(in crate::render::pdf) const fn painting(self) -> PaintBoxGeometry {
        self.painting
    }

    pub(in crate::render::pdf) fn fragment(
        self,
        fragmentation: BoxFragmentation,
    ) -> FragmentPaintGeometry {
        let layout_reassembled = fragmentation.reference_slice.map_or(self.layout, |slice| {
            let edges = slice.edges();
            LayoutBoxGeometry::new(
                PdfRect::from_top(
                    self.layout.border_box.left,
                    self.layout.border_box.top() + slice.block_offset(),
                    self.layout.border_box.width,
                    slice.composite_block_size(),
                ),
                edges.border(),
                edges.padding(),
            )
            .with_background_bleed(self.layout.background_bleed)
        });
        FragmentPaintGeometry {
            layout_reassembled,
            painting: self.painting,
            reassembled: layout_reassembled.resolve(self.page_content, self.grid),
        }
    }

    pub(in crate::render::pdf) fn background(
        self,
        origin: BackgroundOrigin,
        clip: BackgroundClip,
        radii: CornerRadii,
    ) -> BackgroundFragmentGeometry {
        BackgroundFragmentGeometry::resolve(
            self.layout,
            self.painting,
            self.painting,
            origin,
            clip,
            radii,
        )
    }
}

/// The concrete CSS transform reference box resolved from one painted box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(in crate::render::pdf) struct TransformReferenceGeometry {
    border_box: PdfRect,
    reference_box: PdfRect,
    origin: TransformOrigin,
}

impl TransformReferenceGeometry {
    pub(in crate::render::pdf) fn pivot(self) -> PdfPoint {
        self.reference_box.css_transform_origin(self.origin)
    }

    pub(in crate::render::pdf) fn local_pivot(self) -> PdfVector {
        let pivot = self.pivot();
        PdfVector::new(
            pivot.x - self.border_box.left,
            self.border_box.top() - pivot.y,
        )
    }

    pub(in crate::render::pdf) const fn size(self) -> PdfVector {
        PdfVector::new(self.reference_box.width, self.reference_box.height)
    }

    pub(in crate::render::pdf) const fn border_box(self) -> PdfRect {
        self.border_box
    }

    pub(in crate::render::pdf) const fn z_origin(self) -> f32 {
        self.origin.z_length
    }
}

/// Paired background positioning rectangles retained at the paint boundary.
///
/// Intrinsic images use authored geometry for source mapping. Generated images
/// such as CSS gradients use the border-aligned snapped rectangle. Blink
/// deliberately keeps these quantities separate: intrinsic image maps require
/// the author's fractional geometry, while a generated tile must reach the
/// snapped destination without wrapping or leaving a seam beside the border.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct BackgroundPositioningGeometry {
    authored: PdfRect,
    snapped: PdfRect,
}

impl BackgroundPositioningGeometry {
    const fn new(authored: PdfRect, snapped: PdfRect) -> Self {
        Self { authored, snapped }
    }

    pub(in crate::render::pdf) const fn intrinsic_image_box(self) -> PdfRect {
        self.authored
    }

    pub(in crate::render::pdf) const fn generated_image_box(self) -> PdfRect {
        self.snapped
    }
}

/// Background image positioning, optimized destination, and CSS clip.
///
/// These rectangles are deliberately distinct. An opaque border can conceal a
/// contracted image destination, while the authored `background-clip` remains
/// the clipping contract for color and exposed paint.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct BackgroundFragmentGeometry {
    pub(in crate::render::pdf) positioning_area: BackgroundPositioningGeometry,
    pub(in crate::render::pdf) image_destination_box: PdfRect,
    pub(in crate::render::pdf) painting_box: RoundedRect,
}

impl BackgroundFragmentGeometry {
    fn resolve(
        layout_positioning: LayoutBoxGeometry,
        snapped_positioning: PaintBoxGeometry,
        painting: PaintBoxGeometry,
        origin: BackgroundOrigin,
        clip: BackgroundClip,
        radii: CornerRadii,
    ) -> Self {
        let authored_positioning_box = layout_positioning.background_origin_box(origin);
        let aligns_to_inner_border = layout_positioning
            .background_bleed
            .obscures_rectangular_destination(radii);
        let snapped_positioning_box = snapped_positioning.background_origin_box(origin);
        let painting_box = painting.background_clip_box(clip, radii);
        Self {
            positioning_area: BackgroundPositioningGeometry::new(
                authored_positioning_box,
                snapped_positioning_box,
            ),
            image_destination_box: if aligns_to_inner_border && clip == BackgroundClip::Border {
                painting.padding_box()
            } else {
                painting_box.rect
            },
            painting_box,
        }
    }
}

/// The current fragment's paint box and its position in the reassembled box.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct FragmentPaintGeometry {
    layout_reassembled: LayoutBoxGeometry,
    painting: PaintBoxGeometry,
    reassembled: PaintBoxGeometry,
}

impl FragmentPaintGeometry {
    pub(in crate::render::pdf) const fn painting(self) -> PaintBoxGeometry {
        self.painting
    }

    pub(in crate::render::pdf) const fn positioning(self) -> PaintBoxGeometry {
        self.reassembled
    }

    pub(in crate::render::pdf) fn decoration_clip(self, outsets: EdgeSizes) -> Option<PdfRect> {
        if self.painting == self.reassembled {
            return None;
        }
        const EDGE_EPSILON: f32 = 0.001;
        let painting = self.painting.border_box;
        let reference = self.reassembled.border_box;
        let has_real_top = (painting.top() - reference.top()).abs() <= EDGE_EPSILON;
        let has_real_bottom = (painting.bottom - reference.bottom).abs() <= EDGE_EPSILON;
        let top_outset = if has_real_top { outsets.top } else { 0.0 };
        let bottom_outset = if has_real_bottom { outsets.bottom } else { 0.0 };
        Some(PdfRect::new(
            painting.left - outsets.left,
            painting.bottom - bottom_outset,
            painting.width + outsets.horizontal(),
            painting.height + top_outset + bottom_outset,
        ))
    }

    pub(in crate::render::pdf) fn shape_reference(self) -> PaintBoxGeometry {
        PaintBoxGeometry::new(
            PdfRect::from_top(
                self.painting.border_box.left,
                self.painting.border_box.top(),
                self.painting.border_box.width,
                self.reassembled.border_box.height,
            ),
            self.reassembled.border,
            self.reassembled.padding,
        )
        .with_background_bleed(self.reassembled.background_bleed)
    }

    pub(in crate::render::pdf) fn background(
        self,
        origin: BackgroundOrigin,
        clip: BackgroundClip,
        radii: CornerRadii,
    ) -> BackgroundFragmentGeometry {
        BackgroundFragmentGeometry::resolve(
            self.layout_reassembled,
            self.reassembled,
            self.painting,
            origin,
            clip,
            radii,
        )
    }
}

impl LayoutBoxGeometry {
    pub(in crate::render::pdf) const fn new(
        border_box: PdfRect,
        border: EdgeSizes,
        padding: EdgeSizes,
    ) -> Self {
        Self {
            border_box,
            border,
            padding,
            background_bleed: BackgroundBleed::NONE,
        }
    }

    pub(in crate::render::pdf) fn from_layout(
        border_box: PdfRect,
        border: &crate::layout::engine::LayoutBorder,
        padding: EdgeSizes,
        border_image: Option<&crate::style::computed::BorderImagePaint>,
    ) -> Self {
        Self::new(border_box, border.widths(), padding)
            .with_background_bleed(BackgroundBleed::from_decoration(border, border_image))
    }

    const fn with_background_bleed(mut self, background_bleed: BackgroundBleed) -> Self {
        self.background_bleed = background_bleed;
        self
    }

    pub(in crate::render::pdf) fn for_paint(
        self,
        page_content: PageContentTransform,
        grid: BoxPaintGrid,
    ) -> BoxPaintGeometry {
        let painting = self.resolve(page_content, grid);
        BoxPaintGeometry {
            layout: self,
            painting,
            page_content,
            grid,
        }
    }

    fn resolve(self, page_content: PageContentTransform, grid: BoxPaintGrid) -> PaintBoxGeometry {
        let border_box = grid.resolve(page_content, self.border_box);
        PaintBoxGeometry::new(border_box, self.border, self.padding)
            .with_background_bleed(self.background_bleed)
    }

    pub(in crate::render::pdf) fn padding_box(self) -> PdfRect {
        self.border_box.inset(self.border)
    }

    pub(in crate::render::pdf) fn content_box(self) -> PdfRect {
        self.border_box.inset(self.border + self.padding)
    }

    pub(in crate::render::pdf) fn background_origin_box(self, origin: BackgroundOrigin) -> PdfRect {
        match origin {
            BackgroundOrigin::Border => self.border_box,
            BackgroundOrigin::Padding => self.padding_box(),
            BackgroundOrigin::Content => self.content_box(),
        }
    }
}

impl PaintBoxGeometry {
    pub(in crate::render::pdf) const fn new(
        border_box: PdfRect,
        border: EdgeSizes,
        padding: EdgeSizes,
    ) -> Self {
        Self {
            border_box,
            border,
            padding,
            background_bleed: BackgroundBleed::NONE,
        }
    }

    const fn with_background_bleed(mut self, background_bleed: BackgroundBleed) -> Self {
        self.background_bleed = background_bleed;
        self
    }

    pub(in crate::render::pdf) fn padding_box(self) -> PdfRect {
        self.border_box.inset(self.border)
    }

    pub(in crate::render::pdf) fn content_box(self) -> PdfRect {
        self.border_box.inset(self.border + self.padding)
    }

    pub(in crate::render::pdf) fn background_origin_box(self, origin: BackgroundOrigin) -> PdfRect {
        match origin {
            BackgroundOrigin::Border => self.border_box,
            BackgroundOrigin::Padding => self.padding_box(),
            BackgroundOrigin::Content => self.content_box(),
        }
    }

    pub(in crate::render::pdf) fn rounded_border_box(self, radii: CornerRadii) -> RoundedRect {
        self.border_box
            .rounded(radii.fit_to(self.border_box.width, self.border_box.height))
    }

    pub(in crate::render::pdf) fn rounded_padding_box(self, radii: CornerRadii) -> RoundedRect {
        self.rounded_border_box(radii).inset(self.border)
    }

    pub(in crate::render::pdf) fn transform_reference(
        self,
        transform: &BoxTransform,
    ) -> TransformReferenceGeometry {
        let reference_box = match transform.reference_box {
            TransformBox::Content | TransformBox::Fill => self.content_box(),
            TransformBox::Border | TransformBox::Stroke | TransformBox::View => self.border_box,
        };
        TransformReferenceGeometry {
            border_box: self.border_box,
            reference_box,
            origin: transform.origin,
        }
    }

    pub(in crate::render::pdf) fn shape_box(self, kind: ShapeBox) -> PdfRect {
        match kind {
            ShapeBox::Border => self.border_box,
            ShapeBox::Padding => self.padding_box(),
            ShapeBox::Content => self.content_box(),
        }
    }

    pub(in crate::render::pdf) fn background_clip_box(
        self,
        clip: BackgroundClip,
        radii: CornerRadii,
    ) -> RoundedRect {
        let inset = match clip {
            BackgroundClip::Border => self.background_bleed.clip_insets(clip, radii),
            BackgroundClip::Text => EdgeSizes::ZERO,
            BackgroundClip::Padding => self.border,
            BackgroundClip::Content => self.border + self.padding,
        };
        self.rounded_border_box(radii).inset(inset)
    }

    #[cfg(test)]
    pub(in crate::render::pdf) fn for_fragment(
        self,
        fragmentation: BoxFragmentation,
    ) -> FragmentPaintGeometry {
        let reassembled = fragmentation.reference_slice.map_or(self, |slice| {
            let edges = slice.edges();
            Self::new(
                PdfRect::from_top(
                    self.border_box.left,
                    self.border_box.top() + slice.block_offset(),
                    self.border_box.width,
                    slice.composite_block_size(),
                ),
                edges.border(),
                edges.padding(),
            )
            .with_background_bleed(self.background_bleed)
        });
        FragmentPaintGeometry {
            layout_reassembled: LayoutBoxGeometry::new(
                reassembled.border_box,
                reassembled.border,
                reassembled.padding,
            )
            .with_background_bleed(reassembled.background_bleed),
            painting: self,
            reassembled,
        }
    }
}
