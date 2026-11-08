//! CSS image scaling before filter compositing.

use super::*;

/// Rasterize a decoded image at its painted content-box size and the configured
/// filter resolution. CSS filter functions operate on this painted image, not
/// on the source bitmap's intrinsic pixel grid.
pub(crate) fn rasterize_image_buffer(
    source: &image::RgbaImage,
    display_w_pt: f32,
    display_h_pt: f32,
    image_rendering: ImageRendering,
    filter_dpi: f32,
) -> Option<image::RgbaImage> {
    if source.width() == 0 || source.height() == 0 || display_w_pt <= 0.0 || display_h_pt <= 0.0 {
        return None;
    }
    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let width = filter_raster_pixels(display_w_pt, scale)?;
    let height = filter_raster_pixels(display_h_pt, scale)?;
    let css_scaled = if image_rendering.is_pixelated() {
        pixelated_image_at_css_size(source, display_w_pt, display_h_pt)?
    } else {
        source.clone()
    };
    Some(resize_image_for_display(
        &css_scaled,
        width,
        height,
        image_rendering,
    ))
}

/// Apply CSS Images' `pixelated` operation in CSS image coordinates. The
/// physical PDF/filter backing scale is intentionally applied later: it is an
/// output-quality decision, not a second CSS resize.
pub(crate) fn pixelated_image_at_css_size(
    source: &image::RgbaImage,
    display_w_pt: f32,
    display_h_pt: f32,
) -> Option<image::RgbaImage> {
    if source.width() == 0 || source.height() == 0 || display_w_pt <= 0.0 || display_h_pt <= 0.0 {
        return None;
    }
    let target_width = css_image_pixels(display_w_pt)?;
    let target_height = css_image_pixels(display_h_pt)?;
    let integer_width = nearest_pixelated_multiple(source.width(), display_w_pt);
    let integer_height = nearest_pixelated_multiple(source.height(), display_h_pt);
    let integer_scaled = image::imageops::resize(
        source,
        integer_width,
        integer_height,
        image::imageops::FilterType::Nearest,
    );
    Some(resize_rgba_smooth(
        &integer_scaled,
        target_width,
        target_height,
    ))
}

/// Smoothly resize a transparent raster in CSS image coordinates.
///
/// The `image` crate's triangle kernel samples just beyond an exactly aligned
/// transparent edge when shrinking. CSS Images' `pixelated` algorithm requires
/// its second stage to be smooth, but it must not grow a source alpha silhouette
/// whose integral-multiple boundary maps exactly to the target grid. Sampling
/// pixel centres with premultiplied bilinear interpolation preserves that
/// boundary and prevents transparent RGB from creating a coloured fringe.
fn resize_rgba_smooth(
    source: &image::RgbaImage,
    target_width: u32,
    target_height: u32,
) -> image::RgbaImage {
    let (source_width, source_height) = source.dimensions();
    if (source_width, source_height) == (target_width, target_height) {
        return source.clone();
    }
    let mut output = image::RgbaImage::new(target_width, target_height);
    for y in 0..target_height {
        let (top, bottom, vertical) = bilinear_axis(source_height, target_height, y);
        for x in 0..target_width {
            let (left, right, horizontal) = bilinear_axis(source_width, target_width, x);
            let top_left = premultiplied_pixel(source.get_pixel(left, top));
            let top_right = premultiplied_pixel(source.get_pixel(right, top));
            let bottom_left = premultiplied_pixel(source.get_pixel(left, bottom));
            let bottom_right = premultiplied_pixel(source.get_pixel(right, bottom));
            let top = interpolate_premultiplied(top_left, top_right, horizontal);
            let bottom = interpolate_premultiplied(bottom_left, bottom_right, horizontal);
            output.put_pixel(
                x,
                y,
                unpremultiply_pixel(interpolate_premultiplied(top, bottom, vertical)),
            );
        }
    }
    output
}

