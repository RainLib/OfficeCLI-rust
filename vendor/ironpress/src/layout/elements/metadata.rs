use super::LayoutNode;
use super::{ChildContainer, LayoutElement, LayoutVisitor, LayoutVisitorMut};
use crate::layout::engine::PageBreakSide;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AvoidPageBreak;

impl LayoutElement for AvoidPageBreak {
    fn clone_box(&self) -> LayoutNode {
        Box::new(*self)
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_avoid_page_break(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_avoid_page_break(self);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RunningElement {
    pub(crate) name: String,
    pub(crate) element: LayoutNode,
}

impl ChildContainer for RunningElement {
    fn visit_layout_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        visitor(self.element.as_ref());
    }

    fn visit_layout_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        visitor(self.element.as_mut());
    }

    fn visit_layout_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        visitor(&mut self.element);
    }
}

impl LayoutElement for RunningElement {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_running_element(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_running_element(self);
    }

    fn visit_children(&self, visitor: &mut dyn FnMut(&dyn LayoutElement)) {
        self.visit_layout_children(visitor);
    }

    fn visit_children_mut(&mut self, visitor: &mut dyn FnMut(&mut dyn LayoutElement)) {
        self.visit_layout_children_mut(visitor);
    }

    fn visit_child_nodes_mut(&mut self, visitor: &mut dyn FnMut(&mut LayoutNode)) {
        self.visit_layout_child_nodes_mut(visitor);
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct NamedString {
    pub(crate) name: String,
    pub(crate) value: String,
}

impl LayoutElement for NamedString {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_named_string(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_named_string(self);
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PageBreak {
    pub(crate) side: PageBreakSide,
    pub(crate) page_name: Option<String>,
}

impl PageBreak {
    pub(crate) fn named(page_name: String) -> Self {
        Self {
            page_name: Some(page_name),
            ..Default::default()
        }
    }
}

impl LayoutElement for PageBreak {
    fn clone_box(&self) -> LayoutNode {
        Box::new(self.clone())
    }

    fn accept(&self, visitor: &mut dyn LayoutVisitor) {
        visitor.visit_page_break(self);
    }

    fn accept_mut(&mut self, visitor: &mut dyn LayoutVisitorMut) {
        visitor.visit_page_break(self);
    }
}
