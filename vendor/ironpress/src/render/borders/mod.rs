//! Shared CSS border geometry and style semantics.
//!
//! Vector PDF output and filter `SourceGraphic` painting deliberately consume
//! these same used shapes. Backends may encode the geometry differently, but
//! they must not independently decide corner radii, side ownership,
//! double-rule widths, or bevel colours.

mod geometry;
mod styles;

pub(crate) use geometry::*;
pub(crate) use styles::*;
