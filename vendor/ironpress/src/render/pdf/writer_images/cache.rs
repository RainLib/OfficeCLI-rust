use sha2::{Digest, Sha256};

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(in crate::render::pdf) struct LayoutImageCacheKey {
    source: [u8; 32],
    display_width: u32,
    display_height: u32,
    rendering: crate::style::computed::ImageRendering,
}

impl LayoutImageCacheKey {
    pub(super) fn new(
        image: &crate::layout::engine::RasterImageAsset,
        display_width: f32,
        display_height: f32,
        rendering: crate::style::computed::ImageRendering,
    ) -> Self {
        let mut source = Sha256::new();
        source.update(b"ironpress-layout-image-v1");
        source.update(image.source_width.to_be_bytes());
        source.update(image.source_height.to_be_bytes());
        source.update([match image.format {
            ImageFormat::Jpeg => 0,
            ImageFormat::Png => 1,
            ImageFormat::PngAlpha => 2,
        }]);
        if let Some(metadata) = &image.png_metadata {
            source.update([1, metadata.channels, metadata.bit_depth]);
        } else {
            source.update([0]);
        }
        match image.origin {
            crate::layout::engine::RasterImageOrigin::Source => source.update([0]),
            crate::layout::engine::RasterImageOrigin::Rendered(density) => {
                source.update([1]);
                source.update(density.dpi().to_bits().to_be_bytes());
            }
        }
        source.update(&image.data);
        Self {
            source: source.finalize().into(),
            display_width: display_width.to_bits(),
            display_height: display_height.to_bits(),
            rendering,
        }
    }
}
