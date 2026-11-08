use crate::layout::elements::SizeConstraints;
use crate::style::computed::{BoxSizing, ComputedStyle};
use crate::types::Size;

/// Resolved dimensions of one CSS box at the layout boundary.
///
/// Keeping the content and border boxes together prevents callers that move
/// decoration into an outer wrapper from accidentally laying children out in
/// the original border-box extent.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct ResolvedBoxDimensions {
    pub(crate) content: Size,
    pub(crate) border_box: Size,
}

impl ResolvedBoxDimensions {
    /// Resolve specified dimensions, treating `auto_border_box` as the outer
    /// fallback on each unspecified axis.
    pub(crate) fn from_style(style: &ComputedStyle, auto_border_box: Size) -> Self {
        let horizontal_extra = style.padding.horizontal() + style.border.horizontal_width();
        let vertical_extra = style.padding.vertical() + style.border.vertical_width();
        let (content_width, border_box_width) = resolve_axis(
            style.width,
            SizeConstraints::new(style.min_width, style.max_width),
            auto_border_box.width,
            horizontal_extra,
            style.box_sizing,
        );
        let (content_height, border_box_height) = resolve_axis(
            style.height,
            SizeConstraints::new(style.min_height, style.max_height),
            auto_border_box.height,
            vertical_extra,
            style.box_sizing,
        );
        Self {
            content: Size::new(content_width, content_height),
            border_box: Size::new(border_box_width, border_box_height),
        }
    }
}

fn resolve_axis(
    specified: Option<f32>,
    constraints: SizeConstraints,
    auto_border_box: f32,
    padding_and_border: f32,
    box_sizing: BoxSizing,
) -> (f32, f32) {
    let to_border_box = |value: f32| match box_sizing {
        BoxSizing::BorderBox => value.max(0.0),
        BoxSizing::ContentBox => value.max(0.0) + padding_and_border,
    };
    let preferred_border_box = specified
        .map(to_border_box)
        .unwrap_or_else(|| auto_border_box.max(padding_and_border).max(0.0));
    let border_box = constraints
        .map(to_border_box)
        .constrain(preferred_border_box)
        .max(padding_and_border);
    ((border_box - padding_and_border).max(0.0), border_box)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::BorderSides;
    use crate::types::EdgeSizes;

    #[test]
    fn resolves_border_box_to_content_dimensions() {
        let style = ComputedStyle {
            width: Some(126.0),
            height: Some(68.0),
            padding: EdgeSizes::uniform(7.0),
            border: BorderSides::uniform(crate::style::computed::BorderSide::solid(
                2.0,
                crate::parser::css::SpecifiedColor::CurrentColor,
            )),
            box_sizing: BoxSizing::BorderBox,
            ..Default::default()
        };

        let dimensions = ResolvedBoxDimensions::from_style(&style, Size::default());
        assert_eq!(dimensions.border_box, Size::new(126.0, 68.0));
        assert_eq!(dimensions.content, Size::new(108.0, 50.0));
    }

    #[test]
    fn expands_content_box_by_its_edges() {
        let style = ComputedStyle {
            width: Some(108.0),
            height: Some(50.0),
            padding: EdgeSizes::uniform(7.0),
            border: BorderSides::uniform(crate::style::computed::BorderSide::solid(
                2.0,
                crate::parser::css::SpecifiedColor::CurrentColor,
            )),
            ..Default::default()
        };

        let dimensions = ResolvedBoxDimensions::from_style(&style, Size::default());
        assert_eq!(dimensions.content, Size::new(108.0, 50.0));
        assert_eq!(dimensions.border_box, Size::new(126.0, 68.0));
    }

    #[test]
    fn constrains_the_resolved_border_box_with_minimum_winning_conflicts() {
        let capped = ComputedStyle {
            height: Some(68.0),
            max_height: Some(58.0),
            padding: crate::types::EdgeSizes::uniform(7.0),
            border: crate::style::computed::BorderSides::uniform(
                crate::style::computed::BorderSide::solid(
                    2.0,
                    crate::parser::css::SpecifiedColor::CurrentColor,
                ),
            ),
            box_sizing: BoxSizing::BorderBox,
            ..Default::default()
        };
        let minimum_wins = ComputedStyle {
            min_height: Some(68.0),
            ..capped.clone()
        };

        assert_eq!(
            ResolvedBoxDimensions::from_style(&capped, Size::default())
                .border_box
                .height,
            58.0
        );
        assert_eq!(
            ResolvedBoxDimensions::from_style(&minimum_wins, Size::default())
                .border_box
                .height,
            68.0
        );
    }
}
