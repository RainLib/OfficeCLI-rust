//! Shared helpers used across the parser, layout, and renderer.

/// Maximum edge of one in-memory raster tile. Larger requested surfaces are
/// split into tiles instead of being downsampled to this limit.
pub(crate) const MAX_RASTER_TILE_EDGE: u32 = 2_048;

/// Pixel dimensions requested for a raster surface.
///
/// Large surfaces are represented as a grid of bounded [`RasterTile`]s; the
/// dimensions themselves are never silently reduced to a resource limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RasterDimensions {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl RasterDimensions {
    /// Convert point extents to pixels at a caller-provided scale relative to
    /// the CSS reference pixel. Returns `None` when the request cannot be
    /// represented exactly by this pixel-coordinate type.
    pub(crate) fn scaled_points(width: f32, height: f32, scale: f32) -> Option<Self> {
        Self::from_point_scales(width, height, scale / 0.75, scale / 0.75)
    }

    /// Convert point extents to pixels, retaining a final partial source pixel.
    ///
    /// This is appropriate for coverage images: rounding down their final pixel
    /// would discard part of the painted area.
    pub(crate) fn scaled_points_ceil(width: f32, height: f32, scale: f32) -> Option<Self> {
        let pixels_per_point = f64::from(scale) / 0.75;
        Self::from_point_scales_with_rounding(
            width,
            height,
            pixels_per_point,
            pixels_per_point,
            f64::ceil,
        )
    }

    /// Convert point extents with independent horizontal and vertical
    /// pixels-per-point scales.
    pub(crate) fn from_point_scales(
        width: f32,
        height: f32,
        scale_x: f32,
        scale_y: f32,
    ) -> Option<Self> {
        Self::from_point_scales_with_rounding(
            width,
            height,
            f64::from(scale_x),
            f64::from(scale_y),
            f64::round,
        )
    }

    fn from_point_scales_with_rounding(
        width: f32,
        height: f32,
        scale_x: f64,
        scale_y: f64,
        round_pixels: impl Fn(f64) -> f64,
    ) -> Option<Self> {
        let dimension = |extent: f32, scale: f64| {
            if !extent.is_finite() || !scale.is_finite() || extent <= 0.0 || scale <= 0.0 {
                return None;
            }
            let pixels = round_pixels(f64::from(extent) * scale);
            if pixels > f64::from(u32::MAX) {
                None
            } else {
                Some(pixels.max(1.0) as u32)
            }
        };
        Some(Self {
            width: dimension(width, scale_x)?,
            height: dimension(height, scale_y)?,
        })
    }

    pub(crate) fn tiles(self, max_edge: u32) -> Option<RasterTiles> {
        (max_edge > 0).then_some(RasterTiles {
            dimensions: self,
            max_edge,
            next_x: 0,
            next_y: 0,
        })
    }
}

/// One top-down pixel rectangle within a larger raster surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RasterTile {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct RasterTiles {
    dimensions: RasterDimensions,
    max_edge: u32,
    next_x: u32,
    next_y: u32,
}

impl Iterator for RasterTiles {
    type Item = RasterTile;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next_y >= self.dimensions.height {
            return None;
        }
        let tile = RasterTile {
            x: self.next_x,
            y: self.next_y,
            width: self.max_edge.min(self.dimensions.width - self.next_x),
            height: self.max_edge.min(self.dimensions.height - self.next_y),
        };
        self.next_x += tile.width;
        if self.next_x == self.dimensions.width {
            self.next_x = 0;
            self.next_y += tile.height;
        }
        Some(tile)
    }
}

/// One-axis CSS image repetition policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AxisRepeatMode {
    Repeat,
    NoRepeat,
    Space,
    /// Distribute unused space before, after, and between tiles. Border-image
    /// uses this perimeter-gap variant; background-repeat: space does not.
    SpaceAround,
    Round,
}

/// Constant-size arithmetic description of repeated one-dimensional tiles.
///
/// Authored tile sizes can be arbitrarily small, so the logical repeat count
/// is deliberately never stored as or expanded into a collection.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AxisRepeatPattern {
    tile_size: f64,
    placement: AxisRepeatPlacement,
}

