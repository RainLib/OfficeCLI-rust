use crate::parser::css::{AncestorInfo, SelectorContext};
use crate::parser::dom::ElementNode;
use crate::style::computed::ComputedStyle;

use super::context::LayoutContext;
use super::engine::ListContext;

/// State inherited while the layout tree descends through a DOM subtree.
///
/// This keeps CSS inheritance, box geometry, list state, selector ancestry,
/// and positioned-ancestor tracking together instead of passing them as an
/// unrelated parameter list.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LayoutTreeContext<'context, 'dom> {
    parent_style: &'context ComputedStyle,
    layout: &'context LayoutContext,
    list: Option<&'context ListContext>,
    ancestors: &'context [AncestorInfo<'dom>],
    positioned_ancestor_depth: usize,
}

impl<'context, 'dom> LayoutTreeContext<'context, 'dom> {
    pub(crate) const fn new(
        parent_style: &'context ComputedStyle,
        layout: &'context LayoutContext,
        ancestors: &'context [AncestorInfo<'dom>],
    ) -> Self {
        Self {
            parent_style,
            layout,
            list: None,
            ancestors,
            positioned_ancestor_depth: 0,
        }
    }

    pub(crate) const fn with_list(mut self, list: Option<&'context ListContext>) -> Self {
        self.list = list;
        self
    }

    pub(crate) const fn with_positioned_ancestor_depth(mut self, depth: usize) -> Self {
        self.positioned_ancestor_depth = depth;
        self
    }

    pub(crate) const fn parent_style(self) -> &'context ComputedStyle {
        self.parent_style
    }

    pub(crate) const fn layout(self) -> &'context LayoutContext {
        self.layout
    }

    pub(crate) const fn list(self) -> Option<&'context ListContext> {
        self.list
    }

    pub(crate) const fn ancestors(self) -> &'context [AncestorInfo<'dom>] {
        self.ancestors
    }

    pub(crate) const fn positioned_ancestor_depth(self) -> usize {
        self.positioned_ancestor_depth
    }

    pub(crate) const fn for_element<'siblings>(
        self,
        siblings: ElementSiblingContext<'siblings>,
    ) -> ElementLayoutContext<'context, 'siblings, 'dom> {
        ElementLayoutContext {
            tree: self,
            siblings,
            filter_application: FilterApplication::Materialize,
        }
    }
}

/// The current element's location among its element siblings.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ElementSiblingContext<'siblings> {
    child_index: usize,
    sibling_count: usize,
    preceding: &'siblings [(String, Vec<String>)],
    following: &'siblings [(String, Vec<String>)],
}

/// Owned source position for an element whose layout representation outlives
/// the sibling slice used during DOM traversal.
///
/// Formatting contexts such as grid clone or synthesize their item boxes before
/// laying out descendants. Retaining this position keeps ancestor selectors
/// (`:nth-child()`, sibling combinators, and descendant selectors through such
/// an ancestor) tied to the authored DOM rather than to the synthesized box
/// list.
#[derive(Debug, Clone, Default)]
pub(crate) struct ElementSiblingPosition {
    child_index: usize,
    sibling_count: usize,
    preceding: Vec<(String, Vec<String>)>,
    following: Vec<(String, Vec<String>)>,
}

impl ElementSiblingPosition {
    /// Capture one element's authored position among a complete element-sibling
    /// list. Formatting contexts may reorder or filter their boxes later, but
    /// selectors must continue to see the DOM order recorded here.
    pub(crate) fn from_element_siblings(elements: &[&ElementNode], child_index: usize) -> Self {
        fn identity(element: &&ElementNode) -> (String, Vec<String>) {
            (
                element.tag_name().to_string(),
                element
                    .class_list()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            )
        }

        Self {
            child_index,
            sibling_count: elements.len(),
            preceding: elements[..child_index].iter().map(identity).collect(),
            following: elements[child_index + 1..].iter().map(identity).collect(),
        }
    }

    pub(crate) fn from_selector_context(context: &SelectorContext<'_>) -> Self {
        Self {
            child_index: context.child_index,
            sibling_count: context.sibling_count,
            preceding: context.preceding_siblings.clone(),
            following: context.following_siblings.clone(),
        }
    }

    pub(crate) fn as_context(&self) -> ElementSiblingContext<'_> {
        ElementSiblingContext::new(self.child_index, self.sibling_count)
            .with_neighbors(&self.preceding, &self.following)
    }

    pub(crate) fn ancestor<'dom>(
        &self,
        element: &'dom ElementNode,
        is_empty: bool,
    ) -> AncestorInfo<'dom> {
        self.as_context().ancestor(element, is_empty)
    }
}

impl<'siblings> ElementSiblingContext<'siblings> {
    pub(crate) const fn new(child_index: usize, sibling_count: usize) -> Self {
        Self {
            child_index,
            sibling_count,
            preceding: &[],
            following: &[],
        }
    }

    pub(crate) const fn with_neighbors(
        mut self,
        preceding: &'siblings [(String, Vec<String>)],
        following: &'siblings [(String, Vec<String>)],
    ) -> Self {
        self.preceding = preceding;
        self.following = following;
        self
    }

    pub(crate) const fn child_index(self) -> usize {
        self.child_index
    }

    pub(crate) const fn sibling_count(self) -> usize {
        self.sibling_count
    }

    pub(crate) const fn preceding(self) -> &'siblings [(String, Vec<String>)] {
        self.preceding
    }

    pub(crate) const fn following(self) -> &'siblings [(String, Vec<String>)] {
        self.following
    }

    pub(crate) fn selector_context<'dom>(
        self,
        ancestors: &[AncestorInfo<'dom>],
        is_empty: bool,
    ) -> SelectorContext<'dom> {
        SelectorContext {
            ancestors: ancestors.to_vec(),
            child_index: self.child_index,
            sibling_count: self.sibling_count,
            preceding_siblings: self.preceding.to_vec(),
            following_siblings: self.following.to_vec(),
            is_empty,
        }
    }

    pub(crate) fn ancestor<'dom>(
        self,
        element: &'dom ElementNode,
        is_empty: bool,
    ) -> AncestorInfo<'dom> {
        AncestorInfo {
            element,
            child_index: self.child_index,
            sibling_count: self.sibling_count,
            preceding_siblings: self.preceding.to_vec(),
            following_siblings: self.following.to_vec(),
            is_empty,
        }
    }
}

/// Ownership of a CSS filter while an element becomes layout output.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum FilterApplication {
    /// Retain or materialize the filter on output owned by this element.
    #[default]
    Materialize,
    /// Leave paint unfiltered because the enclosing formatting item owns it.
    DeferToFormattingItem,
}

/// Complete semantic input for flattening one DOM element.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ElementLayoutContext<'context, 'siblings, 'dom> {
    tree: LayoutTreeContext<'context, 'dom>,
    siblings: ElementSiblingContext<'siblings>,
    filter_application: FilterApplication,
}

impl<'context, 'siblings, 'dom> ElementLayoutContext<'context, 'siblings, 'dom> {
    pub(crate) const fn with_filter_application(mut self, application: FilterApplication) -> Self {
        self.filter_application = application;
        self
    }

    pub(crate) const fn tree(self) -> LayoutTreeContext<'context, 'dom> {
        self.tree
    }

    pub(crate) const fn siblings(self) -> ElementSiblingContext<'siblings> {
        self.siblings
    }

    pub(crate) const fn filter_application(self) -> FilterApplication {
        self.filter_application
    }
}
