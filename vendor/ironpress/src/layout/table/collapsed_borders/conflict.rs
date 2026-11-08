use crate::layout::engine::LayoutBorderSide;
use crate::style::computed::BorderStyle;

/// CSS table box that supplied one collapsed-border candidate. Declaration
/// order is also the CSS tie-break order from least to most specific.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum CollapsedBorderOrigin {
    #[default]
    Table,
    ColumnGroup,
    Column,
    RowGroup,
    Row,
    Cell,
}

/// One authored border side together with its table-box origin.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct BorderCandidate {
    pub(super) side: LayoutBorderSide,
    pub(super) origin: CollapsedBorderOrigin,
}

pub(super) fn collapsed_style_rank(style: BorderStyle) -> u8 {
    match style {
        BorderStyle::Double => 8,
        BorderStyle::Solid => 7,
        BorderStyle::Dashed => 6,
        BorderStyle::Dotted => 5,
        BorderStyle::Ridge => 4,
        BorderStyle::Outset => 3,
        BorderStyle::Groove => 2,
        BorderStyle::Inset => 1,
        BorderStyle::Hidden | BorderStyle::None => 0,
    }
}

fn collapsed_border_winner(first: BorderCandidate, second: BorderCandidate) -> Option<usize> {
    match (first.side.style, second.side.style) {
        (BorderStyle::Hidden, _) => return Some(0),
        (_, BorderStyle::Hidden) => return Some(1),
        _ => {}
    }
    match (first.side.paints(), second.side.paints()) {
        (false, false) => return None,
        (true, false) => return Some(0),
        (false, true) => return Some(1),
        (true, true) => {}
    }
    match first
        .side
        .width
        .partial_cmp(&second.side.width)
        .unwrap_or(std::cmp::Ordering::Equal)
    {
        std::cmp::Ordering::Greater => Some(0),
        std::cmp::Ordering::Less => Some(1),
        std::cmp::Ordering::Equal => {
            let first_rank = collapsed_style_rank(first.side.style);
            let second_rank = collapsed_style_rank(second.side.style);
            match first_rank.cmp(&second_rank) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => {
                    if first.origin >= second.origin {
                        Some(0)
                    } else {
                        Some(1)
                    }
                }
            }
        }
    }
}

pub(super) fn harmonize_candidates(
    candidates: impl IntoIterator<Item = BorderCandidate>,
) -> BorderCandidate {
    candidates
        .into_iter()
        .reduce(
            |winner, candidate| match collapsed_border_winner(winner, candidate) {
                Some(1) => candidate,
                _ => winner,
            },
        )
        .unwrap_or_default()
}

pub(super) fn resolved_side(candidate: BorderCandidate) -> LayoutBorderSide {
    if candidate.side.style == BorderStyle::Hidden {
        LayoutBorderSide::default()
    } else {
        candidate.side
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: f32) -> LayoutBorderSide {
        LayoutBorderSide {
            width,
            style: BorderStyle::Solid,
            ..Default::default()
        }
    }

    #[test]
    fn collapsed_style_rank_covers_the_full_css_order() {
        let ordered = [
            BorderStyle::Inset,
            BorderStyle::Groove,
            BorderStyle::Outset,
            BorderStyle::Ridge,
            BorderStyle::Dotted,
            BorderStyle::Dashed,
            BorderStyle::Solid,
            BorderStyle::Double,
        ];
        for pair in ordered.windows(2) {
            assert!(collapsed_style_rank(pair[0]) < collapsed_style_rank(pair[1]));
        }
    }

    #[test]
    fn hidden_border_suppresses_a_collapsed_neighbor() {
        let hidden = BorderCandidate {
            side: LayoutBorderSide {
                style: BorderStyle::Hidden,
                ..Default::default()
            },
            origin: CollapsedBorderOrigin::Cell,
        };
        let solid = BorderCandidate {
            side: solid(8.0),
            origin: CollapsedBorderOrigin::Cell,
        };
        assert_eq!(collapsed_border_winner(hidden, solid), Some(0));
    }
}
