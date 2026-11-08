use crate::layout::elements::TextSpacing;
use crate::layout::engine::FlexCell;

/// A typographic unit emitted by the environment-aware inline row.
///
/// CSS Text treats a consecutive run of atomic inlines as one unit for
/// tracking. Text on either side remains a distinct unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InlineRowUnit {
    Text,
    Atomic,
}

/// Source separation between two units after white-space collapsing.
#[derive(Debug, Clone, Copy, Default)]
pub(super) enum InlineRowSeparator {
    #[default]
    Adjacent,
    CollapsedSpace(f32),
}

/// One logical inline cursor shared by text fragments and atomic boxes.
///
/// The cursor owns every advance introduced at a fragment boundary. This keeps
/// tracking and collapsed word spacing in the same sequence as box placement
/// instead of scattering anonymous scalar adjustments through DOM traversal.
#[derive(Debug, Default)]
pub(super) struct InlineRowCursor {
    position: f32,
    tail: Option<InlineRowUnit>,
}

impl InlineRowCursor {
    pub(super) fn push(
        &mut self,
        cells: &mut Vec<FlexCell>,
        mut cell: FlexCell,
        advance: f32,
        unit: InlineRowUnit,
        separator: InlineRowSeparator,
        spacing: TextSpacing,
    ) {
        if let Some(tail) = self.tail {
            match separator {
                InlineRowSeparator::CollapsedSpace(space) => {
                    // The collapsed space is itself a typographic unit, so it
                    // has one tracking boundary on either side.
                    self.position += space + spacing.letter * 2.0;
                }
                InlineRowSeparator::Adjacent
                    if !(tail == InlineRowUnit::Atomic && unit == InlineRowUnit::Atomic) =>
                {
                    self.position += spacing.letter;
                }
                InlineRowSeparator::Adjacent => {}
            }
        }
        cell.x_offset += self.position;
        self.position += advance;
        self.tail = Some(unit);
        cells.push(cell);
    }

    pub(super) const fn position(&self) -> f32 {
        self.position
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(width: f32) -> FlexCell {
        FlexCell {
            width,
            ..Default::default()
        }
    }

    #[test]
    fn tracking_spans_text_atomic_boundaries_but_not_consecutive_atomics() {
        let mut cursor = InlineRowCursor::default();
        let mut cells = Vec::new();
        let spacing = TextSpacing::new(1.0, 0.0);

        cursor.push(
            &mut cells,
            cell(10.0),
            10.0,
            InlineRowUnit::Text,
            InlineRowSeparator::Adjacent,
            spacing,
        );
        cursor.push(
            &mut cells,
            cell(2.0),
            2.0,
            InlineRowUnit::Atomic,
            InlineRowSeparator::Adjacent,
            spacing,
        );
        cursor.push(
            &mut cells,
            cell(3.0),
            3.0,
            InlineRowUnit::Atomic,
            InlineRowSeparator::Adjacent,
            spacing,
        );
        cursor.push(
            &mut cells,
            cell(4.0),
            4.0,
            InlineRowUnit::Text,
            InlineRowSeparator::Adjacent,
            spacing,
        );

        assert_eq!(
            cells.iter().map(|cell| cell.x_offset).collect::<Vec<_>>(),
            vec![0.0, 11.0, 13.0, 17.0]
        );
        assert_eq!(cursor.position(), 21.0);
    }

    #[test]
    fn collapsed_space_owns_two_tracking_boundaries() {
        let mut cursor = InlineRowCursor::default();
        let mut cells = Vec::new();
        let spacing = TextSpacing::new(1.5, 7.0);

        cursor.push(
            &mut cells,
            cell(10.0),
            10.0,
            InlineRowUnit::Text,
            InlineRowSeparator::Adjacent,
            spacing,
        );
        cursor.push(
            &mut cells,
            cell(2.0),
            2.0,
            InlineRowUnit::Atomic,
            InlineRowSeparator::CollapsedSpace(4.0),
            spacing,
        );

        assert_eq!(cells[1].x_offset, 17.0);
        assert_eq!(cursor.position(), 19.0);
    }
}
