use super::placement::{ReplacedBoxSize, parse_html_image_dimension};
use super::svg::{contain_object_size, resolve_svg_size, svg_natural_ratio};
use super::*;
use crate::layout::engine::ImageFormat;
use crate::parser::png;
use crate::parser::svg::{SvgTree, ViewBox};
use crate::style::computed::{ObjectFit, ObjectPosition, ObjectPositionComponent};
use crate::types::{Rect, Size};
use crate::util::{RasterDimensions, decode_base64};

mod placement;
mod raster;
mod svg;
