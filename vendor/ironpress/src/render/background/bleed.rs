use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
use crate::style::computed::{BackgroundClip, BorderStyle};
use crate::types::{CornerRadii, EdgeSizes};

/// Paint-only inset hidden below an opaque rounded border edge.
///
/// CSS backgrounds still cover the border box conceptually. Shrinking only
/// the concealed outer portion prevents the background and border from
/// contributing competing antialias coverage at the same curve. This is
/// equivalent to Blink's `BackgroundBleedShrinkBackground` strategy.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct BackgroundBleed {
    insets: EdgeSizes,
}

impl BackgroundBleed {
    pub(crate) const NONE: Self = Self {
        insets: EdgeSizes::ZERO,
    };

    pub(crate) fn from_decoration(
        border: &LayoutBorder,
        border_image: Option<&crate::style::computed::BorderImagePaint>,
    ) -> Self {
        if border_image.is_some() {
            return Self::NONE;
        }
        let sides = [border.top, border.right, border.bottom, border.left];
        if !sides.into_iter().all(edge_obscures_background) {
            return Self::NONE;
        }
        let fraction = if sides
            .into_iter()
            .any(|side| side.style == BorderStyle::Double)
        {
            1.0 / 6.0
        } else {
            0.5
        };
        Self {
            insets: border.widths() * fraction,
        }
    }

    pub(crate) fn clip_insets(self, clip: BackgroundClip, radii: CornerRadii) -> EdgeSizes {
        if clip == BackgroundClip::Border && !radii.is_zero() {
            self.insets
        } else {
            Self::NONE.insets
        }
    }

    /// Whether every physical border edge hides a rectangular image
    /// destination up to the inner border.
    ///
    /// A rounded border exposes parts of that rectangle around its curved
    /// inner frontier, so it retains the CSS painting box even when every side
    /// is opaque. Dashed, translucent, missing, and image borders never
    /// produce a bleed proof in the first place.
    pub(crate) fn obscures_rectangular_destination(self, radii: CornerRadii) -> bool {
        self.insets != EdgeSizes::ZERO && radii.is_zero()
    }
}

fn edge_obscures_background(side: LayoutBorderSide) -> bool {
    side.paints()
        && side.color.is_opaque()
        && !matches!(side.style, BorderStyle::Dashed | BorderStyle::Dotted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::{BorderImage, BorderImagePaint, BorderImageSource};
    use crate::types::{Color, PhysicalEdges};

    fn side(style: BorderStyle, alpha: u8) -> LayoutBorderSide {
        LayoutBorderSide {
            width: 6.0,
            color: Color::rgba8(0, 0, 0, alpha),
            style,
        }
    }

    #[test]
    fn one_double_edge_selects_the_conservative_global_fraction() {
        let border = PhysicalEdges::new(
            side(BorderStyle::Solid, 255),
            side(BorderStyle::Double, 255),
            side(BorderStyle::Solid, 255),
            side(BorderStyle::Solid, 255),
        );
        let bleed = BackgroundBleed::from_decoration(&border, None);

        assert_eq!(
            bleed.clip_insets(BackgroundClip::Border, CornerRadii::circular(10.0),),
            EdgeSizes::uniform(1.0)
        );
    }

    #[test]
    fn any_exposed_or_translucent_edge_disables_bleed_avoidance() {
        for exposed in [
            side(BorderStyle::Dashed, 255),
            side(BorderStyle::Dotted, 255),
            side(BorderStyle::Solid, 128),
            LayoutBorderSide::default(),
        ] {
            let border = PhysicalEdges::new(
                side(BorderStyle::Solid, 255),
                exposed,
                side(BorderStyle::Solid, 255),
                side(BorderStyle::Solid, 255),
            );
            assert_eq!(
                BackgroundBleed::from_decoration(&border, None),
                BackgroundBleed::NONE
            );
        }
    }

    #[test]
    fn square_and_inner_background_clips_need_no_bleed_inset() {
        let bleed = BackgroundBleed::from_decoration(
            &PhysicalEdges::uniform(side(BorderStyle::Solid, 255)),
            None,
        );

        assert_eq!(
            bleed.clip_insets(BackgroundClip::Border, CornerRadii::ZERO),
            EdgeSizes::ZERO
        );
        assert_eq!(
            bleed.clip_insets(BackgroundClip::Padding, CornerRadii::circular(10.0),),
            EdgeSizes::ZERO
        );
    }

    #[test]
    fn border_image_disables_opaque_edge_bleed_avoidance() {
        let border = PhysicalEdges::uniform(side(BorderStyle::Solid, 255));
        let border_image = BorderImagePaint {
            source: BorderImageSource::Url("unused.svg".into()),
            geometry: BorderImage::default(),
        };

        assert_eq!(
            BackgroundBleed::from_decoration(&border, Some(&border_image)),
            BackgroundBleed::NONE
        );
    }
}
