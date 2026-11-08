use super::PdfTilingPattern;
use crate::render::background::{BackgroundRepeatModes, BackgroundTilePattern};
use crate::render::pdf::geometry::{PdfMatrix, PdfPoint, PdfRect, PdfVector};
use crate::render::pdf::transforms::PdfPaintSpace;
use crate::style::computed::{BackgroundRepeat, GradientLayerBox};
use crate::types::Size;
use crate::util::{AxisRepeatPattern, AxisRepeatPlacements, RasterDimensions};

/// Above this many cells, a PDF tiling pattern remains the compact rendering.
/// `space` and `round` normally produce only a few cells; painting that bounded
/// grid directly avoids a renderer-visible seam at every PDF pattern boundary.
const MAX_DIRECT_DISTRIBUTED_TILES: usize = 256;

pub(in crate::render::pdf) type RepeatModes = BackgroundRepeatModes;

#[derive(Debug, Clone, Copy)]
pub(in crate::render::pdf) struct LayerTilePattern {
    area: LayerPaintArea,
    x: AxisRepeatPattern,
    y: AxisRepeatPattern,
    distributed_repeat: bool,
}

/// The two independent boxes that govern a CSS background layer.
///
/// Tile size, position, and phase are resolved against `positioning_box`.
/// Repetition is then extended through `painting_box`, where the caller applies
/// the possibly-rounded `background-clip`. Keeping both boxes in one value
/// prevents a renderer from accidentally treating `background-origin` as a
/// second clip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(in crate::render::pdf) struct LayerPaintArea {
    positioning_box: PdfRect,
    painting_box: PdfRect,
}

impl LayerPaintArea {
    pub(in crate::render::pdf) const fn new(
        positioning_box: PdfRect,
        painting_box: PdfRect,
    ) -> Self {
        Self {
            positioning_box,
            painting_box,
        }
    }

    #[cfg(test)]
    pub(in crate::render::pdf) const fn single(rect: PdfRect) -> Self {
        Self::new(rect, rect)
    }

    fn horizontal_window(self) -> (f32, f32) {
        (
            self.painting_box.left - self.positioning_box.left,
            self.painting_box.right() - self.positioning_box.left,
        )
    }

    fn vertical_window(self) -> (f32, f32) {
        (
            self.positioning_box.top() - self.painting_box.top(),
            self.positioning_box.top() - self.painting_box.bottom,
        )
    }

    fn shader_step(
        self,
        horizontal: AxisRepeatPattern,
        vertical: AxisRepeatPattern,
    ) -> Option<PdfVector> {
        let (x_start, x_end) = self.horizontal_window();
        let (y_start, y_end) = self.vertical_window();
        Some(PdfVector::new(
            horizontal.shader_stride(x_start, x_end)?,
            vertical.shader_stride(y_start, y_end)?,
        ))
    }

    fn to_positioning_coordinates(self, point: PdfPoint) -> PdfPoint {
        PdfPoint::new(
            point.x + self.painting_box.left - self.positioning_box.left,
            point.y + self.positioning_box.top() - self.painting_box.top(),
        )
    }
}

impl LayerTilePattern {
    pub(in crate::render::pdf) const fn new(
        area: LayerPaintArea,
        x: AxisRepeatPattern,
        y: AxisRepeatPattern,
    ) -> Self {
        Self {
            area,
            x,
            y,
            distributed_repeat: false,
        }
    }

    pub(in crate::render::pdf) const fn with_distributed_repeat(
        mut self,
        distributed_repeat: bool,
    ) -> Self {
        self.distributed_repeat = distributed_repeat;
        self
    }

    pub(in crate::render::pdf) fn tile_size(self) -> PdfVector {
        PdfVector::new(self.x.tile_size(), self.y.tile_size())
    }

    pub(in crate::render::pdf) fn first_tile(self) -> Option<PdfRect> {
        let (x_start, x_end) = self.area.horizontal_window();
        let (y_start, y_end) = self.area.vertical_window();
        let origin = PdfPoint::new(
            self.x.placements(x_start, x_end)?.next()?,
            self.y.placements(y_start, y_end)?.next()?,
        );
        let size = self.tile_size();
        Some(PdfRect::new(
            self.area.positioning_box.left + origin.x,
            self.area.positioning_box.top() - origin.y - size.y,
            size.x,
            size.y,
        ))
    }

