//! Resolved clip-path coverage inside an ancestor filter SourceGraphic.
//!
//! A root clip remains a post-filter effect. A clipped descendant, however,
//! contributes its already-clipped group to an ancestor's SourceGraphic. This
//! module resolves every supported CSS basic shape once into the same
//! Skia-derived raster path used by other renderer-owned coverage masks.

use crate::layout::elements::BoxReferenceGeometry;
use crate::render::curves::{CurveTolerance, EllipsePath, RoundedRectPath, TinySkiaCurveSink};
use crate::render::raster_pixels::PremultipliedRgba8;
use crate::style::computed::ClipPath;
use crate::types::{Point, Rect, Vector};
use resvg::tiny_skia::{FillRule, Mask, Path, PathBuilder, Transform};

struct RasterClipPath {
    path: Path,
    fill_rule: FillRule,
    bounds: Rect,
}

/// One parsed clip-path resolved against a concrete box reference geometry.
///
/// `path: None` is the meaningful empty-clip state. Unsupported URL references
/// never construct this type because their SVG definition context is not part
/// of a layout-owned SourceGraphic.
pub(super) struct SourceClip {
    path: Option<RasterClipPath>,
}

impl SourceClip {
    pub(super) fn resolve(
        clip: &ClipPath,
        border_box: Rect,
        reference: &dyn BoxReferenceGeometry,
    ) -> Option<Self> {
        match clip {
            ClipPath::Circle {
                r,
                cx,
                cy,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let center_offset = Point::new(
                    cx.resolve(reference.size.width),
                    cy.resolve(reference.size.height),
                );
                let radius = r.resolve_circle(
                    reference.size.width,
                    reference.size.height,
                    center_offset.x,
                    center_offset.y,
                );
                let center = reference.origin + (center_offset - Point::ORIGIN);
                Some(Self::ellipse(center, Vector::new(radius, radius)))
            }
            ClipPath::Ellipse {
                rx,
                ry,
                cx,
                cy,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let center_offset = Point::new(
                    cx.resolve(reference.size.width),
                    cy.resolve(reference.size.height),
                );
                let radii = Vector::new(
                    rx.resolve_ellipse_axis(
                        reference.size.width,
                        reference.size.height,
                        center_offset.x,
                    ),
                    ry.resolve_ellipse_axis(
                        reference.size.height,
                        reference.size.width,
                        center_offset.y,
                    ),
                );
                let center = reference.origin + (center_offset - Point::ORIGIN);
                Some(Self::ellipse(center, radii))
            }
            ClipPath::Inset {
                top,
                right,
                bottom,
                left,
                radii,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let rect = Rect::from_xywh(
                    reference.origin.x + left.resolve(reference.size.width),
                    reference.origin.y + top.resolve(reference.size.height),
                    reference.size.width
                        - left.resolve(reference.size.width)
                        - right.resolve(reference.size.width),
                    reference.size.height
                        - top.resolve(reference.size.height)
                        - bottom.resolve(reference.size.height),
                );
                Some(Self::rounded_rect(rect, *radii))
            }
            ClipPath::Polygon {
                points,
                even_odd,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let mut builder =
                    PathBuilder::with_capacity(points.len().saturating_add(1), points.len());
                for (index, (x, y)) in points.iter().enumerate() {
                    let point = Point::new(
                        reference.origin.x + x.resolve(reference.size.width),
                        reference.origin.y + y.resolve(reference.size.height),
                    );
                    if index == 0 {
                        builder.move_to(point.x, point.y);
                    } else {
                        builder.line_to(point.x, point.y);
                    }
                }
                builder.close();
                Some(Self::from_builder(
                    builder,
                    if *even_odd {
                        FillRule::EvenOdd
                    } else {
                        FillRule::Winding
                    },
                ))
            }
            ClipPath::Path {
                commands,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let mut builder = PathBuilder::new();
                for command in commands {
                    append_svg_command(&mut builder, command, reference.origin);
                }
                Some(Self::from_builder(builder, FillRule::Winding))
            }
            ClipPath::Rect {
                x,
                y,
                width,
                height,
                radii,
                geometry_box,
            } => {
                let reference = reference.shape_box(border_box, *geometry_box);
                let rect = Rect::from_xywh(
                    reference.origin.x + x.resolve(reference.size.width),
                    reference.origin.y + y.resolve(reference.size.height),
                    width.resolve(reference.size.width),
                    height.resolve(reference.size.height),
                );
                Some(Self::rounded_rect(rect, *radii))
            }
            ClipPath::Url(_) => None,
        }
    }

