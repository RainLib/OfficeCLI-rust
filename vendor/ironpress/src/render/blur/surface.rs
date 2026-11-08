//! Padding, blurring, and encoding of an already-painted filter surface.

use super::*;

/// Encode an already-built blurred RGBA buffer + overflow into a `BlurredRaster`.
pub(crate) fn raster_from_buffer(
    buf: image::RgbaImage,
    overflow_pt: f32,
    filter_dpi: f32,
) -> Option<BlurredRaster> {
    let asset = rgba_to_png_alpha_asset(buf, filter_dpi)?;
    Some(BlurredRaster { asset, overflow_pt })
}

/// Blur an already-painted RGBA buffer and return the padded pixels. Unlike
/// [`blur_painted_buffer`], this keeps the buffer decoded so later filter-list
/// functions can run after the blur in CSS source order.
pub(crate) fn blur_painted_buffer_to_rgba(
    source: &image::RgbaImage,
    blur_radius_pt: f32,
    filter_dpi: f32,
) -> Option<(image::RgbaImage, f32)> {
    if source.width() == 0 || source.height() == 0 || blur_radius_pt <= 0.0 {
        return None;
    }
    let s = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let kernel = FilterBlurKernel::new(blur_radius_pt, filter_dpi)?;
    let pad = kernel.padding_px;
    let padded_w = padded_pixels(source.width(), pad)?;
    let padded_h = padded_pixels(source.height(), pad)?;
    let mut padded = image::RgbaImage::new(padded_w, padded_h);
    image::imageops::replace(&mut padded, source, pad as i64, pad as i64);
    let blurred = blur_css_filter(&padded, kernel)?;
    let overflow_pt = pad as f32 / s * PT_PER_PX;
    Some((blurred, overflow_pt))
}

/// Blur a premultiplied SourceGraphic without crossing an unnecessary
/// straight-alpha quantization boundary.
pub(crate) fn blur_premultiplied_buffer(
    source: &crate::render::raster_pixels::PremultipliedRgba8,
    blur_radius_pt: f32,
    filter_dpi: f32,
) -> Option<(crate::render::raster_pixels::PremultipliedRgba8, f32)> {
    if source.width() == 0 || source.height() == 0 || blur_radius_pt <= 0.0 {
        return None;
    }
    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let kernel = FilterBlurKernel::new(blur_radius_pt, filter_dpi)?;
    let padding = kernel.padding_px;
    let mut padded = crate::render::raster_pixels::PremultipliedRgba8::transparent(
        padded_pixels(source.width(), padding)?,
        padded_pixels(source.height(), padding)?,
    );
    image::imageops::replace(
        padded.as_image_mut(),
        source.as_image(),
        i64::from(padding),
        i64::from(padding),
    );
    let blurred = blur_css_filter_premultiplied(padded.as_image(), kernel)?;
    let overflow = padding as f32 / scale * PT_PER_PX;
    Some((
        crate::render::raster_pixels::PremultipliedRgba8::from_encoded(blurred),
        overflow,
    ))
}

/// Blur an already-painted border-box RGBA buffer at filter resolution, padding
/// transparent pixels around it so the CSS filter can feather outside the box.
pub(crate) fn blur_painted_buffer(
    source: &image::RgbaImage,
    blur_radius_pt: f32,
    filter_dpi: f32,
) -> Option<BlurredRaster> {
    if source.width() == 0 || source.height() == 0 || blur_radius_pt <= 0.0 {
        return None;
    }
    let (blurred, overflow_pt) = blur_painted_buffer_to_rgba(source, blur_radius_pt, filter_dpi)?;
    raster_from_buffer(blurred, overflow_pt, filter_dpi)
}
