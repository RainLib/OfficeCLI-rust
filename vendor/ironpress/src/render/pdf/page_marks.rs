use super::{PdfEllipse, PdfMatrix, PdfPoint, PdfRect, PdfVector};
use crate::parser::css::{PageBleed, PageOrientation, PageSheetDescriptors, PrinterMarks};
use crate::types::PageSize;

/// Resolved physical-sheet behavior for a rendered page.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PageSheet {
    marks: PageMarks,
    orientation: PageOrientation,
}

impl PageSheet {
    /// Resolve the cascaded CSS page descriptors into physical sheet state.
    pub(crate) fn resolve(descriptors: PageSheetDescriptors) -> Self {
        Self {
            marks: PageMarks::resolve(descriptors.bleed(), descriptors.marks()),
            orientation: descriptors.orientation(),
        }
    }

    pub(crate) const fn bleed(self) -> f32 {
        self.marks.bleed
    }

    pub(crate) const fn has_effect(self) -> bool {
        self.marks.bleed > 0.0 || self.orientation.rotates()
    }

    /// Visible paint bounds before post-layout page orientation is applied.
    pub(super) fn paint_box(self, page: PageSize) -> PdfRect {
        let bleed = self.marks.bleed;
        PdfRect::new(
            -bleed,
            -bleed,
            page.width + 2.0 * bleed,
            page.height + 2.0 * bleed,
        )
    }

    /// Physical PDF media size after post-layout page orientation.
    pub(super) fn media_size(self, page: PageSize) -> PageSize {
        let sheet = PageSize::new(
            page.width + 2.0 * self.marks.bleed,
            page.height + 2.0 * self.marks.bleed,
        );
        if self.orientation.rotates() {
            PageSize::new(sheet.height, sheet.width)
        } else {
            sheet
        }
    }

    /// Transform from the laid-out page box into the physical PDF sheet.
    pub(super) fn page_matrix(self, page: PageSize) -> PdfMatrix {
        let bleed = self.marks.bleed;
        match self.orientation {
            PageOrientation::Upright => PdfMatrix::translate(PdfPoint::new(bleed, bleed)),
            PageOrientation::RotateLeft => PdfMatrix::new(
                PdfVector::new(0.0, 1.0),
                PdfVector::new(-1.0, 0.0),
                PdfPoint::new(page.height + bleed, bleed),
            ),
            PageOrientation::RotateRight => PdfMatrix::new(
                PdfVector::new(0.0, -1.0),
                PdfVector::new(1.0, 0.0),
                PdfPoint::new(bleed, page.width + bleed),
            ),
        }
    }

