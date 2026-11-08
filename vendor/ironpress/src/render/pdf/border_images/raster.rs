//! Browser-style raster image shaders for repeated `border-image` patches.
//!
//! Skia keeps corner and purely stretched source slices as direct image draws,
//! but resolves repeated raster slices onto a page-aligned one-pixel-per-point
//! surface before the PDF patch clip is applied.  Mirroring that division
//! preserves source pixels while avoiding independently clipped tile seams.

use super::*;
use resvg::tiny_skia;

pub(super) enum RepeatedBorderImage {
    Raster(RasterBorderImage),
    LinearGradient(LinearGradientBorderImage),
}

impl RepeatedBorderImage {
    pub(super) fn resolve(
        source: &ResolvedBorderImageSource<'_>,
        geometry: BorderImageSourceGeometry,
    ) -> Option<Self> {
        match source {
            ResolvedBorderImageSource::Raster(asset) => {
                RasterBorderImage::decode(asset).map(Self::Raster)
            }
            ResolvedBorderImageSource::Linear(gradient) => {
                LinearGradientBorderImage::resolve(gradient, geometry).map(Self::LinearGradient)
            }
            ResolvedBorderImageSource::Radial(_)
            | ResolvedBorderImageSource::Conic(_)
            | ResolvedBorderImageSource::Svg(_) => None,
        }
    }

    pub(super) fn paint_patch(
        &self,
        content: &mut String,
        patch: BorderImagePatch,
        pdf_writer: &mut PdfWriter,
        page_images: &mut Vec<ImageRef>,
    ) -> bool {
        match self {
            Self::Raster(source) => source.paint_patch(content, patch, pdf_writer, page_images),
            Self::LinearGradient(source) => {
                source.paint_patch(content, patch, pdf_writer, page_images)
            }
        }
    }
}

pub(super) struct RasterBorderImage {
    pixels: image::RgbaImage,
}

impl RasterBorderImage {
    pub(super) fn decode(asset: &crate::layout::engine::RasterImageAsset) -> Option<Self> {
        Some(Self {
            pixels: crate::layout::images::decode_asset_to_rgba(asset)?,
        })
    }

    pub(super) fn paint_patch(
        &self,
        content: &mut String,
        patch: BorderImagePatch,
        pdf_writer: &mut PdfWriter,
        page_images: &mut Vec<ImageRef>,
    ) -> bool {
        let Some(page) = pdf_writer.page_content_transform.page_bounds() else {
            return false;
        };
        let Some(canvas) = PageRasterCanvas::new(page) else {
            return false;
        };
        let Some(source) = self.slice(patch.source) else {
            return false;
        };
        let Some(tiling) = patch.tiling() else {
            return false;
        };
        let Some(mut surface) = tiny_skia::Pixmap::new(canvas.size.width, canvas.size.height)
        else {
            return false;
        };
        if !paint_shader_surface(&mut surface, &source, patch, tiling, canvas) {
            return false;
        }
        let rgba = crate::render::raster_pixels::pixmap_to_rgba(&surface);
        paint_page_surface(
            content,
            patch.destination,
            canvas,
            &rgba,
            pdf_writer,
            page_images,
        )
    }

    fn slice(&self, source: PdfRect) -> Option<RasterSlice> {
        let integer = |value: f32| {
            (value.is_finite() && (value - value.round()).abs() <= 1e-5)
                .then_some(value.round() as i64)
                .and_then(|value| u32::try_from(value).ok())
        };
        let x = integer(source.left)?;
        let y = integer(self.pixels.height() as f32 - source.top())?;
        let width = integer(source.width)?;
        let height = integer(source.height)?;
        let right = x.checked_add(width)?;
        let bottom = y.checked_add(height)?;
        if right > self.pixels.width() || bottom > self.pixels.height() {
            return None;
        }
        let pixels = image::imageops::crop_imm(&self.pixels, x, y, width, height).to_image();
        let uniform = pixels
            .pixels()
            .next()
            .copied()
            .filter(|first| pixels.pixels().all(|pixel| pixel == first));
        Some(RasterSlice {
            pixmap: crate::render::raster_pixels::rgba_to_pixmap(&pixels)?,
            uniform,
        })
    }
}

