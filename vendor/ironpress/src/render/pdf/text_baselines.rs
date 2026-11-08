//! Shared horizontal text-baseline painting.
//!
//! CSS line layout retains its own flow cursor through PDF painting. Keeping
//! that fractional position intact prevents paint-time rounding from changing
//! a line's glyph coverage without changing its layout geometry.

use super::{LineBoxMetrics, transforms::PageContentTransform};

/// Advances a text block's fractional flow position and resolves individual
/// horizontal baselines for PDF painting.
#[derive(Clone, Copy, Debug)]
pub(super) struct TextBaselineCursor {
    flow_y: f32,
    page_content: PageContentTransform,
}

impl TextBaselineCursor {
    pub(super) const fn new(content_top: f32, page_content: PageContentTransform) -> Self {
        Self {
            flow_y: content_top,
            page_content,
        }
    }

    /// Advance one line while preserving the fractional flow cursor.
    pub(super) fn next_raw(&mut self, metrics: LineBoxMetrics) -> f32 {
        self.flow_y -= metrics.half_leading + metrics.ascender;
        let baseline = self.flow_y;
        self.flow_y -= metrics.descender + metrics.half_leading;
        baseline
    }

    /// Advance one ordinary horizontal line without perturbing fractional layout
    /// geometry at paint time.
    pub(super) fn next_horizontal(&mut self, metrics: LineBoxMetrics) -> f32 {
        let baseline = self.next_raw(metrics);
        self.page_content.snap_horizontal_baseline(baseline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_paint_snaps_each_baseline_without_changing_line_advance() {
        let page = PageContentTransform::print(crate::render::pdf::PdfVector::new(150.0, 150.0));
        let mut cursor = TextBaselineCursor::new(103.5, page);
        let metrics = LineBoxMetrics {
            ascender: 16.5,
            descender: 6.6,
            half_leading: 0.0,
        };

        assert_eq!(cursor.next_horizontal(metrics), 87.0);
        assert_eq!(cursor.next_horizontal(metrics), 63.75);
        assert_eq!(cursor.next_horizontal(metrics), 40.5);
        assert!((cursor.flow_y - 34.2).abs() < 0.000_1);
    }
}
