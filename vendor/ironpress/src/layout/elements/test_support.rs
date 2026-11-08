//! Typed inspection helpers for tests of the heterogeneous layout tree.
//!
//! Tests inspect the same concrete nodes as production. These visitors avoid a
//! second snapshot enum and keep test assertions independent of allocation.

use super::*;

macro_rules! inspector {
    ($method:ident, $visitor:ident, $node:ty, $visit:ident) => {
        fn $method<R>(&self, inspect: impl FnOnce(&$node) -> R) -> Option<R> {
            struct $visitor<F, R> {
                inspect: Option<F>,
                result: Option<R>,
            }

            impl<F, R> LayoutVisitor for $visitor<F, R>
            where
                F: FnOnce(&$node) -> R,
            {
                fn $visit(&mut self, element: &$node) {
                    if let Some(inspect) = self.inspect.take() {
                        self.result = Some(inspect(element));
                    }
                }
            }

            let mut visitor = $visitor {
                inspect: Some(inspect),
                result: None,
            };
            self.accept(&mut visitor);
            visitor.result
        }
    };
}

macro_rules! tree_inspector {
    ($method:ident, $visitor:ident, $node:ty, $visit:ident) => {
        fn $method<R>(&self, inspect: impl FnOnce(&$node) -> R) -> Option<R> {
            struct $visitor<F, R> {
                inspect: Option<F>,
                result: Option<R>,
            }

            impl<F, R> LayoutVisitor for $visitor<F, R>
            where
                F: FnOnce(&$node) -> R,
            {
                fn $visit(&mut self, element: &$node) {
                    if let Some(inspect) = self.inspect.take() {
                        self.result = Some(inspect(element));
                    }
                }
            }

            let mut visitor = $visitor {
                inspect: Some(inspect),
                result: None,
            };
            self.accept(&mut visitor);
            self.visit_children(&mut |child| visit_layout_tree(child, &mut visitor));
            visitor.result
        }
    };
}

#[allow(dead_code)]
pub(crate) trait LayoutElementTestExt: LayoutElement {
    inspector!(inspect_text, TextInspector, TextBlock, visit_text_block);
    inspector!(
        inspect_container,
        ContainerInspector,
        Container,
        visit_container
    );
    inspector!(inspect_flex, FlexInspector, FlexRow, visit_flex_row);
    inspector!(inspect_grid, GridInspector, GridRow, visit_grid_row);
    fn inspect_table<R>(&self, inspect: impl FnOnce(&TableRow) -> R) -> Option<R> {
        struct TableInspector<F, R> {
            inspect: Option<F>,
            result: Option<R>,
        }

        impl<F, R> LayoutVisitor for TableInspector<F, R>
        where
            F: FnOnce(&TableRow) -> R,
        {
            fn visit_table(&mut self, element: &Table) {
                for child in &element.principal.children {
                    child.accept(self);
                    if self.result.is_some() {
                        break;
                    }
                }
            }

            fn visit_table_row(&mut self, element: &TableRow) {
                if let Some(inspect) = self.inspect.take() {
                    self.result = Some(inspect(element));
                }
            }
        }

        let mut visitor = TableInspector {
            inspect: Some(inspect),
            result: None,
        };
        self.accept(&mut visitor);
        visitor.result
    }
    inspector!(inspect_image, ImageInspector, Image, visit_image);
    inspector!(inspect_svg, SvgInspector, Svg, visit_svg);
    tree_inspector!(find_image, ImageTreeInspector, Image, visit_image);
    tree_inspector!(find_svg, SvgTreeInspector, Svg, visit_svg);
    inspector!(inspect_math, MathInspector, MathBlock, visit_math_block);
    inspector!(
        inspect_rule,
        RuleInspector,
        HorizontalRule,
        visit_horizontal_rule
    );
    inspector!(
        inspect_progress,
        ProgressInspector,
        ProgressBar,
        visit_progress_bar
    );
    inspector!(
        inspect_page_break,
        BreakInspector,
        PageBreak,
        visit_page_break
    );
    inspector!(
        inspect_column_rule,
        RuleInspector,
        ColumnRule,
        visit_column_rule
    );
}

impl<T> LayoutElementTestExt for T where T: LayoutElement + ?Sized {}

macro_rules! updater {
    ($method:ident, $visitor:ident, $node:ty, $visit:ident) => {
        fn $method<R>(&mut self, update: impl FnOnce(&mut $node) -> R) -> Option<R> {
            struct $visitor<F, R> {
                update: Option<F>,
                result: Option<R>,
            }

            impl<F, R> LayoutVisitorMut for $visitor<F, R>
            where
                F: FnOnce(&mut $node) -> R,
            {
                fn $visit(&mut self, element: &mut $node) {
                    if let Some(update) = self.update.take() {
                        self.result = Some(update(element));
                    }
                }
            }

            let mut visitor = $visitor {
                update: Some(update),
                result: None,
            };
            self.accept_mut(&mut visitor);
            visitor.result
        }
    };
}

#[allow(dead_code)]
pub(crate) trait LayoutElementTestMutExt: LayoutElement {
    updater!(update_text, TextUpdater, TextBlock, visit_text_block);
    updater!(
        update_container,
        ContainerUpdater,
        Container,
        visit_container
    );
    updater!(update_flex, FlexUpdater, FlexRow, visit_flex_row);
    updater!(update_grid, GridUpdater, GridRow, visit_grid_row);
    fn update_table<R>(&mut self, update: impl FnOnce(&mut TableRow) -> R) -> Option<R> {
        struct TableUpdater<F, R> {
            update: Option<F>,
            result: Option<R>,
        }

        impl<F, R> LayoutVisitorMut for TableUpdater<F, R>
        where
            F: FnOnce(&mut TableRow) -> R,
        {
            fn visit_table(&mut self, element: &mut Table) {
                for child in &mut element.principal.children {
                    child.accept_mut(self);
                    if self.result.is_some() {
                        break;
                    }
                }
            }

            fn visit_table_row(&mut self, element: &mut TableRow) {
                if let Some(update) = self.update.take() {
                    self.result = Some(update(element));
                }
            }
        }

        let mut visitor = TableUpdater {
            update: Some(update),
            result: None,
        };
        self.accept_mut(&mut visitor);
        visitor.result
    }
    updater!(update_image, ImageUpdater, Image, visit_image);
    updater!(update_svg, SvgUpdater, Svg, visit_svg);
    updater!(
        update_column_rule,
        ColumnRuleUpdater,
        ColumnRule,
        visit_column_rule
    );
}

impl<T> LayoutElementTestMutExt for T where T: LayoutElement + ?Sized {}