pub(super) struct LinearGradientBorderImage {
    sampler: crate::render::gradient_sampling::LinearGradientSampler,
    source_size: PdfVector,
}

impl LinearGradientBorderImage {
    fn resolve(gradient: &LinearGradient, geometry: BorderImageSourceGeometry) -> Option<Self> {
        let source_size = PdfVector::new(geometry.width, geometry.height);
        let sampler = crate::render::gradient_sampling::LinearGradientSampler::resolve(
            gradient,
            crate::types::Size::new(source_size.x, source_size.y),
        )?;
        Some(Self {
            sampler,
            source_size,
        })
    }

    fn paint_patch(
        &self,
        content: &mut String,
        patch: BorderImagePatch,
        pdf_writer: &mut PdfWriter,
        page_images: &mut Vec<ImageRef>,
    ) -> bool {
        let Some(page) = pdf_writer.page_content_transform.page_bounds() else {
            return false;
        };
        let Some(canvas) = PageRasterCanvas::new(page) else {
            return false;
        };
        let Some(tiling) = patch.tiling() else {
            return false;
        };
        let x = tiling.x.pattern.shader_lattice();
        let y = tiling.y.pattern.shader_lattice();
        let source = patch.source;
        let image = image::RgbaImage::from_fn(canvas.size.width, canvas.size.height, |px, py| {
            let page_x = page.left + (px as f32 + 0.5) / canvas.scale.x;
            let page_y = page.top() - (py as f32 + 0.5) / canvas.scale.y;
            let local_x = x.sample(page_x - tiling.x.destination_start);
            let local_y = y.sample(page_y - tiling.y.destination_start);
            let Some((local_x, local_y)) = local_x.zip(local_y) else {
                return image::Rgba([0, 0, 0, 0]);
            };
            let source_x = source.left + local_x * source.width / x.tile_size();
            let source_y = source.bottom + local_y * source.height / y.tile_size();
            let top_down = crate::types::Point::new(source_x, self.source_size.y - source_y);
            image::Rgba(self.sampler.sample(top_down).to_rgba8())
        });
        paint_page_surface(
            content,
            patch.destination,
            canvas,
            &image,
            pdf_writer,
            page_images,
        )
    }
}

fn paint_page_surface(
    content: &mut String,
    clip: PdfRect,
    canvas: PageRasterCanvas,
    image: &image::RgbaImage,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) -> bool {
    let Some(obj_id) =
        pdf_writer.add_raw_rgba_image_object(image.as_raw(), image.width(), image.height())
    else {
        return false;
    };
    let image = ImageRef {
        name: format!("Im{obj_id}"),
        obj_id,
    };
    content.push_str("q\n");
    content.push_str(&clip.rect_path());
    content.push_str("W n\n");
    content.push_str(&format!(
        "{} 0 0 {} {} {} cm\n/{} Do\nQ\n",
        canvas.page.width, canvas.page.height, canvas.page.left, canvas.page.bottom, image.name
    ));
    page_images.push(image);
    true
}

struct RasterSlice {
    pixmap: tiny_skia::Pixmap,
    uniform: Option<image::Rgba<u8>>,
}

#[derive(Debug, Clone, Copy)]
struct PageRasterCanvas {
    page: PdfRect,
    size: RasterDimensions,
    scale: PdfVector,
}

impl PageRasterCanvas {
    fn new(page: PdfRect) -> Option<Self> {
        let size = RasterDimensions::from_point_scales(page.width, page.height, 1.0, 1.0)?;
        if size.width > MAX_RASTER_TILE_EDGE || size.height > MAX_RASTER_TILE_EDGE {
            return None;
        }
        Some(Self {
            page,
            size,
            scale: PdfVector::new(
                size.width as f32 / page.width,
                size.height as f32 / page.height,
            ),
        })
    }