    pub(in crate::render::pdf) fn is_single(self) -> bool {
        let (x_start, x_end) = self.area.horizontal_window();
        let (y_start, y_end) = self.area.vertical_window();
        self.x.is_single_in(x_start, x_end) && self.y.is_single_in(y_start, y_end)
    }

    pub(in crate::render::pdf) fn paint_box(self) -> PdfRect {
        self.area.painting_box
    }

    pub(in crate::render::pdf) const fn has_distributed_repeat(self) -> bool {
        self.distributed_repeat
    }

    #[cfg(test)]
    pub(in crate::render::pdf) fn sample(self, point: PdfPoint) -> Option<PdfPoint> {
        let point = self.area.to_positioning_coordinates(point);
        Some(PdfPoint::new(
            self.x.sample(point.x)?,
            self.y.sample(point.y)?,
        ))
    }

    /// Sample the renderer's repeated shader lattice before the CSS paint clip.
    ///
    /// Fixed-point `round` sizing can leave a subpixel remainder after the
    /// finite logical count. Browser paint backends materialize the shader
    /// across their fallback surface, then apply the authored clip while
    /// painting that surface. Keeping those stages separate also prevents
    /// transparent source pixels from leaking into the clipped edge during PDF
    /// image interpolation.
    pub(in crate::render::pdf) fn sample_shader_lattice(self, point: PdfPoint) -> Option<PdfPoint> {
        let point = self.area.to_positioning_coordinates(point);
        Some(PdfPoint::new(
            self.x.unbounded_lattice().sample(point.x)?,
            self.y.unbounded_lattice().sample(point.y)?,
        ))
    }

    fn tiles(self) -> Option<LayerTilePlacements> {
        let (x_start, x_end) = self.area.horizontal_window();
        let (y_start, y_end) = self.area.vertical_window();
        Some(LayerTilePlacements {
            positioning_box: self.area.positioning_box,
            tile_size: self.tile_size(),
            x: self.x.placements(x_start, x_end)?,
            y_pattern: self.y,
            y_window: (y_start, y_end),
            current_x: None,
            y: None,
        })
    }

    fn has_at_most_direct_tiles(self) -> bool {
        let Some(mut tiles) = self.tiles() else {
            return false;
        };
        for _ in 0..=MAX_DIRECT_DISTRIBUTED_TILES {
            if tiles.next().is_none() {
                return true;
            }
        }
        false
    }

    pub(in crate::render::pdf) fn pdf_pattern(self, bbox: PdfRect) -> Option<PdfTilingPattern> {
        let first_tile = self.first_tile()?;
        let painting_box = self.area.painting_box;
        Some(PdfTilingPattern {
            bbox,
            paint_box: PdfRect::new(0.0, 0.0, painting_box.width, painting_box.height),
            step: self.area.shader_step(self.x, self.y)?,
            transform: PdfMatrix::translate(PdfPoint::new(
                first_tile.left - painting_box.left,
                first_tile.bottom - painting_box.bottom,
            )),
        })
    }

    pub(in crate::render::pdf) fn pdf_raster_pattern(
        self,
        source: RasterDimensions,
    ) -> Option<PdfTilingPattern> {
        let tile_size = self.tile_size();
        let mut pattern = self.pdf_pattern(PdfRect::new(0.0, 0.0, tile_size.x, tile_size.y))?;
        let scale = tile_size
            .component_quotient(PdfVector::new(source.width as f32, source.height as f32))?;
        pattern.bbox = PdfRect::new(0.0, 0.0, source.width as f32, source.height as f32);
        pattern.step = pattern.step.component_quotient(scale)?;
        pattern.transform = pattern.transform * PdfMatrix::scale(scale);
        Some(pattern)
    }

    /// Describe a raster cell directly in default page space. Chromium anchors
    /// the pattern axes to the transformed page bounds, then carries the tile
    /// phase in the cell BBox instead of in the matrix translation.
    pub(in crate::render::pdf) fn pdf_page_raster_pattern(
        self,
        source: RasterDimensions,
        paint_space: PdfPaintSpace,
    ) -> Option<PdfTilingPattern> {
        let first_tile = self.first_tile()?;
        let source_size = PdfVector::new(source.width as f32, source.height as f32);
        let scale = self.tile_size().component_quotient(source_size)?;
        let step = self
            .area
            .shader_step(self.x, self.y)?
            .component_quotient(scale)?;
        let placement = paint_space.raster_cell_to_default(
            PdfPoint::new(first_tile.left, first_tile.top()),
            PdfVector::new(scale.x, -scale.y),
        )?;
        let placed = placement.placed;
        let transform = placement.pattern_transform;
        let pattern_origin = transform.inverse()?.transform_point(placed.translation);
        Some(PdfTilingPattern {
            bbox: PdfRect::new(
                pattern_origin.x,
                pattern_origin.y,
                source_size.x,
                source_size.y,
            ),
            paint_box: self.area.painting_box,
            step,
            transform,
        })
    }
}