#[derive(Debug, Clone, Copy)]
enum AxisRepeatPlacement {
    One {
        offset: f64,
    },
    Periodic {
        first: f64,
        stride: f64,
        count: Option<f64>,
    },
}

impl AxisRepeatPattern {
    #[cfg(test)]
    pub(crate) fn new(mode: AxisRepeatMode, origin: f32, size: f32, extent: f32) -> Option<Self> {
        Self::resolve(mode, origin, size, extent, |value| value)
    }

    /// Resolve CSS repetition in point coordinates, truncating a computed
    /// `round` tile size to the canonical 26.6 layout grid.
    pub(crate) fn new_layout(
        mode: AxisRepeatMode,
        origin: f32,
        size: f32,
        extent: f32,
    ) -> Option<Self> {
        Self::resolve(mode, origin, size, extent, |value| {
            crate::layout::units::LayoutUnit::from_points(value).to_points()
        })
    }

    fn resolve(
        mode: AxisRepeatMode,
        origin: f32,
        size: f32,
        extent: f32,
        quantize_round_size: impl FnOnce(f32) -> f32,
    ) -> Option<Self> {
        if ![origin, size, extent].into_iter().all(f32::is_finite) || size <= 0.0 || extent <= 0.0 {
            return None;
        }

        let origin = f64::from(origin);
        let size = f64::from(size);
        let extent = f64::from(extent);
        let one = |offset| Self {
            tile_size: size,
            placement: AxisRepeatPlacement::One { offset },
        };
        match mode {
            AxisRepeatMode::NoRepeat => Some(one(origin)),
            AxisRepeatMode::Repeat => Some(Self {
                tile_size: size,
                placement: AxisRepeatPlacement::Periodic {
                    // The infinite lattice is invariant under whole strides;
                    // keep its canonical phase close to the sampled window.
                    first: origin.rem_euclid(size),
                    stride: size,
                    count: None,
                },
            }),
            AxisRepeatMode::Space => {
                let count = (extent / size).floor().max(1.0);
                if count == 1.0 {
                    // With only one copy, `space` behaves as no-repeat and the
                    // authored position remains observable.
                    Some(one(origin))
                } else {
                    let gap = (extent - size * count) / (count - 1.0);
                    Some(Self {
                        tile_size: size,
                        placement: AxisRepeatPlacement::Periodic {
                            first: 0.0,
                            stride: size + gap,
                            count: Some(count),
                        },
                    })
                }
            }
            AxisRepeatMode::SpaceAround => {
                let count = (extent / size).floor();
                let gap = (extent - size * count) / (count + 1.0);
                Some(Self {
                    tile_size: size,
                    placement: AxisRepeatPlacement::Periodic {
                        first: gap,
                        stride: size + gap,
                        count: Some(count),
                    },
                })
            }
            AxisRepeatMode::Round => {
                let count = (extent / size).round().max(1.0);
                let rounded_size = f64::from(quantize_round_size((extent / count) as f32));
                if !rounded_size.is_finite() || rounded_size <= 0.0 {
                    return None;
                }
                Some(Self {
                    tile_size: rounded_size,
                    placement: AxisRepeatPlacement::Periodic {
                        first: 0.0,
                        stride: rounded_size,
                        count: Some(count),
                    },
                })
            }
        }
    }

    pub(crate) fn tile_size(self) -> f32 {
        self.tile_size as f32
    }

    pub(crate) fn first(self) -> f32 {
        match self.placement {
            AxisRepeatPlacement::One { offset }
            | AxisRepeatPlacement::Periodic { first: offset, .. } => offset as f32,
        }
    }

    pub(crate) fn stride(self) -> Option<f32> {
        match self.placement {
            AxisRepeatPlacement::One { .. } => None,
            AxisRepeatPlacement::Periodic { stride, .. } => Some(stride as f32),
        }
    }