    fn top_down_rect(self, rect: PdfRect) -> Option<tiny_skia::Rect> {
        // Skia's analytic antialiaser resolves path edges on an eight-bit
        // subpixel grid. Snap absolute raster edges, not dimensions, so a
        // distributed sequence retains its accumulated phase.
        let snap = |value: f32| (value * 256.0).round() / 256.0;
        let left = snap((rect.left - self.page.left) * self.scale.x);
        let right = snap((rect.right() - self.page.left) * self.scale.x);
        let top = snap((self.page.top() - rect.top()) * self.scale.y);
        let bottom = snap((self.page.top() - rect.bottom) * self.scale.y);
        tiny_skia::Rect::from_xywh(left, top, right - left, bottom - top)
    }

    fn top_down_origin(self, rect: PdfRect) -> PdfPoint {
        PdfPoint::new(
            (rect.left - self.page.left) * self.scale.x,
            (self.page.top() - rect.top()) * self.scale.y,
        )
    }
}

fn paint_shader_surface(
    surface: &mut tiny_skia::Pixmap,
    source: &RasterSlice,
    patch: BorderImagePatch,
    tiling: PatchTiling,
    canvas: PageRasterCanvas,
) -> bool {
    let source_pixmap = source.pixmap.as_ref();
    let tile = PdfRect::new(
        tiling.x.destination_start + tiling.x.pattern.first(),
        tiling.y.destination_start + tiling.y.pattern.first(),
        tiling.x.pattern.tile_size(),
        tiling.y.pattern.tile_size(),
    );
    let phase = canvas.top_down_origin(tile);
    let tile_scale = PdfVector::new(
        tile.width * canvas.scale.x / source_pixmap.width() as f32,
        tile.height * canvas.scale.y / source_pixmap.height() as f32,
    );
    if !tile_scale.is_positive() {
        return false;
    }
    let paint = tiny_skia::Paint {
        shader: tiny_skia::Pattern::new(
            source_pixmap,
            tiny_skia::SpreadMode::Repeat,
            tiny_skia::FilterQuality::Bilinear,
            1.0,
            tiny_skia::Transform::from_row(tile_scale.x, 0.0, 0.0, tile_scale.y, phase.x, phase.y),
        ),
        anti_alias: true,
        ..Default::default()
    };

    let horizontal_space = patch.horizontal == BorderImageRepeatMode::Space;
    let vertical_space = patch.vertical == BorderImageRepeatMode::Space;
    if (horizontal_space || vertical_space)
        && let Some(color) = source.uniform
    {
        return paint_uniform_space_surface(
            surface,
            color,
            tiling,
            canvas,
            horizontal_space,
            vertical_space,
        );
    }
    if !horizontal_space && !vertical_space {
        let Some(rect) = tiny_skia::Rect::from_xywh(
            0.0,
            0.0,
            canvas.size.width as f32,
            canvas.size.height as f32,
        ) else {
            return false;
        };
        surface.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
        return true;
    }

    let x_tiles: Vec<_> = if horizontal_space {
        let Some(placements) = tiling.x.pattern.unbounded_lattice().placements(
            canvas.page.left - tiling.x.destination_start,
            canvas.page.right() - tiling.x.destination_start,
        ) else {
            return false;
        };
        placements.collect()
    } else {
        vec![0.0]
    };
    let y_tiles: Vec<_> = if vertical_space {
        let Some(placements) = tiling.y.pattern.unbounded_lattice().placements(
            canvas.page.bottom - tiling.y.destination_start,
            canvas.page.top() - tiling.y.destination_start,
        ) else {
            return false;
        };
        placements.collect()
    } else {
        vec![0.0]
    };
    for x in x_tiles {
        for &y in &y_tiles {
            let tile_rect = PdfRect::new(
                if horizontal_space {
                    tiling.x.destination_start + x
                } else {
                    canvas.page.left
                },
                if vertical_space {
                    tiling.y.destination_start + y
                } else {
                    canvas.page.bottom
                },
                if horizontal_space {
                    tiling.x.pattern.tile_size()
                } else {
                    canvas.page.width
                },
                if vertical_space {
                    tiling.y.pattern.tile_size()
                } else {
                    canvas.page.height
                },
            );
            let Some(rect) = tile_rect
                .intersection(canvas.page)
                .and_then(|rect| canvas.top_down_rect(rect))
            else {
                continue;
            };
            surface.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
        }
    }
    true
}

