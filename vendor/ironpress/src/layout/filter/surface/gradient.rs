//! Background painting supported by the filter `SourceGraphic` compositor.

use super::canvas::{RasterCanvas, SurfaceRect};
use crate::layout::elements::{BackgroundPaint, BoxModel};
use crate::render::background::{BackgroundBleed, BackgroundTilePattern};
use crate::render::borders::CssRoundedRect;
use crate::render::gradient_sampling::LinearGradientSampler;
use crate::style::computed::{
    BackgroundAttachment, BackgroundClip, BackgroundOrigin, BlendMode, BorderImagePaint,
    LinearGradient,
};
use crate::types::{Color, CornerRadii, Point};

/// A solid background color and the box that clips it.
struct BackgroundColor {
    color: Color,
    clip: CssRoundedRect,
}

/// A resolved linear-gradient layer ready for point-space sampling.
struct LinearGradientLayer {
    sampler: LinearGradientSampler,
    tiles: BackgroundTilePattern,
    positioning_area: SurfaceRect,
    clip: CssRoundedRect,
}

impl LinearGradientLayer {
    fn resolve(
        gradient: &LinearGradient,
        background: &BackgroundPaint,
        model: &BoxModel,
        border_box: SurfaceRect,
        radii: CornerRadii,
        border_image: Option<&BorderImagePaint>,
    ) -> Option<Self> {
        let layer = gradient
            .layer_box
            .with_fallback(background.layers.gradient_layer_box());
        if layer.attachment != Some(BackgroundAttachment::Scroll) {
            return None;
        }
        let positioning_area = background_origin_box(
            border_box,
            model,
            layer.origin.unwrap_or(BackgroundOrigin::Padding),
        );
        let clip = background_clip_box(
            border_box,
            model,
            layer.clip.unwrap_or(BackgroundClip::Border),
            radii,
            border_image,
        )?;
        let tiles = BackgroundTilePattern::resolve(
            layer.size.unwrap_or_default(),
            layer.position.unwrap_or_default(),
            layer.repeat.unwrap_or_default(),
            positioning_area.size,
        )?;
        Some(Self {
            sampler: LinearGradientSampler::resolve(gradient, tiles.tile_size())?,
            tiles,
            positioning_area,
            clip,
        })
    }

    fn paint(&self, canvas: &mut RasterCanvas<'_>) {
        canvas.paint_rounded(self.clip, |point| {
            let local = self.tiles.sample(Point::new(
                point.x - self.positioning_area.origin.x,
                point.y - self.positioning_area.origin.y,
            ))?;
            Some(self.sampler.sample(local))
        });
    }
}

/// Complete background subset that can be faithfully painted into one filter
/// source. Unsupported image geometries reject the group before any pixels are
/// emitted, allowing the caller to use its existing non-composited fallback.
pub(super) struct FilterBackground {
    color: Option<BackgroundColor>,
    linear_gradient: Option<LinearGradientLayer>,
}

impl FilterBackground {
    pub(super) fn resolve(
        background: &BackgroundPaint,
        model: &BoxModel,
        border_box: SurfaceRect,
        radii: CornerRadii,
        border_image: Option<&BorderImagePaint>,
    ) -> Option<Self> {
        if border_image.is_some()
            || background.blend_mode != BlendMode::Normal
            || background.layers.radial_gradient.is_some()
            || background.layers.conic_gradient.is_some()
            || background.layers.svg.is_some()
            || background.layers.raster_source.is_some()
            || background.layers.blur_radius != 0.0
        {
            return None;
        }
        let color = match background.color {
            Some(color) => Some(BackgroundColor {
                color,
                clip: background_clip_box(
                    border_box,
                    model,
                    background.layers.clip,
                    radii,
                    border_image,
                )?,
            }),
            None => None,
        };
        let linear_gradient = match background.layers.gradient.as_ref() {
            Some(gradient) => Some(LinearGradientLayer::resolve(
                gradient,
                background,
                model,
                border_box,
                radii,
                border_image,
            )?),
            None => None,
        };
        Some(Self {
            color,
            linear_gradient,
        })
    }

    pub(super) fn paint(&self, canvas: &mut RasterCanvas<'_>) {
        if let Some(background) = &self.color {
            if background.clip.radii.is_zero() {
                canvas.fill(background.clip.rect, background.color);
            } else {
                canvas.fill_rounded(background.clip, background.color);
            }
        }
        if let Some(gradient) = &self.linear_gradient {
            gradient.paint(canvas);
        }
    }
}

fn background_origin_box(
    border_box: SurfaceRect,
    model: &BoxModel,
    origin: BackgroundOrigin,
) -> SurfaceRect {
    match origin {
        BackgroundOrigin::Border => border_box,
        BackgroundOrigin::Padding => border_box.inset(model.border.widths()),
        BackgroundOrigin::Content => border_box.inset(model.border.widths() + model.padding),
    }
}

fn background_clip_box(
    border_box: SurfaceRect,
    model: &BoxModel,
    clip: BackgroundClip,
    radii: CornerRadii,
    border_image: Option<&BorderImagePaint>,
) -> Option<CssRoundedRect> {
    let border_shape = CssRoundedRect::new(border_box, radii);
    let bleed =
        BackgroundBleed::from_decoration(&model.border, border_image).clip_insets(clip, radii);
    match clip {
        BackgroundClip::Border => Some(border_shape.inset(bleed)),
        BackgroundClip::Padding => Some(border_shape.inset(model.border.widths())),
        BackgroundClip::Content => Some(border_shape.inset(model.border.widths() + model.padding)),
        BackgroundClip::Text => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::LayoutBorderSide;
    use crate::style::computed::BorderStyle;
    use crate::types::{EdgeSizes, PhysicalEdges, Size};

    #[test]
    fn filter_background_uses_shared_opaque_border_bleed_geometry() {
        let model = BoxModel {
            border: PhysicalEdges::uniform(LayoutBorderSide {
                width: 6.0,
                color: Color::BLACK,
                style: BorderStyle::Double,
            }),
            ..Default::default()
        };
        let border_box = SurfaceRect::new(Point::ORIGIN, Size::new(100.0, 80.0));
        let radii = CornerRadii::circular(12.0);

        assert_eq!(
            background_clip_box(border_box, &model, BackgroundClip::Border, radii, None,),
            Some(CssRoundedRect::new(border_box, radii).inset(EdgeSizes::uniform(1.0)))
        );
    }
}
