//! Coordinate-space ownership for post-layout filter materialization.
//!
//! Layout positions boxes in untransformed page coordinates. CSS transforms
//! form a hierarchy over those boxes, while image filters may evaluate in a
//! simpler layer coordinate system and retain the remaining transform for
//! post-filter compositing. These types keep those meanings separate.

use crate::layout::elements::{BoxReferenceGeometry, PaintGroup};
use crate::style::computed::{CssAffineMatrix, CssVector};
use crate::types::{Point, Rect, Size, Vector};

use super::FilterMatrixCapability;
use super::surface::SourceRasterSpace;

/// Border-box origin in the page's untransformed layout coordinate system.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct PageBoxAnchor(Point);

impl PageBoxAnchor {
    pub(super) const fn at(border_origin: Point) -> Self {
        Self(border_origin)
    }

    pub(super) const fn border_origin(self) -> Point {
        self.0
    }

    pub(super) fn offset(self, offset: Vector) -> Self {
        Self(self.0 + offset)
    }
}

/// Transform inherited by a box from its graphical ancestors.
#[derive(Debug, Clone, Copy)]
pub(super) struct InheritedFilterPaintSpace {
    ancestor_to_page: CssAffineMatrix,
    parameter_origin: PageBoxAnchor,
}

impl Default for InheritedFilterPaintSpace {
    fn default() -> Self {
        Self {
            ancestor_to_page: CssAffineMatrix::IDENTITY,
            parameter_origin: PageBoxAnchor::at(Point::ORIGIN),
        }
    }
}

impl InheritedFilterPaintSpace {
    /// Enter one concrete border box and compose its transform with every
    /// graphical ancestor exactly once.
    pub(super) fn enter(
        self,
        anchor: PageBoxAnchor,
        size: Size,
        group: Option<&PaintGroup>,
        reference_box: Option<&dyn BoxReferenceGeometry>,
    ) -> FilterBoxPaintSpace {
        let own_transform = group
            .and_then(|group| {
                group.transform.resolve(
                    Rect::new(anchor.border_origin(), size),
                    reference_box.map_or(
                        crate::types::EdgeSizes::ZERO,
                        BoxReferenceGeometry::content_insets,
                    ),
                )
            })
            .unwrap_or_default();
        let parameter_origin = if own_transform.is_scale_translate() {
            self.parameter_origin
        } else {
            anchor
        };
        FilterBoxPaintSpace {
            anchor,
            box_to_page: self.ancestor_to_page * own_transform,
            parameter_origin,
        }
    }
}

/// Complete transform state for one concrete box.
#[derive(Debug, Clone, Copy)]
pub(super) struct FilterBoxPaintSpace {
    anchor: PageBoxAnchor,
    box_to_page: CssAffineMatrix,
    parameter_origin: PageBoxAnchor,
}

impl FilterBoxPaintSpace {
    pub(super) fn descendants(self) -> InheritedFilterPaintSpace {
        InheritedFilterPaintSpace {
            ancestor_to_page: self.box_to_page,
            parameter_origin: self.parameter_origin,
        }
    }

    /// Resolve the border-box origin in the layer space used to quantize the
    /// filter source.
    ///
    /// Scale/translate-capable filters retain the full matrix when possible.
    /// Rotation or skew is sampled after filtering, so its layer matrix drops
    /// translation and begins at the box-local origin. Affine-local colour
    /// graphs retain the complete matrix.
    pub(super) fn source_raster_space(
        self,
        capability: FilterMatrixCapability,
    ) -> SourceRasterSpace {
        let border_origin = match capability {
            FilterMatrixCapability::ScaleTranslate if !self.box_to_page.is_scale_translate() => {
                let offset = self.anchor.border_origin() - self.parameter_origin.border_origin();
                Point::new(offset.x, offset.y)
            }
            FilterMatrixCapability::ScaleTranslate | FilterMatrixCapability::Complex => {
                let box_origin = CssAffineMatrix::translation(CssVector::new(
                    f64::from(self.anchor.border_origin().x),
                    f64::from(self.anchor.border_origin().y),
                ));
                (self.box_to_page * box_origin).transform_point(Point::ORIGIN)
            }
        };
        SourceRasterSpace::in_layer(border_origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::{BoxTransform, PaintGroup};
    use crate::style::computed::{Transform, TransformBox, TransformOrigin};

    #[test]
    fn spatial_filter_drops_rotation_and_page_translation_from_layer_space() {
        let group = PaintGroup {
            transform: BoxTransform {
                value: Some(Transform::Rotate(20.0)),
                origin: TransformOrigin {
                    x_fraction: 0.0,
                    y_fraction: 0.0,
                    ..Default::default()
                },
                reference_box: TransformBox::Border,
                ..Default::default()
            },
            ..Default::default()
        };
        let space = InheritedFilterPaintSpace::default().enter(
            PageBoxAnchor::at(Point::new(12.0, 20.0)),
            Size::new(30.0, 10.0),
            Some(&group),
            None,
        );

        assert_eq!(
            space
                .source_raster_space(FilterMatrixCapability::ScaleTranslate)
                .border_origin(),
            Point::ORIGIN
        );
    }

    #[test]
    fn scale_translate_filter_retains_transformed_device_phase() {
        let group = PaintGroup {
            transform: BoxTransform {
                value: Some(Transform::Translate {
                    offset: CssVector::new(3.0, -2.0),
                    percentages: Default::default(),
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let space = InheritedFilterPaintSpace::default().enter(
            PageBoxAnchor::at(Point::new(12.0, 20.0)),
            Size::new(30.0, 10.0),
            Some(&group),
            None,
        );

        assert_eq!(
            space
                .source_raster_space(FilterMatrixCapability::ScaleTranslate)
                .border_origin(),
            Point::new(15.0, 18.0)
        );
    }

    #[test]
    fn nested_filter_retains_layout_offset_from_complex_transform_owner() {
        let outer_group = PaintGroup {
            transform: BoxTransform {
                value: Some(Transform::Rotate(20.0)),
                origin: TransformOrigin {
                    x_fraction: 0.0,
                    y_fraction: 0.0,
                    ..Default::default()
                },
                reference_box: TransformBox::Border,
                ..Default::default()
            },
            ..Default::default()
        };
        let outer = InheritedFilterPaintSpace::default().enter(
            PageBoxAnchor::at(Point::new(12.0, 20.0)),
            Size::new(30.0, 20.0),
            Some(&outer_group),
            None,
        );
        let inner = outer.descendants().enter(
            PageBoxAnchor::at(Point::new(17.0, 27.0)),
            Size::new(10.0, 8.0),
            None,
            None,
        );

        assert_eq!(
            inner
                .source_raster_space(FilterMatrixCapability::ScaleTranslate)
                .border_origin(),
            Point::new(5.0, 7.0)
        );
    }
}