#[derive(Debug, Clone, Copy)]
struct RasterSpaceAxis {
    anchor: f64,
    stride: f64,
    tile_size: f64,
}

impl RasterSpaceAxis {
    fn horizontal(axis: TiledAxis, canvas: PageRasterCanvas) -> Option<Self> {
        Self::new(
            (axis.destination_start + axis.pattern.first() - canvas.page.left) * canvas.scale.x,
            axis,
            canvas.scale.x,
        )
    }

    fn vertical(axis: TiledAxis, canvas: PageRasterCanvas) -> Option<Self> {
        Self::new(
            (canvas.page.top()
                - axis.destination_start
                - axis.pattern.first()
                - axis.pattern.tile_size())
                * canvas.scale.y,
            axis,
            canvas.scale.y,
        )
    }

    fn new(first: f32, axis: TiledAxis, scale: f32) -> Option<Self> {
        let stride = f64::from(axis.pattern.stride()? * scale);
        let tile_size = f64::from(axis.pattern.tile_size() * scale);
        if !stride.is_finite() || !tile_size.is_finite() || stride <= 0.0 || tile_size <= 0.0 {
            return None;
        }
        // Skia materializes the repeating mask on the page pixel lattice. Its
        // phase is page-aligned, while the repeated advance retains an
        // eight-bit subpixel fraction.
        let stride = (stride * 256.0).round() / 256.0;
        let first = f64::from(first);
        let anchor = (first - (first / stride).round() * stride).round();
        Some(Self {
            anchor,
            stride,
            tile_size,
        })
    }

    fn coverage(self, pixel: u32) -> f64 {
        let start = f64::from(pixel);
        let end = start + 1.0;
        let center_index = ((start - self.anchor) / self.stride).floor();
        let mut coverage = 0.0;
        for delta in [-1.0, 0.0, 1.0] {
            let tile_start = self.anchor + (center_index + delta) * self.stride;
            let tile_end = tile_start + self.tile_size;
            coverage += (end.min(tile_end) - start.max(tile_start)).max(0.0);
        }
        coverage.clamp(0.0, 1.0)
    }
}

fn paint_uniform_space_surface(
    surface: &mut tiny_skia::Pixmap,
    color: image::Rgba<u8>,
    tiling: PatchTiling,
    canvas: PageRasterCanvas,
    horizontal_space: bool,
    vertical_space: bool,
) -> bool {
    let horizontal = if horizontal_space {
        let Some(axis) = RasterSpaceAxis::horizontal(tiling.x, canvas) else {
            return false;
        };
        Some(axis)
    } else {
        None
    };
    let vertical = if vertical_space {
        let Some(axis) = RasterSpaceAxis::vertical(tiling.y, canvas) else {
            return false;
        };
        Some(axis)
    } else {
        None
    };
    let premultiplied =
        tiny_skia::ColorU8::from_rgba(color[0], color[1], color[2], color[3]).premultiply();
    let width = surface.width();
    for (index, pixel) in surface.data_mut().chunks_exact_mut(4).enumerate() {
        let x = index as u32 % width;
        let y = index as u32 / width;
        let coverage = horizontal.map_or(1.0, |axis| axis.coverage(x))
            * vertical.map_or(1.0, |axis| axis.coverage(y));
        let scale = |value: u8| (f64::from(value) * coverage).round() as u8;
        pixel.copy_from_slice(&[
            scale(premultiplied.red()),
            scale(premultiplied.green()),
            scale(premultiplied.blue()),
            scale(premultiplied.alpha()),
        ]);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::RasterSpaceAxis;

    #[test]
    fn page_aligned_space_mask_matches_skia_subpixel_coverage() {
        let axis = RasterSpaceAxis {
            anchor: -1.0,
            stride: 12.976_562_5,
            tile_size: 12.0,
        };

        assert_eq!((axis.coverage(11) * 255.0).round() as u8, 6);
        assert_eq!((axis.coverage(23) * 255.0).round() as u8, 249);
        assert_eq!((axis.coverage(24) * 255.0).round() as u8, 12);
    }
}
