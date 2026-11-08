use super::*;

/// One exact sampling grid for a mask's point-space paint area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MaskRasterGrid {
    pub(super) pixels: RasterDimensions,
    pub(super) width_pt: f32,
    pub(super) height_pt: f32,
}

impl MaskRasterGrid {
    pub(super) fn new(pixels: RasterDimensions, width_pt: f32, height_pt: f32) -> Option<Self> {
        if pixels.width == 0
            || pixels.height == 0
            || !width_pt.is_finite()
            || !height_pt.is_finite()
            || width_pt <= 0.0
            || height_pt <= 0.0
        {
            return None;
        }
        let scale_x = pixels.width as f32 / width_pt;
        let scale_y = pixels.height as f32 / height_pt;
        (scale_x.is_finite() && scale_y.is_finite() && scale_x > 0.0 && scale_y > 0.0).then_some(
            Self {
                pixels,
                width_pt,
                height_pt,
            },
        )
    }

    #[cfg(test)]
    pub(super) fn full_window(self) -> MaskRasterWindow {
        MaskRasterWindow {
            grid: self,
            tile: RasterTile {
                x: 0,
                y: 0,
                width: self.pixels.width,
                height: self.pixels.height,
            },
        }
    }

    pub(super) fn window(self, tile: RasterTile) -> Option<MaskRasterWindow> {
        (tile.width > 0
            && tile.height > 0
            && tile.x.checked_add(tile.width)? <= self.pixels.width
            && tile.y.checked_add(tile.height)? <= self.pixels.height)
            .then_some(MaskRasterWindow { grid: self, tile })
    }

    pub(super) fn scale_x(self) -> f32 {
        self.pixels.width as f32 / self.width_pt
    }

    pub(super) fn scale_y(self) -> f32 {
        self.pixels.height as f32 / self.height_pt
    }

    pub(super) fn dimensions_for_points(
        self,
        width_pt: f32,
        height_pt: f32,
    ) -> Option<RasterDimensions> {
        RasterDimensions::from_point_scales(width_pt, height_pt, self.scale_x(), self.scale_y())
    }
}

/// A bounded top-down window into a [`MaskRasterGrid`]. Sampling coordinates
/// remain global to the full grid; only storage is window-local.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MaskRasterWindow {
    pub(super) grid: MaskRasterGrid,
    pub(super) tile: RasterTile,
}

impl MaskRasterWindow {
    pub(super) fn len(self) -> Option<usize> {
        usize::try_from(self.tile.width.checked_mul(self.tile.height)?).ok()
    }

    pub(super) fn global_x(self, local_x: u32) -> f32 {
        (self.tile.x + local_x) as f32 + 0.5
    }

    pub(super) fn global_y(self, local_y: u32) -> f32 {
        (self.tile.y + local_y) as f32 + 0.5
    }

    pub(super) fn user_x(self, local_x: u32, user_width: f32) -> f32 {
        self.global_x(local_x) * user_width / self.grid.pixels.width as f32
    }

    pub(super) fn user_y(self, local_y: u32, user_height: f32) -> f32 {
        self.global_y(local_y) * user_height / self.grid.pixels.height as f32
    }
}

/// Reduce a sampled gradient color to a single mask-coverage byte (0..255)
/// following `mask-mode` (css-masking-1 §3.4). `match-source` on a CSS gradient
/// resolves to alpha. Luminance uses the Rec.709 coefficients premultiplied by
/// alpha.
pub(super) fn coverage_fraction(
    rgba: (f32, f32, f32, f32),
    mode: crate::style::computed::MaskMode,
) -> f32 {
    use crate::style::computed::MaskMode;
    let (r, g, b, a) = rgba;
    let cov = match mode {
        MaskMode::Luminance => (0.2126 * r + 0.7152 * g + 0.0722 * b) * a,
        // `alpha` and `match-source` (CSS image) both use the source alpha.
        MaskMode::Alpha | MaskMode::MatchSource => a,
    };
    cov.clamp(0.0, 1.0)
}

pub(super) fn coverage_byte(
    rgba: (f32, f32, f32, f32),
    mode: crate::style::computed::MaskMode,
) -> u8 {
    (coverage_fraction(rgba, mode) * 255.0).round() as u8
}
