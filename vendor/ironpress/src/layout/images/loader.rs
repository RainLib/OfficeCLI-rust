use crate::layout::elements::{
    Image, ImagePaint, ImageSampling, IntoLayoutNode, LayoutNode, Positioning, ReplacedGeometry,
    Svg, SvgPaint,
};
use crate::layout::engine::{ImageFormat, LayoutBorder, PngMetadata, RasterImageAsset};
use crate::layout::flow_metrics::BlockMargins;
use crate::parser::dom::ElementNode;
use crate::parser::png;
use crate::security::resources::ResourceLoader;
use crate::style::computed::ComputedStyle;
use crate::types::Size;

use super::placement::{ReplacedBoxSize, parse_html_image_dimension};
use super::raster::decode_png_to_rgb_asset;
use super::svg::{resolve_svg_size, sync_svg_tree_to_layout_box};

/// Heuristic SVG sniff over raw bytes (first 512 bytes, UTF-8-lossy so binary
/// content is safely rejected): true when the content looks like an XML/SVG
/// document. Used to gate both the internal SVG parser and the mask rasteriser.
pub(crate) fn looks_like_svg(raw: &[u8]) -> bool {
    let prefix = if raw.len() > 512 { &raw[..512] } else { raw };
    let text = String::from_utf8_lossy(prefix);
    let trimmed = text.trim_start_matches('\u{FEFF}').trim_start();
    let trimmed_lower = trimmed.to_ascii_lowercase();
    if !(trimmed.starts_with("<svg")
        || trimmed.starts_with("<?xml")
        || trimmed.starts_with("<!--")
        || trimmed_lower.starts_with("<!doctype"))
    {
        return false;
    }
    // For the comment case, search the full content (comments may exceed the
    // 512-byte prefix before the <svg> tag appears).
    if trimmed.starts_with("<!--") {
        return String::from_utf8_lossy(raw).contains("<svg");
    }
    true
}

/// Probe raw bytes for SVG content and parse into an `SvgTree`.
///
/// Uses a heuristic on the first 512 bytes (via `String::from_utf8_lossy` so
/// that non-UTF-8 binary content is safely rejected) and then parses the full
/// content through the HTML parser to extract the `<svg>` element.
pub(crate) fn try_parse_svg_bytes(raw: &[u8]) -> Option<crate::parser::svg::SvgTree> {
    // Heuristic: check if the content looks like SVG (XML with an <svg element).
    if !looks_like_svg(raw) {
        return None;
    }

    // Parse the full SVG content — use lossy conversion so that stray non-UTF-8
    // bytes don't cause the whole parse to fail.
    let svg_str = String::from_utf8_lossy(raw);
    crate::parser::svg::parse_svg_from_string(&svg_str)
}

/// Detect PNG/JPEG format and return a raster asset with source dimensions.
pub(crate) fn load_image_bytes(raw: Vec<u8>) -> Option<RasterImageAsset> {
    if png::is_png(&raw) {
        // The final PDF writer extracts raw IDAT for PDF FlateDecode embedding,
        // but the layout asset keeps the complete PNG so later optimization
        // stages can decode and resize it before embedding.
        let Some(png_info) = png::parse_png(&raw) else {
            return decode_png_to_rgb_asset(&raw);
        };
        // The raw-IDAT passthrough writes the sample stream straight into a PDF
        // DeviceRGB/DeviceGray image, which take 3/1 colour components. An alpha
        // colour type (RGBA=4, GrayscaleAlpha=2) cannot be passed through that
        // way (the viewer would read the extra channel as misaligned colour
        // samples). Carry the complete original PNG so the renderer can decode it
        // into a colour stream plus a soft-mask (`/SMask`), preserving the alpha
        // channel rather than dropping it (which rendered transparent regions as
        // opaque black).
        if png_info.channels == 2 || png_info.channels == 4 {
            return Some(RasterImageAsset::source(
                raw,
                png_info.width,
                png_info.height,
                ImageFormat::PngAlpha,
                None,
            ));
        }
        let metadata = PngMetadata {
            channels: png_info.channels,
            bit_depth: png_info.bit_depth,
        };
        Some(RasterImageAsset::source(
            raw,
            png_info.width,
            png_info.height,
            ImageFormat::Png,
            Some(metadata),
        ))
    } else if raw.starts_with(&[0xFF, 0xD8]) {
        let (source_width, source_height) = crate::parser::jpeg::parse_jpeg_dimensions(&raw)?;
        Some(RasterImageAsset::source(
            raw,
            source_width,
            source_height,
            ImageFormat::Jpeg,
            None,
        ))
    } else {
        None
    }
}

