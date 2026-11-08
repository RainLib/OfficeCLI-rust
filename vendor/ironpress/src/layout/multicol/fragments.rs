//! Materialization of retained multi-column fragments as layout nodes.

use super::flow::{BoxFragmentPlacement, SourceBlockRange};
use super::items::MultiColItem;
use crate::layout::elements::{
    BlockSize, BoxModel, BoxPaint, ColumnRule, Container, FragmentBox, FragmentPlacement,
    IntoLayoutNode, LayoutElement, LayoutNode, LayoutSize, LayoutVisitor, LayoutVisitorMut,
    MulticolColumn, TextBlock,
};
use crate::layout::engine::{LayoutBorderSide, TextLine};
use crate::layout::flow_metrics::BlockMargins;
use crate::layout::roundoff::{exceeds_with_roundoff, is_positive_with_roundoff};
use crate::style::computed::{BorderStyle, Position};
use crate::types::{Size, Vector};

/// Build one anonymous column fragmentainer at a padding-box-local placement.
pub(super) fn make_column_container(
    kids: Vec<LayoutNode>,
    column_index: usize,
    off_left: f32,
    off_top: f32,
    width: f32,
    height: f32,
) -> LayoutNode {
    let principal = empty_container_value(kids, width, height, None);
    MulticolColumn::new(
        principal,
        column_index,
        FragmentPlacement::in_padding_box(Vector::new(off_left, off_top), Size::new(width, height)),
    )
    .boxed()
}

/// Whether an item is one block whose fragmentation source exposes legal
/// internal break positions. Unsupported descendants remain atomic.
pub(super) fn item_is_splittable(item: &MultiColItem) -> bool {
    let [element] = item.elements.as_slice() else {
        return false;
    };
    element.block_fragmentation_source().is_some()
}

/// Remove source text lines assigned to an earlier fragment, retaining a
/// leading blank line when the next source line begins below the fragment edge.
/// Fragment selection supplies legal line boundaries; if independent layout
/// sums leave the edge microscopically inside a line box, ownership stays with
/// the preceding fragment so the continuation can never duplicate that line.
pub(super) fn project_text_lines_into_fragment(
    lines: &mut Vec<TextLine>,
    source_content_top: f32,
    source: SourceBlockRange,
) {
    let source_lines = std::mem::take(lines);
    let mut projected = Vec::with_capacity(source_lines.len() + 1);
    let mut line_top = source_content_top;
    let mut inserted_leading_gap = false;
    for line in source_lines {
        let line_height = line.height;
        let starts_before_end = source
            .end
            .is_none_or(|end| exceeds_with_roundoff(end, line_top));
        if starts_before_end && !exceeds_with_roundoff(source.start, line_top) {
            if !inserted_leading_gap && is_positive_with_roundoff(line_top - source.start) {
                projected.push(TextLine {
                    height: line_top - source.start,
                    ..Default::default()
                });
                inserted_leading_gap = true;
            }
            projected.push(line);
        }
        line_top += line_height;
    }
    *lines = projected;
}

/// Project a cloned container subtree to the source block offset represented by
/// a continuation fragment. Fully consumed children are removed; the first
/// partially consumed child is recursively projected. This preserves document
/// order without repainting the first fragment's descendants in every column.
fn project_container_children(container: &mut Container, source: SourceBlockRange) {
    let source_content_top = container.box_model.border.top.width + container.box_model.padding.top;
    let mut child_top = source_content_top;
    container.children.retain_mut(|child| {
        let child_size = child
            .fragmentable_outer_block_extent()
            .unwrap_or_else(|| crate::layout::paginate::estimate_element_height(child.as_ref()));
        let child_bottom = child_top + child_size;
        let consumed = !exceeds_with_roundoff(child_bottom, source.start);
        let follows_fragment = source
            .end
            .is_some_and(|end| !exceeds_with_roundoff(end, child_top));
        let keep = !consumed && !follows_fragment;
        if keep {
            project_fragment_subtree(
                child.as_mut(),
                SourceBlockRange {
                    start: (source.start - child_top).max(0.0),
                    end: source.end.map(|end| (end - child_top).max(0.0)),
                },
            );
        }
        child_top = child_bottom;
        keep
    });
}

fn project_fragment_subtree(element: &mut dyn LayoutElement, source: SourceBlockRange) {
    struct FragmentSubtreeProjector {
        source: SourceBlockRange,
    }

    impl LayoutVisitorMut for FragmentSubtreeProjector {
        fn visit_text_block(&mut self, element: &mut TextBlock) {
            project_text_lines_into_fragment(
                &mut element.lines,
                element.box_model.border.top.width + element.box_model.padding.top,
                self.source,
            );
        }

        fn visit_container(&mut self, element: &mut Container) {
            project_container_children(element, self.source);
        }
    }

    element.accept_mut(&mut FragmentSubtreeProjector { source });
}

