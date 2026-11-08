use super::*;
use crate::style::computed::{
    BorderImage, BorderImagePaint, BorderImageRepeatMode, BorderImageRepeats,
};
use crate::util::{AxisRepeatMode, AxisRepeatPattern, AxisRepeatPlacements};

mod raster;
mod source;

use raster::RepeatedBorderImage;
use source::*;

#[derive(Debug, Clone, Copy)]
struct SliceAxis {
    source: [f32; 4],
    destination: [f32; 4],
}

impl SliceAxis {
    fn span(self, index: usize) -> Option<(std::ops::Range<f32>, std::ops::Range<f32>)> {
        let next = index.checked_add(1)?;
        Some((
            *self.source.get(index)?..*self.source.get(next)?,
            *self.destination.get(index)?..*self.destination.get(next)?,
        ))
    }

    fn scale(self, index: usize) -> Option<f32> {
        let (source, destination) = self.span(index)?;
        let scale = (destination.end - destination.start) / (source.end - source.start);
        (scale.is_finite() && scale > 0.0).then_some(scale)
    }
}

#[derive(Debug, Clone, Copy)]
struct BorderImagePatch {
    source: PdfRect,
    destination: PdfRect,
    horizontal: BorderImageRepeatMode,
    vertical: BorderImageRepeatMode,
    horizontal_scale: f32,
    vertical_scale: f32,
}

impl BorderImagePatch {
    fn repeats_image(self) -> bool {
        self.horizontal != BorderImageRepeatMode::Stretch
            || self.vertical != BorderImageRepeatMode::Stretch
    }

