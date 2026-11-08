//! CSS filter blur sources for solid boxes and borders.

use super::*;

/// Rasterize a solid-fill box (background colour + border) into a transparent,
/// padded RGBA buffer and return the embeddable result.
pub(crate) fn blur_box(
    width_pt: f32,
    height_pt: f32,
    background: Option<crate::types::Color>,
    border: &LayoutBorder,
    blur_radius_pt: f32,
    filter_dpi: f32,
) -> Option<BlurredRaster> {
    if blur_radius_pt <= 0.0 || width_pt <= 0.0 || height_pt <= 0.0 {
        return None;
    }
    let has_background = background.is_some_and(|color| color.alpha() > 0.0);
    if !has_background && !border.has_visible() {
        return None;
    }

    use resvg::tiny_skia;

    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let kernel = FilterBlurKernel::new(blur_radius_pt, filter_dpi)?;
    let padding = kernel.padding_px;
    let box_x = filter_raster_axis(width_pt, scale)?;
    let box_y = filter_raster_axis(height_pt, scale)?;
    let buffer_width = padded_pixels(box_x.pixels, padding)?;
    let buffer_height = padded_pixels(box_y.pixels, padding)?;

    let mut pixmap = tiny_skia::Pixmap::new(buffer_width, buffer_height)?;
    let origin = padding as f32;
    if let Some(color) = background.filter(|color| color.alpha() > 0.0) {
        let (red, green, blue, alpha) = color.to_f32_rgba();
        let mut paint = tiny_skia::Paint::default();
        paint.set_color(color8(red, green, blue, alpha));
        paint.anti_alias = true;
        let rect = tiny_skia::Rect::from_xywh(origin, origin, box_x.paint_px, box_y.paint_px)?;
        pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
    }
    paint_border_rects(
        &mut pixmap,
        border,
        origin,
        origin,
        box_x.paint_px,
        box_y.paint_px,
        scale,
    );

    let premultiplied = crate::render::raster_pixels::pixmap_to_premultiplied_rgba(&pixmap);
    let rgba = crate::render::raster_pixels::unpremultiply_rgba8(&blur_css_filter_premultiplied(
        &premultiplied,
        kernel,
    )?);
    let overflow_pt = padding as f32 / scale * PT_PER_PX;
    let asset = rgba_to_png_alpha_asset(rgba, filter_dpi)?;
    Some(BlurredRaster { asset, overflow_pt })
}

fn paint_border_rects(
    pixmap: &mut resvg::tiny_skia::Pixmap,
    border: &LayoutBorder,
    origin_x: f32,
    origin_y: f32,
    box_width: f32,
    box_height: f32,
    scale: f32,
) {
    use resvg::tiny_skia;

    let points_to_pixels = scale / PT_PER_PX;
    let sides = [
        (
            0.0,
            0.0,
            box_width,
            (border.top.width * points_to_pixels).min(box_height),
            &border.top,
        ),
        (
            0.0,
            box_height - (border.bottom.width * points_to_pixels).min(box_height),
            box_width,
            (border.bottom.width * points_to_pixels).min(box_height),
            &border.bottom,
        ),
        (
            0.0,
            0.0,
            (border.left.width * points_to_pixels).min(box_width),
            box_height,
            &border.left,
        ),
        (
            box_width - (border.right.width * points_to_pixels).min(box_width),
            0.0,
            (border.right.width * points_to_pixels).min(box_width),
            box_height,
            &border.right,
        ),
    ];
    for (x, y, width, height, side) in sides {
        if !side.paints() || width <= 0.0 || height <= 0.0 {
            continue;
        }
        let mut paint = tiny_skia::Paint::default();
        let (red, green, blue) = side.color.to_f32_rgb();
        paint.set_color(color8(red, green, blue, side.color.alpha()));
        paint.anti_alias = true;
        if let Some(rect) = tiny_skia::Rect::from_xywh(origin_x + x, origin_y + y, width, height) {
            pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
        }
    }
}