/// Load image data from an <img> element and return a LayoutElement.
///
/// Bytes are fetched exactly once from the source.  When the content is SVG it
/// is parsed as vector graphics ([`Svg`]); otherwise it falls back to a raster
/// PNG/JPEG [`Image`].
pub(crate) fn load_image_from_element(
    resources: &mut ResourceLoader,
    el: &ElementNode,
    available_width: f32,
    available_height: f32,
    style: &ComputedStyle,
    _filter_dpi: f32,
) -> Option<LayoutNode> {
    let src = el.attributes.get("src")?;

    // Load bytes once.
    let loaded = resources.load_document_resource(src)?;
    let (raw, mime) = (loaded.bytes, loaded.media_type);

    // For data URIs with a non-SVG MIME type, skip the SVG probe entirely.
    let skip_svg = mime
        .as_deref()
        .is_some_and(|m| !m.is_empty() && !m.contains("svg") && !m.contains("xml"));

    // Try SVG path first — render as vector graphics instead of raster.
    if !skip_svg && let Some(mut tree) = try_parse_svg_bytes(&raw) {
        let intrinsic = resolve_svg_size(&tree, available_width, available_height, false, false);
        let html_attr_width = style
            .width
            .or_else(|| parse_html_image_dimension(el.attributes.get("width")));
        let html_attr_height = style
            .height
            .or_else(|| parse_html_image_dimension(el.attributes.get("height")));

        let (width, height) = match (html_attr_width, html_attr_height) {
            (Some(w), Some(h)) => (w, h),
            (Some(w), None) if intrinsic.0 > 0.0 => (w, intrinsic.1 * (w / intrinsic.0)),
            (Some(w), None) => (w, intrinsic.1),
            (None, Some(h)) if intrinsic.1 > 0.0 => (intrinsic.0 * (h / intrinsic.1), h),
            (None, Some(h)) => (intrinsic.0, h),
            (None, None) => intrinsic,
        };

        let (width, height) = ReplacedBoxSize::new(
            width,
            height,
            html_attr_width.is_none(),
            html_attr_height.is_none(),
        )
        .constrain(available_width, style.max_width, style.max_height)
        .dimensions();

        let border = LayoutBorder::from_computed(&style.border, style.color);
        let content_width = (width - border.horizontal_width()).max(0.0);
        let content_height = (height - border.vertical_width()).max(0.0);
        sync_svg_tree_to_layout_box(&mut tree, content_width, content_height);
        return Some(
            Svg {
                tree,
                geometry: ReplacedGeometry::new(
                    Size::new(width, height),
                    BlockMargins::new(style.margin.top, style.margin.bottom),
                    border,
                ),
                positioning: Positioning::from_style(style),
                paint: SvgPaint {
                    background_color: style.background_color,
                    border_image: style.border_image.paint(),
                    border_radii: style.resolve_corner_radii(width, height),
                    group: crate::layout::elements::PaintGroup::from_style(style),
                },
                replaced: crate::layout::engine::ReplacedContent {
                    object_fit: style.object_fit,
                    object_position: style.object_position,
                    ..Default::default()
                },
            }
            .boxed(),
        );
    }

    // The filter property applies to the complete replaced-element
    // SourceGraphic, including its background and border. Keep image loading
    // unfiltered; the shared post-layout filter compositor owns the operation
    // list for every element kind.
    let image = load_image_bytes(raw)?;

    // Determine dimensions: CSS width/height take precedence over the HTML
    // width/height attributes (matching the SVG path and the CSS cascade).
    let attr_width = style
        .width
        .or_else(|| parse_html_image_dimension(el.attributes.get("width")));
    let attr_height = style
        .height
        .or_else(|| parse_html_image_dimension(el.attributes.get("height")));

    // Raster images carry concrete natural dimensions (the source pixel size,
    // taken as CSS px at 1x → pt). The CSS default sizing algorithm
    // (css-images-3 §5.4) uses them to derive any missing dimension and, when
    // neither is given, to size the box directly.
    let src_w = image.source_width as f32;
    let src_h = image.source_height as f32;
    let natural_w = src_w * 0.75;
    let natural_h = src_h * 0.75;
    let (width, height) = match (attr_width, attr_height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) if src_w > 0.0 => (w, w * (src_h / src_w)),
        (Some(w), None) => (w, w), // fallback: square (intrinsic size unknown)
        (None, Some(h)) if src_h > 0.0 => (h * (src_w / src_h), h),
        (None, Some(h)) => (h, h), // fallback: square (intrinsic size unknown)
        // No width/height specified: use the image's natural dimensions
        // (default sizing algorithm, no-dimensions branch). Fall back to the
        // CSS default object size only when natural dimensions are unusable.
        (None, None) if natural_w > 0.0 && natural_h > 0.0 => (natural_w, natural_h),
        (None, None) => (available_width.min(200.0), 150.0),
    };

    let (width, height) =
        ReplacedBoxSize::new(width, height, attr_width.is_none(), attr_height.is_none())
            .constrain(available_width, style.max_width, style.max_height)
            .dimensions();

    Some(
        Image {
            source: image,
            geometry: ReplacedGeometry::new(
                Size::new(width, height),
                BlockMargins::new(style.margin.top, style.margin.bottom),
                LayoutBorder::from_computed(&style.border, style.color),
            ),
            positioning: Positioning::from_style(style),
            sampling: ImageSampling {
                replaced: crate::layout::engine::ReplacedContent {
                    object_fit: style.object_fit,
                    object_position: style.object_position,
                    ..Default::default()
                },
                rendering: style.image_rendering,
            },
            paint: ImagePaint {
                background_color: style.background_color,
                border_image: style.border_image.paint(),
                border_radii: style.resolve_corner_radii(width, height),
                filter_effect: None,
                group: crate::layout::elements::PaintGroup::from_style(style),
                ..Default::default()
            },
        }
        .boxed(),
    )
}
