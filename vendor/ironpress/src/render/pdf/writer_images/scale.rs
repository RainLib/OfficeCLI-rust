/// Positive source-to-CSS scale on each raster axis.
///
/// Once parsed, this carries the proof needed to decide whether CSS
/// `image-rendering: pixelated` needs its smooth second stage.
#[derive(Clone, Copy)]
pub(super) struct CssRasterScale {
    horizontal: f32,
    vertical: f32,
}

impl CssRasterScale {
    pub(super) fn parse(
        source_width: u32,
        source_height: u32,
        display_width: f32,
        display_height: f32,
    ) -> Option<Self> {
        if source_width == 0 || source_height == 0 {
            return None;
        }
        let horizontal = display_width / crate::fonts::PT_PER_CSS_PX / source_width as f32;
        let vertical = display_height / crate::fonts::PT_PER_CSS_PX / source_height as f32;
        (horizontal.is_finite() && vertical.is_finite() && horizontal > 0.0 && vertical > 0.0)
            .then_some(Self {
                horizontal,
                vertical,
            })
    }

    pub(super) fn is_integral_multiple(self) -> bool {
        let integral = |scale: f32| scale >= 1.0 && (scale - scale.round()).abs() <= 1e-5;
        integral(self.horizontal) && integral(self.vertical)
    }
}