    fn tiling(self) -> Option<PatchTiling> {
        Some(PatchTiling {
            x: TiledAxis::new(
                self.source.left,
                self.source.width,
                self.destination.left,
                self.destination.width,
                self.horizontal_scale,
                self.horizontal,
            )?,
            y: TiledAxis::new(
                self.source.bottom,
                self.source.height,
                self.destination.bottom,
                self.destination.height,
                self.vertical_scale,
                self.vertical,
            )?,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct AxisTile {
    source_start: f32,
    source_size: f32,
    destination_start: f32,
    destination_size: f32,
}

/// A source axis, one destination axis, and the lazily generated tiles that
/// connect them. The logical tile count is never materialized.
#[derive(Debug, Clone, Copy)]
struct TiledAxis {
    source_start: f32,
    source_size: f32,
    destination_start: f32,
    destination_size: f32,
    pattern: AxisRepeatPattern,
}

#[derive(Debug, Clone, Copy)]
struct PatchTiling {
    x: TiledAxis,
    y: TiledAxis,
}

impl TiledAxis {
    fn new(
        source_start: f32,
        source_size: f32,
        destination_start: f32,
        destination_size: f32,
        proportional_scale: f32,
        repeat: BorderImageRepeatMode,
    ) -> Option<Self> {
        if ![
            source_start,
            source_size,
            destination_start,
            destination_size,
            proportional_scale,
        ]
        .into_iter()
        .all(f32::is_finite)
            || source_size <= 0.0
            || destination_size <= 0.0
            || proportional_scale <= 0.0
        {
            return None;
        }

        let proportional_size = source_size * proportional_scale;
        let (mode, origin, tile_size) = match repeat {
            BorderImageRepeatMode::Stretch => (AxisRepeatMode::NoRepeat, 0.0, destination_size),
            BorderImageRepeatMode::Repeat => (
                AxisRepeatMode::Repeat,
                (destination_size - proportional_size) * 0.5,
                proportional_size,
            ),
            BorderImageRepeatMode::Round => (AxisRepeatMode::Round, 0.0, proportional_size),
            BorderImageRepeatMode::Space => (AxisRepeatMode::SpaceAround, 0.0, proportional_size),
        };
        Some(Self {
            source_start,
            source_size,
            destination_start,
            destination_size,
            pattern: AxisRepeatPattern::new_layout(mode, origin, tile_size, destination_size)?,
        })
    }

    fn placements(self) -> Option<AxisRepeatPlacements> {
        self.pattern.placements(0.0, self.destination_size)
    }

    fn tile_at(self, local_start: f32) -> Option<AxisTile> {
        let full_size = self.pattern.tile_size();
        let clipped_start = local_start.max(0.0);
        let clipped_end = (local_start + full_size).min(self.destination_size);
        if clipped_end <= clipped_start {
            return None;
        }
        let source_per_destination = self.source_size / full_size;
        Some(AxisTile {
            source_start: self.source_start
                + (clipped_start - local_start) * source_per_destination,
            source_size: (clipped_end - clipped_start) * source_per_destination,
            destination_start: self.destination_start + clipped_start,
            destination_size: clipped_end - clipped_start,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct BorderImageGrid {
    x: SliceAxis,
    y: SliceAxis,
    fill_center: bool,
    repeats: BorderImageRepeats,
}

impl BorderImageGrid {
    fn new(
        image_area: PdfRect,
        border: EdgeSizes,
        border_image: BorderImage,
        source_geometry: BorderImageSourceGeometry,
    ) -> Self {
        let source = border_image.slices.resolve(
            source_geometry.width,
            source_geometry.height,
            source_geometry.number_scale,
        );
        let natural_slices = source_geometry
            .natural_slice_scale
            .map(|scale| source * scale);
        let destination = border_image.widths.resolve(
            border,
            image_area.width,
            image_area.height,
            natural_slices,
        );
        Self {
            x: SliceAxis {
                source: [
                    0.0,
                    source.left,
                    source_geometry.width - source.right,
                    source_geometry.width,
                ],
                destination: [
                    image_area.left,
                    image_area.left + destination.left,
                    image_area.right() - destination.right,
                    image_area.right(),
                ],
            },
            y: SliceAxis {
                source: [
                    0.0,
                    source.bottom,
                    source_geometry.height - source.top,
                    source_geometry.height,
                ],
                destination: [
                    image_area.bottom,
                    image_area.bottom + destination.bottom,
                    image_area.top() - destination.top,
                    image_area.top(),
                ],
            },
            fill_center: border_image.slices.fill,
            repeats: border_image.repeats,
        }
    }

    fn patches(self) -> impl Iterator<Item = BorderImagePatch> {
        (0..3).flat_map(move |row| {
            (0..3).filter_map(move |column| {
                if row == 1 && column == 1 && !self.fill_center {
                    return None;
                }
                let (source_x, destination_x) = self.x.span(column)?;
                let (source_y, destination_y) = self.y.span(row)?;
                let source = PdfRect::new(
                    source_x.start,
                    source_y.start,
                    source_x.end - source_x.start,
                    source_y.end - source_y.start,
                );
                let destination = PdfRect::new(
                    destination_x.start,
                    destination_y.start,
                    destination_x.end - destination_x.start,
                    destination_y.end - destination_y.start,
                );
                if source.is_empty() || destination.is_empty() {
                    return None;
                }
                let horizontal_scale = if row == 1 {
                    self.y.scale(2).or_else(|| self.y.scale(0)).unwrap_or(1.0)
                } else {
                    destination.height / source.height
                };
                let vertical_scale = if column == 1 {
                    self.x.scale(0).or_else(|| self.x.scale(2)).unwrap_or(1.0)
                } else {
                    destination.width / source.width
                };
                Some(BorderImagePatch {
                    source,
                    destination,
                    horizontal: if column == 1 {
                        self.repeats.horizontal
                    } else {
                        BorderImageRepeatMode::Stretch
                    },
                    vertical: if row == 1 {
                        self.repeats.vertical
                    } else {
                        BorderImageRepeatMode::Stretch
                    },
                    horizontal_scale,
                    vertical_scale,
                })
            })
        })
    }
}

fn paint_border_image_patch(content: &mut String, form: &ImageRef, patch: BorderImagePatch) {
    let Some(PatchTiling {
        x: x_axis,
        y: y_axis,
    }) = patch.tiling()
    else {
        return;
    };
    let Some(x_placements) = x_axis.placements() else {
        return;
    };
    for x_start in x_placements {
        let Some(x) = x_axis.tile_at(x_start) else {
            continue;
        };
        let Some(y_placements) = y_axis.placements() else {
            return;
        };
        for y_start in y_placements {
            let Some(y) = y_axis.tile_at(y_start) else {
                continue;
            };
            paint_slice(
                content,
                form,
                PdfRect::new(x.source_start, y.source_start, x.source_size, y.source_size),
                PdfRect::new(
                    x.destination_start,
                    y.destination_start,
                    x.destination_size,
                    y.destination_size,
                ),
            );
        }
    }
}

fn paint_slice(content: &mut String, form: &ImageRef, source: PdfRect, destination: PdfRect) {
    let scale = PdfVector::new(
        destination.width / source.width,
        destination.height / source.height,
    );
    let mapping = PdfMatrix::translate(PdfPoint::new(destination.left, destination.bottom))
        * PdfMatrix::scale(scale)
        * PdfMatrix::translate(PdfPoint::new(-source.left, -source.bottom));
    content.push_str("q\n");
    content.push_str(&destination.rect_path());
    content.push_str("W n\n");
    content.push_str(&mapping.cm_operator());
    content.push_str(&format!("/{} Do\nQ\n", form.name));
}

pub(super) struct BorderImageShadings<'a> {
    pub(super) entries: &'a mut Vec<ShadingEntry>,
    pub(super) counter: &'a mut usize,
}

pub(super) fn render_border_image(
    content: &mut String,
    border_image: &BorderImagePaint,
    geometry: PaintBoxGeometry,
    shadings: BorderImageShadings<'_>,
    page_ext_gstates: &mut Vec<(String, f32)>,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) -> bool {
    let outer = geometry.border_box;
    if outer.is_empty() {
        return true;
    }
    let image_area = outer.outset(border_image.geometry.outsets.resolve(geometry.border));
    if image_area.is_empty() {
        return true;
    }
    let Some(mut source) =
        resolve_border_image_source(&border_image.source, &mut pdf_writer.resources)
    else {
        return false;
    };
    let clamp_slice_edges = source.needs_slice_edge_clamp();
    let Some(source_geometry) = source.prepare(image_area) else {
        return false;
    };
    let source_box = PdfRect::new(0.0, 0.0, source_geometry.width, source_geometry.height);
    let grid = BorderImageGrid::new(
        image_area,
        geometry.border,
        border_image.geometry,
        source_geometry,
    );
    let form = register_border_image_source(
        &source,
        source_box,
        image_area,
        shadings.entries,
        shadings.counter,
        page_ext_gstates,
        pdf_writer,
        page_images,
    );
    let repeated_source = RepeatedBorderImage::resolve(&source, source_geometry);
    page_images.push(form.clone());
    for patch in grid.patches() {
        if patch.repeats_image()
            && repeated_source
                .as_ref()
                .is_some_and(|source| source.paint_patch(content, patch, pdf_writer, page_images))
        {
            continue;
        }
        if clamp_slice_edges {
            let slice =
                register_border_image_slice(&source, &form, patch.source, pdf_writer, page_images);
            paint_border_image_patch(content, &slice, patch);
            page_images.push(slice);
        } else {
            paint_border_image_patch(content, &form, patch);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::{
        BorderImageOutset, BorderImageOutsets, BorderImageSliceValue, BorderImageSlices,
        BorderImageWidth, BorderImageWidths, LengthPercent,
    };

    fn generated_grid(
        outer: PdfRect,
        border: EdgeSizes,
        border_image: BorderImage,
    ) -> BorderImageGrid {
        let image_area = outer.outset(border_image.outsets.resolve(border));
        BorderImageGrid::new(
            image_area,
            border,
            border_image,
            BorderImageSourceGeometry::generated(image_area),
        )
    }

    #[test]
    fn outset_expands_the_image_area_without_changing_border_box_geometry() {
        let outer = PdfRect::new(10.0, 20.0, 100.0, 40.0);
        let border = EdgeSizes::new(3.0, 5.0, 7.0, 11.0);
        let border_image = BorderImage {
            slices: BorderImageSlices::uniform(BorderImageSliceValue::Number(1.0)),
            outsets: BorderImageOutsets::uniform(BorderImageOutset::Number(2.0)),
            ..Default::default()
        };
        let grid = generated_grid(outer, border, border_image);

        assert_eq!(
            outer.outset(border_image.outsets.resolve(border)),
            PdfRect::new(-12.0, 6.0, 132.0, 60.0)
        );
        let bottom_left = grid.patches().next().unwrap();
        assert_eq!(bottom_left.destination, PdfRect::new(-12.0, 6.0, 11.0, 7.0));
    }

    #[test]
    fn length_width_can_paint_without_a_physical_border() {
        let grid = generated_grid(
            PdfRect::new(10.0, 20.0, 100.0, 40.0),
            EdgeSizes::ZERO,
            BorderImage {
                slices: BorderImageSlices::uniform(BorderImageSliceValue::Number(1.0)),
                widths: BorderImageWidths::uniform(BorderImageWidth::LengthPercent(
                    LengthPercent::length(2.0),
                )),
                ..Default::default()
            },
        );

        assert_eq!(grid.patches().count(), 8);
    }

    #[test]
    fn auto_width_uses_a_natural_source_slice() {
        let border = EdgeSizes::uniform(2.0);
        let border_image = BorderImage {
            slices: BorderImageSlices::uniform(BorderImageSliceValue::Number(8.0)),
            widths: BorderImageWidths::uniform(BorderImageWidth::Auto),
            ..Default::default()
        };
        let image_area = PdfRect::new(0.0, 0.0, 100.0, 60.0);
        let grid = BorderImageGrid::new(
            image_area,
            border,
            border_image,
            BorderImageSourceGeometry::natural(32.0, 32.0)
                .expect("positive raster source geometry"),
        );

        let bottom_left = grid.patches().next().expect("corner patch");
        assert_eq!(bottom_left.destination.width, 6.0);
        assert_eq!(bottom_left.destination.height, 6.0);
    }

    #[test]
    fn svg_border_image_uses_its_concrete_object_size_as_source_coordinates() {
        let tree = crate::parser::svg::parse_svg_from_string(
            r#"<svg viewBox="0 0 2 1"><rect width="2" height="1"/></svg>"#,
        )
        .expect("valid SVG border image");
        let mut source = ResolvedBorderImageSource::Svg(Box::new(tree));

        let geometry = source
            .prepare(PdfRect::new(0.0, 0.0, 120.0, 120.0))
            .expect("positive concrete SVG size");

        assert_eq!(geometry.width, 160.0);
        assert_eq!(geometry.height, 80.0);
    }

    #[test]
    fn repeat_centers_partial_end_tiles_and_crops_the_source_with_them() {
        let axis =
            TiledAxis::new(24.0, 96.0, 6.0, 132.0, 0.25, BorderImageRepeatMode::Repeat).unwrap();
        let tiles = axis
            .placements()
            .unwrap()
            .filter_map(|start| axis.tile_at(start))
            .collect::<Vec<_>>();

        assert_eq!(tiles.len(), 7);
        assert_eq!(tiles[0].destination_start, 6.0);
        assert_eq!(tiles[0].destination_size, 6.0);
        assert_eq!(tiles[0].source_start, 96.0);
        assert_eq!(tiles[0].source_size, 24.0);
        assert_eq!(tiles[3].destination_start, 60.0);
        assert_eq!(tiles[3].destination_size, 24.0);
        assert_eq!(tiles[3].source_start, 24.0);
        assert_eq!(tiles[6].destination_start, 132.0);
        assert_eq!(tiles[6].destination_size, 6.0);
        assert_eq!(tiles[6].source_start, 24.0);
        assert_eq!(tiles[6].source_size, 24.0);
    }

    #[test]
    fn space_leaves_equal_perimeter_and_intertile_gaps() {
        let axis = TiledAxis::new(0.0, 10.0, 0.0, 38.0, 1.0, BorderImageRepeatMode::Space).unwrap();
        assert_eq!(
            axis.placements().unwrap().collect::<Vec<_>>(),
            vec![2.0, 14.0, 26.0]
        );
    }
}