struct LayerTilePlacements {
    positioning_box: PdfRect,
    tile_size: PdfVector,
    x: AxisRepeatPlacements,
    y_pattern: AxisRepeatPattern,
    y_window: (f32, f32),
    current_x: Option<f32>,
    y: Option<AxisRepeatPlacements>,
}

impl Iterator for LayerTilePlacements {
    type Item = PdfRect;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(y) = &mut self.y
                && let Some(y) = y.next()
            {
                let x = self.current_x?;
                return Some(PdfRect::new(
                    self.positioning_box.left + x,
                    self.positioning_box.top() - y - self.tile_size.y,
                    self.tile_size.x,
                    self.tile_size.y,
                ));
            }
            let x = self.x.next()?;
            self.current_x = Some(x);
            self.y = self.y_pattern.placements(self.y_window.0, self.y_window.1);
        }
    }
}

/// Paint a small, bounded `space`/`round` grid without a PDF tiling pattern.
/// Each cell is still rendered by the normal vector/raster gradient path; this
/// merely puts its clip directly in page content so viewers cannot anti-alias
/// one pattern cell against the next.
pub(in crate::render::pdf) fn paint_distributed_tiles(
    content: &mut String,
    pattern: LayerTilePattern,
    mut paint: impl FnMut(&mut String, PdfRect),
) -> bool {
    if !pattern.distributed_repeat || !pattern.has_at_most_direct_tiles() {
        return false;
    }
    let Some(tiles) = pattern.tiles() else {
        return false;
    };
    content.push_str("q\n");
    content.push_str(&pattern.paint_box().rect_path());
    content.push_str("W n\n");
    for tile in tiles {
        paint(content, tile);
    }
    content.push_str("Q\n");
    true
}

