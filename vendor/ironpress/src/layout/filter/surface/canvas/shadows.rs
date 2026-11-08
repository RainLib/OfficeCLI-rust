//! Box-shadow geometry and painting.

use crate::style::computed::BoxShadow;
use crate::types::{EdgeSizes, Point, Size};

use super::{RasterCanvas, SurfaceRect};

impl RasterCanvas<'_> {
    pub(in crate::layout::filter::surface) fn paint_outset_shadows(
        &mut self,
        rect: SurfaceRect,
        shadows: &[BoxShadow],
        filter_dpi: f32,
    ) -> Option<()> {
        for shadow in shadows.iter().rev().filter(|shadow| !shadow.inset) {
            let shadow_rect = outset_shadow_rect(rect, *shadow, 0.0)?;
            if shadow.blur <= 0.0 {
                self.fill(shadow_rect, shadow.color);
                continue;
            }
            let blurred = crate::render::blur::blur_shadow_mask(
                shadow_rect.size.width,
                shadow_rect.size.height,
                crate::types::CornerRadii::ZERO,
                shadow,
                filter_dpi,
            )?
            .tinted_raster(shadow.color.to_f32_rgba())?;
            self.paint_asset_at(
                &blurred.asset,
                Point::new(
                    shadow_rect.origin.x - blurred.overflow_pt,
                    shadow_rect.origin.y - blurred.overflow_pt,
                ),
            )?;
        }
        Some(())
    }

    pub(in crate::layout::filter::surface) fn paint_inset_shadows(
        &mut self,
        rect: SurfaceRect,
        shadows: &[BoxShadow],
        filter_dpi: f32,
    ) -> Option<()> {
        for shadow in shadows.iter().rev().filter(|shadow| shadow.inset) {
            if shadow.blur <= 0.0 {
                let hole = SurfaceRect::new(
                    Point::new(
                        rect.origin.x + shadow.offset_x,
                        rect.origin.y + shadow.offset_y,
                    ),
                    rect.size,
                )
                .inset(EdgeSizes::uniform(shadow.spread));
                self.fill_ring(rect, hole, shadow.color);
                continue;
            }
            let blurred = crate::render::blur::blur_inset_shadow_mask(
                rect.size.width,
                rect.size.height,
                crate::types::CornerRadii::ZERO,
                shadow,
                filter_dpi,
            )?
            .tinted_raster(shadow.color.to_f32_rgba())?;
            self.paint_asset_at(
                &blurred.asset,
                Point::new(
                    rect.origin.x - blurred.overflow_pt,
                    rect.origin.y - blurred.overflow_pt,
                ),
            )?;
        }
        Some(())
    }
}

fn outset_shadow_rect(
    border_box: SurfaceRect,
    shadow: BoxShadow,
    blur_overflow: f32,
) -> Option<SurfaceRect> {
    let outset = shadow.spread + blur_overflow;
    let size = Size::new(
        border_box.size.width + 2.0 * outset,
        border_box.size.height + 2.0 * outset,
    );
    if !size.width.is_finite()
        || !size.height.is_finite()
        || size.width <= 0.0
        || size.height <= 0.0
    {
        return None;
    }
    Some(SurfaceRect::new(
        Point::new(
            border_box.origin.x + shadow.offset_x - outset,
            border_box.origin.y + shadow.offset_y - outset,
        ),
        size,
    ))
}

pub(in crate::layout::filter::surface) fn box_shadow_overflow(
    size: Size,
    shadows: &[BoxShadow],
    filter_dpi: f32,
) -> Option<EdgeSizes> {
    let border_box = SurfaceRect::new(Point::ORIGIN, size);
    let mut overflow = EdgeSizes::ZERO;
    for shadow in shadows.iter().filter(|shadow| !shadow.inset) {
        let blur = crate::render::blur::box_shadow_blur_overflow(shadow.blur, filter_dpi)?;
        let Some(rect) = outset_shadow_rect(border_box, *shadow, blur) else {
            continue;
        };
        overflow.top = overflow.top.max((-rect.origin.y).max(0.0));
        overflow.left = overflow.left.max((-rect.origin.x).max(0.0));
        overflow.right = overflow.right.max((rect.right() - size.width).max(0.0));
        overflow.bottom = overflow.bottom.max((rect.bottom() - size.height).max(0.0));
    }
    Some(overflow)
}
