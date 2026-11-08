use super::*;

/// Background exclusion required when a collapsed-border cell is lifted out of
/// the ordinary table paint phase.
///
/// Collapsed borders are resolved once on the table grid. An ordinary cell
/// paints its background before those borders, so the opaque border naturally
/// hides the background below it. A positioned or otherwise atomic cell can be
/// painted later by the stacking-context scheduler. Its background must then be
/// clipped at the inner frontier of the cell-owned trailing borders, otherwise
/// it erases the already-painted shared edge.
///
/// The table grid assigns contested device coverage to the physical top/left
/// cell. Consequently a cell's paint box already starts after its leading
/// (top/left) edges, while its trailing (right/bottom) border bands remain
/// inside that box. This type carries precisely those trailing exclusions.
#[derive(Debug, Clone, Copy, Default)]
pub(in crate::render::pdf) struct CollapsedCellBackgroundBoundary {
    trailing_border: EdgeSizes,
}

impl CollapsedCellBackgroundBoundary {
    pub(in crate::render::pdf) fn for_late_cell(
        cell: &TableCell,
        border_collapse: BorderCollapse,
    ) -> Self {
        if border_collapse != BorderCollapse::Collapse || cell.layout.stacking_level().is_in_flow()
        {
            return Self::default();
        }

        Self {
            trailing_border: EdgeSizes::new(
                0.0,
                used_edge_paint_width(cell, PhysicalSide::Right),
                used_edge_paint_width(cell, PhysicalSide::Bottom),
                0.0,
            ),
        }
    }

    pub(in crate::render::pdf) fn begin(self, content: &mut String, border_box: PdfRect) -> bool {
        if self.trailing_border.is_zero() {
            return false;
        }
        border_box
            .inset(self.trailing_border)
            .rounded(CornerRadii::ZERO)
            .push_clip(content);
        true
    }

    pub(in crate::render::pdf) fn finish(content: &mut String, active: bool) {
        if active {
            content.push_str("Q\n");
        }
    }
}

fn used_edge_paint_width(cell: &TableCell, side: PhysicalSide) -> f32 {
    let representative = cell.layout.box_model.border.get(side);
    if representative.paints() {
        representative.width
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::cells::{CellBox, CellBoxModel};
    use crate::layout::elements::Positioning;
    use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
    use crate::style::computed::Position;

    fn solid_border(width: f32) -> LayoutBorderSide {
        LayoutBorderSide {
            width,
            style: BorderStyle::Solid,
            ..Default::default()
        }
    }

    #[test]
    fn late_collapsed_cell_background_excludes_shared_trailing_borders() {
        let cell = TableCell {
            layout: CellBox {
                box_model: CellBoxModel {
                    border: LayoutBorder {
                        right: solid_border(4.0),
                        bottom: solid_border(6.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                positioning: Positioning::default().with_scheme(Position::Relative),
                ..Default::default()
            },
            ..Default::default()
        };
        let boundary =
            CollapsedCellBackgroundBoundary::for_late_cell(&cell, BorderCollapse::Collapse);
        let mut content = String::new();

        let active = boundary.begin(&mut content, PdfRect::new(10.0, 20.0, 100.0, 80.0));
        CollapsedCellBackgroundBoundary::finish(&mut content, active);

        assert!(active);
        assert_eq!(content, "q\n10 26 96 74 re\nW n\nQ\n");
    }

    #[test]
    fn ordinary_or_separate_cell_background_needs_no_border_exclusion() {
        let collapsed_in_flow = TableCell {
            layout: CellBox {
                box_model: CellBoxModel {
                    border: LayoutBorder {
                        right: solid_border(4.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let mut positioned_separate = collapsed_in_flow.clone();
        positioned_separate.layout.positioning =
            Positioning::default().with_scheme(Position::Relative);

        for boundary in [
            CollapsedCellBackgroundBoundary::for_late_cell(
                &collapsed_in_flow,
                BorderCollapse::Collapse,
            ),
            CollapsedCellBackgroundBoundary::for_late_cell(
                &positioned_separate,
                BorderCollapse::Separate,
            ),
        ] {
            let mut content = String::new();
            assert!(!boundary.begin(&mut content, PdfRect::new(0.0, 0.0, 10.0, 10.0)));
            assert!(content.is_empty());
        }
    }
}