    /// Return a shader-cell stride that preserves the CSS repetition mode
    /// throughout a visible window.
    ///
    /// PDF tiling patterns repeat in both axes even when CSS says
    /// `no-repeat`. A one-tile CSS axis therefore needs a synthetic stride
    /// whose neighbouring cells are wholly outside the eventual paint clip.
    /// One full tile of guard space also keeps antialiasing at the clip edge
    /// from exposing a neighbouring synthetic cell.
    pub(crate) fn shader_stride(self, start: f32, end: f32) -> Option<f32> {
        if let Some(stride) = self.stride() {
            return Some(stride);
        }
        if !start.is_finite() || !end.is_finite() || start >= end {
            return None;
        }

        let first = self.first();
        let size = self.tile_size();
        let exclusion_distance = (end - first).max(first + size - start).max(size);
        let stride = exclusion_distance + size;
        (stride.is_finite() && stride > 0.0).then_some(stride)
    }

    /// Extend a periodic image-shader lattice beyond its eventual paint clip.
    ///
    /// Browser PDF backends materialize the shader over a page surface and
    /// apply the CSS patch clip afterwards. The finite CSS repeat count still
    /// determines its spacing; only the invisible lattice outside that clip is
    /// extended here.
    pub(crate) fn unbounded_lattice(mut self) -> Self {
        if let AxisRepeatPlacement::Periodic { count, .. } = &mut self.placement {
            *count = None;
        }
        self
    }

    /// Extend the image shader cell beyond its eventual CSS clip.
    ///
    /// Even a stretched axis is materialized as a repeating shader cell by
    /// browser paint backends. The destination clip exposes only the authored
    /// cell, while the neighbouring invisible cells keep interpolation at that
    /// clip edge from sampling transparent black.
    pub(crate) fn shader_lattice(mut self) -> Self {
        self.placement = match self.placement {
            AxisRepeatPlacement::One { offset } => AxisRepeatPlacement::Periodic {
                first: offset,
                stride: self.tile_size,
                count: None,
            },
            AxisRepeatPlacement::Periodic { first, stride, .. } => AxisRepeatPlacement::Periodic {
                first,
                stride,
                count: None,
            },
        };
        self
    }

    pub(crate) fn translated(mut self, offset: f32) -> Option<Self> {
        if !offset.is_finite() {
            return None;
        }
        let offset = f64::from(offset);
        match &mut self.placement {
            AxisRepeatPlacement::One { offset: first }
            | AxisRepeatPlacement::Periodic { first, .. } => *first += offset,
        }
        Some(self)
    }

    /// Resolve the local coordinate of the tile covering `coordinate` without
    /// searching or materializing any repeat origins.
    pub(crate) fn sample(self, coordinate: f32) -> Option<f32> {
        if !coordinate.is_finite() {
            return None;
        }
        let coordinate = f64::from(coordinate);
        let start = match self.placement {
            AxisRepeatPlacement::One { offset } => offset,
            AxisRepeatPlacement::Periodic {
                first,
                stride,
                count,
            } => {
                let index = ((coordinate - first) / stride).floor();
                if count.is_some_and(|count| index < 0.0 || index >= count) {
                    return None;
                }
                first + index * stride
            }
        };
        let local = coordinate - start;
        (local >= 0.0 && local < self.tile_size).then_some(local as f32)
    }

    /// Lazily enumerate authored tile origins overlapping a coordinate window.
    pub(crate) fn placements(self, start: f32, end: f32) -> Option<AxisRepeatPlacements> {
        if !start.is_finite() || !end.is_finite() || start >= end {
            return None;
        }
        let start = f64::from(start);
        let end = f64::from(end);
        let state = match self.placement {
            AxisRepeatPlacement::One { offset } => AxisRepeatPlacementState::One(
                (offset < end && offset + self.tile_size > start).then_some(offset),
            ),
            AxisRepeatPlacement::Periodic {
                first,
                stride,
                count,
            } => {
                let mut next = ((start - self.tile_size - first) / stride).floor() + 1.0;
                let mut limit = ((end - first) / stride).ceil();
                if let Some(count) = count {
                    next = next.max(0.0);
                    limit = limit.min(count);
                }
                AxisRepeatPlacementState::Periodic {
                    first,
                    stride,
                    next,
                    limit,
                    last: None,
                }
            }
        };
        Some(AxisRepeatPlacements { state })
    }

