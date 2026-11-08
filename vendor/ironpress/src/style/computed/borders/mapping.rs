use super::*;

/// A flow-relative side before the element's writing mode maps it to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogicalSide {
    BlockStart,
    BlockEnd,
    InlineStart,
    InlineEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogicalAxis {
    Block,
    Inline,
}

impl LogicalAxis {
    pub(super) const fn sides(self) -> [LogicalSide; 2] {
        match self {
            Self::Block => [LogicalSide::BlockStart, LogicalSide::BlockEnd],
            Self::Inline => [LogicalSide::InlineStart, LogicalSide::InlineEnd],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogicalCorner {
    StartStart,
    StartEnd,
    EndStart,
    EndEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PhysicalCorner {
    TopLeft,
    TopRight,
    BottomRight,
    BottomLeft,
}

/// Complete element-relative mapping used by every logical border family.
#[derive(Debug, Clone, Copy)]
pub(super) struct FlowMapping {
    mode: WritingMode,
    rtl: bool,
}

impl FlowMapping {
    pub(super) fn from_style(style: &ComputedStyle) -> Self {
        let mode = style.writing_mode;
        let rtl = style.direction_rtl && !(mode.is_vertical() && style.text_orientation_upright);
        Self { mode, rtl }
    }

    pub(super) const fn side(self, side: LogicalSide) -> PhysicalSide {
        match (self.mode, side, self.rtl) {
            (WritingMode::HorizontalTb, LogicalSide::BlockStart, _) => PhysicalSide::Top,
            (WritingMode::HorizontalTb, LogicalSide::BlockEnd, _) => PhysicalSide::Bottom,
            (WritingMode::HorizontalTb, LogicalSide::InlineStart, false) => PhysicalSide::Left,
            (WritingMode::HorizontalTb, LogicalSide::InlineStart, true) => PhysicalSide::Right,
            (WritingMode::HorizontalTb, LogicalSide::InlineEnd, false) => PhysicalSide::Right,
            (WritingMode::HorizontalTb, LogicalSide::InlineEnd, true) => PhysicalSide::Left,

            (WritingMode::VerticalRl | WritingMode::SidewaysRl, LogicalSide::BlockStart, _) => {
                PhysicalSide::Right
            }
            (WritingMode::VerticalRl | WritingMode::SidewaysRl, LogicalSide::BlockEnd, _) => {
                PhysicalSide::Left
            }
            (WritingMode::VerticalLr | WritingMode::SidewaysLr, LogicalSide::BlockStart, _) => {
                PhysicalSide::Left
            }
            (WritingMode::VerticalLr | WritingMode::SidewaysLr, LogicalSide::BlockEnd, _) => {
                PhysicalSide::Right
            }

            (
                WritingMode::VerticalRl | WritingMode::VerticalLr | WritingMode::SidewaysRl,
                LogicalSide::InlineStart,
                false,
            )
            | (WritingMode::SidewaysLr, LogicalSide::InlineStart, true) => PhysicalSide::Top,
            (
                WritingMode::VerticalRl | WritingMode::VerticalLr | WritingMode::SidewaysRl,
                LogicalSide::InlineStart,
                true,
            )
            | (WritingMode::SidewaysLr, LogicalSide::InlineStart, false) => PhysicalSide::Bottom,
            (
                WritingMode::VerticalRl | WritingMode::VerticalLr | WritingMode::SidewaysRl,
                LogicalSide::InlineEnd,
                false,
            )
            | (WritingMode::SidewaysLr, LogicalSide::InlineEnd, true) => PhysicalSide::Bottom,
            (
                WritingMode::VerticalRl | WritingMode::VerticalLr | WritingMode::SidewaysRl,
                LogicalSide::InlineEnd,
                true,
            )
            | (WritingMode::SidewaysLr, LogicalSide::InlineEnd, false) => PhysicalSide::Top,
        }
    }

    pub(super) const fn corner(self, corner: LogicalCorner) -> PhysicalCorner {
        let (block_start, inline_start) = match corner {
            LogicalCorner::StartStart => (true, true),
            LogicalCorner::StartEnd => (true, false),
            LogicalCorner::EndStart => (false, true),
            LogicalCorner::EndEnd => (false, false),
        };
        let (top, left) = match self.mode {
            WritingMode::HorizontalTb => (block_start, inline_start != self.rtl),
            WritingMode::VerticalRl | WritingMode::SidewaysRl => {
                (inline_start != self.rtl, !block_start)
            }
            WritingMode::VerticalLr => (inline_start != self.rtl, block_start),
            WritingMode::SidewaysLr => (inline_start == self.rtl, block_start),
        };
        match (top, left) {
            (true, true) => PhysicalCorner::TopLeft,
            (true, false) => PhysicalCorner::TopRight,
            (false, false) => PhysicalCorner::BottomRight,
            (false, true) => PhysicalCorner::BottomLeft,
        }
    }
}
