//! Ordered filter-list evaluation over one composited source graphic.

mod color;
mod color_space;
mod surface;

pub(crate) use color::apply_operations_to_color;
pub(crate) use surface::{FilterSourceGeometry, apply_operations_to_surface};