/// Return the source pixels surrounding a destination pixel centre and the
/// interpolation weight toward the latter one.
fn bilinear_axis(source_len: u32, target_len: u32, target_index: u32) -> (u32, u32, f32) {
    if source_len <= 1 || target_len == 0 {
        return (0, 0, 0.0);
    }
    let position = (((target_index as f32 + 0.5) * source_len as f32 / target_len as f32) - 0.5)
        .clamp(0.0, source_len.saturating_sub(1) as f32);
    let first = position.floor() as u32;
    let second = (first + 1).min(source_len - 1);
    (first, second, position - first as f32)
}

fn premultiplied_pixel(pixel: &image::Rgba<u8>) -> [f32; 4] {
    let alpha = f32::from(pixel[3]) / 255.0;
    [
        f32::from(pixel[0]) * alpha,
        f32::from(pixel[1]) * alpha,
        f32::from(pixel[2]) * alpha,
        alpha,
    ]
}

fn interpolate_premultiplied(start: [f32; 4], end: [f32; 4], amount: f32) -> [f32; 4] {
    std::array::from_fn(|channel| start[channel] + (end[channel] - start[channel]) * amount)
}

fn unpremultiply_pixel(pixel: [f32; 4]) -> image::Rgba<u8> {
    let alpha = pixel[3].clamp(0.0, 1.0);
    if alpha == 0.0 {
        return image::Rgba([0, 0, 0, 0]);
    }
    image::Rgba([
        (pixel[0] / alpha).round().clamp(0.0, 255.0) as u8,
        (pixel[1] / alpha).round().clamp(0.0, 255.0) as u8,
        (pixel[2] / alpha).round().clamp(0.0, 255.0) as u8,
        (alpha * 255.0).round().clamp(0.0, 255.0) as u8,
    ])
}

fn css_image_pixels(display_axis_pt: f32) -> Option<u32> {
    let pixels = display_axis_pt / PT_PER_PX;
    (pixels.is_finite() && pixels > 0.0).then(|| pixels.round().clamp(1.0, u32::MAX as f32) as u32)
}

/// Rasterize a CSS-scaled image into a physical target surface.
pub(crate) fn resize_image_for_display(
    source: &image::RgbaImage,
    target_width: u32,
    target_height: u32,
    image_rendering: ImageRendering,
) -> image::RgbaImage {
    match image_rendering {
        ImageRendering::Pixelated | ImageRendering::CrispEdges => {
            resize_nearest_center(source, target_width, target_height)
        }
        ImageRendering::Smooth => image::imageops::resize(
            source,
            target_width,
            target_height,
            image::imageops::FilterType::Triangle,
        ),
        ImageRendering::HighQuality => image::imageops::resize(
            source,
            target_width,
            target_height,
            image::imageops::FilterType::Lanczos3,
        ),
        // CSS leaves the UA's `auto` algorithm open. Retain Ironpress's
        // established nearest-centre choice so this new property does not alter
        // existing documents that did not opt into a scaling preference.
        ImageRendering::Auto => resize_nearest_center(source, target_width, target_height),
    }
}

fn nearest_pixelated_multiple(source_axis: u32, display_axis_pt: f32) -> u32 {
    let target_css_px = display_axis_pt / PT_PER_PX;
    let multiple = (target_css_px / source_axis as f32).round().max(1.0);
    (source_axis as f32 * multiple)
        .round()
        .clamp(1.0, u32::MAX as f32) as u32
}

fn resize_nearest_center(source: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    let (sw, sh) = (source.width(), source.height());
    let mut out = image::RgbaImage::new(width, height);
    if sw == 0 || sh == 0 || width == 0 || height == 0 {
        return out;
    }
    for y in 0..height {
        let sy = (((y as f32 + 0.5) * sh as f32 / height as f32).floor() as u32)
            .min(sh.saturating_sub(1));
        for x in 0..width {
            let sx = (((x as f32 + 0.5) * sw as f32 / width as f32).floor() as u32)
                .min(sw.saturating_sub(1));
            out.put_pixel(x, y, *source.get_pixel(sx, sy));
        }
    }
    out
}