/// Build one positioned fragment box for a `column-fill: auto` slice of an item.
///
/// Clones the item's single block element, projects its text through the source
/// fragment offset, retains its fragmentainer-local placement independently of
/// authored positioning, forces its border-box height to the slice height, and
/// applies `box-decoration-break: slice` borders. The projected subtree assigns
/// content to exactly one fragment; authored visible overflow from the final
/// fragment remains visible.
pub(super) fn make_fragment_box(
    src: &dyn LayoutElement,
    placement: BoxFragmentPlacement,
) -> LayoutNode {
    if placement.is_whole() {
        if let Some(wrapped) = make_whole_text_fragment(src, placement.physical()) {
            return wrapped;
        }
        return retain_whole_fragment(src, placement.physical());
    }
    struct FragmentProjector {
        placement: BoxFragmentPlacement,
    }

    impl LayoutVisitorMut for FragmentProjector {
        fn visit_container(&mut self, element: &mut Container) {
            project_container_children(element, self.placement.source);
            let border = &mut element.box_model.border;
            let padding = &mut element.box_model.padding;
            if !self.placement.edges.block_start {
                border.top = crate::layout::engine::LayoutBorderSide::default();
                padding.top = 0.0;
            }
            if !self.placement.edges.block_end {
                border.bottom = crate::layout::engine::LayoutBorderSide::default();
                padding.bottom = 0.0;
            }
            element.box_model.size.height = BlockSize::definite(self.placement.size.height);
            element.box_model.margins = BlockMargins::ZERO;
        }

        fn visit_text_block(&mut self, element: &mut TextBlock) {
            let border = &mut element.box_model.border;
            let padding = &mut element.box_model.padding;
            project_text_lines_into_fragment(
                &mut element.lines,
                border.top.width + padding.top,
                self.placement.source,
            );
            if !self.placement.edges.block_start {
                border.top = crate::layout::engine::LayoutBorderSide::default();
                padding.top = 0.0;
            }
            if !self.placement.edges.block_end {
                border.bottom = crate::layout::engine::LayoutBorderSide::default();
                padding.bottom = 0.0;
            }
            element.box_model.size.height = BlockSize::definite(fragment_content_height(
                self.placement.size.height,
                border.vertical_width(),
                padding.vertical(),
            ));
            element.box_model.margins = BlockMargins::ZERO;
            element.clipping.rect = None;
        }
    }

    let mut element = src.clone_box();
    element.accept_mut(&mut FragmentProjector { placement });
    FragmentBox::new(element, placement.physical()).boxed()
}

/// Retain an unsliced item in its column without replacing its computed size.
/// Intrinsic, min/max, and overflow widths remain properties of the source box;
/// the column fragmentainer constrains placement, not the box itself.
fn retain_whole_fragment(src: &dyn LayoutElement, placement: FragmentPlacement) -> LayoutNode {
    struct WholeFragment;

    impl LayoutVisitorMut for WholeFragment {
        fn visit_container(&mut self, element: &mut Container) {
            element.box_model.margins = BlockMargins::ZERO;
        }

        fn visit_text_block(&mut self, element: &mut TextBlock) {
            element.box_model.margins = BlockMargins::ZERO;
            element.clipping.rect = None;
        }
    }

    let mut element = src.clone_box();
    element.accept_mut(&mut WholeFragment);
    FragmentBox::new(element, placement).boxed()
}

fn make_whole_text_fragment(
    src: &dyn LayoutElement,
    placement: FragmentPlacement,
) -> Option<LayoutNode> {
    struct WholeTextFragment {
        placement: FragmentPlacement,
        result: Option<LayoutNode>,
    }

    impl LayoutVisitor for WholeTextFragment {
        fn visit_text_block(&mut self, element: &TextBlock) {
            let Some(background) = element.paint.background.color else {
                return;
            };
            if element.box_model.border.has_any()
                || element.box_model.padding != crate::types::EdgeSizes::ZERO
            {
                return;
            }
            let mut text = element.clone();
            text.paint.background.color = None;
            text.box_model.margins = BlockMargins::ZERO;
            text.positioning.scheme = Position::Static;
            text.positioning.insets = crate::types::EdgeSizes::ZERO;
            text.clipping.rect = None;
            let principal = Container {
                children: vec![text.boxed()],
                box_model: BoxModel {
                    size: LayoutSize::fixed(
                        self.placement.size.width,
                        Some(self.placement.size.height),
                    ),
                    ..Default::default()
                },
                paint: BoxPaint {
                    background: crate::layout::elements::BackgroundPaint {
                        color: Some(background),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            };
            self.result = Some(FragmentBox::new(principal.boxed(), self.placement).boxed());
        }
    }

    let mut visitor = WholeTextFragment {
        placement,
        result: None,
    };
    src.accept(&mut visitor);
    visitor.result
}

fn fragment_content_height(border_box_h: f32, border_v: f32, padding_v: f32) -> f32 {
    (border_box_h - border_v - padding_v).max(0.0)
}

/// Build a full-width band (for `column-span: all`) at the current cursor.
pub(super) fn make_band_container(
    kids: Vec<LayoutNode>,
    off_left: f32,
    off_top: f32,
    width: f32,
    height: f32,
) -> LayoutNode {
    FragmentBox::new(
        empty_container_value(kids, width, height, None).boxed(),
        FragmentPlacement::in_padding_box(Vector::new(off_left, off_top), Size::new(width, height)),
    )
    .boxed()
}

/// Build a semantically identified rule spanning a column gap.
pub(super) fn make_rule_container(
    gap_after: usize,
    off_left: f32,
    off_top: f32,
    width: f32,
    height: f32,
    color: crate::types::Color,
    rule_style: BorderStyle,
) -> LayoutNode {
    ColumnRule {
        gap_after,
        placement: FragmentPlacement::in_padding_box(
            Vector::new(off_left, off_top),
            Size::new(width, height),
        ),
        height,
        paint: LayoutBorderSide {
            width,
            color,
            style: rule_style,
        },
    }
    .boxed()
}

fn empty_container_value(
    kids: Vec<LayoutNode>,
    width: f32,
    height: f32,
    bg: Option<crate::types::Color>,
) -> Container {
    Container {
        children: kids,
        box_model: BoxModel {
            size: LayoutSize::fixed(width, Some(height)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: bg,
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    }
}

pub(super) fn empty_flow_anchor() -> LayoutNode {
    Container {
        box_model: BoxModel {
            size: LayoutSize::fixed(0.0, Some(0.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            visible: false,
            ..Default::default()
        },
        ..Default::default()
    }
    .boxed()
}