pub(in crate::render::pdf) fn gradient_layer_pattern(
    layer_box: &GradientLayerBox,
    area: LayerPaintArea,
) -> Option<LayerTilePattern> {
    let PdfRect { width, height, .. } = area.positioning_box;
    let tiles = BackgroundTilePattern::resolve(
        layer_box.size.unwrap_or_default(),
        layer_box.position.unwrap_or_default(),
        layer_box.repeat.unwrap_or(BackgroundRepeat::Repeat),
        Size::new(width, height),
    )?;
    let (horizontal, vertical) = tiles.axes();
    Some(
        LayerTilePattern::new(area, horizontal, vertical)
            .with_distributed_repeat(tiles.has_distributed_repeat()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::pdf::transforms::PageContentTransform;
    use crate::util::AxisRepeatMode;

    fn assert_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 1e-4, "{actual} != {expected}");
    }

    #[test]
    fn page_pattern_carries_tile_phase_in_its_bbox() {
        let paint_box = PdfRect::new(44.25, 42.75, 91.5, 55.5);
        let pattern = LayerTilePattern::new(
            LayerPaintArea::single(paint_box),
            AxisRepeatPattern::new(AxisRepeatMode::Repeat, 0.0, 13.5, paint_box.width).unwrap(),
            AxisRepeatPattern::new(AxisRepeatMode::Repeat, 0.0, 10.5, paint_box.height).unwrap(),
        );
        let to_default = PdfMatrix::new(
            PdfVector::new(1.032_809_1, -0.315_761_45),
            PdfVector::new(0.268_981_96, 0.879_800_4),
            PdfPoint::new(-19.095_955, 29.968_697),
        );
        let page_bounds = PdfRect::new(0.0, 0.0, 180.0, 138.0);

        let pdf_pattern = pattern
            .pdf_page_raster_pattern(
                RasterDimensions {
                    width: 4,
                    height: 4,
                },
                PdfPaintSpace::new(to_default, PageContentTransform::default(), page_bounds),
            )
            .unwrap();

        assert_eq!(pdf_pattern.step, PdfVector::new(4.0, 4.0));
        assert_eq!(pdf_pattern.bbox.width, 4.0);
        assert_eq!(pdf_pattern.bbox.height, 4.0);
        assert!(pdf_pattern.transform.y_axis.y < 0.0);

        let page_in_pattern =
            page_bounds.transformed_bounds(pdf_pattern.transform.inverse().unwrap());
        assert_close(page_in_pattern.left, 0.0);
        assert_close(page_in_pattern.bottom, 0.0);

        let tile_anchor = pdf_pattern.transform.transform_point(PdfPoint::new(
            pdf_pattern.bbox.left,
            pdf_pattern.bbox.bottom,
        ));
        let expected_anchor =
            to_default.transform_point(PdfPoint::new(paint_box.left, paint_box.top()));
        assert_close(tile_anchor.x, expected_anchor.x);
        assert_close(tile_anchor.y, expected_anchor.y);
    }

    #[test]
    fn distributed_gradient_tiles_keep_css_space_and_round_geometry() {
        let paint_box = PdfRect::new(0.0, 0.0, 135.0, 67.5);
        let pattern = LayerTilePattern::new(
            LayerPaintArea::single(paint_box),
            AxisRepeatPattern::new(AxisRepeatMode::Space, 0.0, 30.0, paint_box.width).unwrap(),
            AxisRepeatPattern::new(AxisRepeatMode::Round, 0.0, 18.0, paint_box.height).unwrap(),
        )
        .with_distributed_repeat(true);

        let tiles: Vec<_> = pattern.tiles().unwrap().collect();
        assert_eq!(tiles.len(), 16);
        assert_eq!(tiles[0], PdfRect::new(0.0, 50.625, 30.0, 16.875));
        assert_eq!(tiles[4], PdfRect::new(35.0, 50.625, 30.0, 16.875));
        assert_eq!(tiles[15], PdfRect::new(105.0, 0.0, 30.0, 16.875));
        assert!(pattern.has_at_most_direct_tiles());
    }

    #[test]
    fn repeated_layer_covers_the_paint_box_beyond_its_positioning_box() {
        let positioning_box = PdfRect::new(10.0, 10.0, 100.0, 50.0);
        let painting_box = PdfRect::new(8.0, 8.0, 104.0, 54.0);
        let pattern = LayerTilePattern::new(
            LayerPaintArea::new(positioning_box, painting_box),
            AxisRepeatPattern::new(
                AxisRepeatMode::Repeat,
                0.0,
                positioning_box.width,
                positioning_box.width,
            )
            .unwrap(),
            AxisRepeatPattern::new(
                AxisRepeatMode::Repeat,
                0.0,
                positioning_box.height,
                positioning_box.height,
            )
            .unwrap(),
        );

        let tiles: Vec<_> = pattern.tiles().unwrap().collect();
        assert_eq!(pattern.paint_box(), painting_box);
        assert_eq!(tiles.len(), 9);
        assert_eq!(tiles[0], PdfRect::new(-90.0, 60.0, 100.0, 50.0));
        assert_eq!(tiles[8], PdfRect::new(110.0, -40.0, 100.0, 50.0));
    }

    #[test]
    fn distributed_gradient_tiles_fall_back_before_expanding_a_large_grid() {
        let paint_box = PdfRect::new(0.0, 0.0, 1_000.0, 1_000.0);
        let pattern = LayerTilePattern::new(
            LayerPaintArea::single(paint_box),
            AxisRepeatPattern::new(AxisRepeatMode::Space, 0.0, 1.0, paint_box.width).unwrap(),
            AxisRepeatPattern::new(AxisRepeatMode::Round, 0.0, 1.0, paint_box.height).unwrap(),
        )
        .with_distributed_repeat(true);

        assert!(!pattern.has_at_most_direct_tiles());
    }

    #[test]
    fn shader_lattice_precedes_the_eventual_paint_clip() {
        let paint_box = PdfRect::new(0.0, 0.0, 138.0, 60.0);
        let pattern = LayerTilePattern::new(
            LayerPaintArea::single(paint_box),
            AxisRepeatPattern::new_layout(AxisRepeatMode::Repeat, 0.0, 30.0, paint_box.width)
                .unwrap(),
            AxisRepeatPattern::new_layout(AxisRepeatMode::Round, 0.0, 18.0, paint_box.height)
                .unwrap(),
        );

        assert!(
            pattern
                .sample(PdfPoint::new(10.0, paint_box.height - 0.001))
                .is_none()
        );
        assert!(
            pattern
                .sample_shader_lattice(PdfPoint::new(10.0, paint_box.height - 0.001))
                .is_some()
        );
        assert!(
            pattern
                .sample_shader_lattice(PdfPoint::new(10.0, paint_box.height + 0.001))
                .is_some()
        );
    }
}