    /// Whether exactly one logical tile intersects the requested window.
    pub(crate) fn is_single_in(self, start: f32, end: f32) -> bool {
        let Some(mut placements) = self.placements(start, end) else {
            return false;
        };
        placements.next().is_some() && placements.next().is_none()
    }

    /// Enumerate only distinct raster origins whose tile intersects a pixel
    /// window. Logical subpixel repeats that round to the same destination are
    /// skipped arithmetically, keeping work bounded by the sampled window.
    pub(crate) fn pixel_placements(
        self,
        start: i64,
        end: i64,
        pixels_per_unit: f32,
    ) -> Option<AxisRepeatPixelPlacements> {
        if start >= end || !pixels_per_unit.is_finite() || pixels_per_unit <= 0.0 {
            return None;
        }
        let scale = f64::from(pixels_per_unit);
        let tile_pixels = (self.tile_size * scale).round().max(1.0);
        if !tile_pixels.is_finite() || tile_pixels > i64::MAX as f64 {
            return None;
        }
        let tile_pixels = tile_pixels as i64;
        let candidate_start = start.saturating_sub(tile_pixels.saturating_sub(1));
        let candidate_end = end;
        let state = match self.placement {
            AxisRepeatPlacement::One { offset } => {
                let destination = (offset * scale).round() as i64;
                AxisRepeatPixelPlacementState::One(
                    (destination < end && destination.saturating_add(tile_pixels) > start)
                        .then_some(destination),
                )
            }
            AxisRepeatPlacement::Periodic {
                first,
                stride,
                count,
            } => {
                // This deliberately overestimates by one placement on either
                // side, then filters exact rounded destinations while iterating.
                let mut next =
                    (((candidate_start as f64 - 1.0) / scale - first) / stride).floor() - 1.0;
                let mut limit =
                    (((candidate_end as f64 + 1.0) / scale - first) / stride).ceil() + 1.0;
                if let Some(count) = count {
                    next = next.max(0.0);
                    limit = limit.min(count);
                }
                let candidate_count = candidate_end.saturating_sub(candidate_start) as u64;
                let logical_count = (limit - next).ceil().max(0.0);
                if logical_count <= candidate_count.saturating_mul(2).saturating_add(8) as f64 {
                    AxisRepeatPixelPlacementState::Logical {
                        first,
                        stride,
                        scale,
                        next,
                        remaining: logical_count as u64,
                        candidate_start,
                        candidate_end,
                        last: None,
                    }
                } else {
                    AxisRepeatPixelPlacementState::Destinations {
                        first,
                        stride,
                        count,
                        scale,
                        next: candidate_start,
                        end: candidate_end,
                    }
                }
            }
        };
        Some(AxisRepeatPixelPlacements { state })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AxisRepeatPlacements {
    state: AxisRepeatPlacementState,
}

#[derive(Debug, Clone)]
enum AxisRepeatPlacementState {
    One(Option<f64>),
    Periodic {
        first: f64,
        stride: f64,
        next: f64,
        limit: f64,
        last: Option<f64>,
    },
}

impl Iterator for AxisRepeatPlacements {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.state {
            AxisRepeatPlacementState::One(offset) => offset.take().map(|value| value as f32),
            AxisRepeatPlacementState::Periodic {
                first,
                stride,
                next,
                limit,
                last,
            } => {
                while *next < *limit {
                    let index = *next;
                    let advanced = index + 1.0;
                    *next = if advanced > index { advanced } else { *limit };
                    let position = *first + index * *stride;
                    if last.replace(position) == Some(position) || !position.is_finite() {
                        continue;
                    }
                    let position = position as f32;
                    if position.is_finite() {
                        return Some(position);
                    }
                }
                None
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AxisRepeatPixelPlacements {
    state: AxisRepeatPixelPlacementState,
}

#[derive(Debug, Clone)]
enum AxisRepeatPixelPlacementState {
    One(Option<i64>),
    Logical {
        first: f64,
        stride: f64,
        scale: f64,
        next: f64,
        remaining: u64,
        candidate_start: i64,
        candidate_end: i64,
        last: Option<i64>,
    },
    Destinations {
        first: f64,
        stride: f64,
        count: Option<f64>,
        scale: f64,
        next: i64,
        end: i64,
    },
}

impl Iterator for AxisRepeatPixelPlacements {
    type Item = i64;

    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.state {
            AxisRepeatPixelPlacementState::One(destination) => destination.take(),
            AxisRepeatPixelPlacementState::Logical {
                first,
                stride,
                scale,
                next,
                remaining,
                candidate_start,
                candidate_end,
                last,
            } => {
                while *remaining > 0 {
                    let index = *next;
                    let advanced = index + 1.0;
                    *next = if advanced > index {
                        advanced
                    } else {
                        f64::INFINITY
                    };
                    *remaining -= 1;
                    let destination = ((*first + index * *stride) * *scale).round() as i64;
                    if destination < *candidate_start
                        || destination >= *candidate_end
                        || last.replace(destination) == Some(destination)
                    {
                        continue;
                    }
                    return Some(destination);
                }
                None
            }
            AxisRepeatPixelPlacementState::Destinations {
                first,
                stride,
                count,
                scale,
                next,
                end,
            } => {
                while *next < *end {
                    let destination = *next;
                    *next += 1;
                    let center_index = ((destination as f64 / *scale - *first) / *stride).round();
                    for delta in [-2.0, -1.0, 0.0, 1.0, 2.0] {
                        let index = center_index + delta;
                        if count.is_some_and(|count| index < 0.0 || index >= count) {
                            continue;
                        }
                        if (*first + index * *stride).mul_add(*scale, 0.0).round() as i64
                            == destination
                        {
                            return Some(destination);
                        }
                    }
                }
                None
            }
        }
    }
}

/// Decode a standard Base64 string without pulling in an extra dependency.
pub(crate) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn table(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut result = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut chunks = bytes.chunks_exact(4);

    for chunk in &mut chunks {
        let a = table(chunk[0])?;
        let b = table(chunk[1])?;
        result.push((a << 2) | (b >> 4));

        if chunk[2] != b'=' {
            let c = table(chunk[2])?;
            result.push((b << 4) | (c >> 2));

            if chunk[3] != b'=' {
                let d = table(chunk[3])?;
                result.push((c << 6) | d);
            }
        }
    }

    match chunks.remainder() {
        [] | [_] => {}
        [a, b] => {
            let a = table(*a)?;
            let b = table(*b)?;
            result.push((a << 2) | (b >> 4));
        }
        [a, b, c] => {
            let a = table(*a)?;
            let b = table(*b)?;
            result.push((a << 2) | (b >> 4));
            if *c != b'=' {
                let c = table(*c)?;
                result.push((b << 4) | (c >> 2));
            }
        }
        _ => return None,
    }

    Some(result)
}

#[cfg(test)]
mod tests {
    use super::{AxisRepeatMode, AxisRepeatPattern, RasterDimensions, RasterTile, decode_base64};

    #[test]
    fn axis_repeat_pattern_samples_huge_logical_counts_in_constant_space() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::Repeat, 0.0, 1e-9, 1e30).unwrap();
        assert!(std::mem::size_of_val(&pattern) <= 5 * std::mem::size_of::<f64>());
        let local = pattern.sample(2.25e-9).unwrap();
        assert!(local >= 0.0 && local < pattern.tile_size());

        let placements = pattern
            .pixel_placements(0, 2_048, 1.0)
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(placements.len(), 2_048);
        assert_eq!(placements[0], 0);
        assert_eq!(placements[2_047], 2_047);

        let huge_origin = 1e30_f32;
        let size = 0.125_f32;
        let huge =
            AxisRepeatPattern::new(AxisRepeatMode::Repeat, huge_origin, size, 100.0).unwrap();
        let canonical = AxisRepeatPattern::new(
            AxisRepeatMode::Repeat,
            f64::from(huge_origin).rem_euclid(f64::from(size)) as f32,
            size,
            100.0,
        )
        .unwrap();
        assert_eq!(huge.first(), canonical.first());
        assert_eq!(huge.sample(57.0625), canonical.sample(57.0625));
        assert_eq!(
            huge.pixel_placements(0, 128, 1.0)
                .unwrap()
                .collect::<Vec<_>>(),
            canonical
                .pixel_placements(0, 128, 1.0)
                .unwrap()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn axis_repeat_pixel_placements_convert_point_offsets_to_raster_pixels() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::Repeat, 0.0, 60.0, 180.0).unwrap();

        assert_eq!(
            pattern
                .pixel_placements(0, 750, 750.0 / 180.0)
                .unwrap()
                .collect::<Vec<_>>(),
            [0, 250, 500]
        );
    }

    #[test]
    fn axis_space_with_one_tile_preserves_authored_position() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::Space, 17.0, 60.0, 100.0).unwrap();
        assert_eq!(pattern.sample(16.0), None);
        assert_eq!(pattern.sample(17.0), Some(0.0));
        assert_eq!(pattern.sample(27.0), Some(10.0));
        assert_eq!(pattern.sample(77.0), None);
        assert_eq!(
            pattern.placements(0.0, 100.0).unwrap().collect::<Vec<_>>(),
            [17.0]
        );

        let repeated = AxisRepeatPattern::new(AxisRepeatMode::Space, 99.0, 30.0, 100.0).unwrap();
        let placements = repeated.placements(0.0, 100.0).unwrap().collect::<Vec<_>>();
        assert_eq!(placements, [0.0, 35.0, 70.0]);
        let stride = repeated.stride().unwrap();
        assert!(placements[0] - stride + repeated.tile_size() <= 0.0);
        assert!(placements[2] + stride >= 100.0);
    }

