//! Shared block-flow geometry carried by layout elements.
//!
//! Concrete box types implement [`MarginHolder`]; metadata nodes do not.

/// Physical block-axis margins for the horizontal writing-mode layout tree.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct BlockMargins {
    pub(crate) start: f32,
    pub(crate) end: f32,
}

impl BlockMargins {
    pub(crate) const ZERO: Self = Self::new(0.0, 0.0);

    pub(crate) const fn new(start: f32, end: f32) -> Self {
        Self { start, end }
    }

    pub(crate) const fn total(self) -> f32 {
        self.start + self.end
    }
}

/// Block-axis spacing around a retained border box.
///
/// CSS margins participate in sibling collapse. Formatting-context insets and
/// trailing continuation extent do not, so keeping them distinct prevents a
/// renderer or offscreen painter from treating internal table geometry as a
/// margin.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct BlockFlowSpacing {
    pub(crate) margins: BlockMargins,
    pub(crate) internal: BlockMargins,
    pub(crate) extra_end: f32,
}

impl BlockFlowSpacing {
    pub(crate) const fn from_margins(margins: BlockMargins) -> Self {
        Self {
            margins,
            internal: BlockMargins::ZERO,
            extra_end: 0.0,
        }
    }

    pub(crate) const fn from_internal_start(internal_start: f32) -> Self {
        Self {
            margins: BlockMargins::ZERO,
            internal: BlockMargins::new(internal_start, 0.0),
            extra_end: 0.0,
        }
    }

    pub(crate) const fn content_extent(self, box_extent: f32) -> f32 {
        self.internal.total() + box_extent + self.extra_end
    }

    pub(crate) const fn outer_extent(self, box_extent: f32) -> f32 {
        self.margins.total() + self.content_extent(box_extent)
    }
}

/// Common margin access for every concrete [`LayoutElement`] box kind.
///
/// Consumers operate on the semantic pair and no longer destructure every
/// element variant merely to rediscover the same two scalar fields.
pub(crate) trait MarginHolder {
    fn margins(&self) -> &BlockMargins;
    fn margins_mut(&mut self) -> &mut BlockMargins;
}
