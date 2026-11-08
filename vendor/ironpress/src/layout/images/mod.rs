mod loader;
mod placement;
mod raster;
mod source;
mod svg;

pub(crate) use loader::{
    load_image_bytes, load_image_from_element, looks_like_svg, try_parse_svg_bytes,
};
pub(crate) use placement::{
    ImagePlacement, InlineBaselineGapRounding, add_inline_replaced_baseline_gap,
    compute_image_placement, compute_replaced_content_placement, svg_intrinsic_size,
};
pub(crate) use raster::{
    RasterCrop, crop_raster_asset, decode_asset_to_rgba, png_bytes_for_decoding,
};
pub(crate) use source::build_raster_background_tree;
#[cfg(test)]
pub(crate) use source::{base64_encode, load_image_data};
pub(crate) use svg::{
    inject_inherited_svg_color, resolve_svg_element_size, resolve_svg_image_size,
    sync_svg_tree_to_layout_box,
};

#[cfg(test)]
mod tests;