    pub(super) fn paint_marks(self, content: &mut String, page: PageSize) {
        self.marks.paint(content, page);
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct PageMarks {
    bleed: f32,
    kind: PrinterMarks,
}

impl PageMarks {
    /// CSS Paged Media resolves `bleed:auto` to 6pt when crop marks are
    /// requested and to zero otherwise.
    fn resolve(bleed: PageBleed, kind: PrinterMarks) -> Self {
        let bleed = match bleed {
            PageBleed::Auto if kind.has_crop() => 6.0,
            PageBleed::Auto => 0.0,
            PageBleed::Points(points) => points,
        };
        Self { bleed, kind }
    }

    fn paint(self, content: &mut String, page: PageSize) {
        if self.bleed <= 0.0 || self.kind.is_none() {
            return;
        }

        let geometry = PrinterMarkGeometry::new(self.bleed, page);
        content.push_str("q\n0 0 0 RG\n0 J\n0 j\n");
        if self.kind.has_crop() {
            geometry.paint_crop(content);
        }
        if self.kind.has_cross() {
            geometry.paint_registration_targets(content);
        }
        content.push_str("Q\n");
    }
}

/// Conventional printer-mark geometry within one uniform bleed area.
#[derive(Debug, Clone, Copy)]
struct PrinterMarkGeometry {
    bleed: f32,
    page: PageSize,
}

impl PrinterMarkGeometry {
    const CROP_STROKE_WIDTH: f32 = 0.75;
    const CROSS_STROKE_WIDTH: f32 = 0.375;
    const TARGET_STROKE_WIDTH: f32 = 0.1875;

    const fn new(bleed: f32, page: PageSize) -> Self {
        Self { bleed, page }
    }

    fn paint_crop(self, content: &mut String) {
        let half_bleed = self.bleed / 2.0;
        let width = self.page.width;
        let height = self.page.height;
        MarkStroke::new(Self::CROP_STROKE_WIDTH).paint(
            content,
            [
                MarkLine::new(
                    PdfPoint::new(0.0, -self.bleed),
                    PdfPoint::new(0.0, -half_bleed),
                ),
                MarkLine::new(
                    PdfPoint::new(width, -self.bleed),
                    PdfPoint::new(width, -half_bleed),
                ),
                MarkLine::new(
                    PdfPoint::new(0.0, height + half_bleed),
                    PdfPoint::new(0.0, height + self.bleed),
                ),
                MarkLine::new(
                    PdfPoint::new(width, height + half_bleed),
                    PdfPoint::new(width, height + self.bleed),
                ),
                MarkLine::new(
                    PdfPoint::new(-self.bleed, 0.0),
                    PdfPoint::new(-half_bleed, 0.0),
                ),
                MarkLine::new(
                    PdfPoint::new(width + half_bleed, 0.0),
                    PdfPoint::new(width + self.bleed, 0.0),
                ),
                MarkLine::new(
                    PdfPoint::new(-self.bleed, height),
                    PdfPoint::new(-half_bleed, height),
                ),
                MarkLine::new(
                    PdfPoint::new(width + half_bleed, height),
                    PdfPoint::new(width + self.bleed, height),
                ),
            ],
        );
    }

    fn paint_registration_targets(self, content: &mut String) {
        let center_offset = self.bleed * 0.75;
        let centers = [
            PdfPoint::new(self.page.width / 2.0, -center_offset),
            PdfPoint::new(self.page.width / 2.0, self.page.height + center_offset),
            PdfPoint::new(-center_offset, self.page.height / 2.0),
            PdfPoint::new(self.page.width + center_offset, self.page.height / 2.0),
        ];

        content.push_str(&format!("{} w\n", Self::TARGET_STROKE_WIDTH));
        for center in centers {
            PdfEllipse::circle(center, self.bleed / 8.0).push_path(content);
            content.push_str("S\n");
        }

        let half_extent = self.bleed / 4.0;
        MarkStroke::new(Self::CROSS_STROKE_WIDTH).paint(
            content,
            centers.into_iter().flat_map(|center| {
                [
                    MarkLine::horizontal(center, half_extent),
                    MarkLine::vertical(center, half_extent),
                ]
            }),
        );
    }
}

#[derive(Debug, Clone, Copy)]
struct MarkLine {
    start: PdfPoint,
    end: PdfPoint,
}

impl MarkLine {
    const fn new(start: PdfPoint, end: PdfPoint) -> Self {
        Self { start, end }
    }

    const fn horizontal(center: PdfPoint, half_extent: f32) -> Self {
        Self::new(
            PdfPoint::new(center.x - half_extent, center.y),
            PdfPoint::new(center.x + half_extent, center.y),
        )
    }

    const fn vertical(center: PdfPoint, half_extent: f32) -> Self {
        Self::new(
            PdfPoint::new(center.x, center.y - half_extent),
            PdfPoint::new(center.x, center.y + half_extent),
        )
    }

    fn paint(self, content: &mut String) {
        content.push_str(&format!(
            "{} {} m {} {} l S\n",
            self.start.x, self.start.y, self.end.x, self.end.y,
        ));
    }
}

#[derive(Debug, Clone, Copy)]
struct MarkStroke {
    width: f32,
}

impl MarkStroke {
    const fn new(width: f32) -> Self {
        Self { width }
    }

    fn paint(self, content: &mut String, lines: impl IntoIterator<Item = MarkLine>) {
        content.push_str(&format!("{} w\n", self.width));
        for line in lines {
            line.paint(content);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_bleed_resolves_from_crop_mark_presence() {
        let mut crop = PageSheetDescriptors::default();
        crop.set_marks(PrinterMarks::Crop);
        assert_eq!(PageSheet::resolve(crop).bleed(), 6.0);

        let mut cross = PageSheetDescriptors::default();
        cross.set_marks(PrinterMarks::Cross);
        assert_eq!(PageSheet::resolve(cross).bleed(), 0.0);
    }
}
