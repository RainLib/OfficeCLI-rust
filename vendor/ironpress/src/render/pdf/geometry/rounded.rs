use super::PdfRect;
use super::{PdfPoint, PdfVector};
use crate::render::curves::{
    CurveSink, CurveTolerance, EllipsePath, QuadraticBezier, RoundedRectPath,
};
use crate::types::{CornerRadii, EdgeSizes, Point, Rect, Vector};

/// A rectangle and its resolved corner geometry. Keeping the two together
/// prevents callers from insetting one without the other.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct RoundedRect {
    pub(in crate::render::pdf) rect: PdfRect,
    pub(in crate::render::pdf) radii: CornerRadii,
}

impl RoundedRect {
    pub(in crate::render::pdf) const fn new(rect: PdfRect, radii: CornerRadii) -> Self {
        Self { rect, radii }
    }

    pub(in crate::render::pdf) fn inset(self, edges: EdgeSizes) -> Self {
        Self::new(self.rect.inset(edges), self.radii.inset(edges))
    }

    pub(in crate::render::pdf) fn path(self) -> Option<String> {
        let radii = self.radii.fit_to(self.rect.width, self.rect.height);
        if radii.is_zero() {
            return None;
        }
        let mut content = String::new();
        let mut sink = PdfCurveSink::new(&mut content);
        RoundedRectPath::new(
            Rect::from_xywh(
                self.rect.left,
                -self.rect.top(),
                self.rect.width,
                self.rect.height,
            ),
            radii,
        )
        .write_to(&mut sink, CurveTolerance::PDF);
        Some(content)
    }

    pub(in crate::render::pdf) fn path_or_rect(self) -> String {
        self.path().unwrap_or_else(|| self.rect.rect_path())
    }

    pub(in crate::render::pdf) fn push_clip(self, content: &mut String) {
        content.push_str(&self.clip_command());
    }

    pub(in crate::render::pdf) fn clip_command(self) -> String {
        let mut command = String::from("q\n");
        command.push_str(&self.path_or_rect());
        command.push_str("W n\n");
        command
    }

    pub(in crate::render::pdf) fn push_rounded_clip(self, content: &mut String) -> bool {
        if self.radii.is_zero() {
            return false;
        }
        self.push_clip(content);
        true
    }
}

pub(super) fn push_ellipse_path(content: &mut String, center: PdfPoint, radii: PdfVector) {
    let Some(path) = EllipsePath::new(
        Point::new(center.x, -center.y),
        Vector::new(radii.x, radii.y),
    ) else {
        return;
    };
    path.write_to(&mut PdfCurveSink::new(content), CurveTolerance::PDF);
}

struct PdfCurveSink<'a> {
    content: &'a mut String,
}

impl<'a> PdfCurveSink<'a> {
    fn new(content: &'a mut String) -> Self {
        Self { content }
    }

    fn point(point: Point) -> PdfPoint {
        PdfPoint::new(point.x, -point.y)
    }
}

impl CurveSink for PdfCurveSink<'_> {
    fn move_to(&mut self, point: Point) {
        let point = Self::point(point);
        self.content
            .push_str(&format!("{} {} m\n", point.x, point.y));
    }

    fn line_to(&mut self, point: Point) {
        let point = Self::point(point);
        self.content
            .push_str(&format!("{} {} l\n", point.x, point.y));
    }

    fn quadratic_to(&mut self, curve: QuadraticBezier) {
        let control_1 = curve.start + (curve.control - curve.start) * (2.0 / 3.0);
        let control_2 = curve.end + (curve.control - curve.end) * (2.0 / 3.0);
        let control_1 = Self::point(control_1);
        let control_2 = Self::point(control_2);
        let end = Self::point(curve.end);
        self.content.push_str(&format!(
            "{} {} {} {} {} {} c\n",
            control_1.x, control_1.y, control_2.x, control_2.y, end.x, end.y
        ));
    }

    fn close(&mut self) {
        self.content.push_str("h\n");
    }
}