    fn ellipse(center: Point, radii: Vector) -> Self {
        let mut builder = PathBuilder::new();
        if let Some(ellipse) = EllipsePath::new(center, radii) {
            ellipse.write_to(
                &mut TinySkiaCurveSink::new(&mut builder),
                CurveTolerance::RASTER_PIXEL,
            );
        }
        Self::from_builder(builder, FillRule::Winding)
    }

    fn rounded_rect(rect: Rect, radii: crate::types::CornerRadii) -> Self {
        let mut builder = PathBuilder::new();
        if rect.size.width > 0.0 && rect.size.height > 0.0 {
            RoundedRectPath::new(rect, radii).write_to(
                &mut TinySkiaCurveSink::new(&mut builder),
                CurveTolerance::RASTER_PIXEL,
            );
        }
        Self::from_builder(builder, FillRule::Winding)
    }

    fn from_builder(builder: PathBuilder, fill_rule: FillRule) -> Self {
        let path = builder.finish().and_then(|path| {
            let bounds = path.bounds();
            let bounds =
                Rect::from_xywh(bounds.left(), bounds.top(), bounds.width(), bounds.height());
            (bounds.size.width > 0.0 && bounds.size.height > 0.0).then_some(RasterClipPath {
                path,
                fill_rule,
                bounds,
            })
        });
        Self { path }
    }

    pub(super) fn apply(
        &self,
        pixels: &mut PremultipliedRgba8,
        pixels_per_point: f32,
    ) -> Option<()> {
        let Some(path) = &self.path else {
            pixels
                .as_image_mut()
                .pixels_mut()
                .for_each(|pixel| *pixel = image::Rgba([0, 0, 0, 0]));
            return Some(());
        };
        let mut mask = Mask::new(pixels.width(), pixels.height())?;
        mask.fill_path(
            &path.path,
            path.fill_rule,
            true,
            Transform::from_scale(pixels_per_point, pixels_per_point),
        );
        apply_mask(pixels, &mask);
        Some(())
    }

    pub(super) fn bounds(&self) -> Option<Rect> {
        self.path.as_ref().map(|path| path.bounds)
    }
}

fn append_svg_command(
    builder: &mut PathBuilder,
    command: &crate::parser::svg::PathCommand,
    origin: Point,
) {
    const CSS_TO_POINT: f32 = 0.75;
    let point =
        |x: f32, y: f32| Point::new(origin.x + x * CSS_TO_POINT, origin.y + y * CSS_TO_POINT);
    match command {
        crate::parser::svg::PathCommand::MoveTo(x, y) => {
            let point = point(*x, *y);
            builder.move_to(point.x, point.y);
        }
        crate::parser::svg::PathCommand::LineTo(x, y) => {
            let point = point(*x, *y);
            builder.line_to(point.x, point.y);
        }
        crate::parser::svg::PathCommand::CubicTo(x1, y1, x2, y2, x, y) => {
            let first = point(*x1, *y1);
            let second = point(*x2, *y2);
            let end = point(*x, *y);
            builder.cubic_to(first.x, first.y, second.x, second.y, end.x, end.y);
        }
        crate::parser::svg::PathCommand::QuadTo(x1, y1, x, y) => {
            let control = point(*x1, *y1);
            let end = point(*x, *y);
            builder.quad_to(control.x, control.y, end.x, end.y);
        }
        crate::parser::svg::PathCommand::ClosePath => builder.close(),
    }
}

fn apply_mask(pixels: &mut PremultipliedRgba8, mask: &Mask) {
    for (pixel, coverage) in pixels
        .as_image_mut()
        .pixels_mut()
        .zip(mask.data().iter().copied())
    {
        let scale = u16::from(coverage) + 1;
        *pixel = image::Rgba(
            pixel
                .0
                .map(|channel| ((u16::from(channel) * scale) >> 8) as u8),
        );
    }
}

#[cfg(test)]
mod tests;
