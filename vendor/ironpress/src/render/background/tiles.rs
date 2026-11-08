//! Shared CSS background tile geometry.

use crate::style::computed::{BackgroundPosition, BackgroundRepeat, BackgroundSize};
use crate::types::{Point, Size};
use crate::util::{AxisRepeatMode, AxisRepeatPattern};

/// Per-axis interpretation of one `background-repeat` value.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BackgroundRepeatModes {
    pub(crate) horizontal: AxisRepeatMode,
    pub(crate) vertical: AxisRepeatMode,
}

impl BackgroundRepeatModes {
    pub(crate) fn is_distributed(self) -> bool {
        matches!(
            self.horizontal,
            AxisRepeatMode::Space | AxisRepeatMode::Round
        ) || matches!(self.vertical, AxisRepeatMode::Space | AxisRepeatMode::Round)
    }
}

impl From<BackgroundRepeat> for BackgroundRepeatModes {
    fn from(repeat: BackgroundRepeat) -> Self {
        let horizontal = match repeat {
            BackgroundRepeat::NoRepeat | BackgroundRepeat::RepeatY => AxisRepeatMode::NoRepeat,
            BackgroundRepeat::Space | BackgroundRepeat::SpaceRound => AxisRepeatMode::Space,
            BackgroundRepeat::Round | BackgroundRepeat::RoundSpace => AxisRepeatMode::Round,
            _ => AxisRepeatMode::Repeat,
        };
        let vertical = match repeat {
            BackgroundRepeat::NoRepeat | BackgroundRepeat::RepeatX => AxisRepeatMode::NoRepeat,
            BackgroundRepeat::Round | BackgroundRepeat::SpaceRound => AxisRepeatMode::Round,
            BackgroundRepeat::Space | BackgroundRepeat::RoundSpace => AxisRepeatMode::Space,
            _ => AxisRepeatMode::Repeat,
        };
        Self {
            horizontal,
            vertical,
        }
    }
}

/// Constant-size geometry for sampling or enumerating one CSS background layer.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BackgroundTilePattern {
    horizontal: AxisRepeatPattern,
    vertical: AxisRepeatPattern,
    repeat_modes: BackgroundRepeatModes,
}

impl BackgroundTilePattern {
    pub(crate) fn resolve(
        size: BackgroundSize,
        position: BackgroundPosition,
        repeat: BackgroundRepeat,
        positioning_area: Size,
    ) -> Option<Self> {
        if !positioning_area.width.is_finite()
            || !positioning_area.height.is_finite()
            || positioning_area.width <= 0.0
            || positioning_area.height <= 0.0
        {
            return None;
        }
        let tile_size = resolve_tile_size(size, positioning_area)?;
        let offset = resolve_position(position, positioning_area, tile_size);
        let repeat_modes = BackgroundRepeatModes::from(repeat);
        Some(Self {
            horizontal: AxisRepeatPattern::new_layout(
                repeat_modes.horizontal,
                offset.x,
                tile_size.width,
                positioning_area.width,
            )?,
            vertical: AxisRepeatPattern::new_layout(
                repeat_modes.vertical,
                offset.y,
                tile_size.height,
                positioning_area.height,
            )?,
            repeat_modes,
        })
    }

    pub(crate) fn tile_size(self) -> Size {
        Size::new(self.horizontal.tile_size(), self.vertical.tile_size())
    }

    pub(crate) fn sample(self, point: Point) -> Option<Point> {
        Some(Point::new(
            self.horizontal.sample(point.x)?,
            self.vertical.sample(point.y)?,
        ))
    }

    pub(crate) const fn axes(self) -> (AxisRepeatPattern, AxisRepeatPattern) {
        (self.horizontal, self.vertical)
    }

    pub(crate) fn has_distributed_repeat(self) -> bool {
        self.repeat_modes.is_distributed()
    }
}

fn resolve_tile_size(size: BackgroundSize, positioning_area: Size) -> Option<Size> {
    let resolve = |value: f32, is_percent: bool, basis: f32| {
        if is_percent {
            basis * value / 100.0
        } else {
            value
        }
    };
    let tile = match size {
        BackgroundSize::Explicit {
            width,
            height,
            width_is_percent,
            height_is_percent,
        }
        | BackgroundSize::ExplicitAuto {
            width: Some(width),
            height,
            width_is_percent,
            height_is_percent,
        } => Size::new(
            resolve(width, width_is_percent, positioning_area.width),
            height.map_or(positioning_area.height, |height| {
                resolve(height, height_is_percent, positioning_area.height)
            }),
        ),
        BackgroundSize::ExplicitAuto {
            width: None,
            height: Some(height),
            height_is_percent,
            ..
        } => Size::new(
            positioning_area.width,
            resolve(height, height_is_percent, positioning_area.height),
        ),
        BackgroundSize::Auto
        | BackgroundSize::Cover
        | BackgroundSize::Contain
        | BackgroundSize::ExplicitAuto { .. } => positioning_area,
    };
    (tile.width.is_finite() && tile.height.is_finite() && tile.width > 0.0 && tile.height > 0.0)
        .then_some(tile)
}

fn resolve_position(
    position: BackgroundPosition,
    positioning_area: Size,
    tile_size: Size,
) -> Point {
    let axis = |value: f32, is_percent: bool, area: f32, tile: f32| {
        if is_percent {
            (area - tile) * value
        } else if value < 0.0 {
            area - tile + value
        } else {
            value
        }
    };
    Point::new(
        axis(
            position.x,
            position.x_is_percent,
            positioning_area.width,
            tile_size.width,
        ),
        axis(
            position.y,
            position.y_is_percent,
            positioning_area.height,
            tile_size.height,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_repeat_changes_the_sampled_tile_size_on_each_axis() {
        let pattern = BackgroundTilePattern::resolve(
            BackgroundSize::Explicit {
                width: 30.0,
                height: Some(40.0),
                width_is_percent: false,
                height_is_percent: false,
            },
            BackgroundPosition::default(),
            BackgroundRepeat::Round,
            Size::new(100.0, 100.0),
        )
        .expect("finite background tile pattern");

        let rounded = crate::layout::units::LayoutUnit::from_points(100.0 / 3.0).to_points();
        assert_eq!(pattern.tile_size(), Size::new(rounded, rounded));
    }
}
