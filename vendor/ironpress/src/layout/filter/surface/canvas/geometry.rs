//! Shared device geometry and subpixel sampling for the filter canvas.

use crate::types::{Point, Rect};

use super::SurfaceRect;

const SAMPLE_OFFSETS: [f32; 4] = [0.125, 0.375, 0.625, 0.875];
const SAMPLE_COUNT: f32 = (SAMPLE_OFFSETS.len() * SAMPLE_OFFSETS.len()) as f32;

/// The fixed subpixel grid shared by curved clips and mixed-color shapes.
pub(super) struct CoverageSamples;

impl CoverageSamples {
    pub(super) fn geometry(
        x: u32,
        y: u32,
        pixels_per_point: f32,
        mut contains: impl FnMut(Point) -> bool,
    ) -> f32 {
        let mut inside = 0_u8;
        for point in Self::points(x, y, pixels_per_point) {
            inside += u8::from(contains(point));
        }
        f32::from(inside) / SAMPLE_COUNT
    }

    pub(super) fn colors(
        x: u32,
        y: u32,
        pixels_per_point: f32,
        mut sample: impl FnMut(Point) -> Option<crate::types::Color>,
    ) -> Option<crate::types::Color> {
        let mut premultiplied = [0.0_f32; 4];
        for point in Self::points(x, y, pixels_per_point) {
            let Some(color) = sample(point) else {
                continue;
            };
            let (red, green, blue, alpha) = color.to_f32_rgba();
            premultiplied[0] += red * alpha;
            premultiplied[1] += green * alpha;
            premultiplied[2] += blue * alpha;
            premultiplied[3] += alpha;
        }
        let alpha = premultiplied[3] / SAMPLE_COUNT;
        (alpha > 0.0).then(|| {
            crate::types::Color::from_srgb(
                premultiplied[0] / premultiplied[3],
                premultiplied[1] / premultiplied[3],
                premultiplied[2] / premultiplied[3],
                alpha,
            )
        })
    }

    fn points(x: u32, y: u32, pixels_per_point: f32) -> impl Iterator<Item = Point> {
        SAMPLE_OFFSETS.into_iter().flat_map(move |offset_y| {
            SAMPLE_OFFSETS.into_iter().map(move |offset_x| {
                Point::new(
                    (x as f32 + offset_x) / pixels_per_point,
                    (y as f32 + offset_y) / pixels_per_point,
                )
            })
        })
    }
}

/// Union of semantic paint primitives emitted into one SourceGraphic.
///
/// This records authored geometry rather than scanning raster alpha. Filter
/// subsets can therefore retain line boxes, transparent colors, and kernel
/// support without keeping an entire mostly-empty element allocation.
#[derive(Clone, Copy, Default)]
pub(in crate::layout::filter::surface) struct PaintBounds(Option<Rect>);

impl PaintBounds {
    pub(in crate::layout::filter::surface) fn include(&mut self, rect: Rect) {
        if rect.size.width <= 0.0
            || rect.size.height <= 0.0
            || !rect.origin.x.is_finite()
            || !rect.origin.y.is_finite()
            || !rect.size.width.is_finite()
            || !rect.size.height.is_finite()
        {
            return;
        }
        self.0 = Some(self.0.map_or(rect, |bounds| bounds.union(rect)));
    }

    pub(in crate::layout::filter::surface) fn include_clipped(&mut self, bounds: Self, clip: Rect) {
        if let Some(bounds) = bounds.0.and_then(|bounds| bounds.intersection(clip)) {
            self.include(bounds);
        }
    }

    pub(in crate::layout::filter::surface) fn clip_to(&mut self, clip: Option<Rect>) {
        self.0 = self
            .0
            .and_then(|bounds| clip.and_then(|clip| bounds.intersection(clip)));
    }

    pub(in crate::layout::filter::surface) fn include_transformed(
        &mut self,
        bounds: Self,
        transform: crate::style::computed::CssAffineMatrix,
    ) {
        if let Some(bounds) = bounds.0 {
            self.include(transform.enclosing_rect(bounds));
        }
    }

    pub(in crate::layout::filter::surface) const fn resolve(self) -> Option<Rect> {
        self.0
    }
}

#[derive(Clone, Copy)]
pub(super) struct DeviceRect {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl DeviceRect {
    pub(super) fn from_surface(rect: SurfaceRect, scale: f32) -> Self {
        Self {
            left: rect.origin.x * scale,
            top: rect.origin.y * scale,
            right: rect.right() * scale,
            bottom: rect.bottom() * scale,
        }
    }

    pub(super) fn pixel_coverage(self, x: u32, y: u32) -> f32 {
        interval_coverage(x, self.left, self.right) * interval_coverage(y, self.top, self.bottom)
    }
}

#[derive(Clone, Copy)]
pub(super) struct DeviceClip {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl DeviceClip {
    pub(super) const fn full(canvas: (u32, u32)) -> Self {
        Self {
            left: 0,
            top: 0,
            right: canvas.0 as i32,
            bottom: canvas.1 as i32,
        }
    }

    pub(super) fn from_rect(rect: Rect, scale: f32, canvas: (u32, u32)) -> Self {
        Self {
            left: (rect.origin.x * scale).floor().max(0.0) as i32,
            top: (rect.origin.y * scale).floor().max(0.0) as i32,
            right: (rect.right() * scale).ceil().min(canvas.0 as f32) as i32,
            bottom: (rect.bottom() * scale).ceil().min(canvas.1 as f32) as i32,
        }
    }

    pub(super) fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

pub(super) fn interval_coverage(pixel: u32, start: f32, end: f32) -> f32 {
    ((pixel as f32 + 1.0).min(end) - (pixel as f32).max(start)).clamp(0.0, 1.0)
}

pub(super) fn device_floor(points: f32, scale: f32, maximum: u32) -> u32 {
    (points * scale).floor().clamp(0.0, maximum as f32) as u32
}

pub(super) fn device_ceil(points: f32, scale: f32, maximum: u32) -> u32 {
    (points * scale).ceil().clamp(0.0, maximum as f32) as u32
}