    #[test]
    fn axis_space_around_distributes_border_image_perimeter_gaps() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::SpaceAround, 0.0, 10.0, 38.0).unwrap();
        assert_eq!(
            pattern.placements(0.0, 38.0).unwrap().collect::<Vec<_>>(),
            [2.0, 14.0, 26.0]
        );

        let empty = AxisRepeatPattern::new(AxisRepeatMode::SpaceAround, 0.0, 10.0, 8.0).unwrap();
        assert!(empty.placements(0.0, 8.0).unwrap().next().is_none());
    }

    #[test]
    fn axis_repeat_placements_are_window_bounded_and_translatable() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::Repeat, 3.0, 10.0, 100.0)
            .unwrap()
            .translated(20.0)
            .unwrap();
        assert_eq!(pattern.sample(24.0), Some(1.0));
        assert_eq!(pattern.sample(22.0), Some(9.0));
        assert_eq!(
            pattern.placements(20.0, 50.0).unwrap().collect::<Vec<_>>(),
            [13.0, 23.0, 33.0, 43.0]
        );
    }

    #[test]
    fn axis_repeat_detects_a_single_visible_tile_without_expanding_the_lattice() {
        let exact = AxisRepeatPattern::new(AxisRepeatMode::Repeat, 0.0, 100.0, 100.0).unwrap();
        assert!(exact.is_single_in(0.0, 100.0));

        let partial = AxisRepeatPattern::new(AxisRepeatMode::Repeat, 25.0, 100.0, 100.0).unwrap();
        assert!(!partial.is_single_in(0.0, 100.0));
    }

    #[test]
    fn no_repeat_shader_stride_isolates_the_visible_window() {
        let pattern = AxisRepeatPattern::new(AxisRepeatMode::NoRepeat, 0.0, 20.0, 100.0).unwrap();
        let start = -3.0;
        let end = 103.0;
        let stride = pattern.shader_stride(start, end).unwrap();

        assert!(pattern.first() + stride > end);
        assert!(pattern.first() + pattern.tile_size() - stride < start);
    }

    #[test]
    fn raster_dimensions_preserve_requested_resolution_and_tile_it() {
        let dimensions = RasterDimensions::scaled_points(3_000.0, 1_600.0, 1.0).unwrap();
        assert_eq!(dimensions.width, 4_000);
        assert_eq!(dimensions.height, 2_133);
        assert_eq!(
            dimensions.tiles(2_048).unwrap().collect::<Vec<_>>(),
            vec![
                RasterTile {
                    x: 0,
                    y: 0,
                    width: 2_048,
                    height: 2_048,
                },
                RasterTile {
                    x: 2_048,
                    y: 0,
                    width: 1_952,
                    height: 2_048,
                },
                RasterTile {
                    x: 0,
                    y: 2_048,
                    width: 2_048,
                    height: 85,
                },
                RasterTile {
                    x: 2_048,
                    y: 2_048,
                    width: 1_952,
                    height: 85,
                },
            ]
        );
    }

    #[test]
    fn coverage_dimensions_do_not_gain_a_pixel_from_scale_rounding() {
        assert_eq!(
            RasterDimensions::scaled_points_ceil(937.5, 0.75, 4.0),
            Some(RasterDimensions {
                width: 5_000,
                height: 4,
            })
        );
    }

    #[test]
    fn raster_dimensions_reject_unrepresentable_requests() {
        assert!(RasterDimensions::scaled_points(f32::MAX, 1.0, 1.0).is_none());
        assert!(RasterDimensions::scaled_points(1.0, 1.0, 0.0).is_none());
        assert!(RasterDimensions::scaled_points(1.0, 1.0, f32::NAN).is_none());
        assert!(
            RasterDimensions {
                width: 1,
                height: 1
            }
            .tiles(0)
            .is_none()
        );
    }

    #[test]
    fn decode_base64_basic() {
        assert_eq!(
            decode_base64("SGVsbG8=").as_deref(),
            Some(b"Hello".as_ref())
        );
    }

    #[test]
    fn decode_base64_with_whitespace() {
        assert_eq!(
            decode_base64("SGVs\nbG8=").as_deref(),
            Some(b"Hello".as_ref())
        );
    }

    #[test]
    fn decode_base64_ignores_single_trailing_byte() {
        assert_eq!(
            decode_base64("SGVsbG8=A").as_deref(),
            Some(b"Hello".as_ref())
        );
    }

    #[test]
    fn decode_base64_empty_string() {
        assert_eq!(decode_base64("").as_deref(), Some(b"".as_ref()));
    }

    #[test]
    fn decode_base64_no_padding_two_chars() {
        // "YQ" is "a" without padding (base64 of b"a" is "YQ==")
        assert_eq!(decode_base64("YQ").as_deref(), Some(b"a".as_ref()));
    }

    #[test]
    fn decode_base64_no_padding_three_chars() {
        // "YWI" is "ab" without padding (base64 of b"ab" is "YWI=")
        assert_eq!(decode_base64("YWI").as_deref(), Some(b"ab".as_ref()));
    }

    #[test]
    fn decode_base64_invalid_character_returns_none() {
        assert!(decode_base64("SG!s").is_none());
    }

    #[test]
    fn decode_base64_another_invalid_character_returns_none() {
        // '@' is not a valid base64 character
        assert!(decode_base64("SGVs@G8=").is_none());
    }

    #[test]
    fn decode_base64_longer_multi_block_string() {
        // base64 of b"The quick brown fox"
        assert_eq!(
            decode_base64("VGhlIHF1aWNrIGJyb3duIGZveA==").as_deref(),
            Some(b"The quick brown fox".as_ref())
        );
    }

    #[test]
    fn decode_base64_longer_string_no_padding() {
        // base64 of b"ironpress" is "aXJvbnByZXNz" (no padding needed — 9 bytes → 12 chars)
        assert_eq!(
            decode_base64("aXJvbnByZXNz").as_deref(),
            Some(b"ironpress".as_ref())
        );
    }
}
